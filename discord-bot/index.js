'use strict';
// OnYourSite Discord-Bot: Begrüßung, Vorschläge (Forum → Webseite), Support-Tickets und die Updates der Webseite
// (in #updates) – verbunden mit der Webseite.
// Start: npm start · Verbindung zur Webseite prüfen: npm run check (Anleitung: README.md)
const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const { readConfig } = require('./src/config');
const { SiteClient } = require('./src/site');
const { COLORS, notice } = require('./src/embeds');
const { setupWelcome } = require('./src/welcome');
const { setupSuggestions } = require('./src/suggestions');
const { setupSupport } = require('./src/support');
const { startOutbox } = require('./src/outbox');
const { registerCommands, setupCommands } = require('./src/commands');
const { setupUpdates } = require('./src/updates');
const { setupReport } = require('./src/report');

// Funktionen dieser Version: die Webseite gibt dem Bot nur Aufträge, die er kann
const FEATURES = ['updates.v1', 'suggestions.v2'];

const log = (...args) => console.log(new Date().toISOString(), ...args);

// Einrichtung für install.sh (Bot prüfen, Server finden, Rolle und Kanäle anlegen) – braucht nur das Token
if (process.argv.some((a) => ['--discord-app', '--discord-guilds', '--discord-setup', '--discord-channel', '--channel-keys'].includes(a))) {
  require('./src/setup').cli(process.argv).then((code) => process.exit(code));
  return;
}

const { cfg, problems } = readConfig();
if (problems.length) {
  problems.forEach((p) => console.error(`Config: ${p}`));
  console.error('Fill in .env (see .env.example) and start again.');
  process.exit(1);
}
const site = new SiteClient(cfg.siteUrl, cfg.botSecret, { log });

if (process.argv.includes('--check')) {
  site.get('/_/bot/ping').then((res) => {
    if (res.ok) {
      const features = Array.isArray(res.features) ? res.features : [];
      console.log(`Website connection OK (${res.site}).`);
      console.log(`The website supports: ${features.length ? features.join(', ') : 'suggestions and tickets (an older version of the website)'}.`);
    } else {
      console.log(`Website connection failed: ${res.error}`);
    }
    process.exit(res.ok ? 0 : 1);
  });
  return;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  // Niemand wird aus Versehen erwähnt (z. B. @everyone in einem Vorschlag) – nur wo es ausdrücklich erlaubt ist
  allowedMentions: { parse: [], repliedUser: false },
});

setupWelcome(client, cfg, log);
// Bericht an die Webseite; seine Antwort nennt die Funktionen der Webseite (z. B. suggestions.v2)
const report = setupReport(client, cfg, site, log, FEATURES);
const suggestions = setupSuggestions(client, cfg, site, log, { siteFeatures: () => report.siteFeatures() });
const support = setupSupport(client, cfg, site, log);
const commands = setupCommands(cfg, site, support);
const updates = setupUpdates(client, log);
let outbox = null;

client.on(Events.InteractionCreate, async (interaction) => {
  // Nur auf dem eigenen Server
  if (!interaction.inGuild() || interaction.guildId !== cfg.guildId) return;
  try {
    if (interaction.isChatInputCommand()) return await commands.handle(interaction);
    const id = interaction.customId || '';
    if (id.startsWith('sug')) return await suggestions.handleInteraction(interaction);
    if (id.startsWith('tkt')) return await support.handleInteraction(interaction);
  } catch (err) {
    log(`Interaction ${interaction.customId || interaction.commandName} failed: ${err.message}`);
    const payload = { embeds: [notice('Something went wrong. Please try again in a moment.', COLORS.red)] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.once(Events.ClientReady, async (ready) => {
  log(`Logged in as ${ready.user.tag}.`);
  if (!ready.guilds.cache.has(cfg.guildId)) log('The bot is not on the server from GUILD_ID yet – invite it first (README.md).');
  await registerCommands(cfg).then(() => log('Slash commands are registered.')).catch((err) => log(`Slash commands failed: ${err.message}`));
  // Das Ticket-Panel im Support-Kanal: fehlt es, postet der Bot es selbst
  await support.ensurePanel()
    .then((posted) => { if (posted) log('Posted the support panel.'); })
    .catch((err) => log(`Support panel: ${err.message}`));
  const ping = await site.get('/_/bot/ping');
  log(ping.ok ? `Website connected (${ping.site}).` : `Website not reachable: ${ping.error}`);
  // Bericht an die Webseite (Kanäle, Rechte, #updates) – danach alle 10 Minuten und nach Änderungen
  report.start();
  // In Discord gelöschte Vorschläge, die der Bot verpasst hat: 10 Minuten nach dem Start, dann täglich
  suggestions.startDailyCheck();
  // Änderungen von der Webseite in Discord umsetzen
  outbox = startOutbox(site, {
    'suggestion.decided': (s) => suggestions.applyDecision(s),
    'ticket.reply': (t) => support.postReply(t, t.author_name, t.body),
    'ticket.close': (t) => support.closeChannel(t, t.by_name),
    'update.post': (d, item) => updates.post(d, item),
    'update.edit': (d) => updates.edit(d),
    'update.delete': (d) => updates.remove(d),
    'update.test': (d, item) => updates.test(d, item),
    'suggestions.notice': (d) => suggestions.applyNotice(d),
    'bot.report': async () => {
      await report.send();
      return {};
    },
  }, cfg.pollSeconds, log, { features: FEATURES });
});

process.on('unhandledRejection', (err) => log(`Unhandled error: ${err && err.message ? err.message : err}`));

// Beenden (systemctl stop / docker stop schicken SIGTERM): nichts Neues abholen, noch offene Rückmeldungen an die
// Webseite senden (höchstens 3 s), dann abmelden
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`Stopping (${signal}).`);
  report.stop();
  suggestions.stopDailyCheck();
  if (outbox) await outbox.stop(3000).catch(() => {});
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(cfg.token).catch((err) => {
  console.error(`Login failed: ${err.message}`);
  if (/disallowed intents/i.test(err.message)) console.error('Turn on “Server Members Intent” and “Message Content Intent” in the Developer Portal (Bot tab).');
  process.exit(1);
});
