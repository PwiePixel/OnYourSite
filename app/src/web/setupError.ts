// Fehlerseite bei fehlender Einrichtung (oys_setup_error in lib/config.php): 503, Titel und Text als fertiges HTML
import type { Ctx } from './ctx.js';

export function setupErrorPage(title: string, text: string): string {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Setup | OnYourSite</title></head>'
    + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#d4d4d8;font-family:system-ui,sans-serif;padding:24px">'
    + '<div style="max-width:560px;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px">'
    + '<h1 style="color:#fff;font-size:20px;margin:0 0 12px">' + title + '</h1>'
    + '<p style="line-height:1.6;margin:0">' + text + '</p></div></body></html>';
}

export function setupError(ctx: Ctx, title: string, text: string): never {
  ctx.removeHeader('Content-Type');
  ctx.header('Content-Type', 'text/html; charset=utf-8');
  ctx.send(setupErrorPage(title, text), 503);
}

// Datenbank nicht erreichbar (db.php). Die Zugangsdaten stehen in der Node-Version in config.json.
export const DB_FAILED_TITLE = 'Database connection failed.';
export const DB_FAILED_TEXT = 'Please check the credentials in <code>config.json</code>.';
