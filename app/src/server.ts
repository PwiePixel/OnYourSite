// OnYourSite – Webserver (Node.js). Fastify nimmt die Anfragen an, alles Weitere passiert in dispatch() wie früher
// in index.php. Formulare und Uploads werden wie von PHP gelesen ($_POST/$_FILES-Regeln).
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { Ctx, isHalt } from './web/ctx.js';
import { phpMultipart, rfc1867Boundary } from './web/multipart.js';
import { DbUnavailableError } from './db.js';
import { setupErrorPage, DB_FAILED_TEXT, DB_FAILED_TITLE } from './web/setupError.js';
import { dispatch } from './router.js';
import { parseStr, phpText, strtolower } from './php.js';
import { configInt, loadConfig, ConfigMissingError } from './config.js';
import { timeZone } from './db.js';
import { ensureSchemaOnce } from './schema.js';

// PHP-Grenzen wie auf dem Server: post_max_size 20M, upload_max_filesize 16M, Apache LimitRequestBody 25M
const POST_MAX = 20 * 1024 * 1024;
const UPLOAD_MAX = 16 * 1024 * 1024;
const BODY_LIMIT = 25 * 1024 * 1024;

// opts.dispatch: nur für Tests (z. B. ein Datenstrom, der beim Senden scheitert)
export async function buildServer(opts: { dispatch?: (ctx: Ctx) => Promise<void> } = {}) {
  const run = opts.dispatch ?? dispatch;
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

  // Fehler außerhalb von dispatch() (Datenstrom scheitert beim Senden, Inhalt zu groß, …): nie den Server beenden und
  // nie die Fehlermeldung zeigen – wie PHP ohne Fehleranzeige eine leere Antwort (500, bei Fastify-Fehlern der Anfrage
  // wie 413 deren Status). Ist die Antwort schon unterwegs, bleibt nur der Abbruch der Verbindung.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    console.error(`[${new Date().toISOString()}] ${req.method} ${(req.raw as typeof req.raw & { oysUrl?: string }).oysUrl ?? req.url}:`, err);
    if (reply.sent || reply.raw.headersSent) {
      reply.raw.destroy();
      return;
    }
    const code = err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    void reply.code(code).header('content-type', 'text/html; charset=UTF-8').send('');
  });

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
        await run(ctx);
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
      // Ein Status, den Node nicht senden kann, wäre ein Fehler beim Senden: dann wie bei jedem Fehler 500
      reply.code(Number.isInteger(ctx.status) && ctx.status >= 100 && ctx.status <= 999 ? ctx.status : 500);
      for (const [name, rawValue] of ctx.headersOut()) {
        const value = headerValue(name, rawValue);
        if (value === null) continue;
        if (name.toLowerCase() === 'set-cookie') reply.header('set-cookie', ([] as string[]).concat((reply.getHeader('set-cookie') as string[] | string | undefined) ?? [], value));
        // Name so, wie der Code ihn schreibt (PHP: header('Location: …')) – Fastify schreibt ihn sonst klein. Apache reicht
        // die Namen unverändert weiter. Content-Length braucht Fastify zusätzlich selbst (HEAD, Längenprüfung).
        else {
          reply.raw.setHeader(name, value);
          if (name.toLowerCase() === 'content-length') reply.header(name, value);
        }
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

// Kopfzeilen, die Node nicht senden kann (ungültiger Name, Zeilenumbruch, Steuerzeichen, Zeichen über U+00FF), fallen
// mit einer Meldung weg, statt die ganze Antwort mit einem Fehler (500) zu beenden. PHP sendet Zeilen mit Zeilenumbruch
// ebenfalls nicht; Zeichen über U+00FF setzt der Code der Seite nirgends in Kopfzeilen (Location wandelt redirect() um).
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const INVALID_VALUE = /[^\t\x20-\x7e\x80-\xff]/;
export function headerValue(name: string, value: string): string | null {
  if (TOKEN.test(name) && !INVALID_VALUE.test(value)) return value;
  console.error(`[${new Date().toISOString()}] header not sent (invalid characters): ${JSON.stringify(name)}`);
  return null;
}

// $_POST/$_FILES: nur bei urlencoded und multipart. Den Typ liest PHP (SAPI) klein geschrieben bis zum ersten ';', ','
// oder Leerzeichen – ohne trim (ein Tabulator gehört zum Typ).
export function phpPostType(contentType: string): string {
  const cut = contentType.search(/[;, ]/);
  return strtolower(cut >= 0 ? contentType.slice(0, cut) : contentType);
}

// Grenze wie rfc1867.c: das erste "boundary" im ganzen Wert (sonst ohne Rücksicht auf Groß-/Kleinschreibung), ab dem
// nächsten '=' der Wert in Anführungszeichen oder bis zum ersten ',' oder ';'. null = keine (oder eine leere) Grenze.
export function phpBoundary(contentType: string): string | null {
  return rfc1867Boundary(contentType) || null;
}

export async function readBody(ctx: Ctx, contentType: string, body: Buffer): Promise<void> {
  const type = phpPostType(contentType);
  if (type === 'application/x-www-form-urlencoded') {
    // Bytes, die kein gültiges UTF-8 sind, bleiben wie in PHP erhalten (phpText)
    ctx.post = parseStr(phpText(body), true);
    return;
  }
  if (type !== 'multipart/form-data') return;
  // multipart liest PHP selbst (web/multipart.ts, wie rfc1867.c) – danach ist php://input leer
  const form = phpMultipart(contentType, body, UPLOAD_MAX);
  if (form === null) return;
  ctx.rawBody = Buffer.alloc(0);
  ctx.post = form.post;
  ctx.files = form.files;
}

// Start: node dist/server.js (Port und Adresse aus den Einstellungen oder PORT/HOST)
const isMain = process.argv[1] && /server\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  // Ein vergessenes await (z. B. eine Mail im Hintergrund) darf nicht den ganzen Server beenden – in PHP träfe so ein
  // Fehler nur die eine Anfrage. Meldung ins Log, der Server läuft weiter.
  process.on('unhandledRejection', (err) => console.error(`[${new Date().toISOString()}] unhandled rejection:`, err));
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
