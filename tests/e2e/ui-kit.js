// Bausteintests für static/js/ui.js (eigene Dialoge, Hinweise, Formularprüfungen) ohne Server: Jede Seite liefert
// page.route unter http://ui.test aus, die Dateien kommen aus static/. Aufruf: node tests/e2e/ui-kit.js
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern (lib.js).
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { ROOT, ok, watchPage, step, summary, sleep } = require('./lib');

const ORIGIN = 'http://ui.test';
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };

// Testseite: App-Skin (ui.css) oder Seiten-Skin (Theme + page.css, body.oys)
function pageHtml({ skin = 'app', body = '', head = '', theme = 't-midnight' } = {}) {
  const css = skin === 'app'
    ? '<link rel="stylesheet" href="/static/css/ui.css">'
    : '<link rel="stylesheet" href="/static/css/themes.css"><link rel="stylesheet" href="/static/css/page.css">';
  const cls = skin === 'app' ? '' : ` class="oys ${theme}"`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ui kit</title>${css}${head}<script src="/static/js/ui.js" defer></script></head><body${cls}>${body}</body></html>`;
}

let browser;
async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1100, height: 760 } });
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  const t = watchPage(page, {});
  const posts = [];
  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text()); });
  const html = pageHtml(opts);
  await page.route(ORIGIN + '/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith('/static/')) {
      const file = path.join(ROOT, url.pathname);
      if (!file.startsWith(ROOT + '/static/') || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ path: file, contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
    }
    if (req.method() === 'POST') {
      posts.push({ path: url.pathname, body: req.postData() || '' });
      if (opts.postDelay) await sleep(opts.postDelay);
      return route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><title>posted</title><p id="posted">posted</p>' });
    }
    if (url.pathname === '/next') return route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><title>next</title><p id="next">next</p>' });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto(ORIGIN + '/');
  await page.waitForFunction(() => !!window.OYSUI);
  return { ctx, page, posts, warnings, t };
}
const form = (s) => Object.fromEntries(new URLSearchParams(s));
const activeText = (page) => page.evaluate(() => (document.activeElement && (document.activeElement.textContent || document.activeElement.id || document.activeElement.tagName)).trim());
const dialogs = (page) => page.locator('.ui-dialog').count();

(async () => {
  browser = await chromium.launch();

  await step('dialogs resolve their values', async () => {
    const { ctx, page } = await open();
    await page.evaluate(() => { window.r = {}; OYSUI.alert({ title: 'Saved', text: 'All good.' }).then((v) => { window.r.a = v === undefined ? 'undef' : v; }); });
    await page.waitForSelector('.ui-dialog');
    ok(await page.getAttribute('.ui-dialog', 'role') === 'alertdialog', 'alert has role alertdialog');
    const lbl = await page.getAttribute('.ui-dialog', 'aria-labelledby');
    ok(lbl && await page.textContent('#' + lbl) === 'Saved', 'alert is labelled by its title');
    await page.click('.ui-btn.is-primary');
    await page.waitForFunction(() => window.r.a === 'undef');
    ok(await dialogs(page) === 0, 'alert closes and resolves');

    await page.evaluate(() => { OYSUI.confirm('Delete this block?').then((v) => { window.r.c1 = v; }); });
    await page.waitForSelector('.ui-dialog');
    ok(await page.textContent('.ui-title') === 'Delete this block?', 'a string becomes the title');
    await page.click('.ui-btn.is-primary');
    await page.waitForFunction(() => window.r.c1 === true);
    ok(true, 'confirm OK resolves true');

    for (const how of ['escape', 'x', 'backdrop', 'cancel']) {
      await page.evaluate((h) => { OYSUI.confirm({ title: 'Delete?', tone: 'danger' }).then((v) => { window.r[h] = v; }); }, how);
      await page.waitForSelector('.ui-dialog');
      if (how === 'escape') await page.keyboard.press('Escape');
      if (how === 'x') await page.click('.ui-x');
      if (how === 'backdrop') await page.mouse.click(8, 8);
      if (how === 'cancel') await page.click('.ui-btn.is-ghost');
      await page.waitForFunction((h) => window.r[h] === false, how);
      ok(await dialogs(page) === 0, 'confirm cancelled by ' + how);
    }

    await page.evaluate(() => { OYSUI.prompt({ title: 'Name?', label: 'Your name', value: '  Mia ' }).then((v) => { window.r.p1 = v; }); });
    await page.waitForSelector('.ui-input');
    ok(await page.getAttribute('.ui-dialog', 'role') === 'dialog', 'prompt has role dialog');
    ok(await page.evaluate(() => document.activeElement.classList.contains('ui-input')), 'prompt focuses its field');
    await page.mouse.click(8, 8);
    await sleep(150);
    ok(await dialogs(page) === 1, 'a backdrop click does not close a prompt');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.r.p1 !== undefined);
    ok(await page.evaluate(() => window.r.p1) === 'Mia', 'Enter submits the trimmed value');
    await page.evaluate(() => { OYSUI.prompt({ title: 'Name?' }).then((v) => { window.r.p2 = v; }); });
    await page.waitForSelector('.ui-input');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.r.p2 === null);
    ok(true, 'Escape cancels a prompt with null');

    await page.evaluate(() => {
      OYSUI.choice({ title: 'Embed this YouTube link?', text: 'Show it right on your page, or add it as a normal link button.',
        options: [{ value: 'link', text: 'Add as link' }, { value: 'embed', text: 'Embed it' }] }).then((v) => { window.r.ch = v; });
    });
    await page.waitForSelector('.ui-dialog');
    ok(await page.getAttribute('.ui-dialog', 'role') === 'dialog', 'choice has role dialog');
    ok(await activeText(page) === 'Embed it', 'choice focuses the primary (last) option');
    await page.click('text=Add as link');
    await page.waitForFunction(() => window.r.ch === 'link');
    ok(true, 'choice resolves the chosen value');
    await page.evaluate(() => { OYSUI.choice({ title: 'Pick', options: [{ value: 'a', text: 'A' }, { value: 'b', text: 'B' }] }).then((v) => { window.r.ch2 = v; }); });
    await page.waitForSelector('.ui-dialog');
    await page.mouse.click(8, 8);
    await page.waitForFunction(() => window.r.ch2 === null);
    ok(true, 'a backdrop click cancels a choice with null');
    await ctx.close();
  });

  await step('busy state, error string and retry', async () => {
    const { ctx, page } = await open();
    await page.evaluate(() => {
      window.r = {};
      OYSUI.confirm({ title: 'Buy?', ok: 'Buy', onConfirm: () => new Promise((res) => { window.finishBuy = res; }) }).then((v) => { window.r.buy = v; });
    });
    await page.waitForSelector('.ui-dialog');
    await page.click('.ui-btn.is-primary');
    await page.waitForFunction(() => !!window.finishBuy);
    ok(await page.getAttribute('.ui-dialog', 'aria-busy') === 'true', 'busy while the request runs');
    ok(await page.locator('.ui-btn:disabled').count() === 2 && await page.locator('.ui-x:disabled').count() === 1, 'all buttons disabled while busy');
    ok(await page.locator('.ui-btn .ui-spin').count() === 1, 'spinner in the OK button');
    await page.keyboard.press('Escape');
    await page.mouse.click(8, 8);
    ok(await dialogs(page) === 1, 'Escape and backdrop are ignored while busy');
    await page.evaluate(() => { const f = window.finishBuy; window.finishBuy = null; f('The price changed – this now costs 280 honeycombs (it was 350).'); });
    await page.waitForSelector('.ui-msg.is-err:not([hidden])');
    ok((await page.textContent('.ui-msg')).includes('price changed'), 'a string result shows as error and keeps the dialog open');
    ok(await page.getAttribute('.ui-msg', 'role') === 'alert', 'the error line is an alert');
    ok(await page.locator('.ui-btn:disabled').count() === 0, 'buttons are enabled again');
    await page.click('.ui-btn.is-primary');
    await page.waitForFunction(() => !!window.finishBuy);
    await page.evaluate(() => window.finishBuy());
    await page.waitForFunction(() => window.r.buy === true);
    ok(await dialogs(page) === 0, 'retry succeeds and closes');

    await page.evaluate(() => { OYSUI.confirm({ title: 'Boom', onConfirm: () => { throw new Error('x'); } }).then((v) => { window.r.boom = v; }); });
    await page.waitForSelector('.ui-dialog');
    await page.click('.ui-btn.is-primary');
    ok((await page.textContent('.ui-msg')) === 'Something went wrong. Please try again.', 'a thrown error shows the generic text');
    await page.evaluate(() => { OYSUI.confirm({ title: 'Rejects', onConfirm: () => Promise.reject(new Error('y')) }); });
    await page.waitForFunction(() => document.querySelectorAll('.ui-dialog').length === 2);
    await page.locator('.ui-btn.is-primary').last().click();
    await page.waitForFunction(() => { const m = document.querySelectorAll('.ui-msg'); return m[1] && m[1].textContent === 'Something went wrong. Please try again.'; });
    ok(true, 'a rejected promise shows the generic text');
    await ctx.close();
  });

  await step('custom content, values, canConfirm and ctl.update', async () => {
    const { ctx, page } = await open();
    await page.evaluate(() => {
      window.r = { calls: 0 };
      OYSUI.confirm({
        title: 'Buy Premium?', tone: 'hc', ok: 'Buy for 350',
        content: (body) => {
          body.innerHTML = '<div class="price" id="price">350</div><label><input type="checkbox" name="terms"> I accept</label>'
            + '<label><input type="radio" name="plan" value="30" checked> 30 days</label><label><input type="radio" name="plan" value="90"> 90 days</label>'
            + '<input name="note" value="hi">';
        },
        canConfirm: (v) => v.terms === true,
        onConfirm: (v, ctl) => {
          window.r.calls++;
          window.r.values = v;
          if (window.r.calls === 1) {
            const n = document.createElement('div');
            n.id = 'price2';
            n.innerHTML = '<input name="terms" type="checkbox" checked><button type="button" id="inner">Details</button>';
            ctl.update({ ok: 'Buy for 280', title: 'Price changed', content: n });
            return 'The price changed – this now costs 280 honeycombs (it was 350).';
          }
          if (window.r.calls === 2) return false;
        },
      }).then((v) => { window.r.done = v; });
    });
    await page.waitForSelector('#price');
    ok(await page.getAttribute('.ui-dialog', 'role') === 'dialog', 'a confirm with fields has role dialog');
    ok(await page.locator('.ui-btn.is-hc').isDisabled(), 'OK disabled until canConfirm allows it');
    await page.check('input[name=terms]');
    ok(!(await page.locator('.ui-btn.is-hc').isDisabled()), 'ticking the box enables OK');
    await page.check('input[value="90"]');
    await page.click('.ui-btn.is-hc');
    await page.waitForSelector('#price2');
    const v = await page.evaluate(() => window.r.values);
    ok(v.terms === true && v.plan === '90' && v.note === 'hi', 'values(): checkbox → boolean, radio → value, text → value');
    ok((await page.textContent('.ui-btn.is-hc')).trim() === 'Buy for 280' && (await page.textContent('.ui-title')) === 'Price changed', 'update() changes OK label and title');
    ok(await page.evaluate(() => document.querySelector('.ui-dialog').contains(document.activeElement)), 'focus stays inside the dialog after update()');
    await page.click('.ui-btn.is-hc');
    await sleep(100);
    ok(await dialogs(page) === 1 && (await page.textContent('.ui-msg')) === '', 'onConfirm returning false keeps it open without a message');
    await page.click('.ui-btn.is-hc');
    await page.waitForFunction(() => window.r.done === true);
    ok(true, 'onConfirm returning undefined closes with true');

    await page.evaluate(() => {
      OYSUI.confirm({ title: 'Msg', content: (b, ctl) => { const x = document.createElement('button'); x.type = 'button'; x.id = 'say'; x.textContent = 'Say'; x.onclick = () => ctl.message('Copied.', 'info'); b.appendChild(x); } });
    });
    await page.click('#say');
    ok((await page.getAttribute('.ui-msg', 'class')) === 'ui-msg' && (await page.textContent('.ui-msg')) === 'Copied.', 'ctl.message(info)');
    await page.keyboard.press('Escape');
    await ctx.close();
  });

  await step('type to confirm with normalize and transform', async () => {
    const { ctx, page } = await open();
    await page.evaluate(() => { window.r = {}; OYSUI.prompt({ title: 'Delete page “studio”?', match: 'studio', normalize: 'slug', transform: 'slug', ok: 'Delete page', tone: 'danger' }).then((v) => { window.r.slug = v; }); });
    await page.waitForSelector('.ui-input');
    ok((await page.textContent('.ui-label')) === 'Type studio to confirm', 'default label names the value');
    ok(await page.locator('.ui-btn.is-danger').isDisabled(), 'OK disabled before typing');
    await page.type('.ui-input', 'Stu d');
    ok(await page.inputValue('.ui-input') === 'stud', 'transform slug lower-cases and strips while typing');
    ok(await page.locator('.ui-btn.is-danger').isDisabled(), 'OK disabled while not equal');
    await page.type('.ui-input', 'io');
    ok(!(await page.locator('.ui-btn.is-danger').isDisabled()), 'OK enabled when equal');
    await page.click('.ui-btn.is-danger');
    await page.waitForFunction(() => window.r.slug === 'studio');
    ok(true, 'resolves the normalised value');

    await page.evaluate(() => { OYSUI.prompt({ title: 'Remove domain?', match: 'xn--bcher-kva.de', matchLabel: 'bücher.de', normalize: 'host' }).then((v) => { window.r.host = v; }); });
    await page.waitForSelector('.ui-input');
    ok((await page.textContent('.ui-label')) === 'Type bücher.de to confirm', 'matchLabel is shown in the label');
    await page.fill('.ui-input', 'bücher.d');
    await page.dispatchEvent('.ui-input', 'input');
    ok(await page.locator('.ui-btn.is-primary').isDisabled(), 'host: not equal yet');
    await page.fill('.ui-input', 'Bücher.de');
    await page.dispatchEvent('.ui-input', 'input');
    ok(!(await page.locator('.ui-btn.is-primary').isDisabled()), 'host: Unicode input matches the stored punycode');
    await page.click('.ui-btn.is-primary');
    await page.waitForFunction(() => window.r.host === 'xn--bcher-kva.de');
    ok(true, 'host result is the punycode form');
    await page.evaluate(() => { OYSUI.prompt({ title: 'Remove?', match: 'links.example.com', normalize: 'host' }).then((v) => { window.r.h2 = v; }); });
    await page.waitForSelector('.ui-input');
    await page.fill('.ui-input', 'https://Links.Example.com/path?x=1');
    await page.dispatchEvent('.ui-input', 'input');
    ok(!(await page.locator('.ui-btn.is-primary').isDisabled()), 'host: a pasted link with scheme and path matches');
    await page.keyboard.press('Escape');
    const n = await page.evaluate(() => [OYSUI.normalize.host('xn--bcher-kva.de'), OYSUI.normalize.slug('  My-Page! '), OYSUI.normalize.lower(' AbC '), OYSUI.normalize.trim('  x ')]);
    ok(JSON.stringify(n) === JSON.stringify(['xn--bcher-kva.de', 'my-page', 'abc', 'x']), 'normalize helpers');
    // Lange Eingaben (eingefügt in ein Feld zum Bestätigen) dürfen den Tab nicht einfrieren: kein quadratisches Zurückgehen
    const slow = await page.evaluate(() => {
      const t = performance.now();
      const a = OYSUI.normalize.trim('a' + ' '.repeat(50000) + 'b');
      const b = OYSUI.normalize.host('x' + '/'.repeat(50000) + '\ny');
      const c = OYSUI.normalize.host('https://user@Bücher.de:8080/a/b?c#d');
      return { ms: performance.now() - t, a: a.length, b, c };
    });
    ok(slow.ms < 1000 && slow.a === 50002 && slow.b === 'x' && slow.c === 'xn--bcher-kva.de', 'normalize stays fast and correct on long input (' + Math.round(slow.ms) + ' ms)');
    await page.evaluate(() => { OYSUI.prompt({ title: 'Code', validate: (s) => (s.length < 3 ? 'Too short.' : '') }).then((v) => { window.r.val = v; }); });
    await page.waitForSelector('.ui-input');
    await page.fill('.ui-input', 'ab');
    await page.keyboard.press('Enter');
    ok((await page.textContent('.ui-msg')) === 'Too short.' && await dialogs(page) === 1, 'validate() keeps the prompt open with its text');
    await page.fill('.ui-input', 'abcd');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.r.val === 'abcd');
    ok(true, 'validate() passes');
    await ctx.close();
  });

  await step('IME composition: Escape and Enter do nothing', async () => {
    const { ctx, page } = await open();
    await page.evaluate(() => { window.r = {}; OYSUI.prompt({ title: 'Name' }).then((v) => { window.r.v = v; }); });
    await page.waitForSelector('.ui-input');
    await page.evaluate(() => {
      const i = document.querySelector('.ui-input');
      i.value = 'にほ';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
    });
    await sleep(100);
    ok(await dialogs(page) === 1 && await page.evaluate(() => window.r.v === undefined), 'composing keys neither close nor submit');
    await ctx.close();
  });

  await step('focus rules', async () => {
    const { ctx, page } = await open({ body: '<button id="trigger">Open</button><div id="keep"><button id="fb">Fallback</button></div>' });
    await page.focus('#trigger');
    await page.evaluate(() => { OYSUI.confirm({ title: 'Default' }); });
    await page.waitForSelector('.ui-dialog');
    ok(await activeText(page) === 'OK', 'default tone focuses OK');
    // Tab und Shift+Tab bleiben im Dialog
    const seen = new Set();
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); seen.add(await page.evaluate(() => document.querySelector('.ui-dialog').contains(document.activeElement))); }
    ok(seen.size === 1 && seen.has(true), 'Tab cycles inside the dialog');
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Shift+Tab'); seen.add(await page.evaluate(() => document.querySelector('.ui-dialog').contains(document.activeElement))); }
    ok(seen.size === 1, 'Shift+Tab cycles inside the dialog');
    await page.keyboard.press('Escape');
    ok(await page.evaluate(() => document.activeElement.id) === 'trigger', 'focus returns to the trigger');
    await page.evaluate(() => { OYSUI.confirm({ title: 'Danger', tone: 'danger' }); });
    await page.waitForSelector('.ui-dialog');
    ok(await activeText(page) === 'Cancel', 'danger focuses Cancel');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { OYSUI.confirm({ title: 'Warn', tone: 'warn' }); });
    await page.waitForSelector('.ui-dialog');
    ok(await activeText(page) === 'Cancel', 'warn focuses Cancel');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { OYSUI.confirm({ title: 'Locked', canConfirm: () => false }); });
    await page.waitForSelector('.ui-dialog');
    ok(await page.evaluate(() => document.activeElement.classList.contains('ui-x')), 'a disabled target moves focus to the first enabled control');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { OYSUI.confirm({ title: 'Sel', focus: '.ui-btn.is-ghost' }); });
    await page.waitForSelector('.ui-dialog');
    ok(await activeText(page) === 'Cancel', 'focus option with a selector');
    await page.keyboard.press('Escape');
    // Auslöser verschwindet: fallbackFocus()
    await page.focus('#trigger');
    await page.evaluate(() => { OYSUI.confirm({ title: 'Gone', fallbackFocus: () => document.getElementById('fb') }); document.getElementById('trigger').remove(); });
    await page.waitForSelector('.ui-dialog');
    await page.keyboard.press('Escape');
    ok(await page.evaluate(() => document.activeElement.id) === 'fb', 'fallbackFocus() when the trigger is gone');
    await ctx.close();
  });

  await step('stacking, inert and layers', async () => {
    const { ctx, page, warnings } = await open({ body: '<main id="main"><button id="b1">B</button></main><div id="pre" inert>pre</div>'
      + '<div id="ov" style="position:fixed;inset:0;display:none;background:rgba(0,0,0,.5)"><div role="dialog" aria-modal="true"><h3 id="ovTitle">Overlay</h3><button id="ovBtn">Inside</button></div></div>'
      + '<section><div id="nested"></div></section>' });
    await page.evaluate(() => {
      window.r = { esc: 0 };
      const ov = document.getElementById('ov');
      ov.style.display = 'block';
      window.h = OYSUI.layer(ov, { labelledBy: 'ovTitle', onEscape: () => { window.r.esc++; ov.style.display = 'none'; window.h.release(); } });
    });
    ok(await page.evaluate(() => document.activeElement.id) === 'ovBtn', 'layer() focuses inside the overlay');
    ok(await page.getAttribute('#ov [role=dialog]', 'aria-labelledby') === 'ovTitle', 'layer() labels the dialog');
    ok(await page.getAttribute('#main', 'inert') === '', 'background is inert under a layer');
    await page.evaluate(() => { OYSUI.confirm({ title: 'On top' }).then((v) => { window.r.top = v; }); });
    await page.waitForSelector('.ui-dialog');
    ok(await page.getAttribute('#ov', 'inert') === '', 'the lower layer becomes inert');
    const z = await page.evaluate(() => [getComputedStyle(document.getElementById('ov')).zIndex, getComputedStyle(document.querySelector('.ui-layer')).zIndex]);
    ok(+z[1] > +z[0] && +z[0] >= 300, 'z-index grows with the stack');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.r.top === false);
    ok(await page.evaluate(() => window.r.esc) === 0 && await page.isVisible('#ov'), 'Escape closes only the top layer');
    ok(await page.getAttribute('#ov', 'inert') === null, 'the overlay is active again');
    await page.keyboard.press('Escape');
    ok(await page.evaluate(() => window.r.esc) === 1, 'the next Escape reaches the overlay');
    ok(await page.evaluate(() => [...document.body.querySelectorAll('[inert]')].map((n) => n.id).join(',')) === 'pre', 'inert fully restored (the page’s own inert stays)');
    ok(await page.evaluate(() => !document.documentElement.classList.contains('ui-lock')), 'scroll lock released');
    // Höchstens 5 Ebenen
    await page.evaluate(() => { window.r.many = []; for (let i = 0; i < 6; i++) OYSUI.confirm({ title: 'L' + i }).then((v) => window.r.many.push([i, v])); });
    await page.waitForFunction(() => window.r.many.length === 1);
    ok(JSON.stringify(await page.evaluate(() => window.r.many)) === JSON.stringify([[5, false]]) && await dialogs(page) === 5, 'the 6th dialog resolves as Cancel');
    ok(warnings.some((w) => /too many layers/.test(w)), 'with a console warning');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Escape');
    ok(await dialogs(page) === 0, 'five Escapes close five dialogs');
    ok(await page.evaluate(() => OYSUI.layer(document.getElementById('nested'))) === null, 'layer() on a non-body child returns null');
    ok(warnings.some((w) => /direct child of <body>/.test(w)), 'with a console error');
    await ctx.close();
  });

  await step('Back gesture via CloseWatcher', async () => {
    const init = () => {
      window.__cws = [];
      window.CloseWatcher = class { constructor() { window.__cws.push(this); } destroy() { this.destroyed = true; } };
    };
    const { ctx, page } = await open({ init });
    await page.evaluate(() => { window.r = {}; OYSUI.confirm({ title: 'A' }).then((v) => { window.r.a = v; }); OYSUI.confirm({ title: 'B' }).then((v) => { window.r.b = v; }); });
    await page.waitForFunction(() => document.querySelectorAll('.ui-dialog').length === 2);
    ok(await page.evaluate(() => window.__cws.length) === 1, 'one watcher stands for the top layer');
    await page.evaluate(() => { const w = window.__cws[window.__cws.length - 1]; w.onclose(); });
    await page.waitForFunction(() => window.r.b === false);
    ok(await page.evaluate(() => window.r.a === undefined) && await dialogs(page) === 1, 'Back cancels only the top dialog');
    ok(await page.evaluate(() => window.__cws.length) === 2, 'a new watcher for the remaining layer');
    await page.evaluate(() => { OYSUI.confirm({ title: 'Busy', onConfirm: () => new Promise(() => {}) }).then((v) => { window.r.busy = v; }); });
    await page.waitForFunction(() => document.querySelectorAll('.ui-dialog').length === 2);
    await page.locator('.ui-btn.is-primary').last().click();
    await page.evaluate(() => { const w = window.__cws[window.__cws.length - 1]; w.onclose(); });
    await sleep(50);
    ok(await dialogs(page) === 2 && await page.evaluate(() => window.__cws.length) === 3, 'while busy Back keeps the dialog and re-arms the watcher');
    await ctx.close();
    const second = await open({ init: () => { delete window.CloseWatcher; } });
    await second.page.evaluate(() => { OYSUI.confirm('No watcher'); });
    await second.page.waitForSelector('.ui-dialog');
    await second.page.keyboard.press('Escape');
    ok(await dialogs(second.page) === 0, 'works without CloseWatcher');
    await second.ctx.close();
  });

  await step('themed page without ui.css', async () => {
    const long = 'Long text. '.repeat(600);
    const { ctx, page } = await open({ skin: 'page', theme: 't-midnight', body: '<main class="oys-main" style="height:3000px"><p>Profile</p></main>' });
    ok(await page.evaluate(() => document.head.firstElementChild.id) === 'oys-ui-base', 'base rules injected as the first child of <head>');
    ok(await page.evaluate(() => OYSUI.skin) === 'page', 'skin is page on body.oys');
    await page.evaluate((t) => { OYSUI.confirm({ title: 'Long', text: t }); }, long);
    await page.waitForSelector('.ui-dialog');
    const m = await page.evaluate(() => {
      const box = document.querySelector('.ui-dialog'), body = document.querySelector('.ui-body');
      return { h: box.getBoundingClientRect().height, vh: innerHeight, scrolls: body.scrollHeight > body.clientHeight, lock: document.documentElement.classList.contains('ui-lock'),
        bg: getComputedStyle(box).backgroundColor, surface: getComputedStyle(document.body).getPropertyValue('--surface').trim(), svg: !!document.querySelector('.ui-ico svg') };
    });
    ok(m.h <= m.vh * 0.86 + 1, 'a long dialog stays within 86% of the viewport');
    ok(m.scrolls, 'its body scrolls');
    ok(m.lock, 'scroll lock on the themed page');
    ok(m.svg, 'icons are inline SVGs on profile pages');
    const probe = await page.evaluate((c) => { const p = document.createElement('div'); p.style.color = c; document.body.appendChild(p); const v = getComputedStyle(p).color; p.remove(); return v; }, m.surface);
    ok(probe === m.bg, 'dialog background is the theme’s --surface (' + m.bg + ')');
    await page.keyboard.press('Escape');
    await page.evaluate(() => OYSUI.toast('Copied.'));
    ok(await page.evaluate(() => getComputedStyle(document.querySelector('.ui-toast')).backgroundColor) === m.bg, 'toasts use the theme surface');
    await ctx.close();
  });

  await step('toasts: live region, queue, dedupe, replace, sticky, pause', async () => {
    const { ctx, page } = await open();
    await page.evaluate(() => { for (let i = 1; i <= 6; i++) OYSUI.toast({ text: 'Toast ' + i, duration: 1200 }); });
    ok(await page.getAttribute('.ui-toasts', 'aria-live') === 'polite', 'container is a polite live region');
    ok(await page.locator('.ui-toast').count() === 4, '6 toasts → 4 visible');
    const seen = new Set();
    for (let i = 0; i < 40 && seen.size < 6; i++) {
      for (const t of await page.locator('.ui-toast .ui-toast-text').allTextContents()) seen.add(t);
      await sleep(100);
    }
    ok(seen.size === 6, 'the 2 waiting toasts follow, none lost');
    await page.waitForFunction(() => !document.querySelector('.ui-toast'), null, { timeout: 6000 });
    await page.evaluate(() => { OYSUI.toast('Saved'); OYSUI.toast('Saved'); });
    ok(await page.locator('.ui-toast').count() === 1, 'identical text and tone within 2 s refreshes one toast');
    await page.evaluate(() => { OYSUI.toast({ id: 'up', text: 'Uploading…', tone: 'info', duration: 0 }); OYSUI.toast({ id: 'up', text: 'Uploaded.', tone: 'ok' }); });
    ok(await page.locator('.ui-toast', { hasText: 'Uploading' }).count() === 0 && await page.locator('.ui-toast', { hasText: 'Uploaded.' }).count() === 1, 'same id replaces the toast');
    await page.evaluate(() => { OYSUI.toast({ text: 'Stays', duration: 0 }); OYSUI.toast('Broke', 'err'); });
    ok(await page.getAttribute('.ui-toast.err', 'role') === 'alert', 'error toasts are alerts');
    ok(await page.locator('.ui-toast', { hasText: 'Stays' }).locator('.ui-toast-x[aria-label="Dismiss"]').count() === 1, 'sticky toasts have a Dismiss button');
    await page.locator('.ui-toast', { hasText: 'Stays' }).locator('.ui-toast-x').click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.ui-toast')].some((t) => t.textContent.includes('Stays')));
    ok(true, 'Dismiss closes a sticky toast');
    await page.evaluate(() => { document.querySelectorAll('.ui-toast').forEach((t) => t.click()); });
    await page.waitForFunction(() => !document.querySelector('.ui-toast'), null, { timeout: 3000 });
    await page.evaluate(() => OYSUI.toast({ text: 'Hover me', duration: 900 }));
    await page.hover('.ui-toast');
    await sleep(1400);
    ok(await page.locator('.ui-toast', { hasText: 'Hover me' }).count() === 1, 'hover pauses the timer');
    await page.mouse.move(5, 700);
    await page.waitForFunction(() => !document.querySelector('.ui-toast'), null, { timeout: 3000 });
    ok(true, 'leaving resumes the timer');
    await page.evaluate(() => OYSUI.toast({ text: 'Earned', tone: 'hc', amount: 50 }));
    ok((await page.textContent('.ui-amt')) === '+50 honeycombs' && await page.isVisible('.ui-amt'), 'amount badge reads "+50 honeycombs"');
    ok((await page.evaluate(() => getComputedStyle(document.querySelector('.ui-toast.hc')).color)) === 'rgb(253, 224, 71)', 'honeycomb toasts are yellow');
    await ctx.close();
  });

  await step('notices and toasts while a dialog is open', async () => {
    const { ctx, page } = await open();
    await page.evaluate(() => {
      window.seen = new Set();
      new MutationObserver(() => document.querySelectorAll('.ui-toast-text').forEach((t) => window.seen.add(t.textContent))).observe(document.body, { childList: true, subtree: true });
      const list = [];
      for (let i = 1; i <= 9; i++) list.push({ tone: 'hc', text: 'for reward ' + i, amount: i });
      OYSUI.notices(list, { label: 'History', link: '/dashboard#honeycombs' });
    });
    await page.waitForFunction(() => window.seen.has('+4 more'), null, { timeout: 8000 });
    const texts = await page.evaluate(() => [...window.seen]);
    ok(texts.filter((t) => /for reward/.test(t)).length === 5 && texts.includes('+4 more') && texts.length === 6, 'a batch of 9 shows 5 and "+4 more"');
    ok(await page.locator('.ui-toast', { hasText: '+4 more' }).locator('.ui-toast-act').textContent() === 'History', 'the "+N more" toast carries the History action');
    await page.evaluate(() => { document.querySelectorAll('.ui-toast-x').forEach((x) => x.click()); });
    await page.waitForFunction(() => !document.querySelector('.ui-toast'), null, { timeout: 6000 });
    await page.evaluate(() => {
      window.r = { ran: 0 };
      OYSUI.toast({ text: 'Open inbox', tone: 'info', action: { label: 'Open', run: () => { window.r.ran++; } } });
      OYSUI.confirm({ title: 'Busy here' });
    });
    await page.waitForSelector('.ui-dialog');
    await page.click('.ui-toast-act');
    await sleep(100);
    ok(await page.evaluate(() => window.r.ran) === 0, 'with a dialog open a toast action only dismisses');
    await page.keyboard.press('Escape');
    await page.evaluate(() => OYSUI.toast({ text: 'Open inbox again', tone: 'info', action: { label: 'Open', run: () => { window.r.ran++; } } }));
    await page.click('.ui-toast-act');
    ok(await page.evaluate(() => window.r.ran) === 1, 'without a dialog the action runs');
    // Ein Hinweis mit Aktion wartet, solange ein Dialog offen ist. Der Zeiger darf nicht auf dem Hinweis ruhen (er steht
    // noch dort, wo eben „Open“ geklickt wurde): Darüber hält der Hinweis absichtlich an und liefe nie ab
    await page.mouse.move(5, 700);
    await page.evaluate(() => { OYSUI.toast({ text: 'Held', tone: 'info', duration: 300, action: { label: 'Go', run() {} } }); OYSUI.confirm('Hold'); });
    await sleep(9000);
    ok(await page.locator('.ui-toast', { hasText: 'Held' }).count() === 1, 'a toast with an action is held while a dialog is open');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => ![...document.querySelectorAll('.ui-toast')].some((t) => t.textContent.includes('Held')), null, { timeout: 10000 });
    ok(true, 'and runs its timer after the dialog is closed');
    await ctx.close();
  });

  await step('handle(): session dialogs and notices', async () => {
    const { ctx, page } = await open();
    await page.evaluate(() => { window.r = {}; window.r.ret = OYSUI.handle(401, { ok: false, error: 'Please log in again.' }); OYSUI.toast('Please log in again.', 'err'); });
    await page.waitForSelector('.ui-dialog');
    ok((await page.textContent('.ui-title')) === 'You’re logged out', '401 opens the logged-out dialog');
    ok(await page.locator('.ui-toast.err').count() === 0, 'error toasts are muted while the session dialog is open');
    await page.evaluate(() => OYSUI.handle(401, {}));
    ok(await dialogs(page) === 1, 'only one session dialog');
    await page.click('text=Close');
    ok((await page.textContent('.ui-toast')).includes('You’re logged out.') && await page.locator('.ui-toast .ui-toast-act').textContent() === 'Log in', 'Close leaves a sticky toast with Log in');
    await page.evaluate(() => { OYSUI.handle(401, {}); OYSUI.toast('Again', 'err'); });
    ok(await dialogs(page) === 0 && await page.locator('.ui-toast.err').count() === 0, 'no new dialog or error toast after Close');
    await page.click('.ui-toast-act');
    await page.waitForURL(/\/login$/);
    ok(true, 'Log in goes to /login without a native dialog');
    await ctx.close();
    const b = await open();
    await b.page.evaluate(() => OYSUI.handle(419, {}));
    await b.page.waitForSelector('.ui-dialog');
    ok((await b.page.textContent('.ui-title')) === 'Your session has expired', '419 opens the expired dialog');
    await b.page.click('.ui-btn.is-primary');
    await b.page.waitForLoadState('load');
    ok(await b.page.evaluate(() => !!window.OYSUI && !document.querySelector('.ui-dialog')), 'Reload reloads without a native dialog');
    const ret = await b.page.evaluate(() => { const d = { ok: true, notices: [{ tone: 'ok', text: 'Bought.' }] }; return OYSUI.handle(200, d) === d; });
    ok(ret && (await b.page.textContent('.ui-toast')).includes('Bought.'), 'notices in an answer become toasts; handle() returns the data');
    await b.page.evaluate(() => OYSUI.handle(409, { ok: false, reload: true, error: 'This page was changed in another tab.' }));
    await b.page.waitForSelector('.ui-dialog');
    ok((await b.page.textContent('.ui-text')) === 'This page was changed in another tab.', '409 with reload shows the server text');
    await b.ctx.close();
  });

  await step('flash banners become toasts', async () => {
    const { ctx, page } = await open({ body: '<div data-flash="ok" role="status" class="banner">  User successfully deleted. </div><div data-flash="err" role="alert" class="banner">You cannot delete your own admin account!</div>' });
    ok(await page.locator('.banner').count() === 0, 'banners removed');
    ok((await page.locator('.ui-toast.ok').textContent()).includes('User successfully deleted.'), 'success banner → ok toast');
    ok(await page.locator('.ui-toast.err .ui-toast-x').count() === 1, 'error banner → sticky toast with Dismiss');
    await sleep(5600);
    ok(await page.locator('.ui-toast.ok').count() === 0 && await page.locator('.ui-toast.err').count() === 1, 'success gone after 5 s, error stays');
    await ctx.close();
  });

  await step('form checks replace the browser bubbles', async () => {
    const body = `<form id="f" action="/submit" method="post">
      <label for="name">Name</label><input id="name" name="name" required data-error-required="Please enter your name.">
      <label>Email<input name="email" type="email" required></label>
      <input name="site" type="url" aria-label="Website">
      <input name="pw" type="password" minlength="8" placeholder="Password">
      <input name="n" type="number" min="1" max="10" placeholder="Number">
      <input name="s" type="number" step="1" placeholder="Step">
      <input name="code" pattern="[A-Z]{3}" data-error-pattern="Use three capital letters." placeholder="Code">
      <select name="tpl" required><option value="">--</option><option>a</option></select>
      <label><input type="checkbox" name="tos" required> Terms</label>
      <input type="date" name="day" required>
      <input type="date" name="past" max="2026-01-01" value="2026-05-01" data-error-max="The date can’t be in the future.">
      <input type="password" name="new_password" placeholder="New">
      <input type="password" name="confirm_new_password" data-match="new_password" data-error-match="The new passwords don’t match." placeholder="Repeat">
      <div class="wrap" data-field><input name="slug" required minlength="2" data-error-short="Use 2–30 characters."><span>.on-your.site</span></div>
      <div id="hiddenBox" style="display:none"><label for="hid">Webhook link</label><input id="hid" name="hid" required></div>
      <button type="submit" id="go">Send</button></form>`;
    const { ctx, page, posts } = await open({ body });
    await page.type('input[name=email]', 'nope');
    await page.type('input[name=site]', 'example');
    await page.type('input[name=pw]', 'short');
    await page.type('input[name=n]', '20');
    await page.type('input[name=s]', '1.5');
    await page.type('input[name=code]', 'abc');
    await page.type('input[name=new_password]', 'secret-1');
    await page.type('input[name=confirm_new_password]', 'secret-2');
    await page.type('input[name=slug]', 'a');
    await page.click('#go');
    await sleep(200);
    const msg = async (name) => page.evaluate((n) => { const f = document.querySelector('[name="' + n + '"]'); const id = f.getAttribute('data-ui-err'); return id && document.getElementById(id) ? document.getElementById(id).textContent : null; }, name);
    const expect = {
      name: 'Please enter your name.', email: 'Please enter a valid email address.', site: 'Please enter a full link, e.g. https://example.com.',
      pw: 'Please use at least 8 characters.', n: 'Please enter 10 or less.', s: 'Please enter a whole number.', code: 'Use three capital letters.',
      tpl: 'Please choose an option.', tos: 'Please tick this box.', day: 'Please choose a date.', past: 'The date can’t be in the future.',
      confirm_new_password: 'The new passwords don’t match.', slug: 'Use 2–30 characters.',
    };
    for (const [k, v] of Object.entries(expect)) ok(await msg(k) === v, `"${k}": ${v}`);
    ok(posts.length === 0, 'nothing sent while invalid');
    ok(await page.getAttribute('[name=name]', 'aria-invalid') === 'true' && (await page.getAttribute('[name=name]', 'aria-describedby')).startsWith('ui-e'), 'aria-invalid and aria-describedby');
    ok(await page.evaluate(() => document.activeElement.name) === 'name', 'the first invalid field is focused');
    ok(await page.evaluate(() => { const w = document.querySelector('.wrap'); return w.nextElementSibling.classList.contains('ui-field-err') && w.hasAttribute('data-invalid'); }), 'the message goes after the [data-field] wrapper');
    ok(await page.evaluate(() => { const l = document.querySelector('input[name=tos]').closest('label'); return l.nextElementSibling.classList.contains('ui-field-err'); }), 'checkbox messages go after their label');
    ok((await page.locator('.ui-toast.err').textContent()).includes('Please check “Webhook link”.'), 'a hidden invalid field shows a toast with its label');
    await page.type('[name=name]', 'Mia');
    ok(await msg('name') === null && await page.getAttribute('[name=name]', 'aria-invalid') === null, 'typing a valid value clears the message');
    await page.fill('[name=confirm_new_password]', 'secret-1');
    await page.dispatchEvent('[name=confirm_new_password]', 'input');
    ok(await msg('confirm_new_password') === null, 'matching values clear the data-match message');
    // Per Skript gebautes Formular ohne Attribute
    await page.evaluate(() => {
      const f = document.createElement('form');
      f.innerHTML = '<input name="pw" required><button>Go</button>';
      f.id = 'jsform';
      f.addEventListener('submit', (e) => e.preventDefault());
      document.body.appendChild(f);
      f.requestSubmit();
    });
    await sleep(100);
    ok(await page.evaluate(() => document.querySelector('#jsform .ui-field-err').textContent) === 'Please fill in this field.', 'a script-built form gets the message without any attribute');
    // Ein Skript schreibt den Wert beim Tippen um (dann meldet der Browser tooShort nicht): die Länge prüft ui.js selbst
    const rewritten = await page.evaluate(async () => {
      const f = document.createElement('form');
      f.innerHTML = '<input name="slug" minlength="3" data-error-short="Use 3 or more."><button>Go</button>';
      f.addEventListener('submit', (e) => e.preventDefault());
      document.body.appendChild(f);
      f.slug.addEventListener('input', () => { f.slug.value = f.slug.value.toLowerCase(); });
      f.slug.focus();
      return true;
    });
    await page.keyboard.type('AB');
    await sleep(50);
    await page.evaluate(() => document.querySelectorAll('form')[document.querySelectorAll('form').length - 1].requestSubmit());
    await sleep(100);
    ok(rewritten && await page.evaluate(() => { const f = document.querySelectorAll('form'); const e = f[f.length - 1].querySelector('.ui-field-err'); return e && e.textContent; }) === 'Use 3 or more.', 'minlength also works when a script rewrites the value');
    // novalidate + OYSUI.validate()
    const res = await page.evaluate(() => {
      const f = document.createElement('form');
      f.noValidate = true;
      f.innerHTML = '<input name="m" required minlength="5" data-error-required="Your message is a bit short.">';
      document.body.appendChild(f);
      const a = OYSUI.validate(f);
      f.m.value = 'hello there';
      const b = OYSUI.validate(f);
      return [a, b, !!f.querySelector('.ui-field-err')];
    });
    ok(res[0] === false && res[1] === true && res[2] === false, 'validate() for novalidate forms: false, then true and the message is gone');
    await ctx.close();
  });

  await step('form checks: one message per radio group, reset clears the messages', async () => {
    const body = `<form id="f" action="/submit" method="post"><p>Plan</p>
      <label><input type="radio" name="plan" value="a" required> A</label>
      <label><input type="radio" name="plan" value="b"> B</label>
      <label><input type="radio" name="plan" value="c"> C</label>
      <input name="title" required aria-label="Title">
      <input name="pw" minlength="8" aria-label="Password">
      <input name="pw2" data-match="pw" aria-label="Repeat">
      <button type="submit" id="go">Send</button></form>`;
    const { ctx, page } = await open({ body });
    await page.click('#go');
    await sleep(200);
    ok(await page.locator('.ui-field-err').count() === 2, 'one message for the whole radio group and one for the text field');
    ok(await page.evaluate(() => { const n = document.querySelector('input[value=c]').closest('label').nextElementSibling; return !!n && n.classList.contains('ui-field-err') && n.textContent === 'Please choose an option.'; }), 'the group message follows the last option');
    ok(await page.evaluate(() => [...document.querySelectorAll('input[name=plan]')].every((r) => r.getAttribute('aria-invalid') === 'true' && !!r.getAttribute('aria-describedby'))), 'every option of the group is marked and described');
    ok(await page.evaluate(() => document.activeElement.value) === 'a', 'focus on the first option');
    await page.click('input[value=b]');
    await sleep(100);
    ok(await page.locator('.ui-field-err').count() === 1 && await page.evaluate(() => [...document.querySelectorAll('input[name=plan]')].every((r) => !r.hasAttribute('aria-invalid') && !r.hasAttribute('aria-describedby'))), 'choosing an option clears the group message');
    // Zurücksetzen (z. B. ein Fenster für die nächste Zeile) nimmt alle Meldungen und eigenen Prüfungen weg
    await page.type('input[name=pw]', 'short');
    await page.type('input[name=pw2]', 'other');
    await page.click('#go');
    await sleep(200);
    ok(await page.locator('.ui-field-err').count() === 3, 'title, short password and mismatch are reported');
    await page.evaluate(() => document.getElementById('f').reset());
    await sleep(50);
    ok(await page.locator('.ui-field-err').count() === 0 && await page.evaluate(() => ![...document.querySelectorAll('#f [aria-invalid]')].length), 'resetting the form clears its messages');
    ok(await page.evaluate(() => { const f = document.getElementById('f'); return f.pw.validity.valid && f.pw2.validity.valid; }), 'and the custom length and match checks');
    await ctx.close();
  });

  await step('data-confirm pipeline', async () => {
    const body = `<form id="del" action="/admin" method="post" data-confirm="Delete this user?" data-confirm-text="Mia (mia@test.de) and all their pages … can’t be undone." data-confirm-ok="Delete user" data-confirm-tone="danger">
        <input type="hidden" name="csrf" value="c123"><input type="hidden" name="_confirmed" value="0" autocomplete="off">
        <input type="hidden" name="delete_user_id" value="5"><button type="submit" name="act" value="delete" id="delBtn">Delete</button></form>
      <form id="ticket" action="/admin" method="post"><input type="hidden" name="csrf" value="c123"><input type="hidden" name="_confirmed" value="0" autocomplete="off">
        <textarea name="body"></textarea>
        <button type="submit" name="community_action" value="ticket_close" data-confirm="Close this ticket?" data-confirm-ok="Close ticket" data-confirm-tone="warn" id="closeBtn">Close ticket</button>
        <button type="submit" name="community_action" value="ticket_reply" id="replyBtn">Send reply</button></form>`;
    let s = await open({ body, postDelay: 600 });
    await s.page.click('#delBtn');
    await s.page.waitForSelector('.ui-dialog');
    ok((await s.page.textContent('.ui-title')) === 'Delete this user?' && (await s.page.textContent('.ui-text')).startsWith('Mia (mia@test.de)'), 'dialog from the data-confirm attributes');
    ok((await s.page.textContent('.ui-btn.is-danger')).trim() === 'Delete user', 'OK label and danger tone');
    await s.page.click('.ui-btn.is-ghost');
    await sleep(200);
    ok(s.posts.length === 0, 'Cancel sends nothing');
    // Noch auf der alten Seite (die Antwort kommt erst nach 600 ms): Knopf gesperrt? Zweiter Klick?
    await s.page.evaluate(() => {
      document.getElementById('del').addEventListener('submit', () => setTimeout(() => {
        const b = document.getElementById('delBtn');
        sessionStorage.setItem('locked', String(b.disabled) + '/' + b.getAttribute('aria-busy'));
        b.click();
      }, 30));
    });
    await s.page.click('#delBtn');
    await s.page.click('.ui-btn.is-danger');
    await s.page.waitForSelector('#posted');
    ok(await s.page.evaluate(() => sessionStorage.getItem('locked')) === 'true/true', 'buttons locked (aria-busy) after the confirmed submit');
    await sleep(300);
    ok(s.posts.length === 1, 'exactly one POST (a second click sends nothing)');
    const p = form(s.posts[0].body);
    ok(p._confirmed === '1' && p.csrf === 'c123' && p.act === 'delete' && p.delete_user_id === '5', 'POST has _confirmed=1, the CSRF field and the submitter');
    await s.ctx.close();

    s = await open({ body });
    await s.page.click('#replyBtn');
    await s.page.waitForSelector('#posted');
    ok(form(s.posts[0].body).community_action === 'ticket_reply' && form(s.posts[0].body)._confirmed === '1', 'a button without a question submits at once with _confirmed=1');
    await s.page.goBack();
    await s.page.waitForFunction(() => !!window.OYSUI && !!document.getElementById('closeBtn'));
    await s.page.click('#closeBtn');
    await s.page.waitForSelector('.ui-dialog');
    ok((await s.page.textContent('.ui-title')) === 'Close this ticket?', 'the button’s own data-confirm asks');
    await s.page.click('.ui-btn.is-primary');
    await s.page.waitForSelector('#posted');
    ok(s.posts.length === 2 && form(s.posts[1].body).community_action === 'ticket_close' && form(s.posts[1].body)._confirmed === '1', 'ticket_close arrives with the pressed button');
    await s.ctx.close();

    // Bestätigen durch Tippen mit into
    s = await open({ body: `<form action="/admin" method="post" data-confirm="Delete “studio”?" data-confirm-match="studio" data-confirm-normalize="slug" data-confirm-into="confirm" data-confirm-tone="danger" data-confirm-ok="Delete">
      <input type="hidden" name="_confirmed" value="0"><button id="b">Delete</button></form>` });
    await s.page.click('#b');
    await s.page.waitForSelector('.ui-input');
    await s.page.type('.ui-input', 'Studio');
    await s.page.click('.ui-btn.is-danger');
    await s.page.waitForSelector('#posted');
    const q = form(s.posts[0].body);
    ok(q.confirm === 'studio' && q._confirmed === '1', 'data-confirm-match/normalize/into sends the typed value as "confirm"');
    await s.ctx.close();

    // beforeSubmit: null, false, Optionen
    s = await open({ body: `<form id="nl" action="/admin" method="post"><input type="hidden" name="_confirmed" value="0"><input name="to" value="all"><button id="send">Send</button></form>` });
    await s.page.evaluate(() => { OYSUI.beforeSubmit(document.getElementById('nl'), () => false); });
    await s.page.click('#send');
    await sleep(200);
    ok(s.posts.length === 0 && await dialogs(s.page) === 0, 'beforeSubmit → false cancels');
    await s.page.evaluate(() => { OYSUI.beforeSubmit(document.getElementById('nl'), (f) => ({ title: 'Send this email?', text: 'Template “news.json” to ' + f.to.value + '.', ok: 'Send email', tone: 'warn' })); });
    await s.page.click('#send');
    await s.page.waitForSelector('.ui-dialog');
    ok((await s.page.textContent('.ui-text')) === 'Template “news.json” to all.', 'beforeSubmit options build the dialog');
    await s.page.click('.ui-btn.is-primary');
    await s.page.waitForSelector('#posted');
    ok(s.posts.length === 1 && form(s.posts[0].body)._confirmed === '1', 'confirmed → one POST');
    await s.page.goBack();
    await s.page.waitForFunction(() => !!window.OYSUI && !!document.getElementById('nl'));
    ok(await s.page.evaluate(() => document.querySelector('[name=_confirmed]').value) === '0' && !(await s.page.locator('#send').isDisabled()), 'back from the cache: buttons free, _confirmed reset');
    await s.page.evaluate(() => { OYSUI.beforeSubmit(document.getElementById('nl'), () => null); });
    await s.page.click('#send');
    await s.page.waitForSelector('#posted');
    ok(s.posts.length === 2 && form(s.posts[1].body)._confirmed === '1', 'beforeSubmit → null sends without a question');
    await s.ctx.close();
  });

  await step('old Safari: no requestSubmit', async () => {
    const s = await open({ init: () => { delete HTMLFormElement.prototype.requestSubmit; },
      body: `<form action="/admin" method="post"><input type="hidden" name="_confirmed" value="0"><button name="community_action" value="ticket_close" data-confirm="Close this ticket?" id="c">Close</button></form>` });
    ok(await s.page.evaluate(() => typeof HTMLFormElement.prototype.requestSubmit) === 'undefined', 'requestSubmit removed');
    await s.page.click('#c');
    await s.page.click('.ui-btn.is-primary');
    await s.page.waitForSelector('#posted');
    const q = form(s.posts[0].body);
    ok(s.posts.length === 1 && q.community_action === 'ticket_close' && q._confirmed === '1', 'the fallback still sends the submitter’s name=value');
    await s.ctx.close();
    // Der gedrückte Knopf kann ein anderes Ziel haben (formaction …): auch ohne requestSubmit geht es dorthin
    const t = await open({ init: () => { delete HTMLFormElement.prototype.requestSubmit; },
      body: `<form action="/save" method="post"><input type="hidden" name="_confirmed" value="0"><input name="title" value="x">
        <button id="save">Save</button><button id="del" name="act" value="delete" formaction="/delete" data-confirm="Delete this?">Delete</button></form>` });
    await t.page.click('#del');
    await t.page.click('.ui-btn.is-primary');
    await t.page.waitForSelector('#posted');
    ok(t.posts.length === 1 && t.posts[0].path === '/delete' && form(t.posts[0].body).act === 'delete', 'the fallback keeps the button’s formaction (' + (t.posts[0] && t.posts[0].path) + ')');
    await t.ctx.close();
  });

  await step('openLink only opens own paths', async () => {
    const s = await open();
    const r = await s.page.evaluate(() => {
      const got = [];
      OYSUI.onLink((u) => { if (u.pathname !== '/dashboard') return false; got.push(u.pathname + u.hash); return true; });
      const out = ['/\\evil.example', '//evil.example', 'https://evil.example', 'javascript:alert(1)', '/x\u0000', '/' + 'a'.repeat(300)].map((l) => OYSUI.openLink(l));
      out.push(OYSUI.openLink('/dashboard#messages'));
      return { out, got };
    });
    ok(JSON.stringify(r.out) === JSON.stringify([false, false, false, false, false, false, true]), 'foreign, scheme, backslash and long links are refused');
    ok(JSON.stringify(r.got) === JSON.stringify(['/dashboard#messages']), 'the page’s onLink handler takes own targets');
    await s.page.evaluate(() => OYSUI.openLink('/next'));
    await s.page.waitForSelector('#next');
    ok(true, 'without a handler the link navigates');
    await s.ctx.close();
  });

  await step('leave guard', async () => {
    const body = '<a id="away" href="/next">Away</a> <a id="mail" href="mailto:mia@test.de">Reply</a> <a id="off" href="/next" data-guard="off">Off</a> <a id="hash" href="#tab">Tab</a> <a id="top" href="#">Top</a> <a id="top2" href="/#">Top</a>'
      + '<form id="out" action="/logout" method="post"><button id="logout">Log out</button></form>';
    let s = await open({ body });
    await s.page.evaluate(() => { window.r = { discard: 0 }; window.dirty = true; window.g = OYSUI.guard({ isDirty: () => window.dirty, onDiscard: () => { window.r.discard++; } }); });
    await s.page.click('#away');
    await s.page.waitForSelector('.ui-dialog');
    ok((await s.page.textContent('.ui-title')) === 'Leave without saving?' && await activeText(s.page) === 'Stay', 'our dialog, Stay focused');
    await s.page.click('.ui-btn.is-ghost');
    ok(s.page.url() === ORIGIN + '/' && await s.page.evaluate(() => window.r.discard) === 0, 'Stay keeps the page');
    await s.page.click('#hash');
    ok(await dialogs(s.page) === 0, 'a hash link on the same page does not ask');
    // Auch ein leerer Anker (#, /#) bleibt auf der Seite – keine Frage
    await s.page.click('#top');
    await sleep(100);
    ok(await dialogs(s.page) === 0, 'a link to "#" does not ask');
    await s.page.click('#top2');
    await sleep(100);
    ok(await dialogs(s.page) === 0, 'a link to the same path with an empty fragment does not ask');
    if (await dialogs(s.page)) await s.page.click('.ui-btn.is-ghost');
    await s.page.click('#mail');
    await sleep(100);
    ok(await dialogs(s.page) === 0, 'mailto: opens without any dialog');
    await s.page.evaluate(() => { window.r.discard = 0; sessionStorage.removeItem('discarded'); window.g2 = OYSUI.guard({ isDirty: () => false, onDiscard: () => sessionStorage.setItem('discarded', '1') }); });
    await s.page.click('#logout');
    await s.page.waitForSelector('.ui-dialog');
    await s.page.click('.ui-btn.is-danger');
    await s.page.waitForSelector('#posted');
    ok(s.posts.length === 1 && s.posts[0].path === '/logout', 'a form submit asks first and is sent after “Leave”');
    ok(await s.page.evaluate(() => sessionStorage.getItem('discarded')) === '1', '“Leave without saving” calls onDiscard of every source');
    await s.ctx.close();

    s = await open({ body });
    await s.page.evaluate(() => { window.r = { discard: 0 }; window.dirty = true; window.g = OYSUI.guard({ isDirty: () => window.dirty, onDiscard: () => { window.r.discard++; } }); });
    await s.page.click('#off');
    await s.page.waitForSelector('#next');
    ok(true, 'data-guard="off" is ignored by the guard');
    await s.ctx.close();

    s = await open({ body });
    await s.page.evaluate(() => { window.dirty = true; window.g = OYSUI.guard({ isDirty: () => window.dirty }); });
    await s.page.click('#away');
    await s.page.click('.ui-btn.is-danger');
    await s.page.waitForSelector('#next');
    ok(true, '“Leave without saving” navigates without the browser dialog');
    await s.ctx.close();

    s = await open({ body });
    await s.page.evaluate(() => { window.dirty = true; window.g = OYSUI.guard({ isDirty: () => window.dirty }); });
    await s.page.evaluate(() => window.g.navigate('/next', { force: true }));
    await s.page.waitForSelector('#next');
    ok(true, 'navigate(url, {force}) goes at once');
    await s.ctx.close();

    // Tab schließen: das Fenster des Browsers bleibt das Netz – außer der Entwurf liegt im Browser (D19)
    s = await open({ body });
    s.t.expectBeforeUnload = true;
    await s.page.evaluate(() => { window.dirty = true; window.g = OYSUI.guard({ isDirty: () => window.dirty }); });
    await s.page.click('#mail');
    await sleep(1700);
    await s.page.close({ runBeforeUnload: true });
    await sleep(500);
    ok(s.t.sawBeforeUnload === 1, 'after mailto: the protection is back (browser dialog on close)');
    await s.ctx.close();

    s = await open({ body });
    s.t.expectBeforeUnload = true;
    await s.page.evaluate(() => { window.g = OYSUI.guard({ isDirty: () => true, keepsDraft: () => true }); });
    await s.page.click('body');
    await s.page.close({ runBeforeUnload: true });
    await sleep(500);
    ok(!s.t.sawBeforeUnload, 'with the work kept as a draft the browser does not ask (D19)');
    await s.ctx.close();
  });

  await step('scroll position and sideways shift', async () => {
    const real = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
    const keep = browser;
    browser = real;
    for (const stub of [false, true]) {
      const s = await open({
        init: stub ? () => { const orig = CSS.supports.bind(CSS); CSS.supports = (a, b) => (/scrollbar-gutter/.test(String(a)) ? false : orig(a, b)); } : undefined,
        body: '<div style="height:4000px">tall</div><div id="fx" style="position:fixed;top:10px;left:50%;width:40px;height:20px;background:red"></div>',
      });
      await s.page.evaluate(() => window.scrollTo(0, 1200));
      const before = await s.page.evaluate(() => [scrollY, document.getElementById('fx').getBoundingClientRect().left, innerWidth - document.documentElement.clientWidth]);
      await s.page.evaluate(() => { OYSUI.confirm('Scroll?'); });
      await s.page.waitForSelector('.ui-dialog');
      const during = await s.page.evaluate(() => [scrollY, document.getElementById('fx').getBoundingClientRect().left, document.documentElement.style.paddingRight]);
      await s.page.keyboard.press('Escape');
      const after = await s.page.evaluate(() => [scrollY, document.documentElement.style.paddingRight]);
      const label = stub ? ' (padding fallback)' : ' (scrollbar-gutter)';
      ok(before[0] === 1200 && during[0] === 1200 && after[0] === 1200, 'scrollY unchanged' + label);
      if (!stub) ok(before[2] === 0 || Math.abs(during[1] - before[1]) < 0.5, 'no sideways shift of a fixed element' + label + ' (scrollbar ' + before[2] + 'px)');
      else ok(before[2] === 0 || during[2] === before[2] + 'px', 'padding fallback reserves the scrollbar width' + label);
      ok(after[1] === '', 'padding restored' + label);
      await s.ctx.close();
    }
    browser = keep;
    await real.close();
  });

  await step('unknown option keys warn', async () => {
    const s = await open();
    await s.page.evaluate(() => { OYSUI.confirm({ title: 'x', confirmLabel: 'Buy', danger: true }); OYSUI.toast({ text: 'y', kind: 'hc' }); });
    ok(s.warnings.some((w) => /unknown option "confirmLabel"/.test(w)) && s.warnings.some((w) => /unknown option "danger"/.test(w)) && s.warnings.some((w) => /toast: unknown option "kind"/.test(w)), 'placeholder names from older drafts are reported');
    await s.ctx.close();
  });

  await browser.close();
  summary('ui-kit');
})();
