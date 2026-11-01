// Wochenbericht per E-Mail (lib/report.php, cron/weekly_report.php, /_/cron/weekly-report)
export interface WeeklyResult {
  sent: number;
  failed: number;
}

// oys_run_weekly_reports()
export async function runWeeklyReports(): Promise<WeeklyResult> {
  throw new Error('Not ported yet: weekly reports');
}
