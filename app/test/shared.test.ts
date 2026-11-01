// Gemeinsame Bausteine, die mehrere Bereiche brauchen: Upload-Namen und -Pfade, Code-Seiten-Uploads, rawurldecode
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ROOT_DIR } from '../src/config.js';
import { uploadNameOk, uploadsDir, uploadsDefaultDir, uploadsExternal, uploadsSuggestedDir, uploadPath } from '../src/content/storage.js';
import { usedUploadsIn } from '../src/code/sites.js';
import { rawurldecode } from '../src/php.js';

function php(code: string, input: unknown): unknown {
  const script = `require '${ROOT_DIR}/lib/config.php'; require '${ROOT_DIR}/lib/storage.php';`
    + `$in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in); echo json_encode($out);`;
  return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(input), cwd: ROOT_DIR }).toString());
}

test('upload names and paths match PHP', () => {
  const names = ['avatar_5_1700000000_abcdef12.png', '', '.htaccess', 'a/b.png', 'a\\b.png', 'a..b', 'x'.repeat(200), 'x'.repeat(201), 'ä'.repeat(100), 'ä'.repeat(101), 'ok name.pdf', 'nul\0x'];
  assert.deepEqual(names.map(uploadNameOk), php('return array_map("oys_upload_name_ok", $in);', names));
  assert.deepEqual([uploadsDir(), uploadsDefaultDir(), uploadsExternal(), uploadsSuggestedDir(), uploadPath('x.png')],
    php('return [oys_uploads_dir(), oys_uploads_default_dir(), oys_uploads_external(), oys_uploads_suggested_dir(), oys_upload_path("x.png")];', null));
});

test('rawurldecode matches PHP', () => {
  const inputs = ['a%20b', 'a+b', '%41%42', '%zz', '%4', '100%', '%C3%A4', '%E2%82%AC', 'ä%20ö', '%%41'];
  assert.deepEqual(inputs.map(rawurldecode), php('return array_map("rawurldecode", $in);', inputs));
  // Ungültiges UTF-8 kann PHP gar nicht als Text weitergeben – Node liest es als Ersatzzeichen
  assert.equal(rawurldecode('%FF'), '\uFFFD');
});

test('uploads used by a code page match PHP', () => {
  const files = ['<img src="/static/uploads/avatar_5_1700000000_abcdef12.png">', 'url(static/uploads/old%20file.jpg) bg_5_17000000001_0123abcd.webp',
    'x_6_1700000000_abcdef12.png file_5_123_abcdef12.png', "'static/uploads/a.b-c_d.mp3' static/uploads/ static/uploads/%C3%A4.png"];
  const phpUsed = php(`$used = []; foreach ($in as $content) {
      if (preg_match_all('#[a-z]+_5_\\d{9,11}_[0-9a-f]{8}\\.[a-z0-9]{2,5}#', $content, $m)) foreach ($m[0] as $n) $used[$n] = true;
      if (preg_match_all('#static/uploads/([A-Za-z0-9._%-]+)#', $content, $m)) foreach ($m[1] as $n) $used[rawurldecode($n)] = true;
    } return array_keys($used);`, files);
  assert.deepEqual([...usedUploadsIn(files, 5)], phpUsed);
});
