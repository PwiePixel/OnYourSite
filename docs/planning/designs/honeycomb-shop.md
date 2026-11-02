# Honeycomb shop – design

Feature `honeycomb-shop` · target: the Node version in `app/` after the parity gate · v1 = PR series HC-1 … HC-9;
later items start only after the owner approves them (§9.2) · revised after the design review (§11)

`$S` = the original development workspace (not in the repository, see ../README.md). Code references are to the PHP reference (`lib/`, `views/`,
`static/`) unless they start with `app/`. `port/hc:` = the honeycomb port in progress (`$S/wt-hc`, branch `port/hc`).
The other designs are being revised at the same time, so they are cited by section (`<name>.md §x`), not by line.

## 0. Summary

- **The ledger stays the only source of truth for balances.** A balance is always `SUM(honeycomb_ledger.amount)`.
  Everything that can lower a balance or change what a user owns runs in **one InnoDB transaction that first locks the
  user's `hc_accounts` row** (`FOR UPDATE WAIT 5`). Every change of what a user owns also writes a ledger row
  (`unlock`, `purchase`, `grant`, `revoke`, `refund`), so the history is complete and the ledger's unique key
  (`uq_entry`) still guards against booking twice. Earning on the dashboard uses `NOWAIT` and skips when the row is busy.
- **One ownership model for every feature.** `hc_entitlements` is what features read (`has()`, `quantity()`,
  `entitlement()`). A permanent unlock – bought or granted – writes the ledger row `unlock/<feature>` and the
  entitlement in the same transaction. So `code_page`, `code_more` and `status_page` behave the same in the shop, in
  code-slots-admin, in status-pages and after a PHP rollback (`oys_code_unlocked()` still finds its row).
- **Catalogue = behaviour in code, prices in one table.** Each feature's owner registers it in code (kind, limits and
  purchase checks such as bans and terms). `hc_items` holds every price, and `quote()` is the only reader. Admins set
  prices, availability windows and a minimum account age, and run **offers** (sales) with a start and an end.
- **Premium is a user status**, kept in `users.premium_until` in the same transaction as the `premium` entitlement
  ("for good" is an explicit flag, never NULL). It is bought for 30 or 90 days or granted by an admin. Admins always
  have it. It includes exactly the perks the owning designs register: a custom domain per link page and no "Made
  with OnYourSite" (premium-domains), and the status-page Premium limits if the owner agrees (Q3). It does **not**
  lift the page limit, the upload quota or the address cooldown; those stay staff-only (`isStaff`). Premium stays
  hidden until premium-domains marks it ready.
- **Time-limited unlocks** are checked against the clock at read time, so access ends on time even if a job is late.
  One shared job runner (the honeycomb part runs every 15 minutes) does the side effects:
  - reminders 7, 3 and 1 day(s) before the end;
  - opt-in auto-renewal, at no more than the price the user accepted;
  - expiry notices and mails from a durable outbox;
  - retries of the **reconcile marker**, which makes every change reach the other features (domains, code pages)
    even after a crash or a busy lock.

  Every notification is written in the same transaction as the state change it reports, so it is sent exactly once.
  Data is never deleted when something ends.
- **More ways to earn in v1:** streak bonuses (7 and 30 days), a daily cap for automatic rewards and admin-created
  event codes. Referrals, visitor milestones, anniversaries, paid cosmetics, address passes, extra storage and
  community rewards are specified as later steps. They start only after the owner approves them (§9.2, Q8).
- **UI:** a new "Honeycombs" tab in the editor (shop, your unlocks, earn, redeem, history) and yellow honeycomb icons
  (the `--hc` tokens that custom-dialogs defines in `ui.css`). Notices and bell notifications go through
  custom-dialogs, with one channel per event. The admin "Honeycombs" section gets sub-tabs: overview, catalogue &
  prices, offers, earning rules, users, purchases, ledger and codes.

---

## 1. Goal, requirement and interpretation

### 1.1 What the owner asked for

> „… außerdem soll im beeich Honeycombs nun noch mehr möglichkeiten geben und ich will das es für alles Custom push ups
> gibt und nicht von webbrowser. dazu will ich das man sich auch Custom Domain für link page mit Honeycombs kaufen kan …
> dies ist aber ein Premium Feature genauso wie das OnYourSite werbung weg zu machen. und ich will das die HoneyCombs
> icons Gelb sind."

Follow-up answer: Honeycombs = **admin prices & grants, more things to unlock, more ways to earn, time-limited
purchases** (all four).

### 1.2 What exists today (the base this builds on)

| Area | Today | Where |
|---|---|---|
| Ledger | `honeycomb_ledger(id, user_id, amount, reason, ref, note, created_at)`, `UNIQUE(user_id, reason, ref)`; a balance is `SUM(amount)` | `app/src/schema.ts:310-318`, `lib/honeycombs.php:43-48` |
| Booking | `INSERT IGNORE` – a second booking with the same reason+ref does nothing | `lib/honeycombs.php:58-63` |
| Rules | `oys_meta['honeycombs']` JSON: `daily 5`, `profile 20`, `views 10` per `views_step 100` (one level a day, max 20 levels), price `code_page 100`; values clamped 0–100000 | `lib/honeycombs.php:5-41`, map-app §7.5 |
| Earning | only on `GET /dashboard` (and HEAD), not while impersonating; the route has no rate limit | `lib/routes_app.php:561-613` (`:611`), `lib/honeycombs.php:102-128` |
| Spending | `GET_LOCK('oys_hc_<uid>', 10)` → balance check → `INSERT IGNORE` reason `unlock`, ref `code_page`; one unlock only | `lib/honeycombs.php:132-159`, `port/hc:app/src/honeycombs/honeycombs.ts:154-175` |
| Unlock checks | `oys_code_unlocked()` = the ledger row `unlock/code_page` exists; the admin "Unlock for free" writes a 0-amount row `unlock/code_page` | `lib/codesites.php:44-47`, `lib/honeycombs.php:231-243` |
| Admin | rules form, grant/deduct with note and a per-form nonce (`ref = a<adminId>-<16 hex>`, balance never below 0), code page block/unblock, free code page unlock, balances table, last 25 entries | `lib/honeycombs.php:183-246`, `views/admin_honeycombs.php:5-200`, dispatch `views/admin.php:47-55` |
| Editor | pill with balance in the header, modal "Your honeycombs" (rules, code page, history), earned toasts staggered by 700 ms, code page unlock modal | `views/dashboard.php:119`, `static/js/editor.js:2108-2151`, `:2252-2302`, `:2853-2858` |
| Colours | everything indigo (`--e-brand-2`, `text-brand-400`) | `static/css/editor.css:424-451`, `views/admin_honeycombs.php:39,149` |
| Premium | `is_admin` or an admin impersonating (`original_admin_id`). Gives 1000 MB instead of 200 MB, no page limit, the hide-branding toggle and no 30-day address cooldown. `E.premium` is a boolean in the editor bootstrap | `lib/routes_app.php:23-26`, uses at `:333`, `:349`, `:381`, `:413`, `:433`; `lib/pages.php:83`; `lib/render.php:165`; `views/dashboard.php:20` |
| Bell | `notifications` rows (type, title, body). The API returns no link, and every item opens Messages | `lib/routes_app.php:514-529`, `static/js/editor.js:664-665` |
| Client key | `oys_client_key()` = HMAC of the **UTC** date and the IP (IPv6 per /64), 16 hex | `lib/helpers.php:360-368`, `app/src/web/security.ts:40-43` |
| Terms | honeycombs have no money value, cannot be bought, sold or transferred; cheating can be removed | `views/terms-code-pages.php:167-178` |

### 1.3 Interpretation (where the wording is open)

1. **"noch mehr Möglichkeiten"** = all four confirmed areas: admin prices and grants, more unlocks, more ways to earn,
   time-limited purchases.
2. **"Custom Domain … mit Honeycombs kaufen … Premium Feature … Werbung weg"**: honeycombs buy **Premium for a
   period**. Premium includes the custom domain for link pages and the removal of "Made with OnYourSite". Both are
   built by premium-domains. This design defines how Premium is bought, granted, renewed, refunded and how it ends.
   Today's other "premium" privileges (no page limit, 1000 MB, no address cooldown) are staff privileges and stay with
   admins (premium-domains.md §0, code-slots-admin.md §1.3 rule 10).
3. **"time-limited purchases"** has two meanings and both are built: unlocks that run for N days (Premium, status-page
   check packs) and **time-limited offers** (sales and limited items with a start and an end).
4. **"Custom push ups … nicht von Webbrowser"**: every confirmation, success, reward and reminder in this feature goes
   through the custom-dialogs feature. Nothing here uses `alert()`, `confirm()` or `prompt()`.
5. **"HoneyCombs icons Gelb"**: every icon that stands for the currency or the honeycomb area becomes yellow. The
   OnYourSite **logo** also uses `bx-hive` (`views/dashboard.php:84`, `views/landingpage.php:110`, …) – it stays in the
   brand colour (open question Q1).
6. **"Ledger stays the source of truth"** (from the task split): no balance column anywhere. Every change of what a
   user owns is a ledger row plus derived state (`hc_entitlements`, `users.premium_until`) written in the same
   transaction.

### 1.4 Non-goals

- No buying honeycombs with money, no payouts, no transfers or gifts between users. This keeps the terms true and
  makes farming with extra accounts pointless.
- Honeycombs never expire.
- No self-service refunds (only admins refund, §4.5).
- Nothing that is free today becomes paid: all 30 themes, 13 layouts, effects (`lib/blocks.php:28`), particles and
  rings stay free.
- The shop does not decide what other features do. It owns the mechanics: catalogue, prices, purchases, expiry,
  grants and earning. Each feature's owner registers its items and its purchase checks (§3.6).
- Bought Premium never changes page slots, code page limits, the upload quota or the address cooldown.

### 1.5 Contracts with the other five designs

| Design | This design provides | This design needs |
|---|---|---|
| **custom-dialogs** | sign-off on their dialog contract (their PR 0); notices only in their shape `{tone, text, title?, amount?, action?}` (their §5.4); the bell types `honeycombs` and `unlock` as their catalogue defines them (§4.14); the tab as the target of `/dashboard#honeycombs[/<feature>]` (their §6.10); no own copy of the `--hc` tokens | **PR 1:** `OYSUI.confirm` with `content`, `canConfirm`, `onConfirm(values, ctl)` and `ctl.update` for the purchase dialog; `OYSUI.notices()`; `confirmAttrs()`/`confirmField()` and `beforeSubmit` for admin forms; the `--hc*` tokens in `ui.css`. **PR 2:** the editor's `request()` shows `notices`. **PR 5a:** `notify(…, {db})` and `notifyAdmins()`. **PR 5b:** bell links. **Change request:** their §5.8 row "Honeycombs given, taken or refunded by the team" should be bell-only (drop "and next visit's notices"), so a gift is never announced twice (§4.14). |
| **code-slots-admin** | `has(uid, feature, db?)`, `quantity(uid, feature, db?)`, `entitlement()`; `isPremium(uid, db?)` (also exported as `premiumActive`); `buy()` with `BuyCheck.db`, plus `purchaseUnlock()` and `shopPrice()` (thin wrappers over `buy()`/`quote()` with today's `hcSpend` semantics: `null` = done, otherwise an error text; owned = done); `grantFeature()`/`revokeFeature()`; `registerFeature()`; the reconcile marker and `registerEnforcer()`; `hcAdd(…, 'unlock', …)` keeps working and also writes the entitlement (§4.4) | They own and register `code_page` (HC-3 creates `app/src/code/shop.ts` with today's terms rule; they add the ban check) and `code_more` (permanent, `requires: 'code_page'`, default price 0 = free, their §9.2). Their admin "Unlock for free" calls `grantFeature()`. Their `code-unlock` passes `request_id` and `expected_price` from the client. Their `enforceSlots` follows the enforcer contract of §4.4 (own lock, one connection), as their §9.2 already says. **Alignment:** the 30-day address exemption is `isStaff()` (today's `hasPremium()`: admins and admins acting as a user). Bought Premium does not exempt. Address passes are a later step (L4). There are no buyable page slots and no Premium page cap, so their `pageAllowance` stays `max_pages` with admins unlimited. |
| **premium-domains** | `users.premium_until` (+ the explicit `permanent` flag), `isPremiumRow`, `isPremium`, `premiumUntil`, `premiumState` (§4.4); every change marks the account for reconcile and calls the `premium` enforcer; reminder lines from their `premiumLossPreview`; `E.premiumUntil`, `E.premiumForever`; `openShop('premium')` | Their PR 1 renames `hasPremium` → `isStaff`, switches `E.premium` to the owner's real status, adds `E.staff` (their §4.4) and marks Premium ready. They register their perks (`registerPerk('premium', …)`), `onPremiumChanged` as the `premium` enforcer and `premiumLossPreview` as the loss preview (their §3.5, §4.10). **New request:** a minimum account age before a domain can be added (recommendation 30 days, §6.1). |
| **status-pages** | registry and catalogue, stackable timed packs (lots, §3.6), `has()`, `entitlement(uid, key) → {active, until, quantity, lots}`, `premiumState()`, `isPremium()` (also exported as `userPremium`); `purchaseUnlock()`, `shopPrice()` and `grantFeature()` for their unlock route and admin | As their §4.10 now specifies: they register `status_page` (permanent, 150) in their PR 4, after HC-3, and `status_more_checks` (timed 30 days, 2 packs at most, 60) and `status_fast_checks` (timed 30 days, 80) in their PR 7, after HC-7, each with `canBuy`/`needsTerms`. They have no pre-shop unlock path any more. Their limits stay read-time (`statusLimits`); the enforcer they register (`refreshStatusLimits`, inline) only clears their limits cache. Their Premium perk only if the owner agrees (Q3). |
| **discord-pages** | nothing in v1 | Nothing in v1. Community rewards are the later step L5 (§4.9). It can build on their forward-compatible `hello` (unknown features are dropped) and the kept `author_id` (discord-pages.md §5.4, §10). |

---

## 2. User stories and flows

### 2.1 Users (editor)

**U1 – First visit of the day.** `GET /dashboard` books the daily reward, updates the streak and checks the profile
and views rules. It runs at most once per user every 10 seconds. The rewards arrive in the bootstrap's `notices`
(custom-dialogs §5.4) and show as yellow toasts 700 ms apart, e.g. `+5 · for being active today` and `+15 · for a
7-day streak`. More than six show as five plus "+N more" with the action *History* (custom-dialogs §6.6). The pill
"pops" (`editor.js:2109-2113`). Earning is best effort: if the account row is locked at that moment, it is skipped and
happens on the next load. Gifts, refunds and renewals are not repeated here; they arrive once, in the bell (U17).

**U2 – Open the shop.** Click the pill (header) or "Honeycombs" in the rail → tab `#honeycombs`: balance card, streak
chip, "Unlock" grid, "Your unlocks", "Earn honeycombs", "Redeem a code", "History". If loading fails: *"Couldn’t load
your honeycombs – please reload."* (same panel as the code tab, `editor.js:2213`).

**U3 – Buy a permanent unlock** (code page, more code pages, status page). The card shows the price with a yellow
hive icon. "Buy" opens the purchase dialog: *"Unlock your code page? Costs 100 · you have 140 → 40 left."* The owner's
terms checkbox is part of the dialog when the terms are not yet accepted (`editor.js:2248`). Confirm → `shop-buy` →
toast *"−100 · Code page unlocked"*, balance updated, card turns into "Owned". The owner's checks run inside the
purchase, e.g. *"Code pages have been turned off for your account by the team."*

**U4 – Buy or extend Premium** (only once Premium is ready, §4.4). The card shows the perks registered by the owners
and a duration choice: 30 or 90 days, each with its own price. Dialog: *"Premium for 30 days – runs until Dec 1, 2026.
Costs 350 · you have 420 → 70 left."* plus the checkbox *"Renew automatically for up to 350 honeycombs (the regular
price) while I have enough"*, off by default. While Premium is active, buying again extends from the current end
date: *"Premium will run until Mar 1, 2027."* At most 400 days ahead. Premium needs an account that is at least 30
days old and was active on at least 10 days: *"Premium is available once your account is 30 days old."*

**U5 – Not enough honeycombs.** The button is disabled and reads *"120 more needed"*; below it a link *"How to earn
honeycombs"* scrolls to the earn list (same pattern as `editor.js:2269-2271`).

**U6 – Price changed between seeing and buying** (sale started or ended, admin changed the price, offer used up). The
server answers `code: 'price_changed'`. The dialog stays open, shows *"The price changed – this now costs 280
honeycombs (it was 350)."* and its button becomes "Buy for 280". It retries with the same request id and the new
expected price.

**U7 – Limits.** *"You already own this."*, *"Premium is included with your admin account."*, *"You have Premium for
good – no need to buy it."*, *"Needs your code page first."*, *"You already have 2 packs – you can extend one
instead."*, *"This is available once your account is 30 days old."*, *"This offer was already used on your account."*
The card shows the reason instead of a buy button.

**U8 – Reminders.** 7, 3 and 1 day(s) before a timed unlock ends, a bell notification *"Premium ends in 3 days"*
(link to `/dashboard#honeycombs/premium`). For Premium it adds the lines from premium-domains' loss preview:
*"links.example.com will forward to mia.on-your.site."*, *"“Made with OnYourSite” will be shown again on 2 pages."*
One email goes out 3 days before, only if auto-renew is off and the user did not turn reminder mails off. In the
editor an amber banner above the tab content: *"Premium ends in 2 days. Renew"*, dismissible for the day.

**U9 – It ended.** Read-time checks stop the perks at the end time. The job then notifies: *"Premium has ended. Your
settings and pages are kept – renew any time to switch everything back on."* It also triggers the owners' reconcile:
the custom domain forwards to the OnYourSite address for 30 days (premium-domains), and status checks above the free
limit pause (status-pages). Editor banner for 14 days, with "Renew" and "Dismiss" (dismissed per end date, remembered
in the browser): *"Premium ended on Nov 30. Your custom domain forwards to your OnYourSite address – your content is
safe."* Renewing switches everything back through the same reconcile.

**U10 – Auto-renewal.** 24 hours before the end, the job buys the same option again, but only if its current price is
at most the price the user accepted when turning auto-renew on. The request id comes from a counter.
- Success: *"Premium was renewed until Jan 1, 2027 – 350 honeycombs spent."*
- Not enough: *"Couldn’t renew Premium – you need 350 honeycombs and have 120."* Sent once per period. The job
  retries every 6 hours until the end, never after it.
- Price above the accepted maximum: *"Premium now costs 500 honeycombs – more than the 350 you agreed to. Renew it in
  the shop if you still want it."* Once per period, no charge.
- Honeycombs on hold: *"Couldn’t renew Premium – your honeycombs are on hold."*
- A refund or revoke turns auto-renewal off: *"Auto-renewal for Premium was turned off."*

**U11 – Stackable packs** (status-pages' "Extra checks"). The card shows *"1 of 2 packs active"*. While one pack runs,
the dialog offers *"Add a second pack (+10 checks now, until Dec 15)"* or *"Extend your pack (until Dec 31)"*. With two
packs only "Extend" is possible, for the pack that ends first.

**U12 – Redeem a code.** Input + "Redeem". Errors: *"Please enter a code."*, *"This code doesn’t exist or has
expired."*, *"You’ve already used this code."*, *"This code has been used up."*, *"This code is for accounts that are
at least 7 days old."*, *"Too many tries. Please wait 15 minutes."*

**U13 – History.** 20 entries, *"Show more"* loads older ones. Empty: *"Nothing yet – your first honeycombs are on their
way."* (existing text, `editor.js:2133`).

**U14 – Frozen account.** Banner in the tab: *"Your honeycombs are on hold: <reason>. Earning and buying are paused –
your unlocks keep working."* Buy buttons disabled; auto-renewal fails with the hold text (U10).

**U15 – Admin mode (impersonation).** Banner: *"Admin mode – you can look around, but buying is turned off. Use the
admin area to give honeycombs or unlocks."* The tab shows the user's **real** Premium status. No earning (as today,
`lib/routes_app.php:611`).

**U16 – Settings pills.** Once Premium can be bought, the lock pill *"Premium"* next to premium-only settings
(`editor.js:2733`) becomes a link *"Get Premium"* that opens the tab at the Premium card (`openShop('premium')`).
Before that, today's pill stays.

**U17 – Team actions.** An admin gives honeycombs, an unlock or a refund → exactly one bell notification (type
`honeycombs` or `unlock`). The bell poll shows it as a toast when the user is online (custom-dialogs §6.10). While the
user is away, it waits as an unread item in the bell. The next dashboard load does not repeat it.

### 2.2 Visitors

- **V1** Page of a user whose Premium ended: branding is visible again and the custom domain forwards to the
  OnYourSite address (premium-domains). A status page shows fewer checks (status-pages). Nothing is triggered by
  visitors; it follows from read-time checks and the reconcile of §4.4.

### 2.3 Admins (section "Honeycombs")

- **A1 Catalogue & prices:** table of all options. Per option: price, active, position, availability window, minimum
  account age, minimum active days. Add a duration variant (timed) or a pack size (count/consumable). A timed option
  can be switched on only after HC-7 (lifecycle job) and only when its feature is ready.
- **A2 Offers:** create *"Black Friday – 30 % off everything, Nov 27 00:00 – Dec 1 23:59, max 500 uses"*, or a
  fixed-price offer for one option (*"Premium 30 days for 100 – once per user, accounts at least 30 days old"*).
  Schedule in the future, cancel. Purchases keep the price they paid; refunded purchases still count towards the
  offer's limits.
- **A3 Earning rules:** today's form plus streak bonuses and the daily cap.
- **A4 Users & balances:** server-side search and paging; per user a detail view (balance, unlocks with end dates,
  purchases, ledger, audit). Give or take honeycombs with a note, for one user or for a list of up to 200 entries
  (emails, `#id`, `@name`). A list first shows a preview of who gets what, and nothing is booked before "Confirm".
  Give or remove an unlock (Premium for N days or for good, packs); freeze/unfreeze with a reason.
- **A5 Purchases:** filter by option, user, date, offer, refunded; refund with an amount up to the unused value and an
  explicit choice *"Also remove what was bought"*.
- **A6 Ledger:** filter by reason/user/date; reverse a gift or an earned entry (cheating) – never below 0.
- **A7 Codes:** create event codes (amount, window, max uses, minimum account age), see uses, disable.
- **A8 Overview:**
  - KPIs: in circulation, earned and spent (30 days), active Premium;
  - ending in 7 days, top options, earned by reason;
  - "Needs attention": watch list, accounts waiting for reconcile, mail outbox, job status.

### 2.4 Empty, error and limit states

| Where | State | Text / behaviour |
|---|---|---|
| Shop | load failed | `.panel.empty-state` "Couldn’t load your honeycombs – please reload." |
| Shop | nothing active | "Nothing to unlock right now – check back soon." |
| Shop | Premium not ready or not buyable | no Premium card; settings keep today's "Premium" lock pill |
| Shop | permanent option that is free right now (`code_more` at price 0) | no card (nothing to unlock) |
| Your unlocks | none | "Nothing unlocked yet. Pick something above." |
| Your unlocks | ended < 90 days ago | grey row "Ended on Nov 30 – paused, your content is kept" + "Renew" |
| Buy | lock busy (5 s) | "Honeycombs are busy right now – please try again in a moment." (existing text) |
| Buy | rate limit | 200 `{ok:false}` "Too many purchases in a short time – please wait a moment." (like `lib/routes_app.php:330`) |
| Buy | request id already used for another item or a refunded purchase | 409 "This request was already used. Please reload and try again." |
| Buy | option inactive / outside its window | "This isn’t available right now." |
| Buy | account too young / too few active days | "This is available once your account is 30 days old." / "… once you’ve been active on 10 days." |
| Buy | timed, > 400 days ahead | "You already have Premium until Feb 3, 2027. You can extend it again later." |
| Buy | requires feature | "Needs your code page first." |
| Buy | all packs active | "You already have 2 packs – you can extend one instead." |
| Code tab | old editor script without request id | 409 `{"reload":true}` "OnYourSite was updated – please reload the editor." |
| Earn list | reward switched off (0) | rule hidden (as `editor.js:2122`) |
| Earn | daily cap reached | rule text "Daily limit reached – the rest arrives tomorrow" |
| Banner | ended | grey, "Renew" + "Dismiss" (per end date) |
| Admin | lists empty | "No purchases yet.", "No offers yet.", "No codes yet.", "Nothing found." |
| Admin | bulk list | preview shows "Not found: x, y" and "Not clear: 1234 – use #id, @name or an email" |
| Admin | job stale (> 1 h) | red line in Overview: "The background jobs haven’t run since 14:05 – check `systemctl status onyoursite-jobs.timer`." |
| Admin | reconcile waiting > 1 h | amber line "3 accounts are waiting to be updated (oldest since 14:05): <last error>" |

---

## 3. Data model

### 3.1 Principles

1. `honeycomb_ledger` is **append-only**: no UPDATE or DELETE except deleting a user (as today,
   `oys_code_delete_user`). Corrections are new entries (`reversal`, `refund`, `revoke`).
2. **Every change of what a user owns writes a ledger row** in the same transaction as the entitlement: `unlock`
   (permanent, bought or granted), `purchase` (timed, count, consumable), `grant`, `revoke`, `refund`. Rows of 0
   honeycombs are normal ("free" in the history, as today's free unlock).
3. Every negative entry and every entitlement change happens inside `withAccount(uid)` (§4.2). Positive idempotent
   entries without a cap may run without it, because they cannot make a balance negative.
4. Idempotency comes from unique keys: ledger `(user_id, reason, ref)`, purchases `(user_id, request_id)`, offers
   `(created_by, form_ref)`, mail outbox `(user_id, ref)`. Bell notifications have no unique key (custom-dialogs §5.2);
   they are written in the transaction of the state change they report, so a rerun or a crash can neither repeat nor
   lose them.
5. All `DATETIME` values are wall-clock time in `config.timezone` written by the app (`date('Y-m-d H:i:s')`), like every
   other table. Durations add calendar days (`strtotime('+30 days')` semantics from `app/src/php.ts`).
6. "For good" is always the explicit flag `permanent = 1`, never `expires_at IS NULL`. SQL arithmetic on a NULL date
   gives NULL, so a NULL can never turn into "for ever" by accident.
7. Read-time checks compare with "now" from the app; the job only performs side effects.

### 3.2 Migration steps of v1

Each PR adds **the next free `schema_version`** at merge time. Version numbers are shared by six features. Every step
is idempotent (`CREATE TABLE IF NOT EXISTS`, `addColumn`, new helper `addIndex`), so the merge order does not matter.
`OPTS` = `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci` (`app/src/schema.ts:15`).

New helper in `schema.ts` next to `addColumn` (`:78`):

```ts
// Index nur anlegen, wenn es ihn noch nicht gibt
async function addIndex(conn: PoolConnection, table: string, name: string, definition: string): Promise<void> {
  const r = await rows(conn, `SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [name]);
  if (!r.length) await run(conn, `ALTER TABLE \`${table}\` ADD ${definition}`);
}
```

**HC-2 step `createShopCore(conn)`:**

```sql
-- Wer eine Buchung ausgelöst hat (Admin-ID); NULL = Nutzer oder System
ALTER TABLE honeycomb_ledger ADD COLUMN actor_id INT NULL;                          -- addColumn
ALTER TABLE honeycomb_ledger ADD KEY idx_reason_time (reason, created_at);          -- addIndex
ALTER TABLE honeycomb_ledger ADD KEY idx_time (created_at);                         -- addIndex

-- Premium-Status, den andere Bereiche in SQL verknüpfen (premium-domains):
-- NULL = kein Premium, Datum = Premium bis dahin, '9999-12-31 23:59:59' = dauerhaft (nie NULL)
ALTER TABLE users ADD COLUMN premium_until DATETIME NULL;                           -- addColumn
ALTER TABLE users ADD KEY idx_premium_until (premium_until);                        -- addIndex

-- Eine Zeile je Nutzer: Sperrzeile für Buchungen, Sperre durch das Team, ausstehender Abgleich
CREATE TABLE IF NOT EXISTS hc_accounts (
    user_id INT NOT NULL PRIMARY KEY,
    mail_reminders TINYINT(1) NOT NULL DEFAULT 1,
    frozen_at DATETIME NULL,
    frozen_reason VARCHAR(200) NULL,
    reconcile_at DATETIME NULL,                      -- seit wann ein Abgleich mit anderen Bereichen aussteht
    reconcile_gen INT UNSIGNED NOT NULL DEFAULT 0,   -- zählt jede Änderung; Merker wird nur beim gleichen Stand gelöscht
    reconcile_tries SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    reconcile_error VARCHAR(200) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    KEY idx_reconcile (reconcile_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Was ein Nutzer besitzt: je Funktion eine Zeile, bei stapelbaren Zeitpaketen eine Zeile je Paket (lot)
CREATE TABLE IF NOT EXISTS hc_entitlements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    feature VARCHAR(40) NOT NULL,
    lot TINYINT UNSIGNED NOT NULL DEFAULT 0,         -- 0 … stack−1 bei stapelbaren Zeitpaketen, sonst 0
    quantity INT UNSIGNED NOT NULL DEFAULT 1,        -- 0 = entzogen; Pässe/Pakete: Anzahl
    permanent TINYINT(1) NOT NULL DEFAULT 0,         -- 1 = dauerhaft (nie über expires_at IS NULL ausgedrückt)
    expires_at DATETIME NULL,                        -- Ende bei zeitlich begrenzten; NULL ohne permanent = nicht aktiv
    source VARCHAR(10) NOT NULL DEFAULT 'purchase',  -- purchase | admin | legacy
    auto_renew TINYINT(1) NOT NULL DEFAULT 0,
    renew_item VARCHAR(40) NULL,
    renew_max_price INT UNSIGNED NULL,               -- höchstens so viel wird automatisch bezahlt (vom Nutzer bestätigt)
    renew_seq INT UNSIGNED NOT NULL DEFAULT 0,       -- Zähler für die Anfrage-ID der automatischen Verlängerung
    reminded TINYINT UNSIGNED NOT NULL DEFAULT 0,    -- 0 keine, 1 = 7 Tage, 2 = 3 Tage, 3 = 1 Tag
    renew_failed_at DATETIME NULL,
    renew_notified_for DATETIME NULL,                -- für dieses Ende wurde ein Verlängerungsfehler schon gemeldet
    renew_notified_kind VARCHAR(10) NOT NULL DEFAULT '',  -- balance | price | gone | hold
    expiry_done_at DATETIME NULL,                    -- Ende verarbeitet (Nutzer informiert, Abgleich angestoßen)
    note VARCHAR(200) NOT NULL DEFAULT '',
    granted_by INT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uq_feature (user_id, feature, lot),
    KEY idx_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Jede Admin-Aktion rund um Honigwaben (wer, was, wann) – details nur mit IDs, Beträgen und Schlüsseln
CREATE TABLE IF NOT EXISTS hc_audit (
    id INT AUTO_INCREMENT PRIMARY KEY,
    admin_id INT NOT NULL,
    action VARCHAR(30) NOT NULL,
    user_id INT NULL,
    target VARCHAR(80) NOT NULL DEFAULT '',          -- z. B. item_key, Kauf-ID, Angebots-ID
    details TEXT NULL,                               -- JSON, z. B. {"old":350,"new":300} – keine Namen, keine Notizen
    created_at DATETIME NOT NULL,
    KEY idx_time (created_at),
    KEY idx_user (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**HC-3 step `createShopCatalogue(conn)`:**

```sql
-- Angebote im Shop: Funktion (Verhalten im Code) + Dauer/Menge + Preis (vom Admin)
CREATE TABLE IF NOT EXISTS hc_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    item_key VARCHAR(40) NOT NULL,                   -- z. B. premium_30, code_page
    feature VARCHAR(40) NOT NULL,                    -- z. B. premium
    days SMALLINT UNSIGNED NULL,                     -- nur zeitlich begrenzte Funktionen
    units SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    price INT UNSIGNED NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 0,
    position INT NOT NULL DEFAULT 0,
    available_from DATETIME NULL,                    -- limitierte Angebote
    available_until DATETIME NULL,
    min_account_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    min_active_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uq_item (item_key),
    KEY idx_feature (feature, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rabattaktionen mit Start und Ende
CREATE TABLE IF NOT EXISTS hc_offers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    label VARCHAR(60) NOT NULL,                      -- sehen die Nutzer, z. B. "Black Friday"
    scope VARCHAR(60) NOT NULL,                      -- all | feature:<key> | item:<item_key>
    percent_off TINYINT UNSIGNED NULL,               -- 1–100
    fixed_price INT UNSIGNED NULL,                   -- nur bei item:<key>
    starts_at DATETIME NOT NULL,
    ends_at DATETIME NOT NULL,
    max_uses INT UNSIGNED NULL,
    uses INT UNSIGNED NOT NULL DEFAULT 0,            -- wird bei Erstattungen nicht verringert
    per_user_max SMALLINT UNSIGNED NULL,             -- zählt auch erstattete Käufe
    min_account_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    min_active_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    cancelled_at DATETIME NULL,
    form_ref CHAR(16) NULL,
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uq_form (created_by, form_ref),
    KEY idx_window (ends_at, starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Jeder Kauf, unveränderlich bis auf die Erstattung (und das Verschieben späterer Zeiträume bei einer Erstattung)
CREATE TABLE IF NOT EXISTS hc_purchases (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    request_id VARCHAR(40) NOT NULL,                 -- Browser: 32 hex; Job: auto-<Berechtigung>-<Zähler>
    item_key VARCHAR(40) NOT NULL,
    feature VARCHAR(40) NOT NULL,
    lot TINYINT UNSIGNED NOT NULL DEFAULT 0,
    units SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    days SMALLINT UNSIGNED NULL,
    list_price INT UNSIGNED NOT NULL,
    price INT UNSIGNED NOT NULL,
    offer_id INT NULL,
    ledger_id INT NOT NULL,
    via VARCHAR(10) NOT NULL DEFAULT 'shop',         -- shop | code | status | auto
    period_start DATETIME NULL,
    period_end DATETIME NULL,
    refunded_at DATETIME NULL,
    refund_amount INT UNSIGNED NULL,
    refund_units SMALLINT UNSIGNED NULL,             -- zurückgenommene Pässe/Pakete
    refund_cut_sec INT UNSIGNED NULL,                -- um so viele Sekunden verkürzt
    refund_removed TINYINT(1) NULL,
    refunded_by INT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uq_request (user_id, request_id),
    KEY idx_user (user_id, id),
    KEY idx_lot (user_id, feature, lot, period_start),
    KEY idx_item_time (item_key, created_at),
    KEY idx_offer (offer_id, user_id),
    KEY idx_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**HC-7 step `createShopMail(conn)`:**

```sql
-- Mails des Honigwaben-Jobs: in derselben Transaktion wie die Glocke geschrieben, danach in Ruhe verschickt
CREATE TABLE IF NOT EXISTS hc_mail_outbox (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    template VARCHAR(40) NOT NULL,                   -- unlock_reminder
    ref VARCHAR(80) NOT NULL,                        -- z. B. rem2:<Berechtigung>:<Ende als Unixzeit> – nie doppelt
    subject VARCHAR(200) NOT NULL,
    vars TEXT NOT NULL,                              -- JSON mit Rohwerten; beim Senden mit e() escaped
    created_at DATETIME NOT NULL,
    sent_at DATETIME NULL,
    tries TINYINT UNSIGNED NOT NULL DEFAULT 0,
    last_error VARCHAR(200) NOT NULL DEFAULT '',
    UNIQUE KEY uq_ref (user_id, ref),
    KEY idx_pending (sent_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**HC-8 step `addStreaks(conn)`:**

```sql
ALTER TABLE hc_accounts ADD COLUMN streak SMALLINT UNSIGNED NOT NULL DEFAULT 0;      -- addColumn
ALTER TABLE hc_accounts ADD COLUMN streak_day DATE NULL;                             -- addColumn
ALTER TABLE hc_accounts ADD COLUMN best_streak SMALLINT UNSIGNED NOT NULL DEFAULT 0; -- addColumn
```

**HC-9 step `createEventCodes(conn)`:**

```sql
CREATE TABLE IF NOT EXISTS hc_codes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(32) NOT NULL,                       -- Großbuchstaben, Ziffern, Bindestrich
    amount INT UNSIGNED NOT NULL,
    note VARCHAR(150) NOT NULL DEFAULT '',           -- erscheint im Verlauf
    starts_at DATETIME NULL,
    ends_at DATETIME NULL,
    max_uses INT UNSIGNED NULL,
    uses INT UNSIGNED NOT NULL DEFAULT 0,
    min_account_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    disabled_at DATETIME NULL,
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uq_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 3.3 Later migration steps (only after the owner approves the item, §9.2)

**L1 referrals:**

```sql
ALTER TABLE hc_accounts ADD COLUMN referral_code CHAR(8) NULL;                       -- addColumn
ALTER TABLE hc_accounts ADD UNIQUE KEY uq_referral (referral_code);                  -- addIndex
CREATE TABLE IF NOT EXISTS hc_referrals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    referrer_id INT NOT NULL,
    referred_id INT NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending',   -- pending | review | paid | rejected | expired
    flags VARCHAR(60) NOT NULL DEFAULT '',           -- same_network, over_cap
    email_confirmed_at DATETIME NULL,                -- Link aus der Bestätigungs-Mail geklickt
    created_at DATETIME NOT NULL,
    qualified_at DATETIME NULL,
    decided_at DATETIME NULL,
    decided_by INT NULL,
    UNIQUE KEY uq_referred (referred_id),
    KEY idx_referrer (referrer_id, status),
    KEY idx_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Netz-Schlüssel beider Konten je Tag – nur solange die Einladung offen ist, danach gelöscht
CREATE TABLE IF NOT EXISTS hc_referral_keys (
    referral_id INT NOT NULL,
    day DATE NOT NULL,                               -- Ortszeit
    who CHAR(1) NOT NULL,                            -- i = einladendes Konto, f = eingeladenes Konto
    day_key CHAR(16) NOT NULL,
    PRIMARY KEY (referral_id, day, who, day_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**L2 visitor milestones:**

```sql
-- Besucher je Seite und Tag: nur ein täglich wechselnder Schlüssel (Ortszeit), keine IP; nach 2 Tagen gelöscht
CREATE TABLE IF NOT EXISTS stats_visitors (
    page_id INT UNSIGNED NOT NULL,
    day DATE NOT NULL,
    day_key CHAR(16) NOT NULL,
    PRIMARY KEY (page_id, day, day_key),
    KEY idx_day (day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE stats_daily ADD COLUMN visitors INT UNSIGNED NOT NULL DEFAULT 0;       -- addColumn
```

`day_key = hmac('hc-day|' + date('Y-m-d') + '|' + ipNet).slice(0, 16)` with the **local** date and the same IP
normalisation as `clientKey` (IPv6 per /64). It changes at local midnight, unlike `clientKey`, which changes at UTC
midnight (`app/src/web/security.ts:40`). New helper `dayKey(ctx)` in `app/src/web/security.ts`.

### 3.4 Existing data

Run in the HC-2 / HC-3 steps (`now` = app time):

```sql
-- Konten für alle Nutzer
INSERT IGNORE INTO hc_accounts (user_id, created_at, updated_at) SELECT id, ?, ? FROM users;

-- Alle bisherigen Freischaltungen werden dauerhafte Berechtigungen: code_page und alles, was andere Bereiche schon
-- als unlock/<Funktion> gebucht haben (z. B. code_more, status_page, falls deren PR vor diesem lief)
INSERT IGNORE INTO hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, note, created_at, updated_at)
SELECT l.user_id, l.ref, 0, 1, 1, NULL, IF(l.amount = 0, 'admin', 'legacy'), '', l.created_at, l.created_at
FROM honeycomb_ledger l WHERE l.reason = 'unlock' AND l.ref REGEXP '^[a-z][a-z0-9_]{1,39}$';

-- Sicherheitsnetz: wer schon eine Code-Seite hat, behält sie
INSERT IGNORE INTO hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, note, created_at, updated_at)
SELECT s.user_id, 'code_page', 0, 1, 1, NULL, 'legacy', '', COALESCE(s.created_at, ?), ? FROM code_sites s;

-- Admin-Gutschriften: Admin aus dem Bezug a<id>-<16 hex> übernehmen
UPDATE honeycomb_ledger SET actor_id = CAST(SUBSTRING_INDEX(SUBSTRING(ref, 2), '-', 1) AS UNSIGNED)
WHERE reason = 'admin' AND actor_id IS NULL AND ref REGEXP '^a[0-9]+-[0-9a-f]{16}$';
```

- `users.premium_until` stays NULL for everybody: nobody has bought Premium yet, and admins have it through `is_admin`.
- The backfill only sees rows that exist when the step runs. Two kinds of later rows are covered by the read
  fallback of `has()` (§4.4): rows written by the old process between `migrate` and the restart (plan §5.2), and rows
  written by PHP after a rollback. The nightly job also writes the missing entitlements (same `INSERT IGNORE … SELECT`).
- HC-3 seeds `hc_items` from the registered features with `INSERT IGNORE` (§3.6). The `code_page` price is taken from
  `oys_meta['honeycombs'].code_page`, so an admin's custom price is kept. If code-slots-admin's fallback already
  added `code_more` to that JSON (code-slots-admin.md §3.3), that price is taken too.
- Old ledger rows stay untouched; `describe()` keeps the old texts (`unlock/code_page` → "Unlocked your code page").
- Nothing breaks for existing users: unlocked code pages stay unlocked, balances are unchanged, the old `views` rule
  keeps counting from where it is.
- HC-8 back-fills streaks: it reads `reason='daily'` entries of the last 60 days (`ref` is `Y-m-d`), counts the
  consecutive days that end today or yesterday per user, and writes `streak`, `streak_day` and `best_streak`. Users
  keep their current run.

### 3.5 `oys_meta` keys

**`honeycombs`** (plain JSON, same parser as today: a key counts only if `is_numeric`, value clamped, missing keys use
defaults – `port/hc:app/src/honeycombs/honeycombs.ts:54-65`). Old shape:

```json
{"daily":5,"profile":20,"views":10,"views_step":100,"code_page":100}
```

New shape in v1 (all integers):

```json
{"daily":5,"profile":20,"views":10,"views_step":100,"code_page":100,"streak_week":15,"streak_month":50,"daily_cap":300}
```

- Ranges: rewards 0–100000 (0 = off), `views_step` ≥ 1, `daily_cap` 50–100000.
- `code_page` is no longer read by Node after HC-3; prices live in `hc_items`. Saving the `code_page` item's price
  also writes it here, so a PHP rollback shows and charges the same price (`lib/routes_app.php:258,277`).
- The save keeps unknown keys, so later keys (`visitors_*`, `anniversary`, `referral_*`) can be added by later PRs.

**`hc_jobs`** (written by the job, read by the admin overview):

```json
{"tick_at":"2026-11-02 14:15:03","nightly_day":"2026-11-02","last_error":"","renewed":2,"expired":1,"reminded":4,
 "reconciled":3,"reconcile_waiting":0,"mails_sent":4,"mails_pending":0}
```

**`hc_watch`** (nightly scan, shown under "Needs attention"; at most 50 items, an item stays 7 days):

```json
{"at":"2026-11-02 04:02:10","items":[{"user":12,"kind":"views_spike","detail":"Page “mia” had 2,400 views on Nov 1 (usual: 35)"},
 {"user":40,"kind":"big_grant","detail":"+5,000 honeycombs by admin #1 on Nov 1"}]}
```

| Kind | Rule (all on yesterday, local time) |
|---|---|
| `views_spike` | a page with ≥ 1,000 views and ≥ 20 × its median daily views of the 28 days before (median counted as at least 5) |
| `code_burst` | an event code redeemed ≥ 100 times within its first hour |
| `big_grant` | an admin grant, refund or reversal of ≥ 5,000 honeycombs (visible to all admins) |
| `fast_spender` | an account younger than 7 days that spent ≥ 300 honeycombs |
| `integrity` | a balance below 0, a purchase whose `ledger_id` is missing, an offer with `uses > max_uses`, a `source='purchase'` entitlement without a purchase, `users.premium_until` that does not match the `premium` entitlement |

New `integrity` items also go to every admin's bell: `notifyAdmins('team', 'Honeycomb check found a problem', detail,
'/admin#honeycombs', {db})`. This is written in the same transaction as the new `hc_watch` value, and only for items
that were not in the previous list, so each problem is announced once.

### 3.6 Feature registry and default catalogue

Behaviour lives in code (`app/src/honeycombs/features.ts`). Each owner registers its features in its own module and
PR. The shop registers only `premium`.

```ts
export type FeatureKind = 'permanent' | 'timed' | 'count' | 'consumable';
export interface FeatureItem { days?: number; units?: number; price: number; active: boolean;
  minAccountDays?: number; minActiveDays?: number }
export interface BuyCheck { uid: number; user: Row; db: Db; item: ItemRow; input: { terms?: boolean } }
export interface Feature {
  key: string;                  // z. B. 'premium', 'code_page' – bei dauerhaften Freischaltungen auch der Ledger-Bezug
  owner: string;                // Design, dem die Funktion gehört (Anzeige im Admin)
  title: string; icon: string; description: string;
  kind: FeatureKind;
  stack?: number;               // timed: so viele Pakete gleichzeitig (Standard 1)
  max?: number;                 // count/consumable: höchste Anzahl
  maxAheadDays?: number;        // timed: höchstens so weit im Voraus (Standard 400)
  minAccountDaysFloor?: number; // untere Grenze für min_account_days der Optionen und Angebote (Premium: 30)
  requires?: string;            // muss aktiv sein, z. B. 'code_page'
  freeAtZero?: boolean;         // permanent: Preis 0 = für alle frei – keine Karte, kein Kauf (code_more)
  ready?: () => boolean;        // false: nicht zeigen, nicht verkaufen, nicht vergeben
  includedFor?: (user: Row) => boolean;            // z. B. Premium für Admins
  needsTerms?: (user: Row) => boolean;             // Kaufdialog zeigt die Regeln-Checkbox
  canBuy?: (c: BuyCheck) => Promise<string | null>; // eigene Regeln (Sperre, Grenzen, Regeln akzeptieren) – nur über c.db
  items: Record<string, FeatureItem>;              // Standard-Optionen, per INSERT IGNORE angelegt
  href?: string;                // Ziel nach dem Kauf, z. B. '#code'
}
export function registerFeature(f: Feature): void;
export function registerPerk(feature: 'premium', perk: { owner: string; text: string; ready: () => boolean }): void;
export function registerLossPreview(feature: string, fn: (uid: number, db: Db) => Promise<string[]>): void;
export const LIFECYCLE_READY: boolean;   // false bis HC-7: zeitlich begrenzte Optionen lassen sich nicht einschalten
```

`seedItems()` runs in `cli.js migrate` after the schema steps and writes `INSERT IGNORE INTO hc_items` for every
registered default option. It never overwrites what an admin changed. An option whose feature is not registered in
code is never shown or sold.

**v1 catalogue** (defaults; the admin changes everything in "Catalogue & prices"). Calibration: a user who opens the
editor every day earns about 260 a month (30 × 5 daily + 4 × 15 + 50 streak bonuses).

| Feature | Registered by | Kind and rules | Options → default price | Effect while active | When it ends / is revoked (data kept) | Can be on sale from |
|---|---|---|---|---|---|---|
| `premium` | this design (`honeycombs/premium.ts`); perks from premium-domains and, if Q3 = yes, status-pages | timed, stack 1, ≤ 400 days ahead, accounts ≥ 30 days and ≥ 10 active days | `premium_30` 350 · `premium_90` 900 | the registered perks (custom domain per link page, no "Made with OnYourSite", status-page Premium limits) | perks stop at once; the domain forwards for 30 days, then the hostname is released (premium-domains); `hide_branding` stays saved; status checks above the free limit pause | premium-domains PR 1 (ready) **and** HC-7; until then nothing is shown or sold |
| `code_page` | code-slots-admin (`app/src/code/shop.ts`, created by HC-3 with today's terms rule) | permanent | `code_page` = today's price (100) | the code page module | code pages go offline, files kept (code-slots-admin §9.2) | HC-3 |
| `code_more` | code-slots-admin | permanent, requires `code_page`, `freeAtZero` | `code_more` 0 | more code pages within code-slots-admin's limits | creating new ones is refused; existing pages stay (code-slots-admin §9.2) | code-slots-admin PR 4; a card appears only when an admin sets a price |
| `status_page` | status-pages (their PR 4) | permanent; included for admins | `status_page` 150 | the status page module | the page goes offline, data kept (status-pages §4.10) | status-pages PR 4 |
| `status_more_checks` | status-pages | timed 30 days, stack 2 ("stackable once", status-pages §4.10) | `status_more_checks_30` 60 | +10 checks per pack | checks above the limit pause (read time, status-pages) | status-pages PR 7 + HC-7 |
| `status_fast_checks` | status-pages | timed 30 days | `status_fast_checks_30` 80 | 1-minute interval | intervals stretched (status-pages) | status-pages PR 7 + HC-7 |

No 7-day Premium at launch. An admin can add one later; it inherits the 30-day account-age floor.

**Proposed later** (only with the owner's approval, Q8; not built in v1):

| Feature | Kind | Option → price | Effect | Precondition |
|---|---|---|---|---|
| `theme_honey`, `fx_bees`, `ring_gold` | permanent | 80 / 60 / 50 | new theme "Honey", particles "Bees", avatar ring "Gold" | server-side gating in `themeKey`/`settingsNormalize`; existing themes stay free |
| `address_pass` | consumable, max 3 | `address_pass` 40 | one address change during the 30-day cooldown (link pages and code pages on page addresses) | coordinated with code-slots-admin's `code-address` route |
| `storage_step` | count, max 2, permanent | `storage_step_x1` 200 | +250 MB upload quota for good | the nightly disk report (total upload bytes and the 10 largest accounts in the overview) ships first |

Option keys follow `^[a-z][a-z0-9_]{1,39}$`: permanent → the feature key, timed → `<feature>_<days>`, count and
consumable → `<feature>_x<units>`. Option labels are generated: timed → "30 days", count → "+1" / "+3", consumable →
"1 pass", permanent → "Unlock". Admins can add variants: timed 1–365 days, count/consumable 1–10 units.

### 3.7 Ledger reasons

| Reason | Sign | `ref` (unique per user) | `note` | User text (`describe()`) |
|---|---|---|---|---|
| `daily`, `profile`, `views`, `admin` | as today | as today | as today | unchanged (`lib/honeycombs.php:74-89`) |
| `unlock` | − price or 0 | `<feature>` for the first unlock of a feature; `<feature>:<n>` (n = 2, 3, …) when it is unlocked again after a refund or revoke | option title or admin note | `code_page` → "Unlocked your code page" (today's text); `code_more` → "Unlocked more code pages" (code-slots-admin §9.2); others → "Unlocked <title>" |
| `purchase` | − (or 0) | request id (32 hex, or `auto-<entitlementId>-<n>`) | option title | "Bought Premium · 30 days" / "Renewed Premium · 30 days" |
| `grant` | 0 | `g<adminId>-<form_ref>` | admin note or the generated text | note or "Premium · 30 days from the team" |
| `revoke` | 0 | `v<adminId>-<form_ref>` | admin note | note or "Premium removed by the team" |
| `refund` | + or 0 | `p<purchaseId>` | admin note | note or "Refund: Premium · 30 days" |
| `reversal` | ∓ | `x<ledgerId>` | admin note | note or "Correction by the team" |
| `streak` | + | `w<Y-m-d>` / `m<Y-m-d>` | — | "7-day streak" / "30-day streak" |
| `code` | + | `c<codeId>` | code note | note or "Code redeemed" |
| later: `visitors`, `anniversary`, `referral`, `community` | + | `t<tier>`, `y<year>`, `u<referredId>` / `joined`, `s<suggestionId>` | — | "100 visitors reached", "1 year on OnYourSite", "A friend joined OnYourSite", "Your suggestion was accepted" |

`reason` stays `VARCHAR(20)`; `ref` ≤ 80 and `note` ≤ 200 as today (`mbSubstr` in `hcAdd`). After a PHP rollback, PHP
shows the new rows with its fallback text (note, or `ucfirst(reason)`, `lib/honeycombs.php:88`), and
`oys_code_unlocked()` keeps working because unlocks still write `unlock/code_page`.

### 3.8 Deleting a user

The admin "delete user" flow (`views/admin.php:91-113`, Node `admin/users.ts`) gets `hcDeleteUser(uid)` after
`codeDeleteUser`:

```sql
DELETE FROM hc_entitlements WHERE user_id = ?;
DELETE FROM hc_purchases WHERE user_id = ?;
DELETE FROM hc_mail_outbox WHERE user_id = ?;
DELETE FROM hc_accounts WHERE user_id = ?;
UPDATE hc_audit SET user_id = NULL WHERE user_id = ?;   -- Protokoll bleibt; details enthält nur IDs und Beträge
-- honeycomb_ledger: wie bisher von codeDeleteUser gelöscht; users.premium_until verschwindet mit der Zeile
```

Admin notes and freeze reasons live only in the ledger, purchase and account rows, which are deleted. The audit keeps
ids, amounts and keys, never names or notes.

---

## 4. Server

### 4.1 Module layout (`app/src/honeycombs/`)

| File | Content |
|---|---|
| `honeycombs.ts` | the port (`hcSettings`, `hcBalance`, `hcHas`, `hcAdd`, `hcHistory`, `hcDescribe`, `hcEarn`, `hcSpend`, `hcForEditor`, `adminHcHandle`). From HC-2 on, `hcLocked`/`hcSpend` run on `withAccount`, and `hcAdd(…, 'unlock', …)` goes through `grantUnlock`. `hcEarn` delegates to `earn.ts` from HC-8 on |
| `ledger.ts` | `withAccount`, `credit`, `debit`, `balanceIn`, `reverse` – the only writer of `honeycomb_ledger` |
| `features.ts` | registry (§3.6), perks, loss previews, `seedItems()` |
| `catalogue.ts` | `items()`, `quote()`, `shopPrice()` |
| `offers.ts` | active offers, validation, cancel |
| `entitlements.ts` | `entitlement()`, `has()`, `quantity()`, `grantUnlock()`, `setPeriod()`, `grantFeature()`, `revokeFeature()` |
| `reconcile.ts` | `registerEnforcer()`, `markReconcile()`, `reconcileNow()` |
| `premium.ts` | the `premium` feature, `isPremiumRow()`, `isPremium()` (aliases `premiumActive`, `userPremium`), `premiumUntil()`, `premiumState()` |
| `shop.ts` | `buy()`, `purchaseUnlock()`, `refund()`, `shopState()`, `setAutoRenew()` |
| `earn.ts` | `earnOnVisit()`, streak, daily cap (HC-8) |
| `codes.ts` | event codes (HC-9) |
| `jobs.ts` | the honeycomb job (§4.13) |
| `outbox.ts` | mail outbox (HC-7) |
| `editorApi.ts` | the editor actions (§4.10) |
| `admin.ts`, `adminView.ts` | admin actions (§4.12) and `adminHoneycombsTab()` (the section HTML) |

Shared: `app/src/jobs/registry.ts` (`registerJob()`, `registerNightly()`; the file custom-dialogs §5.7 proposes) and
`app/src/cli.ts` (`jobs:tick`), both created by HC-7 (§4.13). Tests in `app/test/hc-*.test.ts` and
`tests/e2e/hc-*.js`. Code comments German, identifiers and texts English, no new npm dependency.

### 4.2 Account lock, ledger and the connection rule (`ledger.ts`)

```ts
// Sperrt das Honigwaben-Konto eines Nutzers für eine Transaktion – gilt für alle Prozesse (Datenbank-Sperre).
// Hält genau eine Verbindung; fn arbeitet nur über db und holt keine zweite Verbindung aus dem Pool.
export async function withAccount<T>(uid: number, fn: (db: Db, acc: AccountRow) => Promise<T>,
  opts: { nowait?: boolean } = {}): Promise<T | typeof HC_BUSY> {
  return withConnection(async (db, conn) => {
    await db.exec('INSERT IGNORE INTO hc_accounts (user_id, created_at, updated_at) VALUES (?, ?, ?)', [uid, now(), now()]);
    for (let attempt = 1; ; attempt++) {
      await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');  // gilt nur für die nächste Transaktion
      await conn.beginTransaction();
      try {
        const acc = await db.one<AccountRow>(
          `SELECT * FROM hc_accounts WHERE user_id = ? FOR UPDATE ${opts.nowait ? 'NOWAIT' : 'WAIT 5'}`, [uid]);
        await pausePoint('account-locked');          // nur in Tests aktiv (§7.2)
        const out = await fn(db, acc!);
        await conn.commit();
        return out;
      } catch (err) {
        await conn.rollback().catch(() => undefined);
        if (errno(err) === 1205 || errno(err) === 3572) return HC_BUSY;   // Sperre nicht frei (WAIT/NOWAIT)
        if (errno(err) === 1213 && attempt === 1) continue;              // Deadlock: genau einmal neu versuchen
        throw err;
      }
    }
  });
}
```

- `READ COMMITTED` + lock first: the following `SELECT COALESCE(SUM(amount),0) …` sees every committed debit. All
  debits of this user hold the same lock; positive entries can only raise the balance.
- `fn` must not cause effects outside the database. Bell notifications are written through `db` inside the
  transaction (`notify(…, {db})`, custom-dialogs §5.2), and so are outbox mails. Enforcers and mail sending run after
  the connection is released. So the deadlock retry can safely run `fn` again.
- MariaDB answers both `WAIT n` and `NOWAIT` with error 1205 when the row stays locked (3572 is MySQL's code for
  `NOWAIT`; it is accepted too).
- **Never two account locks at once.** Later referral payouts lock only one account per transaction, so there are no
  deadlocks between accounts.
- **Connection rule:** code that holds a pool connection never asks the pool for a second one. Everything inside
  `withAccount` goes through `db`, including `canBuy()` of the owners, `notify()` and loss previews. Every read API
  of the shop takes an optional `db` (§4.4), so other features can call it inside their own locks. Enforcers run only
  after the caller's connection is released (§4.4). The pool has 10 connections and waits without a timeout
  (`app/src/db.ts:74`), so a second connection taken while holding one could deadlock the pool under load.
- `credit(db, uid, amount, reason, ref, note, actorId?)` / `debit(...)`: `INSERT IGNORE INTO honeycomb_ledger
  (user_id, amount, reason, ref, note, actor_id, created_at)`. They return `insertId`, or `null` when the row was
  already booked. `debit` asserts that it runs inside `withAccount`.
- `hcLocked()` and `hcSpend()` from the port are re-implemented on `withAccount` in HC-2, so **no**
  `GET_LOCK('oys_hc_…')` path remains next to the row lock (two lock types would not serialise each other).
  `HC_BUSY` keeps the existing text.
- MariaDB ≥ 10.3 is required for `FOR UPDATE WAIT n` / `NOWAIT` (Ubuntu 22.04: 10.6, 24.04: 10.11).

### 4.3 Quote and buy (`catalogue.ts`, `shop.ts`)

**`quote(db, item, uid, now)`**
1. `list = item.price`.
2. Candidate offers: `cancelled_at IS NULL AND starts_at <= now AND ends_at > now AND (max_uses IS NULL OR uses <
   max_uses)` with `scope` = `all`, `feature:<item.feature>` or `item:<item.item_key>`.
3. Skip an offer whose `per_user_max` is reached. The count includes refunded purchases (`SELECT COUNT(*) FROM
   hc_purchases WHERE user_id=? AND offer_id=?`), so a refunded trial cannot be taken again. Skip an offer whose
   `min_account_days`/`min_active_days` the user does not meet.
4. Offer price = `fixed_price` or `ceil(list × (100 − percent_off) / 100)`. The lowest price wins; on a tie the most
   specific scope wins (item > feature > all), then the lowest id. If no offer is cheaper than `list`, there is no
   offer.

**`buy(ctx, uid, itemKey, requestId, expectedPrice, opts)`** – the only way to spend (shop, code tab, status tab,
auto-renew). `opts = {via, autoRenew?, mode?: 'stack' | 'extend', terms?, renew?: {entId, seq, maxPrice}}`.
1. Outside the lock: `request_id` must match `^[0-9a-f]{32}$` (browser, code and status tabs) or
   `^auto-[0-9]{1,10}-[0-9]{1,6}$` (job). The option must exist, be active and inside `available_from/until`. Its
   feature must be registered and `ready()`, and for a timed feature `LIFECYCLE_READY` must be true. Otherwise *"This
   isn’t available right now."* A `freeAtZero` feature at price 0 answers *"Nothing to unlock – this is free right
   now."*
2. `withAccount(uid, …)`:
   1. **Replay:** `SELECT * FROM hc_purchases WHERE user_id=? AND request_id=?`. Same `item_key` and `refunded_at IS
      NULL` → return it as success, with no second charge. Otherwise → HTTP 409 `{ok:false, code:'request_used',
      error:'This request was already used. Please reload and try again.'}`.
   2. `acc.frozen_at` → *"Your honeycombs are on hold. Please contact the team."*
   3. **Eligibility:** account age from `users.created_at` ≥ `max(item.min_account_days, feature.minAccountDaysFloor)`
      → else *"This is available once your account is N days old."*; active days (`SELECT COUNT(*) FROM
      honeycomb_ledger WHERE user_id=? AND reason='daily'`, served by `uq_entry`) ≥ `item.min_active_days` → else
      *"This is available once you’ve been active on N days."*
   4. `lots = SELECT * FROM hc_entitlements WHERE user_id=? AND feature=? FOR UPDATE`.
   5. **Auto-renew guard** (`via 'auto'` only): the lot still has `auto_renew = 1`, `renew_seq = opts.renew.seq` and
      `expires_at <= now + 24 h` → else stop without a charge. A manual extension in the meantime therefore never
      leads to a second automatic one.
   6. **Feature rules:**
      - included (admin + premium) → *"Premium is included with your admin account."*;
      - permanent and owned → *"You already own this."* (`purchaseUnlock` turns this into success);
      - Premium for good → *"You have Premium for good – no need to buy it."*;
      - count/consumable `quantity + units > max` → *"You already have the maximum (N)."*;
      - timed: pick the lot (below); new end − now > 400 days → *"You already have Premium until <date>. You can
        extend it again later."*;
      - `requires` not active → *"Needs your <title> first."*;
      - `canBuy()` of the owner (terms, ban, limits), always with `db`.
   7. `{price, offer} = quote(...)`. `expectedPrice` given and different → `{ok:false, code:'price_changed', price,
      error:'The price changed – this now costs <price> honeycombs.'}`. For `via 'auto'`: `price >
      opts.renew.maxPrice` → stop with `code:'price_above_max'` (no charge, §4.13).
   8. `balance = SUM(amount)`; `balance < price` → *"You need <price> honeycombs – you have <balance>."* (today's
      text, `lib/honeycombs.php:154`).
   9. Offer: `UPDATE hc_offers SET uses = uses + 1 WHERE id=? AND cancelled_at IS NULL AND starts_at <= ? AND
      ends_at > ? AND (max_uses IS NULL OR uses < max_uses)`. 0 changed rows → `price_changed` with a fresh quote (the
      job treats it as a failed renewal and tries again later).
   10. **Ledger row:** permanent → `debit(uid, price, 'unlock', unlockRef(feature), title)`. `unlockRef` is the
       feature key if no `unlock/<feature>` row exists yet, otherwise `<feature>:<n>`, where n is one more than the
       number of such rows (counted under the lock). Everything else → `debit(uid, price, 'purchase', requestId,
       title)`.
   11. **Lot and period** (timed): stack 1 → lot 0. Stack > 1: `mode 'stack'` (default while a lot is free) takes the
       lowest lot that is not active; `mode 'extend'` (or no free lot) takes the active lot that ends first. `start =
       max(now, lot.expires_at if active)`, `end = start + days`.
   12. `INSERT INTO hc_purchases (...)`.
   13. `applyPurchase()`:
       - timed → `setPeriod(lot, end)`, `renew_item = itemKey`; with `autoRenew` sent: `auto_renew` and
         `renew_max_price = item.price` (the regular price shown in the dialog); `via 'auto'` → `renew_seq + 1` and the
         success bell notification through `db` (§4.13);
       - count/consumable → `quantity = quantity + units`;
       - permanent → `grantUnlock` semantics (`quantity = 1, permanent = 1`);
       - `source = 'purchase'`;
       - `markReconcile(db, uid)`.
   14. The response notice: `{tone:'hc', amount:-100, text:'Code page unlocked'}` (custom-dialogs §5.4).
3. After commit: `reconcileNow(uid, {inlineOnly: true})` (§4.4; errors are logged, never shown to the buyer).
4. Return `{purchase, balance, entitlement, notices}`.

**Wrappers for the other designs** (code-slots-admin §9.2, status-pages §4.10):

```ts
// Heutige hcSpend-Semantik: null = erledigt (auch: schon freigeschaltet), sonst ein Fehlertext für die Oberfläche
export async function purchaseUnlock(ctx: Ctx | null, uid: number, feature: string,
  o: { requestId: string; expectedPrice: number; terms?: boolean; via: 'code' | 'status' | 'shop' }): Promise<string | null>;
// Aktueller Preis der einzigen Option einer dauerhaften Funktion (mit Angebot; mit uid auch je Nutzer)
export async function shopPrice(feature: string, uid?: number, db?: Db): Promise<number>;
```

`purchaseUnlock` resolves the single option of a permanent feature and calls `buy()`. *"You already own this."*
becomes `null`, `price_changed` becomes the text *"The price changed – this now costs N honeycombs."* (the tab reloads
its state), and `request_used` becomes its text. Callers that need the structured answer call `buy()` directly, as
code-slots-admin does.

### 4.4 Entitlements, Premium and reconcile (`entitlements.ts`, `premium.ts`, `reconcile.ts`)

**Reading** (every function takes an optional `db`; without it, one pool query at a time)
- `active(ent, now) = ent.quantity > 0 && (ent.permanent === 1 || (ent.expires_at !== null && ent.expires_at > now))`.
- `has(uid, feature, db?)`: any active lot. **Fallback** for permanent features: when no entitlement row exists at
  all, it checks the ledger row `unlock/<feature>`. This covers rows from the old process during a deploy and from
  PHP after a rollback. The nightly job then writes the missing entitlement. A refunded or revoked unlock keeps its
  entitlement row (quantity 0), so the fallback never revives it. Reads never write.
- `quantity(uid, feature, db?)`: sum of `quantity` over active lots (0 when none).
- `entitlement(uid, feature, db?) → {active, until, quantity, permanent, lots}`: `until` = the earliest end of an
  active lot (the interface status-pages asks for).

**Writing** (all inside `withAccount`, all through `db`)
- `grantUnlock(db, uid, feature, amount, note, actorId)`: ledger row `unlock/<unlockRef>` (amount −price or 0) and an
  upsert of the entitlement (`quantity = 1, permanent = 1, expires_at = NULL`), plus `markReconcile`. It is used by
  `buy()` for permanent features, by `hcSpend()`, by `grantFeature()` for permanent features, and by `hcAdd()` when
  `reason === 'unlock'`. That last route catches every caller that still books `hcAdd(uid, 0, 'unlock', item)`, such as
  code-slots-admin's pre-shop fallback (their §4.6). When `hcAdd` gets the pool instead of a transaction, it opens
  `withAccount` itself.
- `setPeriod(db, lot, change)` is the **single writer** of timed state. Purchases, renewals, grants, refunds and
  revokes all go through it.
  - It sets `expires_at` / `permanent` / `quantity`.
  - It resets `reminded = stage(new end)`, `renew_failed_at = NULL`, and `expiry_done_at = NULL` when the lot is
    active again.
  - On refund and revoke it sets `auto_renew = 0, renew_item = NULL, renew_max_price = NULL`.
  - For `premium` it mirrors `users.premium_until` in the same transaction: active and permanent →
    `'9999-12-31 23:59:59'`, active → `expires_at`, otherwise → NULL. Nothing ever adds days to the far-future value;
    buying or granting days on a "for good" Premium is refused.
  - It calls `markReconcile(db, uid)`.
- `grantFeature(adminId, uid, feature, {days | permanent | units}, note, formRef)` and `revokeFeature(adminId, uid,
  feature, lot | 'all', note, formRef)` (§4.5).
- `consume(db, uid, feature)` for later consumables: `UPDATE … SET quantity = quantity - 1 WHERE user_id=? AND
  feature=? AND quantity > 0`, in the caller's transaction.

**Premium** (`premium.ts`; premium-domains §3.5)
- `isPremiumRow(user, now?) = is_admin || premium_until > now` (works on any loaded user row, no query).
- `isPremium(uid, db?)` (also exported as `premiumActive` for code-slots-admin and `userPremium` for status-pages),
  `premiumUntil(uid, db?)`, `premiumState(uid, db?) → {active, until, forever, source}` with `source` ∈ `admin-role`,
  `purchase`, `admin` (granted), `null`.
- All of these read the database, never the session. An admin acting as a user therefore sees the user's real status.
- `isStaff()` (today's `hasPremium()`: `is_admin || original_admin_id`, `app/src/app/context.ts:15`) keeps the page
  limit, the upload quota and the address cooldown, also for code pages on page addresses. premium-domains PR 1 does
  the rename. This design reads neither.
- **Editor bootstrap:**
  - HC-2 adds `E.premiumUntil` (`'Y-m-d H:i:s'` or `null`) and `E.premiumForever` (boolean). Both are additive.
  - `E.premium` stays a boolean. premium-domains PR 1 switches it to `isPremiumRow(user)` together with `E.staff`. If
    HC-2 switched it alone, the editor's page-limit and cooldown checks (`editor.js:593,694,2716,2768`) would treat
    impersonating admins as normal users until `E.staff` exists.
- **Rollout flag:** the `premium` feature has `ready = () => premiumPerks().some(p => p.owner === 'premium-domains'
  && p.ready())`. premium-domains PR 1 registers the branding perk and makes it ready. Other perks, such as
  status-pages' (registered with `ready: () => true`), only add lines to the card and never make Premium ready on
  their own. While not ready, Premium is hidden everywhere:
  - no shop card;
  - not in the admin's feature list, so no grant and no revoke;
  - no "Get Premium" links;
  - its options cannot be switched on.

  Before `LIFECYCLE_READY` (HC-7), Premium can only be granted **for good**, so nothing timed can end before reminders
  and expiry processing exist.

**Reconcile** (contract for code-slots-admin, premium-domains and status-pages)
- `registerEnforcer({name, features: string[] | '*', inline: boolean, run: (uid) => Promise<void>})`. An enforcer is a
  **reconcile function**, never a blind "pause" or "resume". It reads the current state (entitlements,
  `users.premium_until`, `is_admin`) under **its own** per-user lock and makes its objects match: domains, code
  pages, and so on. It holds at most one pool connection at a time and is never called while the caller holds one.
  It is idempotent. `inline: false` marks slow enforcers (Cloudflare calls); they run only from the job.
- `markReconcile(db, uid)` runs **in the same transaction as every change**: `UPDATE hc_accounts SET reconcile_at =
  COALESCE(reconcile_at, ?), reconcile_gen = reconcile_gen + 1 WHERE user_id = ?`. Callers:
  - every `setPeriod` and `grantUnlock`;
  - refunds and revokes;
  - expiry processing;
  - the admin role toggle (`views/admin.php:116-129`; the Node admin port writes `UPDATE users SET is_admin` and
    `markReconcile` in one transaction).
- `reconcileNow(uid, {inlineOnly})`:
  1. Read `reconcile_gen`.
  2. Run the matching enforcers one after another, each in `try/catch`.
  3. If all succeeded and no job-only enforcer was skipped: `UPDATE hc_accounts SET reconcile_at = NULL,
     reconcile_tries = 0, reconcile_error = '' WHERE user_id = ? AND reconcile_gen = ?`.
  4. Otherwise `reconcile_tries + 1` and the first error text are stored.

  A change that happens during the run raises `reconcile_gen`, so the marker stays and the next run picks it up.
- The request runs the inline enforcers once after its commit. The job (§4.13) runs **all** enforcers for every
  marked account. A restart between commit and enforcer, a busy enforcer lock or a Cloudflare error therefore delays
  the reconcile but never loses it. The marker is durable, and the job always reads the final state.
- Who registers:
  - premium-domains: `onPremiumChanged` for `premium` (their 5-minute job stays as an extra safety net);
  - code-slots-admin: `enforceSlots` for `code_page`, `code_more` and `premium` (their §9.2);
  - status-pages: `refreshStatusLimits` (inline). It computes limits at read time and only clears its cache, so it
    holds no state that could go wrong (their §4.10).

### 4.5 Refund, reversal, grants, freeze (`shop.ts`, `ledger.ts`, `admin.ts`)

**Refund** `refund(adminId, purchaseId, amount, remove, note)` under the buyer's `withAccount`:
1. The purchase exists and `refunded_at IS NULL` (else *"This purchase was already refunded."*).
2. **Refundable value:**
   - permanent and count → `price`;
   - consumable → `floor(price × u / units)` with `u = min(units, current quantity)`; used passes are not refunded;
   - timed → `ceil(price × unusedSec / periodSec)` with `unusedSec = max(0, period_end − max(now, period_start))`.
     It is 0 when the period is over. For a period that has not started yet, it is the whole period.
3. `0 ≤ amount ≤ refundable` → else *"Refund at most N honeycombs (the unused part)."*
4. `credit(uid, amount, 'refund', 'p'+id, note, adminId)`. This is also written for 0 and is the guard against a
   second refund (`INSERT IGNORE`; 0 rows → *"This purchase was already refunded."*).
5. `remove` is an explicit choice of the admin (`1`/`0`); the form pre-selects it only for a full refund.
   - permanent → `quantity = 0, permanent = 0` (the next unlock books `unlock/<feature>:<n>`, §4.3);
   - timed → `cut = unusedSec`, `expires_at = max(now, expires_at − cut)` through `setPeriod`. Later periods of the
     same lot move back by `cut` so that they still describe the truth: `UPDATE hc_purchases SET period_start =
     period_start − INTERVAL ? SECOND, period_end = period_end − INTERVAL ? SECOND WHERE user_id=? AND feature=? AND
     lot=? AND period_start >= ? AND id <> ? AND refunded_at IS NULL`. A refund of a period that is already over cuts
     nothing;
   - consumable / count → `quantity = IF(quantity > ?, quantity − ?, 0)` with `u` (written this way because
     `quantity − u` on an `UNSIGNED` column fails with MariaDB error 1690 before any `GREATEST` could help).
6. Whatever `remove` says, a refund of a timed purchase turns auto-renewal off for that lot (`setPeriod`). The user
   is told: *"Premium · 30 days was refunded: +120 honeycombs. Auto-renewal was turned off."*
7. `UPDATE hc_purchases SET refunded_at, refund_amount, refund_units, refund_cut_sec, refund_removed, refunded_by`.
8. The offer's `uses` is not lowered, and `per_user_max` keeps counting the refunded purchase (§4.3). An admin who
   wants to let a user have the offer again grants the item directly.
9. Audit (`{"purchase":12,"amount":120,"removed":true}`), bell (`honeycombs`, through `db`), `markReconcile`. After
   commit `reconcileNow(uid)`.

**Reversal** `reverse(adminId, ledgerId, note)` is allowed for `admin daily profile views streak code` (and the later
reward reasons). It is not allowed for `purchase refund reversal unlock grant revoke`; unlocks are removed with revoke
or refund. `amount = −original`. A negative result must keep the balance ≥ 0 (*"That would take the balance below 0
(current: N)."*, today's text). The ref `x<id>` makes a second try answer *"This entry was already reversed."* Bell
`honeycombs` through `db`.

**Honeycomb grants** keep today's rules and texts (`lib/honeycombs.php:191-217`): form nonce `grant_ref`, `ref =
a<adminId>-<nonce>`, ±100,000, never below 0; plus `actor_id` and a bell notification (`honeycombs`, through `db`, only
when the row was booked).

**Bulk grants** work in two steps.
1. `grant_preview` with `user_list`: up to 200 entries, separated by commas or new lines. Allowed forms are an email
   (contains `@` after the first character), `#<id>` and `@<name>` (username or page address). Anything else, such as
   a bare `1234`, is listed as *"Not clear – use #id, @name or an email."* The resolved users are stored in the
   session (`hc_bulk = {ref, ids, amount, note, at}`, valid 15 minutes). The section shows the preview: name, email,
   current balance, and "would go below 0" warnings.
2. `grant_bulk` books each resolved user once with the same nonce (`a<adminId>-<grant_ref>` per user, so a second
   submit books nothing). Result: *"+50 honeycombs for 12 users. Skipped: tom@test.de (would go below 0)."*

**Unlock grants** `grantFeature()`:
- `form_ref` (16 hex, required) is the double-submit guard.
- Permanent: `grantUnlock(db, uid, feature, 0, note, adminId)`; already active → *"Mia already has this."*
- Timed or count:
  - a 0-amount ledger row `grant/g<adminId>-<form_ref>` with `INSERT IGNORE`; 0 rows → *"This was already booked –
    the form was sent twice."*;
  - then `setPeriod`, which extends from `max(now, expires_at)` and resets `reminded`, `expiry_done_at` and
    `renew_failed_at`;
  - "for good" sets `permanent = 1, auto_renew = 0`;
  - admin grants are not bound to the 400-day limit, but to 3650 days per grant.
- Then: audit, bell (`unlock`, through `db`), `markReconcile`; after commit `reconcileNow`.

**Unlock revokes** `revokeFeature()`:
- a 0-amount ledger row `revoke/v<adminId>-<form_ref>` (same guard);
- `setPeriod` to inactive (`quantity = 0, permanent = 0, expires_at = now`, auto-renew off,
  `expiry_done_at = now` so the job sends no second "ended" notice);
- Premium can be revoked only while it is ready;
- audit, bell (`unlock`, through `db`), reconcile.

**Freeze** sets `hc_accounts.frozen_at/frozen_reason`. Earning, buying, redeeming and auto-renewal stop; unlocks keep
working. Audit. Unfreeze clears it.

### 4.6 Earning engine (`earn.ts`, HC-8)

`earnOnVisit(ctx, uid)` replaces `hcEarn` on `GET /dashboard` (and HEAD, as today). It is skipped while impersonating.
Rewards in v1: daily, streak, profile, views.

1. **Throttle:** if this process ran it for this user less than 10 seconds ago, return nothing. This is an in-process
   map with at most 10,000 entries and best effort per process; `NOWAIT` keeps it correct across processes.
2. **Reads before the lock** (pool, one query at a time): settings; whether today's `daily` row exists; and only if
   something can still be earned: `profileComplete()` (unchanged SQL, map-app §7.5), the views total and the count of
   `views` rewards. If nothing can be earned today, it stops here, so most loads take no lock at all.
3. **`withAccount(uid, fn, {nowait: true})`**; `HC_BUSY` → return nothing (the page still renders). Inside:
   1. `acc.frozen_at` → return nothing.
   2. **Daily:** `credit(daily, 'daily', Y-m-d)`.
   3. **Streak:** if the daily row was booked → `streak = streak_day = yesterday ? streak + 1 : 1`, `streak_day =
      today`, `best_streak = max(best_streak, streak)`. A streak that is a multiple of 30 →
      `credit(streak_month, 'streak', 'm'+date)`; otherwise a multiple of 7 → `credit(streak_week, 'streak',
      'w'+date)`.
   4. **Profile, views:** unchanged rules (`lib/honeycombs.php:109-126`), with the values read in step 2.
   5. **Daily cap:** capped reasons are `profile` and `views` (later also `visitors`, `anniversary`, `referral`).
      Before each capped credit, today's `SUM(amount)` of the capped reasons plus the amount must stay ≤
      `daily_cap`, read under the lock. Otherwise the reward is skipped; the idempotent refs pay it on a later day.
      `daily` and `streak` are never capped, and gifts, refunds and codes do not count towards the cap. Every capped
      credit is booked only inside this locked transaction, so two parallel requests cannot exceed the cap.
4. Return the earned items. The bootstrap carries them as top-level `notices` (`OYS_EDITOR.notices`, custom-dialogs
   §5.4): `{tone:'hc', amount:5, text:'for being active today'}`. Texts: `for being active today`, `for completing
   your profile`, `for N page views` (today's), `for a 7-day streak`, `for a 30-day streak`. `honeycombs.earned`
   keeps today's value for the key's sake, but the Node editor shows only `notices`.

Gifts, refunds, renewals and other team actions are **not** collected here; they are bell notifications (§4.14). The
former `seen_ledger_id` "notices since the last visit" is gone, so nothing is announced twice.

Code page views (`code_sites.views`) do not count towards the views rule in v1. They are counted on every non-bot GET
of an HTML file, without the origin check of `/_/v` (`lib/codesites.php:325-328`), so counting them would make the
reward easier to farm. The later visitor milestones (L2) can include code pages with the same day key (Q8).

### 4.7 Referrals (`referrals.ts`) – later step L1, not in v1

Rules for when the owner approves it (Q8):
- **Link:** `hc_accounts.referral_code`, 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, created on first use.
  Eligible inviter: account ≥ 30 days old, profile reward booked, not frozen.
- **Sign-up:** `GET /register?ref=CODE` stores `session.ref` (format check only). After a successful `POST /register`
  (`lib/routes_app.php:101-151` → `app/auth.ts`), an `hc_referrals` row is created and a confirmation mail with a
  signed link (`hmac('ref-confirm|' + referredId + '|' + email)`) is sent. Errors never break the registration. There
  is no email verification today (`lib/schema.php:64-93`), so this link is the verification for invited accounts only.
- **Network check:** while a referral is pending, every editor visit of either account stores `(referral_id, day,
  who, dayKey(ctx))` in `hc_referral_keys`. The same key for both accounts on the same local day → flag
  `same_network`. The keys are deleted when the referral is decided or expires.
- **Qualifies:** referred account ≥ 7 days old, email confirmed, profile reward booked, `daily` entries on ≥ 3
  different days within its first 30 days, not frozen.
- **Payout:** inviter 30, friend 10 (defaults). At most **3 paid per inviter per 30 days**; anything above the cap or
  flagged goes to **review** (admin approves or rejects). Each payout runs in `withAccount` of one account at a time,
  with the daily cap. Pending > 30 days without qualifying → `expired` (job).
- **Register view line:** *"You were invited by a friend – you’ll both get honeycombs once you’ve confirmed your
  email and been active on 3 days."* No referrer name is shown.

The same attack as before (a scripted second account over mobile data) now needs a working mailbox per account and
earns at most 90 a month, below what daily use pays (260).

### 4.8 Event codes (`codes.ts`, HC-9)

`hc-redeem {code}`:
1. Normalise the input: trim, remove spaces, ASCII upper case.
2. `attemptsAllowed(ctx, 'hcredeem:'+uid, 5, 50, 900)`.
3. Look the code up; check the window, `disabled_at` and the account age.
4. `withAccount(uid)`:
   - `credit(uid, amount, 'code', 'c'+id, note)`; not booked → *"You’ve already used this code."*;
   - `UPDATE hc_codes SET uses = uses + 1 WHERE id=? AND disabled_at IS NULL AND (max_uses IS NULL OR uses <
     max_uses)`; 0 rows → rollback, *"This code has been used up."*

An unknown code → `attemptFailed`. Codes do not count towards the daily cap. The answer is `{ok:true, amount,
balance, notices:[{tone:'hc', amount:50, text:'Halloween 2026'}]}`.

### 4.9 Community rewards (`community.ts`) – later step L5, not in v1

Rewards for accepted Discord suggestions and a verified Discord link are not part of v1 (scope, finding 26).
discord-pages has since made this possible without breaking anything. Its `hello` drops unknown features instead of
rejecting the report, and it keeps `author_id` (discord-pages.md §5.4, §10).

If the owner wants it (Q8 f), the step must:
- announce the bot feature `link.v1` through that list;
- reward only suggestions accepted in the web admin, or record the deciding staff member. Today Discord staff decide
  through the bot (`lib/community.php:220-238`), and `hc_audit.admin_id` cannot hold a Discord moderator;
- use link codes of 8+ characters with a global rate limit as well as one per Discord id;
- define the re-link rule: a Discord account that another OnYourSite account already uses is moved only after a new
  code from the bot, and the old account loses the verification;
- book with `credit()` under its own reason `community`, capped and once per suggestion.

### 4.10 Editor API (`/dashboard/api/{action}`)

Runs after the existing preamble (CSRF 419, JSON 400, page 409; map-app §4.0) and **before** the `page === null → 404`
step, like `honeycombs` and `code*`. Dispatch: `action === 'shop' || action.startsWith('shop-') ||
action.startsWith('hc-')`. POST actions called with another method → `404 {"ok":false,"error":"Not found."}`. Business
errors and rate limits answer 200 with `{ok:false,error}`, like the editor's existing limits (`lib/routes_app.php:330,
:544`). Protocol errors use status codes. Answers go through custom-dialogs' `OYSUI.handle()` (their §5.4), which shows
`notices`; the shop never renders them itself.

| Action | Method | Input (validated) | Success | Errors / side effects |
|---|---|---|---|---|
| `honeycombs` | any | — | `{ok:true, honeycombs: HC}` – today's keys (map-app §4.19) **plus** `streak` | — |
| `shop` | any | — | `{ok:true, shop: ShopState}` | — |
| `shop-buy` | POST | `item` `^[a-z][a-z0-9_]{1,39}$`; `request_id` `^[0-9a-f]{32}$`; `expected_price` integer ≥ 0; `auto_renew` bool (timed only); `mode` `stack`/`extend` (stackable only); `terms` bool | `{ok:true, purchase: PurchaseOut, notices: Notice[], shop: ShopState}` | 400 `Not all of the data arrived. Please try again.`; 403 `Buying is turned off in admin mode.`; 409 `request_used`; 200 business errors, `{ok:false, code:'price_changed', price, error}` and the rate limit text |
| `shop-auto-renew` | POST | `feature` registered and timed; `lot` 0…stack−1; `enabled` bool; `max_price` integer = the regular price the dialog showed (required when enabling) | `{ok:true, shop}` | 404 `Not found.` (no active timed lot); 403 admin mode; 200 `price_changed` when `max_price` ≠ the option's current regular price |
| `shop-reminders` | POST | `enabled` bool | `{ok:true}` | 403 admin mode |
| `hc-history` | any | `before` int > 0 (optional) | `{ok:true, items: HistoryItem[20], next: number \| null}` | — |
| `hc-redeem` | POST | `code` string ≤ 40 | `{ok:true, amount, balance, notices}` | 403 admin mode; 200 business errors and `Too many tries. Please wait 15 minutes.` |

```ts
type Notice = { tone: 'ok' | 'info' | 'warn' | 'err' | 'hc'; text: string; title?: string; amount?: number;
                action?: { label: string; link: string } };          // custom-dialogs §5.2
interface ShopState {
  balance: number; frozen: boolean; frozenReason: string; readOnly: boolean;   // readOnly = Admin-Modus
  premium: { active: boolean; until: string | null; forever: boolean; source: string | null; buyable: boolean };
  features: ShopFeature[];        // nur registrierte, bereite Funktionen mit mindestens einer aktiven, kaufbaren Option
  owned: Owned[];                 // aktiv (endende zuerst), dann dauerhaft, dann beendet (≤ 90 Tage)
  earn: { rules: EarnRule[]; streak: { days: number; best: number; nextAt: number | null; nextAmount: number | null }; capLeft: number };
  mailReminders: boolean;
  autoRenewAvailable: boolean;    // LIFECYCLE_READY
}
interface ShopFeature {
  feature: string; title: string; icon: string; description: string; perks: string[]; href: string | null;
  kind: 'permanent' | 'timed' | 'count' | 'consumable'; stack: number;
  state: 'buy' | 'owned' | 'max' | 'included' | 'locked'; note: string;   // note: Grund, wenn nicht kaufbar
  quantity: number; max: number | null; activeUntil: string | null; lotsActive: number; needsTerms: boolean;
  options: { item: string; label: string; days: number | null; units: number; listPrice: number; price: number;
             offer: { label: string; endsAt: string; percentOff: number | null } | null;
             availableUntil: string | null; affordable: boolean }[];
}
interface Owned { feature: string; lot: number; title: string; icon: string; kind: string; quantity: number;
  permanent: boolean; expiresAt: string | null; active: boolean; endsInDays: number | null; autoRenew: boolean;
  renewItem: string | null; renewMaxPrice: number | null; renewPrice: number | null;
  source: 'purchase' | 'admin' | 'legacy'; note: string }
interface EarnRule { key: string; icon: string; title: string; text: string; amount: number; done: boolean; doneText: string;
  progress: { value: number; goal: number } | null }
interface PurchaseOut { id: number; item: string; feature: string; title: string; price: number; listPrice: number;
  expiresAt: string | null; quantity: number }
interface HistoryItem { id: number; amount: number; text: string; at: string }   // at = 'Y-m-d H:i:s' wie heute
```

Rate limits: `shop-buy` `rateLimit('hcbuy:'+uid, 20, 600)`; `shop-auto-renew`/`shop-reminders` `hcset:<uid>` 30/600 s;
`hc-history` `hchist:<uid>` 120/60 s.

### 4.11 Changes to existing routes

| Route | Change |
|---|---|
| `GET /dashboard` | `earnOnVisit()` instead of `hcEarn()` (HC-8), its rewards in the bootstrap's top-level `notices`; the bootstrap also gets `honeycombs.streak`, `premiumUntil` and `premiumForever` (HC-2). The `premium` key stays the boolean it is today (`views/dashboard.php:20`); premium-domains PR 1 changes its meaning (§4.4) |
| `/dashboard/api/code` + `code-unlock` | state `cost` = `shopPrice('code_page', uid)` (with offer); `unlocked = has(uid,'code_page')`. `code-unlock` requires `request_id` and `expected_price` and calls `purchaseUnlock(ctx, uid, 'code_page', {requestId, expectedPrice, terms, via:'code'})`. The response shape is unchanged; already owned → success without a charge (as today). Missing fields (an editor script from before the deploy) → 409 `{"ok":false,"error":"OnYourSite was updated – please reload the editor.","reload":true}`. **Behaviour change:** blocked in admin mode (403); admins use "Unlock for free". From code-slots-admin PR 4 on, this route is theirs, with the same contract plus `item` |
| `codeUnlocked()` (`lib/codesites.php:44-47`, `app/src/code/sites.ts`), `hcForEditor().codeUnlocked`, the admin "Unlocked" badge | read `has(uid,'code_page')` (with the ledger fallback of §4.4). PHP keeps reading the ledger row, which every unlock still writes |
| admin role toggle (`views/admin.php:116-129`, Node `admin/users.ts`) | `UPDATE users SET is_admin` and `markReconcile` in one transaction, then `reconcileNow` (HC-2) |
| `/terms/code-pages` | "currently N" shows `shopPrice('code_page')` (`views/terms-code-pages.php:172`) |
| `upload`, `address`, `page-create`, `/register`, `POST /_/v` | **unchanged** in v1 (Premium does not affect them; address passes, storage, referrals and visitor counting are later steps) |

### 4.12 Admin routes

`POST /admin` with `hc_action` (existing dispatch #3, `views/admin.php:47-55`; CSRF field first; admin = `is_admin` of
the session user, impersonation is not admin). Every branch answers `302 /admin?hc_tab=<tab>[&hc_user=<id>]#honeycombs`
with flash `admin_success` / `admin_error`. Every action writes an `hc_audit` row (ids and amounts only). Array-valued
fields are rejected (no PHP casts). Forms that move honeycombs or remove something carry custom-dialogs'
`confirmAttrs()` + `confirmField()`, so the dispatcher refuses them without `_confirmed=1` (custom-dialogs §5.6).

| `hc_action` | Fields and validation | Effect / message |
|---|---|---|
| `settings` | all v1 keys of §3.5, integers in range | save, keep unknown keys → `Honeycomb settings saved.` |
| `item_save` | `item_id`; `price` 0–1,000,000; `is_active`; `position` −1000…1000; `available_from/until` empty or `YYYY-MM-DDTHH:MM`, until > from; `min_account_days` 0–3650 (≥ the feature's floor); `min_active_days` 0–3650 | `Saved “Premium · 30 days”.` Switching on a timed option before `LIFECYCLE_READY`, or an option of a feature that is not ready → `This option can’t be switched on yet.` Saving `code_page` also mirrors the price into `oys_meta.honeycombs.code_page` (§3.5) |
| `item_add` | `feature` registered, ready, not permanent; `days` 1–365 (timed) or `units` 1–10; `price` | new option, inactive until saved as active; duplicate → `This option already exists.` Options are never deleted, only deactivated – purchases refer to them |
| `offer_create` | `label` cleanText 1–60; `scope` `all`/`feature:<key>`/`item:<key>`; exactly one of `percent_off` 1–100 or `fixed_price` 0…list price (item scope only); `starts_at < ends_at`, `ends_at > now`, ≤ 90 days; `max_uses` empty or 1–1,000,000; `per_user_max` empty or 1–100; `min_account_days`, `min_active_days` (a scope that includes `premium` needs `min_account_days` ≥ 30); `form_ref` 16 hex | `Offer “Black Friday” created.`; double submit → `This offer was already created – the form was sent twice.`; > 20 active or upcoming → `There are already 20 active or upcoming offers.` |
| `offer_cancel` | `offer_id` | `Offer cancelled. Purchases made with it keep their price.` (offers are not edited – cancel and create a new one) |
| `grant` | today's fields (`user_id`, `amount`, `note`, `grant_ref`) | today's texts (`lib/honeycombs.php:198-217`); a negative amount asks first through `OYSUI.beforeSubmit` ("Take 20 honeycombs from Mia?") |
| `grant_preview` / `grant_bulk` | `user_list`, `amount`, `note`, `grant_ref` / `grant_ref` | §4.5; preview in the section, booking texts as there |
| `feature_grant` | `user_id`; `feature` (registered and ready); `mode` `days` (1–3650, only when `LIFECYCLE_READY`) / `permanent` / `units` (1–10); `lot` (stackable, optional); `note` ≤ 150; `form_ref` 16 hex | `Premium given to Mia until Dec 1, 2026.` / `… for good.` / `Mia already has this.` / `This was already booked – the form was sent twice.` |
| `feature_revoke` | `user_id`, `feature`, `lot` (optional, default all), `note`, `form_ref` | `Premium removed from Mia.` |
| `refund` | `purchase_id`, `amount` (default = refundable), `remove` `1`/`0` (required), `note`, `form_ref` | `Refunded 120 honeycombs to Mia. Premium · 30 days now ends on Nov 14.` / `… The code page stays unlocked.` |
| `reverse` | `ledger_id`, `note` | `Entry reversed.` |
| `freeze` / `unfreeze` | `user_id`, `reason` ≤ 200 | `Mia’s honeycombs are on hold now.` / `… are active again.` |
| `code_create` | `code` empty (auto, 10 chars) or `^[A-Z0-9-]{4,32}$`; `amount` 1–10,000; `note` ≤ 150; window; `max_uses`; `min_account_days` 0–3650 | `Code HALLOWEEN26 created.`; duplicate → `This code already exists.` |
| `code_disable` | `code_id` | `Code disabled.` |

`GET /admin` parameters for the section:
- `hc_tab` ∈ `overview catalogue offers rules users purchases ledger codes` (else `overview`);
- `hc_q` (≤ 100 chars, LIKE with `%_\` escaped), `hc_p` (page, 50 per page);
- `hc_user`, `hc_reason`, `hc_item`, `hc_status`, `hc_from`/`hc_to` (dates), `hc_bulk` (preview);
- sorting only from allowlists.

### 4.13 Background job (`app/src/jobs/registry.ts`, `jobs.ts`)

**Shared runner** (the registry custom-dialogs §5.7 proposes; HC-7 creates it). `registerJob({name, everyMinutes,
minSchema, budgetSec, run})` and `registerNightly(name, fn)`. `cli.js jobs:tick` is started by one systemd timer every
5 minutes (§8.1).
- For every job that is due, it takes `GET_LOCK('oys_job_<name>', 0)`; a busy lock means the job is skipped.
- It checks `schema_version ≥ minSchema`. If the schema is older (the build ran before `migrate`, plan §5.2), it
  prints `schema too old – skipped` and exits 0.
- It runs the job and stores `{at, ok, error}` in `oys_meta['jobs']`.
- Nightly functions run in the first tick after 04:00 local time, once per day.

The CLI process has its own small pool (`connectionLimit` 3). It holds the job lock connection and at most one work
connection, which is the only exception to the connection rule and safe because nothing else uses that pool.
premium-domains (5-minute domain job) and custom-dialogs (retention, their PR 6) can register there instead of
shipping their own timers (§9.3). status-pages' worker is a long-running service and stays one.

**The honeycomb job** (every 15 minutes, budget 4 minutes). It stops starting new rows when the budget is used up;
the rest follows in the next run. Each row is handled in its own short `withAccount` transaction, never in one long
transaction. Every bell notification and outbox mail is written through `db` in the same transaction as the state that
marks it as done, so a rerun never repeats it and a crash never loses it.

1. **Reconcile:** accounts with `reconcile_at <= now − 30 s` (oldest first, up to 200) → `reconcileNow(uid)` with
   all enforcers.
2. **Auto-renew:** lots with `auto_renew = 1 AND permanent = 0 AND quantity > 0 AND expires_at > now AND expires_at
   <= now + 24 h AND (renew_failed_at IS NULL OR renew_failed_at < now − 6 h)`. For each:
   - `buy(null, uid, renew_item, 'auto-' + id + '-' + (renew_seq + 1), undefined, {via:'auto', renew:{entId,
     seq: renew_seq, maxPrice: renew_max_price}})`.
   - Success → the purchase, `renew_seq + 1` and the bell *"Premium was renewed until …"* commit together.
   - Failure → in a second short transaction: `renew_failed_at = now`. A bell notification is sent only if
     `renew_notified_for ≠ expires_at` or `renew_notified_kind` differs, and then both columns are set. Kinds:
     - `balance` – not enough honeycombs;
     - `price` – price above the accepted maximum;
     - `gone` – the option is no longer active (*"This option is no longer available – please choose another one in
       the shop."*);
     - `hold` – the account is frozen.

     So each kind of failure is notified **once per period**. Retries stop at `expires_at`; nothing is ever bought for
     a period that has already ended.
3. **Reminders:** active timed lots ending within 7 days with `stage(expires_at) > reminded`. One transaction per lot:
   - `reminded = stage`;
   - a bell notification. With auto-renew on: *"Premium renews on Dec 1 for 350 honeycombs – you have 420."*
     Otherwise *"Premium ends in 3 days."* plus the feature's loss-preview lines;
   - at stage 2, an outbox mail (`ref = rem2:<entId>:<unix(expires_at)>`) when `mail_reminders = 1` and
     `auto_renew = 0`.

   `stage()`: days left ≤ 1 → 3, ≤ 3 → 2, ≤ 7 → 1, else 0. A purchase sets `reminded` to the current stage, so a
   7-day unlock does not remind on the day it was bought.
4. **Expiry:** `permanent = 0 AND quantity > 0 AND expires_at <= now AND expiry_done_at IS NULL`. In `withAccount`:
   - re-read the lot; if it is still ended → `expiry_done_at = now`;
   - for `premium`, `users.premium_until` already holds the past date;
   - bell notification, outbox mail (`ref = end:<entId>:<unix(expires_at)>`, if `mail_reminders`), `markReconcile`;
   - after commit → `reconcileNow(uid)`.

   A renewal in the meantime leaves nothing to mark. An enforcer error leaves the reconcile marker set, so step 1
   retries.
5. **Mail outbox:** up to 100 unsent rows (oldest first). Each mail has nodemailer's 10-second timeouts (plan §1) and
   an overall limit of 20 seconds. On success → `sent_at`; on failure → `tries + 1`, `last_error`. After 5 tries, or
   for a reminder older than 3 days, the row is marked sent with the error kept, and it shows in the overview.
6. **Nightly** (`registerNightly('honeycombs', …)`):
   - the integrity checks and watch rules of §3.5 → `hc_watch`, with the admin bell for new `integrity` items;
   - the entitlement repair of §3.4 for `unlock` rows without an entitlement;
   - outbox rows older than 30 days are deleted.
7. Write `hc_jobs`. A step error is logged and stored in `last_error`; the next step still runs.

Nothing in the web process uses timers, so the job runs once no matter how many web processes exist.

### 4.14 Notifications and mails

- **One channel per event** (custom-dialogs §5.4, §5.8):
  - the user's own action → `notices` in the answer;
  - rewards earned on opening the editor → the bootstrap's `notices`;
  - anything that happens to the user without their action (team actions, renewals, reminders, expiry) → **one** bell
    notification. The bell poll shows it as a toast when the user is online; otherwise it waits as an unread item.

  This design does not put team actions into the next visit's notices, so a gift is never shown twice. That is the
  change requested from custom-dialogs §5.8, and it follows their own rule in §5.4: `notify()` for things that happen
  without the user. If custom-dialogs lets the bell's first poll toast unread items newer than the stored last-toasted
  id, offline gifts get a toast too – still once.
- **Bell types** (rows in custom-dialogs' catalogue, their PR 5a):

  | Type | Icon / tone / link (custom-dialogs §5.2) | Used for |
  |---|---|---|
  | `honeycombs` | `bx-hive` · `hc` · `/dashboard#honeycombs` | gifts, deductions, reversals, refunds |
  | `unlock` | `bx-hive` · `hc` · `/dashboard#honeycombs` | unlock grants and revokes, renewals, renewal failures, reminders, ended (Premium and all other items) |

  Each notification passes the more precise link `/dashboard#honeycombs/<feature>` (e.g. `…/premium`), which selects
  the card (custom-dialogs §6.10).
- Every notification is written with `notify(uid, type, title, body, link, {db})` inside the transaction that made the
  change. The state written in that transaction makes it happen exactly once: the ledger row, `reminded`,
  `expiry_done_at`, `renew_seq` or `renew_notified_for`.
- **Mail template** `email/unlock_reminder.json` (same look as `email/weekly_report.json`), sent from the outbox with
  `sendCustomEmail(email, 'unlock_reminder', vars, subject)`. Variables are escaped with `e()` at send time:
  `full_name`, `headline` (*"Premium ends on Dec 1"* / *"Premium has ended"*), `text` (including loss-preview lines),
  `shop_url` (`mainUrl('/dashboard#honeycombs/premium')`). Subjects: *"Your Premium ends on Dec 1"*, *"Your Premium
  has ended"*. Footer: *"You can turn these emails off in the editor under Honeycombs."*

---

## 5. UI

### 5.1 Yellow honeycomb icons

The colour tokens are defined **once**, by custom-dialogs, in `static/css/ui.css` (their §6.4): `--hc: #facc15`
(Tailwind yellow-400), `--hc-2: #fde047`, `--hc-text: #fef08a`, `--hc-soft: rgba(250, 204, 21, .12)`, `--hc-line:
rgba(250, 204, 21, .35)`. `editor.css` uses them with fallbacks such as `var(--hc, #facc15)`, because the PHP views
served during a rollback load `editor.css` without `ui.css` (custom-dialogs §11.2). New in `editor.css`: utility
`.hc-icon { color: var(--hc, #facc15); }` and badge `.bdg.hc` next to `.bdg.amber` (`editor.css:155`).
Server-rendered views use Tailwind's built-in `text-yellow-400` (the CDN config only extends colours,
`views/dashboard.php:64`).

| Place | Change |
|---|---|
| Header pill `views/dashboard.php:119` / `.hc-pill` `editor.css:424-428` | icon `var(--hc, …)`, background `--hc-soft`, border `--hc-line`, text `--hc-text`, pop shadow yellow |
| `.hc-big` `editor.css:430-433` | yellow gradient and icon |
| `.hc-rule .ri` (not `.done`) and `.hc-rule .amt` `editor.css:437,441` | yellow |
| `.hc-bar span` `editor.css:451` | `linear-gradient(90deg, #f59e0b, #facc15)` |
| `editor.js:2257` badge "Unlock with honeycombs", `:2267` `text-brand-400` → `hc-icon`, `:2131`, `:2271`, `:2280` | yellow |
| Admin nav item `views/admin.php:320` and `ADMIN_TABS.honeycombs` `:632` | icon yellow; active style `border-yellow-500/30 bg-yellow-500/10 text-yellow-400` |
| `views/admin_honeycombs.php:39,149` and every new admin honeycomb icon | `text-yellow-400` |
| `views/terms-code-pages.php:169` | `text-yellow-400` |
| **Not changed by this design:** `.toast.hc` (`editor.css:429`) | custom-dialogs' `.ui-toast.hc` is already yellow; the old rule stays for the PHP rollback (custom-dialogs §6.4, §11.2) |
| Bell items | through custom-dialogs' catalogue (§4.14), not in `editor.js:664` |
| **Not changed:** the logo at `views/dashboard.php:84`, `landingpage.php:110`, `login.php:47`, `register.php:53`, `404.php:50`, `terms.php:38`, `privacy.php:38`, `imprint.php:38`, `terms-code-pages.php:43`, `updates.php:109`, `admin.php:271` | brand colour (Q1) |

### 5.2 Editor

**Rail:** a new button after "Code page", mirroring the existing `.nav-btn` markup (`views/dashboard.php:88-94`):
`<button type="button" data-tab="honeycombs" class="nav-btn nav-desktop"><i class='bx bx-hive text-xl hc-icon'></i>
<span class="hidden lg:block text-sm">Honeycombs</span></button>`. On phones (`editor.css:383-399`, bottom bar with 7
items) it is hidden by a new rule `@media (max-width: 639px) { .nav-desktop { display: none; } }`; the header pill opens
the tab there.
- `TAB_TITLES` gains `honeycombs: 'Honeycombs'`; the legacy hash `#shop` maps to it.
- The tab also works without a page (like `#code`, `editor.js:2880`).
- `data-action="honeycombs"` (pill, `editor.js:636`) switches to the tab. When the page has no `#tab-honeycombs` (the
  PHP view during a rollback until release 3.1), it opens today's modal, which stays in the file until the 3.1
  cleanup (custom-dialogs §11.2).
- The deep link `/dashboard#honeycombs[/<feature>]` opens the tab and scrolls to that card (custom-dialogs §6.10 maps
  `honeycombs` to the tab and passes the argument). `openShop(feature)` does the same from code (premium-domains B2).

**Tab `#tab-honeycombs`** (rendered by a new section in `editor.js`, like the code tab; components reused). While
loading: `.empty-state` with spinner. If loading fails: `.panel.empty-state` *"Couldn’t load your honeycombs – please
reload."* (`editor.js:2213`).

1. **Wallet row** – `.panel` with `.hc-big` (balance, "honeycombs"), a streak chip `.bdg.hc` (*"bx-flame Day 4 · best
   12"*), buttons `.btn-ghost` *"How to earn"* (scrolls) and *"Redeem a code"* (focuses the input). Banners above it:
   - frozen; read-only (admin mode);
   - something ends within 3 days: amber border, text, `.btn-secondary` *"Renew"*, dismissible for the day;
   - Premium ended within 14 days: grey, *"Renew"* + *"Dismiss"*; the dismissal is stored in `localStorage` per end
     date, wrapped in `try/catch`, and shown again if storage fails.
2. **"Unlock"** – `<h2 class="section-title">Unlock</h2>` + `.shop-grid`. Its own breakpoints: 1 column, 2 columns
   from 640 px, 3 columns from 1280 px. These are the same widths at which `.theme-grid` steps up, but `.theme-grid`
   itself has 2/3/4 columns (`editor.css:204-206`). Each card is a `.panel.shop-card`:
   - an icon square like `.code-mini-ico`, the title, the description and the perks list in `.code-feats` style;
   - a duration/pack choice as `.chips` with one `.chip` per option (`.chip.on` = selected; the same component as the
     stats range, `editor.css:99-107`, `editor.js:1998`);
   - a price row with `bx-hive hc-icon` + price. During an offer the list price is struck through and `.bdg.hc`
     shows *"−30 % · ends Dec 1"*. A window shows `.bdg.amber` *"Limited · until Dec 24"*;
   - the button: `.btn-primary` *"Buy for 350"* / disabled *"120 more needed"* / `.btn-secondary` *"Renew"* /
     `.bdg.green` *"Owned"* / *"1 of 2 packs"* / the note (included, locked, too new).

   A feature's card appears only when it is ready and has at least one active, buyable option. So Premium appears
   only when it can be bought, and `code_more` only when it has a price.
3. **"Your unlocks"** – `.panel` list in `.hc-rule` rows. Each row has the icon, the title and the status: *"Active
   until Dec 1, 2026 · auto-renew on (up to 350)"*, *"Ends in 3 days"* (amber), *"Ended on Nov 30 – paused, content
   kept"* (grey), *"Unlocked for good"*, *"Pack 2 · until Dec 15"*.
   - The auto-renew switch (`.switch`, as used at `editor.js:2734`) appears only when `autoRenewAvailable`. Turning
     it on asks first: `OYSUI.confirm({title:'Renew Premium automatically?', text:'We renew it 1 day before the end
     for up to 350 honeycombs while you have enough. If the price goes above 350, we ask you first.', tone:'hc',
     ok:'Turn on'})`. Turning it off asks too: *"Turn off auto-renewal? Premium ends on Dec 1 unless you renew it."*
     (`tone:'warn'`).
   - A *"Renew"* button.
   - Below the list, the switch *"Email me before an unlock ends"*.
4. **"Earn honeycombs"** – `.hc-rules` (existing rows, `editor.js:2117-2128`) with progress bars `.hc-bar`: Be active,
   Keep a streak (*"Day 4 – 3 more days to +15"*), Complete your profile, Get visitors (today's views rule), Event
   codes, Gifts from the team, and *"Daily limit: 120 of 300 left today"* as a hint.
5. **"Redeem a code"** – input `.field` + `.btn-secondary` *"Redeem"*, error line like `#codeErr`.
6. **"History"** – `.hc-hist-row` list (`editor.js:2134-2138`) + *"Show more"*.

**Purchase dialog** – `OYSUI.confirm({title, content, ok:'Buy for 350', tone:'hc', canConfirm, onConfirm})`
(custom-dialogs §6.2):
- `content` is a builder that creates the DOM with `esc()`-ed values:
  - `.hc-big` with the price and *"you have N"*;
  - the result line (*"Premium runs until Dec 1, 2026. Afterwards you have 70 honeycombs left."*) and the perks;
  - for stackable packs, a radio choice `mode` "Add a pack" / "Extend";
  - the checkbox `auto_renew` with the maximum price (timed options, when available);
  - the owner's checkbox `terms` when `needsTerms` (e.g. today's `codeTermsHtml()` text).
- `canConfirm(values)` keeps *Buy* disabled until `terms` is ticked.
- `onConfirm(values, ctl)` sends `shop-buy` with the request id. On `price_changed` it calls `ctl.update({ok:'Buy for
  280', content: newPriceBox})` and returns the price text, so the dialog stays open with the same request id. Other
  errors are returned as text. Success closes the dialog; the answer's `notices` show through `OYSUI.handle()`.
- The request id (`crypto.getRandomValues`, 16 bytes hex) is created when the dialog opens.

**Earned rewards** come from `OYS_EDITOR.notices` and are shown by custom-dialogs' start code through
`OYSUI.notices(list, {label:'History', link:'/dashboard#honeycombs'})`. When the bootstrap has no `notices` key (the
PHP view during a rollback), today's `honeycombs.earned` loop (`editor.js:2853-2858`) runs instead. The balance pill
updates with `setBalance(n, true)`.

**Code tab.** The locked hero keeps its layout (`editor.js:2252-2302`) but reads price and offer from `/code`. The
unlock dialog creates a request id when it opens and sends `{terms, request_id, expected_price: st.cost}`. A price
change shows the server's text and reloads the state.

**Other editor changes:**
- The old modal (`hcBody`/`openHoneycombs`, `editor.js:2115-2151`) is no longer used by the Node view; the code is
  deleted in the 3.1 cleanup (see the rail notes above).
- Once Premium is buyable, the *"Premium"* lock pills become *"Get Premium"* links (`data-action="honeycombs"
  data-feature="premium"`); until then they stay as today.
- The Premium banners of the wallet row are also shown on the other tabs (same dismiss rule).

### 5.3 Admin section "Honeycombs"

The section shell (nav item, `#tab-honeycombs`, title "Honeycombs") comes from code-slots-admin's split (their PR 1);
the code-site list (`views/admin_honeycombs.php:90-133`) moves to their "Code pages" section. Layout mirrors the
existing cards (`bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6`, header row with icon + `h2`,
`views/admin_honeycombs.php:37-41`) and the inputs/buttons `$in`, `$lbl`, `$btn` (`:21-23`).

- **Sub-navigation:** links `/admin?hc_tab=<tab>#honeycombs` styled like the community filters
  (`views/admin_community.php:81`: `$btn` + `!bg-white/10 !text-white` when active), with counts.
- **Overview:**
  - four KPI cards: *In circulation*, *Earned · 30 days*, *Spent · 30 days*, *Active Premium*;
  - *Ending in 7 days* (list) and *Top options · 30 days* (table: option, sold, honeycombs);
  - *Earned by reason · 30 days* (horizontal bars in plain CSS, yellow);
  - *Needs attention*: `hc_watch` items, accounts waiting for reconcile with the last error, unsent mails, job
    status line;
  - *Latest activity*: the last 10 ledger entries (today's list at `views/admin_honeycombs.php:170-187`; the full list
    is the Ledger sub-tab).
- **Catalogue & prices:** table with option, feature (owner), duration/pack, price input, active toggle, position,
  available from/until (`datetime-local`), min. account age, min. active days, sold (30 days). One `<form>` per row
  with "Save". Toggles that cannot be switched on yet are disabled, with the reason as `title`. Below the table: "Add
  an option" (feature select, days or units, price).
- **Offers:** list with status badges *Running* (green) / *Scheduled* (sky) / *Ended* / *Cancelled* (grey) and uses
  `12 / 500`. Create form: label, scope select with all features and options, discount type radio %/fixed, start,
  end, max uses, per user, min. account age, min. active days. "Cancel" with a confirmation.
- **Earning rules:** today's form (`views/admin_honeycombs.php:70-87`, same `.flex` rows with title + hint +
  right-aligned number input) with the new keys in groups *Daily* and *Limits*. The old field *"Price: code page"*
  (`:31`) moves to Catalogue & prices. Hints, e.g. *"7-day streak – bonus every 7 days in a row"*, *"Daily limit –
  most honeycombs one user can get per day from automatic rewards (not daily, streaks, gifts or codes)"*.
- **Users:** a search box (server-side) and a table like today's balances (`:135-168`) with Balance, Earned, Spent,
  Premium (*"until Dec 1"* / *"for good"* / *"admin"*), status (frozen badge) and the actions *Give* and *Details*.
  - The grant form (today's, `:42-67`) sits on top, with a "Several users" toggle that shows the `user_list` textarea
    and the hint *"One per line: an email, #id or @name"*. *Check list* leads to the preview card (resolved users,
    unclear and missing entries, warnings) with *Confirm* and *Cancel*.
  - **Details** (`hc_user`) shows: balance, unlocks (with *Give unlock* / *Remove*), purchases (with *Refund*), the
    user's ledger (with *Reverse*), audit lines, and *Freeze* with a reason.
- **Purchases:** filters (option, user search, date range, offer, refunded) and a table (date, user, option, price/list
  price, offer label, period, status) with *Refund*. The inline refund form has the amount (default: the refundable
  value, shown as *"max 120 – the unused part"*), the checkbox *"Also remove what was bought"* (pre-ticked only for a
  full refund) and the note.
- **Ledger:** filters (reason, user, date) and a table (date, user, reason text, amount `+N`/`−N`/`free` in today's
  colours, admin) with *Reverse*.
- **Codes:** create form and a table (code, amount, uses / max, window, status) with *Disable*.

All destructive or money-moving forms (refund, reverse, deduct, freeze, remove unlock, cancel offer, bulk confirm)
use `confirmAttrs()` + `confirmField()` with a precise text, e.g. *"Refund 120 honeycombs to Mia and end Premium ·
30 days 18 days early?"* (custom-dialogs §6.8). Texts that depend on form values (the refund amount, the negative
grant) come from `OYSUI.beforeSubmit`.

### 5.4 Other pages and texts

- **Terms (`/terms`):** a new section *"Honeycombs and Premium"*:
  - no money value, no transfers (as today);
  - prices and offers can change; purchases keep their price;
  - auto-renewal only when turned on, and never above the price the user accepted;
  - time-limited unlocks pause when they end, and content is kept;
  - refunds only at the team's discretion and only for the unused part;
  - cheating (fake views, automated logins) can lead to removal and a hold.

  `terms-code-pages` section 5 links to it.
- **Privacy (`/privacy`):** nothing new in v1 – no new personal data is stored. L1/L2 add their paragraphs (daily
  keys, deleted after 2 days or when the invite is decided).

---

## 6. Security and abuse

### 6.1 Threats and controls

| Threat | Control |
|---|---|
| Double spend (double click, retry, two tabs) | `request_id` unique per user + ledger `(user_id, reason, ref)` + `withAccount` row lock; a replay returns the first result only for the same item and an unrefunded purchase |
| Race purchase vs. admin deduction vs. auto-renew | every debit in `withAccount`; balance read under the lock (READ COMMITTED); deadlock → one retry; nightly check for `SUM < 0` |
| Lock-based slowdown (many parallel `/dashboard` loads) | earning: 10-second throttle per user, reads before the lock, `NOWAIT` (never waits); buys wait at most 5 s and are rate-limited; one pool connection per request at a time (§4.2) |
| Pool deadlock (nested connections) | connection rule; read APIs take `db`; enforcers never run inside a held connection; `notify()` and `canBuy()` use the caller's `db` |
| Lost side effects (crash, busy lock, Cloudflare error) | reconcile marker in the same transaction as the change; the job retries until all enforcers succeed; slow enforcers only in the job |
| Repeated or lost notifications | written through `db` in the transaction of the state change; the state (`reminded`, `expiry_done_at`, `renew_notified_for`, ledger refs) makes each one happen once |
| Mixed lock types | HC-2 moves `hcSpend`/grants to `withAccount`; no `GET_LOCK('oys_hc_*')` left |
| Price tampering | server computes the price; `expected_price` only detects changes; auto-renew pays at most `renew_max_price` |
| Offer over-use | conditional `UPDATE … uses < max_uses` in the purchase transaction; `per_user_max` counted under the lock and including refunds |
| Hoarding at sale prices | timed ≤ 400 days ahead, count/consumable max, offers ≤ 90 days, ≤ 20 active offers |
| Refund abuse | admin only; only the unused part; `refund/p<id>` ledger guard; auto-renew turned off; renewal ids from a counter, so a refunded purchase is never replayed as a renewal |
| Double reversal / double grant / double revoke | ledger refs `x<id>`, `a<adminId>-<nonce>`, `g…`, `v…`; form nonces `grant_ref`, `form_ref`; server-checked confirmations (`_confirmed`) |
| Throwaway accounts using Premium (e.g. to fill the 100 free custom hostnames, premium-domains §6.2) | Premium items and any offer that includes Premium need accounts ≥ 30 days old and ≥ 10 active days; no 7-day Premium; premium-domains is asked for its own minimum account age |
| Farming daily/streaks | login needed; one per site-timezone day; no earning in admin mode |
| Fake views | views rule as today (capped, one level a day); daily cap; nightly `views_spike` watch |
| Extra accounts | no transfers; referrals are not in v1 (L1 has email confirmation, network check and a cap of 3 per 30 days) |
| Code guessing | `attemptsAllowed` 5 per client / 50 total per 15 min; random codes 10 chars from 31 symbols; once per user |
| Admin misuse | `hc_audit` for every admin action, `actor_id` in the ledger, visible in user details; `big_grant` watch for all admins |
| Impersonation | buying, redeeming and toggles blocked (403); earning skipped; the user's real Premium status is shown |
| CSRF / auth | editor API: existing CSRF check (419) and login gate (401); admin: form token + `is_admin` of the session user |
| XSS | offer labels, notes, code notes and titles escaped (`esc()` in the editor, `e()` in the admin), length limits; custom-dialogs sets texts with `textContent`, and the purchase dialog builds its content from `esc()`-ed values |
| Expiry bypass | access checked at read time against the server clock; the job only runs side effects |
| SQL injection | placeholders; filters and sorting from allowlists |
| Denial of service | rate limits, 5 s lock wait, paging (50 per page), job budgets and batches, mail cap per run |
| Indexing | everything is under `/dashboard` (noindex meta, `views/dashboard.php:57`) or `/admin` (noindex meta); no new public page |
| Privacy | no new personal data in v1; the audit keeps ids only; deleting a user removes all honeycomb rows (§3.8) |

### 6.2 Limits (constants in `features.ts` / settings)

| Limit | Value |
|---|---|
| Admin grant per entry | ±100,000 (today) · bulk ≤ 200 entries · unlock grants ≤ 3650 days |
| Prices | 0–1,000,000 |
| Timed unlock ahead | 400 days |
| Packs at the same time | the feature's `stack` (status checks: 2) |
| Premium eligibility | account ≥ 30 days (floor), ≥ 10 active days (default) |
| Offers | discount 1–100 %, ≤ 90 days, ≤ 20 active or upcoming |
| Automatic rewards per user and day | `daily_cap` (300) |
| Earning check | once per user every 10 s per process |
| Codes | amount 1–10,000, redeem tries 5 / 15 min |
| Buy | 20 per 10 min per user |
| Lock wait | 5 s (buy, admin) · none (earning) |
| Job | every 15 min, budget 4 min, ≤ 200 reconciles, ≤ 100 mails per run |

---

## 7. Tests

### 7.1 Unit (`app/test/hc-*.test.ts`, `node:test`, `mock.timers`)

- `hc-settings.test.ts`: old JSON parses as today; new keys default; clamps and `is_numeric` rules; save keeps unknown
  keys.
- `hc-pricing.test.ts`: percent rounding (`ceil`), fixed price, scope precedence and ties, cancelled/ended/not-started
  offers, `max_uses`, `per_user_max` counting refunded purchases, eligibility filters, free (0) items and
  `freeAtZero`.
- `hc-period.test.ts`:
  - extend from now vs. from the current end; the 400-day limit;
  - lot choice for stack 1 and 2;
  - `stage()` for 7/3/1 days;
  - DST weeks (Mar 29 / Oct 25, 2026).
- `hc-refund-math.test.ts`:
  - unused value of a timed period (ended → 0, current → the rest, future → all);
  - consumable units (only unused);
  - shifting of later periods;
  - the `IF(quantity > ?, …)` expression with `quantity < units`.
- `hc-streak.test.ts`: yesterday +1, gap → 1, same day unchanged, bonus at 7/14/30/210 (only the 30-day bonus).
- `hc-describe.test.ts`: every reason of §3.7 including `unlock` refs with `:<n>`; old reasons unchanged.
- `hc-identifiers.test.ts`: email / `#id` / `@name` accepted, bare digits and other forms rejected as "not clear".
- `hc-notices.test.ts`: every notice the shop creates passes custom-dialogs' `notice()` check (tone, lengths, link).

### 7.2 Database tests (`app/test/hc-*.db.test.ts`, run with `$S/oys-db.sh run`)

**Deterministic races.** `pausePoint(name)` is a no-op unless the test harness installs a gate. Gates sit in
`withAccount` (`account-locked`), in `buy()` (`before-debit`, `after-purchase-insert`) and in the job
(`renew-selected`, `expiry-selected`). Race tests open a gate, start the second actor and release the gate. There are
no repetition loops.

- **Concurrency:**
  - 2 `buy` with the same `request_id`, the second gated behind the first → 1 purchase, 1 ledger row;
  - a balance for 3 and 5 buys with different ids, each held at `before-debit` → exactly 3 succeed, balance ≥ 0;
  - a purchase gated while an admin deduction commits → never below 0;
  - offer `max_uses = 1` with two gated buyers → 1 use.
- **Unlock model (findings 1, 3):**
  - after the HC-2 migration, `code-unlock` (`hcSpend` path) gives access (`has()` and `codeUnlocked()` true);
  - the admin "Unlock for free" via `hcAdd(…, 0, 'unlock', 'code_page')` gives access;
  - a ledger row written without an entitlement (PHP during a rollback) gives access, and the nightly repair creates
    the entitlement;
  - a refunded unlock stays locked although its ledger row exists;
  - unlocking again after a refund books `unlock/code_page:2`;
  - the backfill turns `unlock/code_more` and `unlock/status_page` rows into entitlements;
  - `has(uid, feature, db)` inside another transaction uses that connection only (pool size 1 in the test).
- **Refund + auto-renew (finding 4):**
  - (a) refund of an auto-renewed Premium after its old end → `auto_renew = 0`, `tick()` charges nothing;
  - (b) refund before the old end → the next renewal id differs from the refunded purchase's id; replaying the
    refunded id → 409, no notification.
- **Refund rules (finding 5):**
  - refunding an ended January period leaves the March period untouched;
  - 3 passes with 2 used → at most a third refunded;
  - `quantity = 1`, `units = 3` → no SQL error;
  - a partial refund with `remove = 0` keeps the unlock;
  - a refunded "once per user" trial cannot be bought again.
- **Auto-renew price (finding 6):**
  - the price raised above `renew_max_price` → no charge, one notification per period and kind;
  - no renewal after `expires_at`;
  - a manual extension between selection and renewal (gate `renew-selected`) → no second extension.
- **Grants (finding 7):**
  - the same `form_ref` twice → one `grant` row and 30 days, not 60;
  - re-granting an ended Premium resets `expiry_done_at`/`reminded`, and the next end is processed.
- **Reconcile (finding 9):**
  - a throwing test enforcer leaves `reconcile_at` set and the next `tick()` clears it;
  - a change during an enforcer run (gate) keeps the marker;
  - the admin role toggle marks the account.
- **Earning (finding 8):**
  - `earnOnVisit` twice the same day → one daily and one streak step;
  - with the account row held by another transaction it returns at once (`NOWAIT`) and books nothing;
  - the daily cap holds with two gated parallel calls.
- **Notifications exactly once:**
  - `tick()` twice → one reminder, one expiry notification, one renewal, one mail each;
  - a failure injected after the state change but before commit → neither the state nor the notification is written;
  - the next run sends it once.
- **Job:**
  - renewal between selection and marking does not mark the expiry;
  - the job lock prevents a parallel run;
  - the runner exits 0 on an old schema.
- **Migration from a v5 database:**
  - code page unlocks (paid and free) become entitlements;
  - a code site without an unlock entry is covered;
  - the `code_page` price equals the old setting;
  - `actor_id` back-filled;
  - running the step twice changes nothing.
- User deletion removes all rows of §3.8 and anonymises the audit.

### 7.3 HTTP tests (Fastify `inject`, `app/test/hc-*.http.test.ts`)

- Every editor action:
  - 401 without login, 419 bad CSRF, 400 invalid JSON and invalid fields, 404 wrong method, 403 in admin mode;
  - 200 `{ok:false}` after the rate limit;
  - 409 `request_used`;
  - response shapes of §4.10 (key order not relevant for new endpoints).
- `code-unlock` keeps its response shape; without `request_id` → 409 with `reload:true`; with a stale
  `expected_price` → the price text; `honeycombs` keeps today's keys.
- The bootstrap has `premium` as a boolean, `premiumUntil`/`premiumForever`, and top-level `notices` with the earned
  rewards.
- Admin:
  - each `hc_action` with valid and invalid input, the redirect target and flash text, and the audit row;
  - forms with `_confirmed=0` change nothing;
  - bulk preview with ambiguous entries;
  - non-admin and impersonating admin are redirected (`302 /dashboard`).

### 7.4 Playwright end-to-end (`tests/e2e/hc-*.js`, the repo's e2e setup with `playwright@1.63.0`)

1. `hc-earn.js`: first dashboard load → yellow reward toasts from `notices`, the pill pops; the computed colour of
   `.hc-pill i` is `rgb(250, 204, 21)`; the rail logo keeps the brand colour.
2. `hc-buy.js`: buy the code page from the shop (terms checkbox in the dialog keeps *Buy* disabled until ticked) →
   Code tab unlocked; not enough → disabled "N more needed"; double click on "Buy" → one ledger row; the shop's load
   error state (API stubbed to 500).
3. `hc-offer.js`: admin creates a 30 % offer → the user sees the struck-through price and badge → buys at the
   discount; the admin purchases list shows the offer; admin changes the price while the dialog is open → the dialog
   stays open with "The price changed" and "Buy for 280".
4. `hc-premium.js` (after premium-domains PR 1 and HC-7):
   - admin activates the Premium options; a user with a fresh account sees "available once your account is 30 days
     old" (SQL ages the account);
   - buys 30 days with auto-renew → the hide-branding toggle is enabled;
   - SQL moves `expires_at` into the past, `node app/dist/cli.js jobs:tick` → one bell "Premium has ended", the
     banner (dismissible), branding visible on the public page;
   - renew → resumed.
5. `hc-admin.js`:
   - grant +100 with a note → the user sees **one** bell notification (toast from the bell poll), no second notice
     on reload;
   - bulk grant with preview;
   - refund with "Also remove" → unlock removed and balance back;
   - reverse; freeze → buy disabled with banner;
   - all confirmations are custom dialogs (the test fails on any native `dialog` event).
6. `hc-codes.js`: create code → redeem → second redeem refused → disabled code refused → 6 wrong codes → rate-limit
   text.
7. `hc-mobile.js` (390 × 844): bottom bar unchanged (7 items), the pill opens the tab, the shop grid is one column, no
   horizontal scroll.
8. `hc-rollback.js` (rule R): the PHP dashboard view with the new `editor.js` → the pill opens the old modal and the
   earned toasts come from `honeycombs.earned`.

Approved Node snapshots (plan §3.4) are updated for the admin honeycombs section and the dashboard bootstrap JSON.

---

## 8. Installer and operations

### 8.1 Shared job timer (in `write_timers`, `server/install.sh:1326-1408`, Node version per plan §5.2)

```ini
# $UNITS/onyoursite-jobs.service – written by server/install.sh
[Unit]
Description=OnYourSite background jobs (honeycombs and other registered jobs)
After=mariadb.service

[Service]
Type=oneshot
User=$WEB
Group=$WEB
WorkingDirectory=$CODE/app
ExecStart=/usr/bin/node $CODE/app/dist/cli.js jobs:tick
Nice=5
TimeoutStartSec=10min
NoNewPrivileges=true
PrivateTmp=true
```

```ini
# $UNITS/onyoursite-jobs.timer
[Unit]
Description=OnYourSite background jobs every 5 minutes

[Timer]
OnCalendar=*:0/5
RandomizedDelaySec=30
Persistent=true

[Install]
WantedBy=timers.target
```

- `write_timers` writes both files and runs `systemctl enable --now onyoursite-jobs.timer`; `--update` does the same.
  `summary` mentions `systemctl list-timers onyoursite-jobs.timer`.
- **`--rollback` (plan §5.6) also runs `systemctl disable --now onyoursite-jobs.timer`**, so no renewals, charges or
  mails run against the database while PHP serves. `--update` enables it again.
- **Order on update:** the website step builds before it migrates (plan §5.2). A timer run in between finds an older
  `schema_version` and exits 0 without doing anything (§4.13).
- A systemd oneshot unit never runs twice at the same time; `GET_LOCK` per job also covers manual runs.
- The CLI needs config and DB access like `weekly-report`, plus mail access (SMTP from `email/smtp.json`). No
  Cloudflare token permissions, no new ports, no new packages, no new secrets.
- If premium-domains and custom-dialogs register their jobs here (§9.3), their own timers are not needed.

### 8.2 Files and data

- `email/unlock_reminder.json` ships with the code. The newsletter template list shows every `email/*.json`
  (map-admin §3.1), as it already does for `weekly_report`.
- New tables are in the nightly `mysqldump` of the whole database (`server/backup.sh:28`).
- The admin overview shows when the jobs last ran (`oys_meta.jobs`, `hc_jobs`), the reconcile backlog and unsent mails,
  so a stopped timer is visible without a shell.
- Disk use: v1 sells no storage, so the quota is unchanged (200 MB per user, 1000 MB for staff). The later
  `storage_step` (Q8) comes with a nightly disk report (total upload bytes and the 10 largest accounts in the
  overview) first.

### 8.3 Server capacity (16 vCores)

The server now has 16 vCores. The plan runs the website as **one** Node process (per-session lock in-process, plan §0
item 6). This feature keeps **no state in the web process** that matters for correctness. All locking is in MariaDB
(row locks, unique keys, `GET_LOCK`). The earning throttle is a per-process optimisation only. Jobs run in a separate
process. The feature therefore stays correct if the web service is later split into several processes to use the
cores.

**Connection budget:**

| Consumer | Connections |
|---|---|
| Web request (any honeycomb path) | at most **1 at a time** (connection rule §4.2); `withAccount` holds it ≤ 5 s while waiting, earning never waits |
| Web process pool | `connectionLimit` 10 (`app/src/db.ts:74`), so ≤ 10 DB-bound requests at once per process; more queue in mysql2's pool |
| Jobs runner (CLI) | own pool of 3; uses ≤ 2 (job lock + work) |
| status-pages worker, premium-domains job | their own budgets (their designs) |
| Today (1 web process) | ≈ 10 + 3 + others – far below MariaDB's default `max_connections` 151 |
| Split web service, e.g. 12 processes on 16 vCores | 12 × 10 + 3 + others ≈ 130–140: set `max_connections = 300` in `90-onyoursite.cnf` (`server/install.sh:1457-1461`) in the same change that splits the service |

Recommendations for whoever splits the service (not part of this feature):
- give mysql2's pool a `queueLimit` (e.g. 200), so overload answers 503 quickly instead of queueing without end;
- keep the jobs timer a single unit.

---

## 9. Delivery plan

### 9.1 v1 pull requests

Each PR is its own branch on the Node version, reviewable alone, with its own migration step where noted.
custom-dialogs' PR names follow their §11.1 (PR 0 contract, PR 1 library, PR 2 editor, PR 3 admin, PR 5a notification
core, PR 5b bell).

| # | PR | Content | Depends on |
|---|---|---|---|
| HC-1 | Yellow honeycomb icons | §5.1 only (uses the `--hc` tokens with fallbacks, views, editor strings); no change to `.toast.hc` | custom-dialogs PR 1 (soft: the fallbacks work without it) |
| HC-2 | Ledger core, entitlements, Premium status | migration `createShopCore` + backfill of all `unlock/*` rows; `ledger.ts` (`withAccount` with retry and `NOWAIT`); `entitlements.ts` (`has()` with ledger fallback and `db`, `grantUnlock`, `setPeriod`); `reconcile.ts`; `premium.ts` (`users.premium_until`, `isPremiumRow`, aliases, rollout flag); `hcSpend`/grants and `hcAdd('unlock')` on the new lock and writing the entitlement; `codeUnlocked()` via `has()`; admin role toggle marks reconcile; `E.premiumUntil`/`E.premiumForever`; tests incl. "unlock after migration gives access" | — · **unblocks premium-domains PR 1, code-slots-admin, status-pages** |
| HC-3 | Catalogue, offers, purchases, refunds | migration `createShopCatalogue` + `seedItems()`; `features.ts`, `catalogue.ts`, `offers.ts`, `shop.ts` (`buy`, `purchaseUnlock`, `shopPrice`, `refund`); `app/src/code/shop.ts` (registration of `code_page` with today's terms rule, handed over to code-slots-admin); `code-unlock` via `purchaseUnlock` with request id and expected price | HC-2 |
| HC-4 | Editor "Honeycombs" tab | editor API §4.10 (without `hc-redeem`), tab UI, purchase dialog, history, error states, deep-link argument, legacy modal kept for the PHP view, terms section "Honeycombs and Premium" (§5.4) | HC-3 · custom-dialogs PR 1 (hard: `OYSUI.confirm` with `content`) and PR 2 (soft: `notices` shown by `request()`) |
| HC-5 | Admin I: overview, catalogue & prices, offers, earning rules | §5.3 first four sub-tabs, audit | HC-3 · code-slots-admin PR 1 (admin split) · custom-dialogs PR 1 (hard: `confirmAttrs`/`confirmField`, `beforeSubmit`) |
| HC-6 | Admin II: users, grants (bulk with preview), unlock grants, purchases & refunds, ledger & reversal, freeze | §5.3 remaining sub-tabs; bell notifications | HC-5 · custom-dialogs PR 5a (hard: `notify(…, {db})`, catalogue rows) and PR 5b (soft: bell links) |
| HC-7 | Time-limited lifecycle | shared registry and `jobs:tick`, honeycomb job, outbox migration + mail template, reminders with loss previews, auto-renew, expiry banners, installer timer + rollback change; sets `LIFECYCLE_READY` | HC-4, HC-6 · custom-dialogs PR 5a (hard) |
| HC-8 | Streaks and the daily cap | migration `addStreaks` + backfill, `earn.ts` (`NOWAIT`, throttle), bootstrap `notices`, rules form keys | HC-4 · custom-dialogs PR 2 (the start code shows `OYS_EDITOR.notices`) |
| HC-9 | Event codes | migration `createEventCodes`, admin sub-tab, redeem card, `hc-redeem` | HC-6 |

Suggested global order: custom-dialogs PR 0 + PR 1 → HC-1 → HC-2 → premium-domains PR 1 (Premium ready, branding) →
code-slots-admin PR 1 → HC-3 → code-slots-admin PR 2–4 (`code_more`) and status-pages PR 4 (`status_page`) → HC-4 →
HC-5 → custom-dialogs PR 2, PR 5a, PR 5b → HC-6 → HC-7 (admins can switch on Premium options; status-pages PR 7 can
register its packs) → HC-8 → HC-9.

### 9.2 Later steps (each only after the owner approves it, Q8)

| Step | Content | Notes |
|---|---|---|
| L1 Referrals | §3.3, §4.7: invite card, register hook and line, confirmation mail, network keys, cap 3 / 30 days, review sub-tab, privacy text | needs HC-6, HC-7 |
| L2 Visitor milestones + anniversary | `stats_visitors` with the local day key, `POST /_/v` counting, tiers 100…10,000, "at most one tier per day" = `NOT EXISTS (SELECT 1 FROM honeycomb_ledger WHERE user_id=? AND reason='visitors' AND created_at >= <today 00:00>)` under the account lock; anniversary pays **only the latest completed year, and only if that date is on or after the step's launch date** (stored as `honeycombs.anniversary_since`), so imported accounts get no back pay; both capped | the same day key could count code pages (Q8) |
| L3 Cosmetic unlocks | Honey theme, Bees particles, Gold ring (CSS + server-side gating in `themeKey`/`settingsNormalize`; the preview may show them, saving enforces) | public page renderer changes |
| L4 Address passes, storage step | §3.6 "Proposed later" | address passes with code-slots-admin; storage only with the disk report |
| L5 Community rewards | §4.9 | builds on discord-pages' `hello` feature list and kept `author_id` |

### 9.3 What this design asks of the others (summary of §1.5)

- **custom-dialogs:** keep `notify(…, {db})` and the catalogue rows `honeycombs`/`unlock`; make the §5.8 row for team
  gifts bell-only; their retention job may register in the shared registry (§4.13).
- **code-slots-admin:** own `code_page` and `code_more` registrations (incl. bans in `canBuy`); call `buy()` or
  `purchaseUnlock(…, {requestId, expectedPrice})` and `grantFeature()`; read `has(…, db)`; prices only through
  `shopPrice()`; the 30-day address exemption is `isStaff()`, not bought Premium.
- **premium-domains:** `isStaff` rename, `E.premium`/`E.staff` switch and the ready flag in their PR 1; register the
  perks, `onPremiumChanged` (enforcer) and `premiumLossPreview`; a minimum account age before adding a domain; their
  5-minute job may register in the shared registry.
- **status-pages:** register `status_page` (their PR 4, after HC-3) and `status_more_checks` (stack 2) and
  `status_fast_checks` (their PR 7, after HC-7) with `canBuy`; use `has()`/`entitlement()`/`premiumState()`; their
  perk for Premium only if Q3 = yes. Their §4.10 already does all of this.
- **discord-pages:** nothing for v1; L5 would add the `link.v1` feature.

---

## 10. Open questions for the owner

| # | Question | Recommendation |
|---|---|---|
| Q1 | The OnYourSite logo is also a honeycomb icon. Should it turn yellow too? | **No** – only icons that mean the currency or the honeycomb area turn yellow; the logo keeps the brand colour. |
| Q2 | Default prices and rewards for v1: Premium 30/90 days = 350/900 (accounts ≥ 30 days, active on ≥ 10 days, no 7-day option); code page 100 (as today); more code pages 0 (code-slots-admin's question); status page 150, extra checks 60, fast checks 80 (status-pages); streak +15 every 7 days, +50 every 30 days; daily cap 300. | Start with these; all can be changed in the admin at any time. |
| Q3 | What does Premium include? Custom domains and no "Made with OnYourSite" for sure. Should it also include the status-page Premium limits ("Status page: 30 checks, checks every minute, 250 subscribers", status-pages §4.10)? | **Yes** – one clear Premium with everything "pro"; the status page module itself stays a separate unlock. |
| Q4 | Auto-renewal | **Off by default**; the user turns it on; it never pays more than the regular price the user agreed to – a price increase asks again. |
| Q5 | Reminder emails (custom-dialogs asks the same in its Q4 – one answer covers both) | Bell notifications at 7, 3 and 1 day(s); **one** email 3 days before and one when it ended; users can turn the emails off. |
| Q6 | Refunds | **Only by admins, only for the unused part** (time left, unused passes); auto-renewal stops with every refund. |
| Q7 | Confirm the base rules: honeycombs never expire, cannot be bought with money and cannot be sent to other users. | **Confirm.** |
| Q8 | Which extras should follow v1? (a) invite friends (email confirmation, max 3 paid per 30 days, 30 + 10 honeycombs); (b) visitor milestones (each person once a day, code pages included) and a yearly anniversary bonus; (c) paid cosmetics (new Honey theme, Bees particles, Gold ring – existing ones stay free); (d) address passes; (e) extra storage for good; (f) honeycombs for accepted Discord suggestions. | **(b) and (a) first, then (c)**; (d) only together with the code-page address rules; (e) only after a disk report shows room; (f) only with a record of who accepted. |
| Q9 | Trial offers for Premium (e.g. "30 days for 100, once per user") | **Allowed, but only for accounts at least 30 days old** (enforced by the system); no free 7-day trials. |

---

## 11. Review changes

Revision of 2026-11-01 after the review with 26 findings (3 blocker, 12 major, 11 minor). Every finding was checked
against the code and the other designs before it was applied. Line numbers in the findings refer to the previous
version (kept as `$S/backup/honeycomb-shop.md.before-review`) and to the other designs as they were before their own
revisions.

### 11.1 What changed, per finding

| # | Finding | Change (where) |
|---|---|---|
| 1 | Designs disagree on where "owns an unlock" is stored | `hc_entitlements` is what everyone reads. Every permanent unlock, bought or granted, writes `unlock/<feature>` (−price or 0) in the same transaction (`grantUnlock`); a re-unlock after a refund uses `unlock/<feature>:<n>`. `purchaseUnlock()` and `shopPrice()` are wrappers over `buy()`/`quote()`. The backfill covers all `unlock/*` rows. (§0, §1.5, §3.4, §3.7, §4.3, §4.4) |
| 2 | Premium contradicts premium-domains, code-slots-admin, status-pages | Adopted premium-domains' split: Premium = the registered perks only; page limit, quota and cooldown stay `isStaff`. `users.premium_until` is written in the same transaction as the entitlement; "for good" = `permanent = 1` and the far-future value, never NULL. `E.premium` stays a boolean; `E.premiumUntil`/`E.premiumForever` added. `onPremiumChanged` = the `premium` enforcer; loss-preview lines in reminders. One perk list via `registerPerk()`. Q3 (page cap) dropped; the old Q4 (paused extra pages) is gone because Premium no longer adds pages. (§0, §1.3, §3.6, §4.4, §4.11, §10) |
| 3 | HC-2 switches code access before anything writes entitlements | HC-2 makes every writer of `unlock/*` (`hcSpend`, admin free unlock, any `hcAdd(…,'unlock',…)`) write the entitlement too, and `has()` falls back to the ledger row when no entitlement exists. DB tests added. (§4.4, §7.2, §9.1) |
| 4 | Refund does not stop auto-renewal; renewal ids replay refunded purchases | Refund and revoke turn auto-renew off and tell the user; a replay succeeds only for the same item and an unrefunded purchase, otherwise 409; auto ids come from `renew_seq`; the renewal notification commits with the purchase; DB tests (a)/(b). (§4.3, §4.5, §4.13, §7.2) |
| 5 | Refund rules wrong for timed, consumable, offer purchases | Unused-part rule for timed periods (ended → no cut) with shifting of later periods; consumables refund only unused units; `IF(quantity > ?, …)`; refunded purchases keep counting for `per_user_max` and `uses` (one consistent rule); `remove` is an explicit choice. (§4.5, §5.3) |
| 6 | Auto-renewal charges any new price and retries after expiry | `renew_max_price` (the regular price confirmed when turning auto-renew on); above it → no charge, one notice per period; retries stop at `expires_at`. (§2.1 U10, §4.3, §4.13) |
| 7 | Admin feature grants not idempotent, not in the ledger, break expiry state | 0-amount `grant`/`revoke` ledger rows with `g…`/`v…` refs as double-submit guard and history line; extension from `max(now, expires_at)`; one `setPeriod()` resets `reminded`, `expiry_done_at`, `renew_failed_at`. (§3.7, §4.4, §4.5) |
| 8 | Lock on every dashboard load; two connections per enforcer | Earning: 10-second throttle, reads before the lock, `NOWAIT`. Connection rule (never a second pool connection while holding one; `db` passed into reads, `notify()`, `canBuy()`, loss previews); enforcers run without a shop-held lock and never inside a held connection. Connection budget for 16 vCores in §8.3. (§4.2, §4.4, §4.6, §8.3) |
| 9 | Enforcer runs can be lost | Durable reconcile marker (`hc_accounts.reconcile_at/gen`) in the same transaction as every entitlement or role change; the request tries inline enforcers once, the job retries all until success; slow enforcers only in the job. (§4.4, §4.13) |
| 10 | Referral farming | Referrals moved out of v1 (L1). For later: cap 3 per 30 days, everything above or flagged → review; confirmed email for the invited account; network keys of both accounts compared on every day while pending; payouts 30 + 10. (§4.7, §9.2) |
| 11 | Cheap/trial Premium fills the 100 custom hostnames | `min_account_days`/`min_active_days` on items and offers; Premium floor 30 days, default 10 active days; no 7-day Premium; trials only for accounts ≥ 30 days; premium-domains asked for a minimum account age. (§3.2, §3.6, §4.3, §4.12, §6.1, Q9) |
| 12 | Time-limited storage becomes permanent | `storage_boost` removed from v1; a later permanent, capped `storage_step` needs the disk report first. (§3.6, §8.2, Q8) |
| 13 | Catalogue items disagree with their owners | One catalogue table; each owner registers its feature incl. `canBuy` (bans). code-slots-admin has since replaced `code_slot` with `code_more` (permanent, default 0, their §9.2), and this design follows it, with `freeAtZero`. `page_slot` dropped, together with the U9/V1/Q4 texts about paused extra pages. Status packs as status-pages defined them, with stackable lots. All prices in `hc_items`, read through `quote()`/`shopPrice()` (mirrored to `oys_meta` only for the PHP rollback). (§3.6, §1.5) |
| 14 | Interface with custom-dialogs does not match | Follows custom-dialogs' **current** text, which changed while both designs were revised (see §11.2): notices `{tone, text, title?, amount?, action?}` (≤ 3 per answer, bootstrap ≤ 12); bell types `honeycombs` and `unlock`; the tab as the deep-link target incl. `/<feature>`; tokens `--hc*` from their `ui.css`; `.toast.hc` left alone; the purchase dialog on `OYSUI.confirm` with `content`/`ctl.update`; one channel per event (no second dashboard notice; e2e 5 fixed). Job notifications are written through `notify(…, {db})` in the transaction of the state change, so a rerun cannot duplicate them and a crash cannot lose them. custom-dialogs PR 5a is a hard dependency of HC-6 and HC-7. (§4.10, §4.14, §5.1, §5.2, §9.1) |
| 15 | HC-12 breaks the bot handshake, unaudited minting | HC-12 removed from v1 and kept as the later step L5. discord-pages now drops unknown `hello` features, so the handshake issue is gone. The remaining requirements are listed: record who decided, 8+ character codes with a global limit, a re-link rule. (§4.9, §9.2, Q8 f) |
| 16 | Anniversary pays past years | Later step L2 pays only the latest completed year and only on or after the launch date. (§9.2) |
| 17 | Timed items sold before reminders and auto-renew exist | `LIFECYCLE_READY` (HC-7): timed options cannot be switched on before, timed grants are refused, the auto-renew switch is hidden. (§3.6, §4.3, §4.12) |
| 18 | The Premium `ready` flag protects too little | While not ready, Premium is hidden completely (no card, no grant, no revoke, no "Get Premium" link, the old pill stays); premium-domains sets the flag in its PR 1 (listed in §1.5). (§4.4, §5.2) |
| 19 | Code tab skips the price check; replays not checked against the item | The code tab sends `request_id` (created when the dialog opens) and `expected_price`; replays must match the item, else 409; old scripts get 409 `reload`. (§4.3, §4.11, §5.2) |
| 20 | Bulk grants accept ambiguous identifiers | Only emails, `#id`, `@name`; a preview with resolved names before anything is booked. (§4.5, §5.3) |
| 21 | Visitor counting mixes UTC and local day | A separate `dayKey(ctx)` on the local date for L1/L2; code page views do not count in v1 (they lack the beacon's origin check), decision recorded with a later option. (§3.3, §4.6) |
| 22 | Installer and operations gaps | `--rollback` disables the timer; the runner exits 0 on an old schema; one shared `jobs:tick` runner in the registry custom-dialogs also proposes; per-mail timeout and a cap per run via the outbox. (§4.13, §8.1) |
| 23 | Unspecified or untestable parts | Watch rules defined (§3.5); "once per period" via the columns `renew_notified_for`/`renew_notified_kind`; deadlock retry inside `withAccount`; "one tier per day" query (L2); race tests with fixed pause points instead of repetitions. (§3.2, §3.5, §4.2, §4.13, §7.2, §9.2) |
| 24 | Smaller correctness issues | Capped rewards only inside the locked transaction; `seen_ledger_id` removed (no notices from the ledger any more); a frozen account gets the hold text on failed renewal; the audit stores ids only and loses the user id on deletion. (§3.2, §3.8, §4.6, §4.13) |
| 25 | UX, wording, missing states | Register line fixed (L1); ended banner dismissible; rate limits answer 200 `{ok:false}`; shop load error state; Premium card state defined (hidden until buyable); shop grid breakpoints described correctly. (§2.4, §4.7, §4.10, §5.2) |
| 26 | Scope creep | v1 = HC-1 … HC-7 + streaks/daily cap (HC-8) + event codes (HC-9); referrals, visitor milestones, anniversary, cosmetics, address passes, storage and community rewards → later steps after approval. (§0, §9) |

Also fixed while checking:
- citations: the pool size (`app/src/db.ts:74`, not `:38`) and the ledger DDL (`app/src/schema.ts:310-318`);
- the `withAccount` setup row now uses the same connection as the transaction;
- the PHP rollback (custom-dialogs' rule R): `editor.js` keeps the old modal and the `honeycombs.earned` toasts for
  the PHP view, `editor.css` uses token fallbacks, and the jobs timer is disabled;
- the other designs were revised at the same time, and this version matches their current text:
  - code-slots-admin: `code_more`, `has(…, db)`, `enforceSlots`;
  - status-pages: registration in their PR 4 and PR 7, `refreshStatusLimits`, their perk text;
  - custom-dialogs: see §11.2;
  - discord-pages: the forward-compatible `hello`.

  They are therefore cited by section, not by line.

PR numbers: HC-1 … HC-8 keep their topic, except that HC-8 lost visitor milestones and anniversary (now L2). The old
HC-9 (referrals) is L1, the old HC-10 (event codes) is HC-9, the old HC-11 (cosmetics) is L3, and the old HC-12 is L5.
Open questions are renumbered: the old Q3 (page cap) is dropped, the old Q4 (paused extra pages) no longer applies,
and the old Q8–Q11 are merged into Q8. Q3 (status perks in Premium) and Q9 (trials) are new.

### 11.2 Findings applied in a different form, and why

None of the 26 findings was rejected; all were confirmed against the code. These were applied differently from the
suggested fix:

- **#2, `E.premium`:** HC-2 does **not** switch `E.premium` to the user's real status itself. premium-domains PR 1
  does it together with `E.staff`, because the editor still uses `E.premium` for the page limit and the cooldown
  (`editor.js:593,694,2716,2768`). Switching it alone would wrongly limit impersonating admins until `E.staff` exists.
- **#2, "for good":** stored as the explicit flag `hc_entitlements.permanent` plus the value `'9999-12-31 23:59:59'` in
  `users.premium_until`, rather than an extra users column. premium-domains' check
  `isPremiumRow = is_admin || premium_until > now` and its SQL joins keep working unchanged.
- **#6:** `renew_max_price` is the **regular** price confirmed when turning auto-renew on, not the price paid. A user
  who bought during a sale would otherwise never be renewed.
- **#12:** the disk report for the admin overview is moved to the later storage step. v1 sells no storage and leaves
  the quota as it is.
- **#14, custom-dialogs' revision:** the review asked for the notice shape `{type, text, link?}`, the bell types
  `honeycombs`/`purchase`/`premium`, the token `--oys-honey` and `ref` on job notifications. custom-dialogs was revised
  at the same time and now defines different names:
  - notices `{tone, text, title?, amount?, action?}`;
  - the types `honeycombs` and `unlock`;
  - the tokens `--hc*` in its own `ui.css`;
  - a `notify()` with `{db}` but **without** `ref` de-duplication ("every job keeps its own idempotency state").

  This design follows the current custom-dialogs text, because two names for the same thing would break one of the
  two designs. The goal of the finding is still met: one shape, existing types and the owner's token. Exactly-once
  delivery comes from writing each notification in the transaction of its state change.
- **#14, one channel:** custom-dialogs §5.8 still lists team gifts as "bell and next visit's notices". This design
  keeps them bell-only, as the finding asks, and requests that row to be changed (§1.5, §4.14).
- **#15:** the review offered "drop HC-12 or move it to discord-pages". It is dropped from v1 but kept as the later
  shop step L5, because discord-pages has since made its handshake forward compatible and kept the data L5 needs.
- **#21:** code page views are decided as **not** counting in v1, for an anti-abuse reason. They are counted on every
  non-bot GET without the origin check of `/_/v` (`lib/codesites.php:325-328`).
- **#23:** "notify once per period" uses `renew_notified_for`/`renew_notified_kind`. A first draft of this revision
  used notification refs; custom-dialogs then dropped `ref`, so columns it is, as the finding suggested.

### 11.3 Remaining open questions for the owner

Q1 (logo colour), Q2 (default prices), Q3 (status-page perks in Premium), Q4–Q7 (auto-renew, reminder mails, refunds,
base rules), Q8 (which later extras, in which order) and Q9 (Premium trials) – see §10.
