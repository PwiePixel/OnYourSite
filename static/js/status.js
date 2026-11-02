/* OnYourSite – öffentliche Statusseite: Zeiten in der Zone des Besuchers, alle 60 s der neue Stand aus /summary.json
   (nur solange der Tab sichtbar ist). Ohne Skript funktioniert alles – die Zeiten stehen dann in der Zone der Seite. */
(function () {
  'use strict';
  var TEXT = {
    operational: 'Operational', degraded: 'Degraded performance', partial: 'Partial outage', major: 'Major outage',
    maintenance: 'Under maintenance', unknown: 'Not checked right now'
  };
  var CLS = { operational: 'st-s-ok', degraded: 'st-s-degraded', partial: 'st-s-partial', major: 'st-s-major', maintenance: 'st-s-maint', unknown: 'st-s-unknown' };
  var lastFetch = Date.now();

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function rel(d) {
    var s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function fmt(el) {
    var d = new Date(el.getAttribute('datetime'));
    if (isNaN(d.getTime())) return;
    var f = el.getAttribute('data-f');
    if (f === 'rel') { el.textContent = rel(d); return; }
    var date = d.toLocaleDateString('en-US', f === 'd' ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
    var time = pad(d.getHours()) + ':' + pad(d.getMinutes());
    el.textContent = f === 'd' ? date : f === 't' ? time : date + ', ' + time;
    el.title = d.toString();
  }
  function times() { Array.prototype.forEach.call(document.querySelectorAll('time[datetime]'), fmt); }

  function setPill(pill, status) {
    if (!pill || !CLS[status]) return;
    pill.className = 'st-pill ' + CLS[status];
    pill.setAttribute('data-status', status);
    var dot = pill.querySelector('.st-dot');
    pill.textContent = TEXT[status];
    if (dot) pill.insertBefore(dot, pill.firstChild);
  }

  function apply(data) {
    if (!data || !data.status) return;
    var banner = document.querySelector('.st-banner[data-indicator]');
    if (banner && CLS[data.status.indicator]) {
      banner.className = 'st-banner ' + CLS[data.status.indicator];
      banner.setAttribute('data-indicator', data.status.indicator);
      var t = banner.querySelector('[data-banner-text]');
      if (t && typeof data.status.description === 'string') t.textContent = data.status.description;
      var up = banner.querySelector('time');
      if (up) { up.setAttribute('datetime', new Date().toISOString()); fmt(up); }
    }
    (data.components || []).forEach(function (c) {
      var row = document.querySelector('.st-comp[data-id="' + Number(c.id) + '"]');
      if (row) setPill(row.querySelector('.st-comp-head .st-pill'), c.status);
    });
  }

  function refresh() {
    var main = document.querySelector('[data-summary]');
    if (!main || document.hidden || !window.fetch) return;
    lastFetch = Date.now();
    fetch(main.getAttribute('data-summary'), { credentials: 'omit', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(apply)
      .catch(function () {});
  }

  times();
  setInterval(function () {
    times();
    if (Date.now() - lastFetch >= 60000) refresh();
  }, 15000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - lastFetch >= 60000) refresh();
  });
})();
