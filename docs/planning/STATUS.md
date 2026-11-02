# Status

Last update: 2026-11-02 08:12 (UTC+1).

## Release 3.0 – Node.js only (PR #15, `feature/node-complete`)

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

**Release 3.0 is complete and ready to merge** (PR #15 merges cleanly into `main`). The PHP removal and everything
else from `feature/node-complete` is merged into `feature/new-features` too.

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
`feature/new-features`; "reviewed" = the fixes of an independent review are merged too. Items without a separate
review get one shared security review at the end.

| # | Item | Title | State |
|---|---|---|---|
| 1 | CORE-1 | Shared foundations | Built and reviewed |
| 6 | CD-5a | Notification core and bell API | Built and reviewed |
| 21 | CS-1 | Admin split (Honeycombs and Code pages as separate sections) | Built and reviewed |
| 28 | HC-1 | Yellow honeycomb icons | Built and reviewed |
| 2 | DP-1 | Discord settings form and real errors (the webhook / channel ID loop of Q13) | Built and reviewed |
| 4 | DP-4 | Own pages: changelog and roadmap | Built and reviewed |
| 3, 5, 12 | CD-0, CD-1, CD-3 | Dialog contract, dialog and notice library, admin and sign-in confirmations | Built and reviewed |
| 15, 23, 24 | CD-2, CD-4, CD-5b | Editor dialogs, guard and drafts; themed dialogs on profile pages; bell in the editor and admin header | Built |
| 11 | PD-2 | Custom domain core (dormant) | Built and reviewed |
| 10, 18 | CS-2, CS-3 | Address registry with holds; code slots data model and routing | Built and reviewed |
| 9, 29 | ST-1, ST-2 | Status core; checker, sensor, installer units | Built and reviewed (units still to be wired into install.sh) |
| 8, 16 | HC-2, HC-3 | Ledger, entitlements, Premium status; catalogue, offers, purchases, refunds | Built and reviewed |
| 7, 13, 14 | DP-2a, DP-3, DP-5 | Delivery model and bot API; bot 0.2.0; public suggestions page (+ 5b) | Built |
| 20 | DP-2b | Admin UI for bot posting | Built |
| 35 | ST-3 | Notifier and OnYourSite's own status page (+ bot 0.3.0) | Built |
| 17, 19, 26 | PD-1, PD-3, PD-1b | Premium flags and branding; domain worker; wider branding and code-page badge | Built |
| 22, 30 | HC-4, HC-5 | Editor "Honeycombs" tab; shop admin I | Built |
| – | all others | | Open |

Next, as soon as their dependencies are in:
- Premium and domains: PD-4 (domain in the editor), PD-5, PD-6.
- Shop: HC-6a, HC-8, then HC-7a/7b, HC-6b, HC-9.
- Status pages: ST-4 (status pages for users), ST-5, ST-7.
- Code pages: CS-4, CS-5, CS-6 (code slots in the editor, live).
- Later (Stage C): `ROADMAP.md` §4.2.

Schema steps in order: 1–5 (2.x), 6 notifications index, 7 custom domains, 8 site addresses, 9 code slots,
10 status tables, 11 shop core, 12 shop catalogue, 13 Discord delivery, 14 public pages, 15 branding legacy – new
steps take the next free number when they are merged.

## How to continue (handoff)

1. **Merge PR #15 first** ("Create a merge commit" keeps `feature/new-features` in line; after a squash merge, bring
   `main` into `feature/new-features` with `git merge -s ours origin/main` – only when the tree of `main` equals the
   tree of `feature/node-complete` – so #14 shows only the feature changes). Then deploy with
   `sudo bash server/install.sh --update` (see `server/README.md`).
2. **Continue on `feature/new-features`** (PR #14). All built items above are merged there; 927 tests pass
   (`cd app && npx tsc --noEmit -p . && npm test`; with `OYS_PHP_REF=<php-2.x checkout>` the PHP comparisons run too).
3. **Next roadmap items, in dependency order** (`ROADMAP.md` §4.0/§4.1):
   - Shop: HC-6a (shop admin II: users, unlock grants, refunds), HC-8, HC-7a (time-limited lifecycle – switches on
     Premium and timed options), HC-6b, HC-9, HC-7b.
   - Premium and domains: PD-4 (custom domain in the editor – needs HC-4), PD-5 (domains admin), PD-6 (installer:
     Cloudflare for SaaS, systemd unit for the domain worker).
   - Code pages: CS-4 (editor API), CS-5 (moderation), CS-6 (code slots in the editor, live).
   - Status pages: ST-4 (status pages for users – needs HC-6a), then ST-5, ST-7.
   - Later: Stage C (`ROADMAP.md` §4.2).
4. **Follow-ups found during the work:**
   - Texts that still name the PHP setup: `app/src/content/storage.ts` (uploads_dir hint), `app/src/admin/views/storage.ts`
     (config.php line, backup list), `app/src/community/adminView.ts` (bot secret hint), `app/src/admin/newsletter.ts`
     (PHPMailer), `app/src/content/uploads.ts` (PHP settings), the privacy page ("PHP Sessions"), `app/src/cli.ts`
     ("PHP Fatal error" text; exit code 0 when the database is down).
   - README: the "Updates, roadmap & Discord" section still describes the old single Discord form and the `/roadmap`
     redirect; "Structure" is missing `src/discord`, `src/domains`, `src/notify`, `src/status`.
   - The browser flows (`tests/e2e/*.js`, `app/test/e2e/*.e2e.ts`) are not part of `npm test`; the tsconfig does not
     type-check the test files.
   - `status_outbox.class` (VARCHAR(8)) is too short for `broadcast` – widen it before ST-6.
   - The native-dialog check also matches regular-expression literals and comments.
   - Extra DNS records for root domains (ownership TXT, DCV) have no storage yet – PD-4 adds it.

Work in progress lives on branches of the current workspace and is pushed when it is merged into
`feature/new-features`; this file says what is already in. Small fixes from other contributors arrive as pull
requests into `feature/new-features` (for example #16, the weekly report's best link).
