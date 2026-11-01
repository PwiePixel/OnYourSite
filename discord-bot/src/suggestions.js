'use strict';
// Vorschläge: neue Beiträge im Forum-Kanal landen auf der Webseite. Das Team nimmt sie in Discord
// (Knöpfe) oder auf der Webseite (Admin → Community) an oder lehnt sie ab – beides bleibt gleich.
const {
  Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, escapeMarkdown,
} = require('discord.js');
const { COLORS, embed, notice, clip } = require('./embeds');
const { isTeam } = require('./team');

const LABEL = { open: 'Open', accepted: 'Accepted', declined: 'Declined' };

function statusEmbed(s) {
  const color = s.status === 'accepted' ? COLORS.green : s.status === 'declined' ? COLORS.red : COLORS.brand;
  const e = embed(color)
    .setTitle(`Suggestion #${s.id}`)
    .setDescription(escapeMarkdown(clip(s.title, 300)))
    .addFields({ name: 'Status', value: LABEL[s.status] || s.status, inline: true });
  if (s.status === 'open') {
    e.addFields({ name: 'Next step', value: 'The team will review this suggestion.', inline: true });
  } else {
    e.addFields({ name: 'Decided by', value: escapeMarkdown(clip(s.decided_by || 'Team', 80)) + (s.decided_via === 'web' ? ' (website)' : ''), inline: true });
    if (s.reason) e.addFields({ name: 'Note from the team', value: escapeMarkdown(clip(s.reason, 1000)) });
  }
  return e;
}

function decisionButtons(s) {
  if (s.status !== 'open') return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sug:accept:${s.id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sug:decline:${s.id}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
  )];
}

function setupSuggestions(client, cfg, site, log) {
  // Der erste Beitrag eines Threads kommt manchmal kurz nach dem Thread an
  async function starterMessage(thread) {
    for (let i = 0; i < 4; i++) {
      const msg = await thread.fetchStarterMessage().catch(() => null);
      if (msg) return msg;
      await new Promise((r) => setTimeout(r, 750));
    }
    return null;
  }

  // Entscheidung in Discord sichtbar machen: Status-Embed, Forum-Tag, kurze Mitteilung im Thread
  async function applyDecision(s, { announce = true } = {}) {
    const thread = await client.channels.fetch(s.thread_id).catch(() => null);
    if (!thread || !thread.isThread()) throw new Error('The suggestion thread no longer exists.');
    if (thread.archived) await thread.setArchived(false, 'Suggestion decided');
    if (s.status_message_id) {
      const msg = await thread.messages.fetch(s.status_message_id).catch(() => null);
      if (msg) await msg.edit({ embeds: [statusEmbed(s)], components: decisionButtons(s) });
    }
    const tag = s.status === 'accepted' ? cfg.tagAcceptedId : s.status === 'declined' ? cfg.tagDeclinedId : '';
    if (tag) {
      const keep = (thread.appliedTags || []).filter((t) => t !== cfg.tagAcceptedId && t !== cfg.tagDeclinedId);
      await thread.setAppliedTags([...keep, tag].slice(0, 5), 'Suggestion decided').catch((err) => log(`Tag for suggestion #${s.id} failed: ${err.message}`));
    }
    if (announce) {
      const text = `This suggestion was **${s.status}** by ${escapeMarkdown(clip(s.decided_by || 'the team', 80))}.` + (s.reason ? `\n\n${escapeMarkdown(clip(s.reason, 1000))}` : '');
      await thread.send({ embeds: [notice(text, s.status === 'accepted' ? COLORS.green : COLORS.red)] });
    }
  }

  client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
    if (!newlyCreated || !cfg.suggestionForumId || thread.parentId !== cfg.suggestionForumId || thread.guildId !== cfg.guildId) return;
    try {
      const starter = await starterMessage(thread);
      const owner = await client.users.fetch(thread.ownerId).catch(() => null);
      let body = starter ? starter.content : '';
      if (starter && starter.attachments.size) body += `\n\n[${starter.attachments.size} attachment(s) in Discord]`;
      const res = await site.post('/_/bot/suggestions', {
        thread_id: thread.id,
        author_id: thread.ownerId,
        author_name: owner ? (owner.globalName || owner.username) : '',
        title: thread.name,
        body,
      });
      if (!res.ok) {
        log(`Suggestion ${thread.id} could not be saved: ${res.error}`);
        await thread.send({ embeds: [notice('This suggestion could not be saved on the website right now. The team will take care of it.', COLORS.amber)] });
        return;
      }
      const msg = await thread.send({ embeds: [statusEmbed(res.suggestion)], components: decisionButtons(res.suggestion) });
      await site.post(`/_/bot/suggestions/${res.suggestion.id}`, { status_message_id: msg.id });
      log(`Suggestion #${res.suggestion.id} saved (${thread.id}).`);
    } catch (err) {
      log(`Suggestion ${thread.id} failed: ${err.message}`);
    }
  });

  async function handleInteraction(interaction) {
    const parts = interaction.customId.split(':');
    const action = parts[1];
    const id = /^\d+$/.test(parts[2] || '') ? parts[2] : null;
    if (!id || !['accept', 'decline'].includes(action)) return;
    if (!isTeam(interaction.member, cfg)) {
      await interaction.reply({ embeds: [notice('Only the team can accept or decline suggestions.', COLORS.gray)], flags: MessageFlags.Ephemeral });
      return;
    }
    // Knopf → Fenster mit optionaler Notiz
    if (interaction.isButton() && parts[0] === 'sug') {
      const modal = new ModalBuilder()
        .setCustomId(`sugm:${action}:${id}`)
        .setTitle(action === 'accept' ? `Accept suggestion #${id}` : `Decline suggestion #${id}`)
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('reason').setLabel('Note for the community (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
        ));
      await interaction.showModal(modal);
      return;
    }
    if (!interaction.isModalSubmit() || parts[0] !== 'sugm') return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const res = await site.post(`/_/bot/suggestions/${id}/decision`, {
      status: action === 'accept' ? 'accepted' : 'declined',
      reason: interaction.fields.getTextInputValue('reason') || '',
      by_name: interaction.member.displayName || interaction.user.username,
      by_id: interaction.user.id,
      thread_id: interaction.channelId,
    });
    if (!res.ok) {
      await interaction.editReply({ embeds: [notice(`The website did not save this: ${res.error}`, COLORS.red)] });
      return;
    }
    if (!res.changed) {
      await applyDecision(res.suggestion, { announce: false }).catch(() => {});
      await interaction.editReply({ embeds: [notice(`Suggestion #${id} was already ${res.suggestion.status} by ${escapeMarkdown(res.suggestion.decided_by)}.`, COLORS.gray)] });
      return;
    }
    await applyDecision(res.suggestion);
    await interaction.editReply({ embeds: [notice(`Saved – suggestion #${id} is now ${res.suggestion.status}.`, COLORS.green)] });
  }

  return { handleInteraction, applyDecision };
}

module.exports = { setupSuggestions, statusEmbed, decisionButtons };
