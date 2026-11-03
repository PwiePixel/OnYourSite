# Planning: OnYourSite 3.0 and the new features

This folder is the shared plan. Whoever continues the work starts here and keeps it current: when you finish a step or
change the plan, update `STATUS.md` (and the documents you changed) in the same push.

## Documents

| File | Content |
|---|---|
| `STATUS.md` | What is done, in progress and open, with branches – **start here** |
| `DECISIONS.md` | The owner's final answers (Q1–Q14, D1–D20). They override everything else |
| `ROADMAP.md` | The spec of record: ground rules (§2), shared contracts (§3), the pull requests in merge order with their content (§4), installer changes (§5), critical path (§7) |
| `EDITS.md` | Corrections the designs still need – apply them when you implement the affected item |
| `designs/` | The six detailed designs: `custom-dialogs.md`, `discord-pages.md`, `code-slots-admin.md`, `honeycomb-shop.md`, `premium-domains.md`, `status-pages.md` |

- Where documents disagree: `DECISIONS.md` > `ROADMAP.md` > `EDITS.md` > designs.
- Release 3.0 is Node.js only (`DECISIONS.md`, Q10). Ignore anything about a PHP rollback, PHP mirrors, legacy
  fallbacks for PHP or a "3.1" gate – none of it is built.
- "Q…" and "D…" are the owner questions; `DECISIONS.md` lists each one with its answer. "The brief" is the original
  task description for the designs (not in the repository).
- `$S/…` in the designs points to the original development workspace (test harnesses, stand-ins for Discord and
  Cloudflare, reproductions). It is not in the repository; the text says what each tool does.

## Branches and pull requests

| Branch | Pull request | Content |
|---|---|---|
| `main` | – | Release 3.0 (Node.js only) with the new features – PR #15 (the port) and PR #14 (the features) are merged |
| `php-2.x` | – | The last PHP version; the parity tests read it through `OYS_PHP_REF` |
| `feature/owner-decisions` | after #14 | The owner's decisions R1 and R2 from the reviews (`DECISIONS.md`) |

- New work: one branch per roadmap item (or a small group of dependent items), started from `main`. Merge back as
  one squash commit after the tests pass, then update `STATUS.md`.
- Never force-push a shared branch, never push to `main` directly.

## How to build a roadmap item

1. Read `DECISIONS.md`, `ROADMAP.md` §2 and §3, the item's block in `ROADMAP.md` §4.1, the matching section of its
   design and the `EDITS.md` entries for that design.
2. Check its dependencies in `ROADMAP.md` §4.0 – they must be merged first.
3. Use the existing core in `app/src` (database helpers in `db.ts`, schema steps in `schema.ts`, notifications in
   `notify/`, account deletion hooks, admin shell); never re-implement it.
4. Write the tests the block names (unit, database, HTTP; Playwright for the named flows in `tests/e2e/`).
5. `cd app && npx tsc --noEmit -p . && npm test` must pass before the merge.

## Rules for every change

- Every text a user or admin sees is English. Code comments are German.
- Keep the current visual design: the same Tailwind classes, colours, spacing and components as the surrounding pages.
- No new npm dependencies without a strong reason.
- Security: auth and CSRF on every state change, rate limits as designed, no SSRF, no address or domain takeover,
  private areas `noindex`, honeycomb writes race-safe, no secrets in logs.
- No PHP code and no PHP compatibility code in new work.
- Commits: author `PwiePixel <github@pixelcst.tech>`, no trailers; commit messages describe the change only.
- Never commit `config.php`, `config.json`, `email/smtp.json` or `static/uploads/*`. No real tokens or token-like
  test values in committed files – build them at runtime in tests. Scan every staged diff for tokens, keys and
  certificates before you commit.

## Development environment

- Node.js 22, MariaDB 10.6+ (or MySQL 8), Chromium for the Playwright flows.
- `cd app && npm ci`.
- `config.json` in the repository root (or the path in `OYS_CONFIG`) with the same keys as `config.example.php` and
  a test database whose name starts with `oys_test` (the browser flows refuse other names).
- Until the PHP removal step is merged (see `STATUS.md`), the parity tests run the PHP version in the repository
  (`php` 8 with PDO MySQL, GD and mbstring) and read `config.php` next to `config.json`
  (`php app/scripts/config-from-php.php config.php > config.json` converts it). After that step they read a checkout
  of the branch `php-2.x` from `OYS_PHP_REF` and are skipped without it.
