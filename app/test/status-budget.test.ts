// Statusseiten, Mail-Budget (rein, ohne Datenbank): die Klassen system, confirm, owner und broadcast in einem Topf –
// system wird nie aufgehalten (zählt aber mit), confirm höchstens confirm_share % und owner höchstens owner_share % des
// Tages, die Minute als Eimer mit Marken (wait), ein neuer Tag setzt die Zähler zurück, giveBack nach einem Fehlschlag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MailBudget } from '../src/status/budget.js';

const LIMITS = { mail_per_min: 6, mail_per_day: 100, confirm_share: 10, owner_share: 30 };
const T0 = 1_800_000_000_000;

test('system is never held back – not by the minute, not by the day – but it counts', () => {
  const b = new MailBudget(LIMITS, '2026-11-02', {}, T0);
  for (let i = 0; i < 150; i++) assert.equal(b.take('system', T0), 'ok');
  assert.equal(b.used.system, 150);
  assert.equal(b.total, 150);
  // Der Eimer ist im Minus: die anderen Klassen warten, der Tag ist für sie aufgebraucht
  assert.equal(b.take('owner', T0), 'day');
  assert.equal(b.dayLeft('system'), true);
});

test('confirm gets at most confirm_share % of the day, owner at most owner_share %', () => {
  const b = new MailBudget({ ...LIMITS, mail_per_min: 1000 }, '2026-11-02', {}, T0);
  assert.equal(b.classCap('confirm'), 10);
  assert.equal(b.classCap('owner'), 30);
  assert.equal(b.classCap('system'), null);
  assert.equal(b.classCap('broadcast'), 100);
  let ok = 0;
  for (let i = 0; i < 20; i++) if (b.take('confirm', T0) === 'ok') ok++;
  assert.equal(ok, 10);
  assert.equal(b.take('confirm', T0), 'day');
  ok = 0;
  for (let i = 0; i < 40; i++) if (b.take('owner', T0) === 'ok') ok++;
  assert.equal(ok, 30);
  assert.equal(b.dayLeft('owner'), false);
  // Broadcasts bekommen, was übrig ist
  ok = 0;
  for (let i = 0; i < 100; i++) if (b.take('broadcast', T0) === 'ok') ok++;
  assert.equal(ok, 60);
  assert.equal(b.total, 100);
});

test('the minute is a bucket: after mail_per_min mails the others wait, a second later one more token is there', () => {
  const b = new MailBudget(LIMITS, '2026-11-02', {}, T0);
  for (let i = 0; i < 6; i++) assert.equal(b.take('owner', T0), 'ok');
  assert.equal(b.take('owner', T0), 'wait');
  assert.equal(b.take('confirm', T0), 'wait');
  assert.equal(b.nextTokenIn(T0), 10_000);
  assert.equal(b.take('owner', T0 + 10_000), 'ok', 'six per minute: one token every 10 s');
  // system geht trotzdem
  assert.equal(b.take('system', T0 + 10_000), 'ok');
  assert.equal(b.take('owner', T0 + 15_000), 'wait');
});

test('a new day starts from zero; giveBack returns the count after a failed send; limits can change', () => {
  const b = new MailBudget({ ...LIMITS, mail_per_min: 1000 }, '2026-11-02', { owner: 30, system: 4 }, T0);
  assert.equal(b.take('owner', T0), 'day');
  b.rollDay('2026-11-02');
  assert.equal(b.used.owner, 30, 'same day: unchanged');
  b.rollDay('2026-11-03');
  assert.deepEqual(b.used, { system: 0, confirm: 0, owner: 0, broadcast: 0 });
  assert.equal(b.take('owner', T0), 'ok');
  b.giveBack('owner');
  assert.equal(b.used.owner, 0);
  b.giveBack('owner');
  assert.equal(b.used.owner, 0, 'never below zero');
  b.setLimits({ ...LIMITS, mail_per_min: 1000, owner_share: 1 });
  assert.equal(b.take('owner', T0), 'ok');
  assert.equal(b.take('owner', T0), 'day');
});
