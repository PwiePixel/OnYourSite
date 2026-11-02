'use strict';
// Nachgebautes Discord (REST v10) für die Tests der Einrichtung und des Installers: ein Server mit Rollen und Kanälen,
// nur so viel, wie src/setup.js benutzt. Jede Anfrage landet in calls (Methode, Pfad, Inhalt). Das Token entsteht erst
// zur Laufzeit; der Bot benutzt das Discord über DISCORD_API_BASE (= base).
const http = require('http');
const crypto = require('crypto');
const { INVITE_PERMISSIONS } = require('../src/setup');

let seq = 1500000000000000000n;
const nid = () => String(++seq);

function startFakeDiscord({ community = false } = {}) {
  const token = ['MTEx', crypto.randomBytes(18).toString('base64url'), crypto.randomBytes(20).toString('base64url')].join('.');
  const appId = nid();
  const guildId = nid();
  const state = {
    guild: { id: guildId, name: 'OnYourSite Test', owner_id: nid(), rules_channel_id: null, features: community ? ['COMMUNITY'] : [] },
    roles: [
      { id: guildId, name: '@everyone', managed: false, position: 0, permissions: '0' },
      { id: nid(), name: 'OnYourSite', managed: true, position: 1, permissions: INVITE_PERMISSIONS },
    ],
    channels: [{ id: nid(), type: 0, name: 'general', parent_id: null, guild_id: guildId }],
    // Fehler für POST …/channels, z. B. { status: 403, code: 50013, message: 'Missing Permissions' }
    failCreate: null,
  };
  const calls = [];

  const send = (res, status, data) => {
    const body = data === undefined ? '' : JSON.stringify(data);
    res.writeHead(status, body ? { 'Content-Type': 'application/json' } : {});
    res.end(body);
  };
  const channelOf = (id) => state.channels.find((c) => c.id === id);

  function handle(method, parts, body, res) {
    const p = parts.join('/');
    if (method === 'GET' && p === 'users/@me') return send(res, 200, { id: appId, username: 'OnYourSite', bot: true });
    if (method === 'GET' && p === 'oauth2/applications/@me') return send(res, 200, { id: appId, name: 'OnYourSite', bot: { id: appId } });
    if (method === 'GET' && p === 'users/@me/guilds') return send(res, 200, [{ id: guildId, name: state.guild.name }]);
    if (parts[0] === 'guilds') {
      if (parts[1] !== guildId) return send(res, 404, { code: 10004, message: 'Unknown Guild' });
      const rest = parts.slice(2).join('/');
      if (method === 'GET' && rest === '') return send(res, 200, state.guild);
      if (rest === 'roles' && method === 'GET') return send(res, 200, state.roles);
      if (rest === 'roles' && method === 'POST') {
        const r = { id: nid(), name: body.name, color: body.color || 0, hoist: !!body.hoist, managed: false, position: 1, permissions: body.permissions || '0' };
        state.roles.push(r);
        return send(res, 200, r);
      }
      if (rest === 'channels' && method === 'GET') return send(res, 200, state.channels);
      if (rest === 'channels' && method === 'POST') {
        if (state.failCreate) return send(res, state.failCreate.status, { code: state.failCreate.code, message: state.failCreate.message });
        const c = { id: nid(), guild_id: guildId, type: body.type ?? 0, name: body.name, parent_id: body.parent_id || null, topic: body.topic || null, permission_overwrites: body.permission_overwrites || [] };
        if (c.type === 15) c.available_tags = (body.available_tags || []).map((t) => ({ ...t, id: nid() }));
        state.channels.push(c);
        return send(res, 201, c);
      }
      if (method === 'GET' && parts[2] === 'members' && parts.length === 4) {
        if (parts[3] !== appId) return send(res, 404, { code: 10007, message: 'Unknown Member' });
        return send(res, 200, { user: { id: appId }, roles: state.roles.filter((r) => r.managed).map((r) => r.id) });
      }
      if (method === 'PUT' && parts[2] === 'members' && parts[4] === 'roles') return send(res, 204);
    }
    if (parts[0] === 'channels') {
      const c = channelOf(parts[1]);
      if (!c) return send(res, 404, { code: 10003, message: 'Unknown Channel' });
      if (method === 'PUT' && parts[2] === 'permissions') {
        c.permission_overwrites = [...(c.permission_overwrites || []).filter((o) => o.id !== parts[3]), { id: parts[3], ...body }];
        return send(res, 204);
      }
      if (method === 'PATCH' && parts.length === 2) {
        if (body.available_tags) c.available_tags = body.available_tags.map((t) => (t.id ? t : { ...t, id: nid() }));
        if (body.name) c.name = body.name;
        return send(res, 200, c);
      }
    }
    return send(res, 404, { code: 0, message: '404: Not Found' });
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method: req.method, path: url.pathname, body });
      if (req.headers.authorization !== `Bot ${token}`) return send(res, 401, { code: 0, message: '401: Unauthorized' });
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api' || parts[1] !== 'v10') return send(res, 404, { code: 0, message: '404: Not Found' });
      handle(req.method, parts.slice(2), body, res);
    });
  });

  return new Promise((resolve) => {
    // Freier Port, den das System vergibt (nur auf diesem Rechner erreichbar)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        token, appId, guildId, state, calls,
        base: `http://127.0.0.1:${server.address().port}/api`,
        // Anfragen, die etwas ändern
        writes: () => calls.filter((c) => c.method !== 'GET'),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startFakeDiscord, nid };
