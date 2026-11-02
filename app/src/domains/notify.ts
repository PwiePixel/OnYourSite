// Eigene Domains: Hinweise an den Besitzer (Glocke über notify() und – wo vorgesehen – eine Mail) und an die Admins.
// Alles wird in DERSELBEN Transaktion geschrieben wie der Zustand, über den es berichtet: so gibt es jeden Hinweis
// genau einmal. Mails sind Zeilen im Verlauf (custom_domain_log.mail = 1); der Domain-Dienst verschickt sie nach dem
// Commit (worker/mail.ts) – nie in einer Anfrage oder Transaktion.
import type { Db, Row } from '../db.js';
import { addressUrl, type PageLike } from '../helpers.js';
import { intval, phpStr } from '../php.js';
import { notify, notifyAdmins } from '../notify/notify.js';
import { displayHostname } from './hostname.js';
import { logEvent, type DomainRow } from './store.js';

export type DomainNoticeType = 'domain_live' | 'domain_problem' | 'domain_back' | 'domain_paused' | 'domain_removed';

// Titel der Glocke und der Mail
export const NOTICE_TITLES: Readonly<Record<DomainNoticeType | 'alert', string>> = Object.freeze({
  domain_live: 'Your domain is live',
  domain_problem: 'Your domain needs attention',
  domain_back: 'Your domain is back online',
  domain_paused: 'Your custom domain is paused',
  domain_removed: 'Your custom domain was disconnected',
  alert: 'Custom domains need attention',
});

// Diese Hinweise kommen auch per Mail (Q11: nur, wenn der Nutzer handeln muss oder etwas verliert)
const MAILED: ReadonlySet<string> = new Set(['domain_live', 'domain_problem', 'domain_paused', 'domain_removed']);

// Ziel in der Glocke: die Seite der Domain im Editor, Abschnitt „Custom domain“
export const domainLink = (row: Pick<DomainRow, 'target_id'>): string => '/dashboard?page=' + intval(row.target_id) + '#settings/domain';

// OnYourSite-Adresse einer Seite ohne Schema (mia.on-your.site) – für Texte
export function pageAddress(page: Row | null): string {
  if (!page) return 'your OnYourSite address';
  return addressUrl(page as unknown as PageLike).replace(/^https?:\/\//, '');
}

const host = (row: Pick<DomainRow, 'hostname'>): string => displayHostname(row.hostname);

// Texte der Hinweise (Englisch, wie alles, was Nutzer sehen)
export const noticeText = {
  live: (row: DomainRow, page: Row | null): string =>
    `${host(row)} now shows your page “${phpStr(page?.title ?? '') !== '' ? phpStr(page?.title) : phpStr(page?.slug ?? '')}”.`,
  problem: (row: DomainRow, page: Row | null, problem: string): string => {
    const where = `Your page is shown at ${pageAddress(page)} until it’s fixed.`;
    switch (problem) {
      case 'dns_unknown':
        return `The DNS of ${host(row)} has been answering with errors for 30 minutes. ${where}`;
      case 'ssl_expired':
      case 'cert_invalid':
        return `The HTTPS certificate for ${host(row)} isn’t valid any more. ${where}`;
      case 'probe_failed':
        return `${host(row)} doesn’t reach your page through OnYourSite. ${where}`;
      case 'cert_expiring':
        return `The HTTPS certificate for ${host(row)} expires soon and couldn’t be renewed yet. Check that no CAA record blocks letsencrypt.org, pki.goog and ssl.com.`;
      default:
        return `${host(row)} doesn’t point to OnYourSite any more. ${where}`;
    }
  },
  back: (row: DomainRow): string => `${host(row)} works again.`,
  paused: (row: DomainRow, page: Row | null): string => `You’re no longer an admin, so ${host(row)} forwards to ${pageAddress(page)}.`,
  removed: (row: DomainRow, page: Row | null, reason: string, extra = ''): string => {
    switch (reason) {
      case 'setup_timeout':
        return `${host(row)} couldn’t be set up in time, so it was disconnected. Check the DNS records and connect it again.`;
      case 'broken_timeout':
        return `${host(row)} didn’t work for 7 days, so it was disconnected. Your page is shown at ${pageAddress(page)}.`;
      case 'grace_over':
        return `Premium ended, so ${host(row)} was disconnected. Renew Premium to connect it again.`;
      case 'transferred':
        return `${host(row)} was removed because the domain’s owner connected it to another account.`;
      case 'blocked':
        return `The team disabled ${host(row)}` + (extra !== '' ? `: ${extra}` : '.');
      default:
        return `${host(row)} was disconnected.`;
    }
  },
};

// Hinweis an den Besitzer der Domain: Glocke und (je nach Art) Mail-Zeile im Verlauf – in der Transaktion des Aufrufers
export async function domainNotice(db: Db, row: DomainRow, type: DomainNoticeType, body: string): Promise<void> {
  await notify(intval(row.user_id), type, NOTICE_TITLES[type], body, domainLink(row), { db });
  await logEvent(db, row, type, body, { mail: MAILED.has(type) });
}

// Hinweis an alle Admins (Glocke „team“ und Mail) – in der Transaktion des Aufrufers (mit dem Zeitpunkt der Meldung)
export async function adminAlert(db: Db, text: string, hostname = ''): Promise<void> {
  await notifyAdmins('team', NOTICE_TITLES.alert, text, '/admin#domains', { db });
  for (const a of await db.q('SELECT id FROM users WHERE is_admin = 1 ORDER BY id')) {
    await logEvent(db, { id: null, hostname, user_id: intval(a.id) }, 'alert', text, { mail: true });
  }
}

// Schutz vor Flattern: „needs attention“ höchstens einmal je 24 Stunden je Domain; „back online“ nur nach einem
// gemeldeten Problem. Rückgabe: ob gemeldet wird, und die Spalten für den Zustandswechsel (Compare-and-set).
// Zeiten sind Wanduhrzeit der Seite ('Y-m-d H:i:s') – als Text vergleichbar.
export function problemNoticeAllowed(row: DomainRow, now: string, dayAgo: string): { allowed: boolean; set: Record<string, string | number> } {
  const last = row.notice_at === null || row.notice_at === undefined ? '' : phpStr(row.notice_at);
  const allowed = last === '' || last < dayAgo;
  return { allowed, set: allowed ? { notice_state: 1, notice_at: now } : {} };
}

export function backNoticeAllowed(row: DomainRow): { allowed: boolean; set: Record<string, number> } {
  const allowed = intval(row.notice_state) === 1;
  return { allowed, set: allowed ? { notice_state: 0 } : {} };
}
