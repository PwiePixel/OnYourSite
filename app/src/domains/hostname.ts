// Eigene Domains: Eingabe prüfen und in die gespeicherte Form bringen (klein, ASCII/Punycode), Wurzeldomain schätzen,
// Anzeige in Unicode und die relativen „Host“-Felder der DNS-Einträge. Rein – ohne Datenbank und ohne Netz.
// Domains laufen bewusst NICHT durch den Wortfilter der Adressen (something.com, grapes.io …): eine Domain ist der
// eigene Name des Nutzers, geprüft wird wie bisher der Inhalt der Seite.
import { domainToASCII, domainToUnicode } from 'node:url';
import { phpTrim } from '../php.js';

export const HOSTNAME_MAX = 253;
// Höchstens so viele Teile (a.b.c.d …) – mehr braucht keine echte Adresse einer Profilseite
export const LABELS_MAX = 10;
// Name des TXT-Eintrags für den Besitznachweis: _onyoursite.<domain>
export const TXT_PREFIX = '_onyoursite.';

// Ein Teil: a–z, 0–9, Bindestrich nicht am Rand, höchstens 63 Zeichen (kein Unterstrich, kein Stern)
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Endungen, unter denen niemand eine echte Domain besitzt (lokal, intern, Beispiele, Tor …)
const RESERVED_TLDS = new Set(['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'test',
  'example', 'invalid', 'onion', 'arpa', 'alt']);

// Häufige zweiteilige Endungen für die Schätzung „Wurzeldomain“ (bewusst ohne Public-Suffix-Liste: der Domain-Dienst
// bestätigt die Zone später aus dem DNS, eine falsche Schätzung betrifft nur die Rückfrage im Editor)
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'net.nz', 'org.nz',
  'com.br', 'net.br', 'org.br', 'co.jp', 'ne.jp', 'or.jp',
  'co.za', 'co.in', 'net.in', 'org.in', 'com.mx', 'com.ar', 'com.tr', 'com.cn', 'com.hk', 'com.sg', 'co.kr', 'co.il', 'com.tw',
]);

export type HostnameProblem = 'empty' | 'invalid' | 'wildcard' | 'base';
export type HostnameResult = { ok: true; ascii: string; unicode: string } | { ok: false; problem: HostnameProblem; error: string };

// Fehlertexte für den Editor (base = Domain der Seite ohne Port, z. B. on-your.site)
export function hostnameError(problem: HostnameProblem, base: string): string {
  switch (problem) {
    case 'empty':
      return 'Please enter a domain, e.g. links.yourname.com.';
    case 'wildcard':
      return 'Wildcard domains aren’t supported.';
    case 'base':
      return `Addresses on ${base} can’t be used as a custom domain – choose them under Address above.`;
    default:
      return 'That doesn’t look like a valid domain.';
  }
}

const fail = (problem: HostnameProblem, base: string): HostnameResult => ({ ok: false, problem, error: hostnameError(problem, base) });

// Eingabe → gespeicherte Form. Eine eingefügte Adresse (https://Links.Example.com/pfad?x) wird auf den Namen gekürzt:
// Schema, Pfad, Abfrage und Port werden entfernt (nicht übernommen), ein Punkt am Ende ebenso. base = Domain der Seite.
export function normalizeHostname(input: unknown, base: string): HostnameResult {
  // Leerraum am Rand auch in Unicode – eingefügte Werte enthalten oft geschützte oder unsichtbare Leerzeichen
  let s = phpTrim(typeof input === 'string' ? input : '').replace(/^[\s​﻿]+|[\s​﻿]+$/gu, '');
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/\//, '');
  s = s.split(/[/?#\\]/)[0];
  if (s === '') return fail('empty', base);
  if (s.includes('*')) return fail('wildcard', base);
  // Zugangsdaten (user@host) und IPv6-Adressen ([::1]) sind nie ein Name
  if (s.includes('@') || s.includes('[')) return fail('invalid', base);
  s = s.replace(/:\d*$/, '');
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s === '') return fail('empty', base);
  if (s.length > HOSTNAME_MAX * 4) return fail('invalid', base);

  // IDN → Punycode (UTS 46: klein, Breitzeichen und Punkt-Varianten werden zu ASCII), ungültige Namen → ''
  const ascii = domainToASCII(s);
  if (ascii === '') return fail('invalid', base);
  // Die Domain der Seite und alles darunter wählt man unter „Address“ (Subdomain oder Pfad), nie als eigene Domain
  if (base !== '' && (ascii === base || ascii.endsWith('.' + base))) return fail('base', base);
  if (ascii.length > HOSTNAME_MAX) return fail('invalid', base);
  const labels = ascii.split('.');
  if (labels.length < 2 || labels.length > LABELS_MAX || !labels.every((l) => LABEL.test(l))) return fail('invalid', base);
  const tld = labels[labels.length - 1];
  // Zahlen als Endung: IPv4-Adressen und Unsinn wie foo.123; dazu die reservierten Endungen
  if (/^[0-9]+$/.test(tld) || tld.length < 2 || RESERVED_TLDS.has(tld)) return fail('invalid', base);
  const unicode = domainToUnicode(ascii);
  if (unicode === '') return fail('invalid', base);
  return { ok: true, ascii, unicode };
}

// Unicode-Form für die Anzeige (bücher.de); ungültiges Punycode bleibt, wie es ist
export function displayHostname(ascii: string): string {
  return domainToUnicode(ascii) || ascii;
}

// Wahrscheinlich eine Wurzeldomain (example.com, example.co.uk)? Nur eine Schätzung ohne DNS (Rückfrage im Editor)
export function looksLikeApex(ascii: string): boolean {
  const labels = ascii.split('.');
  if (labels.length === 2) return true;
  return labels.length === 3 && TWO_PART_SUFFIXES.has(labels.slice(1).join('.'));
}

// Vermutete Zone des Nutzers, solange der Domain-Dienst sie noch nicht aus dem DNS kennt
export function guessZone(ascii: string): string {
  const labels = ascii.split('.');
  const n = TWO_PART_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-Math.min(n, labels.length)).join('.');
}

// Name eines Eintrags relativ zur Zone (Feld „Host“ der meisten Anbieter): @ für die Zone selbst
export function relativeName(name: string, zone: string): string {
  if (name === zone) return '@';
  if (zone !== '' && name.endsWith('.' + zone)) return name.slice(0, name.length - zone.length - 1);
  return name;
}

// Host-Felder der beiden Einträge: CNAME (links / @) und TXT (_onyoursite.links / _onyoursite)
export function recordHosts(ascii: string, zone: string | null): { cname: string; txt: string } {
  const z = zone !== null && zone !== '' ? zone : guessZone(ascii);
  return { cname: relativeName(ascii, z), txt: relativeName(TXT_PREFIX + ascii, z) };
}
