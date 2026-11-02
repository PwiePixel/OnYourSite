// Werkzeuge für die Browser-Tests (Playwright mit Chromium): die Seite als eigener Prozess mit einer Kopie der
// Einstellungen (eigene Discord-Adresse), Anmelden, Datenbank. Playwright gehört nicht zu den Abhängigkeiten der App –
// es wird aus der Umgebung geladen (NODE_PATH). Start: cd app && node --import tsx --test test/e2e/*.e2e.ts
// Port der Seite: OYS_E2E_PORT (Vorgabe 14203). node --test startet jede Datei in einem eigenen Prozess, gleichzeitig –
// die Dateien warten darum aufeinander (eine Seite je Port), und jede spricht nur mit ihrem eigenen Server.
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_DIR, ROOT_DIR, setConfigForTests, type ConfigData } from '../../src/config.js';
import { closePool } from '../../src/db.js';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright') as typeof import('playwright');

export const PORT = Number(process.env.OYS_E2E_PORT || 14203);
export const HOST = 'oys.test:' + PORT;
export const SITE = 'http://' + HOST;

export interface Site { config: ConfigData; stop(): Promise<void>; log(): string }

// Startet src/server.ts mit einer Kopie von config.json (plus overrides). Der Testprozess selbst benutzt dieselben
// Einstellungen (Datenbank, Schlüssel) – so kann er Zeilen lesen und verschlüsselte Werte schreiben.
// Sperre für den Port: solange eine andere Testdatei ihre Seite laufen hat, warten (eine Sperre eines beendeten
// Prozesses wird weggeräumt)
const LOCK = join(tmpdir(), `oys-e2e-${PORT}.lock`);
function lockHolderAlive(): boolean {
  let pid = 0;
  try {
    pid = Number(readFileSync(LOCK, 'utf8'));
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
async function lockPort(): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (!lockHolderAlive()) rmSync(LOCK, { force: true });
    else if (Date.now() - started > 10 * 60_000) throw new Error(`port ${PORT}: another browser test has held ${LOCK} for 10 minutes`);
    else await new Promise((r) => setTimeout(r, 500));
  }
}
function unlockPort(): void {
  try {
    if (readFileSync(LOCK, 'utf8') === String(process.pid)) rmSync(LOCK, { force: true });
  } catch {
    // schon weg
  }
}
// Antwortet schon etwas auf dem Port (z. B. eine von Hand gestartete Seite), wäre es nicht unsere
function portAnswers(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port: PORT, host: '127.0.0.1' });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
  });
}

export async function startSite(overrides: ConfigData = {}): Promise<Site> {
  await lockPort();
  if (await portAnswers()) {
    unlockPort();
    throw new Error(`port ${PORT} is already in use by another server – stop it first`);
  }
  const base = JSON.parse(readFileSync(process.env.OYS_CONFIG || join(ROOT_DIR, 'config.json'), 'utf8')) as ConfigData;
  const config: ConfigData = { ...base, base_domain: HOST, scheme: 'http', ...overrides };
  const dir = mkdtempSync(join(tmpdir(), 'oys-e2e-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  setConfigForTests(config);
  await closePool();

  let out = '';
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', OYS_CONFIG: file },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) {
      unlockPort();
      throw new Error('the site did not start:\n' + out);
    }
    // Erst wenn unser eigener Server meldet, dass er lauscht (eine Antwort irgendeines Servers auf dem Port genügt nicht)
    if (out.includes(`is listening on http://127.0.0.1:${PORT}`)) break;
    if (Date.now() - started > 30000) {
      child.kill();
      unlockPort();
      throw new Error('the site did not answer within 30 s:\n' + out);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    config,
    log: () => out,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((r) => child.once('exit', r));
      }
      await closePool();
      rmSync(dir, { recursive: true, force: true });
      unlockPort();
    },
  };
}

// Chromium, das oys.test und alle Subdomains auf diesen Rechner leitet
export async function launch() {
  return chromium.launch({ args: ['--host-resolver-rules=MAP *.oys.test 127.0.0.1, MAP oys.test 127.0.0.1'] });
}

type Page = import('playwright').Page;

export async function login(page: Page, email = 'admin@test.de', password = 'test1234'): Promise<void> {
  await page.goto(SITE + '/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button[type=submit]')]);
}

// Meldung nach einem Formular (der Erfolg verschwindet nach fünf Sekunden – darum gleich nach dem Laden lesen). Mit den
// eigenen Dialogen (ui.js) wird das Banner zu einem Toast; ohne ui.js bleibt es das Banner.
export async function flash(page: Page): Promise<string> {
  const toast = page.locator('.ui-toast .ui-toast-text').first();
  try {
    await toast.waitFor({ state: 'attached', timeout: 2000 });
    return (await toast.innerText()).trim();
  } catch {
    // kein Toast
  }
  const el = page.locator('.animate-fade-in').first();
  if (!(await el.count())) return '';
  return (await el.innerText()).trim();
}
