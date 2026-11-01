# Your own server (without Plesk)

One command sets up everything OnYourSite needs on a fresh Linux server – it fetches what it needs by itself:

```bash
curl -fsSL https://raw.githubusercontent.com/PwiePixel/OnYourSite/main/server/install.sh | sudo bash
```

- **the code** from GitHub
- **Apache with PHP-FPM** (the same `.htaccess` as on Plesk) and **MariaDB** – the database, its own database user, a random password, `config.php` with new keys and the upload folder are created automatically
- **HTTPS for the domain and every subdomain** (`*.on-your.site` – also the ones added later) with a free Let’s Encrypt certificate that **renews itself**; if a renewal ever fails, all admins get an email two weeks before it runs out
- **protection**: a firewall (only SSH, HTTP and HTTPS), fail2ban against password guessing on SSH, automatic security updates, a database that only answers the server itself, PHP that can’t start other programs, hardened network settings – and, if you like, SSH logins only with a key
- the **weekly report** every Monday at 8:00 and a **backup** every night
- your **admin account** (on a new installation)
- the **Discord bot** as a system service (optional)
- **moving your data** from the old server: database, uploads, `config.php` and the mail settings

## What you need

- **A server (VPS)** with Ubuntu 24.04 (22.04, Debian 12 and 13 work too), root access via SSH, 2 GB RAM recommended (1 GB works) and enough disk space for the uploads. A minimal Debian may lack `curl` – then `apt update && apt install -y curl` first. Logged in as root? Then leave out `sudo` in all commands here.
- **API access to the DNS of your domain.** A certificate for all subdomains (`*.on-your.site`) is only issued after a check in the DNS, and the installer does that check through the API of your DNS provider – it finds the provider by itself from the nameservers. Built in: **Cloudflare, Hetzner, IONOS, Netcup, INWX, all-inkl.com and Porkbun**; more than 150 others work through [acme.sh](https://github.com/acmesh-official/acme.sh/wiki/dnsapi). If the DNS of your domain is managed by Plesk itself or by a provider without an API, move the DNS to one of these first (Cloudflare is free – use “DNS only”, the grey cloud).
- **Mail:** the website sends its emails through the SMTP server in `email/smtp.json`. If your mailboxes are on the Plesk server, they don’t move with this installer – move them to a mail provider first and change the mail server under *Admin → Mail Server* and the MX records.

## Moving step by step

### 1. A day before: shorten the DNS time

At your DNS provider, set the TTL of the records for `@`, `www` and `*` to 300 seconds. Then the switch in step 5 takes minutes instead of hours.

### 2. Collect the data from the old server

Do this at a quiet time – whatever is saved on the old server after this moment doesn’t move.

| What | Where |
|---|---|
| Uploads | Website → *Admin → Storage & backups → Download all uploads (ZIP)* |
| Database | Plesk → *Databases* → your database → *Export Dump* (download the file) |
| `config.php` | Plesk → *Files* → `httpdocs/config.php` |
| `smtp.json` | Plesk → *Files* → `httpdocs/email/smtp.json` |

Put the four files into one folder on the new server, e.g. from your computer:

```bash
ssh root@NEW-SERVER mkdir -p /root/import
scp config.php smtp.json DATABASE-DUMP.zip onyoursite-uploads-DATE.zip root@NEW-SERVER:/root/import/
```

(or upload them with an SFTP program like FileZilla or WinSCP).

### 3. Run the installer

Log in to the new server (`ssh root@NEW-SERVER`) and start the installer with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/PwiePixel/OnYourSite/main/server/install.sh | sudo bash
```

(As root, `sudo` can be left out. No `curl` on a fresh Debian? `apt update && apt install -y curl` first. Rather keep the file? `curl -fsSLo install.sh https://raw.githubusercontent.com/PwiePixel/OnYourSite/main/server/install.sh && sudo bash install.sh` does the same.)

The installer installs git, gets the code into `/var/www/onyoursite` and goes on by itself. It asks for:

1. the **domain** (Enter = `on-your.site`),
2. the **folder with the files from the old server** (found automatically in `/root/import`),
3. the **API access of your DNS provider** – the provider is detected from the nameservers, Enter picks it; the values are typed in hidden and stay on the server (in `/root/.acme.sh`),
4. whether **SSH logins only with a key** are wanted (only asked if the server has an SSH key – say yes only if you log in with a key),
5. on a new installation: **your admin account** (name, email, page address, password),
6. whether to set up the **Discord bot**.

Everything else happens by itself. Running it again is safe – Enter keeps every value.

From the import it takes the database (a dump from Plesk, phpMyAdmin or mysqldump: `.sql`, `.sql.gz` or `.zip`), the uploads, the mail settings and everything from `config.php` except the database access – above all `aes_key`: without it, encrypted data (Discord IDs, messages, booking requests, tickets) can’t be read. The database gets its own user with a new password, and on the first request the website brings the tables up to date by itself.

> Already have the code on the server (e.g. `git clone` into `/var/www/onyoursite`)? Then start `sudo bash /var/www/onyoursite/server/install.sh` – it’s the same installer. To try a branch before it’s merged: `… | sudo bash -s -- --branch NAME` (once that branch is merged and deleted, `--update` switches back to `main` by itself). If the repository is ever private, the installer shows a read-only deploy key to add once on GitHub.

### 4. Test before switching

Add this line to the hosts file of your computer (Windows: `C:\Windows\System32\drivers\etc\hosts`, opened as administrator; macOS and Linux: `/etc/hosts`):

```
NEW-SERVER-IP  on-your.site www.on-your.site yourname.on-your.site
```

Open the website, log in, open a profile, upload a picture, look at the admin panel. Remove the line afterwards.

### 5. Switch the DNS

At your DNS provider, point the A records of `@`, `www` and `*` to the new server (and the AAAA records, if the server has IPv6 – delete AAAA records that still point to the old server). The certificate is already there: it was created through the DNS API, no matter where the domain pointed at that time.

### 6. Afterwards

- **Discord bot:** if you skipped it, run the installer again and answer `y` at “Set up the Discord bot” – it puts the shared secret into `config.php` by itself.
- **Delete the import folder** – it holds passwords and the whole database: `rm -rf /root/import`
- **Switch off the website on the old server**, so nobody keeps using it by accident. Keep a Plesk backup for a while.

## HTTPS certificate

One certificate covers `on-your.site` and `*.on-your.site`, so every profile and code page – also every new one – has HTTPS right away. A timer checks it every day: about 30 days before it ends, it is renewed through the DNS API and Apache reloads it, without any downtime. If the renewal doesn’t work (most often because the API token was deleted or has expired) and the certificate has less than 14 days left, every admin gets an email through the mail server of the website. Then run `sudo bash /var/www/onyoursite/server/install.sh --https` and enter a new API token.

## Protection

| | |
|---|---|
| Firewall (ufw) | Only SSH, HTTP (80) and HTTPS (443) come in. The SSH port is detected – also when it isn’t 22 – so you can’t lock yourself out. |
| fail2ban | 5 wrong SSH logins within 10 minutes block that address for an hour. |
| Updates | Security updates of the system install by themselves every day. |
| SSH | Optional: logins only with a key (`/etc/ssh/sshd_config.d/00-onyoursite.conf`; undo: delete it and `systemctl reload ssh`). |
| Database | Only reachable from the server itself, its own user with a long random password, no reading of files through SQL. |
| PHP | Can’t start other programs; hidden version; uploads up to 16 MB, bigger requests are refused before they reach PHP. |
| Web server | Internal folders, `config.php`, `.git` and hidden files are locked twice (`.htaccess` and server config); unknown addresses (like the bare IP) get a 404; logs without IP addresses. |
| Files | The code belongs to root – the web server may only write to the upload folder and `email/`. `config.php` is readable only by root and the web server. |
| Network | No redirected or source-routed packets, SYN cookies against floods. |

## Everyday

| | |
|---|---|
| Update to the newest version | `sudo bash /var/www/onyoursite/server/install.sh --update` – gets the code (git pull), reloads everything and updates the bot; settings stay |
| Change settings, turn something on | `sudo bash /var/www/onyoursite/server/install.sh` (Enter keeps the current values) |
| Certificate after “Later” or for a new DNS provider | `sudo bash /var/www/onyoursite/server/install.sh --https` |
| Website errors | `/var/log/apache2/onyoursite-error.log` |
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
| Certificate | `/etc/ssl/onyoursite/` – issued and renewed by acme.sh (`/root/.acme.sh`) |
| Apache | `/etc/apache2/sites-available/onyoursite.conf` |
| PHP | `/etc/php/<version>/fpm/conf.d/90-onyoursite.ini` |
| Discord bot | `/opt/onyoursite-bot`, settings in `/etc/onyoursite-bot.env` (only root) |

The installer rewrites the Apache, PHP, firewall and timer settings every time it runs, so change the installer instead of these files.

## New installation without old data

Run the installer and answer `no` at the import folder. At the end it creates your admin account with your page. More admins later: *Admin → User Management*.
