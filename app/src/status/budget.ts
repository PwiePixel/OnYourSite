// Statusseiten: das Mail-Budget (Entwurf §4.8.12, ROADMAP §3.8). Alle Mails der Statusseiten teilen einen Topf:
// mail_per_min als Eimer mit Marken (füllt sich gleichmäßig über die Minute) und mail_per_day als Zähler je Tag
// (Zeitzone der Seite). Darin vier Klassen:
// - system: OnYourSites eigene Alarme und der Wächter – wird nie von den anderen aufgehalten (zählt aber mit; der
//   Eimer darf dafür ins Minus gehen, die anderen Klassen warten dann);
// - confirm: Bestätigungen (Abonnenten, weitere Alarm-Adressen) – höchstens confirm_share % des Tages;
// - owner: Alarme an Besitzer und ihre Adressen – höchstens owner_share % des Tages;
// - broadcast: Rundmails an Abonnenten (ab ST-6) – was übrig bleibt.
// Rein und ohne Datenbank; der Benachrichtigungsdienst speichert den Stand im Gesundheitseintrag (status_notify).
import type { MailClass } from './alerts.js';

export interface BudgetLimits {
  mail_per_min: number;
  mail_per_day: number;
  confirm_share: number; // Prozent des Tages
  owner_share: number; // Prozent des Tages
}

export type Used = Record<MailClass, number>;
export const emptyUsed = (): Used => ({ system: 0, confirm: 0, owner: 0, broadcast: 0 });

// ok: Marke genommen und gezählt · wait: die Minute ist voll (später noch einmal) · day: Klasse für heute aufgebraucht
export type Take = 'ok' | 'wait' | 'day';

export class MailBudget {
  used: Used;
  private tokens: number;
  private refilledAt: number;

  constructor(private limits: BudgetLimits, public day: string, used: Partial<Used> = {}, nowMs = Date.now()) {
    this.used = { ...emptyUsed(), ...used };
    this.tokens = limits.mail_per_min;
    this.refilledAt = nowMs;
  }

  setLimits(limits: BudgetLimits): void {
    this.limits = limits;
    this.tokens = Math.min(this.tokens, limits.mail_per_min);
  }

  // Neuer Tag (Zeitzone der Seite): Zähler auf null
  rollDay(day: string): void {
    if (day === this.day) return;
    this.day = day;
    this.used = emptyUsed();
  }

  private refill(nowMs: number): void {
    const elapsed = Math.max(0, nowMs - this.refilledAt);
    this.refilledAt = nowMs;
    this.tokens = Math.min(this.limits.mail_per_min, this.tokens + (elapsed / 60_000) * this.limits.mail_per_min);
  }

  get total(): number {
    return this.used.system + this.used.confirm + this.used.owner + this.used.broadcast;
  }

  // Obergrenze einer Klasse für heute (null = keine)
  classCap(cls: MailClass): number | null {
    const day = this.limits.mail_per_day;
    if (cls === 'system') return null;
    if (cls === 'confirm') return Math.floor((day * this.limits.confirm_share) / 100);
    if (cls === 'owner') return Math.floor((day * this.limits.owner_share) / 100);
    return day;
  }

  // Darf die Klasse heute noch? (ohne Marke zu nehmen) – z. B. für „This page can’t take new subscribers right now.“
  dayLeft(cls: MailClass): boolean {
    if (cls === 'system') return true;
    const cap = this.classCap(cls) ?? Infinity;
    return this.used[cls] < cap && this.total < this.limits.mail_per_day;
  }

  take(cls: MailClass, nowMs = Date.now()): Take {
    this.refill(nowMs);
    if (cls === 'system') {
      this.tokens -= 1;
      this.used.system++;
      return 'ok';
    }
    if (!this.dayLeft(cls)) return 'day';
    if (this.tokens < 1) return 'wait';
    this.tokens -= 1;
    this.used[cls]++;
    return 'ok';
  }

  // Ein Versand ist doch nicht passiert (z. B. der Mail-Server lehnte ab): Zähler zurück, die Marke bleibt verbraucht
  giveBack(cls: MailClass): void {
    if (this.used[cls] > 0) this.used[cls]--;
  }

  // Wann wieder eine Marke da ist (ms)
  nextTokenIn(nowMs = Date.now()): number {
    this.refill(nowMs);
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.limits.mail_per_min) * 60_000);
  }
}
