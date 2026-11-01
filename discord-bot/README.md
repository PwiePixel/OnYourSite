# OnYourSite Discord bot

A small bot for the OnYourSite Discord server, connected to the website:

- **Welcome** – greets new members with an embed (optional: gives them a role).
- **Suggestions** – every new post in the suggestion forum is saved on the website. The team accepts or declines it either in Discord (buttons on the post) or on the website (**Admin → Community**). Both stay in sync: the post shows the status, an optional note and a forum tag.
- **Support** – a panel with an “Open a ticket” button. Each ticket is a private channel that only the person and the team can see. Messages are saved on the website; replies written on the website appear in the channel. Tickets can be closed in Discord or on the website.

All messages are embeds in English.

## How it connects to the website

The bot calls the website at `/_/bot/…`. Every request is signed with a shared secret (`BOT_SECRET` in the bot, `bot_secret` in the website’s `config.php`) – HMAC-SHA256 over a timestamp, the method, the path and the body; requests older than 5 minutes are refused. The secret itself is never sent. Changes made on the website wait in a queue until the bot picks them up (every 10 seconds by default), so the website never needs the bot token and the bot doesn’t need to be reachable from the internet.

Without `bot_secret` in `config.php`, the endpoints don’t exist (404). The endpoints and the admin panel are excluded from search engines (`robots.txt`, `noindex`), and there are no public pages with suggestions or tickets.

## Set up (about 10 minutes)

1. **Create the bot:** <https://discord.com/developers/applications> → *New Application* → tab **Bot**:
   - *Reset Token* → copy it into `DISCORD_TOKEN` (never share it).
   - Turn on **Server Members Intent** and **Message Content Intent**.
   - Turn off *Public Bot* so only you can add it.
2. **Invite it** (replace `CLIENT_ID` with the application ID from *General Information*, also used for `DISCORD_CLIENT_ID`):

   `https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=292326296592&scope=bot%20applications.commands`

   This asks for: View Channels, Send Messages, Send Messages in Threads, Embed Links, Read Message History, Manage Channels, Manage Roles, Manage Threads. In *Server Settings → Roles*, drag the bot’s role **above** the welcome role.
3. **Prepare the server:** a welcome channel, a **forum** channel for suggestions (optional tags “Accepted” and “Declined”), a category for tickets, a channel for the support panel and a team role.
4. **Website:** add `'bot_secret' => '…',` to `config.php` (at least 32 characters; *Admin → Community* shows a fresh random one). On your own server, `server/install.sh` does this for you.
5. **Bot:** Node.js 18 or newer.
   ```bash
   cd discord-bot
   cp .env.example .env      # fill in the IDs, the token and BOT_SECRET
   npm install
   npm run check             # tests the connection to the website
   npm start
   ```
6. In the support channel, run **`/support-panel`**. `/bot-status` shows whether everything is connected (both commands need “Manage Server”).

## Install on a server

**On your own server together with the website** (recommended): `server/install.sh` of the website asks “Set up the Discord bot on this server too?” and does everything below – including the shared secret in `config.php`, so nothing has to be copied by hand. See [server/README.md](../server/README.md).

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

Both ask for the **bot token** (tab *Bot* → *Reset Token*), the **application ID** (tab *General Information* – the same number Discord calls *Client ID*), the channel and role IDs and the website address, then create the secret for `config.php` if there is none yet, check the connection to the website and start the bot. It restarts by itself after a crash or a reboot. **The Client Secret is not needed** – don’t enter it anywhere.

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
install.sh          Installer for a server (system service or Docker)
Dockerfile, docker-compose.yml   Container setup used by the installer
```
