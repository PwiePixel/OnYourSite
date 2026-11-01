// Upload-Ordner (lib/storage.php). Standard: static/uploads im Code-Ordner. Mit uploads_dir in den Einstellungen
// liegt er außerhalb des Codes (übersteht Updates); die Adressen bleiben /static/uploads/…
import { realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Ctx } from '../web/ctx.js';
import { ROOT_DIR, configString } from '../config.js';
import { phpTrim, phpRtrim, strlen } from '../php.js';
import { notPorted } from '../web/notPorted.js';

// oys_uploads_default_dir()
export const uploadsDefaultDir = (): string => ROOT_DIR + '/static/uploads';

// oys_uploads_dir(): relative Angaben gelten ab dem Code-Ordner (z. B. "../oys-uploads")
export function uploadsDir(): string {
  const set = phpTrim(configString('uploads_dir', ''));
  if (set === '') return uploadsDefaultDir();
  const absolute = set[0] === '/' || /^[A-Za-z]:[\\/]/.test(set);
  return phpRtrim(absolute ? set : ROOT_DIR + '/' + set, '/\\');
}

const real = (p: string): string | false => {
  try {
    return realpathSync(p);
  } catch {
    return false;
  }
};

// oys_uploads_external(): liegt der Ordner außerhalb des Codes?
export function uploadsExternal(): boolean {
  const a = real(uploadsDir());
  const b = real(uploadsDefaultDir());
  return (a !== false ? a : uploadsDir()) !== (b !== false ? b : uploadsDefaultDir());
}

// oys_uploads_suggested_dir(): Vorschlag neben dem Code-Ordner
export const uploadsSuggestedDir = (): string => dirname(ROOT_DIR) + '/oys-uploads';

// oys_upload_path()
export const uploadPath = (name: string): string => uploadsDir() + '/' + name;

export const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// oys_upload_read_path(): nach dem Umzug liegen manche Dateien evtl. noch im alten Ordner
export function uploadReadPath(name: string): string {
  const path = uploadPath(name);
  if (!isFile(path) && uploadsExternal() && isFile(uploadsDefaultDir() + '/' + name)) return uploadsDefaultDir() + '/' + name;
  return path;
}

// oys_upload_name_ok(): nur einfache Namen, keine Ordner, nichts Verstecktes
export function uploadNameOk(name: string): boolean {
  return name !== '' && strlen(name) <= 200 && !name.includes('/') && !name.includes('\\') && name[0] !== '.' && !name.includes('\0') && !name.includes('..');
}

// /static/uploads/{name} ausliefern, wenn der Ordner nicht im Web-Ordner liegt (oys_serve_upload)
export async function serveUpload(ctx: Ctx, _name: string): Promise<void> {
  notPorted(ctx, 'uploads');
}
