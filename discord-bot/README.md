# OnYourSite Discord bot

A small bot for the OnYourSite Discord server, connected to the website:

- **Welcome** – greets new members with an embed (optional: gives them a role).
- **Suggestions** – every new post in the suggestion forum is saved on the website. The team accepts or declines it either in Discord (buttons on the post) or on the website (**Admin → Community**). Both stay in sync: the post shows the status, an optional note and a forum tag.
- **Support** – a panel with an “Open a ticket” button. Each ticket is a private channel that only the person and the team can see. Messages are saved on the website; replies written on the website appear in the channel. Tickets can be closed in Discord or on the website.

All messages are embeds in English.

## How it connects to the website

The bot calls the website at `/_/bot/…`. Every request is signed with a shared secret (`BOT_SECRET` in the bot, `bot_secret` in the website’s `config.json`) – HMAC-SHA256 over a timestamp, the method, the path and the body; requests older than 5 minutes are refused. The secret itself is never sent. Changes made on the website wait in a queue until the bot picks them up (every 10 seconds by default), so the website never needs the bot token and the bot doesn’t need to be reachable from the internet.

Without `bot_secret` in `config.json`, the endpoints don’t exist (404). The endpoints and the admin panel are excluded from search engines (`robots.txt`, `noindex`), and there are no public pages with suggestions or tickets.

## Set up (about 5 minutes)

1. **Create the bot:** <https://discord.com/developers/applications> → *New Application* → tab **Bot**:
   - *Reset Token* → copy the **bot token** (never share it).
   - Turn on **Server Members Intent** and **Message Content Intent**.
   - Turn off *Public Bot* so only you can add it.
   - Tab *General Information*: copy the **Application ID**.
2. **Run the installer** (on your own server: `server/install.sh` asks for the bot – see below). It only asks for the token and the Application ID; everything else happens by itself:
   - if the bot isn’t on a Discord server yet, it shows the invite link and waits until you added it (with several servers it asks which one),
   - it creates the role **Staff** (you as the server owner get it), a category **OnYourSite** with **#welcome**, **#rules** and **#support** (read-only for members), the forum **#suggestions** with the tags *Accepted* and *Declined* (only the team can set them) and a private category **Tickets** – what already exists (same name or the saved ID) is used again and nothing is created twice; an existing channel only gets the bot’s own access added if it lacks it,
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

**Keep the settings out of the website folder.** The `.htaccess` blocks `/discord-bot/` and every `.env` file – but in a website folder, use the system service: its settings live in `/etc`.

## Files

```
index.js            Start, connects everything
src/config.js       Settings from .env / environment variables
src/site.js         Signed requests to the website
src/welcome.js      Welcome embed
src/suggestions.js  Suggestion forum, accept/decline
src/support.js      Support panel, ticket channels, closing
src/outbox.js       Picks up changes made on the website
src/commands.js     /support-panel and /bot-status
src/setup.js        Sets up the Discord server for the installer (Staff role, channels, forum, IDs)
install.sh          Installer for a server (system service or Docker)
Dockerfile, docker-compose.yml   Container setup used by the installer
```
