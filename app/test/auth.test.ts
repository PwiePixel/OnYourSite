// Anmelden und Registrieren gegen PHP: die Vorlagen (views/login.php, register.php und die festen Seiten) mit
// ungewöhnlichen Werten aus der Sitzung, der Kopf von register.php, Anmeldeschlüssel und Passwort-Hashes.
// Die Abläufe über HTTP (Formulare, Begrenzungen, Datenbank) vergleicht gm/auth-seq.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ROOT_DIR } from '../src/config.js';
import { loginView } from '../src/app/views/login.js';
import { registerView } from '../src/app/views/register.js';
import { challengeView } from '../src/app/views/challenge.js';
import { imprintView } from '../src/app/views/imprint.js';
import { privacyView } from '../src/app/views/privacy.js';
import { termsView } from '../src/app/views/terms.js';
import { registerOld } from '../src/app/auth.js';
import { passwordHash, passwordVerify, sha256Hex } from '../src/crypto.js';
import { date } from '../src/php.js';
import type { PhpArray } from '../src/php.js';

// PHP mit den echten Hilfsfunktionen; $in kommt als JSON, das Ergebnis geht als JSON zurück
function php(code: string, input: unknown): unknown {
  const script = `require '${ROOT_DIR}/lib/config.php'; date_default_timezone_set(oys_config('timezone', 'Europe/Berlin')); mb_internal_encoding('UTF-8');`
    + ` require '${ROOT_DIR}/blacklist.php'; require '${ROOT_DIR}/lib/helpers.php';`
    + `$in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in); echo json_encode($out);`;
  return JSON.parse(execFileSync('php', ['-d', 'display_errors=0', '-r', script], { input: JSON.stringify(input), cwd: ROOT_DIR, maxBuffer: 64 << 20 }).toString());
}

// Eine Vorlage in PHP ausgeben: $_SESSION und $_GET je Fall, danach die Ausgabe und die übrige Sitzung
function renderPhp(view: string, cases: Array<{ session: Record<string, unknown>; get?: Record<string, unknown> }>): Array<{ html: string; session: Record<string, unknown> }> {
  return php(`$res = []; foreach ($in as $c) { $_SESSION = $c['session']; $_GET = $c['get'] ?? []; ob_start(); include '${ROOT_DIR}/views/${view}'; `
    + `$res[] = ['html' => ob_get_clean(), 'session' => $_SESSION]; } return $res;`, cases) as Array<{ html: string; session: Record<string, unknown> }>;
}

const TOKEN = 'a'.repeat(64);
const field = `<input type="hidden" name="csrf" value="${TOKEN}">`;
// Werte, die in PHP anders wahr/falsch sind als in JavaScript, und Zeichen, die maskiert werden müssen
const FLASH: unknown[] = [null, '', '0', 0, '0.0', ' ', 'Wrong email or password.', `<b>"x" & 'y'</b>`, 'Zoë 🐝 – “quoted”', true, false, 12, 1.5, ' \n'];

test('login view matches views/login.php for every flash value', () => {
  const cases = FLASH.flatMap((err, i) => [
    { session: { csrf: TOKEN, error: err, success: FLASH[(i + 3) % FLASH.length] } },
    { session: { csrf: TOKEN, success: err } },
  ]);
  const out = renderPhp('login.php', cases);
  cases.forEach((c, i) => {
    const html = loginView({ flashError: c.session.error ?? null, flashSuccess: c.session.success ?? null, csrfField: field });
    assert.equal(html, out[i].html, `case ${i}: ${JSON.stringify(c.session)}`);
    // Die Hinweise sind danach aus der Sitzung entfernt, das Token bleibt
    assert.deepEqual(out[i].session, { csrf: TOKEN });
  });
});

test('register view and its head match views/register.php', () => {
  const olds: unknown[] = [
    undefined,
    { fullname: 'Max Muster', email: 'max@example.com', subdomain: 'max' },
    { fullname: '', email: '', subdomain: '' },
    { fullname: '<script>"&\'', email: 'a&b@example.com', subdomain: '0' },
    { fullname: 'Zoë 🐝', email: 'x@y.de', subdomain: 'zoe-bee' },
    { fullname: 'Only Name' },
  ];
  const gets: Array<Record<string, unknown>> = [{}, { name: 'Foo Bar' }, { name: 'ÄBC-x_y.z' }, { name: ['x'] }, { name: '' }, { name: '0' }, { other: 'y' }, { name: { a: 'b' } }];
  const cases: Array<{ session: Record<string, unknown>; get: Record<string, unknown> }> = olds.flatMap((old, i) => gets.map((get, j) => ({
    session: { csrf: TOKEN, ...(old === undefined ? {} : { old }), ...(j % 2 ? { error: FLASH[(i + j) % FLASH.length] } : {}) },
    get,
  })));
  const out = renderPhp('register.php', cases);
  cases.forEach((c, i) => {
    const old = registerOld(c.session.old, c.get as PhpArray);
    const html = registerView({ flashError: c.session.error ?? null, old, csrfField: field });
    assert.equal(html, out[i].html, `case ${i}: ${JSON.stringify(c)}`);
    assert.deepEqual(out[i].session, { csrf: TOKEN });
  });
});

test('static pages match the PHP views byte for byte', () => {
  const views: Array<[string, () => string]> = [['challenge.php', challengeView], ['imprint.php', imprintView], ['privacy.php', privacyView], ['terms.php', termsView]];
  for (let attempt = 0; ; attempt++) {
    const day = date('Y-m-d');
    const res = php(`$r = []; foreach ($in as $v) { ob_start(); include '${ROOT_DIR}/views/' . $v; $r[] = ob_get_clean(); } return $r;`, views.map(([v]) => v)) as string[];
    // Um Mitternacht kann sich das Datum zwischen PHP und Node ändern: dann noch einmal
    if (date('Y-m-d') !== day && attempt < 2) continue;
    views.forEach(([name, fn], i) => assert.equal(fn(), res[i], name));
    break;
  }
});

test('login keys match PHP (sha256 of the trimmed, lowercased email)', () => {
  const emails = ['', 'mia@test.de', 'MİA@test.de', 'zoë@exämple.de', 'a'.repeat(300), 'x\u0000y', '🐝@bee.de'];
  const mine = emails.map((m) => 'login:' + sha256Hex(m).slice(0, 40));
  assert.deepEqual(mine, php(`return array_map(fn ($e) => 'login:' . substr(hash('sha256', $e), 0, 40), $in);`, emails));
});

test('password hashes work both ways, including NUL bytes and the 72-byte limit', async () => {
  // Zufällige Passwörter: ASCII, Mehrbyte-Zeichen, genau an der 72-Byte-Grenze
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const alphabet = ['a', 'Z', '9', ' ', '!', 'ä', 'ß', '€', '😀', '\t', '"', "'", '\\'];
  const pw: string[] = ['test1234', '', 'a', 'x'.repeat(71), 'x'.repeat(72), 'x'.repeat(73), 'x'.repeat(71) + 'ä', 'x'.repeat(70) + '€', 'ä'.repeat(36), 'ä'.repeat(37), '😀'.repeat(18) + 'a'];
  for (let i = 0; i < 20; i++) pw.push(Array.from({ length: 1 + rnd(90) }, () => alphabet[rnd(alphabet.length)]).join(''));
  // Varianten, die geprüft werden: gleich, länger, kürzer, nach 72 Bytes anders, mit \0 und Anhang
  const variants = (p: string): string[] => [p, p + 'x', Array.from(p).slice(0, -1).join(''), Buffer.from(p).subarray(0, 72).toString('utf8') + 'tail', p + '\0junk', '\0' + p];

  // PHP lehnt Nullbytes beim Hashen ab (ValueError) – Node genauso
  const withNul = ['abc\0def', '\0', 'test1234\0'];
  const phpHashes = php(`$r = []; foreach ($in as $p) { try { $r[] = password_hash($p, PASSWORD_DEFAULT, ['cost' => 4]); } catch (ValueError $e) { $r[] = 'ERR:' . $e->getMessage(); } } return $r;`,
    [...pw, ...withNul]) as string[];
  for (const [i, p] of withNul.entries()) {
    assert.equal(phpHashes[pw.length + i], 'ERR:Bcrypt password must not contain null character');
    await assert.rejects(passwordHash(p), /null character/);
  }

  // Hashes von PHP in Node prüfen (alle Varianten)
  const checks: Array<{ p: string; h: string }> = [];
  pw.forEach((p, i) => variants(p).forEach((v) => checks.push({ p: v, h: phpHashes[i] })));
  // Hashes von Node (Kosten 10 wie password_hash) in PHP prüfen
  for (const p of pw.slice(0, 8)) {
    const h = await passwordHash(p);
    assert.match(h, /^\$2y\$10\$[./A-Za-z0-9]{53}$/);
    for (const v of variants(p).slice(0, 4)) checks.push({ p: v, h });
  }
  checks.push({ p: 'x', h: '' }, { p: 'x', h: 'preview' }, { p: '', h: '$2y$10$abc' }, { p: 'test1234', h: '$2y$10$' + '.'.repeat(53) });
  const expected = php(`return array_map(fn ($c) => password_verify($c['p'], $c['h']), $in);`, checks) as boolean[];
  for (const [i, c] of checks.entries()) assert.equal(await passwordVerify(c.p, c.h), expected[i], `verify ${JSON.stringify(c.p)} against ${c.h}`);
  // Genug Treffer, sonst prüft der Test nichts
  assert.ok(expected.filter(Boolean).length > pw.length * 2);
});
