// Adressen aller Websites in einer Tabelle (site_addresses, Schritt V_SITE_ADDRESSES): Link-Seiten, Code-Seiten und
// Statusseiten. Der Primärschlüssel hält jede Adresse über alle Arten eindeutig – auch bei gleichzeitigen Anfragen.
// Wer eine Adresse belegt oder freigibt, tut das in DERSELBEN Transaktion wie die Zeile, die sie benutzt (db).
//
// Freigegebene Adressen bleiben reserviert (kind = 'held'): Link- und Code-Seiten 30 Tage, wenn sie mindestens 7 Tage
// benutzt wurden (sonst sofort frei – so lassen sich Adressen nicht durch Anlegen und Löschen horten), Statusseiten
// immer 90 Tage (Mails, Discord und /summary.json zeigen auf sie). Solange kann nur der frühere Besitzer die Adresse
// wieder nehmen; nach dem Löschen eines Kontos niemand.
//
// Sperrreihenfolge überall: users → pages → code_sites → status_pages → site_addresses, nie umgekehrt.
import { exec, one, q, value, type Db, type Row } from '../db.js';
import { date, intval, phpStr, strtotime, time } from '../php.js';

export type AddressKind = 'page' | 'code' | 'status';

// Wie lange eine freigegebene Adresse reserviert bleibt – je nach Art der Seite, die sie benutzt hat
export const HOLD_POLICY: Readonly<Record<AddressKind, { days: number; minUseDays: number }>> = {
  page: { days: 30, minUseDays: 7 },
  code: { days: 30, minUseDays: 7 },
  status: { days: 90, minUseDays: 0 },
};
export const ADDRESS_HOLD_DAYS = HOLD_POLICY.page.days;
export const ADDRESS_HOLD_MIN_DAYS = HOLD_POLICY.page.minUseDays;
// So viele abgelaufene Reservierungen räumt jede Freigabe nebenbei weg (kein Zeitgeber nötig)
const PRUNE_LIMIT = 50;

export interface AddressRow extends Row {
  slug: string;
  kind: string;
  ref_id: number | null;
  user_id: number | null;
  claimed_at: string;
  released_at: string | null;
  hold_until: string | null;
}

// Wem eine Adresse gehören darf: die eigene Seite (except…-IDs), eigene Reservierungen (userId) – zum Zeitpunkt now
export interface AddressExcept {
  pageId?: number | null;
  codeId?: number | null;
  statusId?: number | null;
  userId?: number | null;
  now: string;
}

// Die Adresse gehört schon einer anderen Seite oder ist für jemand anderen reserviert
export class AddressTakenError extends Error {
  constructor(readonly slug: string) {
    super(`the address ${slug} is already taken`);
  }
}

// Einzelne Abfragen über den Pool (innerhalb einer festen Verbindung laufen sie über diese, siehe db.ts)
const poolDb: Db = { q, one, value, exec };

const nowText = (): string => date('Y-m-d H:i:s');
const plusDays = (days: number): string => date('Y-m-d H:i:s', time() + days * 86400);
const idOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : intval(v));
const isKind = (k: string): k is AddressKind => k === 'page' || k === 'code' || k === 'status';

// Reservierung abgelaufen? (ohne Ende: nie – so etwas entsteht nur durch Handarbeit, sites:release hilft)
export function holdExpired(row: Pick<AddressRow, 'hold_until'>, now: string): boolean {
  return row.hold_until !== null && row.hold_until !== undefined && phpStr(row.hold_until) < now;
}

// Rein (Kern von slugProblem): versperrt diese Zeile die Adresse für den Aufrufer?
export function addressBlocks(row: Pick<AddressRow, 'kind' | 'ref_id' | 'user_id' | 'hold_until'>, mine: AddressExcept): boolean {
  const ref = idOrNull(row.ref_id);
  if (row.kind === 'held') {
    if (holdExpired(row, mine.now)) return false;
    const owner = idOrNull(row.user_id);
    return !(owner !== null && mine.userId !== null && mine.userId !== undefined && owner === mine.userId);
  }
  if (row.kind === 'page' && mine.pageId && ref === mine.pageId) return false;
  if (row.kind === 'code' && mine.codeId && ref === mine.codeId) return false;
  if (row.kind === 'status' && mine.statusId && ref === mine.statusId) return false;
  return true;
}

// Ist die Adresse laut Liste vergeben (oder für jemand anderen reserviert)?
export async function addressTaken(slug: string, mine: Omit<AddressExcept, 'now'>, db: Pick<Db, 'one'> = poolDb): Promise<boolean> {
  const row = await db.one<AddressRow>('SELECT kind, ref_id, user_id, hold_until FROM site_addresses WHERE slug = ?', [slug]);
  return row !== null && addressBlocks(row, { ...mine, now: nowText() });
}

// Adresse belegen. Zuerst einfügen: das braucht keine Sperre auf Lücken (zwei gleichzeitige Anmeldungen blockieren sich
// so nicht gegenseitig). Gibt es die Zeile schon, sperrt ON DUPLICATE KEY sie exklusiv (ein einfaches INSERT setzte
// nur eine geteilte Sperre, und zwei Anfragen würden sich beim Übernehmen verklemmen). Die eigene oder eine abgelaufene
// Reservierung wird übernommen; gehört die Adresse schon genau dieser Seite, ist nichts zu tun. Sonst AddressTakenError.
export async function claimAddress(db: Db, slug: string, kind: AddressKind, refId: number, userId: number | null): Promise<void> {
  const now = nowText();
  const res = await db.exec('INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE slug = slug',
    [slug, kind, refId, userId, now]);
  if (res.affectedRows === 1) return;
  const row = await db.one<AddressRow>('SELECT kind, ref_id, user_id, hold_until FROM site_addresses WHERE slug = ? FOR UPDATE', [slug]);
  if (!row) throw new AddressTakenError(slug);
  if (row.kind === kind && idOrNull(row.ref_id) === refId) return;
  const ownHold = userId !== null && idOrNull(row.user_id) === userId;
  if (row.kind === 'held' && (ownHold || holdExpired(row, now))) {
    await db.exec('UPDATE site_addresses SET kind = ?, ref_id = ?, user_id = ?, claimed_at = ?, released_at = NULL, hold_until = NULL WHERE slug = ?',
      [kind, refId, userId, now, slug]);
    return;
  }
  throw new AddressTakenError(slug);
}

// Freigabe nach der Regel der Art: lange genug benutzt → reserviert (für holdUser, null = niemand), sonst sofort frei
async function holdOrFree(db: Db, row: AddressRow, holdUser: number | null): Promise<void> {
  const policy = HOLD_POLICY[isKind(row.kind) ? row.kind : 'page'];
  const claimed = strtotime(phpStr(row.claimed_at));
  const usedSeconds = time() - (claimed === false ? 0 : claimed);
  if (usedSeconds < policy.minUseDays * 86400) {
    await db.exec('DELETE FROM site_addresses WHERE slug = ?', [row.slug]);
    return;
  }
  await db.exec("UPDATE site_addresses SET kind = 'held', ref_id = NULL, user_id = ?, released_at = ?, hold_until = ? WHERE slug = ?",
    [holdUser, nowText(), plusDays(policy.days), row.slug]);
}

// Adresse freigeben (Seite gelöscht, Adresse geändert …). userId: Besitzer laut Liste (null = Seite ohne Konto);
// holdFor 'nobody' (Konto oder Seite vom Team gelöscht): reserviert für niemanden. target: nur freigeben, wenn die
// Zeile genau diese Seite meint – bei alten Doppelungen gehört die Adresse vielleicht einer anderen Seite.
// Räumt nebenbei abgelaufene Reservierungen weg.
export async function releaseAddress(db: Db, slug: string, userId: number | null, holdFor: 'owner' | 'nobody' = 'owner',
  target?: { kind: AddressKind; refId: number }): Promise<void> {
  const row = await db.one<AddressRow>('SELECT * FROM site_addresses WHERE slug = ? FOR UPDATE', [slug]);
  const owner = row ? idOrNull(row.user_id) : null;
  if (row && row.kind !== 'held' && owner === userId && (!target || (row.kind === target.kind && idOrNull(row.ref_id) === target.refId))) {
    await holdOrFree(db, row, holdFor === 'owner' ? owner : null);
  }
  await pruneHolds(db);
}

// Konto gelöscht: jede Adresse des Kontos ist danach für niemanden reserviert (nach der Regel ihrer Art); schon
// bestehende Reservierungen verlieren den Bezug zur Person
export async function releaseUserAddresses(db: Db, userId: number): Promise<void> {
  const rows = await db.q<AddressRow>('SELECT * FROM site_addresses WHERE user_id = ? ORDER BY slug FOR UPDATE', [userId]);
  for (const row of rows) {
    if (row.kind === 'held') await db.exec('UPDATE site_addresses SET user_id = NULL WHERE slug = ?', [row.slug]);
    else await holdOrFree(db, row, null);
  }
  await pruneHolds(db);
}

// Abgelaufene Reservierungen entfernen (höchstens PRUNE_LIMIT). SKIP LOCKED: Zeilen, die eine andere Anfrage gerade
// übernimmt, bleiben liegen – das Aufräumen wartet nie und kann so keine Verklemmung auslösen.
export async function pruneHolds(db: Db): Promise<number> {
  const now = nowText();
  const expired = await db.q("SELECT slug FROM site_addresses WHERE kind = 'held' AND hold_until < ? ORDER BY hold_until LIMIT ? FOR UPDATE SKIP LOCKED",
    [now, PRUNE_LIMIT]);
  if (!expired.length) return 0;
  const slugs = expired.map((r) => phpStr(r.slug));
  const res = await db.exec(`DELETE FROM site_addresses WHERE slug IN (${slugs.map(() => '?').join(', ')}) AND kind = 'held'`, slugs);
  return res.affectedRows;
}

// Zeile der Liste (für Werkzeuge und Tests)
export const addressRow = (slug: string, db: Db = poolDb): Promise<AddressRow | null> =>
  db.one<AddressRow>('SELECT * FROM site_addresses WHERE slug = ?', [slug]);

// Name des Schlüssels eines ER_DUP_ENTRY („Duplicate entry 'x' for key 'uq_own'“ bei MariaDB, 'code_sites.uq_own' bei
// MySQL) – null bei jedem anderen Fehler
export function duplicateKey(err: unknown): string | null {
  const e = err as { code?: unknown; errno?: unknown; sqlMessage?: unknown; message?: unknown };
  if (!e || (e.code !== 'ER_DUP_ENTRY' && e.errno !== 1062)) return null;
  const m = /for key '([^']+)'/.exec(String(e.sqlMessage ?? e.message ?? ''));
  if (!m) return '';
  const name = m[1];
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
}

// Doppelte Adresse in einer der Tabellen, die eine Adresse halten (Liste, Link-Seiten, Code-Seiten)?
export const isTakenError = (err: unknown): boolean => err instanceof AddressTakenError || ['PRIMARY', 'uq_slug'].includes(duplicateKey(err) ?? '-');

// ---------------------------------------------------------------- Namensregeln für neue Adressen (D12)

// Marken aus blacklist.php (Gruppe der bekannten Marken): als ganzer Teil einer Adresse verboten. Teile entstehen an
// Bindestrichen und Ziffern.
const BRAND_TOKENS = ['google', 'gmail', 'googlemail', 'youtube', 'yt', 'android', 'apple', 'icloud', 'itunes', 'appstore',
  'microsoft', 'ms', 'office', 'office365', 'outlook', 'hotmail', 'live', 'amazon', 'aws', 'prime',
  'meta', 'facebook', 'instagram', 'whatsapp', 'messenger', 'twitter', 'x', 'tiktok', 'snapchat', 'reddit', 'pinterest',
  'linkedin', 'telegram', 'signal', 'discord', 'discordapp', 'twitch', 'spotify', 'netflix', 'paypal', 'stripe',
  'visa', 'mastercard', 'wise', 'skrill', 'binance', 'coinbase', 'kraken',
  'github', 'gitlab', 'bitbucket', 'cloudflare', 'docker', 'kubernetes', 'vercel', 'netlify', 'digitalocean', 'linode',
  'hetzner', 'shopify', 'salesforce', 'hubspot', 'zendesk', 'notion', 'dropbox', 'box', 'onedrive', 'gdrive', 'googledrive',
  'slack', 'zoom', 'teams', 'skype', 'steam', 'epicgames', 'riotgames', 'openai', 'chatgpt'];
// Unverwechselbare Marken (ab 6 Buchstaben, keine gewöhnlichen Wörter): verboten, sobald die zusammengezogenen Buchstaben
// sie enthalten („pay-pal-status“). Kurze oder wortähnliche Marken (x, ms, live, box, signal, stripe, office, android,
// telegram, docker …) zählen nur als ganzer Teil – sonst träfe es „items-status“ (ms) oder „delivery-status“ (live).
// Drei Muster lassen gewöhnliche Adressen aus, die die Marke nur zufällig enthalten: „open-air“, „digit-lab“, „big-drive“.
const BRAND_CONTAINS = ['google', 'youtube', 'icloud', 'itunes', 'microsoft', 'hotmail', 'amazon', 'facebook', 'instagram', 'whatsapp', 'twitter',
  'tiktok', 'snapchat', 'reddit', 'pinterest', 'linkedin', 'discord', 'spotify', 'netflix', 'paypal', 'mastercard', 'skrill', 'binance',
  'coinbase', 'github', 'bitbucket', 'cloudflare', 'kubernetes', 'vercel', 'netlify', 'digitalocean', 'linode', 'hetzner', 'shopify',
  'salesforce', 'hubspot', 'zendesk', 'dropbox', 'onedrive', 'epicgames', 'riotgames', 'chatgpt', 'openai(?!r)', '(?<!di)gitlab', '(?<!bi)gdrive'];

// Gleiche Buchstaben hintereinander zu einem (blacklist_squash_repeats)
const squash = (s: string): string => s.replace(/(.)\1+/g, '$1');
const BRAND_TOKENS_SQ = new Set(BRAND_TOKENS.map(squash));
// Je Marke ein Muster für die Buchstaben und eines für die Buchstaben ohne Doppelte („ggoogle“ → „gogle“)
const BRAND_CONTAINS_RE = BRAND_CONTAINS.map((b) => [new RegExp(b), new RegExp(/^[a-z]+$/.test(b) ? squash(b) : b)] as const);

// Ziffern und Zeichen als Buchstaben (wie blacklist.php), dazu 1 auch als l („paypa1“)
const LEET_I: Readonly<Record<string, string>> = { 0: 'o', 1: 'i', 2: 'z', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g' };
const LEET_L: Readonly<Record<string, string>> = { ...LEET_I, 1: 'l' };

// Schreibweisen einer Adresse, die geprüft werden: wie eingegeben, mit Ziffern als Buchstaben, jeweils auch ohne
// doppelte Buchstaben
function nameVariants(slug: string): string[] {
  const base = slug.toLowerCase();
  const leet = (map: Readonly<Record<string, string>>) => base.replace(/[0-9]/g, (d) => map[d] ?? d);
  const out = new Set<string>();
  for (const v of [base, leet(LEET_I), leet(LEET_L)]) {
    out.add(v);
    out.add(squash(v));
  }
  return [...out];
}

// Teile (an allem außer Buchstaben getrennt) und zusammengezogene Buchstaben einer Schreibweise
const tokensOf = (v: string): string[] => v.split(/[^a-z]+/).filter((t) => t !== '');
const lettersOf = (v: string): string => v.replace(/[^a-z]/g, '');

// Der Name von OnYourSite: zusammengezogen „onyoursite“ oder ein Teil „oys“
function usesOurName(slug: string): boolean {
  return nameVariants(slug).some((v) => lettersOf(v).includes('onyoursite') || tokensOf(v).includes('oys'));
}

// Eine bekannte Marke: als ganzer Teil oder – bei unverwechselbaren Marken – irgendwo in den Buchstaben
function usesBrand(slug: string): boolean {
  return nameVariants(slug).some((v) => {
    const letters = lettersOf(v);
    if (tokensOf(v).some((t) => BRAND_TOKENS_SQ.has(squash(t)))) return true;
    const squashed = squash(letters);
    return BRAND_CONTAINS_RE.some(([re, reSq]) => re.test(letters) || reSq.test(squashed));
  });
}

// Rein: Meldung, wenn eine NEUE Adresse dieser Art den Namen von OnYourSite oder (Code- und Statusseiten) eine Marke
// benutzt – sonst null. Bestehende Adressen bleiben; sites:repair listet sie.
export function addressNameProblem(slug: string, kind: AddressKind): string | null {
  if (usesOurName(slug)) return `The address “${slug}” can’t use the OnYourSite name.`;
  if (kind !== 'page' && usesBrand(slug)) {
    return `The address “${slug}” contains a brand name. ` + (kind === 'code' ? 'Code pages' : 'Status pages') + ' can’t use brand names in their address.';
  }
  return null;
}

// ---------------------------------------------------------------- Abgleich mit den Tabellen (sites:repair)

export interface RepairReport {
  added: string[];
  claimed: string[];
  held: string[];
  anomalies: string[];
}

interface LiveSite {
  kind: AddressKind;
  id: number;
  userId: number | null;
  slug: string;
  since: string;
}

const describe = (kind: string): string => (kind === 'page' ? 'link page' : kind === 'code' ? 'code page' : kind === 'status' ? 'status page' : kind);

// Liste und Tabellen abgleichen (nach Handarbeit in der Datenbank oder einer zurückgespielten Sicherung): fehlende
// Zeilen eintragen, Zeilen ohne passende Seite zu Reservierungen für den Besitzer machen, nie eine Statusseiten-Adresse
// oder eine fremde Reservierung an eine andere Seite geben, und alles Auffällige melden (auch Adressen, die gegen die
// Namensregeln verstoßen). Läuft in EINER Transaktion; mehrfach aufrufbar.
export async function repairAddresses(db: Db): Promise<RepairReport> {
  const report: RepairReport = { added: [], claimed: [], held: [], anomalies: [] };
  const now = nowText();
  const hasStatus = (await db.q("SHOW TABLES LIKE 'status\\_pages'")).length > 0;
  const live: LiveSite[] = [];
  for (const p of await db.q('SELECT id, user_id, slug, COALESCE(slug_changed_at, created_at) AS since FROM pages ORDER BY id')) {
    live.push({ kind: 'page', id: intval(p.id), userId: idOrNull(p.user_id), slug: phpStr(p.slug), since: phpStr(p.since ?? '') });
  }
  for (const s of await db.q("SELECT id, user_id, slug, created_at AS since FROM code_sites WHERE slug IS NOT NULL AND slug <> '' ORDER BY id")) {
    live.push({ kind: 'code', id: intval(s.id), userId: idOrNull(s.user_id), slug: phpStr(s.slug), since: phpStr(s.since ?? '') });
  }
  if (hasStatus) {
    for (const s of await db.q("SELECT id, user_id, slug FROM status_pages WHERE slug IS NOT NULL AND slug <> '' ORDER BY id")) {
      live.push({ kind: 'status', id: intval(s.id), userId: idOrNull(s.user_id), slug: phpStr(s.slug), since: '' });
    }
  }
  const rows = new Map<string, AddressRow>();
  for (const r of await db.q<AddressRow>('SELECT * FROM site_addresses ORDER BY slug FOR UPDATE')) rows.set(phpStr(r.slug).toLowerCase(), r);
  // Welche Seite unter welcher Adresse wirklich besteht (Art:ID:Adresse)
  const exists = new Set(live.map((s) => `${s.kind}:${s.id}:${s.slug.toLowerCase()}`));

  // 1. Jede Seite braucht ihre Zeile
  const owners = new Map<string, LiveSite>();
  for (const site of live) {
    const key = site.slug.toLowerCase();
    const label = `${describe(site.kind)} #${site.id} (${site.slug})`;
    const named = addressNameProblem(site.slug, site.kind);
    if (named !== null && !(site.kind === 'status' && site.userId === null)) report.anomalies.push(`Name rule: ${label} – ${named}`);
    const first = owners.get(key);
    if (first) {
      report.anomalies.push(`Collision: ${label} has the same address as ${describe(first.kind)} #${first.id}` + (first.kind === 'page' && site.kind === 'code' ? ' (hidden by the link page)' : ''));
      continue;
    }
    owners.set(key, site);
    const row = rows.get(key);
    if (!row) {
      await db.exec('INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES (?, ?, ?, ?, ?)',
        [site.slug, site.kind, site.id, site.userId, site.since !== '' ? site.since : now]);
      rows.set(key, { slug: site.slug, kind: site.kind, ref_id: site.id, user_id: site.userId, claimed_at: now, released_at: null, hold_until: null });
      report.added.push(`${label}`);
      continue;
    }
    if (row.kind === site.kind && idOrNull(row.ref_id) === site.id) {
      if (idOrNull(row.user_id) !== site.userId) {
        await db.exec('UPDATE site_addresses SET user_id = ? WHERE slug = ?', [site.userId, row.slug]);
        report.claimed.push(`${label}: owner corrected`);
      }
      continue;
    }
    if (row.kind === 'held' && (holdExpired(row, now) || (site.userId !== null && idOrNull(row.user_id) === site.userId))) {
      // Die eigene (oder eine abgelaufene) Reservierung: die Seite ist dort ohnehin zu sehen
      await db.exec('UPDATE site_addresses SET kind = ?, ref_id = ?, user_id = ?, claimed_at = ?, released_at = NULL, hold_until = NULL WHERE slug = ?',
        [site.kind, site.id, site.userId, now, row.slug]);
      rows.set(key, { ...row, kind: site.kind, ref_id: site.id, user_id: site.userId, hold_until: null });
      report.claimed.push(`${label}: took back its own reservation`);
      continue;
    }
    if (row.kind === 'held') {
      report.anomalies.push(`Reserved: ${label} uses an address that is reserved for `
        + (row.user_id === null ? 'nobody' : `user #${intval(row.user_id)}`) + ` until ${phpStr(row.hold_until ?? '?')}`);
    } else {
      report.anomalies.push(`Collision: ${label} uses the address of ${describe(row.kind)} #${intval(row.ref_id)}`);
    }
  }

  // 2. Zeilen, deren Seite es nicht mehr gibt (oder die jetzt anders heißt): reserviert für den Besitzer
  for (const [key, row] of rows) {
    if (row.kind === 'held' || !isKind(row.kind)) {
      if (row.kind !== 'held') report.anomalies.push(`Unknown kind: ${row.slug} (${row.kind})`);
      continue;
    }
    if (row.kind === 'status' && !hasStatus) continue;
    if (exists.has(`${row.kind}:${idOrNull(row.ref_id)}:${key}`)) continue;
    const policy = HOLD_POLICY[row.kind];
    await db.exec("UPDATE site_addresses SET kind = 'held', ref_id = NULL, released_at = ?, hold_until = ? WHERE slug = ?",
      [now, plusDays(policy.days), row.slug]);
    report.held.push(`${row.slug} (${describe(row.kind)} #${intval(row.ref_id)}) is reserved for `
      + (row.user_id === null ? 'nobody' : `user #${intval(row.user_id)}`) + ` for ${policy.days} days`);
  }
  return report;
}

// Reservierung vorzeitig beenden (sites:release, z. B. nach einer Anfrage beim Support). Nur Reservierungen.
export async function endHold(db: Db, slug: string): Promise<boolean> {
  const res = await db.exec("DELETE FROM site_addresses WHERE slug = ? AND kind = 'held'", [slug]);
  return res.affectedRows === 1;
}

// Für Werkzeuge: Zeilen des Kontos (Reihenfolge der Adresse)
export const userAddresses = (userId: number, db: Db = poolDb): Promise<Row[]> =>
  db.q('SELECT * FROM site_addresses WHERE user_id = ? ORDER BY slug', [userId]);
