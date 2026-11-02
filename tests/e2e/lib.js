// Gemeinsame Hilfen der Browser-Tests (Playwright): Prüfungen, Fehler der Seite und – wichtig – jeder native Dialog
// (alert, confirm, prompt) lässt den Lauf scheitern. Nur ein ausdrücklich erwartetes beforeunload wird angenommen.
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const result = { pass: 0, fail: 0, current: '' };

function ok(cond, msg) {
  const label = (result.current ? result.current + ': ' : '') + msg;
  if (cond) {
    result.pass++;
    console.log('PASS ' + label);
  } else {
    result.fail++;
    process.exitCode = 1;
    console.log('FAIL ' + label);
  }
  return !!cond;
}

// t.expectBeforeUnload = true erlaubt genau das Fenster des Browsers beim Verlassen (Tests, die es prüfen)
function watchPage(page, t = {}) {
  page.on('dialog', async (dlg) => {
    if (dlg.type() === 'beforeunload' && t.expectBeforeUnload) {
      t.sawBeforeUnload = (t.sawBeforeUnload || 0) + 1;
      await dlg.accept().catch(() => {});
      return;
    }
    // Erst schließen, sonst hängt die Seite – dann als Fehler zählen
    await dlg.dismiss().catch(() => {});
    ok(false, 'native ' + dlg.type() + ' dialog appeared: ' + dlg.message());
  });
  page.on('pageerror', (err) => ok(false, 'page error: ' + err.message));
  return t;
}

// Ein Testfall: Name für die Ausgabe, Fehler im Test selbst zählen als FAIL (der Lauf geht weiter)
// OYS_E2E_ONLY="teil" führt nur Schritte aus, deren Name den Text enthält (zum Arbeiten an einem Test)
async function step(name, fn) {
  if (process.env.OYS_E2E_ONLY && !name.includes(process.env.OYS_E2E_ONLY)) return;
  result.current = name;
  try {
    await fn();
  } catch (err) {
    ok(false, 'threw ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err));
  }
  result.current = '';
}

function summary(name) {
  console.log(`${name}: ${result.pass} passed, ${result.fail} failed`);
  if (result.fail) process.exitCode = 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { ROOT, ok, watchPage, step, summary, sleep, result };
