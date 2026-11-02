// Verschlüsselung und Hashes – Byte für Byte wie die PHP-Version (security.php, lib/helpers.php), damit alle
// gespeicherten Daten (ENC:…), Passwörter ($2y$…) und Signaturen weiter gelten.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import bcrypt from 'bcryptjs';
import { configString } from './config.js';
import { hasRawBytes, phpBytes } from './php.js';

// encryptData()/decryptData(): die geprüften Nachbauten aus compat/core.js (strenges Base64 wie PHP, Schlüssel als
// Bytes, zu kurz mit Nullbytes aufgefüllt) – hier nur mit dem Schlüssel aus den Einstellungen verbunden
import * as compat from './compat/core.js';

export function phpEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === '0' || value === 0 || value === false;
}

export function encryptData(plaintext: string | null | undefined): string | null | undefined {
  return compat.encryptData(plaintext, configString('aes_key', '')) as string | null | undefined;
}

export function decryptData(value: string | null | undefined): string | null | undefined {
  return compat.decryptData(value, configString('aes_key', '')) as string | null | undefined;
}

// Kurzform für Felder aus der Datenbank: immer ein String
export function decrypt(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(decryptData(String(value)) ?? '');
}

// Text als die Bytes, die PHP hätte (rohe Bytes aus Formularen bleiben einzelne Bytes, siehe phpText in php.ts)
const bytesOf = (data: string | Buffer): Buffer => (typeof data === 'string' ? phpBytes(data) : data);

// oys_hmac(): HMAC-SHA256 mit app_secret (oder dem abgeleiteten Ersatz), hex
export function hmac(data: string): string {
  let secret = configString('app_secret', '');
  if (secret === '') {
    secret = createHash('sha256').update('oys|' + configString('aes_key', '') + '|' + configString('db.pass', '')).digest('hex');
  }
  return createHmac('sha256', secret).update(bytesOf(data)).digest('hex');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(bytesOf(data)).digest('hex');
}

export function sha1Hex(data: string | Buffer): string {
  return createHash('sha1').update(bytesOf(data)).digest('hex');
}

export function md5Hex(data: string | Buffer): string {
  return createHash('md5').update(bytesOf(data)).digest('hex');
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

// hash_equals()
export function safeEqual(a: string, b: string): boolean {
  const x = phpBytes(a);
  const y = phpBytes(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// password_hash(PASSWORD_DEFAULT) = bcrypt mit Kosten 10 und Präfix $2y$ (gleichwertig zu $2b$).
// Ein Nullbyte im Passwort lehnt PHP mit einem ValueError ab (die Anfrage endet mit 500).
// Ein Passwort mit rohen Bytes (ungültiges UTF-8 aus dem Formular) rechnet PHP mit genau diesen Bytes.
export async function passwordHash(password: string): Promise<string> {
  if (password.includes('\0')) throw new Error('Bcrypt password must not contain null character');
  const salt = bcrypt.genSaltSync(10);
  const hash = (await bcryptJob(hasRawBytes(password) ? { op: 'hash', bytes: phpBytes(password), salt } : { op: 'hash', password, salt })) as string;
  return hash.replace(/^\$2[ab]\$/, '$2y$');
}

// password_verify(): leere, fehlende oder fremde Hashes ergeben false. Wie crypt() in PHP endet das Passwort am
// ersten Nullbyte („abc\0x“ passt zu „abc“).
export async function passwordVerify(password: string, hash: unknown): Promise<boolean> {
  if (typeof hash !== 'string' || !/^\$2[aby]\$\d\d\$/.test(hash)) return false;
  const pw = password.split('\0')[0];
  const h = hash.replace(/^\$2y\$/, '$2b$');
  try {
    return (await bcryptJob(hasRawBytes(pw) ? { op: 'compare', bytes: phpBytes(pw), hash: h } : { op: 'compare', password: pw, hash: h })) === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- bcrypt neben dem Event-Loop

// bcrypt mit Kosten 10 rechnet in reinem JavaScript rund 80 ms. Im Haupt-Thread stünden so lange alle anderen Anfragen
// still – auch die asynchrone Fassung von bcryptjs gibt kaum ab (8 gleichzeitige Anmeldungen: ~0,7 s Stillstand).
// Darum rechnen bis zu zwei Worker-Threads mit derselben Bibliothek (gleiche Hashes, gleiche Ergebnisse). Sie starten
// beim ersten Passwort, laufen danach weiter und halten den Prozess nur offen, solange sie etwas zu tun haben.
// Der Worker-Code steht hier als Text (eval): so läuft er gleich unter tsx und im gebauten dist/.
// bcryptjs nimmt nur Text (und schreibt ihn als UTF-8). Passwörter mit rohen Bytes rechnet darum ein eigener Teil
// direkt auf den Bytes – derselbe Algorithmus (Blowfish mit den Startwerten aus den Nachkommastellen von Pi, die er
// beim ersten Bedarf selbst berechnet); die Tests vergleichen ihn mit PHP und bcryptjs.
const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const bcrypt = require(workerData.bcrypt);

// Nachkommastellen von Pi als 32-Bit-Wörter (Machin: pi = 16 atan(1/5) - 4 atan(1/239), Festkomma mit BigInt)
let PI = null;
function piWords(count) {
  const bits = BigInt(count * 32 + 64);
  const one = 1n << bits;
  const atan = (x) => {
    let sum = 0n, term = one / x, k = 1n, neg = false;
    const x2 = x * x;
    while (term !== 0n) { sum = neg ? sum - term / k : sum + term / k; term /= x2; k += 2n; neg = !neg; }
    return sum;
  };
  let frac = 16n * atan(5n) - 4n * atan(239n) - (3n << bits);
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) { frac <<= 32n; out[i] = Number(BigInt.asIntN(32, frac >> bits)); frac &= one - 1n; }
  if (out[0] !== 0x243f6a88 || (out[count - 1] >>> 0) !== 0x3ac372e6) throw new Error('blowfish constants');
  return out;
}

// bcrypt (EksBlowfish, OpenBSD/crypt_blowfish) auf Bytes: key = Passwort + Nullbyte, 16 Bytes Salz, 2^cost Runden
function eksBlowfish(key, salt, cost) {
  PI ??= piWords(18 + 1024);
  const P = PI.slice(0, 18);
  const S = PI.slice(18);
  const lr = new Int32Array(2);
  const enc = (a, o) => {
    let l = a[o] ^ P[0];
    let r = a[o + 1];
    for (let i = 1; i <= 16; i += 2) {
      r ^= (((S[l >>> 24] + S[0x100 | ((l >>> 16) & 0xff)]) ^ S[0x200 | ((l >>> 8) & 0xff)]) + S[0x300 | (l & 0xff)]) ^ P[i];
      l ^= (((S[r >>> 24] + S[0x100 | ((r >>> 16) & 0xff)]) ^ S[0x200 | ((r >>> 8) & 0xff)]) + S[0x300 | (r & 0xff)]) ^ P[i + 1];
    }
    a[o] = r ^ P[17];
    a[o + 1] = l;
  };
  // Bytes im Kreis als Wörter (big-endian)
  const words = (d) => { let p = 0; return () => { let w = 0; for (let i = 0; i < 4; i++) { w = (w << 8) | d[p]; p = (p + 1) % d.length; } return w; }; };
  const expand = (k, s) => {
    const kw = words(k);
    for (let i = 0; i < 18; i++) P[i] ^= kw();
    const sw = s ? words(s) : null;
    lr[0] = 0; lr[1] = 0;
    for (let i = 0; i < 18; i += 2) { if (sw) { lr[0] ^= sw(); lr[1] ^= sw(); } enc(lr, 0); P[i] = lr[0]; P[i + 1] = lr[1]; }
    for (let i = 0; i < 1024; i += 2) { if (sw) { lr[0] ^= sw(); lr[1] ^= sw(); } enc(lr, 0); S[i] = lr[0]; S[i + 1] = lr[1]; }
  };
  expand(key, salt);
  for (let i = 0, n = 2 ** cost; i < n; i++) { expand(key, null); expand(salt, null); }
  const text = Buffer.from('OrpheanBeholderScryDoubt', 'latin1');
  const c = new Int32Array(6);
  for (let i = 0; i < 6; i++) c[i] = text.readInt32BE(i * 4);
  for (let i = 0; i < 64; i++) for (let j = 0; j < 6; j += 2) enc(c, j);
  const out = Buffer.alloc(24);
  for (let i = 0; i < 6; i++) out.writeInt32BE(c[i], i * 4);
  return out.subarray(0, 23);
}

// Wie bcrypt.hashSync(Passwort, Einstellung): "$2b$10$" + 22 Zeichen Salz; null bei ungültiger Einstellung
function bytesHash(pw, setting) {
  const cost = Number(setting.slice(4, 6));
  if (!/^[$]2[ab][$][0-9][0-9][$]/.test(setting) || cost < 4 || cost > 31) return null;
  const salt = bcrypt.decodeBase64(setting.slice(7, 29), 16);
  if (salt.length !== 16) return null;
  const key = Buffer.concat([pw, Buffer.of(0)]);
  return setting.slice(0, 7) + bcrypt.encodeBase64(salt, 16) + bcrypt.encodeBase64(eksBlowfish(key, Buffer.from(salt), cost), 23);
}

function bytesCompare(pw, hash) {
  if (hash.length !== 60) return false;
  const mine = bytesHash(pw, hash.slice(0, 29));
  if (mine === null) return false;
  let diff = 0;
  for (let i = 0; i < 60; i++) diff |= mine.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

parentPort.on('message', (m) => {
  let reply;
  try {
    let result;
    if (m.bytes) {
      const pw = Buffer.from(m.bytes);
      result = m.op === 'hash' ? bytesHash(pw, m.salt) : bytesCompare(pw, m.hash);
      if (result === null) throw new Error('Invalid salt');
    } else {
      result = m.op === 'hash' ? bcrypt.hashSync(m.password, m.salt) : bcrypt.compareSync(m.password, m.hash);
    }
    reply = { result };
  } catch (err) {
    reply = { error: String(err && err.message ? err.message : err) };
  }
  parentPort.postMessage(reply);
});
`;

// password = Text (bcryptjs), bytes = Passwort mit rohen Bytes (eigener Teil im Worker)
type BcryptMsg = { op: 'hash'; password?: string; bytes?: Buffer; salt: string } | { op: 'compare'; password?: string; bytes?: Buffer; hash: string };
interface BcryptJob {
  msg: BcryptMsg;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}
interface BcryptSlot {
  worker: Worker;
  job: BcryptJob | null;
}

const POOL_SIZE = Math.max(1, Math.min(2, availableParallelism() - 1));
const slots: BcryptSlot[] = [];
const waiting: BcryptJob[] = [];
let bcryptFile: string | null = null;
// Worker, die hintereinander ohne ein einziges Ergebnis wegfielen: ab drei keine neuen mehr (Haupt-Thread)
let failedWorkers = 0;

function bcryptJob(msg: BcryptMsg): Promise<unknown> {
  return new Promise((resolve, reject) => {
    waiting.push({ msg, resolve, reject });
    pumpBcrypt();
  });
}

// Wartende Aufgaben an freie Worker geben (bei Bedarf einen neuen starten)
function pumpBcrypt(): void {
  while (waiting.length) {
    let slot = slots.find((s) => s.job === null);
    if (!slot && slots.length < POOL_SIZE && failedWorkers < 3) slot = startBcryptWorker() ?? undefined;
    if (!slot) {
      // Kein Worker zu haben (z. B. Threads nicht erlaubt): im Haupt-Thread wie früher, damit Anmeldungen gehen
      if (slots.length === 0) bcryptInThread(waiting.shift()!);
      else return;
      continue;
    }
    const job = waiting.shift()!;
    slot.job = job;
    slot.worker.ref();
    slot.worker.postMessage(job.msg);
  }
}

function startBcryptWorker(): BcryptSlot | null {
  let worker: Worker;
  try {
    bcryptFile ??= createRequire(import.meta.url).resolve('bcryptjs');
    worker = new Worker(WORKER_CODE, { eval: true, workerData: { bcrypt: bcryptFile }, execArgv: [] });
  } catch (err) {
    failedWorkers++;
    console.error(`[${new Date().toISOString()}] bcrypt worker could not start:`, err);
    return null;
  }
  const slot: BcryptSlot = { worker, job: null };
  worker.unref();
  let answered = false;
  worker.on('message', (m: { result?: unknown; error?: string }) => {
    const job = slot.job;
    slot.job = null;
    answered = true;
    failedWorkers = 0;
    worker.unref();
    if (job) {
      if (m.error !== undefined) job.reject(new Error(m.error));
      else job.resolve(m.result);
    }
    pumpBcrypt();
  });
  // Worker abgestürzt oder beendet: aus dem Pool nehmen, seine Aufgabe rechnet der Haupt-Thread (Notlösung, damit
  // niemand ohne Antwort bleibt); die nächsten Aufgaben bekommt ein neuer Worker
  const gone = (reason: unknown) => {
    const i = slots.indexOf(slot);
    if (i < 0) return;
    slots.splice(i, 1);
    if (!answered) failedWorkers++;
    console.error(`[${new Date().toISOString()}] bcrypt worker stopped:`, reason);
    const job = slot.job;
    slot.job = null;
    if (job) bcryptInThread(job);
    pumpBcrypt();
  };
  worker.on('error', gone);
  worker.on('exit', (code) => gone(`exit code ${code}`));
  slots.push(slot);
  return slot;
}

// Notlösung ohne Worker: bcryptjs im Haupt-Thread. Rohe Bytes kann nur der Worker – dann ein Fehler (Prüfung: false)
function bcryptInThread(job: BcryptJob): void {
  const m = job.msg;
  if (m.password === undefined) {
    job.reject(new Error('bcrypt worker unavailable'));
    return;
  }
  (m.op === 'hash' ? bcrypt.hash(m.password, m.salt) : bcrypt.compare(m.password, m.hash)).then(job.resolve, job.reject);
}
