// Eigene Domains: abgeleitete Werte mit dem Geheimnis der Seite (oys_hmac) – keine Spalte nötig, nicht übertragbar
import { hmac } from '../crypto.js';

// Wert des TXT-Eintrags _onyoursite.<domain>: an Konto und Domain gebunden. Ein anderes Konto kann ihn nicht
// verwenden, und derselbe Nutzer verbindet die Domain später mit demselben Eintrag wieder.
export const ownershipToken = (userId: number, hostname: string): string =>
  'onyoursite-verify=' + hmac('custom-domain|' + userId + '|' + hostname).slice(0, 32);

// Antwort der Prüfstelle /_/domain-check für einen Host (eigene Domain oder – als Selbsttest – die Domain der Seite)
export const probeAnswer = (hostname: string): string => hmac('domain-check|' + hostname).slice(0, 32);
