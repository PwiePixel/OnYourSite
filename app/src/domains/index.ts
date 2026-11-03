// Eigene Domains (Premium) – Schnittstelle für die übrigen Module. Ruht, bis der Installer (--domains) die Werte in
// config.json geschrieben hat: ohne sie betritt der Router diesen Zweig nie und fragt keine Datenbank.
//   hostRoute            Anfragen auf eigenen Domains (Router)
//   hasDomain            hat die Seite eine Domain in irgendeinem Zustand? (code-slots-admin E7, unter der Platz-Sperre)
//   beforePageRemoved    vor dem Löschen einer Seite, in der Transaktion des Aufrufers (nur Datenbank)
//   hostnameForPage      Hostname in jedem Zustand (Termin-Block: interner Kalender)
//   registerDomainTarget weitere Zielarten (status-pages, später)
//   reconcileUser        Abgleich je Konto (Enforcer „domains“ des Shops): ohne Premium pausieren, mit wieder fortsetzen
//   health / capacity    Gesundheit des Domain-Dienstes (status-pages) und freie Plätze (Premium-Karte des Shops)
// Das Löschen eines Kontos läuft über den Haken „domains“ (Reihenfolge 10, ROADMAP §3.9). Netzwerkarbeit (Cloudflare,
// DNS, Prüfung über die Kante, Mails) macht nur der Domain-Dienst (worker/, node app/dist/cli.js domains:worker).
import { registerUserDeletion } from '../admin/accountDeletion.js';
import { registerEnforcer } from '../honeycombs/reconcile.js';
import { registerLossPreview } from '../honeycombs/features.js';
import { removeUserDomains } from './store.js';
import { premiumLossPreview, reconcileUser } from './lifecycle.js';

export { domainsAvailable, cnameTarget, fallbackOrigin } from './config.js';
export { hostRoute } from './host.js';
export {
  beforePageRemoved, createDomain, domainById, domainForTarget, hasDomain, hostnameBlocked, hostnameForPage, releaseBlock, removeDomain, transition,
  type DomainChange, type DomainRef, type DomainRow, type DomainState,
} from './store.js';
export { CUSTOM_HOST_ENDPOINTS, registerDomainTarget, type DomainTarget, type EndpointRule, type TargetInfo } from './targets.js';
export { ownershipToken, probeAnswer } from './tokens.js';
export { domainsCapacity as capacity, domainsHealth as health, forwardEligible, premiumLossPreview, reconcileUser, type DomainsCapacity, type DomainsHealth } from './lifecycle.js';
export { domainSettings, saveDomainSettings, requestWorker, workerState, type DomainSettings, type WorkerState } from './settings.js';

// Konto löschen: jede Domain wie „Entfernen“ (ohne Hostnamen bei Cloudflare sofort weg, sonst removing für den
// Domain-Dienst), Hauptadresse weg, offene Mails verworfen, Verlauf ohne Konto
registerUserDeletion({
  name: 'domains',
  order: 10,
  run: (db, uid) => removeUserDomains(db, uid),
});

// Premium endet, kommt zurück, Admin-Rolle weg, Domain-Plätze geändert: der Shop ruft nach jeder Änderung diesen
// Abgleich auf (nur Datenbank, darum inline); der Domain-Dienst prüft zusätzlich jede Minute
registerEnforcer({ name: 'domains', features: ['premium', 'custom_domain'], inline: true, run: reconcileUser });
// Zeilen für die Erinnerung und den Hinweis beim Ende von Premium
registerLossPreview('premium', premiumLossPreview);
