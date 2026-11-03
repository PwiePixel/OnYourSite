// Stand des Bereichs „Honeycombs“ im Editor: Kontostand, was man freischalten kann (je Funktion eine Karte mit ihren
// Optionen und Preisen), was das Konto besitzt, wie man mehr verdient und der Verlauf. Nur lesen, eine Pool-Abfrage
// nach der anderen (keine gehaltene Verbindung). Ob ein Kauf wirklich geht, entscheidet allein buy() unter der
// Kontosperre – hier steht nur, was die Karte zeigt (Preis mit Angebot, Grund statt Kauf-Knopf).
import { mailRemindersOn } from './outbox.js';
import { cappedToday, earnLimits, streakOf, type EarnLimits, type StreakInfo } from './earn.js';
import type { Row } from '../db.js';
import { date, intval, numberFormat, phpStr, phpTruthy } from '../php.js';
import { poolDb } from './util.js';
import { addDays, nowStr, toUnix } from './clock.js';
import { DEFAULT_MAX_AHEAD_DAYS, LIFECYCLE_READY, feature, featureReady, features, premiumPerks, type Feature, type FeatureKind, type ItemRow } from './features.js';
import { balanceIn } from './ledger.js';
import { entitlement, has, isActive, quantity, type EntRow } from './entitlements.js';
import { buyerInfo, ensureCatalogue, itemOpen, itemsOf, optionLabel, quote, type Buyer } from './catalogue.js';
import { premiumState } from './premium.js';
import { HC_MAX_VIEW_REWARDS, hcDescribe, hcHas, hcSettings } from './honeycombs.js';
import { nextPeriod, pickLot, type LotState } from './shop.js';

export interface ShopOption {
  item: string;
  label: string; // „30 days“, „+1“, „Unlock“
  days: number | null;
  units: number;
  listPrice: number;
  price: number; // mit dem günstigsten Angebot, das für dieses Konto gilt
  offer: { label: string; endsAt: string; percentOff: number | null } | null;
  availableUntil: string | null;
  affordable: boolean;
  note: string; // Grund, warum genau diese Option nicht geht ('' = kaufbar), z. B. das Mindestalter des Kontos
}

export type CardState = 'buy' | 'owned' | 'max' | 'included' | 'locked';

export interface ShopFeature {
  feature: string;
  title: string;
  icon: string;
  description: string;
  perks: string[];
  href: string | null;
  kind: FeatureKind;
  stack: number;
  state: CardState;
  note: string; // Grund, wenn nicht kaufbar (bzw. der Hinweis zu „owned“, z. B. Premium für immer)
  quantity: number;
  max: number | null;
  activeUntil: string | null;
  lotsActive: number;
  needsTerms: boolean;
  options: ShopOption[];
}

export interface Owned {
  feature: string;
  lot: number;
  title: string;
  icon: string;
  kind: FeatureKind;
  quantity: number;
  permanent: boolean;
  expiresAt: string | null;
  active: boolean;
  endsInDays: number | null;
  source: 'purchase' | 'admin' | 'legacy';
  note: string;
}

export interface EarnRule {
  key: string;
  icon: string;
  title: string;
  text: string;
  amount: number; // 0 = ohne feste Menge (Geschenke)
  done: boolean;
  doneText: string;
  progress: { value: number; goal: number } | null;
}

export interface ShopState {
  balance: number;
  frozen: boolean;
  frozenReason: string;
  readOnly: boolean; // Admin-Modus: ansehen ja, kaufen nein
  premium: { active: boolean; until: string | null; forever: boolean; source: string | null; buyable: boolean };
  features: ShopFeature[];
  owned: Owned[];
  earn: { rules: EarnRule[]; streak: StreakInfo; capLeft: number; cap: number };
  mailReminders: boolean; // „Email me before an unlock ends“ (HC-7b)
}

// Beendete Zeitpakete bleiben so lange in „Your unlocks“ (grau, mit „Renew“)
export const ENDED_SHOWN_DAYS = 90;
export const HISTORY_PAGE = 20;

// „Needs your code page first.“ (wie buy())
function needsText(key: string): string {
  const f = feature(key);
  if (!f) return 'Needs another unlock first.';
  return key === 'premium' ? 'Needs Premium first.' : 'Needs your ' + f.title.charAt(0).toLowerCase() + f.title.slice(1) + ' first.';
}

// Prozent des Angebots, wie es die Karte zeigt (fester Preis: ausgerechnet, abgerundet)
function percentOf(listPrice: number, price: number, percentOff: number | null): number | null {
  if (percentOff !== null) return percentOff;
  if (listPrice <= 0 || price >= listPrice) return null;
  return Math.floor(((listPrice - price) * 100) / listPrice);
}

// Grund, warum eine Option für dieses Konto (noch) nicht geht – in der Reihenfolge von buy()
function optionNote(f: Feature, item: ItemRow, buyer: Buyer, lots: readonly LotState[], now: string): string {
  const minDays = Math.max(intval(item.min_account_days), f.minAccountDaysFloor ?? 0);
  if (buyer.accountDays < minDays) return 'This is available once your account is ' + minDays + ' days old.';
  if (buyer.activeDays < intval(item.min_active_days)) return 'This is available once you’ve been active on ' + intval(item.min_active_days) + ' days.';
  if (f.kind === 'timed') {
    const pick = pickLot(f.stack ?? 1, lots);
    if ('full' in pick) return '';
    const current = lots.find((l) => l.lot === pick.lot) ?? null;
    const period = nextPeriod(current, intval(item.days), now);
    if (toUnix(period.end) - toUnix(now) > (f.maxAheadDays ?? DEFAULT_MAX_AHEAD_DAYS) * 86400) {
      return 'You already have ' + f.title + ' until ' + date('M j, Y', toUnix(period.start)) + '. You can extend it again later.';
    }
  }
  return '';
}

// Karte einer Funktion – null, wenn es nichts zu zeigen gibt (nicht bereit, keine offene Option, kostenlos)
async function card(f: Feature, user: Row, uid: number, buyer: Buyer, balance: number, now: string): Promise<ShopFeature | null> {
  if (!featureReady(f) || (f.kind === 'timed' && !LIFECYCLE_READY)) return null;
  // Für alle frei (Preis 0, z. B. weitere Code-Seiten): keine Karte, nichts freizuschalten
  const items = (await itemsOf(f.key)).filter((i) => itemOpen(i, now) && !(f.freeAtZero && intval(i.price) === 0));
  if (!items.length) return null;
  const ent = await entitlement(uid, f.key);
  const lots: LotState[] = ent.lots.map((l) => ({ lot: l.lot, active: l.active, permanent: l.permanent, expiresAt: l.expiresAt }));
  const options: ShopOption[] = [];
  for (const item of items) {
    const q = await quote(poolDb, item, buyer, now);
    options.push({
      item: item.item_key,
      label: optionLabel(f, item),
      days: item.days === null ? null : intval(item.days),
      units: intval(item.units),
      listPrice: q.listPrice,
      price: q.price,
      offer: q.offer ? { label: phpStr(q.offer.label), endsAt: phpStr(q.offer.ends_at), percentOff: percentOf(q.listPrice, q.price, q.offer.percent_off === null ? null : intval(q.offer.percent_off)) } : null,
      availableUntil: item.available_until,
      affordable: balance >= q.price,
      note: optionNote(f, item, buyer, lots, now),
    });
  }
  // Zustand in der Reihenfolge der Prüfungen von buy()
  let state: CardState = 'buy';
  let note = '';
  const unitsMin = Math.min(...items.map((i) => intval(i.units)));
  if (f.includedFor?.(user)) {
    state = 'included';
    note = f.key === 'premium' ? 'Premium is included with your admin account.' : 'This is included with your account.';
  } else if (f.kind === 'permanent' && ent.active) {
    state = 'owned';
  } else if (f.kind === 'timed' && ent.lots.some((l) => l.active && l.permanent)) {
    state = 'owned';
    note = f.key === 'premium' ? 'You have Premium for good – no need to buy it.' : 'You have this for good – no need to buy it.';
  } else if ((f.kind === 'count' || f.kind === 'consumable') && f.max !== undefined && ent.quantity + unitsMin > f.max) {
    state = 'max';
    note = 'You already have the maximum (' + f.max + ').';
  } else if (f.requires !== undefined && !(await has(uid, f.requires))) {
    state = 'locked';
    note = needsText(f.requires);
  } else if (options.every((o) => o.note !== '')) {
    state = 'locked';
    note = options[0].note;
  }
  return {
    feature: f.key,
    title: f.title,
    icon: f.icon,
    description: f.description,
    perks: f.key === 'premium' ? premiumPerks().filter((p) => p.ready()).map((p) => p.text) : [],
    href: f.href ?? null,
    kind: f.kind,
    stack: f.stack ?? 1,
    state,
    note,
    quantity: ent.quantity,
    max: f.max ?? null,
    activeUntil: ent.until,
    lotsActive: ent.lots.filter((l) => l.active).length,
    needsTerms: f.needsTerms ? f.needsTerms(user) : false,
    options,
  };
}

// Was das Konto besitzt: aktive Zeitpakete (das zuerst endende zuerst), dann dauerhafte, dann beendete (≤ 90 Tage)
async function ownedList(uid: number, now: string): Promise<Owned[]> {
  const rows = await poolDb.q<EntRow>('SELECT * FROM hc_entitlements WHERE user_id = ? ORDER BY feature, lot', [uid]);
  const timed: Owned[] = [];
  const forGood: Owned[] = [];
  const ended: Owned[] = [];
  const endedSince = addDays(now, -ENDED_SHOWN_DAYS);
  const withRows = new Set<string>();
  for (const r of rows) {
    withRows.add(String(r.feature));
    const f = feature(String(r.feature));
    if (!f || !featureReady(f)) continue;
    const active = isActive(r, now);
    const permanent = active && phpTruthy(r.permanent);
    const expiresAt = typeof r.expires_at === 'string' ? r.expires_at : null;
    const source = r.source === 'admin' || r.source === 'legacy' ? r.source : 'purchase';
    const row: Owned = {
      feature: f.key, lot: intval(r.lot), title: f.title, icon: f.icon, kind: f.kind, quantity: active ? intval(r.quantity) : 0, permanent,
      expiresAt: permanent ? null : expiresAt, active, endsInDays: active && !permanent && expiresAt !== null ? Math.max(0, Math.ceil((toUnix(expiresAt) - toUnix(now)) / 86400)) : null,
      source, note: phpStr(r.note),
    };
    if (active && !permanent) timed.push(row);
    else if (active) forGood.push(row);
    else if (expiresAt !== null && expiresAt >= endedSince && f.kind === 'timed') ended.push(row);
  }
  // Alte Freischaltungen nur im Buch (unlock/<Funktion>, noch ohne Berechtigung): gelten wie dauerhafte
  for (const f of features()) {
    if (f.kind !== 'permanent' || withRows.has(f.key) || !featureReady(f)) continue;
    if ((await quantity(uid, f.key)) > 0) {
      forGood.push({ feature: f.key, lot: 0, title: f.title, icon: f.icon, kind: f.kind, quantity: 1, permanent: true, expiresAt: null, active: true, endsInDays: null, source: 'legacy', note: '' });
    }
  }
  timed.sort((a, b) => ((a.expiresAt ?? '') < (b.expiresAt ?? '') ? -1 : (a.expiresAt ?? '') > (b.expiresAt ?? '') ? 1 : a.lot - b.lot));
  ended.sort((a, b) => ((a.expiresAt ?? '') > (b.expiresAt ?? '') ? -1 : (a.expiresAt ?? '') < (b.expiresAt ?? '') ? 1 : a.lot - b.lot));
  return [...timed, ...forGood, ...ended];
}

// Wie man mehr verdient (die Regeln von heute; abgeschaltete Belohnungen – Menge 0 – fehlen)
// Serie: „Day 4 – 3 more days to +15“; ohne laufende Serie die Regel selbst
function streakRule(st: StreakInfo, lim: EarnLimits): EarnRule {
  const week = lim.streak_week > 0 ? '+' + numberFormat(lim.streak_week) + ' every 7 days' : '';
  const month = lim.streak_month > 0 ? '+' + numberFormat(lim.streak_month) + ' every 30 days' : '';
  const rule = 'Open your editor every day: ' + [week, month].filter((x) => x !== '').join(', ') + ' in a row';
  const left = st.nextAt !== null ? st.nextAt - st.days : 0;
  const text = st.days > 0 && st.nextAt !== null && st.nextAmount !== null
    ? 'Day ' + st.days + ' – ' + left + ' more day' + (left === 1 ? '' : 's') + ' to +' + numberFormat(st.nextAmount)
    : rule;
  return { key: 'streak', icon: 'bx-flame', title: 'Keep a streak', text, amount: st.nextAmount ?? 0, done: false, doneText: '', progress: null };
}

async function earnRules(uid: number, streak: StreakInfo, lim: EarnLimits): Promise<EarnRule[]> {
  const cfg = await hcSettings();
  const viewRewards = intval(await poolDb.value("SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = ? AND reason = 'views'", [uid]));
  const rules: EarnRule[] = [
    { key: 'daily', icon: 'bx-calendar-check', title: 'Be active', text: 'Open your editor – once a day', amount: cfg.daily,
      done: await hcHas(uid, 'daily', date('Y-m-d')), doneText: 'Collected today – come back tomorrow', progress: null },
    streakRule(streak, lim),
    { key: 'profile', icon: 'bx-user-check', title: 'Complete your profile', text: 'A profile picture, a bio and at least 3 links', amount: cfg.profile,
      done: await hcHas(uid, 'profile', 'complete'), doneText: 'Done – thanks!', progress: null },
    { key: 'views', icon: 'bx-trending-up', title: 'Get visitors', text: 'For every ' + numberFormat(cfg.views_step) + ' views of your pages – one reward a day',
      amount: cfg.views, done: viewRewards >= HC_MAX_VIEW_REWARDS, doneText: 'All ' + HC_MAX_VIEW_REWARDS + ' rewards collected',
      progress: { value: Math.min(viewRewards, HC_MAX_VIEW_REWARDS), goal: HC_MAX_VIEW_REWARDS } },
    { key: 'codes', icon: 'bx-purchase-tag-alt', title: 'Event codes', text: 'Codes from events and the team – redeem them below', amount: 0, done: false, doneText: '', progress: null },
    { key: 'gifts', icon: 'bx-gift', title: 'Gifts from the team', text: 'For great pages, events and helping others', amount: 0, done: false, doneText: '', progress: null },
  ];
  return rules.filter((r) => r.key === 'gifts' || r.key === 'codes' || r.amount > 0);
}

// „Earn honeycombs“: Regeln, Serie und was vom Tageslimit heute noch übrig ist
async function earnState(uid: number): Promise<ShopState['earn']> {
  const lim = await earnLimits();
  const streak = await streakOf(uid);
  return { rules: await earnRules(uid, streak, lim), streak, capLeft: Math.max(0, lim.daily_cap - (await cappedToday(poolDb, uid))), cap: lim.daily_cap };
}

// Der ganze Stand für den Bereich im Editor. readOnly: Admin im Nutzer-Modus (kaufen ist dann aus).
export async function shopState(uid: number, readOnly: boolean): Promise<ShopState> {
  await ensureCatalogue();
  const now = nowStr();
  const user = await poolDb.one('SELECT * FROM users WHERE id = ?', [uid]);
  if (!user) throw new Error(`shopState: user ${uid} not found`);
  const balance = await balanceIn(poolDb, uid);
  const acc = await poolDb.one('SELECT frozen_at, frozen_reason FROM hc_accounts WHERE user_id = ?', [uid]);
  const buyer = await buyerInfo(poolDb, uid, user, now);
  const cards: ShopFeature[] = [];
  for (const f of features()) {
    const c = await card(f, user, uid, buyer, balance, now);
    if (c) cards.push(c);
  }
  const prem = await premiumState(uid);
  const premiumCard = cards.find((c) => c.feature === 'premium');
  return {
    balance,
    frozen: !!acc && acc.frozen_at !== null,
    frozenReason: acc && acc.frozen_at !== null ? phpStr(acc.frozen_reason ?? '') : '',
    readOnly,
    premium: { active: prem.active, until: prem.until, forever: prem.forever, source: prem.source, buyable: !!premiumCard && premiumCard.state === 'buy' },
    features: cards,
    owned: await ownedList(uid, now),
    earn: await earnState(uid),
    mailReminders: await mailRemindersOn(uid),
  };
}

export interface HistoryItem {
  id: number;
  amount: number;
  text: string;
  at: string;
}

// Verlauf seitenweise: die 20 neuesten Buchungen vor der ID before (ohne: die neuesten); next = ID für „Show more“
export async function historyPage(uid: number, before: number | null): Promise<{ items: HistoryItem[]; next: number | null }> {
  const rows = before === null
    ? await poolDb.q(`SELECT id, amount, reason, ref, note, created_at FROM honeycomb_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ${HISTORY_PAGE + 1}`, [uid])
    : await poolDb.q(`SELECT id, amount, reason, ref, note, created_at FROM honeycomb_ledger WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ${HISTORY_PAGE + 1}`, [uid, before]);
  const items = rows.slice(0, HISTORY_PAGE).map((r) => ({ id: intval(r.id), amount: intval(r.amount), text: hcDescribe(r), at: phpStr(r.created_at) }));
  return { items, next: rows.length > HISTORY_PAGE ? items[items.length - 1].id : null };
}
