# Owner decisions (final) – 2026-11-01

Answers to `QUESTIONS.de.md`. These override the baseline wherever they differ; `ROADMAP.md` §6 lists the effects.

| Q | Answer | Meaning |
|---|---|---|
| Q1 Premium scope | **b** | Custom domain + no branding + more for status pages (30 checks instead of 10, every minute, 250 subscribers). Page count, address cooldown and storage stay the same for everyone (staff only). |
| Q2 Branding scope | **c** | "Made with OnYourSite" + OG-card mark, plus "\| OnYourSite" in the title and the own avatar as favicon, plus the code-page badge becomes a plain "Report" link. |
| Q3 Domain included | **a** | Included in Premium: one domain per profile page, at most 3 per user. The `slots` switch stays built in, off. |
| Q4 Start prices | **a** | As proposed: Premium 350 / 30 days, 700 / 90 days; code page 100; more code pages free; status page 150 once; +10 checks 60 / 30 days; fast checks 80 / 30 days; domain slot 150 (inactive); streak +15 after 7 days, +50 after 30 days; daily cap 300. |
| Q5 Auto-renewal | **a** | Opt-in only, renews one day before the end, never above the agreed price. Separate step after the Premium sale has started. |
| Q6 Code page model | **a** | The profile page is parked (hidden, restorable); at most one per account (admin setting 0–3). |
| Q7 Status free tier | **a** | Only after the unlock. |
| Q8 Visitor subscriptions | **a** | Later (Stage C). |
| Q9 Pages hiding the note today | **a** | Grandfathered until the owner of the page changes it; new CSS tricks no longer work; editor shows a hint. |
| Q10 PHP | **"Everything must work without PHP!"** | See below – replaces both (a) and (b). |
| Q11 Emails | **a** | Only when the user must act or loses something (Premium ends in 3 days / ended, domain live / problem (max 1 per domain per day) / paused / removed, status alerts to the owner); Premium mails can be switched off. **Mail server: the owner's own Mailcow** – no provider limit; our own conservative budgets apply (configurable in the admin); Mailcow's own rate limits are set by the owner in Mailcow. |
| Q12 What status pages may check | **a** | Any public website, with per-site caps, robots.txt respected, and an opt-out for site operators. |
| Q13 Discord error | see below | |
| Q14 Extras after v1 | **a** | Visitor milestones + anniversary bonus first, then invite friends, then the new purchasable designs; the rest later. |
| D1–D20 | as listed | No objection – all defaults stand. |

## Q10 – "Everything must work without PHP"

- **Release 3.0 is Node-only.** It contains no PHP code: the PHP site (`*.php` in the root, `lib/`, `views/`,
  `PHPMailer/`, `cron/weekly_report.php`, `server/*.php`, `.htaccess`, `tests/unit.php`) is removed in 3.0, right after
  the parity gate. A `php-2.x` branch keeps the last PHP version (reference for development parity tests, nothing
  else). No PHP is installed on fresh servers, and nothing on the server needs PHP after the migration.
- **No PHP rollback.** `install.sh --rollback` and the two-week window are dropped; there is no 3.1 gate. Safety
  instead: `install.sh --update` always takes a backup first (DB dump, settings, upload snapshot), the migration from
  PHP aborts with the PHP site still serving if anything fails before the switch, and reverts automatically if the
  check right after the switch fails. After that, recovery is "restore the backup + previous release" (documented).
- **Consequences for the roadmap:** the PHP-rollback classes (§2.2) no longer exist. Every PR is built without any
  PHP-rollback code (no PHP patches, no `--rollback` refusals, no legacy fallbacks or mirrors for PHP) and merges as
  soon as its dependencies are in, after 3.0. Stage B no longer waits for 3.1. §8 is void. discord-pages' W3
  compatibility layer for PHP (settings v1 mirror, old update columns written for PHP, outbox parking for rollback)
  is not needed. CORE-1's before-update backup moves into the 3.0 installer.

## Q13 – the Discord loop the owner hit

"When I gave the webhook link, it said it needs a channel ID; when I gave the channel ID, it said it needs a webhook
link – whatever I tried." In the current code this is the loop between
`'Saved – for the bot, a token and a channel ID are both needed.'` (save while the stored or checked mode is `bot`;
the webhook field is ignored in bot mode) and `'Please save a webhook link or bot first.'` (the test action while the
saved settings have no usable target). DP-1 must make this impossible and test it: pasting a webhook link selects the
webhook mode; only the fields of the visible mode are submitted; a channel ID alone is never "saved"; every message
names exactly what is missing for the selected mode; saving checks the target with Discord and shows Discord's own
error; the installed bot is offered without retyping the token.

## Owner answers from the reviews (2026-11-02)

| # | Question | Answer | What it means |
|---|---|---|---|
| R1 | An admin uses "Log in as" on another *admin* account | **"Only the admin, as before"** | The admin panel (`/admin`, `/admin/api/…`) and the site-wide admin parts of the editor (the Status tab for OnYourSite's own status page) only work in the admin's own session. While anyone works as another account through "Log in as", they act as that account – even when it is an admin – and admin actions are never recorded under someone else. "Log in as" itself stays available for every account. |
| R2 | A custom domain an admin blocked | **It can't be added again** | Removing a blocked domain in the editor only detaches it from the page; the hostname stays blocked for every account (adding, claiming with a TXT record and takeover are refused) until an admin releases it (PD-5). This settles designs/premium-domains.md §5.2 vs §2.8 in favour of §2.8. |
| R3 | `code_more` refund while it costs nothing | **Yes, as built** | After a refund or removal of `code_more`, the code pages above the free allowance go offline only while `code_more` costs something; at price 0 it is free for everyone and nothing goes offline (CS-E13). |
| R4 | Confirmation for honeycomb gifts | **Yes, as built** | "Give honeycombs" asks through the site's dialog before every deduction and before gifts above 1,000 honeycombs (`GRANT_ASK_ABOVE`), and the server refuses those without the confirmation. |
| R5 | Code page on `on-your.site/name` instead of `name.on-your.site` | **Subdomain only** | A code page always runs on its own subdomain `name.on-your.site`; `on-your.site/name` only redirects there (as before). Untrusted code never runs on the main address (phishing, password managers). The editor shows and changes the address in the page's Edit dialog. |
| R6 | "A subdomain area to make my own subdomain" | **Name per page** | Every page – link page or code page – gets a "Subdomain" section in its Settings where the owner picks and changes its `name.on-your.site`, separate from the "Custom domain" section. |
| R7 | Owner requests of 2026-11-02 afternoon | **Build now** | CS-6 goes live: "Your pages" shows every slot including the extra code pages bought with "More code pages"; code pages can be added and deleted there; "Edit" on a page chooses Link page or Code page. Status pages for users (ST-4) are sold in the Honeycombs shop (`status_page`, 150 honeycombs), and the look of the status page components is refreshed. |
| R8 | Custom domains while an admin works as the user ("Log in as") | **Refused** | Like spending honeycombs: the admin sees the Custom domain section, but every domain action (add, claim, check, forwarding switch, remove) answers 403 `admin_mode` with "Custom domains can’t be changed in admin mode.", and the editor shows the section locked with that reason. This replaces the staff exemption of designs/premium-domains.md for this mode. |
| R9 | Branding hint for sibling and universal selectors in custom CSS | **No, as built** | Saving custom CSS keeps warning only for selectors that aim at the branding note (`oys-foot`, `footer`, the last child of the main area, attributes that name the note, OnYourSite or the page’s own address); `.oys-main > *` and similar normal CSS stay quiet. The note is protected by its pinned inline styles anyway. |
