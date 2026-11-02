'use strict';
// Updates der Webseite in Discord: posten, bearbeiten, entfernen und die Testnachricht (Aufträge update.* aus der
// Warteschlange der Webseite). Vor dem Posten prüft der Bot seine Rechte im Kanal. Fehler, die ein neuer Versuch nicht
// behebt (400, 403, 404, 50008), sind endgültig (final); Netzwerkfehler und 5xx versucht die Webseite später noch einmal.
const { ChannelType, PermissionFlagsBits: P } = require('discord.js');

const LABEL = { ViewChannel: 'View Channel', SendMessages: 'Send Messages', SendMessagesInThreads: 'Send Messages in Threads', EmbedLinks: 'Embed Links' };

// Fehler für die Webseite; final: ein neuer Versuch hilft nicht
function jobError(message, final) {
  const err = new Error(message);
  err.final = Boolean(final);
  return err;
}

// Fehler von Discord (discord.js) → Fehler für die Webseite, mit Discords Code (z. B. 50005 für „anderer Bot“)
function fromDiscord(err) {
  if (err && err.final !== undefined) return err;
  const status = Number(err && err.status) || 0;
  const code = Number(err && err.code) || 0;
  const text = String(err && err.message ? err.message : err).slice(0, 180) + (code ? ` (${code})` : '');
  return jobError(text, status === 400 || status === 403 || status === 404 || code === 50008);
}

const unknownChannel = (err) => Number(err && err.code) === 10003 || (Number(err && err.status) === 404 && Number(err && err.code) !== 10008);
const isThread = (c) => Boolean(c && typeof c.isThread === 'function' && c.isThread());

// Nachricht der Webseite (Form der Discord-API) → Form für discord.js; ohne Angabe pingt sie niemanden
function messageOf(m) {
  const msg = m && typeof m === 'object' ? m : {};
  const out = { embeds: Array.isArray(msg.embeds) ? msg.embeds : [] };
  if (typeof msg.content === 'string' && msg.content !== '') out.content = msg.content;
  const am = msg.allowed_mentions && typeof msg.allowed_mentions === 'object' ? msg.allowed_mentions : {};
  out.allowedMentions = { parse: Array.isArray(am.parse) ? am.parse : [] };
  if (Array.isArray(am.roles)) out.allowedMentions.roles = am.roles;
  return out;
}

const urlOf = (m) => (m && Array.isArray(m.embeds) && m.embeds[0] && typeof m.embeds[0].url === 'string' ? m.embeds[0].url : '');

// Nonce gegen doppelte Beiträge (Discord erkennt eine Wiederholung innerhalb einiger Minuten), höchstens 25 Zeichen
const nonceOf = (item) => `oys-${item && item.action}-${item && item.id}`.slice(0, 25);

function setupUpdates(client, log = () => {}) {
  async function channelOf(id) {
    if (!/^\d{15,25}$/.test(String(id || ''))) throw jobError('The channel no longer exists.', true);
    let channel = null;
    try {
      channel = await client.channels.fetch(String(id));
    } catch (err) {
      if (unknownChannel(err)) throw jobError('The channel no longer exists.', true);
      throw fromDiscord(err);
    }
    if (!channel) throw jobError('The channel no longer exists.', true);
    return channel;
  }

  // Darf der Bot hier posten? Sonst endgültig, mit der Liste der fehlenden Rechte
  function checkPermissions(channel) {
    const me = channel.guild && channel.guild.members ? channel.guild.members.me : null;
    const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    const need = ['ViewChannel', isThread(channel) ? 'SendMessagesInThreads' : 'SendMessages', 'EmbedLinks'];
    const missing = need.filter((n) => !perms || !perms.has(P[n]));
    if (missing.length) {
      throw jobError(`The bot can’t post in #${channel.name}: it needs ${missing.map((m) => LABEL[m]).join(', ')} there.`, true);
    }
  }

  // Ein eigener, schon geposteter Beitrag zu diesem Update (Erkennung über den Link im ersten Embed) – nach einer
  // Unterbrechung zwischen Beitrag und Rückmeldung an die Webseite
  async function findOwnPost(channel, data) {
    const url = urlOf(data.message);
    if (!url || !client.user) return null;
    const me = client.user.id;
    if (channel.type === ChannelType.GuildForum) {
      const active = await channel.threads.fetchActive();
      for (const thread of active.threads.values()) {
        if (thread.ownerId !== me || thread.name !== data.thread_name) continue;
        const starter = await thread.fetchStarterMessage().catch(() => null);
        if (starter && starter.embeds && starter.embeds[0] && starter.embeds[0].url === url) return { message_id: thread.id, channel_id: thread.id, found: true };
      }
      return null;
    }
    const recent = await channel.messages.fetch({ limit: 50 });
    for (const msg of recent.values()) {
      if (msg.author && msg.author.id === me && msg.embeds && msg.embeds[0] && msg.embeds[0].url === url) {
        return { message_id: msg.id, channel_id: channel.id, found: true };
      }
    }
    return null;
  }

  // Neue Nachricht: Forum → eigener Beitrag, Thread → (wieder geöffnet) hinein, sonst in den Kanal
  async function send(channel, data, item, fallbackName) {
    const msg = messageOf(data.message);
    if (channel.type === ChannelType.GuildForum) {
      const thread = await channel.threads.create({ name: String(data.thread_name || fallbackName).slice(0, 100), message: msg });
      return { message_id: thread.id, channel_id: thread.id };
    }
    if (isThread(channel) && channel.archived) await channel.setArchived(false, 'OnYourSite update');
    const sent = await channel.send(item ? { ...msg, nonce: nonceOf(item), enforceNonce: true } : msg);
    return { message_id: sent.id, channel_id: channel.id };
  }

  // Discord lehnt Änderungen in einem archivierten Thread oder Forenbeitrag ab (50083): erst wieder öffnen, wie beim Posten
  async function reopen(channel, reason) {
    if (isThread(channel) && channel.archived) await channel.setArchived(false, reason);
  }

  // update.post: recheck → erst nach einem eigenen Beitrag sehen; only_if_posted → nur einen schon vorhandenen melden
  async function post(data, item) {
    const channel = await channelOf(data.channel_id);
    checkPermissions(channel);
    try {
      if (data.recheck || data.only_if_posted) {
        const found = await findOwnPost(channel, data);
        if (found) return found;
        if (data.only_if_posted) return { found: false };
      }
      return await send(channel, data, item, 'OnYourSite update');
    } catch (err) {
      throw fromDiscord(err);
    }
  }

  // update.edit: nur das Embed (pingt nie neu); bei einem Forenbeitrag auch der Titel
  async function edit(data) {
    let channel;
    try {
      channel = await channelOf(data.channel_id);
    } catch (err) {
      if (err.message === 'The channel no longer exists.') return { missing: true };
      throw err;
    }
    try {
      const msg = await channel.messages.fetch(String(data.message_id || ''));
      await reopen(channel, 'OnYourSite update edited');
      await msg.edit({ embeds: messageOf(data.message).embeds });
      if (data.kind === 'forum_post' && isThread(channel) && data.thread_name && channel.name !== data.thread_name) {
        await channel.setName(String(data.thread_name).slice(0, 100), 'OnYourSite update edited');
      }
      return {};
    } catch (err) {
      if (Number(err && err.code) === 10008) return { missing: true };
      throw fromDiscord(err);
    }
  }

  // update.delete: einen Forenbeitrag ganz löschen (ohne Recht dazu: seine erste Nachricht), sonst die Nachricht
  async function remove(data) {
    let channel;
    try {
      channel = await channelOf(data.channel_id);
    } catch (err) {
      if (err.message === 'The channel no longer exists.') return { missing: true };
      throw err;
    }
    try {
      if (data.kind === 'forum_post' && isThread(channel)) {
        try {
          await channel.delete('OnYourSite update removed');
          return {};
        } catch (err) {
          if (Number(err && err.status) !== 403) throw err;
          log(`Couldn’t delete the forum post ${channel.id} (no permission) – deleting its first message instead.`);
        }
      }
      const msg = await channel.messages.fetch(String(data.message_id || ''));
      await reopen(channel, 'OnYourSite update removed');
      await msg.delete();
      return {};
    } catch (err) {
      if (Number(err && err.code) === 10008) return { missing: true };
      throw fromDiscord(err);
    }
  }

  // update.test: die Testnachricht der Webseite (im Forum ein Beitrag „OnYourSite test“)
  async function test(data, item) {
    const channel = await channelOf(data.channel_id);
    checkPermissions(channel);
    try {
      return await send(channel, { ...data, thread_name: 'OnYourSite test' }, item, 'OnYourSite test');
    } catch (err) {
      throw fromDiscord(err);
    }
  }

  return { post, edit, remove, test, findOwnPost };
}

module.exports = { setupUpdates, messageOf, nonceOf, fromDiscord, jobError };
