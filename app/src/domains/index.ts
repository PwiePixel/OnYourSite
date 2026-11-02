// Eigene Domains (Premium) – Schnittstelle für die übrigen Module. Ruht, bis der Installer (--domains) die Werte in
// config.json geschrieben hat: ohne sie betritt der Router diesen Zweig nie und fragt keine Datenbank.
//   hostRoute            Anfragen auf eigenen Domains (Router)
//   hasDomain            hat die Seite eine Domain in irgendeinem Zustand? (code-slots-admin E7, unter der Platz-Sperre)
//   beforePageRemoved    vor dem Löschen einer Seite, in der Transaktion des Aufrufers (nur Datenbank)
//   hostnameForPage      Hostname in jedem Zustand (Termin-Block: interner Kalender)
//   registerDomainTarget weitere Zielarten (status-pages, später)
// Das Löschen eines Kontos läuft über den Haken „domains“ (Reihenfolge 10, ROADMAP §3.9).
import { registerUserDeletion } from '../admin/accountDeletion.js';
import { removeUserDomains } from './store.js';

export { domainsAvailable, cnameTarget, fallbackOrigin } from './config.js';
export { hostRoute } from './host.js';
export {
  beforePageRemoved, createDomain, domainById, domainForTarget, hasDomain, hostnameForPage, removeDomain, transition,
  type DomainChange, type DomainRef, type DomainRow, type DomainState,
} from './store.js';
export { CUSTOM_HOST_ENDPOINTS, registerDomainTarget, type DomainTarget, type EndpointRule, type TargetInfo } from './targets.js';
export { ownershipToken, probeAnswer } from './tokens.js';

// Konto löschen: jede Domain wie „Entfernen“ (ohne Hostnamen bei Cloudflare sofort weg, sonst removing für den
// Domain-Dienst), Hauptadresse weg, offene Mails verworfen, Verlauf ohne Konto
registerUserDeletion({
  name: 'domains',
  order: 10,
  run: (db, uid) => removeUserDomains(db, uid),
});
