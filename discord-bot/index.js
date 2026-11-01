'use strict';
// OnYourSite Discord-Bot: Begrüßung, Vorschläge (Forum → Webseite) und Support-Tickets – verbunden mit der Webseite.
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

const log = (...args) => console.log(new Date().toISOString(), ...args);

const { cfg, problems } = readConfig();
if (problems.length) {
  problems.forEach((p) => console.error(`Config: ${p}`));
  console.error('Fill in .env (see .env.example) and start again.');
  process.exit(1);
}
const site = new SiteClient(cfg.siteUrl, cfg.botSecret);

if (process.argv.includes('--check')) {
  site.get('/_/bot/ping').then((res) => {
    console.log(res.ok ? `Website connection OK (${res.site}).` : `Website connection failed: ${res.error}`);
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
const suggestions = setupSuggestions(client, cfg, site, log);
const support = setupSupport(client, cfg, site, log);
const commands = setupCommands(cfg, site, support);

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
  const ping = await site.get('/_/bot/ping');
  log(ping.ok ? `Website connected (${ping.site}).` : `Website not reachable: ${ping.error}`);
  // Änderungen von der Webseite in Discord umsetzen
  startOutbox(site, {
    'suggestion.decided': (s) => suggestions.applyDecision(s),
    'ticket.reply': (t) => support.postReply(t, t.author_name, t.body),
    'ticket.close': (t) => support.closeChannel(t, t.by_name),
  }, cfg.pollSeconds, log);
});

process.on('unhandledRejection', (err) => log(`Unhandled error: ${err && err.message ? err.message : err}`));
process.on('SIGINT', () => { log('Stopping.'); client.destroy(); process.exit(0); });

client.login(cfg.token).catch((err) => {
  console.error(`Login failed: ${err.message}`);
  if (/disallowed intents/i.test(err.message)) console.error('Turn on “Server Members Intent” and “Message Content Intent” in the Developer Portal (Bot tab).');
  process.exit(1);
});
