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

## Where to run it

The bot has to run all the time. For testing, your own computer is fine. Later: a small VPS, a Raspberry Pi, or Plesk’s Node.js extension (if your plan allows long-running apps).

**Keep `.env` out of the website folder.** If the repository is deployed into `httpdocs`, the `.htaccess` blocks `/discord-bot/` and every `.env` file anyway – but it’s best to run the bot from a folder outside the web root, or to set the values as environment variables in your hosting panel instead of a `.env` file.

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
```
