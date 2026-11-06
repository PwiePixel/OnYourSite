# OnYourSite

Your own link-in-bio page at `name.on-your.site` or `on-your.site/name` (soon also at `name.onys.me` and `onys.me/name`) – built with Node.js and TypeScript, with an installer that sets up a whole server.

## Features

| | |
|---|---|
| **Links & social icons** | As many links as you like, each with a matching icon, plus icons for Instagram, TikTok, YouTube, Twitch, Discord and 20+ more. |
| **Videos, music & images** | YouTube, Twitch and Spotify right on your page, plus images, headings and text. |
| **35 themes** | Deep Dark (default), Glass, Brutal, Candy, Zen, Code, Café, Noir, Holo, Dune and more – for winter Snowy Night, Candy Cane, Gingerbread, Christmas Market and Frost – plus special templates like Galaxy, Notebook, Comic, Ocean, Midnight, Blueprint, Chalkboard or Sakura. |
| **Profile picture editor** | Every new profile picture opens in a crop window: drag, zoom (slider, mouse wheel or two fingers), rotate, “Show all” for wide logos, a background color for logos with a transparent background and the shape (circle, rounded, square). SVG logos are turned into a picture, animated GIFs stay as they are. “Adjust” re-opens the current picture. |
| **Live preview** | On the right side of the editor you instantly see how your page looks on a phone – rendered by the same code as the real page. Themes and layouts preview as soon as you hover over them. |
| **Stats without cookies** | Views and clicks per link – no cookies, no IP addresses, no cookie banner for your visitors. |
| **Two addresses** | `on-your.site/name` or `name.on-your.site` – you choose, the other one redirects. |
| **Scheduling** | “Live now” only on Fridays from 6 to 11 pm? Links appear and disappear automatically. |
| **13 layouts** | Buttons, wide cards, tiles, app grid, timeline, cloud, two columns – or tree, bento, carousel, polaroid, magazine and stack. |
| **Effects** | An animated ring around your profile picture, shine or wobble for single links, snow, confetti or fireflies across the page and sparks behind the mouse cursor. |
| **Protected links** | Single links only with a password (at least 6 characters) or after an “18+” confirmation. The target never appears in the page source or the API. |
| **Up to 3 pages** | One page for you, one for your project – each with its own address and stats, switchable in the editor. |
| **Weekly report** | If you like, a short email every Monday with views, clicks and your best link. |
| **Entrance with music** | Visitors tap to enter, the page opens with an animation and your music starts – an uploaded song or simply a YouTube link (video or playlist, even with a start time). |
| **Countdown & gallery** | Count down to your next release or show several images to swipe through. |
| **Contact form** | Visitors message you directly – with a spam filter (invisible trap, timing check, content filter) and a heads-up via the bell. |
| **QR code & sharing** | Every page has a QR code (download as PNG or SVG) and a share window with copy link, WhatsApp, X and Discord. Visitors get a share button on the page (can be switched off), and shared links show a preview card with picture, name and address in the colors of the page. |
| **Honeycombs** | Points for using OnYourSite: for every active day, a complete profile and every 100 page views. The team can give them out in the admin panel. Honeycombs unlock extras – starting with the code page. |
| **Code pages** | Your own website made with HTML, CSS and JavaScript at `yourname.on-your.site`, with a code editor, files, folders, your uploaded images and a preview. Unlocked with honeycombs; only for non-commercial, informational pages (Code Page Terms at `/terms/code-pages`). |
| **Updates, roadmap & suggestions** | Their own pages: the changelog at `/updates` (with an RSS feed), the roadmap at `/roadmap` – what you’re working on now, what’s up next, what comes later and what has shipped, with progress bars from real, ticked-off tasks – and, if the team turns it on, the decided suggestions of the Discord community at `/suggestions`. New updates can be announced in your Discord by the community bot or a webhook. |
| **Status page** | `status.on-your.site` shows whether the website, the database and the other parts work, with incidents, planned maintenance and their history (`/history`, `/summary.json`). A checker on the server keeps it current; the team manages it in the editor’s **Status** tab, and the bot can post incidents to Discord. |
| **Honeycomb shop** | The editor’s **Honeycombs** tab shows the balance and every booking and has a shop: spend honeycombs on extras like the code page, with offers and refunds managed by the team. |
| **Own dialogs** | Confirmations, notices and forms in the editor, the admin panel and on profile pages use OnYourSite’s own dialogs in the page’s design – no browser pop-ups. |

Everything you already had stays: the built-in booking calendar (`/kalender`), file download (PDF/vcf), SEO settings, custom CSS, “Hide branding” (premium), Discord ID, and the admin panel with “Log in as user” and newsletter.

## Your own server

One command – `curl -fsSL https://raw.githubusercontent.com/PwiePixel/OnYourSite/main/server/install.sh | sudo bash` (as root without `sudo`; a minimal Debian may need `apt install -y curl` first) – sets up a fresh Ubuntu or Debian server with everything OnYourSite needs. It fetches it all by itself: the code from GitHub, Node.js 22 for the website (a locked-down system service) with Apache in front of it for HTTPS, MariaDB with its own database, user and password, `config.json`, a Cloudflare Tunnel (creates it, points the domain, `www` and every subdomain to it and removes old records and tunnels – the server then needs no open web ports), a Let’s Encrypt certificate for the domain and every subdomain that renews itself, a firewall, fail2ban and automatic security updates, the weekly report, a nightly backup, your admin account and – if you like – the Discord bot. `--reset` starts from scratch; data of an old server can be moved too. Step by step: [server/README.md](server/README.md).

Requirements: Node.js 22, MariaDB (or MySQL), wildcard DNS and a wildcard certificate for `*.on-your.site` – the installer takes care of all of it. 1 GB of RAM is enough, 2 GB are recommended.

## Updating

```bash
sudo bash /var/www/onyoursite/server/install.sh --update
```

A backup comes first; then the new version is built and checked next to the running one, and only then the website switches over (a restart of a few seconds). If the new version doesn’t work, the previous one comes back by itself. Details and how to restore a backup: [server/README.md](server/README.md#update).

### Coming from 2.x (PHP)

Since 3.0, OnYourSite runs on Node.js only; the PHP version isn’t part of it any more (the branch `php-2.x` keeps its last state).

- **On a server set up with `server/install.sh`**, the same command moves it: the PHP website keeps running until the Node.js version is built and checked with the data of the server, `config.php` becomes `config.json` (same keys, read without PHP), and afterwards PHP is turned off and can be removed. Everyone has to log in once more – passwords, pages and everything else stay. Details: [Moving from 2.x (PHP) to 3.0 (Node.js)](server/README.md#moving-from-2x-php-to-30-nodejs).
- **On Plesk or other PHP hosting**, 3.0 can’t run. Set up your own server with the installer and move your data: `config.php` (above all `aes_key` – without it, encrypted data can’t be read), the database dump, the uploads ZIP (*Admin → Storage & backups*) and `email/smtp.json` – see [Moving data from an old server](server/README.md#moving-data-from-an-old-server-optional).

## Limits

Uploads: photos are already resized in the browser. Music for the “Entrance with music” can be up to 15 MB (uploads up to 16 MB). Each account has 200 MB of storage (premium/admin: 1 GB); files that were uploaded but never saved are removed automatically after two days.

The built-in booking calendar (`/kalender`) is only reachable if the page has a visible booking block that points to it – if that block is protected, the calendar only opens after the password has been entered.

## Uploads & backups

Everything your users upload (profile pictures, backgrounds, gallery images, music, files) is stored in **one folder**. The admin panel shows which one under **Storage & backups**.

- **On a server set up with the installer:** `/var/lib/onyoursite/uploads` (`uploads_dir` in `config.json`) – outside the code folder, so updates never touch it.
- **Without the installer** (e.g. on your computer) the default is `static/uploads/` inside the code folder. Git never touches it (it’s in `.gitignore`), but if you replace the whole folder, the uploads go with it. To keep them elsewhere, set the folder in `config.json` and restart the website:

  ```json
  "uploads_dir": "/srv/oys-uploads"
  ```

  Then open **Admin → Storage & backups** and click **Move files** once. The addresses of all images stay the same (`/static/uploads/…`), so no page has to be changed and nobody has to upload anything again. A relative path (e.g. `"../oys-uploads"`) is resolved from the code folder.

**What to back up:** the database, the upload folder, `config.json` (database password and the encryption key – without the key, encrypted data can’t be read) and the folder `email/` (mail server settings and newsletter templates). On a server set up with the installer, this happens every night – see [Backups](server/README.md#backups). **Admin → Storage & backups → Download all uploads (ZIP)** gives you the upload folder as one file. To restore, put the four back the same way – the uploads go into the upload folder shown in the admin panel.

## Honeycombs & code pages

**Honeycombs** are points users collect by using OnYourSite: for every day they open the editor, once for a complete profile (profile picture, bio and at least 3 links) and for every 100 page views (one reward a day, up to 20 times – so faked views don’t pay off). Every booking is stored once in `honeycomb_ledger` – nothing can be earned twice, and nothing is earned while an admin is logged in as the user. **Admin → Honeycombs** has its own tabs: *Overview*, *Catalogue & prices* (what each item costs – the code page: 100 by default), *Offers* (time-limited discounts), *Earning rules* (what each reward is worth; 0 switches it off) and *Users*, where you give honeycombs (or take them away) with a note the user sees. Every admin change is kept in an audit log. Users spend honeycombs in the editor’s **Honeycombs** tab; every purchase and refund is booked once in the ledger, so nothing can be bought or refunded twice. Premium (custom domain, no OnYourSite branding) stays hidden until custom domains are ready on the server.

**Code pages** are websites users write themselves in HTML, CSS and JavaScript (plus JSON, SVG, XML, text, Markdown): up to 30 files, 256 KB per file and 2 MB per page, stored in the database. They are served at `name.on-your.site` (`on-your.site/name` redirects there) and share the address list with link pages. **No server code is ever executed** – OnYourSite only delivers the files, and every response carries `Content-Security-Policy: sandbox …` without `allow-same-origin`: the page runs in its own anonymous origin and can’t read cookies, storage or anything else from OnYourSite. A small “OnYourSite” badge links to the rules and the report section. Before users can unlock or create a code page, they have to accept the Code Page Terms (`/terms/code-pages`, file `app/src/code/terms.ts`): non-commercial, informational and promotional pages only – no shops, payments, donations or ads. **Admin → Code pages** lists every code page: you can open it and block it with a reason (visitors then get a notice, the user sees why), unlock code pages for someone for free and see who has access; deleting a user also deletes their code page, honeycombs and remaining uploads.

Code pages only answer `GET` and `HEAD`, and names used by mail and network auto-configuration (`autoconfig`, `autodiscover`, `mta-sts`, `wpad` …) can’t be taken as addresses. While a code page is offline, visitors get a notice; its owner still sees the page in the editor preview, which carries a signed preview key. **Don’t set a server-wide `Content-Security-Policy` header** (e.g. in the Apache configuration) – it would replace the sandbox header of the code pages.

> Code pages are user content on subdomains of your main domain. If you ever want to separate them completely (like GitHub does with `github.io`), a second domain just for code pages would be the next step.

## Discord bot

The folder `discord-bot/` contains a small Node.js bot for the community server: welcome messages, a suggestion forum whose posts are saved on the website (accept or decline them in Discord or under **Admin → Community** – both stay in sync) and support tickets in private channels that you can read and answer on the website. It talks to the website at `/_/bot/…` with signed requests (`bot_secret` in `config.json`); without the secret, these endpoints don’t exist. Ticket messages are stored encrypted and tickets are never public. Suggestions the team has decided can be shown on `/suggestions`, without names, when the admin turns that page on under **Admin → Community** (it starts off). The admin panel and endpoints are kept out of search engines. Setup: `discord-bot/README.md`.

## Updates, roadmap & Discord

Everything is managed in the admin panel (`/admin`):

- **Updates** – write a post with title, optional version, category (New, Improved, Fixed, News) and text. The text uses the same formatting as Discord: `**bold**`, `*italic*`, `- lists`, `[text](https://…)`, `` `code` ``. Save it as a draft or publish it right away; the date can be changed for older entries. Published updates appear at `/updates` and in the RSS feed `/updates/feed.xml`.
- **Roadmap** – milestones with a status (*Working on now*, *Up next*, *Later*, *Shipped*), a rough target like “Q1 2027” and tasks (one per line, `[x]` = already done). Tick tasks off and the progress bar on `/updates` moves. When a milestone is done, set it to *Shipped* and use “Write an update about it”. Milestones can be hidden from the public page.
- **Discord** (*Admin → Discord*) – updates are posted in one of two ways:
  - **With the bot (recommended):** the community bot the installer sets up (see [Discord bot](#discord-bot)) posts in a channel you pick from the list it reports, optionally with a ping (a role, `everyone` or `here`). It runs on your server with its own login – no token is ever entered in the admin panel. If the bot isn’t installed or is outdated, the card says how to set it up or update it.
  - **With a webhook:** in Discord open the channel settings → *Integrations* → *Webhooks* → *New Webhook* → *Copy Webhook URL*, paste it in the admin panel and click “Send test”. A webhook can post in a channel, a forum or a thread, with an optional display name, avatar and ping.

  Whether an update gets announced is decided per update (“Announce on Discord when published” – the default is under *Defaults*); already published updates can be announced later with “Post to Discord”. Editing a published update also edits its Discord message (without pinging again); moving it back to drafts or deleting it removes the message. The **Discord posts** list shows every message with its state; if Discord can’t be reached, the website or the bot tries again and the list says what went wrong – nothing is lost, and “Remove from Discord” on the draft cleans up by hand. Webhook links are stored encrypted and never shown again. A bot token from the old setup gets its own card: switch to the bot or a webhook and the token is deleted from the website.

Every update has a permanent link `/updates/<number>` – Discord posts and the feed use it, so it keeps working when older updates move to page 2. The roadmap has its own page at `/roadmap`, and `/suggestions` appears once the team turns it on under **Admin → Community**; the three pages link to each other. After the update to 3.1, the release notes of versions 2.0 to 2.2 are published on `/updates` and listed under “Shipped” while the roadmap is still empty (drafts you changed and versions you entered yourself stay as they are). The notes for 3.0 and 3.1 wait as drafts – read them and publish them with one click. Only 3.1 is announced on Discord when published; use “Post to Discord” if you want 3.0 there too.

## Beta

`beta.on-your.site` is the beta area: beta testers log in with their OnYourSite account (same database, same password; the session is its own on that address) and get a panel with what to test right now, a form for bug reports and ideas, and their reports with the team's status and reply. *Admin → Beta* adds and removes testers (only accounts with a linked Discord ID – the user sets it in the editor under Settings), answers reports and edits the "What to test right now" text. The Discord bot gives testers the **Beta Tester** role (feature `beta.v1`; it creates the role if needed, `BETA_ROLE_ID` in the bot's `.env` picks an existing role) and takes it away again; when a tester changes their Discord ID, the role moves with it. `on-your.site/beta` leads to the beta area. The code is in `app/src/beta/` and `discord-bot/src/beta.js`.

**The beta website.** The panel lives at `beta.on-your.site/_beta/`; every other address on `beta.on-your.site` is the **beta website** – a second installation of OnYourSite with the pre-release (branch `beta`), running next to the main site on its own port with the same database and uploads (`install.sh --beta`, see `server/README.md`). The main site is the gate: it passes logged-in testers on to the beta website (`app/src/beta/site.ts`) and adds a small "Beta · Panel" note to its pages; everyone else lands at the panel. The session is shared (the sessions table is in the same database), so testers are logged in on the beta website right away. The beta website runs with `beta_build: true` and `base_domain` `beta.on-your.site` and doesn't run background tasks. Its new schema steps change the real database at once – they keep the number they'll have on `main` (the main site skips steps it already finds). On the beta website every page opens by path (`beta.on-your.site/name` – there is no `name.beta.on-your.site`); links it creates (mails too) point to `beta.on-your.site`, so do admin work on the main site.

## Seasons

The winter look shows the logo with a Santa hat (`static/images/seasons/logo-winter.png`, the owner's artwork) on every own page: the pages with the whole theme load `static/css/season-winter.css` and `season-winter-logo.css`, the editor, the admin area and the beta panel only `season-winter-logo.css` (`ctx.logoPage`, `applyLogoSeason()` in `app/src/seasons/seasons.ts`).

*Admin → Seasons* decorates OnYourSite’s own pages for a season – the home page, log in and sign up, updates, roadmap, suggestions, the legal pages and the 404 page; users’ pages, the editor and the admin panel stay as they are. Each theme is **Off**, **On** or **Automatic** (every year between two dates, e.g. `12-01` to `01-06`), and *Preview* opens the home page with the theme without turning it on. The first theme is **Winter** (falling snow, fairy lights along the top, a Santa hat on the logo, a frosty glow, icy blue accents; CSS only in `static/css/season-winter.css`); it starts as Automatic from December 1 to January 6. New themes are added in `app/src/seasons/seasons.ts`.

## Development

You need Node.js 22 and MariaDB (or MySQL).

1. Create a database and a user for it.
2. Put a `config.json` next to this README (it is in `.gitignore`; `OYS_CONFIG` can point to another file):

   ```json
   {
     "db": { "host": "127.0.0.1", "name": "onyoursite", "user": "onyoursite", "pass": "…" },
     "aes_key": "…",
     "app_secret": "…",
     "base_domain": "oys.test:3000",
     "scheme": "http",
     "timezone": "Europe/Berlin",
     "max_pages": 3
   }
   ```

   `aes_key` and `app_secret` are random values like the installer makes them: `openssl rand -hex 16` (32 characters – the key uses at most 32) and `openssl rand -hex 32`. Keep `aes_key`: without it, encrypted data can’t be read. `base_domain` is the address you open in the browser: point `oys.test` and the subdomains you need (`yourname.oys.test` …) to `127.0.0.1` in your hosts file.
3. Start the website:

   ```bash
   cd app
   npm ci
   npm run dev      # http://oys.test:3000 – creates the tables on the first start
   ```

   `PORT` changes the port. With `OYS_DEV=1`, changed CSS and JavaScript files get a new `?v=` right away. Sign up at `/register`; the first admin account comes from `OYS_NAME=… OYS_EMAIL=… OYS_SLUG=… OYS_PASSWORD=… node --import tsx src/cli.ts create-admin`.
4. `npm run check` checks the types, `npm run build` builds into `app/dist` – that’s what the server runs (`npm start`, the installer does it for you).

### Tests

```bash
cd app
npm test
```

The tests read `config.json` too – give them one of their own, never the settings of a live site: `"base_domain": "oys.test:8080"`, `"scheme": "http"` and a database only for tests. They create and drop more databases next to it, named after it (`<name>_…`), so its user needs the right to create databases with that prefix – for `"name": "oys_test"`: ``GRANT ALL ON `oys\_test%`.* TO 'oys'@'localhost'``. Mail and Discord are replaced by stand-ins the tests start themselves – nothing leaves your computer.

**Comparisons with the PHP version.** Many tests also compare the Node.js version with the last PHP version (2.x): pages byte for byte, mails, database rows and requests to Discord. They need PHP 8 on the command line (with pdo_mysql, openssl, mbstring, fileinfo, gd with WebP, curl and exif) and a checkout of the branch `php-2.x`, named in `OYS_PHP_REF`:

```bash
git worktree add --detach ~/oys-php-2.x origin/php-2.x   # once
cd app && OYS_PHP_REF=~/oys-php-2.x npm test
```

Without `OYS_PHP_REF`, these tests are skipped with a note (“compares with the PHP version – set OYS_PHP_REF to a checkout of the branch php-2.x”); everything else runs without PHP. The PHP checkout is only read – the tests copy what they need into temporary folders.

## Structure

```
app/                   The website (Node.js 22, TypeScript, Fastify)
  src/server.ts        Starts the web server
  src/router.ts        Central router (main domain, subdomains, /_/ endpoints)
  src/schema.ts        Tables and the automatic database updates
  src/content/         Profile pages: rendering, themes and layouts, blocks, social icons, stats, uploads, share cards (/_/og/…png), demo pages
  src/app/             Home page, login and sign-up, editor and its API, weekly report, legal pages
  src/admin/           Admin panel: users, newsletter and mail server, storage & backups
  src/public/          Counters, unlocking, contact, redirects (/_/…), the JSON API, the 404 page and the booking calendar
  src/updates/         Changelog and roadmap pages, the admin for both, Markdown
  src/discord/         Posting updates to Discord: settings, the bot and webhook delivery, the posts list
  src/honeycombs/      Honeycombs: earning, giving, ledger, shop, offers, refunds, Premium
  src/code/            Code pages: files, limits, slots, delivery in the sandbox, Code Page Terms
  src/status/          Status pages: checker, notifier, incidents and maintenance, the public page
  src/seasons/         Season themes for OnYourSite’s own pages and Admin → Seasons
  src/beta/            The beta area (beta.<domain>), Admin → Beta, the Beta Tester role via the bot
  src/domains/         Custom domains (Premium): host routing, records and the domain worker (Cloudflare for SaaS)
  src/notify/          Notifications for the bell
  src/community/       Discord bot connection: suggestions, support tickets, queue for the bot
  src/web/             Requests, sessions, form protection, static files
  src/cli.ts           Command line for the server: database updates, checks, first admin, certificate warning, weekly report
  scripts/config.mjs   Reads and writes config.json for the installer
  test/                Tests (npm test)
email/                 Email templates; the mail server settings (smtp.json) are written by the admin panel
static/css/            page.css (structure & layouts), themes.css (35 themes), editor.css
static/js/             page.js (profile page), editor.js (editor), share.js (QR code & sharing), ui.js (dialogs), bell.js (notifications), status.js / status-manage.js (status pages)
static/vendor/qrcode/  QR code generator (qrcode-generator, MIT)
static/vendor/codemirror/  Code editor for code pages (CodeMirror 5, MIT)
static/vendor/sortablejs/  Drag and drop for the block list (SortableJS 1.15.2, MIT)
static/fonts/          Self-hosted fonts (no Google requests on profile pages)
discord-bot/           Discord bot (Node.js): welcome, suggestions, support – see its README
server/                Installer for your own server (one file does everything), backup, certificate check – see server/README.md
CHANGELOG.md, VERSION  What changed in which version (GitHub releases are created from it)
scripts/               release.sh (prepare a version), publish-releases.sh (used by GitHub Actions)
.github/               Release workflow, changelog check, pull request template
```

## Releases

Every change is written down in [`CHANGELOG.md`](CHANGELOG.md) – first under **[Unreleased]**. There are two channels: **releases** for everyone (on `main`) and **pre-releases** for the beta website (on the branch `beta`).

**Pre-release** (only on `beta.on-your.site`): bring the changes to the branch `beta`, run `scripts/release.sh 3.6.0-beta.1` (it copies [Unreleased] into a section `## [3.6.0-beta.1]` – [Unreleased] stays), commit it on `beta`. GitHub publishes the tag `v3.6.0-beta.1` as a *pre-release* (never "Latest"). On the server: `sudo bash /var/www/onyoursite/server/install.sh --beta`. The entry in `releaseNotes.ts` is the one of the coming release (`3.6.0`).

**Release** for everyone:

1. Run `scripts/release.sh 3.3.0` – it moves the entries from [Unreleased] into a new section `## [3.3.0] - YYYY-MM-DD` (and drops the sections of its pre-releases) and writes the number into `VERSION`, `app/package.json` and `app/package-lock.json`.
2. Write the text for visitors: an entry for the version in `app/src/updates/releaseNotes.ts`. A few minutes after the update, it waits as a draft in *Admin → Updates* – publish it there (it is announced on Discord if the entry says so).
3. Commit and merge it into `main`.
4. GitHub creates the tag `v3.3.0` and a release with exactly these notes and the source code as a ZIP (Actions → *Release*). The installed version is shown at the bottom of the admin menu.

Pull requests without an entry in `CHANGELOG.md` get a failing *Changelog* check as a reminder (add the label `no-changelog` to skip it). The public `/updates` page is separate: it is written for visitors in the admin panel. After updating to 3.1, the release notes of 2.0 – 2.2 are published there and drafts for 3.0 and 3.1 are waiting in *Admin → Updates* – read them and publish them (only 3.1 is announced on Discord; use “Post to Discord” for 3.0 if you want it there too).

## Privacy

Profile pages and `/updates` don’t set any cookies. Profile pages don’t load anything from third-party servers (fonts and icons are hosted locally; YouTube, Twitch and Spotify only load after a tap – YouTube entrance music only after the visitor taps to enter – as a `youtube-nocookie.com` player in its own frame, without any YouTube script on the page itself). Code pages are written by their owners and may load things from elsewhere; they run in a sandbox without access to cookies or storage, and the code editor itself is hosted locally. Custom CSS can’t load external addresses either – `url(https://…)` and `@import` are removed. Stats only store counters per day, no IP addresses. To stop password guessing and spam (contact form, calendar, login), OnYourSite briefly counts attempts per sender – instead of the IP address it only uses a non-reversible key that changes daily and is deleted after one day at the latest. Messages from the contact form and booking requests are stored encrypted. Discord is only contacted – by the website or the bot on your server – when you publish, edit or delete an update or a status incident, and for the community features of the bot; no visitor data is ever sent there. Please update your privacy policy to cover the new features (contact form, booking calendar, embeds, stats).
