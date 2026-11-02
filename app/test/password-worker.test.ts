// Passwörter rechnen in Worker-Threads: gleichzeitige Anmeldungen halten den Event-Loop nicht an, die Ergebnisse sind
// dieselben wie mit PHP (die Paritätsprüfungen stehen in auth.test.ts und compat.test.ts), und ein Befehl, der ein
// Passwort prüft, endet danach von selbst.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { APP_DIR } from '../src/config.js';
import { passwordHash, passwordVerify } from '../src/crypto.js';

test('several concurrent logins keep the event loop responsive', async () => {
  const hash = await passwordHash('right password');
  // PHP-Hashes in allen drei bcrypt-Schreibweisen
  const phpHash = execFileSync('php', ['-r', 'echo password_hash("right password", PASSWORD_DEFAULT);']).toString();
  const hashes = [hash, phpHash, phpHash.replace(/^\$2y\$/, '$2a$'), phpHash.replace(/^\$2y\$/, '$2b$')];

  // Ein Zeitgeber läuft nebenher (der Event-Loop soll ihn bedienen können)
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const before = performance.eventLoopUtilization();
  const checks = Array.from({ length: 12 }, (_, i) => passwordVerify(i % 3 === 0 ? 'wrong' : 'right password', hashes[i % 4]));
  const results = await Promise.all(checks);
  const busy = performance.eventLoopUtilization(before);
  clearInterval(timer);

  assert.deepEqual(results, Array.from({ length: 12 }, (_, i) => i % 3 !== 0));
  // Zwölf Prüfungen kosten zusammen rund eine Sekunde Rechenzeit – im Haupt-Thread wäre der Event-Loop fast die ganze
  // Zeit belegt (gemessen: 100 %). Mit den Workern wartet er fast nur. Gemessen wird die Auslastung des Event-Loops,
  // nicht die längste Pause: auf der geteilten Testmaschine bekommt der Prozess manchmal hunderte Millisekunden lang
  // keine CPU, ohne dass der Event-Loop etwas rechnet.
  assert.ok(busy.utilization < 0.5, `event loop busy ${(busy.utilization * 100).toFixed(0)} % of the time`);
  assert.ok(ticks > 0);
});

test('hashes match PHP and a short command still ends by itself', async () => {
  const pws = ['test1234', 'ä€😀 x', 'x'.repeat(80)];
  const hashes = await Promise.all(pws.map((p) => passwordHash(p)));
  for (const h of hashes) assert.match(h, /^\$2y\$10\$[./A-Za-z0-9]{53}$/);
  const ok = JSON.parse(execFileSync('php', ['-r', '$in = json_decode(stream_get_contents(STDIN), true); echo json_encode(array_map(fn ($p, $h) => password_verify($p, $h), $in[0], $in[1]));'],
    { input: JSON.stringify([pws, hashes]) }).toString());
  assert.deepEqual(ok, [true, true, true]);
  // Die Worker laufen im Leerlauf weiter, halten den Prozess aber nicht offen
  const started = Date.now();
  const out = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "const c = await import('./src/crypto.ts'); const h = await c.passwordHash('pw'); console.log(await c.passwordVerify('pw', h), await c.passwordVerify('px', h));"],
    { cwd: APP_DIR, timeout: 30000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
  assert.equal(out.trim(), 'true false');
  assert.ok(Date.now() - started < 20000, 'the command ended by itself');
});
