// Admin: Speicherort der Uploads und Backups (views/admin_storage.php, eingebunden in views/admin.php). Gibt genau das
// aus, was das require ausgibt (ohne die 12 Leerzeichen, die admin.php selbst davor schreibt). Der Text außerhalb der
// PHP-Teile ist Byte für Byte übernommen (view2ts).
import { e } from '../../html.js';
import { phpFloatToString } from '../../php.js';
import { phpRound } from '../../content/phpMath.js';
import { storageFiles, uploadsDefaultDir, uploadsDir, uploadsExternal, uploadsSuggestedDir } from '../../content/storage.js';

export interface AdminStorageData {
  uploadsDir: string;
  external: boolean;
  // Name → Bytes (oys_storage_files)
  files: Map<string, number>;
  leftInCode: number;
  suggested: string;
  // oys_csrf_field()
  csrfField: string;
}

// Daten wie am Anfang von admin_storage.php
export function adminStorageData(csrfField: string): AdminStorageData {
  const external = uploadsExternal();
  return {
    uploadsDir: uploadsDir(),
    external,
    files: storageFiles(),
    leftInCode: external ? storageFiles(uploadsDefaultDir()).size : 0,
    suggested: uploadsSuggestedDir(),
    csrfField,
  };
}

// $fmtSize: round() gibt in PHP eine Kommazahl zurück, die als Text ohne ".0" erscheint (2.0 → "2")
export function fmtSize(b: number): string {
  if (b >= 1073741824) return phpFloatToString(phpRound(b / 1073741824, 2)) + ' GB';
  if (b >= 1048576) return phpFloatToString(phpRound(b / 1048576, 1)) + ' MB';
  return phpFloatToString(phpRound(b / 1024)) + ' KB';
}

export function adminStorageView(d: AdminStorageData): string {
  let o = '';
  const count = d.files.size;
  let bytes = 0;
  for (const size of d.files.values()) bytes += size;
  o += "            <div id=\"tab-storage\" class=\"admin-tab-content max-w-4xl mx-auto space-y-8 hidden\">\n                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6\">\n                    <div class=\"flex items-center gap-3 mb-5 border-b border-bordercolor pb-4\">\n                        <i class='bx bx-hdd text-2xl text-teal-400'></i>\n                        <h2 class=\"text-base font-semibold text-white\">Upload folder</h2>\n                    </div>\n                    <p class=\"text-sm text-gray-400 mb-4\">Everything your users upload – profile pictures, backgrounds, gallery images, music and files – is stored in this folder:</p>\n                    <div class=\"flex flex-col sm:flex-row sm:items-center gap-3 bg-inputbg border border-bordercolor rounded-lg px-4 py-3\">\n                        <code class=\"text-sm text-white break-all flex-1\" id=\"uploadsDir\">";
  o += e(d.uploadsDir);
  o += "</code>\n                        ";
  if (d.external) {
    o += "                        <span class=\"shrink-0 text-[11px] font-bold uppercase px-2 py-1 rounded bg-emerald-500/15 text-emerald-400 flex items-center gap-1\"><i class='bx bx-check-shield'></i> Outside the code – safe from updates</span>\n                        ";
  } else {
    o += "                        <span class=\"shrink-0 text-[11px] font-bold uppercase px-2 py-1 rounded bg-amber-500/15 text-amber-400 flex items-center gap-1\"><i class='bx bx-error'></i> Inside the code folder</span>\n                        ";
  }
  o += "                    </div>\n                    <p class=\"text-sm text-gray-400 mt-3\">";
  o += String(count);
  o += " file";
  o += count === 1 ? '' : 's';
  o += " · ";
  o += e(fmtSize(bytes));
  o += "</p>\n\n                    ";
  if (!d.external) {
    o += "                    <div class=\"mt-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-gray-300 space-y-2\">\n                        <p class=\"font-semibold text-amber-300 flex items-center gap-2\"><i class='bx bx-bulb'></i> Keep uploads safe when you update the code</p>\n                        <p>Right now the uploads live inside the code folder. If you ever replace that folder (copying in a new version or restoring a code backup), the uploads go with it. Move them next to the code instead:</p>\n                        <ol class=\"list-decimal pl-5 space-y-1\">\n                            <li>Add this line to <code>config.json</code> and restart the website (<code>sudo systemctl restart onyoursite-web</code>): <code class=\"text-white break-all\">&quot;uploads_dir&quot;: ";
    o += e(JSON.stringify(d.suggested));
    o += ",</code></li>\n                            <li>Come back here and click <b>Move files</b> – all existing uploads are moved there once. Addresses of images don’t change. (If this page still shows the old folder, the website hasn’t been restarted yet.)</li>\n                        </ol>\n                    </div>\n                    ";
  } else if (d.leftInCode > 0) {
    o += "                    <form action=\"/admin\" method=\"POST\" class=\"mt-6 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4 text-sm text-gray-300 flex flex-col sm:flex-row sm:items-center gap-3\">\n                        ";
    o += d.csrfField;
    o += "<input type=\"hidden\" name=\"storage_action\" value=\"move\">\n                        <p class=\"flex-1\"><b class=\"text-white\">";
    o += String(d.leftInCode);
    o += " file";
    o += d.leftInCode === 1 ? '' : 's';
    o += "</b> are still in <code>static/uploads/</code> inside the code. Move them to the new folder once.</p>\n                        <button type=\"submit\" class=\"bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-5 rounded-lg transition-all flex items-center justify-center gap-2 shrink-0\"><i class='bx bx-transfer'></i> Move files</button>\n                    </form>\n                    ";
  }
  o += "                </div>\n\n                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6\">\n                    <div class=\"flex items-center gap-3 mb-5 border-b border-bordercolor pb-4\">\n                        <i class='bx bx-archive-in text-2xl text-teal-400'></i>\n                        <h2 class=\"text-base font-semibold text-white\">Backups</h2>\n                    </div>\n                    <p class=\"text-sm text-gray-400 mb-4\">For a complete backup, save these four things. When you restore one, put them back the same way – nobody has to upload anything again.</p>\n                    <ul class=\"space-y-2 text-sm text-gray-300 mb-6\">\n                        <li class=\"flex gap-2\"><i class='bx bx-data text-lg text-teal-400 shrink-0'></i><span><b class=\"text-white\">The database</b> – on your own server (set up with <code>server/install.sh</code>) it’s saved every night together with the other three to <code>/var/backups/onyoursite</code>; otherwise export a dump, e.g. with <code>mysqldump</code>.</span></li>\n                        <li class=\"flex gap-2\"><i class='bx bx-images text-lg text-teal-400 shrink-0'></i><span><b class=\"text-white\">The upload folder</b> above – or simply download it here as a ZIP.</span></li>\n                        <li class=\"flex gap-2\"><i class='bx bx-key text-lg text-teal-400 shrink-0'></i><span><b class=\"text-white\">config.json</b> – your database password and the encryption key (without the key, encrypted data can’t be read).</span></li>\n                        <li class=\"flex gap-2\"><i class='bx bx-envelope text-lg text-teal-400 shrink-0'></i><span><b class=\"text-white\">The folder email/</b> – mail server settings and newsletter templates.</span></li>\n                    </ul>\n                    <form action=\"/admin\" method=\"POST\" class=\"m-0\">\n                        ";
  o += d.csrfField;
  o += "<input type=\"hidden\" name=\"storage_action\" value=\"zip\">\n                        <button type=\"submit\" class=\"bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2\"";
  o += count > 0 ? '' : ' disabled';
  o += "><i class='bx bx-download'></i> Download all uploads (ZIP)</button>\n                    </form>\n                    <p class=\"text-xs text-gray-500 mt-3\">To restore: unpack the ZIP and copy the files from its “uploads” folder into the upload folder above.</p>\n                </div>\n            </div>\n";
  return o;
}
