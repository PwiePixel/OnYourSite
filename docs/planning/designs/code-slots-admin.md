# Code pages: page slots and the admin split

Feature design **code-slots-admin** for OnYourSite on Node.js (after the port). Scope: separate admin sections for
Honeycombs and Code pages, the slot model that lets a code page either have its own address or replace one of the
user's link pages, and the shared address registry that the slot model needs. Prices are coordinated with
*honeycomb-shop*. Dialogs and notifications come from *custom-dialogs*.

`$S` = the original development workspace (not in the repository, see ../README.md). File references point to
the PHP reference (`lib/`, `views/`, `static/`, `index.php`, `api.php`) or to `app/src` on `feature/node-typescript`
(4c90ed5). This is the revised version after review; §11 lists what changed.

---

## 0. Summary

- **Model.** Every account has its **page slots** (config `max_pages`, 3, as today) and **1 extra code page with its
  own address** (today's code page). Any page slot can show a **code page instead of its link page**. At most
  `max_on_pages` slots can do that (admin setting, default **1**), so an account has either *3 link pages + 1 code
  page* or *2 link pages + 2 code pages*. These are exactly the owner's two options.
- **"Connect"** means that the page slot keeps its address (`studio.on-your.site`) and visitors there see the code
  page. The link page of that slot is **kept and hidden**, so switching back is lossless. `on-your.site/studio`
  redirects to the subdomain, because code is never served on the main host. This reading is owner question 1.
- **Prices.** The first code page needs the existing `code_page` unlock. More code pages need the new unlock
  `code_more`, whose default price is **0**. At price 0 there is no unlock step, because the owner's option 2 already
  costs a link page. Admins can set a price later (owner question 3). Turning a page into a code page, switching back,
  moving and deleting are free.
- **Addresses.** One registry table, `site_addresses` (slug = primary key), covers link pages, code pages and later
  status pages. The database then keeps addresses unique across all kinds. Every released address that was in use
  for at least 7 days is **held for 30 days**: only its previous owner can take it again, and the 404 view stops
  offering it. This closes address takeover for every way an address can be freed.
- **Data.** `pages.code_site_id` (UNIQUE) marks a slot that shows a code page. Such a code page has
  `code_sites.slug = NULL`. `UNIQUE(user_id)` becomes `UNIQUE(own_user_id)` on a generated column, so the database
  still allows only one own-address code page per account. `code_sites` stores `file_count`/`bytes`. There are two
  migration steps (registry, code slots), and they get their numbers at merge time.
- **Concurrency.** All slot changes of an account run under one row lock (`users`) on **one** connection. Nothing
  inside the lock uses the pool, and lock waits are capped at 3 s. The tests run every slot operation with a pool of
  one connection and a strict guard against nested connections.
- **Admin.** "Honeycombs & code pages" splits into **Honeycombs** (`#honeycombs`; the shop builds on it) and **Code
  pages** (`#code-pages`): a list with filters, block/unblock, delete, a read-only source viewer, limits, per-user
  access (free unlocks, ban) and a moderation log. Every moderation action takes the owner's slot lock. Owners are
  notified through `notify()`.
- **Delivery.** Six PRs: admin split → address registry and hold → data model, routing and rollback safety
  (dormant) → editor API (dark: `max_on_pages` defaults to 0) → moderation → editor UI (sets the default to 1, and
  the feature goes live).

---

## 1. Goal and requirement

### 1.1 The owner's words

> „Außerdem will ich das im Admin bereich nun Honeycombs und CodePage getrennt wird da ich dies Updaten Will das man
> seine Code page entweder mit einer seiner Profil websiten verbinden kann oder eine externe macht."

> „Zwei möglichkeiten entwerder hat der user 3 Link websiten plus Code Seite oder er verbindet die Link website mit der
> Code Funktion und kann 2 Code websiten haben anstatt Profiel Website"

What this says: the admin area should show Honeycombs and the code page separately, because the code page is
changing. A user can either connect the code page with one of their profile (link) websites or make an external one.
There are two options. Either the user has 3 link websites plus a code page, or they connect a link website with the
code function and can then have 2 code websites instead of a profile website.

Two words are open to interpretation and go to the owner: "verbinden" (§1.3, owner question 1) and "extern" (owner
question 2).

### 1.2 Today (facts the design builds on)

| Fact | Where |
|---|---|
| Up to `max_pages` (3) link pages. Admins and admins impersonating a user (`oys_has_premium`) have no limit. | `lib/routes_app.php:346-351`, `:23-26`; `config.example.php:34` |
| Every account starts with exactly one page (created at sign-up). | `lib/routes_app.php:133` |
| One code page per account: `code_sites UNIQUE KEY uq_user (user_id)`. Creation relies on it against races. | `lib/schema.php:309`, `app/src/schema.ts:332`, `lib/codesites.php:91-109`, spec map-app §7.6 |
| Code pages and link pages share one address namespace, but the check is a plain read before the write. A race gives a 500 (spec map-app §4.4). | `lib/helpers.php:256-285` (code check at `:278-283`); `app/src/helpers.ts:75-76` |
| A released address (page deleted, address changed) is free at once. The 404 view advertises it: "This address is available … Claim it now". | `views/404.php:11`, `:70-94` |
| Code is served only on `slug.on-your.site`, inside a CSP sandbox without `allow-same-origin`. The path form redirects there. On a subdomain a link page wins over a code page. | `lib/codesites.php:1-16,241-330`; `index.php:75-90` (redirect `:77-80`), `:97-117` |
| One unlock for the code function: ledger `reason='unlock', ref='code_page'` at price `code_page` (100). | `lib/codesites.php:44-47`, `lib/honeycombs.php:5-14,146-159` |
| The editor API code family is account-scoped and uses `oys_code_site(userId) … LIMIT 1`. The editor sends no site id (`static/js/editor.js:2539,2575,2584,2599`). A blocked page refuses every change. | `lib/routes_app.php:244-321` (`:249`, `:293-295`) |
| Messages, bookings, notifications, weekly report and Discord id are account data, but their API actions sit behind "Create a page first.". Without `state.page` the editor skips Messages and Settings and never polls the bell. | `lib/routes_app.php:365-367`, `:467-553`; `static/js/editor.js:1028`, `:2696`, `:2860-2872` |
| Upload cleanup, account deletion and the preview token assume a single code page. The upload sweep runs on every upload and deletes unused uploads older than 2 days. | `lib/codesites.php:190-197,200-222,225-238`, `lib/pages.php:441-450`, `lib/uploads.php:36-51`, `lib/routes_app.php:334` |
| Node runs as **one process** with **one pool of 10 connections**. `transaction()` holds one connection until commit. mysql2 queues pool requests without a timeout. The per-session lock is in-process. | plan §0 item 6, risk 6; `app/src/db.ts:74`, `:161-173`; `app/src/web/session.ts:16-29` |
| Admin: one tab "Honeycombs & code pages". Code actions travel as `hc_action` and redirect to `#honeycombs`. All admin tabs render on every `/admin` request. | `views/admin.php:47-55,319-321,593-596,632`; `views/admin_honeycombs.php:15-18,90-133,143-161`; `lib/honeycombs.php:219-243` |
| Migrations are additive and numbered in `oys_meta.schema_version` (`SCHEMA_VERSION = 5`). discord-pages describes v6 and v7, and custom-dialogs "v7 if right after", so numbers are assigned in merge order. PHP must still run on a database Node has migrated (rollback, v5/v6 listed as PHP-compatible) until release 3.1 removes PHP. | `app/src/schema.ts:13,53-76`; plan §0 item 4, §5.6, §5.7; `discord-pages.md` §4 |

### 1.3 Interpretation: the slot model

**Terms used in the UI and in this document**

| Term | Meaning |
|---|---|
| **Page slot** | One of the account's page slots. Each slot is a `pages` row with its own address. |
| **Link page** | Today's profile page: blocks, design, stats, messages. |
| **Code page** | A website made of the user's own HTML/CSS/JS files (`code_sites` + `code_files`). |
| **Own address** (read as the owner's "extern", owner question 2) | A code page that does not use a page slot and has its own `slug` on on-your.site, like every code page today. At most one per account. |
| **On a page address** (owner: "mit einer Profil-Website verbinden") | A code page shown by a page slot instead of that slot's link page. It has no slug of its own and uses the slot's address. |
| **Held address** | A released address that is reserved for 30 days (rule 11). |

**Rules**

1. A page slot shows either its link page (the default) or a code page. While it shows a code page, its link page
   stays stored but is hidden (*parked*).
2. An account can have **one** code page with its own address and **`max_on_pages`** code pages on page addresses.
   `max_on_pages` is an admin setting with a range of 0–3. Its default is **1** from the release that ships the
   editor UI, which allows at most 2 code pages, matching "2 Code websiten". The PRs before it ship with default 0,
   so the new paths stay closed until moderation is complete (§9.1).
3. Page slots count against the account's page allowance (`pageAllowance()`, §4.2), and slots that show a code page
   count too. The owner's "instead of a profile website" is meant literally: the code page takes a link page's place.
4. **Addresses.** A code page on a page address answers at the slot's subdomain only (`studio.on-your.site`). The
   path form `on-your.site/studio` redirects to `https://studio.on-your.site/` (302, query dropped, the same as for
   own-address code pages today, `index.php:77-80`). `on-your.site/studio/kalender` gives the 404 view. The slot's
   `address_mode` stays stored and applies again after switching back.
5. **The replaced link page's data**: blocks, design, settings, uploads, stats history, messages and bookings stay.
   While parked, every public entry point of that link page acts as if the page did not exist: `/_/v`, `/_/c`,
   `/_/unlock`, `/_/go`, `/_/contact`, `/_/og`, `/kalender`, `/track-click` and `api.php?user=`. Messages already
   received stay in the inbox. The parked page cannot be edited until it is shown again.
6. **Switching back** ("Show the link page again") restores the link page at once. The code page then has to go
   somewhere:
   - it **moves to its own address**, which is possible only while the account has no own-address code page, and the
     user picks a free address;
   - or it is **deleted** after the user types its address.

   Both dialogs offer **"Download files"** (one JSON file with all files) before anything is deleted. There is no
   third "parked code page" state, so a code page never exists without an address.
7. **Moving.** An own-address code page can move onto a page address. Its old address is released and held for the
   user. A code page on a page address can move to its own address, and the slot's link page shows again. Moving is
   free.
8. **Blocked code pages are frozen.** The owner cannot edit, move or delete them and cannot switch the slot back.
   The address shows the 451 notice (`lib/codesites.php:257-261`) until an admin unblocks or deletes the code page.
   An admin delete shows the link page again.
9. **Prices** (honeycomb-shop catalogue, §9.2):

   | Item | Feature / ledger `ref` | Default | Kind |
   |---|---|---|---|
   | Unlock code pages: the first code page, with its own address or on a page address | `code_page` (exists) | 100 | permanent |
   | More code pages: every code page after the first, up to the limits | `code_more` (new) | **0** (owner question 3) | permanent |
   | Turn a page into a code page, switch back, move, delete | – | free | – |

   - While `code_more` costs 0, there is nothing to unlock.
   - A price change never affects existing code pages. It only decides whether creating another one needs the unlock.
   - Nothing is refunded:
     - when the team blocks or deletes a code page for breaking the rules (`views/terms-code-pages.php:177`);
     - when the user deletes a code page;
     - when the team changes limits for everyone (new terms sentence, §5.3).
   - Admins can unlock both for free.
10. **Page allowance and premium.**
    - `pageAllowance(ctx, user)` (§4.2) owns the page limit. Admins and admins acting as a user stay unlimited, as
      today.
    - Whether bought Premium or bought page slots raise the limit is decided together with honeycomb-shop (owner
      question 5).
    - The 30-day address rule belongs to link pages, and so does its exemption: `hasPremium` as honeycomb-shop
      defines it, plus its address pass. Page-address code pages use the same rule and the same flag.
11. **Released addresses are held.**
    - Addresses are released in these cases: a page is deleted, an address is changed, a code page is moved or
      deleted, an account is deleted, or an admin deletes a code page.
    - An address that was in use for at least 7 days stays reserved for 30 days after its release. Only the previous
      owner can take it again during that time. After an admin delete or an account deletion, nobody can.
    - Visitors see the plain 404 page, never "This address is available".

**How visitors reach everything.** Each link page, each code page on a page address and the own-address code page
answer at their own address. A slot's parked link page cannot be reached while its code page is shown (owner
question 1).

### 1.4 What stays the same

- Code pages are still files only, sandboxed, served with the same headers, the badge and the 405/451/404 notices
  (`lib/codesites.php:241-353`). The serving code is reused with one new parameter, the address slug.
- The address format rules (`slugProblem` texts, reserved names), the 30-day rule for page addresses, the terms
  acceptance and the honeycomb ledger semantics (`uq_entry`) do not change.
- `max_pages` stays in `config.json`. Users who never touch the new options see no difference, except that addresses
  they release are now held for them for 30 days.

### 1.5 Consequences for existing users and data

1. **Visitors:** nothing changes. Every existing code page keeps its address and becomes the account's "code page
   with its own address". All link pages stay link pages.
2. **Owners** keep their `code_page` unlock. They can add more code pages on page addresses (free by default), or
   move their existing code page onto a page address for free.
3. **Database:**
   - `code_sites.uq_user` is replaced by `uq_own` on the generated column `own_user_id`, which gives the same
     guarantee for own-address code pages.
   - `code_sites.slug` becomes nullable. `pages.code_site_id` is NULL everywhere.
   - `site_addresses` is filled from `pages` and `code_sites`, and the file counters from `code_files`.
   - No existing row changes its meaning.
4. **Editor tabs opened before the deploy** can still read (`code` without `site` loads the own-address code page).
   Every change from such a tab gets 409 "This tab is out of date. Please reload the editor." This covers
   `code-save`, `code-address`, the title and the Online switch. After one reload the tab runs the new editor, and
   nothing is ever written into a different code page.
5. **Admin bookmarks** to `/admin#honeycombs` still work. Code moderation moves to `/admin#code-pages`, and the old
   `hc_action=code_*` form posts are accepted for one release.
6. **Admins** keep unlimited page slots, but code limits apply to them too. They can raise limits or unlock for free.
7. **Accounts with one page** (every account at sign-up) can turn that page into a code page. Their inbox, bell,
   weekly report and Discord id keep working without a link page (§4.4, §5.1).
8. **Released addresses** are held for 30 days (rule 11). Today they are free at once.
9. **Rollback to PHP** (§3.4): `install.sh --rollback` refuses while code slots exist unless `--force` is given. The
   PHP tree that ships for rollback is patched so that it cannot delete uploads or break slots.

---

## 2. User stories and flows

### 2.1 Users

| # | Story | Flow | Empty / error / limit states |
|---|---|---|---|
| U1 | As a user without code pages, I unlock the code function. | Unchanged: Code tab → locked hero → "Unlock for 100 honeycombs" (`static/js/editor.js:2252-2301`). | Not enough honeycombs: button disabled, "N more honeycombs needed". Terms not accepted: checkbox required. Banned: banned panel instead. |
| U2 | I create my first code page with its own address. | Code tab → "Create your code page" → card **Its own address** → address + name → "Create code page". | Address errors (`slugProblem` texts; a held address is "already taken"). Creation paused by the team. |
| U3 | I put my first code page on one of my page addresses. | Code tab → card **On one of your pages** → pick a link page → warning → "Create code page". Or Settings → Your pages → row → "Turn into a code page". When that page is the one being edited and has unsaved changes, the leave guard asks first. | Limit reached ("Only one of your pages can show a code page."). Slot already shows code. The page has a custom domain ("Remove the custom domain of this page first – custom domains work for link pages only."). |
| U4 | I want **2 code pages** (owner option 2). | With one code page, choose "On one of your pages" (U3). If the first one is on a page address, "Its own address" (U2) also works. While `code_more` costs 0 there is no extra step. With a price, the dialog shows "You need more code pages for this. Unlock them once for N honeycombs." | `code_more` locked: 403 with `need:'code_more'`. Both kinds already used: the option is disabled with its reason. |
| U5 | I create a new page that is a code page right away. | "Create a new page" modal → type card **Code page** → address + name → "Create page". This creates a slot plus a code page in one step. | Page slots full ("You can create up to 3 pages."). Code limits as in U3/U4. |
| U6 | I switch a page back to its link page. | Settings → Your pages → code row → "Show link page", or Code tab → "Where it lives" → "Show link page again". A dialog offers **Give it its own address** (address input) or **Delete it** (type the address), plus "Download files". Confirm with "Show link page". | An own-address code page already exists: that option is disabled with a hint. Blocked code page: the action is hidden, with an explanation. Paused: "Give it its own address" is disabled; "Delete it" works. |
| U7 | I move my own-address code page onto a page address. | Code tab → "Where it lives" → "Move to one of your pages" → choose a link page → "Move code page". The old address is held for me for 30 days. | Limit reached. No link pages to choose. Blocked. Paused. Custom domain on the chosen page. |
| U8 | I delete a code page. | Code tab → "Where it lives" → "Delete code page" → typed confirmation, with "Download files" in the dialog. For a page-address code page this is the same as U6 "Delete it". | Blocked: refused. Wrong confirmation text. |
| U9 | I delete a page slot that shows a code page. | Settings → Your pages → trash → typed confirmation: "This deletes the code page and the saved link page with all its blocks, stats and messages." | Last page cannot be deleted (unchanged). Blocked code page: refused. |
| U10 | I switch between my sites. | The header page switcher lists link pages, code pages on page addresses and the own-address code page. Picking a code page runs the leave guard and then opens `/dashboard?site=ID#code`, the same way picking a link page reloads today (`goToPage`, `static/js/editor.js:575-580`). The editor always holds exactly one code page. | – |
| U11 | I change the address of a code page. | Own address: Code tab → Address, as today. Page address: the same panel, with the 30-day rule of link pages (`site.days_left`; Premium and the address pass as honeycomb-shop defines them). | "You can change your address again in N days." Address taken or held. Paused: "Code pages can’t move to a new address right now. Please try again later." |
| U12 | My code page was blocked or code pages were turned off for me. | Bell notification; clicking it opens `/dashboard?site=ID#code`. The Code tab shows the block box (existing) or the banned panel. For a page-address code page the box adds: "Your link page stays saved. You can show it again once the team has reviewed this code page." | Banned users can still view their code pages and delete those that are not blocked. |
| U13 | All my pages show code pages (for example, my only page). | `/dashboard` opens the Code tab. Content, Design and Stats show "Your pages show code pages" with "Open code pages", plus "Create page" while a slot is free. Messages, the bell and Settings work as before: Your pages, Notifications (weekly report), Integrations (Discord id), email and password. | Weekly report: accounts with nothing to report are skipped, not counted as failed. "Send test report" answers "There’s no link page to report on yet." |
| U14 | I want an address back that I released. | Within 30 days I enter it again (new page, code page, address change), and it works for me. | Others get "Sorry, the address “x” is already taken." After 30 days it is free for everyone. |

### 2.2 Visitors

| # | Request | Result |
|---|---|---|
| V1 | `https://studio.on-your.site/…` (slot shows a code page) | The code page with all code headers. The path is handled by `codeServe` (`/kalender` is just a missing file → the code page's 404). |
| V2 | `https://on-your.site/studio` | 302 → `https://studio.on-your.site/`, query dropped. |
| V3 | `https://on-your.site/studio/kalender` | 404 view. |
| V4 | Old links into the parked link page: `/_/go/{block}`, the contact form, `/_/og/{id}-{hash}.png`, `/track-click`, `api.php?user=studio` | Not-found responses of the respective endpoint (404 view, `{"ok":false,"error":"This form is no longer available."}`, 404 image, `{"status":"success"}` without counting, `{"status":"error","message":"User not found."}`). |
| V5 | Code page offline or blocked | The existing notices, now also at slot addresses. |
| V6 | An address that was moved away from, deleted or renamed | The 404 view in its "Page not found" variant for 30 days (rule 11), never "This address is available – Claim it now". |

### 2.3 Admins

| # | Story | Flow |
|---|---|---|
| A1 | Find code pages quickly. | Admin → **Code pages** → stats cards, filter pills All / Online / Offline / Blocked / Own address / On a page address, and search. |
| A2 | Look at the code without running it. | Row → "Files" → `/admin?code_site=ID#code-pages` shows a read-only viewer (file list + escaped source in `<pre>`). This also works for offline and blocked pages. |
| A3 | Block or unblock with a reason. | Row or viewer → Block (reason) / Unblock. The owner gets a bell notification and the action is logged. |
| A4 | Delete a code page. | Row → Delete: a visible field "Type the address to confirm" (checked by the server), an optional reason and a `data-confirm` dialog. A page-address code page gives its slot back to the link page. The own address is held for nobody. Logged and notified. |
| A5 | Give access. | "Give code access" card: user + item (Code pages / More code pages) → "Unlock for free". Access table per user: Unlock for free, Unlock more for free, Ban (reason, "Also block all their code pages" ticked by default), Lift ban. |
| A6 | Tune limits. | "Limits" card: page addresses per account (0–3), files per code page, max file size, max size per code page, "Allow new code pages" switch. Next to the page-address limit the card shows how many accounts use page addresses and how many unlocked more code pages; saving asks with those numbers. |
| A7 | Change prices. | The Code pages section shows both prices read-only with a link to the Honeycombs section, where the shop edits them. |
| A8 | Manage honeycombs. | Admin → **Honeycombs**: Give honeycombs, earning rules, balances, latest activity. Code page parts are gone from it; the shop extends it. |

### 2.4 Eligibility (who may do what)

`canCreate(q, target, slot?)` and `canMove(q, to, slot?)` are pure functions (§4.2). The first failing rule wins.
`q` is read **inside** the slot lock (§4.2), so a ban or a pause that lands during a request is seen.

| # | Rule | Applies to | Error (HTTP) |
|---|---|---|---|
| E1 | Account banned | create, connect, move, save, address, unlock | "Code pages have been turned off for your account by the team" + (reason ? ": reason" : ".") (200) |
| E2 | `code_page` not unlocked | create, connect | "Unlock code pages with honeycombs first." (403, `need:'code_page'`, existing text) |
| E3 | Admin paused code pages | create, connect → "New code pages are paused right now. Please try again later."; move (both ways), address → "Code pages can’t move to a new address right now. Please try again later." | (200) |
| E4 | Own address already used | create own, move to own | "You already have a code page with its own address." (200) |
| E5 | `onPages >= max_on_pages` | connect (existing slot or new page), move to page | max 0: "Code pages can’t use your page addresses right now." Otherwise "Only one of your pages can show a code page." / "Up to N of your pages can show a code page." (200) |
| E6 | Page allowance used up (not admins) | connect as new page | "You can create up to N pages." (200, existing text) |
| E7 | The slot has a custom domain (premium-domains) | connect existing slot, move to page | "Remove the custom domain of this page first – custom domains work for link pages only." (200) |
| E8 | `total >= 1`, price of `code_more` > 0 and `code_more` not unlocked | create, connect | "Unlock more code pages with honeycombs first." (403, `need:'code_more'`) |

E7 applies from the PR in which premium-domains ships its column; before that no page has a custom domain. E8 comes
last, so nobody is asked to pay for something another rule refuses anyway.

---

## 3. Data model

### 3.1 Migration steps `siteAddresses` and `codeSlots`

There are two steps in `app/src/schema.ts`, shipped in PR 2 and PR 3. Each one takes the **next free schema version
when it merges**. discord-pages already describes v6 and v7, and custom-dialogs and the shop add steps too. So the
numbers are constants named after the step, assigned in merge order, and never written as literals anywhere else.
Tests import the constants (§7).

```ts
// Nummern werden beim Mergen vergeben (nächste freie Version, in der Reihenfolge der PRs). Die Werte sind nur ein
// Beispiel – nach discord-pages (6, 7). Tests verwenden ausschließlich diese Konstanten, nie Zahlen.
export const V_SITE_ADDRESSES = 8;
export const V_CODE_SLOTS = 9;
// SCHEMA_VERSION = die höchste vergebene Nummer
…
if (version < V_SITE_ADDRESSES) await createSiteAddresses(conn);
if (version < V_CODE_SLOTS) await createCodeSlots(conn);
```

Every statement is guarded, because MariaDB DDL is not transactional and a half-finished step reruns.

```ts
// Adressen aller Websites (Link-, Code- und später Statusseiten) in einer Tabelle: eindeutig über alle Arten.
// Freigegebene Adressen bleiben 30 Tage reserviert (kind = 'held').
async function createSiteAddresses(conn: PoolConnection): Promise<void> {
  await run(conn, `CREATE TABLE IF NOT EXISTS site_addresses (
        slug VARCHAR(63) NOT NULL PRIMARY KEY,
        kind VARCHAR(8) NOT NULL,
        ref_id INT NULL,
        user_id INT NULL,
        claimed_at DATETIME NOT NULL,
        released_at DATETIME NULL,
        KEY idx_ref (kind, ref_id),
        KEY idx_user (user_id),
        KEY idx_released (released_at)
    ) ${OPTS}`);
  // Bestand übernehmen. Bei alten Doppelungen (Wettlauf vor dieser Version) gewinnt die Link-Seite – sie wird auch
  // auf der Subdomain ausgeliefert (index.php:100-116)
  await run(conn, `INSERT IGNORE INTO site_addresses (slug, kind, ref_id, user_id, claimed_at)
        SELECT slug, 'page', id, user_id, COALESCE(slug_changed_at, created_at, NOW()) FROM pages`);
  await run(conn, `INSERT IGNORE INTO site_addresses (slug, kind, ref_id, user_id, claimed_at)
        SELECT slug, 'code', id, user_id, COALESCE(created_at, NOW()) FROM code_sites WHERE slug IS NOT NULL`);
}

// Code-Seiten auf Seitenadressen, mehrere Code-Seiten je Konto, Zähler, Moderation
async function createCodeSlots(conn: PoolConnection): Promise<void> {
  // Mehrere Code-Seiten je Konto: erst den einfachen Index anlegen, dann den eindeutigen entfernen
  await addIndex(conn, 'code_sites', 'idx_user', 'KEY idx_user (user_id)');
  await dropIndex(conn, 'code_sites', 'uq_user');
  // Eine Code-Seite auf einer Seitenadresse hat keine eigene Adresse (nur ändern, solange die Spalte NOT NULL ist)
  if (await columnIsNotNull(conn, 'code_sites', 'slug')) await run(conn, 'ALTER TABLE code_sites MODIFY slug VARCHAR(63) NULL');
  // Höchstens eine Code-Seite mit eigener Adresse je Konto – die Datenbank prüft das auch bei gleichzeitigen Anfragen
  await addColumn(conn, 'code_sites', 'own_user_id', 'INT AS (IF(slug IS NULL, NULL, user_id)) PERSISTENT');
  await addIndex(conn, 'code_sites', 'uq_own', 'UNIQUE KEY uq_own (own_user_id)');
  // Anzahl und Größe der Dateien (für die Admin-Liste, ohne bei jedem Aufruf alle Dateien zu summieren)
  await addColumn(conn, 'code_sites', 'file_count', 'SMALLINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn(conn, 'code_sites', 'bytes', 'INT UNSIGNED NOT NULL DEFAULT 0');
  await run(conn, `UPDATE code_sites s SET
        s.file_count = (SELECT COUNT(*) FROM code_files f WHERE f.site_id = s.id),
        s.bytes = (SELECT COALESCE(SUM(LENGTH(f.content)), 0) FROM code_files f WHERE f.site_id = s.id)`);
  // Seite zeigt eine Code-Seite statt ihrer Link-Seite (die Link-Seite bleibt gespeichert)
  await addColumn(conn, 'pages', 'code_site_id', 'INT NULL');
  await addIndex(conn, 'pages', 'uq_code_site', 'UNIQUE KEY uq_code_site (code_site_id)');
  // Moderation: Code-Funktion für ein Konto abschalten, Protokoll der Team-Aktionen
  await addColumn(conn, 'users', 'code_banned_at', 'DATETIME NULL');
  await addColumn(conn, 'users', 'code_ban_reason', 'VARCHAR(200) NULL');
  await run(conn, `CREATE TABLE IF NOT EXISTS code_moderation (
        id INT AUTO_INCREMENT PRIMARY KEY,
        site_id INT NULL,
        user_id INT NULL,
        admin_id INT NOT NULL,
        action VARCHAR(12) NOT NULL,
        address VARCHAR(100) NOT NULL DEFAULT '',
        reason VARCHAR(200) NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL,
        KEY idx_user (user_id, id),
        KEY idx_site (site_id, id)
    ) ${OPTS}`);
}

// Index vorhanden? / Spalte NOT NULL? (für wiederholbare Schritte)
async function hasIndex(conn: PoolConnection, table: string, name: string): Promise<boolean> {
  return (await rows(conn, `SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [name])).length > 0;
}
async function addIndex(conn: PoolConnection, table: string, name: string, definition: string): Promise<void> {
  if (!(await hasIndex(conn, table, name))) await run(conn, `ALTER TABLE \`${table}\` ADD ${definition}`);
}
async function dropIndex(conn: PoolConnection, table: string, name: string): Promise<void> {
  if (await hasIndex(conn, table, name)) await run(conn, `ALTER TABLE \`${table}\` DROP INDEX \`${name}\``);
}
async function columnIsNotNull(conn: PoolConnection, table: string, column: string): Promise<boolean> {
  const r = await rows(conn, `SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
  return r.length > 0 && r[0].Null === 'NO';
}
```

The same as plain DDL (MariaDB 10.11, Ubuntu 24.04):

```sql
-- siteAddresses
CREATE TABLE IF NOT EXISTS site_addresses ( … as above … ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO site_addresses … FROM pages;  INSERT IGNORE INTO site_addresses … FROM code_sites WHERE slug IS NOT NULL;
-- codeSlots
ALTER TABLE code_sites ADD KEY idx_user (user_id);
ALTER TABLE code_sites DROP INDEX uq_user;
ALTER TABLE code_sites MODIFY slug VARCHAR(63) NULL;                       -- only while Null = 'NO'
ALTER TABLE code_sites ADD COLUMN own_user_id INT AS (IF(slug IS NULL, NULL, user_id)) PERSISTENT;
ALTER TABLE code_sites ADD UNIQUE KEY uq_own (own_user_id);
ALTER TABLE code_sites ADD COLUMN file_count SMALLINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE code_sites ADD COLUMN bytes INT UNSIGNED NOT NULL DEFAULT 0;
UPDATE code_sites s SET s.file_count = (…), s.bytes = (…);
ALTER TABLE pages ADD COLUMN code_site_id INT NULL;
ALTER TABLE pages ADD UNIQUE KEY uq_code_site (code_site_id);
ALTER TABLE users ADD COLUMN code_banned_at DATETIME NULL;
ALTER TABLE users ADD COLUMN code_ban_reason VARCHAR(200) NULL;
CREATE TABLE IF NOT EXISTS code_moderation ( … as above … ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Notes:
- `site_addresses.kind` takes one of `page`, `code`, `status` (status-pages) or `held`. `ref_id` points into
  `pages`, `code_sites` or `status_pages`, and is NULL while held. `user_id` is NULL for an address held for nobody.
- `code_moderation.action` takes one of `block`, `unblock`, `delete`, `unlock`, `unlock_more`, `ban`, `unban`, `limits`.
  `user_id` is NULL for `limits` rows. `address` keeps the address at the time of the action, so the log stays
  readable after a deletion.
- The generated column has no NULL/NOT NULL clause, because MariaDB does not accept one on generated columns.
  `INSERT`s that list their columns, which all of them do (`lib/codesites.php:101`), are unaffected.
- On a fresh install, step 3 creates `uq_user` and `codeSlots` removes it, so the end state is the same.
- The step bodies are idempotent. If two features' numbers were ever swapped by mistake, running a step twice
  changes nothing.

Why the link lives in `pages.code_site_id` and not in `code_sites.page_id`: see §3.2.

### 3.2 Invariants and what enforces them

| Invariant | Enforced by |
|---|---|
| At most one own-address code page per account | `uq_own` (DB) |
| A code page is shown by at most one slot, and a slot shows at most one code page | `pages.uq_code_site` (DB) + `UPDATE … WHERE code_site_id IS NULL` with `changedRows === 1` |
| Every code page has exactly one address: `slug IS NOT NULL` or a page references it | All transitions in one transaction under the slot lock (§4.2). The PHP rollback tree cannot create a second address (§3.4). The admin list flags violations as "No address" with a Delete action. |
| `pages.code_site_id` points to a code page of the same user | Set only in slot operations that load both rows by `user_id`. Routing double-checks (§4.3). |
| `onPages ≤ max_on_pages`, `total ≤ 1 + max_on_pages`, slots ≤ allowance | Slot lock + counts on the locked connection. Safe across several Node processes. |
| An address belongs to one site of any kind, including held addresses | `site_addresses` primary key, written in the **same transaction** as the row that uses the address (`claimAddress`, §4.2). `pages.uq_slug` and `code_sites.uq_slug` stay as a second line of defence. `slugProblem` is only the friendly early check. |

**Duplicate keys are mapped by key name** (mysql2 `sqlMessage` "Duplicate entry 'x' for key 'uq_own'"; MySQL-style
`'code_sites.uq_own'` is accepted too):

| Key | Answer |
|---|---|
| `PRIMARY` (`site_addresses`), `uq_slug` (`pages`, `code_sites`) | "Sorry, the address “x” is already taken." (200) |
| `uq_own` | E4 "You already have a code page with its own address." (200) |
| `uq_code_site` | "This page already shows a code page." (200) |
| any other key | rethrown → 500, as today |

**Considered and not taken: `code_sites.page_id UNIQUE` + `CHECK((slug IS NULL) <> (page_id IS NULL))`.** The CHECK
would make "exactly one address" a database rule, and the transitions would become single-row updates. But the flag
"this slot shows code" is needed at about ten public entry points: subdomain, path mode, `/_/v`, `/_/c`, `/_/unlock`,
`/_/go`, `/_/contact`, `/_/og`, `/track-click`, `api.php`, the calendar, and premium-domains' host lookup. All of
them already load the `pages` row by `SELECT *`. With `pages.code_site_id` they get the flag for free, and no loader
can forget it. With `page_id`, every loader would need a JOIN, and one missed loader brings back a ghost endpoint.
The two invalid states the CHECK would prevent can only come from the PHP rollback tree or from manual SQL. §3.4
closes the rollback path, and the admin list shows any leftover. One own-address code page per account would need
the generated column in both models.

### 3.3 `oys_meta` settings

**New key `code_pages`** (plain JSON, written with default `json_encode` flags like `honeycombs`):

```json
{"max_on_pages":1,"max_files":30,"max_file_kb":256,"max_total_kb":2048,"paused":false}
```

| Key | Default | Clamp | Meaning |
|---|---|---|---|
| `max_on_pages` | 0 until PR 6, then 1 | 0–3, and at most `max_pages` | Page slots per account that may show a code page |
| `max_files` | 30 | 1–100 | Files per code page (was `OYS_CODE_MAX_FILES`) |
| `max_file_kb` | 256 | 16–1024 | Bytes per file / 1024 (was 262144) |
| `max_total_kb` | 2048 | 256–5120, raised to at least `max_file_kb` | Bytes per code page / 1024 (was 2097152) |
| `paused` | false | bool (`=== true`) | When true: no new code pages, and code pages cannot move to a new address (E3). Editing, title, online, deleting and "Show link page" with delete still work. |

Reading follows `hcSettingsFrom` (`is_numeric` → `intval` → clamp). A missing or broken row gives the defaults, which
are today's constants. Error texts keep their wording, and the defaults give PHP's exact output
(`lib/codesites.php:155-172`). Sizes are formatted as "256 KB" / "2 MB" / "2.5 MB". The defaults apply only while
the admin has not saved the form. An admin who saved `max_on_pages` before PR 6 keeps that value.

**Honeycomb prices.** `code_page` stays where it is (`oys_meta.honeycombs.code_page`, `lib/honeycombs.php:12`) until
the shop moves it. `code_more` is a catalogue item of honeycomb-shop (§9.2) with a default price of 0. If PR 4 merges
before the shop's catalogue, it adds `code_more: 0` to `hcDefaults()` and a row "Price: more code pages" to the
"How users earn them" form. The shop then moves both into its catalogue.

### 3.4 Existing data and PHP rollback

- **No row changes its meaning.** Existing code sites have a slug, so `own_user_id = user_id`. `uq_user` guaranteed
  uniqueness before, so `uq_own` cannot fail. `pages.code_site_id` is NULL for every row. Without a `code_pages` row
  the defaults apply. The registry and the counters are filled from existing rows.
- **Legacy collisions** (a page and a code site with the same slug, only possible through the old race): the page
  keeps the registry row. `sites:repair` (§8) lists the code site, and the admin list flags it "Hidden by the link
  page". The owner can give it another address.
- **Rollback to PHP** is possible until release 3.1 removes PHP (plan §5.6, §5.7), and plan §5.6 counts Wave 3
  databases as PHP-compatible. So this feature must be safe in PHP, not just "degrade". If it ships after PHP is
  removed, the PHP patches and the guard below are dropped from the PR.
  - **PR 3 patches the PHP tree that ships for rollback** (data safety only, about 20 lines):
    - `oys_code_site()` (`lib/codesites.php:18-23`) becomes `… WHERE user_id = ? AND slug IS NOT NULL ORDER BY id
      LIMIT 1`. PHP's whole code family then works only on the own-address code page, so PHP's `code-address` can
      never give a slug to a page-address code page (`lib/routes_app.php:310-317`). This is the "refuse `code-address`
      for a NULL slug" fix; no separate check is needed.
    - `oys_code_used_uploads()` (`:200-222`) collects uploads over **all** code sites of the user. Otherwise PHP's
      upload sweep (`lib/uploads.php:36-51`, run on every upload, `lib/routes_app.php:334`) deletes, after 2 days,
      every image that only the second code page uses.
    - `oys_code_delete_user()` (`:190-197`) deletes all code sites and their files.
    - `page-delete` (`lib/routes_app.php:445-460`) refuses a page whose row has a non-empty `code_site_id` with "This
      page shows a code page and can’t be deleted right now." This keeps PHP from orphaning a code page.
  - **`install.sh --rollback` refuses** while `SELECT COUNT(*) FROM pages WHERE code_site_id IS NOT NULL` > 0 or some
    user has more than one code site. The query errors before PR 3, and that counts as 0. The message names both
    counts and says that visitors would see the saved link pages instead of those code pages. `--force` rolls back
    anyway; the patches above keep the data safe.
  - What still differs in PHP during a rollback:
    - parked link pages are shown again, and their contact forms accept messages;
    - PHP ignores held addresses and does not write the registry;
    - PHP's admin list shows page-address code pages without an address.

    After rolling forward, `install.sh --update` runs `sites:repair` (§8), which rebuilds the registry and the
    counters from the tables. Parked pages are parked again, because `pages.code_site_id` was never touched.
- **The Node port before PR 3** has the same single-site helpers (`app/src/code/sites.ts:6,20-23`). PR 3 replaces
  them in the same PR that makes several code sites per user possible, so no Node version can see two code sites
  with single-site cleanup.

---

## 4. Server

### 4.1 Module layout (`app/src`)

```
content/
  addresses.ts    [new]    site_addresses: claimAddress, releaseAddress, releaseUserAddresses, addressOwner,
                           AddressTakenError; used by pages, code pages and status pages
  pages.ts        [change] createPage(…, db) claims its address; deletePage(page, db?) returns its files and releases
                           the address; loadPage/loadPageBySlug unchanged (SELECT * includes code_site_id)
code/
  sites.ts        [change] several code pages per account, address helpers, delete, cleanup over all code pages,
                           counters in codeWrite
  serve.ts        [change] codeServe(ctx, site, rawPath, slug) – slug = the address being served
  settings.ts     [new]    oys_meta 'code_pages': read, clamp, save, limits for the editor and the terms page
  slots.ts        [new]    quota, canCreate/canMove (pure), pageAllowance, withSlotLock, create/move/delete operations
  editorApi.ts    [new]    the whole /dashboard/api/code* family (moved out of app/editorApi.ts and extended)
  admin.ts        [new]    adminCodeHandle (POST code_action) + compatibility for hc_action=code_*
  adminView.ts    [new]    adminCodePagesTab(t: AdminTabContext) – the #code-pages section
  moderation.ts   [new]    logModeration(db, …), notifyOwner() (custom-dialogs notify())
  enforce.ts      [new]    enforceSlots(uid) for honeycomb-shop's enforcer registry (§9.2)
  terms.ts        [change] terms view shows limits and both prices from settings/catalogue
honeycombs/
  honeycombs.ts   [change] adminHcHandle loses code_block/code_unblock/code_unlock (moved to code/admin.ts)
  adminView.ts    [change] code pages list and the "Code page" balance column removed
admin/page.ts     [change] nav button + tab, dispatch of code_action, compat mapping, ADMIN_TABS entry,
                           Referrer-Policy: no-referrer; delete user releases addresses (held for nobody)
app/editorApi.ts  [change] preamble 409 for pages that show code; account-level actions before "Create a page first.";
                           delegate code*; page-create/page-delete under the slot lock; address claims/releases
app/auth.ts       [change] sign-up inserts the user and its first page in one transaction (address claim)
app/context.ts    [change] currentPage() skips slots that show a code page
app/dashboard.ts  [change] OYS_EDITOR: pages[].code, code summary, openSite, pagesUnlimited; preview pane without a link page
app/report.ts     [change] weekly report skips slots that show code; nothing to report = skipped, not failed
public/routes.ts  [change] serveSlot(); subdomain and path mode; /_/ endpoints and /track-click ignore parked link pages
public/api.ts     [change] api.php?user= ignores parked link pages
helpers.ts        [change] slugProblem(slug, exceptPageId?, exceptCodeId?, opts?) reads the registry (opts: userId, db,
                           exceptStatusId)
db.ts             [change] test knobs OYS_DB_POOL_SIZE and OYS_DB_STRICT (§4.2)
cli.ts            [change] sites:repair, sites:release <slug>
schema.ts         [change] the two migration steps (§3.1) + hasIndex/addIndex/dropIndex/columnIsNotNull;
                           ensureSchema({upTo}) for test fixtures
```

PHP rollback tree (PR 3 only): `lib/codesites.php` (three functions) and `lib/routes_app.php` (`page-delete`), §3.4.

Code comments are short and in German, like the existing files. Identifiers are in English. `code/editorApi.ts` and
`code/admin.ts` keep the dispatcher files small, which keeps merge conflicts with other Wave 3 PRs low. Functions that
read the database follow the port's convention `db: Db = poolDb` (`port/hc:app/src/code/sites.ts:45`).

### 4.2 Model functions (signatures)

```ts
// content/addresses.ts
export const ADDRESS_HOLD_DAYS = 30;      // so lange bleibt eine freigegebene Adresse reserviert
export const ADDRESS_HOLD_MIN_DAYS = 7;   // nur Adressen, die mindestens so lange benutzt wurden
export type AddressKind = 'page' | 'code' | 'status';
export class AddressTakenError extends Error { constructor(public slug: string) { super(slug); } }
// Adresse belegen – in der Transaktion, die auch die Seite/Code-Seite schreibt. Eigene, reservierte Adressen und
// abgelaufene Reservierungen werden übernommen; sonst AddressTakenError.
export function claimAddress(db: Db, slug: string, kind: AddressKind, refId: number, userId: number): Promise<void>;
// Adresse freigeben: mindestens 7 Tage benutzt → 30 Tage reserviert (für den Besitzer oder – 'nobody' – für niemanden),
// sonst sofort frei. Räumt dabei abgelaufene Reservierungen weg (höchstens 50 Zeilen).
export function releaseAddress(db: Db, slug: string, userId: number, holdFor?: 'owner' | 'nobody'): Promise<void>;
export function releaseUserAddresses(db: Db, userId: number): Promise<void>;     // Konto gelöscht: alle, für niemanden
export function addressBlocks(row: AddressRow, mine: AddressExcept): boolean;     // rein – Kern von slugProblem

// helpers.ts – bestehende Positionen bleiben; neu ist nur opts
export function slugProblem(slug: string, exceptPageId?: number | null, exceptCodeId?: number | null,
  opts?: { userId?: number | null; exceptStatusId?: number | null; db?: Db }): Promise<string | null>;

// code/sites.ts
export type CodeKind = 'own' | 'page';
export interface CodeAddress { kind: CodeKind; slug: string; slot: PageRow | null }
export function codeSites(uid: number, db?: Db): Promise<CodeSiteRow[]>;        // ORDER BY id
export function codeSite(uid: number, db?: Db): Promise<CodeSiteRow | null>;    // the own-address code page (slug IS NOT NULL ORDER BY id) – same meaning as before
export function codeSiteOfUser(uid: number, id: number, db?: Db, forUpdate?: boolean): Promise<CodeSiteRow | null>;
export function slotOfSite(siteId: number, db?: Db): Promise<PageRow | null>;   // SELECT * FROM pages WHERE code_site_id = ?
export function codeAddress(site: CodeSiteRow, slot?: PageRow | null): CodeAddress | null;  // null = no address
export function codeUrl(slug: string): string;                                   // scheme://slug.authority
export function codePreviewToken(site: CodeSiteRow, slug: string, at?: number): string;  // hmac('code-preview|id|slug|t'); old tokens stay valid
export function codePreviewValid(site: CodeSiteRow, slug: string, token: string): boolean;
export function codeForEditor(site: CodeSiteRow, addr: CodeAddress, daysLeft: number, db?: Db): Promise<CodeSiteEditor>;
export function codeSummaries(uid: number, db?: Db): Promise<CodeSiteSummary[]>;
export function codeSave(site: CodeSiteRow, files: CodeFileInput, deleted: unknown[]): Promise<string | null>;
                                  // eigene Transaktion wie heute; codeFiles, codeSettings und Zähler auf deren db;
                                  // prüft is_blocked und den Bann erneut nach SELECT … FOR UPDATE
export function codeDeleteRows(db: Db, site: CodeSiteRow): Promise<Set<string>>; // DELETE code_files + code_sites; returns the uploads they used
export function codeDeleteUser(db: Db, uid: number): Promise<void>;              // all code pages, ledger rows, moderation rows
export function codeUsedUploads(uid: number, db?: Db): Promise<Set<string>>;     // over all code pages (was one, :200-222)

// code/slots.ts
export interface PageAllowance { max: number; unlimited: boolean }
// Seitenplätze: max_pages (+ was honeycomb-shop verkauft/gibt, sobald entschieden – Frage 5); Admins unbegrenzt
export function pageAllowance(ctx: Ctx, user: UserRow, db?: Db): Promise<PageAllowance>;
export interface CodeQuota {
  unlocked: boolean; more: boolean; morePrice: number; banned: string | null; paused: boolean;
  own: number; onPages: number; total: number; maxOnPages: number;
  pagesUsed: number; pages: PageAllowance;
}
export interface CodeDenied { error: string; status: 200 | 403; need?: 'code_page' | 'code_more' }
export function codeQuota(user: SlotUser, ctx: Ctx, db: Db): Promise<CodeQuota>;
export function canCreate(q: CodeQuota, target: 'own' | 'page' | 'new-page', slot?: PageRow): CodeDenied | null;   // pure – §2.4
export function canMove(q: CodeQuota, to: 'own' | 'page', slot?: PageRow): CodeDenied | null;                     // pure
export class SlotBusyError extends Error {}   // → 200 "Your pages are busy right now – please try again in a moment."
export class SlotGoneError extends Error {}   // Konto während der Anfrage gelöscht → 409 reload
export function withSlotLock<T>(uid: number, fn: (db: Db, user: SlotUser) => Promise<T>): Promise<T>;
```

**The slot lock.** All changes to an account's slots, code pages and their addresses run under one row lock on
`users`, on one connection:

```ts
// Alle Änderungen an Seitenplätzen, Code-Seiten und Adressen eines Kontos laufen nacheinander – auch über mehrere
// Prozesse. REGEL: in fn nur über db abfragen, nie über den Pool. Wer eine Verbindung hält und auf eine zweite
// wartet, blockiert bei 10 gleichzeitigen Anfragen den ganzen Pool.
export async function withSlotLock<T>(uid: number, fn: (db: Db, user: SlotUser) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withConnection(async (db, conn) => {
        // Sperren höchstens 3 s abwarten (statt 50 s); vor der Rückgabe an den Pool zurücksetzen
        await conn.query('SET SESSION innodb_lock_wait_timeout = 3');
        try {
          await conn.beginTransaction();
          try {
            const user = await db.one<SlotUser>('SELECT id, is_admin, code_banned_at, code_ban_reason, code_terms_at FROM users WHERE id = ? FOR UPDATE', [uid]);
            if (!user) throw new SlotGoneError();
            const out = await fn(db, user);
            await conn.commit();
            return out;
          } catch (err) {
            await conn.rollback().catch(() => undefined);
            throw err;
          }
        } finally {
          await conn.query('SET SESSION innodb_lock_wait_timeout = DEFAULT');
        }
      });
    } catch (err) {
      // 1205 = Sperre nicht frei geworden, 1213 = Deadlock (einmal wiederholen)
      if (errno(err) === 1213 && attempt === 0) continue;
      if (errno(err) === 1205 || errno(err) === 1213) throw new SlotBusyError();
      throw err;
    }
  }
}
```

- If resetting the timeout fails, the connection is broken anyway, and mysql2 discards it instead of returning it to
  the pool.
- `fn` gets the **locked user row**. Ban, terms and admin flags are read from it, never from the row loaded at
  request start. A ban that commits while the request is running is therefore seen.
- **Everything inside `fn` goes through `db`.** This includes `slugProblem(…, {db})`, `codeSettings(db)`, the shop's
  `has`/`quantity` (`db` parameter, §9.2), `pageAllowance(…, db)`, `createPage(…, db)`, `deletePage(page, db)`,
  `codeDeleteRows(db, …)`, `claimAddress`/`releaseAddress` and `logModeration(db, …)`.
- These run **after** the commit, on the pool: `syncUsername`, `cleanupFiles`, `notify`, `rateHit` and the session
  write.
- Nothing inside the lock writes `users` through the pool. That would wait for the lock that the same request holds.
- **Lock order** in every operation: `users` → `pages` → `code_sites` → `site_addresses`. `code-save` locks only its
  `code_sites` row, and the link-page `address` action locks only `pages` → `site_addresses`, so no wait cycle can
  form.
- `deletePage(page, db)` runs its statements on `db` without its own transaction (PHP's `oys_delete_page` opens one,
  `lib/pages.php:467-479`). It returns the page's files, and the caller runs `cleanupFiles` after its commit. Called
  without `db`, it behaves as today.

**Guard rails in `db.ts` (tests only, no effect in production):**
- `OYS_DB_POOL_SIZE` (default 10) sets `connectionLimit`. The slot tests run with 1, where any nested pool query
  hangs and fails the test after 2 s.
- `OYS_DB_STRICT=1` makes `withConnection` remember the held connection in an `AsyncLocalStorage` (built into Node,
  no dependency). Asking for a second connection from the same async context then throws `NestedConnectionError` at
  once. The code-slots test files set it. The core team can turn it on for the whole suite, because it catches the
  same mistake anywhere.

`codeQuota` reads, in this order, all on the given `db`:
- `has(uid,'code_page')`, `has(uid,'code_more')`, the price of `code_more` (shop; before HC-2: `hcHas` on the ledger);
- ban and terms from the locked user row;
- `codeSettings(db)`;
- `SELECT COUNT(*) FROM code_sites WHERE user_id = ? AND slug IS NOT NULL` (own);
- `SELECT COUNT(*) FROM pages WHERE user_id = ? AND code_site_id IS NOT NULL` (onPages);
- `SELECT COUNT(*) FROM code_sites WHERE user_id = ?` (total);
- `SELECT COUNT(*) FROM pages WHERE user_id = ?` (pagesUsed);
- `pageAllowance(ctx, user, db)`.

**`claimAddress`** inserts first and resolves conflicts second. This avoids gap-lock deadlocks between two claims:

1. `INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES (…)`. Success means the address is
   claimed.
2. On `ER_DUP_ENTRY`, read the row with `SELECT kind, user_id, released_at FROM site_addresses WHERE slug = ? FOR
   UPDATE`.
3. If `kind = 'held'` and the hold is the caller's own (`user_id = userId`) or has expired (`released_at` older than
   30 days), take the address over with an `UPDATE` (`claimed_at` = now, `released_at` = NULL).
4. Otherwise throw `AddressTakenError`, which callers map to "Sorry, the address “x” is already taken."

**`releaseAddress`** decides between hold and delete:
- The row was claimed less than 7 days ago: `DELETE`. Short-lived addresses are not reserved, so creating and deleting
  pages cannot be used to squat addresses.
- Otherwise: `UPDATE … SET kind='held', ref_id=NULL, released_at=now, user_id=(owner ? user_id : NULL)`.
- Then `DELETE FROM site_addresses WHERE kind='held' AND released_at < now - 30 days LIMIT 50` removes expired
  holds, so no timer is needed.

**`slugProblem`** keeps its format checks and texts.
1. It reads `site_addresses` (on `opts.db` when given). The row blocks the address unless it belongs to the caller's
   own target: the page, code site or status page named by the `except…` ids, or a hold of `opts.userId`, or a hold
   that has expired.
2. It then keeps today's two table checks as a guard against drift (after a PHP rollback).

The 404 view (`views/404.php:11`) and sign-up call it without a user, so a held address counts as taken for them.
status-pages passes `opts.exceptStatusId` instead of a 4th positional parameter (§9.2).

### 4.3 Public routing

Only `public/routes.ts` and `public/api.ts` change. `router.ts` already sends the main host and subdomains there.

```ts
// Seitenadresse ausliefern: Link-Seite oder – wenn der Platz eine Code-Seite zeigt – die Code-Seite.
// Auch für eigene Domains (premium-domains ruft dies mit der Seite seines Hostnamens auf).
export async function serveSlot(ctx: Ctx, page: PageRow, sub: string): Promise<void> {
  if (page.code_site_id !== null) {
    const site = await codeSiteById(intval(page.code_site_id));
    // Kaputte Verbindung (nur durch Handarbeit in der DB möglich): wie eine unbekannte Adresse
    if (!site || intval(site.user_id) !== intval(page.user_id)) { ctx.status = 404; return notFound(ctx); }
    return codeServe(ctx, site, ctx.rawPath, phpStr(page.slug));
  }
  return servePage(ctx, page, sub);   // oys_serve_page wie bisher
}

// name.on-your.site
export async function subdomain(ctx: Ctx, slug: string, sub: string): Promise<void> {
  const page = await loadPageBySlug(slug);
  if (page) {
    if (page.code_site_id !== null) return serveSlot(ctx, page, sub);   // NEU: kein /kalender-, Weiterleitungs- oder Pfadmodus
    … wie bisher (index.php:101-112) …
  }
  const site = await codeSiteBySlug(slug);          // WHERE slug = ? – findet nur Code-Seiten mit eigener Adresse
  if (site) return codeServe(ctx, site, ctx.rawPath, phpStr(site.slug));
  … 404 …
}

// on-your.site/name[/kalender]
export async function pathProfile(ctx: Ctx, slug: string, sub: string): Promise<void> {
  const page = await loadPageBySlug(slug);
  if (page && page.code_site_id !== null) {
    if (sub === '') ctx.redirect(pageUrls(page).subdomain + '/', 302);   // Code nie auf der Hauptdomain
    ctx.status = 404; return notFound(ctx);
  }
  … wie bisher (index.php:76-90) …
}
```

**Parked link pages are invisible.** One helper, `isShownLinkPage(page) = page !== null && page.code_site_id === null`,
is used in:
- `publicBlock()`: a page that shows code returns null (`lib/routes_public.php:11-30`). This covers `/_/c`,
  `/_/unlock`, `/_/go` and `/_/contact`.
- `/_/v` (`:81-90`).
- `serveOg` (`/_/og`, `lib/share.php:44-46`), which answers 404.
- `/track-click` (`index.php:26-37`), which answers `{"status":"success"}` and records nothing for a parked page.
- `api.php?user=` (`api.php:16-20`), which answers `{"status":"error","message":"User not found."}`.
- `calendarAccess()`, reached only through `servePage`, which never runs for these pages.

**The 404 view's "Address available"** check (`slugProblem`) treats a slot address and a held address as taken.

### 4.4 Editor API (`/dashboard/api/{action}`)

**Preamble.** These changes slot into spec map-app §4.0 at the given steps:
- **Step 6** (requested page validated): if `page.code_site_id !== null` and the action is `save`, `preview`, `address`
  or `stats`, answer **409** `{"ok":false,"error":"This page now shows a code page. Please reload the editor.",
  "reload":true}`. This stops a stale tab from writing into a parked link page.
- **`currentPage()`** (`app/context.ts`, PHP `lib/routes_app.php:34-51`) only considers pages with
  `code_site_id === null`. A session `page_id` that points to such a page falls back to the first shown link page,
  or to null.
- **Account-level actions move before step 12** ("Create a page first.", `lib/routes_app.php:365-367`): `messages`,
  `message`, `booking-delete`, `weekly`, `weekly-test`, `discord` and `page-delete`.
  - `notifications` and `notifications-read` move as well, unless custom-dialogs PR 5 has already moved them
    (custom-dialogs §5.3).
  - Their bodies stay the same, except `weekly-test` (§4.7) and `page-delete` (§4.4.3).
  - Without this move, an account whose only page shows code gets 404 "Create a page first." for its inbox, bell and
    settings.
- **Step 9** (`code*` prefix) calls `codeApi(ctx, user, action, input, isPost)` from `code/editorApi.ts`. That branch
  always answers.

**Auth and CSRF.** These are unchanged and come from the preamble: no session → 401 JSON; POST without a valid
`X-CSRF-Token` → 419; broken JSON → 400.

**Input conventions.**
- `site` (POST `input.site`, GET `?site=`): `is_scalar && intval > 0`.
  - It is **required** on `code-save`, `code-address`, `code-move` and `code-delete`. When it is missing, the answer
    is **409** `{"ok":false,"error":"This tab is out of date. Please reload the editor.","reload":true}`.
    Pre-deploy tabs send no `site` (`static/js/editor.js:2539,2575,2584,2599`). Guessing a page for them would let a
    stale tab overwrite or rename another code page.
  - An unknown id or another user's id answers **409** `{"ok":false,"error":"This code page no longer exists. Please
    reload the editor.","reload":true}`.
  - Only the read-only `GET code` keeps a default without `site`: the own-address code page, or else the first
    page-address code page by id.
- `slot`: `'new'` or `intval > 0`.
- `slug`: `normalizeSlug` + `slugProblem` as today.
- `title`: `cleanText(…, 120)`, falling back to the slug.
- `confirm`: a string, trimmed, compared exactly.
- Array values where a scalar is expected count as invalid (plan §4.5).

**Rate limit.** The key `slots:<uid>` allows **20 successful changes per hour**, the same way
`attemptsAllowed`/`attemptFailed` count only what matters:
- `rateOk('slots:'+uid, 20, 3600)` runs before the slot lock. Over the limit: 200 `{"ok":false,"error":"Too many
  changes in a short time – please wait a moment."}`.
- `rateHit` runs only after a successful commit.
- Counted actions: `page-create`, `page-delete`, `code-create`, `code-connect`, `code-move`, `code-delete` and
  `code-address`.
- Refused attempts (taken addresses, rule errors) cost nothing. Concurrency is handled by the slot lock, not by the
  counter.

**Busy.** A lock wait over 3 s, or a deadlock after one retry, answers 200 `{"ok":false,"error":"Your pages are busy
right now – please try again in a moment.","busy":true}`.

#### 4.4.1 The state object (every successful `code*` response)

The key order keeps the five existing keys first (spec map-app §4.2).

```json
{
  "ok": true,
  "unlocked": true, "terms": true, "cost": 100, "balance": 140,
  "site": { "id": 7, "slug": "studio", "title": "Studio", "online": true, "blocked": false, "blocked_reason": "",
            "url": "https://studio.on-your.site", "preview": "https://studio.on-your.site/?oys-preview=1793…-…",
            "views": 12, "files": { "index.html": "…" },
            "limits": { "files": 30, "file": 262144, "total": 2097152, "types": ["html", "htm", "css", "js", "mjs", "json", "txt", "md", "svg", "xml", "webmanifest"] },
            "kind": "page", "slot": 42, "days_left": 12 },
  "sites": [ { "id": 3, "kind": "own",  "slug": "mia-dev", "url": "https://mia-dev.on-your.site", "title": "Dev",    "online": true, "blocked": false, "slot": null },
             { "id": 7, "kind": "page", "slug": "studio",  "url": "https://studio.on-your.site",  "title": "Studio", "online": true, "blocked": false, "slot": 42 } ],
  "slots": { "pages": { "used": 3, "max": 3, "unlimited": false }, "own": { "used": 1, "max": 1 }, "onPages": { "used": 1, "max": 1 } },
  "more": { "unlocked": true, "cost": 0 },
  "banned": null,
  "paused": false,
  "pages": [ { "id": 41, "slug": "mia", "title": "Mia", "url": "mia.on-your.site", "avatar": "", "code": null, "custom_domain": false },
             { "id": 42, "slug": "studio", "title": "Studio", "url": "studio.on-your.site", "avatar": "", "code": 7, "custom_domain": false } ]
}
```

- `site` is the selected code page. The fields up to `limits` are unchanged; `limits` now come from the settings.
  `kind`, `slot` and `days_left` are appended.
- `days_left` is the 30-day rule for the slot's address, computed by the same helper as the link page's
  `E.slugDaysLeft` (`views/dashboard.php:35`). It is 0 for own addresses and for users exempt from the rule.
- `more.cost` is 0 while extra code pages are free; then `more.unlocked` is true.
- `banned` is `{"reason":"…"}` when the account is banned.
- `pages` has the same shape as `OYS_EDITOR.pages` plus `code` and `custom_domain` (premium-domains; false before it
  ships). A page-address entry shows its subdomain URL.
- Errors: `{"ok":false,"error":"…"}`, plus `"need":"code_page"|"code_more"` for 403s, `"reload":true` for 409s and
  `"busy":true` for lock timeouts.

#### 4.4.2 Actions

| Action | Method | Input | Checks, in order | Side effects | Success |
|---|---|---|---|---|---|
| `code` | any | `?site` | site selection (409) | none | state |
| `code-unlock` | POST | `terms`, `item` = `code_page` (default) / `code_more` | non-POST 404 "Not found." → banned → terms (existing, `lib/routes_app.php:270-276`) → `code_more`: needs `code_page` (403), and the shop's `canBuy` from this feature refuses when no further code page is possible (`max_on_pages` 0 or paused: "More code pages aren’t available right now.") | shop `buy(…)` (fallback before the shop: `hcSpend`; idempotent through `uq_entry`; balance error "You need N honeycombs – you have M."). Price 0 → nothing to buy, answers the state. | state |
| `code-create` | POST | `slug`, `title`, `terms` | banned → terms → unlocked (403, existing) → `rateOk` → **slot lock**: E1–E8 for `own` from `codeQuota` → `slugProblem(slug, null, null, {userId, db})` | INSERT `code_sites` (slug set) + starter files (`lib/codesites.php:101-108`) + counters; `claimAddress(db, slug, 'code', id, uid)`. After commit: `rateHit`. | state (new site) |
| `code-connect` | POST | `slot` (page id or `'new'`), `slug` (only for `'new'`), `title`, `terms` | banned → terms → unlocked → `rateOk` → **slot lock**: page of this user `FOR UPDATE` with `code_site_id IS NULL` (404 "Page not found." / "This page already shows a code page."), then `canCreate(page, slot)` (incl. E7). For `'new'`: `canCreate(new-page)` + `slugProblem(slug, null, null, {userId, db})`. | `'new'`: `createPage(uid, slug, title, db)` (claims the address). INSERT `code_sites` (slug NULL) + starter files. `UPDATE pages SET code_site_id = ? WHERE id = ? AND code_site_id IS NULL`, with changedRows = 1 or rollback. After commit: `syncUsername` if this was the first page; `rateHit`. | state (new site) + `pages` |
| `code-save` | POST | `site` (required), `files`, `deleted`, `title`, `online` | site (409) → banned → blocked → as today (spec map-app §4.2 step 9) | `codeSave` in its own transaction: re-reads `is_blocked` and the ban after `SELECT … FOR UPDATE`, limits from the settings, stores `file_count`/`bytes`. When a page is already over a lowered limit, a save is still accepted if it does not add files or bytes. | state |
| `code-address` | POST | `site` (required), `slug` | site → banned → blocked → paused (E3) → `rateOk` → **slot lock**: re-read the site `FOR UPDATE` (blocked) → own: `slugProblem(slug, null, site.id, {userId, db})`. Page address: 30-day rule (same helper and flag as the link page's `address`, incl. the shop's address pass) → `slugProblem(slug, slot.id, site.id, {userId, db})` | own: `UPDATE code_sites SET slug`; claim the new address (`code`), release the old one (held for the owner). Page address: `UPDATE pages SET slug = ?, slug_changed_at = ?`; claim (`page`) and release in the same way. After commit: `syncUsername`, `rateHit`. | state |
| `code-move` | POST | `site` (required) and exactly one of `slot` (to a page) / `slug` (to its own address) | site → banned → blocked → paused (E3) → `rateOk` → **slot lock**: re-read the site `FOR UPDATE` (blocked → refuse). To a page: the site is own, the page is this user's shown link page, `canMove(page, slot)` (incl. E7). To own: the site is on a page, `canMove(own)`, `slugProblem(slug, null, site.id, {userId, db})`. Neither or both → "Choose where your code page should go." | To a page: `UPDATE code_sites SET slug = NULL`; `UPDATE pages SET code_site_id` (changedRows = 1); release the old own address (held for the owner). To own: `UPDATE pages SET code_site_id = NULL WHERE code_site_id = ?`; `UPDATE code_sites SET slug = ?`; claim (`code`). After commit: `rateHit`. | state + `pages` |
| `code-delete` | POST | `site` (required), `confirm` | site → blocked (existing text) → `confirm === address slug`, else "To confirm, please type the address of the code page." → `rateOk` → **slot lock**: re-read the site `FOR UPDATE` (blocked → refuse) | `UPDATE pages SET code_site_id = NULL WHERE code_site_id = ?`, then `codeDeleteRows`; own address: release it (held for the owner). After commit: `cleanupFiles(uid, usedUploads)`, `rateHit`. Banned users may delete. | state (default site) + `pages` |

The order `banned → terms → unlocked` keeps the existing order for `code-unlock`/`code-create` and adds the ban first.
The checks before the lock are the cheap early answers. The decisive checks run again inside the lock on the locked
rows, so double clicks, parallel tabs and a block or ban that lands during the request are all handled. `code_terms_at`
is written before the lock, through the pool, as today.

#### 4.4.3 Page actions that change

- **`page-create`**:
  - `rateOk('slots:'+uid)` runs first. **Under `withSlotLock`**, the count (on the locked connection) is compared
    with `pageAllowance(ctx, user, db)`, which replaces `premium`. Bought Premium therefore does not lift the limit
    unless honeycomb-shop and the owner decide so (question 5); today both are the same.
  - Then `slugProblem(slug, null, null, {userId, db})` and `createPage(uid, slug, title, db)`, which claims the
    address.
  - `ER_DUP_ENTRY` and `AddressTakenError` give the taken text instead of today's 500 (spec map-app §4.4).
  - After commit: session `page_id`, `syncUsername` for the first page, `rateHit`. The texts are unchanged.
- **`page-delete`** (`lib/routes_app.php:445-460`) now runs before "Create a page first.":
  - The cheap checks come first, in this order: the target is the user's page (404), "You can’t delete your last
    page." (it counts all slots), the typed confirmation, and for a code slot a blocked code page ("This page shows
    a code page that has been blocked by the team. It can’t be deleted right now.").
  - Then `rateOk`, and premium-domains' `beforePageRemoved(pageId)` once that feature ships.
  - **Slot lock**: re-read the target and, for a code slot, its code site `FOR UPDATE` (blocked → refuse). Then
    `codeDeleteRows`, `deletePage(target, db)` and `releaseAddress(db, slug, uid)` (held for the owner).
  - After commit: `cleanupFiles` covers both the page files and the code uploads; then `unset(page_id)`,
    `syncUsername` and `rateHit`.
- **`address`** (link pages, not otherwise changed): `UPDATE pages SET slug`, `claimAddress` for the new slug and
  `releaseAddress` for the old one run in one transaction. The shop's `consume(db, uid, 'address_pass')` joins that
  transaction (honeycomb-shop §4.4).
- **Sign-up** (`app/auth.ts`, `lib/routes_app.php:117-147`): the user insert and `createPage(…, db)` run in one
  transaction. A claim conflict rolls both back and shows "This email address or page address is already
  registered." Today a race there leaves a user without a page.

### 4.5 Dashboard bootstrap (`GET /dashboard`)

These changes go into `OYS_EDITOR` (spec map-app §10.4, `views/dashboard.php:14-43`). Existing keys keep their
meaning.

- `maxPages` is `pageAllowance().max`. The new **`pagesUnlimited`** is `pageAllowance().unlimited`. The editor uses
  it for the page limit instead of `E.premium` (`static/js/editor.js:593,694,716`).
- `premium` keeps its meaning (branding, and the exemption from the 30-day rule as defined by honeycomb-shop).
  `E.slugDaysLeft` (`views/dashboard.php:35`) and `editor.js:2768` stay on it.
- `pages[]` entries get `code` (code site id or null) and `custom_domain`. For a slot that shows code, `url` is its
  subdomain address and `title` is the code page's title.
- New `code`: `{unlocked, more: {unlocked, cost}, cost, terms, banned, paused, own, onPages, maxOnPages, sites:
  CodeSiteSummary[]}`. This lets the switcher and dialogs render without a request.
- New `openSite`: set when `?site=ID` is one of the user's code pages, or when `?page=ID` names a slot that shows
  code. The editor then opens the Code tab with that page. An unknown id is ignored.
- `#previewPane` stays visible when the user has a code page even without a shown link page (today it is hidden,
  `views/dashboard.php:188`). The editor's `codeLayout()` condition (`static/js/editor.js:2234`) drops `!state.page`.
- `$page` is null when every slot shows code. The "no page" box gets the variant from U13.

### 4.6 Admin

**`GET /admin`** (admin only, spec map-admin §1.1).
- It sends `Referrer-Policy: no-referrer`, and every link to a user site uses `rel="noopener noreferrer"`. A code page
  cannot use `document.referrer` to recognise a reviewer and hide its real content. Today the links use only
  `rel="noopener"` (`views/admin_honeycombs.php:103`).
- It takes these query parameters for the Code pages section:

| Param | Rule |
|---|---|
| `cs` | `all` (default) / `online` / `offline` / `blocked` / `own` / `page` – list filter |
| `csq` | search text, `cleanText(…, 60)`: LIKE on slug, slot slug, title, owner email/name |
| `code_site` | `intval` – opens the source viewer for this code page |
| `file` | a path checked with `codeValidPath`; default `index.html` |

All admin tabs render on every `/admin` request (`views/admin.php:593-596`), so the section reads only stored
counters. There are no per-row subqueries over `code_files` (today `views/admin_honeycombs.php:15-18`) and no
`SUM(LENGTH(content))`.

```sql
-- Liste (höchstens 200 Zeilen; darüber: "Showing 200 of N – narrow it down with the filter or search.")
SELECT s.id, s.user_id, s.slug, s.title, s.is_published, s.is_blocked, s.blocked_reason, s.views, s.file_count,
       s.bytes, s.updated_at, u.full_name, u.email, p.id AS slot_id, p.slug AS slot_slug
FROM code_sites s JOIN users u ON u.id = s.user_id LEFT JOIN pages p ON p.code_site_id = s.id
WHERE …filter… ORDER BY s.updated_at DESC, s.id DESC LIMIT 200;
-- Karten und Filterzahlen in einer Abfrage
SELECT COUNT(*) AS total, SUM(slug IS NULL) AS on_pages, SUM(is_blocked = 1) AS blocked,
       SUM(is_blocked = 0 AND is_published = 1) AS online, COALESCE(SUM(bytes), 0) AS bytes FROM code_sites;
```

The address column prints `slug` for own addresses and `slot_slug` for page addresses, never `https://.on-your.site`.
From PR 3 on, the list moved in PR 1 does this as well.

**`POST /admin`** with `code_action` is dispatched after `hc_action` and before `oys_action`, in the order of spec
map-admin §1.2. The CSRF field `csrf` is checked first, as for every admin form. The result maps to the flashes
`admin_success` / `admin_error`. The redirect goes to `/admin` + (`?code_site=ID` when the form came from the viewer)
+ `#code-pages`. **Every action that touches a user's code pages runs under that user's slot lock** (§4.2), re-reads
the rows `FOR UPDATE`, writes `code_moderation` on the same connection, and notifies after the commit.

| `code_action` | Fields | Effect | Flash |
|---|---|---|---|
| `settings` | `max_on_pages`, `max_files`, `max_file_kb`, `max_total_kb`, `paused` | `saveCodeSettings` (clamped, §3.3), log `limits` (user NULL) | "Code page settings saved." |
| `block` | `site_id`, `reason` | slot lock of the owner; no change when already blocked ("“{address}” is already blocked."); `UPDATE code_sites SET is_blocked = 1, blocked_reason = ?` (as `lib/honeycombs.php:219-229`) + log + notify | "“{address}” is blocked." |
| `unblock` | `site_id` | the same, reversed | "“{address}” is online again." |
| `delete` | `site_id`, `confirm`, `reason` | `confirm` (a visible text field) must equal the address slug. Slot lock of the owner; a page-address code page gives the slot back to its link page; `codeDeleteRows`; own address released and **held for nobody**; log; after commit uploads cleanup + notify | "“{address}” was deleted." / "“{address}” was deleted – the address shows the link page again." · error "To delete it, type the address “{address}”." |
| `unlock` | `user_id`, `item` = `code_page` / `code_more` | shop `grantFeature(…, permanent)`, or before the shop `hcAdd(uid, 0, 'unlock', item, 'Unlocked by the team')`; log | `code_page`: existing texts (`lib/honeycombs.php:231-243`). `code_more`: "More code pages unlocked for {name}." / "{name} had already unlocked more code pages." |
| `ban` | `user_id`, `reason`, `block_all` | slot lock of the user; `UPDATE users SET code_banned_at = now, code_ban_reason = ?`; with `block_all`, block every code page with the same reason. Log + one notification. | "{name} can no longer create or change code pages." + (" {n} code pages blocked." if any) |
| `unban` | `user_id` | slot lock; clears both columns; log + notify | "{name} can use code pages again." |

`{address}` is the code page's current address (its own slug or the slot's slug). Today's flash prints `site.slug`,
which would be empty for page addresses.

Errors: "Code page not found.", "Please choose a user." (existing texts).

**Compatibility (one release).** `hc_action` = `code_block` / `code_unblock` / `code_unlock` is mapped to `block` /
`unblock` / `unlock` (item `code_page`) and redirects to `#code-pages`. `adminHcHandle` no longer handles these cases.

**Notifications** go through custom-dialogs' `notify(userId, 'code', title, body, link, {ref})` (custom-dialogs §5.2).
`ref = 'cm' + moderationLogId`, so a retried request never notifies twice. The type `code` (icon `bx-code-alt`) is
already in their catalogue, so this feature adds no bell code. Before their PR 5 lands, the ported `notify` writes the
same row without `ref`. Titles are at most 190 and bodies at most 255 code points.

| Event | Title | Body | Link |
|---|---|---|---|
| block | Your code page was blocked | `{address}: {reason}` or `{address} broke the rules for code pages.` | `/dashboard?site=ID#code` |
| unblock | Your code page is online again | `{address}` | `/dashboard?site=ID#code` |
| delete | Your code page was deleted by the team | `{address}` + (`: {reason}`) | `/dashboard#code` |
| ban | Code pages are turned off for your account | `{reason}` or `Please contact us if you have questions.` | `/dashboard#code` |
| unban | You can use code pages again | – | `/dashboard#code` |

### 4.7 Other places that change

| Place | Change |
|---|---|
| `codeUsedUploads` / `usedFiles` | over **all** code pages of the user. Otherwise saving would delete images that only the second code page uses (`lib/pages.php:441-450`, `lib/codesites.php:200-222`). |
| `codeWrite` (`lib/codesites.php:146-187`) | already counts files and sums their sizes; it stores both in `code_sites.file_count` / `bytes` in the same transaction. |
| `codeDeleteUser` (admin "delete user", `views/admin.php:102`) | Runs in one transaction with the page deletions. It deletes every code page, the ledger rows and the user's `code_moderation` rows. Addresses become holds for nobody (`releaseUserAddresses`). This keeps the privacy promise (`views/privacy.php:202,213`) and still protects the old addresses for 30 days. |
| Weekly report (`lib/report.php:40`, `:87-89`, `:109-114`) | Skips slots that show code; their link stats are frozen. An account with nothing to report is **skipped**: not sent, not counted as failed, `weekly_report_sent_at` set. The run result becomes `{sent, failed, skipped}`. `weekly-test` then answers "There’s no link page to report on yet." instead of the mail-settings error. |
| `/track-click` (`index.php:26-37`) | records nothing for a parked link page (§4.3). |
| `syncUsername` | unchanged. A slot's slug is still the user's address. |
| `codeForEditor` / preview token | use the address slug: the slot's slug for page-address code pages. Own-address tokens are byte-identical to today. |
| Terms page `/terms/code-pages` | limits and both prices come from settings/catalogue; new texts (§5.3). |

### 4.8 Background jobs

None.
- Code limits are enforced on write.
- Expired address holds are pruned on every release.
- The moderation log is small. It is deleted per user with the account.
- `node app/dist/cli.js sites:repair` (§8) is a one-off command that the installer runs on `--update`. It is not a
  timer.

---

## 5. UI

The look is the existing editor and admin look. Only existing components are used: `.dd-*`, `.page-row`,
`.mode-card`, `.panel`, `.bdg`, `.btn-*`, `.icon-btn`, `openModal()`, the admin card/table/badge classes. The
honeycomb icons use the yellow style that honeycomb-shop introduces.

Dialogs come from custom-dialogs and use their names (custom-dialogs §6.2, §6.8, §6.9):
- `OYSUI.confirm({title, text, list, tone, ok, onConfirm})`;
- `OYSUI.prompt({title, text, label, match, transform:'slug', onConfirm})` for typed confirmations;
- `OYSUI.guard(…).confirm()` for unsaved changes;
- `data-confirm` on admin forms.

Forms with several fields keep the editor's `openModal()` (`static/js/editor.js:675-686`), which custom-dialogs
registers as a layer (their §7.1 row 11). Nothing here uses `alert()`, `confirm()` or `prompt()`.

### 5.1 Editor (`static/js/editor.js`, `static/css/editor.css`, dashboard view)

**Page switcher** (`renderPageMenu`, `static/js/editor.js:582-599`):

```
Your pages                                         2 / 3      ← .dd-head (counts all slots)
[avatar] Mia            mia.on-your.site             ✓        ← link page (.dd-item, current)
[</>]    Studio  CODE   studio.on-your.site                   ← slot that shows code: .ps-avatar with bx-code-alt, .bdg brand "Code"
──────────────────────────────────────────────────── .dd-sep
[+] Create a new page   With its own address and stats        ← unchanged; hidden when slots are full (E.pagesUnlimited)
──────────────────────────────────────────────────── .dd-sep  (only once code pages are unlocked or one exists)
Code page with its own address                     1 / 1      ← .dd-head
[</>]    Dev            mia-dev.on-your.site
[+] Create a code page  Its own address                       ← when allowed; otherwise a .px-3 py-2 text-xs text-gray-500 hint
```

- A code entry calls `goToCode(id)`. It first runs the leave guard (custom-dialogs §7.1 row 1, which replaces
  `confirm()` in `goToPage`). If the user leaves, it sets `leaving = true` and goes to `/dashboard?site=ID#code`.
- Like link pages, code pages are never swapped in place. The Code tab state is one object (`static/js/editor.js:2156`),
  and `setCodeState(res, true)` keeps `code.files` (`:2220-2228`). A late answer to a save of page A would otherwise
  land on page B.
- When the Code tab shows a code page, its entry is marked current.
- `E.pagesUnlimited` replaces `E.premium` in the three page-limit checks (`:593`, `:694`, `:716`).

**"Create a new page" modal** (`openNewPageModal`, `static/js/editor.js:692-720`). A `.mode-cards` row goes on top,
with the same component as Settings → Address (`static/js/editor.js:2703-2705`):
- **Link page**: "Links, socials and your design – with its own stats." This is the default.
- **Code page**: "Your own HTML, CSS and JavaScript at this address."
  - When it is not allowed, the card is dimmed (`opacity-50`, `aria-disabled`) and its reason (rule text from §2.4)
    sits under it. Examples: "Unlock code pages with honeycombs first", "Only one of your pages can show a code page".
  - When `code_more` has a price and is locked, a `.code-price` box shows "You need more code pages for this. Unlock
    them once for N honeycombs." with a progress bar (`.hc-bar`) and "Unlock for N" / "N more honeycombs needed". It
    calls `code-unlock {item:'code_more'}`.
  - The terms checkbox (`codeTermsHtml`) appears when the terms are not yet accepted.
- The fields stay as they are (address + name). The button reads "Create page".
- For a code page the modal calls `code-connect {slot:'new', slug, title, terms:true}` and then goes to
  `/dashboard?site=ID#code`.

**Settings → "Your pages"** (`renderSettings`, `static/js/editor.js:2708-2716`). Rows use `.page-row`:
- A link page: avatar, title, URL, then `Edit` (when not current), **"Turn into a code page"** (`.btn-secondary`,
  shown when `canCreate(page)` passes or fails only because of `code_more`; disabled with the E7 text when the page
  has a custom domain), and the trash button.
- A slot that shows code: a code icon, title + `.bdg brand` "Code page", small text "{address} · Your link page is
  saved and hidden", then **"Open code editor"**, **"Show link page"** and the trash button. A blocked code page shows
  `.bdg red` "Blocked" and hides "Show link page".
- The trash button uses custom-dialogs' page-delete prompt (their §7.1 row 8, PR 2). For a slot that shows code, this
  feature only changes the `text`: "This deletes the code page and the saved link page with all its blocks, stats and
  messages. This can’t be undone."

**Settings without a shown link page** (U13). `renderSettings` no longer reads `state.page.settings` unconditionally
(`static/js/editor.js:2696`). Without a page it renders only the account sections:
- **Your pages**;
- **Notifications**, with only the weekly-report row and "Send test report" (the per-page "Email me about new
  messages" switch belongs to a link page and is hidden);
- **Integrations** (Discord id).

The server-rendered email and password forms below `#settingsDynamic` show as today. `switchTab` (`:1028`) no longer
returns early for `messages` and `settings`. It still does for `content`, `design` and `stats`, which show the
`#noPageBox` variant. The bell is polled without a page. custom-dialogs PR 5 does this in its bell rewrite (their §7.1
row 14). If this feature's PR 6 lands first, it moves the two polling lines (`:2871-2872`) out of `if (state.page)`
itself.

**Code tab** (`renderCode`, `static/js/editor.js:2240-2246`):

| State | Content |
|---|---|
| Not unlocked | The existing hero (`codeLockedHtml`) with the price from the catalogue |
| Banned | `.panel` with `bx-block`: "Code pages are turned off for your account" + reason + "If you think this is a mistake, please contact us." Existing code pages are listed read-only with "Delete" (when not blocked). |
| Unlocked, no code page | `codeCreateHtml` (`static/js/editor.js:2303-2315`) with two `.mode-card`s: **Its own address** (the existing address + name form) and **On one of your pages** (a `<select class="field">` of the shown link pages + the warning "Visitors at {address} will see this code page instead of your link page. Your link page stays saved."). Then the terms and the "Create code page" button. Creating the first code page stays in place, as today. |
| Has code pages | The existing IDE (`renderCodeEditor`) for the selected page, plus the additions below |

IDE additions:
- **Head** (`renderCodeHead`, `static/js/editor.js:2365-2377`).
  - With more than one code page, the title becomes a `<select class="field">` of the code pages ("Dev –
    mia-dev.on-your.site", "Studio – studio.on-your.site"). Changing it calls `goToCode(id)`. It is disabled while
    `code.saving || code.loading`.
  - A kind badge follows: `.bdg` "Own address" or `.bdg brand` "On a page address" (title: "Replaces the link page of
    {address} – your link page is saved").
  - A "New code page" `.btn-secondary` appears when `canCreate` passes or only lacks `code_more`. It opens the create
    panel as a modal. On success it goes to `/dashboard?site=ID#code`.
- **Address panel**: unchanged for own addresses. For a page address, the hint reads "This is the address of your
  page. It can be changed every 30 days." and the read-only state uses `site.days_left`.
- **New full-width panel "Where it lives"** below the Name/Address grid:
  - Own address: "It has its own address." with `[Move to one of your pages]` and `[Delete code page]` (`.btn-ghost`,
    red text).
  - Page address: "It replaces the link page of {address}. Your link page is saved." with `[Show link page again]`
    and `[Delete code page]`.
  - Blocked: the panel is replaced by the block box (`static/js/editor.js:2376`) plus, for page addresses, "Your link
    page stays saved. You can show it again once the team has reviewed this code page."
- Every code request sends `site: code.st.site.id`: `code-save`, `code-address` and the online/title toggles
  (`static/js/editor.js:2539,2551-2604`).
- `codeSave` and `codeSettings` remember the site id they sent. An answer for another site id is dropped (defence
  in depth; with reload switching this cannot happen).
- Every operation that changes which code page the tab shows goes to `/dashboard?site=ID#code` (or `/dashboard#code`
  after a delete): connect, move, switch back and delete.

**Dialogs** (`openModal` with `.mode-card` choices and errors in `.text-sm.text-red-400`, or `OYSUI`):

1. **Turn this page into a code page** (`openModal`).
   - When the page is `state.page` and has unsaved changes, `guard.confirm()` asks first ("Leave without saving?" →
     Stay / Leave without saving), because the page becomes read-only.
   - Text: "Visitors at **{address}** will see a code page instead of your link page." / "Your link page – blocks,
     design, stats and messages – stays saved. You can switch back any time."
   - Choice between "Start a new code page" (with a Name field) and "Move “{title}” here" (small: "{own address}
     stops working"; only offered when an own-address code page exists and is not blocked).
   - The more-code-pages box and the terms appear when needed.
   - Buttons: Cancel / **Turn into a code page**. The call is `code-connect {slot, title}` or `code-move {site,
     slot}`, and then the editor goes to `/dashboard?site=ID#code`.
2. **Show your link page again** (`openModal`).
   - Text: "Visitors at **{address}** will see your link page again. What should happen to the code page “{title}”?"
   - Choice between "Give it its own address" (with an input `[____].on-your.site`) and "Delete it" (with "Type
     {slug} to confirm"). When an own-address code page already exists, or new addresses are paused, the first card
     is disabled with its reason.
   - A `.btn-ghost` **"Download files"** (`bx-download`) sits above the buttons.
   - Buttons: Cancel / **Show link page**. The call is `code-move {site, slug}` or `code-delete {site, confirm}`.
3. **Move your code page to one of your pages** (`openModal`): a page select (pages with a custom domain are
   disabled with the E7 text) + the same warning + "{own address} stops working. It stays reserved for you for 30
   days." The call is `code-move {site, slot}`.
4. **Delete code page** (`OYSUI.prompt`):
   - `title` "Delete code page?"
   - `text`: "{address} and all its files are deleted. This can’t be undone." + a "Download files" button passed as a
     DOM node (custom-dialogs §6.2 allows nodes)
   - `label` "Type {slug} to confirm", `match: slug`, `transform: 'slug'`, `tone: 'danger'`, `ok: 'Delete code page'`
   - `onConfirm` calls `code-delete`.

**"Download files"** fetches `code?site=ID` (the state already carries all files). If the page is open, it uses
`code.files`, which includes unsaved edits, and says so. It saves `{"address":"studio.on-your.site","exported":
"2026-11-01T20:14:00Z","files":{…}}` as `studio-code-2026-11-01.json` through a `Blob` and an `a[download]`. There is
no new dependency.

**Toasts** (`OYSUI.toast` once custom-dialogs PR 2 is in; until then the existing `toast()`):
- "{address} now shows your code page."
- "{address} shows your link page again."
- "Your code page moved to {address}."
- "Code page deleted."
- "More code pages unlocked – {n} honeycombs spent." (type `hc`)

**No shown link page** (`#noPageBox`, `views/dashboard.php:140-147`): title "Your pages show code pages", text "Show a
link page again or create a new page.", buttons "Open code pages" (`switchTab('code')`) and, when a slot is free,
"Create page".

**Deep links.** Bell items for code pages link to `/dashboard?site=ID#code`. custom-dialogs' `openLink` treats that
path as "another own path", so it runs `guard.confirm()` and navigates (their §6.10). The bootstrap's `openSite` then
opens that code page.

### 5.2 Admin (`admin/page.ts`, `honeycombs/adminView.ts`, `code/adminView.ts`)

**Navigation** (`views/admin.php:313-325`). Replace the one button with two, using the same markup:
- `nav-honeycombs`: `bx-hive` (yellow), label "Honeycombs";
- `nav-code-pages`: `bx-code-alt`, label "Code pages".

`ADMIN_TABS` (`views/admin.php:624-634`):
- `honeycombs: ['Honeycombs', 'border-yellow-400/30 bg-yellow-400/10 text-yellow-300']`;
- `'code-pages': ['Code pages', 'border-brand-500/30 bg-brand-500/10 text-brand-400']`.

`switchAdminTab` and the hash routing are unchanged (`#code-pages` → `tab-code-pages`).

**Honeycombs section after PR 1.** This is `views/admin_honeycombs.php` without lines 90-133 (code pages list) and
without the "Code page" column (`:143`, `:152-161`). It keeps Give honeycombs, How users earn them (still including
"Price: code page" until the shop moves prices), Balances and Latest activity. Honeycomb-shop owns this section from
then on.

**Code pages section** (`<div id="tab-code-pages" class="admin-tab-content max-w-5xl mx-auto space-y-8 hidden">`):

1. **Stat cards**: three cards in the markup of `views/admin.php:365-378`, all from the one counts query of §4.6:
   - "Code pages": total, small "{own} own address · {page} on page addresses";
   - "Online / offline / blocked";
   - "Storage": `SUM(bytes)` formatted with `kb()`.
2. **Two cards side by side** (`grid grid-cols-1 lg:grid-cols-2 gap-8`, card markup of
   `views/admin_honeycombs.php:37-41`):
   - **Limits** (`bx-slider-alt`): a `code_action=settings` form whose rows mirror the rule rows
     (`views/admin_honeycombs.php:78-83`):
     - "Pages per account that can show a code page" (0–3), with the hint "{a} accounts use page addresses now ·
       {b} accounts unlocked more code pages. Lower limits only stop new code pages – existing ones keep working.";
     - "Files per code page";
     - "Max file size (KB)";
     - "Max size per code page (KB)";
     - a switch "Allow new code pages".
     - The form has `data-confirm="Save the limits?"` with `data-confirm-text` = the same numbers, so they are in
       front of the admin before a lower value is saved.
     - Save button as in the existing forms.
   - **Prices** (`bx-hive` yellow): read-only "Unlock code pages: 100", "More code pages: free" (or the price), and a
     link "Change prices in Honeycombs" (`switchAdminTab('honeycombs')`).
3. **Give code access** (`bx-key`): a user select (the `all_users` order, as in the hc grant form) + an item select
   ("Code pages" / "More code pages") + "Unlock for free".
4. **Code pages list** (the markup of `views/admin_honeycombs.php:90-133`):
   - Header: count, filter pills `href="/admin?cs=<key>#code-pages"` with counts, styled like
     `views/admin_community.php:81` (`$btn`, active `!bg-white/10 !text-white`), a search form (`csq`) and the
     "Rules for code pages" link.
   - Row line 1: the address link (`target="_blank" rel="noopener noreferrer"`), a kind badge (`bg-white/10
     text-gray-400` "Own address" or `bg-brand-500/15 text-brand-400` "Page address"), a status badge
     (Online/Offline/Blocked as today), and "No address" or "Hidden by the link page" (red) when broken.
   - Row line 2: title · owner (email) · N files · size · views · changed; for page addresses "replaces the link page
     of {slot}".
   - Reason line when blocked.
   - Actions: `[Files]` (link to the viewer), Block (reason input) / Unblock, and Delete:

     ```html
     <form action="/admin" method="POST" class="m-0 flex flex-wrap gap-2"
           data-confirm="Delete “studio.on-your.site”?" data-confirm-ok="Delete code page" data-confirm-tone="danger"
           data-confirm-text="All its files are deleted. A page address shows its link page again. This can’t be undone.">
       <input type="hidden" name="csrf" …><input type="hidden" name="code_action" value="delete"><input type="hidden" name="site_id" value="7">
       <input type="text" name="confirm" required autocomplete="off" placeholder="Type studio to confirm" class="… !py-2 lg:!w-44">
       <input type="text" name="reason" maxlength="200" placeholder="Reason (the user sees it)" class="… !py-2 lg:!w-56">
       <button type="submit" class="… !text-red-400 hover:!bg-red-500/10"><i class='bx bx-trash'></i> Delete</button>
     </form>
     ```

     The typed field is visible and checked by the server. custom-dialogs' `data-confirm` has no typed variant (their
     §6.8), and none is needed.
5. **Source viewer** (only with `?code_site=ID`, rendered above the list):
   - A card titled "Files of {address}" + status badge + "Open site" (`rel="noopener noreferrer"`) + a close link
     (`/admin#code-pages`).
   - Body: `grid lg:grid-cols-[220px_1fr] gap-4`. On the left, the file list (`?code_site=ID&file=…#code-pages`,
     current one highlighted, sizes). On the right, `<pre class="bg-inputbg border border-bordercolor rounded-lg p-4
     text-xs text-gray-300 overflow-auto max-h-[60vh] whitespace-pre-wrap break-all">{e(content)}</pre>`.
   - Note: "Shown as plain text – nothing here runs the code."
   - The Block/Unblock/Delete forms repeat here.
6. **Access** (table markup of `views/admin_honeycombs.php:140-167`). Rows are users with an unlock, a code page or a
   ban. Columns:
   - User;
   - Code pages (count + addresses);
   - Unlocked: `Paid 100` / `Free` / `—` (shop entitlement source, before the shop the ledger amount);
   - More: Unlocked / Free for everyone / —;
   - Earlier blocks (from `code_moderation`);
   - Status (`Banned` badge + reason).
   - Actions: "Unlock for free", "Unlock more for free" (only while `code_more` has a price), Ban (a small form with a
     reason and the "Also block all their code pages" checkbox, checked by default, plus `data-confirm`) / "Lift ban".
   - The search input works like `hcFilter`.
7. **Moderation log** (`bx-history`): the last 25 entries, styled like Latest activity
   (`views/admin_honeycombs.php:170-187`), for example "Admin Pixel blocked mia-dev.on-your.site – Phishing ·
   Nov 1, 2026 20:14". Rows of deleted accounts are gone (§4.7).

### 5.3 Terms and privacy pages

`views/terms-code-pages.php` (Node `code/terms.ts`):
- Section 3, "Limits" (`:144`), reads the settings: "up to {files} files, {file} per file and {total} in total." A new
  bullet: "**Where it lives:** one code page can have its own address. Up to {n} of your pages can also show a code
  page instead of their link page – the link page is kept and you can switch back."
- Section 5 (`:172`): "Code pages are unlocked with honeycombs (currently {code_page})." When `code_more` has a price:
  "More code pages cost {code_more} once."
- A new bullet after `:177`: "An unlock stays with your account. Honeycombs are not refunded when you delete a code
  page yourself, or when we change the limits for everyone – code pages you already have keep working."
- A new bullet in section 3: "**Addresses:** when you move, rename or delete a code page, its old address stays
  reserved for you for 30 days, so nobody else can use it."
- "Last updated" (`:67`) is set to the release date.

`views/privacy.php` (Node view; sections 12 and 13, `:202`, `:213`):
- "When you delete your account, your addresses stay reserved for 30 days so nobody else can pose as you there.
  Nothing else is kept."
- "Notes our team writes when it reviews a code page are deleted with your account."

### 5.4 New texts (exact)

All error, flash, notification, dialog and toast texts are given in §2.4, §4.4, §4.6, §4.7 and §5.1. Apart from
those, the labels are:
- "Own address"
- "On a page address"
- "Page address"
- "Code page"
- "Turn into a code page"
- "Show link page"
- "Show link page again"
- "Open code editor"
- "Where it lives"
- "Move to one of your pages"
- "Delete code page"
- "Download files"
- "New code page"
- "Create a code page"
- "Code page with its own address"
- "More code pages"
- "Unlock more code pages" (unlock modal title; body "You unlock it once and keep it for good.")
- "Code pages", "Limits", "Prices", "Give code access", "Access", "Moderation log", "Files of {address}", "Allow new
  code pages", "Unlock more for free", "No address", "Hidden by the link page" (admin).

The honeycomb history text for `unlock/code_more` is "Unlocked more code pages" (in `hcDescribe`, coordinated with the
shop).

---

## 6. Security, abuse and limits

1. **Authorization.**
   - Every editor action loads code pages and slots with `user_id = current user`; a foreign id answers 409, so there
     is no IDOR.
   - Admin actions require `is_admin` (route gate) + the CSRF form field.
   - The editor API requires a session + `X-CSRF-Token` (419).
   - Impersonating admins act as the user. Their slot exemption stays as today.
2. **Origin isolation.**
   - Code runs only on `*.on-your.site` with `CSP: sandbox …` and no `allow-same-origin`, which gives an opaque
     origin: no cookies, no storage, no service workers. The main host never serves code; path mode redirects.
     Custom domains do not serve code pages in v1 (E7, owner question 7).
   - Switching a slot between link page and code page cannot carry state across, because the sandboxed origin is
     opaque.
   - Cache: link pages send no cache header and code pages send `no-cache, no-transform`, so a switch takes effect
     immediately.
3. **Ghost endpoints.** A parked link page's contact form, protected links, calendar, OG card, click counter and API
   entry are disabled (§4.3). Nobody can send messages or bookings to a page that visitors cannot see.
4. **Races, the connection pool and processes.**
   - The scarce resource is the pool of 10 connections in one Node process (`app/src/db.ts:74`), not CPU. **The rule:
     never wait for a second connection while holding one.** Every query inside `withSlotLock` uses the locked
     connection (§4.2). Lock waits are capped at 3 s and answered with "busy".
   - So neither of these can freeze the site any more:
     - ten parallel requests from one account in ten browsers (the session lock, `app/src/web/session.ts:16-29`, only
       serialises one session);
     - ten accounts at once.
   - The tests prove it with a pool of one connection and the strict guard (§7).
   - Slot changes of an account are serialized by a row lock on `users` inside one transaction. Uniqueness is
     guaranteed by `uq_own`, `uq_code_site`, `site_addresses` and the two `uq_slug` keys.
   - All locks live in the database, so the feature is correct with one process and would stay correct with several.
     The owner reports that the server now has 16 vCPUs. That changes nothing for this feature, because CPU is not its
     bottleneck. Whether Node should run several workers is a plan.md decision (plan §0 item 6, risk 6), not this
     feature's. If it ever happens, the installer must size MariaDB's `max_connections` (default 151) against
     workers × pool size.
   - The existing `code-save` row lock (`lib/codesites.php:126-128`) stays. Lock order is `users` → `pages` →
     `code_sites` → `site_addresses` in every slot operation. `code-save` locks only `code_sites`, so no deadlock
     cycle exists; a rare deadlock is retried once.
5. **Honeycomb exploits.**
   - Unlocks are idempotent (shop `buy` with a request id, or today's `uq_entry`) and are spent under the honeycomb
     lock (`lib/honeycombs.php:132-159`, shop `withAccount`). Double clicks and parallel tabs charge once.
   - `code_more` can only be bought when another code page is actually possible (`canBuy`).
   - No action refunds anything, and moving, switching and deleting are free, so there is no buy/refund loop and
     nothing to farm. Price changes never take away existing code pages.
   - Admin grants are amount 0.
6. **Moderation evasion.**
   - A blocked code page is frozen: no edit, move, delete or switch back (rule 8). The block state is re-read under
     the slot lock, and admin block/unblock/ban/delete take the same lock. A move or delete already in flight either
     commits before the block, so the admin then sees "Code page not found." or blocks the moved page, or it sees the
     block and is refused. A block can never be undone by a request that started earlier.
   - A ban stops all creation and editing. With "block all", it also takes every code page offline. The ban is read
     from the locked user row.
   - "Paused" also stops moves and address changes (E3), so code pages cannot rotate addresses during an abuse wave.
   - A blocked code page keeps occupying its place, so it cannot be swapped for a fresh one.
   - The admin source viewer works for offline and blocked pages. `/admin` sends `Referrer-Policy: no-referrer`, and
     its links to user sites use `rel="noopener noreferrer"`, so a code page cannot recognise reviewers by referrer.
7. **Address takeover.**
   - The brief requires "no domain takeover" (`BRIEF.md:51-52`). Every release point holds the address for 30 days:
     page delete, address change, code move/delete, admin delete, account deletion (rule 11, §4.2). Only the previous
     owner can take it back, and after an admin delete or an account deletion nobody can. The 404 view no longer
     advertises held addresses.
   - Addresses used for less than 7 days are not held, so creating and deleting pages cannot squat addresses.
   - A page-address code page has no slug of its own, so nothing stale remains.
   - Uniqueness across link pages, code pages and status pages is enforced by the `site_addresses` primary key in the
     writing transaction. A race between two users can no longer leave a code page hidden behind a link page.
   - Custom domains: a slot with a custom domain cannot show code in v1 (E7). Domain verification belongs to
     premium-domains.
8. **Admin viewer XSS.**
   - File contents are printed only through `e()` inside `<pre>`, never as HTML. The `file` parameter is checked with
     `codeValidPath`; ids are `intval`.
   - The admin page keeps `noindex, nofollow` (`views/admin.php:242`).
9. **Input and size limits.**
   - Slugs follow the existing rules. Titles go through `cleanText`.
   - Code limits are capped (§3.3) far below the 25 MB body limit (`app/src/server.ts:15`) and the MEDIUMTEXT
     capacity.
   - Rate limit: 20 successful slot changes per hour per user; refused attempts are free.
   - Notifications are cut to the column lengths.
10. **Private areas stay unindexed.** The editor and admin keep their `noindex`. Code notices keep
    `<meta name="robots" content="noindex">`.
11. **Privacy.** Moderation notes are deleted with the account (§4.7). Address holds after an account deletion store
    no user (`user_id` NULL). The privacy page says both (§5.3).

**Limits at a glance**

| Limit | Default | Configurable | Enforced at |
|---|---|---|---|
| Page slots per account | 3 | `config.json max_pages` (+ shop, question 5) | `page-create`, `code-connect {slot:'new'}` (admins unlimited) |
| Code pages with their own address | 1 | no | `uq_own` + `canCreate`/`canMove` |
| Pages that may show a code page | 1 (0 until PR 6) | admin 0–3 | `canCreate`/`canMove` under the slot lock |
| Code pages in total | 1 + previous row | – | implied |
| Files / file size / size per code page | 30 / 256 KB / 2 MB | admin (capped 100 / 1 MB / 5 MB) | `codeWrite` |
| Slot changes | 20 successful per hour | no | `rateOk`/`rateHit('slots:<uid>')` |
| Lock wait inside a slot change | 3 s | no | `withSlotLock` |
| Address change of a page-address code page | every 30 days (exemptions: honeycomb-shop) | no | `code-address` |
| Address hold | 30 days, for addresses used ≥ 7 days | no | `site_addresses` |

---

## 7. Tests

**Unit tests** (`app/test/codeSlots.test.ts`, `node:test`, no DB):
- `canCreate` / `canMove`: the full rule matrix of §2.4. It covers banned, locked, paused (create versus move/address),
  own taken, `max_on_pages` 0/1/2, page allowance full versus unlimited, custom domain, `code_more` price 0 versus
  > 0 and locked/unlocked, the first-failing-rule order, and the `need` field.
- `codeSettingsFrom`: missing row, garbage JSON, non-numeric values, clamping, `max_total_kb < max_file_kb`, `paused`
  only `true`, and the defaults equal to the old constants.
- The size formatting and limit messages: defaults byte-identical to PHP (`lib/codesites.php:155-172`, checked against
  `php -r`); 2560 KB → "2.5 MB".
- `codePreviewToken(site, site.slug)` equals the PHP token for own-address pages, using the existing vectors.
- The over-limit save rule: shrinking saves accepted, growing saves refused.
- Duplicate-key mapping for MariaDB (`'uq_own'`) and MySQL (`'code_sites.uq_own'`) messages; errno 1205/1213 →
  busy.
- `addressBlocks`: own target, own hold, someone else's hold, hold for nobody, expired hold, `exceptStatusId`.

**DB tests** (`app/test/codeSlots.db.test.ts`, `app/test/addresses.db.test.ts`, run through `$S/oys-db.sh run npm
test` with `OYS_DB_STRICT=1`; the pool tests also run with `OYS_DB_POOL_SIZE=1`):
- **Migration** (version numbers only through `V_SITE_ADDRESSES` / `V_CODE_SLOTS`, never literals; the fixture is
  migrated with `ensureSchema({upTo: V_CODE_SLOTS - 1})`):
  - fixture code sites migrate: `uq_user` gone, `idx_user`/`uq_own`/`uq_code_site` present, `slug` nullable,
    `own_user_id = user_id`, counters equal to the file sums;
  - the registry backfill, including a legacy page/code collision (the page keeps the row);
  - rerunning after a simulated crash between any two statements is idempotent, including the guarded `MODIFY`;
  - a fresh install reaches the same schema (`SHOW CREATE TABLE` compared).
- **Keys.** A second own-address code page for a user fails with `ER_DUP_ENTRY` on `uq_own`. Two page-address code
  pages (slug NULL) for one user are allowed. Pointing two pages at one code page fails. A slug in `site_addresses`
  blocks both a page and a code page of another user.
- **Pool discipline.** Every slot operation runs with a pool of **one** connection and finishes in under 2 s. The
  strict guard never fires. The operations are: `code-create`, `code-connect` (existing and new), `code-address` (both
  kinds), `code-move` (both ways), `code-delete` (both kinds), `page-create`, `page-delete` of a code slot, and admin
  block/unblock/delete/ban.
- **Concurrency**, each request on its own session and connection, with every losing request answered with its rule
  text **within 2 s**:
  - 10 parallel `code-connect` for one user (`max_on_pages = 1`): exactly 1 success, 9 × E5;
  - 10 users × `page-create` with an already taken slug: 10 × "already taken", nothing created;
  - user A `page-create x` against user B `code-move {slug:'x'}`: exactly one wins, the other gets the taken text;
  - parallel `code-create` + `code-move {slug}`: exactly one own-address page;
  - parallel `page-create` cannot exceed the allowance;
  - an admin block against an in-flight `code-delete`/`code-move`: never both commit as if unblocked.
- **Lock wait cap.** A test connection holds the user's row for 5 s, and a slot operation answers "busy" after about
  3 s. Afterwards the pooled connection's `innodb_lock_wait_timeout` is back to the default.
- **Lifecycle.**
  - Own → page → own keeps files, views and title. The released address is held for the owner, who can take it back.
  - Delete of a page-address code page: the slot is shown again with its blocks intact; uploads used only by the
    deleted code page are removed; uploads used by the other code page or by link pages are kept.
  - `codeDeleteUser` removes both code pages, the ledger and the moderation rows, and turns the addresses into holds
    for nobody.
- **Holds.** An address used ≥ 7 days is held after release. Another user and the 404 check see "taken" for 30 days,
  and after that it is free. An address used < 7 days is free at once. Expired holds are pruned on the next release.
- **PHP compatibility.**
  - The PHP unit tests (`tests/unit.php`) and the PHP code-site serving requests run against the migrated DB.
  - The **PHP upload sweep** for a user with an own-address and a page-address code page keeps the images of both.
  - PHP's `code-address` never touches the NULL-slug site, and PHP's `page-delete` refuses a code slot.

**HTTP tests** (`app/test/codeSlots.http.test.ts`; `makeTestCtx` for handlers, otherwise the test server against the
seed DB):
- **Routing.**
  - The subdomain of a code slot serves code with the CSP sandbox header and the badge.
  - `/kalender` there → the code page's 404.
  - Main host `/studio` → 302 to `https://studio.<base>/` with the query dropped; `/studio/kalender` → 404 view.
  - Other slots are unaffected.
  - Offline → 404 notice; blocked → 451.
  - A preview token on a slot address is valid; the own-address token works on the own address only.
  - The 404 view shows "Page not found" (not "This address is available") for a held address.
- **Parked page.** `/_/v`, `/_/c`, `/_/unlock`, `/_/go/{id}`, `/_/contact` (JSON and form), `/_/og/{id}-{hash}.png`,
  `/track-click` and `api.php?user=` all give the answers of §2.2 V4. No message, view or click row is written.
- **Editor API.**
  - Every new action covers 401 without a session, 419 without CSRF, 409 for a foreign or deleted `site`/`slot`, and
    validation errors.
  - Every rule of §2.4 with its exact text and status. Banned users can delete only.
  - A blocked page is immutable (save/address/move/delete refused). `page-delete` of a blocked slot is refused.
  - Rate limit: 20 successful changes, then the limit text; 30 refused attempts (taken addresses) do not count.
  - `code-unlock {item:'code_more'}`: at price 0 it answers the state without a ledger row. At a price: balance, a
    double click writes one ledger row, it requires `code_page`, and it is refused when `max_on_pages` is 0 or paused.
  - **Stale tab** (the old-contract scenario). Tab A, which sends no `site`, has `mia-dev` open. Through tab B's
    requests, `mia-dev` moves onto `studio` and `mia-lab` is created. Tab A's `code-save`, title, Online and
    `code-address` requests then get 409 `reload:true`. `mia-lab`'s files, title, online state and address are
    unchanged. `GET code` without `site` still answers, and the state starts with the five old keys in the old order.
  - **No shown link page.** With every slot showing code, `messages`, `message`, `booking-delete`, `notifications`,
    `notifications-read`, `weekly` and `discord` answer as before. `weekly-test` gives "There’s no link page to report
    on yet.", and `page-delete` works.
  - The preamble returns 409 for `save`/`preview`/`address`/`stats` on a slot that shows code.
- **Weekly report.** A run with an account whose slots all show code gives `skipped: 1, failed: 0`.
- **Admin.**
  - A non-admin gets 302 `/dashboard`; a missing CSRF gives the flash error.
  - Every `code_action` with its flash, DB rows, `code_moderation` row and notification row (with `ref`).
  - Delete without or with a wrong `confirm` field is refused.
  - `/admin` sends `Referrer-Policy: no-referrer`; user-site links carry `noreferrer`.
  - The compat `hc_action=code_block` still blocks and redirects to `#code-pages`.
  - Settings are clamped.
  - The viewer escapes `<script>` content (it appears as `&lt;script&gt;`) and rejects `file=../x`.
  - `?cs=` filters and counts.
  - A page-address code page is listed with its slot address, never `https://.on-your.site`.
- **Snapshots** (approved Node snapshots, plan §3.4 style) of the Honeycombs and Code pages sections after PR 1.
  PR 1 itself must leave the Honeycombs HTML identical apart from the removed parts.

**Playwright end-to-end** (new `tests/e2e/code-slots.js` and `tests/e2e/admin-code-pages.js`; `smoke_code.js` is
extended):
1. **Owner option 2, end to end.** Mia (enough honeycombs, `max_on_pages = 1`, `code_more` free):
   - unlocks → creates `mia-dev` → edits → opens `mia-dev.<base>` (sandbox: `document.cookie` empty);
   - turns `studio` into a code page → `studio.<base>` shows code; `<base>/studio` redirects;
   - the switcher shows both code pages, and switching reloads after the leave guard;
   - "Show link page" → "Give it its own address" is disabled → "Download files" saves a JSON with all files →
     deletes with typed confirmation → `studio.<base>` shows the original blocks again.
2. **Move and hold.** Own → page address, then back to a new own address. The old addresses give "Page not found".
   Mia can take `mia-dev` back; Tom (another account) cannot register it.
3. **New page as code page** from the "Create a new page" modal; slot limit reached → the card is disabled with its
   reason.
4. **Admin moderation.**
   - Filter → view the files of an offline page → block with a reason.
   - Mia sees the bell notification (it opens that code page) and the block box, and cannot switch back. The visitor
     sees 451.
   - The admin deletes it, typing the address → the link page is back.
   - Ban with "block all" → Mia's Code tab shows the banned panel, and delete still works for unblocked pages.
5. **Admin split.** Two nav entries; `#honeycombs` shows no code list; `#code-pages` deep link; the flash after
   actions; the old bookmark works.
6. **Mobile** (`mobile-audit.js` widths 360/390): page switcher sections, dialogs, Code tab selector and the admin
   tables scroll horizontally only inside their wrappers.
7. **No browser pop-ups.** A `page.on('dialog')` listener fails the test if `alert`/`confirm`/`prompt` fires in these
   flows.
8. **One-page account.** Tom (one page `tom`) unlocks code pages and turns `tom` into a code page. The editor opens
   the Code tab. Messages lists his earlier message. A notification sent by an admin appears in the bell within one
   polling interval. Settings shows Your pages, the weekly report and Discord; the weekly toggle saves, and "Send test
   report" shows its text.
9. **Save in flight while switching.** With a delayed `code-save` (Playwright `route` delay), Mia picks the other
   code page. The leave guard asks, the page reloads, and the other code page's files are unchanged afterwards.

---

## 8. Installer and operations (`server/install.sh`)

- **No new packages, services, timers, cron jobs or Cloudflare token permissions.**
  - Code pages on page addresses use the existing wildcard `*.on-your.site` route of the tunnel, which own-address
    code pages already use.
  - Nothing runs in the background.
- **Migration.** It runs automatically on service start (`ensureSchema`, under `GET_LOCK('oys_migrate')`). Expected
  cost:
  - `site_addresses`: one insert per page and code page, seconds at most;
  - `code_sites`: rebuilt by the persistent column, and the counters are summed once; one row per code user, seconds
    at most;
  - `pages`/`users`: instant `ADD COLUMN`; `uq_code_site` is an online index build over a few thousand rows.
- **`install.sh --update`** runs `node app/dist/cli.js sites:repair` after the post-update health check. The command
  is idempotent and takes well under a second for thousands of pages. It does four things:
  - it inserts missing registry rows (a live page or code page beats a hold);
  - it turns rows whose page or code page no longer has that slug into holds for the owner;
  - it recounts `file_count`/`bytes`;
  - it prints anomalies: "No address", "Hidden by the link page", collisions.

  After a rollback period this brings back everything PHP did not maintain. The schema version shown by
  `node app/dist/cli.js check` (plan §2.7) rises by two.
- **`install.sh --rollback`** (plan §5.6) gets a first step. When pages show code pages or accounts have more than
  one code page, it prints both counts and "PHP can’t show these code pages – visitors would see the saved link pages
  instead. Run again with --force to roll back anyway." Then it stops. The PHP patches of §3.4 keep the data safe
  with `--force`.
- **Support.** `node app/dist/cli.js sites:release <slug>` ends a hold early (for example after a support request).
  It prints the hold's owner and date first and asks for confirmation on the terminal.
- **Backups.** The nightly `onyoursite-backup.timer` already dumps the DB. There are no new files outside the DB.
- **Capacity.**
  - Serving a code slot costs the same as serving an own-address code page today: one extra indexed query
    (`code_sites` by id) per request.
  - The admin section no longer sums file contents on every `/admin` request (§4.6).
  - The new limits cap a code page at 5 MB. The default stays at 2 MB.
  - The feature works with today's single process and pool. It needs no change for the server's 16 vCPUs; how many
    Node processes run is plan.md's decision (§6.4).

---

## 9. Delivery plan and dependencies

### 9.1 Pull requests, in order

| PR | Title | Content | Depends on | Size |
|---|---|---|---|---|
| 1 | **Split the admin area into Honeycombs and Code pages** | `admin/page.ts` (nav, tab, `code_action` dispatch + compat), `code/admin.ts` (block/unblock/unlock moved from `adminHcHandle`), `code/adminView.ts` (the list + access moved), `honeycombs/adminView.ts` (code parts removed). **No schema change, no behaviour change.** Snapshots + e2e 5. | Admin port (P4/P9) merged. Lands **before** honeycomb-shop's admin work (HC-5). | ~400 lines |
| 2 | **One address registry with a 30-day hold** | Migration step `siteAddresses`; `content/addresses.ts`; `slugProblem` reads the registry; every existing address writer claims/releases in its transaction (sign-up, `page-create`, `address`, `page-delete`, admin "delete user", `code-create`, `code-address`), each on one connection with no pool query inside (the rule of §4.2); the 404 view respects holds; `cli.ts sites:repair` / `sites:release`; terms/privacy sentences; tests. Useful without code slots and the base for status pages. | Content (P1), editor API (P8), accounts/admin (P9) and code (P4) ports | ~450 lines |
| 3 | **Code page slots: data model, routing, rollback safety** | Migration step `codeSlots` (§3.1); `code/sites.ts` multi-page helpers + counters; `serveSlot`/subdomain/path mode; parked-page exclusions incl. `/track-click` and `api.php`; account-level actions before "Create a page first."; weekly report skip; uploads cleanup and account deletion over all code pages; `currentPage` skip; preamble 409; `code/slots.ts` with `withSlotLock` and `pageAllowance`; `page-create`/`page-delete` under the slot lock, rate limit; `db.ts` test knobs; admin list joins `pages` and prints slot addresses; **PHP rollback patches** and the `install.sh --rollback` guard (§3.4). **Dormant**: nothing creates a code slot yet (fixture SQL in tests). | PR 2; public routes (P7) | ~750 lines |
| 4 | **Code page slots: editor API (dark)** | `code/editorApi.ts` (family moved + `code-connect`, `code-move`, `code-delete`, required `site`, state object), `code/slots.ts` (quota and rules E1–E8), `code/settings.ts` with **`max_on_pages` default 0**, `code_more` (price 0) and purchase, `code/enforce.ts`, terms view limits/prices. Unit + DB + HTTP tests. Nothing new is reachable while the default is 0, not even from the browser console. | PR 3; honeycomb-shop HC-2/HC-3 (soft: fallback of §3.3) | ~800 lines |
| 5 | **Code pages admin: limits, source viewer, delete, ban, log** | The rest of `code/adminView.ts`/`code/admin.ts`, `code/moderation.ts`, slot lock for all admin actions, notifications, `Referrer-Policy`. e2e 4. | PR 1, PR 4; custom-dialogs PR 3 (`data-confirm` in the admin, hard) and PR 5 (`notify` with `ref`, soft) | ~600 lines |
| 6 | **Code page slots in the editor (feature live)** | `editor.js` (switcher with reload switching, new-page modal, Settings → Your pages, Settings without a link page, Code tab states, selector, "Where it lives", dialogs, Download files, `E.pagesUnlimited`), `editor.css` (disabled mode cards, switcher sections), dashboard bootstrap; **`max_on_pages` default becomes 1**. e2e 1–3, 6–9. | PR 5 (moderation must exist before users can create slots); custom-dialogs PR 2 (dialogs, leave guard, page-delete prompt, hard); the shop's yellow icon class (soft) | ~750 lines |

Each PR is reviewable alone, keeps the site working when deployed alone, and ships its own tests. Because PR 4
defaults to `max_on_pages = 0`, no code slot can exist before the release that contains PR 5 and PR 6.

### 9.2 What this feature needs from the other features

**honeycomb-shop**
- **Catalogue.** Two permanent unlock items:
  - `code_page` (existing key and ledger ref; default 100; history text "Unlocked your code page");
  - `code_more` (new; requires `code_page`; default price **0**; history text "Unlocked more code pages").
    This replaces the shop's proposed `code_slot` row (count, max 2, 300, honeycomb-shop §3.6). One unlock covers
    every extra code page up to `max_on_pages`, so a count does not fit. Its `canBuy` comes from this feature and
    refuses when no further code page is possible.
  - Prices are editable in the Honeycombs section. These items are not time-limited.
- **Reading inside a transaction.** `has(uid, feature, db?)`, `quantity(uid, feature, db?)` and
  `premiumActive(uid, db?)` take an optional `db`, and `BuyContext` carries the `db` of `withAccount`. This feature
  calls them inside its slot lock, and the shop calls `canBuy` inside `withAccount`. A pool query there would wait
  for a second connection while one is held (§6.4).
- **Purchase.** `buy(…)` as specified (the `code-unlock` route keeps its response shape); before HC-3, `hcSpend`.
- **Flags.** The 30-day address rule's exemption stays the shop's `hasPremium` + address pass. This feature uses the
  same helper for page-address code pages. The page limit is this feature's `pageAllowance()`.
  - If the owner wants sellable page slots (shop Q2) or more pages with Premium (shop Q3), the shop supplies
    `quantity(uid,'page_slot')` / the cap, and `pageAllowance` adds them.
  - Until the owner decides, the allowance is `max_pages`, and admins are unlimited.
- **Enforcer** (the shop's `registerEnforcer` contract). `code/enforce.ts` registers `enforceSlots(uid)` for
  `code_page`, `code_more`, `page_slot` and `premium`. It works only on the connection of its own `withNamedLock`.
  - If `code_page` is no longer held (refund/revoke), the user's code pages go offline (`is_published = 0`, files
    kept). The user can switch them back on after unlocking again.
  - An allowance that shrinks (`code_more` revoked, slots or Premium ended) pauses nothing: existing pages stay, and
    only creating new ones is refused. This feature recommends that over the shop's "pause" (shop Q4); the owner
    decides (question 5).
- The yellow honeycomb icon class, reused in the Code tab, the dialogs and the admin Prices card.
- From PR 1 on, the shop owns the Honeycombs admin section. The "Code page" balance column and the code list are gone
  from it.
- A suggestion, not required: code page views (`code_sites.views`) could count towards the visitor rewards, since
  users who turn their main page into a code page stop earning them.

**custom-dialogs**
- `OYSUI.confirm`, `OYSUI.prompt` with `match`/`transform`, the leave guard `OYSUI.guard(…).confirm()`, and
  `OYSUI.toast` (their §6.2, §6.9). The editor's `openModal()` stays the container for multi-field dialogs; their PR 2
  registers it as a layer.
- `data-confirm` for admin forms (their §6.8). The typed Delete check is a visible field checked by the server, so no
  typed `data-confirm` variant is needed.
- Page delete is their PR 2 row 8. This feature only passes the code-slot text.
- `notify(userId, 'code', …, {ref})` and the `code` catalogue row (their §5.2), the bell rewrite with `link`
  deep links (their §6.10, PR 5). This feature adds no bell code.
- Their PR 5 moves `notifications`/`notifications-read` before "Create a page first." This feature's PR 3 moves the
  other account-level actions, and those two as well if it lands first.
- Bell polling without a link page (their §7.1 row 14). This feature's PR 6 does it if it lands first.

**premium-domains** (questions and agreements, not requirements)
- v1: a page with a custom domain cannot show a code page (E7). This matches their "custom domains stay link-page
  only in v1" (premium-domains §1.3, §9). The editor needs `custom_domain` per page in `OYS_EDITOR.pages`.
- `page-delete` calls their `beforePageRemoved(pageId)` after its checks and before the slot lock. That includes
  pages that show code.
- If the owner later wants code pages on custom domains (question 7), the host lookup calls `serveSlot(ctx, page,
  sub)`, the single place that decides between link page and code page.
- The code badge: their §1 keeps "Hosted on OnYourSite" with Premium. The owner confirms this (question 8).

**status-pages**
- Addresses go through `site_addresses` with kind `status` (`claimAddress`/`releaseAddress` in their writing
  transaction). `slugProblem(slug, null, null, {exceptStatusId})` is used instead of a 4th positional parameter. Holds
  then cover status pages too.
- Status pages take no page slots. If a slot should ever show a status page, `serveSlot()` is the single place to
  extend.

**discord-pages**
- No functional dependency; this feature adds no reserved paths (the admin viewer uses query parameters on `/admin`).
- Migration numbers: both features use named step constants and take the next free number at merge time.

**plan.md (core)**
- A merge-order table of migration numbers, or a decision for named steps. Today discord-pages describes v6/v7 and
  custom-dialogs "v7 if right after".
- The two test knobs in `db.ts` (`OYS_DB_POOL_SIZE`, `OYS_DB_STRICT`) and, ideally, the strict guard for the whole
  test suite.
- The multi-process question raised by the 16 vCPUs, with `max_connections` sizing if workers come.

---

## 10. Open questions for the owner

1. **What does "connect a code page with a profile website" mean?**
   - Options:
     - (a) the page address shows the code page, and the link page is kept hidden;
     - (b) the same, but the link page is deleted;
     - (c) both stay reachable: code at `studio.on-your.site`, link page at `on-your.site/studio`.
   - **Recommended: (a).** It matches "instead of a profile website". Switching back loses nothing, and one address
     always shows one site. (c) puts two different sites under one name, and visitors could not tell which one they
     will get.
2. **What does "eine externe" mean?**
   - Options: an own address on on-your.site (`mia-dev.on-your.site`, like today's code page), or an external domain
     the user owns.
   - **Recommended: an own on-your.site address.** That is today's code page. External domains for link pages are a
     Premium feature (premium-domains), and extending them to code pages is question 7.
3. **Should more code pages cost honeycombs?**
   - Options: free, or a one-time price.
   - **Recommended: free (price 0).** The owner describes two equal options, and option 2 already costs a link page.
     Admins can set a price later in the shop; existing code pages are never affected by it.
4. **How many pages may show a code page?**
   - **Recommended: 1** (so at most 2 code pages per account, as described), adjustable by admins from 0 to 3.
5. **Should bought Premium (or bought page slots) give more page slots, and what happens when they end?**
   - Today admins have unlimited pages through "premium". honeycomb-shop proposes a cap of 10 pages for bought Premium
     (shop Q3) and pausing extra pages when it ends (shop Q4).
   - **Recommended: no extra slots with Premium.** Premium means custom domains and no OnYourSite branding, and slots
     stay 3 + 1 for everyone. If the owner wants extra slots anyway: when they end, existing pages stay online and
     only new pages are refused. Pausing pages would break links that visitors already use.
6. **May users undo a block themselves, by switching back to the link page or deleting the blocked code page?**
   - **Recommended: no.** A blocked code page stays until the team unblocks or deletes it; deleting it shows the link
     page again. Otherwise a block could be removed by the user with one click.
7. **May code pages use custom domains?**
   - **Recommended: not in v1.** A page with a custom domain cannot be turned into a code page until the domain is
     removed. Code on a user's own domain needs its own abuse review, and premium-domains keeps custom domains
     link-page only in v1.
8. **Does Premium also remove the "Hosted on OnYourSite" badge from code pages?**
   - **Recommended: no.** The badge is the report link that the code page rules require
     (`views/terms-code-pages.php:146`). Premium removes OnYourSite branding from link pages, and the Premium offer
     should say so.

---

## 11. Review changes

All findings were checked against the code before changing the design. The evidence held in every case.

| # | Finding | Verdict | What changed |
|---|---|---|---|
| 1 | [blocker] The slot lock can deadlock the pool | Accepted | §4.2: every query inside `withSlotLock` runs on the locked connection. `slugProblem`, `codeSettings`, the shop's `has`/`quantity`, `pageAllowance`, `createPage` and `deletePage` take `db`. Lock waits are capped at 3 s via `innodb_lock_wait_timeout` (reset before release), with "busy" as the answer; 1213 is retried once. `page-create` gets a rate limit (§4.4). §7 adds a pool-of-one test, the `OYS_DB_STRICT` nested-connection guard and concurrency tests on separate sessions with a 2 s bound. §6.4 states the rule. |
| 2 | [major] A request without `site` can overwrite another code page | Accepted | §4.4: `site` is required on `code-save`, `code-address`, `code-move` and `code-delete`; without it the answer is 409 `reload:true`. Only `GET code` keeps a default. §1.5 item 4; stale-tab scenario in the HTTP tests. |
| 3 | [major] Switching code pages without a reload can mix files | Accepted | §5.1/U10: code pages are switched like link pages, through the leave guard and `location.href='/dashboard?site=ID#code'`. Every slot operation navigates. The selector is disabled while saving/loading, and answers for another site id are dropped. e2e 9. |
| 4 | [major] One-page accounts lose inbox, bell and settings | Accepted | §4.4 preamble: all account-level actions move before step 12. custom-dialogs PR 5 is named for the notification actions and the bell polling. §5.1: Messages and the account parts of Settings render without `state.page`. §4.7: the weekly report skips instead of failing; `weekly-test` has its own text. U13, e2e 8. |
| 5 | [major] Rollback deletes uploads and breaks the slot rule | Accepted | §3.4 rewritten: PR 3 patches PHP's `oys_code_site` (`slug IS NOT NULL ORDER BY id`, which also keeps PHP's `code-address` away from NULL slugs), `oys_code_used_uploads` and `oys_code_delete_user` (all code sites), and PHP's `page-delete` (refuses a code slot). `install.sh --rollback` refuses without `--force`. `sites:repair` runs after roll-forward. The PHP test covers the upload sweep. The "move by hand" advice in §8 is gone. |
| 6 | [major] Slot code pages go live before moderation | Accepted | §9.1 reordered: the editor API ships with `max_on_pages` default 0 (PR 4); moderation (PR 5) comes before the editor UI (PR 6), which switches the default to 1. From PR 3 the admin list joins `pages` and prints slot addresses. |
| 7 | [major] Freed addresses can be claimed at once | Accepted | The hold is now part of the feature. Rule 11, `site_addresses` in PR 2 (before any slot can exist), every release point, the 404 view, and reclaim by the previous owner. A 7-day minimum use stops squatting with create/delete cycles. The optional PR 6 and old question 6 are gone. |
| 8 | [minor] Cross-kind uniqueness not enforced; wrong duplicate message | Accepted in part | `site_addresses` (slug primary key), written in the same transaction as every address change and shared with status pages and the hold (§3.1, §4.2). Duplicate keys are mapped by key name (§3.2). **Not taken:** `code_sites.page_id` + CHECK instead of `pages.code_site_id`. About ten public entry points and premium-domains' host lookup already load the `pages` row and get the flag for free; with `page_id` each of them would need a JOIN, and one missed loader brings back a ghost endpoint. The invalid states the CHECK would prevent can only come from the PHP rollback tree, which §3.4 now closes, or from manual SQL, which the admin list flags (§3.2). |
| 9 | [minor] Moderation checks can be raced or evaded | Accepted | `withSlotLock` re-reads the user row (ban) and the code site `FOR UPDATE` (block). Admin block/unblock/ban/delete take the owner's slot lock (§4.6). "Paused" also stops moves and address changes (E3). `/admin` sends `Referrer-Policy: no-referrer`, and links use `rel="noopener noreferrer"`. |
| 10 | [minor] Unasked price for the second code page; unlocks can lose value | Accepted | The item is renamed `code_more` ("More code pages", one unlock up to the limit) with a default price of 0. Owner question 3 is asked neutrally. `canBuy` refuses when no further code page is possible. The Limits form shows how many accounts are affected and asks before saving. A new terms sentence covers self-deletion and limit changes; the refund citation is corrected to `:177`. |
| 11 | [minor] Some readings belong to the owner | Accepted | New owner questions 1 ("connect"), 2 ("extern"), 7 (custom domains, recommended no for v1, with E7 refusing conversion) and 8 (badge with Premium). §9.2 now phrases premium-domains items as agreements and questions. |
| 12 | [minor] Out of step with custom-dialogs and migration numbers | Accepted | `OYSUI` names throughout §5. The admin Delete form has a visible typed field plus `data-confirm`. Notifications use `notify(…, {ref})`, and the `editor.js:664` bell change is dropped. Page delete builds on custom-dialogs PR 2. Migration steps use named constants assigned at merge, with no literals in tests and a plan.md request. `MODIFY` is guarded by `SHOW COLUMNS`. |
| 13 | [minor] Premium versus unlimited pages half-specified | Accepted | `E.pagesUnlimited` (and `maxPages` = allowance) replace `E.premium` at `editor.js:593,694,716`. The 30-day exemption is named as the shop's `hasPremium` + address pass, used for link pages and page-address code pages alike (rule 10, §4.5, §9.2). |
| 14 | [minor] Gaps in the editor flows | Accepted | `site.days_left` (§4.4.1). The leave guard runs before turning the current page into a code page. Bell links go to `/dashboard?site=ID#code` via custom-dialogs' deep links. "Download files" (JSON, no dependency) appears in the delete and switch-back dialogs. |
| 15 | [minor] Moderation log versus the privacy policy | Accepted | `codeDeleteUser` deletes the user's `code_moderation` rows; `user_id` is nullable for `limits` rows (§3.1, §4.7). The privacy page states this and the address holds after deletion (§5.3). |
| 16 | [minor] The 16-vCPU remark is out of scope | Accepted, with one line kept | The suggestion to revisit the single-process decision is removed from §6.4 and §8. Because the owner reported the 16 vCPUs, the design keeps one sentence on what it means here: nothing, since the pool and not CPU is the limit. It states the rule (correct with one process, never wait for a second connection while holding one) and leaves workers and `max_connections` sizing to plan.md (§9.2). |
| 17 | [minor] Legacy click counter and admin query cost | Accepted | `/track-click` ignores parked pages (§4.3). `code_sites.file_count`/`bytes` are stored by `codeWrite`, backfilled in the migration, recounted by `sites:repair`, and read by the list and the Storage card. There are no per-row subqueries and no `SUM(LENGTH(content))` per `/admin` request (§4.6). |
| 18 | [minor] Rate limit counts failures and is not atomic | Accepted | `rateOk` before the lock and `rateHit` only after a successful commit; concurrency relies on the slot lock (§4.4). |

Smaller corrections made along the way:
- line references for the terms page (`:144` Limits, `:177` refunds);
- the Node path of the weekly report (`app/report.ts`);
- admin flashes now print the code page's address instead of `site.slug`, which is empty for page addresses;
- sign-up inserts the user and the first page in one transaction, so a claim race no longer leaves a user without a
  page.
