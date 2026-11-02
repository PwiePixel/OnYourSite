// Formularwerte mit ungültigem UTF-8: PHP behält die rohen Bytes. strlen() zählt sie, oys_clean_text() und
// oys_clean_url() geben dann '' zurück, e() ersetzt sie (ENT_SUBSTITUTE), password_hash() rechnet mit ihnen. Node hält
// sie als U+DC80–U+DCFF (phpText) und rechnet überall dort wie PHP, wo das Ergebnis von den Bytes abhängt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ROOT_DIR } from '../src/config.js';
import { hasRawBytes, mbStrlen, mbSubstr, phpBytes, phpText, rawurlencode, strlen, urlencode, type PhpValue } from '../src/php.js';
import { cleanText, cleanUrl } from '../src/helpers.js';
import { e, xmlEscape } from '../src/html.js';
import { md5Hex, passwordHash, passwordVerify, sha256Hex } from '../src/crypto.js';
import { readBody } from '../src/server.js';
import { makeTestCtx } from '../src/web/ctx.js';

function php(code: string, input: unknown): unknown {
  const script = `require '${ROOT_DIR}/lib/config.php'; require '${ROOT_DIR}/blacklist.php'; require '${ROOT_DIR}/lib/helpers.php'; mb_internal_encoding('UTF-8');`
    + `$in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in); echo json_encode($out);`;
  return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(input), maxBuffer: 1 << 26 }).toString());
}

// Zufällige Bytes aus gültigen und kaputten Stücken (abgeschnittene Folgen, Surrogate, zu lange Formen, > U+10FFFF)
function randomBytes(count: number, seed: number): Buffer[] {
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pieces = [[0x61], [0x20], [0x0a], [0x0d, 0x0a], [0x3c], [0x26], [0x27], [0x09], [0xc3, 0xa4], [0xe2, 0x82, 0xac], [0xf0, 0x9f, 0x98, 0x80],
    [0xc2, 0xa0], [0xef, 0xbf, 0xbd], [0xff], [0xfe], [0xc3], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xc0, 0xaf], [0x80],
    [0xe0, 0x80], [0xf0, 0x90], [0xe0, 0xa0], [0xf5], [0xf1, 0x80, 0x80], [0x2e], [0x2f], [0x40]];
  return Array.from({ length: count }, () => Buffer.from(Array.from({ length: rnd(9) }, () => pieces[rnd(pieces.length)]).flat()));
}

const hex = (s: string): string => phpBytes(s).toString('hex');

test('raw bytes survive the round trip and valid text stays as it was', () => {
  for (const b of randomBytes(3000, 3)) assert.deepEqual(phpBytes(phpText(b)), b, b.toString('hex'));
  for (const s of ['', 'abc', 'Größe €', '😀 x', '�']) {
    assert.equal(phpText(Buffer.from(s, 'utf8')), s);
    assert.equal(hasRawBytes(s), false);
  }
  assert.equal(phpText(Buffer.from([0x61, 0xff])), 'a\uDCFF');
  assert.equal(hasRawBytes('a\uDCFF'), true);
  // Ein echtes Zeichen außerhalb der BMP (Surrogatpaar) ist kein rohes Byte
  assert.equal(hasRawBytes('💀'), false);
});

test('length, mb_*, cleaning, escaping, URL encoding and hashes of raw bytes match PHP', () => {
  const inputs = randomBytes(1500, 11);
  const ref = php(`return array_map(function ($h) { $s = hex2bin($h); return [strlen($s), mb_strlen($s), bin2hex(mb_substr($s, 0, 3)), bin2hex(mb_substr($s, 1)),
    bin2hex(oys_clean_text($s)), bin2hex(oys_clean_text($s, 255, true)), bin2hex(oys_clean_url($s)), bin2hex(e($s)), bin2hex(htmlspecialchars($s, ENT_XML1 | ENT_QUOTES)),
    rawurlencode($s), urlencode($s), hash('sha256', $s), md5($s)]; }, $in);`,
  inputs.map((b) => b.toString('hex'))) as unknown[][];
  const mine = inputs.map((b) => {
    const s = phpText(b);
    return [strlen(s), mbStrlen(s), hex(mbSubstr(s, 0, 3)), hex(mbSubstr(s, 1)), hex(cleanText(s)), hex(cleanText(s, 255, true)), hex(cleanUrl(s)),
      Buffer.from(e(s), 'utf8').toString('hex'), Buffer.from(xmlEscape(s), 'utf8').toString('hex'), rawurlencode(s), urlencode(s), sha256Hex(s), md5Hex(s)];
  });
  const diffs = mine.map((m, i) => ({ input: inputs[i].toString('hex'), node: m, php: ref[i] })).filter((d) => JSON.stringify(d.node) !== JSON.stringify(d.php));
  assert.deepEqual(diffs.slice(0, 5), []);
});

// $_POST/$_GET als Hex (Schlüssel und Werte), Reihenfolge der Schlüssel egal
const hexTree = (v: PhpValue): unknown => (typeof v === 'string' ? hex(v)
  : Object.entries(v).map(([k, x]) => [hex(k), hexTree(x)]).sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)));
const PHP_HEX_TREE = 'function h($v) { if (!is_array($v)) return bin2hex($v); $o = []; foreach ($v as $k => $x) $o[] = [bin2hex((string) $k), h($x)]; usort($o, fn ($a, $b) => strcmp($a[0], $b[0])); return $o; }';

test('form bodies and query strings keep raw bytes like PHP', async () => {
  const bodies = [Buffer.from('name=Mia%FF&pw=%E2%82%ED%A0%80&ok=%C3%A4&raw=', 'latin1'), Buffer.concat([Buffer.from('direct='), Buffer.from([0xff, 0xc3]), Buffer.from('&k%FE=v')]),
    Buffer.from('a[%FF]=1&a[b%C3]=2&x=%25%FF%2B+%FF', 'latin1'), ...randomBytes(300, 21).map((b) => Buffer.concat([Buffer.from('f='), b, Buffer.from('&g%C3'), b]))];
  const ref = php(`${PHP_HEX_TREE} return array_map(function ($b) { parse_str(hex2bin($b), $o); return h($o); }, $in);`, bodies.map((b) => b.toString('hex'))) as unknown[];
  for (const [i, body] of bodies.entries()) {
    const ctx = makeTestCtx({ method: 'POST', url: '/' });
    await readBody(ctx, 'application/x-www-form-urlencoded', body);
    assert.deepEqual(hexTree(ctx.post), ref[i], body.toString('hex'));
  }
  // $_GET aus der Adresse (die Anfragezeile selbst ist ASCII, Bytes kommen über %XX)
  const ctx = makeTestCtx({ url: '/x?q=%FF%FEa&n=%F0%9F%98%80' });
  assert.deepEqual(hexTree(ctx.get), (php(`${PHP_HEX_TREE} parse_str($in, $o); return h($o);`, 'q=%FF%FEa&n=%F0%9F%98%80')));
});

test('sign-up checks see the bytes PHP sees: name is cleaned to nothing, the password length counts bytes', async () => {
  // 7 rohe Bytes: PHP zählt 7 (zu kurz), mit U+FFFD wären es 21 Bytes gewesen
  const body = 'fullname=Mia%FF&password=%FF%FF%FF%FF%FF%FF%FF&password2=%FF%FF%FF%FF%FF%FF%FF%FF';
  const ctx = makeTestCtx({ method: 'POST', url: '/register' });
  await readBody(ctx, 'application/x-www-form-urlencoded', Buffer.from(body));
  const mine = [cleanText(ctx.post.fullname ?? '', 120), strlen(ctx.p('password')), strlen(ctx.p('password2'))];
  assert.deepEqual(mine, php(`parse_str($in, $p); return [oys_clean_text($p['fullname'] ?? '', 120), strlen($p['password']), strlen($p['password2'])];`, body));
  assert.deepEqual(mine, ['', 7, 8]);
});

test('passwords with raw bytes hash and verify like PHP in both directions', async () => {
  const raw = [Buffer.from([0xff, 0xfe, 0x41]), Buffer.from('pass\xe2\x82word', 'latin1'), Buffer.from([0xed, 0xa0, 0x80, 0x61]), Buffer.from([0xc3, 0xa4, 0xff]),
    Buffer.concat([Buffer.alloc(70, 0x78), Buffer.from([0xff, 0xff, 0xff])]), ...randomBytes(6, 5).filter((b) => b.length > 0 && !b.includes(0))];
  const pws = raw.map(phpText);
  const nodeHashes = await Promise.all(pws.map((p) => passwordHash(p)));
  for (const h of nodeHashes) assert.match(h, /^\$2y\$10\$[./A-Za-z0-9]{53}$/);
  const out = php(`return array_map(fn ($p, $h) => [password_verify(hex2bin($p), $h), password_hash(hex2bin($p), PASSWORD_DEFAULT, ['cost' => 5])], $in[0], $in[1]);`,
    [raw.map((b) => b.toString('hex')), nodeHashes]) as Array<[boolean, string]>;
  assert.deepEqual(out.map((o) => o[0]), raw.map(() => true), 'PHP accepts the hashes from Node');
  for (const [i, [, phpHash]] of out.entries()) {
    assert.equal(await passwordVerify(pws[i], phpHash), true, `Node accepts PHP's hash of ${raw[i].toString('hex')}`);
    // Andere Bytes (auch wenn sie als U+FFFD gleich aussähen) passen nicht
    const other = Buffer.from(raw[i]);
    other[other.length - 1] ^= 0x01;
    assert.equal(await passwordVerify(phpText(other), phpHash), php('return password_verify(hex2bin($in[0]), $in[1]);', [other.toString('hex'), phpHash]));
  }
});
