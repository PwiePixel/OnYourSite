// Verschlüsselung und Hashes – Byte für Byte wie die PHP-Version (security.php, lib/helpers.php), damit alle
// gespeicherten Daten (ENC:…), Passwörter ($2y$…) und Signaturen weiter gelten.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { configString } from './config.js';

// PHP: openssl_* nimmt den Schlüssel als Bytes; zu kurz wird mit Nullbytes aufgefüllt, zu lang abgeschnitten
function aesKey(): Buffer {
  const raw = Buffer.from(configString('aes_key', ''), 'utf8');
  const key = Buffer.alloc(32);
  raw.copy(key, 0, 0, Math.min(32, raw.length));
  return key;
}

// PHP empty(): '' und '0' gelten als leer
export function phpEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === '0' || value === 0 || value === false;
}

// encryptData(): 'ENC:' + base64(IV + base64(Ciphertext)) – openssl_encrypt mit Optionen 0 liefert schon Base64
export function encryptData(plaintext: string | null | undefined): string | null | undefined {
  if (phpEmpty(plaintext)) return plaintext;
  const text = String(plaintext);
  if (text.startsWith('ENC:')) return text;
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', aesKey(), iv);
  const ctB64 = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
  return 'ENC:' + Buffer.concat([iv, Buffer.from(ctB64, 'latin1')]).toString('base64');
}

// decryptData(): bei allem, was nicht passt, kommt der Text unverändert zurück (wie in PHP)
export function decryptData(value: string | null | undefined): string | null | undefined {
  if (phpEmpty(value)) return value;
  const text = String(value);
  if (!text.startsWith('ENC:')) return text;
  const b64 = text.slice(4);
  // base64_decode(..., true): nur gültige Zeichen
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64.replace(/\s+/g, ''))) return text;
  const data = Buffer.from(b64, 'base64');
  if (data.length <= 16) return text;
  const iv = data.subarray(0, 16);
  const ctB64 = data.subarray(16).toString('latin1');
  try {
    const decipher = createDecipheriv('aes-256-cbc', aesKey(), iv);
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return text;
  }
}

// Kurzform für Felder aus der Datenbank: immer ein String
export function decrypt(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(decryptData(String(value)) ?? '');
}

// oys_hmac(): HMAC-SHA256 mit app_secret (oder dem abgeleiteten Ersatz), hex
export function hmac(data: string): string {
  let secret = configString('app_secret', '');
  if (secret === '') {
    secret = createHash('sha256').update('oys|' + configString('aes_key', '') + '|' + configString('db.pass', '')).digest('hex');
  }
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function md5Hex(data: string | Buffer): string {
  return createHash('md5').update(data).digest('hex');
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

// hash_equals()
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

// password_hash(PASSWORD_DEFAULT) = bcrypt mit Kosten 10 und Präfix $2y$ (gleichwertig zu $2b$)
export async function passwordHash(password: string): Promise<string> {
  const hash = await bcrypt.hash(password, 10);
  return hash.replace(/^\$2[ab]\$/, '$2y$');
}

export async function passwordVerify(password: string, hash: string): Promise<boolean> {
  if (!/^\$2[aby]\$\d\d\$/.test(hash)) return false;
  try {
    return await bcrypt.compare(password, hash.replace(/^\$2y\$/, '$2b$'));
  } catch {
    return false;
  }
}
