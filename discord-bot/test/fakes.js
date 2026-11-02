'use strict';
// Nachgebaute Discord-Objekte für die Tests (Kanäle, Threads, Foren, Nachrichten, Rechte) – so viel, wie der Bot benutzt.
const { ChannelType, PermissionFlagsBits: P } = require('discord.js');

const BOT_ID = '900000000000000099';
let seq = 910000000000000000n;
const flake = () => String(++seq);

// Fehler wie DiscordAPIError (code = Discords Fehlercode, status = HTTP-Status)
function apiError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function perms(...names) {
  const set = new Set(names.map((n) => P[n]));
  return { has: (bit) => set.has(bit) };
}
const ALL = ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'ReadMessageHistory', 'ManageThreads', 'MentionEveryone'];

class FakeMessage {
  constructor(channel, payload, authorId = BOT_ID) {
    this.id = flake();
    this.channel = channel;
    this.payload = payload;
    this.author = { id: authorId };
    this.embeds = (payload.embeds || []).map((e) => ({ ...e }));
    this.edits = [];
    this.deleted = false;
  }
  async edit(p) {
    if (this.channel.failEdit) throw this.channel.failEdit;
    this.edits.push(p);
    if (p.embeds) this.embeds = p.embeds;
    return this;
  }
  async delete() {
    this.deleted = true;
    this.channel.sent = this.channel.sent.filter((m) => m !== this);
  }
}

const guildOf = (me = { id: BOT_ID }) => ({ id: '900000000000000001', members: { me } });

class FakeChannel {
  constructor(o = {}) {
    Object.assign(this, { id: o.id || flake(), name: o.name || 'updates', type: o.type ?? ChannelType.GuildText, parentId: o.parentId || null, sent: [], guild: o.guild || guildOf() });
    this.allowed = o.perms || perms(...ALL);
    this.messages = {
      fetch: async (arg) => {
        if (arg && typeof arg === 'object') return new Map([...this.sent].reverse().slice(0, arg.limit || 50).map((m) => [m.id, m]));
        const m = this.sent.find((x) => x.id === arg);
        if (!m) throw apiError(404, 10008, 'Unknown Message');
        return m;
      },
    };
  }
  isThread() { return false; }
  permissionsFor() { return this.allowed; }
  async send(payload) {
    if (this.failSend) throw this.failSend;
    const m = new FakeMessage(this, payload);
    this.sent.push(m);
    return m;
  }
}

class FakeThread extends FakeChannel {
  constructor(o = {}) {
    super({ type: ChannelType.PublicThread, ...o });
    Object.assign(this, { ownerId: o.ownerId || BOT_ID, archived: Boolean(o.archived), deletedThread: false, renamed: [] });
  }
  isThread() { return true; }
  async setArchived(v) { this.archived = v; }
  async setName(n) { this.renamed.push(n); this.name = n; }
  async delete() {
    if (this.failDelete) throw this.failDelete;
    this.deletedThread = true;
  }
  async fetchStarterMessage() { return this.sent.find((m) => m.id === this.id) || null; }
}

class FakeForum extends FakeChannel {
  constructor(o = {}) {
    super({ type: ChannelType.GuildForum, ...o });
    this.posts = [];
    this.threads = {
      create: async ({ name, message }) => {
        const t = new FakeThread({ name, parentId: this.id, guild: this.guild });
        // Die erste Nachricht eines Forenbeitrags hat die ID des Beitrags
        const m = new FakeMessage(t, message);
        m.id = t.id;
        t.sent.push(m);
        this.posts.push(t);
        return t;
      },
      fetchActive: async () => ({ threads: new Map(this.posts.filter((t) => !t.archived).map((t) => [t.id, t])) }),
    };
  }
}

function fakeClient(channels = []) {
  const map = new Map(channels.map((c) => [c.id, c]));
  return {
    user: { id: BOT_ID },
    map,
    channels: {
      fetch: async (id) => {
        const c = map.get(id);
        if (!c) throw apiError(404, 10003, 'Unknown Channel');
        return c;
      },
    },
  };
}

module.exports = { BOT_ID, flake, apiError, perms, ALL, FakeMessage, FakeChannel, FakeThread, FakeForum, fakeClient, guildOf };
