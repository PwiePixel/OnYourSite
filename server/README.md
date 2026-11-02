# Your own server

One command sets up everything OnYourSite needs on a fresh Linux server – it fetches what it needs by itself:

```bash
curl -fsSL https://raw.githubusercontent.com/PwiePixel/OnYourSite/main/server/install.sh | sudo bash
```

- **the code** from GitHub
- **Node.js 22** for the website – it runs as its own locked-down system service (`onyoursite-web`) – with **Apache** in front of it for HTTPS, and **MariaDB**: the database, its own database user, a random password, `config.json` with new keys and the upload folder are created automatically. The server doesn’t need PHP.
- a **Cloudflare Tunnel** (if the DNS is at Cloudflare): the installer creates the tunnel, points `on-your.site`, `www` and every subdomain to it and removes old records and tunnels of the website – visitors come in through Cloudflare and the server needs no open web ports
- **HTTPS for the domain and every subdomain** (`*.on-your.site` – also the ones added later) with a free Let’s Encrypt certificate that **renews itself**; if a renewal ever fails, all admins get an email two weeks before it runs out
- **protection**: a firewall, fail2ban against password guessing on SSH, automatic security updates, a database that only answers the server itself, a website service that may only write to its own folders, hardened network settings – and, if you like, SSH logins only with a key
- the **weekly report** every Monday at 8:00 and a **backup** every night
- your **admin account**
- the **Discord bot** as a system service (optional)
- **safe updates**: a backup first, then the new version is built and checked next to the running one, and the switch only happens when it works – if not, the previous version comes back by itself
- **start from scratch** any time (`--reset`) – and, if you want, moving the data of an old server (also of an old PHP installation, e.g. on Plesk)

## What you need

- **A server (VPS)** with Ubuntu 24.04 (22.04, Debian 12 and 13 work too), root access via SSH, 2 GB RAM recommended (1 GB works – building the website needs about 300 MB for a minute) and enough disk space for the uploads, the backups and one extra copy of the website during updates (about 1 GB). A minimal Debian may lack `curl` – then `apt update && apt install -y curl` first. Logged in as root? Then leave out `sudo` in all commands here.
- **The DNS of your domain at Cloudflare** (recommended – the free plan is enough) and **one API token** for it: Cloudflare → *My Profile* → *API Tokens* → *Create Token* → *Create Custom Token* with these permissions:
  - Account · Cloudflare Tunnel · Edit
  - Zone · DNS · Edit
  - Zone · Zone · Read

  Account Resources: your account – Zone Resources: *Specific zone* → `on-your.site`. The installer uses this one token for the tunnel and for the certificate.

  Without Cloudflare it works too: the certificate then comes through the API of your DNS provider (built in: Hetzner, IONOS, Netcup, INWX, all-inkl.com, Porkbun; more than 150 others through [acme.sh](https://github.com/acmesh-official/acme.sh/wiki/dnsapi)), and you point the DNS to the server yourself.
- **Mail:** the website sends its emails through the SMTP server you enter under *Admin → Mail Server* (your own mail server, e.g. mailcow, or a mail provider). Mailboxes aren’t part of this installer – if they were on the Plesk server, move them first.

## Set up a new server

Log in to the new server (`ssh root@NEW-SERVER`) and start the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/PwiePixel/OnYourSite/main/server/install.sh | sudo bash
```

(As root, `sudo` can be left out. Rather keep the file? `curl -fsSLo install.sh https://raw.githubusercontent.com/PwiePixel/OnYourSite/main/server/install.sh && sudo bash install.sh` does the same.)

It installs git, gets the code into `/var/www/onyoursite`, installs Node.js 22 (from NodeSource), builds the website (a minute or two) and goes on by itself. It asks for:

1. the **domain** (Enter = `on-your.site`),
2. a **folder with data from an old server** – just press Enter for a fresh start,
3. the **Cloudflare Tunnel** – Enter says yes when the DNS is at Cloudflare; then the **API token** (typed in hidden). It shows what it will create and delete and asks once more before it changes anything,
4. the **certificate** – the DNS provider is detected, Enter picks it; with Cloudflare it uses the same token,
5. whether **SSH logins only with a key** are wanted (only asked if the server has an SSH key – say yes only if you log in with a key),
6. **your admin account** (name, email, page address, password),
7. whether to set up the **Discord bot** – only the bot token and the Application ID from the Discord Developer Portal; the installer invites the bot (link), creates the Staff role and the channels on your Discord server, fills in all IDs and sets up the shared secret by itself (details: [discord-bot/README.md](../discord-bot/README.md)).

Everything else happens by itself. Running it again is safe – Enter keeps every value. With the tunnel, the website is live as soon as the installer is done; without it, point the A records of `@`, `www` and `*` to the server (the installer shows the IP).

> Already have the code on the server? Then start `sudo bash /var/www/onyoursite/server/install.sh` – it’s the same installer. To try a branch before it’s merged: `… | sudo bash -s -- --branch NAME` (once that branch is merged and deleted, `--update` switches back to `main` by itself).

## Update

```bash
sudo bash /var/www/onyoursite/server/install.sh --update
```

The website keeps running while the update is prepared:

1. **Getting the new version** – git fetches it; the code folder isn’t changed yet.
2. **Checking the server** – database, disk space and passwords. Nothing is changed yet; if something is missing, the update stops here.
3. **Backup** – the database, the uploads, the settings and the running version go to `/var/backups/onyoursite/<date>-<time>-before-update`.
4. **Building the new version** next to the running one (`/var/www/.onyoursite-next`: `npm ci` and TypeScript), then checking it with the data of this server: can it read the encrypted data, is the database updated (only additions – the previous version keeps working with them), does it start?
5. **Switching**: the code folder gets the new version and the website restarts. For a few seconds, visitors see “OnYourSite is restarting – please try again in a few seconds.”
6. **Checking through Apache**, like a visitor: the start page, a profile page (subdomain and `on-your.site/name`), an upload, the connection of the Discord bot and the log of the website. If anything fails, the previous version comes back by itself – code, settings, Apache and the service – and the installer shows what went wrong. The backup stays.

Then it updates `cloudflared` and the bot (if they are set up) and checks the protection and the timers. Settings stay as they are. If there is nothing new, it only checks that everything is set up as it should be. To try a branch: `--update --branch NAME`.

### Moving from 2.x (PHP) to 3.0 (Node.js)

Version 3.0 doesn’t use PHP any more. A server that was set up with this installer for 2.x moves with the same command:

```bash
sudo bash /var/www/onyoursite/server/install.sh --update
```

- The **PHP website keeps running** until the Node.js version is built and checked with the data of the server (the old installer fetches the code first, so the website may show an error for a second or two before the PHP version is back in place).
- `config.php` becomes **`config.json`** – the same keys and values; it is read without PHP. The new settings stay outside the folder that PHP serves until the switch.
- The backup is called `…-before-node` and also holds `config.php`.
- The switch itself takes a moment: Node.js is already running, Apache changes over to it, and only then the code folder gets the new version. Apache processes that still finish a request for the PHP website can’t hand out files from the code folder any more – a `.htaccess` there denies everything (it stays; nothing is served from that folder directly). If the check after the switch fails, the **PHP website comes back by itself** – the database only got additions that the PHP version ignores.
- Afterwards, **OnYourSite doesn’t need PHP any more**: its PHP settings and the PHP weekly report are removed, `config.php` is kept as a copy for root in `/etc/onyoursite/config.php.previous`, PHP-FPM is turned off and the installer offers to remove the PHP packages. If other websites on the server still use PHP (another site in Apache, phpMyAdmin, an own PHP-FPM pool), PHP stays as it is and the installer names them.
- **Everyone has to log in once more** – the logins of the PHP version don’t carry over. Passwords, pages and everything else stay. Tell your users before you update.
- Accounts with a very old kind of password hash (not bcrypt) can’t log in with Node.js; the installer counts them first and asks before it goes on. An admin can set a new password for them (*Admin → Users*).
- There is no way back to PHP. The backup from before the move can be put back into the Node.js version: [Restore a backup](#restore-a-backup).

Was OnYourSite on Plesk or other PHP hosting? 3.0 can’t run there as before – set up your own server with this installer and move the data ([Moving data from an old server](#moving-data-from-an-old-server-optional)).

## Cloudflare Tunnel

The server opens a connection to Cloudflare by itself (`cloudflared`); visitors come in through it. So the server needs **no open web ports** (the firewall only lets SSH in), its IP address stays hidden and Cloudflare filters attacks.

What the installer does through the Cloudflare API:

- creates a tunnel for this server (`onyoursite-<server name>`) and its rules: `on-your.site`, `www.on-your.site` and `*.on-your.site` go to Apache on this server,
- **deletes** the A, AAAA and CNAME records of `on-your.site`, `www` and `*` – e.g. the ones that still point to the old server – and creates CNAMEs to the tunnel (through Cloudflare), all in one step: either everything is switched or nothing,
- **deletes** old tunnels of the website: tunnels whose rules only serve `on-your.site`, `www` and `*`, and unused leftovers of this server (`onyoursite-<server name>` without rules) – plus DNS records that still point to tunnels that are gone,
- **removes** the service `cloudflared` on this server if it runs one of these old tunnels (e.g. from Cloudflare’s own instructions, `cloudflared service install`),
- leaves everything else alone: mail records (MX, TXT/SPF), other names like `mail.on-your.site` and other tunnels. A tunnel that also serves other names (e.g. `nas.on-your.site`) or is managed on its own server stays – the installer names it, so you can clean it up by hand. If the mail of the domain would stop working (MX pointing to a name that becomes the tunnel), it warns first, and it points out records that reveal the address of this server.

It shows this plan and changes nothing until you say yes. The DNS is only switched once the tunnel is connected and the website answers on this server – if not, the website keeps running as before and `--tunnel` picks up the same tunnel later. Afterwards it checks from outside that a random subdomain really reaches this server through Cloudflare. In Cloudflare, *SSL/TLS* must not be set to *Off* (*Full (strict)* is right) – otherwise visitors end up in a redirect loop; the check points that out. A token that is missing a permission is forgotten, so the next run asks for a new one. On the server, `cloudflared` runs as the service `onyoursite-tunnel` (its own user without rights, the tunnel token in `/etc/onyoursite/tunnel.env`, readable only by root). Apache takes the real visitor address from Cloudflare and hands it to the website – the spam and login protection keep working.

Running the installer again (or `--tunnel`) keeps the tunnel and only repairs what is missing; `--update` keeps `cloudflared` up to date and only restarts it when something changed. To stop using the tunnel: delete it in Cloudflare (*Zero Trust → Networks → Tunnels*), point the DNS to the server again, delete `TUNNEL=yes` from `/etc/onyoursite/server.conf`, run the installer and answer *n* to the tunnel question – it opens the web ports again. `sudo systemctl disable --now onyoursite-tunnel` stops `cloudflared`.

## Start from scratch

```bash
sudo bash /var/www/onyoursite/server/install.sh --reset
```

Deletes all OnYourSite data on this server – the database (accounts, pages, stats, messages, suggestions, tickets), all uploads and the keys in `config.json` – and sets everything up fresh, including a new admin account. You have to type the domain to confirm, and a backup is made first (`/var/backups/onyoursite/<date>-<time>-before-reset`); everyone who is logged in is signed out. The code, the certificate, the Cloudflare tunnel, the mail server settings and the bot settings stay.

## HTTPS certificate

One certificate covers `on-your.site` and `*.on-your.site`, so every profile and code page – also every new one – has HTTPS right away. A timer checks it every day: about 30 days before it ends, it is renewed through the DNS API and Apache reloads it, without any downtime. If the renewal doesn’t work (most often because the API token was deleted or has expired) and the certificate has less than 14 days left, every admin gets an email through the mail server of the website. Then run `sudo bash /var/www/onyoursite/server/install.sh --https` and enter a new API token. With the tunnel, visitors see Cloudflare’s certificate; the one on the server is used by the Discord bot (and `cloudflared` talks to Apache through it).

## Protection

| | |
|---|---|
| Firewall (ufw) | Only SSH comes in – plus HTTP (80) and HTTPS (443) when the server is reached without the tunnel. The SSH port is detected – also when it isn’t 22 – so you can’t lock yourself out. |
| fail2ban | 5 wrong SSH logins within 10 minutes block that address for an hour. |
| Updates | Security updates of the system install by themselves every day. |
| SSH | Optional: logins only with a key (`/etc/ssh/sshd_config.d/00-onyoursite.conf`; undo: delete it and `systemctl reload ssh`). |
| Database | Only reachable from the server itself, its own user with a long random password, no reading of files through SQL. |
| Website | Runs as `www-data`, only reachable from the server itself (`127.0.0.1:3000`, Apache passes the requests on). As a systemd service it sees the whole system read-only and may only write to the upload folder, its own folder for temporary files and `email/`; no new privileges, at most 1 GB of memory, and it restarts by itself if it ever crashes. |
| Web server | Apache only passes requests for the domain on – unknown addresses (like the bare IP) get a 404. Uploads up to 16 MB; requests over 25 MB are refused before they reach the website. The visitor address comes from Apache in its own header – a visitor can’t fake it to get around the login and spam limits. Logs without IP addresses. |
| Files | The code belongs to root – the website can’t change it. `config.json` is readable only by root and the website and is never delivered to visitors (the same goes for `.git` and other internal files). Tokens and keys in `/etc/onyoursite` only by root. |
| Network | No redirected or source-routed packets, SYN cookies against floods. |

## Everyday

| | |
|---|---|
| Update to the newest version | `sudo bash /var/www/onyoursite/server/install.sh --update` – backup, build next to the running version, check, switch (and back by itself if the check fails); also updates `cloudflared` and the bot; settings stay |
| Change settings, turn something on | `sudo bash /var/www/onyoursite/server/install.sh` (Enter keeps the current values) |
| Cloudflare Tunnel: set up or repair | `sudo bash /var/www/onyoursite/server/install.sh --tunnel` |
| Certificate after “Later” or for a new DNS provider | `sudo bash /var/www/onyoursite/server/install.sh --https` |
| Start from scratch | `sudo bash /var/www/onyoursite/server/install.sh --reset` |
| Website: errors and requests | `journalctl -u onyoursite-web -f` (Apache: `/var/log/apache2/onyoursite-error.log`) |
| Website: restart | `sudo systemctl restart onyoursite-web` (needed after changing `config.json` by hand) |
| Tunnel | `journalctl -u onyoursite-tunnel -f` |
| Bot | `journalctl -u onyoursite-bot -f` · `sudo systemctl restart onyoursite-bot` |
| Backup right now | `sudo systemctl start onyoursite-backup` |
| When the timers run next | `systemctl list-timers 'onyoursite-*'` |
| Blocked addresses | `sudo fail2ban-client status sshd` · firewall: `sudo ufw status` |

## Backups

Every night at about 3:30, `server/backup.sh` saves to `/var/backups/onyoursite/<date>/` – and before every update and every `--reset` to `/var/backups/onyoursite/<date>-<time>-before-update` (or `-before-reset`):

- `database.sql.gz` – the whole database
- `uploads/` – a snapshot of the upload folder (files that didn’t change take space only once)
- `settings.tar.gz` – `config.json`, the folder `email/` (mail server and email templates) and the bot settings
- `release` – the version of the code that was running (`commit=…` and `branch=…`)

Backups are kept for 14 days (`BACKUP_DAYS` in `/etc/onyoursite/server.conf`). They are on the same disk as the website, so they help against mistakes, not against losing the server: copy them somewhere else now and then (e.g. `scp -r root@SERVER:/var/backups/onyoursite/latest ./onyoursite-backup`) or turn on the backups of your server provider.

### Restore a backup

As root (with a sudo user, run `sudo -i` first). Put the folder of the backup you want into `B`:

```bash
B=/var/backups/onyoursite/2026-11-20-031500-before-update
systemctl stop onyoursite-web
mariadb -e 'DROP DATABASE onyoursite; CREATE DATABASE onyoursite CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
gunzip -c $B/database.sql.gz | mariadb onyoursite
rsync -a --delete $B/uploads/ /var/lib/onyoursite/uploads/
tar -xzf $B/settings.tar.gz -C /var/www/onyoursite config.json email
```

The database belongs to the version of the code that made it – put that version back as well and let the installer build and start it (press Enter at every question):

```bash
. $B/release
git -C /var/www/onyoursite checkout -f ${branch:+-B "$branch"} "$commit"
bash /var/www/onyoursite/server/install.sh
```

The bot settings are in the same file: `tar -xzf $B/settings.tar.gz -C /etc onyoursite-bot.env`, then `systemctl restart onyoursite-bot`. The next `--update` brings the newest version back, with a new backup first.

**The backup from before the move to Node.js** (`…-before-node`) and backups made by version 2.x hold `config.php` instead of `config.json`, and the version they belong to is the PHP version – don’t put that back (3.x doesn’t run PHP). Bring their data into the Node.js version instead, the way data from an old server comes in:

```bash
B=/var/backups/onyoursite/2026-11-20-031500-before-node
systemctl stop onyoursite-web
rsync -a --delete $B/uploads/ /var/lib/onyoursite/uploads/
mkdir -p /root/import
cp $B/database.sql.gz /root/import/
tar -xzf $B/settings.tar.gz -C /root/import config.php email
bash /var/www/onyoursite/server/install.sh
```

When it asks for the folder with the files from the old server, enter `/root/import`, and answer *y* when it asks to replace the database. It reads `config.php` without PHP, keeps its keys (above all `aes_key`) and brings the database up to date. Everyone logs in once more. Then delete the folder: `rm -rf /root/import`. (A 2.x backup made by its nightly timer has its uploads in `uploads/` too and works the same way.)

## Where things are

| | |
|---|---|
| Code (git checkout) | `/var/www/onyoursite` – the website is in `app/` (TypeScript, built into `app/dist` by the installer); updates come with `--update` |
| `config.json` | `/var/www/onyoursite/config.json` (only root and the website); the version before the last change by the installer: `/etc/onyoursite/config.json.previous` |
| Website service | `onyoursite-web` – `/etc/systemd/system/onyoursite-web.service`, Node.js 22 (its path is in `server.conf`), port 3000 on `127.0.0.1` (`node_port` in `config.json`) |
| Uploads | `/var/lib/onyoursite/uploads` (outside the code, so updates never touch them) |
| Temporary files of the website | `/var/lib/onyoursite/tmp` |
| Server settings | `/etc/onyoursite/server.conf` |
| Cloudflare | API token in `/etc/onyoursite/cloudflare.env`, tunnel token in `/etc/onyoursite/tunnel.env` (only root), service `onyoursite-tunnel` |
| Certificate | `/etc/ssl/onyoursite/` – issued and renewed by acme.sh (`/root/.acme.sh`) |
| Apache | `/etc/apache2/sites-available/onyoursite.conf` (HTTPS and the way to the website; with the tunnel also `conf-available/onyoursite-tunnel.conf`) |
| Timers | `onyoursite-weekly-report` (Mondays 8:00), `onyoursite-backup` (nightly), `onyoursite-certs` (daily) in `/etc/systemd/system` |
| Discord bot | `/opt/onyoursite-bot`, settings in `/etc/onyoursite-bot.env` (only root) |

The installer rewrites the Apache, service, firewall, tunnel and timer settings every time it runs, so change the installer instead of these files.

## Moving data from an old server (optional)

Only if you want to keep the accounts and pages of an old OnYourSite (e.g. 2.x on Plesk) – for a fresh start, skip this.

1. On the old server, at a quiet time: *Admin → Storage & backups → Download all uploads (ZIP)*; in Plesk *Databases → Export Dump*, and download `httpdocs/config.php` and `httpdocs/email/smtp.json` (from a 3.x server: `config.json` instead of `config.php`).
2. Put the four files into `/root/import` on the new server (`scp` or an SFTP program).
3. Run the installer and enter `/root/import` as the folder. It imports the database (`.sql`, `.sql.gz` or `.zip`), the uploads, the mail settings and the keys from `config.php` – above all `aes_key`, without which encrypted data can’t be read. `config.php` is read without PHP: it has to be the plain list of settings it always was (anything else is refused with a message). The installer brings the database up to date.
4. Test before switching: put `NEW-SERVER-IP on-your.site www.on-your.site yourname.on-your.site` into the hosts file of your computer. With the Cloudflare Tunnel, do the import before you let the installer switch the DNS.
5. Delete the folder afterwards (`rm -rf /root/import`) – it holds passwords and the whole database – and switch off the old website. Coming from 2.x, everyone has to log in once more on the new server.

## What changed from 2.x

- **Node.js instead of PHP.** The website runs on Node.js 22 as the service `onyoursite-web`; Apache stays in front of it for HTTPS and passes every request on. PHP, PHP-FPM and the PHP settings aren’t used any more – after the move, the installer turns them off and offers to remove the PHP packages (unless other websites on the server still use PHP).
- **`config.json` instead of `config.php`** – same keys, same values, written by the installer. New: `client_ip_header` (the visitor address from Apache) and `node_port` (the port of the website, 3000).
- **Updates are built and checked before the switch** and go back by themselves if the new version doesn’t work; every update makes a backup first, which also notes the running version (`release`).
- **Logins:** after the move, everyone logs in once more.
- **Logs:** `journalctl -u onyoursite-web` instead of the PHP error log.
- **Weekly report, certificate warnings and the first admin account** go through the command line of the website (`app/dist/cli.js`) instead of PHP scripts.
- **Visitor address:** the website only trusts the address Apache passes in its own header – never a `CF-Connecting-IP` sent by a visitor.
- **The bot** gets Node.js 22 from the same place as the website (`server/node.sh`); its shared secret is `bot_secret` in `config.json`.
