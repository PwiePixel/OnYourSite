// Vergleiche mit der PHP-Referenz: Die Admin-Oberfläche für den Bot (DP-2b) ändert die Ansichten absichtlich – in der
// Liste der Updates ein Chip je Ziel statt „On Discord“ und Retry/Forget, im Formular die Ziele in Worten, im
// Community-Bereich Version und Link des Bots. Diese Zusätze werden vor dem Vergleich auf die PHP-Fassung
// zurückgeführt; alles andere bleibt Byte für Byte gleich.

import { appVersion } from '../../src/version.js';

const ON_DISCORD = "<span class=\"text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-[#5865F2]/20 text-[#8b93ff] flex items-center gap-1\"><i class='bx bxl-discord-alt'></i> On Discord</span>";
const CONNECT = "<span class=\"text-gray-500 flex items-center gap-1.5\"><i class='bx bxl-discord-alt text-lg'></i> Connect Discord under <a href=\"#discord\" onclick=\"switchAdminTab('discord')\" class=\"text-brand-400 hover:text-white\">Discord</a> to announce updates.</span>";

// Community: „Version … · Discord settings“ in der Karte des Bots
export function withoutBotExtra(html: string): string {
  return html.replace(/<p class="text-xs text-gray-500 mt-1" data-bot-extra>[^\n]*<\/p>\n/g, '');
}

// Updates: Chips → „On Discord“ (wenn ein Beitrag nicht fehlgeschlagen ist), Retry/Forget weg, Formularzeile wie früher
export function withoutDiscordChips(html: string): string {
  return html
    .replace(/<span class="contents" data-discord-chips="\d+">([\s\S]*?)<\/span><\/span><\/span>/g, (_m, chips: string) =>
      (/data-state="(?!failed")/.test(chips) ? ON_DISCORD : ''))
    .replace(/<div class="contents" data-discord-actions="\d+">[\s\S]*?<\/form><\/div>/g, '')
    .replace(/On Discord \([^)]*\) – changes are synced/g, 'Already on Discord – changes are synced')
    .replace(/<span class="text-gray-500" data-discord-where> \([^<]*\)<\/span>/g, '')
    .replace(/<span class="text-gray-500 flex items-center gap-1\.5" data-discord-off>[\s\S]*?<\/a><\/span>/g, CONNECT);
}

// Gewollter Unterschied (Release-System): PHP schickt im User-Agent an Discord fest „2.2“, Node die installierte
// Version aus VERSION. Für den Vergleich bekommt die PHP-Seite die Version von Node.
export function phpUserAgent(text: string): string {
  return text.replace(/(DiscordBot \([^,()]+, )2\.2\)/g, '$1' + appVersion() + ')');
}
