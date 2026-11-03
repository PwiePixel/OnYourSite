# Status

Last update: 2026-11-02 14:08 (UTC+1).

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

**Release 3.0 is merged into `main`** (PR #15, squash commit `2e6f6de`). `main` is merged into `feature/new-features`
(`0a15a2e`, same tree as `feature/node-complete`), so PR #14 shows only the feature changes and merges cleanly.

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

## New features (PR #14, `feature/new-features`)

Numbers and dependencies: `ROADMAP.md` §4.0. "Built" = implemented with tests and merged into
`feature/new-features`; "reviewed" = the fixes of an independent review are merged too; "security-reviewed" = covered
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
| – | all others | | Open |

Next, as soon as their dependencies are in:
- Premium and domains: PD-5 (domains admin); PD-6 is on `feature/pd6-installer-domains`.
- Shop: HC-8, HC-7a (switches on Premium and timed options), HC-6b, HC-9, HC-7b.
- Status pages: ST-4 (status pages for users – all its dependencies are in now), ST-5, ST-7.
- Code pages: CS-5 (moderation), CS-6 (code slots in the editor, live).
- Later (Stage C): `ROADMAP.md` §4.2.

Schema steps in order: 1–5 (2.x), 6 notifications index, 7 custom domains, 8 site addresses, 9 code slots,
10 status tables, 11 shop core, 12 shop catalogue, 13 Discord delivery, 14 public pages, 15 branding legacy, 16 domain
records – new steps take the next free number when they are merged.

## How to continue (handoff)

1. **PR #15 is merged** (squash) and `main` is merged into `feature/new-features`. Deploy `main` with
   `sudo bash server/install.sh --update` (see `server/README.md`); PR #14 is next.
2. **Continue on `feature/new-features`** (PR #14). All built items above are merged there; 1012 tests pass
   (`cd app && npx tsc --noEmit -p . && npm test`; with `OYS_PHP_REF=<php-2.x checkout>` the PHP comparisons run too).
3. **Next roadmap items, in dependency order** (`ROADMAP.md` §4.0/§4.1):
   - Shop: HC-8, HC-7a (time-limited lifecycle – switches on Premium and timed options), HC-6b, HC-9, HC-7b.
   - Premium and domains: PD-5 (domains admin). PD-6 (installer: Cloudflare for SaaS) is on
     `feature/pd6-installer-domains`: `--domains` / `step_domains` (website token in `/etc/onyoursite/cf-saas.token`,
     `origin`/`edge` DNS, fallback origin, merged tunnel rules – rules of the admin stay –, `config.json`), the
     `onyoursite-domains` unit, `ServerAlias *` with custom domains, the quiet `--update` step, `--reset` deleting the
     hostnames at Cloudflare and the domain-change routine; tests with a stand-in Cloudflare API
     (`app/test/install-domains.test.ts`). Not tried on a real server and a real Cloudflare zone yet – do that once
     before switching custom domains on. Not built: the local catch-all self-test of design §8.2 step 7; `--update`
     filling in missing config keys (§8.3); `--reset` only deletes the hostnames in `custom_domains.cf_id` (orphans known
     only from `custom_domain_log` stay); `tunnel_rules_json` drops rules without a hostname other than the catch-all
     (e.g. path-only rules) and keeps the old domain's rules after a domain change; `CF_ERRFILE` of `--update`/`--reset`
     stays in /tmp.
   - Code pages: CS-5 (moderation), CS-6 (code slots in the editor, live).
   - Status pages: ST-4 (status pages for users), then ST-5, ST-7.
   - Later: Stage C (`ROADMAP.md` §4.2).
4. **Owner decisions needed** (found in the reviews; nothing is built for them yet):
   - An admin who uses "Log in as" on another *admin* account can then use the whole admin panel as that admin
     (grants, refunds and prices are recorded under the other admin). Options: refuse "Log in as" for admin accounts,
     or let `/admin` act only for the original admin.
   - Blocked custom domains: the owner can remove and add again a domain an admin disabled (design §5.2 vs §2.8).
     Decide before PD-5 (nothing sets `blocked` yet).
   - Taken as read, please confirm: after a refund of `code_more`, the code pages above the free allowance go offline
     only while `code_more` costs something (at price 0 it is free for everyone, CS-E13); "Give honeycombs" asks
     before deductions and before gifts above 1,000 honeycombs (one constant, `GRANT_ASK_ABOVE`).
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
   - HC-6a: the free unlock in *Admin → Code pages* (`app/src/code/admin.ts`) still books through `hcAdd` (no audit
     line) – switch it to `grantFeature`. Not in HC-6a: bulk grants, the History tab with Reverse, freeze/unfreeze
     (HC-6b) and codes (HC-9).
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

Work in progress lives on branches of the current workspace and is pushed when it is merged into
`feature/new-features`; this file says what is already in. Small fixes from other contributors arrive as pull
requests into `feature/new-features` (for example #16, the weekly report's best link). #18 (per-checkout names in
three tests) was already contained in `feature/new-features`; its branch is merged with it and changes nothing any
more – merge or close it.
