// OnYourSite – Webserver (Node.js). Fastify nimmt die Anfragen an, alles Weitere passiert in dispatch() wie früher
// in index.php. Formulare und Uploads werden wie von PHP gelesen ($_POST/$_FILES-Regeln).
import Fastify from 'fastify';
import Busboy from 'busboy';
import { Readable } from 'node:stream';
import { Ctx, isHalt, type UploadedFile } from './web/ctx.js';
import { DbUnavailableError } from './db.js';
import { setupErrorPage, DB_FAILED_TEXT, DB_FAILED_TITLE } from './web/setupError.js';
import { dispatch } from './router.js';
import { setPhpVar, parseStr, strtolower } from './php.js';
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
  // Den Content-Type wertet erst readBody() aus (wie PHP). Fastify soll ihn nicht prüfen: ein leerer oder ungewöhnlicher
  // Wert ("application/x-www-form-urlencoded, text/plain") ergäbe sonst 415, PHP liest den Inhalt trotzdem.
  // Bis nach dem Einlesen liegt der Header beiseite, danach steht er wieder unverändert in den Headern.
  app.addHook('onRequest', async (req) => {
    const ct = req.raw.headers['content-type'];
    if (ct !== undefined) {
      (req.raw as typeof req.raw & { oysContentType?: string }).oysContentType = ct;
      delete req.raw.headers['content-type'];
    }
  });
  app.addHook('preHandler', async (req) => {
    const ct = (req.raw as typeof req.raw & { oysContentType?: string }).oysContentType;
    if (ct !== undefined) req.raw.headers['content-type'] = ct;
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
      // $_POST/$_FILES füllt PHP nur bei POST (PUT, PATCH, DELETE: leer, nur php://input hat den Inhalt)
      if (ctx.method === 'POST' && body.length <= POST_MAX) {
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
      // 304 ohne Inhalt und ohne „Content-Length: 0“ (wie Apache; RFC 9110: sonst falsche Länge im Zwischenspeicher).
      // 204 ebenso – ohne Inhalt behält Fastify den Content-Type, den PHP auch hier mitsendet (/_/v, /_/c)
      if (ctx.status === 304 || ctx.status === 204) {
        if (ctx.body instanceof Readable) ctx.body.destroy();
        return reply.send();
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

// $_POST/$_FILES: nur bei urlencoded und multipart. Den Typ liest PHP (SAPI) klein geschrieben bis zum ersten ';', ','
// oder Leerzeichen – ohne trim (ein Tabulator gehört zum Typ).
export function phpPostType(contentType: string): string {
  const cut = contentType.search(/[;, ]/);
  return strtolower(cut >= 0 ? contentType.slice(0, cut) : contentType);
}

// Grenze wie rfc1867.c: das erste "boundary" im ganzen Wert (sonst ohne Rücksicht auf Groß-/Kleinschreibung), ab dem
// nächsten '=' der Wert in Anführungszeichen oder bis zum ersten ',' oder ';'. null = PHP liest nichts.
export function phpBoundary(contentType: string): string | null {
  let at = contentType.indexOf('boundary');
  if (at < 0) at = strtolower(contentType).indexOf('boundary');
  const eq = at < 0 ? -1 : contentType.indexOf('=', at);
  if (eq < 0) return null;
  const rest = contentType.slice(eq + 1);
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    return end < 0 ? null : rest.slice(1, end) || null;
  }
  const end = rest.search(/[,;]/);
  return (end >= 0 ? rest.slice(0, end) : rest) || null;
}

export async function readBody(ctx: Ctx, contentType: string, body: Buffer): Promise<void> {
  const type = phpPostType(contentType);
  if (type === 'application/x-www-form-urlencoded') {
    ctx.post = parseStr(body.toString('utf8'), true);
    return;
  }
  if (type !== 'multipart/form-data') return;
  const boundary = phpBoundary(contentType);
  if (boundary === null) return;
  await new Promise<void>((resolve) => {
    let bb: Busboy.Busboy;
    try {
      // Busboy bekommt die Grenze, die PHP gefunden hat, in einer Form, die es sicher liest. preservePath: den Pfad im
      // Dateinamen entfernt PHP selbst (unten) – busboy machte aus „.“ und „..“ einen leeren Namen
      const header = `multipart/form-data; boundary="${boundary.replace(/["\\]/g, '\\$&')}"`;
      bb = Busboy({ headers: { 'content-type': header }, defParamCharset: 'utf8', preservePath: true, limits: { fileSize: UPLOAD_MAX + 1 } });
    } catch {
      resolve();
      return;
    }
    const files: Array<Promise<void>> = [];
    bb.on('field', (name, value) => setPhpVar(ctx.post, name, value));
    bb.on('file', (name, stream, info) => {
      files.push(new Promise<void>((done) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooBig = false;
        // Nur einfache Namen wie in den Formularen der Seite (avatar, file …)
        const key = name.replace(/\[\]$/, '');
        // php_ap_basename(): alles nach dem letzten / oder \
        const raw = info.filename ?? '';
        const fileName = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);
        stream.on('data', (c: Buffer) => {
          size += c.length;
          if (size > UPLOAD_MAX) tooBig = true;
          else chunks.push(c);
        });
        stream.on('end', () => {
          ctx.files[key] = raw === ''
            ? { name: '', type: '', size: 0, data: Buffer.alloc(0), error: 4 }
            : { name: fileName, type: info.mimeType, size: tooBig ? 0 : size, data: tooBig ? Buffer.alloc(0) : Buffer.concat(chunks), error: tooBig ? 1 : 0 };
          done();
        });
        // Das Formular endet mitten in der Datei: wie PHP UPLOAD_ERR_PARTIAL (3) ohne Inhalt. Ohne diesen Empfänger
        // beendete der Fehler den ganzen Server.
        stream.on('error', () => {
          ctx.files[key] = { name: fileName, type: '', size: 0, data: Buffer.alloc(0), error: 3 } satisfies UploadedFile;
          done();
        });
        stream.on('close', () => done());
      }));
    });
    const finish = () => void Promise.all(files).then(() => resolve());
    bb.on('close', finish);
    bb.on('error', finish);
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
