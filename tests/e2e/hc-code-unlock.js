// E2E: Code-Seite freischalten über den Shop (honeycomb-shop HC-3). Der Dialog erzeugt beim Öffnen eine Kauf-Kennung
// und schickt den Preis mit, den er zeigt; ändert sich der Preis inzwischen, bleibt der Dialog offen und zeigt den neuen
// Preis. Ein Doppelklick bucht einmal, nach dem Kauf kommt das Formular „Create your code page“, und ein Admin im
// Nutzer-Modus kann nichts ausgeben. Kein Browser-Dialog (alert/confirm/prompt) darf erscheinen.
//
// Start (Datenbank muss laufen, z. B. über oys-db.sh run):
//   node tests/e2e/hc-code-unlock.js
// Umgebung wie tests/e2e/admin-split.js: OYS_E2E_PORT, OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_SHOTS.
// Nur gegen eine Test-Datenbank (Name beginnt mit oys_test; sonst Abbruch mit Code 2, bevor er die Datenbank aufruft).
// Der Test setzt Honigwaben, Freischaltung, Käufe und Code-Seite des Testkontos lea@test.de (id 7) vorher und nachher
// zurück und stellt den Preis der Code-Seite wieder auf 100.
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.OYS_E2E_PORT || 14204);
const CONFIG = process.env.OYS_CONFIG || path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const DB_NAME = String((cfg.db && cfg.db.name) || '');
if (!DB_NAME.startsWith('oys_test')) {
  console.error(`Refusing to run: ${CONFIG} uses the database "${DB_NAME}", which is not a test database (oys_test…).`);
  process.exit(2);
}
const HOST = String(cfg.base_domain || 'on-your.site').split(':')[0];
const BASE = `http://${HOST}:${PORT}`;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';

const mysqlArgs = ['--default-character-set=utf8mb4', '-N', '-h', String(cfg.db.host || 'localhost'), '-u', String(cfg.db.user), String(cfg.db.name)];
const sql = (query) => execFileSync('mysql', [...mysqlArgs, '-e', query], { env: { ...process.env, MYSQL_PWD: String(cfg.db.pass || '') } }).toString().trim();
let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failed++;
};

async function startServer() {
  const server = spawn(path.join(ROOT, 'app/node_modules/.bin/tsx'), ['src/server.ts'], {
    cwd: path.join(ROOT, 'app'), env: { ...process.env, PORT: String(PORT), OYS_CONFIG: CONFIG }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 150; i++) {
    if (log.includes('listening')) return server;
    if (server.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  server.kill();
  throw new Error('server did not start:\n' + log);
}

const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });

// Lea ohne Code-Seite, Freischaltung, Käufe und Honigwaben; die Regeln noch nicht akzeptiert
const reset = () => {
  sql(`DELETE FROM code_files WHERE site_id IN (SELECT id FROM code_sites WHERE user_id = 7);
    DELETE FROM code_sites WHERE user_id = 7; DELETE FROM honeycomb_ledger WHERE user_id = 7; DELETE FROM rate_limits WHERE rl_key = 'hcbuy:7';
    UPDATE users SET code_terms_at = NULL WHERE id = 7;`);
  if (sql("SHOW TABLES LIKE 'hc\\_purchases'") !== '') {
    sql(`DELETE FROM hc_entitlements WHERE user_id = 7; DELETE FROM hc_purchases WHERE user_id = 7; DELETE FROM hc_accounts WHERE user_id = 7;
      UPDATE hc_items SET price = 100 WHERE item_key = 'code_page'; DELETE FROM hc_offers WHERE label = 'e2e';`);
  }
};
// Honigwaben geben (wie ein Geschenk des Teams); den Tagesbonus für heute als schon gebucht (0) eintragen, damit das
// Laden des Editors nichts dazu verdient und der Kontostand genau n ist
const give = (n) => sql(`INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES
    (7, ${n}, 'admin', CONCAT('a3-', LPAD(HEX(FLOOR(RAND() * 4294967295)), 16, '0')), 'e2e', NOW()),
    (7, 0, 'daily', DATE_FORMAT(NOW(), '%Y-%m-%d'), '', NOW())
    ON DUPLICATE KEY UPDATE note = note;`);
const unlocks = () => Number(sql("SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = 7 AND reason = 'unlock'"));

async function login(browser, email) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await context.newPage();
  await p.goto(BASE + '/login');
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', PASSWORD);
  await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
  return p;
}

// Den Editor neu laden und den Code-Tab öffnen (ein reiner Wechsel des #-Teils lädt die Seite nicht neu)
let loads = 0;
const codeTab = (p) => p.goto(BASE + '/dashboard?load=' + ++loads + '#code', { waitUntil: 'networkidle' });

async function openUnlock(p) {
  await codeTab(p);
  await p.locator('#tab-code .code-hero').waitFor();
  await p.click('#tab-code [data-code=unlock]');
  await p.locator('#codeUnlockGo').waitFor();
}

(async () => {
  reset();
  const server = await startServer();
  reset();
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP *.${HOST} 127.0.0.1`] });
  const errors = [];
  const dialogs = [];
  try {
    give(150);
    const p = await login(browser, 'lea@test.de');
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });

    // Dialog öffnen; ohne Haken bei den Regeln geht nichts raus
    await openUnlock(p);
    ok((await p.locator('#codePrice').innerText()) === '100', 'The dialog shows the price (100)');
    await p.click('#codeUnlockGo');
    ok((await p.locator('#codeErr').innerText()).includes('Please accept the rules for code pages first.'), 'Without the rules ticked nothing is sent');
    ok(unlocks() === 0, 'Nothing booked yet');
    await p.check('#codeTerms');

    // Der Preis ändert sich, während der Dialog offen ist
    sql("UPDATE hc_items SET price = 120 WHERE item_key = 'code_page'");
    await p.click('#codeUnlockGo');
    await p.locator('#codeErr:has-text("The price changed")').waitFor();
    ok((await p.locator('#codeErr').innerText()) === 'The price changed – this now costs 120 honeycombs.', 'A changed price: the server text in the dialog');
    ok((await p.locator('#codePrice').innerText()) === '120' && (await p.locator('#codeAfter').innerText()) === '30', 'The dialog shows the new price and what is left');
    ok(await p.locator('#codeUnlockGo').isVisible(), 'The dialog stays open');
    ok(unlocks() === 0, 'Nothing booked on a price change');
    await shot(p, 'hc-unlock-price-changed');

    // Noch einmal: freigeschaltet zum neuen Preis
    await p.click('#codeUnlockGo');
    await p.locator('#tab-code #codeSlug').waitFor();
    ok(!(await p.locator('#codeUnlockGo').isVisible()), 'The dialog closes after the purchase');
    ok((await p.locator('.ui-toasts').innerText()).includes('Code page unlocked – 120 honeycombs spent.'), 'Toast with the amount spent');
    ok((await p.locator('#hcBalance').innerText()).trim() === '30', 'The balance pill shows the new balance (' + (await p.locator('#hcBalance').innerText()) + ')');
    ok(unlocks() === 1 && sql("SELECT CONCAT(amount, '|', ref) FROM honeycomb_ledger WHERE user_id = 7 AND reason = 'unlock'") === '-120|code_page', 'One unlock booked: −120');
    ok(sql("SELECT CONCAT(via, '|', price, '|', list_price) FROM hc_purchases WHERE user_id = 7") === 'code|120|120', 'One purchase via the code tab');
    await shot(p, 'hc-unlock-done');

    // Doppelklick: einmal gebucht
    reset();
    give(300);
    await openUnlock(p);
    await p.check('#codeTerms');
    await p.dblclick('#codeUnlockGo');
    await p.locator('#tab-code #codeSlug').waitFor();
    ok(unlocks() === 1, 'A double click books once');

    // Zu wenig Honigwaben: der Knopf ist aus und sagt, wie viele fehlen
    reset();
    give(30);
    await codeTab(p);
    await p.locator('#tab-code .code-hero').waitFor();
    const btn = p.locator('#tab-code [data-code=unlock]');
    ok(await btn.isDisabled() && (await btn.innerText()).includes('70 more honeycombs needed'), 'Not enough: disabled, "70 more honeycombs needed"');

    // Der Preis steigt im offenen Dialog über den Kontostand: der Dialog sagt, wie viele fehlen, und bietet keinen Kauf
    // an (keine negative Zahl „übrig“)
    reset();
    give(100);
    await openUnlock(p);
    await p.check('#codeTerms');
    sql("UPDATE hc_items SET price = 130 WHERE item_key = 'code_page'");
    await p.click('#codeUnlockGo');
    await p.locator('#codeErr:has-text("The price changed")').waitFor();
    const left = await p.locator('p:has-text("You unlock it once")').innerText();
    ok(left.includes('You need 30 more honeycombs.') && !/[-−]\s*\d/.test(left), 'Price above the balance: the dialog says how many are missing (' + left + ')');
    ok(await p.locator('#codeUnlockGo').isDisabled(), 'Price above the balance: the unlock button is off');
    ok(unlocks() === 0, 'Price above the balance: nothing booked');
    await shot(p, 'hc-unlock-price-above-balance');

    // Ein Angebot: der Code-Tab zeigt den Angebotspreis, gekauft wird zu diesem Preis
    reset();
    give(100);
    sql(`INSERT INTO hc_offers (label, scope, percent_off, fixed_price, starts_at, ends_at, max_uses, uses, per_user_max, min_account_days, min_active_days,
      cancelled_at, form_ref, created_by, created_at) VALUES ('e2e', 'item:code_page', 25, NULL, NOW() - INTERVAL 1 DAY, NOW() + INTERVAL 1 DAY, NULL, 0, NULL, 0, 0,
      NULL, LPAD(HEX(FLOOR(RAND() * 4294967295)), 16, '0'), 3, NOW())`);
    await openUnlock(p);
    ok((await p.locator('#codePrice').innerText()) === '75', 'With a 25 % offer the dialog shows 75');
    await p.check('#codeTerms');
    await p.click('#codeUnlockGo');
    await p.locator('#tab-code #codeSlug').waitFor();
    ok(sql("SELECT CONCAT(price, '|', list_price, '|', offer_id IS NOT NULL) FROM hc_purchases WHERE user_id = 7") === '75|100|1', 'Bought at the offer price, the offer recorded');

    // Admin im Nutzer-Modus: kann nichts ausgeben, nichts wird geschrieben
    reset();
    give(300);
    const a = await login(browser, 'admin@test.de');
    a.on('pageerror', (e) => errors.push(e.message));
    a.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    await a.goto(BASE + '/admin', { waitUntil: 'networkidle' });
    await a.evaluate(() => {
      const f = document.createElement('form');
      f.method = 'POST';
      f.action = '/admin_impersonate.php';
      for (const [k, v] of [['csrf', document.querySelector('input[name=csrf]').value], ['id', '7']]) {
        const i = document.createElement('input');
        i.type = 'hidden';
        i.name = k;
        i.value = v;
        f.appendChild(i);
      }
      document.body.appendChild(f);
      f.submit();
    });
    await a.waitForURL(/\/dashboard/);
    await openUnlock(a);
    await a.check('#codeTerms');
    await a.click('#codeUnlockGo');
    await a.locator('#codeErr:has-text("admin mode")').waitFor();
    ok((await a.locator('#codeErr').innerText()) === 'Buying is turned off in admin mode.', 'Admin mode: buying is refused in the dialog');
    ok(unlocks() === 0 && sql('SELECT COALESCE(code_terms_at, \'-\') FROM users WHERE id = 7') === '-', 'Admin mode: nothing booked, the rules not accepted for the user');
    await shot(a, 'hc-unlock-admin-mode');

    ok(dialogs.length === 0, 'No browser dialog' + (dialogs.length ? ': ' + dialogs.join(' | ') : ''));
    ok(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    server.kill();
    reset();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  try {
    reset();
  } catch {
    // Datenbank nicht erreichbar: nichts aufzuräumen
  }
  process.exit(1);
});
