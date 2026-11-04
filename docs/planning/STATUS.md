# Status

Last update: 2026-11-03 (UTC+1), Stage D recorded.

## Release 3.0 – Node.js only (PR #15, merged into `main`)

| Part | State |
|---|---|
| Wave 1 port: page model, rendering, files, sign-in, honeycombs and code pages, updates, community and mail | Done and reviewed – in `main` (PR #13) |
| Public routes, admin page, editor/dashboard/landing page/impersonation/weekly report | Done and reviewed |
| Installer without PHP: Node behind Apache, `--update` moves PHP installs (backup first, switch only after checks, automatic revert), rehearsed on a real 2.x install | Done and reviewed |
| Core hardening: password hashing in worker threads, raw bytes for invalid UTF-8, exact float printing, errors while sending, database down, test isolation | Done |
| Input-handling audit: linear trimming, CSS, markdown, file-type detection, share image, Apache-like answers for odd paths, cookie names | Done |
| Parity gate: every golden-master request SAME or a documented intended difference; browser suites equal on PHP and Node | Passed |
| Request parsing in linear time on hostile bodies (parse_str, rawurldecode, mb_* helpers, multipart) | Done |
| Remove PHP; branch `php-2.x` (pushed) keeps the last PHP version; parity tests read `OYS_PHP_REF` | Done |

**Release 3.0 is merged into `main`** (PR #15, squash commit `2e6f6de`), and the new features followed (PR #14, squash
commit `66207f6`). `main` holds everything below; the branches `feature/node-complete` and `feature/new-features` are
done.

Points to settle before or soon after 3.0:
- Node checks only bcrypt password hashes (`$2y$`, `$2a$`, `$2b$`). Check production before the switch:
  `SELECT LEFT(password,4), COUNT(*) FROM users GROUP BY 1`.
- Image uploads: RGB PNGs with a tRNS chunk and CMYK JPEGs come out slightly differently from PHP's GD.
- The share image takes about 250 ms of CPU the first time – move it into a worker later.
- A YouTube music link with array parameters (`?v[]=`) gives a 500 for the whole page (PHP did the same) – drop the
  music instead.
- Several JSON decoders exist in the packages – merge them into one in the core.
- The privacy page should mention Cloudflare and the Discord bot data.
- On a real server: `systemd-analyze verify` for the new units (the container had no systemd).
- Slow but linear on 20 MB hostile input (follow-ups): `e()`/`xmlEscape` in html.ts, the NUL strip in css.ts, the raw
  e-mail kept in the session after a failed sign-up (cap its length), and the phone check in `cleanUrl` (V8 regex stack).

## New features (PR #14, merged into `main`)

Numbers and dependencies: `ROADMAP.md` §4.0. "Built" = implemented with tests and merged into `main`; "reviewed" = the fixes of an independent review are merged too; "security-reviewed" = covered
by the shared security review of 2026-11-02 (dialogs, Discord, status page, Premium and domain worker, shop UI):
every finding was reproduced with a failing test before it was fixed, and what stays open is listed under "How to
continue" below.

| # | Item | Title | State |
|---|---|---|---|
| 1 | CORE-1 | Shared foundations | Built and reviewed |
| 6 | CD-5a | Notification core and bell API | Built and reviewed |
| 21 | CS-1 | Admin split (Honeycombs and Code pages as separate sections) | Built and reviewed |
| 28 | HC-1 | Yellow honeycomb icons | Built and reviewed |
| 2 | DP-1 | Discord settings form and real errors (the webhook / channel ID loop of Q13) | Built and reviewed |
| 4 | DP-4 | Own pages: changelog and roadmap | Built and reviewed |
| 3, 5, 12 | CD-0, CD-1, CD-3 | Dialog contract, dialog and notice library, admin and sign-in confirmations | Built and reviewed |
| 15, 23, 24 | CD-2, CD-4, CD-5b | Editor dialogs, guard and drafts; themed dialogs on profile pages; bell in the editor and admin header | Built and security-reviewed |
| 11 | PD-2 | Custom domain core (dormant) | Built and reviewed |
| 10, 18 | CS-2, CS-3 | Address registry with holds; code slots data model and routing | Built and reviewed |
| 9, 29 | ST-1, ST-2 | Status core; checker, sensor, installer units | Built and reviewed |
| 8, 16 | HC-2, HC-3 | Ledger, entitlements, Premium status; catalogue, offers, purchases, refunds | Built and reviewed |
| 7, 13, 14 | DP-2a, DP-3, DP-5 | Delivery model and bot API; bot 0.2.0; public suggestions page (+ 5b) | Built and security-reviewed |
| 20 | DP-2b | Admin UI for bot posting | Built and security-reviewed |
| 35 | ST-3 | Notifier and OnYourSite's own status page (+ bot 0.3.0, now 0.3.1) | Built and security-reviewed |
| 17, 19, 26 | PD-1, PD-3, PD-1b | Premium flags and branding; domain worker; wider branding and code-page badge | Built and security-reviewed |
| 22, 30 | HC-4, HC-5 | Editor "Honeycombs" tab; shop admin I | Built and security-reviewed |
| 25 | CS-4 | Code slots: editor API (dark – page slots stay off until `max_on_pages` is raised) | Built and reviewed |
| 32 | PD-4 | Custom domain in the editor: DNS records, live state, extra records for root domains | Built and reviewed |
| 36 | HC-6a | Shop admin II: user details, unlock grants, refunds, purchases tab | Built and reviewed |
| 37 | CS-6 | Code slots in the editor, live: Your pages lists code pages, add and delete them, Edit switches a slot between link page and code page, Subdomain sections (on `feature/owner-decisions`); Where it lives, Download files, the Code page card for new pages and the all-code-pages state (on `feature/cs6-rest`) | Built (small rest below) |
| 38 | ST-4 | Status pages for users: `status_page` in the shop (150), the Status tab, one page with components, deleted with the account; refreshed components (on `feature/owner-decisions`); address change, name rule with review, owner alerts, admin switch (on `feature/st4-rest`) | Built (small rest below) |
| 33 | PD-5 | Custom domains admin: Admin → Custom domains with setup, settings (incl. the worker's mail budget), all domains with Check now / Disable with a reason / Enable / Remove and their history, blocked hostnames with Release (R2), hostnames not managed here (on `feature/pd5-domains-admin`) | Built |
| 45 | PD-6 | Installer for custom domains: `--domains` / `step_domains` (website token in `/etc/onyoursite/cf-saas.token`, `origin`/`edge` DNS, fallback origin, merged tunnel rules that keep the admin's own rules, `config.json`), the `onyoursite-domains` unit, `ServerAlias *`, the quiet `--update` step, `--reset` deleting the hostnames at Cloudflare and the domain-change routine (tests with a stand-in Cloudflare API, `app/test/install-domains.test.ts`; not tried on a real zone yet) | Built and reviewed |
| 31 | CS-5 | Code pages moderation: limits (used when saving; a page above a lowered limit may only get smaller), block/unblock, delete with the typed address (own address held for nobody), ban/unban an account (optionally blocking all its code pages), More code pages for free, the moderation log, filters and search, the source viewer, `Referrer-Policy: no-referrer`; notices inside the slot-lock transaction; the editor's banned state (on `feature/cs5-moderation`; tests `app/test/code-moderation.http.test.ts`, browser flow `tests/e2e/code-moderation.js`) | Built and reviewed |
| 34 | HC-8 | Streaks and the daily cap: `earnOnVisit()` (`app/src/honeycombs/earn.ts`) on `GET /dashboard` – +15 every 7 days and +50 every 30 days in a row (30 wins), daily cap 300 for profile and views under the account lock (NOWAIT), 10-second throttle, nothing while frozen or in admin mode; schema step 19 back-fills streaks from the last 60 days; `honeycombs.streak` in the bootstrap and the `honeycombs` API, `earn.streak`/`capLeft`/`cap` and the rule "Keep a streak" in the shop, the streak chip and the daily-limit hint in the editor, the new fields in *Admin → Honeycombs → Earning rules* (on `feature/hc8-streaks`; tests `app/test/hc-streaks.http.test.ts`, browser flow `tests/e2e/hc-streaks.js`) | Built and reviewed |
| 39 | HC-7a | Time-limited lifecycle and jobs runner: `app/src/jobs/registry.ts` (`registerJob`, `registerNightly`, `GET_LOCK` per job, schema minimum, `oys_meta['jobs']` with `at`/`every` for the status page's `job:runner`), `cli.js jobs:tick [--force]` with its own pool of 3, the honeycomb job `app/src/honeycombs/job.ts` (reconcile retries after 30 s, bell reminders at 7/3/1 days with the loss-preview lines, expiry once per lot with bell, marker and reconcile, nightly entitlement repair), `LIFECYCLE_READY` on (admins can switch on timed options – Premium can be sold), expiry banners in the shop (ends within 3 days: hide for today; Premium ended within 14 days: dismiss), installer `onyoursite-jobs.service`/`.timer` (written and enabled by `write_timers`, stopped by `--reset`, removed when an update goes back to PHP) (on `feature/hc7a-lifecycle`, based on `feature/hc8-streaks`; tests `app/test/hc-jobs.db.test.ts`, `cli.test.ts`, `install-sh.test.ts`, browser flow `tests/e2e/hc-lifecycle.js`) | Built and reviewed |
| 40 | HC-6b | Shop admin III: *Reverse* for rewards and gifts (`reversal/x<id>`, once, never below 0, bell, audit) in the user details and the new *Ledger* sub-tab (filters reason, user, dates; 50 per page), *Freeze*/*Unfreeze* with a reason the user sees (earning and buying stop, unlocks keep working), honeycombs for several users (email, `#id`, `@name` or page address; up to 200; preview from the session for 15 minutes with unclear/missing entries and “below 0” warnings; *Confirm* books once per account with the form's key) – `app/src/honeycombs/teamTools.ts`, `bulkAction.ts` (on `feature/hc6b-admin`, based on `feature/hc7a-lifecycle`; tests `app/test/hc-admin3.http.test.ts`, browser flow `tests/e2e/hc-admin3.js`) | Built and reviewed |
| 41 | HC-9 | Event codes: schema step 20 (`hc_codes`), `app/src/honeycombs/codes.ts` (normalised codes, once per account `code/c<id>`, `max_uses` counted under the account lock – the last place goes to exactly one account, window, `disabled_at`, minimum account age, frozen accounts, 5 wrong tries per 15 minutes), `hc-redeem` in the editor API (403 in admin mode), the *Redeem a code* card and wallet button, the rule *Event codes*, *Admin → Honeycombs → Codes* (create, list with uses and status, *Disable* after the dialog, audit) (on `feature/hc9-codes`, based on `feature/hc6b-admin`; tests `app/test/hc-codes.http.test.ts`, browser flow `tests/e2e/hc-codes.js`) | Built and reviewed |
| 42 | HC-7b | Reminder and "ended" emails: schema step 21 (`hc_mail_outbox`, `hc_accounts.mail_reminders`), `app/src/honeycombs/outbox.ts` (queued in the transaction of the change, once per ref – `rem2:<ent>:<end>` at reminder stage 2 for the last pack, `end:<ent>:<end>` on expiry, a full refund with *Also remove* and a revoke by the team, only when the loss preview has lines; sent by the honeycomb job, budget per run in *Admin → Honeycombs → Earning rules* (default 100), 5 tries, reminders older than 3 days dropped, rows older than 30 days removed at night), template `email/unlock_reminder.json`, the switch *Email me before an unlock ends* (`shop-reminders`, 403 in admin mode) (on `feature/hc7b-mails`, based on `feature/hc9-codes`; tests `app/test/hc-mails.db.test.ts`, browser flow `tests/e2e/hc-mails.js`) | Built and reviewed |
| 43 | ST-5 | Status alert channels: extra email addresses (confirmation link minted by the notifier, only its sha256 stored, `GET|POST /_/status/verify/<token>` on the main host – GET only shows a button –, 7 days valid, resend after 10 minutes, at most 10 confirmation mails a page a day) and Discord webhooks (checked and tested when added; alerts as embeds without mentions; 5 rejections (401/404) turn it off with the mail "Your Discord alerts for … stopped working"; *Incident updates*: one post per incident, edited on updates, deleted with the incident, sent by the notifier, not the bot), alerts fanned out to confirmed channels with the event (`alerts.ts`), *Test* (3 per 10 minutes), *Recent alerts* for user pages, the warning when nothing is on, limit 3 (`limits.channels`), refused in admin mode – `app/src/status/channels.ts`, templates `email/status_verify.json`, `email/status_channel_alert.json` (on `feature/st5-channels`, based on `feature/st4-rest`; tests `app/test/status-channels.test.ts`, browser flow `tests/e2e/status-channels.js`) | Built and reviewed |
| 44 | ST-7 | Status add-ons and Premium limits: `status_more_checks` (+10 checks for 30 days, up to 2 packs, 60) and `status_fast_checks` (every minute for 30 days, 80) in the shop with their rules (a page, not blocked, checks not paused by the team, not with Premium for good); `statusLimits` reads the packs and Premium at run time (free 10/3 min, packs up to 30, Premium 30 and every minute with 250 subscribers – channels and broadcasts stay as free, DECISIONS Q1 = b; the admin role counts as Premium) with the earliest end; the Premium perk text; the reconcile step `refreshStatusLimits` (`app/src/status/limitsSync.ts`: bumps the page for the checker, one bell per change of paused checks in `status_pages.limit_paused`); *Hide “Made with OnYourSite”* for status pages (Premium only, `footerHidden`); the plan and its end in the Status tab (on `feature/st7-addons`, based on `feature/st5-channels`; timed packs go on sale with HC-7a's `LIFECYCLE_READY`; tests `app/test/status-addons.test.ts`, browser flow `tests/e2e/status-addons.js`) | Built and reviewed |
| – | all others | | Open |

Next:
- D1–D3 are in `main` (PR #22–#24; releases 3.2.0 and 3.3.0). The owner's next ask came first: *Admin → Seasons* and
  release 3.4.0 are on `feature/seasons`. `app/src/seasons/seasons.ts` holds the season themes (first: `winter`,
  CSS in `static/css/season-winter.css`: snow, frost glow, fairy lights `.oys-season-lights` above the nav, a Santa hat
  as an SVG data address on the logo icons `.bx-hive.text-brand-500` / `.bx-hive.text-white`), the settings in `oys_meta['site_seasons']` (Off / On / Automatic with
  month-day dates, also across the new year; winter starts as Automatic 12-01 to 01-06 until the admin saves; cached
  15 s per process) and `applySeason()`, which adds the stylesheet,
  the class `season-<key>` on `<body>` and the decoration. Routes mark OnYourSite's own pages with
  `ctx.seasonPage` (`isSeasonPath()` in `app/src/app/dispatch.ts`, the 404 page in `public/notFound.ts`), and
  `server.ts` calls `seasonalBody()` after every request; `?season_preview=<key>` shows a theme while it is off. Users'
  pages, the editor and the admin never get it; with no theme active every page stays byte for byte as before (the
  PHP comparisons are untouched). Admin section: `app/src/seasons/admin.ts` (`season_action=save`). Tests:
  `app/test/seasons.test.ts`, browser flow `tests/e2e/seasons.js`. Next: D6 (`onys.me`), then D5 (docs) and D4 (beta).
- The owner's new asks are recorded as Stage D in `ROADMAP.md` §4.2a: D1 fix block reordering (phone and PC), D2 a
  bigger block picker, D3 Christmas themes, D4 the beta site `beta.on-your.site` for approved testers, D5 the user
  guide at `docs.on-your.site`, D6 the short domain `onys.me` (installer asks for it and for adding the zone to the
  Cloudflare token).
- Later: auto-renewal (HC-7c) once the Premium sale has started; status subscriptions (ST-6) and the rest of Stage C
  (`ROADMAP.md` §4.2).

Schema steps in order: 1–5 (2.x), 6 notifications index, 7 custom domains, 8 site addresses, 9 code slots,
10 status tables, 11 shop core, 12 shop catalogue, 13 Discord delivery, 14 public pages, 15 branding legacy, 16 domain
records, 17 domain blocks, 18 code slots live, 19 shop streaks (HC-8), 20 event codes (HC-9), 21 shop mail (HC-7b), 22 update history (release system) – new steps take the next free number when they are merged.

## How to continue (handoff)

1. **`main`** holds 3.0, the new features and roadmap v1 (PR #15, #14 and #20, squash commits `2e6f6de`, `66207f6` and
   `e41af5b`). Deploy with `sudo bash server/install.sh --update` (see `server/README.md`; it also updates the Discord
   bot, see 5). After the deploy: `onyoursite-jobs.timer` runs the background jobs every 5 minutes; switch on the
   Premium options in *Admin → Honeycombs → Catalogue & prices* when Premium should go on sale; run
   `install.sh --domains` once before custom domains go live. Tests: `cd app && npx tsc --noEmit -p . && npm test`
   (with `OYS_PHP_REF=<php-2.x checkout>` the PHP comparisons run too; `npm run test:seed` rebuilds the test database
   first). The only failing test in this container is "profile handles keep exactly the letters and digits PHP keeps
   (all code points)" – the local PCRE has older Unicode tables. The browser flows (`tests/e2e/*.js`) run on their own,
   each starting the site itself.
2. **`feature/release-system-node`** (on top of `main`): `VERSION` (3.1.0, the same number in `app/package.json` and
   its lock file), `CHANGELOG.md` (2.0.0 – 3.1.0), `scripts/release.sh X.Y.Z`, `scripts/publish-releases.sh` with
   `.github/workflows/release.yml` (tag and GitHub release with the notes and a source ZIP when `VERSION` or
   `CHANGELOG.md` change on `main`; older versions only if their tag exists), the changelog check for pull requests
   (label `no-changelog`), a pull request template, `.gitattributes`. The admin menu shows the version
   (`app/src/version.ts`), Discord requests send it. Schema step 22 `updateHistory` publishes the unchanged 2.0 – 2.2
   drafts, adds their "Shipped" milestones while the roadmap is empty and writes drafts for 3.0 and 3.1 (only 3.1
   announces itself on Discord). Tests: `app/test/release.test.ts`, `schema.test.ts`, the version line in
   `tests/e2e/admin-split.js`. The old branches were checked against `main`: `feature/cloudflare-tunnel` and
   `fix/review-followups` are in `main` in their later form (`bc0cf0a`, `ca0e647`, `92ee8ba` and the Node port),
   the third old branch holds an older state of PR #14 – nothing of them is missing. Older tags (v2.0.0 …
   v3.0.0) can be set by hand on their commits; the workflow then publishes their releases too.
3. **Open points** of the single items are listed under 6 (follow-ups). From PD-5: the globe badge for pages with a
   live domain in the admin user list (design §5.4 last bullet), "place in line" and "N waiting" in the list and the
   Hostnames row, a copy button for "Customers point to", the problem as text instead of its code, the Cloudflare docs
   link in the not-set-up card; `removeDomain()` re-reads under REPEATABLE READ, so a takeover during an admin remove
   can end in "kept changing" (500) – read with a locking read in the retry. From PD-6: not built – the local catch-all
   self-test of design §8.2 step 7; `--update` filling in missing config keys (§8.3); `--reset` only deletes the
   hostnames in `custom_domains.cf_id` (orphans known only from `custom_domain_log` stay); `tunnel_rules_json` drops
   rules without a hostname other than the catch-all (e.g. path-only rules) and keeps the old domain's rules after a
   domain change; `CF_ERRFILE` of `--update`/`--reset` stays in /tmp.
4. **Owner decisions R1–R4** (`DECISIONS.md`, from the reviews): R1 – the admin panel and the site-wide admin parts
   of the editor work only in the admin's own session, never through "Log in as"; R2 – a custom domain an admin
   blocked stays blocked for every account until an admin releases it. Both are built on the branch
   `feature/owner-decisions` (pull request after #14): R1 checks `isAdminSession()` for `/admin`, `/admin/api` and
   "Log in as" itself, and logging in or registering drops the "Log in as" marker; R2 keeps blocked hostnames in
   `custom_domain_blocks` (schema step 17), and PD-5 releases them with `releaseBlock()` (its actions go behind
   `/admin`). Both had an independent review; R2's hostname spellings (case, trailing dot, ports, Unicode, punycode)
   are covered by a test.
   R3 and R4 confirm what is built (`code_more` at price 0, the confirmation for honeycomb gifts above 1,000).
5. **Before the 3.x deploy:** `sudo bash server/install.sh --update` also updates the Discord bot to 0.3.1 – it
   reports which channels everyone can see; team alerts of the status page are only sent to a channel an admin saved
   in *Editor → Status → Alerts* that is not public (until then they are skipped, with the reason in the editor).
6. **Follow-ups found during the work:**
   - Test database: `cd app && npm run test:seed` builds it (`app/test/seed.ts`, see README.md → Development
     environment). Before it existed the seed lived only in the original workspace; with it a fresh checkout passes
     the whole suite (on `main` 1011 of 1012 – the one left is the PHP Unicode comparison, which needs a PHP with a PCRE
     as new as Node's Unicode tables).
   - The browser flows (`tests/e2e/*.js`, `app/test/e2e/*.e2e.ts`) are not part of `npm test`; the tsconfig does not
     type-check the test files.
   - `status_outbox.class` (VARCHAR(8)) is too short for `broadcast` – widen it before ST-6.
   - The native-dialog check also matches regular-expression literals and comments.
   - CS-4: saving uses the `code_pages` limits since CS-5; the terms page doesn't show the limits and both prices
     yet; nobody is told when a refund takes code pages offline; the editor bootstrap still
     lacks `pages[].code` and the code summary (CS-6).
   - CS-5: turning code pages back on for an account leaves its blocked pages blocked (the flash names how many);
     the moderation log shows the last 30 entries without paging; a code page without an address (no slot points to it)
     can't be deleted (the server refuses it), only blocked; the free unlocks and the limits write their log line after
     their own commit (not in one transaction); the access table lists only `code_page` holders, not `code_more`; the
     source viewer loads every file of the page to show one.
   - HC-7b: an "ended" mail already queued still goes out if the user renews before the job sends it (a switch turned
     off before sending is respected); the job and its nightly run now need schema step 21.
   - HC-9: a code disabled between the look-up and the booking answers "used up"; the end of a code's window is not
     checked again under the lock; codes are counted per account (5 wrong tries per address, 50 in total per 15
     minutes) – there is no limit across accounts.
   - HC-6b: *Reverse* has no note field (the user sees "Correction: <entry>"); after a reverse from the Ledger the filters
     and page are not kept; "several users" is its own card under *Give honeycombs* instead of a toggle inside it.
   - HC-7a: not built – the integrity checks and watch rules of §3.5 (`hc_watch`) in the nightly run, the admin
     overview of the job runs (the status page's `job:runner` reads `oys_meta['jobs']`), auto-renew (HC-7c) and the
     reminder/ended mails (HC-7b). Reminders and ends are bell notifications only. The domains worker and the
     notification retention still run on their own (they may register in the runner later). Known limits: a failed
     nightly run waits for the next day; entries of jobs that no longer exist stay in `oys_meta['jobs']` (the status
     page would show them as late – remove the key by hand after renaming a job); the reconcile step has no backoff for
     accounts that keep failing (200 per run, oldest first); the bell body is cut at 255 characters, so long loss-preview
     lines can be shortened.
   - HC-8: `hcEarn()` stays for the PHP comparison only; a PHP rollback drops the new keys (`streak_week`,
     `streak_month`, `daily_cap`) from the rules when an admin saves them there; the streak counts a day once the editor
     opens, also when the daily reward is 0 (the design says "if the daily row was booked"; counting the day itself also
     works with `daily` 0 and with daily rows a PHP rollback wrote); a profile or views reward above the daily limit is
     never paid (the admin form doesn't warn yet); the back-fill (schema step 19) reads all daily rows of the last 62
     days in one query and writes one row per user – fine for today's size, batch it for a much larger ledger.
   - ST-7: the status page's title and favicon don't follow `fullyUnbranded` yet (only the footer is hidden); the
     limit notice is sent by the reconcile step (purchase, grant, refund, expiry through HC-7a's job), not by the checker
     itself – a limit lowered by an admin setting gets no notice; the Premium perk text leaves out "250 subscribers"
     until subscriptions (ST-6) exist; every reconcile of the account (also for code pages or domains) bumps the status
     page's rev once (harmless: the page cache and the checker reload).
   - ST-5: the Discord test message is posted before the locked limit check (in a race the message is posted but the
     channel isn't saved); unconfirmed email channels are purged 7 days after they were added (a link resent on day 6
     lives one more day); a resend that the per-page cap skips leaves the older link valid a little longer; Premium's
     5 channels come with ST-7.
   - HC-6a: the free unlock in *Admin → Code pages* (`app/src/code/admin.ts`) still books through `hcAdd` (no audit
     line) – switch it to `grantFeature`. Bulk grants, the Ledger tab with Reverse and freeze/unfreeze came with HC-6b;
     codes come with HC-9.
   - PD-4: the worker stores only problem codes, so the editor can't show "Found: …" values; the server's
     `fastUntil` has no time zone (the editor counts 15 minutes itself); browser flows still missing: claiming another
     account's domain, the root-domain choice, a live domain with the forwarding switch, the paused view, polling
     stops; the "Checks are delayed" line has no test. An admin working as a user can no longer change domains (R8), and –
     assumed in the spirit of R8 while the owner was away, easy to undo – can't delete a page that has a custom domain
     either (`page-delete` answers 403 `admin_mode`; other pages are deleted as before). Small: Enter in the domain field doesn't check the busy flag; after a 404
     the section shows the old domain until it reloads; a takeover keeps the old owner's forwarding setting;
     `domain-check` has no 403 without Premium (the worker refuses it) and `domain-settings` has no rate limit.
   - Domain worker (premium review, left open on purpose – retry policy for the lead): send domain mails from their own
     loop with a time budget instead of the minute step; a deadline for unknown TXT results and backoff for failed
     creates; storing a hostname ID although the version moved, and not counting deleted orphans in the daily sweep.
   - Branding hint: stays as it is (R9) – no warning for sibling and universal selectors.
   - Status page: the bot's setup reuses an existing public #alerts (saving it is refused now; setup could create a
     private channel instead); the post of an incident is found by the page's current address – store the URL in
     `status_incident_posts` (schema step) so a renamed page still finds old posts; a notifier restart between
     sending a mail and writing its result sends again (needs a claimed state); no per-client rate limit for unknown
     status addresses; edits of messages already posted still go out while the page is offline.
   - CS-6 (built; owner decisions R5–R7): the Code tab's "Where it lives" (Move to
     one of your pages, Show link page again, Download files, Delete), "Download files" also in the Edit and delete
     dialogs (one JSON file with every file, unsaved edits included), the "Link page / Code page" cards in "Create a new
     page" (locked with the reason), and the state where every slot shows a code page (U13: own start box, Settings
     with Your pages – code rows with Open code editor –, the weekly report and Discord, `#settings` opens without a
     link page). Browser flow `tests/e2e/cs6-rest.js` (also on a phone). Still open: the code-page select and the
     kind badge in the Code tab head (design §5.1, the page switcher covers switching), the unlock box for "More code
     pages" inside the new-page dialog (it links to the shop instead), a browser test for moving the own-address code
     page onto a slot from the page switcher, and `tests/e2e/editor-dialogs.js` should clear the address registry in its
     reset so it can run twice on one database. From the review of the rest: the move dialog's reason "Your link pages
     have custom domains" has no browser test (custom domains are off in the browser flows); the move dialog says the
     own address "stays reserved for you for 30 days", but an address used for less than 7 days is free at once
     (`HOLD_POLICY`) – say so or drop the sentence; deleting the open code page reloads to the Content tab, the design
     says `/dashboard#code`.
   - ST-4 (built): changing a status page's address (`status-address`: first change
     free, then once per 30 days, staff exempt; the old address forwards for 90 days through `status_slug_redirects`
     and stays held for the owner), the name rule (`status/names.ts`: the OnYourSite name is refused; a distinctive
     brand sets `review_note`, the page stays noindex until an admin approves it under Admin → Status pages → "Name
     needs review", `status_action=review_ok`), the owner's alerts (`status-owner-alerts`: email on/off and events;
     the bell always), the admin's switch between OnYourSite's page and their own in the editor, and tests for
     incidents and maintenance on user pages, the "new unlocks" switch and concurrent component adds
     (`app/test/status-user-rest.test.ts`, `tests/e2e/status-user.js`). Subscribers are ST-6 (Stage C). Still open:
     blocking a user's status page from the admin (the public side already answers for `is_blocked`), editing the
     address of OnYourSite's own page, and `app/test/e2e/status-system.e2e.ts` test 1 (the incident isn't shown
     resolved after "Resolve") fails on the base too. From the review: delete + create resets the address cooldown
     (status holds have no minimum use), so the "about four held addresses per 90 days" cap of ST-E10 is not enforced
     (`statuscreate` allows 10 creates an hour); while the database is down, `statusDbDownHost` serves an old address
     from the process-local `knownSlugs` list instead of redirecting; "Pay Pal status" (a brand split into words) is not
     flagged; an admin working as a user has no address cooldown (like link and code pages, `isStaff`).
   - R1: while an admin works as another admin account, that account's bell can still show team notifications that
     link to `/admin` (they lead back to the editor – a dead end, not a way into admin rights); `editorData.user.admin`
     in the editor bootstrap still reflects `is_admin` (nothing reads it yet – switch it to `isAdminSession` before
     anything does); sessions that got the marker before this change keep it until logout or "Back to admin panel".
   - Dialogs: password-protected link URLs still sit in editor drafts (blanking them needs merge logic on restore);
     the privacy page should say that unsaved work is kept on the device.
   - Discord: optional hourly clean-up of old dead jobs (only for installs that ran 3.x before the fix); optional notice
     when a sent message ends with no post record.
   - CS-4 review: a duplicate on `uq_code_site` answers 500 (inconsistent data only); `code-delete` compares the typed address
     read before the lock.
   - HC-6a review: gifts "for good" don't keep the form reference; the refund form pre-fills the refundable amount at page
     load (a time-limited purchase can be "Refund at most N" later); gifts skip the shop's buying rules; unlocks that
     exist only in the ledger can't be removed (only during a deploy); the gift form reads `user_id[]` with PHP-style
     casts (pinned by the PHP comparison).

Work in progress lives on branches of the current workspace and is pushed when it is ready; this file says what is
already in `main`. Small fixes from other contributors arrive as pull requests into `main` (#16 and #17 were such
fixes; #18 was already contained in #14).
