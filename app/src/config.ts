// Einstellungen der Seite – dieselben Schlüssel wie früher in config.php, jetzt als config.json neben dem Code.
// Der Pfad lässt sich mit OYS_CONFIG ändern (z. B. für Tests).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key: string]: ConfigValue };
export type ConfigData = { [key: string]: ConfigValue };

// Wurzel des Repositorys: app/src (Entwicklung) oder app/dist (Betrieb) → zwei Ebenen höher
export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT_DIR = resolve(APP_DIR, '..');

let loaded: ConfigData | null = null;

export class ConfigMissingError extends Error {}

export function configFile(): string {
  return process.env.OYS_CONFIG || join(ROOT_DIR, 'config.json');
}

export function loadConfig(): ConfigData {
  if (loaded) return loaded;
  const file = configFile();
  if (!existsSync(file)) throw new ConfigMissingError(`The settings file ${file} is missing.`);
  const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  loaded = data && typeof data === 'object' && !Array.isArray(data) ? (data as ConfigData) : {};
  return loaded;
}

// Nur für Tests: andere Einstellungen setzen
export function setConfigForTests(data: ConfigData | null): void {
  loaded = data;
}

// Wie oys_config(): Punkt-Schreibweise (config('db.host')), sonst der Vorgabewert
export function config<T = ConfigValue>(key: string, fallback?: T): T {
  let value: ConfigValue | undefined = loadConfig();
  for (const part of key.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !(part in value)) return fallback as T;
    value = (value as { [key: string]: ConfigValue })[part];
  }
  return value as unknown as T;
}

// Diese Installation ist die Beta-Webseite (beta/site.ts; config.json der zweiten Installation von server/beta.sh)
export function isBetaBuild(): boolean {
  return config<unknown>('beta_build', false) === true;
}

export function configString(key: string, fallback = ''): string {
  const v = config<ConfigValue>(key, null);
  if (v === null || v === undefined || typeof v === 'object') return fallback;
  return String(v);
}

export function configInt(key: string, fallback: number): number {
  const v = config<ConfigValue>(key, null);
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return fallback;
}
