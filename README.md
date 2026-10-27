# OnYourSite

Deine eigene Link-in-Bio-Seite unter `name.on-your.site` oder `on-your.site/name` – in PHP, ohne Framework.

## Funktionen

| | |
|---|---|
| **Links & Social-Icons** | Beliebig viele Links mit automatisch passendem Symbol, dazu Icons für Instagram, TikTok, YouTube, Twitch, Discord und 22 weitere. |
| **Videos, Musik & Bilder** | YouTube, Twitch und Spotify direkt auf der Seite (laden erst nach Antippen – datenschutzfreundlich), dazu Bilder, Überschriften und Text. |
| **25 Designs** | TRS-Design als Standard, dazu Glas, Brutal, Candy, Zen, Code, Café und mehr – und besondere Vorlagen wie Galaxie, Notizbuch, Comic, Ozean oder Mitternacht. |
| **Live-Vorschau** | Rechts im Editor siehst du sofort, wie deine Seite auf dem Handy aussieht – erzeugt vom selben Code wie die echte Seite. Designs und Anordnungen wechseln schon beim Drüberfahren. |
| **Statistik ohne Cookies** | Aufrufe und Klicks je Link – ohne Cookies, ohne IP-Adressen, ohne Cookie-Banner. |
| **Zwei Adressen** | `on-your.site/name` oder `name.on-your.site` – du wählst, die andere leitet weiter. |
| **Zeitsteuerung** | „Jetzt live“ nur freitags 18–23 Uhr? Blöcke erscheinen und verschwinden automatisch. |
| **13 Anordnungen** | Knöpfe, breite Karten, Kacheln, App-Raster, Zeitstrahl, Wolke, zwei Spalten, Baum, Bento, Karussell, Polaroid, Magazin, Stapel. |
| **Effekte** | Animierter Ring ums Profilbild, Glanz/Wackeln/Pulsieren für einzelne Links, Schnee, Konfetti oder Glühwürmchen und Funken hinter dem Mauszeiger. |
| **Geschützte Links** | Einzelne Links nur mit Passwort oder nach „Ab 18“-Bestätigung. Die Zieladresse steht nie im Quelltext. |
| **Bis zu 3 Seiten** | Eigene Adresse und Statistik je Seite, umschaltbar im Editor. |
| **Wochenbericht** | Auf Wunsch jeden Montag eine Mail mit Aufrufen, Klicks und dem besten Link. |
| **Eingang mit Musik** | Besucher tippen zum Betreten, die Seite öffnet sich mit Animation und die Musik startet. |
| **Countdown & Galerie** | Countdown bis zum nächsten Release, Bildergalerie zum Wischen. |
| **Kontaktformular** | Mit Spamschutz (unsichtbare Falle, Zeitprüfung, Inhaltsfilter) und Hinweis über die Glocke. |

Bestehendes bleibt: eingebauter Terminkalender (`/kalender`), Datei-Download (PDF/vcf), SEO-Angaben, eigenes CSS, Branding ausblenden (Premium), Discord-ID, Admin-Panel mit „Als Nutzer einloggen“ und Newsletter.

## Update einer bestehenden Installation (Plesk)

1. **Backup** von Datenbank und Dateien machen.
2. Neue Dateien hochladen bzw. per Git deployen. `static/uploads/` (Bilder deiner Nutzer) und `email/smtp.json` sind nicht im Repo und bleiben auf dem Server unverändert.
3. **`config.php` anlegen:** `config.example.php` kopieren und ausfüllen
   - `db`: Werte aus deiner alten `db.php`
   - `aes_key`: **exakt** der alte Wert aus `security.php` (`AES_256_KEY`) – sonst sind Discord-IDs und Termin-Anfragen nicht mehr lesbar
   - `app_secret`: neuen Zufallswert erzeugen, z. B. `php -r "echo bin2hex(random_bytes(32));"`
4. Die Startseite einmal aufrufen. Beim ersten Aufruf legt OnYourSite die neuen Tabellen an und übernimmt alle bestehenden Profile automatisch (Links inkl. Klickzahlen, Design, Termin-Button, Datei, „Über mich“-Text). **Alte Tabellen werden nicht gelöscht.**
5. Wochenbericht einrichten: Plesk → *Geplante Aufgaben* → *PHP-Skript ausführen* → `cron/weekly_report.php`, Zeitplan montags 8:00 (`0 8 * * 1`).

Voraussetzungen: PHP 7.4 oder neuer (8.x empfohlen) mit PDO MySQL, OpenSSL, mbstring, fileinfo und GD (mit WebP); Wildcard-DNS und -SSL für `*.on-your.site` wie bisher.

> **Wichtig:** Bisher konnte `email/smtp.json` (mit dem SMTP-Passwort) direkt über `https://on-your.site/email/smtp.json` abgerufen werden. Das ist jetzt gesperrt (`.htaccess`). Bitte prüfe, ob die Datei bei dir erreichbar war, und **ändere vorsichtshalber das Passwort des Mail-Kontos**.

## Aufbau

```
index.php              Zentrale Weiterleitung (Hauptdomain, Subdomains, /_/-Endpunkte)
config.example.php     Vorlage für config.php (Zugangsdaten – nicht im Repo)
lib/
  bootstrap.php        Lädt alles, startet die automatische Migration
  schema.php           Tabellen + Übernahme der alten Profile
  render.php           Erzeugt die Profilseite (öffentlich UND Editor-Vorschau)
  routes_app.php       Login, Registrierung, Editor-API, Admin
  routes_public.php    Zähler, Entsperren, Kontakt, Weiterleitungen – ohne Cookies
  themes.php           25 Designs und 13 Anordnungen (Namen, Farben)
  blocks.php           Blocktypen, Prüfung, YouTube/Twitch/Spotify, Zeitsteuerung
  pages.php, stats.php, spam.php, uploads.php, report.php, social.php, demo.php
views/                 Startseite, Editor (dashboard.php), Login, Admin, Kalender …
static/css/            page.css (Aufbau & Anordnungen), themes.css (25 Designs), editor.css
static/js/             page.js (Profilseite), editor.js (Editor)
static/fonts/          Selbst gehostete Schriften (keine Google-Anfragen auf Profilseiten)
cron/weekly_report.php Wochenbericht
```

## Datenschutz

Profilseiten setzen keine Cookies und laden nichts von fremden Servern (Schriften und Icons liegen lokal; YouTube, Twitch und Spotify erst nach Antippen). Statistik speichert nur Zähler pro Tag. Nachrichten aus dem Kontaktformular und Termin-Anfragen werden verschlüsselt gespeichert. Bitte passe deine Datenschutzerklärung an die neuen Funktionen an (Kontaktformular, Terminkalender, Einbettungen, Statistik).
