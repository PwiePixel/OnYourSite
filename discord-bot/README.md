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
4. **Website:** add `'bot_secret' => '…',` to `config.php` (at least 32 characters; *Admin → Community* shows a fresh random one).
5. **Bot:** Node.js 18 or newer.
   ```bash
   cd discord-bot
   cp .env.example .env      # fill in the IDs, the token and BOT_SECRET
   npm install
   npm run check             # tests the connection to the website
   npm start
   ```
6. In the support channel, run **`/support-panel`**. `/bot-status` shows whether everything is connected (both commands need “Manage Server”).

## Install on a server (Docker)

The easiest way: a small Linux server (Ubuntu or Debian, 1 CPU and 512 MB RAM are plenty). The bot only connects outwards – to Discord and to the website – so no ports have to be opened.

```bash
# 1. Get the code onto the server – clone the repository (private: use a deploy key or token)
#    or upload just the folder discord-bot/ via SFTP
git clone https://github.com/PwiePixel/OnYourSite.git
cd OnYourSite/discord-bot

# 2. Run the installer
sudo ./install.sh
```

The installer
1. installs Docker if it’s missing (official script from get.docker.com, after asking),
2. asks for the token, the IDs and the website address – and creates the secret for `config.php` if you don’t have one yet,
3. saves everything in `.env` (readable only by root; it never goes into the Docker image),
4. builds the image, checks the connection to the website and starts the bot.

The bot runs as a container that restarts by itself after a crash or a reboot. It runs as a normal user, with a read-only file system, no extra rights and a 256 MB memory limit, and its logs are rotated.

| | |
|---|---|
| Logs | `docker compose logs -f bot` |
| Restart | `docker compose restart bot` |
| Stop | `docker compose down` |
| Change settings | `sudo ./install.sh` (Enter keeps the current values) |
| Update | `git pull && sudo ./install.sh --update` |

Without Docker it also runs directly with Node.js 18 or newer (`npm install` and `npm start`, see above) – then keep it running with a service manager such as systemd or pm2.

**Keep `.env` out of the website folder.** If the repository is deployed into `httpdocs`, the `.htaccess` blocks `/discord-bot/` and every `.env` file anyway – but run the bot from a folder outside the web root, or on its own server.

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
install.sh          Installer for a server (Docker)
Dockerfile, docker-compose.yml   Container setup used by the installer
```
