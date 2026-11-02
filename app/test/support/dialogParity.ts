// Vergleiche mit der PHP-Referenz: Die eigenen Dialoge (custom-dialogs) ändern die Seiten absichtlich – Tags für ui.css
// und ui.js, Bestätigungen für Formulare statt confirm(), eigene Fehlertexte für Felder. Diese Zusätze werden vor dem
// Vergleich entfernt (Node) bzw. die alten Browser-Bestätigungen (PHP); alles andere muss weiter Byte für Byte gleich sein.

const V = '\\?v=[0-9a-f]+';
// Kopf der App-Seiten: uiAssets('app') vor </head>
const APP_HEAD = new RegExp(`\\n {4}<link rel="stylesheet" href="/static/css/ui\\.css${V}">\\n {4}<script src="/static/js/ui\\.js${V}" defer></script>(?:\\n {4}<style>:root \\{ --ui-toast-top: \\d+px; \\}</style>)?(?=\\n</head>)`, 'g');
// Profilseite: vor page.js; einfache Seiten (Kalender, Passwort-Abfrage): vor </head>
const PAGE_SCRIPT = new RegExp(`<script src="/static/js/ui\\.js${V}" defer></script>(?:\\n(?=<script src="/static/js/page\\.js)|(?=</head>))`, 'g');

// Node-Ausgabe ohne die Zusätze der eigenen Dialoge
export function withoutDialogs(html: string): string {
  return html
    .replace(APP_HEAD, '')
    .replace(PAGE_SCRIPT, '')
    // Bestätigungen (confirmAttrs/confirmField) und Hinweise für Felder
    .replace(/ data-confirm(?:-[a-z]+)?="[^"]*"/g, '')
    .replace(/<input type="hidden" name="_confirmed" value="0" autocomplete="off">/g, '')
    .replace(/ data-error-[a-z]+="[^"]*"/g, '')
    .replace(/ data-match="[^"]*"/g, '')
    .replace(/ data-field(?=[ >])/g, '');
}

// PHP-Ausgabe ohne die Bestätigungen des Browsers (onsubmit="return confirm(…)", onclick="return confirm(…)")
// und ohne data-confirm (das PHP schon für „Log in as …“ hatte)
export function withoutNativeConfirms(html: string): string {
  return html
    .replace(/ on(?:submit|click)="return confirm\((?:[^"\\]|\\.)*\);?"/g, '')
    .replace(/ data-confirm(?:-[a-z]+)?="[^"]*"/g, '');
}
