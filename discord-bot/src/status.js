'use strict';
// Statusseite von OnYourSite in Discord (Aufträge status.* der Webseite, Funktion status.v1):
// - status.post / status.edit / status.delete: Beiträge zu Vorfällen und Wartungen im Kanal #status (öffentlich, nur
//   lesen). Dieselben Wege wie bei den Updates: Rechte prüfen, Nonce gegen doppelte Beiträge, nach einer verlorenen
//   Rückmeldung zuerst den eigenen Beitrag suchen (recheck, Link im ersten Embed = Seite des Vorfalls), only_if_posted
//   meldet nur einen schon vorhandenen Beitrag (der Vorfall wurde inzwischen gelöscht). Die Webseite übernimmt die
//   Nachrichten-ID aus dem Ergebnis.
// - status.alert: Meldungen ans Team im Kanal #alerts (privat): eine Nachricht, ohne Erwähnungen.
// Ein Forum ist für beide Kanäle nicht vorgesehen (je Meldung ein eigener Beitrag) – die Webseite bietet keins an.
const { ChannelType } = require('discord.js');
const { jobError, fromDiscord } = require('./updates');

function setupStatus(client, updates) {
  // Der Kanal muss ein Text- oder Ankündigungskanal sein (oder ein Thread darin)
  async function checkChannel(id) {
    if (!/^\d{15,25}$/.test(String(id || ''))) throw jobError('The channel no longer exists.', true);
    let channel = null;
    try {
      channel = await client.channels.fetch(String(id));
    } catch (err) {
      if (Number(err && err.code) === 10003 || Number(err && err.status) === 404) throw jobError('The channel no longer exists.', true);
      throw fromDiscord(err);
    }
    if (!channel) throw jobError('The channel no longer exists.', true);
    if (channel.type === ChannelType.GuildForum) throw jobError('Status messages can’t go to a forum – choose a text channel on the website.', true);
  }

  // status.post: neuer Beitrag (oder der schon vorhandene eigene)
  async function post(data, item) {
    await checkChannel(data.channel_id);
    return updates.post({ channel_id: data.channel_id, message: data.message, recheck: data.recheck === true, only_if_posted: data.only_if_posted === true }, item);
  }

  // status.edit: nur das Embed – pingt nie neu
  async function edit(data) {
    return updates.edit({ channel_id: data.channel_id, message_id: data.message_id, message: data.message, kind: 'message' });
  }

  // status.delete: die Nachricht löschen (schon gelöscht: missing)
  async function remove(data) {
    return updates.remove({ channel_id: data.channel_id, message_id: data.message_id, kind: 'message' });
  }

  // status.alert: eine Nachricht im Teamkanal
  async function alert(data, item) {
    await checkChannel(data.channel_id);
    return updates.post({ channel_id: data.channel_id, message: data.message }, item);
  }

  return { post, edit, remove, alert };
}

module.exports = { setupStatus };
