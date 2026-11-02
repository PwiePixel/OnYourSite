# Edits needed to make the six designs match ROADMAP.md

For each design: where to change it, what to change, and why (review finding, owner decision and `ROADMAP.md`
section). Section and line numbers refer to the revised designs as they are in this folder on 2026-11-01. The owner
has answered every question (`DECISIONS.md`); `Q…` and `D…` are the numbers of `QUESTIONS.de.md`, and every entry
states the decided answer – no design keeps a variant for another answer. Entries marked **Obsolete** were withdrawn
by a decision and must not be applied; entries marked **Applied** are already in the target file; the numbers of both
stay so that references keep working. A last section lists the edits `spec/plan.md` needs.

Common to all six designs:
- **Migration steps** become exported constants `V_<STEP>` that take the next free number at merge, in the order of
  ROADMAP §4; helpers come from CORE-1; each step names the steps it needs (XD-13, ROADMAP §3.1).
- **PR numbers and dependencies** follow ROADMAP §4: a position (`#1` … `#44`, Stage C `C1` … `C5`) and the real
  dependencies. There are no stages A/B, no rollback classes (N/W3/L) and no 3.1 gate: every PR merges after 3.0 as
  soon as its dependencies are in (Q10).
- **No PHP** (Q10): release 3.0 is Node-only and has no `install.sh --rollback`. Every mention of release 3.1, the
  two-week window, `--rollback`, the PHP rollback tree, PHP patches, fallbacks or mirrors written for PHP, and tests
  that run PHP against a migrated database goes; the entries below name the places. References to today's PHP code
  (`lib/…:line`) stay – they cite the behaviour the port keeps.
- **Open questions:** each design's last section is answered; replace it by the decided answers, mapped per design
  below. No design keeps open questions.

---

## 1. discord-pages.md

**DP-E1 · §4 intro (L393-397), §4.1, §4.2, §8 migrations** – Name the steps `V_DISCORD_DELIVERY` (PR 2a) and
`V_PUBLIC_PAGES` (PR 5); use CORE-1's `addIndex`/`hasIndex` instead of the design's own `addIndex`; replace "Plan §3.4
calls the Wave 3 pages migration v6" with "plan.md's v6 is replaced by these named steps". *Why:* XD-13; ROADMAP §3.1.

**DP-E2 · §4.2 (L482-502), §8 migrations, §10 PR 5** – The `publicPages` transaction no longer writes
`INSERT INTO notifications … SELECT`. It selects the affected `user_id`s (path-mode pages named `suggestions`, code
sites named `suggestions`) and calls `notify(uid, 'system', title, body, '/dashboard', {db: conn})` for each, inside the
transaction and before the `UPDATE`; drop the sentence about cutting texts like `oys_notify` (`notify()` does it). The
migration test checks "one notice per owner through `notify()`". PR 5 gets a hard dependency on custom-dialogs PR 5a.
*Why:* XD-08; ROADMAP §3.6, #14.

**DP-E3 · §5.1 (`community/outbox.ts`), §5.4 (L748-799), §8 bot API tests** – Define the registry as
`registerBotAction(action, {feature: string | null, onResult?(db, job, result, error, final), maxAgeSec?})`:
- `/_/bot/ping` and the `hello` answer list `hello` plus every registered feature; `hello` stores only registered
  features (so another feature's `status.v1` is kept);
- the `hello` validator **drops unknown top-level keys** and accepts an optional `gateway: {ready: boolean, ping_ms:
  integer ≥ 0}`; other violations stay 400;
- express the 24-hour rule of `update.post` and the 2-minute rule of `update.test` as `maxAgeSec` (86400, 120) and keep
  their special cases (`only_if_posted` for a claimed post, the post row update);
- `/done` calls the registered `onResult` inside its transaction (`update.*` → `applyBotResult`).
Tests: a registered test action whose `onResult` runs inside the `/done` transaction; `hello` with an unknown top-level
key and with `gateway` accepted; the known features come from the registry. *Why:* XD-05; ROADMAP §3.7.

**DP-E4 · §5.5.3 "Ticket jobs get ref …" (L946-947)** – Add the full ref list or point to ROADMAP §3.7:
`status-inc:<incidentId>`, `status-alert:m<monitorId>`, `status-alert:sys`. *Why:* XD-05 (4), X10.

**DP-E5 · §3.1 step 2, §5.6 `src/setup.js`, §6.9, §9 `discord-bot/install.sh`, §8 installer harness** – `--update`
runs `--discord-channel <KEY>` once for **every** `CHANNEL_SPECS` key that has no line in the settings file (today only
`UPDATES_CHANNEL_ID`; status-pages adds `STATUS_CHANNEL_ID` and `ALERTS_CHANNEL_ID`). `--updates-channel` becomes
`--channel <KEY>`; the §6.9 note names it. Harness: a second missing key is added once, nothing else changes. *Why:*
XD-05 (5); ROADMAP §3.7, #13.

**DP-E6 · Obsolete (Q10).** The outbox parking for `install.sh --rollback` (and its harness test) is not built: there
is no rollback. DP-E12 removes the rollback text instead. *Why:* Q10; X4 is void (ROADMAP §9).

**DP-E7 · §9 (L1432-1434), §12 row 16** – "plan.md:997 is marked superseded" is not true yet; write "plan.md §3.4 and
§5.3 point to this design (see EDITS.md, plan.md section)". *Why:* R5.

**DP-E8 · §10 table and "What I need from the other features"** – PR 2b depends on custom-dialogs PR 1 and PR 3
(hard; drop the local `data-confirm` shim, both land earlier); PR 5 on PR 5a (DP-E2); PR 3 contains the generic
channel loop (DP-E5). Add the ROADMAP positions (#2 PR 1, #4 PR 4, #7 PR 2a, #13 PR 3, #14 PR 5, #20 PR 2b, C4 PR 6);
there is no class and no v1 settings mirror (DP-E12). Replace the status-pages bullet with the registry contract of
DP-E3 (they register `status.*` with `onResult` and `maxAgeSec`, add two `CHANNEL_SPECS` keys and `gateway`).
*Why:* R2, XD-05, XD-07; Q10.

**DP-E9 · §3.4, §6.1, §6.2, §6.3 confirmations** – Every confirmed admin form renders `confirmAttrs()` **and**
`confirmField()` (fail closed), not only `data-confirm` attributes. *Why:* ROADMAP §3.4.

**DP-E10 · §5.7** – Add: once the shared jobs runner exists (HC-7a), the hourly outbox clean-up may move there.
Optional. *Why:* ROADMAP §3.10.

**DP-E11 · §11 (L1549-1575), §2.6 item 2 (L151)** – Every question is answered: Q6 by QUESTIONS Q13 (DP-E13); Q1–Q5
and Q7 by default D16, accepted – no author names, only decided suggestions appear by themselves, no newly typed bot
tokens on the website, path pages named `suggestions` move with a notice, older suggestions stay hidden, extras later
(Q14); plan.md's appendix item 4 ("own page" for the admin) by D17. Replace §11 by these answers. *Why:* R9;
DECISIONS.md.

**DP-E12 · §4.1 (L446-448), §4.3 (L518-534), §4.4 (L593), §5.1 `settings.ts` (L608), §8 (L1308-1309,
L1361-1364), §9 "Rollback" (L1476-1486), §10 PR 2a (L1510), §12 row 13 (L1596)** – The PHP compatibility layer (the
former class W3) is not built:
- §4.1: Node no longer writes `updates.discord_message_id/discord_target` for webhook and token posts. The columns stay
  (migrations only add); the step reads them once to turn existing posts into rows.
- §4.3: drop the v1 mirror – the paragraph "The last two lines are the v1 mirror …" and the mirror keys of the JSON
  example. While an old token is the legacy destination, the token (`bot_token`) and the channel and ping it posts with
  stay stored, because the `token` destination needs them – not because old code reads them. `discordSettingsFromV1()`
  stays: a restored old backup still holds v1 settings.
- §4.4 and §5.1: "Converted to v2" without "with the v1 mirror"; `storeDiscordSettings()` writes no mirror.
- §8: the unit test drops "the v1 mirror read back through a port of `array_intersect_key`"; the migration test drops
  "with the mirror" and "PHP's `oys_discord_settings` (php-cli on the migrated test DB) still finds the webhook and the
  token", and checks the v2 settings, the kept old token and the post rows instead.
- §9: "Rollback" becomes "Version skew" with the two bot bullets ("Bot 0.2 against an older website", "Bot 0.1 against
  the new website"); "To an older build" goes – recovery is the before-update backup plus the previous release
  (ROADMAP §2.4).
- §10 PR 2a: "settings v2 + mirror" → "settings v2".
- §12 row 13: add that the mirror keys, the old-column writes and the rollback text were withdrawn after the owner's
  Q10 answer; the token stays under `bot_token` because the legacy destination uses it.
*Why:* Q10; ROADMAP §2.2, §3.7, #7.

**DP-E13 · Q13, the loop the owner hit: §2 (new RC5 after RC4, L108-115), §2.6 (L127-164), §3.2 and §3.7
(L214-253, L371-389), §6.1 (L1034-1118), §8 HTTP admin tests (L1333-1347) and Playwright list (L1392-1397), §10 PR 1
row (L1509), §11 Q6 (L1567-1570)** – The owner's answer: "When I gave the webhook link, it said it needs a channel
ID; when I gave the channel ID, it said it needs a webhook link – whatever I tried."
- **§2:** add RC5 "the mode loop" as the observed case. `lib/updates.php:548` takes the mode from the radio; while it
  (or the stored mode) is `bot`, a pasted webhook link is stored but ignored (`:520-523`), and the save answers
  "Saved – for the bot, a token and a channel ID are both needed." (`:590-593`); "Send test" then answers "Please save
  a webhook link or bot first." (`:982-985`). The Node port has both texts (`app/src/updates/discord.ts:129-132`,
  `app/src/updates/admin.ts:156-157`). §2.6: the table gets a row for it, item 2 is answered, and the read-only
  command is no longer needed (it is a PHP command, and nothing runs PHP after 3.0); "§2.6 done" in the PR 1 row is
  met.
- **PR 1 makes the loop impossible:** a pasted webhook link selects the webhook mode, also when the stored mode is
  `bot`; only the fields of the visible mode are submitted; a channel ID alone is never "saved"; every message names
  exactly what is missing for the selected mode (no combined "a token and a channel ID" text, no "a webhook link or
  bot" text); saving checks the target with Discord and shows Discord's own error (§3.2 step 4); the installed bot is
  offered without retyping its token. PR 1 therefore never asks for the installed bot's token and takes no newly typed
  token (D16): its token form becomes §6.1's read-only "Old bot token" card at once (test and delete only). The offer
  itself ("Use #updates") is PR 2b's bot card; PR 1 … PR 3 should reach the owner in one release where possible.
- **§8 and §10 PR 1:** a required **loop test** (HTTP and Playwright), starting from the owner's state – stored mode
  `bot`, no token, no webhook: paste a webhook link and save → stored and enabled as the webhook destination, checked
  with the mock, "Send test" posts; save a channel ID alone → refused, nothing stored, the text names what is missing;
  a link the mock refuses (401, 404) → nothing stored, Discord's text shown; neither old message appears in any order
  of these steps. PR 2b's tests add: with an installed bot that reports, the bot card offers "Use #updates" and "Send
  test" posts through the bot, with no token field anywhere.
- **§11 Q6:** answered; PR 1's release note names the loop.
*Why:* Q13, D16; ROADMAP #2 DP-1, #20 DP-2b.

**DP-E14 · §2 (L124), §2.6 item 2 (L151), §6.5 (L1203)** – Refer to the owner without gendered pronouns: "so the
owner still couldn't use the installed bot", "the owner's Discord members"; item 2 is rewritten by DP-E11/DP-E13
anyway. *Why:* house style.

---

## 2. code-slots-admin.md

**CS-E1 · §0 "Addresses", §1.3 rule 11, §3.1 `createSiteAddresses` DDL and backfill, §4.2 `addresses.ts`
signatures and `claimAddress`/`releaseAddress` steps** – Add `hold_until DATETIME NULL` and
`KEY idx_hold (kind, hold_until)`. One hold policy chosen by the row's kind: `page`/`code` 30 days if used ≥ 7 days
(else free at once), `status` 90 days with no minimum use. `claimAddress(db, slug, kind, refId, userId: number |
null)`; `releaseAddress(db, slug, userId: number | null, holdFor: 'owner' | 'nobody' = 'owner')` (no days parameter;
the kind decides); expiry, pruning and `addressBlocks` compare `hold_until` with now. The backfill also inserts
`status_pages` rows when that table exists (kind `status`, `user_id` NULL for the system page). *Why:* XD-01, X1, R4;
ROADMAP §3.5.

**CS-E2 · §8 `sites:repair`** – Rows of kind `status` are checked against `status_pages` and left alone while that table
does not exist; the command never hands a status or held address to another row and prints name-rule violations
(CS-E15). (The former variant for a page created during a PHP rollback is gone with Q10.) *Why:* XD-01.

**CS-E3 · §1.3 rule 11, §1.5 item 8, §2.1 U14, §5.3 terms and privacy, §6 item 7, Limits table** – "30 days (status
pages: 90 days)". Replace the privacy sentence "Nothing else is kept" with the shared paragraph of ROADMAP §3.9.
*Why:* XD-01, X5.

**CS-E4 · §3.1 helpers (L345-358), §4.1 `schema.ts` row, §7 migration tests** – `hasIndex`, `addIndex`, `dropIndex`,
`columnIsNotNull` and `ensureSchema({upTo})` move to CORE-1 with the same signatures; remove the example numbers
(`8`, `9`); keep `V_SITE_ADDRESSES`/`V_CODE_SLOTS` as the global convention. *Why:* XD-13.

**CS-E5 · §2.4 E7 (L256-259), §4.2 `canCreate`/`canMove`, §4.4.1 `pages[].custom_domain`, §4.4.2 `code-connect` and
`code-move`, §4.5, §5.1 settings rows, §9.2 premium-domains bullet, §7 tests** – E7 reads
`domains.hasDomain(slot.id, db)` inside `withSlotLock` and passes it into the pure functions (e.g. a `slotHasDomain`
field of the quota input); it refuses for a `custom_domains` row in **any** state. The editor flag
`pages[].custom_domain` is premium-domains' "row in any state" value. Until premium-domains PR 2 exists `hasDomain` is a
stub returning false. New test: a page whose domain is still `verifying` cannot be turned into a code page. *Why:*
XD-02, X8.

**CS-E6 · §1.3 rule 10, §2.1 U11, §4.4.2 `code-address`, §4.4.3 `address`, §4.5 (L888-891), §5.1 switcher bullet,
§6 Limits table, §9.2 "Flags", §11 row 13** – The 30-day cooldown exemption is `isStaff(ctx, user)` on the server and
`E.staff` in the editor, for link pages and page-address code pages alike. Remove `address_pass`/`consume()` from v1
(a hook point for the shop's later step L4). `E.pagesUnlimited` is introduced by premium-domains PR 1 (= `isStaff`) and
computed from `pageAllowance()` in PR 3; the editor's page-limit checks are `editor.js:593, 694, 2716` (not `716`).
`E.premium` is no longer used for limits or the cooldown. *Why:* XD-03, X13; ROADMAP §3.3.

**CS-E7 · §4.4.2 `code-unlock`, §5.1 new-page modal and unlock boxes, §3.3 last paragraph, §7 HTTP tests** –
`code-unlock` takes `{terms, item, request_id, expected_price}`; a missing `request_id` → 409 `{"ok":false,"error":
"OnYourSite was updated – please reload the editor.","reload":true}`; admin mode → 403 from `buy()`; the route calls
`buy(ctx, uid, item, requestId, expectedPrice, {via: 'code', terms})` and maps `price_changed`. The editor creates the
request id when the unlock box or dialog opens, for `code_page` and `code_more`. Remove the `hcSpend`/`hcDefaults`
fallback: HC-3 lands before PR 4. *Why:* XD-04, X6; ROADMAP §3.2.

**CS-E8 · §4.4.3 `page-delete`, §9.2 premium-domains bullet** – Call `beforePageRemoved(pageId, db)` inside the
slot-locked transaction after the final re-checks (it is DB-only), not before the lock; a refused deletion then never
disconnects a live domain. *Why:* X9.

**CS-E9 · §4.2 "These run after the commit, on the pool" (L647-648), §4.6 "Notifications" (L959-962), §7 admin tests,
§9.2 custom-dialogs bullet** – `notify(uid, 'code', title, body, link, {db})` runs inside the slot-lock transaction
right after the `code_moderation` insert, exactly once, without `ref`; remove `notify` from the after-commit list and
"(with `ref`)" from the tests. *Why:* XD-09; ROADMAP §3.6.

**CS-E10 · §5.1 page switcher (`goToCode`), dialogs 1–4, the "goes to `/dashboard?site=ID#code`" bullet, §11 row 3** –
Navigate with `guard.confirm()` then `guard.navigate(url, {force: true})`; no `leaving = true`, no `location.href =`.
Dialog 4 passes the "Download files" button through `content`, not `text`. *Why:* XD-09; ROADMAP §3.4.

**CS-E11 · §5.2 Delete form (L1208-1216), block/unblock/ban/unban/unlock/settings forms, access table actions** –
Every moderation form renders `confirmAttrs()` + `confirmField()`; the typed delete keeps the visible field checked by
the server plus `_confirmed`, or uses `data-confirm-match/-normalize/-into="confirm"`. *Why:* XD-09.

**CS-E12 · §5.2 navigation and `ADMIN_TABS` (L1158-1164), Prices card** – PR 1 keeps today's style for the honeycombs
tab (`border-brand-500/30 bg-brand-500/10 text-brand-400`) and adds no yellow of its own; honeycomb-shop HC-1 sets the
honeycomb colours (`border-yellow-500/30 bg-yellow-500/10 text-yellow-400`, icon `text-yellow-400`). *Why:* XD-12, R10.

**CS-E13 · §4.1 `enforce.ts`, §9.2 "Enforcer" (L1593-1599)** – Register `enforceSlots` with `inline: true` for
`code_page` and `code_more` only – no `page_slot`, and no `premium`, because Premium never changes page or code-page
limits (Q1 = b). Losing `code_page` takes the user's code pages offline (files kept). A refund of `code_more` with
"Also remove" or a revoke – not a price change – takes the newest code pages above the free allowance offline, files
kept (D11). A re-run sends no notice; a notice is written only together with a recorded change. Drop "This feature
recommends that over the shop's "pause" (shop Q4); the owner decides (question 5)". *Why:* XD-16, X14; Q1 = b, D11;
ROADMAP §3.2.

**CS-E14 · §9.2 "Flags" (L1588-1592), §10 (L1648-1686)** – Remove the stale shop question numbers and write the
decided answers: Q1, Q2 and Q4 → QUESTIONS Q6 = a (CS-E21); Q3 → Q4 = a (`code_more` stays 0, CS-E22); Q5 → Q1 = b
(CS-E23); Q6 → D10 and Q7 → D9, both accepted (only the team releases or deletes a blocked code page; no custom domains
for code pages in v1); Q8 → Q2 = c (CS-E24). §10 then lists answers only. *Why:* XD-14, R6; DECISIONS.md.

**CS-E15 · §2.1 U2, U3, U5, U7, U11; §4.2 `slugProblem`; §4.4.2 `code-create`, `code-address`, `code-move`,
`code-connect`; §7 unit tests** – `slugProblem` calls the new pure `addressNameProblem(slug, kind)`: for every kind the
OnYourSite rule (joined letters contain `onyoursite`, or a token is `oys`); for `code` and `status` also the brand rules
(moved here from status-pages' `names.ts`). It runs on every claim and address change, **and** when a code page takes
over an existing slot's address (`code-connect` on an existing slot, `code-move` to a page) with the text "This page’s
address contains a brand name. Code pages can’t use brand names in their address." Existing addresses stay;
`sites:repair` lists them. *Why:* X2 (verified with PHP: `onyoursite-status`, `oys-status`, `paypal-status` are allowed
today), D12.

**CS-E16 · PHP rollback goes (Q10): §0 "Delivery" (L42-44), §1.2 schema row (L82), §1.5 item 9 (L193-194), §3.2
(L403, L424-425), §3.4 (L454-492), §4.1 (L536), §4.2 `slugProblem` step 2 (L696), §7 "PHP compatibility"
(L1439-1442), §8 (L1538-1543), §9.1 PR 3 row (L1565), §11 rows 5 and 8 (L1699, L1702)** – PR 2–6 contain nothing for
PHP: no patches of the PHP tree (`oys_code_site`, `oys_code_used_uploads`, `oys_code_delete_user`, `page-delete`), no
`install.sh --rollback` refusal and no `--force`, no PHP tests, no "PHP ignores held addresses", and no box
"If Q10 = (a)" (this replaces the earlier version of this entry). In detail: §0 and the PR 3 title lose "rollback
safety"; §1.2 says that 3.0 removes PHP; §1.5 item 9 goes; §3.2 names manual SQL as the only source of the two invalid
states; §3.4 keeps "No row changes its meaning", "Legacy collisions" and "The Node port before PR 3" and drops the
rollback bullet; §4.1 L536 goes; §4.2 keeps today's two table checks as a guard against drift from manual SQL or a
restored backup; §7 drops "PHP compatibility"; §8 drops the `--rollback` bullet and "After a rollback period …"
(`sites:repair` stays for drift and anomalies); §11 rows 5 and 8 note that the PHP parts were withdrawn after Q10.
*Why:* Q10, R3; X3 is void (ROADMAP §2.2, §9).

**CS-E17 · §4.1 `admin/page.ts` row, §4.7 `codeDeleteUser`** – Account deletion goes through CORE-1's `deleteAccount`:
the `code` hook (order 30; it no longer deletes ledger rows – the shop's `honeycombs` hook does) and the `addresses`
hook (order 70, `releaseUserAddresses`). *Why:* X5; ROADMAP §3.9.

**CS-E18 · §4.4 preamble, §5.1 "Settings without a shown link page"** – custom-dialogs PR 5a (ROADMAP #6) moves
`notifications`, `notifications-read`, `messages`, `message` and `booking-delete`; PR 3 moves `weekly`, `weekly-test`,
`discord` and `page-delete`. Bell polling without a page is done by custom-dialogs PR 5b. Both custom-dialogs PRs are in
before PR 6 makes accounts without a shown link page possible (PR 6 needs PR 5, which needs 5a, and needs 5b
directly), so remove the "if it lands first" alternatives. *Why:* ROADMAP §3.11, #37.

**CS-E19 · §9.1 table** – Dependencies: PR 1 admin port + custom-dialogs PR 3; PR 2 CORE-1 (+ status-pages PR 1 for
the status backfill when present, soft); PR 3 PR 2 (PR 1 soft: PR 3 extends the admin code list that PR 1 moves);
PR 4 PR 3, HC-3 (hard), premium-domains PR 2 (`hasDomain`, stub otherwise); PR 5 PR 1, PR 4, custom-dialogs PR 3 and
5a (hard); PR 6 PR 5, custom-dialogs PR 2 and PR 5b (hard), HC-1. Add the ROADMAP positions (#21 PR 1, #10 PR 2, #18
PR 3, #25 PR 4, #31 PR 5, #37 PR 6); there are no classes (Q10). PR 1 and PR 5 are in before HC-6a, which brings the
shop's `grantFeature`: in §4.6's `unlock` row, "before the shop" therefore means "before HC-6a", and until then the
free unlock books `hcAdd(uid, 0, 'unlock', item, …)` (ROADMAP §3.2). *Why:* R2; Q10.

**CS-E20 · §4.1 `slots.ts`, §4.2 lock order** – Export `withSlotLock` for premium-domains (`domain-add`) and
status-pages (`status-create`, `status-address`, `status-delete`). Lock order `users` → `pages` → `code_sites` →
`status_pages` → `site_addresses`. *Why:* ROADMAP §3.5.

**CS-E21 · Q6 = a, code page parking: §0 "Connect" (L20-22), §1.1 (L63-64), §1.3 terms table "Own address" (L93),
"How visitors reach everything" (L158-160), §10 Q1, Q2, Q4 (L1650-1668)** – The owner chose this design's model:
under the slot's address the code page appears; the link page is parked (hidden, restorable with "Show the link page
again"); at most one slot per account shows a code page (`max_on_pages` 1 from PR 6, admin setting 0–3, as §3.3
already says). "Extern" means a code page with its own on-your.site address, not a foreign domain. Replace "This
reading is owner question 1", "owner question 2" and "(owner question 1)" by "decided (QUESTIONS Q6 = a)". *Why:*
Q6; ROADMAP #18, #37.

**CS-E22 · Q4 = a, prices: §0 "Prices" (L23-26), §1.3 rule 9 table (L134), §10 Q3 (L1663-1666)** – `code_page` 100
(as today) and `code_more` 0 are the start prices; more code pages are free, and admins can set a price later. Replace
"(owner question 3)" by "(QUESTIONS Q4 = a)". *Why:* Q4; ROADMAP §3.2.

**CS-E23 · Q1 = b, Premium and page slots: §1.3 rule 10 (L144-150), §9.2 "Flags" (L1588-1592) and "Enforcer"
(L1593-1599), §10 Q5 (L1669-1674)** – Premium never raises the page allowance, and page slots are not sold in v1:
`pageAllowance` is `max_pages`, staff unlimited. Rule 10 states this instead of "decided together with honeycomb-shop
(owner question 5)"; §9.2 drops the `page_slot`/Premium-cap branch ("If the owner wants sellable page slots …" and
"Until the owner decides …"); the enforcer follows CS-E13. *Why:* Q1, XD-14; ROADMAP §3.3.

**CS-E24 · Q2 = c, the code-page badge: §1.4 first bullet (L164-165), §9.2 premium-domains bullet "The code badge"
(L1626), §10 Q8 (L1682-1686)** – For owners with Premium the badge becomes a plain "Report" link: same position and
target, no OnYourSite name, no hexagon (`codeBadge(ownerPremium)`). premium-domains PR 1b adds it in this design's
serve code after PR 3; this design reviews it. The report link stays for everybody; the code-page terms get the
sentence from PR 1b. *Why:* Q2, R6; ROADMAP #26.

---

## 3. honeycomb-shop.md

**HC-E1 · §3.2 intro and the `addIndex` block (L295-307)** – Delete the design's own `addIndex` (CORE-1 provides it)
and the sentence "so the merge order does not matter" (it does: `ensureSchema` runs steps by number, and premium-domains'
Step B reads `users.premium_until`). Name the steps `V_SHOP_CORE`, `V_SHOP_CATALOGUE`, `V_SHOP_MAIL`,
`V_SHOP_STREAKS`, `V_SHOP_EVENT_CODES`, `V_SHOP_AUTO_RENEW`, each with what it needs. *Why:* XD-13.

**HC-E2 · §3.2 HC-2 DDL and the code that uses the columns** – Move `hc_accounts.mail_reminders` to `V_SHOP_MAIL`
(HC-7b) and the `hc_entitlements` columns `auto_renew`, `renew_item`, `renew_max_price`, `renew_seq`,
`renew_failed_at`, `renew_notified_for`, `renew_notified_kind` to `V_SHOP_AUTO_RENEW` (HC-7c). The code that uses them
(`buy()` step 5 and the `autoRenew` option, `setPeriod`'s reset on refund/revoke, `Owned.autoRenew*`,
`ShopState.autoRenewAvailable`/`mailReminders`, `shop-auto-renew`, `shop-reminders`) arrives with those PRs. *Why:* R1.

**HC-E3 · §3.6 (L639-640), §4.1 module table, §4.4 rollout flag, §9.1 HC-2/HC-3 rows** – `features.ts`
(`registerFeature`, `registerPerk`, `premiumPerks`, `registerLossPreview`) ships in **HC-2**; `seedItems()` stays in HC-3
with `hc_items` (registrations before HC-3 live in memory only). *Why:* XD-07; ROADMAP §3.2.

**HC-E4 · §3.6 catalogue, §1.5 premium-domains row, §9.3, §10 Q2** – Add `custom_domain` (owner premium-domains, kind
count, max 10, requires `premium`, option `custom_domain_x1` 150, seeded inactive and never shown while the domains
switch `slots` is off – Q3 = a keeps it off). Premium row: "can be on sale from premium-domains PR 1 and HC-7a".
`premium_90` is 700 (Q4 = a; HC-E18). *Why:* R12, R7; Q3, Q4.

**HC-E5 · §4.3 `buy()` step 1, §4.10 table (403 rows), §4.11 `code-unlock`, §1.5 code-slots-admin row** – `buy()`
itself refuses admin mode: session `original_admin_id` and `via !== 'auto'` → 403 `{ok:false, code:'admin_mode',
error:'Buying is turned off in admin mode.'}`; `purchaseUnlock`, `code-unlock` and `status-unlock` inherit it. The
spending-route contract (request id created when the dialog opens, `expected_price`, 409 reload, 403) is written once
and referenced by code-slots-admin and status-pages. *Why:* X6, XD-04; ROADMAP §3.2.

**HC-E6 · §4.4 "Reading" `has()`, §7.2 unlock-model tests** – `has()` is also true when the feature's
`includedFor(user)` holds (one users primary-key read on the same `db`). Test: an admin without any entitlement row has
`status_page`. *Why:* XD-15 (1).

**HC-E7 · §4.5 "Unlock grants", §4.12 `feature_grant` row** – `formRef` is required for timed and count grants and
optional for permanent grants, which stay idempotent through the `unlock/<feature>` row. *Why:* XD-15 (3).

**HC-E8 · §4.4 "Reconcile" (L963-990)** – Add to the enforcer contract: a re-run never writes a bell row or mail;
notices are written only together with a transition recorded in the feature's own rows. "Who registers": code-slots-admin
`enforceSlots` for `code_page` and `code_more`, inline (not `premium`: Q1 = b); premium-domains `reconcileUser`
(`premium`, `custom_domain`, inline); status-pages `refreshStatusLimits`, side-effect free. *Why:* XD-16; Q1.

**HC-E9 · §4.5 refund (with "Also remove") and revoke, §4.13 step 4, §4.14 mail template** – A refund with remove and a
revoke of a timed feature queue the same "ended" mail as the natural expiry (ref `end:<entId>:<unix(now)>`, the
loss-preview lines included), only when `mail_reminders = 1` and the preview is not empty. Part of HC-7b. *Why:* XD-17;
Q11 = a; ROADMAP §3.8.

**HC-E10 · §1.5 custom-dialogs row ("Change request"), §9.3 custom-dialogs bullet, §11.2 "#14, one channel"** – Mark as
resolved: custom-dialogs now makes team actions bell-only (CD-E1). *Why:* XD-10, R13.

**HC-E11 · §5.1 table (L1362, L1365), §9.1 HC-1 row (L1800)** – HC-1 also recolours `.toast.hc` (`editor.css:429`,
indigo today) as long as custom-dialogs PR 2 has not deleted the old toast rules; whichever of the two lands second
does nothing for it. HC-1 recolours the admin honeycomb nav item and `ADMIN_TABS.honeycombs` after code-slots-admin
PR 1, and it is the only place that sets honeycomb colours. It uses the `--hc*` tokens of `ui.css` without fallbacks:
custom-dialogs PR 1 is always in before HC-1 (HC-1 needs code-slots-admin PR 1, which needs custom-dialogs PR 3, which
needs PR 1 – ROADMAP #28), and no PHP view needs them (HC-E16). *Why:* R10, XD-12; Q10.

**HC-E12 · §9.1 table and "Suggested global order"** – Split the PRs:
- **HC-6a** users and details, unlock grants/revokes, purchases and refunds, bell notices (deps HC-5, custom-dialogs 5a;
  5b soft);
- **HC-6b** bulk grants with preview, ledger reversal, freeze (deps HC-6a);
- **HC-7a** `jobs/registry.ts`, `cli.js jobs:tick`, the timer, the honeycomb job steps 1 (reconcile), 3 (reminders, bell
  only), 4 (expiry, bell and reconcile), 6 (nightly checks and repair) and 7, the expiry banners, `LIFECYCLE_READY`
  (deps HC-4, HC-6a, custom-dialogs 5a);
- **HC-7b** `V_SHOP_MAIL`, the outbox and its step 5, `email/unlock_reminder.json`, the stage-2 reminder mail, the
  "ended" mail (HC-E9), the reminders switch, the mail budget setting (HC-E22) (deps HC-7a; Q11 = a);
- **HC-7c** `V_SHOP_AUTO_RENEW`, step 2 (auto-renew), `shop-auto-renew`, the switch and its dialogs, the U10 texts
  (deps HC-7a; Q5 = a, Stage C after the Premium sale has started, HC-E21).
HC-1 depends on code-slots-admin PR 1; HC-4 gets HC-1 as a soft dependency (the yellow icon class: if HC-4 is in
first, as in ROADMAP's order, HC-1 turns its `hc-icon` icons yellow with the rest) and custom-dialogs PR 2 as a hard one
(the `notices` of the shop answers are shown by its `request()` – ROADMAP #22; the design's "soft" goes); HC-9 depends
on HC-6a. Replace the "Suggested global order" by a reference to ROADMAP §4 (positions #8 HC-2, #16 HC-3, #22 HC-4, #28
HC-1, #30 HC-5, #34 HC-8, #36 HC-6a, #39 HC-7a, #40 HC-6b, #41 HC-9, #42 HC-7b, C1 HC-7c, C5 L1–L5) and drop the edge
"status-pages PR 4 → HC-4". *Why:* R1, R2; Q10.

**HC-E13 · §0 bullet "Premium …", §1.3 item 2, §1.4 last non-goal, §10** – Premium's scope is decided (QUESTIONS
Q1 = b: domains, branding, status limits; staff privileges stay `isStaff`); the non-goal states it as settled (HC-E19).
§10 lists the answers: Q1 → D1, Q2 → Q4 = a (HC-E18), Q3 → Q1 = b (HC-E19), Q4 → Q5 = a (HC-E21), Q5 → Q11 = a,
Q6 → D3, Q7 → D2, Q8 → Q14 = a (HC-E20), Q9 → D4 – the defaults all accepted. *Why:* XD-14, R7; DECISIONS.md.

**HC-E14 · §3.8** – `hcDeleteUser` becomes the `honeycombs` hook (order 40) of CORE-1's `deleteAccount`; it also deletes
the `honeycomb_ledger` rows (moved there from code-slots-admin's hook). *Why:* X5; ROADMAP §3.9.

**HC-E15 · §4.13 "Shared runner" (L1256-1259), §8.1 last bullet, §9.3** – The runner is created by HC-7a. Correct
"premium-domains (5-minute domain job) … can register there": premium-domains runs a long-running worker; status-pages
watches the runner (`job:runner`) and the worker (`job:domains`). *Why:* XD-06; ROADMAP §3.10.

**HC-E16 · PHP rollback goes (Q10): §0 (L18-20), §3.4 (L578-580), §3.5 (L607-608), §3.7 (L716-717), §4.4 `has()`
(L906-909), §4.11 `codeUnlocked()` row (L1209), §4.12 `item_save` row (L1225), §5.1 (L1349-1350, L1365), §5.2
(L1378-1380, L1437-1440, L1447-1448), §7.2 (L1608-1609), §7.4 flow 8 (L1700-1701), §8.1 (L1745-1746), §9.1 HC-1, HC-4
and HC-7 rows (L1800, L1803, L1806), §11.1 rows 13 and 22 (L1881, L1890) and its list "Also fixed while checking"
(L1899-1900)** – Nothing is built for
PHP (this replaces the earlier "only if Q10 = (a)" version of this entry): no `code_page` price mirror into
`oys_meta.honeycombs` (§3.5, §4.12); no legacy modal and no `honeycombs.earned` fallback for a PHP view (§5.2) –
HC-4 deletes the old modal (`hcBody`/`openHoneycombs`, `editor.js:2115-2151`), and HC-8 replaces the
`honeycombs.earned` loop (`editor.js:2853-2858`) by the bootstrap `notices`; no `hc-rollback.js` (§7.4 flow 8); no
`--rollback` step for the jobs timer (§8.1); no `var(--hc, …)` fallbacks written for PHP views (§5.1). `has()`'s
ledger fallback stays, but only for unlock rows the old process writes between `migrate` and the restart (§3.4,
§4.4); the §7.2 test says "written by the old process during a deploy". §0's "after a PHP rollback" and §3.7's PHP
display note go; §4.11 keeps "every unlock still writes the ledger row" without the PHP reason; §11 notes that the
PHP parts were withdrawn after Q10. *Why:* Q10, R3; ROADMAP §2.2.

**HC-E17 · §1.5 status-pages row, §3.6 status rows** – "after HC-7" → "after HC-7a". *Why:* R1.

**HC-E18 · Q4 = a, start prices: §3.6 v1 catalogue (L675-686), §3.5 `honeycombs` shape (L601-603), §10 Q2 (L1847)**
– Seed exactly: `premium_30` 350, `premium_90` **700** (not 900), `code_page` 100, `code_more` 0, `status_page` 150,
`status_more_checks_30` 60, `status_fast_checks_30` 80, `custom_domain_x1` 150 (inactive); `streak_week` 15,
`streak_month` 50 (repeating, as §4.6 counts them), `daily_cap` 300. The calibration (about 260 a month for a daily
visitor) stays. *Why:* Q4, R7; ROADMAP §3.2.

**HC-E19 · Q1 = b, Premium perks: §0 Premium bullet (L24-30), §1.5 status-pages row ("Their Premium perk only if the
owner agrees (Q3)"), §3.6 `premium` row (L680, "if Q3 = yes"), §9.3 status-pages bullet ("only if Q3 = yes"), §10 Q3
(L1848)** – Premium includes the status-page Premium limits (30 checks instead of 10, checks every minute, 250
subscribers once status-pages' subscriptions exist); status-pages registers that perk in its PR 7. The Premium card
lists three perk groups: a custom domain for link pages (one per page, at most 3 – Q3 = a), no OnYourSite branding
including title, favicon and the code-page badge (Q2 = c), and the status limits. Page limit, upload quota and address
cooldown stay staff-only. *Why:* Q1, Q2, Q3, XD-14; ROADMAP §3.3.

**HC-E20 · Q14 = a, later steps: §0 "More ways to earn" (L40-42), §3.3 heading (L504), §3.6 "Proposed later" (L689),
§9.2 heading and table (L1815-1823), §10 Q8 (L1853)** – The later steps are not "only after the owner approves"; the
owner set the order: L2 visitor milestones and the anniversary bonus first, then L1 invite friends, then L3 the new
purchasable designs; L4 (address passes, storage) and L5 (community rewards) later. They stay outside v1 (ROADMAP C5).
*Why:* Q14; ROADMAP §3.2, §4.2.

**HC-E21 · Q5 = a, auto-renewal: §2.1 U10 (L178-186), §10 Q4 (L1849)** – Decided as designed: opt-in only, the job
renews one day (24 hours) before the end, never above the price the user agreed to (a higher price asks again). HC-7c
is a separate step after the Premium sale has started (ROADMAP C1). *Why:* Q5; ROADMAP §4.2.

**HC-E22 · Q11 = a, mails and budget: §6.2 "Job" row (L1565), §4.13/§4.14, §5.3 admin, §10 Q5 (L1850)** – Mails as
designed: one 3 days before Premium ends (auto-renewal off) and one when it ended, both switchable by the user. The
mail server is the owner's own Mailcow (no provider limit). "≤ 100 mails per run" stays as our own conservative budget
but becomes an admin setting (default 100; for example `mails_per_run` in `oys_meta.honeycombs`, shown in Admin →
Honeycombs next to the job status), added by HC-7b. *Why:* Q11; ROADMAP §3.8.

---

## 4. premium-domains.md

**PD-E1 · §3.1** – Step A is `V_CUSTOM_DOMAINS` (PR 2), Step B is `V_BRANDING_LEGACY` (PR 1, needs `V_SHOP_CORE`);
use CORE-1's `addIndex` instead of the inline `SHOW INDEX` check. *Why:* XD-13.

**PD-E2 · §0 branding bullet (L17-22), §3.4 (L550-552), §4.4.1, §10 Q3 and Q9, §7.1 migration tests** – Correct "the
visible output of every page stays the same in PR 1": free pages that hide the note with custom CSS today would show it
again, and the footer hover changes on all pages. QUESTIONS Q9 = a (grandfathered until the owner of the page changes
it): Step B also grandfathers free pages whose custom CSS **hides** the note – a new pure `cssHidesBranding(css)`,
stricter than `cssTouchesBranding` (a selector that targets the note **and** a hiding declaration such as
`display:none`, `visibility:hidden`, `opacity:0`, `font-size:0`, `height:0`/`max-height:0`, `clip`/`clip-path`,
`transform:scale(0)`), sets `hide_branding = true` and `branding_legacy = true`. CSS that only restyles the note is not
grandfathered (its footer stays visible, as today). New CSS tricks no longer work (pinned footer), and saving such CSS
shows the hint; custom CSS stays free for everyone (not Premium-only). The hover change goes into the release note.
This design's Q3 and Q9 are both answered by QUESTIONS Q9 = a; there is no notice variant. *Why:* R11; Q9.

**PD-E3 · §3.5 items 3–5, §9 PR 1, PR 3 and PR 4 rows** – `registerPerk`, `registerLossPreview` and `registerFeature`
come from HC-2 (`features.ts` moved); PR 3 needs HC-2 and custom-dialogs 5a; the `custom_domain` option is seeded by
HC-3's `seedItems()`, so PR 4 depends on HC-3. *Why:* XD-07.

**PD-E4 · §4.5.2 dashboard payload, §4.10 `hasDomain` row, §9 code-slots-admin bullet** – `pages[].custom_domain` in
the editor payload is `hasDomain` (a row in any state); code-slots-admin uses it for E7 in the editor. `hasDomain`
ships in PR 2. *Why:* XD-02.

**PD-E5 · §2.8 "Page deleted", §4.6 delete-user paragraph, §4.10 `beforePageRemoved`/`onUserDeleted` rows, §5.6
privacy** – `beforePageRemoved(pageId, db)` takes the caller's connection (DB-only compare-and-set) and is called by
code-slots-admin inside its slot-locked transaction after the final checks. `onUserDeleted` becomes the `domains` hook
(order 10) of CORE-1's `deleteAccount`, registered in PR 2: rows to `removing`, `pages.custom_domain` cleared, pending
mail rows cancelled, `custom_domain_log.user_id = NULL` for that user. Privacy text as ROADMAP §3.9. *Why:* X9, X5.

**PD-E6 · §2.7 "Notice" row (L311-314), §4.11 email bullet** – The shop always sends the bell notice with this design's
loss-preview lines; the **mail** for expiry, refund with remove and revoke comes from the shop's HC-7b (Q11 = a).
Without HC-7b there is no domain mail for these cases. *Why:* XD-17; ROADMAP §3.8.

**PD-E7 · §2.10 A5, §4.12 last bullet, §8.4** – Settled: status-pages' `domains` component reads `domains.health()`
in-process and its new `job:domains` component watches `workerAt`. *Why:* XD-06.

**PD-E8 · PHP rollback goes (Q10): §7.4 harness scenario (L1590), §8.3 `--rollback` row (L1726), §9 PR 6 row
(L1762)** – Drop the `--rollback` scenario, the `--rollback` row and "rollback" from PR 6's list of installer changes.
There is no "If Q10 = (a)" variant (this replaces the earlier version of this entry). *Why:* Q10, R3; X11 is void.

**PD-E9 · §4.4 "Editor flags"** – PR 1 also adds `E.pagesUnlimited` (= `isStaff` until code-slots-admin PR 3 computes it
from `pageAllowance()`) and switches `editor.js:593, 694, 2716` to it and `:2768` to `E.staff`. *Why:* XD-03; ROADMAP §3.3.

**PD-E10 · §0 branding bullet (L19-21), §1.2 row "OnYourSite werbung weg machen" (L78), §3.4 (L551), §5.3, §9 PR 1b
(L1757), §10** – Branding scope is decided: QUESTIONS Q2 = c. PR 1b is built – drop "only if the owner agrees (Q7)",
"only after Q7" and "(only if Q7 = yes)". PR 1b also adds `codeBadge(ownerPremium)`: for owners with Premium the
code-page badge becomes a plain "Report" link (same position and target, no OnYourSite name, no hexagon), plus the
sentence in the code-page terms; PR 1b then depends on PR 1 and code-slots-admin PR 3. §1.2's "The code-page badge …
stays (code-slots-admin Q8)" is replaced by this. §10 lists the answers: Q1 → Q3 = a, Q2 → D5, Q3 + Q9 → Q9 = a,
Q4 → D6, Q5 → D7, Q6 → D8, Q7 → Q2 = c, Q8 → Q1 = b, Q10 → D9. *Why:* R6, XD-14; Q2.

**PD-E11 · §9 table** – Dependencies: PR 1 HC-2; PR 2 CORE-1; PR 3 PR 2, HC-2, custom-dialogs 5a; PR 4 PR 1, PR 3,
code-slots-admin PR 3 (`withSlotLock`), HC-3, HC-4, custom-dialogs PR 1 and 2; PR 5 PR 3, code-slots-admin PR 1,
custom-dialogs PR 3; PR 6 PR 3. ROADMAP positions #17 PR 1, #26 PR 1b, #11 PR 2, #19 PR 3, #32 PR 4, #33 PR 5, #27
PR 6; there are no classes (Q10). "Premium can be sold once HC-7a exists". *Why:* R2; Q10.

**PD-E12 · §5.4 navigation** – The admin entry sits after "Code pages" (ROADMAP §3.11). *Why:* consistency.

**PD-E13 · Q1 = b and Q3 = a: §0 Premium bullet (L10-16), §1.2 first row (L75), §10 Q1 and Q8 (L1800-1803,
L1821-1824)** – Premium unlocks the two things of this design plus the status-page limits that status-pages registers
(Q1 = b); page limit, upload quota and address cooldown stay staff-only (`isStaff`). A custom domain is included in
Premium – one per link page, at most 3 per user (`per_user` 3) – and the `slots` switch ("Each domain needs a domain
slot") stays built in and off, with `custom_domain_x1` (150) seeded inactive (Q3 = a, Q4 = a). Replace "the owner
answers this once for all three designs (Q8)" and "→ Q1 becomes a catalogue setting" by the decided answers. *Why:*
Q1, Q3, XD-14; ROADMAP §3.3.

**PD-E14 · Q11 = a, mail budget: §3.2 `custom_domains` (L512), §4.6 `settings` row (L914), §4.9 "up to 20 emails"
(L1094), §5.4 Settings card (L1329-1336), §6.2 limits table** – Mail goes through the owner's own Mailcow (no provider
limit). The worker's "up to 20 emails" per minute stays as our own conservative budget but becomes an admin setting:
a key in `custom_domains` (for example `mails_per_minute`, default 20, clamped), a number field in the Settings card,
and a row in §6.2. The worker reads it (PR 3), the admin shows it (PR 5). "At most one problem mail per domain per
24 h" (the flap guard) stays fixed. *Why:* Q11; ROADMAP §3.8, #19, #33.

---

## 5. custom-dialogs.md

**CD-E1 · §5.4 second bullet (L378-379), §5.8 team row (L454)** – Bootstrap `notices` carry only the rewards earned on
that load (remove "and gifts"). Team gifts, deductions, refunds and referrals are bell-only (`honeycombs`), toasted by
the bell poll (remove "(and next visit's notices)"); the first poll also toasts unread items newer than the stored
last-toasted id. *Why:* XD-10, R13; ROADMAP §3.6.

**CD-E2 · §4.1** – The step is `V_NOTIFICATIONS_INDEX` and uses CORE-1's `addIndex`; drop "plan.md §0 item 4 reserves
v6". *Why:* XD-13.

**CD-E3 · §5.2 catalogue, §6.10 deep links** – Add the rows `status_down` (`bx-pulse`, `err`), `status_up`
(`bx-pulse`, `ok`) and `status_team` (`bx-shield-quarter`, `warn`), all with link `/dashboard#status`, so every row ships
in PR 5a. `DEEP_LINKS` documents the target `status` with the argument `system`; link arguments use `/`, never `:`
(the colon fails `safeLink`). *Why:* XD-11.

**CD-E4 · §5.2 `notify()` bullets** – State the rule for features: the bell row is written in the transaction of the
state change it reports (`{db}`); that – not a `ref` – makes it exactly once. *Why:* XD-09; ROADMAP §3.6.

**CD-E5 · §11.1 table and the paragraph below** – Every PR merges after 3.0 as soon as its dependencies are in
(ROADMAP #3 PR 0, #5 PR 1, #6 PR 5a, #12 PR 3, #15 PR 2, #23 PR 4, #24 PR 5b; PR 6 is Stage C, C2, after HC-7a).
PR 5a depends on CORE-1 (helpers); "parity gate" in the Needs column becomes "3.0". There are no stages A/B and no
3.1 (Q10). *Why:* R2, R3; Q10.

**CD-E6 · Rule R goes (Q10): header (L6), §3.5 "ui.js fails to load" row (L230), §4.3 (L271), §5.5 (L392), §6.4
(L755-760), §6.6 (L807-808), §6.10 (L929-930, L934-935), §7.1 rows 22 and 24 (L1021, L1023), §7.4 first sentence
(L1082), §7.5 lint exception (L1108-1109), §9 flow 7 (L1229-1231) and "PHP rollback smoke" (L1243-1244), §10
"Rollback" (L1261), §11.1 PR 2 row (L1278), §11.2 (L1291-1310), §11.3 (L1336, L1366-1369), §13 row 3 (L1420)** –
This replaces the earlier "only if Q10 = (a)" version of this entry. No legacy adapter (`legacyUI`, the
`oys-legacy` blocks and their lint exception); PR 2 deletes the old `.toasts`/`.toast*` rules itself; a missing
`OYSUI` stops the editor with the in-page notice (no "before 3.1" path in §3.5, §7.1 row 24 and flow 7); `bell.js` is
included by the views and reads only Node's answer shape (no self-loading in row 22, no fallback for answers without
`icon`/`link`); `OYS_FLASH` stays the editor's flash for its own sake (§5.5 drops the rollback reason); delete §11.2,
the rollback smoke test, the §10 rollback bullet, the PHP clause of §11.3's honeycomb bullet and the `--rollback`
guard advice at the end of §11.3. §7.4 keeps `page.js`'s `OYSUI` checks only for the blocked-`ui.js` case of §3.5
(profile pages behave as today); its reason "the PHP rollback serves these pages" goes. §13 row 3 notes that Rule R
was withdrawn after Q10. *Why:* Q10, R3; ROADMAP §2.2, #15, #23, #24.

**CD-E7 · §6.4 last paragraph** – honeycomb-shop HC-1 recolours `.toast.hc` with the tokens only while PR 2 has not
deleted the old toast rules; whichever of the two lands second does nothing for it. *Why:* R10; ROADMAP #28.

**CD-E8 · §11.3 per-design bullets** – code-slots-admin: resolved (notify without `ref` inside the transaction,
`guard.navigate`, nodes in `content`, `confirmField()` on moderation forms – CS-E9 to CS-E11). discord-pages: resolved
(DP-E2, DP-E9). status-pages: the three type rows ship in 5a; links `#status/system`. *Why:* XD-08, XD-09, XD-11.

**CD-E9 · §5.3, §11.3 code-slots-admin bullet** – PR 5a moves its five actions; code-slots-admin PR 3 moves `weekly`,
`weekly-test`, `discord`, `page-delete` (CS-E18). *Why:* ROADMAP §3.11.

**CD-E10 · §12** – All answered: Q4 → QUESTIONS Q11 = a (mails only where the user must act or loses something;
Premium mails can be switched off; the owner's own Mailcow); Q1 → D18; Q2, Q3 and Q6 → D19; Q5 → D20 (PR 6 built
with the switch off). The defaults are accepted as recommended; §12 lists the answers. *Why:* dedup; DECISIONS.md.

---

## 6. status-pages.md

**ST-E1 · §3.1 (L283-288, L614-635), §9 PR 1** – `V_STATUS_TABLES` no longer depends on the address registry: the
system page seed calls `claimAddress(db, 'status', 'status', id, null)` only when `site_addresses` exists (otherwise
code-slots-admin's backfill claims it); drop "It runs after code-slots-admin's siteAddresses step". Add
`status_pages.limit_paused SMALLINT UNSIGNED NOT NULL DEFAULT 0` (ST-E3). Q8 = a: `status_subscribers` and
`status_broadcasts` move to `V_STATUS_SUBSCRIBERS` (PR 6). Use CORE-1's helpers. *Why:* R4, R8, XD-16, XD-13.

**ST-E2 · §4.2 `limits.ts`, §4.10, §2.1.10, §4.8.2** – Until PR 4, `statusLimits` returns the system page's fixed limits
and plan `none` for users, without any shop read. From PR 4 it returns plan `none` (0 checks) when
`!has(uid, 'status_page')` – `has()` includes admins through `includedFor` – so every monitor of a page that lost its
unlock pauses as "over the limit", data kept. *Why:* R4, X7, XD-15 (1).

**ST-E3 · §4.10 `refreshStatusLimits` (L1547-1551), §2.1.10** – Side-effect free: it only sets `changed_at` and bumps
`status_rev`. The checker sends one `status_team` notice when the number of over-limit monitors changes from 0 to more
than 0 or back, and stores that number in `status_pages.limit_paused` in the same transaction. *Why:* XD-16.

**ST-E4 · §2.1.1, §4.6 `status-unlock` row, `StatusState`** – Call `buy(ctx, uid, 'status_page', requestId,
expectedPrice, {via: 'status', terms})` directly and return its top-level `notices` (not "the shop's notice"); missing
`request_id` → 409 reload; the admin-mode 403 comes from `buy()`. *Why:* XD-15 (2), X6.

**ST-E5 · §4.7 `unlock` row** – Unchanged call; it is valid because `formRef` is optional for permanent grants (HC-E7);
§4.10 already shows the same call. *Why:* XD-15 (3).

**ST-E6 · §3.2 settings comment, §4.2 reuse list, §4.10 last paragraph, §5.3 footer bullet, §7 render test, §9
premium-domains bullet** – `brandingHidden(settings, ownerPremium)` → `footerHidden(settings, ownerPremium)` from
`content/branding.ts`. *Why:* XD-15 (4).

**ST-E7 · §4.8.11 "Bot" bullet (L1370-1374), §5.8, §9 discord-pages bullets, §7 Discord tests** – Alerts use
`ref: 'status-alert:m' + monitorId` (`'status-alert:sys'` for the watchdog and gate alerts). Register
`status.alert` (`maxAgeSec` 7200) and `status.post/edit/delete` with `onResult` = the incident-post handler (applies
`message_id`/`channel_id` inside the `/done` transaction) through `registerBotAction`. The bot's post handlers send the
nonce `oys-<action>-<jobId>`; the bot version becomes 0.3.0. *Why:* XD-05, X10; ROADMAP §3.7.

**ST-E8 · §4.8.11 bell bullet (L1355-1359), §5.1 admin scope switch (L1601-1605), §5.6 card 2 (L1793), §4.9 alerts** –
`/dashboard#status:system` → `/dashboard#status/system`; register the `DEEP_LINKS` target `status` with argument
`system` (until custom-dialogs PR 2 exists, `editor.js`'s own hash handling opens it). The three `NOTIFY_TYPES` rows ship
in custom-dialogs 5a; remove "our PR adds the three exact rows". *Why:* XD-11.

**ST-E9 · §3.1 seed step 4, §4.9 table (`domains` row L1453, job rows L1460), §9 premium-domains bullet (L2493)** – The
`domains` component reads `domains.health()` in-process: major when the worker is not ok, or when domains are live and
the probe is older than 20 minutes; hidden while `health().configured` is false. Add the internal component
`job:domains` (from `workerAt`, major after 3 minutes). Drop the request for the fallback-origin hostname. *Why:* XD-06.

**ST-E10 · §2.1.9, §4.6 `status-address` and `status-delete` rows, §5.1 settings texts, §6.6 last bullets (L2042-2052)** –
`releaseAddress(db, slug, uid, 'owner')`: the registry holds status addresses 90 days with no minimum use. Remove
"(The registry frees an address used for less than 7 days at once …)". The address cooldown is the link-page rule – the
first change is free, then once per 30 days, staff exempt – instead of "only once the page has confirmed subscribers";
this caps a status owner at about four held addresses per 90 days. On account deletion there is no own release call
(the registry's hook does it). *Why:* XD-01, X1; ROADMAP §3.5.

**ST-E11 · §2.1.2, §4.2 `names.ts`, §6.6 "Impersonation", §7 `status.names.test.ts`** – The slug rules (OnYourSite name,
brand tokens, distinctive brands) move into code-slots-admin's shared `addressNameProblem(slug, kind)` (CS-E15) and
apply to every kind (OnYourSite rule) and to code and status pages (brand rules). `names.ts` keeps `statusTitleProblem`
and the review flag; the slug test list moves with the function. *Why:* X2.

**ST-E12 · §4.8.12 "confirm" class, §6.3** – Each page may use at most 10 `confirm`-class mails a day (plus 10 % of its
confirmed subscribers once PR 6 exists), checked with the per-page limiter; this also covers alert-address
verifications (PR 5). *Why:* X12.

**ST-E13 · §6.6 "Deleting an account" (L2050-2052)** – `statusDeleteUser` becomes the `status` hook (order 20) of
CORE-1's `deleteAccount`, in the same transaction; it deletes the page's pending and sent `status_outbox` rows and
calls no `releaseAddress` of its own. *Why:* X5; ROADMAP §3.9.

**ST-E14 · §9 table** – PR 1 depends on CORE-1 only; PR 2 on PR 1 and code-slots-admin PR 1 (admin nav); PR 3 on PR 2,
custom-dialogs PR 1 and 5a, discord-pages PR 2a and 3; PR 4 on PR 3, HC-3, HC-6a (`grantFeature` for the free unlock,
§4.7 `unlock` row – it arrives with HC-6a), code-slots-admin PR 2 and PR 3, custom-dialogs 5a, HC-1 (soft); PR 5 on
PR 4; PR 6 on PR 5 (Q8 = a: later, Stage C); PR 7 on PR 4, HC-7a and premium-domains PR 1 and PR 1b (Q1 = b; PR 1b's
`fullyUnbranded` for Q2 = c, ST-E23). ROADMAP positions #9 PR 1, #29 PR 2, #35 PR 3, #38 PR 4, #43 PR 5, #44 PR 7,
C3 PR 6; there are no classes (Q10), and the editor tab of PR 3 stays guarded so that a missing `#tab-status` does
nothing. *Why:* R4, R2, R8; Q10.

**ST-E15 · PHP rollback goes (Q10): §3.4 (L732-736), §4.2 `cli.ts` row (L834), §5.6 card 1 (L1790), §7 router test
(L2219-2220) and installer test (L2253-2256), §8 item 10 (L2442-2447), §9 PR 2 row (L2469) and "Core (plan.md)"
bullet (L2521-2522), §11.1 row 17 (L2611)** – No `status:slug-check`, no "link page created during a rollback", no
"slug conflicts after a rollback" on the health card, no "Rolling back to an older build", and no `--rollback` step:
the units are stopped by `--reset` and by uninstall only. This replaces the earlier version of this entry, which kept
`--rollback` for PR 2 and PR 3. §3.4 keeps "Nothing is migrated" and the routing order; §11.1 row 17 notes that the
rollback parts were withdrawn after Q10. *Why:* Q10, R3.

**ST-E16 · §4.6 `status-create`, `status-address`, `status-delete`** – Run under code-slots-admin's `withSlotLock(uid)`
instead of an own user-row lock, so every address writer of an account shares one lock and one lock order. *Why:*
ROADMAP §3.5.

**ST-E17 · §0 bullet "Alerts", §1.2 "alerts" row, §2.1.8, §2.2 subscribe bullets** – Visitor subscriptions come later
(Q8 = a, Stage C): at the start alerts go only to the owner (email, verified extra addresses, Discord, bell). *Why:*
R8; Q8.

**ST-E18 · §5.1 rail, §5.6 navigation** – The `.nav-desktop` rule comes from the first PR that needs it. In ROADMAP's
order that is honeycomb-shop HC-4 (#22, before PR 3 at #35), so PR 3 reuses it, as §5.1 already says ("the class
honeycomb-shop introduces"); only if PR 3 is in first does it add the rule, and HC-4 then reuses it.
`ADMIN_TABS.status` uses lime. *Why:* ROADMAP §3.11.

**ST-E19 · §10** – All answered: Q1 → D13; Q2 → Q4 = a; Q3 → Q1 = b (ST-E22); Q4 → Q12 = a; Q5 → D13; Q6 and Q7 →
D14; Q8 → D15; Q9 → Q11 = a (ST-E21); Q10 → D13; Q11 → Q7 = a (ST-E20); visitor subscriptions → Q8 = a (ST-E17).
The defaults are accepted; §10 lists the answers. *Why:* dedup, R8; DECISIONS.md.

**ST-E20 · Q7 = a, no free tier: §1.2 row "Status Page-System … was alle nutzen können" (L57), §9 follow-ups
(L2476-2478), §10 Q11 (L2562-2574)** – A status page needs the unlock; there is no free basic tier and nothing is
prepared for one. Replace "Whether a small part should be free … is open question 11" by the decision and drop "the
free basic tier if the owner wants it (question 11)" from the follow-ups. *Why:* Q7; ROADMAP #38, §4.2.

**ST-E21 · Q11 = a, mail budget: §0 last bullet (L36-37), §3.3 (L718-719), §6.3 (L1981-1982), §10 Q9 (L2556-2559)** –
Mail goes through the owner's own Mailcow, so there is no provider limit to derive the budget from. The defaults
(`mail_per_min` 30, `mail_per_day` 1,000, Premium subscribers ≤ 25 % of the day) are our own conservative budget, not
placeholders, and stay admin settings in Admin → Status; Mailcow's own rate limits are the owner's. "follow the SMTP
quota (open question 9)" → "follow the daily mail budget"; "the SMTP quota" in §0 → "our mail budget". *Why:* Q11;
ROADMAP §3.8.

**ST-E22 · Q1 = b, Q4 = a, Q12 = a: §4.10, §9 honeycomb-shop bullet ("Q3's perk text", L2487), §10 Q2–Q4
(L2531-2541); for the Premium values also §2.1.5 (L157), §2.1.6 (L172), §3.3 `premium` row (L705), §4.8.12 (L1382),
§6.3 (L1977), §6.7 rows "Extra alert channels" and "Subscriber broadcasts per day" (L2064, L2066)** – Premium includes
the status limits; the perk text names 30 checks instead of 10, checks every minute and – once PR 6 exists – 250
subscribers; the unlock is 150 once, "Extra checks" 60 and "Fast checks" 80 per 30 days; any public website may be
checked within the per-site caps, robots.txt and the operators' opt-out (§6.2, as designed). Q1 = b names exactly
these three status perks, so the other two Premium values change: `premium.channels` 5 → 3 and
`premium.broadcasts_day` 10 → 3, the free plan's values (still admin settings in Admin → Status); "(Premium 5)",
"(Premium 10)" and "Premium 10" go from the texts, the §6.7 Premium column shows 3 and 3, and the §9 perk text loses
"5 alert channels". *Why:* Q1, Q4, Q12; ROADMAP §3.3, #38, #44.

**ST-E23 · Q2 = c, branding on status pages: §5.3 footer bullet (L1745-1749), §9 PR 7 row (L2474)** – Besides
`footerHidden` (ST-E6), a Premium owner's status page follows premium-domains PR 1b's `fullyUnbranded` wherever the
renderer adds OnYourSite's title suffix or favicon; §5.3 states the page's `<title>` and favicon, which it does not
today. "Report this page" stays. PR 7 applies it and therefore depends on premium-domains PR 1b (ST-E14). *Why:* Q2;
ROADMAP §3.3, #44.

---

## 7. spec/plan.md

Line numbers in this section refer to `plan.md` as it is since 2026-11-02 00:09, when PL-E1 and PL-E5 were applied
there (the new §3.5 moved every line after L793 down by six).

**PL-E1 · §0 item 4 (L31)** – **Applied:** item 4 no longer says "6 = Wave 3" or that PHP keeps running on a migrated
database; it names the feature steps of ROADMAP §3.1 and says that 3.0 is Node-only. Nothing left to do. *Why:* XD-13;
Q10.

**PL-E2 · §3.4 (L736-790)** – Replace "Separate pages" and "Discord fix" with a pointer: the spec of record is
`design/discord-pages.md` (named steps `discordDelivery` and `publicPages`, `/suggestions` off until the admin turns it
on, no new bot tokens), delivered as DP-1 … DP-5 after 3.0 – not by the port packages P5/P6. The "P9 Wave 3" SMTP items
stay. *Why:* R5.

**PL-E3 · §5.2 `step_bot` row (L1003), §5.3 step 6 (L1097) and step 11 (L1111), data inventory (L1118, L1124-1125)** – The
cutover migrates to schema 5 only; step 11 updates the bot as today; the `UPDATES_CHANNEL_ID` step belongs to the bot
installer (DP-3). *Why:* R5, XD-13.

**PL-E4 · Obsolete (Q10).** There is no `--rollback` in which to park outbox jobs or disable status units, and no PHP
that must read migrated databases; PL-E8 replaces §5.6. *Why:* Q10.

**PL-E5 · §3.5 "Feature wave (after 3.0)" (L794-798)** – **Applied:** the section points to `design/ROADMAP.md` and
`design/DECISIONS.md` and lets them win over Wave 3, v6 and the PHP rollback. Nothing left to do. *Why:* R2.

**PL-E6 · §5.2 (`--update`), §5.3 step 3 (L1094)** – `install.sh --update` always takes a backup first:
`backup.sh before-update` (DB dump, settings, hard-link upload snapshot) on every update; on the migration from PHP this
is step 3's `before-node`. A failed release is fixed forward or restored from that backup plus the previous release
tag, documented in `server/README.md`. This was CORE-1's before-update backup; it is now part of 3.0 (this replaces the
earlier "from CORE-1 on" version). *Why:* Q10; ROADMAP §2.4.

**PL-E7 · Appendix items 1, 3 and 4** – Item 1 is answered by D16 and item 4 by D17; item 3 by Q10: the `php-2.x`
branch is a reference for the development parity tests only, with no fixes for Plesk or shared hosting. *Why:* R9; Q10.

**PL-E8 · Q10, 3.0 is Node-only: §0 item 5 (L32), §1 bcrypt row (L47), §3.3 track D (L731), §5.1 (L985), §5.2
(L993, L997, L1008-1009, L1080), §5.3 (L1084, L1096, L1109, L1112, L1123, L1129), §5.4 (L1133), §5.5 (L1145), §5.6
(L1147-1154), §5.7 (L1156-1161), §6 risks 10 and 15 (L1178, L1183)** – The PHP site is removed in 3.0, right after the
parity gate: §5.7's list moves into 3.0 and gains `tests/unit.php`; "release 3.1, at least 2 weeks later" goes, and
"Port `seed.php` to TS" moves with the list. §5.6 becomes "Recovery" (PL-E6) – no `--rollback`, no vhost swap back
after the migration; §5.2 drops "new `--rollback`", "Existing installs keep their PHP packages for rollback" and
"`PHPV` is still detected (for rollback …)"; §5.1's "Rollback is a vhost swap", §5.2's "rollback needs no `chown`",
§5.3's "(rollback; ignored by Node)", "Kept until 3.1" and the "rollback command" in the summary go; §5.4's rehearsals
replace "then `--rollback`, then `--update` again" by "a forced failure of the check after the switch (automatic
revert) and a restore from the backup plus the previous release"; §5.5 installs no PHP at all, also not for importing
an old server's `config.php` (PL-E10); §1 keeps `$2y$` without "so a rollback to PHP still works"; risks 10 and 15 drop
`--rollback` and "`php-2.x` branch for Plesk with 3 months of security fixes"; item 5's "both stacks can serve from
the same files" (L32) becomes "both stacks can serve the same uploads during the switch" – the code files are no
longer the same (PL-E9). What stays, because the owner asked for the automatic revert: the previous vhost and
`proxy_fcgi` in `write_apache` (L997), now only until the check after the switch has passed (instead of "until PHP is
removed"); step 9's "automatic rollback of the vhost" (L1109), called "automatic revert", which needs PL-E9's PHP
files; and the inventory's "PHP-FPM: disabled, not removed" (L1129). *Why:* Q10.

**PL-E9 · Q10, keeping PHP serving during the migration: §5.3 intro (L1084), steps 1, 7–9 (L1086, L1098-1109)** –
"The cutover release still contains the complete PHP code" is no longer true, and step 1's `git pull` would delete the
PHP files PHP-FPM serves. Required by the owner's answer: the migration from PHP aborts with the PHP site still
serving if anything fails before the switch, and reverts automatically if the check right after the switch fails. The
plan must say how the installer serves PHP from the previous release's files until step 9 has passed (for example a
copy of the code folder taken with the backup, or a checkout of the last PHP tag, as the PHP document root), and when
it removes that copy. *Why:* Q10; ROADMAP §2.1. Left to the lead: the mechanism.

**PL-E10 · Q10, no PHP code in the 3.0 tree: §2.1 (L71), §2.7 (L533), §4.6 (L930), §5.2 `write_config_json` (L994),
§5.3 step 2 (L1093) and step 8 (L1100)** – `app/scripts/config-from-php.php` is PHP code in the tree; the conversion
of `config.php` has to work without it (and without PHP on fresh servers, PL-E8). The pre-flight `check --php-compare`
(`php -r`) and the optional `sessions:import-php` (`php -r session_decode`) run PHP only during the migration, which
"nothing on the server needs PHP after the migration" allows, but they may not rely on files of the PHP tree. The
parity harness (§4.7) runs PHP from the `php-2.x` branch. *Why:* Q10. Left to the lead: whether the inline `php -r`
calls count as "PHP code in 3.0".

**PL-E11 · §4.1 row L6 (L813), §4.7 "Gate for release 3.0" (L965)** – 3.0 is the pure port (ROADMAP §2.1): its gate is
the parity gate, the clean L7 crawl and the green §5.4 rehearsals. "Wave 3 snapshots approved, e2e8/e2e9 green" and
"New e2e8/e2e9 after Wave 3" go: those pages and admin flows are tested by DP-4, DP-5 and DP-1/DP-2b after 3.0
(discord-pages §8). *Why:* R5; ROADMAP §2.1.
