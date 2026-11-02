# Premium: custom domains for link pages and branding removal – design

Feature `premium-domains` · design date 2026-11-01, revised the same day after review (see "Review changes" at the end)
· built on the Node.js version (`app/`, branch `feature/node-typescript`) after the port · Cloudflare facts verified on
the web on 2026-11-01 (Appendix A) · contracts aligned with the revised designs of honeycomb-shop, code-slots-admin,
custom-dialogs and status-pages as they stood on 2026-11-01 at 21:20.

## 0. Summary

- **Premium is a user status owned by honeycomb-shop.** It is bought with honeycombs for 30 or 90 days or granted by an
  admin; admins always have it. honeycomb-shop stores it as `users.premium_until`, written in the same transaction as
  the `premium` entitlement ("for good" = `9999-12-31 23:59:59`), and provides `isPremiumRow`, `premiumState`, the
  reconcile/enforcer registry, perks and loss previews. Here Premium unlocks exactly two things: **a custom domain per
  link page** and **hiding the OnYourSite branding**. Today's other "premium" privileges (no page limit, 1000 MB, no
  address cooldown) stay **staff-only** (`isStaff`). honeycomb-shop and code-slots-admin say the same, so the owner
  answers this once for all three designs (Q8).
- **Branding**: the stored page setting `hide_branding` stays. A page hides the branding only when
  `hide_branding && (owner has Premium || page has the legacy flag)`, decided at render time, so expiry needs no data
  change. PR 1 keeps today's scope: the footer, the OG mark and the API flag. The title suffix, `og:image:alt` and the
  favicon follow only if the owner agrees (Q7), and then only for Premium. Free pages can no longer hide the note with
  the usual custom-CSS tricks: the footer has pinned inline styles, saving such CSS shows a warning, and the terms
  forbid it (Q9).
- **Domains (Cloudflare for SaaS)**: the user enters `links.example.com` and proves ownership with a TXT record bound to
  their account (`_onyoursite.links.example.com`). Only then is a Cloudflare custom hostname created (HTTP DCV). The
  user adds a CNAME to `edge.on-your.site`. The domain goes live once three checks pass: the Cloudflare status, the DNS
  (DNS-over-HTTPS, two resolvers) and an end-to-end probe through the Cloudflare edge.
- **All network work runs in one separate worker service** (`onyoursite-domains`, its own systemd sandbox and user).
  Only this worker receives the Cloudflare token, as a systemd credential. The website never calls Cloudflare, never
  probes, and never holds a database connection while it waits on the network. "Check now" only schedules a check,
  and the worker runs it within seconds.
- **A live domain becomes the page's primary address.** The OnYourSite addresses redirect to it with a 302; the owner
  can switch that off. Canonical, `og:url`, the OG image, share links and QR codes use the domain. Custom hosts never
  start sessions. They serve only the page, the owner's uploads and the page's public `/_/` endpoints.
- **Failure handling**:
  - Our own outages never count against a domain (control check and circuit breaker).
  - A domain that points elsewhere loses its Cloudflare hostname at once, so we never capture a domain whose owner
    moved it away.
  - DNS errors that last 30 minutes count as a failure.
  - When Premium ends, a domain that was live for at least the last 14 days forwards visitors to the OnYourSite
    address for 30 days. Otherwise its hostname is released at once.
  - When Premium comes back, the domain reconnects without DNS changes.
- **Takeover-safe**: a fresh TXT proof beats any other account's claim, unless that account's proof is still present.
  A claim can never lock out the real owner.
- **Installer**:
  - a second, narrow Cloudflare token (Zone · SSL and Certificates · Edit), stored root-only and passed only to the
    worker;
  - the DNS records `origin`/`edge` and the fallback origin;
  - a tunnel catch-all that sends custom hostnames to the website, merged into the existing rules;
  - the worker unit.
  `--update` checks and repairs without prompting. `--reset` and a domain change delete the hostnames first.
- **Cost**: Cloudflare includes 100 custom hostnames on Free/Pro/Business. Each further one costs $0.10 per month, up
  to 50,000. By default the app never goes beyond the free 100, and the free places are protected against squatting.
- **Scale**: the server now has 16 vCPUs. Nothing in this feature depends on per-process memory, so it works unchanged
  if the website later runs as several Node processes. The worker is one process with bounded concurrency.

---

## 1. Goal and the owner's requirement

### 1.1 Quote

> „… dazu will ich das man sich auch Custom Domain für link page mit Honeycombs kaufen kan und dns einträge bekommt
> wenn dieser will das seine domain dort stehen soll dies ist aber ein Premium Feature genauso wie das OnYourSite
> werbung weg zu machen.“
>
> Follow-up answer: „Custom domains: **Cloudflare for SaaS** (custom hostnames on the OnYourSite Cloudflare zone).“

(In English: users can buy a custom domain for a link page with honeycombs and receive the DNS records if they want
their domain shown there; this is a Premium feature, just like removing the OnYourSite advertising.)

### 1.2 Interpretation where the wording is ambiguous

| Wording | Interpretation in this design |
|---|---|
| "Custom Domain … mit Honeycombs kaufen" + "Premium Feature" | Honeycombs buy **Premium** (honeycomb-shop). By default Premium includes custom domains: no extra price, limits instead. The literal reading, where each domain costs honeycombs on top, is built in as an admin switch. With `slots` on, every domain needs a **domain slot** (`custom_domain`, a count feature that requires Premium, sold in the shop, §3.5). → Q1 becomes a catalogue setting, not a code change. |
| "dns einträge bekommt" | The app shows the exact records to add (name, type, value, relative "host" field, copy buttons) and checks them. It never edits the user's DNS. |
| "für link page" | Link (profile) pages only. A page that shows a code page cannot get a domain, and a page with a domain cannot be turned into a code page (code-slots-admin rule E7). Status pages can be added later through the target registry (§4.12, Q10). |
| "OnYourSite werbung weg machen" | v1 covers today's scope: the "Made with OnYourSite" footer, the "OnYourSite" mark on the OG card, and the `hide_branding` API field. The title suffix ` \| OnYourSite`, the `og:image:alt` suffix ` on OnYourSite` and the favicon follow in PR 1b only if the owner agrees (Q7). The code-page badge "Hosted on OnYourSite" (`lib/codesites.php:332-342`) is the code module's report link and stays (code-slots-admin Q8). |
| Premium for admins | Admin accounts always count as Premium (`isPremiumRow` = `is_admin \|\| premium_until > now`). An admin acting as a user sees the user's real Premium status, because honeycomb-shop reads the database, never the session. The admin keeps the staff privileges (`isStaff`) – but, superseded by DECISIONS.md R8, changes no custom domain while acting as the user (every domain action answers 403 `admin_mode`). |

### 1.3 Not in v1

- apex proxying with A records (Enterprise/paid add-on, Appendix A);
- wildcard hostnames (Enterprise);
- a www + apex pair for one page;
- custom certificates;
- code pages on custom domains (code-slots-admin Q7);
- status pages on custom domains (follow-up, §4.12, Q10);
- mail on custom domains;
- managing the user's DNS;
- customer records proxied by the customer's own Cloudflare zone ("orange cloud", O2O). Users set the CNAME to
  "DNS only".

### 1.4 What the code does today (PHP reference; the Node port keeps it)

- `oys_has_premium()` = admin or an admin in user mode (`lib/routes_app.php:23-26`; Node `hasPremium()` in
  `app/src/app/context.ts:15-18`). `$premium` (`lib/routes_app.php:197`) drives:
  - the upload quota (`:333`);
  - the page limit (`:349`, `static/js/editor.js:593,694,2716`);
  - the slug cooldown (`:433`, `views/dashboard.php:35`, `editor.js:2768`);
  - `hide_branding` editing (`lib/pages.php:83`, `editor.js:2733-2734`).
- Branding output:
  - footer (`lib/render.php:165-167`);
  - title suffix (`:22`);
  - `og:image:alt` (`:110`);
  - favicon (`:117`);
  - OG mark (`lib/share.php:157-161`), which is also part of the OG hash (`:34`);
  - API field (`api.php:73`).
  - The 2.0 migration copied the legacy `users.hide_branding` into page settings (`lib/schema.php:468`, Node
    `migrateLegacyUsers` in `app/src/schema.ts`).
- Custom CSS is open to every user (`editor.js:2735`, `lib/pages.php:81`). The sanitizer removes only external URLs,
  `@import` and `<` (`lib/pages.php:92-158`). The CSS is printed into the page head (`lib/render.php:123`), and the
  footer is `<footer class="oys-foot">` (`:165-167`). So today `.oys-foot{display:none}` hides the note on any page.
- Addresses:
  - URL helpers: `oys_page_urls/url/origin/on_page_host` (`lib/helpers.php:63-104`; Node `app/src/helpers.ts`).
  - Redirects between path and subdomain mode (`index.php:83-87,103-110`).
  - Booking blocks count as "internal" when their URL equals one of the page's own addresses
    (`lib/blocks.php:33-46`). This drives `/kalender` access (`lib/pages.php:421-435`) and block targets
    (`lib/routes_public.php:38`).
  - The stats beacons only accept origins on the base domain (`lib/stats.php:24-33`).
- Router order (`app/src/router.ts:34-86`):
  1. the https redirect (`:36-38`);
  2. the deny list (`:40-44`). It denies every path segment that starts with a dot (`app/src/web/static.ts:19-25`),
     so `/.well-known/…` gets 403 on every host;
  3. uploads, before any host logic (`:45-50`);
  4. static files (`:52`);
  5. the old PHP entry points (`:56-58`);
  6. `/_/` on every host (`:65-68`);
  7. main host (`:73-78`), subdomains (`:81-84`), otherwise 404 (`:86`).
- Public endpoints:
  - `oys_public_block` finds blocks of **any** page (`lib/routes_public.php:11-30`);
  - `/_/go` with an unknown block renders the OnYourSite 404 view (`:132-137`);
  - a failed contact post without JSON redirects to the main site (`:184`).
- Uploads are named `<kind>_<userId>_<random>.<ext>` (`lib/blocks.php:60-73`) and are served on every host
  (`lib/storage.php:67-84`).
- The DB pool has `connectionLimit: 10` (`app/src/db.ts:74`), and `withNamedLock` holds one connection for its whole
  callback (`app/src/db.ts:177-187`).
- The Node website runs as one process (plan §0 item 6), as `www-data`, behind Apache, which stays the TLS terminator
  (plan item 5).
- The tunnel sends `$DOMAIN`, `www.` and `*.` to `https://127.0.0.1:443` with `originServerName: $DOMAIN` and ends with
  `http_status:404` (`server/install.sh:1237-1240`). So today a custom hostname would get a 404 from cloudflared.

---

## 2. User stories and flows

### 2.1 Premium and branding (users)

| # | Story | Behaviour |
|---|---|---|
| B1 | Premium user hides the branding | The Settings → "Branding & custom CSS" switch works as today. The page loses the footer and the OG mark. After Q7 (PR 1b) it also loses the title suffix and the `og:image:alt` suffix, and gets the avatar as favicon. |
| B2 | Free user | The switch is disabled with today's lock pill. Once Premium can be bought, honeycomb-shop turns the pill into its "Get Premium" link (`data-action="honeycombs" data-feature="premium"` → `openShop('premium')`, their U16). The hint reads "Included in Premium." |
| B3 | Premium ended, switch was on | The stored value stays `true`, but the page shows the branding again; the OG hash changes, so a new card is generated. The switch shows as on but disabled, with an amber hint: "Premium ended – the note is shown again. Renew Premium to hide it." Renewing restores it with no action. |
| B4 | Legacy page (hid the branding before Premium existed; owner has no Premium) | The page keeps hiding the footer and the OG mark (`settings.branding_legacy = true`, §3.4). The switch is enabled, but only for turning it **off**. Hint: "Kept from before Premium existed. If you turn it off, you’ll need Premium to turn it back on." → Q3. |
| B5 | Admin acting as a user | The admin can flip the stored switch for the user (`isStaff`, as today). It only takes effect if the user has Premium or the legacy flag. To give a user branding removal, the admin grants Premium (honeycomb-shop admin). |
| B6 | Free user hides the note with custom CSS (e.g. `.oys-foot{display:none}`) | The save works, but the answer carries a warning that shows under the CSS field: "Your custom CSS targets the “Made with OnYourSite” note. Hiding it is part of Premium, so it stays visible." The note's own inline styles keep it visible against the usual tricks (§4.4.1). Hiding it in other ways breaks the terms (§5.6). |

### 2.2 Connecting a domain – happy path (subdomain)

1. Settings → new section **Custom domain** (below "Address"). The user enters `links.example.com` and selects
   **Connect domain**.
2. The server checks, without any DNS lookup:
   - the feature is available and switched on;
   - the page is a link page (no code page);
   - the owner has Premium with at least 7 days left, or Premium for good, or is an admin;
   - the account is at least `min_account_days` (30) old. This does not apply to admins or to Premium granted by an
     admin;
   - the page has no domain yet;
   - the limits allow it (per user; a free domain slot when slots are on);
   - the hostname is valid;
   - the takeover rules allow it (2.8).

   A row is created in state `verifying`. No DNS query runs yet, so resolvers cannot cache a "not found" before the
   records exist (§4.7).
3. The section shows the two records with copy buttons:

   | Type | Name (host field) | Value |
   |---|---|---|
   | TXT | `_onyoursite.links` (full: `_onyoursite.links.example.com`) | `onyoursite-verify=3f9c0a…` (32 hex) |
   | CNAME | `links` (full: `links.example.com`) | `edge.on-your.site` |

   It also shows a checklist: ○ Ownership confirmed · ○ Domain points to OnYourSite · ○ Secure connection (HTTPS) ·
   ○ Live. Both record rows show a grey "Not checked yet".
4. The user adds both records and selects **Check now** (hint: "Added the records? Select Check now."). The worker
   checks the TXT within seconds. Without a click, the first automatic check runs 10 minutes after adding, then on the
   schedule (§4.9). The editor itself only reads the state (`GET domain`), every 3 s while a check is running, then
   every 15 s until the end of the fast window (§5.2).
5. TXT found → ✓ Ownership. The worker creates the Cloudflare custom hostname (`ssl.method=http`). State → `pending`.
   From now on the CNAME is checked too.
6. The CNAME is in place → Cloudflare validates the hostname in real time and issues the certificate over HTTP DCV
   (minutes). The worker sees `status=active`, `ssl.status=active`, the CNAME to `edge.on-your.site` and the probe
   answering → state `active`.
7. The badge turns **Live** with the text "Your page is live at https://links.example.com. Your OnYourSite addresses,
   QR codes and shared links lead here." The user also gets a bell notification and an email.

### 2.3 Apex domain (`example.com`)

- `domain-add` recognises a likely root domain without DNS. That is a name with two labels (`example.com`), or with
  three labels that end in a common two-part suffix (`co.uk`, `com.au`, `co.nz`, `com.br`, `co.jp` …; a fixed list of
  about 30 in `hostname.ts`). Then it first answers `{ok:false, confirm:"apex"}`.
- The editor shows `OYSUI.choice` (custom-dialogs) with the title "example.com is a root domain" and the text: "Most DNS
  providers can’t point a root domain to another name. We recommend www.example.com or a subdomain like
  links.example.com, and forwarding example.com to it at your provider. Continue only if your provider supports CNAME
  flattening, ALIAS or ANAME records." The options are "Use www.example.com" (primary), "Continue with example.com"
  and "Cancel".
- The worker later confirms "root domain or not" from the zone it finds (§4.7). The records table follows that result,
  so a wrong guess only affects the question.
- Records: the CNAME row shows the host `@` and the note "Use CNAME flattening, ALIAS or ANAME – a plain CNAME isn’t
  allowed at the root". The TXT is the same as for subdomains.
- After the Cloudflare hostname exists, the section lists the records Cloudflare asks for under "Additional records".
  Cloudflare cannot follow a flattened record, so these are needed:
  - the `ownership_verification` TXT (`_cf-custom-hostname.example.com`);
  - the delegated DCV CNAME (`_acme-challenge.example.com` → `…dcv.cloudflare.com`, from
    `ssl.dcv_delegation_records`), which keeps certificate renewals automatic.
  - If Cloudflare offers no delegation record and HTTP validation has not succeeded within 30 minutes, the worker
    switches the hostname to TXT validation (`PATCH … {"ssl":{"method":"txt","type":"dv"}}`, Appendix B). It then
    shows `ssl.validation_records[].txt_name/txt_value` with the note "This value changes when the certificate is
    renewed – we’ll tell you when." The new value at renewal reaches the user through `cert_expiring` (2.6).
- A root domain without a visible CNAME counts as "points to us" only under three conditions together: Cloudflare
  reports `status=active`, all its addresses are Cloudflare's, and at least one equals a current address of
  `edge.on-your.site` (§4.7).
- A-record apex setups (apex proxying) are not offered (Enterprise or paid add-on).

### 2.4 Error, empty and limit states (editor)

| Situation | What the user sees |
|---|---|
| Feature not configured on the server | The section is not rendered at all. |
| Admin switched new domains off | The section shows existing domains only. The form is replaced by "New custom domains are paused right now." |
| Not Premium | A teaser card: globe icon, "Use your own domain, like links.yourname.com, for this page.", "Included in Premium", button **Get Premium** (`openShop('premium')`). |
| Premium ends within 7 days | "Your Premium ends on Nov 30. Extend it to connect a domain." with the button **Extend Premium**. |
| Account younger than `min_account_days` | "Custom domains are available once your account is 30 days old." |
| Page shows a code page | "Custom domains work for link pages only." |
| Page has no domain (Premium) | Input with a `https://` addon, placeholder `links.yourname.com`, button **Connect domain**, hint "Use a domain you own. You’ll get two DNS records to add at your domain provider." |
| Invalid input | Inline error from the server (texts in 4.5.2). |
| Not checked yet | "Add the two records below, then select Check now." |
| TXT missing | "We can’t see the TXT record yet. DNS changes usually show up within minutes, sometimes up to an hour." |
| TXT wrong value | "The TXT record has a different value. Please copy the value again." |
| CNAME missing / pointing elsewhere / A records | "The CNAME record for links.example.com is missing." / "links.example.com points to other.host – it should point to edge.on-your.site." / "links.example.com points to 203.0.113.7. Replace that record with the CNAME above." |
| CNAME proxied by Cloudflare or flattened (only Cloudflare addresses, no CNAME visible) | "links.example.com is proxied by Cloudflare (orange cloud) or flattened. Use a plain CNAME set to “DNS only” (grey cloud)." |
| DNS error | "Your domain’s DNS answers with an error (SERVFAIL) – often a DNSSEC problem at your provider." After 30 minutes the domain counts as not reachable (2.6). |
| HTTPS pending | "Your domain points to us. The HTTPS certificate is being issued – this usually takes a few minutes." |
| CAA blocks the certificate | "A CAA record on your domain blocks the certificate. Allow letsencrypt.org, pki.goog and ssl.com, or remove the CAA record." |
| Waiting for a free place | "Custom domains are fully booked right now. Yours is next in line (position 3) – we connect it as soon as a place is free." The verification timeout is paused. The admins get an email. |
| Another of the user's domains is still being set up | "We’ll set this one up as soon as links.example.com is live." |
| Not confirmed within 7 days | Red badge "Couldn’t be verified", text "We couldn’t confirm your domain within 7 days. Check the records and select Check again." |
| Per-user limit | "You’ve connected 3 of 3 domains. Remove one from another page to connect a new one." |
| Slots on, no free slot | "Each custom domain needs a domain slot. Get one in the shop." with the button **Get a domain slot** (`openShop('custom_domain')`). |
| Rate limits | "Please wait a moment before checking again." / "You’ve added too many domains today. Please try again tomorrow." |
| Worker not seen for over 5 minutes | Amber line: "Checks are delayed right now – your page and domain keep working." |
| Domain in another account | "This domain is connected to or waiting in another account. To use it here, add this TXT record to prove it’s yours, then select “I’ve added it”." (the TXT row is shown; 2.8) |
| Proof of another account still present | "There is another OnYourSite TXT value on _onyoursite.links.example.com. Remove it at your DNS provider (keep yours: onyoursite-verify=3f9c…), then try again." |
| Domain used by your other page | "This domain is already connected to your page “mia”. Remove it there first." |
| Domain disabled by the team in another account | "This domain can’t be connected right now. Please contact support." |
| Domain being removed from another page | "This domain is being disconnected from another page. Please try again in a few minutes." |

### 2.5 What changes when the domain is live

| Area | Behaviour |
|---|---|
| Primary address | `pages.custom_domain` is set. `pageUrl()` returns `https://links.example.com`. The Address section shows a third card "Custom domain – Primary address"; both OnYourSite cards show "Redirects". |
| `mia.on-your.site`, `on-your.site/mia` | 302 to `https://links.example.com` (plus `/kalender` and the raw query, as the path/subdomain redirects do today), with `Cache-Control: no-store`. It is a **302 on purpose**: a cached 301 would loop once the domain is paused and forwards back. This holds while the switch "Forward my OnYourSite addresses to this domain" is on (default). With the switch off, both OnYourSite addresses keep showing the page, with canonical pointing to the domain. |
| Canonical, `og:url`, share button, QR, OG image URL and card text, API `url`, admin list, weekly report, message mails | All use the domain, because they go through `pageUrl/pageOrigin/pageDisplayUrl`. |
| Stats | The beacons `/_/v` and `/_/c` from the domain are accepted (4.3). |
| Calendar, protected links, contact form | They work on the domain, because their absolute URLs come from `pageUrl`. A booking block that links to `https://links.example.com/kalender` stays internal whatever the domain's state (4.3). |
| Sessions | None on the domain; login and editor stay on `on-your.site`. |

### 2.6 Problems later, certificate renewal

- **Definite failures.** Each must be seen twice, at least 10 minutes apart:
  - Cloudflare reports `moved`, `deleted` or `blocked`, answers 404 for the hostname, or reports an expired or inactive
    certificate;
  - the DNS answers on both resolvers and the domain points elsewhere, has no record, or (for a subdomain) shows only
    Cloudflare addresses without our CNAME;
  - the DNS fails (SERVFAIL or timeout) on both resolvers for at least 30 minutes and 3 checks in a row;
  - the probe gets a TLS certificate that is not valid for the hostname, or a 2xx–4xx answer that is not ours.
- **Unknown, never counted**:
  - network errors and timeouts;
  - any 5xx from Cloudflare or from us (including 52x and 530/1033);
  - any response with `cf-mitigated`;
  - anything while the circuit breaker is open.
- **Circuit breaker.** Once a minute the worker checks our own path: both resolvers must resolve `edge.on-your.site`,
  and `https://on-your.site/_/domain-check` must answer correctly through the same edge address. The breaker opens when
  - that control fails, or
  - more than 20 % of the live domains (and at least 3) failed definitely within 10 minutes.

  While it is open, all downgrades and hostname deletions pause and only the admins are told (once per 6 hours). It
  closes by itself when the control passes and the failure rate drops.
- **Effects of `broken`**:
  - `pages.custom_domain` is cleared, so the OnYourSite address is primary again (no redirect). If traffic still
    arrives on the domain, it still shows the page, with canonical pointing to the OnYourSite address.
  - If the cause is that the domain points elsewhere, has no record, or Cloudflare reports `moved`/`deleted`, the
    Cloudflare hostname is **deleted at once**. A kept hostname would go on capturing the domain (§6.1, Appendix A).
    The row stays `broken` without a hostname. When the CNAME comes back, the worker creates a new hostname (the TXT
    proof is still valid; at most 3 creations per domain per 24 h) → `pending` → `active`.
  - For the other causes (certificate, DNS errors, probe) the hostname is kept.
  - The user gets a bell notification and an email: "links.example.com doesn’t point to OnYourSite any more. Your page
    is shown at mia.on-your.site until it’s fixed." There is at most one problem notice per domain per 24 h, and
    "back online" only follows a problem notice.
  - When the checks pass again → `active` and the notification "back online".
  - After 7 days `broken`, the hostname is deleted if it still exists → `failed(broken_timeout)`.
- **Certificate renewal** is done by Cloudflare: 90-day certificates, renewal opens 30 days before expiry, automatic over
  HTTP DCV while the CNAME points to us and traffic is proxied (Appendix A). The probe records the certificate's
  `valid_to` in `cert_expires_at`.
  - Less than 14 days left and Cloudflare reports no active certificate → problem `cert_expiring`: one notification to
    the user (with the CAA hint, or the new TXT value for the apex fallback of 2.3) and one email to the admins.
  - Expired → a definite failure → `broken`.

### 2.7 Premium ends or comes back

| Event | Domain | Page |
|---|---|---|
| Premium ends, is revoked or refunded, or the admin role is removed | honeycomb-shop marks the account for reconcile and runs this design's enforcer right after the change; its job retries. The worker's minute check is a further safety net (§4.9). The domain becomes `suspended` and `pages.custom_domain` is cleared. **Forwarding**: if the domain was live for at least the last 14 days, the hostname is kept for `grace_days` (30) and visitors of the domain get a 302 to the OnYourSite address, so printed links keep working. Otherwise (not live, or live for less than 14 days) the hostname is deleted at once. This keeps short Premium periods from holding the free hostname places (6.1). | Fully online at its OnYourSite address; the branding is shown again (B3). |
| Notice | honeycomb-shop's notices for the end, a revoke or a refund (bell and mail) include this design's loss-preview lines: "links.example.com forwards to mia.on-your.site until Dec 30." or "links.example.com is disconnected until you renew Premium.". Only when Premium is lost without an entitlement change (the admin role was removed) does this design send its own bell `domain_paused`. | – |
| Grace period over | The Cloudflare hostname is deleted (`cf_id = NULL`) and the state stays `suspended`. The editor shows "Premium ended. Renew Premium to reconnect links.example.com." The row is deleted 90 days after the suspension. | – |
| The domain is moved away during the suspension (Cloudflare `moved`, or the DNS points elsewhere twice) | The hostname is deleted at once, so our hostname does not keep catching traffic for a domain the user moved (Appendix A, hostname priority). | – |
| Premium is back | With `cf_id` → `pending` with fast checks, then `active` in minutes, no DNS change. Without `cf_id` → `verifying` with an immediate check; if the TXT is still there, it reconnects by itself (when a place is free). | The branding switch takes effect again. |
| User is admin | Never expires. If the admin flag is removed, the next reconcile treats the user like everyone else. | – |

### 2.8 Removing, deleting, takeover rules

- **Remove** (any state) uses `OYSUI.prompt` with:
  - title "Remove links.example.com?";
  - text "Your page goes back to mia.on-your.site right away. Links and QR codes that use links.example.com stop
    working. Afterwards, delete the CNAME and TXT records at your domain provider.";
  - `match` = the hostname, `normalize: 'host'`, `matchLabel` "Type links.example.com to confirm", `tone: 'danger'`,
    `ok` "Remove domain".

  Then:
  - `pages.custom_domain` is cleared and the state becomes `removing`, in one compare-and-set transaction.
  - Without a hostname the row is deleted at once. Otherwise the worker deletes the hostname (retrying until
    Cloudflare confirms; a 404 counts as done) and then the row.
  - There is no forwarding after Remove. A kept hostname would capture the domain as soon as its owner points it
    somewhere else.
- **Page deleted** (user `page-delete`, admin "delete user"): the hook `beforePageRemoved(pageId)` runs first and does
  the same as Remove.
- **Turning a page into a code page** is refused while the page has a domain in any state (code-slots-admin E7: "Remove
  the custom domain of this page first – custom domains work for link pages only."). They call
  `domains.hasDomain(pageId, db)` under their slot lock, and `domain-add` takes the same lock (4.5.2).
- **Takeover rules** (the hostname is unique across all rows). Ages count from `created_at` and are never reset by
  "Check again".

  | Existing row for the hostname | Request from user U | Result |
  |---|---|---|
  | none | U | Created for U (`verifying`). |
  | U, same page | U | Returns the existing row (a `failed` row offers "Check again"). |
  | U, other page | U | 409 "already connected to your page “slug”. Remove it there first." |
  | V ≠ U in `blocked` | U | 409 "can’t be connected right now … contact support" (only an admin releases it). |
  | V ≠ U in `removing` | U | 409 "being disconnected from another page … try again in a few minutes". |
  | V ≠ U in any other state (`verifying`, `failed`, `pending`, `active`, `broken`, `suspended`), any age | U without `claim` | 409 with a `challenge` that contains U's TXT record. No DNS lookup yet, so nothing negative is cached before U adds the record. V's state is not revealed. |
  | same | U with `claim:true` ("I’ve added it") | One TXT lookup on both resolvers (§4.5.2). Only U's value present → **transfer**: V's row moves to U's page in state `verifying` with an immediate check, V's page loses the domain, log `transferred`, V gets `domain_removed` "removed because the domain’s owner connected it to another account". U's value missing → 409 challenge again. Another account's value present as well → 409 "There is another OnYourSite TXT value … remove it (keep yours) …". DNS error → 409 "We couldn’t check your DNS right now. Please try again in a few minutes." |

  Why this is safe: only someone who controls the domain's DNS can publish U's value and remove V's. An unproven or
  stale row in another account never blocks the real owner, whatever its age or state.

  Admins can remove any domain.
- **Clean-up**: `failed` rows are deleted 30 days after failing; `suspended` rows without a hostname 90 days after the
  suspension.

### 2.9 Visitors

| Request | Result |
|---|---|
| `https://links.example.com/` (active/pending/broken) | The page, rendered exactly as on the subdomain, except: canonical is the primary address; the branding depends on the owner's Premium. |
| `/kalender`, `/_/go/N`, contact form, `/_/og/…png` on the domain | Work as on the subdomain – but only for blocks and the OG card of **this** page. Ids of other pages get the neutral 404. |
| `/static/…` (theme CSS, fonts, scripts) | Served as on every host. |
| `/static/uploads/<name>` | Only files of the domain's owner (the user id in the file name). Any other file → neutral 404. |
| `/_/domain-check` | The probe answer (states `pending`, `active`, `broken`, `suspended`). |
| Any other path | 302 to `https://links.example.com/`, like the subdomain rule (`index.php:103-104`). |
| `/login`, `/dashboard`, `/admin`, `/api.php`, `/admin_*.php`, `/track-click`, any other `/_/…` | 404 (neutral page), no session. |
| Paused (`suspended`) domain | 302 to the page's OnYourSite address (keeping `/kalender` and the query). |
| Domain not connected (no row, `verifying`, `failed`, `blocked`, `removing`) | 404, neutral page "This domain isn’t connected to a page right now." with no OnYourSite marketing and `noindex`. |
| Any other "not found" on a custom host | The same neutral page, never the OnYourSite marketing 404. |
| Domain removed but CNAME still set | Cloudflare error page (no hostname in our zone). The editor told the user to delete the records. |

### 2.10 Admins

| # | Story |
|---|---|
| A1 | Runs `install.sh --domains` once (8.2). The admin section shows a health panel: token (as last tested by the worker), fallback origin, CNAME target, worker (last seen), checks (running, or paused by the circuit breaker with the reason), quota, last successful probe. |
| A2 | Settings: new domains on/off, per-user limit, global cap, "allow paid hostnames beyond the free quota", grace days, setup days (1–7), minimum account age, "Each domain needs a domain slot" (slots). |
| A3 | Domain list with search: state, owner, page, Cloudflare and SSL status, last error, place in line, dates. Actions: **Check now**, **Disable** (with a reason the user sees; the hostname is deleted), **Enable**, **Remove**. A collapsible event log per domain. |
| A4 | Gives a user Premium (honeycomb-shop admin grant). That user can then connect a domain; the account-age rule does not apply to Premium granted by an admin. |
| A5 | Gets a bell notification (`notifyAdmins('team', …)`) and an email when the token stops working, the fallback origin is not `active`, the quota reaches 80 % or 100 %, the circuit breaker opens, or the worker has not been seen for 10 minutes. The last case is noticed on admin page views and by status-pages' `job:domains` check (`domains.health()`, 4.10). |
| A6 | Hostnames this app created but no longer tracks (their id appears in a `cf_created`/`cf_adopted` log row) are deleted automatically by the daily sweep. Only hostnames created by hand are listed as "Cloudflare hostnames not managed here", read-only and never deleted. |

### 2.11 State machine

```
                 add (Premium ≥ 7 days left, limits ok)       own TXT found + a free place: hostname created
   (no row) ─────────────────────────────────▶ verifying ────────────────────────────────────────▶ pending
                                                │    ▲                                               │    ▲
             7 days after created_at without    │    │ "Check again" and the TXT is found             │    │ Premium back
             TXT (paused while it waits for a   ▼    │ (hostname created)              CF active +    │    │ (hostname kept)
             free place)                      failed ◀── pending_days (≤ 7) passed ───── SSL active + │    │
                                                ▲                                       DNS ok +       ▼    │
                                                └── 7 days broken ◀── broken ◀─────────▶ active (probe ok)  │
                                                                  2 definite failures / checks pass         │
             points elsewhere, no record or moved: hostname deleted at once, the row stays broken;          │
             CNAME back + TXT ok → new hostname → pending                                                    │
   Premium lost (verifying|pending|active|broken) ──▶ suspended ── Premium back ────────────────────────────┘
       hostname kept for grace_days only if it was live for the last 14 days, otherwise deleted at once;
       without a hostname: Premium back → verifying; the row is deleted 90 days after the suspension
   admin "Disable" (any) ──▶ blocked (hostname deleted) ── admin "Enable" ──▶ verifying
   remove / page or user deleted (any) ──▶ removing ── hostname deleted ──▶ row deleted
   fresh TXT proof of another account (any state except blocked/removing) ──▶ the row moves to that account (verifying)
```

Invariant: `pages.custom_domain = hostname` ⇔ state `active` (and the owner has Premium). It is set and cleared in
the same transaction as the state. Every state write is a compare-and-set on `custom_domains.version` (§4.9).

---

## 3. Data model

### 3.1 Migration (schema version N = the next free number when the PR merges; current Node version 5)

Two migration steps, one per PR (see 9). Both follow `app/src/schema.ts` conventions: `IF NOT EXISTS`, `addColumn()`
(`schema.ts:78`) and the shared `OPTS`.

**Step A – PR 2 "domain core"**

```sql
-- Eigene Domains (Premium): eine Zeile je Domain, Ziel ist (vorerst) eine Profilseite
CREATE TABLE IF NOT EXISTS custom_domains (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  hostname VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,      -- immer klein, ASCII/Punycode
  target_type VARCHAR(8) NOT NULL DEFAULT 'page',                           -- Zielart aus der Registry (§4.12)
  target_id INT UNSIGNED NOT NULL,                                          -- pages.id
  user_id INT NOT NULL,
  state VARCHAR(12) NOT NULL DEFAULT 'verifying',
  version INT UNSIGNED NOT NULL DEFAULT 0,                                  -- +1 bei jeder Änderung (Compare-and-set)
  state_at DATETIME NOT NULL,                                               -- letzte Zustandsänderung
  is_apex TINYINT(1) NOT NULL DEFAULT 0,
  zone_name VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NULL,         -- Zone des Nutzers (für "Host"-Felder)
  redirect TINYINT(1) NOT NULL DEFAULT 1,                                   -- OnYourSite-Adressen leiten auf die Domain um
  cf_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,              -- Cloudflare custom hostname id
  cf_status VARCHAR(32) NOT NULL DEFAULT '',
  cf_ssl_status VARCHAR(32) NOT NULL DEFAULT '',
  cf_created_at DATETIME NULL,
  problem VARCHAR(32) NOT NULL DEFAULT '',
  problem_detail VARCHAR(255) NOT NULL DEFAULT '',
  fail_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,                          -- eindeutige Fehler in Folge
  fail_since DATETIME NULL,
  dns_unknown_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,                   -- DNS-Fehler bei beiden Resolvern in Folge
  dns_unknown_since DATETIME NULL,
  checked_at DATETIME NULL,
  next_check_at DATETIME NULL,
  fast_until DATETIME NULL,
  manual_at DATETIME NULL,                                                  -- "Jetzt prüfen" angefordert
  patched_at DATETIME NULL,                                                 -- letzter PATCH bei Cloudflare
  verified_at DATETIME NULL,                                                -- TXT zuletzt bestätigt
  activated_at DATETIME NULL,                                               -- Beginn der aktuellen Live-Phase
  suspended_at DATETIME NULL,
  notice_state TINYINT UNSIGNED NOT NULL DEFAULT 0,                         -- 1 = Problem gemeldet, "wieder da" folgt
  notice_at DATETIME NULL,
  blocked_reason VARCHAR(200) NULL,
  cert_expires_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uq_hostname (hostname),
  UNIQUE KEY uq_target (target_type, target_id),
  KEY idx_user (user_id, state),
  KEY idx_due (next_check_at),
  KEY idx_state (state, state_at),
  KEY idx_cf (cf_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Verlauf für Admins und Support; zugleich Mail-Warteschlange und Liste aller Cloudflare-IDs, die wir angelegt haben
CREATE TABLE IF NOT EXISTS custom_domain_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  domain_id INT UNSIGNED NULL,
  hostname VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NULL,
  event VARCHAR(24) NOT NULL,
  detail VARCHAR(255) NOT NULL DEFAULT '',
  cf_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,              -- bei cf_created / cf_adopted / cf_deleted
  mail TINYINT UNSIGNED NOT NULL DEFAULT 0,                                 -- 1 = E-Mail an den Besitzer fällig
  mail_tries TINYINT UNSIGNED NOT NULL DEFAULT 0,
  mailed_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  KEY idx_domain (domain_id, id),
  KEY idx_host (hostname, id),
  KEY idx_cf (cf_id),
  KEY idx_mail (mail, mailed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

```ts
// Hauptadresse einer Seite, solange ihre Domain live ist (NULL = OnYourSite-Adresse)
await addColumn(conn, 'pages', 'custom_domain', 'VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NULL');
// Eindeutig – mehrere NULL sind erlaubt
if (!(await rows(conn, "SHOW INDEX FROM pages WHERE Key_name = 'uq_custom_domain'")).length) {
  await run(conn, 'CREATE UNIQUE INDEX uq_custom_domain ON pages (custom_domain)');
}
```

- `state` takes `verifying | pending | active | broken | suspended | failed | blocked | removing`.
- `problem` takes `txt_missing | txt_wrong | cname_missing | cname_wrong | cname_proxied | a_records | apex_ips |
  dns_error | dns_unknown | cf_pending | ssl_pending | caa | cf_moved | cf_blocked | cf_rejected | quota | waiting_own |
  probe_failed | cert_expiring | verify_timeout | setup_timeout | broken_timeout | premium_ended | target_changed |
  api_error | ''`.
- Log events: `added | txt_ok | waiting | cf_created | cf_adopted | cf_deleted | active | broken | recovered |
  suspended | resumed | failed | blocked | unblocked | removed | transferred | redirect | check | api_error`.

**Step B – PR 1 "branding"** (data only, no DDL): see 3.4.

### 3.2 `oys_meta`

| Key | Shape | Written by |
|---|---|---|
| `custom_domains` | `{"enabled":false,"per_user":3,"max_total":100,"allow_paid":false,"grace_days":30,"pending_days":7,"min_account_days":30,"slots":false}` | Admin settings. Read with clamping: `per_user` 0–10, `max_total` 0–50000, `grace_days` 0–90, `pending_days` 1–7 (Cloudflare deletes hostnames that are not validated within 7 days, Appendix A), `min_account_days` 0–365; booleans via `phpTruthy`. A missing or broken row means the defaults. |
| `custom_domains_state` | `{"worker_at":"2026-11-01 20:15:05","daily_at":"2026-11-01","token":"ok","token_error":"","fallback":{"origin":"origin.on-your.site","status":"active","checked_at":"…"},"quota":{"allocated":100,"used":7,"exceeded":false,"hard_cap":200,"checked_at":"…"},"probe_ok_at":"…","control":{"ok":true,"at":"…","error":""},"freeze":null,"alerts":{"quota80":"2026-10-30"},"cf_ips":{"v4":["173.245.48.0/20",…],"v6":["2400:cb00::/32",…],"fetched_at":"…"},"unmanaged":[{"hostname":"…","id":"…","status":"active"}],"test":{"at":"…","result":"…"}}` – `freeze` is `null` or `{"since":"…","reason":"control"\|"mass","detail":"…"}` | Only the worker. Health data, no secrets. |
| `custom_domains_req` | `{"test":"2026-11-01 20:15:00","control":"…"}` | Admin actions (4.6); the worker reads and clears it. |

### 3.3 `config.json` and the Cloudflare credential

```json
{
  "cloudflare": { "zone_id": "<32 hex>" },
  "custom_domains": { "cname_target": "edge.on-your.site", "fallback_origin": "origin.on-your.site" }
}
```

- **The website token is not in `config.json`.** It lives in `/etc/onyoursite/cf-saas.token` (`root:root 0600`) and
  reaches only the worker, through `LoadCredential=cf_saas_token:/etc/onyoursite/cf-saas.token` (8.2). The website
  process (`www-data`) cannot read it.
- The feature counts as **available** when the three values above are non-empty. The installer writes them only after
  the token check passed. Otherwise the editor section, the admin section (except a "not set up" card with the
  installer command), the router branch and the worker do nothing.
- Test-only keys:
  - `cloudflare.api_base` (default `https://api.cloudflare.com/client/v4`)
  - `custom_domains.doh` (list of DoH JSON endpoints)
  - `custom_domains.edge_ips` (skips resolving the CNAME target)
  - `custom_domains.probe_ca` (PEM path)
  - `custom_domains.url_port` (appended to custom-domain URLs in local tests)
  - `custom_domains.token_file` (production uses `$CREDENTIALS_DIRECTORY/cf_saas_token`)

### 3.4 Existing data

- No existing page or URL changes: `pages.custom_domain` starts as NULL, and the new tables start empty.
- **Branding, preserving the current state (Step B)**: a page gets `"branding_legacy": true` when all of these hold:
  - its settings JSON has `hide_branding === true`;
  - its owner is not an admin;
  - its owner has no Premium at migration time (`isPremiumRow(owner)` is false).

  Owners who already have Premium (before PR 1 only an admin can grant it, and only for good – honeycomb-shop §4.4)
  are skipped, so if that Premium is revoked later, the branding comes back. The step runs in the migration with JS:
  parse with the ported PHP JSON decoder, write back with the same encoder the page save uses.
- The **visible** output of every page stays the same in PR 1: footer and OG mark exactly as today for every page. The
  footer markup only gains inline styles (§4.4.1). PR 1b (only after Q7) changes titles, `og:image:alt` and favicons
  of Premium pages, admin pages included. Its release note says so.
- `settingsNormalize(in, userId, canEditBranding, old)` (port of `lib/pages.php:46-87`) carries the flag explicitly.
  Today the defaults drop unknown keys on save, so without this the flag would vanish:

```ts
// Branding: Premium (oder Staff) darf frei schalten; Bestandsschutz nur zum Ausschalten
if (canEditBranding) {
  s.hide_branding = phpTruthy(input.hide_branding);
} else if (phpTruthy(old.branding_legacy) && phpTruthy(old.hide_branding)) {
  s.hide_branding = phpTruthy(input.hide_branding);          // nur „aus“ ist wirksam neu
} else {
  s.hide_branding = phpTruthy(old.hide_branding);            // wie bisher: alten Wert behalten
}
if (phpTruthy(old.branding_legacy) && s.hide_branding) s.branding_legacy = true;  // fällt weg, sobald aus
```

### 3.5 What I use from `honeycomb-shop` (Premium status) – their revised contract (honeycomb-shop §1.5, §3.6, §4.4)

1. **Storage and SQL path.** `users.premium_until`: NULL = no Premium, a date = Premium until then,
   `9999-12-31 23:59:59` = for good, never NULL for "for good". Their `setPeriod` writes it in the same transaction as
   the `premium` entitlement, and their nightly integrity check flags a mismatch. So the SQL path is simply
   `u.is_admin = 1 OR u.premium_until > NOW()`, equal to the entitlement condition
   `quantity > 0 AND (permanent OR expires_at > NOW())`.
2. **Functions** (`app/src/honeycombs/premium.ts`):
   - `isPremiumRow(user, now?)` on any loaded user row;
   - `premiumState(uid) → {active, until, forever, source}`, where `source` is `admin-role`, `purchase`, `admin`
     (granted) or `null`.
   Both read the database, never the session.
3. **Reconcile.** This design registers
   `registerEnforcer({name:'domains', features:['premium','custom_domain'], inline:true, run: domains.reconcileUser})`.
   It is `inline` because it only writes the database (no Cloudflare calls). honeycomb-shop calls it after every change
   (purchase, renewal, grant, revoke, refund, expiry, admin role toggle) through their durable reconcile marker.
4. **Loss preview.** This design registers `registerLossPreview('premium', domains.premiumLossPreview)`. Request: the
   lines appear in the reminders (as they do today, their U8) **and** in the notices for the end, a revoke and a refund
   (their U9). Then this design sends no second "paused" notice for those cases (§4.11).
5. **Perks.** This design registers `registerPerk('premium', {owner:'premium-domains', …})` twice:
   - PR 1: "No “Made with OnYourSite” on your pages", `ready: () => true` – this makes Premium ready (their rollout
     flag);
   - PR 4: "Your own domain for each link page", `ready: () => domainsAvailable() && settings().enabled`.
6. **Editor bootstrap.** HC-2 adds `E.premiumUntil` and `E.premiumForever`. This design's PR 1 switches `E.premium` to
   `isPremiumRow(user)` (the owner's real status) and adds `E.staff` at the same time, as honeycomb-shop asks
   (their §4.4).
7. **Shop UI.** `openShop(feature)` and the "Get Premium" pill markup (`data-action="honeycombs"
   data-feature="premium"`) are theirs. This design only adds the hint lines of B2–B4.
8. **Optional domain slots** (for Q1). This design registers the count feature `custom_domain` in PR 4:
   `{key:'custom_domain', title:'Custom domain slot', icon:'bx-globe', kind:'count', max:10, requires:'premium',
   includedFor: u => u.is_admin == 1, ready: () => domainsAvailable() && settings().slots, items:{custom_domain_x1:
   {units:1, price:150}}, href:'#settings'}`. It is never shown or sold while `slots` is off.
9. **For their Premium card**: `domains.capacity()` (4.10), so the card can say "Custom domains are fully booked right
   now" before anyone buys.
10. **Account age.** honeycomb-shop asked for a minimum account age before a domain can be added. This design uses
    `min_account_days` (default 30, admin setting). Their Premium items already require accounts that are 30 days old.

---

## 4. Server

### 4.1 Module layout (`app/src`)

```
domains/
  index.ts      – öffentliche Schnittstelle: hostRoute, reconcileUser (Enforcer), premiumLossPreview, beforePageRemoved,
                  onUserDeleted, hasDomain, domainForPage, hostnameForPage, capacity, health, registerDomainTarget
  targets.ts    – Registry der Zielarten (v1: 'page') und die gemeinsame /_/-Liste für eigene Domains
  hostname.ts   – Eingabe → ASCII/Unicode, Regeln, Schätzung "Wurzeldomain", Anzeige (rein, ohne I/O)
  store.ts      – Datenbank: Zeilen laden, Zustand per Compare-and-set wechseln (mit pages.custom_domain, Log, Glocke)
  host.ts       – Anfragen auf eigenen Domains (Seite, Uploads des Besitzers, Weiterleitung, neutrale Seite, Prüfstelle)
  editor.ts     – Editor-API (domain, domain-add, domain-check, domain-remove, domain-settings) – ohne Netzwerk,
                  einzige Ausnahme: eine TXT-Abfrage bei "claim"
  admin.ts      – Admin-Bereich (Ansicht + Aktionen) – ohne Netzwerk
  settings.ts   – oys_meta 'custom_domains' lesen/speichern (mit Grenzen)
  notify.ts     – Glocke (notify() von custom-dialogs mit db) und Mail-Einträge im Log
  worker/       – läuft nur im Dienst onyoursite-domains
    worker.ts     – Schleife, Einzelinstanz-Sperre, Nebenläufigkeit, Minuten- und Tagesaufgaben
    cloudflare.ts – kleiner API-Client (fetch, Token aus dem systemd-Credential, Zeitlimits, 429/Retry-After)
    dns.ts        – DNS-over-HTTPS (TXT, CNAME, A/AAAA, SOA) über zwei Resolver
    cfips.ts      – Cloudflare-IP-Bereiche (GET /ips, täglich; eingebaute Liste als Rückfall) mit net.BlockList
    probe.ts      – Ende-zu-Ende-Prüfung über die Cloudflare-Kante (fester Ziel-IP, SNI = Domain)
    control.ts    – Selbsttest des eigenen Wegs und Schutzschalter bei Ausfällen
    checks.ts     – Beobachtungen sammeln → evaluate() (rein) → Cloudflare-Aktion → Zustand schreiben
    schedule.ts   – nächste Prüfzeit je Zustand und Alter (rein)
    mail.ts       – E-Mails aus dem Log senden
content/branding.ts – wirksames Branding (Premium des Besitzers, Bestandsschutz), Fußzeile mit festen Stilen, CSS-Hinweis
cli.ts            – `node dist/cli.js domains:worker` (Dienst) und `domains:check <hostname>` (Diagnose für Admins)
```

Changed shared files, each change minimal:
- `router.ts` (one branch), `web/ctx.ts` (`ctx.customDomain`), `helpers.ts`;
- `app/context.ts` (`isStaff`), `app/editorApi.ts`, `app/dashboard.ts`;
- `public/routes.ts`, `public/api.ts`;
- the Node ports of `render.php`, `share.php`, `pages.php`, `blocks.php`, `stats.php` and `routes_public.php`;
- `schema.ts`;
- `static/js/editor.js`, `static/css/editor.css`, `static/css/page.css` (footer hover, §4.4.1);
- the admin view and nav (through code-slots-admin's admin split).

### 4.2 Host routing (`router.ts`)

One new branch sits right after the deny list (`router.ts:40-44`) and **before** the upload handling (`:45-50`):

```ts
// Eigene Domains (Premium): nur wenn eingerichtet. Steht vor den Uploads, damit fremde Dateien nie
// unter einer Kunden-Domain erscheinen; die Sperrliste davor gilt auch hier.
if (domainsAvailable() && !isMainHost(ctx.host) && !ctx.host.endsWith('.' + baseHost())) return hostRoute(ctx);
```

`domainsAvailable()` reads only the config. On an install without the feature, unknown hosts keep today's 404 and
cost no database query (tested). The probe path `/_/domain-check` has no dot segment, so the deny list
(`static.ts:19`) never touches it.

`hostRoute(ctx)` (`domains/host.ts`):

1. `/static/…` except uploads, and `/robots.txt` → `serveStatic` as on every host (no database). Not found → neutral
   404.
2. `await ensureSchemaOnce()`. `host` = `ctx.host` without a trailing dot. Then
   `SELECT id, state, version, target_type, target_id, user_id, hostname, redirect FROM custom_domains WHERE hostname = ?`.
   - There is **no positive cache**: state and target are read fresh on every request. It is one lookup on a unique
     key, cheaper than the page load that follows.
   - Unknown hosts are cached per process for 10 s (at most 5,000 entries, cleared when full), which absorbs junk
     traffic from the catch-all.
   - With a row, `ctx.customDomain = {id, hostname, state, targetType, targetId, userId}` is set for every later step
     and handler.
3. No row, or state `verifying|failed|blocked|removing` → 404 neutral page (5.5) with `X-Robots-Tag: noindex`.
4. `GET|HEAD /_/domain-check` with state `pending|active|broken|suspended` → 200 `text/plain`, body
   `hmac('domain-check|' + hostname).slice(0, 32)`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`.
5. `/static/uploads/<name>` → served (`serveUpload`) only when the name matches `^[a-z]+_(\d+)_` and the number equals
   the row's `user_id`. Otherwise → neutral 404. A page can only reference its owner's uploads
   (`lib/blocks.php:60-73`), so nothing legitimate is lost.
6. The target is loaded through the registry (§4.12). For pages that is the page row. Missing, or `code_site_id` set
   (which E7 and `domain-add` prevent) → neutral 404.
7. State `suspended`: `sub = trim(lower(path), '/')`. If `sub` is `''` or `kalender`, 302 to `pageUrl(page, sub)` plus
   the raw query; otherwise 302 to `pageUrl(page)`. `Cache-Control: no-store`. `pageUrl` is the OnYourSite address
   here, because `custom_domain` is NULL.
8. `/_/…` → only the endpoints of the shared list `CUSTOM_HOST_ENDPOINTS` (§4.12). For pages these are `POST /_/v`,
   `POST /_/c`, `POST /_/unlock`, `/_/go/{id}`, `POST /_/contact`, `/_/og/{id}-{hash}.png`, and in PR 1b
   `/_/icon/{id}-{hash}.png`.
   - Each one only for ids of **this** page: the page id, or a block whose `page_id` is this page.
   - Everything else → neutral 404.
   - Because `ctx.customDomain` is set, the handlers render the neutral page instead of `views/404.php`, and redirect
     failed contact posts to `https://{host}/` instead of the main site. Always `X-Robots-Tag: noindex`, as on the
     other hosts.
9. `/api.php`, `/admin_impersonate.php`, `/admin_return.php`, `/track-click`, `/dashboard/…` and every app path of
   `APP_ROUTES` (`router.ts:32`) **except `/`** → 404 neutral page.
10. `sub = trim(lower(path), '/')`. `''` or `kalender` → `servePage(ctx, page, sub)` (the same function as on the
    subdomain, `index.php:40-64`). Anything else → 302 to `https://{host}/`. This holds for states
    `active|pending|broken`.
11. **Sessions**: none of these paths calls `Session.start`. A test asserts that no custom-host response carries
    `Set-Cookie`.

The redirects on the OnYourSite addresses get the same generalization (`public/routes.ts`, the ports of
`index.php:81-111`). The primary host is the custom domain if `page.custom_domain` is set and the domain's `redirect`
switch is on, otherwise today's `address_mode` rule:
- path profile on the main host: when the primary host is not the main host → 302 `pageUrl(page, sub) + ?query`;
- subdomain: another sub-path → 302 `pageUrl(page)` (unchanged rule). Otherwise, when the primary host is not this
  subdomain → 302 `pageUrl(page, sub) + ?query`.

These 302s also get `Cache-Control: no-store` when the target is a custom domain.

### 4.3 URL helpers and everything that follows from them

`helpers.ts` (`PageLike` gets `custom_domain?: unknown`):

```ts
// Live-Domain? Dann ist sie die Hauptadresse (Schema wie die Seite, lokal mit Test-Port)
const customUrl = (p: PageLike): string | null => {
  const h = phpStr(p.custom_domain ?? '');
  return h !== '' ? scheme() + '://' + h + configString('custom_domains.url_port', '') : null;
};
export function pageUrls(p: PageLike) {           // Reihenfolge: subdomain, path, (custom) – api.php
  const urls: Record<string, string> = { subdomain: …, path: … };   // wie bisher
  const c = customUrl(p); if (c) urls.custom = c;  // nur mit Domain: ohne bleibt die Ausgabe gleich
  return urls;
}
export function pageUrl(p, sub = '')  { const c = customUrl(p); const url = c ?? /* bisherige Wahl */; … }
export const pageOrigin = (p) => customUrl(p) ?? /* bisher */;
export function onPageHost(ctx, p)    { const h = phpStr(p.custom_domain ?? ''); if (h) return ctx.host === h; /* bisher */ }
```

Effects without further code, because every caller uses the helpers:
- canonical and `og:url` (`render.php:24,104,107`), share URL (`:91`);
- OG URL (`share.php:40`), the OG card address (`share.php:125`);
- `/_/go` origin redirect (`routes_public.php:144-146`), contact redirect (`:195`), relative block targets (`:48`),
  calendar URLs (`kalender.php:9,65`);
- API `url`/`urls` (`api.php:44,69-70`), editor payload `url`/`urls`/`og` (`pages.php:267-269`), page switcher
  (`dashboard.php:18`);
- admin list (`admin.php:418`), weekly report (`report.php:74`), message mail (`spam.php:107`).

Explicit changes:
- **Booking blocks** (`blocks.php:33-46`): `bookingIsInternal(data, page, extraHosts)`. The two callers
  (`pages.php:426`, `routes_public.php:38`) pass the page's domain hostname **in any state**
  (`domains.hostnameForPage(pageId)`, one indexed query, made only when a booking block has an absolute URL). The
  block save also stores `https://<the page's domain>/kalender` as `/kalender`, so the link survives a later removal.
  URLs with the OnYourSite addresses are saved as today. A calendar therefore keeps its key gate when the domain
  breaks, pauses or is removed.
- `stats.ts` `requestFromOwnSite(ctx)` (`lib/stats.php:24-33`) is also true when the origin/referer host **equals
  `ctx.host`** and `ctx.customDomain` is set. Same-origin beacons from the domain count; other foreign origins stay
  rejected. On custom hosts the beacons only accept this page's ids anyway (4.2 step 8).
- `share.ts` `ogHash(page)`: the input list stays the same, so hashes of pages without a domain do not change. It uses
  the **effective** branding value (§4.4) and, when `custom_domain` is set, appends it as the last element.

### 4.4 Branding (`content/branding.ts`)

```ts
// Fußzeile und OG-Zeichen ausgeblendet? Gespeicherter Schalter UND (Premium des Besitzers ODER Bestandsschutz)
export const footerHidden = (s: PageSettings, ownerPremium: boolean): boolean =>
  phpTruthy(s.hide_branding) && (ownerPremium || phpTruthy(s.branding_legacy));
// Nur nach Q7 (PR 1b): Titelzusatz, og:image:alt und Favicon – nur mit Premium, nicht mit Bestandsschutz
export const fullyUnbranded = (s: PageSettings, ownerPremium: boolean): boolean =>
  BRANDING_FULL && phpTruthy(s.hide_branding) && ownerPremium;
// Premium des Besitzers – nur abgefragt, wenn der Schalter an ist (sonst ändert sich nichts)
export async function ownerPremium(page: PageRow, db?: Db): Promise<boolean>;   // isPremiumRow(users-Zeile)
```

- `renderPage(page, blocks, opts)` gets `opts.branding = {footerHidden, fullyUnbranded}`, computed by the callers:
  - public serve: owner from `page.user_id`; one primary-key query, made only when `hide_branding` is stored true;
  - editor preview/save: the page's owner;
  - demo: nothing hidden.
- PR 1 (today's scope, on the effective value):
  - the footer is left out (`render.php:165-167`);
  - the OG card mark is left out (`share.php:157-161`). `/_/og/{id}-{hash}` looks up the owner, so the hash and the
    picture follow the effective value;
  - API `hide_branding` (`api.php:73`) = the effective value.
- PR 1b, only if the owner says yes to Q7, and only with `fullyUnbranded` (Premium, not legacy):
  - the default title is `seo.title || (title || slug)`, without ` | OnYourSite` (`render.php:22`);
  - `og:image:alt` is just the share title (`:110`);
  - the favicon becomes `/_/icon/{id}-{hash}.png` (`:117`). That is a 64 × 64 PNG made with `sharp` (already a
    dependency) from the avatar, a centre crop, cached on disk next to the OG images, with
    `Cache-Control: public, max-age=31536000, immutable`. The hash is `sha1('icon-1|' + avatar).slice(0, 12)`. Without
    an avatar, or if `sharp` fails, it stays `/static/images/favicon.png`. So the tag keeps `type="image/png"`
    truthfully.
- Editor flags (`lib/routes_app.php:197` and its uses):
  - `app/context.ts`: `hasPremium()` is renamed **`isStaff()`** with the same logic (`is_admin || original_admin_id`);
    honeycomb-shop asks for exactly this (their §4.4).
  - `canEditBranding = isPremiumRow(user) || isStaff(ctx, user)`, used by `save` and `preview`
    (`lib/routes_app.php:381,413`).
  - Upload quota (`:333`) and slug cooldown (`:433`, `views/dashboard.php:35`) → `isStaff`.
  - Page limit (`:349`) → code-slots-admin's `pageAllowance()`. Until it ships, → `isStaff`. Both behave as today.
  - `E.premium` = `isPremiumRow(user)`, `E.staff` = `isStaff(…)`. `editor.js:2768` (cooldown) uses `E.staff`, and
    `editor.js:593,694,2716` (page limit) use `E.pagesUnlimited` from code-slots-admin (or `E.staff` until it ships).
    The branding switch (`:2733-2734`) uses `E.premium || E.staff`.

#### 4.4.1 Custom CSS cannot simply remove the note

Custom CSS is free today and stays free: honeycomb-shop's non-goal "nothing that is free today becomes paid" (their
§1.4). Instead:

1. **Pinned footer.** When the footer is shown, `<footer class="oys-foot">` and its link carry inline `!important`
   declarations for the properties that hide or shrink it:
   - on the footer: `display:block`, `visibility:visible`, `opacity:1`, `position:relative`, `z-index:2147483647`,
     `transform:none`, `clip-path:none`, `filter:none`, `height:auto`, `max-height:none`, `overflow:visible`,
     `content-visibility:visible`, `font-size:max(.78em,11px)`;
   - on the link: `display:inline-block`, `visibility:visible`, `opacity:.75`, `position:static`, `transform:none`,
     `filter:none`, `clip-path:none`, `font-size:max(1em,11px)`;
   - on `<strong>`: `display:inline`, `visibility:visible`.

   Inline declarations beat every stylesheet rule, `!important` and cascade layers included, because the cascade
   compares element-attached styles before layers and specificity. The sizes equal today's computed values, so honest
   pages look the same. Only the hover effect moves from `opacity` to `text-decoration: underline` in `page.css:204`,
   because the pinned opacity would override `:hover`.
2. **Warning on save.** `cssTouchesBranding(css)` runs on the sanitized CSS (comments removed, identifier escapes
   resolved by the sanitizer). It looks for selectors that contain `oys-foot`, the type selector `footer`,
   `:last-child`/`:last-of-type`/`:nth-last-*` on children of `.oys-main`/`main`, or attribute selectors with
   `on-your`/`onyoursite`. When it matches and the footer would be shown, `save` still succeeds and adds
   `cssWarning: "Your custom CSS targets the “Made with OnYourSite” note. Hiding it is part of Premium, so it stays
   visible."`.
3. **Terms** (5.6): hiding or covering the note without Premium is not allowed. Admins can remove the CSS through
   "Log in as user".

Remaining risk, stated openly: arbitrary CSS can still cover the note with an overlay, clip it through an ancestor or
make its text transparent. The text colour cannot be pinned without breaking the themes. This is not a security
boundary, so the terms handle it; the warning in step 2 already catches every rule that names the footer. The stricter alternative, custom CSS only with Premium, is
Q9.

### 4.5 Editor API (`/dashboard/api/{action}`, `domains/editor.ts`)

The existing preamble (`lib/routes_app.php:214-243`) applies to all of them:
- logged in, else 401;
- a POST needs `X-CSRF-Token`, else 419;
- a JSON body, else 400;
- `page_id` must belong to the user, else 409 `reload`.

Only link pages are a valid target (`target_type='page'`, `code_site_id IS NULL`). None of these routes calls Cloudflare
or probes. The only network call in the website process is one DoH TXT lookup for a `claim` (below). It runs with no
database connection held, at most 2 at a time per process, with a 4 s timeout.

#### 4.5.1 Shapes

```ts
interface DomainView {
  hostname: string;            // ASCII, z. B. "links.example.com" / "xn--bcher-kva.de"
  display: string;             // Unicode für die Anzeige ("bücher.de")
  state: 'verifying'|'pending'|'active'|'broken'|'suspended'|'failed'|'blocked'|'removing';
  primary: boolean;            // gerade Hauptadresse
  redirect: boolean;           // OnYourSite-Adressen leiten um
  url: string;                 // "https://links.example.com"
  apex: boolean;
  steps: { ownership: Step; dns: Step; https: Step };   // Step = 'done'|'waiting'|'problem'|'unchecked'
  records: DnsRecordView[];    // immer TXT + CNAME (Apex: Host "@" mit Hinweis)
  extra: DnsRecordView[];      // Zusatz-Einträge von Cloudflare, nur wenn nötig (Apex, hängt fest)
  problem: string;             // Code aus 3.1 ('' = keiner)
  message: string;             // fertiger englischer Text (Tabelle 2.4)
  checking: boolean;           // "Jetzt prüfen" angefordert, der Dienst hat noch nicht geantwortet
  checkedAt: string | null;    // 'Y-m-d H:i:s'
  fastUntil: string | null;    // bis dann fragt der Editor regelmäßig nach (nur lesen)
  waiting: number | null;      // Platz in der Warteschlange (ausgebucht)
  graceUntil: string | null;   // nur 'suspended'
  blockedReason: string;
}
interface DnsRecordView {
  type: 'TXT'|'CNAME'; host: string; name: string; value: string;
  status: 'ok'|'missing'|'wrong'|'unknown'|'unchecked'; found: string; note: string;
}
```

#### 4.5.2 Routes

| Route | Input | Checks (in order) | Response |
|---|---|---|---|
| `GET domain?page=ID` | – | – | `{"ok":true,"available":true,"enabled":true,"premium":{"active":true,"until":"2026-12-31 10:00:00","forever":false},"target":"edge.on-your.site","limits":{"perUser":3,"used":1,"slots":null},"capacity":{"full":false,"waiting":0},"delayed":false,"domain":DomainView\|null}`. A pure database read; it never changes `fast_until` and never triggers a check. |
| `POST domain-add` | `{"page_id":12,"hostname":"links.example.com","apex_ok":false,"claim":false}` | See the numbered checks below the table. | Inserts the row (`verifying`, `state_at = created_at = now`, `next_check_at = now + 10 min`), log `added` → `{"ok":true,"domain":DomainView}`. A transfer answers the same way with U's row. |
| `POST domain-check` | `{"page_id":12}` | row exists → 404 `This page has no custom domain.`; `rateLimit('domain-check-user:'+uid, 60, 3600)` → 429; per domain at most one request per 30 s (`manual_at`) – otherwise the current view with `"cooldown":true` | `UPDATE custom_domains SET manual_at = NOW(), next_check_at = NOW(), fast_until = NOW() + INTERVAL 15 MINUTE, version = version + 1 WHERE id = ? AND version = ?` → `{"ok":true,"domain":DomainView}` with `checking: true`. The worker runs the check within seconds. A `failed` row is checked too (TXT), but its ages are not reset. |
| `POST domain-remove` | `{"page_id":12,"confirm":"links.example.com"}` | `confirm` equals the hostname (ASCII or Unicode form) → else 400 `To confirm, please type the domain.` | `removeDomain(row,'user')` → `{"ok":true,"records":[…records to delete…]}` |
| `POST domain-settings` | `{"page_id":12,"redirect":false}` | row exists → else 404 | `UPDATE … SET redirect = ?, version = version + 1 WHERE id = ? AND version = ?`, log `redirect` → `{"ok":true,"domain":DomainView}` |

Checks of `POST domain-add`, in order:
1. Feature available and switched on → else 404 `Custom domains aren’t available right now.`
2. The page is a link page → else 409 `Custom domains work for link pages only.`
3. `isPremiumRow(owner)` → else 403 `{"ok":false,"premium":false,"error":"Custom domains are part of Premium."}`.
4. Premium has at least 7 days left, or is for good, or the owner is an admin → else 403 `Your Premium ends on Nov 30.
   Extend it to connect a domain.`
5. The account is at least `min_account_days` old (not for staff, and not when `premiumState.source` is `admin` or
   `admin-role`) → else 403 `Custom domains are available once your account is 30 days old.`
6. `rateLimit('domain-add:'+uid, 10, 86400)` → else 429.
7. `normalizeHostname()` → else 400 with one of: `Please enter a domain, e.g. links.yourname.com.` ·
   `That doesn’t look like a valid domain.` · `Wildcard domains aren’t supported.` ·
   `Addresses on on-your.site can’t be used as a custom domain – choose them under Address above.`
8. The apex guess (2.3) and `!apex_ok` → 200 `{"ok":false,"confirm":"apex","suggest":"www.example.com","error":"…"}`.
9. The hostname belongs to another account and `claim` is true → the DoH TXT lookup (2.8), **before** any transaction.
   With `claim` false → 409 with the challenge.
10. One transaction under code-slots-admin's slot lock (`withSlotLock(uid)`; before they ship,
    `SELECT id FROM users WHERE id = ? FOR UPDATE` in the same transaction):
    - the page is still a link page;
    - the page has no row → else 409 `This page already has a domain. Remove it first.`;
    - per-user and slot allowance → else 409 (texts in 2.4; with slots on, `need: 'custom_domain'`);
    - the takeover rules (2.8), with a compare-and-set on the other row's `version` read before the lookup. A changed
      row → 409 `Please try again.`

The capacity (free hostname places) is **not** checked here. A verified domain waits in line instead (2.4, 4.8).

`page-delete` (`lib/routes_app.php:445-460`) calls `domains.beforePageRemoved(targetId)` before `deletePage`;
code-slots-admin keeps this call in their reworked `page-delete`. The dashboard payload gets:
- `E.domains = {available, enabled, target, perUser}`;
- `page.domain` (`DomainView | null`) in `pageForEditor`;
- `pages[].custom_domain` (boolean), which code-slots-admin uses for E7 in the editor.

### 4.6 Admin actions (`domains/admin.ts`)

The admin section follows the existing pattern (`views/admin.php` POST dispatch, map-admin §1.2): `POST /admin` with
`domain_action` + CSRF + `is_admin`, then a flash message and `302 /admin#domains`. If code-slots-admin moves sections
to their own routes, the same handlers mount there. No action calls Cloudflare; the worker does.

| `domain_action` | Input | Effect | Flash |
|---|---|---|---|
| `settings` | `enabled` (checkbox), `per_user`, `max_total`, `allow_paid` (checkbox), `grace_days`, `pending_days`, `min_account_days`, `slots` (checkbox) | Clamped (3.2), `REPLACE INTO oys_meta` | `Custom domain settings saved.` |
| `test` | – | `custom_domains_req.test = now`. The worker refreshes the quota, the fallback origin and the Cloudflare IPs, and writes `custom_domains_state.test`. | `Test started – the result shows up here in a few seconds.` |
| `control` | – | `custom_domains_req.control = now`. The worker runs the control check at once, and the breaker closes if it passes. | `Checking the connection again.` |
| `check` | `domain_id` | Like the editor's `domain-check` (no rate limit) | `links.example.com: check started.` |
| `disable` | `domain_id`, `reason` (`cleanText`, 200) | CAS: state `blocked`, `blocked_reason`, `custom_domain` cleared, `next_check_at = now` (the worker deletes the hostname); log; user notified (bell + mail) | `links.example.com is disabled.` |
| `enable` | `domain_id` | `blocked` → `verifying` (immediate check) | `links.example.com is being reconnected.` |
| `remove` | `domain_id` | `removeDomain(row,'admin')` + user notified | `links.example.com was removed.` |

The admin "delete user" path (`views/admin.php:91-113`) calls `domains.onUserDeleted(id)` before the pages are deleted.
The admin role toggle (`views/admin.php:116-129`) marks the account for reconcile (honeycomb-shop §4.4), which runs
`reconcileUser`.

### 4.7 Ownership TXT, DNS checks and the probe

- **Ownership token**: `onyoursite-verify=` + `hmac('custom-domain|' + userId + '|' + hostname).slice(0, 32)`. It is
  deterministic and bound to the account and the hostname. No column is needed, another account cannot reuse it, and
  the same user can reconnect later with the same record. The record name is `_onyoursite.<hostname>`. Several
  accounts' values can sit in the same TXT record set. The lookup reads them all, which the takeover rule (2.8) uses.
- **DoH** (`worker/dns.ts`): `GET https://cloudflare-dns.com/dns-query?name=…&type=…` and
  `GET https://dns.google/resolve?…` with `accept: application/dns-json`, 4 s timeout each, both in parallel.
  - TXT values come quoted and can be split into several strings (`"a" "b"`); they are joined.
  - A record counts as **present** if either resolver shows it.
  - DNS counts as **wrong** only if both resolvers answered (`Status` 0 or 3) and neither matches.
  - `SERVFAIL` or a timeout counts as **unknown**. Unknown on both resolvers for 3 checks and at least 30 minutes is a
    definite failure (`dns_unknown`, 2.6), unless the breaker is open.
- **What is looked up, and when.**
  - While `verifying`, only `TXT _onyoursite.<host>` and the SOA of that same name are looked up, never the hostname
    itself. Looking up the hostname before its record exists would let resolvers cache "does not exist" for it, and
    resolvers that infer from that (RFC 8020, aggressive NSEC use per RFC 8198) could then also deny
    `_onyoursite.<host>` until the negative TTL runs out.
  - The first automatic lookup waits 10 minutes after adding, or until the user selects Check now.
  - From `pending` on, `CNAME`, `A` and `AAAA` of the hostname are checked too.
- **Zone and apex** (fills `zone_name` and `is_apex`, from which the relative "host" fields `links`,
  `_onyoursite.links` and `@` are computed). No public suffix list is needed.
  - The zone is the owner of the Authority SOA in the answer for `_onyoursite.<host>` (NXDOMAIN/NODATA). It is never
    taken from the hostname's own answer: when the CNAME already exists, that answer follows it into our zone.
  - If the answer contains a CNAME, or the SOA owner is not a suffix of the hostname, or it is the base domain or a name
    under it: walk the hostname's parent names with SOA queries until an Answer SOA is owned by that name. The base
    zone is never accepted.
  - `zone_name == hostname` → apex.
- **"Points to us"** (both resolvers answered):

  | Observation | Subdomain | Apex |
  |---|---|---|
  | The CNAME chain contains `cname_target` or ends under the base domain | ok | ok |
  | No CNAME; all A/AAAA in Cloudflare's ranges | `cname_proxied` (wrong) | ok (`cf_ips`) only if Cloudflare reports `status=active` **and** at least one address equals a current address of `cname_target`; otherwise `apex_ips` (wrong) |
  | No CNAME; other A/AAAA | `a_records` (wrong) | `a_records` (wrong) |
  | NXDOMAIN or NODATA | `cname_missing` (wrong) | `cname_missing` (wrong) |
  | CNAME to another name | `cname_wrong` | `cname_wrong` |

  For a root domain without a visible CNAME, the address check stays a heuristic: many Cloudflare zones share
  addresses. The editor therefore tells root-domain users: "If you move example.com away, remove it here first."
- **Edge probe** (`worker/probe.ts`):
  - Request: `GET https://<hostname>/_/domain-check` through `https.request` with a custom `lookup` that returns an IP
    of **our own** `cname_target`. That IP is resolved over DoH and must be inside Cloudflare's ranges
    (`net.BlockList`).
  - TLS: SNI and certificate check are against the custom hostname (Node default). Timeout 8 s. Redirects are not
    followed. At most 256 bytes are read.
  - It tries two edge IPs (v4 and v6 when available).
  - Through our edge our own hostname always wins (hostname priority), so the probe proves "our hostname, certificate
    and path work", never "the user's DNS points to us". The DNS check does that.

  | Result | When |
  |---|---|
  | `ok` | 200 and the body equals the HMAC |
  | `wrong` (definite) | TLS: certificate not valid for the hostname, or expired, or a handshake failure for this SNI (no certificate at the edge). HTTP: a 2xx, 3xx or 4xx response without `cf-mitigated` whose body is not the HMAC. That covers another service, and cloudflared's 404 for a missing catch-all, which hits every domain at once and so opens the breaker. |
  | `unknown` | connect errors, timeouts, any 5xx (Cloudflare 52x and 530/1033, our 502/503), 429, any response with `cf-mitigated` (Cloudflare challenge pages, Appendix A) |

  - The certificate's `valid_to` goes into `cert_expires_at`.
- **Control check and circuit breaker** (`worker/control.ts`), once a minute, before any downgrade:
  - both resolvers resolve `cname_target`;
  - `GET https://<base>/_/domain-check` through the same edge IP with SNI = the base host. On the main host this
    answers `hmac('domain-check|' + base).slice(0, 32)` after a `SELECT 1`, or 503.

  If the control fails, or more than 20 % of the active domains (and at least 3) had a definite failure within the
  last 10 minutes, `custom_domains_state.freeze` is set:
  - no downgrade and no hostname deletion because of DNS or probe results;
  - upgrades (`pending` → `active`) still happen;
  - one admin alert per 6 hours.

  The breaker closes automatically after a passing control and a failure rate below the threshold.
- **Evaluation** (`worker/checks.ts`, a pure function
  `evaluate(row, obs, settings, freeze, now) → {state, problem, cfAction, failCount, failSince, unknownCount,
  unknownSince, nextCheckAt, event}`):
  - `verifying`: TXT `ok` (U's value) → `cfAction: 'create'` when a place is free and the owner has no other
    `pending` row; otherwise problem `quota` / `waiting_own` and the row waits.
  - `pending` → `active` when all of these hold:
    - CF `status ∈ {active, active_redeploying}`;
    - `ssl.status = active`;
    - DNS `ok` (or `cf_ips` for an apex, as above);
    - probe `ok`.
  - `active` → `broken` after 2 definite failures at least 10 minutes apart (2.6). The causes "points elsewhere",
    "no record", `moved` and `deleted` also set `cfAction: 'delete'`. Unknown observations only bring the next check
    forward (+5 min).
  - The problem shown comes from CF `verification_errors` / `ssl.validation_errors` (a CAA message → `caa`) or from our
    own observations.

### 4.8 Cloudflare API (`worker/cloudflare.ts`)

- **Client** (only in the worker):
  - The token is read once at start from `$CREDENTIALS_DIRECTORY/cf_saas_token`.
  - `Authorization: Bearer <token>`, base `cloudflare.api_base`, JSON, 15 s timeout.
  - 429 → no calls until `Retry-After` has passed. 5xx or a network error → `CfUnavailable` (retried later). 4xx with
    `errors[]` → `CfError(code, message)`.
  - It never logs headers.
- **Calls and permission**: zone permission "SSL and Certificates" (Edit/Write for writes, Read for reads; Appendix B).
- **Create**:
  - Preconditions, re-read at the moment of creation:
    - the row is `verifying` with a confirmed TXT;
    - the owner has no other row in `pending`;
    - a free place (below);
    - fewer than 3 `cf_created` log rows for this domain in the last 24 h.
  - Before the POST, `GET …/custom_hostnames?hostname=h` adopts an existing hostname (log `cf_adopted`). This covers a
    timed-out earlier create, and is safe because ownership is already proven. A duplicate error on POST does the same.
  - Request: `POST /zones/{zone}/custom_hostnames` with
    `{"hostname":h,"ssl":{"method":"http","type":"dv","settings":{"min_tls_version":"1.2"}}}`. Certificate authority,
    wildcard and custom metadata are Enterprise-only and are not sent.
  - Right after a successful POST: `UPDATE custom_domains SET cf_id = ?, cf_created_at = NOW() WHERE id = ? AND cf_id
    IS NULL` and the log row `cf_created` with the `cf_id`, even if the state write that follows fails. If that UPDATE
    finds no row (removed meanwhile), the new hostname is deleted at once. Nothing can be left behind unnoticed, and
    the daily sweep catches the rest (2.10 A6).
  - The POST response may lack `validation_records`, so a GET follows 10 s later.
- **Free places** (checked before every create):
  - the count of rows with `cf_id IS NOT NULL` must be below `max_total`;
  - `GET …/custom_hostnames/quota` (cached 10 min): refuse when `used ≥ allocated && !allow_paid` or `used ≥ hard_cap`;
  - on refusal: problem `quota`; the row keeps waiting in `verified_at` order; the verification timeout is paused; one
    admin alert per day.
  - `domains.capacity()` = `{available, full, free, waiting}` from the same numbers.
- **Status**:
  - a GET per row for rows being set up or checked manually;
  - for `active` rows, the paged list (`GET …/custom_hostnames?per_page=1000&page=n`) every 10 minutes, one call for up
    to 1,000 hostnames;
  - a 404 on GET counts as `deleted`.
- **PATCH**:
  - a no-change PATCH with the same `ssl` object on a manual check for `pending`/`broken`, at most once per 5 minutes
    per domain (`patched_at`). The docs say this resets the validation backoff;
  - the TXT-DCV fallback for root domains (2.3): `{"ssl":{"method":"txt","type":"dv"}}`.
- **Delete**: `DELETE …/custom_hostnames/{id}`. It also revokes the certificates. A 404 counts as done. Log
  `cf_deleted` with the `cf_id`.
- **Budget**: at most 400 Cloudflare calls per 5 minutes, a third of the 1,200 per 5 minutes global limit.

### 4.9 The worker (`onyoursite-domains`, `worker/worker.ts`)

- **Process**: a long-running systemd service (8.2), `node dist/cli.js domains:worker`. It has its own small pool
  (`connectionLimit: 4`) plus one dedicated connection that holds `GET_LOCK('oys_domains_worker', 0)` for the life of
  the process. A second instance waits and retries every 30 s. If the lock connection drops, the process exits and
  systemd restarts it.
- **Loop** (every 5 s): due rows (`next_check_at <= NOW() ORDER BY next_check_at LIMIT 50`), up to **8 checks in
  parallel**. A check never holds a database connection while it waits on the network:
  1. read the row (with `version`) and release the connection;
  2. DoH, Cloudflare and probe calls;
  3. `evaluate()`;
  4. the Cloudflare action;
  5. one short transaction: the compare-and-set state write (`… WHERE id = ? AND version = ?`), `pages.custom_domain`,
     the log row and the bell notification.

  A compare-and-set miss means the row changed meanwhile (remove, Premium, admin). The next round re-reads it; side
  effects at Cloudflare are covered by the `cf_id` rule of 4.8.
- **Every minute**:
  - the control check and the breaker (4.7);
  - the Premium safety net:

    ```sql
    -- Domains, deren Besitzer kein Premium mehr hat (Admins haben es immer)
    SELECT DISTINCT d.user_id FROM custom_domains d JOIN users u ON u.id = d.user_id
     WHERE d.state IN ('verifying','pending','active','broken') AND NOT (u.is_admin = 1 OR u.premium_until > NOW());
    -- Pausierte Domains, deren Besitzer Premium wieder hat
    SELECT DISTINCT d.user_id FROM custom_domains d JOIN users u ON u.id = d.user_id
     WHERE d.state = 'suspended' AND (u.is_admin = 1 OR u.premium_until > NOW());
    ```

    → `reconcileUser(uid)` for each;
  - timeouts and deletions that are due (by state, `state_at`, `created_at`, `cf_created_at`, `suspended_at`):
    - `verifying` 7 days after `created_at` without TXT (not while it waits for a place) → `failed(verify_timeout)`;
    - `pending` `pending_days` after `cf_created_at` → delete the hostname → `failed(setup_timeout)`;
    - `broken` for 7 days → delete the hostname → `failed(broken_timeout)`;
    - `suspended` past `grace_days` → delete the hostname;
    - `blocked` with a hostname → delete it;
    - `removing` → retry the delete;
  - the waiting line (oldest `verified_at` first) when places are free;
  - up to 20 emails from the log (`mail = 1 AND mailed_at IS NULL`, at most 5 tries);
  - `custom_domains_req` (test, control), and `custom_domains_state.worker_at`.
- **Every 10 minutes**: Cloudflare status of all `active` rows from the paged list.
- **Once a day** (first loop after 04:30 local time, `daily_at`):
  - refresh the Cloudflare IPs (`GET /ips`, public);
  - quota and fallback origin snapshot; quota alerts at 80 % and 100 %;
  - **orphan sweep**: page through all hostnames. Delete those whose id appears in a `cf_created`/`cf_adopted` log row
    but in no `custom_domains` row; list the others as unmanaged;
  - prune log rows older than 90 days, except `cf_created`/`cf_adopted` rows whose `cf_id` has no `cf_deleted` row;
  - delete `failed` rows 30 days and hostname-less `suspended` rows 90 days after their state change.
- **`schedule.ts`** (from the state age, `fast_until` and `manual_at`):

  | State | Schedule |
  |---|---|
  | `verifying` | first 10 min after adding (or at once on Check now); then 15, 20, 30, 45 and 60 min after adding, hourly up to 24 h, every 6 h until 7 days; every minute while `fast_until` lies ahead |
  | `pending` | every minute while `fast_until` lies ahead; otherwise 5 min up to 1 h after creation, 15 min up to 24 h, hourly up to 3 days, every 6 h until `pending_days` |
  | `active` | DNS and probe every 10 min, offset by `id`; Cloudflare status from the 10-minute list |
  | `broken` | 5 min for the first hour, then 15 min; without a hostname: DNS only, every 15 min (a new hostname as soon as the CNAME is back) |
  | `suspended` | with a hostname: DNS every 6 h (moves) plus the 10-minute status list; without: daily |
  | `removing` | 1 min, doubling up to 1 h |
  | `failed`, `blocked` | only on request (Check again / admin) |

- **The server now has 16 vCPUs.** The website may later run as several Node processes (plan §0 item 6 keeps one for
  now). Nothing here depends on per-process memory for correctness:
  - there is no positive host cache;
  - every write is a compare-and-set;
  - all network work runs in the one worker process.

  Web processes never wait on Cloudflare, DoH or a probe while holding a pool connection, so slow checks cannot use up
  the pool (`db.ts:74`). Connections: web processes × 10 + this worker's 5 + status-pages' worker + the shared job
  runner (3) must stay below MariaDB's `max_connections` (151 by default). The Discord bot uses no database
  connection.

### 4.10 Hooks for other modules (`domains/index.ts`)

| Hook | Caller | Does |
|---|---|---|
| `reconcileUser(uid)` | honeycomb-shop's enforcer registry after every Premium or domain-slot change and from their job; this worker's minute check | Under `GET_LOCK('oys_domains_u<uid>', 5)` (honeycomb-shop: "its own per-user lock"), in this order: read the user's rows, then the user (`isPremiumRow`, slots), then compare-and-set suspend or resume. The allowance is `per_user`, with slots on also `quantity(uid,'custom_domain')`; the oldest domains keep their place. Database only, so `inline: true`. |
| `premiumLossPreview(uid, db)` | honeycomb-shop (`registerLossPreview('premium', …)`) for reminders and for the end, revoke and refund notices | Lines such as "links.example.com will forward to mia.on-your.site for 30 days.", "links.example.com will be disconnected.", "“Made with OnYourSite” will be shown again on 2 pages." |
| `beforePageRemoved(pageId)` | user `page-delete` (code-slots-admin keeps the call), admin "delete user" | Same as Remove. It never blocks the deletion: if Cloudflare is down, the row stays `removing` and the worker retries. |
| `onUserDeleted(uid)` | admin "delete user" | `beforePageRemoved` for all of the user's targets. |
| `hasDomain(pageId, db)` | code-slots-admin E7, inside their slot lock | True when a row exists in any state. |
| `hostnameForPage(pageId)` | booking internal check (4.3) | The hostname in any state, or null. |
| `domainForPage(pageId)` | editor payload, admin user list | Row → `DomainView`. |
| `capacity()` | honeycomb-shop's Premium card, editor | `{available, full, free, waiting}` |
| `health()` | status-pages (`domains` and `job:domains` components), admin | `{configured, activeDomains, workerAt, workerOk, probeOkAt, frozen, reason}` – ok when the worker was seen in the last 3 minutes and, if any domain is live, `probe_ok_at` is less than 20 minutes old. |
| `registerDomainTarget(type, adapter)` | status-pages (follow-up) | §4.12 |

### 4.11 Notifications and emails

- **Bell** through custom-dialogs' `notify(userId, type, title, body, link, {db})`, written **in the same transaction**
  as the state change. That makes every notice exactly-once, because custom-dialogs no longer de-duplicates (their
  §5.2). The types `domain_live|domain_back|domain_problem|domain_paused|domain_removed` are already in their
  catalogue (PR 5a).
- **Link**: `/dashboard?page=<id>#settings/domain`. The query selects the page that owns the domain (`currentPage`,
  `lib/routes_app.php:603`). custom-dialogs' `openLink` navigates there, because the query differs from the current
  page's. The editor registers the deep-link target `settings/domain` (switch to Settings, scroll to `#domainSection`).

  | `type` | Title | Body | Email |
  |---|---|---|---|
  | `domain_live` | `Your domain is live` | `links.example.com now shows your page “Mia”.` | yes |
  | `domain_problem` | `Your domain needs attention` | `links.example.com doesn’t point to OnYourSite any more. Your page is shown at mia.on-your.site until it’s fixed.` | yes |
  | `domain_back` | `Your domain is back online` | `links.example.com works again.` | no |
  | `domain_paused` | `Your custom domain is paused` | `You’re no longer an admin, so links.example.com forwards to mia.on-your.site.` (only for a loss without an entitlement change, 2.7) | yes |
  | `domain_removed` | `Your custom domain was disconnected` | The reason: setup timeout, broken for 7 days, grace period over, disabled by the team (with reason), transferred to another account. | yes |

- **Flap guard**: `domain_problem` only when `notice_at` is NULL or more than 24 h old; it sets `notice_state = 1`.
  `domain_back` only when `notice_state = 1`; it resets it.
- **Email**: the transaction also writes the log row with `mail = 1`. The worker sends it after the commit through the
  ported mail module (the weekly-report layout), up to 5 tries. No SMTP call ever runs inside a web request or a
  transaction.
- **Admins**: `notifyAdmins('team', …)` plus email for the alerts of 2.10 A5, each at most once per day (per 6 hours
  for the breaker).

### 4.12 Target registry, status pages and the shared `/_/` list (`domains/targets.ts`)

```ts
// Zielart für eigene Domains (v1: 'page'; status-pages kann später 'status' anmelden)
export interface DomainTarget {
  type: string;                                              // ≤ 8 Zeichen (custom_domains.target_type)
  load(id: number, db?: Db): Promise<TargetInfo | null>;     // null = gibt es nicht (mehr) → neutrale 404
  serve(ctx: Ctx, t: TargetInfo, sub: string): Promise<void>;
  endpoints: EndpointRule[];                                 // zusätzliche /_/-Pfade auf der Domain
  fallbackUrl(t: TargetInfo, sub?: string): string;          // OnYourSite-Adresse (Weiterleitung bei Pause)
  setPrimary(db: Db, id: number, host: string | null): Promise<void>;   // in derselben Transaktion wie der Zustand
  ownerId(t: TargetInfo): number;
}
// Die eine Liste der /_/-Endpunkte auf eigenen Domains; die Kennung muss zum Ziel der Domain gehören
export const CUSTOM_HOST_ENDPOINTS: Record<string, EndpointRule[]> = {
  '*':  [{ method: 'GET', path: /^\/_\/domain-check$/ }],
  page: [
    { method: 'POST', path: /^\/_\/v$/,          owns: { page: 'p' } },
    { method: 'POST', path: /^\/_\/c$/,          owns: { block: 'b' } },
    { method: 'POST', path: /^\/_\/unlock$/,     owns: { block: 'b' } },
    { method: 'ANY',  path: /^\/_\/go\/(\d+)$/,  owns: { block: 1 } },
    { method: 'POST', path: /^\/_\/contact$/,    owns: { block: 'b' } },
    { method: 'GET',  path: /^\/_\/og\/(\d+)-[0-9a-f]{12}\.png$/,   owns: { page: 1 } },
    { method: 'GET',  path: /^\/_\/icon\/(\d+)-[0-9a-f]{12}\.png$/, owns: { page: 1 } },   // PR 1b
  ],
};
```

- v1 registers only `page`. Its `serve` is `servePage` and its `setPrimary` writes `pages.custom_domain`.
- **Status pages are not in v1.** status-pages agrees (their §1.3: "`custom_domains.target_type = 'status'` is the
  agreed follow-up"). Their settings form and limits table still list a "Custom domain" control; that control should
  wait for the follow-up. In that follow-up (their PR 7, only if the owner wants it, Q10) they register `status` with
  `serve = statusServe`, `fallbackUrl` = their page address, and `endpoints: []`. Their `/_/hb`, `/_/health` and
  `/_/status/*` are main-domain endpoints and are not needed on customer domains. The worker, state machine, limits,
  Premium lifecycle and editor component are shared.
- **Health signal for status-pages**: their `domains` system check should read `domains.health()` (a sensor, like their
  `origin` check) instead of `https://<fallback origin>/_/health`. That URL goes through the `*.<base>` tunnel rule
  and never exercises the catch-all that customer domains depend on. `probe_ok_at` comes from real customer-domain
  probes.

---

## 5. UI

All texts are English. The look is the existing one (Tailwind/Boxicons, `static/css/editor.css` components). Dialogs
and toasts use custom-dialogs' `OYSUI` (until their PR 2 lands, the editor's `toast()` and `openModal()`).

### 5.1 Editor → Settings → Address (`editor.js:2699-2706`, `modeCard` `:2810-2815`)

- When `state.page.domain.primary`, a third full-width card comes first, built from the `.mode-card` markup with the
  `on` class: label `Custom domain`, URL `links.example.com`, badge `bdg green` "Primary address". It is not
  clickable.
  - The two existing cards keep working (they choose the fallback address). Both show the badge "Redirects", or
    "Also shows your page" when the redirect switch is off.
  - The section subtitle changes to "Your custom domain is primary – both OnYourSite addresses redirect to it".
- Otherwise the section is unchanged.

### 5.2 Editor → Settings → Custom domain (new section)

The section sits between "Address" and "Your pages". It is a
`<section class="max-w-3xl mx-auto mt-8" id="domainSection">` with `<h2 class="section-title">Custom domain
<small>Show this page on your own domain</small></h2>`, and the content in a `.panel`. A separate `renderDomain()`
re-renders only this section (polling).

- **Teaser (no Premium)**: `bx bx-globe` icon (32 px, `text-white/80`), text "Use your own domain, like
  links.yourname.com, for this page.", hint "Included in Premium", button `btn-primary` "Get Premium"
  (`openShop('premium')`). With slots on and Premium but no free slot: "Get a domain slot" (`openShop('custom_domain')`).
- **Form**:
  - Label `lbl` "Your domain".
  - `input-group`: `addon left` "https://" + `input.field` (placeholder `links.yourname.com`, `autocomplete="off"`,
    `inputmode="url"`, `maxlength=253`) + `btn-primary` "Connect domain" with `bx bx-link`.
  - Hint "Use a domain you own. You’ll get two DNS records to add at your domain provider."
- **Claim box** (409 with `challenge`): the TXT record row with copy buttons, the text from 2.4 and a `btn-primary`
  "I’ve added it" (sends `claim:true`).
- **Status header** (all states with a row):
  - The domain in bold (`display`; with an IDN, the ASCII form in small text after it) and a badge:

    | State | Badge |
    |---|---|
    | `verifying` | `bdg amber` "Waiting for DNS" (with a place in line: "Waiting for a free place") |
    | `pending` | `bdg amber` "Setting up HTTPS" |
    | `active` | `bdg green` "Live" |
    | `broken` | `bdg red` "Not reachable" |
    | `suspended` | `bdg` "Paused" |
    | `failed` | `bdg red` "Couldn’t be verified" |
    | `blocked` | `bdg red` "Disabled by the team" |
    | `removing` | `bdg` "Removing…" |

  - Right side:
    - `btn-secondary` "Check now" (`bx bx-refresh`; spinner while `checking`; disabled with a countdown during the
      30-s cooldown; label "Check again" for `failed`);
    - `icon-btn danger` remove (`bx bx-trash`);
    - for `active`, `btn-ghost` "Open" (`bx bx-link-external`).
- **Checklist** (`verifying`, `pending`, `broken`): three rows `Ownership confirmed`, `Domain points to OnYourSite`,
  `Secure connection (HTTPS)`. Each has an icon: `bx-check-circle` (green), `bx-time-five` (amber),
  `bx-error-circle` (red) or `bx-circle` (grey, not checked yet). Below them `message` and "Checked 2 minutes ago"
  (`timeAgo`).
- **Records table** (`verifying`, `pending`, `broken`, `failed`; for `active` collapsed under a `<details>` "DNS
  records"):
  - Columns: Type · Name · Value · status icon.
  - Name and Value are monospace, with a copy button each (`btn-ghost` `bx bx-copy`, like the share dialog copy row
    `editor.js:2650`, through `S.copy`). Wrong values show "Found: …" in red below.
  - Notes under the table (`hint`):
    - "Name: some providers want only the part before your domain (shown), others the full name."
    - "Using Cloudflare DNS? Set the CNAME to “DNS only” (grey cloud)."
    - "Remove other records (A, AAAA) for this name first – a CNAME can’t share its name."
    - "Using CAA records? Allow letsencrypt.org, pki.goog and ssl.com."
    - "Keep the TXT record – it lets us switch your domain back on automatically after a break."
    - Root domains only: "If you move example.com away, remove it here first."
  - "Additional records" (from `extra`) appear under the same table with the note "Cloudflare needs these for root
    domains."
- **Live**: text "Your page is live at https://links.example.com. Your OnYourSite addresses, QR codes and shared links
  lead here." Below it a switch (`.switch`) "Forward my OnYourSite addresses to this domain" (`domain-settings`).
- **Suspended**: text with the grace date, buttons "Renew Premium" (`openShop('premium')`) and "Remove".
- **Blocked**: the reason, and only "Remove".
- **Checks delayed**: the amber line from 2.4 when `delayed`.
- **Polling**: after "Connect domain" or "Check now", the editor keeps the `fastUntil` from that answer and reads
  `GET domain`:
  - every 3 s while `checking` is true (at most 60 s);
  - then every 15 s until that `fastUntil`.

  Polling never extends `fastUntil` and never starts a check. It stops at once for `active`, `failed`, `blocked` and
  `suspended`, and while the tab is hidden (`visibilitychange`).
- **Dialogs** (custom-dialogs):
  - the apex question: `OYSUI.choice`, three options;
  - Remove: `OYSUI.prompt` with `match`, `normalize: 'host'` and `matchLabel` (2.8).
  - Toasts use `OYSUI.toast`: "Domain added – add the DNS records below.", "Domain removed.", and errors with tone
    `err`.
- **CSS** (`editor.css`, small): `.dns-table` (grid; stacked on phones below 640 px), `.check-steps`. It reuses
  `--e-*` tokens, `.bdg` (`:153-158`) and `.input-group` (`:78-83`).

### 5.3 Editor → Branding switch (`editor.js:2732-2734`)

- The title stays "Hide “Made with OnYourSite”". The hint stays "Removes the note at the bottom of your page." In PR 1b
  it becomes "Removes the note at the bottom of your page, “| OnYourSite” from the default page title and the
  OnYourSite mark on your preview image."
- The states B2–B4 (2.1) are rendered from `E.premium`, `E.premiumUntil`, `E.premiumForever`, `E.staff` and
  `page.settings.branding_legacy`. The pill is honeycomb-shop's (`data-action="honeycombs" data-feature="premium"`).
- A `cssWarning` in the save answer shows as an amber `hint` under the Custom CSS field and as a `warn` toast (B6).
- SEO title placeholder (`editor.js:2719`): after PR 1b and with hidden branding, "Default: Mia" instead of
  "Default: Mia | OnYourSite".

### 5.4 Admin → Custom domains (new section)

- **Navigation**: a new entry `domains` with `bx bx-globe` after the code pages entry. With today's markup this means
  `ADMIN_TABS.domains = ['Custom domains', 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400']`
  (`views/admin.php:624-634`) and a nav button like `views/admin.php:319-322`. The admin split by code-slots-admin
  decides where exactly it goes.
- **Layout**: `max-w-5xl mx-auto space-y-8`, cards and classes as in `views/admin_honeycombs.php:21-23,37-128`.
  1. **Setup** card (`bx bx-server`): a list of status rows (green/amber/red dot):
     - Cloudflare token (last test by the worker);
     - Fallback origin (`origin.on-your.site` · active);
     - Customers point to (`edge.on-your.site` + copy);
     - Tunnel catch-all (ok since the last successful probe / not tested yet);
     - Worker ("running – last seen 20 seconds ago" / red after 3 minutes, with `journalctl -u onyoursite-domains`);
     - Checks ("running" / "paused: our own site didn’t answer through Cloudflare at 20:14" with the button "Check
       again now", `domain_action=control`);
     - Hostnames ("7 used · 100 included · hard cap 200 · 2 waiting");
     - Last job run.
     Button "Test connection" (`domain_action=test`). When the feature is not set up: "Run `sudo bash
     /var/www/onyoursite/server/install.sh --domains` on the server." plus a link to the Cloudflare docs.
  2. **Settings** card (`bx bx-slider-alt`):
     - switch "Let premium users connect new domains";
     - number fields "Domains per user" (0–10), "Domains in total" (0–50,000), "Days a paused domain keeps
       forwarding" (0–90), "Days to finish the setup" (1–7), "Minimum account age in days" (0–365);
     - checkbox "Allow paid hostnames beyond the free quota", with the hint "Cloudflare bills $0.10 per hostname and
       month above the 100 included.";
     - checkbox "Each domain needs a domain slot (sold in the shop)";
     - button "Save".
  3. **Domains** table card (`bx bx-globe`, count, `type=search` filter like `#hcFilter`). Rows `p-4 sm:px-6 flex …`:
     - domain link + state badge (`text-[10px] font-bold uppercase …`, colours as in 5.2);
     - second line `text-xs text-gray-500`: page `slug` · owner name (email) · `CF: active / SSL: active` · last
       error · place in line · added / live since / last check;
     - actions with `$btn`: "Check now", "Disable" (inline reason input, red, `data-confirm` through custom-dialogs'
       `confirmAttrs()`), "Enable", "Remove";
     - `<details>` "History" with the last 10 log entries.
  4. **Not managed here** card, only if any: hostname · status · created, plus the hint "Created by hand in Cloudflare.
     Delete them there if they’re not needed." Hostnames this app created are cleaned up automatically (2.10 A6).
- The admin user list (`views/admin.php:418`) shows the domain (through `pageUrl`) and a small globe badge for pages
  with a live domain.

### 5.5 Neutral page on custom hosts

- Built from `oys_render_simple` (`lib/render.php:547-563`; theme `deep-dark`, `noindex`).
- Title "Not connected". Body: `<div class="oys-card"><h1>Not connected</h1><p>This domain isn’t connected to a page
  right now.</p></div>`. Status 404. No link to OnYourSite and no favicon change.
- It is used for **every** "not found" on a custom host: unknown hosts, unconnected states, foreign uploads, foreign
  ids under `/_/`, unknown `/_/` paths and the app routes.

### 5.6 Legal texts (owner to confirm the wording)

- **Privacy** (`views/privacy.php`), new paragraph "Custom domains": "If you connect your own domain, we send the domain
  name to Cloudflare, Inc., which issues the HTTPS certificate and routes visitors to your page. To check your DNS
  records we ask public DNS resolvers (Cloudflare 1.1.1.1 and Google Public DNS). We store the domain, its status and
  a history of checks for as long as it is connected, and the history for up to 90 days."
- **Terms** (`views/terms.php`), new paragraph "Premium and custom domains":
  - "You may only connect domains you own or are allowed to use."
  - "We may disable a domain that is used for abuse."
  - "When Premium ends, your domain forwards to your OnYourSite address for 30 days (if it was live for at least 14
    days) and is then disconnected; your page stays online."
  - "If you remove a domain, links and QR codes that use it stop working."
  - "Without Premium, the “Made with OnYourSite” note must stay visible. Don’t hide or cover it, for example with
    custom CSS; we may remove such CSS."

---

## 6. Security, abuse and limits

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| **Domain takeover** through a dangling CNAME to `edge.on-your.site` (the old owner removed the domain but kept DNS) | Every claim needs the TXT bound to **that account** (HMAC of user id + hostname) before any Cloudflare hostname is created or any page is served. Cloudflare's own real-time CNAME validation is never enough. The neutral 404 serves nothing for unverified hostnames. |
| **Claim squatting** (someone adds `www.victim.com` to block the owner) | A claim without proof blocks nobody: the owner's fresh TXT proof takes over any row of another account in any state except `blocked`/`removing`, at any age (2.8). Ages count from `created_at` and are never reset. Stale rows are cleaned up (30/90 days). |
| A stale hostname in our zone keeps catching traffic after the user moved the domain (Cloudflare ranks a custom hostname above the customer's own DNS – Appendix A) | The DNS check is the move detector; the probe cannot see moves. As soon as the DNS definitely points elsewhere or Cloudflare reports `moved`/`deleted`, the hostname is deleted at once, in every state. Subdomains must show our CNAME ("DNS only"); Cloudflare addresses without it count as wrong. Root domains need Cloudflare `active` plus an address of our edge. Orphans this app created are deleted daily (log ids). On removal, setup timeout, 7 days broken and the end of the grace period the hostname goes too; `removing` retries until Cloudflare confirms. A domain change of the whole site deletes the old zone's hostnames (8.3). |
| Takeover of our own names | `edge` and `origin` are on the reserved list (`blacklist.php:88`). Custom names chosen at the installer prompt (`SAAS_TARGET`, `SAAS_ORIGIN`) are read from the config by `slugProblem` and refused as addresses. The installer refuses a name that is already taken (8.2). Hostnames on or under the base domain are rejected. |
| Session/cookie theft or fixation on custom hosts | Custom hosts never start a session. App routes, `api.php` and the impersonation entry points answer 404 there; there is no `Set-Cookie` (tested). Cookies stay host-only on the main domain (map-core §5.3). |
| **Another user's files or cards under a customer domain** | Uploads on a custom host only for the domain owner's id; `/_/` endpoints only for ids of the domain's page; every other request gets the neutral page (4.2). |
| **SSRF** through checks | No request ever goes to a user-chosen IP or host. DNS goes through fixed DoH endpoints. The probe connects only to IPs of our own `edge` record that are inside Cloudflare's ranges, with SNI/Host = the custom hostname. The Cloudflare API base is fixed (config only for tests). |
| Open redirect | Redirect targets come only from the DB (`pageUrl`, the verified hostname), never from the request. |
| Host header tricks | Custom hosts are matched exactly against verified rows; unknown hosts get the neutral 404. The https redirect stays on the same host, as today. Without the feature configured, the branch is never entered. |
| **Token leakage** | The token never enters the website process: it is a root-only file passed by systemd only to the worker (`LoadCredential`, 8.2). The worker runs in its own sandbox with its own dynamic user. It can read the config (database password) but nothing can read its credential except itself. The scope is one zone, but "SSL and Certificates Write" also covers e.g. `PATCH /ssl/universal/settings`, `DELETE /ssl/certificate_packs/{id}` and the paid `POST /ssl/certificate_packs/order` (Appendix A). So the containment matters. If the server has a fixed outbound address, the README recommends Cloudflare's "Client IP Address Filtering" on the token. The installer token with DNS/Tunnel rights stays root-only, as today. |
| **Pool exhaustion** (slow checks hold connections) | The website does no network checks at all. The worker never holds a connection during network I/O and runs at most 8 checks. The only network call in the website, the claim TXT lookup, holds no connection (§4.5). |
| **Our outages counted as user failures** | Only definite negatives count; 5xx, `cf-mitigated` and timeouts are unknown; a control check through the same edge and a 20 % breaker stop all downgrades during our own outages (4.7). Under Attack mode, Bot Fight Mode or a challenge rule on the probe path would keep domains from going live (unknown), so they must stay off for the zone or `/_/domain-check` must be exempt (8.1). |
| **Cost exhaustion / place squatting** (Cloudflare bills hostnames above 100; Premium is cheap) | `max_total` (100) plus the quota check before each create; `allow_paid` is off by default; per-user limit; at most one domain per user in `pending`; Premium must have 7 days left; accounts must be 30 days old (and Premium items already need that); a domain that was not live for 14 days loses its hostname at once when Premium ends; setups that fail release their hostname within 7 days; verified domains wait in line instead of failing; `capacity()` lets the shop say "fully booked"; admin alerts at 80 % and 100 %. |
| Cloudflare API rate limit (1,200/5 min) | At most 400 calls per 5 minutes; 429 stops calls (`Retry-After`); active rows use the paged list; the editor cannot cause Cloudflare calls (one PATCH per 5 min per domain on manual checks). |
| Premium abuse (buy, keep the domain) | Reconcile right after every change through honeycomb-shop's marker, plus the worker's minute check; after that the domain only forwards (if it was live for 14 days), then it is deleted. Branding is decided at render time. |
| Honeycomb double spend / refunds | Owned by honeycomb-shop; refunds and revokes mark the account for reconcile. |
| Races (Check now, job, remove, Premium change, double create) | Compare-and-set on `version` for every state write; unique `hostname` and `(target_type,target_id)`; one worker instance (`GET_LOCK`); `cf_id` written right after the create, and an orphaned create deleted at once; adopt-before-create at Cloudflare; the slot lock shared with code-slots-admin's conversions. |
| Phishing or abusive content on a domain | It is the same page content as on the subdomain (CSS sanitizer, no user JS on link pages). Admins can **Disable** with a reason. IDN domains are shown in both Unicode and ASCII forms. Hostnames are **not** run through the word filter (`forbidden_contains` would reject `something.com`, `grapes.io`, `torpedo.de` …); a domain is the user's own name, and the content is moderated as before. |
| Branding bypass with custom CSS | Pinned footer, save warning, terms (4.4.1); the remaining risk (covering overlays) is handled by the terms; Q9 offers the strict alternative. |
| Indexing of private areas | No private area exists on custom hosts. `/_/`, the probe and the neutral page are `noindex`. |
| CSRF / auth | Every state change: editor POST with `X-CSRF-Token` + ownership check through the preamble; admin POST with CSRF + `is_admin`. |
| Hostname input | `domainToASCII` (Node built-in), length and label rules, no IP literals, no reserved TLDs (`localhost local localdomain internal intranet lan home corp private test example invalid onion arpa alt`), no wildcard or underscore, no port or path (they are stripped, not trusted). |
| Several web processes (16 vCPUs) | No correctness depends on process memory (4.9). |

### 6.2 Limits

| Limit | Default | Where |
|---|---|---|
| Domains per link page | 1 | `uq_target` |
| Domains per user (staff exempt; with slots on also the owned slots) | 3 | `custom_domains.per_user`, `quantity(uid,'custom_domain')` |
| Domains in total (with a Cloudflare hostname) | 100 | `max_total`, plus the Cloudflare quota/hard cap |
| Domains per user in `pending` | 1 | worker (4.8) |
| Hostname creations per domain | 3 per 24 h | worker (log) |
| Premium left when adding | ≥ 7 days (or for good / admin) | `domain-add` |
| Account age when adding | 30 days (`min_account_days`; not for staff or admin-granted Premium) | `domain-add` |
| `domain-add` | 10 / 24 h per user | `rateLimit('domain-add:{uid}')` |
| `claim` lookups | inside the `domain-add` limit; at most 2 parallel per process | `domain-add` |
| `domain-check` | 1 / 30 s per domain, 60 / h per user | `manual_at`, `domain-check-user:{uid}` |
| Editor polling | reads only: 3 s for ≤ 60 s while checking, then 15 s until the `fastUntil` of the last action | editor |
| Setup | 7 days to verify (paused while waiting for a place), `pending_days` (≤ 7) to go live | worker |
| Broken | 7 days, then the hostname is deleted (at once if the domain points elsewhere) | worker |
| Paused domain forwards | 30 days (`grace_days`), only after ≥ 14 days live | reconcile/worker |
| Worker | 8 checks in parallel, 400 Cloudflare calls / 5 min | worker |
| Hostname | ≤ 253 chars, labels ≤ 63, 2–10 labels | `hostname.ts` |
| Log retention | 90 days (except unmatched `cf_created`/`cf_adopted`); `failed` rows 30 days; hostname-less `suspended` rows 90 days | worker (daily) |

---

## 7. Tests

### 7.1 Unit tests (`app/test/domains/*.test.ts`, `node --test`)

- `hostname.ts`:
  - valid inputs: subdomain, apex, IDN → punycode, uppercase, trailing dot, pasted `https://Links.Example.com/path?x`;
  - rejected inputs: IPv4/IPv6, `localhost`, `.test`, `*.x.com`, `_x.com`, base domain and `www.`/`mia.` under it,
    labels over 63 or the total over 253, `-a.com`, numeric TLD;
  - accepted despite filter words: `something.com`, `grapes.io`, `crisis.org`, `torpedo.de`, `glockenspiel.de`;
  - apex guess: `example.com`, `example.co.uk` yes; `links.example.com`, `www.example.com` no;
  - relative host fields (`links`, `_onyoursite.links`, `@`).
- The token is deterministic, differs per user and per hostname, and has the fixed prefix and length.
- `evaluate()` as a table test for all transitions in 2.11:
  - "unknown never flips" and two definite failures 10 minutes apart;
  - DNS unknown on both resolvers: no flip before 3 checks / 30 minutes, flip after;
  - "points elsewhere" → `broken` + `cfAction: 'delete'`; CNAME back → `create` (≤ 3 per 24 h);
  - breaker open → no downgrade, upgrades still happen;
  - Premium lost/back with and without `cf_id`; the 14-day rule at suspension;
  - timeouts measured from `created_at` / `cf_created_at`, not reset by a manual check; the verify timeout paused
    while waiting for a place;
  - one `pending` per user (`waiting_own`).
- "Points to us" (the table in 4.7):
  - subdomain with only Cloudflare addresses → `cname_proxied`;
  - apex with Cloudflare addresses without CF `active` → wrong; with `active` but none of our edge addresses → wrong;
    with both → `cf_ips`.
- Probe classification: 200 + body → ok; wrong cert host / expired → wrong; 200 other body → wrong; 404 without
  `cf-mitigated` → wrong; 403 + `cf-mitigated: challenge` → unknown; 502, 521, 530 → unknown; timeout → unknown.
- Circuit breaker: control fails → frozen; 3 of 10 live domains failing → frozen; recovery → closed.
- Zone detection: SOA in the Authority for `_onyoursite.links.example.com` → `example.com`; with a CNAME on the name
  (follows into `on-your.site`) → parent walk, never the base zone; apex.
- `schedule.ts`: the steps of 4.9; `GET`-only polling cannot move `next_check_at`.
- DoH parsing: quoted and split TXT, several values in one set, CNAME chains, SERVFAIL, NXDOMAIN. CIDR matching through
  `net.BlockList` (v4/v6 edges).
- Cloudflare response mapping: statuses → problems/messages, CAA texts, duplicate → adopt, quota, GET 404 → deleted,
  the TXT-DCV PATCH body.
- Takeover decision (pure): every row of the 2.8 table, including "both values present".
- Branding:
  - `footerHidden` / `fullyUnbranded` truth tables (premium × stored × legacy × Q7);
  - `settingsNormalize` legacy rules (premium on/off, free with legacy can only turn it off, the flag drops);
  - the OG hash uses the effective value; hashes of pages without a domain and with an unchanged effective value stay
    identical to before (regression vectors from PHP);
  - `cssTouchesBranding`: `.oys-foot{display:none}`, `footer{opacity:0}`, `.o\79s-foot{…}` (escape),
    `/**/.oys-foot`, `main>:last-child{…}`, `a[href*="on-your"]` → true; `.oys-name{…}` → false.
- `pageUrls/pageUrl/pageOrigin/onPageHost`: with and without `custom_domain`; the key order of `pageUrls` stays the
  same without a domain.
- The migration on a copy of the test DB:
  - tables, column and index are created idempotently;
  - `branding_legacy` is set only for non-admin owners without Premium who had `hide_branding: true`;
  - an owner with Premium for good is skipped;
  - running it again changes nothing.

### 7.2 HTTP tests

These run on a real server on random ports, with the Cloudflare mock and the DoH mock as `node:http` servers in
`app/test/support/`.

- **Probe path through `dispatch()`** (the regression for review finding 1): `makeTestCtx({url:'/_/domain-check', host:
  'links.example.com'})`. Expected:
  - 200 + HMAC for `pending`, `active`, `broken` and `suspended`;
  - neutral 404 for `verifying`, `failed`, `blocked`, `removing` and unknown hosts;
  - never 403;
  - on the main host, the control answer, and 503 with the pool closed.
- **Custom host routing** for every state and the paths in 4.2:
  - `/`, `/kalender`, `/kalender?k=`, `/x` → 302;
  - `/_/v` from the custom origin counts a view, a foreign origin does not, another page's id does not;
  - `/_/go/N` gate for this page's block; another page's block → neutral 404;
  - `/_/contact` redirect back to the domain; failure without JSON → back to the domain, not the main site;
  - `/_/og/…` (the hash with the domain); another page's OG card → neutral 404;
  - `/static/uploads/avatar_<owner>_x.webp` → 200; `/static/uploads/file_<other>_x.pdf` → neutral 404;
  - `/_/bot/ping`, `/_/cron/weekly-report`, `/api.php`, `/admin_impersonate.php`, `/login`, `/dashboard` → neutral
    404;
  - no response has `Set-Cookie`;
  - suspended → 302 to the subdomain/path address with the query;
  - unknown host → neutral 404.
- **Feature not configured**: an unknown host gets today's 404 and the request runs **no** query (query counter on the
  test pool).
- **OnYourSite addresses with a live domain**: subdomain and path → 302 + `no-store` + query; `/kalender` kept;
  canonical/`og:url`/share URL/API `url` = the domain; API `urls.custom` present only then; with `redirect` off → 200
  and canonical = the domain.
- **Booking**: a block with `https://links.example.com/kalender` stays internal (protected calendar keeps its key gate)
  while the domain is `active`, `broken`, `suspended`, and after removal (the block was saved as `/kalender`).
- **Editor API**:
  - 401 without login, 419 without CSRF, 409 for a foreign page;
  - 403 without Premium; 403 with less than 7 days left; 403 for a young account (and none for admin-granted Premium);
    404 when the feature is off; 409 for a code slot;
  - 400 messages per invalid input; per-user limit; slots on without a slot (`need`); rate limits (429); apex confirm
    round-trip;
  - takeover cases: other account `active` without `claim` → 409 + challenge and **no** DoH request (mock counter);
    with `claim` and only U's value → transfer + notification for V; both values → 409; `blocked` → 409;
    `removing` → 409;
  - **polling termination** (review finding 9): 100 `GET domain` calls change nothing (`fast_until`, `next_check_at`,
    `version` unchanged; no Cloudflare or DoH request); `domain-check` twice within 30 s → `cooldown`; at most one
    PATCH per 5 minutes even with repeated manual checks;
  - **pool test** (review finding 8): pool size 10, the Cloudflare mock answers after 15 s. 10 parallel `domain-check`
    plus 20 page views: every page view answers in under 1 s;
  - the full happy path through the mocks (TXT → create → CF active → probe → `active`, `pages.custom_domain` set);
  - remove (CF delete called by the worker; on API failure → `removing`, the worker finishes it); a remove during an
    in-flight create leaves no hostname behind;
  - `page-delete` removes the domain first; code-slots-admin's conversion is refused while a domain exists (contract
    test with `hasDomain` under the slot lock).
- **Branding**: a free page whose custom CSS is `.oys-foot{display:none}` still renders the footer with the pinned
  styles, and its save answer contains `cssWarning`. A Premium page with the switch on renders no footer. A legacy page
  renders no footer and keeps the `| OnYourSite` title.
- **Worker** (in-process `tick()` against the mocks):
  - Premium expiry → `suspended` + `custom_domain` cleared; live ≥ 14 days → hostname kept, else deleted; renewal
    within grace → `pending` → `active` without a new create; after grace → delete;
  - **move-away** (review finding 5): the DNS mock switches the CNAME to `other.host` → after two checks `broken` and an
    immediate DELETE; `mia.on-your.site` stops redirecting; the CNAME back → a new hostname → `active`; an apex with
    Cloudflare addresses but CF `pending` → not ok;
  - `moved` while paused → immediate delete;
  - **outage** (review finding 6): the edge mock answers 530 for every domain and the control → no downgrade, breaker
    open, one admin alert; the control passes but 3 of 5 domains answer 404 → breaker open; recovery → closed;
  - DNS SERVFAIL on both resolvers for 35 minutes (4 checks) → `broken`; for 20 minutes → still `active`;
  - 429 stops Cloudflare calls; the global/quota cap and the waiting line (oldest first, timeout paused); orphan sweep
    deletes only ids found in the log;
  - notifications exactly once per transition (two worker runs on the same state write one bell row); the flap guard;
    mails sent once.
- **Admin**: CSRF and admin-only for every `domain_action`; settings clamping (`pending_days` 30 → 7);
  disable/enable/remove effects; test/control requests reach the worker; delete user removes the domains.
- **Probe**: a local HTTPS server with a test CA (`custom_domains.probe_ca`) as the "edge". Cases: correct body →
  `ok`; wrong cert host → `wrong`; 404 → `wrong`; 530 → `unknown`; `cf-mitigated` → `unknown`; timeout → `unknown`.

### 7.3 Playwright end-to-end

Setup: Chromium with `--host-resolver-rules="MAP links.example.com 127.0.0.1"`, test config `url_port`, the mocks, and
a **test edge**: a small `node:https` server with the test CA. It terminates TLS for any SNI and forwards to the app
with the Host header kept. `custom_domains.edge_ips` points the worker's probe at it, so the "Live" flow runs the real
probe.

1. A free user sees the locked branding switch and the domain teaser; "Get Premium" opens the shop on the Premium card.
2. An admin grants Premium (honeycomb-shop admin) → the user connects `links.example.com`: the records appear and copy
   works; "Check now" → the mock DoH serves the TXT → "Ownership confirmed" within seconds; the mock Cloudflare goes
   active → the badge turns "Live" without a page reload (polling); the Address section shows the custom card as
   primary.
3. Visiting `http://mia.oys.test:8080/` lands on `http://links.example.com:8080/` and shows the page; its canonical is
   the domain; view stats count. Switching "Forward my OnYourSite addresses" off → the subdomain shows the page.
4. The apex flow: the choice dialog offers `www.` → choosing it fills the input.
5. Premium expiry (worker run with the clock moved forward): the editor shows "Paused"; the domain redirects to the
   subdomain; the branding footer is back.
6. Remove through the custom dialog (type to confirm) → the page is back on its subdomain.
7. Admin: settings save, Check now, Disable with a reason → the user sees "Disabled by the team: …".
8. Takeover: a second user adds the same domain → challenge box → the mock DoH serves only the second user's value →
   "I’ve added it" → transferred; the first user gets the bell notification.
9. Mobile (390 px): the records table stacks and the copy buttons are reachable.

### 7.4 Installer tests (existing harness with `cf_mock.py`, extended)

- The mock gains:
  - `custom_hostnames` CRUD, `quota`, `fallback_origin` GET/PUT (statuses `pending_deployment → active`);
  - "SaaS not enabled", "missing permission" and `429` switches;
  - tunnel configurations with extra rules.
- Scenarios:
  - fresh `--domains`: DNS records with their own comments, fallback origin, ingress catch-all merged, config keys,
    credential file `0600 root`, worker unit with `LoadCredential`, Apache `ServerAlias *`;
  - `--update` twice: the second run reports "Everything is in place." and sends no PUT. A rule the admin added in the
    dashboard (`nas.$DOMAIN`) survives. A broken saved token gives one warning and **no prompt**;
  - `--tunnel` twice with `origin` in `mine`: the second run reports "Everything is in place." (no "+ DNS …" line, no
    question) and re-points `origin` when the tunnel is recreated;
  - a custom `SAAS_TARGET` that a page already uses → refused; `slugProblem` refuses it afterwards;
  - a token without SSL permission (clear message, nothing changed); SaaS not enabled (instructions);
  - `--reset` deletes the hostnames before dropping the DB;
  - a domain change deletes the old zone's hostnames and marks the rows `broken` (`target_changed`);
  - `--rollback` stops the worker; `--update` starts it again;
  - `CUSTOM_DOMAINS`, `SAAS_ORIGIN`, `SAAS_TARGET` survive `save_conf`.

---

## 8. Installer and operations

### 8.1 Prerequisites (shown by the installer and in `server/README.md`)

- The DNS of the domain is at Cloudflare, the Cloudflare tunnel is set up (`TUNNEL=yes`), and the Node version runs.
- **Cloudflare for SaaS is enabled** on the zone: Dashboard → the domain → SSL/TLS → Custom Hostnames → Enable. For
  non-Enterprise zones Cloudflare asks for a payment method. 100 hostnames are included; each further one costs
  $0.10/month (maximum 50,000). The docs describe this only for the dashboard, so the installer cannot do it.
- A **second API token for the website**: My Profile → API Tokens → Create Token → Create Custom Token, permission
  **Zone · SSL and Certificates · Edit** (API name "SSL and Certificates Write"), Zone Resources: Specific zone → the
  domain. If the server has a fixed outbound address, set "Client IP Address Filtering" to it. The installer token
  (Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit, Zone · Zone · Read; see `server/install.sh:894-898`) is
  unchanged and stays root-only. → Q5.
- **Keep challenges off the probe path**: "Under Attack" mode and Bot Fight Mode stay off for the zone, and no WAF or
  challenge rule may match `/_/domain-check`. Otherwise domains cannot go live; the admin card then says "Checks are
  blocked by a Cloudflare challenge".

### 8.2 `install.sh --domains` (new mode) and `step_domains`

`step_domains` is asked once in the normal run when `TUNNEL=yes` and `CUSTOM_DOMAINS` is unset.

1. Question: "Let premium users show their page on their own domain (Cloudflare for SaaS)? [y/N]" (the default is no).
   Then `cf_login` (the existing installer token, for DNS and the tunnel).
2. Prompt for the website token (hidden, same handling as `cf_login`, `server/install.sh:876-915`). Check it with
   `GET /zones/$ZONE_ID/custom_hostnames/quota`:
   - 403/9109 → "This token can’t manage custom hostnames – it needs Zone · SSL and Certificates · Edit for $DOMAIN.";
   - an error mentioning SaaS/entitlement → "Cloudflare for SaaS isn’t enabled for $DOMAIN yet: Cloudflare → $DOMAIN
     → SSL/TLS → Custom Hostnames → Enable (Cloudflare asks for a payment method; 100 domains are free, each further
     one $0.10 per month). Then run: sudo bash …/install.sh --domains".
   The token is sent to curl over stdin like `cf()` does (`:812-827`), never as an argument. It is stored as
   `/etc/onyoursite/cf-saas.token` (`root:root 0600`, written with `umask 077`), never in `config.json`.
3. Names: `SAAS_ORIGIN` (default `origin`) and `SAAS_TARGET` (default `edge`), changeable at the prompt. A name is
   refused if a page, code page or status page already uses it as its address (a DB query over `pages.slug`,
   `code_sites.slug`, and code-slots-admin's `site_addresses` when it exists). Both full names go into the config
   (`custom_domains.fallback_origin`, `custom_domains.cname_target`), so `slugProblem` keeps refusing them later.
4. Plan and confirm (same style as the tunnel plan, `:1168-1215`):
   - `+ DNS origin.$DOMAIN → the tunnel (fallback origin for custom domains)`: proxied CNAME to
     `$TUNNEL_ID.cfargotunnel.com`, comment `OnYourSite custom domains: fallback origin`;
   - `+ DNS edge.$DOMAIN → origin.$DOMAIN (customers point their CNAME here)`: proxied CNAME, comment
     `OnYourSite custom domains: customers point here`;
   - `* Fallback origin for custom hostnames: origin.$DOMAIN`;
   - `* Tunnel: names it doesn’t know go to the website (needed for custom domains)`.
   An existing `origin`/`edge` record with other content is shown as "replace", and the installer asks before
   replacing it.
5. Create the DNS records (batch, like `:1280-1291`).
6. `PUT /zones/$ZONE_ID/custom_hostnames/fallback_origin {"origin":"origin.$DOMAIN"}` with the website token, then
   poll the GET until `active` (up to 2 minutes; otherwise "pending_deployment – it usually takes a few minutes, the
   admin page shows the status").
7. **Tunnel ingress, merged.** One shared function `tunnel_rules_json` (used by `step_tunnel`, `step_domains` and
   `--update`) reads the current configuration (`GET …/cfd_tunnel/$TUNNEL_ID/configurations`):
   - it keeps every rule and every other key (e.g. rules the admin added in the dashboard);
   - it ensures the three hostname rules of this site, unchanged when present;
   - it replaces only the final catch-all: with `CUSTOM_DOMAINS=yes`, the same service and `originRequest` as the main
     rules (`https://127.0.0.1:443`, `originServerName: $DOMAIN`, `noTLSVerify: true`; Apache stays in front, plan
     item 5); otherwise `{"service":"http_status:404"}` as today.

   A PUT is sent only when the result differs. Today `step_tunnel` replaces the whole list (`:1237-1240`). The merge
   also stops it from dropping the admin's rules.
   - Cloudflare sends Host **and SNI = the custom hostname** to the fallback origin (Appendix A). cloudflared matches
     the ingress by hostname, so custom hostnames only reach the catch-all rule. The Host header arrives unchanged.
     cloudflared then connects to Apache with SNI `$DOMAIN` (`originServerName`) and the customer's Host.
   - Apache would answer a Host that matches no vhost from the `default.invalid` vhost, and with the SNI pointing
     elsewhere, with 421 (`SSLVHostSNIPolicy`, the CVE-2025-23048 fix in the Ubuntu changelog). So `write_apache` adds
     `ServerAlias *` to the `*:443` OnYourSite vhost when `CUSTOM_DOMAINS=yes`. SNI and Host then select the same
     vhost, and the app returns its neutral 404 for unknown hosts. In tunnel mode the web ports are closed to the
     outside (`server/install.sh:1438-1442`), so this opens nothing.
   - Local self-test: `curl -sk --resolve "$DOMAIN:443:127.0.0.1" -H "Host: oys-catchall-check.invalid"
     "https://$DOMAIN/"` must return the app's neutral 404 ("isn’t connected"), not Apache's or cloudflared's.
8. **`mine` in `step_tunnel`.** With `CUSTOM_DOMAINS=yes`, `mine` (`:1106`) is built as
   `[$DOMAIN, www.$DOMAIN, *.$DOMAIN] + [$SAAS_ORIGIN_FQDN]`. A recreated tunnel then re-points `origin` instead of
   deleting it as "dead" (`:1134-1136`).
   - The completeness check compares against the length of `mine`, not the hard-coded `!= 3` (`:1173`). Otherwise every
     `--tunnel` run would plan "+ DNS …" again and ask.
   - The plan line names the origin record too.
   - `posts` (`:1255-1257`) gives the origin record its own comment.
9. Write the app config (`cloudflare.zone_id`, `custom_domains.cname_target`, `custom_domains.fallback_origin`) with
   `jq` into `config.json` (atomic, `root:www-data 0640`, as the plan writes it). Restart the website.
10. **Worker unit** (written by a new function `write_domain_worker`, called next to `write_timers`, enabled with
    `--now`):

    ```ini
    # onyoursite-domains.service – written by server/install.sh
    [Unit]
    Description=OnYourSite custom domains (checks, Cloudflare, clean-up)
    After=network-online.target mariadb.service
    Wants=network-online.target

    [Service]
    Type=simple
    DynamicUser=yes
    SupplementaryGroups=www-data
    LoadCredential=cf_saas_token:/etc/onyoursite/cf-saas.token
    WorkingDirectory=$CODE/app
    Environment=NODE_ENV=production
    ExecStart=/usr/bin/node $CODE/app/dist/cli.js domains:worker
    Restart=always
    RestartSec=5
    NoNewPrivileges=true
    CapabilityBoundingSet=
    ProtectSystem=strict
    ProtectHome=true
    PrivateTmp=true
    PrivateDevices=true
    ProtectKernelTunables=true
    ProtectKernelModules=true
    ProtectControlGroups=true
    RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
    RestrictSUIDSGID=true
    LockPersonality=true
    MemoryMax=256M

    [Install]
    WantedBy=multi-user.target
    ```

    `SupplementaryGroups=www-data` lets it read `config.json` (`root:www-data 0640`). `ProtectSystem=strict` without
    `ReadWritePaths` leaves it nothing to write but the database. The credential is visible only to this service. The
    same pattern of a root-only secret handed over by systemd is what the tunnel unit already uses (`:935-960`).
11. `conf_set CUSTOM_DOMAINS yes`, `SAAS_ORIGIN`, `SAAS_TARGET`. Also **`save_conf` (`:114-127`) must write these
    keys**; it rewrites the whole file and would otherwise drop them on the next run.
12. Summary line: "Custom domains: on – customers point their CNAME to edge.$DOMAIN. Switch them on for users in the
    admin area (Custom domains)." The admin switch `enabled` defaults to off, so the owner decides when to open it.

### 8.3 Other modes

| Mode | Changes |
|---|---|
| `--update` (`:1802-1842`) | Today it makes no Cloudflare calls. With `CUSTOM_DOMAINS=yes`, a new non-interactive step "Custom domains":<br>• it reads the installer token from `cloudflare.env` **without prompting** (`cf_token_quiet`; a broken token gives one warning "The Cloudflare token in /etc/onyoursite/cloudflare.env doesn’t work any more – custom domains were not checked. Run --domains." and the step is skipped);<br>• it merges the ingress (8.2 step 7; PUT only on a difference);<br>• it ensures `origin`/`edge` exist and point correctly (warn, don't replace foreign content);<br>• it GETs the fallback origin and PUTs if it differs or is missing (website token from the credential file);<br>• it checks the website token (quota call); on 401/403 it warns "The custom-domain token no longer works – run --domains";<br>• it writes the worker unit and restarts it after the build;<br>• it fills in missing config keys.<br>Every failure is a warning; the update itself never stops because of this step. When `CUSTOM_DOMAINS` is unset and `TUNNEL=yes`: one hint line "New: premium users can show their page on their own domain – set it up with … --domains". |
| `--tunnel` / `step_tunnel` | `mine` and the merge as in 8.2 steps 7–8. |
| `--reset` (`:1863-1889`) | Before `DROP DATABASE`: `SELECT cf_id FROM custom_domains WHERE cf_id IS NOT NULL` → DELETE each with the website token, printing "Deleted N custom hostnames at Cloudflare." Failures give a warning that names Cloudflare → SSL/TLS → Custom Hostnames. `CUSTOM_DOMAINS`, the config keys and the credential stay. |
| Domain change (installer re-run with a new `DOMAIN`) | When the DB has domains:<br>• stop the worker;<br>• delete every hostname in the **old** zone with the old zone id and the saved token (a hostname left there would keep capturing the customer's domain, Appendix A);<br>• set the rows to `broken` with `cf_id = NULL`, `problem = 'target_changed'`, `pages.custom_domain = NULL`;<br>• warn "N custom domains pointed to edge.$OLD_DOMAIN. Their owners must change the CNAME to edge.$DOMAIN.";<br>• reset `CUSTOM_DOMAINS` to unset, so `--domains` runs for the new zone. The worker sends each owner one `domain_problem` notice with the new target, and reconnects each domain once its CNAME points to the new target (the TXT proofs stay valid). |
| `--rollback` (plan §5.6) | `systemctl disable --now onyoursite-domains`. PHP does not route custom hosts, so during a rollback they get the PHP 404, and the branding follows the stored switch. Nothing is lost; `--update` back to Node starts the worker again. |

### 8.4 Operations

- **Health**: the admin Setup card; `journalctl -u onyoursite-domains` (one summary line per minute when something
  happened: `domains: 12 checked, 1 live, 0 problems, 0 API errors`); `node dist/cli.js domains:check
  links.example.com` (prints every observation, without changing state); admin alerts (2.10 A5); status-pages'
  `domains`/`job:domains` components through `domains.health()`.
- **Cost**: within the 100 included hostnames, $0. Example: 250 domains = 150 × $0.10 = $15/month. That only happens
  after the owner turns on `allow_paid` and raises `max_total`.
- **Backups**: the tables are in the nightly DB backup. The token is not in the backup, like the installer token in
  `cloudflare.env` today (`server/backup.sh:37-39`). After a restore on a new server, run `--domains` again.
- **Firewall**: outbound HTTPS only (api.cloudflare.com, cloudflare-dns.com, dns.google). The ufw defaults allow it.
- **Docs**: `server/README.md` gets a "Custom domains (Premium)" section with the prerequisites, the token, `--domains`,
  costs and troubleshooting:
  - fallback origin pending;
  - CAA;
  - a user on Cloudflare DNS must use a grey-cloud CNAME;
  - apex providers;
  - challenges on the probe path (8.1);
  - "checks paused" (the breaker).

---

## 9. Delivery plan

Seven PRs in this order, after the Node port and the switch of the installer to Node:

| PR | Title | Content | Depends on |
|---|---|---|---|
| 1 | Premium status in the editor and branding | `hasPremium` → `isStaff` (all call sites, §4.4); `E.premium` = `isPremiumRow`, `E.staff`; `content/branding.ts` with the effective footer, OG mark and API flag; `settingsNormalize` legacy rules + migration step B (Premium owners skipped); pinned footer + `cssTouchesBranding` warning + `page.css` hover; `registerPerk` for branding (Premium becomes ready); tests. | honeycomb-shop HC-2 (`users.premium_until`, `isPremiumRow`, `registerPerk`) |
| 1b | Wider branding removal (only if Q7 = yes) | title suffix, `og:image:alt`, `/_/icon` favicon with `sharp`, for Premium pages only; editor hint and SEO placeholder. | 1 |
| 2 | Custom domain core: schema, hostnames, routing | Migration step A; `hostname.ts`, `store.ts` (compare-and-set), `targets.ts` (`page`), `host.ts`; the router branch (only when available, before uploads); uploads owner rule; `/_/` list with the same-page rule; neutral 404s; `/_/domain-check` incl. the main-host control answer; URL helpers; generalized redirects with the `redirect` switch; `requestFromOwnSite`; OG hash; booking internal check and save normalization; API `urls.custom`; reserved custom names in `slugProblem`. No Cloudflare (tests activate through `store`). | – (can be reviewed in parallel with 1) |
| 3 | The domain worker: Cloudflare, DNS, probe | `worker/*` (`cloudflare.ts`, `dns.ts`, `cfips.ts`, `probe.ts`, `control.ts`, `checks.ts`, `schedule.ts`, `mail.ts`, `worker.ts`), `notify.ts`, `settings.ts`, `cli.ts domains:worker`/`domains:check`; `registerEnforcer` (`reconcileUser`), `registerLossPreview`; mocks and the test edge; tests. | 2; honeycomb-shop HC-2 (enforcer registry); custom-dialogs 5a (`notify` with `db`) |
| 4 | Custom domain section in the editor | Editor API routes incl. `claim` and `domain-settings`; dashboard payload (`page.domain`, `pages[].custom_domain`, `E.domains`); `renderDomain()`, Address card, polling, CSS; `page-delete` hook; domain perk; optional `custom_domain` slot feature; deep link `settings/domain`; Playwright flows. | 1, 3; custom-dialogs PR 1 + 2 (`OYSUI.choice/prompt`); honeycomb-shop HC-4 (`openShop`); code-slots-admin's slot lock (or the fallback lock, §4.5.2) |
| 5 | Admin: custom domains | Admin section (setup with worker and breaker rows, settings, table, unmanaged), actions incl. `test`/`control` requests, delete-user hook, admin alerts. | 3, code-slots-admin admin split (navigation/section framework) |
| 6 | Installer: custom domains with Cloudflare for SaaS | `--domains`, `step_domains`, the credential file, `write_domain_worker`, `tunnel_rules_json` (merge), `mine` fix, Apache `ServerAlias *`, `save_conf` keys, the update/tunnel/reset/domain-change/rollback changes, README, privacy/terms text. | 3 (worker CLI), Node switch in the installer |

The feature stays invisible until PR 6 has run on the server and an admin switches `enabled` on. PR 1 can ship on its
own; it makes Premium ready, so honeycomb-shop can sell it once their lifecycle job (HC-7) exists.

**What I need from the other features**

- **honeycomb-shop**: §3.5 – in short:
  - `users.premium_until`, `isPremiumRow`, `premiumState`;
  - `registerEnforcer`, `registerLossPreview`, `registerPerk`, `registerFeature`;
  - `markReconcile` on the admin role toggle;
  - the loss-preview lines also in the end/revoke/refund notices;
  - `E.premiumUntil`/`E.premiumForever`;
  - `openShop` and the "Get Premium" pill;
  - showing `domains.capacity()` on the Premium card.
- **code-slots-admin**:
  - an admin section slot "Custom domains" in the new admin navigation;
  - E7: refuse converting or moving onto a page while `domains.hasDomain(pageId, db)` (any state), inside their slot
    lock;
  - export `withSlotLock` so `domain-add` takes the same lock;
  - keep calling `beforePageRemoved(pageId)` in `page-delete`;
  - `pageAllowance()`/`E.pagesUnlimited` for the page limit (staff only);
  - their `pages[].custom_domain` comes from this design's payload (PR 4).
- **custom-dialogs**:
  - `OYSUI.prompt` with `match`/`normalize: 'host'`/`matchLabel`, `OYSUI.choice`, `OYSUI.toast`, `confirmAttrs()`;
  - `notify(…, {db})`, `notifyAdmins`;
  - the `domain_*` catalogue rows;
  - a `DEEP_LINKS` target `settings/domain` that this design registers in PR 4.
- **status-pages**:
  - v1: no "Custom domain" control yet (their §1.3 already says so; the settings form and limits table should follow);
  - the `domains` system check reads `domains.health()` instead of the fallback origin URL;
  - the follow-up registers `status` through `registerDomainTarget` (§4.12, Q10).
- **discord-pages**: nothing.

---

## 10. Open questions for the owner

1. **Price of a domain.** Is a custom domain included in Premium, or does each domain need a domain slot bought with
   honeycombs on top? Both are built: it is the admin switch "Each domain needs a domain slot" plus a price in the
   catalogue. *Recommendation: included (one per link page, at most 3 per user); the limits and the free Cloudflare
   quota keep the cost at $0.*
2. **After Premium ends.** How long does a domain keep forwarding to the OnYourSite address before it is disconnected?
   *Recommendation: 30 days (admin setting), only for domains that were live for at least 14 days, with the shop's
   reminders 7, 3 and 1 day before.*
3. **Legacy hidden branding.** Pages that hide "Made with OnYourSite" today without Premium (from the old version or
   set by an admin): keep it, or show the branding again? *Recommendation: keep it (legacy flag), so nothing changes
   for existing pages; it disappears once the owner turns the switch off.*
4. **Root domains.** Allow `example.com` (works only with CNAME flattening/ALIAS/ANAME at the user's DNS provider and
   needs extra records), or only subdomains like `www.`/`links.`? *Recommendation: allow it with a clear warning and
   an offer to use `www.` instead.*
5. **Cloudflare tokens.** A second, narrow token for the website, held only by the domain worker, or reuse the
   installer token (DNS + Tunnel)? *Recommendation: a second token, so a website bug can never change DNS or the
   tunnel.*
6. **Paid hostnames.** Allow more than the 100 free custom hostnames ($0.10 per hostname per month)?
   *Recommendation: off for now; turn it on in the admin area when Premium sales cover it.*
7. **Branding scope.** Besides the footer and the OG mark, also remove "| OnYourSite" from the default page title and
   use the avatar as favicon (Premium pages only; this also changes admin pages)? *Recommendation: yes; the code-page
   "Hosted on OnYourSite" badge stays (report link).*
8. **What Premium does not include** (one answer for three designs: this Q8, code-slots-admin Q5 and honeycomb-shop's
   non-goal "Bought Premium never changes page slots, code page limits, the upload quota or the address cooldown").
   Should Premium also lift the page limit, the slug cooldown or the upload quota (today admin-only)?
   *Recommendation: no – they stay staff-only (`isStaff`); Premium means custom domains and no OnYourSite branding.*
9. **Hiding the note with custom CSS.** Free users can hide "Made with OnYourSite" with custom CSS today. Pinned
   styles, a warning and a terms rule, with covering tricks left to the terms; or custom CSS for Premium only?
   *Recommendation: pinned styles + warning + terms. Custom CSS stays free, as it is today.*
10. **Custom domains for status pages.** Add them later as a follow-up (the model is ready), or never?
    *Recommendation: a follow-up after link-page domains have run for a while.*

---

## Appendix A – Cloudflare facts used (verified 2026-11-01)

| Fact | Source (last updated) |
|---|---|
| Free/Pro/Business: **100 custom hostnames included, $0.10 per additional hostname, maximum 50,000**; Enterprise custom/unlimited. Enterprise-only: custom certificates, CSR, selectable CA, wildcard custom hostnames, mTLS, SNI rewrite; **apex proxying/BYOIP and custom metadata are paid Enterprise add-ons**. Custom origin is on all plans. | [Plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) (Aug 14, 2026) |
| Enabling: dashboard → Custom Hostnames → Enable; **non-Enterprise zones must enter payment information**. API enabling is not documented. | [Enable Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/enable/) (Apr 29, 2026) |
| The fallback origin must be a **proxied A/AAAA/CNAME** in the zone; set by the dashboard or `PUT …/fallback_origin`; ready when `active`; changing it is non-disruptive. A separate CNAME target (customers point to it) is recommended. "Do not configure a custom hostname which matches the zone name." The POST response may lack `validation_records`, so do a delayed GET. Ready = `status: active` + `ssl.status: active` + DNS pointing to the SaaS target. "By default, using an A record to point to the target is not a supported setup." | [Getting started](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/) (Jun 19, 2026) |
| Hostname ownership: pre-validation TXT `_cf-custom-hostname.<host>` or the HTTP token (not supported for O2O); **real-time validation happens automatically when the CNAME is added**; no-change PATCH resets the backoff. | [Hostname validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/) (Jun 19, 2026), [Pre-validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/pre-validation/) (Jun 20, 2026), [Real-time validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/realtime-validation/) (Apr 15, 2026) |
| Validation retries spread over **7 days (75 retries)**; then the hostname is deleted. `moved` = "not active after Pending for the entirety of the Validation Backoff Schedule" or "no longer points to the fallback origin"; **deleted after more than 7 days in `moved`**. The status page documents no periodic re-check of active hostnames – so this design detects moves with its own DNS checks. | [Backoff schedule](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/backoff-schedule/) (Jul 16, 2026), [Validation status](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/validation-status/) (Sep 8, 2026) |
| Error texts such as "Custom hostname does not CNAME to this zone." and "Zone does not have a fallback origin set." | [Error codes](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/error-codes/) (Apr 15, 2026) |
| DCV methods `http`/`txt`/`email` plus Delegated DCV. **Automatic HTTP DCV needs the hostname to point to the SaaS target**; CAA records must not block the CA. **Certificates are valid 90 days, renewal opens 30 days before expiry**, and HTTP renewal is automatic for non-wildcard, active, proxied hostnames pointing to the provider. Delegated DCV (`_acme-challenge` CNAME) auto-renews and must stay in place. | [Validate certificates](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/) (May 7, 2026), [HTTP](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/http/) (Oct 15, 2026), [TXT](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/txt/) (Oct 15, 2026), [Delegated DCV](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/delegated-dcv/) (May 5, 2026), [Renew](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/renew-certificates/) (Oct 15, 2026) |
| CAs for SaaS: Let's Encrypt, Google Trust Services, SSL.com; CAA values `letsencrypt.org`, `pki.goog; cansignhttpexchanges=yes`, `ssl.com`. | [Certificate authorities](https://developers.cloudflare.com/ssl/reference/certificate-authorities/) (Apr 16, 2026) |
| Apex: most providers can't put a CNAME at the root, so customers use a subdomain or CNAME flattening; A records need apex proxying (static IP prefixes, extra cost). | [Apex proxying](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/apex-proxying/) (Jun 10, 2026) |
| **Default fallback origin: "the Host header and SNI will both be the value of the original custom hostname."** | [Custom origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/custom-origin/) (Jun 19, 2026) |
| A fallback origin can be "a CNAME DNS record that points to a public hostname exposed by Cloudflare Tunnel". | [Reference architecture](https://developers.cloudflare.com/reference-architecture/design-guides/extending-cloudflares-benefits-to-saas-providers-end-customers/) (Oct 16, 2026) |
| cloudflared ingress must end with a catch-all rule; the default is `http_status:404`, but a catch-all can be a service. `originServerName`/`matchSNItoHost` control the SNI to the origin. | [Tunnel configuration file](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/), [Origin parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/) |
| O2O applies when the customer's own Cloudflare zone proxies the CNAME; the customer's zone settings apply first ("settings on the customer zone will override settings on the SaaS zone"). Pre-validation is not supported for O2O → we tell users to use a DNS-only CNAME. | [How O2O works](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/how-it-works/) (Jun 19, 2026), [Product compatibility](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/product-compatibility/) (Sep 8, 2026) |
| **Hostname priority** for an exact match: "1. New custom hostname (belonging to a SaaS provider) 2. Legacy custom hostname 3. DNS (belonging to the logical DNS zone)". To regain control, the customer asks the SaaS provider to delete the custom hostname. | [Certificate and hostname priority](https://developers.cloudflare.com/ssl/reference/certificate-and-hostname-priority/) (Apr 16, 2026) |
| Remove hostnames when a customer churns. If the DNS points away but the hostname stays, "the custom hostname will continue to route to your service". | [Remove custom hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/remove-custom-hostnames/) (Apr 15, 2026) |
| A challenged response carries the header `cf-mitigated: challenge` (the only documented value), whatever the challenge type; it is meant for detecting challenges in non-browser requests. | [Detect a challenge response](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/), [Cloudflare challenges](https://developers.cloudflare.com/waf/reference/cloudflare-challenges/) |
| API: **1,200 requests per 5 minutes per user**; 429 + `Retry-After`. | [API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) (Aug 25, 2026) |
| Token permission names: zone "SSL and Certificates Read" and "SSL and Certificates Edit" (also listed as "… Write"). | [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) (Oct 30, 2026) |
| In the API schema, the group "SSL and Certificates Write" covers 78 zone endpoints – besides custom hostnames also `PATCH /ssl/universal/settings`, `DELETE /ssl/certificate_packs/{id}`, `POST /ssl/certificate_packs/order` (paid packs), `PUT/DELETE …/custom_hostnames/fallback_origin` and custom certificates. List endpoint: `per_page` 5–1000. PATCH `ssl.method` ∈ `http`, `txt`, `email`; `ssl.dcv_delegation_records` is read-only in the response. | Cloudflare API schema `openapi.json` (`x-api-token-group`; copy fetched 2026-11-01 at `$S/cfdocs/oas/openapi.json`); [API reference – custom hostnames](https://developers.cloudflare.com/api/resources/custom_hostnames/methods/create/) |
| DoH JSON: `https://cloudflare-dns.com/dns-query` with `accept: application/dns-json`, fields `Status`, `Answer[name,type,TTL,data]`. | [DNS over HTTPS – JSON](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/) (May 5, 2026) |
| Endpoint shapes, status enums, `quota` (`allocated`/`used`/`exceeded`/`hard_cap`), `dcv_delegation_records`, per-endpoint token groups and plan availability (free/pro/business/enterprise). | Cloudflare API schema `openapi.json` (as above) |

## Appendix B – Cloudflare API calls

| Call | Used by | Body / query | Token group (OpenAPI) |
|---|---|---|---|
| `POST /zones/{zone}/custom_hostnames` | worker (create) | `{"hostname":h,"ssl":{"method":"http","type":"dv","settings":{"min_tls_version":"1.2"}}}` | SSL and Certificates Write |
| `GET /zones/{zone}/custom_hostnames/{id}` | worker (checks) | – | SSL and Certificates Read/Write |
| `GET /zones/{zone}/custom_hostnames?hostname={h}` | worker (adopt before create) | – | Read/Write |
| `GET /zones/{zone}/custom_hostnames?per_page=1000&page={n}` | worker (status of active rows every 10 min, daily orphan sweep) | – | Read/Write |
| `PATCH /zones/{zone}/custom_hostnames/{id}` | worker (manual check: no-change PATCH, ≤ 1 per 5 min; apex fallback: `ssl.method` → `txt`) | the same `ssl` object / `{"ssl":{"method":"txt","type":"dv"}}` | Write |
| `DELETE /zones/{zone}/custom_hostnames/{id}` | worker (remove, moves, timeouts, grace, orphans), installer `--reset` and domain change | – | Write |
| `GET /zones/{zone}/custom_hostnames/quota` | worker (place check, health), installer (token check) | – | Read/Write |
| `GET /zones/{zone}/custom_hostnames/fallback_origin` | worker (health), installer | – | Read/Write |
| `PUT /zones/{zone}/custom_hostnames/fallback_origin` | installer (website token) | `{"origin":"origin.<domain>"}` | Write |
| `GET /ips` | worker (daily Cloudflare ranges) | – | public |
| `POST /zones/{zone}/dns_records/batch`, `GET`/`PUT /accounts/{acc}/cfd_tunnel/{id}/configurations` | installer (installer token; existing calls; the PUT now merges) | `origin`/`edge` records; ingress with catch-all | DNS Write; Cloudflare Tunnel Write |

---

## Review changes

The review listed 24 findings: 2 blockers, 10 major, 12 minor. Every code claim was checked against the repository
before it was used:
- `app/src/router.ts:34-86` and `app/src/web/static.ts:19-25`;
- `app/src/db.ts:74,145-187`;
- `lib/pages.php:46-158`, `lib/render.php:22,110,117,123,165-167`, `lib/share.php:30-35,157-161`, `api.php:73`;
- `lib/blocks.php:33-73`, `lib/routes_public.php:11-237`, `lib/storage.php:60-84`, `lib/stats.php:24-33`;
- `static/js/editor.js:593,694,2716,2733-2768`, `views/dashboard.php:20,35`, `views/admin.php:91-129`;
- `server/install.sh:114-127,876-915,935-960,1095-1300,1802-1842`, `server/backup.sh:37-39`;
- `blacklist.php:15-99`.

Web claims were re-checked on 2026-11-01 (Appendix A, new rows: hostname priority, `moved`, `cf-mitigated`, token
group coverage).

The other designs were revised in parallel. This revision aligns with their versions of 2026-11-01 21:20
(honeycomb-shop, code-slots-admin, custom-dialogs, status-pages). The owner also noted that the server now has
16 vCPUs. That is reflected in §0, §4.9 and §6.1: no correctness depends on
process memory.

| # | Finding | Verdict | What changed |
|---|---|---|---|
| 1 | Probe endpoint under `/.well-known/` is denied (403) for every host | Confirmed (`static.ts:19`, `router.ts:40-44`) – fixed | Endpoint moved to `GET /_/domain-check` in the shared custom-host `/_/` list (§4.2 step 4, §4.12); the same path on the main host is the breaker's control (§4.7). HTTP test through `dispatch()` + `makeTestCtx` for every state (§7.2). |
| 2 | Premium contract contradicts honeycomb-shop and code-slots-admin | Confirmed for the versions reviewed – fixed by alignment, partly not by the proposed means (see below) | honeycomb-shop is the single owner. §3.5 now lists exactly what their revised design provides: `users.premium_until` written with the entitlement, `isPremiumRow`, `premiumState`, `registerEnforcer` (inline, own lock), `registerLossPreview`, `registerPerk` (PR 1 makes Premium ready), `E.premiumUntil`/`E.premiumForever`, `openShop` and their pill. `onPremiumChanged` → `reconcileUser` registered as enforcer. One staff function (`isStaff`); the page limit is code-slots-admin's `pageAllowance` (staff only). Q8 is one question for all three designs, which now agree. |
| 3 | Free users hide the branding with custom CSS | Confirmed – fixed (option a) | Pinned inline footer styles, save-time `cssWarning`, terms rule, tests (§4.4.1, §5.3, §5.6, §7). Option b is Q9. |
| 4 | Unproven claims block the real owner; `suspended` rows block forever | Confirmed – fixed | Fresh TXT proof beats any other account's row except `blocked`/`removing`, at any age; ambiguous only while another account's value is still published (the user removes it). Ages from `created_at`/`cf_created_at`, never reset. `failed` rows deleted after 30 days, hostname-less `suspended` rows after 90 days (§2.8, §4.9). |
| 5 | Kept hostnames capture moved domains; `cf_ips` hides moves | Confirmed (Appendix A, hostname priority) – fixed | Delete the hostname at once on `moved`/`deleted`/DNS elsewhere/no record, in every state; `broken` without hostname and automatic re-creation; `cf_ips` only for apex with CF `active` and one of our edge addresses; subdomains must show our CNAME; daily orphan auto-delete from log ids; domain change deletes the old zone's hostnames (§2.6, §4.7, §4.8, §8.3). |
| 6 | Our own outages count as failures of every domain | Confirmed – fixed | 5xx/52x/530/`cf-mitigated`/429 are unknown; control check through the same edge every minute; 20 % breaker freezes downgrades and alerts admins; challenge settings documented (§2.6, §4.7, §8.1). |
| 7 | Lasting DNS failure never flips | Confirmed – fixed | Unknown on both resolvers for ≥ 3 checks and ≥ 30 min is definite (unless the breaker is open; its control includes DoH); active rows checked every 10 min; optional "Forward my OnYourSite addresses" switch (§2.5, §4.7, §4.9). |
| 8 | Network checks hold pooled connections | Confirmed (`db.ts:74,177-187`) – fixed differently | No lease column: the website does no network checks at all. One worker process does them, never holding a connection during I/O (8 parallel, own pool), with compare-and-set writes on `version`. The only web lookup (claim TXT) holds no connection (§4.5, §4.9). |
| 9 | Editor polling never ends and PATCHes every 20 s | Confirmed – fixed | Polling reads `GET domain` only and stops at the `fastUntil` of the last user action; only "Check now" writes (30 s per domain, 60/h per user); at most one PATCH per 5 min; the worker's fast schedule does the work (§4.5.2, §5.2, §4.9). |
| 10 | Contradiction with code-slots-admin about code slots | Confirmed – fixed | Chose "block the conversion" (code-slots-admin E7 now does this); `hasDomain` under their slot lock, `domain-add` takes the same lock; `host.ts` answers the neutral 404 for a page with `code_site_id` (§2.8, §4.2, §4.5.2). |
| 11 | status-pages promises custom domains this design leaves out | Confirmed – fixed | v1 stays link pages; the target registry (§4.12) makes `status` a small follow-up (Q10); status-pages' own §1.3 now agrees; their remaining control should wait. Real health signal `domains.health()` instead of the fallback-origin URL; one shared `/_/` list. |
| 12 | Cheap Premium can fill all 100 free places | Confirmed – fixed | Hostname deleted at suspension unless live ≥ 14 days; Premium ≥ 7 days left and account ≥ 30 days when adding; one `pending` per user; ≤ 3 creations per domain per day; waiting line with paused timeout; `capacity()` for the shop (§2.7, §4.8, §6.2). honeycomb-shop dropped 7-day Premium and requires 30-day-old accounts for Premium. |
| 13 | Branding scope changes existing pages; migration over-grants | Confirmed – fixed | PR 1 = today's scope (footer, OG mark, API); title/alt/favicon in PR 1b only after Q7, only for Premium (legacy keeps exactly what it had); favicon is a generated 64 px PNG; migration skips owners with Premium (§3.4, §4.4, §9). |
| 14 | Per-process host cache can loop with several workers | Confirmed – fixed | No positive cache: state and target are read fresh per request (one unique-key lookup); only a 10-s negative cache for unknown hosts (§4.2). |
| 15 | Installer details (a) `!= 3`, (b) `--update` PUT/prompt, (c) custom names not reserved | Confirmed (`install.sh:1106,1173,1257,876-915,1237-1240,1802-1842`) – fixed | (a) length of `mine`, `$SAAS_ORIGIN`, own comment; (b) merge instead of replace (also for `--tunnel`), quiet token read, warnings only; (c) names in config, refused by `slugProblem`, installer refuses taken names (§8.2, §8.3, §7.4). |
| 16 | Website token can do far more than "minimal" | Confirmed (OpenAPI token groups) – fixed with the stronger option | The token never enters the website: root-only file, `LoadCredential` to the worker's own sandbox; scope documented; IP filtering recommended where possible (§3.3, §6.1, §8.2). |
| 17 | Booking blocks lose their internal calendar | Confirmed (`blocks.php:33-46`) – fixed | Check-time acceptance of the domain hostname in any state plus save-time normalization to `/kalender` (§4.3). |
| 18 | Interfaces don't match custom-dialogs; dedup and links have gaps | Confirmed – fixed against custom-dialogs' current API | `OYSUI.prompt` (`match`, `normalize:'host'`, `matchLabel`), `OYSUI.choice`, `OYSUI.toast`, `confirmAttrs()`. custom-dialogs' `notify()` no longer takes a `ref`, so exactly-once comes from writing the bell row with `{db}` in the state-change transaction; emails are log rows sent by the worker; 24-h flap guard in `notice_at`/`notice_state`. Link `/dashboard?page=<id>#settings/domain` + `DEEP_LINKS`. Paused lines go into honeycomb-shop's end/revoke/refund notices through `premiumLossPreview`; own `domain_paused` only for a lost admin role (§4.11). |
| 19 | Zone detection breaks when the CNAME exists | Confirmed – fixed | Zone from the `_onyoursite.<host>` lookup, parent walk on CNAME or mismatch, never the base zone (§4.7). |
| 20 | (a) `pending_days` up to 30; (b) no `removing` row; (c) no compare-and-set; (d) early TXT lookup poisons caches; (e) TXT fallback needs PATCH; (f) Remove without forwarding | Confirmed – fixed; (f) partly rejected | (a) clamp 1–7, GET 404 = deleted; (b) row added; (c) `version` CAS everywhere; (d) no lookup at add, first after 10 min or Check now, and never of the hostname itself while verifying (RFC 8020/8198); (e) PATCH `ssl.method: txt` first, only as an apex fallback; (f) the dialog now says links and QR codes stop working. |
| 21 | Word filter rejects ordinary domains | Confirmed (`blacklist.php:19-45,92-99`) – fixed | Hostnames are not run through `forbidden_contains` or the regex list at all; admin Disable covers abuse (§6.1, tests). |
| 22 | Custom hosts expose more than the page | Confirmed (`router.ts:45-50`, `routes_public.php:11-30,132-137,184`) – fixed | Router branch before uploads and only when available; uploads only of the owner; `/_/` ids only of the domain's page; neutral page for every 404 and failure redirects to the domain (§4.2, §5.5). |
| 23 | The literal "buy a domain with honeycombs" has no design | Accepted – fixed | `custom_domain` count feature (requires Premium) behind the admin switch `slots`; Q1 becomes a catalogue setting (§1.2, §3.5, §4.5.2). |
| 24 | Tests miss the risky paths | Accepted – fixed | Added: probe through `dispatch()`, polling termination, pool test, CSS bypass, breaker, move-away/`cf_ips`, takeover, uploads/ids on custom hosts, booking, exactly-once notices, installer merge/`mine`/quiet token; Playwright with a `node:https` test edge (§7). |

**Fixes I rejected or changed, and why**

- **#2 – "drop `users.premium_until`, use `premiumActive` and the `hc_entitlements` EXISTS path".** The reviewed
  honeycomb-shop version stored Premium only in `hc_entitlements`. Its revision (2026-11-01) now owns
  `users.premium_until` itself, writes it in the same transaction as the entitlement (`setPeriod`), checks it nightly,
  and offers exactly `isPremiumRow`/`premiumState`. Following the literal fix would re-open the contradiction the
  finding is about. The SQL path `u.is_admin = 1 OR u.premium_until > NOW()` is equivalent to the proposed EXISTS
  condition, because "for good" is stored as `9999-12-31 23:59:59`, never NULL. The other parts of the fix are done
  as proposed: single owner, `registerEnforcer` instead of a private hook, one staff function, PR 1 sets `ready`, one
  pill, one set of bootstrap keys.
- **#8 – lease column + semaphore in the website.** Replaced by a stronger fix: the website no longer performs network
  checks at all. With a single worker instance under `GET_LOCK` and compare-and-set on `version`, a lease adds nothing.
- **#14 – "cache `hostname → ids`, read state by primary key".** A cache of ids would save only one unique-key lookup,
  which costs the same as the primary-key read it would trigger. Dropping the positive cache is simpler and cannot be
  stale.
- **#16 – "document and restrict by Client IP Address Filtering".** IP filtering is recommended but not required: many
  small servers have no fixed outbound address. Keeping the token out of the website process (the reviewer's "better"
  option) is the actual fix.
- **#20(f) – "offer the 30-day forward on Remove".** Rejected. A user who removes a domain usually points it somewhere
  else next, and a kept hostname would capture it (finding 5). The dialog now states what stops working instead.
- **#21 – "apply the filter only left of the registrable domain".** Without a public suffix list the registrable domain
  is not known reliably at add time, and filtering subdomain labels still blocks ordinary names (`meth.example.com` for
  "methods"). The filter is dropped for hostnames; moderation stays on the page content.
- **#7 – the optional redirect switch** is included, because the column and the generalized redirect rule were needed
  anyway.
- **#3 – option (b), custom CSS as a Premium perk,** is not the default. It would make a free feature paid
  (honeycomb-shop non-goal) and change existing pages. It remains Q9.
