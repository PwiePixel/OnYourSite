// Statusseiten: Tagespartitionen von status_checks (nach UTC). Einzelne Prüfungen bleiben nur zwei Tage – alte Tage
// fallen als Ganzes weg (DROP PARTITION) statt Millionen Zeilen zu löschen. Hier die reinen Regeln (Namen, Grenzen,
// Klausel für CREATE TABLE); die tägliche Pflege macht der Prüfdienst (ST-2).

const DAY = 86400;

// Beginn des UTC-Tages
export const utcDay = (unix: number): number => Math.floor(unix / DAY) * DAY;

// p20261102 = alle Prüfungen vor dem 3.11.2026 00:00 UTC, die in keine frühere Partition gehören
export function partitionName(dayStart: number): string {
  const d = new Date(utcDay(dayStart) * 1000);
  return 'p' + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
}

export interface DayPartition {
  name: string;
  day: number; // Beginn des Tages (Unix, UTC)
  lessThan: number; // Grenze VALUES LESS THAN (Beginn des nächsten Tages)
}

// Heute und `ahead` Tage voraus
export function partitionPlan(now: number, ahead = 3): DayPartition[] {
  const today = utcDay(now);
  const out: DayPartition[] = [];
  for (let i = 0; i <= ahead; i++) {
    const day = today + i * DAY;
    out.push({ name: partitionName(day), day, lessThan: day + DAY });
  }
  return out;
}

// „PARTITION BY RANGE (at) (PARTITION p… VALUES LESS THAN (…), …, PARTITION pmax VALUES LESS THAN MAXVALUE)“
export function partitionClauseFor(now: number, ahead = 3): string {
  const parts = partitionPlan(now, ahead).map((p) => `PARTITION ${p.name} VALUES LESS THAN (${p.lessThan})`);
  parts.push('PARTITION pmax VALUES LESS THAN MAXVALUE');
  return `PARTITION BY RANGE (at) (${parts.join(', ')})`;
}

// Tag einer Partition aus ihrem Namen (pmax und Unbekanntes: null)
export function partitionDay(name: string): number | null {
  const m = /^p(\d{4})(\d{2})(\d{2})$/.exec(name);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
}
