'use strict';
// Beta-Tester: Auftrag beta.role gibt oder nimmt die Rolle „Beta Tester“ – vorhandene Rolle (ID aus .env oder Name),
// sonst neu angelegt; Mitglied nicht auf dem Server: not_on_server; kaputte ID: endgültiger Fehler.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupBeta } = require('../src/beta');

function fakeGuild({ roles = [], members = {} } = {}) {
  const roleMap = new Map(roles.map((r) => [r.id, r]));
  const created = [];
  const cache = {
    get: (id) => roleMap.get(id),
    find: (fn) => [...roleMap.values()].find(fn),
  };
  const g = {
    roles: {
      cache,
      fetch: async (id) => (id ? roleMap.get(id) ?? null : roleMap),
      create: async (opts) => {
        const r = { id: '900000000000000099', name: opts.name, managed: false, opts };
        roleMap.set(r.id, r);
        created.push(r);
        return r;
      },
    },
    members: {
      fetch: async (id) => {
        if (members[id] instanceof Error) throw members[id];
        if (!members[id]) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
        return members[id];
      },
    },
  };
  return { g, created };
}
function fakeMember(has = []) {
  const set = new Set(has);
  const calls = [];
  return {
    calls,
    roles: {
      cache: { has: (id) => set.has(id) },
      add: async (r) => { set.add(r.id); calls.push('add:' + r.id); },
      remove: async (r) => { set.delete(r.id); calls.push('remove:' + r.id); },
    },
    hasRole: (id) => set.has(id),
  };
}
const client = (g) => ({ guilds: { cache: { get: () => g }, fetch: async () => g } });
const ID = '123456789012345678';

test('gives the existing "Beta Tester" role, and takes it away again', async () => {
  const role = { id: '800000000000000001', name: 'Beta Tester', managed: false };
  const m = fakeMember();
  const { g, created } = fakeGuild({ roles: [role], members: { [ID]: m } });
  const beta = setupBeta(client(g), { guildId: '1'.repeat(18), betaRoleId: '' }, () => {});
  assert.deepEqual(await beta.role({ user_id: 5, discord_id: ID, add: true }), { state: 'given', role_id: role.id });
  assert.ok(m.hasRole(role.id));
  assert.deepEqual(await beta.role({ user_id: 5, discord_id: ID, add: true }), { state: 'given', role_id: role.id }, 'twice is fine');
  assert.deepEqual(m.calls, ['add:' + role.id], 'added only once');
  assert.deepEqual(await beta.role({ user_id: 5, discord_id: ID, add: false }), { state: 'removed', role_id: role.id });
  assert.ok(!m.hasRole(role.id));
  assert.equal(created.length, 0);
});

test('uses BETA_ROLE_ID first, creates "Beta Tester" when there is none', async () => {
  const own = { id: '800000000000000002', name: 'Testers', managed: false };
  const m = fakeMember();
  const one = fakeGuild({ roles: [own, { id: '800000000000000003', name: 'Beta Tester', managed: false }], members: { [ID]: m } });
  const b1 = setupBeta(client(one.g), { guildId: '1'.repeat(18), betaRoleId: own.id }, () => {});
  assert.equal((await b1.role({ discord_id: ID, add: true })).role_id, own.id);
  const logs = [];
  const two = fakeGuild({ roles: [], members: { [ID]: fakeMember() } });
  const b2 = setupBeta(client(two.g), { guildId: '1'.repeat(18), betaRoleId: '' }, (l) => logs.push(l));
  const r = await b2.role({ discord_id: ID, add: true });
  assert.equal(two.created.length, 1);
  assert.equal(two.created[0].name, 'Beta Tester');
  assert.deepEqual(two.created[0].opts.permissions, [], 'no extra rights');
  assert.deepEqual(r, { state: 'given', role_id: two.created[0].id });
  assert.match(logs.join('\n'), /Created the role "Beta Tester"/);
});

test('a member who is not on the server: not_on_server; a broken ID: a final error', async () => {
  const { g } = fakeGuild({ roles: [{ id: '800000000000000001', name: 'Beta Tester', managed: false }] });
  const beta = setupBeta(client(g), { guildId: '1'.repeat(18), betaRoleId: '' }, () => {});
  assert.deepEqual(await beta.role({ discord_id: ID, add: true }), { state: 'not_on_server', role_id: '800000000000000001' });
  await assert.rejects(beta.role({ discord_id: 'abc', add: true }), (err) => err.final === true && /No valid Discord ID/.test(err.message));
});

test('only "Unknown Member" means not on the server; other errors are retried, missing permissions are final', async () => {
  const role = { id: '800000000000000001', name: 'Beta Tester', managed: false };
  const flaky = fakeGuild({ roles: [role], members: { [ID]: Object.assign(new Error('Service Unavailable'), { status: 503 }) } });
  const b1 = setupBeta(client(flaky.g), { guildId: '1'.repeat(18), betaRoleId: '' }, () => {});
  await assert.rejects(b1.role({ discord_id: ID, add: false }), (err) => /Service Unavailable/.test(err.message) && !err.final, 'retried later, not "removed"');
  const m = fakeMember();
  m.roles.add = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); };
  const locked = fakeGuild({ roles: [role], members: { [ID]: m } });
  const b2 = setupBeta(client(locked.g), { guildId: '1'.repeat(18), betaRoleId: '' }, () => {});
  await assert.rejects(b2.role({ discord_id: ID, add: true }), (err) => err.final === true && /Manage Roles/.test(err.message));
});
