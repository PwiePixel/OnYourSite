// Nächste Prüfung einer Domain je Zustand und Alter (rein). Das Lesen im Editor (GET domain) ändert hier nichts; nur
// „Check now“ setzt fast_until/manual_at, und nur der Dienst schreibt next_check_at.
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

export interface ScheduleRow {
  id: number;
  state: string;
  cf_id: string | null;
  created: number; // Unix-Zeiten (null = fehlt)
  cfCreated: number | null;
  stateAt: number;
  fastUntil: number | null;
}

// Feste Punkte nach dem Hinzufügen (verifying): 10, 15, 20, 30, 45, 60 Minuten, dann stündlich bis 24 h, dann alle 6 h
function verifyingNext(age: number): number {
  for (const p of [10, 15, 20, 30, 45, 60].map((m) => m * MIN)) if (age < p) return p - age;
  if (age < DAY) return HOUR - ((age - HOUR) % HOUR);
  return 6 * HOUR - ((age - DAY) % (6 * HOUR));
}

// Sekunden bis zur nächsten Prüfung; null = nur auf Anfrage (failed, blocked ohne Hostnamen)
export function nextDelay(r: ScheduleRow, now: number): number | null {
  const fast = r.fastUntil !== null && r.fastUntil > now;
  switch (r.state) {
    case 'verifying':
      return fast ? MIN : Math.max(MIN, verifyingNext(now - r.created));
    case 'pending': {
      if (fast) return MIN;
      const age = now - (r.cfCreated ?? r.stateAt);
      if (age < HOUR) return 5 * MIN;
      if (age < DAY) return 15 * MIN;
      if (age < 3 * DAY) return HOUR;
      return 6 * HOUR;
    }
    case 'active': {
      // Alle 10 Minuten, je Domain versetzt (nicht alle in derselben Sekunde)
      const offset = (r.id * 37) % 600;
      const next = (Math.floor((now - offset) / 600) + 1) * 600 + offset;
      return Math.max(MIN, next - now);
    }
    case 'broken':
      if (!r.cf_id) return 15 * MIN;
      return now - r.stateAt < HOUR ? 5 * MIN : 15 * MIN;
    case 'suspended':
      return r.cf_id ? 6 * HOUR : DAY;
    case 'removing':
      // 1 Minute, dann jeweils doppelt so lange (gemessen am Beginn), höchstens 1 Stunde
      return Math.min(HOUR, Math.max(MIN, now - r.stateAt));
    case 'blocked':
    case 'failed':
      return r.cf_id ? 5 * MIN : null;
    default:
      return null;
  }
}
