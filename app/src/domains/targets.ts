// Eigene Domains: Zielarten (v1: Profilseiten) und die eine Liste der /_/-Endpunkte, die auf einer eigenen Domain
// erreichbar sind. status-pages kann später 'status' anmelden (registerDomainTarget); Dienst, Zustände, Grenzen und
// Premium-Ablauf sind für alle Zielarten dieselben.
import type { Ctx } from '../web/ctx.js';
import { one, type Db, type Row } from '../db.js';
import { addressUrl, type PageLike } from '../helpers.js';
import { intval, phpTruthy } from '../php.js';

export interface TargetInfo {
  id: number;
  userId: number;
  row: Row;
}

// Ein /_/-Pfad auf einer eigenen Domain. owns sagt, wo die Kennung steht, die zum Ziel der Domain gehören muss:
// ein Name = Feld im POST, eine Zahl = Gruppe im Pfad; page = Seiten-ID, block = Block-ID (page_blocks.page_id).
// GET gilt auch für HEAD.
export interface EndpointRule {
  method: 'GET' | 'POST' | 'ANY';
  path: RegExp;
  owns?: { page?: string | number; block?: string | number };
}

export interface DomainTarget {
  type: string;                                                        // ≤ 8 Zeichen (custom_domains.target_type)
  load(id: number, db?: Db): Promise<TargetInfo | null>;               // null = gibt es nicht (mehr) → neutrale 404
  serve(ctx: Ctx, t: TargetInfo, sub: string): Promise<void>;
  endpoints: EndpointRule[];                                           // zusätzliche /_/-Pfade auf der Domain
  fallbackUrl(t: TargetInfo, sub?: string): string;                    // OnYourSite-Adresse (Weiterleitung bei Pause)
  lock(db: Db, id: number): Promise<void>;                             // Zeile des Ziels sperren – immer vor der Domain
  setPrimary(db: Db, id: number, host: string | null): Promise<void>;  // in derselben Transaktion wie der Zustand
  ownerId(t: TargetInfo): number;
}

// Die eine Liste der /_/-Endpunkte auf eigenen Domains; die Kennung muss zum Ziel der Domain gehören.
// '*' gilt für jede Zielart (die Prüfstelle des Domain-Dienstes).
export const CUSTOM_HOST_ENDPOINTS: Readonly<Record<string, readonly EndpointRule[]>> = Object.freeze({
  '*': [{ method: 'GET', path: /^\/_\/domain-check$/ }],
  page: [
    { method: 'POST', path: /^\/_\/v$/, owns: { page: 'p' } },
    { method: 'POST', path: /^\/_\/c$/, owns: { block: 'b' } },
    { method: 'POST', path: /^\/_\/unlock$/, owns: { block: 'b' } },
    { method: 'ANY', path: /^\/_\/go\/(\d+)$/, owns: { block: 1 } },
    { method: 'POST', path: /^\/_\/contact$/, owns: { block: 'b' } },
    { method: 'GET', path: /^\/_\/og\/(\d+)-[0-9a-f]{12}\.png$/, owns: { page: 1 } },
    // Favicon aus dem Profilbild (Premium, content/icon.ts)
    { method: 'GET', path: /^\/_\/icon\/(\d+)-[0-9a-f]{12}\.png$/, owns: { page: 1 } },
  ],
});

const targets = new Map<string, DomainTarget>();

// Zielart anmelden (einmal je Art, beim Laden des Moduls)
export function registerDomainTarget(type: string, adapter: Omit<DomainTarget, 'type'>): void {
  if (!/^[a-z]{1,8}$/.test(type)) throw new Error(`invalid custom domain target type: ${type}`);
  if (targets.has(type)) throw new Error(`custom domain target "${type}" is registered twice`);
  targets.set(type, { ...adapter, type });
}

export const domainTarget = (type: string): DomainTarget | null => targets.get(type) ?? null;

// ---------------------------------------------------------------- v1: Profilseiten

const pageLike = (t: TargetInfo): PageLike => t.row as unknown as PageLike;

registerDomainTarget('page', {
  async load(id, db) {
    const row = db ? await db.one('SELECT * FROM pages WHERE id = ?', [id]) : await one('SELECT * FROM pages WHERE id = ?', [id]);
    // Eine Seite, die eine Code-Seite zeigt (code-slots-admin), hat nie eine eigene Domain (E7, domain-add)
    if (!row || phpTruthy(row.code_site_id ?? null)) return null;
    return { id: intval(row.id), userId: intval(row.user_id), row };
  },
  // Dieselbe Darstellung wie auf der Subdomain (index.php). Erst beim Aufruf geladen: public/routes.ts lädt über
  // store.ts dieses Modul – so entsteht beim Laden kein Kreis.
  async serve(ctx, t, sub) {
    const { servePage } = await import('../public/routes.js');
    return servePage(ctx, t.row, sub);
  },
  endpoints: [...CUSTOM_HOST_ENDPOINTS.page],
  fallbackUrl: (t, sub = '') => addressUrl(pageLike(t), sub),
  async lock(db, id) {
    await db.q('SELECT id FROM pages WHERE id = ? FOR UPDATE', [id]);
  },
  async setPrimary(db, id, host) {
    await db.exec('UPDATE pages SET custom_domain = ? WHERE id = ?', [host, id]);
  },
  ownerId: (t) => t.userId,
});
