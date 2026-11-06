'use strict';
// Beta-Tester der Webseite: Auftrag beta.role gibt oder nimmt die Rolle „Beta Tester“ (Funktion beta.v1).
// Die Rolle: BETA_ROLE_ID aus .env, sonst eine Rolle namens „Beta Tester“, sonst legt der Bot sie an (unter seiner
// eigenen Rolle, damit er sie vergeben darf). Ist das Mitglied nicht auf dem Server, meldet er not_on_server – die
// Webseite zeigt das dem Admin, der es später noch einmal versuchen kann.

const ROLE_NAME = 'Beta Tester';
const REASON = 'OnYourSite beta';

function setupBeta(client, cfg, log) {
  async function guild() {
    const g = client.guilds.cache.get(cfg.guildId) || await client.guilds.fetch(cfg.guildId).catch(() => null);
    if (!g) throw new Error('The bot is not on the server from GUILD_ID.');
    return g;
  }

  async function betaRole(g) {
    if (cfg.betaRoleId) {
      const byId = g.roles.cache.get(cfg.betaRoleId) || await g.roles.fetch(cfg.betaRoleId).catch(() => null);
      if (byId) return byId;
    }
    await g.roles.fetch().catch(() => null);
    const byName = g.roles.cache.find((r) => !r.managed && r.name.toLowerCase() === ROLE_NAME.toLowerCase());
    if (byName) return byName;
    const created = await g.roles.create({ name: ROLE_NAME, color: 0x38bdf8, hoist: false, mentionable: false, permissions: [], reason: REASON });
    log(`Created the role "${ROLE_NAME}".`);
    return created;
  }

  // data: { user_id, discord_id, add }
  async function role(data) {
    const id = String(data.discord_id || '');
    if (!/^\d{15,22}$/.test(id)) {
      const err = new Error('No valid Discord ID.');
      err.final = true;
      throw err;
    }
    const g = await guild();
    const r = await betaRole(g);
    // Nur „Unknown Member/User“ heißt: nicht auf dem Server – jeder andere Fehler (Netz, Rate-Limit) wird wiederholt
    let member = null;
    try {
      member = await g.members.fetch(id);
    } catch (err) {
      if (err && (err.code === 10007 || err.code === 10013)) return { state: 'not_on_server', role_id: r.id };
      throw err;
    }
    try {
      if (data.add === true) {
        if (!member.roles.cache.has(r.id)) await member.roles.add(r, REASON);
        return { state: 'given', role_id: r.id };
      }
      if (member.roles.cache.has(r.id)) await member.roles.remove(r, REASON);
      return { state: 'removed', role_id: r.id };
    } catch (err) {
      // Dauerhaft: fehlende Rechte (Rolle über der des Bots) oder unbekannte Rolle – sofort melden statt stundenlang
      // zu wiederholen
      if (err && (err.code === 50013 || err.code === 10011)) {
        const final = new Error(err.code === 50013
          ? `Missing permissions: give the bot "Manage Roles" and move its role above "${r.name}".`
          : `The role "${r.name}" doesn’t exist any more.`);
        final.final = true;
        throw final;
      }
      throw err;
    }
  }

  return { role };
}

module.exports = { setupBeta, ROLE_NAME };
