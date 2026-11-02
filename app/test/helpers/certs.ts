// Zertifikate für Tests der HTTPS-Prüfungen, zur Laufzeit mit openssl erzeugt (nichts davon liegt im Repository):
// eine eigene Zertifizierungsstelle und Blätter für bestimmte Namen und Laufzeiten – auch schon abgelaufene.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Leaf {
  key: string;
  cert: string;
}

export interface TestPki {
  ca: string;
  leaf(names: string[], opts?: { days?: number; start?: string; end?: string }): Leaf;
  done(): void;
}

export function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function testPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'oys-status-pki-'));
  const run = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  };
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  run(['req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '30', '-subj', '/CN=OYS status test CA']);
  writeFileSync(join(dir, 'index.txt'), '');
  writeFileSync(join(dir, 'serial'), '1000\n');
  writeFileSync(join(dir, 'ca.cnf'), [
    '[ ca ]', 'default_ca = test', '[ test ]', 'database = index.txt', 'new_certs_dir = .', 'serial = serial', 'default_md = sha256',
    'policy = any', 'unique_subject = no', 'copy_extensions = copy', '[ any ]', 'commonName = supplied', '',
  ].join('\n'));
  let n = 0;
  return {
    ca: readFileSync(join(dir, 'ca.crt'), 'utf8'),
    leaf(names, opts = {}) {
      n++;
      const base = `leaf${n}`;
      const san = names.map((x) => (/^\d+\.\d+\.\d+\.\d+$/.test(x) ? `IP:${x}` : `DNS:${x}`)).join(',');
      writeFileSync(join(dir, `${base}.ext`), `subjectAltName=${san}\n`);
      run(['req', ...ec, '-keyout', `${base}.key`, '-out', `${base}.csr`, '-subj', `/CN=${names[0]}`]);
      const dates = opts.start && opts.end ? ['-startdate', opts.start, '-enddate', opts.end] : ['-days', String(opts.days ?? 90)];
      run(['ca', '-batch', '-config', 'ca.cnf', '-cert', 'ca.crt', '-keyfile', 'ca.key', '-in', `${base}.csr`, '-out', `${base}.crt`, '-notext',
        '-extfile', `${base}.ext`, ...dates]);
      return { key: readFileSync(join(dir, `${base}.key`), 'utf8'), cert: readFileSync(join(dir, `${base}.crt`), 'utf8') };
    },
    done() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
