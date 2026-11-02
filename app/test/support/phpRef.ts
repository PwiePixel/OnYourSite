// Vergleiche mit der PHP-Version: Seit 3.0 liegt sie nicht mehr im Repository – der Branch php-2.x hält die letzte
// Fassung. Tests, die Node mit PHP vergleichen, lesen sie aus einer Arbeitskopie dieses Branches, deren Pfad
// OYS_PHP_REF nennt (dafür braucht es PHP 8 auf der Kommandozeile, siehe README.md unter „Tests“):
//   git worktree add --detach ~/oys-php-2.x origin/php-2.x
//   cd app && OYS_PHP_REF=~/oys-php-2.x npm test
// Ohne OYS_PHP_REF werden genau diese Tests übersprungen (mit Hinweis); alles andere läuft ohne PHP.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ROOT_DIR, configFile, type ConfigData } from '../../src/config.js';

const given = process.env.OYS_PHP_REF ?? '';

// Arbeitskopie der PHP-Version ('' = keine angegeben)
export const PHP_REF = given ? resolve(given) : '';

// Für test(name, { skip: PHP_SKIP }, …): ohne OYS_PHP_REF der Grund zum Überspringen, sonst false
export const PHP_SKIP: string | false = PHP_REF ? false : 'compares with the PHP version – set OYS_PHP_REF to a checkout of the branch php-2.x';

if (PHP_REF) {
  // Falsch gesetzt: lieber deutlich scheitern als still nichts vergleichen
  if (!existsSync(join(PHP_REF, 'lib', 'bootstrap.php'))) {
    throw new Error(`OYS_PHP_REF=${given} is not a checkout of the PHP version (lib/bootstrap.php is missing) – use the branch php-2.x`);
  }
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('OYS_PHP_REF is set, but the php command doesn’t run – the comparisons need PHP 8 on the command line');
  }
}

// Pfad in der Arbeitskopie der PHP-Version
export function phpRef(...parts: string[]): string {
  if (!PHP_REF) throw new Error(String(PHP_SKIP));
  return join(PHP_REF, ...parts);
}

// config.php mit diesen Einstellungen (als JSON, dieselben Werte wie config.json) in einen Ordner schreiben
export function writePhpConfig(dir: string, config: ConfigData): void {
  const json = Buffer.from(JSON.stringify(config)).toString('base64');
  writeFileSync(join(dir, 'config.php'), `<?php\nreturn json_decode(base64_decode('${json}'), true);\n`, { mode: 0o600 });
}

// Eigener Code-Ordner der PHP-Version für einen Test: <neuer Ordner>/code mit config.php aus config. PHP sucht
// config.php, email/ und static/ relativ zu __DIR__, und __DIR__ zeigt bei einer Verknüpfung auf das Ziel – darum
// sind die PHP-Dateien kopiert (PHPMailer nur verlinkt). static/ und robots.txt kommen aus diesem Repository (dieselben
// Dateien wie für Node, auch die Zeitstempel für ?v=), email/ mit den Vorlagen von hier, ohne smtp.json – Tests legen
// bei Bedarf ihre eigene ab. Der Ordner darüber ist eigens angelegt: oys_uploads_suggested_dir() zeigt dorthin.
// Aufräumen: removePhpTree(dir).
export function phpTree(config: ConfigData, parent = tmpdir()): string {
  const ref = phpRef();
  const dir = join(mkdtempSync(join(parent, 'oys-php-')), 'code');
  mkdirSync(join(dir, 'server'), { recursive: true });
  for (const f of readdirSync(ref)) if (f.endsWith('.php') && f !== 'config.php') copyFileSync(join(ref, f), join(dir, f));
  for (const d of ['lib', 'views', 'cron']) cpSync(join(ref, d), join(dir, d), { recursive: true });
  for (const f of readdirSync(join(ref, 'server'))) if (f.endsWith('.php')) copyFileSync(join(ref, 'server', f), join(dir, 'server', f));
  symlinkSync(join(ref, 'PHPMailer'), join(dir, 'PHPMailer'));
  symlinkSync(join(ROOT_DIR, 'static'), join(dir, 'static'));
  symlinkSync(join(ROOT_DIR, 'robots.txt'), join(dir, 'robots.txt'));
  mkdirSync(join(dir, 'email'));
  for (const f of readdirSync(join(ROOT_DIR, 'email'))) {
    if (f.endsWith('.json') && f !== 'smtp.json') copyFileSync(join(ROOT_DIR, 'email', f), join(dir, 'email', f));
  }
  writePhpConfig(dir, config);
  return dir;
}

// Ordner aus phpTree() samt dem eigens angelegten Ordner darüber löschen (Verknüpfungen werden nicht verfolgt)
export function removePhpTree(dir: string): void {
  rmSync(dirname(dir), { recursive: true, force: true });
}

let shared = '';

// Gemeinsamer Code-Ordner der PHP-Version für diesen Testlauf, mit den Einstellungen aus config.json (wie früher die
// config.php neben dem Code). Entsteht beim ersten Aufruf und wird am Ende gelöscht.
export function phpRoot(): string {
  if (!shared) {
    const dir = phpTree(JSON.parse(readFileSync(configFile(), 'utf8')) as ConfigData);
    process.on('exit', () => removePhpTree(dir));
    shared = dir;
  }
  return shared;
}

// Datei im gemeinsamen Code-Ordner der PHP-Version, z. B. phpFile('lib/helpers.php')
export const phpFile = (rel: string): string => join(phpRoot(), rel);

// Pfade aus einem Code-Ordner der PHP-Version in die dieses Repositorys umschreiben (für Ausgaben mit Pfaden)
export function fromPhpTree(text: string, dir = phpRoot()): string {
  return text.split(dir).join(ROOT_DIR).split(dirname(dir)).join(dirname(ROOT_DIR));
}
