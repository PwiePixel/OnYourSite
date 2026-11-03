# Status

Last update: 2026-11-02 16:35 (UTC+1).

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
| 37 | CS-6 | Code slots in the editor, live: Your pages lists code pages, add and delete them, Edit switches a slot between link page and code page, Subdomain sections (on `feature/owner-decisions`) | Built (core; rest below) |
| 38 | ST-4 | Status pages for users: `status_page` in the shop (150), the Status tab, one page with components, deleted with the account; refreshed components (on `feature/owner-decisions`) | Built (first part; rest below) |
| 34 | HC-8 | Streaks and the daily cap: `earnOnVisit()` (`app/src/honeycombs/earn.ts`) on `GET /dashboard` – +15 every 7 days and +50 every 30 days in a row (30 wins), daily cap 300 for profile and views under the account lock (NOWAIT), 10-second throttle, nothing while frozen or in admin mode; schema step 19 back-fills streaks from the last 60 days; `honeycombs.streak` in the bootstrap and the `honeycombs` API, `earn.streak`/`capLeft`/`cap` and the rule "Keep a streak" in the shop, the streak chip and the daily-limit hint in the editor, the new fields in *Admin → Honeycombs → Earning rules* (on `feature/hc8-streaks`; tests `app/test/hc-streaks.http.test.ts`, browser flow `tests/e2e/hc-streaks.js`) | Built and reviewed |
| 39 | HC-7a | Time-limited lifecycle and jobs runner: `app/src/jobs/registry.ts` (`registerJob`, `registerNightly`, `GET_LOCK` per job, schema minimum, `oys_meta['jobs']` with `at`/`every` for the status page's `job:runner`), `cli.js jobs:tick [--force]` with its own pool of 3, the honeycomb job `app/src/honeycombs/job.ts` (reconcile retries after 30 s, bell reminders at 7/3/1 days with the loss-preview lines, expiry once per lot with bell, marker and reconcile, nightly entitlement repair), `LIFECYCLE_READY` on (admins can switch on timed options – Premium can be sold), expiry banners in the shop (ends within 3 days: hide for today; Premium ended within 14 days: dismiss), installer `onyoursite-jobs.service`/`.timer` (written and enabled by `write_timers`, stopped by `--reset`, removed when an update goes back to PHP) (on `feature/hc7a-lifecycle`, based on `feature/hc8-streaks`; tests `app/test/hc-jobs.db.test.ts`, `cli.test.ts`, `install-sh.test.ts`, browser flow `tests/e2e/hc-lifecycle.js`) | Built and reviewed |
| 40 | HC-6b | Shop admin III: *Reverse* for rewards and gifts (`reversal/x<id>`, once, never below 0, bell, audit) in the user details and the new *Ledger* sub-tab (filters reason, user, dates; 50 per page), *Freeze*/*Unfreeze* with a reason the user sees (earning and buying stop, unlocks keep working), honeycombs for several users (email, `#id`, `@name` or page address; up to 200; preview from the session for 15 minutes with unclear/missing entries and “below 0” warnings; *Confirm* books once per account with the form's key) – `app/src/honeycombs/teamTools.ts`, `bulkAction.ts` (on `feature/hc6b-admin`, based on `feature/hc7a-lifecycle`; tests `app/test/hc-admin3.http.test.ts`, browser flow `tests/e2e/hc-admin3.js`) | Built and reviewed |
| – | all others | | Open |

Next, as soon as their dependencies are in:
- Premium and domains: PD-5 (domains admin), PD-6 (installer: Cloudflare for SaaS, domain worker unit).
- Shop: HC-9, HC-7b (HC-8, HC-7a and HC-6b are on their branches).
- Status pages: the rest of ST-4 (see follow-ups), then ST-5, ST-7.
- Code pages: CS-5 (moderation) and the rest of CS-6 (see follow-ups).
- Later (Stage C): `ROADMAP.md` §4.2.

Schema steps in order: 1–5 (2.x), 6 notifications index, 7 custom domains, 8 site addresses, 9 code slots,
10 status tables, 11 shop core, 12 shop catalogue, 13 Discord delivery, 14 public pages, 15 branding legacy, 16 domain
records, 17 domain blocks, 18 code slots live, 19 shop streaks (HC-8, on its branch) – new steps take the next free number when they are merged.

## How to continue (handoff)

1. **PR #15 and PR #14 are merged** (squash commits `2e6f6de` and `66207f6`). Deploy `main` with
   `sudo bash server/install.sh --update` (see `server/README.md`; it also updates the Discord bot, see 5).
2. **New work starts from `main`**: one branch per roadmap item, merged as one squash commit after the tests pass
   (never push to `main` directly). On `main` 1012 tests pass (1035 with `feature/owner-decisions`) (`cd app && npx tsc --noEmit -p . && npm test`; with
   `OYS_PHP_REF=<php-2.x checkout>` the PHP comparisons run too).
3. **Next roadmap items, in dependency order** (`ROADMAP.md` §4.0/§4.1):
   - Shop: HC-8 is on `feature/hc8-streaks`, HC-7a on `feature/hc7a-lifecycle`; done there: HC-7a (time-limited lifecycle – switches on Premium and timed options), HC-6b, HC-9, HC-7b.
   - Premium and domains: PD-5 (domains admin), PD-6 (installer: Cloudflare for SaaS, systemd unit for the domain
     worker).
   - Code pages: CS-5 (moderation), the rest of CS-6.
   - Status pages: the rest of ST-4, then ST-5, ST-7.
   - Later: Stage C (`ROADMAP.md` §4.2).
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
   - The browser flows (`tests/e2e/*.js`, `app/test/e2e/*.e2e.ts`) are not part of `npm test`; the tsconfig does not
     type-check the test files.
   - `status_outbox.class` (VARCHAR(8)) is too short for `broadcast` – widen it before ST-6.
   - The native-dialog check also matches regular-expression literals and comments.
   - CS-4: saving still uses the fixed size limits (take them from the `code_pages` settings in `codeWrite`, with the
     "page already over a lowered limit" rule); the terms page doesn't show the limits and both prices yet; nobody is
     told when a refund takes code pages offline (needs notifications with `ref`, CS-5); the editor bootstrap still
     lacks `pages[].code` and the code summary (CS-6).
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
   - HC-6a: the free unlock in *Admin → Code pages* (`app/src/code/admin.ts`) still books through `hcAdd` (no audit
     line) – switch it to `grantFeature`. Bulk grants, the Ledger tab with Reverse and freeze/unfreeze came with HC-6b;
     codes come with HC-9.
   - PD-4: the worker stores only problem codes, so the editor can't show "Found: …" values; the server's
     `fastUntil` has no time zone (the editor counts 15 minutes itself); browser flows still missing: claiming another
     account's domain, the root-domain choice, a live domain with the forwarding switch, the paused view, polling
     stops; the "Checks are delayed" line has no test. An admin working as a user may change domains (the designs
     exempt staff; only spending is refused). Small: Enter in the domain field doesn't check the busy flag; after a 404
     the section shows the old domain until it reloads; a takeover keeps the old owner's forwarding setting;
     `domain-check` has no 403 without Premium (the worker refuses it) and `domain-settings` has no rate limit.
   - Domain worker (premium review, left open on purpose – retry policy for the lead): send domain mails from their own
     loop with a time budget instead of the minute step; a deadline for unknown TXT results and backoff for failed
     creates; storing a hostname ID although the version moved, and not counting deleted orphans in the daily sweep.
   - Branding hint: extending the save hint to sibling and universal selectors would also warn on normal CSS such as
     `.oys-main > *` – decide first.
   - Status page: the bot's setup reuses an existing public #alerts (saving it is refused now; setup could create a
     private channel instead); the post of an incident is found by the page's current address – store the URL in
     `status_incident_posts` (schema step) so a renamed page still finds old posts; a notifier restart between
     sending a mail and writing its result sends again (needs a claimed state); no per-client rate limit for unknown
     status addresses; edits of messages already posted still go out while the page is offline.
   - CS-6 (core built; owner decisions R5–R7): still open – in the Code tab "Where it lives", "Show the link page
     again" and "Download files" in the dialogs; rows for code pages and "Turn into a code page" in Settings → Your
     pages; the "Code page" card in the Create-a-new-page dialog; the state where every slot shows a code page (design
     U13) and the preview pane without a link page; a browser test for moving the own-address code page onto a slot;
     `tests/e2e/editor-dialogs.js` should clear the address registry in its reset so it can run twice on one database.
   - ST-4 (first part built): still open – changing a status page's address (90-day redirect, cooldown), the brand
     rule for page titles, the owner's alert settings (mail and bell are written by the core but not verified end to
     end), the paused-module behaviour, incidents on user pages (the API exists, untested), subscribers, a test for
     concurrent component adds, the remaining browser flows of the design, and the admin's switch between OnYourSite's
     page and their own. `app/test/e2e/status-system.e2e.ts` test 1 (the incident isn't shown resolved after
     "Resolve") fails on the base too.
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
