// Statusseiten: Fehlerschlüssel einer Prüfung und ihre Texte. Gespeichert wird nur der Schlüssel (status_state.last_error,
// status_checks.error, höchstens 20 Zeichen) – nie Text der Gegenseite.

export const ERROR_KEYS = [
  'dns', 'blocked', 'connect', 'ipv6', 'timeout', 'tls', 'tls_expired', 'tls_untrusted', 'tls_name', 'status', 'keyword', 'keyword_found',
  'keyword_type', 'redirect', 'redirect_blocked', 'robots', 'hb_missed', 'hb_failed', 'internal', 'degraded', 'down',
  // Eigene Bestandteile (Prüfungen vom Typ system)
  'bot_offline', 'bot_gateway', 'bot_report', 'mail_failed', 'mail_login', 'disk_low', 'disk_full', 'job_late', 'job_failed',
] as const;
export type ErrorKey = (typeof ERROR_KEYS)[number];

export interface ErrorContext {
  timeout?: number; // Sekunden
  code?: number | null; // HTTP-Status
  since?: string; // „Oct 31, 14:05“ (Heartbeat)
}

// Text für Editor, Admin und Alarme (ohne Inhalte der Gegenseite)
export function errorText(key: string | null, c: ErrorContext = {}): string {
  switch (key) {
    case null:
    case '':
      return '';
    case 'dns':
      return 'Couldn’t find this address (DNS).';
    case 'blocked':
      return 'This address now points to a private network.';
    case 'connect':
      return 'Couldn’t connect.';
    case 'ipv6':
      return 'This site only has an IPv6 address, which our checker can’t reach.';
    case 'timeout':
      return `No answer within ${c.timeout ?? 10} s.`;
    case 'tls':
      return 'Certificate problem: the secure connection failed.';
    case 'tls_expired':
      return 'Certificate problem: expired.';
    case 'tls_untrusted':
      return 'Certificate problem: not trusted.';
    case 'tls_name':
      return 'Certificate problem: wrong name.';
    case 'status':
      return c.code ? `Answered with HTTP ${c.code}.` : 'Answered with an unexpected status.';
    case 'keyword':
      return 'The keyword wasn’t found.';
    case 'keyword_found':
      return 'The keyword was found.';
    case 'keyword_type':
      return 'Not a text response.';
    case 'redirect':
      return 'Too many redirects.';
    case 'redirect_blocked':
      return 'Redirected to an address we don’t check.';
    case 'robots':
      return 'Paused: the site’s robots.txt asks us not to check this address.';
    case 'hb_missed':
      return c.since ? `No ping since ${c.since}.` : 'No ping in time.';
    case 'hb_failed':
      return 'Your job reported a failure.';
    case 'internal':
      return 'The check couldn’t run (our side).';
    case 'degraded':
      return 'Slower than usual.';
    case 'down':
      return 'Not working.';
    case 'bot_offline':
      return 'The bot hasn’t checked in for over 3 minutes.';
    case 'bot_gateway':
      return 'The bot isn’t connected to Discord.';
    case 'bot_report':
      return 'The bot’s last report is over 25 minutes old.';
    case 'mail_failed':
      return 'Sending emails failed 3 times in a row.';
    case 'mail_login':
      return 'The mail server couldn’t be reached or refused the login.';
    case 'disk_low':
      return 'Less than 15 % disk space left.';
    case 'disk_full':
      return 'Less than 10 % disk space left.';
    case 'job_late':
      return 'A background job hasn’t run in time.';
    case 'job_failed':
      return 'A background job failed on its last run.';
    default:
      return 'The check failed.';
  }
}
