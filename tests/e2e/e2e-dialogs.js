// Ende-zu-Ende: eigene Bestätigungen im Admin und Formular-Meldungen beim Anmelden (custom-dialogs CD-3).
// Abläufe 6 (Admin, ohne Glocke), 7 (Admin ohne ui.js: nichts ändert sich) und 9 (Registrieren, Anmelden, Konto).
// Braucht einen laufenden Server und seine Datenbank (zurückgesetzt):
//   OYS_E2E_PORT=8080 node tests/e2e/e2e-dialogs.js
// Umgebung: OYS_E2E_PORT, OYS_E2E_DOMAIN (Vorgabe oys.test:<Port>), OYS_CONFIG (Vorgabe config.json im Projekt; daraus
// Datenbank und Zugang), OYS_E2E_DB (statt der Datenbank aus der Konfiguration), OYS_E2E_PASSWORD.
// Der Ablauf löscht und ändert Testkonten: er läuft nur gegen eine Test-Datenbank (Name beginnt mit oys_test), sonst
// Abbruch mit Code 2, bevor er die Datenbank aufruft. Jeder native Dialog (alert/confirm/prompt) lässt ihn scheitern.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { chromium } = require('playwright');
const { ROOT, ok, watchPage, step, summary, sleep } = require('./lib');

const CONFIG = process.env.OYS_CONFIG || path.join(ROOT, 'config.json');
const cfg = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};
const dbCfg = cfg.db || {};
const DB = String(process.env.OYS_E2E_DB || dbCfg.name || '');
if (!DB.startsWith('oys_test') || !/^[A-Za-z0-9_]+$/.test(DB)) {
  console.error(`Refusing to run: the database "${DB}" is not a test database (oys_test…).`);
  process.exit(2);
}
const PORT = process.env.OYS_E2E_PORT || '8080';
const DOMAIN = (process.env.OYS_E2E_DOMAIN || 'oys.test:' + PORT).toLowerCase();
const HOST = DOMAIN.split(':')[0];
const B = 'http://' + DOMAIN;
// Passwort der Testkonten (seed.php) – zur Laufzeit zusammengesetzt
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
if (!/^[a-z0-9.-]+(:\d+)?$/.test(DOMAIN)) throw new Error('invalid OYS_E2E_DOMAIN');

const mysqlArgs = ['--default-character-set=utf8mb4', '-N'].concat(dbCfg.host ? ['-h', String(dbCfg.host)] : [], dbCfg.user ? ['-u', String(dbCfg.user)] : [], [DB]);
const sql = (q) => execFileSync('mysql', mysqlArgs, { input: q, env: { ...process.env, MYSQL_PWD: String(dbCfg.pass || process.env.MYSQL_PWD || '') } }).toString().trim();
const count = (q) => Number(sql(q));
const NOTHING = 'Nothing was changed. Please confirm in the dialog – if no dialog appears, reload the page.';

// Daten, damit jedes Formular mit Rückfrage erscheint
function fixtures() {
  sql(`DELETE FROM code_sites WHERE id = 40;
    INSERT INTO code_sites (id, user_id, slug, title, created_at, updated_at) VALUES (40, 6, 'tomcode', 'Tom', NOW(), NOW());
    DELETE FROM milestone_tasks WHERE milestone_id = 50; DELETE FROM milestones WHERE id = 50;
    INSERT INTO milestones (id, title, status, position, created_at, updated_at) VALUES (50, 'Dialogs', 'planned', 0, NOW(), NOW());
    INSERT INTO milestone_tasks (id, milestone_id, title, position) VALUES (60, 50, 'Write the library', 0), (61, 50, 'Convert the admin', 1);
    DELETE FROM community_tickets WHERE id = 70;
    INSERT INTO community_tickets (id, user_id, user_name, subject, channel_id, status, created_at, updated_at)
      VALUES (70, '123456789012345678', 'Tom', 'Help with my page', '223456789012345678', 'open', NOW(), NOW());`);
  // Discord als verbunden (Webhook) – verschlüsselt wie von der Seite gespeichert; der Link entsteht erst hier
  execSync(`node --import tsx -e "const m = await import('./src/updates/discord.ts'); await m.discordStore({ ...m.discordDefaults(), webhook_url: 'https://discord.com/api/webhooks/123456789012/' + 'w'.repeat(40) }); process.exit(0);"`,
    { cwd: ROOT + '/app', stdio: 'inherit' });
}

let browser;
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const t = watchPage(page, {});
  page.on('console', (m) => { if (m.type() === 'error' && !/tailwindcss|favicon|ERR_FAILED|net::/.test(m.text())) ok(false, 'console error: ' + m.text()); });
  if (opts.blockUi) await page.route('**/static/js/ui.js*', (r) => r.abort());
  return { ctx, page, t };
}
async function login(page, email) {
  await page.goto(B + '/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
}
const row = (page, email) => page.locator('#userTable tbody tr', { hasText: email });
const dialogTitle = (page) => page.locator('.ui-dialog .ui-title').textContent();
async function confirmDialog(page, how) {
  await page.waitForSelector('.ui-dialog');
  if (how === 'cancel') await page.click('.ui-dialog .ui-btn.is-ghost');
  else await page.click('.ui-dialog .ui-foot .ui-btn:not(.is-ghost)');
}
// Absenden mit Bestätigung: Dialog, OK, auf die nächste Seite warten
async function confirmAndLoad(page) {
  await page.waitForSelector('.ui-dialog');
  await Promise.all([page.waitForNavigation(), page.click('.ui-dialog .ui-foot .ui-btn:not(.is-ghost)')]);
  await page.waitForFunction(() => !!window.OYSUI);
}

(async () => {
  fixtures();
  browser = await chromium.launch({ args: ['--host-resolver-rules=MAP *.' + HOST + ' 127.0.0.1, MAP ' + HOST + ' 127.0.0.1'] });

  await step('6 admin: delete user, cancel and confirm, flash as toast', async () => {
    const { ctx, page } = await newPage();
    await login(page, 'admin@test.de');
    await page.goto(B + '/admin');
    const posts = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/admin')) posts.push(r.postData() || ''); });
    await row(page, 'lea@test.de').locator('button[title="Delete User"]').click();
    await page.waitForSelector('.ui-dialog');
    ok(await dialogTitle(page) === 'Delete this user?', 'title');
    ok((await page.textContent('.ui-dialog .ui-text')).startsWith('Lea (lea@test.de) and all their pages'), 'text names the user and the address');
    ok(await page.evaluate(() => document.activeElement.textContent.trim()) === 'Cancel', 'Cancel is focused for a danger dialog');
    await confirmDialog(page, 'cancel');
    await sleep(300);
    ok(posts.length === 0 && count('SELECT COUNT(*) FROM users WHERE id = 7') === 1, 'Cancel sends nothing, Lea stays');
    await row(page, 'lea@test.de').locator('button[title="Delete User"]').click();
    await confirmAndLoad(page);
    ok(posts.length === 1 && new URLSearchParams(posts[0]).get('_confirmed') === '1', 'one POST with _confirmed=1');
    ok(count('SELECT COUNT(*) FROM users WHERE id = 7') === 0, 'Lea deleted');
    ok(await page.locator('[data-flash]').count() === 0, 'the banner became a toast');
    ok((await page.locator('.ui-toast.ok').textContent()).includes('User successfully deleted.'), 'success toast');
    await sleep(5600);
    ok(await page.locator('.ui-toast.ok').count() === 0, 'success toast gone after 5 s');
    await ctx.close();
  });

  await step('6 admin: role, log in as, and back', async () => {
    const { ctx, page } = await newPage();
    await login(page, 'admin@test.de');
    await page.goto(B + '/admin');
    await row(page, 'tom@test.de').locator('button[title="Make Admin"]').click();
    ok(await dialogTitle(page) === 'Make Tom Weber an admin?', 'role dialog names the user');
    await confirmDialog(page, 'cancel');
    await sleep(200);
    ok(count('SELECT is_admin FROM users WHERE id = 6') === 0, 'Cancel keeps the role');
    await row(page, 'tom@test.de').locator('button[title="Make Admin"]').click();
    await confirmAndLoad(page);
    ok(count('SELECT is_admin FROM users WHERE id = 6') === 1, 'confirmed: Tom is admin');
    await row(page, 'tom@test.de').locator('button[title="Remove Admin Rights"]').click();
    ok(await dialogTitle(page) === 'Remove admin rights from Tom Weber?', 'the text follows the current role');
    await confirmAndLoad(page);
    ok(count('SELECT is_admin FROM users WHERE id = 6') === 0, 'rights removed again');
    await row(page, 'mia@test.de').locator('button[title="Login as this User"]').click();
    ok((await dialogTitle(page)).startsWith('Log in as Mia'), 'log-in dialog');
    await confirmDialog(page, 'cancel');
    await sleep(200);
    ok(page.url().endsWith('/admin'), 'Cancel stays in the admin');
    await row(page, 'mia@test.de').locator('button[title="Login as this User"]').click();
    await page.waitForSelector('.ui-dialog');
    await Promise.all([page.waitForURL(/\/dashboard/), page.click('.ui-dialog .ui-btn.is-primary')]);
    ok((await page.textContent('body')).includes('Admin mode: You’re editing'), 'impersonating Mia');
    await Promise.all([page.waitForURL(/\/admin/), page.click('text=Back to admin panel')]);
    ok((await page.locator('.ui-toast.ok').textContent()).includes('Welcome back!'), 'back in the admin with a toast');
    await ctx.close();
  });

  await step('6 admin: code pages, updates, roadmap, Discord', async () => {
    const { ctx, page } = await newPage();
    await login(page, 'admin@test.de');
    await page.goto(B + '/admin#code-pages');
    const block = '#tab-code-pages form:has(input[name=code_action][value=block]) button[type=submit]';
    await page.locator(block).first().click();
    ok(await dialogTitle(page) === 'Block this code page?', 'block dialog');
    await confirmDialog(page, 'cancel');
    await sleep(200);
    ok(count('SELECT is_blocked FROM code_sites WHERE id = 40') === 0, 'Cancel: not blocked');
    await page.locator(block).first().click();
    await confirmAndLoad(page);
    ok(count('SELECT is_blocked FROM code_sites WHERE id = 40') === 1, 'blocked');
    await page.goto(B + '/admin#code-pages');
    await page.selectOption('#codeUser', '8');
    await page.click('#codeAccessForm button[type=submit]');
    ok(await dialogTitle(page) === 'Unlock the code page for free?', 'unlock dialog');
    await confirmAndLoad(page);
    ok(count("SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = 8 AND reason = 'unlock'") === 1, 'unlocked for free');

    await page.goto(B + '/admin#updates');
    const updates = count('SELECT COUNT(*) FROM updates');
    await page.locator('form:has(input[value=update_delete]) button[type=submit]').first().click();
    ok(await dialogTitle(page) === 'Delete this update?', 'update dialog');
    await confirmDialog(page, 'cancel');
    await sleep(200);
    ok(count('SELECT COUNT(*) FROM updates') === updates, 'Cancel keeps the update');
    await page.locator('form:has(input[value=update_delete]) button[type=submit]').first().click();
    await confirmAndLoad(page);
    ok(count('SELECT COUNT(*) FROM updates') === updates - 1, 'update deleted');

    await page.goto(B + '/admin#roadmap');
    await page.locator('form:has(input[value=task_delete]) button[type=submit]').first().click();
    ok(await dialogTitle(page) === 'Remove this task?', 'task dialog');
    await confirmAndLoad(page);
    ok(count('SELECT COUNT(*) FROM milestone_tasks WHERE milestone_id = 50') === 1, 'one task removed');
    await page.goto(B + '/admin#roadmap');
    await page.locator('form:has(input[value=milestone_delete]) button[type=submit]').first().click();
    ok(await dialogTitle(page) === 'Delete this milestone?' && (await page.textContent('.ui-dialog .ui-text')) === 'Its tasks are deleted too.', 'milestone dialog');
    await confirmAndLoad(page);
    ok(count('SELECT COUNT(*) FROM milestones WHERE id = 50') === 0 && count('SELECT COUNT(*) FROM milestone_tasks WHERE milestone_id = 50') === 0, 'milestone and its tasks deleted');

    await page.goto(B + '/admin#discord');
    await page.locator('form:has(input[value=discord_disconnect]) button[type=submit]').click();
    ok(await dialogTitle(page) === 'Disconnect Discord?', 'disconnect dialog');
    await confirmDialog(page, 'cancel');
    await sleep(200);
    ok(count("SELECT COUNT(*) FROM oys_meta WHERE meta_key = 'discord'") === 1, 'Cancel keeps Discord');
    await page.locator('form:has(input[value=discord_disconnect]) button[type=submit]').click();
    await confirmAndLoad(page);
    ok(count("SELECT COUNT(*) FROM oys_meta WHERE meta_key = 'discord'") === 0, 'Discord disconnected');
    await ctx.close();
  });

  await step('6 admin: ticket close sends ticket_close', async () => {
    const { ctx, page } = await newPage();
    await login(page, 'admin@test.de');
    await page.goto(B + '/admin?ticket=70#community');
    const posts = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/admin')) posts.push(new URLSearchParams(r.postData() || '')); });
    await page.click('button[value=ticket_close]');
    ok(await dialogTitle(page) === 'Close this ticket?', 'ticket dialog');
    await confirmAndLoad(page);
    ok(posts.length === 1 && posts[0].get('community_action') === 'ticket_close' && posts[0].get('_confirmed') === '1', 'the pressed button arrives');
    ok(sql('SELECT status FROM community_tickets WHERE id = 70') === 'closed', 'ticket closed');
    await ctx.close();
  });

  await step('6 admin: newsletter names the address, a double click sends once, errors stay', async () => {
    const { ctx, page } = await newPage();
    await login(page, 'admin@test.de');
    await page.goto(B + '/admin#newsletter');
    const posts = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/admin')) posts.push(new URLSearchParams(r.postData() || '')); });
    const tplSelect = page.locator('select[name=template_file]');
    const chevron = page.locator('#newsletterForm .bx-chevron-down').first();
    const centre = async (l) => { const b = await l.boundingBox(); return b.y + b.height / 2; };
    await page.click('#newsletterForm button[type=submit]');
    await sleep(200);
    ok(await page.locator('.ui-dialog').count() === 0 && (await page.textContent('#newsletterForm .ui-field-err')) === 'Please choose a template.', 'no template: inline error, no dialog');
    // Die Meldung steht unter dem Feld, nicht im Rahmen um Auswahl und Pfeil: der Pfeil bleibt mittig in der Auswahl
    ok(Math.abs((await centre(chevron)) - (await centre(tplSelect))) < 2, 'the chevron stays centred in the select while the message shows');
    await page.selectOption('select[name=template_file]', 'welcome.json');
    await page.selectOption('#audienceSelect', 'single');
    await page.click('#newsletterForm button[type=submit]');
    await sleep(200);
    ok((await page.locator('#singleEmail + .ui-field-err, #singleEmail ~ .ui-field-err').first().textContent()) === 'Please enter the email address.', '“Test / Single User” needs the address');
    await page.fill('#singleEmail', 'nobody@example.org');
    await page.click('#newsletterForm button[type=submit]');
    await page.waitForSelector('.ui-dialog');
    ok((await page.textContent('.ui-dialog .ui-text')) === 'Template “welcome.json” to nobody@example.org.', 'the dialog names the single address');
    // Doppelklick auf OK und danach noch einmal auf Senden: nur eine Sendung
    await Promise.all([page.waitForNavigation(), page.dblclick('.ui-dialog .ui-btn.is-primary')]);
    await page.waitForFunction(() => !!window.OYSUI);
    await sleep(500);
    ok(posts.length === 1 && posts[0].get('send_newsletter') === '1' && posts[0].get('_confirmed') === '1', 'exactly one POST');
    ok((await page.locator('.ui-toast.err').textContent()).includes('No users found for this audience. Mail aborted.'), 'the server’s error as toast');
    await sleep(6000);
    ok(await page.locator('.ui-toast.err').count() === 1, 'the error toast stays');
    await page.locator('.ui-toast.err .ui-toast-x').click();
    await sleep(500);
    ok(await page.locator('.ui-toast.err').count() === 0, 'Dismiss closes it');
    await page.goto(B + '/admin#newsletter');
    await page.selectOption('#audienceSelect', 'single');
    ok(await page.locator('#singleEmail').evaluate((n) => n.required), 'the address is required for a single user');
    await page.selectOption('#audienceSelect', 'all');
    ok(!(await page.locator('#singleEmail').evaluate((n) => n.required)), 'the address is only required for a single user');
    await ctx.close();
  });

  await step('6 admin: reset-password window with Escape and inline errors', async () => {
    const { ctx, page } = await newPage();
    await login(page, 'admin@test.de');
    await page.goto(B + '/admin');
    const key = row(page, 'tom@test.de').locator('button[title="Force Password Reset"]');
    await key.click();
    ok(await page.isVisible('#pwdModal') && (await page.textContent('#resetUserName')) === 'Tom Weber', 'window opens for Tom');
    ok(await page.evaluate(() => document.activeElement.id) === 'resetPassword', 'focus in the password field');
    ok(await page.evaluate(() => document.querySelector('main').closest('[inert]') !== null), 'the page behind is inert');
    await page.keyboard.press('Escape');
    ok(!(await page.isVisible('#pwdModal')), 'Escape closes it');
    ok(await page.evaluate(() => document.activeElement.getAttribute('title')) === 'Force Password Reset', 'focus back on the key button');
    await key.click();
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
    ok(await page.evaluate(() => document.getElementById('pwdModal').contains(document.activeElement)), 'Tab stays inside the window');
    await page.click('#pwdModal button[type=submit]');
    await sleep(200);
    ok((await page.textContent('#pwdModal .ui-field-err')) === 'Please enter a new password.' && await page.getAttribute('#resetPassword', 'aria-invalid') === 'true', 'empty → inline error');
    // Für die nächste Zeile öffnet das Fenster ohne die Meldung von eben
    await page.keyboard.press('Escape');
    await row(page, 'mia@test.de').locator('button[title="Force Password Reset"]').click();
    ok((await page.textContent('#resetUserName')) === 'Mia Müller' && await page.locator('#pwdModal .ui-field-err').count() === 0
      && await page.getAttribute('#resetPassword', 'aria-invalid') === null, 'reopened for another user: no old message');
    // Text im Feld markieren und die Maus neben dem Fenster loslassen: das Fenster bleibt offen, nichts geht verloren
    const typed = ['typed', 'not', 'lost'].join('-');
    await page.fill('#resetPassword', typed);
    const field = await page.locator('#resetPassword').boundingBox();
    await page.mouse.move(field.x + field.width - 4, field.y + field.height / 2);
    await page.mouse.down();
    await page.mouse.move(field.x - 200, field.y + field.height / 2, { steps: 6 });
    await page.mouse.up();
    await sleep(200);
    ok(await page.isVisible('#pwdModal') && (await page.inputValue('#resetPassword')) === typed, 'a text selection ending on the backdrop keeps the window open');
    await page.mouse.click(30, 450);
    await sleep(200);
    ok(!(await page.isVisible('#pwdModal')), 'a real click on the backdrop still closes it');
    await key.click();
    const before = sql('SELECT password FROM users WHERE id = 6');
    await page.fill('#resetPassword', 'Another-pass-123');
    await Promise.all([page.waitForNavigation(), page.click('#pwdModal button[type=submit]')]);
    ok(sql('SELECT password FROM users WHERE id = 6') !== before, 'password changed');
    ok((await page.locator('.ui-toast.ok').textContent()).includes('Password for user #6 successfully changed.'), 'toast');
    await ctx.close();
  });

  await step('7 admin without ui.js: nothing changes', async () => {
    const { ctx, page } = await newPage({ blockUi: true });
    await login(page, 'admin@test.de');
    await page.goto(B + '/admin');
    ok(await page.evaluate(() => typeof window.OYSUI) === 'undefined', 'ui.js blocked');
    await Promise.all([page.waitForNavigation(), row(page, 'noname@test.de').locator('button[title="Delete User"]').click()]);
    ok(count('SELECT COUNT(*) FROM users WHERE id = 8') === 1, 'the user is still there');
    const banner = page.locator('[data-flash="err"]');
    ok(await banner.isVisible() && (await banner.textContent()).includes(NOTHING), 'the error banner explains it');
    await ctx.close();
  });

  await step('9 sign-up and log-in: inline errors, focus, server texts', async () => {
    const { ctx, page } = await newPage();
    const posts = [];
    page.on('request', (r) => { if (r.method() === 'POST') posts.push(r.url()); });
    await page.goto(B + '/register');
    await page.click('form[action="/register"] button[type=submit]');
    await sleep(200);
    const err = (name) => page.evaluate((n) => { const f = document.querySelector('[name="' + n + '"]'); const id = f.getAttribute('data-ui-err'); return id ? document.getElementById(id).textContent : null; }, name);
    ok(await err('subdomain') === 'Please enter an address.' && await err('fullname') === 'Please enter your name.'
      && await err('email') === 'Please enter your email address.' && await err('password') === 'Please choose a password.', 'every empty field has its message');
    ok(await page.evaluate(() => document.activeElement.name) === 'subdomain', 'focus on the first error');
    ok(await page.evaluate(() => { const w = document.querySelector('[data-field]'); return w.hasAttribute('data-invalid') && w.nextElementSibling.classList.contains('ui-field-err'); }), 'the address message goes below the field with its suffix');
    await page.type('#regSlug', 'A');
    await page.fill('input[name=fullname]', 'Neo');
    await page.fill('input[name=email]', 'neo@');
    await page.type('input[name=password]', 'short');
    await page.click('form[action="/register"] button[type=submit]');
    await sleep(200);
    ok(await err('subdomain') === 'The address must be 2–30 characters long.', 'address too short (server wording)');
    ok(await err('fullname') === null && await page.getAttribute('input[name=fullname]', 'aria-invalid') === null, 'a fixed field loses its message');
    ok(await err('email') === 'Please enter a valid email address.', 'invalid email');
    ok(await err('password') === 'Your password must be at least 8 characters long.', 'short password');
    ok(posts.length === 0, 'nothing sent');
    // Die Prüfung im Browser umgangen: der Server meldet wie bisher
    await page.evaluate(() => { document.querySelector('form[action="/register"]').noValidate = true; });
    await Promise.all([page.waitForNavigation(), page.click('form[action="/register"] button[type=submit]')]);
    ok((await page.textContent('body')).includes('Please enter a valid email address.') || (await page.textContent('body')).includes('Your password must be at least 8 characters long.'), 'server message unchanged');

    await page.goto(B + '/login');
    await page.click('form[action="/login"] button[type=submit]');
    await sleep(200);
    ok(await err('email') === 'Please enter your email address.' && await err('password') === 'Please enter your password.', 'log-in messages');
    ok(await page.evaluate(() => document.activeElement.name) === 'email', 'focus on the email field');
    await page.evaluate(() => { document.querySelector('form[action="/login"]').noValidate = true; });
    await page.fill('input[name=email]', 'mia@test.de');
    await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
    ok((await page.textContent('body')).includes('Wrong email or password.'), 'server message for a bypassed check');
    await ctx.close();
  });

  await step('9 account forms in the editor: matching passwords', async () => {
    const { ctx, page } = await newPage();
    await login(page, 'mia@test.de');
    await page.goto(B + '/dashboard#settings');
    await page.waitForSelector('input[name=new_password]', { state: 'attached' });
    await page.evaluate(() => { const b = document.querySelector('[data-tab=settings]'); if (b) b.click(); });
    await page.fill('input[name=new_password]', 'Long-enough-1');
    await page.fill('input[name=confirm_new_password]', 'Long-enough-2');
    await page.fill('input[name=current_password_pwd]', PASSWORD);
    await page.locator('form:has(input[value=password]) button[type=submit]').click();
    await sleep(200);
    const msg = await page.evaluate(() => { const f = document.querySelector('[name=confirm_new_password]'); const id = f.getAttribute('data-ui-err'); return id ? document.getElementById(id).textContent : null; });
    ok(msg === 'The new passwords don’t match.', 'mismatch shown under the field');
    ok(await page.evaluate(() => document.activeElement.name) === 'confirm_new_password', 'focus on it');
    await page.fill('input[name=confirm_new_password]', 'Long-enough-1');
    await page.dispatchEvent('input[name=confirm_new_password]', 'input');
    ok(await page.evaluate(() => !document.querySelector('[name=confirm_new_password]').getAttribute('data-ui-err')), 'matching clears it');
    await ctx.close();
  });

  await browser.close();
  summary('e2e-dialogs');
})();
