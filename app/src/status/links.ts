// Statusseiten: Pfade auf einer Statusseite und Ziele im Editor (ohne Doppelpunkt – notify/links.ts prüft sie)
import { withConnection } from '../db.js';
import { statusPageUrl } from './model.js';

export const incidentPath = (id: number): string => '/incidents/' + id;
export const historyPath = (page = 1): string => (page > 1 ? '/history?page=' + page : '/history');
// Glocke und Mails: OnYourSites eigene Seite verwaltet das Team im Editor (Bereich Status, Umschalter „OnYourSite status“)
export const editorLink = (system: boolean): string => (system ? '/dashboard#status/system' : '/dashboard#status');

// Link „Status“ in Navigation und Fußzeilen der Hauptseite (Startseite, /updates, /roadmap, /suggestions): nur, wenn
// OnYourSites eigene Statusseite online ist. Fehlt die Tabelle noch (Datenbank-Update) oder schlägt die Abfrage fehl,
// gibt es keinen Link – die Seite selbst lädt trotzdem.
export async function systemStatusLink(): Promise<string> {
  try {
    const slug = await withConnection((db) => db.value('SELECT slug FROM status_pages WHERE is_system = 1 AND is_published = 1 ORDER BY id LIMIT 1'));
    return typeof slug === 'string' && slug !== '' ? statusPageUrl(slug) : '';
  } catch {
    return '';
  }
}
