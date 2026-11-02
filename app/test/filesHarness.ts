// Gemeinsame Hilfen für die Vergleiche des Datei-Pakets (lib/storage.php, uploads.php, stats.php, spam.php der
// PHP-Version, siehe support/phpRef.ts) mit PHP: PHP-Funktionen direkt aufrufen (eigene Einstellungen, eigene
// Datenbank-Kopie) und ein kleiner PHP-Webserver für das, was nur mit einer echten Anfrage geht (Hochladen:
// is_uploaded_file, Ausliefern: header()).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { configString, loadConfig, type ConfigData } from '../src/config.js';
import { phpFile } from './support/phpRef.js';

const LIBS = ['lib/helpers.php', 'lib/storage.php', 'lib/themes.php', 'lib/social.php', 'lib/blocks.php', 'lib/pages.php', 'lib/share.php',
  'lib/codesites.php', 'lib/stats.php', 'lib/spam.php', 'lib/uploads.php'];

// oys_config() aus der Umgebung, security.php ohne sein require (das würde oys_config() ein zweites Mal anlegen) und
// sendCustomEmail() als Aufzeichnung statt Versand
export const phpPrelude = (): string => `
  function oys_config(?string $key = null, $default = null) {
    static $c = null;
    if ($c === null) $c = json_decode(getenv('OYS_TEST_CONFIG'), true);
    if ($key === null) return $c;
    $v = $c;
    foreach (explode('.', $key) as $p) { if (!is_array($v) || !array_key_exists($p, $v)) return $default; $v = $v[$p]; }
    return $v;
  }
  date_default_timezone_set(oys_config('timezone', 'Europe/Berlin'));
  mb_internal_encoding('UTF-8');
  eval('?>' . str_replace("require_once __DIR__ . '/lib/config.php';", '', file_get_contents('${phpFile('security.php')}')));
  $GLOBALS['mails'] = [];
  function sendCustomEmail($to, $template, $vars = [], $subject = null, $replyTo = null) { $GLOBALS['mails'][] = [$to, $template, $vars, $subject, $replyTo]; return true; }
  ${LIBS.map((f) => `require_once '${phpFile(f)}';`).join('\n')}
`;

// PHP-Code ausführen: $in = json_decode(<input>, true); mit db: true steht $pdo bereit (wie db.php)
export function runPhp(body: string, input: string, opts: { config?: ConfigData; db?: boolean; ini?: string[] } = {}): string {
  const config = opts.config ?? loadConfig();
  const script = `${phpPrelude()}
    ${opts.db ? `$pdo = new PDO('mysql:host=' . oys_config('db.host', 'localhost') . ';dbname=' . oys_config('db.name') . ';charset=utf8mb4', oys_config('db.user', ''), oys_config('db.pass', ''),
      [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
      $pdo->exec("SET time_zone = '" . date('P') . "'");` : ''}
    $in = json_decode(stream_get_contents(STDIN), true);
    ${body}`;
  try {
    return execFileSync('php', [...(opts.ini ?? []).flatMap((x) => ['-d', x]), '-d', 'display_errors=stderr', '-d', 'memory_limit=1G', '-r', script], {
      input,
      env: { ...process.env, OYS_TEST_CONFIG: JSON.stringify(config) },
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    throw new Error('PHP failed: ' + String(e.stderr ?? '').slice(-2000) + String(e.stdout ?? '').slice(-500));
  }
}

// ---------------------------------------------------------------- Datenbank-Kopien

export interface DbCopies {
  admin: Connection;
  names: { php: string; node: string };
  dump(db: string, tables: string[]): Promise<Record<string, unknown[]>>;
  drop(): Promise<void>;
}

// Zwei frische Kopien der Test-Datenbank (eine für PHP, eine für Node)
export async function copyDatabase(suffix: string): Promise<DbCopies> {
  const source = configString('db.name');
  const admin = await mysql.createConnection({
    host: configString('db.host', 'localhost'), user: configString('db.user', ''), password: configString('db.pass', ''),
    charset: 'utf8mb4_unicode_ci', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false,
  });
  const names = { php: `${source}_${suffix}php`, node: `${source}_${suffix}node` };
  const [tables] = await admin.query<RowDataPacket[]>(`SHOW TABLES FROM \`${source}\``);
  for (const db of Object.values(names)) {
    await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const row of tables) {
      const t = String(Object.values(row)[0]);
      await admin.query(`CREATE TABLE \`${db}\`.\`${t}\` LIKE \`${source}\`.\`${t}\``);
      await admin.query(`INSERT INTO \`${db}\`.\`${t}\` SELECT * FROM \`${source}\`.\`${t}\``);
    }
  }
  return {
    admin,
    names,
    async dump(db, list) {
      const out: Record<string, unknown[]> = {};
      for (const t of list) out[t] = (await admin.query<RowDataPacket[]>(`SELECT * FROM \`${db}\`.\`${t}\` ORDER BY 1, 2, 3`))[0];
      return out;
    },
    async drop() {
      for (const db of Object.values(names)) await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
      await admin.end();
    },
  };
}

// Einstellungen mit anderer Datenbank und anderem Upload-Ordner
export function configWith(base: ConfigData, db: string, uploadsDir?: string): ConfigData {
  return { ...base, db: { ...(base.db as ConfigData), name: db }, ...(uploadsDir !== undefined ? { uploads_dir: uploadsDir } : {}) };
}

// ---------------------------------------------------------------- PHP-Webserver (php -S) für Hochladen und Ausliefern

// Der Router macht genau das, was index.php (Zeilen 5–10) bzw. routes_app.php für den Upload tun – ohne Datenbank
const router = (): string => `<?php
${phpPrelude()}
$path = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if (strpos($path, '/static/uploads/') === 0) {
    oys_serve_upload(substr((string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH), strlen('/static/uploads/')));
    exit;
}
if ($path === '/upload') {
    header('Content-Type: application/json');
    $res = oys_handle_upload($_FILES['file'] ?? [], (string) ($_POST['kind'] ?? ''), (int) ($_POST['user'] ?? 0));
    $info = isset($res['file']) && is_file(oys_upload_path($res['file'])) ? @getimagesize(oys_upload_path($res['file'])) : false;
    // Farben an vier Stellen des gespeicherten WebP (R/G/B/?): zeigt, in welche Richtung gedreht wurde
    $colors = null;
    if ($info && $info['mime'] === 'image/webp' && ($im = imagecreatefromwebp(oys_upload_path($res['file'])))) {
      $colors = '';
      foreach ([[0.15, 0.2], [0.85, 0.2], [0.15, 0.8], [0.85, 0.8]] as [$x, $y]) {
        $c = imagecolorsforindex($im, imagecolorat($im, (int) ($x * ($info[0] - 1)), (int) ($y * ($info[1] - 1))));
        $colors .= $c['red'] > 150 ? 'R' : ($c['green'] > 150 ? 'G' : ($c['blue'] > 150 ? 'B' : '?'));
      }
    }
    echo json_encode(['res' => $res, 'img' => $info ? [$info[0], $info[1], $info['mime']] : null, 'colors' => $colors,
      'mode' => isset($res['file']) && is_file(oys_upload_path($res['file'])) ? decoct(fileperms(oys_upload_path($res['file'])) & 0777) : null,
      'limit' => oys_upload_limit_mb()], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
http_response_code(404);
`;

const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port }, () => {
      s.destroy();
      resolve(false);
    });
    s.on('error', () => resolve(true));
  });

export interface PhpServer {
  url: string;
  stop(): Promise<void>;
}

// php -S starten; ob er den Port bekommen hat, steht in seiner ersten Meldung ("… started" bzw. "Failed to listen …")
function spawnPhpServer(port: number, dir: string, config: ConfigData): Promise<ChildProcess | null> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn('php', ['-d', 'upload_max_filesize=16M', '-d', 'post_max_size=20M', '-d', 'display_errors=0',
      '-d', 'memory_limit=1G', '-S', `127.0.0.1:${port}`, '-t', dir, join(dir, 'router.php')], {
      env: { ...process.env, OYS_TEST_CONFIG: JSON.stringify(config) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let log = '';
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok ? child : null);
    };
    // Weiter lesen, auch nach dem Start (sonst bleibt der Server beim vollen Puffer stehen)
    child.stderr!.on('data', (chunk: Buffer) => {
      if (done) return;
      log += chunk.toString();
      if (/Development Server \(.*\) started/.test(log)) finish(true);
    });
    child.once('exit', () => finish(false));
  });
}

// Der Port gehört diesem Paket; laufen zwei Testdateien gleichzeitig, wartet die zweite, bis er wieder frei ist
export async function startPhpServer(port: number, config: ConfigData): Promise<PhpServer> {
  const dir = mkdtempSync(join(tmpdir(), 'oys-files-php-'));
  writeFileSync(join(dir, 'router.php'), router());
  const deadline = Date.now() + 180_000;
  let child: ChildProcess | null = null;
  while (!child) {
    while (!(await portFree(port))) {
      if (Date.now() > deadline) throw new Error(`port ${port} is in use`);
      await new Promise((r) => setTimeout(r, 100));
    }
    child = await spawnPhpServer(port, dir, config);
    if (!child && Date.now() > deadline) throw new Error(`port ${port} is in use`);
  }
  const server = child;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => {
      if (server.exitCode !== null || server.signalCode !== null) return resolve();
      server.once('exit', () => resolve());
      server.kill();
    }),
  };
}
