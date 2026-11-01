# OnYourSite

Your own link-in-bio page at `name.on-your.site` or `on-your.site/name` – in PHP, without a framework.

## Features

| | |
|---|---|
| **Links & social icons** | As many links as you like, each with a matching icon, plus icons for Instagram, TikTok, YouTube, Twitch, Discord and 20+ more. |
| **Videos, music & images** | YouTube, Twitch and Spotify right on your page, plus images, headings and text. |
| **30 themes** | Deep Dark (default), Glass, Brutal, Candy, Zen, Code, Café, Noir, Holo, Dune and more – plus special templates like Galaxy, Notebook, Comic, Ocean, Midnight, Blueprint, Chalkboard or Sakura. |
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
| **Updates & roadmap** | A public page at `/updates` with the full changelog and a roadmap: what you’re working on now, what’s up next, what comes later and what has shipped. Progress bars come from real, ticked-off tasks – no made-up percentages. New updates can be announced in your Discord automatically. |

Everything you already had stays: the built-in booking calendar (`/kalender`), file download (PDF/vcf), SEO settings, custom CSS, “Hide branding” (premium), Discord ID, and the admin panel with “Log in as user” and newsletter.

## Your own server (without Plesk)

One command – `curl -fsSL https://raw.githubusercontent.com/PwiePixel/OnYourSite/main/server/install.sh | sudo bash` (as root without `sudo`; a minimal Debian may need `apt install -y curl` first) – sets up a fresh Ubuntu or Debian server with everything OnYourSite needs. It fetches it all by itself: the code from GitHub, Apache with PHP-FPM (the same `.htaccess`), MariaDB with its own database, user and password, `config.php`, a Cloudflare Tunnel (creates it, points the domain, `www` and every subdomain to it and removes old records and tunnels – the server then needs no open web ports), a Let’s Encrypt certificate for the domain and every subdomain that renews itself, a firewall, fail2ban and automatic security updates, the weekly report, a nightly backup, your admin account and – if you like – the Discord bot. `--reset` starts from scratch; data of an old server can be moved too. Updates later: `sudo bash /var/www/onyoursite/server/install.sh --update`. Step by step: [server/README.md](server/README.md).

## Updating an existing installation (Plesk)

1. **Back up** your database and files.
2. Upload the new files or deploy them via Git. The uploaded images and `email/smtp.json` aren’t in the repo and stay unchanged on the server – see [Uploads & backups](#uploads--backups) to keep the uploads completely out of the code folder.
3. **Create `config.php`:** copy `config.example.php` and fill it in
   - `db`: the values from your old `db.php`
   - `aes_key`: **exactly** the old value from `security.php` (`AES_256_KEY`) – otherwise Discord IDs and booking requests can no longer be read
   - `app_secret`: generate a new random value, e.g. `php -r "echo bin2hex(random_bytes(32));"`
4. Open the home page once. On the first request, OnYourSite creates the new tables and automatically migrates all existing profiles (links incl. click counts, theme, booking button, file, “About me” text). **Old tables are not deleted.**
5. Set up the weekly report: Plesk → *Scheduled Tasks* → *Run a PHP script* → `cron/weekly_report.php`, schedule Mondays at 8:00 (`0 8 * * 1`).

Requirements: PHP 7.4 or newer (8.x recommended) with PDO MySQL, OpenSSL, mbstring, fileinfo and GD (with WebP), cURL recommended for Discord; wildcard DNS and wildcard SSL for `*.on-your.site` as before.

Uploads: photos are already resized in the browser, so they fit under small server limits too. For music in the “Entrance with music” (up to 15 MB), set `upload_max_filesize` and `post_max_size` to at least `16M` in Plesk under *PHP Settings*. Each account has 200 MB of storage (premium/admin: 1 GB); files that were uploaded but never saved are removed automatically after two days.

The built-in booking calendar (`/kalender`) is only reachable if the page has a visible booking block that points to it – if that block is protected, the calendar only opens after the password has been entered.

Tests: `php tests/unit.php` (command line only) checks scheduling, embeds, addresses, the spam filter, URL validation, the update formatting, Discord links, file names of code pages and uploads, and the honeycomb texts. It only reads – nothing in the database is changed.

## Uploads & backups

Everything your users upload (profile pictures, backgrounds, gallery images, music, files) is stored in **one folder**. The admin panel shows which one under **Storage & backups**.

- **Default:** `static/uploads/` inside the code folder. Git never touches it (it’s in `.gitignore`), but if you replace the whole folder – copying in a new version or restoring a code backup – the uploads go with it.
- **Recommended:** move the uploads next to the code, so updates and code backups can never touch them. Add this line to `config.php` (Plesk: one level above `httpdocs`, the admin panel suggests the exact path):

  ```php
  'uploads_dir' => '/var/www/vhosts/on-your.site/oys-uploads',
  ```

  Then open **Admin → Storage & backups** and click **Move files** once. The addresses of all images stay the same (`/static/uploads/…`), so no page has to be changed and nobody has to upload anything again. A relative path (e.g. `'../oys-uploads'`) is resolved from the code folder.

**What to back up:** the database, the upload folder, `config.php` (database password and the encryption key – without the key, encrypted data can’t be read) and the folder `email/` (mail server settings and newsletter templates). **Admin → Storage & backups → Download all uploads (ZIP)** gives you the upload folder as one file. To restore, put the four back the same way – the uploads go into the upload folder shown in the admin panel.

## Honeycombs & code pages

**Honeycombs** are points users collect by using OnYourSite: for every day they open the editor, once for a complete profile (profile picture, bio and at least 3 links) and for every 100 page views (one reward a day, up to 20 times – so faked views don’t pay off). Every booking is stored once in `honeycomb_ledger` – nothing can be earned twice, and nothing is earned while an admin is logged in as the user. In **Admin → Honeycombs & code pages** you can give honeycombs (or take them away) with a note the user sees, change what each reward is worth and what the code page costs (default: 100), and unlock the code page for someone for free.

**Code pages** are websites users write themselves in HTML, CSS and JavaScript (plus JSON, SVG, XML, text, Markdown): up to 30 files, 256 KB per file and 2 MB per page, stored in the database. They are served at `name.on-your.site` (`on-your.site/name` redirects there) and share the address list with link pages. **No PHP or other server code is ever executed** – OnYourSite only delivers the files, and every response carries `Content-Security-Policy: sandbox …` without `allow-same-origin`: the page runs in its own anonymous origin and can’t read cookies, storage or anything else from OnYourSite. A small “OnYourSite” badge links to the rules and the report section. Before users can unlock or create a code page, they have to accept the Code Page Terms (`/terms/code-pages`, file `views/terms-code-pages.php`): non-commercial, informational and promotional pages only – no shops, payments, donations or ads. In the admin panel you can open every code page and block it with a reason (visitors then get a notice, the user sees why); deleting a user also deletes their code page, honeycombs and remaining uploads.

Code pages only answer `GET` and `HEAD`, and names used by mail and network auto-configuration (`autoconfig`, `autodiscover`, `mta-sts`, `wpad` …) can’t be taken as addresses. While a code page is offline, visitors get a notice; its owner still sees the page in the editor preview, which carries a signed preview key. **Don’t set a server-wide `Content-Security-Policy` header** (e.g. in Plesk’s *Apache & nginx Settings*) – it would replace the sandbox header of the code pages.

> Code pages are user content on subdomains of your main domain. If you ever want to separate them completely (like GitHub does with `github.io`), a second domain just for code pages would be the next step.

## Discord bot

The folder `discord-bot/` contains a small Node.js bot for the community server: welcome messages, a suggestion forum whose posts are saved on the website (accept or decline them in Discord or under **Admin → Community** – both stay in sync) and support tickets in private channels that you can read and answer on the website. It talks to the website at `/_/bot/…` with signed requests (`bot_secret` in `config.php`); without the secret, these endpoints don’t exist. Ticket messages are stored encrypted, nothing about suggestions or tickets is public, and the admin panel and endpoints are kept out of search engines. Setup: `discord-bot/README.md`.

## Updates, roadmap & Discord

Everything is managed in the admin panel (`/admin`):

- **Updates** – write a post with title, optional version, category (New, Improved, Fixed, News) and text. The text uses the same formatting as Discord: `**bold**`, `*italic*`, `- lists`, `[text](https://…)`, `` `code` ``. Save it as a draft or publish it right away; the date can be changed for older entries. Published updates appear at `/updates` and in the RSS feed `/updates/feed.xml`.
- **Roadmap** – milestones with a status (*Working on now*, *Up next*, *Later*, *Shipped*), a rough target like “Q1 2027” and tasks (one per line, `[x]` = already done). Tick tasks off and the progress bar on `/updates` moves. When a milestone is done, set it to *Shipped* and use “Write an update about it”. Milestones can be hidden from the public page.
- **Discord** – connect one of the two:
  - **Webhook link (easiest):** in Discord open the channel settings → *Integrations* → *Webhooks* → *New Webhook* → *Copy Webhook URL*, paste it in the admin panel and click “Send test”.
  - **Bot:** create an application at [discord.com/developers](https://discord.com/developers/applications) → *Bot* → copy the token, invite the bot to your server with *View Channel*, *Send Messages* and *Embed Links*, then copy the channel ID (Discord settings → *Advanced* → *Developer Mode*, right-click the channel → *Copy Channel ID*).

  Optionally ping a role, `everyone` or `here` for new posts. Whether an update gets announced is decided per update (“Announce on Discord when published” – the default comes from the Discord settings); already published updates can be announced later with “Post to Discord”. Editing a published update also edits its Discord message (without pinging again); moving it back to drafts or deleting it removes the message. If Discord can’t be reached, the admin panel says so and nothing is lost – try again, or use “Remove from Discord” on the draft. Webhook links and bot tokens are stored encrypted and never shown again in the admin panel.

Every update has a permanent link `/updates/<number>` – Discord posts and the feed use it, so it keeps working when older updates move to page 2. `/roadmap` redirects to the roadmap on `/updates`. After the update, the release notes of versions 2.0 to 2.2 are already waiting as drafts – read through them and publish them with one click. Only 2.2 is announced on Discord when published; use “Post to Discord” if you want the older ones there too.

> **Important:** Until now, `email/smtp.json` (which contains the SMTP password) could be downloaded directly via `https://on-your.site/email/smtp.json`. This is now blocked (`.htaccess`). Please check whether the file was reachable on your server and, to be safe, **change the password of the mail account**.

## Structure

```
index.php              Central router (main domain, subdomains, /_/ endpoints)
config.example.php     Template for config.php (credentials – not in the repo)
lib/
  bootstrap.php        Loads everything, starts the automatic migration
  schema.php           Tables + migration of the old profiles
  render.php           Renders the profile page (public AND editor preview)
  routes_app.php       Login, sign-up, editor API, admin
  routes_public.php    Counters, unlocking, contact, redirects – without cookies
  themes.php           30 themes and 13 layouts (names, colors)
  blocks.php           Block types, validation, YouTube/Twitch/Spotify, scheduling
  updates.php          Updates, roadmap, Markdown and Discord (webhook or bot)
  share.php            Preview card for shared links (/_/og/…png, cached in the upload folder under og/)
  storage.php          Upload folder (config: uploads_dir), delivering uploads, ZIP backup
  honeycombs.php       Honeycombs: earning, giving, spending
  codesites.php        Code pages: files, limits, delivery in the sandbox
  community.php        Discord bot connection: suggestions, support tickets, queue for the bot
  pages.php, stats.php, spam.php, uploads.php, report.php, social.php, demo.php
views/                 Home page, editor (dashboard.php), login, admin, calendar, updates …
static/css/            page.css (structure & layouts), themes.css (30 themes), editor.css
static/js/             page.js (profile page), editor.js (editor), share.js (QR code & sharing)
static/vendor/qrcode/  QR code generator (qrcode-generator, MIT)
static/vendor/codemirror/  Code editor for code pages (CodeMirror 5, MIT)
static/fonts/          Self-hosted fonts (no Google requests on profile pages)
cron/weekly_report.php Weekly report
discord-bot/           Discord bot (Node.js): welcome, suggestions, support – see its README
server/                Installer for your own server (one file does everything), backup, certificate check – see server/README.md
```

## Privacy

Profile pages and `/updates` don’t set any cookies. Profile pages don’t load anything from third-party servers (fonts and icons are hosted locally; YouTube, Twitch and Spotify only load after a tap – YouTube entrance music only after the visitor taps to enter – as a `youtube-nocookie.com` player in its own frame, without any YouTube script on the page itself). Code pages are written by their owners and may load things from elsewhere; they run in a sandbox without access to cookies or storage, and the code editor itself is hosted locally. Custom CSS can’t load external addresses either – `url(https://…)` and `@import` are removed. Stats only store counters per day, no IP addresses. To stop password guessing and spam (contact form, calendar, login), OnYourSite briefly counts attempts per sender – instead of the IP address it only uses a non-reversible key that changes daily and is deleted after one day at the latest. Messages from the contact form and booking requests are stored encrypted. Discord is only contacted by the server when you publish, edit or delete an update – no visitor data is ever sent there. Please update your privacy policy to cover the new features (contact form, booking calendar, embeds, stats).
