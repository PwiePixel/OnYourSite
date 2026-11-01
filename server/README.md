# Your own server (without Plesk)

One command sets up everything OnYourSite needs on a fresh Linux server – it fetches what it needs by itself:

```bash
curl -fsSL https://raw.githubusercontent.com/PwiePixel/OnYourSite/main/server/install.sh | sudo bash
```

- **the code** from GitHub
- **Apache with PHP-FPM** (the same `.htaccess` as on Plesk) and **MariaDB** – the database, its own database user, a random password, `config.php` with new keys and the upload folder are created automatically
- a **Cloudflare Tunnel** (if the DNS is at Cloudflare): the installer creates the tunnel, points `on-your.site`, `www` and every subdomain to it and removes old records and tunnels of the website – visitors come in through Cloudflare and the server needs no open web ports
- **HTTPS for the domain and every subdomain** (`*.on-your.site` – also the ones added later) with a free Let’s Encrypt certificate that **renews itself**; if a renewal ever fails, all admins get an email two weeks before it runs out
- **protection**: a firewall, fail2ban against password guessing on SSH, automatic security updates, a database that only answers the server itself, PHP that can’t start other programs, hardened network settings – and, if you like, SSH logins only with a key
- the **weekly report** every Monday at 8:00 and a **backup** every night
- your **admin account**
- the **Discord bot** as a system service (optional)
- **start from scratch** any time (`--reset`) – and, if you want, moving the data of an old server

## What you need

- **A server (VPS)** with Ubuntu 24.04 (22.04, Debian 12 and 13 work too), root access via SSH, 2 GB RAM recommended (1 GB works) and enough disk space for the uploads. A minimal Debian may lack `curl` – then `apt update && apt install -y curl` first. Logged in as root? Then leave out `sudo` in all commands here.
- **The DNS of your domain at Cloudflare** (recommended – the free plan is enough) and **one API token** for it: Cloudflare → *My Profile* → *API Tokens* → *Create Token* → *Create Custom Token* with these permissions:
  - Account · Cloudflare Tunnel · Edit
  - Zone · DNS · Edit
  - Zone · Zone · Read

  Account Resources: your account – Zone Resources: *Specific zone* → `on-your.site`. The installer uses this one token for the tunnel and for the certificate.

  Without Cloudflare it works too: the certificate then comes through the API of your DNS provider (built in: Hetzner, IONOS, Netcup, INWX, all-inkl.com, Porkbun; more than 150 others through [acme.sh](https://github.com/acmesh-official/acme.sh/wiki/dnsapi)), and you point the DNS to the server yourself.
- **Mail:** the website sends its emails through the SMTP server you enter under *Admin → Mail Server*. Mailboxes aren’t part of this installer – if they were on the Plesk server, move them to a mail provider first.

## Set up a new server

Log in to the new server (`ssh root@NEW-SERVER`) and start the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/PwiePixel/OnYourSite/main/server/install.sh | sudo bash
```

(As root, `sudo` can be left out. Rather keep the file? `curl -fsSLo install.sh https://raw.githubusercontent.com/PwiePixel/OnYourSite/main/server/install.sh && sudo bash install.sh` does the same.)

It installs git, gets the code into `/var/www/onyoursite` and goes on by itself. It asks for:

1. the **domain** (Enter = `on-your.site`),
2. a **folder with data from an old server** – just press Enter for a fresh start,
3. the **Cloudflare Tunnel** – Enter says yes when the DNS is at Cloudflare; then the **API token** (typed in hidden). It shows what it will create and delete and asks once more before it changes anything,
4. the **certificate** – the DNS provider is detected, Enter picks it; with Cloudflare it uses the same token,
5. whether **SSH logins only with a key** are wanted (only asked if the server has an SSH key – say yes only if you log in with a key),
6. **your admin account** (name, email, page address, password),
7. whether to set up the **Discord bot** – only the bot token and the Application ID from the Discord Developer Portal; the installer invites the bot (link), creates the Staff role and the channels on your Discord server, fills in all IDs and sets up the shared secret by itself (details: [discord-bot/README.md](../discord-bot/README.md)).

Everything else happens by itself. Running it again is safe – Enter keeps every value. With the tunnel, the website is live as soon as the installer is done; without it, point the A records of `@`, `www` and `*` to the server (the installer shows the IP).

> Already have the code on the server? Then start `sudo bash /var/www/onyoursite/server/install.sh` – it’s the same installer. To try a branch before it’s merged: `… | sudo bash -s -- --branch NAME` (once that branch is merged and deleted, `--update` switches back to `main` by itself).

## Cloudflare Tunnel

The server opens a connection to Cloudflare by itself (`cloudflared`); visitors come in through it. So the server needs **no open web ports** (the firewall only lets SSH in), its IP address stays hidden and Cloudflare filters attacks.

What the installer does through the Cloudflare API:

- creates a tunnel for this server (`onyoursite-<server name>`) and its rules: `on-your.site`, `www.on-your.site` and `*.on-your.site` go to Apache on this server,
- **deletes** the A, AAAA and CNAME records of `on-your.site`, `www` and `*` – e.g. the ones that still point to the old server – and creates CNAMEs to the tunnel (through Cloudflare),
- **deletes** old tunnels of the website: tunnels whose name starts with `onyoursite` or that serve this domain,
- leaves everything else alone: mail records (MX, TXT/SPF), other names like `mail.on-your.site` and other tunnels. If the mail of the domain would stop working (MX pointing to a name that becomes the tunnel), it warns first.

It shows this plan and changes nothing until you say yes. The DNS is only switched once the tunnel is connected. On the server, `cloudflared` runs as the service `onyoursite-tunnel` (its own user without rights, the tunnel token in `/etc/onyoursite/tunnel.env`, readable only by root), and Apache passes the real visitor IP from Cloudflare on to the website – the spam and login protection keep working.

Running the installer again (or `--tunnel`) keeps the tunnel and only repairs what is missing. To stop using the tunnel: delete it in Cloudflare (*Zero Trust → Networks → Tunnels*), point the DNS to the server again, delete `TUNNEL=yes` from `/etc/onyoursite/server.conf` and run the installer – it opens the web ports again.

## Start from scratch

```bash
sudo bash /var/www/onyoursite/server/install.sh --reset
```

Deletes all OnYourSite data on this server – the database (accounts, pages, stats, messages, suggestions, tickets), all uploads and the keys in `config.php` – and sets everything up fresh, including a new admin account. You have to type the domain to confirm, and a backup is made first. The code, the certificate, the Cloudflare tunnel, the mail server settings and the bot settings stay.

## HTTPS certificate

One certificate covers `on-your.site` and `*.on-your.site`, so every profile and code page – also every new one – has HTTPS right away. A timer checks it every day: about 30 days before it ends, it is renewed through the DNS API and Apache reloads it, without any downtime. If the renewal doesn’t work (most often because the API token was deleted or has expired) and the certificate has less than 14 days left, every admin gets an email through the mail server of the website. Then run `sudo bash /var/www/onyoursite/server/install.sh --https` and enter a new API token. With the tunnel, visitors see Cloudflare’s certificate; the one on the server is used between Cloudflare and Apache and by the Discord bot.

## Protection

| | |
|---|---|
| Firewall (ufw) | Only SSH comes in – plus HTTP (80) and HTTPS (443) when the server is reached without the tunnel. The SSH port is detected – also when it isn’t 22 – so you can’t lock yourself out. |
| fail2ban | 5 wrong SSH logins within 10 minutes block that address for an hour. |
| Updates | Security updates of the system install by themselves every day. |
| SSH | Optional: logins only with a key (`/etc/ssh/sshd_config.d/00-onyoursite.conf`; undo: delete it and `systemctl reload ssh`). |
| Database | Only reachable from the server itself, its own user with a long random password, no reading of files through SQL. |
| PHP | Can’t start other programs; hidden version; uploads up to 16 MB, bigger requests are refused before they reach PHP. |
| Web server | Internal folders, `config.php`, `.git` and hidden files are locked twice (`.htaccess` and server config); unknown addresses (like the bare IP) get a 404; logs without IP addresses. |
| Files | The code belongs to root – the web server may only write to the upload folder and `email/`. `config.php` is readable only by root and the web server. Tokens and keys in `/etc/onyoursite` only by root. |
| Network | No redirected or source-routed packets, SYN cookies against floods. |

## Everyday

| | |
|---|---|
| Update to the newest version | `sudo bash /var/www/onyoursite/server/install.sh --update` – gets the code (git pull), reloads everything, updates `cloudflared` and the bot; settings stay |
| Change settings, turn something on | `sudo bash /var/www/onyoursite/server/install.sh` (Enter keeps the current values) |
| Cloudflare Tunnel: set up or repair | `sudo bash /var/www/onyoursite/server/install.sh --tunnel` |
| Certificate after “Later” or for a new DNS provider | `sudo bash /var/www/onyoursite/server/install.sh --https` |
| Start from scratch | `sudo bash /var/www/onyoursite/server/install.sh --reset` |
| Website errors | `/var/log/apache2/onyoursite-error.log` |
| Tunnel | `journalctl -u onyoursite-tunnel -f` |
| Bot | `journalctl -u onyoursite-bot -f` · `sudo systemctl restart onyoursite-bot` |
| Backup right now | `sudo systemctl start onyoursite-backup` |
| When the timers run next | `systemctl list-timers 'onyoursite-*'` |
| Blocked addresses | `sudo fail2ban-client status sshd` · firewall: `sudo ufw status` |

## Backups

Every night at about 3:30, `server/backup.sh` saves to `/var/backups/onyoursite/<date>/`:

- `database.sql.gz` – the whole database
- `uploads/` – a snapshot of the upload folder (files that didn’t change take space only once)
- `settings.tar.gz` – `config.php`, the folder `email/` and the bot settings

Backups are kept for 14 days (`BACKUP_DAYS` in `/etc/onyoursite/server.conf`). They are on the same disk as the website, so they help against mistakes, not against losing the server: copy them somewhere else now and then (e.g. `scp -r root@SERVER:/var/backups/onyoursite/latest ./onyoursite-backup`) or turn on the backups of your server provider.

Restore a day – as root (with a sudo user, run `sudo -i` first):

```bash
gunzip -c /var/backups/onyoursite/2026-11-01/database.sql.gz | mariadb onyoursite
rsync -a --delete /var/backups/onyoursite/2026-11-01/uploads/ /var/lib/onyoursite/uploads/
```

## Where things are

| | |
|---|---|
| Code (git checkout) | `/var/www/onyoursite` – updates come with `--update` (git pull) |
| `config.php` | `/var/www/onyoursite/config.php` |
| Uploads | `/var/lib/onyoursite/uploads` (outside the code, so updates never touch them) |
| Server settings | `/etc/onyoursite/server.conf` |
| Cloudflare | API token in `/etc/onyoursite/cloudflare.env`, tunnel token in `/etc/onyoursite/tunnel.env` (only root), service `onyoursite-tunnel` |
| Certificate | `/etc/ssl/onyoursite/` – issued and renewed by acme.sh (`/root/.acme.sh`) |
| Apache | `/etc/apache2/sites-available/onyoursite.conf` (with the tunnel also `conf-available/onyoursite-tunnel.conf`) |
| PHP | `/etc/php/<version>/fpm/conf.d/90-onyoursite.ini` |
| Discord bot | `/opt/onyoursite-bot`, settings in `/etc/onyoursite-bot.env` (only root) |

The installer rewrites the Apache, PHP, firewall, tunnel and timer settings every time it runs, so change the installer instead of these files.

## Moving data from an old server (optional)

Only if you want to keep the accounts and pages of an old OnYourSite (e.g. on Plesk) – for a fresh start, skip this.

1. On the old server, at a quiet time: *Admin → Storage & backups → Download all uploads (ZIP)*; in Plesk *Databases → Export Dump*, and download `httpdocs/config.php` and `httpdocs/email/smtp.json`.
2. Put the four files into `/root/import` on the new server (`scp` or an SFTP program).
3. Run the installer and enter `/root/import` as the folder. It imports the database (`.sql`, `.sql.gz` or `.zip`), the uploads, the mail settings and the keys from `config.php` – above all `aes_key`, without which encrypted data can’t be read.
4. Test before switching: put `NEW-SERVER-IP on-your.site www.on-your.site yourname.on-your.site` into the hosts file of your computer. With the Cloudflare Tunnel, do the import before you let the installer switch the DNS.
5. Delete the folder afterwards (`rm -rf /root/import`) – it holds passwords and the whole database – and switch off the old website.
