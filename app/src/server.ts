// OnYourSite – Webserver (Node.js). Fastify nimmt die Anfragen an, alles Weitere passiert in dispatch() wie früher
// in index.php. Formulare und Uploads werden wie von PHP gelesen ($_POST/$_FILES-Regeln).
import Fastify from 'fastify';
import Busboy from 'busboy';
import { Readable } from 'node:stream';
import { Ctx, isHalt, type UploadedFile } from './web/ctx.js';
import { DbUnavailableError } from './db.js';
import { setupErrorPage, DB_FAILED_TEXT, DB_FAILED_TITLE } from './web/setupError.js';
import { dispatch } from './router.js';
import { setPhpVar, parseStr } from './php.js';
import { configInt, loadConfig, ConfigMissingError } from './config.js';
import { timeZone } from './db.js';
import { ensureSchemaOnce } from './schema.js';

// PHP-Grenzen wie auf dem Server: post_max_size 20M, upload_max_filesize 16M, Apache LimitRequestBody 25M
const POST_MAX = 20 * 1024 * 1024;
const UPLOAD_MAX = 16 * 1024 * 1024;
const BODY_LIMIT = 25 * 1024 * 1024;

export async function buildServer() {
  loadConfig();
  // Zeitzone der Seite für alles, was Date benutzt
  process.env.TZ = timeZone();
  // Tabellen anlegen bzw. auf den neuesten Stand bringen (einmal beim Start statt bei jeder Anfrage).
  // Ist die Datenbank gerade nicht erreichbar, startet der Server trotzdem und versucht es mit der nächsten Anfrage.
  await ensureSchemaOnce().catch((err) => {
    if (!(err instanceof DbUnavailableError)) throw err;
    console.error(`[${new Date().toISOString()}] ${err.message} – will retry with the next request`);
  });

  // Alle Anfragen gehen an genau eine Route: Fastify soll die Adresse weder dekodieren noch ablehnen (z. B. /%FF.html),
  // denn index.php arbeitet mit der rohen Adresse. Die Original-Adresse wird vorher gemerkt.
  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT,
    trustProxy: false,
    rewriteUrl: (req) => {
      (req as typeof req & { oysUrl?: string }).oysUrl = req.url ?? '/';
      return '/';
    },
  });
  // Ein leerer Content-Type-Header würde sonst mit 415 abgelehnt – PHP liest den Inhalt trotzdem
  app.addHook('onRequest', async (req) => {
    const ct = req.headers['content-type'];
    if (typeof ct === 'string' && ct.trim() === '') delete req.headers['content-type'];
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body));

  app.route({
    method: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    url: '/',
    handler: async (req, reply) => {
      const rawUrl = (req.raw as typeof req.raw & { oysUrl?: string }).oysUrl || '/';
      const ctx = new Ctx({ method: req.method, url: rawUrl, headers: req.headers, peer: req.socket.remoteAddress || '' });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      ctx.rawBody = body;
      if (ctx.method !== 'GET' && ctx.method !== 'HEAD' && body.length <= POST_MAX) {
        await readBody(ctx, String(req.headers['content-type'] ?? ''), body);
      }
      try {
        await dispatch(ctx);
      } catch (err) {
        if (err instanceof DbUnavailableError) {
          // Wie db.php: Hinweisseite mit 503 statt eines leeren Fehlers
          console.error(`[${new Date().toISOString()}] ${err.message}`);
          ctx.status = 503;
          ctx.removeHeader('Content-Type');
          ctx.header('Content-Type', 'text/html; charset=utf-8');
          ctx.body = setupErrorPage(DB_FAILED_TITLE, DB_FAILED_TEXT);
        } else if (!isHalt(err)) {
          // Wie PHP ohne Fehleranzeige: 500 mit leerem Inhalt
          console.error(`[${new Date().toISOString()}] ${ctx.method} ${ctx.rawUrl}:`, err);
          ctx.status = 500;
          ctx.body = '';
        }
      } finally {
        if (ctx.session) await ctx.session.close().catch((e) => console.error('session save failed:', e));
      }
      reply.code(ctx.status);
      for (const [name, value] of ctx.headersOut()) {
        if (name.toLowerCase() === 'set-cookie') reply.header('set-cookie', ([] as string[]).concat((reply.getHeader('set-cookie') as string[] | string | undefined) ?? [], value));
        else reply.header(name, value);
      }
      if (ctx.body instanceof Readable) {
        // Datenströme (große Dateien, ZIP): bei HEAD nicht lesen
        if (ctx.method === 'HEAD') {
          ctx.body.destroy();
          return reply.send('');
        }
        return reply.send(ctx.body);
      }
      return reply.send(ctx.method === 'HEAD' ? '' : ctx.body);
    },
  });
  return app;
}

// $_POST/$_FILES: nur bei urlencoded und multipart
async function readBody(ctx: Ctx, contentType: string, body: Buffer): Promise<void> {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') {
    ctx.post = parseStr(body.toString('utf8'), true);
    return;
  }
  if (type !== 'multipart/form-data') return;
  await new Promise<void>((resolve) => {
    let bb: Busboy.Busboy;
    try {
      bb = Busboy({ headers: { 'content-type': contentType }, defParamCharset: 'utf8', limits: { fileSize: UPLOAD_MAX + 1 } });
    } catch {
      resolve();
      return;
    }
    bb.on('field', (name, value) => setPhpVar(ctx.post, name, value));
    bb.on('file', (name, stream, info) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > UPLOAD_MAX) tooBig = true;
        else chunks.push(c);
      });
      stream.on('end', () => {
        const file: UploadedFile = info.filename === undefined || info.filename === ''
          ? { name: '', type: '', size: 0, data: Buffer.alloc(0), error: 4 }
          : { name: info.filename, type: info.mimeType, size: tooBig ? 0 : size, data: tooBig ? Buffer.alloc(0) : Buffer.concat(chunks), error: tooBig ? 1 : 0 };
        // Nur einfache Namen wie in den Formularen der Seite (avatar, file …)
        ctx.files[name.replace(/\[\]$/, '')] = file;
      });
    });
    bb.on('close', () => resolve());
    bb.on('error', () => resolve());
    bb.end(body);
  });
}

// Start: node dist/server.js (Port und Adresse aus den Einstellungen oder PORT/HOST)
const isMain = process.argv[1] && /server\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  try {
    const app = await buildServer();
    const port = Number(process.env.PORT) || configInt('node_port', 3000);
    const host = process.env.HOST || '127.0.0.1';
    await app.listen({ port, host });
    console.log(`OnYourSite is listening on http://${host}:${port}`);
  } catch (err) {
    if (err instanceof ConfigMissingError) console.error(err.message);
    else console.error(err);
    process.exit(1);
  }
}
