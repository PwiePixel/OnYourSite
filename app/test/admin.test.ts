// Admin-Panel: kleine Bausteine gegen die echten PHP-Ausdrücke aus views/admin.php und views/admin_storage.php
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addslashes, joined, smtpValue } from '../src/admin/views/admin.js';
import { fmtSize } from '../src/admin/views/storage.js';
import { phpIntBig } from '../src/admin/page.js';
import { emailTemplates, saveSmtp, setEmailDirForTests, smtpConfig, utf8Substitute } from '../src/admin/newsletter.js';
import { phpJsonDecode } from '../src/community/json.js';
import { e } from '../src/html.js';

// PHP-Ausdruck über alle Eingaben (JSON hinein, JSON heraus)
function php(code: string, input: unknown): unknown {
  const script = `$in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in); echo json_encode($out);`;
  return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(input) }).toString());
}
const each = (fn: string, inputs: unknown[]) => php(`return array_map(function ($v) { return ${fn}; }, $in);`, inputs);

const tmp = mkdtempSync(join(tmpdir(), 'oys-admin-'));
after(() => {
  setEmailDirForTests(null);
  rmSync(tmp, { recursive: true, force: true });
});

test('addslashes() for openPwdModal matches PHP', () => {
  const names = ["O'Brien", 'a"b', 'back\\slash', 'nul\0byte', '', 'plain', "mix'\"\\\0end", 'Zoë 😀'];
  assert.deepEqual(names.map(addslashes), each('addslashes($v)', names));
});

test('"Joined:" (date(\'M j, Y\', strtotime($created_at ?? \'now\'))) matches PHP, also for the zero TIMESTAMP', () => {
  const values = ['0000-00-00 00:00:00', '0001-01-01 00:00:00', '0099-12-31 23:59:59', '1970-01-01 00:00:00', '1969-12-31 23:59:59', '2038-01-19 03:14:07',
    '2024-03-31 02:30:00', '2024-10-27 02:30:00', '2026-12-31 23:59:59', '9999-12-31 23:59:59', '', 'garbage'];
  const ref = php('date_default_timezone_set("Europe/Berlin"); return array_map(fn($v) => date("M j, Y", strtotime($v ?? "now")), $in);', values);
  assert.deepEqual(values.map(joined), ref);
  assert.equal(joined('0000-00-00 00:00:00'), 'Nov 30, -0001');
});

test('storage sizes ($fmtSize) match PHP round() and float output', () => {
  const sizes = [0, 1, 511, 512, 513, 1023, 1024, 1536, 10239, 10240, 1048575, 1048576, 1572864, 1153433, 1073741823, 1073741824,
    1610612736, 5e9, 123456789, 999999999, 2147483648, 1288490188];
  for (let i = 0; i < 200; i++) sizes.push(Math.floor(Math.random() * 3e9));
  const ref = php('$f = function (int $b) { return $b >= 1073741824 ? round($b / 1073741824, 2) . \' GB\' : ($b >= 1048576 ? round($b / 1048576, 1) . \' MB\' : round($b / 1024) . \' KB\'); }; return array_map($f, $in);', sizes);
  assert.deepEqual(sizes.map(fmtSize), ref);
});

test('(int) for the user number in the reset message matches PHP, also beyond 2^53', () => {
  const values = ['5', ' 5', '5 ', '+5', '-5', '0x1A', '1e3', '1.9', '-1.9', '9223372036854775807', '9223372036854775808',
    '-9223372036854775808', '-9223372036854775809', '99999999999999999999', '1e400', '-1e400', '.5', '5.', 'abc', '', '12abc',
    ' \t\n12', '00012', '1e18', '9.2233720368547758e18', '-0', '1e19', '-1e19', '123456789012345678', '4.5e15'];
  assert.deepEqual(values.map((v) => phpIntBig(v).toString()), each('(string) (int) $v', values));
  // Arrays: (int) [] = 0, (int) ['x'] = 1
  assert.equal(phpIntBig({ 0: 'x' }).toString(), '1');
  assert.equal(phpIntBig({}).toString(), '0');
});

test('smtp.json is written like json_encode(…, JSON_PRETTY_PRINT) with trimmed values', () => {
  const dir = join(tmp, 'mail1');
  mkdirSync(dir);
  setEmailDirForTests(dir);
  const cases = [
    { smtp_host: ' smtp.example.com ', smtp_port: '587', smtp_username: 'user@x.de', smtp_password: 'pa"ss\\w/rd', from_email: 'a@b.c', from_name: 'OYS <Team> & Co' },
    { smtp_host: 'Zoë 😀', smtp_port: '\t465\n', smtp_username: 'ctrl\x01\x1f\x7f', smtp_password: 'line sep ', from_email: '', from_name: "tab\tin'side" },
    {},
  ];
  for (const c of cases) {
    saveSmtp(c);
    const ref = execFileSync('php', ['-r', `$p = json_decode(stream_get_contents(STDIN), true); echo json_encode([
      'host' => trim($p['smtp_host'] ?? ''), 'port' => trim($p['smtp_port'] ?? ''), 'username' => trim($p['smtp_username'] ?? ''),
      'password' => trim($p['smtp_password'] ?? ''), 'from_email' => trim($p['from_email'] ?? ''), 'from_name' => trim($p['from_name'] ?? '')
    ], JSON_PRETTY_PRINT);`], { input: JSON.stringify(c) }).toString();
    assert.equal(readFileSync(join(dir, 'smtp.json'), 'utf8'), ref);
  }
  // trim(array) ist in PHP ein TypeError – die Anfrage endet mit 500
  assert.throws(() => saveSmtp({ smtp_host: { 0: 'x' } }), TypeError);
});

test('SMTP form values (htmlspecialchars($smtp_config[key] ?? \'\')) match PHP for odd smtp.json files', () => {
  const files = ['{"host":"a&b<\\"\'>"}', '{"host":5}', '{"host":1.5}', '{"host":true}', '{"host":false}', '{"host":null}', '"host"', '5', 'null', '',
    'not json', '{"host":1e100}', '{"host":0.1}', '{"host":-0.0}', '{"host":"\\u00e9"}', '[1,2]', '{"host":12345678901234567890}', '{"host":-7}',
    '{"port":"x"}', '{"host":"ok","host":"dup"}'];
  const ref = php('return array_map(function ($j) { $c = json_decode($j, true); return htmlspecialchars($c[\'host\'] ?? \'\'); }, $in);', files);
  assert.deepEqual(files.map((f) => smtpValue(phpJsonDecode(f), 'host')), ref);
  // Ein Array als Wert: TypeError wie in PHP
  assert.throws(() => smtpValue(phpJsonDecode('{"host":{"a":1}}'), 'host'), TypeError);
});

test('smtp.json is read like file_exists() + json_decode(), without a file as an empty array', () => {
  const dir = join(tmp, 'mail2');
  mkdirSync(dir);
  setEmailDirForTests(dir);
  assert.equal(smtpValue(smtpConfig(), 'host'), '');
  writeFileSync(join(dir, 'smtp.json'), '{"host": "mx.example.org", "port": 25}');
  assert.equal(smtpValue(smtpConfig(), 'host'), 'mx.example.org');
  assert.equal(smtpValue(smtpConfig(), 'port'), '25');
  rmSync(join(dir, 'smtp.json'));
  // Ein Ordner namens smtp.json: file_exists() ja, lesbar nein → leer
  mkdirSync(join(dir, 'smtp.json'));
  assert.equal(smtpValue(smtpConfig(), 'host'), '');
});

test('the template list matches glob(email/*.json) without smtp.json', () => {
  const dir = join(tmp, 'mail3');
  mkdirSync(dir);
  for (const name of ['b.json', 'a.json', 'Z.json', 'smtp.json', 'smtp.example.json', '.hidden.json', 'x.JSON', 'x.json.bak', 'ä.json',
    'a b.json', '_.json', '0.json', 'update0.1.json', 'register.json', 'json', 'xjson']) {
    writeFileSync(join(dir, name), '{}');
  }
  mkdirSync(join(dir, 'dir.json'));
  setEmailDirForTests(dir);
  const ref = php(`$t = []; foreach (glob($in . '/*.json') ?: [] as $f) { if (basename($f) !== 'smtp.json') $t[] = basename($f); } return $t;`, dir);
  assert.deepEqual(emailTemplates(), ref);
  // Ohne Ordner: keine Vorlagen
  setEmailDirForTests(join(tmp, 'missing'));
  assert.deepEqual(emailTemplates(), []);
});

test('invalid UTF-8 is replaced like htmlspecialchars() with ENT_SUBSTITUTE (random byte sequences)', () => {
  // Viele Grenzfälle: Folgebytes, C0/C1, Ersatzzeichen (ED A0..), zu lange Formen (E0 80, F0 80), > U+10FFFF (F4 90), F5..FF
  const pool = [0x41, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xc3, 0xdf, 0xe0, 0xe1, 0xed, 0xef, 0xf0, 0xf1, 0xf4, 0xf5, 0xf8, 0xff];
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const inputs = [Buffer.from('ok äöü 😀'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf4, 0x90, 0x80, 0x80]), Buffer.from([0xc3, 0xff]),
    Buffer.from([0xe0, 0x80, 0x80]), Buffer.from([0xf0, 0x80, 0x80, 0x80]), Buffer.from([0xe2, 0x82]), Buffer.from([0xf0, 0x9f, 0x98])];
  for (let i = 0; i < 3000; i++) inputs.push(Buffer.from(Array.from({ length: 1 + rnd(7) }, () => pool[rnd(pool.length)])));
  const ref = php('return array_map(fn($b) => bin2hex(htmlspecialchars(base64_decode($b))), $in);', inputs.map((b) => b.toString('base64')));
  assert.deepEqual(inputs.map((b) => Buffer.from(utf8Substitute(b), 'utf8').toString('hex')), ref);
});

test('template names with invalid UTF-8 are shown like htmlspecialchars(basename($file))', () => {
  const dir = join(tmp, 'mail4');
  mkdirSync(dir);
  const names = [[0x61, 0xff, 0x62], [0x63, 0xed, 0xa0, 0x80, 0x64], [0x65, 0xc0, 0x80, 0x66], [0x67, 0xe2, 0x82, 0x68], [0x6b, 0xf4, 0x90, 0x80, 0x80, 0x6c], [0x6d, 0xc3]];
  for (const n of names) writeFileSync(Buffer.concat([Buffer.from(dir + '/'), Buffer.from(n), Buffer.from('.json')]), '{}');
  writeFileSync(join(dir, 'smtp.json'), '{}');
  setEmailDirForTests(dir);
  const ref = php(`$t = []; foreach (glob($in . '/*.json') ?: [] as $f) { if (basename($f) !== 'smtp.json') $t[] = bin2hex(htmlspecialchars(basename($f))); } return $t;`, dir);
  assert.deepEqual(emailTemplates().map((t) => Buffer.from(e(t), 'utf8').toString('hex')), ref);
});
