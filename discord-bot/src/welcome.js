'use strict';
// Begrüßung neuer Mitglieder (braucht den „Server Members Intent“ im Developer Portal).
const { Events, escapeMarkdown } = require('discord.js');
const { embed } = require('./embeds');

function welcomeEmbed(member, cfg) {
  const host = new URL(cfg.siteUrl).host;
  const e = embed()
    .setTitle('Welcome to OnYourSite')
    .setDescription([
      `Hi **${escapeMarkdown(member.displayName)}**, great to have you here.`,
      '',
      `OnYourSite gives you your own link-in-bio page at **name.${host}** – free, with lots of themes and stats without cookies.`,
    ].join('\n'))
    .addFields({ name: 'Create your page', value: cfg.siteUrl });
  const more = [];
  if (cfg.rulesChannelId) more.push({ name: 'Rules', value: `<#${cfg.rulesChannelId}>`, inline: true });
  if (cfg.suggestionForumId) more.push({ name: 'Ideas', value: `<#${cfg.suggestionForumId}>`, inline: true });
  if (cfg.supportChannelId) more.push({ name: 'Help', value: `<#${cfg.supportChannelId}>`, inline: true });
  if (more.length) e.addFields(more);
  return e
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `Member #${member.guild.memberCount} · OnYourSite` });
}

function setupWelcome(client, cfg, log) {
  if (!cfg.welcomeChannelId) {
    log('Welcome messages are off (WELCOME_CHANNEL_ID is not set).');
    return;
  }
  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.id !== cfg.guildId || member.user.bot) return;
    try {
      const channel = await member.guild.channels.fetch(cfg.welcomeChannelId);
      if (!channel || !channel.isTextBased()) return;
      // Nur die Erwähnung steht außerhalb des Embeds – sonst bekäme das neue Mitglied keine Benachrichtigung
      await channel.send({ content: `<@${member.id}>`, embeds: [welcomeEmbed(member, cfg)], allowedMentions: { users: [member.id] } });
      if (cfg.welcomeRoleId) await member.roles.add(cfg.welcomeRoleId, 'Welcome role');
    } catch (err) {
      log(`Welcome for ${member.id} failed: ${err.message}`);
    }
  });
}

module.exports = { setupWelcome, welcomeEmbed };
