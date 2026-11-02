# Status pages – design (feature `status-pages`)

OnYourSite's own status page (`status.on-your.site`) and a status page module that every user can unlock – checks
(monitoring), incidents and maintenance, alerts – built on the Node version (`app/`) after the port, as its own pull
requests. All UI text English, code comments German, no new npm dependency.

`$S` = the original development workspace (not in the repository, see ../README.md). File references are to branch `feature/node-typescript` at
`e5cd29e` (PHP code = behaviour reference, `app/src` = target layout). The commits after `41d4e55` only touch
`app/src/server.ts` and a test, so every citation below still holds. References to the other five designs are to
their current drafts in `` (discord-pages and code-slots-admin in their revised versions).

---

## 0. Summary

- One renderer, one data model and one set of background services serve both OnYourSite's own page
  (`is_system = 1`, slug `status`) and every user's page.
- User status pages are a module like the code page. They live in the shared address space at
  **`name.on-your.site`** (own origin, like code pages; addresses go through code-slots-admin's address registry).
  `on-your.site/name` redirects there. They are unlocked once with honeycombs through the shop (`status_page`), need
  accepted terms, and have their own editor tab and their own admin moderation.
- A page has **components**. A component is either an automated **check** (HTTP(S) with expected status and an
  optional keyword, or a **heartbeat** that the user's own job sends to us) or a **manual** component. On top of that
  come **incidents** and **scheduled maintenance**, each with an update timeline.
- **Alerts** go by email, Discord webhook and the editor bell. OnYourSite's own page also alerts through the own bot.
  Visitors can **subscribe** by email (double opt-in).
- Three systemd units do the background work. `onyoursite-status.service` (the **checker**) runs the checks. Inside
  the app it is guarded against SSRF by pinned DNS resolution and IP/port rules. At the kernel level a second guard
  applies: the unit reaches no local or private address at all (`IPAddressDeny=`, verified by the installer).
  `onyoursite-status-notify.service` (the **notifier**) sends emails, Discord messages and bot jobs; it never talks
  to user-chosen hosts. A one-minute timer, `onyoursite-status-local.timer` (the **sensor**), probes the local-only
  parts (Cloudflare tunnel `/ready`, local origin, disk, SMTP) and alerts admins directly when the database is gone.
- A **platform health gate** (§4.8.15) keeps OnYourSite's own outages (uplink, resolvers, deploys, tunnel) from
  turning into false outages, alerts and incidents on users' pages.
- Load: CPU is not the limit on the 16-vCPU server. Even 12,000 checks a minute use under one core, and the checker
  is capped at 2 vCPUs. The real limits are in-flight connections, politeness towards other sites, outbound traffic,
  database memory and the SMTP quota. All of them are sized in §6.8, capped and admin-configurable.

---

## 1. Goal and the owner's requirement

### 1.1 What the owner asked for

> „… und das OnYourSite auch seine eigene Status Page hat und auch ein Status Page-System hat was dann alle nutzen
> können. auch so ein eigener Modul wie die CodeSpace page."

Follow-up answer: **„Status pages: monitoring + incidents + alerts"**. Latest note from the owner: **„Der Server hat nun
16 vcores"** (the server now has 16 vCPUs). That note feeds the load estimate (§6.8) and the sizing of the checker
and the database (§8).

### 1.2 Interpretation (where the wording is open)

| Wording | Decision |
|---|---|
| „eigene Status Page" | `https://status.on-your.site` shows OnYourSite's own systems: website, profile and code pages, database, Discord bot, tunnel, email. Admins post incidents and maintenance there. |
| „Status Page-System … was alle nutzen können" | Every registered user can unlock a status page module (one page per account, like the code page – `code_sites.uq_user`, `app/src/schema.ts:321-334`). Visitors can view pages and subscribe; they don't create pages. Whether a small part should be free for everyone without honeycombs is open question 11. |
| „so ein eigener Modul wie die CodeSpace page" | Same shape as the code page module (`lib/codesites.php`): its own address in the shared slug namespace (`name.on-your.site`, own origin), unlock with honeycombs (`lib/codesites.php:44-47`; in Node through honeycomb-shop's `purchaseUnlock()`), its own terms page (`/terms/code-pages` → `/terms/status-pages`), its own editor tab (`views/dashboard.php:92`), admin block/unblock (`views/admin_honeycombs.php:90-139`). It is **not** a block inside link pages and does **not** use a link/code page slot. |
| „monitoring" | Check types that are safe: **HTTP(S)** (GET/HEAD, expected status codes, optional keyword, response time, certificate expiry), **heartbeat** (push: the user's cron job or server calls a secret URL; we make no outbound request) and **manual** components. No ICMP, TCP-port, DNS or custom-header checks (port scanning, internal probing, credential handling). |
| „incidents" | Incidents (investigating → identified → monitoring → resolved) and scheduled maintenance (scheduled → in progress → completed), each with an update timeline in simple Markdown (the same safe renderer as updates, `lib/updates.php:348`). Optional automatic incidents when a check stays down. |
| „alerts" | To the owner: email (account address, plus extra addresses after confirmation), Discord webhooks (validated, discord.com only), and the editor bell (custom-dialogs' `notify()`). For OnYourSite's page also all admins and the own bot. Visitors: email subscription with double opt-in. |
| Intervals „1–5 minutes" | Allowed intervals are 1, 2, 3 and 5 minutes. Free plan minimum: 3 minutes. Premium and the time-limited shop item “Fast checks” (`status_fast_checks`) unlock 1 minute. Heartbeat periods can be 1 min to 24 h, because the user's job decides how often it runs. |

### 1.3 Not in v1 (on purpose)

Ping/TCP/DNS/SMTP checks for users, custom request headers or bodies, generic outgoing webhooks for alerts (SSRF
vector), SMS, several status pages per account, multiple check locations, a “status” block on link pages, an SVG
status badge, an Atom feed, “remind me while it’s down” alerts, and custom domains for status pages (premium-domains
v1 covers link pages only; `custom_domains.target_type = 'status'` is the agreed follow-up). These are good
follow-ups and the model leaves room for them.

### 1.4 Words used below

- **Page**: one row in `status_pages` (user page or the system page).
- **Component**: one row in `status_monitors`. It shows up as a line on the page. Its **type** is `http`, `heartbeat`,
  `manual` or `system`.
- **Check**: one execution of an http/system component, or a ping or missed deadline of a heartbeat.
- **Monitor state** (internal): `unknown | up | degraded | down`, plus a `flapping` flag.
- **Component status** (public): `operational | degraded | partial | major | maintenance | unknown`.
- **Incident**: a row in `status_incidents` with `kind` = `incident` or `maintenance`.

---

## 2. User stories and flows

### 2.1 Owner (logged-in user, editor tab “Status page”)

**2.1.1 Unlock.** The tab shows a hero card that mirrors the locked code page card (`static/js/editor.js:2252-2275`).
It has an icon `bx-pulse`, a badge “Unlock with honeycombs” with the yellow honeycomb icon (see honeycomb-shop) and the
title “Your own status page”. The text reads “Show your visitors if your website, shop server or bot is up – with
automatic checks, incidents and email alerts. It lives at yourname.on-your.site.” Below are the features, a
balance/price bar (`.hc-bar`) and the button “Unlock for 150 honeycombs”. The price is the shop's current price of
the item `status_page` (`shopPrice`, an offer can lower it). The purchase is honeycomb-shop's `purchaseUnlock()` (their
`buy()` underneath), so the same rules, texts and idempotency apply as in the shop tab.
- Not enough honeycombs: the button is disabled and reads “40 more honeycombs needed”, next to “How to earn
  honeycombs”.
- Terms not accepted yet: a checkbox inside the confirm dialog (`OYSUI.confirm`, custom-dialogs) reads “I’ve read the
  rules for status pages. I only check websites and services that I run or am allowed to check.” Without it: “Please
  accept the rules for status pages first.”
- Success: toast “Status page unlocked – 150 honeycombs spent.” (the shop's `notice`).
- Price changed meanwhile: “The price changed – this now costs 120 honeycombs.” (the shop's text); the tab reloads its
  state and the button shows the new price.
- Module paused by the team (`status.allow_new = false`): the button is replaced by “Status pages are paused for new
  accounts right now.” This only stops **new unlocks**. Users who already unlocked can still create their page.
- Admin mode (an admin impersonating the user): the button is disabled with “Buying is turned off in admin mode.”
  (the shop's rule); admins unlock for free from the admin area instead.

**2.1.2 Create.** Only after the unlock (the server refuses it otherwise, §4.6). The form mirrors `codeCreateHtml`
(`static/js/editor.js:2303-2316`). It asks for an address (input group `… .on-your.site`; suggested value
`<first link page slug>-status`, cut to 30 characters) and a name. Errors come from the shared slug check
(`lib/helpers.php:256-286`; in Node `slugProblem` with code-slots-admin's address registry, which covers link, code
and status pages and held addresses), e.g. “Sorry, the address “acme” is already taken.” or “The address “status” is
reserved or not allowed.”. Status pages have one more rule against impersonation (§6.6): “The address “paypal-status”
contains a brand name. Status pages can’t use brand names in their address.” and, for the name, “Status page names
can’t use the OnYourSite name.” A second page gets “You already have a status page.” On success the page exists,
published, with no components, and the view switches to the management screen with the toast “Your status page is
live at acme-status.on-your.site.” New pages stay hidden from search engines for their first 14 days (§6.6).

**2.1.3 Add components** (dialog, §5.2). There are three types:
- *Website check* – a URL plus interval and options. On save the server validates (§4.6, §6.1). The row appears at
  once with the grey dot “Waiting for the first check…”. The checker picks it up within about 10 s (sync, §4.8.2).
- *Heartbeat* – a period and a grace time. After save the dialog shows the secret URL
  `https://on-your.site/_/hb/<token>` with a copy button and examples (`curl -fsS https://on-your.site/_/hb/… >/dev/null`
  for cron, “add /fail to report a failure”).
- *Manual* – a name and the current status. The owner sets it by hand.

Empty state: icon `bx-pulse`, “No components yet”, “Add your website, your API or anything you want to show – we’ll
check it every few minutes.” and the button “Add component”.

Limit states (the server enforces them; the UI shows them in advance):
- “You’ve used all 10 checks. Remove one, or get more checks in the shop.” (+ link to the shop item “Extra checks”).
- The interval select shows “1 min” disabled with the lock text “Fast checks or Premium”.
- At the components cap (40 incl. manual): “A status page can have up to 40 components.”

Validation errors (field-level, see §4.6 for the full list), e.g. “This address points to a private or local network –
only public websites can be checked.”, “Port 22 can’t be checked. Allowed ports: 80, 443, 8080, 8443.”, “This site
is already checked by many accounts – please contact us if you need it.”, “Monitoring this site isn’t allowed. The
site owner asked us not to check it.”, “The site’s robots.txt asks us not to check this address.”

**2.1.4 Watch.** Each row shows a status dot, the name, the target (pretty URL or “Heartbeat · every 1 h”), a strip
of the last 30 checks, the last response time and “2 min ago”. A pending retry shows “Checking again…”. A row that is
down shows the red dot and the error text, e.g. “No answer within 10 s.” Clicking a row opens details: a 24 h
response-time chart (inline SVG like `chartSvg`, `static/js/editor.js:2017`), the 90-day bars, the certificate
expiry, the last error and a “History” list of state changes (“Down for 12 min · Oct 31, 14:05 · No answer within
10 s”, 90 days, from `status_events`). The head card shows the overall page status pill and KPIs (`.kpis`, like the
stats tab `static/js/editor.js:1999`): “Uptime (30 days)”, “Avg. response”, “Open incidents”, “Subscribers”. While
the tab is open, the data refreshes every 20 s (GET `status-monitors`).

Special row states: “Rate-limited by the site (HTTP 429 since 14:05)” after an hour of 429 answers, then “Paused: the
site asked us to stop” after 24 hours of 403/429 (the owner can resume; it pauses again if the site keeps refusing),
“Paused: the site’s robots.txt asks us not to check it”, and, for every check at once, the banner “Checks are paused
– a problem on our side since 14:05. Nothing is counted as down meanwhile.” while the platform gate is closed
(§4.8.15).

**2.1.5 Alerts.** On by default: email to the account address for down, back up, slow, certificate and heartbeat
events, plus the bell (custom-dialogs' `notify()`, types `status_down` / `status_up`; clicking opens `#status`). The
owner can add up to 3 (Premium 5) channels:
- an email address, which gets a confirmation mail (“Waiting for confirmation”, “Resend” after 10 min);
- a Discord webhook, validated with discord-pages' `parseWebhookLink()`/`checkWebhook()` (`app/src/discord/index.ts`,
  today `lib/updates.php:531-543`). Saving sends a test message, and the channel is only active once Discord accepts it
  (“Discord rejected the webhook link – please copy it again from Discord.” reuses `lib/updates.php:655-676`). Discord
  channels also get the event “Incident updates”: one embed per incident, edited on each update (§5.8).

A Discord channel that keeps failing is switched off after 5 failures, and the owner gets an email: “Your Discord
alerts for Acme status stopped working.” Email alerts are capped per page (12 an hour, 50 a day; then one “Alerts are
muted until tomorrow” mail). A list “Recent alerts” shows the last 20 deliveries. (“Remind me while it’s down” is a
follow-up, §1.3.)

**2.1.6 Incidents.** “Report incident” opens a dialog with title, status, impact, affected components with their
effect, message (Markdown) and “Email 42 subscribers”. Each new update appears in the timeline. “Resolve” adds a final
update. Mistakes can be fixed: an update can be edited or deleted, and a whole incident can be deleted (confirm
dialog). Subscriber emails are limited to 3 updates a day per page (Premium 10); beyond that the checkbox is disabled
with “You’ve emailed your subscribers 3 times today – the update still shows on your page.” Automatic incidents (page
setting, default on, after 5 min down) are labelled “Auto”. They resolve themselves when the check recovers, unless
the owner has written in them. In that case an automatic update “… is responding again.” is added and the owner
resolves the incident. A component that stops being checked (deleted, paused, over the limit, inactive, or all user
checks paused by the team) counts as resolved for this, with the automatic update “{Name} is no longer monitored.”,
so an auto incident never stays open forever.

**2.1.7 Maintenance.** “Schedule maintenance” asks for title, start, end (local time in the browser, sent as UTC),
components, message and “Email subscribers now”. The checker moves it to *in progress* at the start and to *completed*
at the end, each with an automatic update. During maintenance, alerts for the affected components are muted and
downtime counts as maintenance, not as downtime (§4.8.7).

**2.1.8 Subscribers.** A switch reads “Visitors can subscribe by email”. The panel shows the confirmed and waiting
counts and the limit (“42 of 50 · Premium: 250”), plus “Remove all subscribers” (confirm dialog). Owners never see
subscriber addresses (privacy by design: we send the mails, so they don't need them). The limits follow the email
budget (§4.8.12, open question 9).

**2.1.9 Settings.** The owner can change name, description, address and the design: one of the 30 themes (theme
cards as in the Design tab) and an accent colour. Address changes use the same slug rules as creating. The old address
is **held for the owner for 90 days and forwards visitors to the new address** during that time, so old emails,
bookmarks, Discord embeds and `/summary.json` integrations keep working and nobody else can take it (§6.6). Once the
page has confirmed subscribers, the address can change only once every 30 days (“You can change the address again on
Dec 1, 2026.”). Further settings: logo from a chosen link page's avatar, a “Back to …” link to a link page, show
uptime %, show response times, history days (0–30), hide from search engines, and “Hide ‘Made with OnYourSite’”
(Premium; for others locked with “Premium” – mirrors `lib/pages.php:83`; the “Report this page” link always stays).
The online switch takes the page offline (visitors get a 404 notice, the owner previews with a token). Delete page:
type the address to confirm. This removes all components, data, incidents, channels and subscribers; the address is
held for the owner for 90 days.

**2.1.10 Limits change (time-limited purchase or Premium ends).** The checker and the editor use the same
`statusLimits(userId)` (§4.10). Checks above the new limit are paused by position (the first N stay active). The row
shows the badge “Paused – over your limit” and the banner reads “Your extra checks ended on Nov 30, 2026 – 5 checks
are paused. Remove some or get more.” Intervals below the new minimum are stretched (“Every 1 min · runs every
3 min now”). Existing subscribers stay. New subscriptions above the limit are refused. Branding shows again. Nothing
is deleted, and buying again re-activates everything within a few seconds (the shop runs our enforcer after every
purchase, grant, refund and expiry, §4.10).

**2.1.11 Team actions and inactivity.** A blocked page looks like the blocked code page box (`static/js/editor.js:2376`):
“Your status page has been blocked by the team: <reason>”. The public page answers 451. A component paused by the
team shows “Paused by the team: <note>”, and the owner can't resume it. Each of these team actions (block, unblock,
pause, resume) also puts a bell notice in the owner's editor (type `status_team`, opens `#status`). If the owner hasn't
opened the editor for 90 days, the checks pause automatically. A warning email goes out 14 days before (“Your status
checks pause on Jan 30 – open the editor to keep them running.”) and a bell notice when they pause. Opening the editor
resumes them.

### 2.2 Visitor

- Opens `acme-status.on-your.site`. It shows the overall banner, active incidents and maintenance, components with
  90-day bars and uptime %, past incidents (last 7 days, configurable) and a subscribe box. Times appear in the
  visitor's time zone (`<time datetime>` + small JS); without JS they use the site time zone with its abbreviation.
- `/incidents/{id}` shows the timeline. `/history` lists all incidents and maintenance, 20 per page. `/summary.json`
  is JSON (CORS `*`). Links inside incident texts show their target host (“here (evil.example)”) and carry
  `rel="nofollow ugc noopener noreferrer"`.
- Subscribe: enter an email → “Check your inbox to confirm.” (the same text whether the address is new, pending or
  already confirmed – no address enumeration). The mail link points to the main site
  (`on-your.site/_/status/sub/c/…`) and opens a page with a “Confirm subscription” button (POST, so link scanners
  can't confirm). Then: “You’re subscribed to Acme status.” Every mail carries an unsubscribe link (main site, page
  with button) and `List-Unsubscribe` / `List-Unsubscribe-Post` headers (one-click, RFC 8058), plus “Report this
  status page”. Unsubscribing works whatever happened to the page since (renamed, offline, blocked, deleted).
- Error and limit states: “Please enter a valid email address.”, “This form has expired. Please reload the page.”
  (time token), “A lot of requests are coming in right now. Please try again later.” (rate limit), “This page can’t
  take more subscribers right now.” (limit or the day's confirmation budget is used up), subscriptions off → no form.
- A blocked page shows the notice “This status page has been blocked” (451). An offline page shows “This status page
  is offline” (404). An old address of a renamed page forwards to the new one for 90 days. If the module is paused
  by the team, the page still renders but each check shows “Not checked right now” and the banner reads “Live checks
  are paused.” While the platform gate is closed (§4.8.15) the banner reads “Checks are paused – a problem on our
  side since 14:05. The status below is from before that.” If our database is down, the banner is red: “We can’t load
  live data right now (since 14:05).” (§4.4).

### 2.3 Admins

- **OnYourSite status** is managed in the editor's Status tab: admins (not while impersonating) get a switch “My
  status page | OnYourSite status” at the top of the tab. There they edit the system components (rename, group,
  show/hide, reorder; they can't be deleted), add normal website checks, report incidents, schedule maintenance and
  route alerts (all admins by email and bell, the bot's #alerts channel, the bot's #status channel for public
  incident posts, optional webhook). Admin → Status links there.
- **Admin → Status** (server-rendered like the other admin sections): the health card shows checker, notifier and
  sensor (running/stopped), checks per minute, delayed checks, the platform gate and its canaries, whether the kernel
  guard works, the email budget per class and the local probe age. A Discord card picks the #status and #alerts
  channels from the bot's report.
- **Moderation**: a list of all user status pages (slug, owner, components, checks/min, subscribers, state, a
  “Mentions PayPal” review flag) with block/unblock plus a reason the user sees, and “Approve name” for flagged
  pages. Each component can be expanded to show its target and state, with pause/resume and a note. Admins can also
  unlock for free (the shop's `grantFeature`, like `code_unlock`, `lib/honeycombs.php:231-243`).
- **Sites**: the most checked registrable domains (e.g. `victim.com`, from the Public Suffix List), each with its
  hosts and resolved IPs, the number of checks, users and requests per hour, and flags (“robots.txt opt-out”,
  “refuses our checker”). A second table lists the busiest IP addresses. Admins can block a host or a whole domain
  (existing checks pause with the note “The site owner asked us not to check it.”) or allow more checks for it.
- **Settings**: limits (free, the add-ons and Premium), allowed intervals and ports, per-site/domain/IP caps,
  retention, the email budget and its classes, inactivity days, plus the switches “Allow new status pages” (stops
  new unlocks) and “Run checks for users” (kill switch).

### 2.4 Failure situations

| Situation | What people see |
|---|---|
| Checker stopped or stuck (no heartbeat for more than 3 min) | Public pages: banner “Live checks are paused since 14:05 – the data below may be out of date.”, and components keep their last state but are greyed. Editor: “Checks are delayed – we’re on it.” Admins: email + bell + bot alert from the local watchdog (at most once an hour). systemd restarts the checker. |
| Our uplink, our DNS resolvers or our sockets fail (canaries fail, or local errors such as `EMFILE`) | The platform gate closes (§4.8.15): user checks are recorded as `internal`, no state changes, alerts or auto incidents. Public pages and the editor show “Checks are paused – a problem on our side since 14:05.” The time is not counted (neither up nor down). Admins get an alert; the system page shows the problem. |
| Many targets fail at once but the canaries are fine (e.g. a large CDN is down) | The gate holds new “down” changes for up to 3 minutes and re-runs the canaries every 10 s. If they stay fine, the failures are real: the changes happen with the correct start time and alerts go out. |
| Deploy or restart (`install.sh --update`, web or tunnel restart) | The installer marks a planned window; the web app records its own starts. Heartbeat deadlines restart after the window, so no job is reported missing because our ingress was briefly down (§4.8.6). |
| Database down | The web app answers 503 (`DbUnavailableError`). Status pages serve the last rendered copy for up to 1 h, **with a red banner** “We can’t load live data right now (since 14:05).”; on OnYourSite's page Website and Database show “Major outage”. The sensor alerts the admins directly (email and alert webhook from a local file), because the outbox and the admin list live in the database (§4.9). |
| Whole server down / tunnel down | `status.on-your.site` is down too – a status page on the same machine can't report its own outage. Admins post in Discord by hand (the bot is down too, unless it runs on another host with Docker, which `discord-bot/install.sh` supports). See open question 6 (Cloudflare edge copy). |
| A user's site down | That page's component goes red after the retries. Owner alerts go out. An auto incident opens after 5 min and subscribers are notified (within the page's daily email cap). |

---

## 3. Data model

### 3.1 Migration step (exact DDL)

All status tables come in **one** schema step `createStatusTables(conn)` in `app/src/schema.ts`. Its version is the
next free number when the first status PR merges. Below it is written as `STATUS_V`. If it lands after the other five
features it is probably 11. The current version is 5 (`app/src/schema.ts:13`, steps at `:63-70`, HEAD `e5cd29e`).
It runs after code-slots-admin's `siteAddresses` step (status addresses live in that registry). Times that are
compared or used for durations are **Unix seconds (UTC)** (`INT UNSIGNED`), because the site's DATETIME values are
local Berlin time and ambiguous in the DST overlap (map-admin §5.4). Days are `DATE` in the site time zone, like
`stats_daily`.

```ts
// Statusseiten: eigene Seite von OnYourSite und Statusseiten der Nutzer (Prüfungen, Vorfälle, Benachrichtigungen)
async function createStatusTables(conn: PoolConnection): Promise<void> {
  await run(conn, `CREATE TABLE IF NOT EXISTS status_pages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,                                  -- NULL = Seite von OnYourSite (is_system = 1)
        is_system TINYINT(1) NOT NULL DEFAULT 0,
        slug VARCHAR(63) NOT NULL,
        title VARCHAR(120) NOT NULL DEFAULT '',
        description VARCHAR(300) NOT NULL DEFAULT '',
        theme VARCHAR(40) NOT NULL DEFAULT 'deep-dark',
        settings MEDIUMTEXT NULL,                          -- JSON, siehe 3.2
        is_published TINYINT(1) NOT NULL DEFAULT 1,
        is_blocked TINYINT(1) NOT NULL DEFAULT 0,
        blocked_reason VARCHAR(200) NULL,
        review_note VARCHAR(80) NULL,                      -- Name nennt eine Marke („Mentions PayPal“): noindex bis zur Freigabe
        reviewed_at INT UNSIGNED NULL,                     -- Freigabe des Namens durch das Team
        rev INT UNSIGNED NOT NULL DEFAULT 0,               -- steigt bei jeder Änderung (Zwischenspeicher der Seite)
        changed_at INT UNSIGNED NOT NULL DEFAULT 0,        -- letzte Änderung (Unix-Zeit) für den Abgleich des Prüfdienstes
        slug_changed_at INT UNSIGNED NULL,                 -- letzter Adresswechsel (30 Tage Sperrfrist, sobald es Abonnenten gibt)
        owner_seen_at DATE NULL,                           -- letzter Besuch des Besitzers im Editor (Inaktivität)
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        UNIQUE KEY uq_slug (slug),
        UNIQUE KEY uq_user (user_id),
        KEY idx_changed (changed_at)
    ) ${OPTS}`);

  // Bestandteile einer Seite – mit automatischer Prüfung (http, heartbeat, system) oder von Hand (manual)
  await run(conn, `CREATE TABLE IF NOT EXISTS status_monitors (
        id INT AUTO_INCREMENT PRIMARY KEY,
        page_id INT NOT NULL,
        user_id INT NULL,                                  -- Besitzer (doppelt gespeichert für Grenzen und Admin)
        type VARCHAR(12) NOT NULL,                         -- http | heartbeat | manual | system
        name VARCHAR(80) NOT NULL,
        description VARCHAR(200) NOT NULL DEFAULT '',
        group_name VARCHAR(60) NOT NULL DEFAULT '',
        position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        is_public TINYINT(1) NOT NULL DEFAULT 1,
        target VARCHAR(500) NOT NULL DEFAULT '',           -- http: bereinigte Adresse · system: Name der Prüfung
        target_host VARCHAR(253) NOT NULL DEFAULT '',      -- http: Host in ASCII, klein, ohne Punkt am Ende
        target_domain VARCHAR(253) NOT NULL DEFAULT '',    -- http: registrierbare Domain (Public Suffix List)
        config TEXT NULL,                                  -- JSON, siehe 3.2
        interval_s SMALLINT UNSIGNED NOT NULL DEFAULT 300,
        manual_status VARCHAR(12) NULL,                    -- manual: operational|degraded|partial|major|maintenance
        manual_since INT UNSIGNED NULL,
        hb_token_hash CHAR(64) NULL,                       -- sha256 des geheimen Heartbeat-Links
        hb_token_enc VARCHAR(255) NULL,                    -- derselbe Link verschlüsselt (zum erneuten Anzeigen)
        hb_last_ping_at INT UNSIGNED NULL,
        hb_last_fail_at INT UNSIGNED NULL,
        is_paused TINYINT(1) NOT NULL DEFAULT 0,
        admin_paused TINYINT(1) NOT NULL DEFAULT 0,
        admin_note VARCHAR(200) NULL,
        auto_paused VARCHAR(12) NULL,                      -- vom Prüfdienst angehalten: private_ip | refused | robots
        auto_paused_at INT UNSIGNED NULL,
        changed_at INT UNSIGNED NOT NULL DEFAULT 0,        -- letzte Änderung (Unix-Zeit) für den Abgleich des Prüfdienstes
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        KEY idx_page (page_id, position),
        KEY idx_user (user_id),
        KEY idx_host (target_host),
        KEY idx_domain (target_domain),
        KEY idx_changed (changed_at),
        UNIQUE KEY uq_hb (hb_token_hash)
    ) ${OPTS}`);

  // Laufender Zustand je Prüfung – schreibt nur der Prüfdienst
  await run(conn, `CREATE TABLE IF NOT EXISTS status_state (
        monitor_id INT NOT NULL PRIMARY KEY,
        state VARCHAR(10) NOT NULL DEFAULT 'unknown',      -- unknown|up|degraded|down
        since INT UNSIGNED NULL,
        flapping TINYINT(1) NOT NULL DEFAULT 0,
        fails TINYINT UNSIGNED NOT NULL DEFAULT 0,
        last_check_at INT UNSIGNED NULL,
        last_ok_at INT UNSIGNED NULL,
        last_ms INT UNSIGNED NULL,
        last_code SMALLINT UNSIGNED NULL,
        last_error VARCHAR(20) NULL,                       -- Fehlerschlüssel (4.8.5), nie Text der Gegenseite
        cert_expires_at INT UNSIGNED NULL,
        cert_warned TINYINT UNSIGNED NULL,                 -- zuletzt gemeldete Schwelle in Tagen (14 oder 3)
        throttled_at INT UNSIGNED NULL,                    -- zuletzt wegen Grenzen je Website verschoben
        refused_since INT UNSIGNED NULL,                   -- Beginn einer ununterbrochenen Folge von 403/429
        updated_at INT UNSIGNED NOT NULL DEFAULT 0
    ) ${OPTS}`);

  // Einzelne Prüfungen (48 Stunden). Tagespartitionen nach UTC: alte Tage werden als Ganzes entfernt (4.8.13).
  // partitionClause() liefert z. B. „PARTITION BY RANGE (at) (PARTITION p20261101 VALUES LESS THAN (1793577600), …,
  // PARTITION pmax VALUES LESS THAN MAXVALUE)“ für heute und drei Tage voraus – oder '' ohne Partitionierung.
  await run(conn, `CREATE TABLE IF NOT EXISTS status_checks (
        monitor_id INT NOT NULL,
        at INT UNSIGNED NOT NULL,
        ok TINYINT(1) NOT NULL,
        ms INT UNSIGNED NULL,
        code SMALLINT UNSIGNED NULL,
        error VARCHAR(20) NULL,
        PRIMARY KEY (monitor_id, at)
    ) ${OPTS} ${await partitionClause(conn)}`);

  // Zustandswechsel je Prüfung (90 Tage) – Verlauf im Editor; ersetzt das lange Aufbewahren fehlgeschlagener Prüfungen
  await run(conn, `CREATE TABLE IF NOT EXISTS status_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        monitor_id INT NOT NULL,
        at INT UNSIGNED NOT NULL,
        kind VARCHAR(10) NOT NULL,                         -- down|up|degraded|recovered|flapping|stable|paused|resumed
        error VARCHAR(20) NULL,
        code SMALLINT UNSIGNED NULL,
        KEY idx_monitor (monitor_id, id),
        KEY idx_at (at)
    ) ${OPTS}`);

  // Zusammenfassung je Stunde (14 Tage) – Antwortzeiten-Diagramme
  await run(conn, `CREATE TABLE IF NOT EXISTS status_hourly (
        monitor_id INT NOT NULL,
        hour INT UNSIGNED NOT NULL,                        -- Beginn der Stunde (Unix-Zeit, UTC)
        checks SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        fails SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        ms_sum INT UNSIGNED NOT NULL DEFAULT 0,
        ms_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        ms_min INT UNSIGNED NULL,
        ms_max INT UNSIGNED NULL,
        covered_s SMALLINT UNSIGNED NOT NULL DEFAULT 0,    -- Sekunden mit Daten
        down_s SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        degraded_s SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        maint_s SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (monitor_id, hour)
    ) ${OPTS}`);

  // Zusammenfassung je Tag in der Zeitzone der Seite (120 Tage) – 90-Tage-Balken und Verfügbarkeit
  await run(conn, `CREATE TABLE IF NOT EXISTS status_daily (
        monitor_id INT NOT NULL,
        day DATE NOT NULL,
        checks MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        fails MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        ms_sum BIGINT UNSIGNED NOT NULL DEFAULT 0,
        ms_count MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        ms_max INT UNSIGNED NULL,
        covered_s MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        down_s MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        degraded_s MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        maint_s MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (monitor_id, day)
    ) ${OPTS}`);

  // Vorfälle und geplante Wartungen mit ihrem Verlauf
  await run(conn, `CREATE TABLE IF NOT EXISTS status_incidents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        page_id INT NOT NULL,
        kind VARCHAR(12) NOT NULL DEFAULT 'incident',      -- incident | maintenance
        title VARCHAR(160) NOT NULL,
        status VARCHAR(16) NOT NULL,                       -- investigating|identified|monitoring|resolved · scheduled|in_progress|completed
        impact VARCHAR(10) NOT NULL DEFAULT 'minor',       -- none|minor|major|critical (Wartung: maintenance)
        is_auto TINYINT(1) NOT NULL DEFAULT 0,             -- vom Prüfdienst eröffnet
        auto_edited TINYINT(1) NOT NULL DEFAULT 0,         -- Besitzer hat eingegriffen → nicht automatisch schließen
        starts_at INT UNSIGNED NOT NULL,
        ends_at INT UNSIGNED NULL,                         -- Wartung: geplantes Ende
        resolved_at INT UNSIGNED NULL,
        notify TINYINT(1) NOT NULL DEFAULT 1,
        sub_mails TINYINT UNSIGNED NOT NULL DEFAULT 0,     -- schon verschickte Mails an Abonnenten (höchstens 10)
        created_by INT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        KEY idx_page (page_id, resolved_at, starts_at),
        KEY idx_open (kind, status, starts_at)
    ) ${OPTS}`);
  await run(conn, `CREATE TABLE IF NOT EXISTS status_incident_monitors (
        incident_id INT NOT NULL,
        monitor_id INT NOT NULL,
        effect VARCHAR(12) NOT NULL DEFAULT 'partial',     -- degraded|partial|major|maintenance
        PRIMARY KEY (incident_id, monitor_id),
        KEY idx_monitor (monitor_id)
    ) ${OPTS}`);
  await run(conn, `CREATE TABLE IF NOT EXISTS status_incident_updates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        incident_id INT NOT NULL,
        status VARCHAR(16) NOT NULL,
        body TEXT NOT NULL,                                -- einfaches Markdown (wie Updates)
        is_auto TINYINT(1) NOT NULL DEFAULT 0,
        created_by INT NULL,
        created_at INT UNSIGNED NOT NULL,
        edited_at INT UNSIGNED NULL,
        KEY idx_incident (incident_id, id)
    ) ${OPTS}`);
  // Discord-Nachrichten eines Vorfalls – eine Zeile je Ziel (Bot-Kanal #status oder Webhook-Kanal), wird bei jedem
  // Update bearbeitet (Ablauf wie update_discord_posts von discord-pages)
  await run(conn, `CREATE TABLE IF NOT EXISTS status_incident_posts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        incident_id INT NOT NULL,
        target VARCHAR(40) NOT NULL,                       -- 'bot:<channel_id>' | 'channel:<status_channels.id>'
        channel_id VARCHAR(22) NULL,
        message_id VARCHAR(22) NULL,                       -- NULL, solange der erste Beitrag aussteht
        state VARCHAR(12) NOT NULL DEFAULT 'queued',       -- queued | posted | failed
        dirty TINYINT(1) NOT NULL DEFAULT 0,               -- geändert, während der erste Beitrag noch aussteht
        error VARCHAR(160) NULL,
        updated_at INT UNSIGNED NOT NULL,
        UNIQUE KEY uq_target (incident_id, target)
    ) ${OPTS}`);

  // Wohin Benachrichtigungen gehen (zusätzlich zur E-Mail des Kontos): E-Mail, Discord-Webhook, eigener Bot (nur OnYourSite)
  await run(conn, `CREATE TABLE IF NOT EXISTS status_channels (
        id INT AUTO_INCREMENT PRIMARY KEY,
        page_id INT NOT NULL,
        type VARCHAR(10) NOT NULL,                         -- email | discord | bot
        target_enc TEXT NOT NULL,                          -- verschlüsselt: Adresse, Webhook-Link oder Bot-Kanal
        target_hash CHAR(64) NOT NULL,                     -- hmac(Typ|Ziel): jedes Ziel nur einmal je Seite
        label VARCHAR(120) NOT NULL DEFAULT '',            -- gekürzt zum Anzeigen (m•••@example.com, Webhook …1234)
        events VARCHAR(120) NOT NULL DEFAULT 'down,up,degraded,cert,heartbeat', -- Discord: zusätzlich 'incident'
        verify_hash CHAR(64) NULL,                         -- sha256 des Bestätigungslinks, erst beim Versand erzeugt
        verify_sent_at INT UNSIGNED NULL,
        verified_at INT UNSIGNED NULL,
        is_enabled TINYINT(1) NOT NULL DEFAULT 1,
        fail_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
        last_error VARCHAR(160) NULL,
        last_sent_at INT UNSIGNED NULL,
        created_at DATETIME NULL,
        UNIQUE KEY uq_target (page_id, target_hash),
        KEY idx_page (page_id)
    ) ${OPTS}`);

  // Abonnenten (Besucher, doppelte Bestätigung). Der Abmeldelink wird nicht gespeichert, sondern berechnet:
  // hmac('status-unsub|' + id) – so trägt jede Rundmail ihren eigenen Link (4.5).
  await run(conn, `CREATE TABLE IF NOT EXISTS status_subscribers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        page_id INT NOT NULL,
        email_enc TEXT NOT NULL,
        email_hash CHAR(64) NOT NULL,                      -- hmac('status-sub|' + Adresse klein), gleich für alle Seiten
        confirm_hash CHAR(64) NULL,                        -- sha256 des Bestätigungslinks, erst beim Versand erzeugt
        confirmed_at INT UNSIGNED NULL,
        confirm_sent_at INT UNSIGNED NULL,
        created_at INT UNSIGNED NOT NULL,
        UNIQUE KEY uq_email (page_id, email_hash),
        UNIQUE KEY uq_confirm (confirm_hash),
        KEY idx_hash (email_hash),
        KEY idx_page (page_id, confirmed_at, id)
    ) ${OPTS}`);

  // Rundmails an Abonnenten: eine Zeile je Vorfall-Update, der Benachrichtigungsdienst arbeitet sie schrittweise ab
  await run(conn, `CREATE TABLE IF NOT EXISTS status_broadcasts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        page_id INT NOT NULL,
        incident_id INT NOT NULL,
        update_id INT NOT NULL,
        cursor_id INT NOT NULL DEFAULT 0,                  -- letzter angeschriebener Abonnent
        sent INT UNSIGNED NOT NULL DEFAULT 0,
        failed INT UNSIGNED NOT NULL DEFAULT 0,
        state VARCHAR(10) NOT NULL DEFAULT 'queued',       -- queued|sending|done|superseded|cancelled|expired
        created_at INT UNSIGNED NOT NULL,
        done_at INT UNSIGNED NULL,
        KEY idx_state (state, id),
        KEY idx_page (page_id, created_at),
        KEY idx_incident (incident_id, id)
    ) ${OPTS}`);

  // Ausgehende Nachrichten (Alarme, Bestätigungsmails, Bot) – mit Wiederholung und Verlauf (30 Tage).
  // Die Nutzdaten enthalten nie Geheimnisse: Bestätigungslinks erzeugt erst der Versand (4.8.12).
  await run(conn, `CREATE TABLE IF NOT EXISTS status_outbox (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        page_id INT NOT NULL,
        monitor_id INT NULL,
        kind VARCHAR(20) NOT NULL,                         -- alert|channel_verify|sub_confirm|inactive_warning|channel_broken|muted
        class VARCHAR(8) NOT NULL DEFAULT 'owner',         -- Mail-Budget: system | confirm | owner (4.8.12)
        channel VARCHAR(20) NOT NULL,                      -- owner|admins|bell|bot|channel:<id>|sub:<id>
        event VARCHAR(16) NOT NULL DEFAULT '',             -- down|up|degraded|recovered|flapping|stable|cert|heartbeat|incident|test
        payload TEXT NOT NULL,                             -- JSON mit allem, was die Nachricht braucht (ohne Geheimnisse)
        state VARCHAR(10) NOT NULL DEFAULT 'pending',      -- pending|sent|failed|merged|skipped
        attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
        next_at INT UNSIGNED NOT NULL,
        error VARCHAR(160) NULL,
        created_at INT UNSIGNED NOT NULL,
        sent_at INT UNSIGNED NULL,
        KEY idx_due (state, next_at),
        KEY idx_page (page_id, id)
    ) ${OPTS}`);

  // Regeln je Website (Admin): sperren oder mehr Prüfungen erlauben
  await run(conn, `CREATE TABLE IF NOT EXISTS status_host_rules (
        host VARCHAR(253) NOT NULL PRIMARY KEY,            -- exakter Host oder „.example.com“ für die Domain und alle Subdomains
        rule VARCHAR(8) NOT NULL,                          -- block | allow
        max_monitors SMALLINT UNSIGNED NULL,
        note VARCHAR(200) NOT NULL DEFAULT '',
        created_by INT NULL,
        created_at DATETIME NULL
    ) ${OPTS}`);

  // robots.txt je Host (höchstens einmal am Tag geholt) – nur Gruppen für „OnYourSite-Monitor“ zählen (6.2)
  await run(conn, `CREATE TABLE IF NOT EXISTS status_host_meta (
        host VARCHAR(253) NOT NULL PRIMARY KEY,
        robots_at INT UNSIGNED NULL,
        robots_rules TEXT NULL,                            -- JSON: [["allow"|"disallow", "/pfad"], …] der eigenen Gruppe
        robots_error VARCHAR(20) NULL
    ) ${OPTS}`);

  // „Jetzt prüfen“: kleine Warteschlange statt eines vollständigen Neuladens im Prüfdienst
  await run(conn, `CREATE TABLE IF NOT EXISTS status_run_requests (
        monitor_id INT NOT NULL PRIMARY KEY,
        requested_at INT UNSIGNED NOT NULL
    ) ${OPTS}`);

  // Daten gelöschter Prüfungen und Seiten räumt der Prüfdienst in Teilen weg (statt im Web-Request)
  await run(conn, `CREATE TABLE IF NOT EXISTS status_purge (
        id INT AUTO_INCREMENT PRIMARY KEY,
        kind VARCHAR(8) NOT NULL,                          -- monitor | page
        ref_id INT NOT NULL,
        created_at INT UNSIGNED NOT NULL
    ) ${OPTS}`);

  // Alte Adresse nach einem Adresswechsel: 90 Tage Weiterleitung (die Adresse selbst hält site_addresses fest)
  await run(conn, `CREATE TABLE IF NOT EXISTS status_slug_redirects (
        slug VARCHAR(63) NOT NULL PRIMARY KEY,
        page_id INT NOT NULL,
        until INT UNSIGNED NOT NULL,
        KEY idx_page (page_id)
    ) ${OPTS}`);

  await addColumn(conn, 'users', 'status_terms_at', 'DATETIME NULL');
  await seedSystemStatusPage(conn);
}
```

`partitionClause(conn)` checks `SELECT PLUGIN_STATUS FROM information_schema.PLUGINS WHERE PLUGIN_NAME = 'partition'`
(built into the MariaDB packages of Debian and Ubuntu). Without it, the table is created unpartitioned and retention
falls back to batched `DELETE`s by primary-key range (§3.6). The app user may run the partition DDL: the installer
grants `ALL PRIVILEGES` on the database (`server/install.sh:286`).

Addresses: status pages claim their slug in code-slots-admin's registry `site_addresses` (kind `status`) in the same
transaction that writes `status_pages` (`claimAddress`, `releaseAddress`; code-slots-admin §4.2). This step therefore
runs after their `siteAddresses` step, and the system page's `status` slug is claimed there too (step 5 below).

`seedSystemStatusPage(conn)` (same step, idempotent):
1. Skip if `SELECT id FROM status_pages WHERE is_system = 1` finds a row.
2. Collision check: `status` and `health` have been forbidden subdomains since the original list (`blacklist.php:51`),
   so no page or code site can have them. To be safe the step still runs
   `SELECT 'page', id FROM pages WHERE slug IN ('status','health') UNION SELECT 'code', id FROM code_sites WHERE slug IN (…)`.
   If it finds a row (legacy import), it logs `console.error` and creates the system page **unpublished**. The admin
   section then shows “The address status.<domain> is used by another page – decide what to do before publishing.”
   Existing pages keep working, because the router checks status pages last (§4.3).
3. `INSERT INTO status_pages (user_id, is_system, slug, title, description, theme, settings, is_published, created_at, updated_at) VALUES (NULL, 1, 'status', 'OnYourSite status', 'Live status of on-your.site, profile pages, code pages and our Discord bot.', 'deep-dark', '{"accent":"#6366f1","show_uptime":true,"history_days":14,"subscribe":true,"auto_incident":300,"alerts":{"owner":false,"admins":true,"events":["down","up","degraded","cert","heartbeat"]}}', <1|0>, NOW(), NOW())`.
4. Insert the system components (type `system`, `target` = check key, `user_id` NULL), groups as in §4.9:
   `web` “Website”, `pages` “Profile & code pages”, `domains` “Custom domains”, `bot` “Discord bot”, `mail` “Email”,
   `db` “Database”, `tunnel` “Cloudflare tunnel”, and the private ones (`is_public = 0`): `origin` “Web server
   (internal)”, `disk` “Disk space (internal)”, and the job heartbeats `job:backup` “Nightly backup”, `job:weekly`
   “Weekly report” and `job:runner` “Background jobs” (honeycomb-shop's shared runner and every job registered in
   it). A component whose feature is not installed (no bot secret, no SMTP, no runner yet) is hidden and not
   evaluated until it is.
5. `claimAddress(db, 'status', 'status', <page id>, null)` in `site_addresses` (no owner; the slug is also a
   forbidden subdomain, `blacklist.php:51`).
6. `REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_rev', '1')`.

The step creates no foreign keys (the schema has none, `app/src/schema.ts`). Deleting is done by the code (§4.6
`status-delete`, `statusDeleteUser`): configuration rows go in the request, measured data through `status_purge`.

### 3.2 JSON shapes

`status_pages.settings` (defaults filled in by `statusPageSettings(row)`; unknown keys dropped on save):

```json
{
  "accent": "",               // '' = Farbe des Designs, sonst #rrggbb
  "logo_page_id": 0,          // Profilbild dieser eigenen Linkseite als Logo (0 = Initialen)
  "back_page_id": 0,          // Link „Back to …“ auf diese eigene Linkseite (0 = keiner)
  "show_uptime": true,
  "show_response": false,     // 24-h-Antwortzeit unter jedem Bestandteil
  "history_days": 7,          // „Past incidents“ auf der Startseite: 0–30 Tage
  "subscribe": true,
  "hide_branding": false,     // wirkt nur mit Premium (brandingHidden, premium-domains)
  "noindex": false,
  "auto_incident": 300,       // Sekunden „down“ bis zum automatischen Vorfall (0 = aus, 300, 900)
  "notify_auto": true,        // automatische Vorfälle an Abonnenten
  "alerts": { "owner": true, "admins": false, "events": ["down","up","degraded","cert","heartbeat"] }
}
```

`status_monitors.config` by type:

```json
// http
{ "method": "GET", "expect": "200-299", "keyword": "", "keyword_mode": "contains", "keyword_case": false,
  "timeout": 10, "retries": 1, "slow_ms": 0, "redirects": true, "cert_warn": true, "tls_ignore": false }
// heartbeat
{ "period": 3600, "grace": 300 }
// system (Job-Heartbeats; Prüfungen ohne Einstellungen: {})
{ "period": 86400, "grace": 7200 }
// manual
{}
```

Rules: `method` ∈ GET, HEAD. `expect` = up to 10 comma-separated codes or ranges within 100–599 (e.g.
`200-299,301,401`). `keyword` ≤ 100 characters, `keyword_mode` ∈ contains, absent. `timeout` ∈ 5, 10, 15, 20, 30
and must be smaller than the interval. `retries` 0–3. `slow_ms` 0 (off) or 500–20000. `cert_warn` on/off (warnings at
14 and 3 days before expiry). `period` 60–86400 (system job heartbeats up to 7 days). `grace` 60–3600 (system jobs up
to 6 h).

### 3.3 `oys_meta` keys

| Key | Value | Written by |
|---|---|---|
| `status` | Module settings (JSON, below) | Admin |
| `status_rev` | Integer as text. Raised in the same transaction as every change to pages, components or incidents. The checker syncs on change. | Web |
| `status_worker` | `{"at":…, "pid":…, "started":…, "version":"…", "monitors":{"active":…,"paused":…}, "checks_min":…, "inflight":…, "delayed_10m":…, "lag_p95_ms":…}` every 30 s | Checker |
| `status_gate` | `{"state":"ok\|hold\|frozen", "since":…, "reason":"canaries\|resolver\|local\|ratio", "canaries":{"ok":3,"of":3,"at":…}, "ingress_recovered_at":…}` on every change and every 30 s (§4.8.15) | Checker |
| `status_notify` | `{"at":…, "mail_today":{"system":…,"confirm":…,"owner":…,"broadcast":…}, "outbox":…, "smtp_fail":…}` every 30 s | Notifier |
| `status_probe` | `{"at":…, "tunnel":{"ok":true,"ms":2}, "origin":{"ok":true,"ms":14}, "disk":{"free_pct":71}, "smtp":{"ok":true,"at":…}}` every 60 s (`tunnel` is `null` without a tunnel; `smtp` is checked every 10 min) | Sensor |
| `status_planned` | Unix time until which our ingress is down on purpose (deploy), written by `cli.js status:planned <s>` from the installer | Installer |
| `status_web_start` | Unix time of the last start of the web app (written once at start-up) | Web |
| `status_watchdog_at` | Unix time of the last watchdog email (at most once an hour) | Sensor |

`status` settings (defaults in `app/src/status/settings.ts`, values clamped like `oys_hc_settings`,
`lib/honeycombs.php:18-31`). Prices are not here: they belong to honeycomb-shop's catalogue (`status_page`,
`status_more_checks_30`, `status_fast_checks_30`).

```json
{
  "allow_new": true, "run_user_checks": true,
  "free":    { "checks": 10, "min_interval": 180, "channels": 3, "subscribers": 50,  "broadcasts_day": 3 },
  "addons":  { "more_checks": 10, "fast_interval": 60 },
  "premium": { "checks": 30, "min_interval": 60,  "channels": 5, "subscribers": 250, "broadcasts_day": 10 },
  "components_max": 40, "intervals": [60, 120, 180, 300], "ports": [80, 443, 8080, 8443],
  "host_cap": 20, "domain_cap": 60, "host_per_min": 30, "domain_per_min": 60, "ip_per_min": 3000,
  "timeout_max": 30, "keyword_kb": 512,
  "raw_days": 2, "hourly_days": 14, "daily_days": 120, "events_days": 90,
  "mail_per_min": 30, "mail_per_day": 1000, "confirm_share": 10, "owner_share": 30,
  "owner_mails_hour": 12, "owner_mails_day": 50, "updates_per_hour": 20, "inactive_days": 90
}
```

`addons` is what the shop items add to the free plan: each active “Extra checks” pack (`status_more_checks`, at most
2 at a time) +10 checks, “Fast checks” (`status_fast_checks`) the 1-minute interval. Premium (30 checks, 1 minute) is
at least as much as the free plan with both packs and fast checks.
Saving refuses a `premium.subscribers` above 25 % of `mail_per_day` (“One update to 1,000 subscribers would use more
than a quarter of the daily email budget (1,000).”), so subscriber limits always follow the SMTP quota (open question 9).
Values that are **not** admin-editable go in `config.json` → `status`: `dns` (resolvers, default
`["1.1.1.1","1.0.0.1","9.9.9.9"]`), `canaries` (default `["https://www.gstatic.com/generate_204",
"https://www.cloudflare.com/cdn-cgi/trace", "https://detectportal.firefox.com/success.txt"]` – three networks, each
built for connectivity checks; PR 2 verifies them), `concurrency` (1000), `keyword_concurrency` (64), `user_inflight`
(32), `tunnel` (true/false), `self_ips` (every global address of the server), `egress_ips` (shown on the terms page)
and `kernel_guard` (the installer's test result, §8). These are server facts, not product settings; the installer
writes them.

### 3.4 Existing data

Nothing is migrated. The step only adds tables, one column (`users.status_terms_at`) and the system page. Existing
URLs keep their meaning: a status page is looked up **after** link pages and code sites (§4.3), and its address sits
in the shared registry `site_addresses`, so new link or code pages can't take it. Rolling back to an older build
leaves the tables unused; the rollback stops the status units (§8). The PHP tree's `oys_slug_problem`
(`lib/helpers.php:256-286`) knows neither the registry nor `status_pages`, so a link page created during a rollback
could take a status page's address. On roll-forward, `cli.js status:slug-check` lists such collisions; the link page
keeps priority in routing (§4.3) and the admin card shows the conflict until it is resolved.

### 3.5 Who writes what

| Table | Writers (columns) |
|---|---|
| `status_pages`, `status_monitors`, `status_channels` (config), `status_subscribers`, `status_host_rules`, `status_slug_redirects`, `status_run_requests` (insert), `status_purge` (insert) | Web process (editor API, admin, public subscribe). The heartbeat endpoint writes only `hb_last_ping_at` / `hb_last_fail_at`. |
| `status_monitors.auto_paused/auto_paused_at` | Checker (self-pause) and web (owner resumes) – single-row `UPDATE`s |
| `status_channels.fail_count/last_error/last_sent_at/is_enabled`, `status_channels.verify_hash/verify_sent_at`, `status_subscribers.confirm_hash/confirm_sent_at` | Notifier (delivery results, tokens minted at send time) – separate columns, single-row `UPDATE`s, no read-modify-write |
| `status_state`, `status_checks`, `status_events`, `status_hourly`, `status_daily`, `status_host_meta` | Checker only |
| `status_incidents` / `status_incident_updates` | Web (owner) and checker (auto incidents, maintenance transitions). Checker writes use compare-and-set (`… WHERE id = ? AND auto_edited = 0 AND resolved_at IS NULL`, `… WHERE status = 'scheduled'`). Owner writes set `auto_edited = 1` in the same statement. |
| `status_incident_posts` | Web and checker insert or mark `dirty` (row lock); the notifier and the bot result handler (`/_/bot/outbox/{id}/done`) set `message_id/state`. |
| `status_broadcasts` | Web and checker insert and supersede. The notifier advances `cursor_id/sent/failed/state`. |
| `status_outbox` | Web and checker insert. Only the notifier delivers and updates. |

### 3.6 Retention (checker, hourly; partitions daily)

| Data | Kept | How |
|---|---|---|
| `status_checks` | `raw_days` (2 days, ok and failed alike) | daily at 00:20 UTC: `ALTER TABLE status_checks DROP PARTITION p<day>` for days older than 2, and `REORGANIZE PARTITION pmax` to keep 3 future days. Instant, no row deletes. Without partitioning: batched PK-range deletes. |
| `status_events` | `events_days` (90 d) | `DELETE … WHERE at < ? LIMIT 5000` (index `idx_at`) |
| `status_hourly` | `hourly_days` (14 d) | per monitor PK range |
| `status_daily` | `daily_days` (120 d) | per monitor PK range |
| `status_outbox` done/failed | 30 d | `DELETE … WHERE state <> 'pending' AND created_at < ? LIMIT 5000` |
| `status_broadcasts` done/expired | 7 d | same |
| unconfirmed subscribers | 48 h | `DELETE … WHERE confirmed_at IS NULL AND created_at < ?` |
| unverified channels | 7 d | `DELETE … WHERE verified_at IS NULL AND type = 'email' AND …` |
| `status_slug_redirects` | 90 d | `DELETE … WHERE until < ?` |
| incidents | forever (user content) | removed with the page or the account |
| data of deleted monitors or pages | — | `status_purge` queue (§4.8.13): hourly/daily/events/state rows in PK-range batches; raw checks simply age out with their partitions |

Failed checks are no longer kept for 7 days: one dead check at 1 minute would add about 10,000 rows a week. The
editor's error history comes from `status_events` (one row per state change) and the hourly `fails` counts instead.
Size per check component at a 1-minute interval: raw about 140 KB (2 days), hourly about 20 KB, daily about 8 KB, so
roughly 170 KB. Totals are in §6.8.

---

## 4. Server

### 4.1 Processes

```
 Browser ──HTTPS──► Cloudflare ──tunnel──► Node web app (app/dist/server.js)
                                              │  status pages, editor API, /_/hb, /_/health, /_/status/*, admin
                                              ▼
                                      MariaDB (unix socket only)
                                    ▲          ▲          ▲
 checker  onyoursite-status.service │          │          │ notifier  onyoursite-status-notify.service
 (app/dist/status/worker.js) ───────┘          │          └─ (app/dist/status/notify.js): status_outbox,
   checks, gate, state, aggregates,            │             broadcasts, mail budget → SMTP, Discord webhooks,
   incidents, partitions, purge                │             bell rows, bot jobs → community_outbox ──(bot polls
   │ outbound only to public addresses on      │             /_/bot/outbox?f=…status.v1)──► Discord bot
   │ allowed ports (app guard + IPAddressDeny) │
   ▼                                           │
 user targets, canaries, public DNS resolvers  │
 sensor  onyoursite-status-local.timer (every 60 s, app/dist/status/local.js): cloudflared /ready, local origin,
         disk, SMTP verify, watchdog; direct email/webhook alerts from a local file when the database is down
```

The split is deliberate: the checker is the only process that connects to user-chosen hosts, so it is the one that
gets the strict network sandbox. The notifier only talks to fixed services (the SMTP host, discord.com) and may need
the system resolver and a local mail relay, which the checker must never reach (§6.1, §8).

### 4.2 Module layout (`app/src/status/`)

| File | Contents |
|---|---|
| `settings.ts` | `statusSettings()`, `statusSaveSettings(input)` (oys_meta `status`), `statusPageSettings(row)` |
| `limits.ts` | `statusLimits(userId, db?)` → `{plan, checks, components, minInterval, channels, subscribers, broadcastsDay, until}` (§4.10), `effectiveMonitors(rows, limits)` |
| `features.ts` | Registration with honeycomb-shop: `registerFeature` for `status_page`, `status_more_checks` and `status_fast_checks` with their `canBuy`/`needsTerms` rules, `registerPerk('premium', …)`, and the optional inline enforcer that refreshes the checker at once (§4.10) |
| `model.ts` | Loaders and writers: `statusPageBySlug/ById/ForUser`, `systemStatusPage`, monitor CRUD, `bumpRev()`, `statusDeleteUser(userId)`; address claims/releases through `content/addresses.ts` (code-slots-admin) |
| `names.ts` | `statusBrandProblem(slug)`, `statusTitleProblem(title)` → refuse/flag (§6.6) |
| `guard.ts` | SSRF policy (pure): `parseTarget(url)`, `classifyIp(ip)`, `hostAllowed(host, rules)`, `portAllowed`, special names, own addresses |
| `psl.ts` + `app/data/public_suffix_list.dat` | Registrable domain of a host (Public Suffix List incl. the private section, so `*.github.io` sites stay separate). A data file plus a ~60-line matcher, no npm package; `npm run psl:update` refreshes the file before a release. |
| `resolver.ts` | DNS with explicit public resolvers (`dns.promises.Resolver`), TTL cache, resolver health, `resolvePublic(host)` → validated addresses |
| `http.ts` | `runHttpCheck(monitor, deps)` – pinned connection, manual redirects, size/time limits, certificate expiry, error classes (incl. `internal`) |
| `robots.ts` | Daily `robots.txt` fetch per host, parser for the `OnYourSite-Monitor` group (RFC 9309 matching) |
| `gate.ts` | Platform health gate (§4.8.15): canaries, failure ratio, local errors, ingress windows; pure `gateStep()` |
| `state.ts` | Pure state machine `step(prev, result, cfg, now)` → `{next, events}` (§4.8.7) |
| `aggregate.ts` | Bucket maths (hour/day split, DST), uptime %, bar colours |
| `scheduler.ts` | Min-heap of due checks, jitter, per-host/domain/IP token buckets, concurrency gates |
| `partitions.ts`, `purge.ts` | Daily partition maintenance of `status_checks`; the purge queue |
| `worker.ts` | Entry point of the checker `onyoursite-status.service` (leader lock, sync loop, flushers, sweeps) |
| `notify.ts` | Entry point of the notifier `onyoursite-status-notify.service` (leader lock, outbox, broadcasts, budget) |
| `local.ts` | Entry point of the sensor timer (probes, watchdog, direct alerts) |
| `system.ts` | System check definitions (§4.9) |
| `incidents.ts` | Incident and maintenance rules (validation, transitions, auto incidents, broadcasts) |
| `alerts.ts` | Outbox: build and coalesce (web and checker); deliver email / Discord / bell / bot messages (notifier) |
| `posts.ts` | Incident posts to Discord (one per target, edit in place, bot results) |
| `broadcast.ts`, `budget.ts` | Subscriber fan-out (round robin per page), mail budget classes |
| `render.ts`, `views/*.ts` | Public page, incident, history, notices, subscription pages (TS templates) |
| `summary.ts` | JSON summary |
| `routes.ts` | `statusServe(ctx, page, path)` for status hosts, old-address redirects |
| `endpoints.ts` | `/_/hb/…`, `/_/health`, `/_/status/verify`, `/_/status/sub/…` |
| `editorApi.ts` | `/dashboard/api/status*` |
| `admin.ts`, `adminView.ts` | `POST /admin` `status_action=…` and the admin section |
| `terms.ts` | `/terms/status-pages` view |
| `cli.ts` additions | `status:ping <job>`, `status:planned <seconds>`, `status:slug-check` |

Reused (already ported or being ported): `app/src/db.ts` (`withNamedLock`, `transaction`, socket for `localhost`),
`app/src/crypto.ts` (`encryptData`, `hmac`, `sha256Hex`, `randomHex`, `safeEqual`), `app/src/helpers.ts` (`cleanText`,
`slugProblem` with code-slots-admin's `opts`, `isBot`), `content/addresses.ts` (`claimAddress`, `releaseAddress`,
code-slots-admin), `app/src/web/security.ts` (`rateLimit`, `clientKey`, CSRF), `updates/markdown.ts` (`markdown`,
`mdPlain`; gains an options object `{base, ugc}`, §6.6), `discord/index.ts` (discord-pages: `parseWebhookLink`,
`checkWebhook`, `discordRequest`, `discordError`, `webhookPost/Edit`), `community/community.ts` (`outboxAdd(action,
data, {ref, conn})`, `supersede`, `botLastSeen`) and `discord/botReport.ts` (`report()`), honeycomb-shop's
`entitlements.ts`/`premium.ts`/`shop.ts`/`features.ts` (`has`, `entitlement`, `premiumState`, `purchaseUnlock`,
`shopPrice`, `grantFeature`, `registerFeature`, `registerPerk`, `registerEnforcer`), premium-domains' `content/branding.ts` (`brandingHidden`),
custom-dialogs' `notify/notify.ts` (`notify`, `notifyAdmins`, `NOTIFY_TYPES`), `content/themes.ts` (theme list) and
the ported mail helper (`sendCustomEmail`).

Static files (new): `static/css/status.css` (public page), `static/js/status.js` (public: local times, tooltips,
60 s refresh, subscribe via fetch), `static/js/status-manage.js` + `static/css/status-manage.css` (management UI,
loaded lazily by the editor tab only). Email templates (new, same style as `email/weekly_report.json`):
`status_alert.json`, `status_verify.json`, `status_subscribe.json`, `status_update.json`, `status_inactive.json`.

### 4.3 Routing changes

- `app/src/router.ts:32` `APP_ROUTES` += `/terms/status-pages`. `app/src/app/dispatch.ts:18-20` `STATIC` +=
  `['/terms/status-pages', 'terms-status-pages']`.
- Subdomain branch (`app/src/router.ts:80-84` → `public/routes.ts:subdomain`, PHP `index.php:97-117`): the order stays
  link page → code site, then **`statusPageBySlug(slug)` → `statusServe(ctx, page, ctx.path)`**, then a
  **`status_slug_redirects`** row (`until` in the future) → `302 Location: <new status page URL><same path>`, then
  404. Addresses are unique across the three kinds (`site_addresses`), so the order only matters for legacy
  collisions (§3.1, §3.4).
- Path mode (`index.php:75-90`, `public/routes.ts:pathProfile`): after the link page and code site lookups, a status
  page with that slug → `302 Location: <status page URL>/` (the same as code sites, `index.php:78-80`). So
  `on-your.site/status` → `https://status.on-your.site/`.
- `/_/` routes (any host, cookieless, `X-Robots-Tag: noindex`, `app/src/router.ts:65-68`): `/_/hb/`, `/_/health`,
  `/_/status/verify/…`, `/_/status/sub/c/…` and `/_/status/sub/u/…` go to `status/endpoints.ts` before `notPorted`.
- Editor API (`lib/routes_app.php:214-247` preamble; Node `app/src/app/editorApi.ts`): right after the `code*` branch
  (`lib/routes_app.php:248`), **`action` starting with `status` → `statusEditorApi(ctx, user, action, input)`**. That
  branch always ends there, before “Create a page first.” (`:365`), so status pages work without a link page.
- Admin `POST /admin`: a new branch `status_action` next to `hc_action` (map-admin §1.2 #3). Its flash goes to
  `/admin#status`.
- No custom domains for status pages in v1 (premium-domains v1 covers link pages only, premium-domains.md:53). The
  follow-up is `custom_domains.target_type = 'status'` in their table.
- Slug namespace: `slugProblem(slug, null, null, {userId, exceptStatusId, db})` – code-slots-admin's signature with an
  options object (their §4.2), not a 4th positional parameter. It reads `site_addresses`, which already holds link
  pages, code pages, status pages and held addresses. The race between check and insert is closed by
  `claimAddress(db, slug, 'status', pageId, uid)` in the same transaction: the registry's primary key refuses a
  second claim (`AddressTakenError` → “Sorry, the address “x” is already taken.”). The reserved path list
  (`lib/helpers.php:288-300`, `app/src/helpers.ts:62-64`) gains `status` and `health` (they are already forbidden as
  subdomains; this also keeps them out of path mode explicitly).

### 4.4 Public routes on a status host (`name.on-your.site`, `status.on-your.site`)

`/static/*` and `/_/*` are handled before host routing on every host (`app/src/router.ts:45-68`), so pages load
`/static/css/status.css` and theme fonts from their own origin. No route starts a session or sets a cookie.

| Method | Path | Response |
|---|---|---|
| GET, HEAD | `/` | 200 page. `?preview=<token>` lets the owner see an offline page (token like `oys_code_preview_token`, `lib/codesites.php:225-238`, prefix `status-preview`). |
| GET, HEAD | `/incidents/{id}` | 200 incident page. Unknown id or an id from another page → themed 404. |
| GET, HEAD | `/history?page=N` | 200, 20 per page, newest first |
| GET, HEAD | `/summary.json` | 200 JSON (below), `Access-Control-Allow-Origin: *` |
| POST | `/subscribe` | form `email`, `website` (honeypot), `t` (time token). JSON (`Accept: application/json`) → `{"ok":true,"message":"Check your inbox to confirm."}` / `{"ok":false,"error":"…"}`. Plain form → 200 themed notice. |
| other paths | | themed 404 “Page not found” |
| other methods | | 405 with `Allow: GET, HEAD` (POST on `/subscribe`) |

Confirming and unsubscribing do **not** live on the page host (§4.5): those links must work after an address
change, a block, going offline or deleting the page, and a page host answers 451/404 on every route in those states.

States: blocked → 451 notice “This status page has been blocked” / “It broke the rules for status pages on
OnYourSite.” (like `lib/codesites.php:257-260`). Offline without a valid preview → 404 “This status page is
offline”. A user page whose owner never unlocked it (or lost the unlock) → 404 offline notice. The notices use the
page theme (`oys_render_simple` pattern, `lib/render.php:547-561`).

Headers on every HTML answer:
- `Content-Type: text/html; charset=UTF-8`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`;
- `Content-Security-Policy: default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
- `Cache-Control: public, max-age=30, stale-while-revalidate=60, stale-if-error=86400` on `/`, `/incidents/*`,
  `/history`, `/summary.json`, and `no-store` on `/subscribe`;
- a weak `ETag` with 304 support;
- `X-Robots-Tag: noindex` (plus `<meta name="robots" content="noindex">`) when `settings.noindex`, for user pages
  younger than 14 days (`created_at`), while the page name waits for review (`review_note` set, `reviewed_at`
  NULL), on offline/preview answers and on `/subscribe`.

Render cache: an in-process LRU (500 entries), key `pageId:rev:route:variant`, TTL 30 s. The `rev` bump makes owner
edits visible at once, and monitor states are at most 30 s old. Page data comes from 6 queries: page, components +
state, daily rows for 90 days (`WHERE monitor_id IN (…) AND day >= ?`), open incidents + updates, upcoming
maintenance, past incidents, plus `status_gate` from the 2-second meta cache. This stays independent of traffic during
an outage.

**Database down** (`DbUnavailableError`): the last cached copy is served for up to 1 h with `Cache-Control: no-store`
and a **red banner** on top: “We can’t load live data right now (since 14:05). What you see below may be out of date.”
The time comes from the process (first failed query), not from the database. On OnYourSite's own page the renderer
also overrides Website and Database to “Major outage” and the page indicator to `major` – the main site answers 503
at that moment, so “All systems operational” would be wrong. Without any cached copy (e.g. the web app restarted
during the outage): OnYourSite's page renders a static fallback with the same banner, the two components as “Major
outage” and links to Discord and the updates page, status 200; a user page answers 503 with `Retry-After: 60` and a
neutral notice “This status page can’t be loaded right now. Please try again in a few minutes.”

`/summary.json`:

```json
{
  "page": { "name": "Acme status", "url": "https://acme-status.on-your.site/", "updated_at": "2026-11-01T19:20:31Z" },
  "status": { "indicator": "partial", "description": "Partial outage" },
  "components": [
    { "id": 12, "name": "Website", "group": "Core", "status": "major", "uptime_90d": 99.93, "updated_at": "2026-11-01T19:20:00Z" }
  ],
  "incidents": [
    { "id": 7, "title": "Website is unavailable", "status": "investigating", "impact": "major",
      "started_at": "2026-11-01T19:05:10Z", "updated_at": "2026-11-01T19:10:10Z", "url": "https://acme-status.on-your.site/incidents/7" }
  ],
  "maintenance": []
}
```

`indicator` ∈ `operational | degraded | partial | major | maintenance | unknown`. Private components
(`is_public = 0`) never appear.

### 4.5 Endpoints on any host

**`GET|HEAD|POST /_/hb/{token}` and `/_/hb/{token}/fail`** – heartbeat. The token is 32 base64url characters (24
random bytes). Lookup goes by `sha256Hex(token)`.
- Unknown → 404 `Not found` (text/plain). Unknown hashes are remembered for 60 s in memory, so a flood of wrong
  tokens costs no database reads.
- Known → 200 `OK`. A paused or blocked one → 200 `OK (paused)`, so the user's cron doesn't fail.
- Writes `hb_last_ping_at = now` only if the previous ping is ≥ 10 s old (`UPDATE … WHERE id = ? AND (hb_last_ping_at IS NULL OR hb_last_ping_at <= ?)`).
- `/fail` writes `hb_last_fail_at`, at most once per 10 s.
- Limits **per token**, not per client: many jobs behind one NAT or CI egress share a client key (IPv6 is
  aggregated per /64, `lib/helpers.php:360-368`), but each has its own token. An in-memory token bucket per token
  hash (10 requests per 10 s) → 429 `Too many requests`, plus 600/min per client key for unknown tokens only. Both
  live in the web process (LRU of 50,000 keys) and write nothing to `rate_limits` – today every hit there is a write
  (`lib/helpers.php:326-352`).
- `Cache-Control: no-store`, `X-Robots-Tag: noindex`. Request bodies are ignored.
- Cloudflare: jobs call this from servers (curl), which a zone-wide bot challenge can block. `server/README.md`
  says to keep “Bot Fight Mode” off for the zone and, on plans that allow it, to add a WAF skip rule for
  `starts_with(http.request.uri.path, "/_/hb/")`.

**`GET /_/health`** – `{"ok":true,"db":true,"time":1762024831}` or 503 `{"ok":false,"db":false}`. The DB ping is
`SELECT 1`, cached 2 s. No secrets, no-store. This is the target of the system checks `web`, `pages`, `origin`.

**`GET|POST /_/status/verify/{token}`** – confirms an extra alert email address (main domain, the recipient isn't
logged in). GET shows a button, POST sets `verified_at` → “Alerts for Acme status will now go to this address.” The
token is 32 base64url characters, minted by the notifier when it sends the mail (`verify_hash` = sha256, valid 7
days), so it never sits in the outbox.

**`GET|POST /_/status/sub/c/{token}`** – confirms a subscription. The token (32 base64url characters) is minted by
the notifier at send time: `UPDATE status_subscribers SET confirm_hash = ?, confirm_sent_at = ? WHERE id = ? AND
confirmed_at IS NULL`, then the mail goes out; a resend mints a new one, so only the latest link works. Valid 48 h.
GET shows the page's name and a button “Confirm subscription”; POST sets `confirmed_at`, clears `confirm_hash` → “You’re
subscribed to Acme status.” Invalid or used → “This link isn’t valid any more.” A blocked, offline or deleted page →
“This status page isn’t available, so we didn’t subscribe you.”

**`GET|POST /_/status/sub/u/{id}.{mac}`** – unsubscribes. `mac` = the first 32 base64url characters of
`hmac(app_secret, 'status-unsub|' + id)`, checked with `safeEqual` by recomputing it; nothing is stored, so every mail
can carry its own link (a hash could not be turned back into a link). GET shows a button “Unsubscribe”; POST (form,
or the RFC 8058 body `List-Unsubscribe=One-Click`) deletes the row → “You won’t get emails from Acme status any
more.” Idempotent: an already deleted subscriber or a deleted page gives the same answer. This works whatever state
the page is in, because it runs on the main host and never loads the page's host.

The three pages above render in the status page's theme when the page still exists (else the neutral `deep-dark`)
with their own headers: `Cache-Control: no-store`, `X-Robots-Tag: noindex`, and the CSP of §4.4 – `form-action
'self'` fits, because each page posts to its own URL on the main host. Limits: 30 requests/h per client key on each
route, POST only changes state (link scanners only GET).

### 4.6 Editor API (`/dashboard/api/status*`)

Preamble as today: login (401 JSON), CSRF for POST (419), JSON body (400) (`lib/routes_app.php:214-247`). Every
response is `oys_json` (no-store). Every handler loads `page = statusPageForUser(userId)`. With `scope: "system"`
(body) or `?scope=system` (query) the handler instead loads the system page. That is only allowed if `user.is_admin`
is truthy (an impersonating admin is the user, so that's not admin) → otherwise 403
`{"ok":false,"error":"Not allowed."}`. Every write to pages, components or incidents runs in a transaction that locks
the page row (`SELECT id FROM status_pages WHERE id = ? FOR UPDATE`, the pattern of `lib/codesites.php:123-142`) and
bumps `status_pages.rev` and `oys_meta.status_rev`.

Common guards for every action except `status` and `status-unlock` (the order mirrors `lib/routes_app.php:270-292`,
where `code-create` also sits behind the unlock check):
- not unlocked (user scope) → 403 `Unlock status pages with honeycombs first.` – this includes `status-create`, so no
  address can be taken without the unlock;
- no page (every action except `status-create`) → 404 `Create your status page first.`
- page blocked → 200 `{ok:false, error:"Your status page has been blocked by the team: <reason>"}` (reads allowed).

| Action | Method | Input | Output / errors |
|---|---|---|---|
| `status` | any | — | `StatusState` (below). Sets `owner_seen_at = CURDATE()` (once a day). |
| `status-unlock` | POST | `{terms:true, request_id, expected_price}` | Admin mode (impersonating) → 403 `Buying is turned off in admin mode.` (the shop's rule, honeycomb-shop §4.10/§4.11). Terms: like `code-unlock` (map-app §4.2 step 3, column `status_terms_at`). Then honeycomb-shop's `purchaseUnlock(ctx, uid, 'status_page', {requestId, expectedPrice, terms, via: 'status'})` – locked, idempotent by `request_id`; `null` = done (also when already owned), otherwise its text passes through (`You need 150 honeycombs – you have 40.`, `The price changed – this now costs 120 honeycombs.`), plus our `canBuy` rule `Status pages are paused for new accounts right now.` (§4.10). → `StatusState` (+ the shop's `notice`) |
| `status-create` | POST | `{slug, title}` | Unlock guard above. Existing page → `You already have a status page.` In one transaction with the user row locked: `slugProblem(normalizeSlug(slug), null, null, {userId, db})`, `statusBrandProblem(slug)` (§6.6), title `cleanText(…,120)` or the slug and `statusTitleProblem(title)`; INSERT `status_pages`; `claimAddress(db, slug, 'status', id, uid)` (`AddressTakenError` → `Sorry, the address “x” is already taken.`); `rev`. A brand mention in the title sets `review_note`. `allow_new` is **not** checked here: it only stops new unlocks. → `StatusState` |
| `status-page` | POST | `{title?, description?, theme?, accent?, logo_page_id?, back_page_id?, show_uptime?, show_response?, history_days?, subscribe?, hide_branding?, noindex?, auto_incident?, notify_auto?, online?}` | Only keys present change. `title` → `statusTitleProblem` (a new brand mention sets `review_note`, clears `reviewed_at`). `theme` must be a known key. `accent` `#rrggbb` or `''`. Page ids must belong to the user. `hide_branding` only stored true with Premium (like `lib/pages.php:83`). → `StatusState` |
| `status-address` | POST | `{slug}` | Cooldown: confirmed subscribers > 0 and `slug_changed_at` < 30 days ago → `You can change the address again on Dec 1, 2026.` Then in one transaction: `slugProblem(slug, null, null, {userId, exceptStatusId, db})`, `statusBrandProblem`, claim the new address, `releaseAddress(db, old, uid, 'owner', 90)` (held for the owner for 90 days), `INSERT status_slug_redirects (old, pageId, now + 90 d)` (an existing redirect row for the new slug is deleted), `slug_changed_at = now`. → `StatusState` |
| `status-delete` | POST | `{confirm}` | `confirm` must equal the slug → `Type the address to confirm.` One transaction: delete the page, its monitors, incidents (+ updates, links, posts), channels, subscribers, broadcasts, pending outbox rows and redirects; `releaseAddress(db, slug, uid, 'owner', 90)`; one `status_purge` row per monitor plus one for the page. Measured data is removed by the checker in batches (§4.8.13). → `{ok:true}` |
| `status-monitors` | GET | — | `{ok, monitors: Monitor[], usage:{checks, checksMax, components, componentsMax}, worker:{ok, since}, gate:{state, since}}` |
| `status-monitor` | GET | `?id=` | `{ok, monitor, checks:[{at,ok,ms,code,error}] (last 50), hourly:[{hour,avg,min,max,uptime}] (48), daily:[{day,uptime,down_s,maint_s,color}] (90)}` |
| `status-monitor-save` | POST | `MonitorInput` (below) | `{ok, monitor}` / `{ok:false, error, field}`. Rate limit `statussave:<uid>` 60/h → `You’re changing checks very often – please wait a bit.` |
| `status-monitor-delete` | POST | `{id}` | Deletes the monitor row and its incident links, inserts a `status_purge` row (state, aggregates and events go in the checker's batches) → `{ok:true}` |
| `status-monitor-pause` | POST | `{id, paused}` | `{ok, monitor}`. `admin_paused` → `This check was paused by the team.` Resuming also clears `auto_paused` (the checker pauses it again if the site still refuses, §6.2). |
| `status-monitor-order` | POST | `{ids:[…]}` | every id must belong to the page → positions 0…n → `{ok:true}` |
| `status-monitor-run` | POST | `{id}` | “Check now”: `statusrun:<uid>` 10 per 10 min. `INSERT INTO status_run_requests … ON DUPLICATE KEY UPDATE requested_at = VALUES(requested_at)` – no `status_rev` bump, so no reload of every monitor; the checker polls the queue every 2 s → `{ok:true}` |
| `status-monitor-token` | POST | `{id}` | heartbeat only: new token → `{ok, monitor}` (with the new `heartbeatUrl`) |
| `status-monitor-manual` | POST | `{id, status}` | manual only; `status` ∈ operational, degraded, partial, major, maintenance → `{ok, monitor}` |
| `status-incidents` | GET | `?before=<id>` | `{ok, open:[Incident], upcoming:[Incident], past:[Incident] (20), more}` |
| `status-incident-save` | POST | `{id?, kind, title, status, impact, starts_at?, ends_at?, monitors:[{id,effect}], body, notify}` | Create (with first update) or edit the fields. Validation below. `notify` and a new update → broadcast (§4.8.12), refused with the daily-cap text when the page's `broadcasts_day` is used up (the update is still saved). Discord incident posts are queued or marked dirty (§5.8). → `{ok, incident}` |
| `status-incident-update` | POST | `{id, status, body, notify}` | adds an update. `resolved`/`completed` sets `resolved_at`. Broadcast and Discord as above. → `{ok, incident}` |
| `status-incident-edit` | POST | `{id, update_id, body}` or `{id, update_id, delete:true}` | the last update can't be deleted if it's the only one → `{ok, incident}` |
| `status-incident-delete` | POST | `{id}` | removes incident, updates, links and unfinished broadcasts; posted Discord messages are deleted through the same targets (bot `status.delete` job / webhook delete) → `{ok:true}` |
| `status-alerts` | GET | — | `{ok, owner:{enabled,email,events}, admins?:{enabled} (system), bot?:{statusChannel, alertsChannel, choices, ready} (system), channels:[Channel], recent:[OutboxItem] (20), limits:{channels}}` |
| `status-alerts-owner` | POST | `{enabled, events, admins?}` | → same as `status-alerts` |
| `status-channel-add` | POST | `{type, target, events}` (`type` = `email` or `discord`) | email: `validateEmail`, ≤ 190 chars, `statusverify:<uid>` 10/h → verification mail (minted at send time). discord: `parseWebhookLink` + `checkWebhook` (discord-pages' `discord/index.ts`) → test message → only saved if accepted; `events` may include `incident`. Duplicate → `This address is already on the list.` Limit → `You can add up to 3 alert channels.` → `{ok, channel}` |
| `status-bot-channels` | POST | `{status_channel_id, alerts_channel_id}` (system scope only) | Each must be `''` or a channel of the latest bot report with `can_post` (discord-pages' report, `discord_bot_report.channels`) → `That channel isn’t in the bot’s latest report – refresh the list.` Stored in the system page settings (`bot.status_channel_id`, `bot.alerts_channel_id`). → same as `status-alerts` |
| `status-channel-edit` | POST | `{id, events?, enabled?}` | → `{ok, channel}` |
| `status-channel-remove` / `-test` / `-resend` | POST | `{id}` | test: 3 per 10 min. resend: only unverified, 1 per 10 min. → `{ok, …}` |
| `status-subscribers` | GET | — | `{ok, enabled, confirmed, pending, limit}` |
| `status-subscribers-clear` | POST | `{confirm:true}` | deletes all → `{ok:true}` |

Shapes (key order as listed; booleans are real JSON booleans):

```ts
type StatusState = {
  ok: true; unlocked: boolean; terms: boolean; balance: number; premium: boolean;
  readOnly: boolean;                                // Admin-Modus: Kaufen gesperrt (Regel des Shops)
  buy: { state: 'buy' | 'owned' | 'paused' | 'locked'; note: string; price: number; listPrice: number };  // aus dem Shop (quote)
  limits: { checks: number; components: number; minInterval: number; intervals: number[]; timeoutMax: number;
            channels: number; subscribers: number; broadcastsDay: number;
            until: string | null };                 // until: Ende eines Zusatzpakets oder von Premium
  gate: { state: 'ok' | 'hold' | 'frozen'; since: number | null };   // Plattform-Sperre (4.8.15)
  page: null | {
    id: number; slug: string; title: string; description: string; url: string; online: boolean;
    blocked: boolean; blockedReason: string; review: string; preview: string; theme: string; settings: PageSettings;
    addressChangeAt: string | null;                 // frühester nächster Adresswechsel (Sperrfrist), sonst null
    status: 'operational' | 'degraded' | 'partial' | 'major' | 'maintenance' | 'unknown';
    kpis: { uptime30: number | null; avgMs: number | null; openIncidents: number; subscribers: number };
    paused: '' | 'team' | 'inactive' | 'module';  // warum Prüfungen ruhen
  };
};
type Monitor = {
  id: number; type: 'http' | 'heartbeat' | 'manual' | 'system'; name: string; description: string; group: string;
  position: number; public: boolean; target: string; prettyTarget: string; interval: number; effectiveInterval: number;
  config: Record<string, unknown>; paused: boolean; adminPaused: boolean; adminNote: string; overLimit: boolean;
  autoPaused: '' | 'private_ip' | 'refused' | 'robots';
  heartbeatUrl: string | null; manualStatus: string | null;
  state: { status: 'up' | 'down' | 'degraded' | 'unknown' | 'paused' | 'maintenance'; since: number | null;
           lastCheck: number | null; lastMs: number | null; lastCode: number | null; error: string | null;
           errorText: string; pending: boolean; flapping: boolean; throttled: boolean; certExpires: number | null;
           refusedSince: number | null };          // 403/429 ohne Unterbrechung seit …
  strip: Array<{ at: number; ok: boolean; ms: number | null }>;   // letzte 30
};
type MonitorInput = {
  id?: number; type: 'http' | 'heartbeat' | 'manual'; name: string; description?: string; group?: string;
  public?: boolean; url?: string; interval?: number; method?: 'GET' | 'HEAD'; expect?: string; keyword?: string;
  keyword_mode?: 'contains' | 'absent'; keyword_case?: boolean; timeout?: number; retries?: number; slow_ms?: number;
  redirects?: boolean; cert_warn?: boolean; tls_ignore?: boolean; period?: number; grace?: number; status?: string;
};
```

`status-monitor-save` validation, in order (first error wins; `field` names the input):
1. `type` ∈ http, heartbeat, manual (system components can only be edited in system scope, and only name, description,
   group, public).
2. `name` = `cleanText(name, 80)` non-empty → `Please give the component a name.` `description` ≤ 200, `group` ≤ 60.
3. Count (in the page lock): components ≥ `components_max` → `A status page can have up to 40 components.` New
   http/heartbeat at ≥ `limits.checks` → `You’ve used all 10 checks. Remove one, or get more checks in the shop.`
4. http: `parseTarget(url)` (§6.1) with its messages; then `interval` ∈ `intervals` and ≥ `limits.minInterval` →
   `You can check every 3 minutes at most. “Fast checks” or Premium check every minute.`; `timeout` < interval,
   ≤ `timeout_max`; `expect`/`keyword`/`slow_ms` as in §3.2 → `Expected status codes look like 200-299,301.`
5. http: host rules (exact host, or a `.domain` rule matching the host or its registrable domain) → `Monitoring this
   site isn’t allowed. The site owner asked us not to check it.`; a known `robots.txt` opt-out for this path
   (`status_host_meta`) → `The site’s robots.txt asks us not to check this address.`; per-host cap
   (`SELECT COUNT(*) FROM status_monitors WHERE target_host = ? AND type = 'http' AND id <> ?` vs `host_cap` or the
   rule's `max_monitors`) and per-domain cap (same on `target_domain` vs `domain_cap`) → `This site is already
   checked by many accounts – please contact us if you need it.`
6. http: DNS pre-check with the public resolver (5 s). If it resolves to a blocked address → the private-network
   message. NXDOMAIN, timeout or no addresses → saved anyway, `warning: "We couldn’t find this address yet – the
   first check will tell."` `target_domain` = `registrableDomain(host)` (`psl.ts`; an IP literal is its own domain).
7. heartbeat: `period` 60–86400, `grace` 60–3600. A new token on create.
8. manual: `status` valid.

Premium and the add-ons for validation always come from `statusLimits(userId)` (DB: the shop's `entitlement()` and
`premiumState()`). The session-based `hasPremium` (`lib/routes_app.php:23`) is not used here, so an admin
impersonating a user can't save values the user's plan doesn't allow.

Incident validation: `title` `cleanText(…,160)` required; `kind` incident|maintenance; `status` valid for the kind;
`impact` none|minor|major|critical (maintenance → `maintenance`); `body` `cleanText(…, 5000, multiline)` required for
new updates (“Please write what’s going on.”); maintenance `starts_at` < `ends_at`, `ends_at` − `starts_at` ≤ 7 days,
`starts_at` ≥ now − 1 h; `monitors[].id` from this page, `effect` valid. Rate limit `statusinc:<pageId>`
`updates_per_hour` (20) → `That’s a lot of updates – please wait a bit before posting again.`

### 4.7 Admin actions (`POST /admin`, CSRF field, `status_action=…`)

| `status_action` | Fields | Effect / flash |
|---|---|---|
| `settings` | all fields of §3.3 `status` | clamp + save (subscriber limits checked against `mail_per_day`) → “Status settings saved.” |
| `block` / `unblock` | `page_id`, `reason` | like `code_block` (`lib/honeycombs.php:219-229`) + rev + `notify(owner, 'status_team', …)` → ““acme-status” is blocked.” / “… is online again.” |
| `review_ok` | `page_id` | `reviewed_at = now` (the brand mention in the name is fine) → “Name approved – the page can be found by search engines again.” |
| `monitor_pause` / `monitor_resume` | `monitor_id`, `note` | `admin_paused`, `admin_note` + rev + `notify(owner, 'status_team', …)` → “Check paused.” |
| `host_rule_save` | `host` (`example.com` or `.example.com` = the domain and all its subdomains), `rule` block\|allow, `max_monitors`, `note` | normalised like `parseTarget` hosts. `block` pauses matching checks (`admin_paused = 1`, note “The site owner asked us not to check it.”, owners notified) → “Rule saved – 3 checks paused.” |
| `host_rule_delete` | `host` | → “Rule removed.” (paused checks stay paused until resumed one by one or with “Resume all for this site”) |
| `unlock` | `user_id` | free unlock: honeycomb-shop's `grantFeature(adminId, uid, 'status_page', {permanent: true}, 'Unlocked by the team')` (audited there; the shop's “Unlock grants” sub-tab does the same) → “Status pages unlocked for Mia.” |
| `checks_pause` / `checks_resume` | — | `run_user_checks` false/true → “All user checks are paused.” |

### 4.8 The checker (`onyoursite-status.service`) and the notifier (`onyoursite-status-notify.service`)

§4.8.1–4.8.10, 4.8.13–4.8.15 run in the checker, §4.8.11–4.8.12 in the notifier. Both are entry points of the same
build and share the model code.

**4.8.1 Start, leader lock, shutdown.**
- At start: `loadConfig()`, `process.env.TZ = timeZone()` (like `app/src/server.ts:21-26`). The checker refuses to
  start when `db.host` is not `localhost` (the Unix socket, `app/src/db.ts:63-68`): its sandbox blocks every local
  TCP address (§8), so a TCP database would only fail later and less clearly. Log: “The status checker needs the
  database socket – set db.host to localhost in config.json.” The installer writes `localhost`
  (`server/install.sh:373`).
- **No migrations.** Neither process calls `ensureSchemaOnce()`. They read `oys_meta.schema_version` and wait,
  read-only, until it is ≥ `STATUS_V` (“Waiting for the database update (schema 9 < 11).”, re-checked every 10 s).
  Migrations run in the web app or `cli.js migrate`, as today. During `--reset` they therefore never write into a
  half-created database.
- Each takes its own `GET_LOCK('oys_status_worker' | 'oys_status_notify', 0)` on a dedicated connection held for the
  process lifetime. If another instance holds it, it logs “Another status worker is running – waiting.” and retries
  every 30 s, so there is never a double run, even during restarts.
- The lock connection is pinged every 10 s. If it fails, the lock is gone: in-flight work is aborted, nothing more
  is written, and the process re-acquires.
- `SIGTERM`: stop scheduling, wait ≤ 10 s for in-flight checks or sends, flush all buffers, release the lock, exit 0
  (`TimeoutStopSec=20`).

**4.8.2 Sync.** Every 5 s the checker reads `oys_meta.status_rev`. When it changes, it loads the monitors and pages
whose `changed_at` is newer than its last sync (minus 2 s), the open incidents and maintenance, the host rules and the
limits of the affected users (`statusLimits`, cached 60 s; a page whose `changed_at` moved re-reads its owner's
limits past the cache, which is how purchases and expiries take effect within seconds, §4.10).
It diffs against memory: new → schedule; changed → run within 5 s (jitter). Deleted monitors and pages arrive through
`status_purge` and are dropped. A full reload runs every 10 minutes as a safety net. “Check now” requests come from
`status_run_requests` (polled every 2 s) and never trigger a reload.
The heartbeat columns are read every 15 s in the sweep (`SELECT id, hb_last_ping_at, hb_last_fail_at FROM status_monitors WHERE type = 'heartbeat'`).
A monitor runs only if all of these hold: not paused by user, admin or itself (`auto_paused`), not over limit, page
not blocked, owner not inactive, `run_user_checks` on (the system page is exempt). Offline pages keep checking, so
owners can test before going live.

**4.8.3 Scheduler.**
- A min-heap keyed by the due time.
- First run: `last_check_at + interval` from `status_state`, or `now + (crc32(id) mod interval)`. This spreads checks
  evenly and keeps them away from :00.
- After a result: on failure with retries left, run again after `min(20 s, interval/3)`. Otherwise the next run is
  `previousDue + effectiveInterval`, anchored so there is no drift; if more than one interval behind, `now + interval`.
- The loop wakes on the earliest due time (or within 1 s), takes everything that is due and starts what the gates
  allow (4.8.4). Anything held back goes back with `due = now + wait` (buckets) or `now + 250 ms` (capacity). A
  check delayed by host, domain or IP limits sets `throttled_at`, which the editor shows as “Delayed: this site gets
  many checks”. The schedule lag (start time − due time) is measured per check; its p95 over 10 minutes goes into
  `status_worker.lag_p95_ms` and the admin card.

**4.8.4 Concurrency and politeness** (16 vCPUs: CPU is no gate; the gates are sized for the in-flight load of §6.8,
protect targets and keep network and DB calm):
- at most `concurrency` (1,000, config) checks in flight overall;
- at most `keyword_concurrency` (64) keyword checks in flight – they read up to 512 KiB of body each;
- at most `user_inflight` (32) in flight per user (30 checks that all time out at 30 s, with retries, need about 30);
- at most 1 per monitor (the next run waits for the current one);
- token buckets: per target host `host_per_min` (30/min, burst 5), per registrable domain `domain_per_min` (60/min,
  burst 10; `a.victim.com` and `b.victim.com` share it), per resolved IP `ip_per_min` (3,000/min, burst 100). The IP
  bucket is a ceiling against many domains pointed at one server; it is far above what shared anycast addresses
  (e.g. one IP for thousands of Vercel or GitHub Pages sites) see from us, so unrelated owners don't slow each other
  down. There is no per-IP connection gate any more.
- **429** from a target pauses that host for `min(Retry-After, 3600)` s (60 s without `Retry-After`); the check counts
  as “delayed”, not as a result. 429 answers without a break for more than 1 h show as “Rate-limited by the site” in
  the editor (public: “Not checked right now”), and after 24 h the check pauses itself (§6.2).
- **503 is always a failed result** (error `status`), with or without `Retry-After`: a site stuck in maintenance mode
  (WordPress's `wp_maintenance()` answers 503 with `Retry-After: 600`) is down for its visitors. `Retry-After` only
  spaces the retry: `max(normal retry spacing, min(Retry-After, interval))`.

**4.8.5 HTTP check, step by step** (`http.ts`):
1. `parseTarget(url)` again (rules can change) plus host and domain rules, plus the host's `robots.txt` group for
   `OnYourSite-Monitor` (`robots.ts`, fetched at most once a day, §6.2).
2. `resolvePublic(host)` (`resolver.ts`): an IP literal is checked directly. Otherwise the checker runs
   `resolve4` and `resolve6` on its own `dns.promises.Resolver` with the servers from config, timeout 2.5 s, 2 tries.
   It **never** uses `getaddrinfo`/`/etc/hosts`/the system resolver (on the server `/etc/hosts` maps the own domain
   to 127.0.0.1, `server/install.sh:982`). Results are cached for min(TTL, 300 s), errors for 60 s. **Every**
   returned address must pass `classifyIp` (§6.1). If one fails → error `blocked`. IPv4 is preferred; IPv6 is used
   only if there are no A records. With several A records one is picked at random per check.
   A resolver **timeout or SERVFAIL** is the target's problem (`dns`) – a zone with dead name servers or broken
   DNSSEC produces exactly that – unless the resolver canary fails at the same time (§4.8.15): then it is `internal`.
3. The checker connects with `http(s).request({host, port, path, method, agent: false, lookup: pinned, timeout, headers})`.
   `pinned` hands out exactly the validated address and honours `options.all` (Node 22 calls lookup with
   `{all:true}` when `autoSelectFamily` is on). SNI and certificate checks still use the hostname.
   - After `connect` the checker checks `socket.remoteAddress` against the pinned address once more, and against the
     server's own addresses (`os.networkInterfaces()` refreshed every minute, plus `status.self_ips`): with the
     tunnel they are always refused; without it only ports 80 and 443 are allowed (users may check their own
     `name.on-your.site`, which then resolves to this server).
   - Headers: `User-Agent: OnYourSite-Monitor/1.0 (+https://on-your.site/terms/status-pages#checks)`,
     `Accept: */*`, `Accept-Encoding: gzip, deflate, br` only when a keyword is set (else `identity`),
     `Connection: close`, and `Cache-Control: no-cache`. No cookies, no credentials, no body.
4. Deadline = `timeout` for the whole check, including redirects (AbortController). The response time is time to
   response headers.
5. Redirects (if `redirects`): 301/302/303/307/308 are followed manually, at most 5. `Location` is resolved against
   the current URL, and every hop goes through steps 1–3 again (scheme, port, host rules, DNS, IP). HEAD stays HEAD,
   303 becomes GET. A blocked hop → error `redirect`. A loop → error `redirect`.
6. Status: the final code is checked against `expect`.
7. Body: only with a keyword. The checker reads up to `keyword_kb` (512 KiB) of the **decoded** body (zlib/brotli
   streams with an output limit; more decoded output → stop and search what was read) from `text/*`, `application/json`
   or `*+xml` / `application/xml`. Otherwise → error `keyword` (“Not a text response.”). Without a keyword the socket
   is destroyed right after the headers.
8. TLS: when `rejectUnauthorized` is true (default) a certificate problem → error `tls` with a fixed reason (expired,
   not trusted, wrong name). `valid_to` of the peer certificate → `cert_expires_at`. With `tls_ignore` the expiry is
   still read and warned about.
9. Status code classes: 429 → “delayed” (no result, §4.8.4); 403 and 429 start or continue `refused_since`; any other
   code ends it. 503 is an ordinary failed result.
10. Result `{ok, ms, code, error, certExpires}`.

**Our side or theirs.** These are always `internal` (never counted against the target, state unchanged): socket
errors that come from this machine – `EMFILE`, `ENFILE`, `ENOBUFS`, `EADDRNOTAVAIL`, `ENETUNREACH` (no route here);
an aborted check (lock loss, shutdown); an exception in our code; a timeout while the event loop was blocked (the
`perf_hooks.monitorEventLoopDelay` p99 of the last 10 s above 1 s); and DNS failures while the resolver canary fails.
Every `internal` result also feeds the gate (§4.8.15).

Error keys and texts (the texts are ours, never remote content):

| Key | Text shown |
|---|---|
| `dns` | Couldn’t find this address (DNS). |
| `blocked` | This address now points to a private network. (3 in a row → the check pauses itself, `auto_paused = 'private_ip'`, “Paused: the address points to a private network.”, plus an admin log line) |
| `connect` | Couldn’t connect. |
| `ipv6` | This site only has an IPv6 address, which our checker can’t reach. |
| `timeout` | No answer within {n} s. |
| `tls` | Certificate problem: {expired \| not trusted \| wrong name}. |
| `status` | Answered with HTTP {code}. (403/429 for 24 h → `auto_paused = 'refused'`, “Paused: the site asked us to stop.”) |
| `keyword` | The keyword wasn’t found. / The keyword was found. / Not a text response. |
| `redirect` | Too many redirects. / Redirected to an address we don’t check. |
| `robots` | Paused: the site’s robots.txt asks us not to check this address. (`auto_paused = 'robots'`, lifted by the next daily fetch that allows it) |
| `hb_missed` | No ping since {time}. |
| `hb_failed` | Your job reported a failure. |
| `internal` | The check couldn’t run (our side). (not counted against the target: state unchanged; see “Our side or theirs” above) |

**4.8.6 Heartbeat, manual and system components.**
- Heartbeat: a ping (`hb_last_ping_at` newer than the last seen) → ok row. `hb_last_fail_at` newer → failed
  `hb_failed` immediately. Before the first ping → `unknown`. A ping can only arrive if **our** ingress works
  (Cloudflare → tunnel → web app → database). So the deadline counts from whichever is later, the last ping or the
  end of our last ingress problem:
  `deadline = max(hb_last_ping_at, ingress_recovered_at) + period + grace`, and `now > deadline` → one failed
  result `hb_missed` (no retries, the grace is the retry).
  `ingress_recovered_at` (kept in `status_gate`) is the end of the latest interval in which the ingress was unhealthy
  or unknown: the `web` or `pages` system check failing, the sensor's `tunnel` or `origin` probe failing, the
  checker unable to reach the database, a planned window from the installer (`status_planned`, §8), the minute before
  a web app start (`status_web_start`), the platform gate being closed, and the checker's own downtime when it was
  away for more than 2 minutes (the gap since the last `status_worker.at`). Why “restart the clock” and not “add the
  outage length”: a job that pings hourly and whose 11:00 ping hit our outage pings again only at 12:00; adding 20
  minutes of outage to a 10:00 ping would still report it missing at 11:25.
- Manual: no results. In the 15 s sweep the elapsed time counts into the buckets by `manual_status`: major/partial →
  `down_s`, degraded → `degraded_s`, maintenance → `maint_s`.
- System: §4.9.

**4.8.7 State machine** (`state.ts`, pure, unit-tested). Counters: `fails`, `oks`, `slows` (consecutive), plus a ring
of the last 10 up/down transition times.

| From | Input | Rule | To | Event |
|---|---|---|---|---|
| unknown | ok | — | up | — |
| unknown / up / degraded | fail | `fails < 1 + retries` | unchanged (pending) | — (retry soon) |
| unknown / up / degraded | fail | `fails = 1 + retries` | down (`since` = time of the **first** failed check) | `down` |
| up | ok, slow | `slow_ms` > 0 and 3 slow in a row | degraded | `degraded` |
| degraded | ok, fast | — | up | `recovered` |
| down | ok | 1 success | up (degraded if slow) | `up` (with downtime duration) |
| any | — | ≥ 6 up/down transitions within 60 min | `flapping = 1` | `flapping` (once). Alerts for this monitor are muted. The public status shows *degraded*. |
| flapping | — | no transition for 30 min | `flapping = 0` | `stable` (with the current state) |
| any | `internal` | — | unchanged | — |
| any | any | gate `frozen` (§4.8.15) | unchanged; the result is recorded as `internal` | — |
| unknown / up / degraded | fail | gate `hold` and this would be the `down` transition | unchanged (pending, `since` kept) | — until the hold ends: then `down` with the first failure's time, or nothing if the gate froze |

Every transition also writes a `status_events` row (the editor's history). Certificate (`cert_warn` on):
`cert_expires_at` − now ≤ 14 days → `cert` event, and again at ≤ 3 days, via `cert_warned`. It resets when a later
expiry shows up. Maintenance: while an in-progress maintenance covers the monitor, events are recorded but not
alerted, and `down`/`degraded` time counts as `maint_s`. If the monitor is still down when the maintenance ends, a
`down` alert goes out then.

**4.8.8 Public component status** (`aggregate.ts:componentStatus`, used by the renderer, the JSON and the editor):
1. Paused (by the owner, the team or itself), over limit, module paused, inactive, or rate-limited by the site (429)
   for more than 1 h → `unknown` (“Not checked right now”). Manual → `manual_status`.
2. Otherwise from the monitor state: up → operational; degraded or flapping → degraded; down → major; unknown →
   unknown.
3. An in-progress maintenance covering it → `maintenance`, and that replaces an automatic `major`/`degraded`.
4. Effects from unresolved incidents: worst of (2/3, the incident effects). Severity order: major > partial > degraded
   > maintenance > operational > unknown.

Page indicator:
- **major** “Major outage” if every public checked component is major;
- else **partial** “Partial outage” if any is major or partial;
- else **degraded** “Degraded performance”;
- else **maintenance** “Maintenance in progress”;
- else **operational** “All systems operational”;
- **unknown** “No data yet” if every component is unknown.

**4.8.9 Aggregation and flush.** For each result the elapsed time since the previous result (capped at
`2 × interval + timeout`; anything beyond counts as not covered) is credited to the state **before** this result:
`covered_s` and one of `down_s`/`degraded_s`/`maint_s`. Time while the gate is frozen is never covered: it counts
neither as up nor as down. When `down` is confirmed, the pending stretch since the first
failure moves from up to down. Spans are split exactly at UTC hour borders (hourly) and at local midnights of the site
time zone (daily; DST days have 23 or 25 hours). Response times (ok results only) feed `ms_sum/ms_count/ms_min/ms_max`.
- Every 5 s, multi-row `INSERT IGNORE INTO status_checks …` and `INSERT INTO status_state … ON DUPLICATE KEY UPDATE`
  run with one row per monitor and the latest values.
- Every 10 s, `INSERT INTO status_hourly/status_daily … ON DUPLICATE KEY UPDATE checks = checks + VALUES(checks), …, ms_min = LEAST(COALESCE(ms_min, VALUES(ms_min)), VALUES(ms_min)), …`
  writes the deltas. A failed statement is retried with the same deltas (atomic, no double counting). A crash loses
  at most 10 s of aggregates.
- Uptime % = `100 × (1 − Σdown_s / Σ(covered_s − maint_s))`, floored to 2 decimals (99.999 shows 99.99). With no
  covered time → “—”.

**4.8.10 Automatic incidents and maintenance transitions** (every 30 s and on state change):
- **Open.** If `settings.auto_incident` > 0 and a public monitor has been down for at least that long (not in
  maintenance, not flapping, and the gate was `ok` the whole time – frozen or held time doesn't count), the checker
  attaches the monitor to the page's open auto incident if one exists, was started < 10 min ago and is not edited. In
  that case the title becomes “Several components are unavailable”. Otherwise it creates an incident: title “{Name}
  is unavailable”, status investigating, impact major, effect major, `is_auto = 1`, first update (auto) “We’re aware
  that {Name} isn’t responding and we’re looking into it.”
- **Close.** Each attached monitor is either *up again* or *no longer monitored* (deleted, paused by the owner, the
  team or itself, over the limit, owner inactive, or `run_user_checks` off). A monitor that leaves monitoring gets
  the automatic update “{Name} is no longer monitored.” Once every attached monitor is in one of the two states: if
  `auto_edited = 0` → update “{Name} is responding again.” (or the not-monitored text) plus resolved
  (compare-and-set). Otherwise → automatic update with status monitoring; the owner resolves. A frozen gate is not
  “no longer monitored”: the checker waits for the gate to open.
- **Maintenance.** At `starts_at` the checker sets `UPDATE … SET status='in_progress' WHERE id=? AND status='scheduled'`
  plus the automatic update “The scheduled maintenance has started.” At `ends_at`, `status='completed'`,
  `resolved_at`, plus “The scheduled maintenance is complete.” An owner can complete it early or move `ends_at`.
- Each automatic update with `notify` (or `notify_auto` for auto incidents) queues a broadcast (4.8.12, within the
  page's daily cap) and updates the incident's Discord posts (§5.8).

**4.8.11 Alerts (outbox, delivered by the notifier).**
- Events become rows in `status_outbox` (`kind = alert`, one per recipient), written by the checker in the same
  transaction as the state change: owner email (if enabled and the event is selected), every verified and enabled
  channel with that event, the bell, all admins (`alerts.admins`, system page) and the bot (system page, #alerts).
  `class` is `system` for the system page and `owner` for user pages (§4.8.12).
- **Bell.** custom-dialogs' `notify(userId, type, title, body, link, {db})`, called by the notifier inside the
  transaction that marks the bell's outbox row `sent` – the outbox row is the idempotency (custom-dialogs keeps no
  de-duplication of its own, “every job keeps its own idempotency state”). Types: `status_down` (tone err) and
  `status_up` (tone ok, also for cert and heartbeat events), and `status_team` (block, unblock, team pause/resume,
  inactivity pause; icon `bx-shield-quarter`); custom-dialogs' catalogue already has the row `status` (`bx-pulse`,
  `/dashboard#status`), which the lookup “exact type, then the part before the first `_`” falls back to, and our PR
  adds the three exact rows. Admins get `notifyAdmins('status', …)`: monitor events of OnYourSite's page link to
  `/dashboard#status:system`, the watchdog to `/admin#status`.
- Delivery loop every 2 s takes `pending` rows with `next_at <= now` (an indexed read on `idx_due`; alerts therefore
  leave within about 2 s of the state change).
- **Coalescing.** If an `up` arrives while the `down` for the same monitor and recipient is still pending, both become
  one message “{Name} was down for 40 s” (`down` → `merged`).
- **Retries.** Retries happen after 30 s, 2 min and 10 min, then `failed`. After a restart, pending rows younger than
  30 min are delivered, older ones are skipped.
- **Discord.** discord-pages' `discordRequest`/`webhookPost` (`app/src/discord/index.ts`, today
  `lib/updates.php:614-653`) with `allowed_mentions: {parse: []}`, 10 s timeout, no redirects. 401/404 (codes
  10015/10003) → `fail_count++`. 5 in a row → channel disabled + `channel_broken` mail to the owner.
- **Email.** The ported `sendCustomEmail` with template `status_alert`, 15 s timeout.
- **Bot.** Only when the latest bot report lists the feature `status.v1` (discord-pages' report and feature registry):
  `outboxAdd('status.alert', {channel_id: <#alerts id>, embed}, {ref: 'status-alert'})`. Otherwise the bot is skipped
  and admins still get email and bell; the admin card says “The bot doesn’t support status messages yet – update it
  with discord-bot/install.sh --update.” The outbox registry hands `status.*` jobs only to a bot polling with
  `f=…status.v1`, so an old bot never receives them (it would fail them ten times, `discord-bot/src/outbox.js:21-29`).
- **Caps.** At most 30 alert messages per page per hour across all channels; beyond that one message “Too many alerts
  – Acme status alerts are muted for an hour.” Email alerts of a user page additionally stop at `owner_mails_hour`
  (12) and `owner_mails_day` (50) with one final “Alerts are muted until tomorrow” mail. The system page is exempt.

**4.8.12 Subscriber broadcasts and the mail budget (notifier).**
- When a web request (or the checker) posts an update with notify on, it inserts `status_broadcasts` and marks
  unfinished broadcasts of the same incident `superseded`. Subscribers then only get the newest text.
- Per-page caps: at most `broadcasts_day` broadcasts per page and day (3, Premium 10; counted on `created_at`), and at
  most 10 per incident (`sub_mails`). Later updates still show on the page. This also stops a page from being used
  as a newsletter sent from OnYourSite's domain.
- **One SMTP budget, four classes.** `mail_per_min` is a token bucket and `mail_per_day` a daily counter for all
  status mail. Within it:
  1. `system` – OnYourSite's own alerts and the watchdog: never held back by the classes below (still counted);
  2. `confirm` – subscriber confirmations and alert-address verifications: at most `confirm_share` (10 %) of the day;
     at most 3 confirmation mails per address per day across all pages (`rateLimit('statusconf:' + email_hash, 3,
     86400)`, the hash is the same for every page). When the class is used up, `/subscribe` answers “This page can’t
     take new subscribers right now. Please try again tomorrow.” instead of queueing;
  3. `owner` – alerts to owners and their extra addresses: at most `owner_share` (30 %) of the day, plus the per-page
     caps of §4.8.11;
  4. `broadcast` – whatever is left. Pages take turns: every 10 s the notifier sends up to `mail_per_min / 6` mails,
     handing out batches of at most 20 per page in round robin over the pages with a queued broadcast, so one page with
     many subscribers can't hold back the others. A broadcast that hasn't finished within 12 h is `expired` (the update
     is on the page anyway).
- Subject: “[Acme status] Investigating: Website is unavailable”. Each mail carries its own unsubscribe link
  (`/_/status/sub/u/{id}.{mac}`, §4.5), the `List-Unsubscribe` / `List-Unsubscribe-Post` headers and a footer line
  “Report this status page: https://on-your.site/terms/status-pages?page=acme-status#report”.
- Confirmation mails (`sub_confirm`) and channel verifications (`channel_verify`) go through the outbox too; the
  notifier mints their tokens when it sends them, so `status_outbox.payload` holds only ids. The web request stays
  fast and the budget holds: “You’ll get an email within a minute.”
- Budget empty for the day → broadcasts wait. The admin card shows the four classes (“Emails today: system 4 · confirm
  80/100 · owner 120/300 · updates 410”).

**4.8.13 Retention, purge, partitions, inactivity (checker).**
- Retention as in §3.6, every hour at :07, in batches of 5,000 with a 50 ms pause.
- **Partitions** daily at 00:20 UTC and at start: add the next 3 days, drop days older than `raw_days`.
- **Purge queue** every minute: for each `status_purge` row, delete `status_state`, `status_hourly`,
  `status_daily`, `status_events` and `status_incident_monitors` rows of that monitor (or of every monitor of that
  page) in PK-range batches of 5,000, then delete the purge row. Raw checks age out with their partitions. This
  replaces the hourly `NOT IN (SELECT …)` orphan sweep, which would scan the raw table, and keeps the web request of
  `status-delete` short.
- **Inactivity**, daily 04:10 local: pages whose `owner_seen_at` is older than `inactive_days` − 14 get one
  `inactive_warning` mail (class `owner`). At `inactive_days` their checks pause (computed, `paused: 'inactive'`) and
  the owner gets a `status_team` bell notice. `owner_seen_at` is refreshed by `GET status` and by `GET /dashboard`.

**4.8.14 Health record and logs.**
- `status_worker` (checker) and `status_notify` (notifier) are written to oys_meta every 30 s.
- The journal (stdout) gets only start/stop, lock changes, gate changes, state changes (`down`/`up`, without URLs of
  other users: `monitor #123 down (timeout)`), delivery errors and a summary every 10 minutes (“1,204 checks, 3
  failed, 0 delayed, lag p95 0.4 s” / “12 alerts, 40 mails”).

**4.8.15 Platform health gate (`gate.ts`).** OnYourSite's own problems must never look like an outage of a user's
site. The gate has three states, kept in memory, written to `oys_meta.status_gate` on every change and shown in the
editor, on public pages and on the admin card.

| State | Entered when | Effect on user checks (http and heartbeat on every page, also admin-added website checks on the system page) |
|---|---|---|
| `ok` | normal | as described above |
| `hold` | more than 30 % of the distinct hosts checked in the last 2 minutes failed (at least 20 hosts), while the canaries are fine | new `down` transitions wait (results are kept, `since` stays the first failure); canaries run every 10 s. After 3 minutes with healthy canaries the hold ends and the waiting transitions happen with their real start time (a big CDN outage is real and must alert). If the canaries fail meanwhile → `frozen`. |
| `frozen` | 2 of the 3 canaries fail in two rounds in a row (30 s apart); or the resolver canary fails; or local socket errors (`EMFILE`, `ENFILE`, `ENOBUFS`, `EADDRNOTAVAIL`, `ENETUNREACH`) hit more than 5 checks within 30 s | every result is recorded as `internal`; no state transitions, no alerts, no auto incidents, no retries; the time is not covered. Public pages and the editor show “Checks are paused – a problem on our side since 14:05.” The checker keeps running checks on schedule. The gate reopens after two healthy canary rounds in a row (≥ 2 of 3 canaries and the resolver canary) with no local socket error in the last 60 s; checks continue where they were. |

- **Canaries** (config `status.canaries`): three fixed HTTPS endpoints on different networks, built for
  connectivity checks, requested every 30 s through exactly the same code path as user checks (resolver, pinned
  connection, TLS), 5 s timeout. The **resolver canary** resolves the three canary names and the own base domain on
  each configured resolver; it fails when no resolver answers. Canary traffic: 6 small requests a minute.
- **System components are never frozen.** The gate is about our platform, so OnYourSite's own page must show it:
  when the gate freezes, admins get a `system` alert (“User checks are paused: this server can’t reach the internet
  reliably (canaries 0/3).”) and the `web`/`pages` components show what they see.
- **Ingress** (for heartbeats, §4.8.6): the gate also tracks `ingress_recovered_at` from the `web`/`pages` checks, the
  sensor's probes, database reachability, planned windows (`status_planned`) and web app starts (`status_web_start`).
- `gateStep(prev, signals, now)` is a pure function with unit tests for every row above; the integration test kills
  the test DNS server and the canary servers (§7).

### 4.9 OnYourSite's own checks (system components) and the local sensor

| Key | Name (group) | How | Interval | Public by default |
|---|---|---|---|---|
| `web` | Website | checker: `GET https://<base>/_/health` resolved via the **public** resolver → through Cloudflare and the tunnel (the same path visitors take). OK = 200 + `ok:true`. | 60 s | yes |
| `pages` | Profile & code pages | checker: `GET https://health.<base>/_/health` (`health` can never be a user slug, `blacklist.php:51`; `/_/` routes work on every host) – tests the wildcard DNS and tunnel ingress for `*.<base>` | 60 s | yes |
| `domains` | Custom domains | checker: `GET https://<fallback origin host>/_/health` (host from premium-domains). This is the link-page custom domain service, not status pages. Only shown once custom domains exist. | 120 s | yes |
| `bot` | Discord bot | checker, from three signals: `botLastSeen()` (`lib/community.php:57-72`) ≤ 180 s (the process polls the site); the latest bot report (discord-pages' `discord_bot_report.reported_at`) ≤ 25 min old (sent on ready and every 10 min); and the report's `gateway.ready` (added by the status bot changes, §9). `botLastSeen` alone is not enough: the outbox loop keeps polling while the gateway is disconnected (`discord-bot/index.js:65-86`). Last seen too old or `gateway.ready = false` for 2 min → major; report too old → degraded. Hidden without `bot_secret`. | 60 s | yes |
| `mail` | Email | sensor: nodemailer `verify()` against `email/smtp.json` every 10 min (15 s timeout) → `status_probe.smtp`; plus the notifier's recent delivery errors (`status_notify.smtp_fail` ≥ 3 in a row → major). Hidden without SMTP. | 600 s | yes |
| `db` | Database (Infrastructure) | checker: `SELECT 1` plus the `status_worker` write. > 250 ms → slow → degraded. An outage can't be stored (the DB is the store): the public page shows the red database banner (§4.4) and the sensor alerts directly. | 60 s | yes |
| `tunnel` | Cloudflare tunnel (Infrastructure) | sensor: `GET http://127.0.0.1:20241/ready` (200 iff cloudflared has an active edge connection) → `status_probe.tunnel`. The checker reads the probe. Hidden without a tunnel (`status.tunnel = false`). | 60 s | yes |
| `origin` | Web server (internal) | sensor: `GET http://127.0.0.1:<node_port>/_/health` with `Host: <base>` | 60 s | no (admin diagnosis: `web` down + `origin` up = Cloudflare/tunnel problem) |
| `disk` | Disk space (internal) | sensor: `fs.statfs` of the uploads dir and `/var/lib/mysql` → `status_probe.disk`. Below 15 % free → degraded, below 10 % → major (alerts admins). | 60 s | no |
| `job:backup` · `job:weekly` · `job:runner` | Nightly backup · Weekly report · Background jobs (internal) | heartbeats without a URL. `server/backup.sh` ends with `node "$CODE/app/dist/cli.js" status:ping backup` and the weekly-report command calls `status:ping weekly` after success; both set `hb_last_ping_at` directly in the database (period 24 h + 2 h grace, 7 days + 6 h). `job:runner` reads honeycomb-shop's `oys_meta['jobs']` (`{at, ok, error}` per registered job, written by `cli.js jobs:tick` every 5 minutes – the honeycomb job, and premium-domains' and custom-dialogs' jobs if they register there): degraded if a job's last run failed, major if its last run is older than 3 of its intervals; the error text names the job. | 15 s sweep | no |

The **sensor** (`onyoursite-status-local.timer`, every 60 s; it reads `status.tunnel` from `config.json`, so the
unit has no topology flag that could go stale) probes `tunnel`, `origin`, disk space and (every 10 min) SMTP. It
writes `status_probe`. It runs as the web user without `IPAddressDeny`; its targets are fixed, nothing is
user-controlled. A sensor probe older than 3 min makes `tunnel`/`origin` *unknown* (not down), and the admin card
shows “Local probe isn’t running”.

It is also the **watchdog**, and it works without the database:
- While the database is reachable, every run refreshes a local file `/var/lib/onyoursite-status/alert-contacts.json`
  (`StateDirectory=`, mode 0600, owner the web user) with the admins' email addresses and the decrypted URL of the
  system page's alert webhook, if one is set. The web user can already read `config.json` with the database password
  and the AES key, so the file adds no new exposure.
- If `status_worker.at` is older than 180 s: at most one alert an hour to all admins (email + bell + `status.alert`
  to the bot through the outbox): “Status checks have stopped on <domain>. Check: journalctl -u onyoursite-status”.
  The same for the notifier (`status_notify.at`), whose own alerts could not go out.
- If the database has been unreachable for more than 2 minutes (the first failure time is kept in the state
  directory): the sensor sends the alert itself – an email to the addresses in the file over the SMTP settings, and
  a message to the alert webhook – “The database on <domain> isn’t reachable since 14:05 – the website answers 503.”
  At most once an hour, plus one “The database is back” message. The same path is used when `origin` has failed for
  more than 2 minutes and the database is gone too.

Alerts for the system page: all admins by email (`alerts.admins`, class `system`), the admins' bell, the bot's
#alerts channel (team-only) for monitor events, the bot's #status channel (public, read-only) for incident posts (one
embed per incident, edited on each update – the message id comes back in the bot's `done.result`, §5.8), and
optionally a webhook channel. The admin picks both bot channels from the bot's report (`status-bot-channels`).

### 4.10 Limits and entitlements (interface to honeycomb-shop / premium)

`statusLimits(userId, db?)` (`limits.ts`) is the only place that decides. It reads, without the session, through
honeycomb-shop's API (their §4.4, `entitlements.ts` and `premium.ts`):
- `has(uid, 'status_page')` – unlocked (bought, granted by an admin, or – for admins – included);
- `entitlement(uid, 'status_more_checks')` → `{active, until, quantity, lots}` – active “Extra checks” packs (at most
  2 lots at a time) and the earliest end;
- `entitlement(uid, 'status_fast_checks')` – “Fast checks” and its end;
- `premiumState(uid)` → `{active, until, forever, source}` (time-limited, granted, or the admin role).

**No pre-shop path.** User status pages (PR 4) come after the shop's catalogue (HC-2, HC-3), so status never books
`hcSpend(…, 'status_page')` or a 0-amount `unlock/status_page` row by itself. (The shop would cope – its HC-2 backfill
now turns every `unlock/*` row into an entitlement and `hcAdd(…, 'unlock', …)` writes one – but one path is simpler
to test.) The unlock is the shop's `purchaseUnlock(ctx, uid, 'status_page', {requestId, expectedPrice, terms, via:
'status'})`, the price display is `shopPrice('status_page', uid)`, and the admin's free unlock is
`grantFeature(adminId, uid, 'status_page', {permanent: true}, note, formRef)`.

**Registration** (`features.ts`; `status_page` in PR 4, the two timed packs in PR 7 once the shop's lifecycle (HC-7)
exists):

```ts
// Statusseiten im Shop: dauerhafte Freischaltung und zwei zeitlich begrenzte Zusatzpakete
registerFeature({ key: 'status_page', owner: 'status-pages', kind: 'permanent', title: 'Status page',
  icon: 'bx-pulse', description: 'Your own status page with checks, incidents and alerts.', href: '#status',
  includedFor: (u) => isAdmin(u), needsTerms: (u) => !u.status_terms_at, canBuy: statusUnlockRule,
  items: { status_page: { price: 150, active: true } } });
registerFeature({ key: 'status_more_checks', owner: 'status-pages', kind: 'timed', stack: 2, requires: 'status_page',
  title: 'Extra checks', icon: 'bx-pulse', description: '+10 checks for 30 days.', href: '#status',
  canBuy: statusAddonRule, items: { status_more_checks_30: { days: 30, price: 60, active: true } } });
registerFeature({ key: 'status_fast_checks', owner: 'status-pages', kind: 'timed', requires: 'status_page',
  title: 'Fast checks', icon: 'bx-pulse', description: 'Check every minute for 30 days.', href: '#status',
  canBuy: statusAddonRule, items: { status_fast_checks_30: { days: 30, price: 80, active: true } } });
// nur wenn Premium die Vorteile der Statusseiten enthält (Frage Q3 des Shops)
registerPerk('premium', { owner: 'status-pages', ready: () => true,
  text: 'Status page: 30 checks, checks every minute, 250 subscribers' });
registerEnforcer({ name: 'status', features: ['status_page', 'status_more_checks', 'status_fast_checks', 'premium'],
  inline: true, run: refreshStatusLimits });
```

| Feature (option → default price) | Kind | Effect while active | When it ends |
|---|---|---|---|
| `status_page` (`status_page` → 150) | permanent | the module | — (only an admin revoke or refund; then the page goes offline, data kept) |
| `status_more_checks` (`status_more_checks_30` → 60) | timed 30 days, up to 2 packs at once, requires `status_page` | +10 checks per pack (10 → 20 → 30) | checks over the limit pause by position; data kept |
| `status_fast_checks` (`status_fast_checks_30` → 80) | timed 30 days, requires `status_page` | 1-minute interval | intervals stretch to 3 minutes; data kept |

These are exactly the items in honeycomb-shop's revised catalogue (their §3.6), so names, kinds and prices match.
The `registerFeature` calls above are the only definition; the shop's table references them.

- `statusUnlockRule(c)`: `allow_new = false` → “Status pages are paused for new accounts right now.” – this stops
  **new unlocks only**; users who unlocked can still create their page, and admins can still grant. Terms not
  accepted and no `terms` in the request → “Please accept the rules for status pages first.” (the shop's dialog shows
  the checkbox because of `needsTerms`). Everything is read through `c.db`, as the shop requires.
- `statusAddonRule(c)`: no status page → “Create your status page first.”; page blocked → “Your status page is
  blocked by the team.”; `run_user_checks = false` → “Checks are paused by the team right now – buying more checks
  isn’t possible.”; Premium for good (`forever`) → “Your Premium already includes this.” So nobody pays for checks that
  can't run. (An inactivity pause can't be in the way: the shop lives in the editor, and opening it resumes the
  checks, §4.8.13.)
- Admin mode: the shop refuses every purchase while an admin impersonates (403 “Buying is turned off in admin mode.”,
  honeycomb-shop §4.10–§4.11); `status-unlock` calls `purchaseUnlock` and inherits that, and the tab shows the button
  disabled with the same text.
- `refreshStatusLimits(uid)`: the shop says status needs no enforcer because limits are computed at read time, which
  stays true. This one only makes changes visible at once: it sets the user's `status_pages.changed_at` and bumps
  `status_rev`, so the checker's next sync (≤ 5 s) re-reads that user's limits past its 60 s cache, and it puts a
  `status_team` bell notice when checks paused or resumed because of it. It writes no monitor state, so it is idempotent and a
  renewal racing an expiry cannot leave checks paused.

The result: `{plan:'free'|'addons'|'premium', checks, components, minInterval, channels, subscribers, broadcastsDay,
until}` from the §3.3 rows: free 10 + 10 per active pack, minimum interval 3 min or 1 min with “Fast checks”; Premium
30 checks and 1 minute (if the owner answers the shop's Q3 with yes; otherwise Premium changes nothing here). `until`
is the earliest end of an active pack or Premium, shown in the UI. `effectiveMonitors` keeps the first `checks`
http/heartbeat components by position active; the rest are `overLimit`.

**Premium perk text** goes through the shop's single perk list (`registerPerk`), which premium-domains' Premium card
shows: “Status page: 30 checks, checks every minute, 250 subscribers” (plus their own “no ‘Made with OnYourSite’”,
which covers status pages through the shared `brandingHidden`).

### 4.11 Background jobs

| Job | Where | When |
|---|---|---|
| Checks, canaries | checker | continuously, per component interval (1–5 min; system 1–10 min); canaries every 30 s (10 s during a hold) |
| Config sync / “Check now” queue | checker | every 5 s (on `status_rev` change) / every 2 s |
| Heartbeat, manual, system-probe evaluation | checker | every 15 s |
| Flush raw + state / aggregates | checker | every 5 s / 10 s |
| Auto incidents, maintenance start/end | checker | every 30 s and on state change |
| Purge queue | checker | every minute |
| Retention / partitions | checker | hourly at :07 / daily 00:20 UTC and at start |
| robots.txt refresh | checker | per host at most once a day, before the next check after 24 h |
| Inactivity warnings and pauses | checker | daily 04:10 (site time zone) |
| Health records `status_worker` / `status_notify` | checker / notifier | every 30 s |
| Alert outbox | notifier | every 2 s and on events |
| Subscriber broadcasts | notifier | every 10 s |
| Local probes, watchdog, direct alerts | sensor (`onyoursite-status-local.timer`) | every 60 s |
| Restart on crash | systemd | `Restart=always`, `RestartSec=5` |

---

## 5. UI

### 5.1 Editor tab “Status page”

- **Rail** (`views/dashboard.php:87-95`): a new nav button after “Code page” and before the shop's “Honeycombs”
  (agreed order: Content, Design, Stats, Messages, Code page, **Status**, Honeycombs, Settings, Preview):
  `<button type="button" data-tab="status" class="nav-btn nav-desktop"><i class='bx bx-pulse text-xl'></i> <span class="hidden lg:block text-sm">Status<span class="nav-long"> page</span></span></button>`.
  **One phone rule with the shop:** the bottom bar keeps today's seven items (`static/css/editor.css:383-399`); new
  feature tabs are desktop rail items (`.nav-desktop`, hidden below 640 px, the class honeycomb-shop introduces) and
  are opened on phones from inside the app – Honeycombs from the header pill, Status from a row “Status page” in the
  Settings tab, from bell notices and from links to `/dashboard#status`.
- **Container**: `<div id="tab-status" class="tab-content hidden"></div>` next to `#tab-code`
  (`views/dashboard.php:152`).
- **editor.js changes**: `switchTab('status')` hides the phone preview like `code-mode` (`static/js/editor.js:1018`),
  and the save button is hidden while `status` is active. The first open lazy-loads `static/css/status-manage.css` and
  `static/js/status-manage.js` (like the CodeMirror loading via `E.cm`). Then it calls
  `OYS_STATUS.mount(root, {api: '/dashboard/api/', csrf: E.csrf, scope: 'user', baseHost: E.baseHost, themes: E.themes, pages: E.pages, terms: E.statusTerms, isAdmin: E.statusAdmin})`.
- **Admin scope switch** (instead of mounting the manager in the admin page, which loads neither `editor.css`
  (`views/dashboard.php:69` only) nor Sortable (`:61`) and has no `E.themes`/`E.pages`): when `E.statusAdmin` is true
  (`is_admin` and not impersonating), the tab starts with a segmented `.chips` switch “My status page | OnYourSite
  status”. The second sets `scope: 'system'` for every API call. `#status:system` opens it directly (Admin → Status
  links there).
- **Bell**: today every bell item opens the inbox (`static/js/editor.js:664-665`). custom-dialogs changes the bell to
  each item's `link`, `icon` and `tone` from `NOTIFY_TYPES` (their row `status` plus our `status_down`, `status_up`,
  `status_team`, all `link: '/dashboard#status'`) and adds a `DEEP_LINKS` entry `status`, so a status notice opens
  the Status tab. `status-manage.js` runs its fetches through `OYSUI.handle()` (session dialogs, notices) and
  registers unsaved dialog input with `OYSUI.guard()`.
- **`E.statusTerms`** = `/terms/status-pages` and **`E.statusAdmin`** in `$editorData` (`views/dashboard.php:14-46`).

Screens inside `status-manage.js` (components and classes from `static/css/editor.css`: `.panel`, `.btn-primary`,
`.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.bdg`, `.field`, `.lbl`, `.hint`, `.input-group/.addon`, `.switch`,
`.kpis/.kpi`, `.chips/.chip`, `.empty-state`, `.icon-btn`, `.theme-grid/.theme-card`, `.premium-pill`, `.toast`):

1. **Locked**: the hero card (§2.1.1), a copy of `codeLockedHtml` with `.code-hero` → `.st-hero`. Features:
   “Automatic checks every few minutes”, “Incidents and maintenance with a timeline”, “Alerts by email and Discord”,
   “Visitors can subscribe”, “Your own address”.
2. **Create**: like `codeCreateHtml`. Hint “2–30 characters: a–z, 0–9 and hyphens. It can’t be the address of a link
   page or code page.”
3. **Manage**:

```
┌ panel ───────────────────────────────────────────────────────────────────────────┐
│ Acme status  [Online]                                         ● Partial outage   │
│ acme-status.on-your.site ↗                       [◉ Online]  [View page]  [⋯]    │
└──────────────────────────────────────────────────────────────────────────────────┘
 [ Uptime (30 days) 99.95% ] [ Avg. response 231 ms ] [ Open incidents 1 ] [ Subscribers 42 ]
 ( Components ) ( Incidents ) ( Alerts ) ( Subscribers ) ( Settings )      ← .chips
```

   - **Components**: a toolbar with “Add component” (btn-primary) and the usage text “4 of 10 checks · every 3–5 min
     (1 min with Fast checks or Premium)”. Then groups (heading = group name, none → no heading). Rows are `.panel` lines with a drag
     handle (Sortable, already loaded in the editor, `views/dashboard.php:61`), status dot, name, type icon
     (`bx-globe` http, `bx-time-five` heartbeat, `bx-slider-alt` manual, `bx-server` system), pretty target, the
     30-check strip (`.st-strip` with 30 `<i>`), “231 ms · 2 min ago” and the menu (Edit, Check now, Pause/Resume,
     Copy heartbeat URL, Delete). Badges: “Paused”, “Paused by the team”, “Paused – over your limit”, “Paused: the
     site asked us to stop”, “Paused: robots.txt”, “Rate-limited by the site”, “Delayed”, “Flapping”, “Private” (not on
     the public page). A row click expands the details (§2.1.4). While the platform gate is closed, an amber `.panel`
     above the list reads “Checks are paused – a problem on our side since 14:05. Nothing is counted as down
     meanwhile.”
   - **Incidents**: buttons “Report incident” (btn-primary, `bx-error`) and “Schedule maintenance” (btn-secondary,
     `bx-wrench`). Then sections Active, Upcoming and Past (30 days, “Show more”). Cards show the impact colour
     stripe, title, status badge, affected component chips, the last update (2 lines), “Updated 5 min ago”, and the
     buttons “Post update”, “Resolve”/“Complete”, ⋯ (edit, delete). The empty state reads “No incidents – nice.”
   - **Alerts**: a card “Email me at mia@test.de” (switch + event checkboxes: “Down”, “Back up”, “Slow”,
     “Certificate expires”, “Heartbeat missed”). A card “More alert channels” lists the channels (label, type icon
     `bx-envelope`/`bxl-discord-alt`, badges “Waiting for confirmation”, “Working”, “Failing: <error>”, “Off”) with
     Test, Resend and Remove, plus an add form (type select + input + “Add”); Discord channels have one more event
     checkbox, “Incident updates”. In system scope a card “Discord bot” has two selects filled from the bot's report –
     “Public incident posts” (#status) and “Team alerts” (#alerts) – with the line “Bot ready · reported 2 min ago” or
     “The bot doesn’t support status messages yet – update it with discord-bot/install.sh --update.” A card “Recent alerts” lists time, component, event
     and where to, each “Sent”/“Failed”/“Merged”. Warning when nothing is on: “You won’t be notified when something
     breaks.”
   - **Subscribers**: switch “Visitors can subscribe by email”, KPIs confirmed/waiting, limit line, “Remove all
     subscribers” (btn-danger) and the privacy note “We only use these addresses for updates of this page. Every
     email has an unsubscribe link.”
   - **Settings**:
     - Name, Description and Address (input group);
     - Design (`.theme-grid` with the 30 themes, accent colour input like the Design tab);
     - Logo (select: “None (initials)” or one of the own link pages);
     - Back link (same select);
     - switches “Show uptime”, “Show response times”, “Hide from search engines”, “Open an incident automatically
       when a check is down for 5 min” (select Off/5 min/15 min) and “Email subscribers about automatic incidents”;
     - “Past incidents on the page” (0–30 days);
     - Address: the hint “Your old address keeps forwarding here for 90 days and stays reserved for you.” and, during
       the cooldown, “You can change the address again on Dec 1, 2026.”;
     - Premium block: “Hide ‘Made with OnYourSite’” (`.premium-pill` when locked; the “Report this page” link
       always stays);
     - Danger zone: “Delete status page”.

   All confirms (delete component, incident, update, channel, subscribers, page) and all toasts use custom-dialogs'
   `window.OYSUI` (`OYSUI.confirm({title, text, tone: 'danger', ok})`, `OYSUI.prompt({…, match: slug})` for the
   type-to-confirm delete, `OYSUI.toast(text, type)`), never `confirm()`/`alert()`.

### 5.2 Dialogs

- **Add/edit component**: type tiles (`.mode-cards`): “Website check” (“We open your address every few minutes.”),
  “Heartbeat” (“Your server or job pings us. If the ping is missing, we alert you.”), “Manual” (“You set the status
  yourself.”).
  - Website fields: Name, Address (`https://`), Check every (1/2/3/5 min, locked ones disabled with “Fast checks or
    Premium”), Timeout, and “Advanced”: method GET/HEAD, expected status codes, keyword (must contain / must not
    contain, “Match case”), slow above (ms), retries before alerting (0–3), follow redirects, “Warn 14 and 3 days
    before the certificate expires” (switch), ignore certificate errors (with the warning “Only for test servers – it
    hides real problems.”).
    Then Group (datalist of existing groups), Description, Show on the public page.
  - Heartbeat: Name, Expected every, Grace period, Group, Show on page. After save: the URL box + “Copy” + examples.
  - Manual: Name, Status, Group, Show on page.
- **Incident**: title, status (segmented), impact (None/Minor/Major/Critical with colour dots), affected components
  (checkbox + effect select per component: Degraded performance / Partial outage / Major outage), message (textarea,
  hint “Simple formatting: **bold**, lists, links.”), “Email 42 subscribers” (disabled at 10 mails for this incident,
  hint “Subscribers already got 10 emails about this incident.”, or at the page's daily cap, hint “You’ve emailed your
  subscribers 3 times today.”), and “Post to Discord” when the page has a bot channel (system scope) or a Discord
  channel with “Incident updates”.
- **Maintenance**: title, starts, ends (`datetime-local`), components, message, “Email subscribers now”, and the hint
  “It starts and ends automatically. Alerts for these components are muted during the window.”
- **Update**: status + message + notify.

### 5.3 Public status page

Renderer `status/render.ts`. It uses the profile page system for a consistent look: body classes
`oys t-<theme> l-buttons mode-status` (+ `f-<font>` / `--accent` like `lib/render.php:63-77`), `oys-bg` decorations,
`static/css/fonts.css`, `themes.css`, `page.css`, plus `status.css`. Everything is local: no Tailwind CDN, no Google
Fonts, no third-party scripts. That matters because a status page must load when other things are down.

```
 [logo]  Acme status                                         [Subscribe]  [Back to Acme]
         Live status of the Acme shop and API.
 ┌ st-banner (colour by indicator) ───────────────────────────────────────────────────┐
 │ ● Partial outage                                             Updated 1 min ago     │
 └────────────────────────────────────────────────────────────────────────────────────┘
 ┌ oys-card st-incident (red stripe) ─────────────────────────────────────────────────┐
 │ Website is unavailable                       Investigating · started 19:05 (15 min)│
 │ We’re aware that the website isn’t responding …                    View details →  │
 └────────────────────────────────────────────────────────────────────────────────────┘
 ┌ oys-card st-components ────────────────────────────────────────────────────────────┐
 │ Core                                                                               │
 │ Website                                                        ● Major outage      │
 │ ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ │
 │ 90 days ago                       99.93% uptime                            Today   │
 │ API ……                                                         ● Operational       │
 └────────────────────────────────────────────────────────────────────────────────────┘
 Past incidents   Nov 1 – Website is unavailable (resolved) · Oct 31 – No incidents …
 ┌ oys-card st-subscribe ┐ Get updates by email  [email@example.com] [Subscribe]
 Made with OnYourSite · Report this page
```

- `.oys-main.st-main` has max-width 760 px (profile pages use 580 px, `static/css/page.css:107-117`).
- Bars: 90 `<i class="st-bar d-ok|d-minor|d-partial|d-major|d-maint|d-none">` with `title` and an `aria-label` like
  “Nov 1, 2026: 99.2% uptime, 12 min down, 1 incident”.
- Bar colours: green #22c55e (no downtime), yellow #eab308 (degraded ≥ 30 min, or a degraded/partial incident),
  orange #f97316 (down > 0 and < 30 min), red #ef4444 (down ≥ 30 min, or a major incident), blue #3b82f6
  (maintenance only), grey `var(--divider)` (no data).
- Under 640 px only the last 30 bars are shown (`:nth-child(-n+60) {display:none}`) and the legend reads “30 days
  ago”.
- Status pills use the same colours with text. Colour is never the only signal.
- Groups are `<details open>` (no JS needed). The optional response time is an inline SVG sparkline (24 hourly
  points).
- `status.js` (≈ 3 KB, `defer`) does three things:
  - formats `<time datetime>` in the visitor's zone;
  - re-fetches `/summary.json` every 60 s while the tab is visible and updates banner, pills and “Updated …”;
  - submits the subscribe form via fetch and shows the inline message.
  Without JS everything works (server-side times, a normal POST).
- The header shows the logo from the chosen link page's avatar (`oys-avatar` markup, `lib/render.php:131-134`) or the
  initials. The footer (`oys-foot`, `lib/render.php:165-167`) uses the site's wording “Made with **OnYourSite**”
  (`lib/render.php:166`) and premium-domains' helper `brandingHidden(settings, ownerPremium)`
  (`content/branding.ts`), so link pages and status pages hide it under the same rule. “Report this page”
  (`/terms/status-pages?page=<slug>#report`) always stays – like the code page badge, it is a safety link.
- Markdown in incident updates goes through `markdown(text, {base: pageUrl, ugc: true})`: relative links resolve
  against the status page, not against the main site's `/updates` (today's `oys_md_link`, `lib/updates.php:455-461`),
  and every external link gets `rel="nofollow ugc noopener noreferrer"` plus its host in a small span after the link
  text (“here <span class="md-host">(evil.example)</span>”). The updates pages keep today's output (options default to
  the current behaviour).
- Checker stale > 3 min → the banner adds “Live checks are paused since 14:05 – the data below may be out of date.”
  Gate frozen → “Checks are paused – a problem on our side since 14:05. The status below is from before that.”
  Database down → the red banner of §4.4.

### 5.4 Incident page, history, notices

- `/incidents/{id}`: back link, title, impact badge, “Affected: Website, API”, duration (“Lasted 25 min” or “Ongoing
  for 15 min”, maintenance “Scheduled for Nov 3, 02:00–04:00”). The timeline lists each update with its status label,
  time and Markdown body (`markdown()`; `.md` styles like `views/updates.php:79-95`, ported into `status.css`).
- `/history`: incidents and maintenance grouped by month, impact colour dot, title, date and duration, 20 per page with
  “Older”/“Newer”.
- Notices (offline, blocked, not found, subscribe result) use one `oys-card` in the page theme
  (`oys_render_simple` pattern). The confirm and unsubscribe pages on the main host (§4.5) use the same card.

### 5.5 OnYourSite's own page (`status.on-your.site`)

The same renderer with theme `deep-dark`, accent #6366f1 and logo `/static/images/favicon.png`. The header has links
“on-your.site”, “Updates”, “Roadmap” and “Discord” (invite from the Discord settings, as `views/updates.php:37-38`).
There is no “Made with” line. Groups: no group (Website, Profile & code pages, Custom domains, Discord bot, Email) and
“Infrastructure” (Database, Cloudflare tunnel), collapsed. The main-site footers (`views/landingpage.php`,
`views/updates.php`) and discord-pages' shared layout for `/updates`, `/roadmap`, `/suggestions` (`updates/layout.ts`,
its “Status” slots in the top nav and the footer) link to `https://status.<domain>`.

### 5.6 Admin section “Status”

- **Nav**: a new button `nav-status` (`bx-pulse`, “Status pages”) in the group with Community/Honeycombs/Storage
  (`views/admin.php:315-326`; after code-slots-admin's split: next to “Code pages”). `ADMIN_TABS.status`
  (`views/admin.php:624`). The section is rendered by `status/adminView.ts`, styled like
  `views/admin_honeycombs.php` (`$in`, `$lbl`, `$btn` class strings, cards
  `bg-card border border-bordercolor rounded-xl shadow-xl`).
- Order of cards:
  1. **Health** (like the bot card in `views/admin_community.php:45-56`): checker “Running · since Nov 1, 19:00” /
     “Stopped – last seen 14:05”, notifier and sensor the same, checks per minute, schedule lag p95, active/paused
     components, delayed (10 min); the platform gate (“OK · canaries 3/3” / “Paused since 14:05: canaries 0/3”);
     “Kernel guard: on” or the warning “This server ignores IPAddressDeny – checks rely on the app guard only.”;
     emails today per class; “Local probe: 40 s ago”; version; slug conflicts after a rollback (§3.4); link “Open
     status.on-your.site”.
  2. **OnYourSite status**: a short card “Manage components, incidents and alerts of status.on-your.site in the
     editor.” with the button “Open in the editor” → `/dashboard#status:system` (§5.1). The admin page loads neither
     `editor.css` nor Sortable, so the manager is not mounted here.
  3. **Status pages** (list like the code pages list, `views/admin_honeycombs.php:90-139`): `slug.<domain>` link,
     badge Online/Offline/Blocked/Inactive/“Name needs review”, the line `title · owner (email) · 7 components · 3.2
     checks/min · 42 subscribers · created Nov 1, 2026`, the block form with reason or Unblock, “Approve name” for
     flagged pages, “Unlock for free” for users without the unlock, and `<details>` “Components” with target,
     interval, state and pause/resume + note per row.
  4. **Sites**: the table “Most checked domains” (registrable domain, its hosts and resolved IPs, checks, users,
     requests per hour, flags “robots.txt opt-out” / “refuses our checker”, rule), a table “Busiest IP addresses”
     (IP, domains, requests per hour) and the rule form (Host or `.domain`, Block/Allow more, Max checks, Note).
  5. **Settings** (like “How users earn them”, `views/admin_honeycombs.php:70-89`): label + hint left, number right;
     the switches “Allow new status pages” (hint: “Stops new unlocks. Pages that exist keep working.”) and “Run checks
     for users”.
- Confirms through custom dialogs (`data-confirm`), bell notices to owners through `notify()` (§4.7).

### 5.7 Emails (templates in `email/`, dark style of `email/weekly_report.json`, variables escaped)

| Template | Subject | Body (short) |
|---|---|---|
| `status_alert` | `[Down] Website – Acme status` · `[Back up] Website – down for 4 min` · `[Slow] …` · `[Certificate] acme.com expires in 7 days` · `[Heartbeat] Nightly backup missed its ping` | coloured status box, what happened (our text), since, check details (URL, code, error), buttons “Open status page”, “Manage alerts” |
| `status_verify` | `Confirm alerts for Acme status` | “{owner} wants to send status alerts for {page} to this address.” button → `https://<base>/_/status/verify/<token>`; “Not you? Ignore this email.” |
| `status_subscribe` | `Confirm your subscription to Acme status` | button → `https://<base>/_/status/sub/c/<token>`; the page address in plain text |
| `status_update` | `[Acme status] Investigating: Website is unavailable` | the page address in plain text under the title, update text (Markdown → HTML with `ugc` links and visible hosts), affected components, “View incident”, unsubscribe link (`/_/status/sub/u/<id>.<mac>`), “Report this status page” |
| `status_inactive` | `Your status checks pause on Jan 30` | “Open the editor to keep them running.” |

The mail helper port needs optional extra headers (`List-Unsubscribe`, `List-Unsubscribe-Post`) – see §9. Every
status mail to a third party (subscribers, extra alert addresses) names the page address, because the sender is
OnYourSite's domain.

### 5.8 Discord messages (embeds, English, no emojis; colours from `discord-bot/src/embeds.js:4` + blue #3b82f6)

- **Alert** (webhook channel or the bot's #alerts): title “Website is down”, description “No answer within 10 s (2
  checks in a row).”, colour red, fields “Since” (`<t:…:R>`) and “Check” (URL for the owner's own channels; the bot
  channel is team-only), footer “Acme status · OnYourSite”, url → editor/admin. Back up: green, “Down for 4 min.”
  Slow/flapping: amber. Certificate: amber.
- **Incident** (the bot's #status, public; also each owner webhook channel with the event `incident`): title
  “Investigating · Website is unavailable”, description = latest update (`mdPlain`, max 1,500 characters), colour
  by impact (minor amber, major orange, critical red, maintenance blue, resolved green), fields “Affected” and
  “Status”, timestamp, url → incident page. Later updates **edit** the same message.
- **One message per target** (`status_incident_posts`, one row per incident and target, like discord-pages'
  `update_discord_posts`):
  - new incident → a `queued` row per target; webhook targets are posted by the notifier with `?wait=true` and get
    `message_id` at once; the bot target is the job `status.post {channel_id, embed}` with `ref 'status-inc:{id}'`;
  - a change while a row is `queued` → `dirty = 1`; when the post's result arrives (webhook answer, or the bot's
    `/_/bot/outbox/{id}/done` with `result: {message_id, channel_id}`, applied by our handler in the same transaction
    as `done`) and `dirty` is set, an edit follows;
  - a change on a `posted` row → webhook `PATCH …/messages/{id}` by the notifier, or the job `status.edit
    {channel_id, message_id, embed}` with the same `ref` – discord-pages' `supersede(ref, 'status.edit')` drops an
    older edit that the bot hasn't claimed yet, and their outbox hands out jobs of one `ref` in order;
  - a deleted incident → `status.delete` / webhook delete; a message that is gone (Discord 10008, `missing: true`)
    marks the row `failed` and is not posted again.
  - There is **no** extra callback route: the message id travels in `done.result`.

### 5.9 Terms page `/terms/status-pages`

A static view like `views/terms-code-pages.php`. Sections:
1. What status pages are for.
2. Only check services you run or may check; no load tests; no misleading pages, no other brands or the OnYourSite
   name in the address or title (names that mention a brand are reviewed before search engines see them).
3. How checks work: User-Agent, frequency, the egress IPs from `config.json status.egress_ips`, limits per site and
   per domain, `Retry-After` on 429 honoured; a 503 counts as down.
4. For website owners: how to stop checks – add a `User-agent: OnYourSite-Monitor` group with `Disallow` to
   robots.txt (read once a day), or answer 403 or 429 to our user agent (checks pause after 24 hours of that), or
   report the page.
5. Subscribers and privacy.
6. Blocking and removal; released addresses stay reserved for 90 days.
7. `#report` (with `?page=<slug>` the mail link's subject names the page).

The privacy page (`views/privacy.php`) gets a paragraph on status page subscriptions and alert addresses (stored
encrypted, deleted on unsubscribe or with the page).

---

## 6. Security, abuse, limits

### 6.1 SSRF (monitors, redirects, webhooks)

**Target parsing** (`guard.ts:parseTarget`, used on save and before every check):
- trim; without a scheme add `https://` (like `oys_clean_url`, `lib/helpers.php:196-231`); length ≤ 500;
- WHATWG `new URL()` – this normalises `http://2130706433/`, `0x7f.1`, `0177.0.0.1`, `①②⑦.0.0.1` and `%31…` to
  `127.0.0.1` (verified on Node 22);
- scheme `http:`/`https:` only → “Please enter an address starting with http:// or https://.”;
- no username/password → “Addresses with a user name or password can’t be checked.”;
- port (explicit or default) in `ports` → “Port 22 can’t be checked. Allowed ports: 80, 443, 8080, 8443.”;
- hostname: lower case, IDN → ASCII (`url.domainToASCII`), brackets stripped, trailing dot removed;
- special names rejected: `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.intranet`, `*.lan`, `*.home`,
  `*.corp`, `*.home.arpa`, `*.arpa`, `*.test`, `*.invalid`, `*.example`, `*.onion`, single-label names →
  “This address points to a private or local network – only public websites can be checked.”;
- the stored `target` is the normalised URL without fragment.

**IP classification** (`classifyIp`, all resolved addresses must be `public`). Blocked IPv4: 0.0.0.0/8, 10/8,
100.64/10 (incl. Alibaba's metadata 100.100.100.200), 127/8, 168.63.129.16/32 (Azure's platform endpoint, a public
address that serves VM metadata and health), 169.254/16 (incl. the 169.254.169.254 metadata of AWS, GCE, Azure,
DigitalOcean and others), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24,
203.0.113/24, 224/4, 240/4, 255.255.255.255. Blocked IPv6: ::/128, ::1, ::ffff:0:0/96 (mapped – the embedded IPv4 is
checked too), 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64), 100::/64, 2001::/23 (incl. Teredo), 2001:db8::/32, 2002::/16
(6to4), fc00::/7 (incl. AWS's `fd00:ec2::254`), fe80::/10, fec0::/10, ff00::/8. **Own addresses**: every global
address of this server (`config status.self_ips`, written by the installer from `ip -o addr show scope global`, not
only the first one that `ip4()`/`ip6()` return, `server/install.sh:138-145`, plus `os.networkInterfaces()` at
runtime). With the Cloudflare tunnel they are blocked, because they would lead around Cloudflare to the origin.
Without a tunnel the site is served from them anyway, so they stay allowed on ports 80 and 443 only (users can check
their own `name.on-your.site`). The implementation is a `net.BlockList` (Node 22 matches IPv4-mapped IPv6 against IPv4
ranges – verified) plus explicit prefix rules for NAT64/6to4/Teredo.

**DNS rebinding**: resolution happens once per check in the checker, every address is validated, and the connection
goes to exactly that address (pinned lookup). After connect, `remoteAddress` is checked again (also against the own
addresses). Each redirect hop is resolved and validated anew. TTLs don't matter because nothing re-resolves between
validate and connect. Public resolvers bypass `/etc/hosts` and internal split-horizon zones.

**What a check reveals**: status code, time, a keyword yes/no, and our own error key. No body, no headers, no remote
error text. This is blind SSRF at most, and with the IP rules there is nothing internal to reach.

**Second layer (kernel)**: the checker unit has `IPAddressDeny=` for loopback, link-local, multicast, every private
and special range, 168.63.129.16 and – with the tunnel – the server's own addresses, and **no `IPAddressAllow=` at
all** (§8). That is possible because the checker sends no mail and no Discord messages (the notifier does) and uses
only the public resolvers from `config.json`, never the system resolver. So a bug in the app guard still can't reach
MariaDB on 127.0.0.1:3306 (`server/install.sh:1460`), the web app on :3000, cloudflared's metrics on :20241, a local
mail relay, a resolver stub on 127.0.0.53, or the metadata service – even on GCE, where `resolv.conf` names
169.254.169.254 as resolver. (The first draft allowed the resolv.conf resolvers and, with a local mail relay,
127.0.0.1; `IPAddressAllow` opens a whole address on every port and wins over `IPAddressDeny`, so that draft did not
hold.) The DB is reached over the Unix socket only (`AF_UNIX`, `app/src/db.ts:63-68`: host `localhost` → socket); the
checker refuses a TCP `db.host` (§4.8.1). systemd ignores `IPAddressDeny` silently on kernels without cgroup BPF, so
the installer tests it and records the result (`status.kernel_guard`, shown on the admin card, §8).

**Webhooks**: Discord URLs only through discord-pages' `parseWebhookLink` (`app/src/discord/index.ts`; today
`lib/updates.php:531-543`), requests without redirects, sent by the notifier. There are no generic webhooks in v1.

**Web process**: it never connects to user targets. It only resolves them (public resolver) when saving. “Check now”
is done by the checker. The web process sends only the Discord test message when a webhook channel is added (to
discord.com, validated).

### 6.2 Abuse of third-party sites

- **Caps**:
  - per user: 10 checks (up to 30 with two “Extra checks” packs; Premium 30), 32 in flight, 1-minute minimum only
    with “Fast checks” or Premium;
  - per host: `host_cap` 20 checks across all accounts; per registrable domain (Public Suffix List, so
    `a.victim.com` and `b.victim.com` count together, while `alice.github.io` and `bob.github.io` stay apart):
    `domain_cap` 60 checks; admin rules can raise or block either;
  - request buckets: 30/min per host, 60/min per registrable domain, 3,000/min per resolved IP (a ceiling against
    many domains pointed at one server, far above what shared anycast addresses get from us);
  - overall: 1,000 in flight, 64 of them keyword checks.
  All accounts together send at most 30 requests a minute to one host and 60 to one registrable domain, and at most
  20 checks can point at one host and 60 at one domain. More accounts don't help: each needs weeks of honeycombs
  (unlock 150), and registration is rate-limited (map-app §1.5: 5/h per client, 50/h total).
- **Politeness**: `Retry-After` on 429 is honoured (the host pauses, nothing counts as down). A 503 counts as down –
  `Retry-After` there only spaces the retry, otherwise a site stuck in maintenance mode would never be reported. A
  light request (GET without reading the body, HEAD optional). An identifying User-Agent with a link explaining how
  to stop checks.
- **Site owners can stop us** (the terms page says how, and both ways work without contacting us):
  - **robots.txt**: once a day per host the checker fetches `/robots.txt` (same guarded path, 64 KiB, 10 s, at most 5
    redirects on the same host) and applies only a group that names `OnYourSite-Monitor` (RFC 9309 longest-match on
    the check's path). Groups for `*` are ignored: they are written for crawlers, uptime checks don't crawl, and
    honouring them would stop most legitimate checks. 4xx → no rules. 5xx or unreachable → the last known rules stay
    (RFC 9309 says to assume “disallow all” then, which for a monitor would pause checks exactly when the site is
    down). A disallow pauses the check (`auto_paused = 'robots'`); save refuses it; the next fetch that allows it
    resumes it.
  - **Refusing us**: 403 or 429 answers to our User-Agent without a break for 24 hours pause the check
    (`auto_paused = 'refused'`, “Paused: the site asked us to stop.”); owner (bell + email) and admins are told. The
    owner can resume it (e.g. after allowing our checker on their own site); if the refusals continue, it pauses
    again after another 24 hours.
- **Accountability**: terms acceptance (`users.status_terms_at`). Admins see targets, the most checked registrable
  domains with their hosts and IPs, the busiest IPs, requests per hour and the opt-out flags. Host and domain rules
  (block with a note the owner sees). Page block. Kill switch.
- **Target changes as a scanner**: saving checks is limited to 60/h, “Check now” to 10 per 10 min, and the port
  allowlist blocks port scans.
- **Origin IP**: checks leave from the server's IP, which bypasses the tunnel's hiding of the origin. The same IP
  already shows in outgoing mail headers. With the tunnel on, the firewall only lets SSH in (`server/install.sh`,
  `step_protect`), so the exposure is accepted (open question 7).

### 6.3 Mail and subscription abuse

- Double opt-in for subscribers and extra alert addresses. Confirmation needs a POST, so mail scanners don't confirm.
  The links point to the main host and keep working (or fail safely) whatever happens to the page.
- The subscribe answer is identical for every case (no enumeration), and a confirmation is resent at most every 10 min.
- Rate limits: `statussub:<pageId>:<clientKey>` 5/h, `statussub:<pageId>` 20/h, and **at most 3 confirmation mails
  per address and day across all pages** (`statusconf:<email_hash>`). Confirmations have their own budget class (≤ 10 %
  of the day). The first draft's global 1,000/h allowed rotating client keys to spend the whole day's budget on mails
  to victims within an hour; now that costs at most 10 % of a day and 3 mails per victim.
- Honeypot field `website` + time token (`<unix>.<hmac('status-sub|'+pageId+'|'+unix)[0:32]>`, ≥ 3 s, ≤ 1 day, like
  `lib/spam.php:5-55`).
- Addresses are stored encrypted (`encryptData`) with an HMAC for uniqueness. Unsubscribe deletes the row. Owners never
  see addresses. Confirm and verify tokens are minted when the mail is sent and stored only as hashes; unsubscribe
  links are HMACs and not stored at all; the outbox never holds a secret.
- Per page: at most 3 subscriber broadcasts a day (Premium 10), 10 mails per incident, 20 updates an hour, 12 owner
  alert emails an hour and 50 a day. Across pages: the budget classes of §4.8.12 (OnYourSite's own alerts are never
  held back; confirmations ≤ 10 %; owner alerts ≤ 30 %; broadcasts take turns per page). Every subscriber mail carries
  `List-Unsubscribe` + `List-Unsubscribe-Post`, the page address in plain text and a report link.
- Subscriber limits follow the SMTP quota: the settings refuse a Premium subscriber limit above 25 % of the daily
  budget (open question 9).
- No bulk import of subscribers.

### 6.4 Auth, CSRF and rate limits

| Surface | Auth | CSRF | Limits |
|---|---|---|---|
| `/dashboard/api/status*` | session user; system scope = `is_admin` and not impersonating | `X-CSRF-Token` on POST (419) | save 60/h, run 10/10 min, channel add/verify 10/h, test 3/10 min, incident updates 20/h per page; unlock: the shop's `hcbuy` limit; address change 30-day cooldown with subscribers |
| `POST /admin` `status_action` | admin (`views/admin.php:3-6`) | field `csrf` | — |
| Public status pages | none, cookieless | — | render cache; subscribe limits above |
| `/_/hb/*` | token (192 bits) | — | per token 10 per 10 s (in memory), unknown tokens 600/min per client; 1 write per 10 s per token |
| `/_/status/verify/*`, `/_/status/sub/c/*`, `/_/status/sub/u/*` | token or HMAC in the link | the token itself; state changes only on POST | 30/h per client and route |
| `/_/health` | none | — | DB ping cached 2 s |
| Bot results `POST /_/bot/outbox/{id}/done` (discord-pages) | HMAC (`lib/community.php:19-29`) | — | as the bot API; no status-specific bot route |

### 6.5 Honeycombs and premium

- The unlock is the shop's `purchaseUnlock` (`withAccount` row lock, idempotent per `request_id`); the ledger
  uniqueness `uq_entry(user_id, reason, ref)` blocks double spend and repeated unlocks.
- **No address without the unlock**: `status-create` sits behind the unlock guard, so a 0-honeycomb account can't take
  an address in the shared namespace (the first draft exempted it).
- **No paying into a closed module**: `allow_new = false` stops new unlocks in the shop's `canBuy`, not creation – a
  user can never pay 150 and then be refused at create. Add-ons are refused while their checks couldn't run (page
  blocked, user checks switched off), and nothing can be bought in admin mode.
- Create is protected by `UNIQUE(user_id)` and the `site_addresses` primary key in the same transaction.
- Limit checks run inside the page row lock (two tabs can't pass the limit).
- Premium and add-ons come from the DB (`statusLimits` → the shop's `entitlement()`/`premiumState()`), never from the
  session.
- On expiry nothing is deleted or refunded automatically; refunds are admin-only in the shop. Admin free unlocks go
  through `grantFeature` and are audited there.

### 6.6 Content, privacy, indexing

- All user text is escaped. Incident bodies go through the existing safe Markdown (`lib/updates.php:348-470`) with
  the new options `{base, ugc}`: external links get `rel="nofollow ugc noopener noreferrer"` and show their host
  next to the text; relative links stay on the status page. No custom CSS/HTML/JS on status pages, a strict CSP, and
  same-origin assets only.
- **Impersonation.** Today's brand list matches only whole slugs: `blacklist.php:47-90` exact, and the brand regex
  (`blacklist.php:107`) only `^brand\d*$`. Checked with PHP on this commit: `onyoursite-status`, `oys-status`,
  `discord-status`, `paypal-status`, `github-status`, `cloudflare-status` and `onyoursitestatus` are all allowed
  (`status`, `onyoursite`, `on-your-site` and `paypal` are refused). For a status page – the page type people trust
  during an outage – that is not enough. `names.ts` adds, for status pages only (the system page is exempt):
  - **Slug** (`statusBrandProblem`): the slug is normalised with the existing variants (`blacklist.php:19-45`: ASCII
    fold, leet digits, repeated letters) and split into tokens at hyphens and digits. Refused when the joined letters
    contain `onyoursite` or a token is `oys`; when a token equals any brand of the brand group (`blacklist.php:75-82`);
    or when the joined letters contain a distinctive brand (`BRAND_CONTAINS`: the brands of that group with six or
    more letters that are not ordinary words, e.g. `paypal`, `discord`, `github`, `cloudflare`, `coinbase`,
    `instagram`). Short or word-like brands (`x`, `ms`, `live`, `box`, `prime`, `teams`, `signal`, `stripe`, `notion`,
    `office`, …) count only as whole tokens, because “contains” would refuse ordinary names (`items-status` contains
    `ms`, `delivery-status` contains `live`). Message: “The address “paypal-status” contains a brand name. Status
    pages can’t use brand names in their address.”
  - **Name** (`statusTitleProblem`): the OnYourSite name (`onyoursite`, `on your site`, `on-your.site`, the token
    `oys`) is refused: “Status page names can’t use the OnYourSite name.” A third-party brand in the name is **not**
    refused – “Acme Discord bot status” is exactly what many users will write – but it sets `review_note` (“Mentions
    Discord”): the page stays `noindex` and is listed as “Name needs review” for the admins until one approves it
    (`review_ok`). A later rename that adds a brand flags it again.
  - **New pages** are `noindex` for their first 14 days, so a phishing page created today can't rank before reports
    and reviews catch it.
  - Every subscriber mail and every verification mail names the page address in plain text and carries “Report this
    status page”; the footer of every page keeps “Report this page”.
- Released addresses (address change, deletion, account deletion) are held for 90 days in `site_addresses` (for the
  owner; for nobody after an account deletion), and an old address forwards to the new one for those 90 days, so old
  emails, Discord embeds and `/summary.json` integrations never land on someone else's page. (The registry frees an
  address used for less than 7 days at once – its rule against squatting by creating and deleting.) With
  subscribers, the address can change only once in 30 days.
- Public pages are cookieless and store no visitor IPs (rate limits use the daily HMAC `clientKey`, map-app §1.5).
- Private areas (editor, admin, API) stay noindex/no-store. User pages are indexable unless “Hide from search
  engines”, younger than 14 days or waiting for a name review. Offline, preview and subscription pages are noindex.
- Deleting an account (admin, `views/admin.php:91-113`) calls `statusDeleteUser(userId)` next to
  `oys_code_delete_user` (`views/admin.php:102`); it releases the status address itself with
  `releaseAddress(db, slug, uid, 'nobody', 90)` before code-slots-admin's `releaseUserAddresses` frees the rest.
- No new uploads: the logo is the avatar of one of the owner's link pages, served as today.

### 6.7 Limits overview (defaults)

| | Free (unlocked) | With add-ons | Premium |
|---|---|---|---|
| Status pages | 1 | 1 | 1 |
| Checks (http + heartbeat) | 10 | +10 per “Extra checks” pack, up to 2 (30) | 30 |
| Components incl. manual | 40 | 40 | 40 |
| Minimum interval | 3 min | 1 min with “Fast checks” | 1 min |
| Timeout | ≤ 30 s | ≤ 30 s | ≤ 30 s |
| Extra alert channels | 3 | 3 | 5 |
| Subscribers | 50 | 50 | 250 |
| Subscriber broadcasts per day | 3 | 3 | 10 |
| Hide “Made with OnYourSite” | – | – | yes |

Premium's column applies if the owner answers the shop's Q3 with yes. Custom domains for status pages are not in v1
(§1.3).

### 6.8 Load estimate (server with 16 vCPUs)

Assumptions:
- An HTTPS check opens a new TLS connection (no keep-alive between minutes) and costs 1–3 ms CPU (handshake +
  verification + parsing). A healthy check takes about 0.3–0.5 s from start to response headers.
- It moves about 20 KB (TLS handshake ≈ 5 KB, headers ≈ 1–2 KB, about 14 KB of body already in flight before we close).
  A keyword check moves up to 512 KB.
- A raw row is about 50 B and an aggregate row about 60–70 B, including index; InnoDB pages are 16 KB.

| Scenario | Components with checks | Average interval | Checks/s | CPU (checker) | Outbound traffic | Raw rows (48 h) | Hourly (14 d) | Daily (120 d) |
|---|---|---|---|---|---|---|---|---|
| A – first year | 1,500 | 3.5 min | 7 | < 0.03 core | 0.15 MB/s ≈ 0.4 TB/month | 1.2 M ≈ 60 MB | 0.5 M ≈ 30 MB | 0.18 M ≈ 13 MB |
| B – growth | 10,000 | 2.5 min | 67 | ≈ 0.2 core | 1.3 MB/s ≈ 3.5 TB/month | 11.5 M ≈ 580 MB | 3.4 M ≈ 200 MB | 1.2 M ≈ 85 MB |
| C – worst case | 12,000 | 1 min | 200 | ≈ 0.6 core | 4 MB/s ≈ 10 TB/month | 35 M ≈ 1.7 GB | 4 M ≈ 240 MB | 1.4 M ≈ 100 MB |

- **CPU**: a single Node event loop handles several hundred checks per second. The checker is capped at
  `CPUQuota=200%` (2 of the 16 vCPUs), so the web app, MariaDB and the bot always keep at least 14 vCPUs; the notifier
  (`CPUQuota=50%`) and the sensor are tiny. Above about 25,000 checking components, the checker can be sharded
  (`onyoursite-status@.service` with `--shard i/n` and a lock per shard). Not needed for v1.
- **Checks in flight** (Little's law: in flight = checks per second × seconds per check), scenario C:
  - all healthy: 200/s × 0.4 s ≈ **80**;
  - 5 % of targets time out at the default 10 s, each with one retry: 80 + 2 × 10/s × 10 s ≈ **280**;
  - 10 % hang until `timeout_max` 30 s, with retries: 80 + 2 × 20/s × 30 s ≈ **1,280** – a large outage elsewhere;
    the cap of 1,000 is reached and the rest waits seconds in due order (the gate's hold usually starts first).
  So the global cap is 1,000 (the first draft's 128 would have delayed everyone's checks already in the 5 % case),
  keyword checks have their own cap of 64 (each may hold 512 KiB of body plus a decompressor), and a user has 32
  (30 checks that all time out at 30 s with retries need about 30). The per-IP connection gate of 8 is gone: shared
  anycast addresses (Vercel's 76.76.21.21, GitHub Pages' four IPs, shared Cloudflare pairs) serve thousands of
  unrelated owners; the per-host and per-domain buckets carry politeness, and the per-IP bucket is only a ceiling.
  The schedule lag p95 is on the admin card; the load test of §7 asserts it.
- **Memory**: in C at the cap: runtime state ≈ 2 KB × 12,000 ≈ 24 MB, 1,000 TLS sockets ≈ 64 MB, 64 keyword bodies
  with decompressors ≈ 55 MB, V8 base ≈ 60 MB – about 200 MB. `MemoryMax=768M`, `--max-old-space-size=384` (socket
  and body buffers live outside the V8 heap).
- **Database writes**: flushes run about 1 multi-row statement per second. C writes ≈ 600–800 rows/s in batches,
  with ≈ 1–2 commits per second. Status pages read from a 30 s cache, so a traffic spike during an outage doesn't
  reach the DB. Connections: checker pool 4 (lock, flush, sync, reads), notifier 3, sensor 1 – about 8 in total next
  to the web pool (honeycomb-shop §8.3 has the overall budget; MariaDB's default `max_connections` 151 is far away).
- **Database memory** – the part that binds before CPU: the primary keys `(monitor_id, at)`, `(monitor_id, hour)` and
  `(monitor_id, day)` keep one insert position per monitor, so the pages being written are spread over the tables. In
  C that is about one 16 KB leaf per monitor in today's `status_checks` partition (≈ 190 MB), the same in
  `status_hourly` (≈ 190 MB) and about half that in `status_daily` (≈ 95 MB): a hot set near **500 MB**. With
  MariaDB's default buffer pool of 128 MB (`90-onyoursite.cnf` sets only `bind-address` and `local-infile`,
  `server/install.sh:1457-1461`) every flush would read pages from disk. So the installer sets
  `innodb_buffer_pool_size` to about 25 % of RAM (at least 512 MB, at most 16 GB; §8). Retention costs nothing:
  `status_checks` drops whole day partitions instead of deleting 17 M rows a day, failed rows are no longer kept for 7
  days (a dead 1-minute check would add 10,000 rows a week), and deleted monitors go through the purge queue instead
  of a `NOT IN (SELECT …)` sweep over the raw table.
- **Network/sockets**: in C there are up to 200 new connections/s; we close first, so ≈ 12k sockets sit in TIME_WAIT on
  our side – fine, because TIME_WAIT is per destination address and port, and the per-IP bucket keeps any one
  destination far below the 28k ports of the default range. DNS is cached per host (min(TTL, 300 s)), about 40–80
  queries/s to the public resolvers in C.
- **Binding limits**: outbound traffic (C ≈ 10 TB/month – check the VPS quota), database memory, politeness and the
  SMTP quota – not CPU. All are capped by settings (§3.3) and visible on the admin card (checks/min, lag, emails per
  class).

---

## 7. Tests

**Unit** (`node:test`, `app/test/`, run with `$S/oys-db.sh run npm test`):
- `status.guard.test.ts`: ≈ 110 table cases.
  - schemes, userinfo, ports, IDN, trailing dots, special TLDs, single labels;
  - IPv4 numeric forms (`2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1`, full-width digits);
  - IPv6 (`[::1]`, `[::ffff:127.0.0.1]`, `[64:ff9b::7f00:1]`, `[2002:7f00:1::]`, `[fe80::1%25eth0]`, `[fd00:ec2::254]`);
  - metadata `169.254.169.254`, `168.63.129.16`, `100.100.100.200`, CGNAT, every own address (tunnel: refused; no
    tunnel: only ports 80/443), host and `.domain` rules.
- `status.psl.test.ts`: `a.victim.com`/`b.victim.com` → `victim.com`; `alice.github.io` ≠ `bob.github.io`;
  `x.co.uk` → `x.co.uk`; IP literals; IDN.
- `status.names.test.ts`: refused slugs `onyoursite-status`, `oys-status`, `discord-status`, `paypal-status`,
  `github-status`, `cloudflare-status`, `onyoursitestatus`, `paypalstatus`, `status-paypal`, `pay-pal-status` (leet
  and repeats: `paypa1-status`, `ppaypal-status`); allowed `items-status`, `delivery-status`, `approval-status`,
  `acme-status`, `signals-lab`; titles: “OnYourSite status” and “On Your Site status” refused, “Acme Discord bot
  status” saved with `review_note = 'Mentions Discord'`.
- `status.robots.test.ts`: group selection (only `OnYourSite-Monitor`, case-insensitive; `*` ignored), longest match,
  `Allow` vs `Disallow` ties, `$` and `*` patterns, 4xx/5xx handling, 64 KiB cap.
- `status.resolver.test.ts`: a fake DNS server on a random UDP port (Resolver `setServers`):
  - mixed public + private answers → blocked;
  - CNAME to a private name → blocked;
  - TTL caching and negative caching;
  - IPv4 preference;
  - SERVFAIL/timeout → `dns` while the resolver canary answers, `internal` while it doesn't.
- `status.gate.test.ts` (pure `gateStep`): every row of §4.8.15 – canaries 3/3 → ok; 1/3 once → ok; 1/3 twice → frozen;
  recovery needs two good rounds; ratio > 30 % of ≥ 20 hosts → hold, released after 3 min with healthy canaries,
  frozen when they fail; < 20 hosts never holds; local errors > 5 in 30 s → frozen; `ingress_recovered_at` from each
  signal (web/pages check, tunnel/origin probe, DB, planned window, web start, checker gap > 2 min).
- `status.state.test.ts`: every row of §4.8.7:
  - retries 0–3, slow/degraded, recovery;
  - flapping on/off at the thresholds, maintenance muting, certificate warnings at 14 and 3 days;
  - frozen and hold rows (no transition; held `down` keeps the first failure's time);
  - heartbeat deadlines and `/fail`, including the clock restart: last ping 10:00, period 1 h, grace 5 min, ingress
    down 10:50–11:10 → no `hb_missed` before 12:15;
  - 503 with `Retry-After: 600` → failed (down after retries); 429 → no result, host paused; 403/429 for 24 h →
    `auto_paused = 'refused'`.
- `status.aggregate.test.ts`: splitting at hour and day borders; DST days in Europe/Berlin (2026-03-29 has 23 h,
  2026-10-25 has 25 h); pending → down back-dating; gaps (checker offline) and frozen time not covered; uptime
  flooring; bar colours; component status and page indicator for every combination.
- `status.scheduler.test.ts` (fake clock):
  - jitter spreading (no more than 2% of checks in the same second);
  - drift-free rescheduling, retry spacing, `Retry-After` spacing of a 503 retry;
  - host/domain/IP buckets and the global/keyword/user gates, 429 backoff;
  - limits over time (add-on expiry → overLimit).
- `status.limits.test.ts`: free / one pack / two packs / fast checks / premium / expiry / admin / impersonation.
- `status.budget.test.ts`: the four mail classes (system never held back; confirm ≤ 10 %; owner ≤ 30 % and the
  per-page 12/h and 50/day; broadcasts round robin – a page with 250 subscribers and three with 5 all finish their
  first batch in the first minute), 3 confirmations per address and day across pages, broadcast cap per day, expiry
  after 12 h.
- `status.render.test.ts`: escaping of every user field (`<script>`, `"`, `’`), the Markdown subset with `{base, ugc}`
  (relative link → status page URL; external link → `rel="nofollow ugc noopener noreferrer"` and visible host; the
  updates pages' output unchanged without options), JSON shape, no private components in any output, “Made with
  OnYourSite” through `brandingHidden` (Premium + switch hides it; “Report this page” always there), noindex for
  pages < 14 days and for flagged names.

**HTTP tests** (Fastify `inject` against `buildServer()` with the test DB):
- Editor API: 401 without login, 419 without CSRF, 400 for broken JSON.
  - **Paywall:** `status-create {"slug":"acme","terms":true}` with 0 honeycombs and no unlock → 403 `Unlock status pages
    with honeycombs first.`, and `site_addresses` has no `acme` row afterwards.
  - **Paused module:** with `allow_new = false`, `status-unlock` → `Status pages are paused for new accounts right
    now.` and the balance is unchanged; a user who unlocked before can still `status-create`.
  - Unlock without terms, with too few honeycombs, in admin mode (403 `Buying is turned off in admin mode.`), in
    parallel (two concurrent unlocks with the same and with different request ids → one ledger row), price changed
    between view and buy.
  - Add-on purchase through the shop refused for a blocked page and with `run_user_checks = false`.
  - Create with every slug error (format, forbidden, brand, held by someone else, taken by a link page or code page),
    two concurrent creates of the same slug in different tables (link page vs status page) → exactly one wins
    (`site_addresses` primary key).
  - Address change: old address 302 → new for 90 days, held for the owner (another user's create → taken), cooldown
    with subscribers; delete: held 90 days, purge rows written, the request returns without deleting raw checks.
  - Each monitor validation message incl. domain cap and robots opt-out. Limits under concurrency (two saves at the
    limit → one wins). System scope as user (403), as admin, and as an impersonating admin (403). Incident flows,
    daily broadcast cap. Channel add with a Discord mock (`discord_api_base` config, like the existing mock
    `$S/discord_mock.py`). `status-bot-channels` accepts only channels of the report with `can_post`.
  - “Check now” inserts into `status_run_requests` and does not change `status_rev`.
- Public: `/` 200 with no `Set-Cookie`; CSP and cache headers; ETag 304; preview token; 451 blocked; 404 offline; 405
  for wrong methods; `/summary.json` CORS; `/history` paging; old-address redirect. Subscribe: honeypot, time token,
  rate limits, the identical answer for known addresses, the “no new subscribers today” answer when the confirm class
  is used up.
- **Subscriptions on the main host:** confirm via GET (no change) and POST; the minted token works once and a resend
  invalidates the old one; unsubscribe GET page, POST and RFC 8058 one-click with the HMAC link – while the page is
  renamed, offline, blocked and after it was deleted (always “You won’t get emails …”); a wrong MAC → “This link isn’t
  valid any more.”; `status_outbox.payload` of a sent `sub_confirm` contains no token.
- **Database down** (pool closed): a cached page is served with the red banner and `no-store`; OnYourSite's page shows
  Website and Database as “Major outage”; without a cache, OnYourSite's page renders the static fallback (200) and a
  user page answers 503 with `Retry-After`.
- `/_/hb`: unknown 404 (no DB read on the second try within 60 s), write throttling, `/fail`, per-token 429, two
  tokens from one client key both accepted at 10 per 10 s each. `/_/health` 200/503 (pool closed).
- Admin: block/unblock (+ owner bell notice), host and domain rule block pauses the matching checks, settings clamp
  (subscriber limit vs budget refused), free unlock through `grantFeature`, name approval, kill switch.
- Router: `on-your.site/<status slug>` → 302. A link page and code page keep priority over a status page with a
  (legacy) same slug; `cli.js status:slug-check` lists it.

**Checker and notifier integration** (`status.worker.test.ts`, `status.notify.test.ts`):
- The checker is started by a test entry in `app/test/helpers/` (new folder) with an **injected** policy that allows only
  `127.0.0.1:<test ports>`, test canaries on local ports and a test DNS server. The production entry
  `src/status/worker.ts` has no override – no env var, no config flag.
- Local HTTP/HTTPS test servers (self-signed CA trusted in the test only) cover: 200, 500 → down after retries,
  503 + `Retry-After` → down, 429 → delayed and host paused, timeout, slow → degraded, keyword present/absent,
  redirect chain, redirect to a blocked address, redirect loop, gzip bomb (output limit), non-text keyword target,
  expired certificate, `valid_to` thresholds, robots.txt opt-out (and its removal), 403 for 24 h (fake clock) →
  paused.
- **Gate:** kill the test DNS server → every check result is `internal`, no state change, no outbox row, no auto
  incident, the banner text in `/summary.json`; restart it → checks continue and nothing was counted as down. Stop
  two canary servers → frozen; make 40 % of 50 test hosts fail with healthy canaries → hold, then real `down` with the
  first failure's time after 3 minutes (fake clock). Heartbeat: mark a planned window → no `hb_missed` until a period
  after it ends.
- Database effects: rows in `status_checks`/`state`/`events`/`hourly`/`daily`; partitions added and dropped (fake
  dates), the unpartitioned fallback; purge queue; an auto incident opens after N s (scaled) and closes – also when
  its monitor is deleted or paused (“{Name} is no longer monitored.”); maintenance auto start/end; outbox coalescing
  (down+up → one “was down for” message); broadcasts superseded and capped; mail budget classes; retention deletes;
  inactivity; the checker waits read-only while `schema_version < STATUS_V`.
- Discord: incident posts per target with the Discord mock – webhook post with `?wait=true`, edit, dirty edit after a
  queued post, `missing` → failed; bot jobs `status.post`/`status.edit` only when the report lists `status.v1`,
  `supersede` of an unclaimed edit, the message id applied from `done.result`.
- Leader lock: two checkers → one active, and the second takes over after the first exits. Graceful SIGTERM flushes.
  The same for the notifier.
- Captured mail (nodemailer stream transport via the mail helper's test hook).

**Load test** (`npm run test:status-load`, a new script in `app/package.json`, not part of `npm test`): one local HTTPS
server answers 2,000 test hostnames (resolved by the test DNS server to 127.0.0.1); 10 % of them answer after 8 s or
never (timeout 10 s); all 2,000 monitors at a 1-minute interval for 10 minutes. Asserts: p95 schedule lag < 5 s, no
check started more than once per interval, memory below 400 MB, in-flight never above the caps.

**Installer test** (the existing installer harness, `$S/harness*.sh`): `write_status_units` in every mode (`--update`,
`--tunnel` switching yes/no, `--https`), the kernel-guard probe (passes on cgroup v2; with a stubbed `systemd-run`
that lets the connection through, the installer warns and writes `kernel_guard: false`), a TCP `db.host` refused,
`--reset` stops the status units before dropping the database, `--rollback` disables them.

**Playwright end-to-end** (same harness as the existing e2e scripts):
1. Admin grants 200 honeycombs. Mia unlocks the status page (custom dialog, terms), creates `mia-status` and adds
   a website check for the test target. The public page shows “All systems operational”. The test target fails →
   the editor row goes red, the public banner shows “Major outage” and an auto incident appears. The captured alert
   mail has the right subject. The target recovers → resolved.
2. Mia reports an incident with two updates and schedules maintenance (banner “Maintenance in progress” inside the
   window). History shows both.
3. A visitor subscribes. The confirm link from the captured mail (main host) needs the button. An incident update mail
   arrives with the page address and a report link, and one-click unsubscribe works – also after Mia renamed the page.
4. Heartbeat: copy the URL, ping with `request.get`, wait past the deadline → down; ping again → up.
5. Limits: an 11th check is refused with the message. The 1-minute option is locked. “Fast checks” (bought) unlocks
   it, and expiry (time travel via DB + the shop job) pauses nothing but stretches the interval with the note.
6. Admin: block the page (public 451, editor box, bell notice), host rule block (check paused with the note), the
   health card values, OnYourSite's page managed from the editor's admin switch, system page incident posted (bot
   outbox row created only with `status.v1` in the report).
7. Mobile (390×844): editor tab reached from Settings, dialogs, public page with 30 bars, no horizontal scroll (like
   `$S/mobile-audit.js`).
8. Keyboard and screen reader basics: bars have labels, the banner `role="status"`, dialogs trap focus (custom-dialogs).

---

## 8. Installer and operations impact (`server/install.sh`)

The status feature needs the Node switch of the installer (task “Umstieg im Installer”, plan §5): Node 22 installed,
the app built to `app/dist`, the web user known (`$WEB`, today `www-data`), `config.json` written.

1. **New function `write_status_units()`**, called in **every mode that can change the topology**: `step_services`
   (`server/install.sh:1533-1539`), `--update` (next to `write_timers`, `:1836`), `--https` (next to `write_timers`,
   `:1849`) and `--tunnel` (after `step_protect`, `:1857`; today that mode writes no timers at all, so a switch of
   `--tunnel` between yes and no would otherwise leave stale units). It first writes the `status` block of
   `config.json` (item 3), then, with `write_if_changed`, the files below, then `systemctl daemon-reload`, `enable
   --now` all three, runs the kernel-guard test (item 4), and on `--update` restarts the checker and the notifier
   (the code changed). Before restarting the web app or the tunnel, `--update` runs `node app/dist/cli.js
   status:planned 600` and after `check_site` passed `status:planned 0`, so heartbeat deadlines restart after the
   deploy (§4.8.6).

   `/etc/systemd/system/onyoursite-status.service` (the checker):

   ```ini
   # OnYourSite – written by server/install.sh
   [Unit]
   Description=OnYourSite status checks (monitors, incidents)
   After=network-online.target mariadb.service
   Wants=network-online.target

   [Service]
   Type=simple
   User=$WEB
   Group=$WEB
   WorkingDirectory=$CODE/app
   Environment=NODE_ENV=production
   Environment=UV_THREADPOOL_SIZE=8
   ExecStart=$NODE --max-old-space-size=384 $CODE/app/dist/status/worker.js
   Restart=always
   RestartSec=5
   TimeoutStopSec=20
   # Only the internet and the database socket – never this server, its network or a metadata service (second layer against SSRF).
   # No IPAddressAllow: it would open whole addresses on every port and it wins over IPAddressDeny.
   IPAddressDeny=localhost link-local multicast 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 168.63.129.16/32 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 240.0.0.0/4 ::/128 ::ffff:0:0/96 64:ff9b::/96 2002::/16 fc00::/7 fec0::/10 $SELF_IPS
   RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
   NoNewPrivileges=true
   CapabilityBoundingSet=
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true
   PrivateDevices=true
   ProtectKernelTunables=true
   ProtectKernelModules=true
   ProtectKernelLogs=true
   ProtectControlGroups=true
   ProtectClock=true
   ProtectHostname=true
   RestrictNamespaces=true
   RestrictRealtime=true
   RestrictSUIDSGID=true
   LockPersonality=true
   SystemCallArchitectures=native
   # 16 vCPUs on the server: the checks may use at most 2 of them
   CPUQuota=200%
   MemoryMax=768M
   TasksMax=64
   LimitNOFILE=16384
   Nice=5

   [Install]
   WantedBy=multi-user.target
   ```

   - `$SELF_IPS` = every global address of the server with the tunnel (`ip -o addr show scope global`, all of them –
     `ip4()`/`ip6()` return only the first, `server/install.sh:138-145`), empty without it.
   - There is no `IPAddressAllow=` and no resolver exception: the checker resolves only through the public resolvers
     of `config.json` and sends no mail or Discord messages. So it reaches neither MariaDB on 127.0.0.1:3306
     (`server/install.sh:1460`), the web app on :3000, cloudflared's metrics on :20241, a local mail relay, a
     127.0.0.53 resolver stub, nor 169.254.169.254 – also on GCE, where that address is the resolver in
     `resolv.conf`.
   - The database is reached through its socket only. The installer already writes `db.host = localhost`
     (`server/install.sh:373`); `write_status_units` refuses to continue if `config.json` has another host (“The
     status checker needs the database socket: set db.host to localhost.”), and the checker refuses to start (§4.8.1).

   `/etc/systemd/system/onyoursite-status-notify.service` (the notifier): the same `[Unit]`/`[Install]` and
   hardening, `ExecStart=$NODE $CODE/app/dist/status/notify.js`, **no** `IPAddressDeny` (it needs the system
   resolver, the SMTP host – possibly a local relay – and discord.com, and it never connects to a user-chosen
   host), `CPUQuota=50%`, `MemoryMax=256M`.

   `/etc/systemd/system/onyoursite-status-local.service` and `.timer` (the sensor):

   ```ini
   # OnYourSite – written by server/install.sh
   [Unit]
   Description=OnYourSite status: local probes (tunnel, web server, disk, mail) and watchdog
   After=mariadb.service

   [Service]
   Type=oneshot
   User=$WEB
   Group=$WEB
   WorkingDirectory=$CODE/app
   ExecStart=$NODE $CODE/app/dist/status/local.js
   StateDirectory=onyoursite-status
   StateDirectoryMode=0700
   TimeoutStartSec=50
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true
   MemoryMax=192M
   ```

   ```ini
   # OnYourSite – written by server/install.sh
   [Unit]
   Description=OnYourSite status probes every minute

   [Timer]
   OnBootSec=90s
   OnUnitActiveSec=60s
   AccuracySec=5s

   [Install]
   WantedBy=timers.target
   ```

   The sensor reads `status.tunnel` from `config.json` instead of a `--tunnel=` argument in the unit, so a topology
   change can't leave a stale flag behind.

2. **Tunnel metrics on a fixed port**: in `tunnel_local()` (`server/install.sh:917-985`, unit at `:931-961`) add
   `Environment=TUNNEL_METRICS=127.0.0.1:20241` (`TUNNEL_METRICS` is the env form of cloudflared's `--metrics`). By
   default cloudflared picks the first free port of 20241–20245. `write_if_changed` restarts the tunnel once (a few
   seconds, `:969`) at that update – inside the planned window of item 1, so no heartbeat is reported missing.

3. **`config.json` → `status`**: `tunnel` (true/false from `$TUNNEL`), `self_ips` (all global addresses), `egress_ips`
   (the addresses checks leave from, for the terms page), `dns` and `canaries` (default lists), `concurrency`,
   `keyword_concurrency`, `user_inflight`, `kernel_guard`. Written by `write_status_units` in every mode above, so a
   `--tunnel` switch updates them; values the admin edited by hand (`dns`, `canaries`) are kept.

4. **Kernel-guard test**: `systemd-run --wait --pipe --quiet -p User=$WEB -p IPAddressDeny=localhost curl -s -o
   /dev/null --max-time 3 http://127.0.0.1:<node_port>/_/health` must **fail**. If it succeeds, the kernel ignores
   `IPAddressDeny` (no cgroup BPF, e.g. some container-based VPS): the installer warns “This server ignores
   IPAddressDeny – status checks rely on the app guard only.” and writes `status.kernel_guard = false`, which the admin
   card shows. Nothing else changes; the app guard (§6.1) still applies.

5. **MariaDB memory**: `90-onyoursite.cnf` (`server/install.sh:1457-1461`) gains `innodb_buffer_pool_size =
   <25 % of RAM, between 512M and 16G>` (from `/proc/meminfo`), unless the admin set it in another file
   (`my_print_defaults mysqld` shows it). `write_if_changed` restarts MariaDB once (§6.8 explains the size). On a
   16-vCPU server with 32 GB that is 8 GB.

6. **Backups** (`server/backup.sh:28-29`): raw checks are short-lived and large. Dump them without data:
   `mysqldump … --ignore-table=$DB.status_checks "$DB"` plus `mysqldump --no-data "$DB" status_checks` appended, so a
   restore has the table (with its old partitions, which the checker reorganises at start). The script's last line
   becomes `node "$CODE/app/dist/cli.js" status:ping backup || true` (the backup heartbeat, §4.9). Everything else is
   backed up as today.

7. **Firewall**: nothing new. Outbound is already allowed (`ufw default allow outgoing`, `server/install.sh:1447`).
   No inbound port: status pages come through the tunnel like every subdomain.

8. **DNS/certificates/Cloudflare token**: nothing new. `status.<domain>` and `health.<domain>` are covered by the
   wildcard DNS record and tunnel rule the installer creates (`*.$DOMAIN`, `server/install.sh:1173-1174`, `:1240`)
   and by the wildcard edge certificate. No new token permission. Only open question 6 would need one.
   `server/README.md` tells the admin to keep Cloudflare's “Bot Fight Mode” off (heartbeats come from servers) and,
   where the plan allows, to add a WAF skip rule for `/_/hb/`.

9. **Summary output** (`summary()`, `:1620`): “Status page: https://status.$DOMAIN · checks: systemctl status
   onyoursite-status onyoursite-status-notify”.

10. **`--reset`** (`:1863-1888`): `systemctl stop onyoursite-status onyoursite-status-notify
    onyoursite-status-local.timer` **before** `DROP DATABASE` (`:1879`); the fresh install re-enables them. (They
    would wait read-only anyway, §4.8.1, but stopping them keeps the log clean.) **`--rollback`** (plan §5.6):
    `systemctl disable --now onyoursite-status onyoursite-status-notify onyoursite-status-local.timer`, like the
    shop's jobs timer; the next `--update` enables them and runs `cli.js status:slug-check` (§3.4).
    **Uninstall/stop**: the same `disable --now`.

11. **Discord bot** (`discord-bot/install.sh --update` via `step_bot`, `:1574-1606`): the bot version with the
    `status.v1` handlers (§9). discord-pages' generic `--discord-channel <KEY>` (their `CHANNEL_SPECS`) gets two
    entries, `STATUS_CHANNEL_ID` (#status, read-only for members, the bot may post) and `ALERTS_CHANNEL_ID` (#alerts,
    team-only); the installer runs it once when the line is missing, like `UPDATES_CHANNEL_ID`. The IDs are only
    suggestions in the bot's report; the website uses the channels the admin picks from the report (§5.1).

12. **Docs**: `server/README.md` (services, logs `journalctl -u onyoursite-status -u onyoursite-status-notify`, how to
    pause checks, the kernel-guard warning, the Cloudflare note), `README.md` (feature list).

---

## 9. Delivery plan and dependencies

Every PR is small enough to review, ships with its tests, and works on its own (feature gates: the module stays
invisible until PR 4). The module never ships without notifications: PR 4 already sends owner email alerts, the bell
and the inactivity warning.

| # | PR | Contents | Needs |
|---|---|---|---|
| 1 | **Status core** | schema step `STATUS_V` (§3.1, incl. partitions), `settings.ts`, `limits.ts` (reads the shop's API; until PR 4 nobody is unlocked), `guard.ts`, `psl.ts` + data file, `names.ts`, `resolver.ts`, address registry use (`slugProblem` options, `claimAddress`/`releaseAddress`), reserved paths, `markdown(text, {base, ugc})`, unit tests (guard/psl/names/resolver/limits) | Node port merged; code-slots-admin PR 2 (`site_addresses`); honeycomb-shop HC-2 (`has`, `entitlement`, `premiumState`) |
| 2 | **Checker, sensor, installer** | `worker.ts`, `scheduler.ts`, `http.ts`, `robots.ts`, `gate.ts`, `state.ts`, `aggregate.ts`, `partitions.ts`, `purge.ts`, `system.ts`, `local.ts`, `/_/health`, `/_/hb` (no UI to create user heartbeats yet), `cli.js status:ping/planned/slug-check`; installer: `write_status_units` in all modes, checker and sensor units, kernel-guard test, buffer pool, tunnel metrics, backup change, `--reset`/`--rollback`; admin health card; load test | 1; installer Node switch |
| 3 | **Notifier and OnYourSite's status page** | notifier unit + `notify.ts` (outbox, mail classes, admin email + bell, bot jobs gated on `status.v1`), renderer, `status.css`/`status.js`, routes (status host, `/status` redirect), incident page, history, JSON, database-down fallback, `status-manage.js` with the admin scope switch (system scope only), Discord bot card, footer links; the bot part: handlers `status.alert/post/edit/delete`, `CHANNEL_SPECS` entries, `gateway` in the report | 2; discord-pages PR 2–3 (report, `?f=` feature registry, `done.result`, `supersede`) – without them the page ships with email, bell and webhook alerts and the bot follows; custom-dialogs PR 1 (`OYSUI`, `notify()`) |
| 4 | **Status pages for users** | editor tab (user scope), editor API, `status_page` registration + unlock via `purchaseUnlock`, name/brand rules and review, address hold/redirect/cooldown, terms page, moderation list (block, review, free unlock via `grantFeature`), Sites (domains and IPs), settings form, limits UI, inactivity, **owner email alerts and bell for the account address**, inactivity mail | 3; honeycomb-shop HC-3 (catalogue, `purchaseUnlock`, `registerFeature`) and HC-1 (yellow icon); code-slots-admin PR 1 (admin nav) |
| 5 | **Alert channels** | extra email addresses (verification on the main host), Discord webhook channels incl. incident posts (`status_incident_posts`), coalescing/retries display, “Recent alerts”, `channel_broken` | 4 |
| 6 | **Visitor subscriptions** | subscribe, confirm/unsubscribe on the main host, broadcasts with classes and round robin, `List-Unsubscribe` headers, report links, privacy text | 5; mail helper with extra headers |
| 7 | **Add-ons and Premium** | `status_more_checks` and `status_fast_checks` registration, `registerPerk('premium', …)`, the refresh enforcer, Premium limits, hide branding through `brandingHidden` | honeycomb-shop HC-7 (lifecycle); premium-domains PR 1 (`brandingHidden`, Premium ready) |

Follow-ups (not v1): Atom feed, “remind me while it’s down”, custom domains for status pages
(`custom_domains.target_type = 'status'` with premium-domains), a status badge and a status block for link pages, and
the free basic tier if the owner wants it (question 11).

**What status-pages needs from the other features**
- **honeycomb-shop** (their revised draft already lists our three items with our names, kinds and prices)
  - the API as written there: `purchaseUnlock(ctx, uid, 'status_page', {requestId, expectedPrice, terms, via:
    'status'})`, `shopPrice`, `has`, `entitlement` (with `until` and lots), `premiumState`, `grantFeature`,
    `registerFeature` (with `needsTerms`, `canBuy(c)` on `c.db`, `items`, `href`), `registerPerk`, and – optional –
    `registerEnforcer({inline: true})`;
  - `status_page` is registered by our **PR 4** (their table says PR 7); the two timed packs by our PR 7 after HC-7;
  - Q3's perk text becomes “30 checks, checks every minute, 5 alert channels, 250 subscribers”;
  - the rail order Code page → Status → Honeycombs and one phone rule (`.nav-desktop` for both feature tabs);
  - the yellow honeycomb icon class; the 403 in admin mode (already there).
- **premium-domains**
  - `brandingHidden(settings, ownerPremium)` from `content/branding.ts` and the wording “Made with OnYourSite”;
  - the Premium card shows the perks registered through the shop (our text included);
  - the fallback-origin hostname for the system check `domains`;
  - custom domains stay link-page only in v1; `target_type = 'status'` is the agreed follow-up.
- **discord-pages**
  - the stable `app/src/discord/index.ts` (`parseWebhookLink`, `checkWebhook`, `discordRequest`, `discordError`,
    `webhookPost/Edit/Delete`);
  - the outbox feature registry: `status.alert`, `status.post`, `status.edit`, `status.delete` belong to the
    feature `status.v1`, and `/_/bot/hello` keeps `status.v1` in the stored report (it drops unknown feature names, so
    its list of known features must come from the same registry) and lists it in its answer; `outboxAdd(action, data, {ref, conn})` and `supersede(ref, action)`; a hook so that
    `POST /_/bot/outbox/{id}/done` hands the `result` of `status.*` jobs to our handler in the same transaction
    (like `applyBotResult` for `update.*`);
  - the bot report (`channels` with `can_post`, `features`, `reported_at`) – read for the channel choice and the
    `bot` check; our bot PR adds `gateway: {ready, ping_ms}` and a report on shard disconnect/resume;
  - `CHANNEL_SPECS` for `--discord-channel` gets `STATUS_CHANNEL_ID` and `ALERTS_CHANNEL_ID` (our bot PR);
  - the “Status” slots in the top nav and footer of `updates/layout.ts`.
- **code-slots-admin**
  - the address registry `site_addresses` with kind `status`, `claimAddress`/`releaseAddress` in our transactions and
    `slugProblem(slug, null, null, {userId, exceptStatusId, db})`;
  - **one addition**: an optional hold length per release, `releaseAddress(db, slug, uid, holdFor, days = 30)`, stored
    as `hold_until` (their expiry query then uses `hold_until < now`), so status addresses are held for 90 days;
  - admin navigation slot “Status pages” next to “Code pages”; status pages take no slots.
- **custom-dialogs**
  - `window.OYSUI` (`confirm`, `prompt` with `match`, `toast`) and `data-confirm` for the admin forms;
  - `notify()` / `notifyAdmins()` with `{db}`, the bell opening each item's `link`, the `DEEP_LINKS` entry `status`,
    and our three `NOTIFY_TYPES` rows (`status_down`, `status_up`, `status_team`) next to their `status` row;
  - `OYSUI.handle()` and `OYSUI.guard()` for `status-manage.js`; the page skin and `ui.js` on public status pages
    (themed errors in the subscribe form).
- **Mail helper (port)**
  - optional extra headers, a per-call timeout, and a test transport hook.
- **Core (plan.md)**
  - `--rollback` stops our units (§8 item 10); the migration number is taken at merge time.

---

## 10. Open questions for the owner (each with a recommendation)

1. **Address of user status pages.** Own address in the shared namespace (`acme-status.on-your.site`, like the code
   page) or attached to a link page (`acme.on-your.site/status`)? *Recommendation:* own address. It's the same module
   pattern as the code page, an own origin, and it works without a link page.
2. **Unlock and price.** A one-time unlock for 150 honeycombs plus time-limited add-ons (“Extra checks” +10 checks for
   60, up to two at once; “Fast checks”, 1-minute checks, for 80; each 30 days), or a monthly rental?
   *Recommendation:* one-time unlock + add-ons (the same items and prices as honeycomb-shop's Q2). Ongoing costs are
   covered by the add-ons and the caps.
3. **Limits.** Free (unlocked): 10 checks, 3-minute minimum, 50 subscribers, 3 subscriber emails a day. Premium:
   30 checks, 1 minute, 250 subscribers, 10 emails a day – if Premium includes status perks (honeycomb-shop's Q3).
   *Recommendation:* yes; all of them can be changed later in Admin → Status, and subscriber limits follow the email
   budget of question 9.
4. **What may be checked.** Any public website within the caps and terms, or only domains the user has verified?
   *Recommendation:* any public website. Verification adds friction for little gain once per-site and per-domain caps,
   the User-Agent, the robots.txt and 403/429 opt-outs and moderation exist.
5. **Automatic public incidents.** Open an incident automatically after 5 minutes down (and email subscribers)?
   *Recommendation:* on by default, labelled “Auto”, switchable per page. The platform gate (§4.8.15) makes sure our
   own outages never open one.
6. **When the whole server is down,** `status.on-your.site` is down too. Accept this for v1 and announce outages on
   Discord, or add a Cloudflare cache rule (`stale-if-error`, documented for 500/502/503/504; behaviour for a dead
   tunnel is not documented and must be tested) that needs an extra token permission? *Recommendation:* accept for
   v1; test the cache rule later. (A database outage alone is covered: the page shows a red banner and the sensor
   alerts the team directly.)
7. **Checks reveal the server's IP address** to the checked sites (outgoing mail already does, and the firewall only
   lets SSH in). *Recommendation:* accept for v1. If the IP gets attacked, move the checker to a small separate
   egress server later (it's already a separate service).
8. **Discord channels for OnYourSite's page.** Should the bot find or create a public read-only `#status` (incident
   posts) and a team-only `#alerts` (check alerts)? The admin then picks them in Admin → Status, like `#updates`.
   *Recommendation:* yes, both.
9. **Email provider limits.** Which SMTP provider sends the mails, and what are its hourly and daily limits? The
   defaults (30/min, 1,000/day for status mail, Premium subscribers ≤ 25 % of the day) are placeholders, and subscriber
   limits are derived from them. *Recommendation:* tell us the limits; we set the status budget below them, leaving
   room for the site's other mail (registration, weekly report, contact notices).
10. **Inactive accounts.** Pause checks after 90 days without opening the editor (with a warning 14 days before)?
    *Recommendation:* yes. It saves resources and stops alerts to forgotten mailboxes.
11. **„was dann alle nutzen können“ – a free basic tier?** Today's design needs the unlock (150 honeycombs – about 17
    days of daily logins by honeycomb-shop's calibration of about 260 a month) before anyone can create a status page.
    Alternative: everyone gets a small free tier – e.g. 3 checks every 5 minutes, manual components, incidents and
    alerts to the account email, no subscribers, “Made with OnYourSite” always shown – and the unlock adds the rest.
    Cost: about 0.01 checks/s per page (10,000 basic pages ≈ 100 checks/s, inside scenario C of §6.8), more pages to
    moderate, and throw-away accounts get free checks (the per-site and per-domain caps still bound what reaches any
    one site, but §6.2's argument “each account needs weeks of honeycombs” no longer holds for 3 checks).
    *Recommendation:* start with the paid unlock as designed (honeycomb-shop's catalogue sells `status_page` the same
    way) and keep the basic tier ready as a follow-up: it is one more row in the settings (`basic: {checks,
    min_interval}`) and `status-create` accepting `unlocked || basic.checks > 0`. Turn it on if few users reach the
    unlock in the first months.

---

## 11. Review changes

This revision answers the 28 review findings. The blocker and all majors are fixed; for #1, #3, #8, #12 and the
minor #26 parts of the proposed fix were changed, for the reasons in §11.2. No finding was rejected as wrong. Every code citation the review relied on was re-checked on
`e5cd29e` – among others with PHP (`is_forbidden_subdomain` on the brand examples) and by reading
`server/install.sh` (tunnel restart `:969`, MariaDB config `:1457-1461`, modes `:1836-1888`, `ip4()`/`ip6()`
`:138-145`, socket host `:373`), `discord-bot/src/outbox.js:21-29`, `discord-bot/index.js:65-86`,
`static/js/editor.js:664-665`, `views/admin.php` (no `editor.css`, no Sortable), `lib/render.php:166`,
`lib/updates.php:455-461` and `app/src/helpers.ts:68`. One correction: the repository's `config.json` with
`db.host = 127.0.0.1` is a local test file (not tracked); production installs get `localhost` from the installer. The
checker still refuses a TCP host.

While this revision was written, honeycomb-shop, discord-pages, code-slots-admin and custom-dialogs revised their
drafts too. Where their new versions settle a point, this design follows them (noted per finding).

### 11.1 What changed, per finding

| # | Finding | Decision | Changes (sections) |
|---|---|---|---|
| 1 | [blocker] Own outages become false incidents | **Fixed, partly differently** | New platform health gate with canaries, resolver canary, local-error and failure-ratio triggers; states ok/hold/frozen; frozen time is not covered; no transitions, alerts or auto incidents while frozen; system components never frozen; admins alerted. `internal` is defined. Heartbeat deadlines restart after any ingress problem (web/pages checks, tunnel/origin probes, DB, planned deploy windows from the installer, web starts, checker gaps). Failure table rows added. Unit and integration tests incl. killing the test DNS server. (§0, §2.4, §4.8.5, §4.8.6, §4.8.7, §4.8.9, §4.8.10, §4.8.15, §7, §8) |
| 2 | [major] Paywall and honeycomb bugs at unlock/create | **Fixed** | `status-create` sits behind the unlock guard (403 “Unlock status pages with honeycombs first.”); `allow_new` only stops new unlocks (in `canBuy`), never creation; add-ons refused while checks can't run; HTTP tests for both exploits. (§2.1.1, §2.1.2, §4.6, §4.10, §6.5, §7) |
| 3 | [major] Brand and OnYourSite impersonation | **Fixed, partly differently** | Slugs: brand tokens and distinctive brands as “contains”, own names refused. Names: OnYourSite refused; third-party brands flag the page for review (noindex until approved). New pages noindex for 14 days. Markdown links `nofollow ugc` with visible host. Page address and report link in every subscriber and verification mail. (§2.1.2, §4.4, §4.6, §4.7, §5.3, §5.7, §6.6, §7) |
| 4 | [major] Subscriber links can't be built / break | **Fixed** | Confirm and unsubscribe on the main host under `/_/status/sub/…`, independent of the page's state; unsubscribe = HMAC of the subscriber id (nothing stored); separate confirm token minted at send time, stored as hash; the outbox never holds a secret; CSP stated for those pages. (§2.2, §3.1, §4.4, §4.5, §4.8.12, §6.3, §7) |
| 5 | [major] Mail budget drain and mail-bombing | **Fixed** | Four budget classes (system never held back, confirm ≤ 10 %, owner ≤ 30 %, broadcasts round robin with 12 h expiry); per page 3 broadcasts a day (Premium 10), owner emails 12/h and 50/day; 3 confirmations per address and day across pages; subscriber limits lowered to 50/250 and tied to the budget (settings refuse more than 25 %). (§2.1.5, §2.1.6, §2.1.8, §3.3, §4.8.11, §4.8.12, §6.3, §6.7) |
| 6 | [major] Scheduler gates smaller than capacity | **Fixed** | Global cap 1,000, keyword cap 64, per user 32; per-IP connection gate removed, replaced by a high per-IP bucket; Little's-law sizing, memory and lag in §6.8; load test with 2,000 local HTTPS targets and p95 lag < 5 s. (§3.3, §4.8.3, §4.8.4, §6.8, §7, §8) |
| 7 | [major] 503 with Retry-After hides outages | **Fixed** | 503 is always a failed result; `Retry-After` only spaces the retry; only 429 delays; 429 for > 1 h is visible, for 24 h pauses. (§4.8.4, §4.8.5, §5.9, §6.2, §7) |
| 8 | [major] Contract with honeycomb-shop | **Fixed** (aligned with the shop's revised draft) | No pre-shop path: unlock = `purchaseUnlock`, price = `shopPrice`, free unlock = `grantFeature`; reads through `has`/`entitlement`/`premiumState`; registration with the shop's `registerFeature` shape (`needsTerms`, `canBuy(c)`, `items`); perk text through `registerPerk`; an optional inline enforcer that refreshes the checker; admin mode blocks the unlock. (§2.1.1, §4.6, §4.7, §4.10, §6.5, §9) |
| 9 | [major] Bot integration conflicts with discord-pages | **Fixed** | Admin picks #status/#alerts from the bot report; jobs `status.post/edit/delete/alert` carry `channel_id` and `ref 'status-inc:{id}'`; message id from `done.result`; `status.*` registered under `status.v1` and only enqueued when the report lists it, else email/webhook; the extra callback route is gone; `.env` channel IDs are only setup suggestions via discord-pages' `CHANNEL_SPECS`. (§4.8.11, §4.9, §5.1, §5.8, §6.4, §8, §9) |
| 10 | [major] Kernel layer weaker than claimed | **Fixed** | Delivery moved to a separate notifier unit; the checker has no `IPAddressAllow` at all and uses only public resolvers; own addresses and 168.63.129.16 denied; socket `db.host` required; installer verifies the deny and records `kernel_guard`; runtime self-connection check. (§0, §4.1, §4.8.1, §4.8.5, §6.1, §8) |
| 11 | [major] Own page blind during a DB outage | **Fixed** | Red banner with the outage start from the process; Website and Database forced to “Major outage” on OnYourSite's page; static fallback without a cache; the sensor keeps a local recipient file and alerts directly after 2 minutes; HTTP test with the pool closed. (§2.2, §2.4, §4.4, §4.9, §7, §8) |
| 12 | [major] Gaps in third-party abuse controls | **Fixed, partly differently** | Auto-pause after 24 h of 403/429; robots.txt group for `OnYourSite-Monitor` (daily); caps per registrable domain (Public Suffix List) and a per-IP bucket; admin Sites grouped by domain and IP. (§2.1.3, §2.3, §3.1, §4.6, §4.8.4, §4.8.5, §5.6, §5.9, §6.2) |
| 13 | [major] Released addresses can be taken over | **Fixed** | Released status addresses held for 90 days through the shared registry (needs a per-release hold length from code-slots-admin) and the old address forwards to the new one for those 90 days; 30-day cooldown once the page has subscribers. (§2.1.9, §3.1, §4.3, §4.6, §6.6, §9) |
| 14 | [major] Custom domains conflict with premium-domains | **Fixed** | Custom domains removed from status v1 (settings, limits, PR 7, router hook); follow-up `target_type = 'status'`. The `domains` system check stays – it monitors the link-page domain service. (§1.3, §2.1.9, §4.3, §4.9, §6.7, §9) |
| 15 | [minor] Auto incidents open forever | Fixed | Removed/paused/over-limit/inactive/kill-switched monitors count as resolved with “{Name} is no longer monitored.”; a frozen gate does not. (§2.1.6, §4.8.10, §7) |
| 16 | [minor] MariaDB sizing and retention | Fixed | Installer sets `innodb_buffer_pool_size` (25 % of RAM); `status_checks` partitioned by day, raw data 48 h, failed rows no longer kept 7 days (`status_events` instead); purge queue replaces the orphan sweep and the in-request delete; hot-set estimate in §6.8. (§3.1, §3.6, §4.6, §4.8.13, §6.8, §8) |
| 17 | [minor] Worker migrates; not stopped on reset/rollback | Fixed | Checker and notifier only wait for `schema_version ≥ STATUS_V`; `--reset` stops and `--rollback` disables the units; `status:slug-check` on roll-forward. (§3.4, §4.8.1, §8) |
| 18 | [minor] Installer topology incomplete | Fixed | `write_status_units` in fresh install, `--update`, `--https` and `--tunnel`; `status.tunnel` and all global addresses in `config.json`; the sensor reads the config instead of a flag; runtime self-connection check. (§4.8.5, §6.1, §8) |
| 19 | [minor] custom-dialogs and bell mismatch | Fixed | `OYSUI` and `notify()`; types `status_down`/`status_up`/`status_team` with link `/dashboard#status`; owners notified on block/unblock/pause/resume and inactivity. (§2.1.5, §2.1.11, §4.7, §4.8.11, §5.1) |
| 20 | [minor] Admin mount lacks dependencies | Fixed | OnYourSite's page is managed in the editor's Status tab with an admin scope switch; the admin section links there. (§2.3, §5.1, §5.6) |
| 21 | [minor] One Discord target per incident | Fixed | `status_incident_posts` (one row per incident and target) replaces the two columns; event “Incident updates” added for Discord channels. (§3.1, §5.1, §5.8) |
| 22 | [minor] UI inconsistencies | Fixed | “Made with OnYourSite” via `brandingHidden`; rail order Code page → Status → Honeycombs with the shop's `.nav-desktop` phone rule; Markdown base-URL option. (§5.1, §5.3, §9) |
| 23 | [minor] Free tier not raised | Fixed | Open question 11 with costs and a recommendation. (§1.2, §10) |
| 24 | [minor] Heartbeat limits and “Check now” | Fixed | Per-token in-memory limits (no `rate_limits` writes), negative cache for unknown tokens, Cloudflare note; “Check now” through `status_run_requests` without a `status_rev` bump; incremental sync. (§4.5, §4.6, §4.8.2, §8) |
| 25 | [minor] Monitoring ships without notifications | Fixed | Owner email alerts, bell and the inactivity mail move into PR 4. (§9) |
| 26 | [minor] `slugProblem` signature and slug races | Fixed differently | Options object as code-slots-admin defines it; the race is closed by the registry's primary key in the same transaction instead of `GET_LOCK`. (§4.3, §4.6) |
| 27 | [minor] Gaps in OnYourSite's own checks | Fixed | `bot` uses last-seen + report age + a `gateway` field; disk alerts below 10 % (`disk` component); heartbeats for backup, weekly report and the shared jobs runner. (§3.1, §4.9) |
| 28 | [minor] Scope for v1 | Fixed | Daily rows 120 days; certificate warnings at 14 and 3 days (switch instead of a choice); reminders and Atom moved to follow-ups. (§1.3, §3.2, §3.6, §4.8.7, §5.2) |

### 11.2 Parts of findings not taken as proposed, and why

- **#1 – SERVFAIL and resolver timeouts are not always `internal`.** A zone with dead name servers or broken DNSSEC
  produces exactly these answers at a public resolver, so classifying them as ours would hide real outages – the
  same class of bug as #7. They count as `internal` only while the resolver canary fails too. Local socket errors
  (`EMFILE`, `ENFILE`, `ENOBUFS`, `EADDRNOTAVAIL`, `ENETUNREACH`) are always `internal`.
- **#1 – the failure-ratio trigger holds instead of freezing.** More than 30 % of hosts failing is also what a real
  outage of a large CDN looks like, and users must be told about that. With healthy canaries the gate holds new
  “down” changes for at most 3 minutes and then lets them through with their real start time; only failing canaries
  freeze.
- **#1 – heartbeat clocks restart instead of being extended.** Adding the outage length to the deadline still reports a
  job missing when its regular ping fell into our outage (example in §4.8.6); restarting the clock at the end of the
  outage, as the finding's second rule says, covers both.
- **#3 – brand names in page names are flagged, not refused.** “Acme Discord bot status” is a normal name for the
  people this module is for. Refusing it would hurt honest users, while the review flag keeps a flagged page out of
  search engines until an admin looked at it. The OnYourSite name is refused outright, as proposed.
- **#3 – “contains” matching only for distinctive brands.** Applying it to the whole of `blacklist.php:61-83` would
  refuse ordinary addresses: `items-status` contains `ms`, `delivery-status` contains `live`, `approval-status`
  contains `pro`. Short and word-like brands therefore count as whole tokens, distinctive brands of six letters or more
  as substrings. All of the review's examples are refused.
- **#6/#12 – one per-IP limit, not two.** #6 asks to drop or raise the per-IP gate, #12 asks for a per-IP cap. Both are
  met by one high per-IP request bucket (3,000/min): it never slows shared anycast addresses in the scenarios of §6.8,
  but bounds many domains pointed at one server. Politeness per site comes from the host and domain buckets.
- **#8 – the add-on names stay `status_more_checks` and `status_fast_checks`, not `monitor_pack`.** The finding asked to
  use the shop's names. In the meantime the shop's revised draft adopted this design's items (`status_page`,
  `status_more_checks` with two lots, `status_fast_checks`, prices 150/60/80) and its API changed (`purchaseUnlock`,
  `entitlement` with lots, `registerFeature` with `items`). Using those current names is what removes the mismatch;
  switching to the old `monitor_pack` would create it again. The `registerFeature` calls in §4.10 are the single
  definition. The pre-shop path is dropped anyway (as the finding proposed): `status_page` is registered in PR 4.
- **#10 – a separate notifier unit, not delivery from the web app.** Delivery runs continuously (retries, broadcasts,
  budgets) and needs a leader lock; inside the web process it would compete with requests and break once the web
  service is split into several processes on the 16 vCPUs. A small unit without IP restrictions keeps the checker's
  sandbox strict.
- **#12 – robots.txt only for groups that name us.** `User-agent: *` groups are written for crawlers; honouring them
  would stop most legitimate uptime checks. And on 5xx we keep the last known rules instead of RFC 9309's
  “disallow all”, which would pause a check exactly when the site is down.
- **#13 – 90-day hold plus redirect, through the shared registry.** The finding offered “hold 90 days” or “redirect 30
  days”; status pages get both, because old subscriber mails, embeds and JSON integrations keep pointing at an
  address for months. code-slots-admin's revised draft already holds every released address for 30 days; status
  needs one small addition there (a per-release hold length).
- **#26 – no `GET_LOCK` around check and insert.** code-slots-admin's revised draft introduced `site_addresses`, whose
  primary key is written in the same transaction as the page row. That closes the race for every writer and every
  process, which a named lock only does if every path remembers to take it.
