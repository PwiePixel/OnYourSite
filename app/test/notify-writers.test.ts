// Prüfregel: Benachrichtigungen schreibt nur app/src/notify/ (notify(), notifyAdmins()). Nur so gelten überall
// dieselben Regeln (Längen, sichere Ziele, Typen) und „genau einmal“ über die Transaktion der Funktion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const RAW_WRITE = /\b(?:INSERT|REPLACE)\s+(?:LOW_PRIORITY\s+|DELAYED\s+|HIGH_PRIORITY\s+)?(?:IGNORE\s+)?INTO\s+`?notifications`?(?![A-Za-z0-9_])/i;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(p));
    else if (/\.(ts|js|mjs)$/.test(entry.name)) out.push(p);
  }
  return out;
}

test('only app/src/notify/ writes rows into notifications', () => {
  const offenders: string[] = [];
  for (const file of files(SRC)) {
    const rel = relative(SRC, file).split('\\').join('/');
    if (rel.startsWith('notify/')) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (RAW_WRITE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'use notify()/notifyAdmins() from app/src/notify/notify.ts instead');
  // Die Regel findet, was sie finden soll
  for (const bad of ['INSERT INTO notifications (user_id)', 'insert ignore into `notifications` (x)', 'REPLACE INTO notifications SET', 'INSERT LOW_PRIORITY INTO notifications']) {
    assert.ok(RAW_WRITE.test(bad), bad);
  }
  for (const ok of ['DELETE FROM notifications WHERE user_id = ?', 'UPDATE notifications SET is_read = 1', 'INSERT INTO notifications_archive (id)']) {
    assert.ok(!RAW_WRITE.test(ok), ok);
  }
});
