# OnYourSite

Your own link-in-bio page at `name.on-your.site` or `on-your.site/name` – in PHP, without a framework.

## Features

| | |
|---|---|
| **Links & social icons** | As many links as you like, each with a matching icon, plus icons for Instagram, TikTok, YouTube, Twitch, Discord and 20+ more. |
| **Videos, music & images** | YouTube, Twitch and Spotify right on your page, plus images, headings and text. |
| **30 themes** | Deep Dark (default), Glass, Brutal, Candy, Zen, Code, Café, Noir, Holo, Dune and more – plus special templates like Galaxy, Notebook, Comic, Ocean, Midnight, Blueprint, Chalkboard or Sakura. |
| **Live preview** | On the right side of the editor you instantly see how your page looks on a phone – rendered by the same code as the real page. Themes and layouts preview as soon as you hover over them. |
| **Stats without cookies** | Views and clicks per link – no cookies, no IP addresses, no cookie banner for your visitors. |
| **Two addresses** | `on-your.site/name` or `name.on-your.site` – you choose, the other one redirects. |
| **Scheduling** | “Live now” only on Fridays from 6 to 11 pm? Links appear and disappear automatically. |
| **13 layouts** | Buttons, wide cards, tiles, app grid, timeline, cloud, two columns – or tree, bento, carousel, polaroid, magazine and stack. |
| **Effects** | An animated ring around your profile picture, shine or wobble for single links, snow, confetti or fireflies across the page and sparks behind the mouse cursor. |
| **Protected links** | Single links only with a password (at least 6 characters) or after an “18+” confirmation. The target never appears in the page source or the API. |
| **Up to 3 pages** | One page for you, one for your project – each with its own address and stats, switchable in the editor. |
| **Weekly report** | If you like, a short email every Monday with views, clicks and your best link. |
| **Entrance with music** | Visitors tap to enter, the page opens with an animation and your music starts. |
| **Countdown & gallery** | Count down to your next release or show several images to swipe through. |
| **Contact form** | Visitors message you directly – with a spam filter (invisible trap, timing check, content filter) and a heads-up via the bell. |

Everything you already had stays: the built-in booking calendar (`/kalender`), file download (PDF/vcf), SEO settings, custom CSS, “Hide branding” (premium), Discord ID, and the admin panel with “Log in as user” and newsletter.

## Updating an existing installation (Plesk)

1. **Back up** your database and files.
2. Upload the new files or deploy them via Git. `static/uploads/` (your users’ images) and `email/smtp.json` aren’t in the repo and stay unchanged on the server.
3. **Create `config.php`:** copy `config.example.php` and fill it in
   - `db`: the values from your old `db.php`
   - `aes_key`: **exactly** the old value from `security.php` (`AES_256_KEY`) – otherwise Discord IDs and booking requests can no longer be read
   - `app_secret`: generate a new random value, e.g. `php -r "echo bin2hex(random_bytes(32));"`
4. Open the home page once. On the first request, OnYourSite creates the new tables and automatically migrates all existing profiles (links incl. click counts, theme, booking button, file, “About me” text). **Old tables are not deleted.**
5. Set up the weekly report: Plesk → *Scheduled Tasks* → *Run a PHP script* → `cron/weekly_report.php`, schedule Mondays at 8:00 (`0 8 * * 1`).

Requirements: PHP 7.4 or newer (8.x recommended) with PDO MySQL, OpenSSL, mbstring, fileinfo and GD (with WebP); wildcard DNS and wildcard SSL for `*.on-your.site` as before.

Uploads: photos are already resized in the browser, so they fit under small server limits too. For music in the “Entrance with music” (up to 15 MB), set `upload_max_filesize` and `post_max_size` to at least `16M` in Plesk under *PHP Settings*. Each account has 200 MB of storage (premium/admin: 1 GB); files that were uploaded but never saved are removed automatically after two days.

The built-in booking calendar (`/kalender`) is only reachable if the page has a visible booking block that points to it – if that block is protected, the calendar only opens after the password has been entered.

Tests: `php tests/unit.php` (command line only) checks scheduling, embeds, addresses, the spam filter and URL validation.

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
  pages.php, stats.php, spam.php, uploads.php, report.php, social.php, demo.php
views/                 Home page, editor (dashboard.php), login, admin, calendar …
static/css/            page.css (structure & layouts), themes.css (30 themes), editor.css
static/js/             page.js (profile page), editor.js (editor)
static/fonts/          Self-hosted fonts (no Google requests on profile pages)
cron/weekly_report.php Weekly report
```

## Privacy

Profile pages don’t set any cookies and don’t load anything from third-party servers (fonts and icons are hosted locally; YouTube, Twitch and Spotify only load after a tap). Custom CSS can’t load external addresses either – `url(https://…)` and `@import` are removed. Stats only store counters per day, no IP addresses. To stop password guessing and spam (contact form, calendar, login), OnYourSite briefly counts attempts per sender – instead of the IP address it only uses a non-reversible key that changes daily and is deleted after one day at the latest. Messages from the contact form and booking requests are stored encrypted. Please update your privacy policy to cover the new features (contact form, booking calendar, embeds, stats).
