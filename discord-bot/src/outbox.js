'use strict';
// Aufträge der Webseite abholen (z. B. „Vorschlag im Admin angenommen“, „Antwort im Ticket“, „Update posten“) und in
// Discord umsetzen. Der Bot fragt regelmäßig nach – die Webseite muss den Bot dafür nie erreichen können.
//
// - Beim Abholen nennt der Bot seine Funktionen (?f=updates.v1,…, Teil der signierten Adresse): die Webseite gibt ihm
//   nur Aufträge, die er kann.
// - Ein Auftrag kann ein Ergebnis liefern (z. B. die ID der geposteten Nachricht); es geht mit der Rückmeldung
//   (/done) an die Webseite. Ein Fehler mit err.final = true sagt der Webseite: kein neuer Versuch.
// - Kommt eine Rückmeldung nicht an (Webseite nicht erreichbar), merkt sich der Bot sie (höchstens 100) und schickt
//   sie vor dem nächsten Abholen noch einmal; solange wird derselbe Auftrag nicht noch einmal ausgeführt.

const MAX_PENDING = 100;

function startOutbox(site, handlers, seconds, log, { features = [] } = {}) {
  let busy = null;
  let lastError = '';
  let stopped = false;
  // Rückmeldungen, die noch nicht angekommen sind: Auftrag → Inhalt
  const pending = new Map();
  const query = features.length ? `?f=${features.join(',')}` : '';

  // Eine Rückmeldung senden; true = erledigt (angekommen oder von der Webseite abgelehnt)
  async function report(id, body) {
    const res = await site.post(`/_/bot/outbox/${id}/done`, body);
    if (res.ok) return true;
    if (res.httpStatus === 0 || res.httpStatus >= 500) return false;
    // Abgelehnt (z. B. 400 bei einem unbrauchbaren Ergebnis): ein neuer Versuch ändert nichts
    log(`Change #${id}: the website didn’t take the result (${res.error}).`);
    return true;
  }

  function keep(id, body) {
    if (pending.size >= MAX_PENDING && !pending.has(id)) {
      const oldest = pending.keys().next().value;
      pending.delete(oldest);
      log(`Change #${oldest}: gave up sending its result to the website (too many waiting).`);
    }
    pending.set(id, body);
  }

  // Gemerkte Rückmeldungen nachschicken (vor dem nächsten Abholen)
  async function flush() {
    for (const [id, body] of [...pending]) {
      if (await report(id, body)) pending.delete(id);
      else return false;
    }
    return true;
  }

  async function run(item) {
    const handler = handlers[item.action];
    try {
      if (!handler) throw new Error(`Unknown action “${item.action}”.`);
      const result = await handler(item.data || {}, item);
      return result && typeof result === 'object' ? { error: '', result } : {};
    } catch (err) {
      log(`Change #${item.id} (${item.action}) failed: ${err && err.message ? err.message : err}`);
      const body = { error: String((err && err.message) || 'Error').slice(0, 200) };
      if (err && err.final) body.final = true;
      return body;
    }
  }

  async function tick() {
    if (stopped) return;
    try {
      if (!(await flush())) return;
      const res = await site.get(`/_/bot/outbox${query}`);
      if (!res.ok) {
        // Nur melden, wenn sich der Fehler ändert – sonst steht alle paar Sekunden dasselbe im Log
        if (res.error !== lastError) log(`Website: ${res.error}`);
        lastError = res.error;
        return;
      }
      if (lastError) log('Website reachable again.');
      lastError = '';
      for (const item of res.items || []) {
        if (stopped) return;
        // Seine Rückmeldung ist noch unterwegs: nicht noch einmal ausführen
        if (pending.has(item.id)) continue;
        const body = await run(item);
        if (!(await report(item.id, body))) keep(item.id, body);
      }
    } catch (err) {
      log(`Outbox: ${err && err.message ? err.message : err}`);
    }
  }

  function once() {
    if (busy) return busy;
    busy = tick().finally(() => {
      busy = null;
    });
    return busy;
  }

  once();
  const timer = setInterval(once, seconds * 1000);

  // Rückgabe wie bisher der Timer (clearInterval geht weiter), dazu tick, pending und stop
  return Object.assign(timer, {
    pending,
    tick: once,
    // Anhalten (SIGTERM): nichts Neues abholen, den laufenden Durchgang abwarten, gemerkte Rückmeldungen senden – zusammen
    // höchstens maxMs
    async stop(maxMs = 3000) {
      stopped = true;
      clearInterval(timer);
      const deadline = new Promise((resolve) => {
        const t = setTimeout(resolve, maxMs);
        if (t.unref) t.unref();
      });
      await Promise.race([(async () => {
        if (busy) await busy.catch(() => {});
        await flush();
      })(), deadline]);
    },
  });
}

module.exports = { startOutbox };
