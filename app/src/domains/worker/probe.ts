// Ende-zu-Ende-Prüfung über die Cloudflare-Kante: GET https://<domain>/_/domain-check, verbunden mit einer Adresse
// UNSERES CNAME-Ziels (nie mit einer Adresse aus dem DNS des Nutzers), SNI und Host = die Domain, Zertifikat gegen die
// Domain geprüft (Node-Standard). 8 s, keine Weiterleitungen, höchstens 256 Bytes gelesen. Beweist „unser Hostname,
// Zertifikat und Weg funktionieren“ – ob das DNS des Nutzers auf uns zeigt, prüft dns.ts.
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { config, configString } from '../../config.js';
import { date } from '../../php.js';

export interface ProbeOutcome {
  result: 'ok' | 'wrong' | 'unknown';
  reason: string; // kurz, für Verlauf und Admin (z. B. cert_invalid, not_ours, timeout, http_502)
  certValidTo: string | null; // Ablauf des Zertifikats ('Y-m-d H:i:s', Zeitzone der Seite)
}

export interface ProbeOptions {
  hostname: string; // SNI und Host
  ips: string[]; // Adressen der Kante (höchstens zwei werden versucht)
  port: number;
  expected: string; // erwartete Antwort (probeAnswer)
  ca?: Buffer;
  timeoutMs?: number;
}

export const PROBE_UA = 'OnYourSite-Domains/1.0';

// Prüf-Einstellungen aus der Konfiguration (nur Tests ändern Port und Zertifizierungsstelle)
export function probeConfig(): { port: number; ca?: Buffer } {
  const port = Number(configString('custom_domains.probe_port', '443')) || 443;
  const caFile = configString('custom_domains.probe_ca');
  let ca: Buffer | undefined;
  if (caFile !== '') {
    try {
      ca = readFileSync(caFile);
    } catch {
      ca = undefined;
    }
  }
  return { port, ca };
}

// Feste Adressen der Kante (nur Tests: dann wird das CNAME-Ziel nicht aufgelöst)
export function configuredEdgeIps(): string[] {
  const v = config<unknown>('custom_domains.edge_ips', null);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && isIP(x) !== 0) : [];
}

const DEFINITE_TLS = new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'CERT_UNTRUSTED', 'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE']);

// Fehler der Verbindung → eindeutig falsch (Zertifikat passt nicht, keins für diesen Namen) oder unbekannt (Netz)
export function classifyError(err: unknown): ProbeOutcome {
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e?.code === 'string' ? e.code : '';
  const msg = typeof e?.message === 'string' ? e.message : '';
  if (code === 'CERT_HAS_EXPIRED') return { result: 'wrong', reason: 'cert_expired', certValidTo: null };
  if (DEFINITE_TLS.has(code)) return { result: 'wrong', reason: 'cert_invalid', certValidTo: null };
  // \x20 statt des Leerzeichens: sonst sähe die Dialog-Prüfung (tools/check-native-dialogs.mjs) hier ein Browser-Popup
  if (/ALERT_(HANDSHAKE_FAILURE|UNRECOGNIZED_NAME|INTERNAL_ERROR)/.test(code) || /alert\x20(handshake failure|unrecognized name|internal error)/i.test(msg)) {
    return { result: 'wrong', reason: 'no_certificate', certValidTo: null };
  }
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) return { result: 'unknown', reason: 'timeout', certValidTo: null };
  return { result: 'unknown', reason: code !== '' ? code.toLowerCase() : 'network', certValidTo: null };
}

// Antwort → ok, falsch oder unbekannt (5xx, 429 und jede Antwort mit cf-mitigated zählen nie)
export function classifyResponse(status: number, mitigated: boolean, body: string, expected: string): ProbeOutcome {
  if (mitigated) return { result: 'unknown', reason: 'challenge', certValidTo: null };
  if (status >= 500 || status === 429) return { result: 'unknown', reason: 'http_' + status, certValidTo: null };
  if (status === 200 && body.trim() === expected) return { result: 'ok', reason: '', certValidTo: null };
  return { result: 'wrong', reason: 'not_ours_' + status, certValidTo: null };
}

function once(hostname: string, ip: string, o: ProbeOptions): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let finished = false;
    let certValidTo: string | null = null;
    const finish = (r: ProbeOutcome): void => {
      if (finished) return;
      finished = true;
      resolve({ ...r, certValidTo: r.certValidTo ?? certValidTo });
    };
    const req = https.request({
      host: ip, port: o.port, path: '/_/domain-check', method: 'GET', servername: hostname, agent: false, rejectUnauthorized: true,
      ...(o.ca ? { ca: o.ca } : {}), headers: { Host: hostname, 'User-Agent': PROBE_UA, Accept: 'text/plain' }, timeout: o.timeoutMs ?? 8000,
    });
    req.on('socket', (sock) => {
      sock.once('secureConnect', () => {
        const cert = (sock as TLSSocket).getPeerCertificate?.();
        const t = cert && typeof cert.valid_to === 'string' ? Date.parse(cert.valid_to) : NaN;
        if (!Number.isNaN(t)) certValidTo = date('Y-m-d H:i:s', Math.floor(t / 1000));
      });
    });
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      const mitigated = res.headers['cf-mitigated'] !== undefined;
      let body = Buffer.alloc(0);
      const done = (): void => finish(classifyResponse(status, mitigated, body.subarray(0, 256).toString('utf8'), o.expected));
      res.on('data', (chunk: Buffer) => {
        body = Buffer.concat([body, chunk]);
        if (body.length > 256) {
          res.destroy();
          done();
        }
      });
      res.on('end', done);
      res.on('close', done);
      res.on('error', done);
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ result: 'unknown', reason: 'timeout', certValidTo: null });
    });
    req.on('error', (err) => finish(classifyError(err)));
    req.end();
  });
}

// Bis zu zwei Adressen der Kante (v4 und v6): eine eindeutige Antwort zählt, sonst „unbekannt“
export async function probeHost(o: ProbeOptions): Promise<ProbeOutcome> {
  // Nie eine IP-Adresse als Name (dann würde ohne Namensauflösung direkt dorthin verbunden)
  if (isIP(o.hostname) !== 0 || !/^[a-z0-9.-]+$/.test(o.hostname)) return { result: 'unknown', reason: 'invalid_name', certValidTo: null };
  if (!o.ips.length) return { result: 'unknown', reason: 'no_edge', certValidTo: null };
  let last: ProbeOutcome = { result: 'unknown', reason: 'no_edge', certValidTo: null };
  for (const ip of o.ips.slice(0, 2)) {
    last = await once(o.hostname, ip, o);
    if (last.result !== 'unknown') return last;
  }
  return last;
}
