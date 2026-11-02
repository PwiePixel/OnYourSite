'use strict';
// Einstellungen aus der Umgebung bzw. einer .env-Datei (KEY=VALUE, Kommentare nur in eigenen Zeilen mit #).
const fs = require('fs');
const path = require('path');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    // Echte Umgebungsvariablen (z. B. im Hosting eingetragen) haben Vorrang
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function readConfig() {
  loadEnvFile(process.env.BOT_ENV_FILE || path.join(__dirname, '..', '.env'));
  const env = process.env;
  const id = (name) => {
    const value = String(env[name] || '').trim();
    return /^\d{15,22}$/.test(value) ? value : '';
  };
  const cfg = {
    token: String(env.DISCORD_TOKEN || '').trim(),
    clientId: id('DISCORD_CLIENT_ID'),
    guildId: id('GUILD_ID'),
    teamRoleId: id('TEAM_ROLE_ID'),
    welcomeChannelId: id('WELCOME_CHANNEL_ID'),
    welcomeRoleId: id('WELCOME_ROLE_ID'),
    rulesChannelId: id('RULES_CHANNEL_ID'),
    suggestionForumId: id('SUGGESTION_FORUM_ID'),
    tagAcceptedId: id('TAG_ACCEPTED_ID'),
    tagDeclinedId: id('TAG_DECLINED_ID'),
    supportChannelId: id('SUPPORT_CHANNEL_ID'),
    supportCategoryId: id('SUPPORT_CATEGORY_ID'),
    // Kanal für Updates der Webseite (optional; der Installer legt #updates an)
    updatesChannelId: id('UPDATES_CHANNEL_ID'),
    siteUrl: String(env.SITE_URL || '').trim().replace(/\/+$/, ''),
    botSecret: String(env.BOT_SECRET || '').trim(),
    pollSeconds: Math.max(5, Math.min(300, parseInt(env.POLL_SECONDS || '10', 10) || 10)),
  };

  const problems = [];
  if (!cfg.token) problems.push('DISCORD_TOKEN is missing.');
  if (!cfg.clientId) problems.push('DISCORD_CLIENT_ID is missing or not an ID.');
  if (!cfg.guildId) problems.push('GUILD_ID is missing or not an ID.');
  if (!cfg.teamRoleId) problems.push('TEAM_ROLE_ID is missing or not an ID.');
  // Nur https – außer für eine lokale Testseite
  if (!/^https:\/\/[^/]+/.test(cfg.siteUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|[a-z0-9.-]+\.test)(:\d+)?$/.test(cfg.siteUrl)) {
    problems.push('SITE_URL must be the address of the website, starting with https://');
  }
  if (cfg.botSecret.length < 32) problems.push('BOT_SECRET must be at least 32 characters – the same value as bot_secret in config.json of the website.');
  return { cfg, problems };
}

module.exports = { readConfig, loadEnvFile };
