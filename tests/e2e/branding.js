// E2E: „Made with OnYourSite“ ohne Premium (premium-domains PD-1). Im echten Browser bleibt der Hinweis sichtbar, egal
// mit welchem eigenen CSS (auch !important, @layer, Transformationen, Verschieben, Ausschneiden …); eine ehrliche Seite
// sieht aus wie bisher (Schriftgröße, Deckkraft), und beim Darüberfahren wird der Link unterstrichen. Mit Premium des
// Besitzers und eingeschaltetem Schalter fehlt der Hinweis, und der Titel endet nicht mehr auf „| OnYourSite“ (PD-1b).
//
// Start (Datenbank muss laufen, z. B. über oys-db.sh run):
//   node tests/e2e/branding.js
// Umgebung: OYS_E2E_PORT (Port des Node-Servers, Vorgabe 14207), OYS_CONFIG (Vorgabe config.json im Projekt),
// OYS_E2E_SHOTS (Ordner für Bildschirmfotos, optional). Schreibt nur Mias Seite (id 2) und Toms Premium (id 6) und stellt
// beides am Ende wieder her.
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.OYS_E2E_PORT || 14207);
const SOURCE = process.env.OYS_CONFIG || path.join(ROOT, 'config.json');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const base = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const HOST = String(base.base_domain || 'on-your.site').split(':')[0];
const MIA = `http://mia.${HOST}:${PORT}`;
const TOM = `http://tom.${HOST}:${PORT}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oys-e2e-branding-'));
const CONFIG = path.join(dir, 'config.json');
fs.writeFileSync(CONFIG, JSON.stringify({ ...base, base_domain: `${HOST}:${PORT}`, scheme: 'http' }), { mode: 0o600 });

const mysqlArgs = ['--default-character-set=utf8mb4', '-N', '-h', String(base.db.host || 'localhost'), '-u', String(base.db.user), String(base.db.name)];
const sql = (query) => execFileSync('mysql', [...mysqlArgs, '-e', query], { env: { ...process.env, MYSQL_PWD: String(base.db.pass || '') } }).toString().trim();
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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

// Eigenes CSS, das den Hinweis heute ausblenden würde – keines darf ihn verstecken
const TRICKS = [
  '.oys-foot{display:none!important}',
  '@layer x{.oys-foot{display:none!important}}',
  'footer{visibility:hidden!important;opacity:0!important}',
  '.oys-foot{transform:scale(0)!important}',
  '.oys-foot{scale:0!important}',
  '.oys-foot{position:absolute!important;left:-9999px!important}',
  '.oys-foot{height:0!important;overflow:hidden!important}',
  '.oys-foot,.oys-foot a{font-size:0!important}',
  '.oys-main>:last-child{clip-path:inset(50%)!important}',
  '.oys-foot{text-indent:-9999px!important}',
  '.oys-foot{content-visibility:hidden!important}',
  '.oys-foot strong{display:none!important}',
  '.oys-foot{-webkit-mask-image:linear-gradient(transparent,transparent)!important;mask-image:linear-gradient(transparent,transparent)!important}',
  '.oys-foot a{filter:opacity(0)!important;translate:0 -9999px!important}',
  '.oys-foot{zoom:.01!important}',
];

// Box und berechnete Stile des Hinweises
async function footerState(p) {
  return p.evaluate(() => {
    const f = document.querySelector('footer.oys-foot');
    if (!f) return null;
    const a = f.querySelector('a');
    const s = f.querySelector('strong');
    const r = f.getBoundingClientRect();
    const ra = a.getBoundingClientRect();
    const rs = s.getBoundingClientRect();
    const cf = getComputedStyle(f);
    const ca = getComputedStyle(a);
    const cs = getComputedStyle(s);
    return {
      footer: { w: r.width, h: r.height, left: r.left, right: r.right, display: cf.display, visibility: cf.visibility, opacity: cf.opacity, fontSize: parseFloat(cf.fontSize) },
      link: { w: ra.width, h: ra.height, left: ra.left, right: ra.right, top: ra.top, opacity: ca.opacity, fontSize: parseFloat(ca.fontSize), display: ca.display, deco: ca.textDecorationLine },
      strong: { w: rs.width, h: rs.height, display: cs.display, visibility: cs.visibility },
      vw: window.innerWidth,
      docH: document.documentElement.scrollHeight,
      mainFont: parseFloat(getComputedStyle(document.querySelector('.oys-main')).fontSize),
    };
  });
}

(async () => {
  const server = await startServer();
  const before = sql('SELECT settings FROM pages WHERE id = 2');
  const tomSettings = sql('SELECT settings FROM pages WHERE id = 3');
  const tomPremium = sql("SELECT COALESCE(premium_until, '') FROM users WHERE id = 6");
  const setCss = (css, hide = false) => sql(`UPDATE pages SET settings = JSON_SET(settings, '$.custom_css', '${esc(css)}', '$.hide_branding', ${hide ? 'true' : 'false'}) WHERE id = 2`);
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP *.${HOST} 127.0.0.1`] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const p = await context.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));

    // 1. Ehrliche Seite: wie bisher (Schriftgröße .78em, Deckkraft .75, Unterstreichung beim Darüberfahren)
    setCss('');
    await p.goto(MIA + '/', { waitUntil: 'networkidle' });
    let st = await footerState(p);
    ok(st !== null, 'The note is there');
    ok(Math.abs(st.footer.fontSize - st.mainFont * 0.78) < 0.05, `Footer font size unchanged (${st.footer.fontSize}px = .78 × ${st.mainFont}px)`);
    ok(st.link.opacity === '0.75' && st.link.display === 'inline-block', `Link as before (opacity ${st.link.opacity}, ${st.link.display})`);
    ok(st.link.deco === 'none', 'No underline at rest');
    await p.hover('footer.oys-foot a');
    st = await footerState(p);
    ok(st.link.deco === 'underline', 'Underlined on hover');
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'branding-honest.png'), fullPage: true });

    // 2. Jeder Trick: der Hinweis bleibt sichtbar und lesbar
    for (const css of TRICKS) {
      setCss(css);
      await p.goto(MIA + '/', { waitUntil: 'networkidle' });
      st = await footerState(p);
      const fine = st !== null && st.footer.display === 'block' && st.footer.visibility === 'visible' && st.footer.opacity === '1'
        && st.footer.w > 50 && st.footer.h > 10 && st.footer.left >= 0 && st.footer.right <= st.vw
        && st.link.w > 50 && st.link.h > 10 && st.link.left >= 0 && st.link.right <= st.vw && st.link.top > -1 && st.link.top < st.docH
        && st.link.opacity === '0.75' && st.link.fontSize >= 11 && st.strong.w > 10 && st.strong.display === 'inline' && st.strong.visibility === 'visible';
      ok(fine, `Still visible with ${css}` + (fine ? '' : ' ' + JSON.stringify(st)));
    }
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'branding-trick.png'), fullPage: true });

    // 3. Schalter an, aber ohne Premium: der Hinweis bleibt
    setCss('', true);
    await p.goto(MIA + '/', { waitUntil: 'networkidle' });
    ok((await footerState(p)) !== null, 'Switch on without Premium: the note stays');

    // 4. Premium des Besitzers und Schalter an: kein Hinweis
    sql("UPDATE users SET premium_until = '9999-12-31 23:59:59' WHERE id = 6");
    sql("UPDATE pages SET settings = JSON_SET(settings, '$.hide_branding', true) WHERE id = 3");
    await p.goto(TOM + '/', { waitUntil: 'networkidle' });
    ok((await footerState(p)) === null, 'Premium and switch on: no note');
    const title = await p.title();
    ok(title !== '' && !title.includes('OnYourSite'), `Premium: no “| OnYourSite” in the title (${title})`);
    await p.goto(MIA + '/', { waitUntil: 'networkidle' });
    ok((await p.title()).endsWith(' | OnYourSite'), 'Without Premium the title keeps “| OnYourSite”');
    ok(errors.length === 0, 'No page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    sql(`UPDATE pages SET settings = '${esc(before)}' WHERE id = 2`);
    sql(`UPDATE pages SET settings = '${esc(tomSettings)}' WHERE id = 3`);
    sql(`UPDATE users SET premium_until = ${tomPremium === '' ? 'NULL' : `'${tomPremium}'`} WHERE id = 6`);
    await browser.close();
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `branding e2e: ${failed} failed` : 'branding e2e: all passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
