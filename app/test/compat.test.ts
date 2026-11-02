// Gegenprobe mit der PHP-Version (siehe support/phpRef.ts): Verschlüsselung, Signaturen, Passwörter, Maskierung und
// JSON müssen Byte für Byte übereinstimmen, sonst wären gespeicherte Daten oder Signaturen nach dem Umstieg wertlos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { encryptData, decryptData, hmac, passwordHash, passwordVerify } from '../src/crypto.js';
import { e, phpJson } from '../src/html.js';
import { tzOffset, timeZone } from '../src/db.js';
import { PHP_SKIP, phpFile, phpRoot } from './support/phpRef.js';

// PHP-Funktion mit JSON-Ein- und Ausgabe aufrufen (lädt die echten Dateien der PHP-Version)
function php(code: string, input: unknown): unknown {
  const script = `require '${phpFile('security.php')}'; require '${phpFile('lib/helpers.php')}';`
    + `$in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in); echo json_encode($out);`;
  return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(input), cwd: phpRoot() }).toString());
}

const SAMPLES = ['hello', 'Grüße aus München – „Test“ €', '0', '', 'emoji 🐝🍯', 'x'.repeat(5000), "quotes ' \" < > & /", 'ENC:already', '1234567890123456'];

test('Node decrypts what it encrypts, and odd values stay as they are', () => {
  for (const s of SAMPLES) assert.equal(decryptData(encryptData(s)), s);
  assert.match(String(encryptData('hello')), /^ENC:/);
  for (const v of ['ENC:!!!', 'ENC:', 'ENC:YWJj', 'plain text']) assert.equal(decryptData(v), v);
});

test('Node encrypts, PHP decrypts', { skip: PHP_SKIP }, () => {
  const enc = SAMPLES.map((s) => encryptData(s));
  const back = php('return array_map(function ($v) { return decryptData($v); }, $in);', enc) as string[];
  assert.deepEqual(back, SAMPLES);
});

test('PHP encrypts, Node decrypts', { skip: PHP_SKIP }, () => {
  const enc = php('return array_map(function ($v) { return encryptData($v); }, $in);', SAMPLES) as string[];
  assert.deepEqual(enc.map((v) => decryptData(v)), SAMPLES);
  // Ungültiges bleibt unverändert – wie in PHP
  const odd = ['ENC:!!!', 'ENC:', 'ENC:YWJj', 'plain text'];
  assert.deepEqual(odd.map((v) => decryptData(v)), php('return array_map(function ($v) { return decryptData($v); }, $in);', odd));
});

test('hmac matches oys_hmac()', { skip: PHP_SKIP }, () => {
  const inputs = ['client|2026-11-01|1.2.3.4', 'preview|5|1700000000', 'äöü', ''];
  assert.deepEqual(inputs.map(hmac), php('return array_map(function ($v) { return oys_hmac($v); }, $in);', inputs));
});

test('e() matches htmlspecialchars', { skip: PHP_SKIP }, () => {
  const inputs = ['<script>alert("x")</script>', "it's & that's", 'plain', '&amp; stays double', '“curly” – 🐝', ''];
  assert.deepEqual(inputs.map(e), php('return array_map(function ($v) { return e($v); }, $in);', inputs));
});

test('phpJson matches json_encode with the same flags', { skip: PHP_SKIP }, () => {
  const value = { a: 'x/y', b: 'Grüße 🐝', c: '</script>', d: "it's \"q\" & <b>", e: [1, 2, 3], f: null, g: true, h: 'line\nbreak\ttab', i: ' ' };
  const cases: Array<[Record<string, boolean>, string]> = [
    [{}, '0'],
    [{ unescapedSlashes: true, unescapedUnicode: true }, 'JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE'],
    [{ hexTag: true, hexAmp: true, hexApos: true, hexQuot: true }, 'JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT'],
    [{ unescapedSlashes: true, unescapedUnicode: true, hexTag: true }, 'JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG'],
  ];
  for (const [flags, phpFlags] of cases) {
    const fromPhp = execFileSync('php', ['-r', `echo json_encode(json_decode(stream_get_contents(STDIN), true), ${phpFlags});`], { input: JSON.stringify(value) }).toString();
    assert.equal(phpJson(value, flags), fromPhp, phpFlags);
  }
});

test('passwords are $2y$ bcrypt hashes Node verifies', async () => {
  const hash = await passwordHash('test1234');
  assert.match(hash, /^\$2y\$10\$/);
  assert.equal(await passwordVerify('test1234', hash), true);
  assert.equal(await passwordVerify('test12345', hash), false);
});

test('passwords work both ways', { skip: PHP_SKIP }, async () => {
  const hash = await passwordHash('test1234');
  assert.equal(php('return password_verify("test1234", $in);', hash), true);
  const phpHash = php('return password_hash("geheim123", PASSWORD_DEFAULT);', null) as string;
  assert.equal(await passwordVerify('geheim123', phpHash), true);
  assert.equal(await passwordVerify('wrong', phpHash), false);
});

test('time zone offset matches date("P")', { skip: PHP_SKIP }, () => {
  // Wie db.php: erst die Zeitzone der Seite setzen
  assert.equal(tzOffset(timeZone()), php('date_default_timezone_set(oys_config("timezone", "Europe/Berlin")); return date("P");', null));
});

test('time zone offset follows summer time', () => {
  // Sommerzeit: im Juli eine Stunde mehr
  assert.equal(tzOffset('Europe/Berlin', new Date('2026-07-01T12:00:00Z')), '+02:00');
  assert.equal(tzOffset('Europe/Berlin', new Date('2026-12-01T12:00:00Z')), '+01:00');
});
