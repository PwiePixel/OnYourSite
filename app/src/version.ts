// Installierte Version: Datei VERSION im Code-Ordner (wird bei jedem Release erhöht, siehe CHANGELOG.md und
// scripts/release.sh). Fehlt sie oder ist sie leer, gilt „dev“.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from './config.js';

let cached: string | null = null;

export function appVersion(): string {
  if (cached === null) {
    let v = '';
    try {
      v = readFileSync(join(ROOT_DIR, 'VERSION'), 'utf8').trim();
    } catch {
      v = '';
    }
    cached = v !== '' ? v : 'dev';
  }
  return cached;
}
