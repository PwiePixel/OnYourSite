'use strict';
// Abholen und Rückmelden mit dem echten SiteClient gegen eine nachgebaute Webseite, die jede Signatur prüft:
// ?f= ist Teil der signierten Adresse, Ergebnisse und final gehen mit /done zurück, eine Rückmeldung, die nicht ankommt,
// wird vor dem nächsten Abholen noch einmal gesendet (der Auftrag läuft nicht noch einmal), stop() schickt sie zuletzt.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { SiteClient } = require('../src/site');
const { startOutbox } = require('../src/outbox');

// Die Webseite: prüft die Signatur wie /_/bot/* (Zeitstempel, Methode, Pfad mit Abfrage, Inhalt)
function fakeSite(secret) {
  const requests = [];
  const site = {
    requests,
    items: [],
    // Antwort für /done: 200, 503 (Störung), 413 (zu groß) oder 'down' (Verbindung bricht ab)
    doneStatus: 200,
    done: [],
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const ts = req.headers['x-oys-timestamp'];
      const want = crypto.createHmac('sha256', secret).update(`${ts}\n${req.method}\n${req.url}\n${body}`).digest('hex');
      const signed = req.headers['x-oys-signature'] === want;
      requests.push({ method: req.method, url: req.url, signed, ua: req.headers['user-agent'] });
      const json = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (!signed) return json(401, { ok: false, error: 'Invalid signature.' });
      if (req.method === 'GET' && req.url.startsWith('/_/bot/outbox')) return json(200, { ok: true, items: site.items });
      const m = /^\/_\/bot\/outbox\/(\d+)\/done$/.exec(req.url);
      if (req.method === 'POST' && m) {
        if (site.doneStatus === 'down') return req.socket.destroy();
        if (site.doneStatus !== 200) return json(site.doneStatus, { ok: false, error: site.doneStatus === 413 ? 'Request too large.' : 'Busy.' });
        site.done.push({ id: Number(m[1]), body: JSON.parse(body) });
        site.items = site.items.filter((i) => i.id !== Number(m[1]));
        return json(200, { ok: true });
      }
      return json(404, { ok: false, error: 'Not found.' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    site.url = `http://127.0.0.1:${server.address().port}`;
    site.close = () => new Promise((r) => {
      server.closeAllConnections();
      server.close(r);
    });
    resolve(site);
  }));
}

async function setup() {
  const secret = crypto.randomBytes(32).toString('hex');
  const site = await fakeSite(secret);
  const logs = [];
  const client = new SiteClient(site.url, secret, { timeoutMs: 3000, log: (l) => logs.push(l) });
  return { site, logs, client };
}

// Ein Durchgang läuft beim Start sofort; danach nur noch über tick() (das Intervall ist eine Stunde)
async function outboxFor(client, handlers, logs) {
  const ob = startOutbox(client, handlers, 3600, (l) => logs.push(l), { features: ['updates.v1'] });
  await ob.tick();
  return ob;
}

test('the bot names its features in the signed address and reports results, final errors and plain success', async () => {
  const { site, logs, client } = await setup();
  site.items = [
    { id: 1, action: 'update.post', data: { channel_id: '1' } },
    { id: 2, action: 'update.edit', data: {} },
    { id: 3, action: 'ticket.close', data: {} },
    { id: 4, action: 'update.delete', data: {} },
    { id: 5, action: 'ticket.what', data: {} },
  ];
  const ob = await outboxFor(client, {
    'update.post': async (d, item) => ({ message_id: '900000000000000001', channel_id: d.channel_id, job: item.id }),
    'update.edit': async () => {
      throw Object.assign(new Error('The bot can’t post in #updates: it needs Embed Links there.'), { final: true });
    },
    'ticket.close': async () => undefined,
    'update.delete': async () => {
      throw new Error('Discord is busy.');
    },
  }, logs);
  try {
    const get = site.requests.find((r) => r.method === 'GET');
    assert.equal(get.url, '/_/bot/outbox?f=updates.v1');
    assert.ok(site.requests.every((r) => r.signed), 'every request is signed – the query too');
    assert.match(get.ua, /^OnYourSite-Bot\/\d+\.\d+\.\d+$/);
    assert.deepEqual(site.done, [
      { id: 1, body: { error: '', result: { message_id: '900000000000000001', channel_id: '1', job: 1 } } },
      { id: 2, body: { error: 'The bot can’t post in #updates: it needs Embed Links there.', final: true } },
      { id: 3, body: {} },
      { id: 4, body: { error: 'Discord is busy.' } },
      { id: 5, body: { error: 'Unknown action “ticket.what”.' } },
    ]);
    assert.equal(ob.pending.size, 0);
  } finally {
    await ob.stop(500);
    await site.close();
  }
});

test('a result that doesn’t arrive is kept and sent again before the next poll – the job doesn’t run twice', async () => {
  const { site, logs, client } = await setup();
  site.items = [{ id: 7, action: 'update.post', data: {} }];
  site.doneStatus = 503;
  let runs = 0;
  const ob = await outboxFor(client, { 'update.post': async () => ({ message_id: String(900000000000000000n + BigInt(++runs)) }) }, logs);
  try {
    assert.equal(runs, 1);
    assert.deepEqual([...ob.pending.keys()], [7]);
    // Die Webseite ist ganz weg: nichts wird abgeholt, solange die Rückmeldung nicht angekommen ist
    site.doneStatus = 'down';
    const before = site.requests.length;
    await ob.tick();
    assert.deepEqual(site.requests.slice(before).map((r) => r.method + ' ' + r.url), ['POST /_/bot/outbox/7/done']);
    assert.equal(runs, 1);
    // Wieder da: erst die Rückmeldung, dann abholen – derselbe Auftrag ist erledigt und läuft nicht noch einmal
    site.doneStatus = 200;
    const mark = site.requests.length;
    await ob.tick();
    assert.deepEqual(site.requests.slice(mark).map((r) => r.method + ' ' + r.url), ['POST /_/bot/outbox/7/done', 'GET /_/bot/outbox?f=updates.v1']);
    assert.deepEqual(site.done, [{ id: 7, body: { error: '', result: { message_id: '900000000000000001' } } }]);
    assert.equal(runs, 1);
    assert.equal(ob.pending.size, 0);
  } finally {
    await ob.stop(500);
    await site.close();
  }
});

test('a result the website refuses (e.g. 413) is logged and not sent again; at most 100 results wait', async () => {
  const { site, logs, client } = await setup();
  site.items = [{ id: 9, action: 'update.post', data: {} }];
  site.doneStatus = 413;
  const ob = await outboxFor(client, { 'update.post': async () => ({ message_id: '1' }) }, logs);
  try {
    assert.equal(ob.pending.size, 0);
    assert.ok(logs.some((l) => /the request was too big/.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => /Change #9: the website didn’t take the result \(Request too large\.\)/.test(l)), logs.join('\n'));
  } finally {
    await ob.stop(500);
  }
  // 101 Rückmeldungen hängen: die älteste wird aufgegeben (und gemeldet)
  site.items = Array.from({ length: 101 }, (_, i) => ({ id: 100 + i, action: 'x.ok', data: {} }));
  site.doneStatus = 503;
  const many = await outboxFor(client, { 'x.ok': async () => ({}) }, logs);
  try {
    assert.equal(many.pending.size, 100);
    assert.equal(many.pending.has(100), false);
    assert.ok(logs.some((l) => /Change #100: gave up sending its result/.test(l)));
  } finally {
    await many.stop(200);
    await site.close();
  }
});

test('stop() fetches nothing new and sends the waiting results once more', async () => {
  const { site, logs, client } = await setup();
  site.items = [{ id: 11, action: 'update.post', data: {} }];
  site.doneStatus = 503;
  const ob = await outboxFor(client, { 'update.post': async () => ({ message_id: '5' }) }, logs);
  try {
    assert.equal(ob.pending.size, 1);
    site.doneStatus = 200;
    const mark = site.requests.length;
    await ob.stop(3000);
    assert.deepEqual(site.requests.slice(mark).map((r) => r.method + ' ' + r.url), ['POST /_/bot/outbox/11/done']);
    assert.equal(ob.pending.size, 0);
    // Danach holt er nichts mehr ab
    await ob.tick();
    assert.equal(site.requests.length, mark + 1);
  } finally {
    await site.close();
  }
});
