'use strict';
// Vorschläge: neue Beiträge im Forum-Kanal landen auf der Webseite. Das Team nimmt sie in Discord
// (Knöpfe) oder auf der Webseite (Admin → Community) an oder lehnt sie ab – beides bleibt gleich.
//
// Öffentliche Vorschlagsseite der Webseite (suggestions.v2, nur wenn die Webseite es kann):
// - Solange sie an ist, steht im Status-Embed jedes neuen Beitrags der Hinweis darauf; der Bot sagt der Webseite, dass
//   der Autor ihn bekommen hat (web_notice) – nur solche Beiträge erscheinen dort von selbst.
// - Wird ein Beitrag (oder seine erste Nachricht) gelöscht, verschwindet sein Text von der Webseite: über die rohen
//   Gateway-Ereignisse (discord.js meldet threadDelete nur für Threads im Cache) und eine tägliche Prüfung.
// - Auftrag suggestions.notice: der Satz über die Webseite in den Richtlinien des Forums (topic), der Rest bleibt.
const {
  Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, escapeMarkdown,
} = require('discord.js');
const { COLORS, embed, notice, clip } = require('./embeds');
const { isTeam } = require('./team');

const LABEL = { open: 'Open', accepted: 'Accepted', declined: 'Declined' };
const SNOWFLAKE = /^\d{15,25}$/;
// Der Satz der Webseite in den Richtlinien des Forums (auch mit einer früheren Adresse); ohne verschachtelte
// Wiederholungen, damit kein Text das Muster ausbremsen kann
const GUIDELINE = /Decided ideas are shown on \S{1,200} without your name\./g;

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
  if (webNotice(s)) {
    e.addFields({ name: 'Website', value: `Once decided, this idea is shown on ${escapeMarkdown(clip(String(s.web.host), 100))}/suggestions, without your name.` });
  }
  return e;
}

// Bekommt dieser Beitrag den Hinweis auf die Webseite? (die Seite ist an; ältere Webseiten senden kein web)
function webNotice(s) {
  return Boolean(s && s.web && s.web.notice === true && typeof s.web.host === 'string' && s.web.host !== '');
}

// Richtlinien des Forums mit oder ohne den Satz der Webseite. Steht er schon so da (oder fehlt er beim Ausschalten),
// bleibt der Text unverändert; sonst wird nur er entfernt bzw. ans Ende gesetzt (Leerzeilen um ihn herum fallen weg).
function guidelines(topic, on, sentence) {
  const current = String(topic || '');
  const found = current.match(GUIDELINE) || [];
  if (on ? found.length === 1 && found[0] === sentence : found.length === 0) return current;
  const without = current.replace(GUIDELINE, '').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!on) return without;
  return (without ? `${without}\n\n${sentence}` : sentence).slice(0, 4096);
}

function decisionButtons(s) {
  if (s.status !== 'open') return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sug:accept:${s.id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sug:decline:${s.id}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
  )];
}

// siteFeatures(): Funktionen der Webseite aus der Antwort auf den Bericht (null, solange unbekannt)
function setupSuggestions(client, cfg, site, log, { siteFeatures = () => null, pauseMs = 1000 } = {}) {
  const syncOn = () => {
    const f = siteFeatures();
    return Array.isArray(f) && f.includes('suggestions.v2');
  };
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
    // Ein Beitrag des Bots selbst (z. B. ein Update) ist kein Vorschlag
    if (client.user && thread.ownerId === client.user.id) return;
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
      // Der Hinweis auf die Webseite steht im Beitrag: der Autor weiß Bescheid
      await site.post(`/_/bot/suggestions/${res.suggestion.id}`, webNotice(res.suggestion) ? { status_message_id: msg.id, web_notice: true } : { status_message_id: msg.id });
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

  // Ein Beitrag (deleted) oder seine erste Nachricht (body_deleted) ist in Discord weg. 404 = kein Vorschlag (die erste
  // Nachricht irgendeines Forenbeitrags): nichts zu tun.
  async function reportDeleted(threadId, body) {
    if (!SNOWFLAKE.test(String(threadId))) return false;
    const res = await site.post(`/_/bot/suggestions/thread/${threadId}`, body);
    if (!res.ok && res.httpStatus !== 404) log(`Couldn’t tell the website that suggestion post ${threadId} was deleted: ${res.error}`);
    return res.ok === true;
  }

  // Rohe Gateway-Ereignisse: kommen auch für Threads, die nicht im Cache sind (archivierte Beiträge, nach einem Neustart)
  function onRaw(packet) {
    if (!packet || !packet.d || !syncOn() || !cfg.suggestionForumId) return null;
    const d = packet.d;
    if (d.guild_id !== undefined && d.guild_id !== cfg.guildId) return null;
    if (packet.t === 'THREAD_DELETE' && d.parent_id === cfg.suggestionForumId) return reportDeleted(d.id, { deleted: true });
    // Die erste Nachricht eines Forenbeitrags hat die ID des Beitrags
    if (packet.t === 'MESSAGE_DELETE' && d.id === d.channel_id) return reportDeleted(d.channel_id, { body_deleted: true });
    return null;
  }
  client.on(Events.Raw, (packet) => {
    const p = onRaw(packet);
    if (p) p.catch((err) => log(`Suggestion sync failed: ${err.message}`));
  });

  // Tägliche Prüfung: was der Bot verpasst hat, während er nicht lief. Höchstens eine Anfrage an Discord pro Sekunde;
  // fehlender Zugriff (50001/403) ist keine Löschung, andere Fehler versucht er am nächsten Tag wieder.
  let lastRequest = 0;
  async function throttle() {
    const wait = lastRequest + pauseMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
  }
  async function dailyCheck() {
    if (!syncOn()) return { checked: 0, deleted: 0, bodies: 0 };
    const out = { checked: 0, deleted: 0, bodies: 0 };
    let after = 0;
    for (let pages = 0; pages < 1000; pages++) {
      const res = await site.get(`/_/bot/suggestions/threads?after=${after}`);
      if (!res.ok) {
        log(`Daily suggestion check: ${res.error}`);
        break;
      }
      for (const item of Array.isArray(res.items) ? res.items : []) {
        if (!SNOWFLAKE.test(String(item.thread_id))) continue;
        out.checked++;
        await throttle();
        let thread = null;
        try {
          thread = await client.channels.fetch(String(item.thread_id), { force: true });
        } catch (err) {
          if (Number(err && err.code) === 10003 && await reportDeleted(item.thread_id, { deleted: true })) out.deleted++;
          continue;
        }
        if (!thread || !item.has_body) continue;
        await throttle();
        try {
          await thread.messages.fetch(String(item.thread_id));
        } catch (err) {
          if (Number(err && err.code) === 10008 && await reportDeleted(item.thread_id, { body_deleted: true })) out.bodies++;
        }
      }
      if (res.next === null || res.next === undefined) break;
      after = Number(res.next);
    }
    if (out.deleted || out.bodies) log(`Daily suggestion check: ${out.deleted} deleted post(s) and ${out.bodies} deleted text(s) removed from the website.`);
    return out;
  }
  let dailyTimer = null;
  function startDailyCheck(firstMs = 10 * 60 * 1000) {
    const run = () => dailyCheck().catch((err) => log(`Daily suggestion check failed: ${err.message}`));
    dailyTimer = setTimeout(() => {
      run();
      dailyTimer = setInterval(run, 24 * 60 * 60 * 1000);
      if (dailyTimer.unref) dailyTimer.unref();
    }, firstMs);
    if (dailyTimer.unref) dailyTimer.unref();
  }
  function stopDailyCheck() {
    clearTimeout(dailyTimer);
    clearInterval(dailyTimer);
  }

  // Auftrag suggestions.notice: den Satz in die Richtlinien des Forums setzen oder ihn entfernen
  async function applyNotice(data) {
    if (!cfg.suggestionForumId) throw Object.assign(new Error('There is no suggestion forum (SUGGESTION_FORUM_ID).'), { final: true });
    let forum;
    try {
      forum = await client.channels.fetch(cfg.suggestionForumId);
    } catch (err) {
      throw Object.assign(new Error(`The suggestion forum can’t be read: ${err.message}`), { final: Number(err && err.status) === 404 || Number(err && err.status) === 403 });
    }
    const sentence = String((data && data.text) || '').slice(0, 300);
    const next = guidelines(forum.topic, Boolean(data && data.on) && sentence !== '', sentence);
    if (next === String(forum.topic || '')) return {};
    try {
      await forum.setTopic(next, 'OnYourSite suggestions page');
    } catch (err) {
      const code = Number(err && err.code);
      throw Object.assign(new Error(`${err.message}${code ? ` (${code})` : ''}`), { final: [400, 403, 404].includes(Number(err && err.status)) });
    }
    return {};
  }

  return { handleInteraction, applyDecision, applyNotice, dailyCheck, startDailyCheck, stopDailyCheck, onRaw };
}

module.exports = { setupSuggestions, statusEmbed, decisionButtons, guidelines, webNotice };
