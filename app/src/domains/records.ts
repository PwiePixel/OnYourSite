// Eigene Domains: Zusatz-Einträge von Cloudflare (custom_domains.extra_records, Schritt V_DOMAIN_RECORDS).
// Apex-Domains brauchen oft mehr als TXT + CNAME: den Besitz-TXT „_cf-custom-hostname.…“ und für das Zertifikat einen
// DCV-TXT oder den delegierten „_acme-challenge“-CNAME. Der Domain-Dienst liest sie aus der Antwort von Cloudflare und
// speichert sie geprüft (nur Hostnamen-Zeichen im Namen, nur druckbares ASCII im Wert, höchstens 6 Einträge) – der
// Editor zeigt sie unverändert an.
import type { CfHostname, CfValidationRecord } from './worker/cloudflare.js';

export interface ExtraRecord {
  type: 'TXT' | 'CNAME';
  name: string; // voller Name, klein, ohne Punkt am Ende
  value: string;
}

export const EXTRA_MAX = 6;
const NAME = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9])?$/;
const VALUE = /^[\x21-\x7e](?:[\x20-\x7e]{0,253}[\x21-\x7e])?$/;

// Ein Eintrag nur, wenn Name und Wert gültig sind (sonst weggelassen – nie roh weitergereicht)
function clean(type: ExtraRecord['type'], name: unknown, value: unknown): ExtraRecord | null {
  if (typeof name !== 'string' || typeof value !== 'string') return null;
  const n = name.trim().toLowerCase().replace(/\.$/, '');
  let v = value.trim();
  if (type === 'CNAME') v = v.toLowerCase().replace(/\.$/, '');
  if (!NAME.test(n) || !VALUE.test(v)) return null;
  if (type === 'CNAME' && !NAME.test(v)) return null;
  return { type, name: n, value: v };
}

function fromValidation(r: CfValidationRecord | undefined): ExtraRecord[] {
  if (!r || typeof r !== 'object') return [];
  const out: ExtraRecord[] = [];
  const txt = clean('TXT', r.txt_name, r.txt_value);
  if (txt) out.push(txt);
  const cname = clean('CNAME', r.cname, r.cname_target);
  if (cname) out.push(cname);
  return out;
}

// Nötige Zusatz-Einträge aus der Antwort von Cloudflare: der Besitz-TXT, solange der Hostname nicht aktiv ist; DCV-
// Einträge, solange das Zertifikat nicht aktiv ist; delegierte DCV-Einträge immer (sie müssen stehen bleiben)
export function extraRecordsFrom(host: CfHostname | null | undefined): ExtraRecord[] {
  if (!host || typeof host !== 'object') return [];
  const out: ExtraRecord[] = [];
  const own = host.ownership_verification;
  if (host.status !== 'active' && own && typeof own === 'object' && String(own.type ?? 'txt').toLowerCase() === 'txt') {
    const r = clean('TXT', own.name, own.value);
    if (r) out.push(r);
  }
  const ssl = host.ssl;
  if (ssl && typeof ssl === 'object') {
    if (ssl.status !== 'active' && Array.isArray(ssl.validation_records)) for (const v of ssl.validation_records) out.push(...fromValidation(v));
    if (Array.isArray(ssl.dcv_delegation_records)) for (const v of ssl.dcv_delegation_records) out.push(...fromValidation(v));
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    const key = `${r.type}|${r.name}|${r.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, EXTRA_MAX);
}

// Für die Spalte: leere Liste = NULL
export function encodeExtraRecords(list: ExtraRecord[]): string | null {
  return list.length ? JSON.stringify(list.slice(0, EXTRA_MAX)) : null;
}

// Aus der Spalte (kaputt oder fremd geschrieben → nur die gültigen Einträge)
export function decodeExtraRecords(raw: unknown): ExtraRecord[] {
  if (typeof raw !== 'string' || raw === '') return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: ExtraRecord[] = [];
  for (const e of v) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const type = o.type === 'CNAME' ? 'CNAME' : o.type === 'TXT' ? 'TXT' : null;
    if (!type) continue;
    const r = clean(type, o.name, o.value);
    if (r) out.push(r);
  }
  return out.slice(0, EXTRA_MAX);
}
