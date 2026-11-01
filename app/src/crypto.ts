// Verschlüsselung und Hashes – Byte für Byte wie die PHP-Version (security.php, lib/helpers.php), damit alle
// gespeicherten Daten (ENC:…), Passwörter ($2y$…) und Signaturen weiter gelten.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { configString } from './config.js';

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

export function sha1Hex(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
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

// password_verify(): leere, fehlende oder fremde Hashes ergeben false
export async function passwordVerify(password: string, hash: unknown): Promise<boolean> {
  if (typeof hash !== 'string' || !/^\$2[aby]\$\d\d\$/.test(hash)) return false;
  try {
    return await bcrypt.compare(password, hash.replace(/^\$2y\$/, '$2b$'));
  } catch {
    return false;
  }
}
