// Befehle für den eigenen Server (server/install.sh, die systemd-Timer und server/cert-check.sh):
//   node app/dist/cli.js migrate [--pending]      Datenbank auf den Stand dieser Version bringen, Schema-Version ausgeben
//                                                 (--pending: nur prüfen – Rückgabe 2, wenn Schritte ausstehen)
//   node app/dist/cli.js check --native           sharp und @napi-rs/canvas laden und ein kleines Bild erzeugen
//   node app/dist/cli.js check --crypto           je verschlüsselter Spalte bis zu 50 Werte mit aes_key entschlüsseln
//   node app/dist/cli.js create-admin             erstes Admin-Konto (wie server/create-admin.php in 2.x)
//   node app/dist/cli.js cert-alert <tage>        Mail an alle Admins, wenn das Zertifikat bald abläuft (cert-alert.php in 2.x)
//   node app/dist/cli.js weekly-report            Wochenbericht (src/cli/weekly-report.ts)
// Rückgabe 0 = in Ordnung, 1 = Fehler (mit Meldung auf stderr). Entwicklung: node --import tsx src/cli.ts …
import { existsSync, readFileSync } from 'node:fs';
import { ConfigMissingError, ROOT_DIR, loadConfig } from './config.js';
import { DbUnavailableError, closePool, exec, one, q, timeZone, value, withConnection } from './db.js';
import { SCHEMA_VERSION, ensureSchema, ensureSchemaOnce, schemaVersion } from './schema.js';
import { decryptData, passwordHash } from './crypto.js';
import { baseHost, cleanText, mainUrl, normalizeSlug, pageUrls, slugProblem, validateEmail } from './helpers.js';
import { intval, phpTrim, strlen, strtolower } from './php.js';
import { DB_FAILED_TEXT, DB_FAILED_TITLE, setupErrorPage } from './web/setupError.js';

// Ausgabe und Umgebung – Tests geben eigene mit
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
}

const processIo = (): CliIo => ({
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
});

const firstLine = (err: unknown): string => String(err instanceof Error ? err.message : err).split('\n').find((l) => l.trim() !== '') ?? 'unknown error';

export async function runCli(argv: string[], io: CliIo = processIo()): Promise<number> {
  const [command, ...args] = argv;
  const commands: Record<string, () => Promise<number>> = {
    migrate: () => migrate(args, io),
    check: () => check(args, io),
    'create-admin': () => createAdmin(io),
    'cert-alert': () => certAlert(args, io),
    'weekly-report': () => weeklyReport(io),
  };
  if (!command || !Object.hasOwn(commands, command)) {
    io.err('Usage: node app/dist/cli.js migrate [--pending] | check --native | check --crypto | create-admin | cert-alert <days> | weekly-report\n');
    return 1;
  }
  // Wie der Server: ohne config.json geht nichts (Meldung, Rückgabe 1). check --native prüft nur die Pakete – das geht
  // schon vor den Einstellungen (beim Bauen einer neuen Version); der Wochenbericht lädt sie selbst.
  if (command !== 'weekly-report' && !(command === 'check' && args[0] === '--native')) {
    try {
      loadConfig();
    } catch (err) {
      if (!(err instanceof ConfigMissingError)) throw err;
      io.err(err.message + '\n');
      return 1;
    }
    process.env.TZ = timeZone();
  }
  try {
    return await commands[command]();
  } finally {
    await closePool().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- migrate

async function migrate(args: string[], io: CliIo): Promise<number> {
  const pending = args.includes('--pending');
  if (args.some((a) => a !== '--pending')) {
    io.err('Usage: node app/dist/cli.js migrate [--pending]\n');
    return 1;
  }
  try {
    const before = await withConnection((_db, conn) => schemaVersion(conn));
    if (pending) {
      if (before < SCHEMA_VERSION) {
        io.out(`Database schema: version ${before} – this release needs ${SCHEMA_VERSION}\n`);
        return 2;
      }
      io.out(`Database schema: version ${before} – up to date${before > SCHEMA_VERSION ? ` (newer than this release: ${SCHEMA_VERSION})` : ''}\n`);
      return 0;
    }
    await ensureSchema();
    const after = await withConnection((_db, conn) => schemaVersion(conn));
    if (after < SCHEMA_VERSION) throw new Error(`the schema is still at version ${after}`);
    io.out(`Database schema: version ${after}${after !== before ? ` (was ${before})` : ''}${after > SCHEMA_VERSION ? ` – newer than this release (${SCHEMA_VERSION})` : ''}\n`);
    return 0;
  } catch (err) {
    if (err instanceof DbUnavailableError) io.err(`The database can’t be reached: ${firstLine(err)}\n`);
    else io.err(`The database couldn’t be updated: ${firstLine(err)}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------- check

async function check(args: string[], io: CliIo): Promise<number> {
  if (args[0] === '--native' && args.length === 1) return checkNative(io);
  if (args[0] === '--crypto' && args.length === 1) return checkCrypto(io);
  io.err('Usage: node app/dist/cli.js check --native | check --crypto\n');
  return 1;
}

// Die beiden Pakete mit eigenem Maschinencode: sharp (Bilder beim Hochladen) und @napi-rs/canvas (Vorschaubilder
// beim Teilen). npm ci --ignore-scripts lädt ihren Code als fertiges Paket für diesen Rechner – hier zeigt sich, ob er läuft.
async function checkNative(io: CliIo): Promise<number> {
  const problems: string[] = [];
  try {
    const { default: sharp } = await import('sharp');
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 99, g: 102, b: 241, alpha: 1 } } }).png().toBuffer();
    const webp = await sharp(png).resize(4, 4, { fit: 'fill' }).webp({ quality: 84 }).toBuffer();
    const meta = await sharp(webp).metadata();
    if (meta.format !== 'webp' || meta.width !== 4 || meta.height !== 4) throw new Error(`unexpected result (${meta.format} ${meta.width}×${meta.height})`);
    io.out(`sharp ${sharp.versions.sharp} with libvips ${sharp.versions.vips}: works\n`);
  } catch (err) {
    problems.push(`sharp (pictures people upload) doesn’t work on this server: ${firstLine(err)}`);
  }
  try {
    const { ogFont } = await import('./content/share.js');
    const { GdImage, trueColorAlpha } = await import('./content/gdImage.js');
    const font = ogFont(true);
    if (!existsSync(font)) throw new Error(`the font ${font} is missing`);
    // Schrift auf dunklem Grund wie auf den Vorschaubildern – danach müssen helle Pixel da sein
    const img = new GdImage(160, 40);
    img.fill(0, 0, trueColorAlpha(9, 9, 11, 0));
    img.text(16, 6, 30, trueColorAlpha(255, 255, 255, 0), font, 'OnYourSite');
    const lit = img.px.filter((c) => (c & 0xff) > 128).length;
    if (lit < 20) throw new Error('the text wasn’t drawn');
    const png = img.png();
    if (png.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error('no PNG was made');
    io.out('@napi-rs/canvas with the Inter font: works\n');
  } catch (err) {
    problems.push(`@napi-rs/canvas (share images) doesn’t work on this server: ${firstLine(err)}`);
  }
  if (problems.length) {
    for (const p of problems) io.err(p + '\n');
    io.err('The website needs both. Run the installer again; if it keeps failing, the server’s processor or system may not be supported (x64 or arm64 with glibc is needed).\n');
    return 1;
  }
  return 0;
}

// Spalten mit verschlüsselten Werten (ENC:…): Kontaktnachrichten, Buchungsanfragen, Anmelde-IP, Discord-ID, alte
// Buchungslinks, Discord-Einstellungen und Nachrichten der Support-Tickets
const ENCRYPTED: Array<{ table: string; column: string; key: string; where?: string; json?: boolean; label?: string }> = [
  { table: 'messages', column: 'name', key: 'id' },
  { table: 'messages', column: 'email', key: 'id' },
  { table: 'messages', column: 'message', key: 'id' },
  { table: 'user_bookings', column: 'guest_name', key: 'id' },
  { table: 'user_bookings', column: 'guest_email', key: 'id' },
  { table: 'users', column: 'last_ip', key: 'id' },
  { table: 'users', column: 'discord_id', key: 'id' },
  { table: 'users', column: 'booking_url', key: 'id' },
  { table: 'community_ticket_messages', column: 'body', key: 'id' },
  { table: 'oys_meta', column: 'meta_value', key: 'meta_key', where: "meta_key = 'discord'", json: true, label: 'oys_meta.discord' },
];
const SAMPLE = 50;

async function checkCrypto(io: CliIo): Promise<number> {
  const all: Array<{ label: string; id: string; value: string; plain: string }> = [];
  let failures = 0;
  const failedIds: string[] = [];
  try {
    for (const col of ENCRYPTED) {
      const label = col.label ?? `${col.table}.${col.column}`;
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await q(`SELECT \`${col.key}\` AS k, \`${col.column}\` AS v FROM \`${col.table}\` WHERE \`${col.column}\` LIKE 'ENC:%'${col.where ? ' AND ' + col.where : ''} ORDER BY \`${col.key}\` DESC LIMIT ${SAMPLE}`);
      } catch (err) {
        if ((err as { code?: string }).code === 'ER_NO_SUCH_TABLE' || (err as { code?: string }).code === 'ER_BAD_FIELD_ERROR') {
          io.out(`  ${label.padEnd(36)} not in this database\n`);
          continue;
        }
        throw err;
      }
      let bad = 0;
      for (const row of rows) {
        const value = String(row.v);
        const plain = String(decryptData(value) ?? '');
        // Nicht entschlüsselbar: decryptData gibt den Wert unverändert zurück. Ein falscher Schlüssel mit zufällig
        // gültigem Polster ergibt Datenmüll – kein gültiges UTF-8 (U+FFFD nach dem Umwandeln).
        let ok = plain !== value && !plain.includes('�');
        if (ok && col.json) {
          try {
            JSON.parse(plain);
          } catch {
            ok = false;
          }
        }
        if (!ok) {
          bad++;
          failedIds.push(`${label} ${col.key} ${String(row.k)}`);
        }
        all.push({ label, id: String(row.k), value, plain });
      }
      failures += bad;
      io.out(`  ${label.padEnd(36)} ${rows.length ? `${rows.length} checked${bad ? `, ${bad} can’t be read` : ', all readable'}` : 'no encrypted values'}\n`);
    }
  } catch (err) {
    io.err(`The database can’t be read: ${firstLine(err)}\n`);
    return 1;
  }
  if (failures) {
    io.err(`${failures} encrypted values can’t be read with the aes_key in config.json (${failedIds.slice(0, 5).join('; ')}${failedIds.length > 5 ? ' …' : ''}).\n`);
    io.err('The key must be exactly the one that encrypted this database – check aes_key.\n');
    return 1;
  }
  io.out(all.length ? `All ${all.length} checked values can be read with this key.\n` : 'There is no encrypted data yet.\n');
  return 0;
}

// ---------------------------------------------------------------- create-admin (server/create-admin.php)

// lib/bootstrap.php in der Kommandozeile: Verbindung und Schema – ist die Datenbank nicht erreichbar, gibt PHP die
// Hinweisseite aus und endet (exit; also mit 0). Gibt false zurück, wenn es so endet.
async function bootstrap(io: CliIo): Promise<boolean> {
  try {
    // db.php verbindet sich zuerst – auch wenn das Schema in diesem Prozess schon geprüft ist
    await value('SELECT 1');
    await ensureSchemaOnce();
    return true;
  } catch (err) {
    if (!(err instanceof DbUnavailableError)) throw err;
    io.err('DB connection failed: ' + err.message + '\n');
    io.out(setupErrorPage(DB_FAILED_TITLE, DB_FAILED_TEXT));
    return false;
  }
}

// Ein Fehler, den PHP nicht abfängt (z. B. PDOException): „PHP Fatal error“ und Rückgabe 255
function fatal(io: CliIo, err: unknown): number {
  io.err(`PHP Fatal error:  Uncaught ${firstLine(err)}\n`);
  return 255;
}

async function createAdmin(io: CliIo): Promise<number> {
  if (!(await bootstrap(io))) return 0;
  const fail = (message: string): number => {
    io.err(message + '\n');
    return 1;
  };
  try {
    // (string) getenv(…): fehlt die Variable, ist es ein leerer Text
    const name = cleanText(io.env.OYS_NAME ?? '', 120);
    const email = strtolower(phpTrim(io.env.OYS_EMAIL ?? ''));
    const password = io.env.OYS_PASSWORD ?? '';
    const slug = normalizeSlug(io.env.OYS_SLUG ?? '');
    if (name === '' || email === '' || password === '' || slug === '') return fail('Please fill in everything.');
    if (!validateEmail(email)) return fail('Please enter a valid email address.');
    if (strlen(password) < 8) return fail('The password must be at least 8 characters long.');
    const problem = await slugProblem(slug);
    if (problem !== null) return fail(problem);
    if (await one('SELECT id FROM users WHERE email = ? OR username = ? LIMIT 1', [email, slug])) {
      return fail('This email address or page address is already taken.');
    }
    const { DEFAULT_THEME } = await import('./content/themes.js');
    const { createPage } = await import('./content/pages.js');
    const { insertId } = await exec("INSERT INTO users (email, password, full_name, username, layout_type, last_ip, theme, is_admin) VALUES (?, ?, ?, ?, 'link-tree', '', ?, 1)",
      [email, await passwordHash(password), name, slug, DEFAULT_THEME]);
    await createPage(intval(insertId), slug, name);
    io.out('Admin account created – log in at ' + mainUrl('/login') + ' with ' + email + '. Your page: ' + pageUrls({ slug }).subdomain + '\n');
    return 0;
  } catch (err) {
    return fatal(io, err);
  }
}

// ---------------------------------------------------------------- cert-alert – früher server/cert-alert.php

async function certAlert(args: string[], io: CliIo): Promise<number> {
  if (!(await bootstrap(io))) return 0;
  try {
    const { phpJsonDecode, PhpArr, phpJsonTruthy, jsonField } = await import('./community/json.js');
    const { sendPlainEmail, smtpConfigPath } = await import('./mail.js');
    const days = intval(args[0] ?? 0);
    const domain = baseHost();
    let raw: Buffer;
    try {
      raw = readFileSync(smtpConfigPath());
    } catch {
      raw = Buffer.alloc(0);
    }
    const smtp = phpJsonDecode(raw);
    if (!(smtp instanceof PhpArr) || !phpJsonTruthy(jsonField(smtp, 'host') ?? null)) {
      io.err('No mail server is set up (Admin → Mail Server) – no warning sent.\n');
      return 1;
    }
    const admins = (await q('SELECT email FROM users WHERE is_admin = 1')).map((r) => String(r.email));
    const subject = `HTTPS certificate of ${domain} expires in ${days} days`;
    const text = `The HTTPS certificate of ${domain} and *.${domain} expires in ${days} days, and the automatic renewal didn't work.\n\n`
      + 'Please log in to the server and run:\n\n    sudo bash ' + ROOT_DIR + '/server/install.sh --https\n\n'
      + 'It shows what goes wrong – often the API token of the DNS provider has expired or was deleted.\n'
      + 'Details: journalctl -u onyoursite-certs\n';
    let sent = 0;
    for (const to of admins) {
      try {
        await sendPlainEmail(smtp, to, subject, text);
        sent++;
      } catch (err) {
        io.err('Mail to ' + to + ' failed: ' + firstLine(err) + '\n');
      }
    }
    io.out(`Warning sent to ${sent} of ${admins.length} admins.\n`);
    return sent > 0 ? 0 : 1;
  } catch (err) {
    return fatal(io, err);
  }
}

// ---------------------------------------------------------------- weekly-report

// Der Wochenbericht liegt in src/cli/weekly-report.ts (App-Paket). Geladen wird er erst hier und über eine zur Laufzeit
// gebaute Adresse – so übersetzt tsc diese Datei auch ohne ihn, und der Befehl meldet klar, wenn er fehlt.
export async function weeklyReport(io: CliIo, url = new URL(['.', 'cli', 'weekly-report.js'].join('/'), import.meta.url)): Promise<number> {
  let mod: { weeklyReportCli?: () => Promise<number> };
  try {
    mod = (await import(url.href)) as typeof mod;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_UNSUPPORTED_DIR_IMPORT') && String((err as Error).message).includes('weekly-report')) {
      io.err('The weekly report isn’t part of this version of OnYourSite yet (app/src/cli/weekly-report.ts is missing) – nothing was sent.\n');
      return 1;
    }
    throw err;
  }
  if (typeof mod.weeklyReportCli !== 'function') {
    io.err('The weekly report module has no weeklyReportCli() – nothing was sent.\n');
    return 1;
  }
  return mod.weeklyReportCli();
}

// Als Befehl gestartet (nicht beim Import in Tests)
const isMain = process.argv[1] && /cli\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
