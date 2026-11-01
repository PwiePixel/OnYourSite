'use strict';
// Aufträge der Webseite abholen (z. B. „Vorschlag im Admin angenommen“, „Antwort im Ticket“) und in Discord umsetzen.
// Der Bot fragt regelmäßig nach – die Webseite muss den Bot dafür nie erreichen können.

function startOutbox(site, handlers, seconds, log) {
  let busy = false;
  let lastError = '';
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const res = await site.get('/_/bot/outbox');
      if (!res.ok) {
        // Nur melden, wenn sich der Fehler ändert – sonst steht alle paar Sekunden dasselbe im Log
        if (res.error !== lastError) log(`Website: ${res.error}`);
        lastError = res.error;
        return;
      }
      if (lastError) log('Website reachable again.');
      lastError = '';
      for (const item of res.items) {
        const handler = handlers[item.action];
        try {
          if (!handler) throw new Error(`Unknown action “${item.action}”.`);
          await handler(item.data || {});
          await site.post(`/_/bot/outbox/${item.id}/done`, {});
        } catch (err) {
          log(`Change #${item.id} (${item.action}) failed: ${err.message}`);
          await site.post(`/_/bot/outbox/${item.id}/done`, { error: String(err.message || 'Error').slice(0, 200) });
        }
      }
    } finally {
      busy = false;
    }
  }
  tick();
  return setInterval(tick, seconds * 1000);
}

module.exports = { startOutbox };
