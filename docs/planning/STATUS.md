# Status

Last update: 2026-11-02 03:05 (UTC+1).

## Release 3.0 – Node.js only (PR #15, `feature/node-complete`)

| Part | State |
|---|---|
| Wave 1 port: page model, rendering, files, sign-in, honeycombs and code pages, updates, community and mail | Done and reviewed – in `main` (PR #13) |
| Public routes: profile pages, path and subdomain addresses, calendar page, 404, the API | Done and reviewed – on `feature/node-complete` |
| Admin page | Done and reviewed – on `feature/node-complete` |
| Editor, dashboard, landing page, impersonation, weekly report (+ CLI) | Done and reviewed – on `feature/node-complete`; uploads and forms are read by a port of PHP's own multipart parser |
| Installer without PHP: Node behind Apache, `--update` migrates PHP installs (backup first, switch only after checks, automatic revert if the check after the switch fails) | Being built, then reviewed |
| Core hardening: password hashing off the event loop, raw bytes for invalid UTF-8 in forms, `parseStr` edge cases, exact float printing, errors while a response is sent, database down, test isolation | In progress |
| Parity gate: full comparison of every request PHP vs Node (golden master) plus the browser suites | In progress |
| Input-handling audit: regular expressions on user input (V8 has no backtracking limit), quadratic loops, static files, multipart parsing, prototype pollution | In progress |
| Remove PHP; branch `php-2.x` keeps the last PHP version as reference; parity tests read `OYS_PHP_REF` | After the installer |

Points to settle before or soon after 3.0:
- Node checks only bcrypt password hashes (`$2y$`, `$2a$`, `$2b$`). Check production before the switch:
  `SELECT LEFT(password,4), COUNT(*) FROM users GROUP BY 1`.
- Image uploads: RGB PNGs with a tRNS chunk and CMYK JPEGs come out slightly differently from PHP's GD.
- The share image takes about 250 ms of CPU the first time (blocks the event loop) – move it into a worker later.
- A YouTube music link with array parameters (`?v[]=`) gives a 500 for the whole page (PHP did the same) – drop the
  music instead.
- Several JSON decoders exist in the packages (`content/util`, `honeycombs/util`, `community/json`, `updates/util`) –
  merge them into one in the core.
- The privacy page should mention Cloudflare and the Discord bot data.

## New features (PR #14, `feature/new-features`)

Numbers and dependencies: `ROADMAP.md` §4.0. "Built" = implemented with tests and merged into
`feature/new-features`; "reviewed" = the fixes of an independent review are merged too.

| # | Item | Title | State |
|---|---|---|---|
| 1 | CORE-1 | Shared foundations | Built and reviewed |
| 6 | CD-5a | Notification core and bell API | Built and reviewed |
| 21 | CS-1 | Admin split (Honeycombs and Code pages as separate sections) | Built and reviewed |
| 28 | HC-1 | Yellow honeycomb icons | Built and reviewed |
| 2 | DP-1 | Discord settings form and real errors (the webhook / channel ID loop of Q13) | Built and reviewed |
| 4 | DP-4 | Own pages: changelog and roadmap | Built and reviewed |
| 3, 5, 12 | CD-0, CD-1, CD-3 | Dialog contract, dialog and notice library, admin and sign-in confirmations | Built; review in progress |
| 15, 23, 24 | CD-2, CD-4, CD-5b | Editor dialogs, guard and drafts; themed dialogs on profile pages; bell in the editor and admin header | Being built (no separate review) |
| 8, 16 | HC-2, HC-3 | Ledger, entitlements, Premium status; catalogue, offers, purchases, refunds | Being built |
| 9, 29 | ST-1, ST-2 | Status core; checker, sensor, installer units | Being built |
| 10, 18 | CS-2, CS-3 | Address registry with holds; code slots data model and routing | Being built |
| 11 | PD-2 | Custom domain core (dormant) | Built; review in progress |
| 7, 13, 14 | DP-2a, DP-3, DP-5 | Delivery model and bot API; bot 0.2.0; public suggestions page | Being built (no separate review – covered by the final security review) |
| – | all others | | Open |

Next, as soon as their dependencies are in:
- Discord: DP-2b (admin UI for bot posting, after the dialog library).
- Premium and domains: PD-1 (Premium flags, branding), PD-3 (domain worker), PD-1b, PD-4 (domain in the editor), PD-5,
  PD-6.
- Shop: HC-4 (editor tab), HC-5, HC-6a, HC-8, then HC-7a/7b, HC-6b, HC-9.
- Status pages: ST-3 (notifier and OnYourSite's own status page), ST-4 (status pages for users), ST-5, ST-7.
- Code pages: CS-4, CS-5, CS-6 (code slots in the editor, live).
- Later (Stage C): `ROADMAP.md` §4.2.

Work in progress lives on branches of the current workspace and is pushed when it is merged into
`feature/new-features`; this file says what is already in. Small fixes from other contributors arrive as pull
requests into `feature/new-features` (for example #16, the weekly report's best link).
