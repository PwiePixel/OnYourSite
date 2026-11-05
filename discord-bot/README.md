# OnYourSite Discord bot

A small bot for the OnYourSite Discord server, connected to the website:

- **Welcome** – greets new members with an embed (optional: gives them a role).
- **Suggestions** – every new post in the suggestion forum is saved on the website. The team accepts or declines it either in Discord (buttons on the post) or on the website (**Admin → Community**). Both stay in sync: the post shows the status, an optional note and a forum tag.
- **Support** – a panel with an “Open a ticket” button. Each ticket is a private channel that only the person and the team can see. Messages are saved on the website; replies written on the website appear in the channel. Tickets can be closed in Discord or on the website.
- **Updates** – updates published on the website are posted in **#updates** (an embed with a link to the update). Edits on the website change the post in place without a new ping; moving an update back to drafts or deleting it removes the post. The website never needs the bot token for this – see below.
- **Status** – incidents and maintenance of OnYourSite's status page (`status.on-your.site`) are posted in **#status**; every new update on the website edits that post. When one of OnYourSite's checks fails or recovers, the team gets a short alert in **#alerts**, a private channel only Staff and the bot can see.

All messages are embeds in English.

## How it connects to the website

The bot calls the website at `/_/bot/…`. Every request is signed with a shared secret (`BOT_SECRET` in the bot, `bot_secret` in the website’s `config.json`) – HMAC-SHA256 over a timestamp, the method, the path and the body; requests older than 5 minutes are refused. The secret itself is never sent. Changes made on the website wait in a queue until the bot picks them up (every 10 seconds by default), so the website never needs the bot token and the bot doesn’t need to be reachable from the internet.

Without `bot_secret` in `config.json`, the endpoints don’t exist (404). The endpoints and the admin panel are excluded from search engines (`robots.txt`, `noindex`). Tickets are never public; suggestions the team has decided can be shown on the website at `/suggestions`, without names, once the admin turns that page on under *Admin → Community* (it starts off).

**Updates on Discord.** When the bot starts (and every 10 minutes, and after channels or roles change) it sends the website a short report: its version, what it can do, and the channels and roles of the server with its own permissions there – no messages and no member data. As soon as the report names **#updates** and neither a webhook nor an old bot token is set up under *Admin → Discord*, the website hands new updates to the bot: it posts them in #updates, edits them and removes them again. When it picks up its jobs, the bot tells the website what it can do (`updates.v1`), so an older bot never gets a job it doesn’t know. If the bot is offline, updates wait for it; an update the bot hasn’t picked up within 24 hours isn’t posted any more (no surprise pings for old news). If the website is unreachable while the bot reports a result, the bot keeps the result and sends it again; before posting an update a second time it looks for its own earlier post, so nothing shows up twice.

**Status on Discord.** From version 0.3.0 the bot tells the website it can post status messages (`status.v1`); an older bot never gets these jobs. In *Editor → Status → Alerts* an admin picks the two channels from the bot's report – until then the website uses the bot's suggestions **#status** and **#alerts**. Each incident or maintenance window gets one post in #status with a link to its page; every update on the website edits that post (no new ping), deleting the incident removes it. Alerts for the team (check down, back up, slow, certificate, heartbeat missed) go to #alerts; alerts the bot hasn't picked up within 2 hours are dropped. The report also says whether the bot is connected to Discord (`gateway`); when the connection breaks or comes back, the bot reports at once, so the status page shows the Discord bot as disrupted only while it really is.

**Suggestions on the website.** When the admin turns on the page `/suggestions` (*Admin → Community*, it starts off), the bot adds the field *Website – “Once decided, this idea is shown on …/suggestions, without your name.”* to the status message of every new post and tells the website that the author got this note – only such posts appear there by themselves once the team decides them. It also adds the sentence “Decided ideas are shown on …/suggestions without your name.” to the forum’s guidelines and removes it again when the page is turned off; the rest of the guidelines stays as it is. If a post (or its first message) is deleted in Discord, its text disappears from the website within seconds; a check 10 minutes after the start and then once a day (at most one request to Discord per second) catches deletions that happened while the bot was offline. The bot does all this only when the website supports it (`suggestions.v2`).

## Set up (about 5 minutes)

1. **Create the bot:** <https://discord.com/developers/applications> → *New Application* → tab **Bot**:
   - *Reset Token* → copy the **bot token** (never share it).
   - Turn on **Server Members Intent** and **Message Content Intent**.
   - Turn off *Public Bot* so only you can add it.
   - Tab *General Information*: copy the **Application ID**.
2. **Run the installer** (on your own server: `server/install.sh` asks for the bot – see below). It only asks for the token and the Application ID; everything else happens by itself:
   - if the bot isn’t on a Discord server yet, it shows the invite link and waits until you added it (with several servers it asks which one),
   - it creates the role **Staff** (you as the server owner get it), a category **OnYourSite** with **#welcome**, **#rules**, **#support**, **#updates** and **#status** (read-only for members; #updates and #status are announcement channels on community servers), the private channel **#alerts** (only Staff and the bot), the forum **#suggestions** with the tags *Accepted* and *Declined* (only the team can set them) and a private category **Tickets** – what already exists (same name or the saved ID) is used again and nothing is created twice; an existing channel only gets the bot’s own access added if it lacks it (an existing #updates is used exactly as it is),
   - it saves all IDs, creates the shared secret with the website and starts the bot,
   - the bot posts the ticket panel in **#support** by itself.
3. Give your team members the **Staff** role – they can then accept or decline suggestions and see every ticket.

The invite link asks for: View Channels, Send Messages, Send Messages in Threads, Embed Links, Attach Files, Read Message History, Manage Messages, Manage Channels, Manage Roles, Manage Threads, Create Public Threads, Create Private Threads. Discord only lets the bot hand out rights it has itself: Create … Threads makes the info channels read-only, Attach Files and Manage Messages are for the ticket channels (files from members, moderation by the Staff role). If the bot was invited with an older link, the installer says which rights are missing and shows the link again – opening it and authorizing once more adds them. `/support-panel` posts the panel again, `/bot-status` shows whether everything is connected (both need “Manage Server”). The Client Secret is not needed.

Forum channels may need a community server: if Discord refuses the forum, the installer says so – turn on *Server Settings → Enable Community* and run the installer again. Everything else works without it.

**Without the installer** (e.g. to develop on your computer): Node.js 18 or newer, then `cp .env.example .env`, fill in the token and the IDs by hand, add `"bot_secret": "…"` to the website’s `config.json` and restart the website (*Admin → Community* shows a fresh random one), and `npm install && npm run check && npm start`.

## Install on a server

**On your own server together with the website** (recommended): `server/install.sh` of the website asks “Set up the Discord bot on this server too?” and runs this installer for you – including the shared secret in `config.json`, so nothing has to be copied by hand. See [server/README.md](../server/README.md).

**Anywhere else** – e.g. a small extra server (Ubuntu or Debian, 1 CPU and 512 MB RAM are plenty). The bot only connects outwards – to Discord and to the website – so no ports have to be opened:

```bash
# 1. Get the code onto the server – clone the repository or upload just the folder discord-bot/ via SFTP
git clone https://github.com/PwiePixel/OnYourSite.git
cd OnYourSite/discord-bot

# 2. Run the installer
sudo bash install.sh
```

The installer asks how the bot should run:

1. **As a system service with Node.js** (recommended): installs Node.js 22 if it’s missing (from deb.nodesource.com, after asking), copies the bot to `/opt/onyoursite-bot` and runs it as its own user without a login, without write access and with a 256 MB limit. The settings are stored in `/etc/onyoursite-bot.env`, readable only by root.
2. **In Docker**: installs Docker if it’s missing (official script from get.docker.com, after asking) and runs the bot as a container with a read-only file system, no extra rights and rotated logs. The settings are stored in `.env` next to the installer, readable only by root – they never go into the image.

Both ask only for the **bot token** and the **Application ID** (Enter takes the one that belongs to the token), set up the Discord server as described above, ask for the website address (Enter = `https://on-your.site`), create the secret for the website’s `config.json` if there is none yet, check the connection to the website and start the bot. It restarts by itself after a crash or a reboot. **The Client Secret is not needed** – don’t enter it anywhere.

| | System service | Docker |
|---|---|---|
| Logs | `journalctl -u onyoursite-bot -f` | `docker compose logs -f bot` |
| Restart | `sudo systemctl restart onyoursite-bot` | `docker compose restart bot` |
| Stop | `sudo systemctl stop onyoursite-bot` | `docker compose down` |
| Change settings | `sudo bash install.sh` (Enter keeps the current values) | the same |
| Update | `git pull && sudo bash install.sh --update` | the same |
| Add a channel again | `sudo bash install.sh --channel UPDATES_CHANNEL_ID` (or `STATUS_CHANNEL_ID`, `ALERTS_CHANNEL_ID`) | the same |

**Updating from an older version** adds what the new version needs and changes nothing else: `--update` looks for each channel the new version knows and the settings file doesn’t have yet – **updates**, **status** and **alerts** (text, announcement or forum) – and uses an existing one unchanged (an existing #alerts that everyone can see only gets a note), or creates it in the OnYourSite category (#alerts private for Staff and the bot); it saves its ID in the settings file (only that one line changes) and doesn’t touch roles or other channels. If that fails, it says why, stores an empty value and doesn’t try again by itself – `--channel <KEY>` tries again. `npm run check` (or `node index.js --check`) shows whether the website is reachable and what it supports.

**Keep the settings out of the website folder.** The website never serves `/discord-bot/` or any `.env` file – but in a website folder, use the system service: its settings live in `/etc`.

## Beta testers

When an admin adds a beta tester on the website (*Admin → Beta*), the bot gives that member the role **Beta Tester** and takes it away when they leave the beta. It uses `BETA_ROLE_ID` from `.env` if set, otherwise a role with that name, and creates it if there is none (it needs *Manage Roles*, which the invite link includes, and its own role must be above the Beta Tester role – that's the case for a role the bot creates). Members who aren't on the server yet are shown on the website; the admin can try again once they joined.

## Files

```
index.js            Start, connects everything
src/config.js       Settings from .env / environment variables
src/site.js         Signed requests to the website
src/welcome.js      Welcome embed
src/suggestions.js  Suggestion forum, accept/decline
src/support.js      Support panel, ticket channels, closing
src/outbox.js       Picks up changes made on the website (only jobs it can do) and reports the results
src/updates.js      Posts, edits and removes updates in #updates
src/status.js       Incident posts in #status and alerts for the team in #alerts
src/report.js       Report for the website: connection to Discord, channels, permissions, roles, #updates, #status, #alerts
src/commands.js     /support-panel and /bot-status
src/setup.js        Sets up the Discord server for the installer (Staff role, channels, forum, IDs)
test/               Tests (npm test – no Discord account needed)
install.sh          Installer for a server (system service or Docker)
Dockerfile, docker-compose.yml   Container setup used by the installer
```
