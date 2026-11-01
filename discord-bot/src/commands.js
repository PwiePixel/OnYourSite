'use strict';
// Slash-Befehle (nur für Leute mit „Server verwalten“). Sie gelten nur auf dem eigenen Server und sind sofort da.
const { SlashCommandBuilder, PermissionFlagsBits, REST, Routes, MessageFlags } = require('discord.js');
const { COLORS, embed, notice } = require('./embeds');

const definitions = [
  new SlashCommandBuilder()
    .setName('support-panel')
    .setDescription('Post the support panel with the “Open a ticket” button in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('bot-status')
    .setDescription('Check the connection between the bot and the website.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

async function registerCommands(cfg) {
  const rest = new REST({ version: '10' }).setToken(cfg.token);
  await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), { body: definitions.map((d) => d.toJSON()) });
}

function setupCommands(cfg, site, support) {
  async function handle(interaction) {
    // Doppelte Absicherung zusätzlich zu den Standard-Rechten des Befehls
    if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ embeds: [notice('You need the “Manage Server” permission for this.', COLORS.gray)], flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === 'support-panel') {
      await interaction.channel.send(support.panelMessage());
      await interaction.reply({ embeds: [notice('The support panel is posted.', COLORS.green)], flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === 'bot-status') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ping = await site.get('/_/bot/ping');
      const show = (id, kind) => (id ? (kind === 'role' ? `<@&${id}>` : `<#${id}>`) : 'not set');
      await interaction.editReply({ embeds: [embed(ping.ok ? COLORS.green : COLORS.red)
        .setTitle('Bot status')
        .addFields(
          { name: 'Website', value: ping.ok ? 'Connected' : `Not reachable: ${ping.error}` },
          { name: 'Team role', value: show(cfg.teamRoleId, 'role'), inline: true },
          { name: 'Welcome channel', value: show(cfg.welcomeChannelId), inline: true },
          { name: 'Suggestion forum', value: show(cfg.suggestionForumId), inline: true },
          { name: 'Ticket category', value: show(cfg.supportCategoryId), inline: true },
          { name: 'Checks the website every', value: `${cfg.pollSeconds} seconds`, inline: true },
        )] });
    }
  }
  return { handle };
}

module.exports = { definitions, registerCommands, setupCommands };
