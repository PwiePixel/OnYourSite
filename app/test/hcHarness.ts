// Prüfstand für Honigwaben und Code-Seiten: dieselben Aufrufe laufen einmal mit den echten PHP-Funktionen auf
// Datenbank A und einmal mit der Node-Version auf Datenbank B (gleicher Ausgangsstand). Danach werden Ergebnisse
// und Tabellen verglichen. Zeitstempel „jetzt“ und zufällige Formular-Schlüssel werden vereinheitlicht.
import { execFile } from 'node:child_process';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { ROOT_DIR, loadConfig, setConfigForTests, type ConfigData } from '../src/config.js';
import { closePool, exec } from '../src/db.js';
import { ensureSchema } from '../src/schema.js';
import { strtotime, time, type PhpArray } from '../src/php.js';
import * as hc from '../src/honeycombs/honeycombs.js';
import * as code from '../src/code/sites.js';
import { adminCodeHandle, legacyCodePost } from '../src/code/admin.js';
import { hcDeleteUser } from '../src/honeycombs/deletion.js';
import { poolDb } from '../src/honeycombs/util.js';
import { ensureCatalogue } from '../src/honeycombs/catalogue.js';

export const BASE = loadConfig();
export const started = time();
// Name einer Test-Datenbank: abgeleitet von der Datenbank der Einstellungen (je Arbeitsordner eine eigene), damit
// gleichzeitige Läufe in verschiedenen Arbeitsordnern sich nicht gegenseitig die Daten löschen
export const testDbName = (suffix: string): string => String((BASE.db as ConfigData).name ?? 'oys_test') + '_' + suffix;
export type Op = [string, ...unknown[]];

// Verbindung ohne feste Datenbank (für CREATE DATABASE und Vergleiche)
export async function adminConnection(): Promise<Connection> {
  const db = BASE.db as ConfigData;
  return mysql.createConnection({ host: String(db.host), user: String(db.user), password: String(db.pass), charset: 'utf8mb4_unicode_ci', dateStrings: true, supportBigNumbers: true });
}

// Node-Seite auf eine andere Datenbank umstellen
export async function useDb(name: string): Promise<void> {
  await closePool();
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name } });
}
export async function restoreDb(): Promise<void> {
  await closePool();
  setConfigForTests(BASE);
}

// Neue Datenbank mit dem Schema der Seite und den Testdaten
export async function freshDb(admin: Connection, name: string, rows: Array<[string, unknown[]]>): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await useDb(name);
  await ensureSchema();
  await admin.query(`USE \`${name}\``);
  for (const [sql, params] of rows) await admin.query(sql, params);
}

// PHP mit eigener Verbindung auf die Test-Datenbank; die Funktionen kommen aus den echten Dateien
export const PHP_BOOT = `require '${ROOT_DIR}/lib/config.php'; date_default_timezone_set(oys_config('timezone', 'Europe/Berlin')); mb_internal_encoding('UTF-8');
  $pdo = new PDO('mysql:host=' . oys_config('db.host', 'localhost') . ';dbname=' . getenv('OYS_TEST_DB') . ';charset=utf8mb4', oys_config('db.user', ''), oys_config('db.pass', ''),
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
  $pdo->exec("SET time_zone = '" . date('P') . "'");
  require '${ROOT_DIR}/security.php'; require '${ROOT_DIR}/blacklist.php'; require '${ROOT_DIR}/lib/helpers.php';
  require '${ROOT_DIR}/lib/honeycombs.php'; require '${ROOT_DIR}/lib/codesites.php';`;

const PHP_OPS = `${PHP_BOOT}
  $ops = json_decode(stream_get_contents(STDIN), true);
  // {"__pairs": [[k, v], …]} → PHP-Array in genau dieser Reihenfolge (wie json_decode)
  $arr = function ($v) { if (is_array($v) && array_key_exists('__pairs', $v)) { $a = []; foreach ($v['__pairs'] as $p) { $a[$p[0]] = $p[1]; } return $a; } return $v; };
  $pairs = function (array $a) { $o = []; foreach ($a as $k => $v) { $o[] = [(string) $k, $v]; } return $o; };
  $site = function ($id) use ($pdo) { return oys_code_site_by_id($pdo, (int) $id); };
  $out = [];
  foreach ($ops as $op) {
    $a = array_slice($op, 1);
    try {
      switch ($op[0]) {
        case 'settings': $r = oys_hc_settings($pdo); break;
        case 'meta': $pdo->prepare("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('honeycombs', ?)")->execute([$a[0]]); $r = oys_hc_settings($pdo); break;
        case 'meta_delete': $pdo->exec("DELETE FROM oys_meta WHERE meta_key = 'honeycombs'"); $r = oys_hc_settings($pdo); break;
        case 'save_settings': oys_hc_save_settings($pdo, $a[0]); $r = oys_hc_settings($pdo); break;
        case 'balance': $r = oys_hc_balance($pdo, $a[0]); break;
        case 'has': $r = oys_hc_has($pdo, $a[0], $a[1], $a[2]); break;
        case 'add': $r = oys_hc_add($pdo, $a[0], $a[1], $a[2], $a[3], $a[4] ?? ''); break;
        case 'history': $r = oys_hc_history($pdo, $a[0], $a[1] ?? 20); break;
        case 'describe': $r = oys_hc_describe($a[0]); break;
        case 'profile_complete': $r = oys_hc_profile_complete($pdo, $a[0]); break;
        case 'earn': $r = oys_hc_earn($pdo, $a[0]); break;
        case 'spend': $r = oys_hc_spend($pdo, $a[0], $a[1], $a[2]); break;
        case 'for_editor': $r = oys_hc_for_editor($pdo, $a[0], $a[1] ?? []); break;
        case 'admin': $r = oys_admin_hc_handle($pdo, $a[0], $a[1]); break;
        // Bereich Code-Seiten (Node: code_action) – in PHP waren es dieselben Aktionen als hc_action=code_*
        case 'code_admin': $p = $a[0]; if (isset($p['code_action'])) { $p['hc_action'] = is_string($p['code_action']) ? 'code_' . $p['code_action'] : $p['code_action']; unset($p['code_action']); }
          $r = oys_admin_hc_handle($pdo, $p, $a[1]); break;
        case 'sql': $pdo->exec($a[0]); $r = true; break;
        // Preis der Code-Seite: PHP las ihn aus den Einstellungen, Node aus dem Katalog (hc_items)
        case 'set_code_price': $pdo->prepare("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('honeycombs', ?)")->execute([json_encode(['code_page' => $a[0]])]); $r = true; break;
        case 'code_site': $r = oys_code_site($pdo, $a[0]); break;
        case 'code_site_by_id': $r = oys_code_site_by_id($pdo, $a[0]); break;
        case 'code_site_by_slug': $r = oys_code_site_by_slug($pdo, $a[0]); break;
        case 'code_url': $r = oys_code_url($site($a[0])); break;
        case 'code_unlocked': $r = oys_code_unlocked($pdo, $a[0]); break;
        case 'code_files': $r = $pairs(oys_code_files($pdo, $a[0])); break;
        case 'code_for_editor': $r = oys_code_for_editor($pdo, $site($a[0])); break;
        // $state aus lib/routes_app.php (Editor-API der Code-Seite)
        case 'code_state': $userId = $a[0]; $s = oys_code_site($pdo, $userId); $u = $pdo->prepare('SELECT code_terms_at FROM users WHERE id = ?'); $u->execute([$userId]);
          $r = ['unlocked' => oys_code_unlocked($pdo, $userId), 'terms' => (bool) $u->fetchColumn(), 'cost' => oys_hc_settings($pdo)['code_page'], 'balance' => oys_hc_balance($pdo, $userId), 'site' => $s ? oys_code_for_editor($pdo, $s) : null]; break;
        case 'code_create': [$s, $e] = oys_code_create($pdo, $a[0], $a[1], $a[2]); $r = [$s, $e]; break;
        case 'code_save': $r = oys_code_save($pdo, $site($a[0]), $arr($a[1]), $a[2]); break;
        case 'code_write': $r = oys_code_write($pdo, $site($a[0]), $arr($a[1]), $a[2]); break;
        case 'code_delete_user': oys_code_delete_user($pdo, $a[0]); $r = null; break;
        case 'code_used_uploads': $r = array_map('strval', array_keys(oys_code_used_uploads($pdo, $a[0]))); break;
        case 'preview_token': $r = oys_code_preview_token($site($a[0]), $a[1]); break;
        case 'preview_valid': $r = oys_code_preview_valid($site($a[0]), $a[1]); break;
        default: $r = 'unknown op ' . $op[0];
      }
    } catch (Throwable $e) {
      $r = ['exception' => get_class($e)];
    }
    $out[] = $r;
  }
  echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);`;

export function phpRun(db: string, ops: Op[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = execFile('php', ['-r', PHP_OPS], { env: { ...process.env, OYS_TEST_DB: db }, cwd: ROOT_DIR, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`php failed: ${err.message}\n${stderr}`));
      try {
        resolve(JSON.parse(stdout) as unknown[]);
      } catch {
        reject(new Error('php output: ' + stdout.slice(0, 2000) + stderr));
      }
    });
    child.stdin!.end(JSON.stringify(ops));
  });
}

// {"__pairs": …} → Map (Reihenfolge exakt wie in PHP)
function arr(v: unknown): code.CodeFileInput {
  if (v && typeof v === 'object' && !Array.isArray(v) && '__pairs' in v) return new Map((v as { __pairs: Array<[string, unknown]> }).__pairs);
  return v as code.CodeFileInput;
}
const siteOf = async (id: unknown) => (await code.codeSiteById(Number(id))) as Record<string, unknown>;

export async function nodeRun(db: string, ops: Op[]): Promise<unknown[]> {
  await useDb(db);
  const out: unknown[] = [];
  try {
    for (const [fn, ...a] of ops) {
      let r: unknown;
      try {
        switch (fn) {
          case 'settings': r = await hc.hcSettings(); break;
          case 'meta': await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('honeycombs', ?)", [a[0] as string]); r = await hc.hcSettings(); break;
          case 'meta_delete': await exec("DELETE FROM oys_meta WHERE meta_key = 'honeycombs'"); r = await hc.hcSettings(); break;
          case 'save_settings': await hc.hcSaveSettings(a[0] as PhpArray); r = await hc.hcSettings(); break;
          case 'balance': r = await hc.hcBalance(a[0] as number); break;
          case 'has': r = await hc.hcHas(a[0] as number, a[1] as string, a[2] as string); break;
          case 'add': r = await hc.hcAdd(a[0] as number, a[1] as number, a[2] as string, a[3] as string, (a[4] as string) ?? ''); break;
          case 'history': r = await hc.hcHistory(a[0] as number, (a[1] as number) ?? 20); break;
          case 'describe': r = hc.hcDescribe(a[0] as Record<string, unknown>); break;
          case 'profile_complete': r = await hc.hcProfileComplete(a[0] as number); break;
          case 'earn': r = await hc.hcEarn(a[0] as number); break;
          case 'spend': r = await hc.hcSpend(a[0] as number, a[1] as number, a[2] as string); break;
          case 'for_editor': r = await hc.hcForEditor(a[0] as number, (a[1] as hc.HcEarned[]) ?? []); break;
          // Wie der Admin-Verteiler (admin/page.ts): alte Formulare hc_action=code_* gehen an den Bereich Code-Seiten
          case 'admin': {
            const legacy = legacyCodePost(a[0] as PhpArray);
            r = legacy ? await adminCodeHandle(legacy) : await hc.adminHcHandle(a[0] as PhpArray, a[1] as number);
            break;
          }
          case 'code_admin': r = await adminCodeHandle(a[0] as PhpArray); break;
          case 'sql': await exec(a[0] as string); r = true; break;
          case 'set_code_price':
            await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('honeycombs', ?)", [JSON.stringify({ code_page: a[0] })]);
            await ensureCatalogue();
            await exec("UPDATE hc_items SET price = ? WHERE item_key = 'code_page'", [a[0] as number]);
            r = true;
            break;
          case 'code_site': r = await code.codeSite(a[0] as number); break;
          case 'code_site_by_id': r = await code.codeSiteById(a[0] as number); break;
          case 'code_site_by_slug': r = await code.codeSiteBySlug(a[0] as string); break;
          case 'code_url': r = code.codeUrl(await siteOf(a[0])); break;
          case 'code_unlocked': r = await code.codeUnlocked(a[0] as number); break;
          case 'code_files': r = [...(await code.codeFiles(a[0] as number)).entries()]; break;
          case 'code_for_editor': r = await code.codeForEditor(await siteOf(a[0])); break;
          case 'code_state': r = await code.codeEditorState(a[0] as number); break;
          case 'code_create': r = await code.codeCreate(a[0] as number, a[1] as string, a[2] as string); break;
          case 'code_save': r = await code.codeSave(await siteOf(a[0]), arr(a[1]), a[2] as unknown[]); break;
          case 'code_write': r = await code.codeWrite(await siteOf(a[0]), arr(a[1]), a[2] as unknown[]); break;
          // oys_code_delete_user() löschte auch die Buchungen; in Node sind das zwei Haken des Kontolöschens (code, honeycombs)
          case 'code_delete_user': await code.codeDeleteUser(a[0] as number); await hcDeleteUser(a[0] as number, poolDb); r = null; break;
          case 'code_used_uploads': r = [...(await code.codeUsedUploads(a[0] as number))]; break;
          case 'preview_token': r = code.codePreviewToken(await siteOf(a[0]), a[1] as number); break;
          case 'preview_valid': r = code.codePreviewValid(await siteOf(a[0]), a[1] as string); break;
          default: r = 'unknown op ' + fn;
        }
      } catch (err) {
        r = { exception: (err as Error).message };
      }
      // Gleiche Form wie aus PHP (json_encode → JSON.parse)
      out.push(r === undefined ? null : JSON.parse(JSON.stringify(r)));
    }
  } finally {
    await restoreDb();
  }
  return out;
}

// Werte vereinheitlichen: Zeit „jetzt“, zufällige Formular-Schlüssel, Vorschau-Schlüssel mit Zeit
export function normalize(v: unknown, knownRefs: string[] = []): unknown {
  if (typeof v === 'string') {
    if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v)) {
      const t = strtotime(v);
      if (t !== false && t >= started - 2 && t <= time() + 2) return 'NOW';
    }
    if (/^a\d+-[0-9a-f]{16}$/.test(v) && !knownRefs.includes(v)) return 'a-RANDOM';
    return v.replace(/oys-preview=\d+-[0-9a-f]{24}/g, 'oys-preview=TOKEN');
  }
  if (Array.isArray(v)) return v.map((x) => normalize(x, knownRefs));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x, knownRefs)]));
  return v;
}

export const TABLES = ['users', 'pages', 'page_blocks', 'honeycomb_ledger', 'code_sites', 'code_files', 'oys_meta'];

const omit = (row: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

// Code-Seiten, deren gespeicherte Zähler nicht zu ihren Dateien passen (leer = alle stimmen)
export async function codeCounters(admin: Connection, db: string): Promise<unknown[]> {
  const [rows] = await admin.query<RowDataPacket[]>(`SELECT s.id, s.file_count, s.bytes, COUNT(f.id) AS n, COALESCE(SUM(LENGTH(f.content)), 0) AS b
    FROM \`${db}\`.code_sites s LEFT JOIN \`${db}\`.code_files f ON f.site_id = s.id GROUP BY s.id HAVING s.file_count <> n OR s.bytes <> b`);
  return rows.map((r) => ({ ...r }));
}

export async function dump(admin: Connection, db: string, knownRefs: string[] = []): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const t of TABLES) {
    const [rows] = await admin.query<RowDataPacket[]>(`SELECT * FROM \`${db}\`.\`${t}\` ORDER BY 1`);
    // Die Zähler der Code-Seiten (Dateien, Größe) führt nur Node – PHP kennt sie nicht; geprüft in codeCounters().
    // Buchungen seit dem Shop-Kern: actor_id (wer gebucht hat) schreibt nur Node – PHP kennt die Spalte nicht; geprüft
    // wird sie in honeycombs.test.ts und hc-core.db.test.ts. Eine schon vorhandene Freischaltung bucht Node gar nicht
    // erst (PHP verbraucht dabei mit INSERT IGNORE eine Nummer) – verglichen werden Inhalt und Reihenfolge, nicht die IDs.
    out[t] = normalize(rows.map((r) => {
      if (t === 'code_sites') return omit({ ...r }, ['file_count', 'bytes']);
      if (t === 'honeycomb_ledger') return omit({ ...r }, ['actor_id', 'id']);
      return { ...r };
    }), knownRefs);
  }
  // Nächste freie IDs (INSERT IGNORE und ON DUPLICATE KEY verbrauchen Nummern)
  const [ai] = await admin.query<RowDataPacket[]>(`SELECT TABLE_NAME, AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('code_sites', 'code_files') ORDER BY 1`, [db]);
  out.auto_increment = ai.map((r) => ({ ...r }));
  return out;
}
