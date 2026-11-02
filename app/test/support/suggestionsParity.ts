// Vergleiche mit der PHP-Referenz: Die öffentliche Vorschlagsseite (DP-5) ergänzt die Community-Ansicht absichtlich um
// die Karte „Public suggestions page“ und je Vorschlag um Abzeichen und Zeigen/Verbergen; der Vorschlag für den Bot
// trägt zusätzlich web. Diese Zusätze werden vor dem Vergleich entfernt – alles andere bleibt Byte für Byte gleich.

// Node-Ausgabe der Community-Ansicht ohne die Zusätze der Vorschlagsseite
export function withoutPublicPage(html: string): string {
  return html
    .replace(/\n {16}<!-- Öffentliche Vorschlagsseite -->[\s\S]*?<!-- \/Öffentliche Vorschlagsseite -->/g, '')
    .replace(/<div class="mt-3 flex flex-wrap items-center gap-2" data-web>[\s\S]*?<\/div>\n {28}/g, '');
}

// JSON (Antwort oder Auftrag) ohne das Feld web eines Vorschlags
export function withoutWeb(json: string): string {
  return json.replace(/,"web":\{"notice":(?:true|false),"host":"[^"\\]*"\}/g, '');
}
