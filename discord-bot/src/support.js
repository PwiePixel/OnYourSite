'use strict';
// Support: Knopf „Open a ticket“ → privater Kanal nur für die Person und das Team. Alles, was dort geschrieben
// wird, landet auf der Webseite (Admin → Community); Antworten von der Webseite erscheinen im Kanal.
const {
  Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
  ChannelType, PermissionFlagsBits, escapeMarkdown,
} = require('discord.js');
const { COLORS, embed, notice, clip } = require('./embeds');
const { isTeam } = require('./team');

const P = PermissionFlagsBits;
const pad = (id) => String(id).padStart(4, '0');

function panelMessage() {
  return {
    embeds: [embed()
      .setTitle('Support')
      .setDescription('Need help with your page or your account? Open a ticket – a private channel that only you and the team can see.')
      .addFields({ name: 'Before you ask', value: 'Please never share your password. The team will never ask for it.' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tkt:open').setLabel('Open a ticket').setStyle(ButtonStyle.Primary),
    )],
  };
}

function closeButton(ticketId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tkt:close:${ticketId}`).setLabel('Close ticket').setStyle(ButtonStyle.Secondary),
  );
}

function setupSupport(client, cfg, site, log) {
  const ticketByChannel = new Map(); // Kanal-ID → Ticket-ID

  async function ticketForChannel(channel) {
    if (ticketByChannel.has(channel.id)) return ticketByChannel.get(channel.id);
    if (!cfg.supportCategoryId || channel.parentId !== cfg.supportCategoryId || !/^(ticket|closed)-\d+$/.test(channel.name || '')) return null;
    const res = await site.get(`/_/bot/tickets/by-channel/${channel.id}`);
    const id = res.ok ? res.ticket.id : null;
    if (id) ticketByChannel.set(channel.id, id);
    return id;
  }

  // Ticket schließen: Hinweis, Person kann nicht mehr schreiben, Kanal heißt „closed-0012“ (das Team kann ihn löschen)
  async function closeChannel(ticket, byName) {
    const channel = ticket.channel_id ? await client.channels.fetch(ticket.channel_id).catch(() => null) : null;
    if (!channel) throw new Error('The ticket channel no longer exists.');
    await channel.send({ embeds: [notice(`This ticket was closed by ${escapeMarkdown(clip(byName || 'the team', 80))}. Thank you!`, COLORS.gray)] });
    await channel.permissionOverwrites.edit(ticket.user_id, { SendMessages: false }, { reason: 'Ticket closed' }).catch((err) => log(`Lock of ticket #${ticket.id} failed: ${err.message}`));
    await channel.setName(`closed-${pad(ticket.id)}`, 'Ticket closed').catch((err) => log(`Rename of ticket #${ticket.id} failed: ${err.message}`));
  }

  async function postReply(ticket, authorName, body) {
    const channel = ticket.channel_id ? await client.channels.fetch(ticket.channel_id).catch(() => null) : null;
    if (!channel) throw new Error('The ticket channel no longer exists.');
    await channel.send({
      content: `<@${ticket.user_id}>`,
      embeds: [embed().setAuthor({ name: `${clip(authorName || 'Team', 80)} · OnYourSite team` }).setDescription(clip(body, 4000))],
      allowedMentions: { users: [ticket.user_id] },
    });
  }

  async function openTicket(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const user = interaction.user;
    const res = await site.post('/_/bot/tickets', {
      user_id: user.id,
      user_name: interaction.member.displayName || user.username,
      subject: interaction.fields.getTextInputValue('subject'),
      body: interaction.fields.getTextInputValue('message'),
    });
    if (!res.ok && res.httpStatus === 409 && res.ticket) {
      const where = res.ticket.channel_id ? `<#${res.ticket.channel_id}>` : 'your open ticket';
      await interaction.editReply({ embeds: [notice(`You already have an open ticket: ${where}. Please continue there.`, COLORS.gray)] });
      return;
    }
    if (!res.ok) {
      await interaction.editReply({ embeds: [notice(`Your ticket could not be created: ${res.error}`, COLORS.red)] });
      return;
    }
    const ticket = res.ticket;
    let channel;
    try {
      // Nur die Person, das Team und der Bot sehen den Kanal
      channel = await guild.channels.create({
        name: `ticket-${pad(ticket.id)}`,
        type: ChannelType.GuildText,
        parent: cfg.supportCategoryId || undefined,
        topic: `OnYourSite support ticket #${ticket.id}`,
        reason: `Support ticket #${ticket.id}`,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
          { id: user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks] },
          { id: cfg.teamRoleId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.ManageMessages] },
          { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.ManageChannels, P.ManageMessages] },
        ],
      });
    } catch (err) {
      log(`Ticket channel for #${ticket.id} failed: ${err.message}`);
      await site.post(`/_/bot/tickets/${ticket.id}/close`, { by_name: 'Bot (channel could not be created)' });
      await interaction.editReply({ embeds: [notice('Your ticket could not be created right now. Please try again later.', COLORS.red)] });
      return;
    }
    ticketByChannel.set(channel.id, ticket.id);
    await site.post(`/_/bot/tickets/${ticket.id}/channel`, { channel_id: channel.id });
    await channel.send({
      content: `<@${user.id}>`,
      embeds: [embed()
        .setTitle(`Ticket #${ticket.id}: ${clip(ticket.subject, 200)}`)
        .setDescription(escapeMarkdown(clip(interaction.fields.getTextInputValue('message'), 3500)))
        .addFields({ name: 'What happens now?', value: 'The team will answer here as soon as possible. You can add details or screenshots in this channel.' })],
      components: [closeButton(ticket.id)],
      allowedMentions: { users: [user.id] },
    });
    await interaction.editReply({ embeds: [notice(`Your ticket is open: ${channel}`, COLORS.green)] });
    log(`Ticket #${ticket.id} opened by ${user.id}.`);
  }

  // Nachrichten im Ticket-Kanal auf der Webseite speichern
  client.on(Events.MessageCreate, async (message) => {
    if (!message.guild || message.guild.id !== cfg.guildId || message.author.bot || message.system) return;
    try {
      const ticketId = await ticketForChannel(message.channel);
      if (!ticketId) return;
      let body = message.content || '';
      if (message.attachments.size) body += `${body ? '\n\n' : ''}[${message.attachments.size} attachment(s): ${[...message.attachments.values()].map((a) => a.name).join(', ')}]`;
      if (!body.trim()) return;
      const res = await site.post(`/_/bot/tickets/${ticketId}/messages`, {
        message_id: message.id,
        author_id: message.author.id,
        author_name: (message.member && message.member.displayName) || message.author.username,
        team: isTeam(message.member, cfg),
        body,
      });
      if (!res.ok) log(`Ticket #${ticketId}: message ${message.id} not saved: ${res.error}`);
    } catch (err) {
      log(`Ticket message ${message.id} failed: ${err.message}`);
    }
  });

  async function handleInteraction(interaction) {
    const parts = interaction.customId.split(':');
    if (interaction.isButton() && interaction.customId === 'tkt:open') {
      const modal = new ModalBuilder().setCustomId('tktm:create').setTitle('Open a support ticket').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject').setLabel('Subject').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('How can we help?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500)),
      );
      await interaction.showModal(modal);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId === 'tktm:create') {
      await openTicket(interaction);
      return;
    }
    const id = /^\d+$/.test(parts[2] || '') ? Number(parts[2]) : null;
    if (!id || !interaction.isButton()) return;
    // Schließen: nur die Person, der das Ticket gehört, oder das Team – erst nach Rückfrage
    const info = await site.get(`/_/bot/tickets/by-channel/${interaction.channelId}`);
    if (!info.ok || info.ticket.id !== id) {
      await interaction.reply({ embeds: [notice('This button doesn’t belong to a ticket in this channel.', COLORS.gray)], flags: MessageFlags.Ephemeral });
      return;
    }
    if (info.ticket.user_id !== interaction.user.id && !isTeam(interaction.member, cfg)) {
      await interaction.reply({ embeds: [notice('Only the person who opened this ticket or the team can close it.', COLORS.gray)], flags: MessageFlags.Ephemeral });
      return;
    }
    if (parts[1] === 'close') {
      await interaction.reply({
        embeds: [notice('Close this ticket? You can open a new one at any time.', COLORS.gray)],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`tkt:closeok:${id}`).setLabel('Close ticket').setStyle(ButtonStyle.Danger),
        )],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (parts[1] !== 'closeok') return;
    await interaction.deferUpdate();
    const name = interaction.member.displayName || interaction.user.username;
    const res = await site.post(`/_/bot/tickets/${id}/close`, { by_name: name, by_id: interaction.user.id });
    if (!res.ok) {
      await interaction.editReply({ embeds: [notice(`The ticket could not be closed: ${res.error}`, COLORS.red)], components: [] });
      return;
    }
    if (res.changed) await closeChannel(res.ticket, name);
    await interaction.editReply({ embeds: [notice(res.changed ? 'The ticket is closed.' : 'This ticket was already closed.', COLORS.gray)], components: [] });
  }

  return { handleInteraction, panelMessage, closeChannel, postReply };
}

module.exports = { setupSupport, panelMessage };
