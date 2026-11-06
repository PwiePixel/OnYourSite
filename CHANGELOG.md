# Changelog

Everything that changed in OnYourSite, version by version. New entries go under **[Unreleased]** first. When a version is released, they move into a section of their own and GitHub automatically publishes a release with exactly these notes (see “Releases” in the README).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [3.6.0] - 2026-11-06

### Added
- **Beta website**: `beta.on-your.site` now runs the next version of OnYourSite for beta testers. Log in first, then the beta panel has an **Open the website** button – the whole site in its pre-release version, with your real account and pages (the same database) and a small "Beta · Panel" note to get back. Everyone else only gets the login and the note that the area is for beta testers.
- **Two release channels**: releases (`scripts/release.sh 3.6.0`, merged into `main`) for everyone, and pre-releases (`scripts/release.sh 3.6.0-beta.1`, on the `beta` branch) only for the beta website. GitHub publishes pre-releases as such, never as the latest release.
- `install.sh --beta` sets up the beta website next to the main site (branch `beta`, its own service `onyoursite-beta`, the same database and uploads – with a backup before it changes the database); `install.sh --update` updates it too, `install.sh --beta-off` removes it. *Admin → Beta* shows which version runs there.

### Changed
- A new Santa hat on the logo, taken from our own artwork (`static/images/seasons/logo-hat.png`) and placed exactly like on it. In the winter look the OnYourSite logo wears it **everywhere** – also in the editor, the admin area and the beta area (only the hat there, no snow). The yellow honeycombs and users' pages stay as they are.
- The beta panel moved to `beta.on-your.site/_beta/` – every other address there is the beta website (for testers) or leads to the panel.

## [3.5.0] - 2026-11-05

### Added
- **Beta area at `beta.on-your.site`**: beta testers log in with their OnYourSite account and get a beta panel – what to test right now, a form for bug reports and ideas (type, area, what happened, steps, a link) and their own reports with status and the team's reply. Everyone else sees that the area is for beta testers.
- *Admin → Beta*: add testers by email or username (they need a linked Discord account), remove them, answer reports (status and a reply – the tester gets a notification) and write the "What to test right now" text.
- The Discord bot gives beta testers the **Beta Tester** role (it creates the role if it's missing; `BETA_ROLE_ID` in the bot's `.env` picks an existing one) and takes it away when they leave the beta. When a tester changes their Discord ID in the editor, the role moves with it; without a Discord ID the beta area pauses for them. The admin sees whether the role was given or the member isn't on the server yet, and can try again.
- `on-your.site/beta` leads to the beta area. A page that was called `beta` moved to `on-your.site/beta` (its owner got a notification).

## [3.4.2] - 2026-11-04

### Added
- **Bea**, the OnYourSite bee, in the winter season theme: in a Santa hat (the same as on the logo) and a scarf, she sits on the snow at the bottom right of the footer – or at the bottom right of the window on pages without a footer (not on phones there). She sways gently, never catches clicks and stands still for reduced motion.

### Changed
- The mascot is called Bea (`static/images/mascot/bea-*.svg` and `.png`); the Santa hat comes from one source, `tools/santa_hat.py`, for the logo and for Bea.

## [3.4.1] - 2026-11-04

### Changed
- Winter season theme: the fairy lights hang on one sagging wire with real-looking sockets and bulbs, and two groups of bulbs glow up gently in turn. A new Santa hat on the OnYourSite logo – a fluffy trim, a tip that falls to the left with its bobble – sits on top of the fairy lights. Snow lies at the bottom of the page – a snow edge on the footer and drifts below it, or at the bottom of the window on pages without a footer.

## [3.4.0] - 2026-11-04

### Added
- *Admin → Seasons*: season themes for OnYourSite’s own pages (home page, log in and sign up, updates, roadmap, suggestions, the legal pages and the 404 page). Each theme is Off, On or Automatic between two dates every year (also across the new year), with a preview. Users’ pages, the editor and the admin panel stay as they are.
- The first season theme, **Winter**: gently falling snow, fairy lights along the top, a Santa hat on the OnYourSite logo, a frosty glow and icy blue accents – CSS only, it lets every click through and stands still when the device asks for less motion. It starts as Automatic from December 1 to January 6 – switch it off or change the dates in *Admin → Seasons*.

## [3.3.0] - 2026-11-04

### Added
- Five themes for winter and Christmas: **Snowy Night** (falling snow under the moon), **Candy Cane** (red and white stripes), **Gingerbread** (cookie brown with white icing), **Christmas Market** (fairy lights on a winter evening) and **Frost** (icy blue and frosted glass) – 35 themes in total, with their own “Winter & Christmas” filter in the editor.

## [3.2.0] - 2026-11-04

### Added
- Every new version brings its text for `/updates`: a few minutes after the update it waits as a draft in *Admin → Updates* (from `app/src/updates/releaseNotes.ts`; a deleted draft doesn’t come back).

### Changed
- A bigger block picker: large tiles with an icon, the name and a short description, up to four columns on a computer and two on a phone, and a search that filters while you type (Enter adds the first match).

### Fixed
- Blocks in the editor can be dragged into a new order again – on phones and on a PC, also after changing the profile picture. The drag library now comes from OnYourSite itself, so content blockers can’t switch it off, and on phones the handle no longer scrolls the page instead.

## [3.1.0] - 2026-11-03

### Added
- Release system: this changelog and a `VERSION` file. As soon as a new version reaches `main`, GitHub creates the tag `vX.Y.Z` and a release with these notes and the source code as a ZIP. Pull requests are checked for an entry in this changelog (skip with the label `no-changelog`), and `scripts/release.sh` prepares a new version.
- The admin menu shows the installed version; requests to Discord send it in their User-Agent.
- Code pages on page slots: the editor lists code pages next to link pages, a slot switches between a link page and a code page, files can be downloaded, and the team moderates code pages (limits, block, delete, ban an account).
- Status pages for everyone: a status page from the shop with components, alert channels (extra email addresses with a confirmation link, webhooks), posts for incidents, and add-ons for more and faster checks. Premium raises the limits and can hide the branding.
- Custom domains: the admin panel manages domains, their history and blocked hostnames; the installer sets up Cloudflare for SaaS with `--domains`.
- Honeycombs: streaks (+15 every 7 days, +50 every 30 days in a row) and a daily cap, time-limited extras with reminder and “ended” emails (can be turned off), event codes to redeem, and for the team reversals, freezing an account and gifts to many users at once.
- Background jobs run every 5 minutes (`onyoursite-jobs.timer`).

### Changed
- The release notes of 2.0 – 2.2 are published on `/updates` once after the update (versions you already entered yourself are not added twice, drafts you changed stay drafts), and “Recently shipped” lists them as milestones while the roadmap is still empty.

## [3.0.0] - 2026-11-02

### Changed
- OnYourSite runs on Node.js 22 and TypeScript; the PHP version is no longer part of it (the branch `php-2.x` keeps its last state). `config.php` becomes `config.json` with the same keys, and everyone logs in once more.
- `server/install.sh --update` builds and checks the new version next to the running one before switching over, and goes back by itself if it doesn’t work.

### Added
- Own dialogs everywhere instead of browser pop-ups, and the notification bell in the editor and the admin panel.
- OnYourSite’s own status page at `status.on-your.site` with incidents, maintenance, alerts and Discord posts.
- The honeycomb shop in the editor (balance, bookings, offers, refunds) and Premium, which includes hiding the branding.
- Posting updates through the installed Discord bot and a public suggestions page.

### Added since 2.2 (already in the last PHP version)
- QR codes, a share window and preview cards for shared links.
- Code pages, honeycombs, YouTube links as entrance music and a safe upload folder.
- A crop window for profile pictures.
- The Discord community bot (suggestions, support tickets, updates) with an automatic server setup.
- `server/install.sh` sets up a whole server, including a Cloudflare Tunnel and `--reset` for a fresh start.

## [2.2.0] - 2026-10-29

### Added
- Public page `/updates` with the changelog and a roadmap (*Working on now*, *Up next*, *Later*, *Shipped*), an RSS feed at `/updates/feed.xml` and permanent links `/updates/<id>`; `/roadmap` leads there.
- Milestones with tasks – progress bars come only from ticked-off tasks.
- Admin panel sections for updates, the roadmap and Discord.
- Discord announcements via webhook link or bot, with an optional ping (role, `@here` or `@everyone`). Each update remembers whether it should be announced; edits update the Discord post, drafts and deletions remove it, failed requests are reported and can be retried.
- “Updates” link in the navigation and the footer of the home page.

### Changed
- Pages called “updates” or “roadmap” keep working through their subdomain.

### Security
- Webhook links and bot tokens are stored encrypted and never shown again.

## [2.1.0] - 2026-10-28

### Changed
- The whole interface is in English: editor, profile pages, home page, login and sign-up, booking page, emails, API and error messages.
- Optimized for phones: bottom navigation bar in the editor, full-width menus, 16px inputs (no zooming on iOS), booking and contact forms for narrow screens and bigger tap areas – no sideways scrolling from 320px up.
- Deep Dark is the default theme again.

### Added
- Six new themes: Noir, Holo, Dune and the templates Blueprint, Chalkboard and Sakura – 30 themes in total.

### Removed
- The TRS theme; pages that used it switch to the default theme.

## [2.0.1] - 2026-10-27

### Security
- Protected links never reveal their target or platform – neither in the page source nor in the API. `/_/go` only forwards protected links of the page itself, and only after a POST.
- Custom CSS can’t load anything from other servers (`url()`, `@import`, `image-set`, also when disguised with CSS escapes) – it is cleaned when saving and when rendering.
- Log out, “Log in as user” and “Back to admin” only work via POST with a CSRF token.
- Password, login, contact and calendar limits per visitor – without storing IP addresses.
- 200 MB of storage per account and an upload rate limit; uploads that were never saved are removed after two days; sign-ups are slowed down.

### Fixed
- The editor never saves into a different page by accident (deleted page, other account in a second tab) and rejects broken data.
- The booking calendar only opens with an active booking block and rejects invalid dates.
- Emoji with joiners (👨‍💻) stay intact; text direction tricks are removed.

## [2.0.0] - 2026-10-27

### Added
- Rebuilt editor with a live preview on a phone, rendered by the same code as the real page, and a theme gallery with previews of your own page.
- 25 themes and 13 layouts.
- Block editor with drag & drop, quick links and image uploads (WebP, without EXIF data); photos are made smaller in the browser before uploading.
- Up to 3 pages per account, each with its own address and stats.
- Links with matching brand icons, social icons for 27 platforms.
- YouTube, Twitch and Spotify (loaded after a tap), images, gallery, countdown and text blocks.
- Scheduling, password protection and 18+ confirmation for single links.
- Effects: ring around the profile picture, shine, wobble and pulse, snow, confetti, fireflies and sparks behind the mouse cursor.
- Entrance with music, contact form with spam protection and a notification bell.
- Stats without cookies and without IP addresses; optional weekly report by email.
- Two addresses: `name.on-your.site` and `on-your.site/name`.

### Changed
- Existing profiles are migrated automatically; old tables stay untouched.
- Credentials live in `config.php` (not in the repository); CSRF protection everywhere, sessions only for login and editor; internal folders and `email/smtp.json` can no longer be downloaded.
- Fonts and icons are self-hosted.
