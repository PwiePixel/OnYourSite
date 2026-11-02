// static/js/ui.d.ts – Vertrag für window.OYSUI (eigene Dialoge, Hinweise, Formulare). Nur additive Änderungen.
//
// Die Bibliothek static/js/ui.js zeichnet jedes Fenster und jeden Hinweis der Seite selbst – kein alert(), confirm(),
// prompt(), keine Prüf-Blasen des Browsers und keine Browser-Benachrichtigungen. Diese Datei wird nicht geladen; sie
// ist die abgestimmte Schnittstelle für alle Funktionen, die Dialoge oder Hinweise brauchen (Honigwaben-Shop,
// Code-Seiten, eigene Domains, Statusseiten, Discord). Neue Felder dürfen dazukommen, bestehende ändern sich nicht.
// ui.js warnt in der Konsole bei unbekannten Optionen (z. B. confirmLabel, danger, expect aus älteren Entwürfen).
//
// Laden: Tags aus app/src/views/partials/ui.ts – uiAssets('app') auf App-Seiten (ui.css + ui.js),
// uiAssets('page') auf Profil- und einfachen Seiten (nur ui.js; das Aussehen kommt aus page.css und dem Theme).
// ui.js wird mit defer geladen. Skripte, die OYSUI nutzen, laufen ebenfalls mit defer oder nach DOMContentLoaded.
//
// ---------------------------------------------------------------------------------------------------------------
// Grundregeln
// ---------------------------------------------------------------------------------------------------------------
// - Texte: title, text, list, label und alle Hinweistexte sind reiner Text (textContent). ui.js liest nie einen Text
//   als HTML. Knöpfe, Preisboxen oder Links gehören in content (ein Knoten oder ein Builder), nie in text.
// - Ein content-Builder ist Code der aufrufenden Seite: DOM bauen oder HTML nur aus maskierten Werten (esc()).
// - Ebenen: höchstens 5 (Dialoge und registrierte Overlays). Ein 6. Dialog antwortet sofort wie „Abbrechen“
//   (false / null) und warnt in der Konsole; layer() gibt dann null zurück.
// - Escape, ✕ und die Zurück-Geste (CloseWatcher) schließen nur die oberste Ebene (= Abbrechen). Während einer Anfrage
//   in onConfirm (busy) wird nichts geschlossen. Ein Klick auf den Hintergrund bricht alert/confirm/choice ab, nicht aber
//   prompt und Dialoge mit Feldern.
// - Fokus: beim Öffnen auf das Eingabefeld (prompt), auf „Abbrechen“ (Ton warn/danger) oder auf den Hauptknopf; beim
//   Schließen zurück auf das auslösende Element (sonst fallbackFocus()).
// - Hinweise (Toasts): höchstens 4 sichtbar, weitere warten (keiner geht verloren); gleicher Text und Ton innerhalb von
//   2 s erneuert den vorhandenen Hinweis; gleiche id ersetzt ihn. Text höchstens 300 Zeichen.
//   Dauer: ok/info/hc 3000 ms, warn 5000, err 5200, mit Aktion mindestens 8000, 0 = bleibt bis zum Schließen.
//   Solange eine Ebene offen ist, schließt ein Klick auf einen Hinweis ihn nur; Links und Aktionen warten.
// - Notices vom Server: immer oberste Ebene der JSON-Antwort, notices: Notice[] – höchstens 3 je Antwort, höchstens
//   12 beim Start des Editors (dort nur, was beim Laden verdient wurde). Nur OYSUI.handle() und der Start des Editors
//   zeigen sie (über OYSUI.notices()); Funktionen zeigen notices nie selbst an.
// - Links (openLink, Hinweis-Aktionen, Glocke): nur eigene Pfade – ^/(?!/)[A-Za-z0-9/_.~%#?=&-]*$, höchstens
//   255 Bytes und dieselbe Herkunft. Ziele im Editor: /dashboard#<ziel>[/<argument>], z. B. #honeycombs/premium,
//   #settings/domain, #status/system – Argumente immer mit „/“, nie mit „:“. Im Admin: /admin#<tab>.
// - Navigation: eine Wache je Seite (OYSUI.guard()). Skripte mit Wache wechseln die Seite nur über guard.navigate()
//   und guard.reload() – kein location.href =, kein location.reload() (Prüfskript tools/check-native-dialogs.mjs).
// - Farben der Honigwaben: --hc, --hc-2, --hc-text, --hc-soft, --hc-line (static/css/ui.css, auf allen App-Seiten).
//
// ---------------------------------------------------------------------------------------------------------------
// Attribute für Formulare vom Server (ohne eigenes Skript)
// ---------------------------------------------------------------------------------------------------------------
// | Attribut                    | an                     | Bedeutung                                                     |
// |-----------------------------|------------------------|---------------------------------------------------------------|
// | data-confirm                | form oder Absendeknopf | Titel des Dialogs; schaltet die Rückfrage ein (Knopf vor Form) |
// | data-confirm-text           | 〃                     | Erklärung (reiner Text)                                       |
// | data-confirm-ok             | 〃                     | Beschriftung des OK-Knopfs                                    |
// | data-confirm-tone           | 〃                     | warn · danger · hc                                            |
// | data-confirm-match          | 〃                     | Wert, der getippt werden muss (Bestätigen durch Tippen)       |
// | data-confirm-label          | 〃                     | Feldbeschriftung, sonst „Type {match} to confirm“             |
// | data-confirm-normalize      | 〃                     | trim · lower · slug · host (Vergleich und Ergebnis)           |
// | data-confirm-into           | 〃                     | Feldname, der den getippten Wert bekommt (fehlt er: hidden)   |
// | hidden _confirmed           | form                   | confirmField(): „0“, ui.js setzt „1“ – der Server lehnt alles  |
// |                             |                        | andere ab (ohne ui.js passiert nichts)                        |
// | data-guard="off"            | form oder Link         | die Wache fragt hier nicht (auch kein Fenster des Browsers)   |
// | data-error-<key>            | Feld                   | eigener Text für required, type, short, long, min, max, step, |
// |                             |                        | number, pattern, match                                        |
// | data-match="otherName"      | Feld                   | muss dem genannten Feld gleichen                              |
// | data-field                  | Hülle um ein Feld      | Fehlertext steht nach der Hülle (z. B. Adresse + .on-your.site)|
// | data-flash="ok|err"         | Hinweis-Banner         | wird zum Toast (ok 5 s, err bleibt) und das Banner entfernt   |
//
// Ablauf beim Absenden: Der Browser prüft die Felder (eigene Meldungen unter dem Feld, keine Blasen). Hat das Formular
// einen beforeSubmit-Handler oder tragen Knopf oder Formular data-confirm, wird gefragt; bei OK setzt ui.js
// _confirmed = 1 und sendet einmal neu – mit dem gedrückten Knopf (name/value). Danach bleiben die Absendeknöpfe bis
// zur nächsten Seite gesperrt (kein doppelter Newsletter). Formulare mit _confirmed, die für den gedrückten Knopf
// keine Frage haben, bekommen _confirmed = 1 ohne Dialog.
//
// Standardtexte: "OK", "Cancel", "Close", "Confirm", "Dismiss", "Something went wrong. Please try again.",
// "+N more notifications", "+N more", "Type {match} to confirm", "Please check “{label}”.",
// "Nothing was changed. Please confirm in the dialog – if no dialog appears, reload the page." (Server).

export type DialogTone = 'default' | 'warn' | 'danger' | 'hc';
export type ToastTone = 'ok' | 'info' | 'warn' | 'err' | 'hc';
export type Values = Record<string, string | boolean>;            // benannte Felder im Dialog
export type Content = Node | ((body: HTMLElement, ctl: Ctl) => void);
export type Normalize = 'trim' | 'lower' | 'slug' | 'host' | ((s: string) => string);

export interface Ctl {                                            // an content-Builder und onConfirm übergeben
  readonly body: HTMLElement;
  values(): Values;                                               // checkbox → boolean, radio → gewählter Wert, sonst .value
  update(p: { title?: string; text?: string; list?: string[]; tone?: DialogTone; ok?: string;
              okDisabled?: boolean; content?: Content }): void;   // Dialog bleibt offen, Fokus bleibt im Dialog
  message(text: string, kind?: 'err' | 'info'): void;             // Zeile über den Knöpfen; '' leert sie
  error(text: string): void;                                      // = message(text, 'err')
  close(): void;                                                  // wie Abbrechen
}
export type OnConfirmResult = void | true | false | string;       // void/true: schließen · false: offen · string: Fehler, offen

export interface DialogOptions {
  title?: string; text?: string; list?: string[]; tone?: DialogTone;
  icon?: string;                                                  // Boxicons-Klasse (App-Seiten), z. B. 'bx-trash'
  ok?: string; cancel?: string;
  content?: Content;                                              // eigener Inhalt (Preisbox, Checkboxen …)
  canConfirm?(values: Values): boolean;                           // nach jeder Eingabe; false = OK gesperrt
  onConfirm?(value: any, ctl: Ctl): OnConfirmResult | Promise<OnConfirmResult>;
                                                                  // value: confirm → Values, prompt → Text, choice → Wert
                                                                  // während des Promise: busy (Spinner, Knöpfe gesperrt);
                                                                  // ein Fehler zeigt "Something went wrong. Please try again."
  focus?: 'ok' | 'cancel' | 'input' | string;                     // string = Selektor im Dialog
  fallbackFocus?(): HTMLElement | null;                           // falls der Auslöser beim Schließen fehlt
}
export interface PromptOptions extends DialogOptions {
  label?: string; value?: string; placeholder?: string; type?: 'text' | 'email' | 'url' | 'password';
  maxLength?: number; inputMode?: string; autocomplete?: string;
  match?: string; matchLabel?: string;                            // Tippen zum Bestätigen; verglichen nach normalize.
                                                                  // Beschriftung „Type {matchLabel ?? match} to confirm“,
                                                                  // label ersetzt sie ganz
  normalize?: Normalize;                                          // für Vergleich und Ergebnis (Standard 'trim')
  transform?: 'lower' | 'slug' | ((s: string) => string);         // ändert das Feld beim Tippen
  validate?(v: string): string;                                   // '' = gültig, sonst Fehlertext (Dialog bleibt offen)
}
export interface ChoiceOptions extends DialogOptions {
  options: { value: string; text: string; tone?: DialogTone; primary?: boolean }[];   // 2–3 Knöpfe; ✕/Escape → null
}
export interface SubmitConfirm extends PromptOptions { into?: string }   // Feldname für den getippten Wert

export interface Notice {                                         // Server → Client, immer oberste Ebene: notices[]
  tone: ToastTone; text: string; title?: string;                  // text ≤ 200, title ≤ 80 Zeichen (notify/types.ts)
  amount?: number;                                                // Honigwaben mit Vorzeichen, als Abzeichen „+50“
  action?: { label: string; link: string };                       // link: eigener Pfad (siehe Grundregeln)
}
export interface ToastOptions {
  text: string; tone?: ToastTone; title?: string; amount?: number;
  action?: { label: string; link?: string; run?(): void };
  duration?: number;                                              // ms; 0 = bleibt bis zum Schließen
  id?: string;                                                    // gleiche id ersetzt den Hinweis
  icon?: string;                                                  // Boxicons-Klasse statt des Symbols des Tons (App-Seiten),
                                                                  // geprüft gegen ^bx[sl]?-[a-z0-9-]+$ (Glocke: Typ-Symbol)
}
export interface Guard {
  isDirty(): boolean;
  confirm(o?: Partial<DialogOptions>): Promise<boolean>;          // sofort true, wenn nichts ungespeichert ist;
                                                                  // „Leave without saving“ ruft onDiscard
  navigate(url: string, o?: { force?: boolean }): Promise<boolean>;   // force: ohne Frage, der Entwurf bleibt
  reload(o?: { force?: boolean }): Promise<boolean>;
}
export interface GuardOptions {
  isDirty(): boolean;
  onDiscard?(): void;                                             // nach „Leave without saving“ (Entwurf löschen)
  keepsDraft?: boolean | (() => boolean);                         // true: die ungespeicherte Arbeit liegt als Entwurf im
                                                                  // Browser – dann fragt der Browser beim Schließen des Tabs
                                                                  // nicht mehr (D19); nur false, wenn das Sichern scheitert
}
export interface OYSUI {
  alert(o: DialogOptions | string): Promise<void>;
  confirm(o: DialogOptions | string): Promise<boolean>;
  prompt(o: PromptOptions): Promise<string | null>;
  choice(o: ChoiceOptions): Promise<string | null>;
  toast(o: ToastOptions | string, tone?: ToastTone): { close(): void };
  notices(list?: Notice[], more?: { label: string; link: string }): void;      // Warteschlange, 700 ms versetzt;
                                                                  // mehr als 6: die ersten 5 und „+N more“ (Aktion more)
  handle<T extends object>(status: number, data: T): T;           // 401/419/409+reload → Sitzungsdialog (einmal);
                                                                  // data.notices → Hinweise; gibt data zurück
  layer(el: HTMLElement, o?: { labelledBy?: string; onEscape?(): void; fallbackFocus?(): HTMLElement | null }):
    { release(): void } | null;                                   // el muss direktes Kind von <body> sein
  isOpen(): boolean;
  validate(form: HTMLFormElement): boolean;                       // für Formulare mit novalidate (zeigt die Meldungen)
  beforeSubmit(form: HTMLFormElement, fn: (form: HTMLFormElement, submitter: HTMLElement | null) =>
    null | false | SubmitConfirm | Promise<null | false | SubmitConfirm>): void;   // null: ohne Frage senden · false: abbrechen
                                                                  // · undefined: die data-confirm-Attribute gelten
  guard(o: GuardOptions): Guard;                                  // eine Wache je Seite, Quellen verodert
  navigate(url: string): Promise<boolean>;                        // über die Wache, falls vorhanden
  reload(): Promise<boolean>;
  openLink(link: string): boolean;                                // nur eigene Pfade; false = abgelehnt
  onLink(fn: (url: URL) => boolean): void;                        // Seite übernimmt eigene Ziele (Tabs, Admin-Bereiche);
                                                                  // nur Ziele mit demselben Pfad und derselben Query
  normalize: { trim(s: string): string; lower(s: string): string; slug(s: string): string; host(s: string): string };
  readonly skin: 'app' | 'page';                                  // automatisch: body.oys → 'page'
}
declare global { interface Window { OYSUI: OYSUI } }
