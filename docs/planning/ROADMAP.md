# Roadmap – the six features after the Node port

Integrated delivery plan for discord-pages, custom-dialogs, code-slots-admin, honeycomb-shop, premium-domains and
status-pages. Written 2026-11-01 by the lead architect from `BRIEF.md`, the six revised designs in this folder,
`PORTING.md` §1/§3, `spec/plan.md` §3.4/§5, and the three cross-design reviews (contracts `XD-01…17`, security
`X1…X14`, requirements `R1…R13`). Every finding was checked against the designs and against the repository
(`/home/user/OnYourSite`, branch `feature/node-typescript` @ `e01a003`); §9 says how each one was handled. Revised the
same day with the owner's final answers (`DECISIONS.md`): they are the baseline of this file, and §6 lists their
effects.

Companion files in this folder:
- `DECISIONS.md` – the owner's final answers to Q1–Q14 and D1–D20. Where anything here or in a design differs, they
  win.
- `QUESTIONS.de.md` – the questions (Q1–Q14) and the defaults (D1–D20) as they were put to the owner.
- `EDITS.md` – the concrete edits each design (and `plan.md`) needs to match this file.

---

## 1. How to read this

- **PR IDs:** `CORE-1` (core), `CD-n` custom-dialogs, `DP-n` discord-pages, `CS-n` code-slots-admin, `HC-n`
  honeycomb-shop, `PD-n` premium-domains, `ST-n` status-pages. honeycomb-shop's HC-6 and HC-7 are split
  (HC-6a/6b, HC-7a/7b/7c, finding R1); all other PR numbers are the designs' own.
- **Baseline:** the owner's answers (`DECISIONS.md`): Q1 b, Q2 c, Q3 a, Q4 a, Q5 a, Q6 a, Q7 a, Q8 a, Q9 a,
  Q10 "everything must work without PHP", Q11 a with the owner's own Mailcow, Q12 a, Q13 the Discord loop (a required
  DP-1 test), Q14 a, and D1–D20 as listed in `QUESTIONS.de.md`. No PR waits for an owner answer any more; §6 lists
  what each answer changed.
- **Positions:** `#1` … `#44` is the recommended merge order after 3.0 (§4). Every PR merges as soon as its
  dependencies are in; PRs without a dependency between them may merge in any order. `C1` … `C5` are the later steps
  (Stage C).
- **Precedence:** for anything that crosses a design boundary this file is the spec of record. Where a design still
  says otherwise, `EDITS.md` lists the fix; until it is applied, this file wins.
- **Migration steps** are written as symbolic constants (`V_SHOP_CORE`); numbers are assigned at merge (§3.1).

---

## 2. Ground rules

### 2.1 Releases

1. **3.0 is the pure port, and it is Node-only** (Q10). After the parity gate (plan §4.7) the PHP site leaves the
   tree in 3.0: `*.php` in the root, `lib/`, `views/`, `PHPMailer/`, `cron/weekly_report.php`, `server/*.php`,
   `.htaccess` and `tests/unit.php`. A `php-2.x` branch keeps the last PHP version as the reference for the
   development parity tests, nothing else. No PHP is installed on fresh servers, and nothing on the server needs PHP
   after the migration.
2. **The installer switch** (plan §5) migrates up to schema 5 (sessions) and nothing else: plan §5.3 step 6
   ("v6 = Wave 3") is dropped, because the Wave-3 work is now discord-pages with its own named steps (R5, XD-13).
3. **No PHP rollback.** There is no `install.sh --rollback`, no two-week window and no 3.1 gate. Safety instead
   (§2.4): `install.sh --update` always takes a backup first; the migration from PHP aborts with the PHP site still
   serving if anything fails before the switch, and reverts automatically if the check right after the switch fails.
   Because the 3.0 tree holds no PHP code, the installer has to keep the PHP site serving from the previous release's
   files until that check has passed; plan §5.3 must say how (`EDITS.md` PL-E9).
4. **Feature PRs (§4.1)** merge after 3.0, each as soon as its dependencies are in, and ship with the next release.
   Development may start earlier. No PR carries PHP-rollback code (§2.2).
5. **Stage C (§4.2):** the steps the owner placed later (auto-renewal once the Premium sale has started, visitor
   subscriptions, the extras of Q14), notification retention and the follow-ups.

### 2.2 No PHP-rollback code

The rollback classes (N, W3, L) of the first version of this file are gone (Q10): no PR has to stay usable by a PHP
site. Every PR is built for Node only:
- no patches to the PHP tree, no `install.sh --rollback` steps or refusals, no checks or repairs after a
  roll-forward (such as `status:slug-check`);
- no legacy fallbacks or mirrors written for PHP: no Discord settings v1 mirror and no old update columns written for
  PHP, no `oys_meta` price mirror, no legacy editor adapter, no `.toast*` rules kept for PHP views, no `bell.js`
  self-loading or PHP answer shapes, no legacy honeycomb modal, no `var(--hc, …)` fallbacks for PHP views;
- no outbox parking for a rollback;
- no tests that run PHP against a migrated database ("PHP compatibility", "rollback smoke", `hc-rollback.js`).

Paths that serve Node itself stay: `has()`'s ledger fallback for unlock rows the old process writes during a deploy
(§3.2), `discordSettingsFromV1()` for settings from a restored old backup, and `page.js` leaving profile pages as they
are when `ui.js` is blocked (custom-dialogs §3.5). `EDITS.md` names every design section that goes.

### 2.3 Rules for every PR

- Built on Node (`app/`) after the port; UI text English, code comments German, identifiers English; the naming rule
  of `BRIEF.md` (constraints) for code, texts and commits; no new runtime dependency (the designs need none).
- No PHP-rollback code (§2.2).
- Auth + CSRF on every state change, rate limits as designed, no SSRF, no domain or address takeover, private areas
  `noindex`, honeycomb writes race-safe.
- **Connection rule:** code that holds a pool connection never asks the pool for a second one. Every shared read API
  takes an optional `db`; network calls never run inside a transaction; enforcers run after the caller released its
  connection.
- Each PR ships its tests (unit, DB/HTTP, Playwright flows named in its block). From CD-1 on, the dialog flows
  (custom-dialogs §9) fail on a native `alert/confirm/prompt`; CD-2, CD-3 and CD-4 extend this to the suites of the
  area each converts (editor; admin and sign-in; profile pages), so from CD-4 on every e2e run fails on one.
- Each PR keeps the site working when deployed alone (dormant code and admin switches as designed).

### 2.4 Recovery

There is no live downgrade. From 3.0 on, `install.sh --update` always takes a backup first
(`server/backup.sh before-update`: DB dump, settings, hard-link upload snapshot); on the migration from PHP this is the
`before-node` backup of plan §5.3 step 3. This used to be CORE-1's before-update backup, taken only when migrations
were pending; it is now part of the 3.0 installer and runs on every update. A failed release is fixed forward, or
restored from that backup plus the previous release tag; `server/README.md` documents the restore. The one
non-additive step (`codeSlots`) needs nothing beyond this.

---

## 3. Shared contracts

### 3.1 Schema steps and migrations (owner: core, CORE-1)

- **One convention** (XD-13): each step is `async function <name>(conn)` in `app/src/schema.ts` with
  `export const V_<NAME> = <n>`. Numbers are the next free version **at merge time**, in the merge order of §4;
  `SCHEMA_VERSION` = the highest. `ensureSchema` runs `if (version < V_X) await x(conn)` in that order and stores the
  version after all steps (as today, `app/src/schema.ts:53-70`), so every DDL statement is guarded.
- **Helpers** (CORE-1, code-slots-admin's signatures): `hasIndex`, `addIndex`, `dropIndex`, `columnIsNotNull`, next to
  the existing `addColumn`. No feature defines its own. `ensureSchema({upTo})` for test fixtures; tests import the
  constants and never write numbers.
- Each step's header comment names the earlier steps it needs. The merge order matters (a step that reads another
  step's table must run after it); "the merge order does not matter" is wrong and is removed from the shop design.
- Data steps write bell rows only through `notify(…, {db: conn})` (§3.6).
- Background processes (status checker and notifier, domains worker, jobs runner) never migrate; they wait read-only
  until `schema_version` ≥ their step.
- The only non-additive step is `codeSlots` (drops `code_sites.uq_user`, makes `code_sites.slug` nullable); the
  before-update backup covers it (§2.4).

Expected steps in merge order:

| Step constant | PR | Contents | Needs |
|---|---|---|---|
| `V_NOTIFICATIONS_INDEX` | CD-5a | `notifications` `KEY idx_user_id (user_id, id)` | – |
| `V_DISCORD_DELIVERY` | DP-2a | `update_discord_posts`; `community_outbox.ref/next_try_at/claimed_at` + `idx_ref`; Discord settings v1 → v2 (no v1 mirror); existing posts as rows | – |
| `V_SHOP_CORE` | HC-2 | ledger `actor_id` + indexes; `users.premium_until` + index; `hc_accounts` (without `mail_reminders`); `hc_entitlements` (without the `renew_*` columns); `hc_audit`; backfill of all `unlock/*` rows and code sites | – |
| `V_STATUS_TABLES` | ST-1 | all status tables except `status_subscribers`/`status_broadcasts` (Q8 = a); `status_pages.limit_paused`; `users.status_terms_at`; system page seed (registry claim only if `site_addresses` exists) | – |
| `V_SITE_ADDRESSES` | CS-2 | `site_addresses` with `hold_until`; backfill from `pages`, `code_sites` and – when present – `status_pages` | – |
| `V_CUSTOM_DOMAINS` | PD-2 | `custom_domains`, `custom_domain_log`, `pages.custom_domain` + `uq_custom_domain` | – |
| `V_PUBLIC_PAGES` | DP-5 | `community_suggestions.web_state/web_notice/removed_at` + `idx_web`; reserve `suggestions` (path pages → subdomain, owners notified through `notify()`) | `V_NOTIFICATIONS_INDEX` |
| `V_SHOP_CATALOGUE` | HC-3 | `hc_items`, `hc_offers`, `hc_purchases`; `seedItems()` after the steps (start prices of Q4) | `V_SHOP_CORE` |
| `V_BRANDING_LEGACY` | PD-1 | page settings: `branding_legacy` and the Q9 grandfathering | `V_SHOP_CORE` |
| `V_CODE_SLOTS` | CS-3 | code slots (non-additive, see above), counters, `pages.code_site_id`, ban columns, `code_moderation` | `V_SITE_ADDRESSES` |
| `V_SHOP_STREAKS` | HC-8 | streak columns + backfill | `V_SHOP_CORE` |
| `V_SHOP_EVENT_CODES` | HC-9 | `hc_codes` | – |
| `V_SHOP_MAIL` | HC-7b | `hc_mail_outbox`, `hc_accounts.mail_reminders` | `V_SHOP_CORE` |
| `V_SHOP_AUTO_RENEW` | HC-7c (Stage C) | `hc_entitlements.auto_renew, renew_item, renew_max_price, renew_seq, renew_failed_at, renew_notified_for, renew_notified_kind` | `V_SHOP_CORE` |
| `V_STATUS_SUBSCRIBERS` | ST-6 (Stage C, Q8 = a) | `status_subscribers`, `status_broadcasts` | `V_STATUS_TABLES` |

### 3.2 Entitlements and ledger (owner: honeycomb-shop)

- **Source of truth:** a balance is `SUM(honeycomb_ledger.amount)`; the ledger is append-only. Every change of what a
  user owns writes a ledger row plus derived state (`hc_entitlements`, `users.premium_until`) in **one** transaction
  under `withAccount(uid)` (row lock on `hc_accounts`, `WAIT 5`; earning `NOWAIT`; deadlock retried once).
- **Modules in HC-2** (moved forward, XD-07): `ledger.ts`, `entitlements.ts`, `reconcile.ts`, `premium.ts` **and
  `features.ts`** with `registerFeature`, `registerPerk`, `premiumPerks`, `registerLossPreview`. HC-3 adds
  `catalogue.ts`, `offers.ts`, `shop.ts` and `seedItems()` (registrations made before HC-3 live in memory only).
- **Read API** (all take an optional `db`): `has(uid, feature, db?)` = an active lot, **or** – for a permanent feature
  without any entitlement row – the ledger row `unlock/<feature>`, **or** `feature.includedFor(user)` (one users
  primary-key read on the same `db`; XD-15). `quantity()`, `entitlement() → {active, until, quantity, permanent,
  lots}`, `isPremium`/`premiumActive`/`userPremium`, `premiumState`, `isPremiumRow`. The ledger fallback covers unlock
  rows the old process writes between `migrate` and the restart of a deploy; it is not there for PHP (§2.2).
- **Spending:** `buy(ctx, uid, itemKey, requestId, expectedPrice, opts)` is the only way to spend. Its first check
  after the request-id format is new: **admin mode** (session `original_admin_id` and `via !== 'auto'`) → 403
  `{ok:false, code:'admin_mode', error:'Buying is turned off in admin mode.'}` (X6). `purchaseUnlock()` (text or
  `null`) and `shopPrice()` stay as thin wrappers.
- **Every route that spends** (`shop-buy`, `code-unlock`, `status-unlock`) uses one contract (XD-04, XD-15):
  - input `request_id` (32 hex, created by the browser when the dialog or unlock box opens) and `expected_price`;
  - missing `request_id` → 409 `{"ok":false,"error":"OnYourSite was updated – please reload the editor.","reload":true}`;
  - admin mode → 403 (from `buy()`); price changed → 200 `{ok:false, code:'price_changed', price, error}`;
  - success answers carry top-level `notices` (§3.4). `code-unlock` and `status-unlock` call `buy()` directly.
- **Grants** (`grantFeature`/`revokeFeature`, HC-6a): `formRef` (16 hex) is required for timed and count grants and
  optional for permanent grants, which stay idempotent through the `unlock/<feature>` row (XD-15). The free unlocks
  in the code-pages and status admin call `grantFeature(adminId, uid, feature, {permanent: true}, note)`. The
  code-pages admin (CS-1, CS-5) is in before HC-6a and books them until then with `hcAdd(uid, 0, 'unlock', item, …)`,
  which runs through HC-2's `grantUnlock` (code-slots-admin §4.6). The status admin has no such path, so ST-4
  depends on HC-6a.
- **Enforcers** (`registerEnforcer({name, features, inline, run})`, XD-16): a reconcile function that reads the
  current state under its own per-user lock, holds at most one connection, and is idempotent **including its side
  effects**: a re-run never sends a bell row or mail. A user-visible notice is sent only for a transition recorded in
  the feature's own rows. `markReconcile` runs in the same transaction as every change; HC-7a's job retries.
  Registrations: premium-domains `domains` (`premium`, `custom_domain`; inline), code-slots-admin `slots`
  (`code_page`, `code_more`; inline), status-pages `status` (`status_page`, `status_more_checks`,
  `status_fast_checks`, `premium`; inline). `slots` does not list `premium`: Premium never changes page or code-page
  limits (Q1 = b).
- **Catalogue** (start prices of Q4 = a; admins change them later):

| Feature | Registered by (PR) | Kind | Option → start price |
|---|---|---|---|
| `premium` | shop (HC-2) | timed, stack 1, ≤ 400 days ahead, account ≥ 30 days and ≥ 10 active days | `premium_30` 350 · `premium_90` 700 |
| `code_page` | code-slots-admin (`code/shop.ts`, created by HC-3) | permanent | `code_page` 100 |
| `code_more` | code-slots-admin (CS-4) | permanent, requires `code_page`, `freeAtZero` | `code_more` 0 (more code pages are free) |
| `status_page` | status-pages (ST-4) | permanent (one price, no rent), `includedFor` admins | `status_page` 150 |
| `status_more_checks` | status-pages (ST-7) | timed 30 days, stack 2, +10 checks per pack | `status_more_checks_30` 60 |
| `status_fast_checks` | status-pages (ST-7) | timed 30 days, checks every minute | `status_fast_checks_30` 80 |
| `custom_domain` | premium-domains (PD-4) | count, max 10, requires `premium`; seeded inactive and hidden while the admin switch `slots` is off (Q3 = a: off) | `custom_domain_x1` 150 (R12) |

- **Earning** (HC-8, Q4 = a): streak bonus +15 after 7 days and +50 after 30 days in a row (repeating, as
  honeycomb-shop §4.6 counts them); daily cap 300 for automatic rewards.
- **Not in v1:** address passes (`address_pass`, `consume()` callers), page slots, storage steps, cosmetics,
  referrals, visitor milestones, community rewards (shop L1–L5). Order after v1 (Q14 = a): visitor milestones and the
  anniversary bonus (L2) first, then invite friends (L1), then the new purchasable designs (L3); address passes and
  storage (L4), community rewards (L5) and the Discord extras (DP-6) later.

### 3.3 Premium status and staff privileges (owners: honeycomb-shop for the status, premium-domains for the editor flags)

- **Stored:** `users.premium_until` – `NULL` none, a date, or `9999-12-31 23:59:59` for good – written only by
  `setPeriod` in the same transaction as the `premium` entitlement.
- **Checks:** `isPremiumRow(user) = is_admin || premium_until > now` (no query); `premiumState(uid, db?) → {active,
  until, forever, source}`; both read the database, never the session. `isStaff(ctx, user) = is_admin ||
  original_admin_id` (today's `hasPremium`, renamed in PD-1).
- **What Premium includes** (Q1 = b):
  - a custom domain for link pages, included in Premium – one per link page, at most 3 per user (Q3 = a; PD-4);
  - no OnYourSite branding (Q2 = c): "Made with OnYourSite" and the OG-card mark go (PD-1); "| OnYourSite" leaves the
    title, the owner's avatar becomes the favicon, and on code pages the badge becomes a plain "Report" link (PD-1b);
  - more for status pages: 30 checks instead of 10, checks every minute, 250 subscribers once visitor subscriptions
    exist (ST-7, ST-6). Nothing else: the design's Premium values for alert channels (5) and daily broadcasts (10)
    are not part of Q1, so their defaults become the free plan's (3 and 3); they stay admin settings (EDITS ST-E22).

  **Staff only, not Premium:** no page limit, no address cooldown, 1000 MB upload quota. Page count, address cooldown
  and storage stay the same for every other account.
- **The cooldown exemption is `isStaff()`** on the server and `E.staff` in the editor, for link pages and for code pages
  on page addresses alike (XD-03, X13). Address passes are a later shop step (L4).
- **Editor bootstrap keys:**

| Key | Meaning | Added by |
|---|---|---|
| `E.premiumUntil`, `E.premiumForever` | the user's real Premium | HC-2 |
| `E.premium` | `isPremiumRow(user)` (meaning changes) | PD-1 |
| `E.staff` | `isStaff()` | PD-1 |
| `E.pagesUnlimited` | `isStaff()` in PD-1; `pageAllowance().unlimited` from CS-3 (the same value under Q1 = b, so the two PRs work in either order) | PD-1, CS-3 |

  `editor.js:593`, `:694` and `:2716` (page limit) switch to `E.pagesUnlimited` in PD-1 (code-slots-admin's `:716` is
  not a limit check – verified); `:2768` (cooldown) to `E.staff`; the branding switch (`:2733-2734`) to
  `E.premium || E.staff`.
- **Branding helpers** (`content/branding.ts`, PD-1): `footerHidden(settings, ownerPremium)`,
  `fullyUnbranded(settings, ownerPremium)` (PD-1b), `ownerPremium(page, db?)`. Link pages and status pages use
  `footerHidden` (XD-15: there is no `brandingHidden`); title and favicon follow `fullyUnbranded` (Q2 = c).
  "Report this page" links always stay.
- **Rollout:** Premium stays hidden until PD-1 registers the branding perk (`ready`). Timed options can be switched
  on only after `LIFECYCLE_READY` (HC-7a); before that an admin can grant Premium only for good (HC-6a). Selling
  starts when an admin activates the options in HC-5's catalogue.
- **Ending:** perks stop at read time; HC-7a processes the end (bell, reconcile). Domains are suspended (forward
  30 days if live ≥ 14 days, D5), status limits drop, branding shows again. Data is never deleted.

### 3.4 Dialog and notice API (owner: custom-dialogs)

- **Contract:** `static/js/ui.d.ts` (CD-0), additive only after sign-off by honeycomb-shop and code-slots-admin.
  Global `window.OYSUI` from `static/js/ui.js` (CD-1).
- **Dialogs:** `alert`, `confirm`, `prompt` (`match`, `normalize: trim|lower|slug|host`, `matchLabel`, `transform`),
  `choice`; `content` (a node or a builder) carries every DOM node – **`text` is plain text only** (XD-09);
  `canConfirm`, `onConfirm(values, ctl)` (a returned string keeps the dialog open), `ctl.update()`.
- **Notices:** server answers may carry top-level `notices: Notice[]` (≤ 3; bootstrap ≤ 12), `Notice = {tone, text,
  title?, amount?, action?: {label, link}}`. Only `OYSUI.handle()` and the editor's start code render them.
- **Server forms:** every destructive or money-moving admin form renders `confirmAttrs()` **and** `confirmField()`;
  the admin dispatcher (and the impersonation route) refuses `_confirmed !== '1'` when the field is present (fail
  closed, CD-3). Typed confirmations use `data-confirm-match/-normalize/-into` or a visible field checked by the
  server; value-dependent texts use `OYSUI.beforeSubmit`.
- **Navigation:** one `OYSUI.guard({isDirty, onDiscard, keepsDraft})` per page; code navigations go through
  `guard.navigate(url, {force})` / `guard.reload()`. No `leaving` flag and no `location.href =` in guarded scripts
  (lint, XD-09).
- **Layers:** the editor's `openModal()` is registered with `OYSUI.layer()` in CD-2 and stays the container for
  multi-field dialogs.
- **Deep links:** `/dashboard#<target>[/<arg>]`, mapped by the editor's `DEEP_LINKS`. Targets: `content`, `design`,
  `stats`, `messages`, `code`, `settings`, `settings/domain` (PD-4), `honeycombs[/<feature>]` (HC-4),
  `status[/system]` (ST-3; never `status:system` – the colon fails `safeLink`, XD-11). Links with `?page=`/`?site=`
  navigate through the guard.
- **Colours:** the `--hc*` tokens live in `ui.css` (CD-1). honeycomb-shop HC-1 owns every honeycomb colour in
  `editor.css`, the views and the admin (including `.toast.hc` while it exists, R10, XD-12).
- **Lint** (`tools/check-native-dialogs.mjs`): native dialogs, inline `onsubmit`/`return confirm`, bare
  `location.*` in guarded scripts, raw `INSERT INTO notifications` outside `app/src/notify/` – warning from CD-1 and
  CD-5a, error from CD-4. There is no `oys-legacy` exception (§2.2).

### 3.5 Address model (owner: code-slots-admin, `content/addresses.ts`, CS-2)

- **Table** (XD-01, X1):

```sql
CREATE TABLE IF NOT EXISTS site_addresses (
    slug VARCHAR(63) NOT NULL PRIMARY KEY,
    kind VARCHAR(8) NOT NULL,          -- page | code | status | held
    ref_id INT NULL,                   -- pages.id | code_sites.id | status_pages.id; NULL while held
    user_id INT NULL,                  -- NULL: system page, or held for nobody
    claimed_at DATETIME NOT NULL,
    released_at DATETIME NULL,
    hold_until DATETIME NULL,          -- end of the hold (kind = 'held'), NULL otherwise
    KEY idx_ref (kind, ref_id), KEY idx_user (user_id), KEY idx_hold (kind, hold_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- **Hold policy, one table in `addresses.ts`:** `page` and `code` – held 30 days if used for at least 7 days,
  otherwise free at once (anti-squatting); `status` – held 90 days always (`minUseDays` 0), because subscriber mails,
  Discord embeds and `/summary.json` integrations point at it. The policy is chosen by the row's kind, so callers pass
  no days.
- **API:** `claimAddress(db, slug, kind, refId, userId: number | null)` – insert first; on a duplicate, take over the
  caller's own hold or an expired one (`hold_until < now`), else `AddressTakenError`.
  `releaseAddress(db, slug, userId: number | null, holdFor: 'owner' | 'nobody' = 'owner')` – applies the policy and
  prunes up to 50 expired holds. `releaseUserAddresses(db, uid)` – every row of the account → held for nobody, per
  kind. `addressBlocks(row, mine)` (pure) uses `hold_until`.
- **Writes** happen in the same transaction as the row that uses the address. Lock order: `users` → `pages` →
  `code_sites` → `status_pages` → `site_addresses`, never the reverse. Account-wide slot changes run under
  `withSlotLock(uid)` (CS-3), which `domain-add` (PD-4) and the status page writers (ST-4) use as well.
- **`slugProblem(slug, exceptPageId?, exceptCodeId?, opts?: {userId?, exceptStatusId?, kind?, db?})`** reads the
  registry (plus today's two table checks as a guard against drift from manual SQL or a restored backup), the format
  rules, the reserved and forbidden names, and the new
  **`addressNameProblem(slug, kind)`** (X2): for every kind, refused when the joined letters contain `onyoursite` or a
  token is `oys`; for `code` and `status` also brand tokens and distinctive brands (status-pages' `statusBrandProblem`
  rules, moved here). It applies to every new claim and every address change, **including a code page taking over an
  existing slot's address** (`code-connect` on an existing slot, `code-move` to a page) – otherwise a brand-named link
  page could be turned into a code page. Existing addresses stay; `sites:repair` lists them for review. Verified with
  PHP: `onyoursite-status`, `oys-status`, `onyoursite-login`, `onyoursite-support`, `discord-status` and
  `paypal-status` are all allowed by `blacklist.php` today.
- **Reserved names:** `suggestions` (DP-5), `status` and `health` (ST-1; already forbidden subdomains), the custom
  domain names from the config (`edge`, `origin`, PD-2).
- **Routing on a subdomain:** link page → code page with its own address → status page → `status_slug_redirects` →
  404. The order only matters for legacy collisions, because the registry keeps addresses unique. A code slot and a
  status page on the main host's path form → 302 to the subdomain.
- **Cooldowns:** link pages, code pages on page addresses **and status pages** follow one rule – the first change is
  free, then once per 30 days, staff exempt. (status-pages' "only once the page has subscribers" is replaced; with the
  90-day hold and no minimum use this keeps a status owner to at most four held addresses per 90 days.)
- **E7:** a page with any `custom_domains` row – `domains.hasDomain(pageId, db)`, read inside `withSlotLock` and
  passed into the pure `canCreate`/`canMove` – cannot show a code page. The editor flag `pages[].custom_domain` is the
  same "row in any state" value from premium-domains' payload (XD-02, X8). Until PD-2 exists, `hasDomain` is a stub
  that returns false.
- **`sites:repair`** (run by `install.sh --update` from CS-2 on): inserts missing rows (a live page or code page beats
  a hold), turns rows whose page, code page or **status page** no longer has that slug into holds for the owner (status
  rows are checked against `status_pages` and skipped while that table does not exist), never gives a status or held
  address to another row, recounts code counters, and prints anomalies including name-rule violations.
  `sites:release <slug>` ends a hold after a support request.
- **404 view:** live and held addresses count as taken ("Page not found", never "This address is available").
- **Privacy text:** "your addresses stay reserved for 30 days (status pages: 90 days)".

### 3.6 Notifications (owner: custom-dialogs, `app/src/notify/`, CD-5a)

- `notify(uid, type, title, body, link, {db})` and `notifyAdmins(type, …, {db})` are the **only** writers of
  `notifications` (lint). Title ≤ 190, body ≤ 255 code points; `link` through `safeLink`
  (`^/(?!/)[A-Za-z0-9/_.~%#?=&-]*$`, ≤ 255 bytes).
- **Exactly once comes from the feature's own state:** the bell row is written in the **same transaction** as the state
  change it reports (ledger row, `reminded`, `expiry_done_at`, a domain state CAS, a status outbox row marked sent, a
  `code_moderation` row). There is no `ref` and no de-duplication in `notify()` (XD-09).
- **Types** (all rows ship in CD-5a's catalogue): `message`, `booking`, `honeycombs`, `unlock`, `code`, `domain`,
  `domain_live|domain_back|domain_problem|domain_paused|domain_removed`, `status`, `status_down`, `status_up`,
  `status_team`, `team`, `system`.
- **Link formats:** `/dashboard#<target>[/<arg>]`, `/dashboard?page=<id>#settings/domain`,
  `/dashboard?site=<id>#code`, `/admin#<tab>`. No colons.
- **One channel per event** (custom-dialogs §5.8 with honeycomb-shop's rule; XD-10, R13):

| Event | Toast in the open tab | Bell (`type`) | Email (§3.8) |
|---|---|---|---|
| Result of the user's own action | `notices` in the answer | – | – |
| Rewards earned when opening the editor | bootstrap `notices` – only rewards earned on that load | – | – |
| Honeycombs given, taken, refunded by the team; unlock grants and revokes | the bell poll's toast | `honeycombs` / `unlock` | – |
| Unlock or Premium ends soon / ended / renewal result | the bell poll's toast | `unlock` | Premium ending and ended (Q11 = a) |
| Code page blocked, unblocked, deleted; code ban | the bell poll's toast | `code` | – |
| Custom domain live, back, problem, paused, removed | the bell poll's toast | `domain_*` | live, problem, paused (admin role only), removed |
| Status monitor down/up, team actions on a status page, inactivity pause | the bell poll's toast | `status_down`, `status_up`, `status_team` | owner alert settings |
| New message, booking | the bell poll's toast | `message`, `booking` | as today |
| Address changed by a migration | the bell poll's toast | `system` | – |
| Something needs an admin | editor and admin header bells | `team`, `status` via `notifyAdmins()` | the feature's rules |

- **Bell poll toasts** (CD-5b): the first poll takes a baseline, except unread items newer than the last toasted id
  stored per user in the browser; at most 3 toasts, then "+N more notifications".
- Account deletion removes the user's rows (§3.9).

### 3.7 Discord bot and outbox (owner: discord-pages)

- **Table:** `community_outbox` gains `ref`, `next_try_at`, `claimed_at` (`V_DISCORD_DELIVERY`).
- **Registry** (`community/outbox.ts`, DP-2a; XD-05):
  `registerBotAction(action, {feature: string | null, onResult?(db, job, result, error, final): Promise<void>,
  maxAgeSec?: number})`.

| Action(s) | Feature | `onResult` | `maxAgeSec` |
|---|---|---|---|
| `suggestion.decided`, `ticket.reply`, `ticket.close` | `null` (every bot) | – | – |
| `update.post`, `update.edit`, `update.delete`, `update.test`, `bot.report` | `updates.v1` | `applyBotResult` (posts state machine) | `update.post` 86400 (with its claimed → `only_if_posted` rule), `update.test` 120 |
| `suggestions.notice` | `suggestions.v2` | – | – |
| `status.alert` | `status.v1` | – | 7200 |
| `status.post`, `status.edit`, `status.delete` | `status.v1` | status-pages' incident-post handler | – |

- **Known features** = `hello` + every registered feature. `/_/bot/ping` and the `hello` answer list them; `hello`
  stores only known features (so `status.v1` survives once ST-3 registers it).
- **`hello` validator:** unknown **top-level keys are dropped**, not rejected; an optional `gateway: {ready: boolean,
  ping_ms: integer ≥ 0}` is accepted (ST-3's bot sends it); any other violation → 400.
- **Hand-out** (`GET /_/bot/outbox?f=…`, signed): open, `attempts < 10`, `next_try_at` due, the feature is in the
  polling bot's `f`, and no earlier open job with the same `ref`. A never-claimed job older than its `maxAgeSec` is
  marked done (`'expired'`) and its `onResult` gets the final error. discord-pages' special reconcile rules for
  `update.*` stay.
- **`/done`:** one transaction; the job row is locked; the registered `onResult` runs in that transaction; errors back
  off (10 s doubling, at most 1 h, 10 tries). A repeated `/done` changes nothing.
- **Refs:** `post:<postId>`, `test`, `report`, `notice`, `ticket:<id>`, `suggestion:<id>`, `status-inc:<incidentId>`,
  `status-alert:m<monitorId>` and `status-alert:sys` (watchdog, gate). Alerts of different monitors never wait for
  each other; alerts of one monitor stay in order (X10; chosen over one ref per alert so a "back up" never overtakes
  its "down").
- **Bot side:** post-type handlers send a nonce `oys-<action>-<jobId>` with `enforceNonce` where Discord supports it;
  results travel in `done.result`. Versions: 0.2.0 (DP-3: `updates.v1`, then `suggestions.v2` with DP-5b), 0.3.0
  (ST-3: `status.v1`, `gateway`).
- **Channels:** `CHANNEL_SPECS` in `discord-bot/src/setup.js` – `UPDATES_CHANNEL_ID` (DP-3), `STATUS_CHANNEL_ID`
  and `ALERTS_CHANNEL_ID` (ST-3). `discord-bot/install.sh --update` runs `--discord-channel <KEY>` once for **every**
  key missing from the settings file; `--channel <KEY>` retries one by hand (replaces `--updates-channel`).
  The website uses the channels the admin picks from the bot's report.
- **No PHP compatibility layer** (Q10): the outbox is never parked for a rollback, the stored Discord settings carry no
  v1 mirror, and `updates.discord_message_id/discord_target` are no longer written (the columns stay; the
  `V_DISCORD_DELIVERY` step reads them once to turn existing posts into rows).

### 3.8 Email policy (owners: each sender; Q11 = a)

| Event | Mail | Sent by | Opt-out |
|---|---|---|---|
| Premium (or another timed unlock) ends in 3 days, auto-renew off | yes | shop, `hc_mail_outbox` (HC-7b) | "Email me before an unlock ends" |
| Premium ended – by expiry, by a refund with "Also remove", or by a revoke – with the loss-preview lines | yes, only if the preview is not empty | shop, same template, ref `end:<entId>:<unix>` (XD-17) | same switch |
| Custom domain live, problem, removed; paused because the admin role was removed | yes, ≤ 1 problem mail per domain per 24 h | premium-domains worker (`custom_domain_log.mail = 1`) | – |
| Status alerts to the owner and verified extra addresses; inactivity warning | per page settings | status notifier (`status_outbox`) | per page |
| Status alert-address verification | yes | status notifier, class `confirm` | – |
| Status subscriber confirmations and broadcasts | only with ST-6 (Q8 = a: later, Stage C) | status notifier | unsubscribe link |
| Gifts, rewards, purchases, code moderation, team actions | no – bell only | – | – |
| Existing mails (messages, bookings, weekly report, newsletter) | unchanged | – | – |

Rules for every sender:
- The mail is queued **in the transaction of the state change** and sent by a background process, never in a web
  request or a transaction. The ported mail helper gets optional extra headers, a per-call timeout and a test
  transport (CORE-1).
- Templates in `email/*.json` with the weekly-report look; English; the footer names where to switch the mail off.
- Mail to third parties (subscribers, extra alert addresses) names the page address in plain text and carries a report
  link.
- **Mail server and budgets (Q11):** all mail goes through the owner's own Mailcow server, so there is no provider
  limit to stay under; Mailcow's own rate limits are the owner's to set in Mailcow. Our own conservative budgets stay,
  each an admin setting with these defaults (no longer placeholders waiting for provider limits):
  - status mail: `mail_per_min` 30 and `mail_per_day` 1,000 in the classes `system`, `confirm`, `owner`, and
    `broadcast` with ST-6 – Admin → Status (already admin settings, status-pages §3.3). Each page may use at most 10
    `confirm`-class mails a day (plus 10 % of its confirmed subscribers once ST-6 exists), checked with the per-page
    limiter, so no page can drain the class (X12);
  - the shop job: ≤ 100 mails per run – Admin → Honeycombs (HC-7b);
  - the domains worker: ≤ 20 mails a minute – Admin → Custom domains → Settings (read by PD-3, shown by PD-5).

  "At most one problem mail per domain per 24 h" stays a fixed rule (Q11).

### 3.9 Account deletion (owner: core, CORE-1; X5)

- One function `deleteAccount(ctx, uid)` in the admin port; features register
  `registerUserDeletion({name, order, run(db, uid)})`. All hooks run in **one transaction on one connection**, in this
  order; nothing in a hook touches the network:

| Order | Hook | Does |
|---|---|---|
| 10 | `domains` (PD-2) | compare-and-set every domain to `removing`, clear `pages.custom_domain`, cancel pending mail rows, set `custom_domain_log.user_id = NULL` |
| 20 | `status` (ST-4) | delete configuration rows (page, monitors, incidents, channels, subscribers, broadcasts, pending and sent outbox rows, redirects), insert `status_purge` rows |
| 30 | `code` (CORE-1 wraps today's `codeDeleteUser`; CS-3 extends it) | `codeDeleteRows` for every code page, `code_moderation` rows |
| 40 | `honeycombs` (HC-2) | `honeycomb_ledger` rows (moved here from the code hook), `hc_*` rows, `hc_audit.user_id = NULL` |
| 50 | `pages` (core) | `deletePage(page, db)` for every page (returns its files) |
| 60 | `account data` (core) | `notifications`, `messages`, `user_links`, `user_bookings`, `user_certificates` |
| 70 | `addresses` (CS-2) | `releaseUserAddresses` (held for nobody, per-kind policy) |
| 99 | `user` (core) | `DELETE FROM users` |

- After the commit: upload clean-up (page files, code uploads, the user's remaining upload files); the domains worker
  deletes hostnames; the status checker purges measured data. A failing hook rolls everything back and the admin sees
  "The user couldn’t be deleted – please try again."
- **Privacy page, one paragraph** (replaces code-slots-admin's "Nothing else is kept"): after an account is deleted,
  former addresses stay reserved for 30 days (status pages 90 days) without a link to the person; the domain-check
  history keeps a domain name for up to 90 days without the account; the honeycomb audit keeps only numbers.

### 3.10 Background processes and jobs

| Process | Unit | Created by | Connections |
|---|---|---|---|
| Website | `onyoursite-web.service` | plan §5 | pool 10 |
| Shared jobs runner `cli.js jobs:tick` (`registerJob`, `registerNightly`, `GET_LOCK` per job, writes `oys_meta['jobs']`) | `onyoursite-jobs.timer` every 5 min | HC-7a | own pool 3 |
| Domains worker | `onyoursite-domains.service` (DynamicUser, credential) | PD-3 code, PD-6 unit | 4 + 1 lock |
| Status checker / notifier / sensor | `onyoursite-status(-notify).service`, `onyoursite-status-local.timer` | ST-2, ST-3 | 4 / 3 / 1 |
| Discord bot | `onyoursite-bot.service` or Docker | DP-3, ST-3 | none |

- About 26 database connections in total, far below MariaDB's 151.
- Jobs that may register in the runner: the shop job (HC-7a), notification retention (CD-6); discord-pages' hourly
  outbox clean-up may move there from its in-process interval.
- **Health:** status-pages watches the runner (`job:runner`, reads `oys_meta['jobs']`) and the domains worker
  (`job:domains`, from `domains.health().workerAt`); its public `domains` component reads `domains.health()`
  in-process – major when the worker is not ok or the probe is stale while domains are live, hidden while
  `health().configured` is false. The fallback-origin URL probe is dropped: it never touches the custom-hostname
  catch-all (XD-06).
- `--reset` stops every unit before `DROP DATABASE`. There is no `--rollback` that would have to stop them (Q10).

### 3.11 Admin area and editor shell

- **Admin navigation** (after CS-1): Users … Updates, Roadmap, Discord, Community, **Honeycombs**, **Code pages**,
  **Custom domains** (PD-5), **Status pages** (ST-2), Storage & backups.
- **`ADMIN_TABS`:** `honeycombs` keeps today's style in CS-1 and turns yellow in HC-1
  (`border-yellow-500/30 bg-yellow-500/10 text-yellow-400`, icon `text-yellow-400`); `code-pages` brand; `domains`
  cyan; `status` lime (no other tab uses it).
- **`POST /admin` dispatch:** CSRF and `_confirmed` checks first, then `community_action` → `hc_action` →
  `code_action` → `domain_action` → `status_action` → `oys_action`. `/admin/api/` (DP-2b) answers 401/403 as JSON
  and is shared by all features. `/admin` sends `Referrer-Policy: no-referrer` (CS-5).
- **Editor rail:** Content, Design, Stats, Messages, Code page, Status, Honeycombs, Settings, Preview. Desktop-only
  feature items carry `.nav-desktop`. The rule is added by the first PR that needs it: HC-4 in the order of §4 (as
  honeycomb-shop §5.2 designs it), or ST-3 if that is in first; the other reuses it. The phone bottom bar keeps its
  seven items; Honeycombs opens from the header pill and Status from Settings on phones.
- **Editor API dispatch:** account-level actions run before "Create a page first." – CD-5a moves `notifications`,
  `notifications-read`, `messages`, `message`, `booking-delete`; CS-3 moves `weekly`, `weekly-test`, `discord`,
  `page-delete`. Feature branches: `code*` (CS-4), `shop`/`shop-*`/`hc-*` (HC-4), `status*` (ST-3/ST-4), `domain*`
  (PD-4, page level).
- **New bootstrap keys:** `notices` (CD-2/HC-8), `premiumUntil`, `premiumForever` (HC-2), `staff`,
  `pagesUnlimited` (PD-1), `code`, `openSite` (CS-6), `domains` (PD-4), `statusTerms`, `statusAdmin` (ST-3/ST-4),
  `user.id` (CD-2).

---

## 4. Pull requests in merge order

### 4.0 Overview

Every PR merges after 3.0, as soon as the PRs in "Depends on" are in. **Depth** is the length of the longest chain of
PRs that must be in first (0 = only 3.0; soft dependencies are not counted); within one depth the order is a
recommendation, and step numbers follow the actual merge order. "soft" marks a dependency that works in either order;
the recommended order puts two PRs before their soft dependency (CS-3 before CS-1, HC-4 before HC-1), and their blocks
say what the later PR then does.

| # | PR | Title | Depends on | Schema step | Depth |
|---|---|---|---|---|---|
| 1 | CORE-1 | Shared foundations | 3.0 | – | 0 |
| 2 | DP-1 | Discord settings form and real errors (Q13) | 3.0 (port of updates and admin) | – | 0 |
| 3 | CD-0 | Dialog contract | 3.0 | – | 0 |
| 4 | DP-4 | Own pages: changelog and roadmap | 3.0 (port of the updates pages) | – | 0 |
| 5 | CD-1 | Dialog and notice library | CD-0 | – | 1 |
| 6 | CD-5a | Notification core and bell API | CORE-1 | `V_NOTIFICATIONS_INDEX` | 1 |
| 7 | DP-2a | Delivery model and bot API | DP-1, CORE-1 | `V_DISCORD_DELIVERY` | 1 |
| 8 | HC-2 | Ledger core, entitlements, Premium status, registry | CORE-1 | `V_SHOP_CORE` | 1 |
| 9 | ST-1 | Status core | CORE-1 | `V_STATUS_TABLES` | 1 |
| 10 | CS-2 | Address registry with holds | CORE-1; ST-1 soft | `V_SITE_ADDRESSES` | 1 |
| 11 | PD-2 | Custom domain core (dormant) | CORE-1 | `V_CUSTOM_DOMAINS` | 1 |
| 12 | CD-3 | Admin and sign-in confirmations | CD-1 | – | 2 |
| 13 | DP-3 | Bot 0.2.0 | DP-2a | – | 2 |
| 14 | DP-5 | Public suggestions page (+ 5b bot part) | DP-4, CD-5a; 5b: DP-3 | `V_PUBLIC_PAGES` | 2 (5b: 3) |
| 15 | CD-2 | Editor: own dialogs, guard, drafts | CD-1 | – | 2 |
| 16 | HC-3 | Catalogue, offers, purchases, refunds | HC-2 | `V_SHOP_CATALOGUE` | 2 |
| 17 | PD-1 | Premium flags in the editor, branding | HC-2 | `V_BRANDING_LEGACY` | 2 |
| 18 | CS-3 | Code slots: data model and routing (dormant) | CS-2; CS-1 soft | `V_CODE_SLOTS` | 2 |
| 19 | PD-3 | Domain worker | PD-2, HC-2, CD-5a | – | 2 |
| 20 | DP-2b | Admin UI for bot posting | DP-2a, CD-1, CD-3 | – | 3 |
| 21 | CS-1 | Admin split | 3.0 (admin port), CD-3 | – | 3 |
| 22 | HC-4 | Editor "Honeycombs" tab | HC-3, CD-1, CD-2; HC-1 soft | – | 3 |
| 23 | CD-4 | Profile pages: themed dialogs and form checks | CD-1, CD-2, CD-3 | – | 3 |
| 24 | CD-5b | Bell in the editor and the admin header | CD-2, CD-5a | – | 3 |
| 25 | CS-4 | Code slots: editor API (dark) | CS-3, HC-3, PD-2 | – | 3 |
| 26 | PD-1b | Wider branding and the code-page badge (Q2 = c) | PD-1, CS-3 | – | 3 |
| 27 | PD-6 | Installer: Cloudflare for SaaS | PD-3 | – | 3 |
| 28 | HC-1 | Yellow honeycomb icons | CS-1 | – | 4 |
| 29 | ST-2 | Checker, sensor, installer units | ST-1, CS-1 | – | 4 |
| 30 | HC-5 | Shop admin I | HC-3, CS-1, CD-3 | – | 4 |
| 31 | CS-5 | Code pages moderation | CS-1, CS-4, CD-3, CD-5a | – | 4 |
| 32 | PD-4 | Custom domain in the editor | PD-1, PD-3, CS-3, HC-3, HC-4, CD-2 | – | 4 |
| 33 | PD-5 | Custom domains admin | PD-3, CS-1, CD-3 | – | 4 |
| 34 | HC-8 | Streaks and the daily cap | HC-4, CD-2 | `V_SHOP_STREAKS` | 4 |
| 35 | ST-3 | Notifier and OnYourSite's status page (+ bot 0.3.0) | ST-2, CD-1, CD-5a, DP-2a, DP-3 | – | 5 |
| 36 | HC-6a | Shop admin II: users, unlock grants, refunds | HC-5, CD-5a | – | 5 |
| 37 | CS-6 | Code slots in the editor (live) | CS-5, CD-2, CD-5b, HC-1 | – | 5 |
| 38 | ST-4 | Status pages for users | ST-3, HC-3, HC-6a, CS-2, CS-3, CD-5a; HC-1 soft | – | 6 |
| 39 | HC-7a | Time-limited lifecycle and jobs runner | HC-4, HC-6a, CD-5a | – | 6 |
| 40 | HC-6b | Shop admin III: bulk grants, reversal, freeze | HC-6a | – | 6 |
| 41 | HC-9 | Event codes | HC-6a | `V_SHOP_EVENT_CODES` | 6 |
| 42 | HC-7b | Reminder and "ended" emails | HC-7a, CORE-1 | `V_SHOP_MAIL` | 7 |
| 43 | ST-5 | Status alert channels | ST-4 | – | 7 |
| 44 | ST-7 | Status add-ons and Premium limits | ST-4, HC-7a, PD-1, PD-1b | – | 7 |
| C1 | HC-7c | Auto-renewal (after the Premium sale has started) | HC-7a | `V_SHOP_AUTO_RENEW` | – |
| C2 | CD-6 | Notification retention (switch off by default) | CD-5a, HC-7a | – | – |
| C3 | ST-6 | Visitor subscriptions | ST-5, CORE-1 | `V_STATUS_SUBSCRIBERS` | – |
| C4 | DP-6 | Discord extras | DP-5 | – | – |
| C5 | HC L1–L5 | Shop later steps (order of Q14) | per step | per step | – |

### 4.1 The PRs after 3.0

**#1 · CORE-1 – Shared foundations** (core)
- Depends on: 3.0.
- Content: `schema.ts` helpers and the step convention (§3.1), `ensureSchema({upTo})`; `db.ts` test knobs
  `OYS_DB_POOL_SIZE` and `OYS_DB_STRICT` (nested-connection guard); `admin/accountDeletion.ts` with
  `registerUserDeletion`/`deleteAccount` (§3.9; today's delete-user statements become the core hooks); the mail
  helper's extra headers, per-call timeout and test transport; `plan.md` points to this file.
- Ships: nothing visible; deleting a user is now all-or-nothing.
- Tests: helper idempotency (each helper twice), the strict guard fires on a nested pool request, a failing deletion
  hook leaves every row in place, mail headers and timeout through the test transport.
- Installer: none. The before-update backup moved into the 3.0 installer and runs on every `--update` (§2.4);
  `cli.js migrate --pending`, which only decided whether to take it, is dropped.

**#2 · DP-1 – Discord settings form and real errors**
- Depends on: 3.0 (port of updates and admin).
- Content: discord-pages PR 1 (separate forms, renamed fields, no password inputs, display-name rules, `discordError`
  with the `errors` walk, webhook check on save, forum/thread options, named lock per update, log line per failed save).
- **Q13 – the loop the owner hit must be impossible.** Today a save while the stored or checked mode is `bot` answers
  "Saved – for the bot, a token and a channel ID are both needed." – the mode comes from the radio, and in bot mode a
  pasted webhook link is stored but ignored (`lib/updates.php:548`, `:520-523`, `:590-593`; Node port
  `app/src/updates/discord.ts:129-132`). "Send test" then answers "Please save a webhook link or bot first." because
  the saved settings have no usable target (`lib/updates.php:982-985`; `app/src/updates/admin.ts:156-157`). DP-1
  makes sure that:
  - pasting a webhook link selects the webhook mode;
  - only the fields of the visible mode are submitted;
  - a channel ID alone is never "saved";
  - every message names exactly what is missing for the selected mode;
  - saving checks the target with Discord and shows Discord's own error;
  - the installed bot is offered without retyping its token: DP-1 never asks for the installed bot's token and takes
    no newly typed token (D16; a stored old token can still be tested and deleted). The "Use #updates" offer itself is
    DP-2b's bot card, so DP-1 … DP-3 should reach the owner in one release where possible (M1).
- Ships: **the webhook complaint is fixed.**
- Tests: A1–A5 regressions, `parseWebhookLink`, `discordError` table, Playwright "autofill" flow, and the **required
  loop test** (HTTP and Playwright), starting from the owner's state – stored mode `bot`, no token, no webhook:
  - paste a webhook link and save → stored and enabled as the webhook destination, checked against the Discord mock,
    and "Send test" posts;
  - save a channel ID alone → refused, nothing stored, the message names what is missing;
  - a link the mock refuses (401, 404) → nothing stored, Discord's own text shown;
  - neither of the two old messages appears, in any order of these steps.

**#3 · CD-0 – Dialog contract**
- Depends on: 3.0.
- Content: `static/js/ui.d.ts` and the attribute table (custom-dialogs §6.2) with the changes of `EDITS.md`;
  sign-off by honeycomb-shop and code-slots-admin, review by the other three.
- Ships: nothing. Tests: none (typed contract).

**#4 · DP-4 – Own pages: changelog and roadmap**
- Depends on: 3.0 (port of the updates pages).
- Ships: `/updates` and `/roadmap` as own pages with the sub-navigation; trailing-slash 301s; old anchors forwarded.
- Tests: HTTP (no `Set-Cookie`, canonicals, forward script), Playwright nav widths and the cached-301 proxy test.

**#5 · CD-1 – Dialog and notice library**
- Depends on: CD-0.
- Content: `ui.js` (dialogs, controller, layers, toasts, notices, `handle()`, global form checks, submit pipeline,
  guard, `openLink`), `ui.css` with the `--hc*` tokens, the page skin in `page.css`, `views/partials/ui.ts`
  (`uiAssets`, `confirmAttrs`, `confirmField`, `flashBanner`, `bellMarkup`), script tags on every Node page; lint in
  warning mode.
- Ships: browser validation bubbles are replaced by inline field errors on every page that loads `ui.js`.
- Tests: Playwright component tests (`tests/e2e/ui-kit.js`): dialogs, focus, stacking, Back gesture stub, scroll,
  toasts, form checks, `data-confirm` pipeline including the old-Safari re-submit path.

**#6 · CD-5a – Notification core and bell API**
- Depends on: CORE-1 (helpers). Step: `V_NOTIFICATIONS_INDEX`.
- Content: `notify()`, `notifyAdmins()`, `safeLink()`, `NOTIFY_TYPES` with every row of §3.6; contact and booking
  notices delegate to it; `notifications` (with `link`, `icon`, `tone`, `latest`), `notifications-read {id|upTo}`,
  `messages`, `message`, `booking-delete` before the page check; lint against raw `INSERT INTO notifications`.
- Ships: messages and bookings work for accounts without a shown link page.
- Tests: truncation by code points, `safeLink` cases, `opts.db` inside a rolled-back transaction, bell API (key
  order, `upTo`, impersonation read-only, 401/419), the index step twice.

**#7 · DP-2a – Delivery model and bot API**
- Depends on: DP-1, CORE-1. Step: `V_DISCORD_DELIVERY`.
- Content: discord-pages PR 2a plus the registry contract of §3.7 (`registerBotAction` with `feature`, `onResult`,
  `maxAgeSec`; features from the registry in `ping`/`hello`; tolerant `hello` validator with `gateway`; `/done` calls
  `onResult` in its transaction), **without** the PHP compatibility layer (Q10): no v1 mirror in the stored settings,
  no writes to `updates.discord_message_id/discord_target`, no outbox parking.
- Ships: nothing visible (inert until a bot polls with `updates.v1`).
- Tests: post state machine table, races with the barrier hook, outbox filter/backoff/same-ref order/`maxAgeSec`, a
  registered test action whose `onResult` runs inside the `/done` transaction, `hello` with an unknown top-level key
  and with `gateway`, migration v1 → v2 (webhook; old token kept as the legacy destination; existing posts as rows).

**#8 · HC-2 – Ledger core, entitlements, Premium status, feature registry**
- Depends on: CORE-1. Step: `V_SHOP_CORE`.
- Content: honeycomb-shop HC-2 plus `features.ts` (registry, perks, loss previews), `has()` with `includedFor`, the
  enforcer contract of §3.2, the `honeycombs` deletion hook; no `renew_*` columns and no `mail_reminders` yet.
- Ships: nothing visible; code page unlocks keep working (now through entitlements).
- Tests: unlock after the migration gives access, the free admin unlock gives access, a ledger-only row gives access
  (the `has()` fallback for rows the old process writes during a deploy), `has(…, db)` with a pool of one,
  `includedFor` for admins, the `honeycombs` deletion hook.

**#9 · ST-1 – Status core**
- Depends on: CORE-1 (not on the registry or the shop – R4). Step: `V_STATUS_TABLES`.
- Content: status-pages PR 1 without the address registry and without shop reads: `settings.ts`, `limits.ts`
  (fixed limits for the system page; plan `none` for users until ST-4), `guard.ts`, `psl.ts`, `resolver.ts`,
  reserved paths `status`/`health`, `markdown(text, {base, ugc})`. The system page is seeded without a registry claim.
- Ships: nothing visible. Tests: guard (≈ 110 cases), PSL, resolver, limits, markdown options, the step twice.

**#10 · CS-2 – Address registry with holds**
- Depends on: CORE-1. ST-1 is soft: CS-2 backfills status rows when the table exists, and ST-1 claims the system page
  when `site_addresses` exists, so either order works. Step: `V_SITE_ADDRESSES`.
- Content: code-slots-admin PR 2 with §3.5 (`hold_until`, per-kind policy, `userId: number | null`,
  `addressNameProblem`, `sites:repair` for status rows); the `addresses` deletion hook; nothing for PHP (Q10).
- Ships: released addresses are held 30 days; the 404 page stops offering them; new addresses can't use the
  OnYourSite name (D12).
- Tests: holds (≥ 7 days held, < 7 days free, status 90 days), expiry via `hold_until`, the 404 check, races between
  kinds, `sites:repair` leaving a live status row alone, name rules.
- Installer: `--update` runs `node app/dist/cli.js sites:repair` after the health check.

**#11 · PD-2 – Custom domain core (dormant)**
- Depends on: CORE-1. Step: `V_CUSTOM_DOMAINS`.
- Content: premium-domains PR 2 with `domains.hasDomain(pageId, db)`, `beforePageRemoved(pageId, db)` (DB-only) and
  the `domains` deletion hook (§3.9).
- Ships: nothing until PD-6 runs on the server. Tests: routing per state, probe path, uploads and ids on custom hosts,
  no query when the feature is not configured.

**#12 · CD-3 – Admin and sign-in confirmations**
- Depends on: CD-1.
- Content: custom-dialogs §7.2/§7.3 on the Node admin and auth views; `_confirmed` check in the admin dispatcher and
  the impersonation route; flash banners → toasts; the reset-password modal as a layer.
- Ships: no browser pop-ups in the admin; inline errors on login and register.
- Tests: e2e flows 6 (without the bell), 7 (admin part, `ui.js` blocked → nothing changes), 9.

**#13 · DP-3 – Bot 0.2.0**
- Depends on: DP-2a (merged before the release).
- Content: discord-pages PR 3 with the generic channel step: `--update` runs `--discord-channel <KEY>` for every
  missing `CHANNEL_SPECS` key; `--channel <KEY>` replaces `--updates-channel`.
- Ships: **the bot posts, edits and removes updates in #updates.**
- Tests: bot unit tests, setup against `discord_setup_mock.py`, installer harness (one line added, nothing else
  changed, no retry after a failure), bot ↔ site e2e.
- Installer: `discord-bot/install.sh` (`--update`, `--channel`, `OYS_BOT_RUNTIME` in the unit); `server/install.sh`
  `step_bot` also updates a Docker bot in the code folder.

**#14 · DP-5 – Public suggestions page (+ DP-5b bot part)**
- Depends on: DP-4, CD-5a (the migration notices); DP-5b after DP-3. Step: `V_PUBLIC_PAGES` – the owner notices are
  written with `notify(uid, 'system', …, {db: conn})` per affected user inside the step's transaction, before the
  `UPDATE` (XD-08).
- Ships: `/suggestions` (off until the admin turns it on), show/hide per suggestion, privacy text; DP-5b: the website
  note in new forum posts, deletion sync, daily check.
- Tests: `visible()` matrix, migration (notices written once, path page moved), bot raw-event tests.

**#15 · CD-2 – Editor: own dialogs, guard, drafts**
- Depends on: CD-1.
- Content: custom-dialogs PR 2 **without** Rule R (Q10): no legacy adapter; PR 2 deletes the old `.toasts`/`.toast*`
  rules itself, and a missing `OYSUI` stops the editor with the in-page notice of custom-dialogs §3.5; `DEEP_LINKS`
  map; `E.user.id`.
- Ships: no browser pop-up in the editor; unsaved work survives a crash or an expired session.
- Tests: e2e flows 1–4, 7 (editor: the in-page notice), 8, 11; the save race.

**#16 · HC-3 – Catalogue, offers, purchases, refunds**
- Depends on: HC-2. Step: `V_SHOP_CATALOGUE`.
- Content: honeycomb-shop HC-3 with the admin-mode refusal inside `buy()` and the spending-route contract of §3.2;
  `code/shop.ts` registers `code_page`; `code-unlock` takes `request_id`/`expected_price`; `seedItems()` with the
  start prices of Q4 (§3.2); no `oys_meta` price mirror (Q10).
- Ships: code page unlocks run through the shop's rules; an impersonating admin can no longer spend a user's
  honeycombs (today that works, `lib/routes_app.php:277-281`).
- Tests: pricing, races with pause points, replay rules, refund maths, HTTP 409 reload / 403 admin mode / price change.

**#17 · PD-1 – Premium flags in the editor, branding**
- Depends on: HC-2 (`users.premium_until`, `registerPerk` – now in HC-2). Step: `V_BRANDING_LEGACY` (Q9 = a).
- Content: premium-domains PR 1 with the keys of §3.3 (`E.pagesUnlimited` included). Q9 = a: pages that hide the note
  today keep it until the owner of the page changes it – free pages with the old switch, and free pages whose custom
  CSS hides the note (`cssHidesBranding`), get `hide_branding` plus `branding_legacy`; new CSS tricks no longer work
  (pinned footer styles), and saving such CSS shows a hint (`cssTouchesBranding`).
- Ships: branding follows the owner's Premium; existing pages keep what they show; new CSS tricks no longer hide the
  note.
- Tests: `footerHidden` truth table, `settingsNormalize` legacy rules, OG hash regression vectors, `cssTouchesBranding`
  / `cssHidesBranding`, migration cases.

**#18 · CS-3 – Code slots: data model and routing (dormant)**
- Depends on: CS-2; CS-1 soft (CS-3 extends the admin code list, which CS-1 moves to `code/adminView.ts`; in the
  order of §4 CS-3 is in first, and CS-1 then moves the extended list). Step: `V_CODE_SLOTS`. Model: Q6 = a – a
  slot that shows a code page keeps its link page parked (hidden, restorable).
- Content: code-slots-admin PR 3 without the PHP patches and the `--rollback` guard (Q10); the remaining
  account-level actions; `E.pagesUnlimited` from `pageAllowance()`; `page-delete` under the slot lock with the
  `beforePageRemoved(pageId, db)` call point (no-op until PD-2); the `code` deletion hook; `withSlotLock` exported.
- Ships: nothing new (no code slot can exist yet).
- Tests: pool-of-one and strict-guard tests, concurrency, parked-page endpoints, routing, migration re-runs.

**#19 · PD-3 – Domain worker**
- Depends on: PD-2, HC-2 (`registerEnforcer`, `registerLossPreview`), CD-5a.
- Content: premium-domains PR 3 plus `domains.health()` for status-pages (§3.10); the mail budget per minute (default
  20) is read from the `custom_domains` settings (Q11, §3.8).
- Ships: nothing until PD-6 installs the unit. Tests: worker `tick()` against the Cloudflare/DoH mocks, move-away,
  breaker, exactly-once notices and mails, the mail budget.

**#20 · DP-2b – Admin UI for bot posting**
- Depends on: DP-2a, CD-1, CD-3 (so its forms use `confirmAttrs`/`confirmField` from the start; no local shim).
- Ships: bot card, old-token card, "Discord posts" card, chips with Retry/Forget, `/admin/api/discord-status`; the
  installed bot is offered with "Use #updates" (Q13).
- Tests: HTTP for every `discord_*` action, the 401/403 JSON of `/admin/api/`, Playwright flows 3–4, and the last
  part of the Q13 loop test: with an installed bot that reports, the bot card offers "Use #updates" and "Send test"
  posts through the bot – no token field anywhere.

**#21 · CS-1 – Admin split**
- Depends on: 3.0 (admin port), CD-3.
- Content: code-slots-admin PR 1; the moved forms render `confirmAttrs()` + `confirmField()`; the honeycomb tab keeps
  today's style (HC-1 recolours it); `code_action` dispatch and the one-release `hc_action=code_*` mapping.
- Ships: **Admin shows Honeycombs and Code pages as separate sections.**
- Tests: snapshots (Honeycombs HTML identical apart from the removed parts), e2e 5.

**#22 · HC-4 – Editor "Honeycombs" tab**
- Depends on: HC-3, CD-1 (`OYSUI.confirm` with `content`), CD-2 (the shop answers' `notices` are shown by its
  `request()`); HC-1 soft (HC-4 uses the `hc-icon` class; in the order of §4 HC-4 is in first, and HC-1 then turns
  its icons yellow with the rest).
- Content: honeycomb-shop HC-4 without the legacy modal (HC-4 deletes the old modal, Q10), without the auto-renew
  switch (HC-7c) and without the reminder-mail switch (HC-7b); the terms section "Honeycombs and Premium";
  `#honeycombs[/<feature>]` deep links.
- Ships: **the Honeycombs tab** (shop, unlocks, earn list, history).
- Tests: e2e `hc-buy.js`, `hc-offer.js`, `hc-mobile.js`.

**#23 · CD-4 – Profile pages: themed dialogs and form checks**
- Depends on: CD-1, CD-2, CD-3.
- Content: custom-dialogs PR 4. Nothing is kept for pages served by PHP (Q10); `page.js` keeps its `OYSUI` checks only
  so that a blocked `ui.js` leaves profile pages as they are today (custom-dialogs §3.5). Lint becomes an error.
- Ships: themed dialogs and inline errors on profile, booking and gate pages. Tests: e2e flow 10.

**#24 · CD-5b – Bell in the editor and the admin header**
- Depends on: CD-2, CD-5a.
- Content: `bell.js` (included by the views, reads only Node's answer shape – no self-loading, Q10), admin header
  bell, the first-poll rule of §3.6, polling without a page.
- Ships: bell items open their target; team gifts and alerts appear as toasts. Tests: e2e flow 5 and the bell part of 6.

**#25 · CS-4 – Code slots: editor API (dark)**
- Depends on: CS-3, HC-3 (`buy()`), PD-2 (`hasDomain`; stub otherwise).
- Content: code-slots-admin PR 4 with: `code-unlock` on the spending contract (`item`, `request_id`,
  `expected_price`); E7 from `hasDomain` inside the lock; cooldown via `isStaff`; no address pass; `code_more`
  registered (price 0, Q4); `enforceSlots` inline for `code_page` and `code_more`; `max_on_pages` default 0.
- Ships: nothing reachable. Tests: rule matrix E1–E8, stale-tab 409s, `code-unlock` replay and admin-mode 403.

**#26 · PD-1b – Wider branding and the code-page badge** (Q2 = c)
- Depends on: PD-1, CS-3 (code serving).
- Content: title without "| OnYourSite", `og:image:alt`, `/_/icon` favicon from the owner's avatar for Premium pages;
  for owners with Premium the code-page badge becomes a plain "Report" link without the OnYourSite name and hexagon
  (`codeBadge(ownerPremium)`), plus the sentence in the code-page terms.
- Ships: Premium removes OnYourSite branding on every page type (status pages through ST-7). Tests: `fullyUnbranded`
  table, favicon generation, badge variants (the report link always present).

**#27 · PD-6 – Installer: Cloudflare for SaaS**
- Depends on: PD-3 (worker CLI).
- Content: premium-domains PR 6 without the `--rollback` part (Q10).
- Ships: **custom domains can be switched on** (admin switch, default off).
- Tests: installer harness with `cf_mock.py` (fresh `--domains`, `--update` twice, `--tunnel` twice, merged ingress,
  token errors, `--reset`, domain change).
- Installer: `--domains`, `step_domains`, `/etc/onyoursite/cf-saas.token`, `write_domain_worker`,
  `tunnel_rules_json` merge (also used by `--tunnel`), `mine` fix, Apache `ServerAlias *`, `save_conf` keys, quiet
  `--update` checks, `--reset` deletes hostnames, the domain-change routine.

**#28 · HC-1 – Yellow honeycomb icons**
- Depends on: CS-1 (the admin nav it recolours). CD-1 is always in by then (CS-1 needs CD-3, which needs CD-1), so
  HC-1 uses the `--hc*` tokens of `ui.css` directly – no fallbacks for PHP views (Q10).
- Content: honeycomb-shop §5.1; `.toast.hc` (`editor.css:429`, indigo today – verified) only if CD-2 has not deleted
  the old toast rules yet (CD-2's `.ui-toast.hc` is yellow already); the admin honeycomb nav item and
  `ADMIN_TABS.honeycombs`.
- Ships: **honeycomb icons are yellow everywhere**; the logo keeps the brand colour (D1).
- Tests: Playwright computed colour of `.hc-pill i`, the honeycomb toast and the admin icon; the logo unchanged.

**#29 · ST-2 – Checker, sensor, installer units**
- Depends on: ST-1, CS-1 (admin nav slot).
- Content: status-pages PR 2 without `status:slug-check` and the `--rollback` step (Q10); the `domains` component
  reads `domains.health()` (hidden until PD-3 and PD-6 exist); `job:runner` (hidden until HC-7a) and the new
  `job:domains` (hidden until PD-6).
- Ships: the admin "Status pages" section with the health card.
- Tests: guard/state/gate/aggregate/scheduler unit tests, the checker integration test (test DNS, canaries, kernel
  guard stub), the load test script.
- Installer: `write_status_units` in every topology mode, kernel-guard test, `innodb_buffer_pool_size`,
  `TUNNEL_METRICS`, `backup.sh` change and `status:ping backup`, `status:planned` around restarts, `--reset` stops the
  units.

**#30 · HC-5 – Shop admin I** – overview, catalogue and prices, offers, earning rules (honeycomb-shop HC-5).
- Depends on: HC-3, CS-1, CD-3. Ships: admins set prices and run offers. Tests: every `hc_action` of the sub-tabs,
  `_confirmed=0` changes nothing, the audit rows.

**#31 · CS-5 – Code pages moderation**
- Depends on: CS-1, CS-4, CD-3, CD-5a.
- Content: code-slots-admin PR 5 with notices through `notify(…, {db})` inside the slot-lock transaction right after
  the `code_moderation` insert (no `ref`); every moderation form with `confirmAttrs()` + `confirmField()`.
- Ships: limits, source viewer, block/delete/ban, moderation log. Tests: each `code_action`, e2e 4.

**#32 · PD-4 – Custom domain in the editor**
- Depends on: PD-1, PD-3, CS-3 (`withSlotLock`), HC-3 (seeding `custom_domain`), HC-4 (`openShop`), CD-2.
- Content: premium-domains PR 4 with `pages[].custom_domain` = `hasDomain`; `domain-add` under `withSlotLock`;
  Q3 = a: a domain is included in Premium – one per link page, at most 3 per user (`per_user` 3) – and the
  `custom_domain` slot feature stays built in behind the admin switch `slots`, off; deep link `settings/domain`.
- Ships: the Custom domain section (visible once PD-6 ran and the admin switched it on).
- Tests: editor API cases, takeover flows, polling termination, pool test, Playwright flows 1–9.

**#33 · PD-5 – Custom domains admin** – premium-domains PR 5; the Settings card also holds the worker's mail budget
per minute (Q11). Depends on: PD-3, CS-1, CD-3. Ships: setup card, settings, domain list with actions. Tests:
CSRF/admin-only per `domain_action`, settings clamping.

**#34 · HC-8 – Streaks and the daily cap** – Depends on: HC-4, CD-2 (start code shows `OYS_EDITOR.notices`).
Step: `V_SHOP_STREAKS`. Ships: streak bonuses (+15 after 7 days, +50 after 30 days in a row) and the daily cap (300)
– Q4 = a; the start code shows `notices`, and the old `honeycombs.earned` loop goes.

**#35 · ST-3 – Notifier and OnYourSite's status page (+ bot 0.3.0)**
- Depends on: ST-2, CD-1 (`OYSUI` in `status-manage.js`), CD-5a (`notify`, `notifyAdmins`), DP-2a (registry), DP-3
  (bot base).
- Content: status-pages PR 3 with: `status.*` registered per §3.7 (refs `status-inc:<id>`, `status-alert:m<id>`,
  `status.alert` `maxAgeSec` 7200); admin links `/dashboard#status/system`; the editor tab only for admins
  (`E.statusAdmin`), guarded so a missing `#tab-status` does nothing; bot handlers, `CHANNEL_SPECS`
  `STATUS_CHANNEL_ID`/`ALERTS_CHANNEL_ID`, `gateway` in the report.
- Ships: **`status.on-your.site` is live**; admins post incidents and maintenance from the editor; #status and
  #alerts on Discord (D15).
- Tests: renderer, database-down fallback, outbox and budget classes (system, confirm, owner), Discord posts with the
  mock, bot jobs only with `status.v1`, `onResult` applying the message id.
- Installer: the notifier unit; the bot's `--update` picks up the two new channel keys through DP-3's loop.

**#36 · HC-6a – Shop admin II: users, unlock grants, purchases and refunds**
- Depends on: HC-5, CD-5a (CD-5b soft).
- Content: the users sub-tab with details, `feature_grant`/`feature_revoke` (formRef rules of §3.2), purchases and
  refunds, bell notices.
- Ships: admins can grant or remove unlocks and Premium (for good until HC-7a) and refund purchases.
- Tests: grants twice with one `form_ref`, refund cases, bell exactly once.

**#37 · CS-6 – Code slots in the editor (feature live)**
- Depends on: CS-5, CD-2, CD-5b (bell polling without a page – accounts can now have no shown link page), HC-1.
- Content: code-slots-admin PR 6 with `guard.navigate(…, {force: true})` instead of `leaving`, "Download files" in
  `content`, no bell-polling change (CD-5b did it); `max_on_pages` default 1 (admin setting 0–3, Q6 = a).
- Ships: **a link page can show a code page – 3 link pages + 1 code page, or 2 + 2**; the parked link page comes back
  with "Show the link page again".
- Tests: e2e 1–3, 6–9.

**#38 · ST-4 – Status pages for users**
- Depends on: ST-3, HC-3 (`registerFeature`, `buy()`), HC-6a (`grantFeature` for the free unlock in the status
  admin, §3.2), CS-2 (registry), CS-3 (`withSlotLock`), CD-5a; HC-1 soft.
  Q7 = a: nothing without the unlock. Q12 = a: any public website, within the per-site caps, robots.txt and the site
  operators' opt-out (status-pages §6.2).
- Content: status-pages PR 4 with: `status-unlock` on the spending contract; `status_page` at 150 (Q4); addresses
  through the registry (90-day hold, redirect, the link-page cooldown rule); `addressNameProblem(…, 'status')` and the
  title rule; `statusLimits` plan `none` (0 checks) without the unlock (X7); owner email alerts and bell; the `status`
  deletion hook.
- Ships: **every user can unlock a status page** (with checks, incidents, maintenance and owner alerts).
- Tests: paywall, paused module, unlock races, slug errors incl. brands, address hold and redirect, limits under
  concurrency, Playwright flows 1, 2, 4–6.

**#39 · HC-7a – Time-limited lifecycle and jobs runner**
- Depends on: HC-4, HC-6a, CD-5a.
- Content: `jobs/registry.ts`, `cli.js jobs:tick` and its timer; the honeycomb job (reconcile retries, bell reminders
  at 7/3/1 days with loss-preview lines, expiry processing, nightly integrity checks and entitlement repair); expiry
  banners; `LIFECYCLE_READY`.
- Ships: admins can switch on timed options – **Premium can be sold** (with PD-1 ready).
- Tests: `tick()` twice = one reminder/expiry each, renewal-free expiry, a throwing enforcer keeps the marker, the
  runner exits 0 on an old schema.
- Installer: `write_timers` writes and enables `onyoursite-jobs.service`/`.timer`; `--update` re-enables; `--reset`
  stops it.

**#40 · HC-6b – Shop admin III** – bulk grants with preview, ledger reversal, freeze. Depends on: HC-6a.

**#41 · HC-9 – Event codes** – Depends on: HC-6a. Step: `V_SHOP_EVENT_CODES`. Ships: admins create codes, users
redeem them.

**#42 · HC-7b – Reminder and "ended" emails** (Q11 = a)
- Depends on: HC-7a, CORE-1 (mail helper). Step: `V_SHOP_MAIL`.
- Content: `hc_mail_outbox`, `email/unlock_reminder.json`, the stage-2 reminder, the "ended" mail for expiry, refund
  with remove and revoke (XD-17), the "Email me before an unlock ends" switch; the per-run mail budget (default 100)
  as an admin setting in Admin → Honeycombs (Q11, §3.8).
- Ships: one mail 3 days before Premium ends (auto-renewal off) and one when it ended; users can switch them off.
  Tests: exactly once per ref, opt-out, the refund/revoke mail, the 5-try give-up, the budget.

**#43 · ST-5 – Status alert channels** – extra email addresses, Discord webhook channels with incident posts,
"Recent alerts", `channel_broken`, the per-page `confirm` share (X12). Depends on: ST-4. Tests: verification on the
main host, the Discord mock, the per-page cap.

**#44 · ST-7 – Status add-ons and Premium limits**
- Depends on: ST-4, HC-7a, PD-1, PD-1b (`fullyUnbranded`, Q2 = c).
- Content: `status_more_checks`/`status_fast_checks` (60 and 80 per 30 days, Q4), the Premium perk (Q1 = b: 30 checks
  instead of 10, checks every minute; 250 subscribers once ST-6 exists – nothing else: the Premium defaults for alert
  channels and daily broadcasts are the free plan's, §3.3), `refreshStatusLimits` without side effects
  (`changed_at`, `status_rev` only); the checker sends one `status_team` notice per transition of
  `effectiveMonitors`, recorded in `status_pages.limit_paused` (XD-16); `footerHidden` for status pages and, with
  Q2 = c, PD-1b's `fullyUnbranded` for their title and favicon.
- Ships: **status add-ons can be bought**; Premium raises status limits.
- Tests: limits over time, renewal racing expiry, one notice per transition across repeated reconciles.

### 4.2 Stage C – later steps

| PR | Starts when | Decision |
|---|---|---|
| C1 · HC-7c Auto-renewal | after the Premium sale has started (Q5 = a) | build: opt-in only, renews one day before the end, never above the price the user agreed to |
| C2 · CD-6 Notification retention | HC-7a exists | build with the switch off (D20) |
| C3 · ST-6 Visitor subscriptions | later (Q8 = a); needs ST-5 | later; mail goes through the owner's Mailcow under our own budgets (Q11) |
| C4 · DP-6 Discord extras | when the owner asks | not planned (D16; Q14: "the rest later") |
| C5 · Shop L1–L5 | after v1 | Q14 = a: L2 visitor milestones and the anniversary bonus first, then L1 invite friends, then L3 the new purchasable designs; L4 (address passes, storage) and L5 (community rewards) later |
| Follow-ups | after v1 | custom domains for status pages (D9), code pages on custom domains (D9). The free status tier is not planned (Q7 = a). |

### 4.2a Stage D – the owner's asks of 2026-11-03

Recorded, not built yet. Each item gets its own branch from `main`, its own tests and a browser flow for new editor
surfaces (2.3). Suggested order: D1 (a bug), D2, D3 (Christmas is close), then D6, D4 and D5.

| PR | What | Notes for the build |
|---|---|---|
| D1 · Fix block reordering | Blocks in the editor can no longer be dragged into a new order – neither on phones nor on a PC. | The list uses SortableJS from `cdn.jsdelivr.net` (`app/src/app/views/dashboard.ts`, `static/js/editor.js` `renderBlocks()`, handle `.blk-drag`). Check first: the script loads (CDN reachable, no CSP or blocker), the instance survives `renderBlocks()` re-renders and tab switches, touch on the handle (`touch-action`, `delay`/`delayOnTouchOnly`, `forceFallback` for iOS), the bottom navigation on phones covering the list. Prove it with a browser flow that drags a block on desktop and on a phone viewport, then fix. Consider serving SortableJS from `static/vendor/` like CodeMirror. |
| D2 · Bigger block picker | The "choose a block" selection gets bigger: larger tiles with icon, name and a short line of what the block does, easy to tap on phones. | Same design (Tailwind classes, colours, components). |
| D3 · Christmas themes | More themes, now in the direction of Christmas and winter (e.g. snowy night, candy cane, gingerbread, Christmas market, frost). | Themes live in `app/src/content/themes.ts` and `static/css/themes.css` (30 today); every theme needs its preview in the gallery and must pass the contrast checks of the render tests. The snow effect already exists and fits. |
| D4 · Beta site `beta.on-your.site` | A beta area where only approved beta testers can log in; they need an account on the main website. | Admin: a beta tester switch per user (and a list) in *Admin → Users*. `beta.<domain>` runs the beta build (own service and code folder from a branch, set up by the installer) on the same database (owner's decision of 2026-11-03: the real database, so testers use their normal account and pages – beta code must only add to the schema, like every update). Login on beta checks the flag; everyone else sees "This area is for beta testers". Reserve `beta` as an address (`RESERVED` in `app/src/helpers.ts`) and check that no page owns it yet (like `status`). |
| D5 · Docs site `docs.on-your.site` | A user guide on the web that explains everything about using OnYourSite (not GitHub, not for developers): getting started, editor, blocks, themes and layouts, addresses, stats, honeycombs and the shop, code pages, status pages, custom domains, account and privacy. | Rendered by the website itself from Markdown in the repository (like `/updates`), with a search and links from the editor ("?" help links). English. Reserve `docs`. |
| D6 · Short domain `onys.me` | Short links: pages also at `name.onys.me` and `onys.me/name` (README already promises it). | Second base domain in `config.json` (e.g. `short_domain`), routing in `app/src/router.ts` for both hosts, redirects to the main address (owner's decision of 2026-11-03: `onys.me/name` and `name.onys.me` redirect to the page's main address), cookies stay on the main domain. Installer: ask for the short domain on its own step and ask the admin to add the zone `onys.me` to the existing Cloudflare API token (Zone · DNS · Edit, Zone · Zone · Read, plus the tunnel); then DNS records, tunnel rules, certificate. `--update` asks once if it isn't set. |

### 4.3 Milestones (what the owner sees)

| Milestone | Reached with | Complete with | Owner's ask |
|---|---|---|---|
| M1 Discord fixed | DP-1, DP-2a, DP-3, DP-2b (DP-1 alone ends the loop of Q13) | #20 | „Discord-Bereich fixen“ |
| M2 Own pages | DP-4, DP-5 | #14 | „eigene Page für Roadmap, Updates, Suggestions“ |
| M3 Admin split, yellow icons | CS-1, HC-1 | #28 | „Honeycombs und CodePage getrennt“, „Icons gelb“ |
| M4 OnYourSite status page | ST-1 … ST-3 | #35 | „OnYourSite eigene Status Page“ |
| M5 No browser pop-ups | CD-1, CD-3, CD-2, CD-4, CD-5b | #24 | „Custom push ups für alles“ |
| M6 Honeycombs tab | HC-3, HC-4 | #22 | „mehr Möglichkeiten“ |
| M7 Code page on a profile address (Q6 = a: the link page is parked) | CS-2 … CS-6 | #37 | „Code page mit Profil-Website verbinden“ |
| M8 Premium, custom domains, no branding (Q1 = b, Q2 = c, Q3 = a) | HC-5, HC-6a, HC-7a, PD-1 … PD-6, PD-1b | #39 | „Custom Domain mit Honeycombs“, „Werbung weg“ |
| M9 Status pages for everyone (Q7 = a: after the unlock) | ST-4, ST-5, ST-7 | #44 | „Status Page-System für alle“ |
| M10 More shop options | HC-6b, HC-8, HC-9, HC-7b | #42 | „mehr Möglichkeiten“, „zeitlich begrenzte Käufe“ |

---

## 5. Installer changes (consolidated)

| PR | `server/install.sh` and other scripts |
|---|---|
| 3.0 (plan §5, for reference) | Node-only tree; `--update` always takes a backup first (`backup.sh before-update`, on the PHP migration `before-node`); the PHP migration keeps the PHP site serving from the previous release until the check after the switch has passed and reverts automatically otherwise; no `--rollback`; no PHP on fresh servers |
| DP-3 | `step_bot` also updates a Docker bot in the code folder; `discord-bot/install.sh --update` runs `--discord-channel` for every missing `CHANNEL_SPECS` key, `--channel <KEY>`; unit `Environment=OYS_BOT_RUNTIME=service`; `Dockerfile` `ENV OYS_BOT_RUNTIME=docker`; `--check` prints the site's features |
| ST-2 | `write_status_units` in fresh install, `--update`, `--https`, `--tunnel` (checker and sensor units, `config.json` `status` block, kernel-guard test); `90-onyoursite.cnf` `innodb_buffer_pool_size`; `TUNNEL_METRICS=127.0.0.1:20241`; `backup.sh` without `status_checks` data + `status:ping backup`; `status:planned` around restarts; `--reset` stops the units; summary line |
| ST-3 | the notifier unit; the two bot channel keys (picked up by the DP-3 loop) |
| CS-2 | `--update` runs `sites:repair` after the health check |
| HC-7a | `write_timers` adds `onyoursite-jobs.service`/`.timer`; `--update` enables, `--reset` stops |
| PD-6 | `--domains`/`step_domains`, the root-only website token, `write_domain_worker`, merged tunnel ingress (also for `--tunnel`), `mine` fix, Apache `ServerAlias *`, `save_conf` keys, quiet `--update` checks, `--reset` deletes hostnames, domain-change routine |
| ST-6 (later) | none (CORE-1 already extends the mail helper) |

Not needed by anyone: new firewall ports, new packages, new Cloudflare permissions for the main token, `--rollback`
steps (Q10). The only new Cloudflare token is premium-domains' narrow "SSL and Certificates · Edit" token (D7). CORE-1
and DP-2a no longer change the installer: the before-update backup is part of 3.0, and the outbox parking is dropped.

---

## 6. Owner decisions and their effects

All answers are final (`DECISIONS.md`, 2026-11-01); nothing waits for the owner any more.

| Question | Answer | What it means for the plan | PRs |
|---|---|---|---|
| Q1 What Premium includes | b | Premium = a custom domain per link page, no branding, and more for status pages: 30 checks instead of 10, checks every minute, 250 subscribers (once ST-6 exists) – nothing else (alert channels and daily broadcasts keep the free values, §3.3). Page count, address cooldown and upload storage stay staff-only (`isStaff`); the `slots` enforcer does not list `premium`. | PD-1, PD-4, ST-7 |
| Q2 Branding scope | c | Besides "Made with OnYourSite" and the OG-card mark, Premium removes "\| OnYourSite" from the title, shows the owner's avatar as favicon, and turns the code-page badge into a plain "Report" link. Report links stay everywhere. | PD-1b (after CS-3), ST-7 |
| Q3 Domain included | a | Included in Premium: one domain per link page, at most 3 per user. The `slots` switch (a bought domain slot per domain) stays built in and off; `custom_domain_x1` is seeded inactive. | PD-4, HC-3 |
| Q4 Start prices | a | `premium_30` 350, `premium_90` 700, `code_page` 100, `code_more` 0, `status_page` 150 once, `status_more_checks_30` 60, `status_fast_checks_30` 80, `custom_domain_x1` 150 (inactive); streak +15 after 7 days and +50 after 30 days; daily cap 300. Admins change them later. | HC-3, CS-4, ST-4, ST-7, PD-4, HC-8 |
| Q5 Auto-renewal | a | Opt-in only, renews one day before the end, never above the agreed price; HC-7c is a separate step after the Premium sale has started (C1). | HC-7c |
| Q6 Code page model | a | The slot's link page is parked (hidden, restorable); at most one slot per account shows a code page (`max_on_pages` 1 from CS-6, admin setting 0–3). | CS-3 … CS-6 |
| Q7 Status free tier | a | Only after the unlock: `statusLimits` gives plan `none` without `status_page`. The basic-tier follow-up is dropped. | ST-4 |
| Q8 Visitor subscriptions | a | Later: ST-6 is Stage C (C3); its tables stay out of `V_STATUS_TABLES`. | ST-6 |
| Q9 Pages hiding the note today | a | Grandfathered until the owner of the page changes it (old switch, or custom CSS that hides the note); new CSS tricks no longer work; the editor shows a hint. Custom CSS stays free. | PD-1 |
| Q10 PHP | "Everything must work without PHP!" | 3.0 is Node-only; no `--rollback`, no two-week window, no 3.1; no PHP-rollback code in any PR (§2.2); every PR merges after 3.0 as soon as its dependencies are in (§4, §7); §8 is void; the before-update backup is part of 3.0 (§2.4). | all |
| Q11 Emails | a, own Mailcow | Mails only where the user must act or loses something (§3.8); Premium mails can be switched off. The mail server is the owner's own Mailcow: no provider limit; our own conservative budgets stay and are admin settings; Mailcow's own rate limits are set by the owner in Mailcow. | HC-7b, PD-3, PD-5, ST-3 … ST-5 |
| Q12 What status pages may check | a | Any public website, with per-site caps, robots.txt respected and an opt-out for site operators – as status-pages §6.2 designs it. | ST-2, ST-4 |
| Q13 Discord error | the loop | The loop between "Saved – for the bot, a token and a channel ID are both needed." and "Please save a webhook link or bot first." DP-1 makes it impossible and tests it (§4.1 #2); DP-2b tests the bot offer. | DP-1, DP-2b |
| Q14 Extras after v1 | a | Visitor milestones and the anniversary bonus (L2) first, then invite friends (L1), then the new purchasable designs (L3); the rest (L4, L5, DP-6) later. | C4, C5 |
| D1–D20 | as listed | No objection: every default in `QUESTIONS.de.md` stands. | the PRs named there |

---

## 7. Critical path and parallel tracks

Depth counts PRs, not days, but it shows where waiting starts.

**Critical path:** Node port parity gate → 3.0 (Node-only, installer switch) → **CD-0 → CD-1 → CD-3 → CS-1** →
**HC-5 → HC-6a → HC-7a** → admin activates the Premium options (PD-1 ready) → Premium on sale. **ST-7** (#44, depth 7
like HC-7b and ST-5, the last of v1) needs HC-7a and ST-4, and the status chain after CS-1 – **ST-2 → ST-3 → ST-4** –
is just as long as the shop chain (ST-4 also needs HC-6a), so the dialog work and the admin split (CS-1) gate both the
shop and the status pages. CD-0 needs the sign-off of honeycomb-shop and code-slots-admin: the first coordination
point on the path. The other inputs have slack: CORE-1 → HC-2 → HC-3 must be in before HC-5, HC-4 (after HC-3 and
CD-2) before HC-7a, PD-1 before the sale, PD-1b before ST-7, and DP-2a and DP-3 before ST-3.

| Track | Chain after 3.0 | Must be ready for |
|---|---|---|
| Dialogs and admin split (critical) | CD-0 → CD-1 → CD-3 → CS-1; CD-2 → CD-4, CD-5b beside it | CS-1 for HC-1, HC-5, ST-2, CS-5, PD-5; CD-2 for HC-4, HC-8, PD-4, CS-6; CD-5b for CS-6 |
| Shop (critical) | HC-2 → HC-3 → HC-5 (after CS-1) → HC-6a → HC-7a; HC-4 after HC-3 and CD-2 | Premium sale, ST-7, HC-7b; HC-6a also for ST-4 |
| Status | ST-1 → ST-2 (after CS-1) → ST-3 (needs DP-2a, DP-3, CD-5a) → ST-4 (needs HC-3, HC-6a, CS-2, CS-3) → ST-5; ST-7 (needs HC-7a, PD-1, PD-1b) | M4, M9 |
| Discord | DP-1 → DP-2a → DP-3; DP-2b after CD-3; DP-4 → DP-5 | M1, M2; DP-2a and DP-3 also for ST-3 |
| Domains | PD-2 → PD-3 → PD-6; PD-1 after HC-2; PD-1b after PD-1 and CS-3; PD-4 after PD-1, PD-3, CS-3 and HC-4; PD-5 after CS-1 | M8 together with HC-7a; PD-1 and PD-1b also for ST-7 |
| Code slots | CS-2 → CS-3 → CS-4 (needs HC-3, PD-2) → CS-5 (needs CS-1) → CS-6 (needs CD-2, CD-5b, HC-1) | M7; CS-3 also for PD-4, PD-1b and ST-4 |

**First after 3.0:** CORE-1, DP-1 (the owner's loop, Q13), CD-0 and DP-4 need nothing else and can merge as soon as
3.0 is out. The Discord fix and the own pages (M1, M2) reach users first; DP-1 alone already ends the loop.

---

## 8. PHP-rollback code per PR – void

This section listed what each PR would have had to keep if it merged while a PHP rollback still existed (the former
option a of Q10).
The owner answered Q10 with "everything must work without PHP!": there is no PHP rollback, so no PR keeps such code
(§2.2). The former table is withdrawn; `EDITS.md` names the design sections that built it.

---

## 9. Review findings – how each was handled

None of the 44 findings was wrong on the facts; each was checked against the designs and, where it cites code,
against the repository (for example `editor.js:593/694/2716/2768`, `.toast.hc` at `editor.css:429`, `blacklist.php`
run with PHP for the X2 slugs, `lib/community.php:304` and `:309-316`, `views/admin.php:91-113`,
`app/src/schema.ts:53-70`; `plan.md` has no "superseded" marker). One citation is off by one line (XD-13 cites
`plan.md` L32 for §0 item 4, which is L31). Several findings describe the same defect and are merged; where two
reviews proposed different fixes, one was chosen. X3, X4 and X11 are void since the owner's Q10 answer (no PHP
rollback).

| Finding | Handling | Where |
|---|---|---|
| XD-01, X1 | Accepted, modified: `hold_until` plus a per-kind hold policy instead of a days parameter; status renames follow the link-page cooldown so 90-day holds can't be farmed | §3.5, CS-2, ST-4 |
| XD-02, X8 | Accepted | §3.5 (E7), CS-4, PD-4 |
| XD-03, X13 | Accepted (`:716` corrected to `:2716`) | §3.3, PD-1, CS-4 |
| XD-04, X6 | Accepted; the admin-mode refusal moves into `buy()` | §3.2, HC-3, CS-4, ST-4 |
| XD-05, X10 | Accepted; refs per monitor (X10's variant) plus `maxAgeSec` | §3.7, DP-2a, DP-3, ST-3 |
| XD-06 | Accepted | §3.10, ST-2 |
| XD-07 | Accepted (`features.ts` in HC-2; notify dependencies on CD-5a) | §3.2, §4 |
| XD-08 | Accepted | DP-5 |
| XD-09 | Accepted | §3.4, §3.6, CS-5, CS-6 |
| XD-10, R13 | Accepted | §3.6 |
| XD-11 | Accepted | §3.4, ST-3 |
| XD-12, R10 | Accepted; CS-1 keeps today's style, HC-1 owns every honeycomb colour incl. `.toast.hc` while it exists | §3.4, §3.11, HC-1 |
| XD-13 | Accepted | §3.1, CORE-1 |
| XD-14 | Owner question, answered: Q1 = b | §3.3 |
| XD-15 | Accepted | §3.2, §3.3, ST-4 |
| XD-16 | Accepted | §3.2, ST-7, CS-4 |
| XD-17 | Accepted (Q11 = a) | §3.8, HC-7b |
| X2 | Accepted and extended to conversions onto an existing slot | §3.5, CS-2, CS-4, ST-4, D12 |
| X3 | Void – no PHP rollback (Q10) | – |
| X4 | Void – no PHP rollback (Q10); the outbox parking is dropped | §3.7 |
| X5 | Accepted; owned by core (CORE-1), hooks per feature | §3.9 |
| X7 | Accepted | ST-4 |
| X9 | Accepted | CS-3, PD-2, PD-4 |
| X11 | Void – no PHP rollback (Q10) | – |
| X12 | Accepted, also covers alert-address verifications | §3.8, ST-5 |
| X14 | Default D11 (accepted) | QUESTIONS.de.md |
| R1 | Accepted; HC-6 and HC-7 split, the timed lifecycle no longer waits for mail or auto-renewal | HC-6a/6b, HC-7a/7b/7c |
| R2 | Accepted; this file is the one cross-feature order | §4 |
| R3 | Owner question, answered: Q10 "everything must work without PHP" | §2 |
| R4 | Accepted | ST-1 … ST-3 |
| R5 | Accepted; `plan.md` §3.4/§5.3 point to discord-pages | §2.1, EDITS.md |
| R6 | Owner question, merged with premium-domains Q7; answered: Q2 = c | PD-1b |
| R7 | Owner question, merged into the price question; answered: Q4 = a | §3.2 |
| R8 | Owner question; answered: Q8 = a | ST-6 (C3) |
| R9 | Default D17 (accepted) | QUESTIONS.de.md |
| R11 | Accepted; grandfathering with a stricter "hides" check, Q9 = a | PD-1 |
| R12 | Accepted | §3.2 |

Questions that stay with `plan.md`: the PHP session import at cutover (plan Appendix 2). The `php-2.x` question
(plan Appendix 3) is answered by Q10: the branch is a reference for the development parity tests only, with no fixes
for Plesk or shared hosting.
