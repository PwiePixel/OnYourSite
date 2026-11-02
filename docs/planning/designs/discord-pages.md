# Design: Discord fix and own pages for updates, roadmap and suggestions (`discord-pages`)

`$S` = `the original development workspace (not in the repository, see ../README.md)`

- **Code read:** PHP reference on `feature/node-typescript` (HEAD `6eaf9b8`; the PHP code is unchanged since `f3d18b0`),
  the Node core at `6eaf9b8` (`app/src/router.ts`, `app/src/app/dispatch.ts`, `app/src/schema.ts`, `app/src/db.ts`), the
  port branches `port/updates` (`8b6d5d1`, `app/src/updates/discord.ts`) and `port/community` (`729e1b7`,
  `app/src/community/{community,api,admin,adminView}.ts`), `discord-bot/` (discord.js 14.28.0, including
  `node_modules/discord.js/src/client/actions`), `server/install.sh`, the specs `$S/spec/map-admin.md` §1.8–1.9,
  §2.3–2.5, §3.2–3.6, §6 and `$S/spec/plan.md` §0, §3.4, §5.
- **Reproduction:** detached worktree `$S/wt-design-discord` with the database `oys_test_designdiscord`, PHP on port
  18401, a Discord mock that follows Discord's validation rules (`$S/design-discord-repro/discord_mock2.py`).
  The scripts are `$S/design-discord-repro/repro.sh` (HTTP) and `form.js` (Chromium). Their output is in `repro.out` and `form.out`.
- **Checks for the review round** (`$S/design-discord-rev/`): `redirect-cache.mjs` (a cached `/roadmap` 301 against the
  forward script, Chromium), `navwidth.mjs` and `navfit.mjs` (sub-navigation widths with Inter and Boxicons from the
  repo), and a PHP run of the trailing-slash route (§7; the test page was removed again).
- PHP is cited as `file:line`. Node files are named by path and identifier, because their line numbers still move
  during the port.

---

## 1. Goal and the owner's requirement

> „… Außerdem will ich das du den discord bereich fixt denn ich kann updates nicht mit Bot verknüpfen oder Webhook
> link verbinden behebe dies und amche eine eigene page für roadmap und updates und suggsion oder so alles soll seine
> eigene page haben lasse das aktuelle design bestehen."

In English: fix the Discord area. Updates can be linked neither to the bot nor to a webhook link. Give the roadmap,
the updates and the suggestions their own pages, and keep the current design.

How I read it, where the wording is open:

1. **"Link updates with the bot"** means the bot the installer set up (welcome, suggestions, tickets) should also
   announce updates. There is no second bot and no copied token. → The installed bot posts updates through the
   existing signed outbox, which it polls every `POLL_SECONDS` (10 s, as today). The bot installer adds an `#updates`
   channel.
2. **"Connect a webhook link"**: a pasted webhook must save reliably, be checked against Discord, and say clearly
   what is wrong. → The webhook stays as an optional second destination, for example for another server or when no
   bot is installed.
3. **"Fix the Discord area"** also covers the parts that make failures invisible: status, error texts, forum and
   thread channels, edits and deletions kept in sync, and no double posts.
4. **"Own page for roadmap, updates and suggestions"** means three public addresses with the same look and one shared
   navigation:
   - `/updates` is the changelog and keeps every existing URL.
   - `/roadmap` becomes a real page instead of today's 301.
   - `/suggestions` is new. It shows the suggestions from the Discord forum that the team has decided, with their
     status and the team's note, without names. The page starts switched off, and posts written before their authors
     could know about it never appear by themselves (§3.4, §7).
5. **"Keep the current design"**: the same Tailwind config, cards, badges and typography as `views/updates.php` and the
   admin views. The only new element is a small pill sub-navigation built from existing classes.

**Out of scope:** voting on suggestions, submitting suggestions on the website (they stay on Discord), honeycomb
rewards for ideas (honeycomb-shop HC-12 hooks into the decision), and other admin sections.

**Optional extras, not part of the core** (PR 6, only if the owner wants them, §11 Q7): crossposting to following
servers, forum tags for update posts, syncing edited suggestion titles and texts from Discord, linking suggestions to
roadmap milestones (with "ideas" chips), a "Working on now" strip on `/updates`, and a suggestions feed.

---

## 2. Root cause analysis (reproduced)

Today two separate things are called "Discord":

- **Admin → Community** talks to the installed bot. It uses the signed `/_/bot/*` API and an outbox the bot polls
  (`lib/community.php:2-6`: *"Die Webseite kennt keinen Bot-Token und spricht Discord nie selbst an"*).
- **Admin → Discord** is a second, unrelated integration for update announcements. The website calls Discord itself,
  either with a webhook URL or with a bot token pasted again (`lib/updates.php:599-612`).

The complaint comes from three root causes. A fourth problem explains why the setups that do save still fail. Which
of them hit the owner is not proven yet; §2.6 settles that before PR 1.

### RC1 – updates can't use the installed bot (design gap)

| Evidence | Where |
|---|---|
| The update "bot" mode needs a raw bot token and a channel ID typed into the website, and posts by REST. | `views/admin_updates.php:306-315`, `lib/updates.php:557-568, 599-606` |
| The README even says to create a *new* application for it. | `README.md:92` |
| The installed bot's token lives only in `/etc/onyoursite-bot.env` (root, mode 600). The installer says "The Client Secret isn't needed" and never shows the token again. | `discord-bot/install.sh:203-213, 309-321` |
| The bot's outbox knows only `suggestion.decided`, `ticket.reply` and `ticket.close`. There is no update action. | `discord-bot/index.js:76-80` |
| The bot setup creates #welcome, #rules, #support, the #suggestions forum and the Tickets category, but **no updates channel**, so there is no channel ID to pick. | `discord-bot/src/setup.js:137-193` |
| Repro **C**: after a signed `/_/bot/ping`, Community shows **"Connected"**, while the Discord tab says **"Discord isn't connected yet"** and the update form says **"Connect Discord under Discord…"**. | `repro.out` |
| Repro **A6** (a plausible attempt, not observed): pasting the 32-character client secret fails with "That doesn't look like a bot token". | `repro.out` |
| Repro **A7** (a plausible attempt, not observed): with the real token and the setup's #suggestions forum as the channel (there is no #updates to pick), every post fails with "Discord error 400: Cannot send messages in a non-text channel." | `repro.out` |

### RC2 – the settings form blocks saving (form bug)

| Evidence | Where |
|---|---|
| One form holds both modes. The other mode's fields are only hidden with CSS and are still submitted. | `views/admin.php:655-663` |
| Every non-empty field is validated before storing, whatever mode is chosen. A value in the invisible field aborts the save with an error about a field the admin can't see. | `lib/updates.php:550-567` |
| The secret fields are `type="password"` and the form has a text field named `username`. Password managers fill saved logins into such forms and ignore `autocomplete="off"` (MDN: *"setting autocomplete to off will not prevent a password manager … from automatically filling in those values"*). The admin has a saved login for the same origin. | `views/admin_updates.php:293, 298, 309`; `views/login.php:68,73` |
| A password field shows dots, so the admin can't see that it was already filled. Pasting a link then appends to the autofilled text. | Repro **A3** |
| Repro **A1**: webhook mode with a value in the hidden token field → "That doesn't look like a bot token…", nothing stored. | `repro.out` |
| Repro **A2**: bot mode with a value in the hidden webhook field → "That doesn't look like a Discord webhook link…", nothing stored. | `repro.out` |
| **Chromium run**: in bot mode `#dHook` is invisible, yet the real form posts `webhook_url` and the save fails. | `form.out` |
| **Proven vs. assumed:** the defect (hidden fields are submitted and validated) is proven. The trigger – a password manager filling those fields – is the most likely one, but it was simulated (`form.js` sets `#dHook` by script) and not observed; `map-admin.md` §6 says the same. | §2.6 |

### RC3 – saves that succeed are not checked, and Discord's reason is lost

| Evidence | Where |
|---|---|
| Saving never contacts Discord. Only "Send test" or publishing does. | `lib/updates.php:545-596` vs `:982-994` |
| `oys_discord_error` reads only `message` and drops Discord's per-field `errors`. | `lib/updates.php:655-675` |
| The name check rejects only "discord" and "clyde". Discord also forbids `@ # : ```` and the names `everyone` and `here`. | `lib/updates.php:576-579` |
| Repro **A4**: "Name in Discord" (`name="username"`) filled with the login e-mail is saved, then every post fails with **"Discord error 400: Invalid Form Body."**, with no hint that the name is the cause. | `repro.out` |

### RC4 – unsupported channel kinds

| Evidence | Where |
|---|---|
| A webhook in a forum channel needs `thread_name`. Repro **A5**: "Discord error 400: Webhooks posted to forum channels must have a thread_name or thread_id." The UI has no option for it. | `repro.out` |
| There is no thread support at all: no `thread_id` for webhooks and no thread channel for the bot. | `lib/updates.php:599-612` |
| Pings through a bot need *Mention @everyone* (or a mentionable role), which is never checked. The text then shows but nobody is pinged. | `lib/updates.php:701-711` |

### Not the cause (verified)

- **Repro B:** with a correct webhook, the send, edit and delete code works: `POST ?wait=true`, then `PATCH`, then
  `DELETE`.
- `php-curl` is installed (`server/install.sh:195`).
- The webhook regex accepts every current URL form: discord.com, discordapp.com, ptb, canary and `/api/v10`
  (`lib/updates.php:534`).

Fixing only the form (RC2) would leave RC1, so the owner still couldn't use his bot. That is why the design below
rebuilds the delivery and does not just patch the form.

### 2.6 Pinning it to the owner's server (before PR 1 is merged)

1. **Read the stored settings on the production server.** The command prints only facts – no link, no token, no
   name. Checked against the test database of the repro worktree.

   ```bash
   cd /path/to/onyoursite        # the folder that contains server/install.sh
   sudo -u www-data php <<'PHP'
   <?php
   require 'lib/bootstrap.php';
   $s = oys_discord_settings($pdo);
   echo json_encode([
       'mode' => $s['mode'],
       'webhook_saved' => $s['webhook_url'] !== '',
       'webhook_parses' => oys_discord_parse_webhook($s['webhook_url']) !== null,
       'token_saved' => $s['bot_token'] !== '',
       'channel_id_saved' => $s['channel_id'] !== '',
       'name_breaks_rules' => (bool) preg_match('/[@#:]|```|^(everyone|here)$/i', $s['username']),
       'bot_last_seen' => oys_bot_last_seen($pdo),
       'posts_on_discord' => (int) $pdo->query('SELECT COUNT(*) FROM updates WHERE discord_message_id IS NOT NULL')->fetchColumn(),
   ], JSON_PRETTY_PRINT), "\n";
   PHP
   ```

2. **Ask the owner which message he saw** when saving or testing (§11 Q6).
3. **Log every failed save or test from PR 1 on**: one server-log line `Discord settings: <reason>` (the flash text,
   never a link or token), so a later report can be traced.

| What the facts show | Cause |
|---|---|
| `mode=bot`, `token_saved`, `bot_last_seen` set, or "Cannot send messages in a non-text channel" | RC1 (A6/A7) |
| `webhook_saved=false` and "That doesn't look like a Discord webhook link / bot token" | RC2 (A1–A3) |
| `name_breaks_rules=true`, or "Invalid Form Body" | RC3 (A4) |
| "must have a thread_name or thread_id" | RC4 (A5) |

The design fixes all four, so the answer changes the order of the release notes, not the scope.

---

## 3. User stories and flows

### 3.1 Admin – connect the installed bot (main flow)

1. `server/install.sh --update` updates the code and runs `discord-bot/install.sh --update` when the bot runs on this
   server – as a system service (`server/install.sh:1577-1580`) or, new, in Docker in the same code folder. A bot on
   another machine is updated there (the admin card says how, §6.1).
2. The bot installer finds no `UPDATES_CHANNEL_ID=` line in its settings file and runs
   `--discord-channel UPDATES_CHANNEL_ID` **once**. That command does nothing but look for a channel named "updates"
   (text, announcement or forum) and use it unchanged ("Using your existing #updates"), or create **#updates** when
   there is none. Roles, other channels, tags and permissions stay as they are. On failure it writes
   `UPDATES_CHANNEL_ID=` (empty) and a warning, and does not try again by itself.
3. A created **#updates** is read-only for members and writable for the bot. It is an announcement channel if the
   server has the community feature, otherwise a text channel.
4. The bot starts and sends `POST /_/bot/hello` with:
   - its version, its features and how it runs (`service`, `docker` or `other`);
   - the server;
   - every text, announcement and forum channel with the bot's own permissions there, except the private ticket
     channels;
   - active threads, except the #suggestions posts;
   - roles;
   - the suggested `updates_channel_id`.
5. **Admin → Discord**, card "Post with the bot":
   - It shows *Online · version 0.2.0 · system service on this server · server "OnYourSite" · channels checked 2 min
     ago*.
   - A highlighted line says *"The bot is ready to post in #updates."* with a button **Use #updates**.
6. Saving validates against the report and asks the bot for a fresh one. The card says *"Checking with the bot…"*
   until a report newer than the save arrives, then *"Ready – the bot can post in #updates."* or the exact problem.
7. **Send test** queues `update.test`.
8. The card shows *"Sending the test through the bot…"*. A status poll (§5.3) replaces it with *"Test message posted
   in #updates at 14:02."*, with the bot's exact error, or after 2 minutes with *"The bot didn't answer within 2
   minutes – it may be offline. Try again when it shows Online."*

States of the bot card (`{code}` is the website's real code folder, never a hard-coded path):

| State | Shown text | Possible actions |
|---|---|---|
| Not installed (`bot_secret` < 32 bytes) | "The Discord bot isn't set up on this server. Run `sudo bash {code}/server/install.sh` and answer y at "Set up the Discord bot on this server too?" – until then you can use a webhook below." | — |
| Installed, but no report with `updates.v1` – bot unit or Docker settings in `{code}` exist | "The bot runs an older version that can't post updates yet. Update it: `sudo bash {code}/server/install.sh --update`" | Refresh |
| Same, but the bot doesn't run from this server (or an old bot that doesn't report how it runs) | "The bot runs an older version that can't post updates yet. Update it where it runs: get the new code there, then `sudo bash discord-bot/install.sh --update` in that folder. If it runs on this server: `sudo bash {code}/server/install.sh --update`." | Refresh |
| Checking (after a save) | "Checking with the bot…" | — |
| Offline (last seen ≥ 5 min ago) | "Offline – last seen {Nov 1, 2026 13:40}. New posts wait and go out when the bot is back; posts that wait longer than 24 hours aren't sent." | Settings stay editable against the last report |
| Online | "Online · version {v} · {system service on this server / Docker / elsewhere} · server "{name}" · channels checked {time ago}" | **Refresh list**, **Send test**, **Turn off** |
| Turned off | "The bot doesn't announce new updates. It still edits and removes the {n} posts it made." | **Turn on** |

"This server" is decided like `server/install.sh` decides it: `/etc/systemd/system/onyoursite-bot.service` exists,
or `{code}/discord-bot/.env` exists (Docker in the code folder, the test of `discord-bot/install.sh:64`).

### 3.2 Admin – webhook (optional second destination)

1. The card "Post with a webhook" contains a plain text input **Webhook link**. It is not a password field and
   carries no `username` name.
2. Where to post:
   - **In the channel** (default);
   - **As a new forum post for each update**;
   - **In a thread**, which shows a field *Thread ID*.
   - Under the two last options: *"A webhook can't rename or delete forum posts or threads: edits keep the first
     title, and unpublishing removes the message but leaves an empty post. The bot can do both – use it for
     forums."*
3. Optional fields: **Display name**, **Avatar image link**, **Ping**.
4. Save checks, in this order:
   1. the link format (§5.5.1);
   2. the display name rules;
   3. the ping;
   4. the thread ID format;
   5. **Discord itself**: `GET /webhooks/{id}/{token}`, which posts nothing.
5. Results of saving:
   - Success → *"Webhook saved and checked – Discord knows it as "Captain Hook" (channel 1234…)."*
   - Discord unreachable → stored with a warning: *"Webhook saved, but Discord couldn't be asked right now
     (timeout). Use "Send test" to try it."*
   - Unknown webhook or token (404 10015, 401 50027) → nothing stored:
     *"Discord doesn't know this webhook – it was deleted or the link is incomplete. Copy it again in Discord
     (channel settings → Integrations → Webhooks)."*
   - A thread can't be checked by `GET /webhooks/…`, so a saved thread shows *"Thread not verified yet"* until the
     first post into it succeeds.
6. Webhook in a forum channel:
   - If the bot's report knows the webhook's channel and it is a forum, the site preselects "As a new forum post…" and
     tells the admin.
   - Otherwise a test or post failing with 220001 says: *"This webhook belongs to a forum channel. Choose "As a new
     forum post for each update" or "In a thread", then save again."*
   - **Send test** in forum mode creates one post "OnYourSite test" after a confirmation and remembers it; later tests
     go into that post (`?thread_id=`). If it was deleted, the next test asks again.
7. A saved webhook is shown as text: *"Webhook "Captain Hook" · https://discord.com/api/webhooks/1301…/•••• ·
   checked Nov 1, 14:02"* with the buttons **Replace link**, **Send test** and **Remove**. The link input only exists
   in the DOM after **Replace link**, so nothing secret is pre-filled.
8. Bot and webhook on the same channel → error: *"The bot already posts into this channel – updates would show up
   twice."*

### 3.3 Admin – publish, edit, unpublish, delete (kept in sync)

The per-update choice "Announce on Discord when published" stays as it is (`discord_announce`, default
`auto_post`). It now applies to **every enabled destination**. Every step below is safe against double clicks and
against the bot's answer arriving at the same moment (§5.5.3).

| Action | Webhook (synchronous, as today) | Bot (asynchronous, via outbox) | Flash |
|---|---|---|---|
| Publish with announce | Claim the row (`posting`), commit, `POST ?wait=true`, then `posted`, or `failed` with the reason. A second click meanwhile gets "Already posting to Discord – this takes a few seconds." | Row `queued` + `update.post` job in one transaction | "Update published. Posted with the webhook; the bot posts it to Discord within a few seconds." (variants per destination; bot offline → "…the bot is offline – it posts it when it's back, within 24 hours."; bot too old → "…the bot needs an update before it can post it.") |
| Edit a published update | `PATCH` (no new ping). While `posting`: marked and patched right after the post. | Unclaimed edit jobs are superseded and a new `update.edit` is queued; while `queued`: `dirty=1` | "Update published. The Discord posts are updated too." / "…the bot updates its post within a few seconds." |
| Unpublish | `DELETE`. While `posting`: "Still posting to Discord – try again in a few seconds." | Job not yet handed to the bot: cancelled and the row deleted. Otherwise row `removing` + `update.delete` (or the bot's post result triggers the delete). | "Moved back to drafts and removed from Discord." / "…the bot removes its post within a few seconds." |
| Delete update | `DELETE` first. A transient failure aborts the whole delete, as today (`lib/updates.php:925-929`); while `posting` it is refused like unpublish. | As unpublish. The update row is deleted at once; a `removing` post row stays until the bot confirms. | "Update deleted." + notes |
| "Post to Discord" on an old update | posts where not yet posted | same | "Posted to Discord." / "Queued for the bot." On a `remove_failed` row: "Its earlier Discord post couldn't be removed yet – use Retry or Forget on it first." |
| "Remove from Discord" on a draft | as unpublish | same | |

**Status in the update list** (replaces the single "On Discord" badge, `views/admin_updates.php:124`): one chip per
destination.

| Chip | Meaning | Actions |
|---|---|---|
| *Bot · posted* | the message is in Discord | — |
| *Bot · posting…* (amber) | the job is queued, or the webhook request is running | **Forget** after 10 minutes (webhook: after 2 minutes) |
| *Bot · not updated* (amber) | the last edit failed; `title` holds the reason | **Retry** (queues the edit again); for posts of a different bot only **Forget** |
| *Webhook · failed* (red) | the post failed and nothing is in Discord – or the website stopped while posting, which the text then says | **Retry**, **Forget** |
| *Bot · removing…* | the delete job is queued | **Forget** after 10 minutes |
| *Bot · couldn't remove* (red) | the delete failed; the message is still in Discord | **Retry**, **Forget** |

**Card "Discord posts"** in the Discord tab:

- It lists every row that is not `posted`, every `posted` row with an error, and the last 10 posted ones.
- Columns: Update (title, or "(deleted update #12)"), Where (Bot #updates / Webhook), Status, Actions (Retry,
  Forget).
- Forget asks: *"Forget this post? If it is in Discord, it stays there and can't be edited from here any more."* It
  also marks the post's open or dead jobs as done.
- When nothing is listed: "Nothing posted to Discord yet."

### 3.4 Admin – suggestions page and visibility (Community tab)

**Card "Public suggestions page"**, a new small card at the top:

- Radio **Off** (default) / **On**. While the bot isn't set up, the card is disabled: "The suggestions page needs the
  Discord bot."
- Turning it on asks first (custom-dialogs `data-confirm`): *"Turn on the suggestions page? Suggestions the team
  decides from now on are shown at {host}/suggestions, without names. The bot adds a note about this to the
  #suggestions guidelines and to every new post. Older suggestions stay hidden unless you show them one by one."*
- One line below: "On the website: {n} · Waiting for a decision: {m} · Not shown: {k}" and a link "View
  /suggestions".
- There is no switch for author names: names are never shown (decision, §11 Q1).

**Changes to each suggestion** (`views/admin_community.php:89-116`):

- **Badge** "On the website" (emerald) or "Not on the website" (gray), with the reason as `title`: "waiting for a
  decision", "the author wasn't told it could appear on the website", "hidden by the team" or "deleted in Discord".
- **Button** **Show on website** / **Hide on website** (`suggestion_web`).
  - Showing an open suggestion shows it before the decision.
  - Showing a suggestion whose author wasn't told asks: *"Show it anyway? The author posted it before the website
    showed suggestions and wasn't told it could appear there."*
- **Badge** *Deleted in Discord* when the thread is gone; the text is then erased and only the title is kept.
- The accept/decline form stays as it is.

### 3.5 Visitors

All three pages are cookieless like `/updates`, use the same header and footer, and share the sub-navigation
**Changelog · Roadmap · Suggestions**. The active pill has `aria-current="page"`. The Suggestions pill and footer link
are hidden while the page is off.

**`/updates`** – the changelog:

- The timeline and pager as today; the roadmap sections move to `/roadmap`.
- Milestone chips link to `/roadmap#milestone-{id}`.
- `?page=N`, `/updates/{id}`, `#update-{id}` and `/updates/feed.xml` are unchanged.
- **Old links** `/updates#roadmap`, `#shipped` and `#milestone-N` are forwarded by a one-line script to
  `/roadmap?from=updates…`. The query is needed because browsers keep the old 301 of `/roadmap` in their cache
  (§6.5).

**`/roadmap`**:

- The three columns and the "Recently shipped" grid, with the same markup as today (`views/updates.php:145-222`).
- Up to 12 shipped milestones are shown; the rest sit in a `<details>`.
- "Read the update" links to `/updates/{id}`.
- Empty: "Nothing on the roadmap right now – see what shipped in the changelog."

**`/suggestions`** (only while the page is on):

- **Filter pills:** *All n · Accepted n · Declined n*, plus *Open n* only when the team shows open suggestions.
- **Cards** contain:
  - a status badge (colours as in `views/admin_community.php:31-34`);
  - the title;
  - a plain-text excerpt; longer text sits behind *Show more*;
  - "Suggested Nov 1, 2026 · Accepted Nov 3, 2026";
  - "Note from the team" as a quote;
  - **Discuss on Discord** (thread link, only when the guild ID is known).
- No names – neither the author nor the team member who decided.
- **Paging:** 20 per page.
- **Empty states:** "No suggestions on the website yet. Post yours in #suggestions on our Discord – once the team
  decides it, it shows up here." and, per filter, "No accepted suggestions yet."
- **`/suggestions/{id}`** redirects to the page and anchor that show it, like `/updates/{id}`.
- **Page off:** the route answers 404 and the pill and footer link are hidden.
- `/updates/`, `/roadmap/` and `/suggestions/` (trailing slash) answer 301 to the address without the slash.

### 3.6 Discord members

- **New forum post while the page is on:** the bot's status embed in the thread gets the field *"Website – Once
  decided, this idea is shown on {host}/suggestions, without your name."* The bot tells the website that it posted
  this note (`web_notice`); only such posts appear by themselves.
- The #suggestions guidelines get the sentence *"Decided ideas are shown on {host}/suggestions without your name."*
  while the page is on, and lose it when it is turned off.
- **Deleting the post:** it disappears from the website within seconds, and at the latest with the bot's daily
  check. The stored text is erased; the title stays for the admin only, with "Deleted in Discord".
- **Deleting only the first message of the post:** the text is erased on the website; the title stays.
- **Editing the post:** the website keeps the text the team decided on (syncing edits is an optional extra, PR 6).
  To take something down, delete the post or ask the team, who can hide it.
- **#updates:** it shows embeds of the published updates.
  - Edits change them in place, without a new ping.
  - Drafts and deleted updates disappear.
  - In a forum channel, every update is its own post titled "{version} – {title}".

### 3.7 Empty, error and limit states

| Situation | Behaviour |
|---|---|
| Nothing set up | Updates tab: "Connect Discord under Discord to announce updates." (unchanged) |
| No destination on, but announcing is the default | Amber banner in the Discord tab and a gray note in the update form: "Updates aren't announced on Discord right now – no destination is on." |
| Bot offline at publish time | Jobs wait; the flash says so. A post the bot hasn't picked up after 24 hours is not sent any more: the chip turns red "Not posted: the bot didn't pick it up within 24 hours" with **Retry** – no surprise pings for old updates. |
| Bot too old for updates | Same waiting and 24-hour rule (an old bot never receives `update.*` jobs, §5.4); the card says how to update it. |
| Bot lost a permission later | Job fails *final* with "The bot can't post in #updates: it needs Send Messages, Embed Links there." → chip red + Retry |
| Discord or the website briefly unreachable | Every bot job is retried with growing pauses (10 s, 20 s, 40 s … 2560 s; 10 tries over about 1.4 hours instead of today's 100 seconds), then it is dead and shown with Retry. |
| Message deleted by hand in Discord | Edit → 10008 → row forgotten, flash "Its Discord post had been deleted – use "Post to Discord" to announce it again." (today's text) |
| Webhook replaced | Old webhook posts become unreachable, as today. They are forgotten on the next edit with "can't be edited from here (…)". |
| Discord rate limit | discord.js queues internally. The webhook gives "Discord is rate limiting us – try again in {n} s." |
| Test spam | "Send test" at most 5 per minute per admin (DB rate limit); a new test replaces one the bot hasn't picked up yet; a bot test expires after 2 minutes. |
| Report too big | The bot keeps the report under 48 KB: it drops threads first, then channels it can't post in, then sets `truncated` ("Some channels aren't listed – the server has more than the bot can report."). Bodies over 64 KiB get 413; a report that still needs more than 60,000 bytes to store gets 413. |
| `/suggestions?page=999` | Clamped to the last page, like `/updates` (`views/updates.php:9`) |
| `/suggestions?status=foo` | Treated as `all` |

---

## 4. Data model

Migrations follow the pattern in `app/src/schema.ts`: `if (version < N) await step(conn)`, idempotent, add-only.
`schema.ts` stores the version only after all steps (`ensureSchema`), so a step that half ran is run again: every DDL
statement goes through a guard (`addColumn`, and a new `addIndex` that checks `SHOW INDEX … WHERE Key_name = ?`
first). The steps are named, not numbered: they take the next free numbers when merged. Plan §3.4 calls the Wave 3
pages migration "v6"; here it is `publicPages` (code-slots-admin §3.1 expects the same "next free number" rule).

### 4.1 Migration `discordDelivery` (PR 2a)

```sql
CREATE TABLE IF NOT EXISTS update_discord_posts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    update_id INT NOT NULL,                       -- no FK: rows outlive a deleted update until Discord confirms
    via VARCHAR(10) NOT NULL,                     -- 'bot' | 'webhook' | 'token' (old settings, until replaced)
    target VARCHAR(80) NOT NULL,                  -- 'bot' | 'webhook:{webhookId}' | 'bot:{channelId}' (token)
    kind VARCHAR(12) NOT NULL DEFAULT 'message',  -- 'message' | 'thread_msg' | 'forum_post'
    channel_id VARCHAR(22) NULL,                  -- channel or thread holding the message
    message_id VARCHAR(22) NULL,                  -- NULL until posted
    state VARCHAR(16) NOT NULL DEFAULT 'queued',  -- queued | posting | posted | failed | removing | remove_failed
    dirty TINYINT(1) NOT NULL DEFAULT 0,          -- content changed while queued/posting
    legacy TINYINT(1) NOT NULL DEFAULT 0,         -- posted with the old token, maybe by another Discord application
    error VARCHAR(300) NULL,                      -- last error; on 'posted' it means "the last edit failed"
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uq_update_via (update_id, via),
    KEY idx_state (state, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

On the outbox (all through `addColumn` / `addIndex`):

```sql
ALTER TABLE community_outbox ADD COLUMN ref VARCHAR(40) NULL;          -- 'post:7', 'test', 'report', 'ticket:3' …
ALTER TABLE community_outbox ADD COLUMN next_try_at DATETIME NULL;     -- pause after an error (§5.4)
ALTER TABLE community_outbox ADD COLUMN claimed_at DATETIME NULL;      -- first handed to the bot
ALTER TABLE community_outbox ADD KEY idx_ref (ref, done_at);
```

**Existing posts** become rows:

```sql
INSERT IGNORE INTO update_discord_posts
    (update_id, via, target, kind, channel_id, message_id, state, legacy, created_at, updated_at)
SELECT id,
       IF(discord_target LIKE 'bot:%', 'token', 'webhook'),
       discord_target,
       'message',
       IF(discord_target LIKE 'bot:%', SUBSTRING(discord_target, 5), NULL),
       discord_message_id, 'posted',
       IF(discord_target LIKE 'bot:%', 1, 0), ?, ?              -- date('Y-m-d H:i:s') like every other write
FROM updates
WHERE discord_message_id IS NOT NULL AND discord_message_id <> '' AND discord_target IS NOT NULL;
```

The columns `updates.discord_message_id` and `updates.discord_target` stay. Node never reads them, but keeps
**writing** them for webhook and token posts in the old format (`webhook:{id}` / `bot:{channel}`), so an older build
after a rollback can still edit and delete those posts (§9).

**Settings v1 → v2** (one time, in the same step):

1. Read `oys_meta.discord` and decrypt it (`decryptData`, already imported in `schema.ts`).
2. Convert it with the pure function `discordSettingsFromV1()` (§4.3).
3. Encrypt and store it again.

**The old bot token is kept for now.** It stays in the same encrypted value, under its old key `bot_token`, and keeps
posting as destination `token` exactly as today, until the admin saves the bot card or a webhook. Then it is
deleted, and its posts become `via='bot', legacy=1` rows when the bot is installed, so the installed bot can still try
to edit and remove them (§5.5.3). Without an installed bot they are dropped like today's unreachable posts (the
messages stay in Discord, `lib/updates.php:746-747, 793-795`). A v1 webhook link that was stored but inactive (`mode=bot`) is
kept as a disabled webhook. A wrong `aes_key` gives the defaults, as today (`lib/updates.php:506`); the step then
stores nothing.

### 4.2 Migration `publicPages` (PR 5)

DDL first (each statement guarded):

```sql
ALTER TABLE community_suggestions ADD COLUMN web_state VARCHAR(8) NOT NULL DEFAULT 'auto';  -- auto | shown | hidden
ALTER TABLE community_suggestions ADD COLUMN web_notice TINYINT(1) NOT NULL DEFAULT 0;      -- author was told in the thread
ALTER TABLE community_suggestions ADD COLUMN removed_at DATETIME NULL;                      -- thread deleted in Discord
ALTER TABLE community_suggestions ADD KEY idx_web (removed_at, web_state, status, id);       -- through addIndex
```

Every existing row gets `web_notice = 0`, so none of them can appear by itself.

**Reserving `suggestions`** – the same move as schema v2 (`lib/schema.php:279-280`, Node `schema.ts`
`createUpdateTables`), but with the notices written first and everything in one transaction (DDL above is outside it,
because MariaDB commits DDL implicitly). A marker makes a re-run skip it; only one process migrates at a time
(`GET_LOCK('oys_migrate')` in `ensureSchema`):

```sql
START TRANSACTION;
SELECT meta_value FROM oys_meta WHERE meta_key = 'reserved_suggestions';                 -- present → skip all
INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at)
    SELECT user_id, 'system', 'Your page address changed', ?, '/dashboard', 0, ?
    FROM pages WHERE slug = 'suggestions' AND address_mode = 'path';
INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at)
    SELECT user_id, 'system', 'A short link to your code page changed', ?, '/dashboard', 0, ?
    FROM code_sites WHERE slug = 'suggestions';
UPDATE pages SET address_mode = 'subdomain' WHERE slug = 'suggestions' AND address_mode = 'path';
INSERT INTO oys_meta (meta_key, meta_value) VALUES ('reserved_suggestions', ?);
COMMIT;
```

- Page notice: *"{base}/suggestions now opens OnYourSite's suggestions page. Your page stays at suggestions.{base} –
  please update links and printed QR codes that use the old address."*
- Code page notice: *"{base}/suggestions no longer forwards to your code page – it now opens OnYourSite's suggestions
  page. Your code page stays at suggestions.{base}."* Own-address code pages only live on subdomains, but
  `on-your.site/{slug}` forwards to them today (`index.php:78-80`); that forward ends for this name.
- Both texts use `baseAuthority()` and are cut like `oys_notify` (`lib/spam.php:115-119`). The type `system` gets the
  default bell icon (`static/js/editor.js:664`).
- New code pages can't take the name: `slugProblem` checks `RESERVED` for pages and code pages alike
  (`lib/helpers.php:256`).

### 4.3 `oys_meta` settings

**`discord`** (encrypted, `encryptData(JSON)` as today, `lib/updates.php:510-518`) – new shape:

```json
{
  "v": 2,
  "auto_post": true,
  "invite_url": "https://discord.gg/abc",
  "bot": { "enabled": true, "channel_id": "1300000000000000001", "channel_type": "announcement", "mention": "",
           "saved_at": "2026-11-01 14:02:11" },
  "webhook": {
    "enabled": false, "url": "https://discord.com/api/webhooks/{id}/{token}",
    "post_in": "channel", "thread_id": "", "thread_verified": false, "test_thread_id": "",
    "display_name": "", "avatar_url": "", "mention": "",
    "checked_at": "2026-11-01 14:02:11", "check_error": "",
    "hook_name": "Captain Hook", "hook_channel_id": "1200…", "hook_guild_id": "1100…"
  },
  "mode": "webhook", "webhook_url": "…", "username": "", "avatar_url": "", "mention": "",
  "channel_id": "", "bot_token": ""
}
```

- The last two lines are the **v1 mirror**. Every save writes them, derived from the v2 fields: an enabled webhook
  becomes `mode=webhook` with its link, name, avatar and ping; otherwise the old token, while it exists, becomes
  `mode=bot` with `bot_token` and `channel_id`; with neither, `mode=webhook` and an empty link (old code can't use the
  installed bot). PHP and the ported `discordSettings` keep only the v1 keys
  (`array_intersect_key`, `lib/updates.php:507`), so they still find the webhook and the token after a rollback.
  The mirror is written for one release; `bot_token` stays as long as the old token is the legacy destination.
- Field values: `channel_type` ∈ text, announcement, forum, thread (copied from the report on save); `post_in` ∈
  channel, forum, thread; `mention` ∈ `''`, everyone, here or a role ID.

`discordSettingsFromV1(v1)` converts the old shape:

- `mode=webhook` with a parseable URL → `webhook.enabled=true` and `url`.
- `display_name` = the old `username` if it passes the new rules, else `''`.
- `avatar_url` and `mention` are copied; PR 1's fields (`post_in`, `thread_id`, `checked_at` …) are copied when
  present.
- `mode=bot` → the old token stays the active destination (`token`); `bot.channel_id` = the old `channel_id` and
  `bot.mention` = `mention` are prefilled, and `bot.enabled` stays `false` until the admin saves the bot card, which
  validates against the report.
- `auto_post` and `invite_url` are copied.

`discordSettings()` also runs this converter when it meets a v1 value, for example after a restore from an old
backup.

**`discord_bot_report`** (plain JSON, UTF-8 without `\u` escapes; holds no secrets) – the last `/_/bot/hello`:

```json
{
  "reported_at": 1793563302, "version": "0.2.0", "runtime": "service",
  "features": ["updates.v1", "suggestions.v2"],
  "guild": { "id": "1100…", "name": "OnYourSite", "community": true },
  "updates_channel_id": "1300…",
  "categories": [ { "id": "1299…", "name": "OnYourSite" } ],
  "channels": [
    { "id": "1300…", "name": "updates", "type": "announcement", "parent_id": "1299…",
      "can_post": true, "can_mention_everyone": false, "missing": [] },
    { "id": "1301…", "name": "general", "type": "text", "parent_id": "", "can_post": false,
      "can_mention_everyone": false, "missing": ["SendMessages"] },
    { "id": "1302…", "name": "changelog", "type": "forum", "parent_id": "", "can_post": true,
      "can_mention_everyone": false, "missing": [] }
  ],
  "threads": [ { "id": "1304…", "name": "Release notes", "parent_id": "1301…", "can_post": true } ],
  "roles":   [ { "id": "1305…", "name": "Update pings", "mentionable": true } ],
  "truncated": false
}
```

Category names appear once in `categories` instead of on every channel. The bot keeps the body under 48 KB and the
site refuses anything that needs more than 60,000 bytes to store, below the 65,535 bytes of `oys_meta.meta_value`
(TEXT, `lib/schema.php:58-61`).

**`discord_bot_test`** (plain JSON):

```json
{"at": "2026-11-01 14:02:11", "state": "queued|ok|failed|expired", "job_id": 41, "channel_id": "…", "error": ""}
```

**`community_pages`** (plain JSON): `{"suggestions": "off|on"}`. The key is missing until the first save, which means
`off`. The page also counts as off while `bot_secret` is empty, because nothing new can arrive without the bot.

### 4.4 Existing data – summary

| Data | What happens |
|---|---|
| Updates already posted | Become `update_discord_posts` rows and stay editable and deletable. Webhook posts: `via=webhook`. Posts made with the old token: `via=token`, `legacy=1`; they keep working through the token until it is replaced, then the installed bot takes them over, and an edit it can't do ("Cannot edit a message authored by another user") says so and offers Forget. |
| Discord settings | Converted to v2 with the v1 mirror; the old token keeps working until the admin chooses a new destination. |
| Suggestions | Get `web_state='auto'`, `web_notice=0`, `removed_at=NULL`: none of them is public, and the page starts off. |
| Pages and code pages named `suggestions` | Path-mode pages move to their subdomain; owners of both get a notice. |
| URLs | `/updates`, `/updates/{id}`, `/updates/feed.xml` and `/updates?page=N` stay. `/roadmap` changes from 301 to 200. Old `/updates#roadmap` anchors are forwarded to `/roadmap?from=updates#roadmap`. Trailing-slash forms answer 301. |

---

## 5. Server

### 5.1 Module layout (`app/src`)

```
discord/                         NEW – Discord delivery for updates, plus helpers other features may use
  index.ts         the stable interface for other features (status-pages): parseWebhookLink(), checkWebhook(),
                   discordRequest(), discordError(), webhookPost/Edit/Delete() – no update-specific types
  settings.ts      discordSettings(), storeDiscordSettings() (writes the v1 mirror), discordSettingsFromV1(),
                   displayNameProblem(), parseMention(), snowflake()
  rest.ts          discordRequest() (moved from the port's updates/discord.ts: fetch, 5 s connect / 10 s total,
                   redirect:'manual', 1 MB cap), discordError(res, via) incl. walkErrors() for 50035
  webhook.ts       parseWebhookLink(), checkWebhook(), webhookPost/Edit/Delete() with ?wait / ?thread_id / thread_name
  payload.ts       updatePayload(u, dest), testPayload(), threadName(u), forEdit(p)   (= oys_discord_update_payload…)
  posts.ts         the state machine of §5.5.3: announce(u), syncEdit(u), remove(u, {deleting}), retry(id),
                   forget(id), applyBotResult(job, result|error); every transition locks the post row
  botReport.ts     saveReport(), report(), botStatus() {installed, online, lastSeen, version, runtime, features,
                   onThisServer, ready}
  admin.ts         handler for the discord_* actions, view model for the Discord tab, status JSON
updates/discord.ts (port) keeps its exported names as re-exports (discordParseWebhook → parseWebhookLink, …), so code
                   written against the port keeps compiling (status-pages cites them).
community/
  community.ts     (port) outboxAdd(action, data, {ref, conn}) – conn = the caller's transaction; supersede(ref, action)
  api.ts           (port) + POST /hello, /ping features, GET /outbox (features, pauses, order, reconcile),
                   done{result,final}, POST /suggestions/thread/{id}, GET /suggestions/threads
  outbox.ts        NEW  action → feature registry, reconcile(), hourly cleanup
  suggestions.ts   NEW  visible(), publicSuggestions(), suggestionPage(id), setWebState()
  suggestionsPage.ts  NEW  GET /suggestions, /suggestions/{id}
updates/
  layout.ts        NEW  shared <head>, nav, hero, sub-nav, footer for /updates, /roadmap, /suggestions
  changelogPage.ts from the ported pages.ts – /updates
  roadmapPage.ts   NEW  /roadmap
  feed.ts          ported feed, unchanged
admin/             Discord, Updates and Community tab views change (§6)
```

`app/src/router.ts` (main host, `dispatch()`):

- `APP_ROUTES` adds `/suggestions`; the app check also passes `^/suggestions/\d+$` and paths starting with
  `/admin/api/` (today only `APP_ROUTES`, `/dashboard/*` and `/updates/\d+` reach the app, `router.ts:74`, so
  `/admin/api/…` would fall to the profile pattern and give 404).
- **Before the profile pattern**, `/updates/`, `/roadmap/` and `/suggestions/` answer 301 to the address without the
  slash (query kept). The profile pattern (`router.ts:75`) allows a trailing slash, so these would otherwise reach a
  page with that slug (§7). The 301 carries `Cache-Control: max-age=3600`, so a later change can't get stuck in
  browsers the way the old `/roadmap` 301 did.

`app/src/app/dispatch.ts`:

- `COOKIELESS` adds `/suggestions` and the regex `^/suggestions/\d+$`.
- The `/roadmap` 301 is replaced by `roadmapPage`.
- New branch `/admin/api/discord-status`.
- The logged-out branch answers `401 {"ok":false,"error":"Please log in again."}` for `/admin/api/` as it does for
  `/dashboard/api/` (today everything else gets a 302 to `/login`, `dispatch.ts:45-46`); a non-admin gets
  `403 {"ok":false,"error":"Admins only."}` there instead of the redirect to `/dashboard`.

`app/src/helpers.ts`: `RESERVED` adds `'suggestions'`.

### 5.2 Public routes

| Method + path | Auth | Input | Response |
|---|---|---|---|
| `GET /updates` | public, cookieless | `page` (int, clamped) | 200 HTML; the roadmap sections are replaced by the sub-nav and the forward script |
| `GET /updates/{id}`, `/updates/feed.xml` | public | — | unchanged |
| `GET /roadmap` | public, cookieless | any query is ignored (`?from=updates`) | 200 HTML (was 301), canonical `/roadmap` |
| `GET /suggestions` | public, cookieless | `status` ∈ {all, open, accepted, declined} (else all), `page` (int, clamped) | 200 HTML; the 404 page while the page is off |
| `GET /suggestions/{id}` | public, cookieless | — | 302 to `/suggestions[?page=N]#suggestion-{id}` if visible, else 302 `/suggestions` (404 while off) |
| `GET /updates/`, `/roadmap/`, `/suggestions/` | public | query kept | 301 to the address without the slash, `Cache-Control: max-age=3600` |

**Visible** means: the page is on (`community_pages.suggestions = 'on'` and `bot_secret` set) **and**
`removed_at IS NULL` **and** (`web_state = 'shown'` **or** (`web_state = 'auto'` **and** `web_notice = 1` **and**
`status <> 'open'`)). One function, `visible()`, builds this SQL and is the only place that decides. Queries:

- **List:** `SELECT id, thread_id, title, body, status, reason, created_at, decided_at FROM community_suggestions
  WHERE <visible> [AND status = ?] ORDER BY id DESC LIMIT 20 OFFSET ?`
- **Counts:** `SELECT status, COUNT(*) … WHERE <visible> GROUP BY status`.
- **Permalink page:** `intdiv(COUNT(*) WHERE <visible> AND id > ?, 20) + 1`.

`author_id`, `author_name` and `decided_by` are never selected for public pages.

**Indexing:** canonical URLs `/updates` (page N: `/updates?page=N`), `/roadmap` (also for `?from=updates`) and
`/suggestions`. Filtered suggestion views (`status` other than all) carry `<meta name="robots" content="noindex,
follow">`, so only one version of the list is indexed.

**Plain text for the website** – `suggestionText(body)`:

1. Replace Discord tokens: `<@id>`/`<@!id>` → "@member", `<@&id>` → "@role", `<#id>` → "#channel", `<a?:name:id>` →
   ":name:".
2. Collapse runs of more than 2 blank lines.
3. Escape with `e()` and print inside `whitespace-pre-line`. Nothing is rendered as Markdown and links are not made
   clickable.
4. The excerpt is the first 280 code points; the full text (max 4000) sits in `<details>`.

### 5.3 Admin routes

All admin POSTs keep today's contract: `POST /admin`, session admin (`is_admin`), field `csrf`, dispatch order
`community_action` → `hc_action` → `oys_action` (`views/admin.php:37-65`), then a 302 with a flash. Fields are read
as strings; arrays are rejected (`map-admin.md` §1.2 note).

| `oys_action` | Input (validation) | Effect | Flash / redirect |
|---|---|---|---|
| `discord_bot_save` | `enabled` (bool), `channel_id` (snowflake, in the latest report with `can_post`), `mention` (`''` / everyone / here / role in the report; `everyone`/`here` need `can_mention_everyone`, a role needs `mentionable` or `can_mention_everyone`) | store `discord.bot` with `channel_type` and `saved_at`; queue `bot.report` (ref `report`, replacing an unclaimed one); delete the old token if present (§4.1) | "Saved – the bot checks #{name} now." / "The bot no longer announces new updates." · `#discord` |
| `discord_bot_test` | bot installed, channel chosen; rate limit 5/min | supersede an unclaimed test job; `outboxAdd('update.test', …, {ref:'test'})`; `discord_bot_test = {state:'queued', job_id}` | "Test message queued – the bot posts it within a few seconds." |
| `discord_bot_refresh` | bot installed | `outboxAdd('bot.report', {}, {ref:'report'})`, replacing an unclaimed one | "The bot sends its channel list within a few seconds." |
| `discord_webhook_save` | `enabled`; `webhook_link` (optional if one is saved; §5.5.1); `post_in`; `thread_id` (snowflake when `post_in=thread`); `display_name` (rules §5.5.1); `avatar_url` (https, `cleanUrl`, ≤ 500); `mention` (as today `lib/updates.php:570-574`); not the bot's channel | GET check (§5.5.2); store; delete the old token if present | see §3.2 |
| `discord_webhook_test` | webhook enabled; rate limit 5/min | synchronous test post (payload of `lib/updates.php:986-992`); forum mode: into `test_thread_id`, or a new post after the confirmation | "Test message sent – check your Discord channel." or the mapped error |
| `discord_webhook_remove` | — | delete `discord.webhook`; delete its post rows (messages stay in Discord) | "Webhook removed. Its earlier posts stay in Discord." |
| `discord_token_test`, `discord_token_remove` | old token present | test as today / delete the token and convert its rows (§4.1) | "The old bot token is deleted from the website." |
| `discord_defaults_save` | `auto_post` (bool), `invite_url` (https, `cleanUrl`, as `lib/updates.php:583-587`) | store | "Discord settings saved." |
| `discord_post_retry` | `id` of a `failed`, `remove_failed` or `posted`-with-error row | failed → announce; remove_failed → remove; posted with error → queue the edit; the dead job is marked done | per destination |
| `discord_post_forget` | `id`; rows in `queued`/`removing` only after 10 minutes, `posting` only after 2 minutes | delete the row; mark its open or dead jobs done (`last_error='forgotten'`) | "Forgotten. If the message is in Discord, it stays there." |
| `update_save`, `update_publish`, `update_discord`, `update_discord_remove`, `update_delete` | unchanged inputs (`map-admin.md` §2.4) | go through `discord/posts.ts` (§5.5.3) instead of the single-target functions | texts of §3.3; existing texts reused where the case is the same |
| `discord_save`, `discord_test`, `discord_disconnect` (old) | — | nothing | error "This form is out of date – please reload the page." · `#discord` |

| `community_action` | Input | Effect |
|---|---|---|
| `suggestion_decide` | unchanged | as today (`lib/community.php:329-341`); the outbox job carries S with `web` (below). Whether it appears on the website follows from `visible()`. |
| `suggestion_web` | `id`, `state` ∈ {`shown`, `hidden`} | `UPDATE community_suggestions SET web_state=?, updated_at=? WHERE id=?` → "Suggestion #{id} is now shown on the website." / "…hidden on the website." |
| `suggestions_page` | `suggestions` ∈ {off, on} | store `community_pages`; queue `suggestions.notice` {on, text} (ref `notice`, replacing an unclaimed one) → "The suggestions page is on." / "…off." |

The suggestion shape `S` (`lib/community.php:84-98`) gains `web: {notice: bool, host: string}` – `notice` is true
while the page is on. The bot ignores unknown keys, so old bots keep working.

**Status JSON** – `GET /admin/api/discord-status?updates=12,13`:

- Auth: logged-in admin; logged out → `401 {"ok":false,"error":"Please log in again."}`; non-admin → 403 JSON
  (§5.1).
- Headers: `Cache-Control: no-store` and `X-Robots-Tag: noindex` (`/admin` is already disallowed in `robots.txt`).
- At most 100 IDs.

```json
{"ok": true,
 "bot": {"installed": true, "online": true, "last_seen": 1793563302, "version": "0.2.0", "ready": true,
         "checking": false, "channel": "#updates", "test": {"state": "ok", "at": "2026-11-01 14:02:11", "error": ""}},
 "webhook": {"enabled": true, "checked_at": "2026-11-01 13:55:02", "error": ""},
 "posts": [{"id": 7, "update_id": 12, "via": "bot", "state": "posted", "error": "", "forget": false}]}
```

The admin page polls it every 3 s, for at most 2 minutes, but only while a row on the page is `queued`, `posting` or
`removing`, the bot card is checking, or a test is `queued`. It swaps the chips and shows a toast (`OYSUI.toast`,
custom-dialogs).

### 5.4 Bot API (`/_/bot/*`, signed exactly as today, `map-admin.md` §1.9)

**Unchanged:** the envelope, the HMAC over the raw `REQUEST_URI` with its query, the 300 s skew, snowflakes as strings
and `oys_bot_seen`. **One change for every route:** a body over 64 KiB now gets
`413 {"ok":false,"error":"Request too large."}` instead of `401 "Unauthorized."` (`lib/community.php:187`), so the
bot can tell "too big" from "wrong secret". The size is still checked before the signature.

**`GET /_/bot/ping`** – the answer gains `"features": ["hello", "updates.v1", "suggestions.v2"]`, so
`index.js --check` can print what the website supports without a full report.

**`POST /_/bot/hello`** – NEW.

- Body: the report of §4.3, without `reported_at`.
- Validation:
  - `version` at most 20 chars of `[0-9a-z.+-]`; `runtime` ∈ {service, docker, other};
  - `features`: unknown names are dropped (forward compatible), not rejected;
  - every ID a snowflake;
  - names through `cleanText(…, 100)`;
  - `type` ∈ {text, announcement, forum};
  - `missing` ⊂ {ViewChannel, SendMessages, SendMessagesInThreads, EmbedLinks, ReadMessageHistory, ManageThreads};
  - caps of 50 categories, 200 channels, 50 threads and 100 roles;
  - the JSON to store must fit in 60,000 bytes, else 413.
- Any other violation → `400 {"ok":false,"error":"Invalid report."}`.
- Stores `discord_bot_report` with `reported_at = time()`.
- Answer: `200 {"ok":true,"site":"<mainUrl('/')>","features":["hello","updates.v1","suggestions.v2"]}`.

**`GET /_/bot/outbox?f=<features>`** – extended. There is no long poll: the bot keeps polling every `POLL_SECONDS`.

- `f` is the comma-separated feature list of the polling bot. It is part of the signed URI. A request without `f` (bot
  0.1) has no features.
- Each action belongs to a feature (registry in `community/outbox.ts`): `suggestion.decided`, `ticket.reply` and
  `ticket.close` to none; `update.*` and `bot.report` to `updates.v1`; `suggestions.notice` to `suggestions.v2`. Only
  actions the polling bot supports are handed out. So a downgraded or old bot never gets a job it would answer with
  "Unknown action" ten times (`discord-bot/src/outbox.js:21-29`), whatever the last hello said.
- Selection: `done_at IS NULL AND attempts < 10 AND (next_try_at IS NULL OR next_try_at <= now)`, and no earlier job
  with the same `ref` that is still open (not done, fewer than 10 attempts), `ORDER BY id LIMIT 20`.
- Before answering, in one transaction that locks, for each selected `update.*` job, its post row and then the job
  (lock order of §5.5.3):
  - `update.post` whose post row is `removing` without a message ID: never claimed → marked done
    (`last_error='cancelled'`) and the row deleted; already claimed → handed out with `only_if_posted: true`;
  - `update.post` older than 24 hours: never claimed → done (`'expired'`), row `failed` with "Not posted: the bot
    didn't pick it up within 24 hours."; claimed (the bot took it and then went away) → handed out with
    `only_if_posted: true`, so the bot only reports an earlier message and never posts a day-old announcement;
  - `update.test` older than 2 minutes → done (`'expired'`), `discord_bot_test.state = 'expired'`;
  - `update.edit` whose row is not `posted` → done (`'skipped'`);
  - an `update.post` that was claimed before is handed out with `recheck: true`;
  - `claimed_at = now` where it is still NULL.
- Same answer shape as today.

**`POST /_/bot/outbox/{id}/done`** – extended; old bots keep working:

```json
{"error": "", "final": false,
 "result": {"message_id": "…", "channel_id": "…", "missing": false, "found": false, "warning": ""}}
```

- Everything runs in one transaction with the locks of §5.5.3. A job that is already done answers `{"ok":true}` and
  changes nothing, so a repeated `/done` is harmless.
- **`error === ''`:** `done_at = now`, as today; for `update.*` the result is applied through `applyBotResult()`.
- **`error` set:** `attempts = attempts + 1` (or `10` when `final` is true), `last_error = error`,
  `next_try_at = now + min(10 s · 2^(attempts − 1), 1 h)` with the new `attempts` – pauses of 10, 20, 40 … 2560 s. When the job is now dead (`attempts >= 10`), the failure is
  applied to the post row (§5.5.3: a dead post → `failed`, a dead edit → stays `posted` with `error`, a dead delete →
  `remove_failed`, a dead test → `discord_bot_test.state = 'failed'`).
- Answer: `{"ok":true}`.

**`POST /_/bot/suggestions`** (existing): the answer's `S` carries `web`.

**`POST /_/bot/suggestions/{id}`** (existing, stores `status_message_id`): also accepts `"web_notice": true`, sent by
the bot when the status message it posted contains the website note → `web_notice = 1`.

**`POST /_/bot/suggestions/thread/{thread_id}`** – NEW, `suggestions.v2`:

- Body `{"deleted": true}` → `removed_at = now`, `body = ''`; `{"body_deleted": true}` → `body = ''`.
- Answer: `200 {"ok":true}`, or `404 {"ok":false,"error":"Suggestion not found."}` (the bot sends the starter-message
  case without knowing whether the thread is a suggestion).

**`GET /_/bot/suggestions/threads?after=<id>`** – NEW, for the daily check:
`{"ok":true,"items":[{"id":12,"thread_id":"…","has_body":true}],"next":13}` – rows with `removed_at IS NULL`, 100 per
page, ordered by `id`.

### 5.5 Delivery logic

#### 5.5.1 Validation (pure, `discord/settings.ts` and `discord/webhook.ts`)

**`parseWebhookLink(raw)`** → `{id, token, threadId}` or null:

- `trim`, then the existing pattern (`lib/updates.php:534`) or the `discord_api_base` variant (`:537-539`).
- Additionally allows a query of **only** `thread_id=<snowflake>` and/or `wait=true|false`. `thread_id` becomes
  `post_in=thread`, and `wait` is dropped.
- Anything else → "That isn't a Discord webhook link. In Discord: channel settings → Integrations → Webhooks → Copy
  Webhook URL."

**`displayNameProblem(name)`** – 1–80 characters after `cleanText`. Rejected, case-insensitive, with these messages:

- contains `@` → *"Display name: Discord doesn't allow "@" in names."*
- contains `#` → *"Display name: Discord doesn't allow "#" in names."*
- contains `:` → *"Display name: Discord doesn't allow ":" in names."*
- contains ```` ``` ```` → *"Display name: Discord doesn't allow "```" in names."*
- contains `discord` or `clyde` → *"Display name: Discord doesn't allow the word "{w}" in names."*
- equals `everyone` or `here` → *"Display name: Discord doesn't allow the name "{w}"."*

**Thread ID** – `/^\d{15,25}$/`, else *"Thread ID: in Discord turn on Developer Mode, right-click the thread → Copy
Thread ID."*

#### 5.5.2 Discord HTTP (webhook and old token; `discord/rest.ts`)

`discordRequest` ports `oys_discord_request` (`lib/updates.php:614-653`) with the same limits:

- user agent `DiscordBot (https://{baseHost}, 2.2)`;
- no redirects;
- 10 s timeout;
- `?wait=true` on create.

New:

- `GET` for the check.
- `?thread_id=` on create, edit and delete when `kind` is `thread_msg` or `forum_post`.
- `thread_name` (100 chars) when `post_in=forum`.
- The answer's `channel_id` is stored as the post's thread.

**`discordError(res, via)`** extends `lib/updates.php:655-675`:

| Status / code | Text |
|---|---|
| 0 | "Couldn't reach Discord ({timeout \| DNS lookup failed \| connection refused \| TLS error})." (from `err.cause.code`) |
| 401 / 50027 (webhook) | "Discord doesn't accept this webhook link any more – copy it again in Discord." |
| 403 / 50013, 50001 | bot: "The bot can't post in #{name}: it needs {missing} there."; webhook: today's 403 text |
| 403 / 50005, 50001 on a `legacy` row | "Posted by a different bot – it can't be edited from here." (Forget is offered) |
| 404 / 10015 | "Discord doesn't know this webhook – it was deleted or the link is incomplete." |
| 404 / 10003 | "Discord can't find this channel or thread – it may have been deleted." |
| 400 / 50035 | "Discord rejected the message – {path}: {message}". The path comes from walking `errors` recursively to the first `_errors[0].message`, e.g. `username: Username cannot contain "@"`. |
| 400 / 220001 | the forum hint of §3.2 |
| 400 / 220003 | "Threads can only be created in forum channels – choose "In the channel" for this webhook." |
| 400 / 50008 | "This isn't a text channel – choose a text, announcement or forum channel." |
| 429 | "Discord is rate limiting us – try again in {ceil(retry_after)} s." |
| ≥ 500 | "Discord had a problem ({status}) – please try again in a moment." |

**Check on save** – `checkWebhook()`: `GET {base}/v10/webhooks/{id}/{token}`.

- 200 → `hook_name`, `hook_channel_id`, `hook_guild_id`, `checked_at`, `check_error=''`.
- 401/404 → reject the save.
- 0, 429 or ≥ 500 → save with `check_error` and the warning text.

#### 5.5.3 Post state machine (`discord/posts.ts`; pure transition table + DB wrapper)

**Concurrency rules** (they hold for the admin actions and for `/done` alike):

1. Every transition runs in one transaction (`db.ts` `transaction()`) that first locks the post row with
   `SELECT … FROM update_discord_posts WHERE id = ? FOR UPDATE`, then – where a job is involved – the outbox row.
   The lock order is always post row → outbox row; `/done` first reads the job's `post_id` without a lock. A
   deadlock (1213) is retried once.
2. A missing row is claimed with `INSERT IGNORE` (unique key `uq_update_via`). Only the request whose insert
   succeeded goes on; the other one locks the existing row and decides from its state (e.g. "Already posting…").
3. Discord is never called inside a transaction. The synchronous paths (webhook, old token) claim the row
   (`posting`), commit, call Discord, then lock again and apply the answer only with
   `UPDATE … WHERE id = ? AND state = 'posting'`.
4. A queued job and its row change together: `outboxAdd(…, {conn})` writes in the caller's transaction.

| Event \ state | (no row) | `queued` | `posting` | `posted` | `failed` | `removing` | `remove_failed` |
|---|---|---|---|---|---|---|---|
| announce | webhook/token: claim `posting` → call → `posted` / `failed`; bot: insert `queued` + `update.post` | no-op ("Already queued for the bot.") | "Already posting…" | edit instead (as PHP) | claim `posting` / `queued` again (`WHERE state='failed'`) | "Still removing the previous Discord post – try again in a moment." | "Its earlier Discord post couldn't be removed yet – use Retry or Forget on it first." |
| edit | — | `dirty=1` | `dirty=1`; patched right after the post | webhook/token: PATCH (missing → delete row + note; unreachable → delete row + note; failure → stays `posted` with `error`); bot: supersede unclaimed edits, queue `update.edit` | — | — | — |
| remove (unpublish/delete) | — | job unclaimed → cancel it and delete the row; claimed → `removing` | "Still posting…" | webhook/token: DELETE (ok/missing/unreachable → delete row; transient → keep, `error`); bot: `removing` + `update.delete` | delete row | — | queue the delete again |
| bot result: post ok | — | `posted`, `message_id`, `channel_id`; if dirty → `update.edit`, `dirty=0` | — | — | — | store `message_id`, queue `update.delete` | — |
| bot result: `only_if_posted` | — | found → `posted` with IDs (dirty → `update.edit`); not found → `failed` "Not posted: the bot didn't pick it up within 24 hours." | — | — | — | found → store IDs, queue `update.delete`; not found → delete row | — |
| bot result: post failed (final/dead) | — | `failed`, `error` | — | — | — | delete row | — |
| bot result: edit ok | — | — | — | clear `error` | — | — | — |
| bot result: edit missing (10008) | — | — | — | delete row | — | — | — |
| bot result: edit failed (final/dead) | — | — | — | stays `posted`, `error` (legacy + 50005/50001: "Posted by a different bot…") | — | — | — |
| bot result: delete ok / missing | — | — | — | — | — | delete row | — |
| bot result: delete failed (final/dead) | — | — | — | — | — | `remove_failed`, `error` | — |
| retry | — | — | — | with `error`: queue `update.edit` | announce | — | remove |
| forget | — | after 10 min: delete row, job done | after 2 min: delete row | delete row | delete row | after 10 min: delete row, job done | delete row |
| cleanup (hourly; a `posting` row also whenever it is read) | — | — | older than 2 min → `failed` "The website stopped while posting – the message may be in Discord. Check the channel before you retry." | update deleted → `remove_failed` "The update was deleted, but its Discord post is still there." | — | — | — |

A result for a row that no longer exists (forgotten meanwhile) is ignored; the Forget dialog says that the message
may stay in Discord.

**When jobs are queued.**

- *New posts* go to the bot when `bot.enabled` is set and the bot is installed. They are queued even while the bot
  is offline or too old; it gets them once it polls with `updates.v1` (§5.4), and the 24-hour rule applies.
- *Edits and removals of existing bot posts* are queued whenever the bot is installed – also after **Turn off**,
  which only stops new announcements.
- Without an installed bot (`bot_secret` removed), an edit leaves the row `posted` with the error "not updated – the
  Discord bot isn't set up", and a removal turns it into `remove_failed` with today's note "Discord isn't connected,
  so its post there was not removed – please delete it in Discord yourself." (`lib/updates.php:819-830`).

**Job payloads** (`community_outbox.payload`; `ref` is a column):

```json
{"action": "update.post",   "data": {"post_id": 7, "update_id": 12, "channel_id": "1300…", "kind": "announcement",
  "thread_name": "2.5 – Own pages for the roadmap", "recheck": false, "only_if_posted": false,
  "message": {"content": "<@&1305…>", "embeds": [{"title": "…", "url": "…", "color": 2278750, "author": {"name": "New"},
              "footer": {"text": "OnYourSite Updates"}, "timestamp": "2026-11-01T13:02:11Z", "description": "…"}],
              "allowed_mentions": {"parse": [], "roles": ["1305…"]}}}}            ref post:7
{"action": "update.edit",   "data": {"post_id": 7, "channel_id": "…", "message_id": "…", "kind": "forum_post",
  "thread_name": "…", "message": {"embeds": [ … ]}}}                                ref post:7
{"action": "update.delete", "data": {"post_id": 7, "channel_id": "…", "message_id": "…", "kind": "message"}}   ref post:7
{"action": "update.test",   "data": {"channel_id": "…", "kind": "text", "message": {"embeds": [ …test embed… ]}}}  ref test
{"action": "bot.report",    "data": {}}                                                                    ref report
{"action": "suggestions.notice", "data": {"on": true,
  "text": "Decided ideas are shown on on-your.site/suggestions without your name."}}                  ref notice
```

Ticket jobs get `ref = 'ticket:{id}'` and suggestion jobs `ref = 'suggestion:{id}'`, so the pauses after errors can't
reorder a reply and the close of the same ticket.

**Payload rules:**

- `updatePayload` is today's `oys_discord_update_payload` (`lib/updates.php:678-699`) and is used for every
  destination.
- `withMention` keeps its rules (`:701-721`).
- `username` and `avatar_url` apply to the webhook only.
- Edits strip `content`, `allowed_mentions`, `username` and `avatar_url` (`:752-755`).
- The forum `thread_name` is `mbSubstr((version ? version + ' – ' : '') + title, 0, 100)`.

### 5.6 Bot changes (`discord-bot/`, version 0.2.0, no new dependencies)

| File | Change |
|---|---|
| `src/updates.js` NEW | Handlers `update.post/edit/delete/test` (below) and `findOwnPost()`. |
| `src/report.js` NEW | `buildReport()` from the gateway cache: text, announcement and forum channels except those in the Tickets category (`SUPPORT_CATEGORY_ID`); active threads except those of `SUGGESTION_FORUM_ID`; roles (no `@everyone`, no managed roles); `permissionsFor(me)`. Byte budget 48 KB (`Buffer.byteLength`): drop threads, then channels without `can_post`, then cut the list and set `truncated`. `sendReport()` runs on ready, every 10 minutes, on channel/role/thread create/update/delete (debounced 5 s) and on `bot.report`; it keeps the hello answer (`siteFeatures`). `runtime` comes from `OYS_BOT_RUNTIME` (service / docker, set by the installer and the Dockerfile), else `other`. |
| `src/outbox.js` | Polls `GET /_/bot/outbox?f=<features>` every `POLL_SECONDS`, as today (`setInterval`, no long poll). Handlers may return a `result`, passed to `/done`; a thrown error with `err.final = true` passes `final: true`. A `/done` that fails is kept in memory (at most 100) and sent again before the next poll; an item whose `/done` is still pending is not run again. |
| `src/site.js` | User agent with the real version (`OnYourSite-Bot/0.2.0`); a 413 is logged as "too big". |
| `src/suggestions.js` | Status embed: field "Website" with the note of §3.6 when `S.web.notice`; the existing status-message call also sends `web_notice: true`. `Events.Raw` listener: `THREAD_DELETE` with `d.parent_id === SUGGESTION_FORUM_ID` → `POST /_/bot/suggestions/thread/{d.id}` `{deleted:true}`; `MESSAGE_DELETE` with `d.id === d.channel_id` (the first message of a forum post) → `{body_deleted:true}`. Daily check (§5.7). Handler `suggestions.notice`: adds or removes the sentence in the forum's guidelines (`topic`), leaving the rest of the text as it is. `applyDecision` is unchanged. Sync calls are only made when the site lists `suggestions.v2`. |
| `src/setup.js` | `CHANNEL_SPECS` (first entry `UPDATES_CHANNEL_ID`: name `updates`, announcement on community servers else text, read-only for members, bot may write, topic "Release notes and updates from OnYourSite.") and `ensureNamedChannel(key)`: stored ID, else a channel with that name of type text, announcement or forum, used **unchanged**; otherwise created inside the "OnYourSite" category. The full setup uses it for #updates; the new CLI `--discord-channel <KEY> <guild>` runs only this. |
| `src/config.js` | Optional `UPDATES_CHANNEL_ID`. |
| `src/welcome.js`, `src/commands.js` | Welcome field "Updates" `<#id>`; `/bot-status` field "Updates channel". |
| `index.js` | Registers the outbox handlers, `report.js`, the raw listener and the daily check; `--discord-channel`; sends hello after ready; `SIGTERM` (systemd stop) and `SIGINT`: stop polling, send pending `/done` calls (at most 3 s), `client.destroy()`. |
| `Dockerfile` | `ENV OYS_BOT_RUNTIME=docker`. |
| `install.sh` | §9. |
| `README.md` | Updates section. |

**`update.*` handlers** (discord.js 14.28):

- **Before posting:**
  1. `channel = await client.channels.fetch(id)`. Unknown → final "The channel no longer exists.".
  2. `perms = channel.permissionsFor(guild.members.me)`.
  3. Check that ViewChannel, SendMessages (SendMessagesInThreads for threads) and EmbedLinks are present. Any missing
     → final "The bot can't post in #{name}: it needs {list} there."
  4. `allowed_mentions` is converted to `allowedMentions`.
- **`findOwnPost()`**, used when `recheck` or `only_if_posted` is set: text, announcement and thread → the last 50
  messages (`channel.messages.fetch({limit: 50})`) for one by the bot whose first embed has the update's URL; forum →
  the forum's active threads owned by the bot with the same name, then their starter message's embed URL. Found →
  `{message_id, channel_id, found: true}` without posting. With `only_if_posted` and nothing found → `{found: false}`
  and nothing is posted.
- **`post`:**
  - **forum** → `channel.threads.create({ name: thread_name, message: { content, embeds, allowedMentions } })`. The
    result is `{message_id: thread.id, channel_id: thread.id}`, because a forum's starter message has the thread's
    ID.
  - **thread** → if archived, `setArchived(false)` first, then `send`.
  - **text/announcement** → `channel.send({ …, nonce: 'oys-post-{post_id}', enforceNonce: true })`. The nonce
    catches a repeat within Discord's window of a few minutes; `findOwnPost()` and the kept `/done` cover longer
    gaps (a website outage between the post and `/done`).
- **`edit`:** `channel.messages.fetch(message_id)`. Discord error 10008 → result `{missing:true}`. Then
  `msg.edit({ embeds })`. For a forum post whose name differs, also `thread.setName(thread_name)`.
- **`delete`:** a forum post is deleted with `thread.delete()` (ManageThreads is already in the invite,
  `src/setup.js:17-19`). If that gives 403, fall back to deleting the starter message. Other messages:
  `msg.delete()`, where 10008 → `{missing:true}`.
- **Errors:**
  - final: 400, 403, 404 and 50008;
  - not final: network errors and ≥ 500;
  - 429 is handled by discord.js itself.

**Why raw gateway events for deletions.** In discord.js 14.28, `ThreadDeleteAction` only emits `threadDelete` for a
thread that is in the cache (`client/actions/ThreadDelete.js:9-19`), and a `THREAD_UPDATE` for an uncached thread
only adds it to the cache (`actions/ChannelUpdate.js:34-35`, `websocket/handlers/THREAD_UPDATE.js:6-7`). After every
restart only active threads are cached, and forum posts archive by themselves – so the normal events would miss most
deletions. `Events.Raw` is emitted for every dispatch before any cache handling
(`websocket/WebSocketManager.js:231-236`). Events missed while the bot was offline are caught by the daily check.

### 5.7 Background work

- **No new cron jobs or systemd timers.** The bot's existing polling (same interval as today) drives the delivery.
- **The bot report** runs every 10 minutes inside the bot.
- **Daily suggestion check** inside the bot: 10 minutes after ready, then every 24 hours. It pages through
  `GET /_/bot/suggestions/threads` and calls `client.channels.fetch(id, {force: true})` – at most one request per
  second:
  - 10003 (Unknown Channel) → `{deleted:true}`;
  - thread found and `has_body` → `thread.messages.fetch(thread.id)`; 10008 → `{body_deleted:true}`;
  - 50001 / 403 → skipped (lost access isn't a deletion); other errors → tried again the next day.
- **Hourly cleanup** inside the Node service (`unref`'d interval, guarded by `withNamedLock('oys_outbox_cleanup', 0,
  …, 'fail')` so only one process runs it):
  - `DELETE FROM community_outbox WHERE done_at < ? LIMIT 1000`, for rows done more than 30 days ago;
  - `posting` rows older than 2 minutes → `failed` (text in §5.5.3);
  - `posted` rows of deleted updates → `remove_failed` (they are still in Discord; nothing is deleted silently).
- If status-pages brings a shared scheduler, the cleanup moves there.

---

## 6. UI (all texts English; classes reused from the cited markup)

### 6.1 Admin → Discord (replaces `views/admin_updates.php:259-354`)

**Status header.** The layout is `:261-273`: icon box, title, subline. One row per destination:

- **Bot** – `bx-bot`, with a badge:
  - Online → `bg-emerald-500/15 text-emerald-400`;
  - Checking → amber;
  - Offline → `bg-white/10 text-gray-400`;
  - Not installed → amber.
- **Webhook** – `bx-link`, with a badge: Checked / Not verified / Off.
- **Old bot token** – `bx-key`, only while one is stored: "Posting with the old token".

**Banner** (amber, `rounded-xl border border-amber-500/30 bg-amber-500/5`, like `views/admin_community.php:63`) while
announcing is the default but no destination is on: "Updates aren't announced on Discord right now – no destination
is on."

**Card 1 "Post with the bot"**, marked with the badge "Recommended".

- **Container** (`:275`): `bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6`.
- **Own form** `id="discordBotForm"` with `autocomplete="off"`. It has **no** text input named
  `username`/`email` and **no** `type="password"`.
- **Call to action** when `updates_channel_id` is set and not yet used:
  `rounded-xl border border-[#5865F2]/40 bg-[#5865F2]/10 p-4` with *"The bot is ready to post in #updates."* and the
  primary button **Use #updates**, a separate one-field form.
- **Update instructions** (state table of §3.1) as a `<code>` line with the real code folder; for a bot that doesn't
  run from this server both commands are shown.
- **Field "Channel"**: a `<select>` with class `$in` (`:12`).
  - Option groups: "Announcement channels", "Text channels", "Forum channels – each update becomes a new post",
    "Threads".
  - Option label "#name (category)". Channels without access are `disabled` and labelled " – no access".
  - With `truncated`: the note "Some channels aren't listed – the server has more than the bot can report."
- **Field "Ping"**: Nobody / @everyone / @here / mentionable roles.
  - Not allowed options are disabled with " – the bot may not ping".
  - Help text: "Who gets notified when an update is posted. To let the bot ping @everyone, give it "Mention
    @everyone, @here and All Roles" in this channel's settings."
- **Checkbox** "Announce new updates with the bot" (`accent-[#5865F2]`, `:328`).
- **Buttons:**
  - **Save** (primary, `:330`);
  - **Send test** and **Refresh list** (`$btn`, `:14`).
- **Status line:** "Checking with the bot…" / "Ready – the bot can post in #updates." / the problem (red); then "Last
  test: posted in #updates at 14:02" (emerald), the error (red) or "The bot didn't answer within 2 minutes…".

**Card "Old bot token"** (only while one is stored): "Updates are posted with a bot token stored on the website (old
setup), in #{channel}. Switch to the installed bot above or to a webhook – the token is then deleted from the
website." Buttons **Send test** and **Delete token** (`data-confirm`: "Delete the old bot token? Updates posted with
it are then edited and removed by the installed bot, if it can."). There is no field to enter a token (§11 Q3).

**Card 2 "Post with a webhook"**, with "Optional – e.g. for a second server" in gray.

- Own form `id="discordWebhookForm"` with `autocomplete="off"`.
- **No webhook saved:**
  - `<input type="text" name="webhook_link" inputmode="url" spellcheck="false" autocapitalize="off" autocomplete="off"
    data-1p-ignore data-lpignore="true" data-bwignore placeholder="https://discord.com/api/webhooks/…">`.
- **A webhook is saved:**
  - the saved line of §3.2;
  - **Replace link**, which reveals the input with a little JS and focuses it.
- **Where to post:** radio cards (pattern `:281-288`), with the forum/thread note of §3.2 under the two last cards and
  "Thread not verified yet" until the first post into it succeeds.
- **Display name** (`name="display_name"`, help with the rules), **Avatar image link**, **Ping** (text, as today).
- Buttons **Save**, **Send test** (forum mode, first time: `data-confirm` "Send a test? In a forum channel this
  creates a post "OnYourSite test"; later tests go into that post."), and **Remove** (`data-confirm`: "Remove the
  webhook? Its earlier posts stay in Discord and can't be edited from here any more.").

**Card 3 "Defaults":**

- "Announce new updates on Discord by default";
- "Invite link for visitors", with the help "Used for "Get updates on Discord" and "Join the Discord" on /updates,
  /roadmap and /suggestions.".

**Card 4 "Discord posts"** – the table of §3.3: `divide-y divide-bordercolor`, rows like `:119-144`.

**Help boxes** (`:335-352`):

- "Get a webhook link" stays.
- "Use a bot" becomes "Set up the bot": "The server installer sets up the bot and its channels. It runs on your server
  and posts updates by itself – no token needed here."

**Field errors.** The PRG flow keeps the flash (`views/admin.php:351-360`). The handler also sets
`admin_error_field`, and the view adds `ring-1 ring-red-500` to that input. Non-secret values are kept after an error.

**Field names.** None of the new forms reuses `webhook_url`, `bot_token`, `username` or `channel_id` from another
form. A browser can't fill one form's field into the other any more, because each form only posts its own fields.

**Confirmations and toasts** use custom-dialogs (`data-confirm`, `data-confirm-text`, `data-confirm-ok`,
`data-confirm-tone`; `OYSUI.toast`). No inline `onsubmit`.

### 6.2 Admin → Updates (`views/admin_updates.php:38-148`)

- **Discord line** (`:91-100`):
  - When posted: "On Discord (bot in #updates, webhook) – changes are synced, drafts are removed there."
  - Otherwise the checkbox text stays, with a gray suffix listing the active destinations, or the "no destination is
    on" note of §3.7.
- **Chips per destination** in the list (§3.3), with **Retry** and **Forget** in the row's button group (`:129-143`).
- "View /updates" (`:43`) stays. "View roadmap" (`:155`) links to `/roadmap`.
- Confirm texts move to `data-confirm` (custom-dialogs):
  - "Delete this update and its Discord posts?"
  - "Remove this task?"
  - "Delete this milestone and its tasks?"

### 6.3 Admin → Community (`views/admin_community.php`)

- The changes of §3.4.
- The bot card (`:47-58`) also shows "Version {v}" and links to "Discord settings" (`#discord`).
- The red "The bot couldn't carry out …" banner (`:26`, `:71-73`) no longer lists `update.*`, `bot.*` and
  `suggestions.notice` jobs – they have their own status and actions in the Discord tab. Retry and Forget mark a
  dead job done, so its banner goes away.

### 6.4 Shared public layout (`updates/layout.ts`)

**Fixed parts**, taken from `views/updates.php`:

- `<head>` (`:43-101`), with per-page title, description, og URL and canonical (§5.2):
  - "Updates | OnYourSite"
  - "Roadmap | OnYourSite"
  - "Suggestions | OnYourSite"
- The feed `<link rel="alternate">` is kept on all three pages.
- Nav (`:105-128`): "Updates" stays active for all three. A slot for "Status" sits between "Updates" and "Community"
  (md and up); status-pages fills it with `https://status.{base}`.
- Hero (`:130-141`).
- Footer (`:276-291`), with a slot for "Status" after "Code page terms" (status-pages).

**Sub-nav**, placed directly under the hero buttons:

```html
<nav aria-label="Updates sections" class="mt-8 inline-flex max-w-full overflow-x-auto [scrollbar-width:none] gap-1 p-1 rounded-full border border-bordercolor bg-card/60">
  <a href="/updates" aria-current="page" class="shrink-0 inline-flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-full text-sm font-medium bg-white text-black"><i class='bx bx-news hidden sm:inline-block'></i> Changelog</a>
  <a href="/roadmap" class="shrink-0 inline-flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-full text-sm font-medium text-gray-400 hover:text-white hover:bg-white/5 transition-colors"><i class='bx bx-map-alt hidden sm:inline-block'></i> Roadmap</a>
  <a href="/suggestions" class="…same…"><i class='bx bx-bulb hidden sm:inline-block'></i> Suggestions</a>
</nav>
```

- The icons are the admin icons for the same topics (`views/admin.php:301-309`; bx-bulb from
  `views/admin_community.php:78`). They show from `sm` (640 px) up. `hidden` has to beat Boxicons' own
  `.bx { display: inline-block }`; it does because Tailwind's generated styles come after the Boxicons stylesheet in
  `<head>` (`views/updates.php:60-61`), and the Playwright width check (§8) would catch a change of that order.
- Measured in Chromium with Inter 500 and Boxicons from the repo (`navwidth.mjs`, `navfit.mjs`): with icons the three
  pills need **381 px**, more than a 375 px phone has inside its 16 px gutters (343 px) – and the body's
  `overflow-x-hidden` (`views/updates.php:103`) would cut "Suggestions" off. Without icons they need **319 px**: inside
  the viewport at 360, 375 and 390 px. At 320 px the pills scroll inside the nav (`max-w-full overflow-x-auto`); the
  page itself never scrolls sideways. From 640 px up, with icons: 391 px.
- "Status" is not a fourth pill: it is another host, not a section of these pages, and four pills don't fit on phones
  (361 px even at 13 px without icons).

### 6.5 `/updates`

**Hero:**

- Badge "Changelog";
- h1 "What's new at OnYourSite" (unchanged);
- text "Every change to OnYourSite, newest first.";
- buttons unchanged ("Get updates on Discord", "RSS feed").

**Body:**

- The changelog section `:224-273` is unchanged, except that the milestone chip is always a link to
  `/roadmap#milestone-{id}` for public milestones.

**Anchors for old links:** `<span id="roadmap"></span><span id="shipped"></span>` plus:

```html
<script>if (/^#(roadmap|shipped|milestone-\d+)$/.test(location.hash)) location.replace('/roadmap?from=updates' + location.hash);</script>
```

Why the query: today `/roadmap` answers `301 Location: /updates#roadmap` without `Cache-Control`
(`lib/routes_app.php:69-70`, `lib/helpers.php:110-113`); cookieless visitors get no session and so no no-cache
headers, and browsers keep a 301 like that. Measured in Chromium (`redirect-cache.mjs`: open the old `/roadmap`, switch
the server, open `/roadmap` again): forwarding to `/roadmap` loops – `/updates` was requested 121 times in 3 s,
`/roadmap` never; forwarding to `/roadmap?from=updates` costs one request each and lands on the roadmap. The Roadmap
pill and all links keep pointing at `/roadmap`; a browser with the cached redirect takes one extra hop through
`/updates`. Those are likely the owner and his Discord members, because `README.md:96` advertised `/roadmap`.

### 6.6 `/roadmap`

**Hero:**

- Badge "Roadmap";
- h1 "What we're <gradient>building</gradient>" (gradient span of `:134`);
- text "What we're working on right now, what's up next and what has shipped. Progress comes from finished tasks – no
  guesswork.";
- buttons **Suggest an idea** (→ `/suggestions`, or the invite when that page is off) and **See the changelog**.

**Body:**

- Columns and shipped grid as in `:145-222`.
- Tail card: "Missing something? Post your idea in #suggestions on our Discord." with a link to the invite.
- Script: if the hash targets an element inside `<details>`, open it first.

### 6.7 `/suggestions`

**Hero:**

- Badge "Community ideas";
- h1 "Ideas from the <gradient>community</gradient>";
- text "Suggestions from our Discord and what the team decided. Got an idea? Post it in #suggestions.";
- buttons **Share an idea on Discord** (invite) and **See the roadmap**.

**Filter pills.** The pattern is `views/admin_community.php:79-83`, made `rounded-full`:

- active: `bg-white/10 text-white`;
- counts: `text-gray-500`;
- "Open" only when visible open suggestions exist.

**Card** (`id="suggestion-{id}"`, `rounded-2xl border border-bordercolor bg-card/50 p-5 sm:p-6 scroll-mt-24`):

- **Badge** – class `text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full`, colours as in the admin;
  labels Open / Accepted / Declined.
- **Title** – `h3 text-lg font-bold text-white`.
- **Excerpt** – `mt-2 text-gray-300 whitespace-pre-line break-words`, with `<details>` "Show more".
- **Meta** – `mt-3 text-xs text-gray-500`: "Suggested {date} · Accepted {date}".
- **Team note** – `mt-3 border-l-2 border-emerald-500/40 pl-3 text-sm text-gray-300` (red for declined), with the
  label "Note from the team".
- **Footer row** – "Discuss on Discord" (`bx-conversation`, `target="_blank" rel="noopener"`).

**Below the list:**

- the pager of `:265-271` with the query kept;
- the note "Suggestions come from the #suggestions forum on our Discord. Only ideas the team has decided are shown,
  without names."

### 6.8 Landing page (`views/landingpage.php`)

- The footer link "Updates & roadmap" (`:324`) becomes three links: "Updates", "Roadmap" and "Suggestions".
  "Suggestions" is left out while that page is off.
- The nav "Updates" link (`:118`) stays.

### 6.9 Discord texts (embeds, English, no emojis)

- **Update embed:** unchanged (`lib/updates.php:678-699`).
- **Test embed:** "Discord is connected" / "New updates from {host} will show up here." (`:986-992`).
- **Suggestion status embed:** while the page is on, the field "Website" – "Once decided, this idea is shown on
  {host}/suggestions, without your name."
- **Forum guidelines sentence:** "Decided ideas are shown on {host}/suggestions without your name."
- **Setup output** (`--discord-channel`):
  - DONE "Created channel #updates", or "Using your existing #updates";
  - for servers without the community feature: "Created channel #updates (a text channel – announcement channels need
    a community server)".
- **Installer:**
  - "Adding the #updates channel …";
  - Note "The #updates channel couldn't be added: {error} – run sudo bash {folder}/install.sh --updates-channel to try
    again."

---

## 7. Security, abuse and limits

| Topic | Measure |
|---|---|
| **Secrets** | The webhook token stays encrypted in `oys_meta` and is never rendered (masked). The old bot token stays encrypted only until the admin switches to the bot or a webhook; then it is deleted and the website holds no bot token (`lib/community.php:4-6`). No new token can be entered. The bot report holds no secrets. No secret field is pre-filled in the DOM. |
| **SSRF** | Requests are built only from the parsed `{id, token, thread_id}`, against a fixed host (discord.com or the config `discord_api_base`). No redirects, 5 s / 10 s timeouts, answers read up to 1 MB. Avatar and invite links are stored, never fetched by the server. |
| **Admin actions** | Admin session and CSRF on every POST, as today. Tests are limited to 5 per minute and webhook checks to 10 per minute, per admin, using the DB `rate_limits` (correct across processes). The status JSON is read-only, admin-only (401/403 JSON) and `no-store`. |
| **Bot API** | Unchanged HMAC and skew. Bodies over 64 KiB → 413. Strict schemas for `hello` and `result`. The feature list of each poll is signed, so the website hands out only jobs the polling bot knows. Results are applied once, under row locks; a repeated `/done` changes nothing. |
| **Races and double posts** | Every post transition locks its row, in the admin and in `/done` (§5.5.3). A missing row is claimed through the unique key before Discord is called, so a double click posts once; the loser gets "Already posting…". A repeated job looks for its own earlier message before posting (`findOwnPost`). |
| **Wrong pings** | `allowed_mentions` is always explicit (`parse: []` unless chosen). Edits never ping. Update titles are inside embeds, which never ping. A post that waited more than 24 hours is not sent at all. |
| **XSS** | Everything public goes through `e()`. Suggestion text is plain text with Discord tokens replaced, and no links are made clickable. Markdown is used only for admin text, with the existing renderer. |
| **Privacy** | `README.md:82` promises "nothing about suggestions or tickets is public", and the forum topic set by the setup (`discord-bot/src/setup.js:159`) says nothing about a website. So: the page starts **off**; a suggestion appears only if the team decided it **and** its author was told in the thread (`web_notice`), or if the team shows it by hand (with a warning when the author wasn't told); existing suggestions have `web_notice = 0`. No names – neither authors nor team members – and never a Discord ID. Deleting a post or its first message in Discord erases the text on the website (gateway event, daily check). The admin can hide any suggestion. Forum guidelines, the note in every new post and the privacy page (`views/privacy.php`, new paragraph "Community suggestions") say what is shown. `README.md:82` changes to: "Suggestions the team has decided can be shown on /suggestions, without names, when the admin turns that page on; tickets are never public." |
| **Abuse** | Nothing reaches the public page without a team action (a decision or "Show on website"), so a spam or phishing post in the forum doesn't appear under the main domain. Titles are capped at 200 characters and text at 4000 (existing); the public excerpt is 280 characters. URLs stay plain text. |
| **Reserved addresses** | `suggestions` is reserved. The exact address `/suggestions` is always OnYourSite's page, because `router.ts:74` serves the app routes before the profile pattern – for it, moving path-mode pages only avoids a dead address. But the profile pattern also matches `/suggestions/` and `/suggestions/kalender` (`router.ts:75`, `index.php:75`), and there a path-mode page with that slug is served under OnYourSite's address. Verified on the PHP site: with a path-mode page named `updates`, `GET /updates/` answered **200 with that page** ("Not the real changelog \| OnYourSite"), while `/updates` showed the real changelog. Such a page exists when an owner switches a page that schema v2 moved back to path mode: the editor's `address` action (`lib/routes_app.php:426-441`, Node `app/editorApi.ts`) checks the slug only when it changes. Fixed by the trailing-slash 301s (§5.1) and by refusing `mode=path` for reserved slugs: "This address is used by OnYourSite on the main domain – your page stays at {slug}.{base}." This also closes the gap for `updates` and `roadmap`. |
| **Indexing** | Canonical URLs as in §5.2; filtered suggestion views are `noindex, follow`. `/admin*` and `/_/*` stay disallowed or noindex. |
| **Load** | Public queries use `idx_web` and `idx_published`, with 20 or 15 items per page. Report, outbox and posts are small. |

---

## 8. Tests

**Unit** (`app/test/discord.test.ts`, `community.test.ts`, `pages.test.ts`; `node --test`, as now):

- **`parseWebhookLink`:**
  - valid: every host variant, `/api/v10`, trailing slash, `?thread_id=`, `?wait=true`;
  - rejected: channel links, `http://`, foreign hosts, other queries, short tokens, padding.
  - The `discord_api_base` override is checked too.
- **`displayNameProblem`:** each rule and the 81-character case.
- **`parseMention`:** golden cases from `tests/unit.php`.
- **`discordError`:** every row of the §5.5.2 table, including nested `errors` paths such as `embeds.0.description` and
  `username`, and the legacy 50005/50001 text.
- **`discordSettingsFromV1` / `storeDiscordSettings`:** webhook, token, garbage, a wrong key, a v2 round trip; the v1
  mirror read back through a port of `array_intersect_key` gives the same webhook and token as before.
- **`updatePayload` / `forEdit` / `threadName`:** same output as PHP for the golden updates of `map-admin.md` §2.3.
- **Post state machine:** table-driven over every cell of §5.5.3, including `posting`, `legacy` and the cleanup.
- **`visible()`:** every combination of page mode, `bot_secret`, `web_state`, `web_notice`, `status` and
  `removed_at`.
- **Outbox:** the action → feature filter (no `f` → no `update.*`), the pause schedule, same-`ref` order, and each
  reconcile rule (cancel, `only_if_posted`, `recheck`, 24-hour and 2-minute expiry, skipped edit).
- **`suggestionText`:** Discord tokens, blank lines, the excerpt.
- **Report validator:** caps, types, IDs, unknown features dropped, the 60,000-byte limit.
- **`slugProblem`:** `suggestions` is reserved. The `address` mode guard is covered as well.

**HTTP** (`buildServer().inject()` against `oys_test_*`, Discord mocked by a small `node:http` server on a random port
through `discord_api_base`):

- **Public:**
  - `/roadmap`, `/updates` and `/suggestions` give 200 and **no `Set-Cookie`**; `/roadmap?from=updates` has the
    canonical `/roadmap`;
  - `/updates` has no roadmap section but the sub-nav and the forward script with `?from=updates`;
  - `/suggestions` is 404 by default and while `bot_secret` is empty; when on, it shows only visible rows, never
    `author_name`/`decided_by`, filters, clamps pages, and filtered views are `noindex`;
  - `/suggestions/{id}` redirects;
  - `/updates/`, `/roadmap/` and `/suggestions/` give 301 with `Cache-Control: max-age=3600` – also when a path-mode
    page with that slug exists (regression for the verified `/updates/` case);
  - `/updates/{id}` and the feed are byte-identical to the port's golden master.
- **Admin:**
  - CSRF missing → error flash;
  - non-admin → `/dashboard`;
  - `/admin/api/discord-status`: logged out → 401 JSON, non-admin → 403 JSON, admin → 200 `no-store`;
  - webhook save: valid (the mock's GET was hit and the setting stored encrypted), 401, 404, timeout (saved with a
    warning), bad name (A4 case), forum webhook, thread "not verified" until the first post, forum tests reuse the
    test post;
  - the **regression A1/A2**: posting the other form's field names has no effect;
  - bot save against a report: channel missing, `can_post=false`, `everyone` without the permission, same channel as
    the webhook; the save queues `bot.report` and the status says "checking" until a newer report arrives;
  - tests are rate-limited, a new test replaces an unclaimed one, and a test expires after 2 minutes;
  - publish, edit, unpublish and delete produce the expected rows, jobs, `ref` superseding and flashes;
  - delete with a transient webhook error aborts;
  - retry and forget (the jobs are marked done, the Community banner is gone);
  - the old token keeps posting after the migration and is deleted by the first bot or webhook save.
- **Races** (table-driven; two DB connections and a barrier hook in `posts.ts` that pauses one path between its read
  and its write):
  - bot `/done` (post ok) against unpublish, in both orders → the row ends `removing` with an `update.delete` job, or
    is gone; never stuck;
  - edit against `/done` → the edit is never lost (`dirty` or a new job);
  - two "Post to Discord" clicks (webhook) → exactly one POST at the mock, the other request gets "Already posting";
  - two announces through the bot → one job.
- **Bot API:**
  - `hello`: valid, invalid → 400, > 64 KiB → 413, stored ≤ 60,000 bytes; `ping` lists features;
  - outbox: feature filter, pauses (`next_try_at`), same-`ref` order, reconcile rules, `claimed_at`;
  - `done` with `result`, a replayed `done`, `final`, and a dead edit (row stays `posted` with `error`, never
    `failed`);
  - suggestions: `web_notice`, thread sync `deleted` / `body_deleted`, the threads listing with paging.
- **Migrations** (`schema.test.ts` pattern):
  - a v5 database with v1 settings (webhook; token) and posted updates → `discordDelivery`: rows created, settings v2
    with the mirror, token kept; PHP's `oys_discord_settings` (php-cli on the migrated test DB) still finds the
    webhook and the token;
  - `publicPages`: columns added, the path page moved, notices for pages and code pages written exactly once;
  - a re-run after a simulated failure between two steps (index already there, marker missing) succeeds;
  - running both again changes nothing.

**Bot** (`discord-bot/test/*.test.js`, `node --test`, no new dependency):

- `update.post` into text, announcement, forum and an archived thread (fake channel objects like `$S/bot-e2e.js`);
- missing permissions → final error with the list;
- the nonce is set; `recheck` finds an earlier message and posts nothing; `only_if_posted` without a match posts
  nothing;
- edit and delete, including 10008, 50005 (final) and the forum thread delete with its 403 fallback;
- `buildReport`: exclusions (Tickets category, suggestion threads), permissions, the 48 KB budget and `truncated`;
- outbox: `?f=` in the signed URL, a failed `/done` is kept and sent before the next poll, the item is not run
  again, a 413 is logged;
- **raw events with a real `Client`** (not logged in): `client.ws.handlePacket({t:'THREAD_DELETE', …})` for an
  uncached thread emits no `threadDelete` (documents the discord.js behaviour), while
  `client.emit(Events.Raw, packet)` makes the listener post `{deleted:true}`; `MESSAGE_DELETE` with
  `id === channel_id` posts `{body_deleted:true}`; other channels are ignored;
- daily check: 10003 → deleted, 10008 → body erased, 50001 → skipped, at most one request per second;
- setup `--discord-channel` against `$S/discord_setup_mock.py`: an existing text channel "updates" on a community
  server is reused (no second channel), a missing one is created as announcement or text, existing channels are never
  changed (the mock logs no PUT or PATCH);
- installer harness: `--update` without `UPDATES_CHANNEL_ID` reads the token from the settings file (safe under
  `set -u`), adds the key once and leaves every other line byte-identical; on failure it writes
  `UPDATES_CHANNEL_ID=` and a note and doesn't try again on the next `--update`; it never runs the full setup (no
  Staff-role PUT in the mock log).

**Playwright end-to-end** (Chromium, 1440×900 and 390×844; Discord and the bot faked):

1. **Webhook:** paste → saved and checked → **Send test** → the mock received the embed. The page contains no
   `input[type=password]` in the Discord tab.
2. **Bug regression:** fill every input of the *other* form, simulating autofill, then save → success, and the request
   carries only this form's fields.
3. **Bot:**
   - a fake bot (the real `discord-bot/src/site.js` with signed requests) sends `hello`;
   - the admin clicks **Use #updates** → "Checking with the bot…" → the fake bot reports → "Ready" → **Send test**;
   - the fake bot runs the job and reports;
   - the status line changes without a reload.
4. **Publish, edit, unpublish:** job, then result, then the chips posted → edit job → removed.
5. **Public navigation:**
   - Changelog → Roadmap → Suggestions with `aria-current`;
   - at 360, 375 and 390 px the nav's bounding box lies inside the viewport and the last pill is fully visible;
   - **cached 301:** a small proxy in front of the app serves the old `/roadmap` 301 (no `Cache-Control`); Chromium
     opens `/roadmap`; the proxy switches to pass-through; opening `/roadmap` again ends on
     `/roadmap?from=updates#roadmap` with the title "Roadmap | OnYourSite", and `/updates` was requested at most
     twice (template: `$S/design-discord-rev/redirect-cache.mjs`);
   - an anonymous visitor has **no cookies** after all three pages.
6. **Moderation:** page off → 404; turn on (confirmation) → a decided suggestion with `web_notice` appears; hide → gone;
   an old suggestion (`web_notice = 0`) appears only after "Show on website" and its warning.

**Bot ↔ site end-to-end** (extends `$S/bot-e2e.js`: real bot modules, Node site, fake Discord objects):

- the full post, edit and delete loop, including a website outage between the post and `/done` (no second post);
- a deleted suggestion thread (raw packet) disappears from `/suggestions`.

---

## 9. Installer and operations

**`server/install.sh`**:

- No new step. The website's Node service comes from the port's installer switch.
- `step_bot` (`:1574-1606`) already runs `discord-bot/install.sh --update` after a code update when the bot's systemd
  unit exists (`:1577-1580`). New: also when `$CODE/discord-bot/.env` is not empty (Docker in the code folder, the
  same test as `discord-bot/install.sh:64`) – today such a bot gets the new code but is never rebuilt. The website is
  updated first and the bot second; that is safe, because the website hands `update.*` jobs only to a bot that polls
  with `updates.v1`.
- Plan §4 lists "run `--discord-setup` once when `UPDATES_CHANNEL_ID` is missing" under `step_bot` (`plan.md:997`).
  This design moves it into the bot installer, which has the token and the settings file and knows Docker from
  service; `step_bot` doesn't run it.

**`discord-bot/install.sh`**:

- `UPDATES_CHANNEL_ID` is added to:
  - the env key list (`:314-315`);
  - the full setup's environment (`:272-276`);
  - the parsed keys (`:283`);
  - the Docker `bot_tool -e` list (`:164-166`).
- **`--update`** (`:203-206`): if the settings file has no `UPDATES_CHANNEL_ID=` line:
  1. `TOKEN=$(current DISCORD_TOKEN)` – today `TOKEN` is only set in the interactive path (`:221`), and `bot_tool`
     uses it under `set -u` (`:14`, `:160-167`);
  2. `bot_tool --discord-channel UPDATES_CHANNEL_ID "$(current GUILD_ID)"` with the stored IDs in the environment;
  3. success → `env_set UPDATES_CHANNEL_ID <id>` and the DONE lines; failure → `env_set UPDATES_CHANNEL_ID ""` and the
     note of §6.9. Either way the update goes on, and the next `--update` doesn't try again.
  - `env_set KEY VALUE` replaces or appends that one line through a temp file and `mv`, with mode 600, and leaves every
    other line and comment as it is.
- **`--updates-channel`**: the same step on demand (for a retry), then a restart of the bot.
- The unit file gets `Environment=OYS_BOT_RUNTIME=service`.
- `--check` also prints the website's features from `/_/bot/ping`.

**Bots that `server/install.sh` doesn't update** (on another machine): the admin card names the command for that
machine (§3.1). Until it runs, the website keeps update posts for the bot for 24 hours and says so.

**Discord:**

- No new invite permissions. ManageThreads, ManageChannels (forum guidelines), SendMessages and EmbedLinks are already
  there (`src/setup.js:17-19`).
- Pinging `@everyone` through the bot needs the channel permission "Mention @everyone"; the admin help explains it.

**Network and other services:**

- **Cloudflare / DNS / firewall:** nothing new. The web server still calls `discord.com` outbound, for the webhook
  (and the old token while it exists) only. The bot reaches the website through the domain; on the same server it goes
  through the `/etc/hosts` entry (`server/install.sh:980-982`).
- **Cron / systemd:** nothing new. There is an hourly in-process cleanup (§5.7) and a daily check inside the bot.
- **Capacity – the server now has 16 vCPUs.** Nothing here needs CPU: one indexed outbox query per bot poll (every
  10 s, as today), one hello every 10 minutes, a daily check at one Discord request per second. The website keeps no
  state in its process: posts are guarded by row locks and unique keys, rate limits live in `rate_limits`, and the
  cleanup holds a named DB lock. So it stays correct if the web service is later spread over several processes to use
  the cores (plan §0.6 runs one, because of the in-process session lock).

**Rollback:**

- **To an older build** (PHP 2.x through `install.sh --rollback`, plan §5.6, or a Node release from before this
  feature): `discord` still carries the v1 mirror, so the webhook – and the old token while it exists – keep working.
  Webhook and token posts are mirrored into `updates.discord_message_id/discord_target`, so the old code can still edit
  and delete them. Posts made by the installed bot can't be edited by the old code (it has no outbox delivery); they
  stay in Discord, and the old code shows those updates as not posted. The new table, columns and keys are ignored.
  `/roadmap` is a 301 again, and `/suggestions` shows the "Address available" 404 page.
- **Bot 0.2 against an older website:** `hello` gets 404, so the bot sends no report and polls as before; the old site
  ignores `?f=`, `web_notice` and the result fields. Deletion calls get 404 and are logged once.
- **Bot 0.1 against the new website:** it polls without `f` and only receives the three old actions.

**Docs:**

- website `README.md` "Updates, roadmap & Discord" (`:84-96`) and the privacy promise at `:82`;
- `discord-bot/README.md`;
- the privacy page (suggestions shown without names, only after a team decision);
- release notes for the update entry.

---

## 10. Delivery plan

**Conventions for all PRs:**

- They are built on the Node version after the port.
- Code comments are in German and UI texts in English.
- No new runtime dependencies.
- The Playwright flows use the browser setup already used for the port's end-to-end runs. If Playwright becomes a
  devDependency, that is decided once for all features.

| # | PR | Contents | Size | Depends on |
|---|---|---|---|---|
| 1 | **Fix the Discord settings form and show Discord's real errors** | Separate forms per destination (webhook, bot token – a token can still be entered until 2b makes this card read-only –, defaults) with renamed fields and no password inputs; display-name rules; `discordError` with the `errors` walk and the code table; webhook check on save; webhook forum and thread options with their limits; test-post reuse in forums; a named lock per update against double posts (`withNamedLock`, `'fail'`); a log line per failed save or test; tests for A1–A5. Shippable alone: **fixes the webhook complaint.** | M | port of updates and admin; §2.6 done |
| 2a | **Delivery model and bot API (website)** | Migration `discordDelivery` (table, outbox columns, settings v2 + mirror, old token kept, legacy rows); `discord/posts.ts` with the row locks; `/hello`, `/ping` features, outbox features/pauses/order/reconcile, `done{result,final}`; cleanup. Inert until a bot polls with `updates.v1`. | M | PR 1, port of community |
| 2b | **Admin UI for bot posting** | Bot card (states, checking, update instructions), old-token card, "Discord posts" card, chips, Retry/Forget, status JSON with the `/admin/api/` routing, Community banner fix. | M | 2a; custom-dialogs |
| 3 | **Bot 0.2.0: post updates, report channels, add #updates** | `updates.js`, `report.js`, outbox (`?f=`, kept `/done`, result, final), `--discord-channel`, installer `--update`/`--updates-channel`, `OYS_BOT_RUNTIME`, SIGTERM, README, welcome and `/bot-status` fields; bot tests; `server/install.sh` Docker case. **Fixes the bot complaint.** | M | 2a merged before release |
| 4 | **Own pages for the changelog and the roadmap** | `updates/layout.ts`, sub-nav, `/roadmap` page (200), forward script with `?from=updates`, trailing-slash 301s, admin "View roadmap", landing footer links; tests including the cached-301 test. | S–M | port of the updates pages |
| 5 | **Public suggestions page** | Migration `publicPages` (columns, reservation, notices); `RESERVED` + address-mode guard; `/suggestions`, `/suggestions/{id}`; page card, show/hide; privacy text and README. Bot part (5b): status-embed note + `web_notice`, guideline sentence, raw-event deletion sync, daily check. | M (+S bot) | PR 4; 5b after PR 3 |
| 6 | **Optional extras** (only if wanted, §11 Q7) | Crossposting; forum tags for update posts; edit sync for suggestion titles and texts (`THREAD_UPDATE`/`MESSAGE_UPDATE` through `Events.Raw`; a `suggestion.updated` handler that edits archived threads without leaving them open); milestone links with idea chips – **only milestones with `is_public = 1`**, an unknown or hidden `?milestone` is ignored and its title never echoed, `S.milestone` is null for hidden ones, chips through a `LEFT JOIN … AND is_public = 1` so a deleted or hidden milestone just drops the chip, with a test per path; the "Working on now" strip; a suggestions feed. | M | PR 5 |

PRs 1–3 and 4–5 are independent tracks and can go in parallel.

**What I need from the other features:**

- **custom-dialogs:**
  - declarative confirmations for server forms (`data-confirm`, `-text`, `-ok`, `-tone`) for delete update, remove
    webhook, delete token, forget post, delete milestone and turning the suggestions page on;
  - `OYSUI.toast` on the admin page for the asynchronous bot results;
  - optionally `notifyAdmins()` for a dead update post.
  - If 2b or 5 must ship first, they carry a few lines that read `data-confirm` until the custom-dialogs sweep replaces
    them – no inline `onsubmit`.
- **code-slots-admin (admin split):**
  - keep Updates, Roadmap, Discord and Community as admin sections, and keep the `POST /admin` dispatch order;
  - the `/admin/api/` prefix in `router.ts`/`dispatch.ts` is shared; their admin endpoints can live there too;
  - the `publicPages` reservation covers pages and own-address code pages named `suggestions`. If code pages get path
    addresses or a second slot, those addresses are `pages` rows (their §3.1) and are covered by the same `UPDATE`.
- **status-pages:**
  - `app/src/discord/index.ts` is the stable interface: `parseWebhookLink`, `checkWebhook`, `discordRequest`,
    `discordError`, `webhookPost/Edit/Delete`; the port's names stay as re-exports;
  - the outbox's action → feature registry is generic: they register `status.*` under their own feature (e.g.
    `status.v1`) and keep their own message IDs – `update_discord_posts` is for updates only;
  - `--discord-channel <KEY>` with `CHANNEL_SPECS` is generic: they add `STATUS_CHANNEL_ID` and `ALERTS_CHANNEL_ID`;
  - a "Status" slot in the top nav (md and up) and in the footer of the three pages – not a fourth pill (§6.4);
  - they reserve their own path in the same `RESERVED` array and migration list (a trivial merge); they may reuse
    `updates/layout.ts`; a shared scheduler would take over my hourly cleanup.
- **honeycomb-shop:** HC-12 rewards accepted ideas after a verified `/link`. This design keeps `author_id` stored
  (never public), so the link works; the hello feature list lets their bot change add `link.v1` and the `/link`
  command. Nothing else.
- **premium-domains:** nothing.

---

## 11. Open questions for the owner

1. **Show author names on /suggestions?** *Recommendation: no.*
   - Show "Suggested {date}" only, and never the Discord ID or the team member's name.
   - The names would be public on the web and in search engines, which goes beyond Discord.
2. **Show undecided (open) suggestions automatically?** *Recommendation: no – only decided ones appear by themselves;
   the team can show a single open one with "Show on website".*
   - Every public suggestion has been looked at by the team, so spam or phishing posts never reach on-your.site.
   - If you want open ones automatically: they would go online the moment someone posts, so the page would have to be
     kept out of search engines while they are shown, and each member could have only a few open ones on the page.
3. **The old way of pasting a bot token into the website** (plan §3.4 keeps it under "Advanced"): keep it?
   *Recommendation: no new tokens.* The installed bot replaces it. A token you already saved keeps posting until you
   switch to the bot or a webhook; then it is deleted, so the website stores no bot token.
4. **Existing pages named "suggestions" in path mode:** move them to `suggestions.on-your.site` and notify the owner,
   as was done for "updates" and "roadmap"? *Recommendation: yes.* There is no other way to free `/suggestions`, and
   their subdomain address keeps working.
5. **Suggestions posted before the page existed:** show them? *Recommendation: no.* Their authors couldn't know that
   the website would show them. They stay hidden; you can show single ones by hand, ideally after asking the author.
6. **Which message did you see when connecting failed?** (for example "That doesn't look like a Discord webhook
   link", "Invalid Form Body", "Cannot send messages in a non-text channel", or "Discord isn't connected yet"). And
   may the read-only command of §2.6 run once on your server? *Recommendation: yes* – it prints no secrets and tells
   which cause hit you.
7. **Optional extras (PR 6):** crossposting, forum tags for update posts, syncing edited suggestions, linking ideas to
   roadmap milestones, a "Working on now" strip, a suggestions feed – which do you want? *Recommendation: none for
   now;* ship PRs 1–5 first and decide with real use.

---

## 12. Review changes

Review round 1 (20 findings). Every blocker and major finding is fixed; the minor ones are applied. Parts I did not
take over as proposed are listed with the reason.

| # | Finding | What changed | Rejected or done differently |
|---|---|---|---|
| 1 | Cached `/roadmap` 301 → endless reload | Forward script targets `/roadmap?from=updates` + hash; canonical stays `/roadmap`; reason and own Chromium measurement in §6.5 (121 requests to `/updates` in 3 s vs. one request each); Playwright test with a proxy that serves the old 301 first (§8); new 301s carry `Cache-Control: max-age=3600` (§5.1). | — |
| 2 | Existing suggestions become public; page live on migration | Page default **off**, and off while `bot_secret` is empty (§4.3); per-row `web_notice` (the bot confirms that the author got the note in the thread), all existing rows 0 (§4.2); a suggestion appears only after a team decision with `web_notice = 1`, or when shown by hand with a warning (§3.4, §5.2); forum guidelines, per-post note, privacy page and `README.md:82` updated (§3.6, §7); retroactive question as §11 Q5. The "View on the website" button is dropped, so no stale buttons remain in Discord. | Instead of `public_since` I record consent per post (`web_notice`): it is exact when the page is turned off and on again and for posts recorded by an old bot that couldn't show the note. |
| 3 | Open suggestions = instant spam channel | Nothing appears without a team action (decision or "Show"), so a forum post can't reach the main domain by itself (§7); Q2 recommends "only decided"; filtered views `noindex`, one canonical (§5.2). | `noindex` while open items are shown and a per-author limit are not needed: no open item is public without a team action. They are described in Q2 for the case the owner wants open ones automatically. The `milestone` filter no longer exists in the core. |
| 4 | Hidden milestones leak | Milestone links moved to the optional PR 6, with the rules: only `is_public = 1` milestones can be linked or shown, unknown or hidden `?milestone` ignored without echo, `S.milestone` null for hidden ones, `LEFT JOIN … AND is_public = 1`, a test per path (§10). | — |
| 5 | Deletions missed for archived threads and while offline | `Events.Raw` for `THREAD_DELETE` (filtered by `parent_id`) and `MESSAGE_DELETE` of the first message; daily check over a signed thread list with `channels.fetch(…, {force:true})` (10003 = deleted); the discord.js evidence in §5.6; tests with a real `Client` and injected packets (§8). | `THREAD_UPDATE`/`MESSAGE_UPDATE` (edit sync, which would need `Partials.Channel`) moved to PR 6 with the other edit sync (finding 18). Deleting the post or its first message is covered in the core. |
| 6 | Lost updates between bot result and admin; double click posts twice | Concurrency rules in §5.5.3: one transaction per transition with `SELECT … FOR UPDATE` on the post row in admin and `/done`, fixed lock order, claim through `INSERT IGNORE` on `uq_update_via`, Discord called only outside transactions with a conditional finalize; new state `posting`; PR 1 adds a named lock per update; race tests with a barrier hook (§8). | — |
| 7 | No "edit failed" state; Retry duplicates | A dead or final edit keeps the row `posted` with `error` (chip "not updated"); Retry queues the edit again; legacy rows map 50005/50001 to "Posted by a different bot…" with Forget; dead edit/delete jobs never become `failed` (§5.4, §5.5.3). | — |
| 8 | Long poll spins and burns retries | Long poll removed; `setInterval` as today (§5.4, §5.6). Pauses per job (`next_try_at`, 10 s doubling, at most 1 h; the ten tries span about 1.4 hours) and same-`ref` order; the bot sends its features with every poll (`?f=`, signed), so a downgraded bot gets no `update.*`; against duplicates after a long website outage the bot keeps unacknowledged `/done` calls and checks for its own earlier message (`recheck`, `findOwnPost`). | The "if it stays" sub-fixes (minimum interval, waiter release on SIGTERM) are moot. `POLL_SECONDS` stays 10; 5 isn't needed. |
| 9 | Installer `--update` runs the full setup | New `--discord-channel <KEY>` that only finds a channel named "updates" across text, announcement and forum and uses it unchanged, or creates it; `TOKEN` and IDs read from the settings file; failure writes `UPDATES_CHANNEL_ID=` and a note, no automatic retry, `--updates-channel` for a manual one; `env_set` changes one line only (§3.1, §5.6, §9). | — |
| 10 | Sub-nav too wide for phones | Icons only from `sm` up, `max-w-full overflow-x-auto` as a safety net; own measurements (381 px with icons, 319 px without; inside the viewport at 360/375/390, scrolling inside the nav at 320) in §6.4; Playwright checks the bounding box at 360/375/390 (§8). | "Status" becomes a top-nav and footer slot, not a fourth pill (four pills need 361 px even at 13 px). |
| 11 | Routing gaps | `/admin/api/` passes `router.ts` and gets 401/403 JSON in `dispatch.ts`; trailing-slash 301s for the three pages before the profile pattern (§5.1). Additionally verified that `/updates/` serves a user's path-mode page today (§7). | — |
| 12 | Report size, storage, freshness | Byte budget 48 KB with `parent_id` + `categories`, exclusions of suggestion threads and the Tickets category, `truncated`; stored unescaped and refused above 60,000 bytes; bodies over 64 KiB get 413 on every bot route; after a bot save a fresh report is requested and the card shows "Checking…" (§3.1, §4.3, §5.4, §5.6). | — |
| 13 | Dropping the token; wrong rollback text | The old token keeps posting (inside the same encrypted value, key `bot_token`) until the admin saves the bot card or a webhook; banner when no destination is on; v1 mirror keys written for one release; webhook and token posts mirrored into the old columns; rollback text rewritten (§4.1, §4.3, §9). | The token is not moved to a separate `legacy_bot_token` key: staying under its v1 key is exactly what PHP and the pre-feature port read after a rollback. |
| 14 | Stuck and undefined states | (a) Forget after 10 minutes for `queued`/`removing` (2 for `posting`), marking the job done; (b) bot tests expire after 2 minutes; (c) tests use `ref='test'` and replace unclaimed ones; (d) edits and removals are queued whenever the bot is installed, also after "Turn off", otherwise the row gets today's "disconnected" note; (e) "Post to Discord" on `remove_failed` says why; (f) Retry/Forget mark dead jobs done and the Community banner leaves out update jobs; (g) the cleanup turns `posted` rows of deleted updates into `remove_failed` (§3.3, §5.3, §5.5.3, §5.7, §6.3). Also: posts not picked up within 24 hours aren't sent. | — |
| 15 | Webhook forum/thread limits | Limits stated next to the options; forum tests reuse one test post after a confirmation; threads "not verified" until the first post (§3.2, §6.1). | — |
| 16 | Installer and operations gaps | Card text per run mode with the real code folder, both commands for unknown or old bots (§3.1); `server/install.sh` also updates a Docker bot in the code folder; the bot installer owns the #updates step and `plan.md:997` is marked superseded; `/ping` lists features; SIGTERM handling in the bot (§5.6, §9). | Waiter release on SIGTERM is moot without the long poll. |
| 17 | Root cause not pinned | RC2 states what is proven and what is assumed; A6/A7 marked as plausible attempts; §2.6 adds a read-only command (tested on the repro database), the question to the owner (§11 Q6) and log lines from PR 1 on. | — |
| 18 | Scope creep; PR 2 too large | Core = PR 1, bot outbox delivery without long poll, #updates, the pages with hide/off and deletion sync. Crossposting, forum tags, edit sync, milestone links and idea chips, the "Working on now" strip and the feed moved to the optional PR 6 (§1, §10, §11 Q7); PR 2 split into 2a and 2b. `applyDecision` is unchanged in the core; PR 6 notes that its handler must not leave old threads open. | — |
| 19 | Migration v7 details and wording | `addIndex` for every index; notices with `INSERT … SELECT` before the `UPDATE` in one transaction with a marker; notice text mentions links and QR codes; code pages named `suggestions` get their own notice (§4.2). | §7 is reworded, but not to "only a broken-link fix": for `/suggestions` itself it is, but the trailing-slash and `/kalender` forms reach the profile route, where a path-mode page is served under OnYourSite's address – verified on the PHP site with `/updates/` (200, the user's page). Both statements are now in §7. |
| 20 | Agreements with other features | status-pages: stable `discord/index.ts`, generic feature registry and `--discord-channel`, Status slots in nav and footer; code-slots-admin: shared `/admin/api/` prefix, reservation covers code pages; honeycomb-shop: `author_id` kept for HC-12, feature list for `link.v1` (§10). | No fourth pill (see 10). |

The user's note for this round – "the server now has 16 vCores" – is reflected in §9 (Capacity): nothing in this
design needs CPU, and nothing depends on a single web process.
