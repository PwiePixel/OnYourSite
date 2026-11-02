/* OnYourSite – Statusseite verwalten (Editor, Bereich „Status“). Der Editor lädt diese Datei erst beim ersten Öffnen
   des Bereichs und ruft OYS_STATUS.mount(root, opts) auf. Bis jedes Konto eine eigene Statusseite freischalten kann,
   gibt es hier nur OnYourSites eigene Seite (scope system, nur für Admins): Bestandteile, Vorfälle und Wartungen,
   Alarme und die Kanäle des Bots, Einstellungen. Dialoge und Hinweise kommen aus window.OYSUI – keine Browser-Popups.
   Jeder Text vom Server wird maskiert (esc) oder als textContent gesetzt. */
(function () {
  'use strict';
  var UI = window.OYSUI;
  var S = { root: null, opts: null, tab: 'components', state: null, mons: null, incs: null, alerts: null, open: {}, timer: null, loading: false };
  var TABS = [['components', 'bx-list-ul', 'Components'], ['incidents', 'bx-error', 'Incidents'], ['alerts', 'bx-bell', 'Alerts'], ['settings', 'bx-cog', 'Settings']];
  var STATUS_TEXT = { operational: 'All systems operational', degraded: 'Degraded performance', partial: 'Partial outage', major: 'Major outage', maintenance: 'Maintenance in progress', unknown: 'No data yet' };
  var DOT = { up: 'ok', down: 'down', degraded: 'warn', unknown: 'none', paused: 'none', maintenance: 'maint' };
  // Von Hand gesetzte Bestandteile: Farbe aus dem gewählten Zustand (Teilausfall orange)
  var MANUAL_TONE = { operational: 'ok', degraded: 'warn', partial: 'part', major: 'down', maintenance: 'maint' };
  var TYPE_ICON = { http: 'bx-globe', heartbeat: 'bx-time-five', manual: 'bx-slider-alt', system: 'bx-server' };
  var INC_STATUS = [['investigating', 'Investigating'], ['identified', 'Identified'], ['monitoring', 'Monitoring'], ['resolved', 'Resolved']];
  var MAINT_STATUS = [['scheduled', 'Scheduled'], ['in_progress', 'In progress'], ['completed', 'Completed']];
  var IMPACTS = [['none', 'None'], ['minor', 'Minor'], ['major', 'Major'], ['critical', 'Critical']];
  var EFFECTS = [['degraded', 'Degraded performance'], ['partial', 'Partial outage'], ['major', 'Major outage']];
  var MANUAL = [['operational', 'Operational'], ['degraded', 'Degraded performance'], ['partial', 'Partial outage'], ['major', 'Major outage'], ['maintenance', 'Under maintenance']];
  var EVENTS = [['down', 'Down'], ['up', 'Back up'], ['degraded', 'Slow'], ['cert', 'Certificate expires'], ['heartbeat', 'Heartbeat missed']];

  // ---------------------------------------------------------------- Helfer
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function h(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function when(unix) {
    if (!unix) return '—';
    var d = new Date(unix * 1000);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function ago(unix) {
    if (!unix) return '';
    var s = Math.max(0, Math.round(Date.now() / 1000 - unix));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return when(unix);
  }
  function dur(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.round(s / 60) + ' min';
    if (s < 86400) { var m = Math.round((s % 3600) / 60); return Math.floor(s / 3600) + ' h' + (m ? ' ' + m + ' min' : ''); }
    var d = Math.round(s / 86400);
    return d === 1 ? '1 day' : d + ' days';
  }
  function localInput(unix) {
    var d = new Date(unix * 1000);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fromInput(v) { var t = new Date(v).getTime(); return isNaN(t) ? null : Math.floor(t / 1000); }
  function options(list, cur) {
    return list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
  }
  function toast(t, tone) { if (UI) UI.toast(t, tone || 'ok'); }

  // Anfragen: CSRF-Kopf, scope=system, Antwort über UI.handle() (Sitzungsdialog, Hinweise)
  function api(action, body) {
    var o = S.opts;
    var url = o.api + action + (body === undefined ? (action.indexOf('?') === -1 ? '?' : '&') + 'scope=' + encodeURIComponent(o.scope) : '');
    var init = { credentials: 'same-origin', headers: { 'X-CSRF-Token': o.csrf } };
    if (body !== undefined) {
      body.scope = o.scope;
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!data || typeof data !== 'object') data = { ok: false, error: 'Unexpected response from the server.' };
        return UI.handle(r.status, data);
      });
    }, function () { return { ok: false, error: 'No connection to the server.' }; });
  }

  // ---------------------------------------------------------------- Einstieg

  function mount(root, opts) {
    var first = S.root !== root;
    S.root = root;
    S.opts = opts;
    if (first) {
      root.innerHTML = '<div class="st-m"><div class="st-m-loading"><i class="bx bx-loader-alt bx-spin"></i></div></div>';
      root.addEventListener('click', onClick);
      document.addEventListener('visibilitychange', function () { if (!document.hidden && visible()) refreshMonitors(); });
    }
    loadAll();
    if (!S.timer) S.timer = setInterval(function () { if (visible() && !document.hidden && S.tab === 'components') refreshMonitors(); }, 20000);
  }

  function visible() { return S.root && !S.root.classList.contains('hidden'); }
  // Eigene Statusseite eines Kontos (ST-4): ohne Alarme der Admins und Bot-Kanäle, mit Anlegen und Löschen
  function userScope() { return S.opts && S.opts.scope === 'user'; }

  function loadAll() {
    if (S.loading) return;
    S.loading = true;
    // Eigene Seite: erst fragen, ob es sie gibt (ohne Seite nur das Formular zum Anlegen, keine 404-Anfragen)
    var first = userScope() ? api('status').then(function (st) {
      if (!st.ok || !st.page) return [st];
      return Promise.all([st, api('status-monitors'), api('status-incidents'), { ok: false }]);
    }) : Promise.all([api('status'), api('status-monitors'), api('status-incidents'), api('status-alerts')]);
    first.then(function (r) {
      S.loading = false;
      if (!r[0].ok) { showError(r[0].error); return; }
      if (!r[0].page) { S.state = r[0]; renderCreate(); return; }
      S.state = r[0];
      S.mons = r[1].ok ? r[1] : null;
      S.incs = r[2].ok ? r[2] : null;
      S.alerts = r[3].ok ? r[3] : null;
      render();
    });
  }

  function refreshState() {
    if (!S.state || !S.state.page) return Promise.resolve();
    return api('status').then(function (r) { if (r.ok) { S.state = r; renderHead(); } });
  }
  function hasPage() { return !!(S.state && S.state.page); }
  function refreshMonitors() {
    if (!hasPage()) return Promise.resolve();
    return api('status-monitors').then(function (r) { if (r.ok) { S.mons = r; if (S.tab === 'components') renderBody(); } });
  }
  function refreshIncidents() {
    if (!S.state || !S.state.page) return Promise.resolve();
    return api('status-incidents').then(function (r) { if (r.ok) { S.incs = r; if (S.tab === 'incidents') renderBody(); } });
  }
  function refreshAlerts() {
    return api('status-alerts').then(function (r) { if (r.ok) { S.alerts = r; if (S.tab === 'alerts') renderBody(); } });
  }

  function showError(text) {
    S.root.innerHTML = '';
    var box = h('<div class="st-m"><div class="panel empty-state"><i class="bx bx-error-circle"></i><p></p></div></div>');
    $('p', box).textContent = text || 'Something went wrong. Please try again.';
    S.root.appendChild(box);
  }

  // ---------------------------------------------------------------- Zeichnen

  function render() {
    S.root.innerHTML = '<div class="st-m"><div id="stmHead"></div><div class="chips st-m-tabs" role="tablist"></div><div id="stmBody"></div></div>';
    var tabs = $('.st-m-tabs', S.root);
    TABS.forEach(function (t) {
      if (t[0] === 'alerts' && userScope()) return;
      var b = h('<button type="button" class="chip" role="tab" data-stm-tab="' + t[0] + '"><i class="bx ' + t[1] + '"></i> ' + esc(t[2]) + '</button>');
      tabs.appendChild(b);
    });
    renderHead();
    renderBody();
  }

  // Noch keine eigene Seite: Name und Adresse (eigene Subdomain) wählen
  function renderCreate() {
    var lim = (S.state && S.state.limits) || {};
    S.root.innerHTML = '';
    var box = h('<div class="st-m"><div class="panel st-m-create space-y-4 max-w-xl">' +
      '<div><h2 class="section-title"><i class="bx bx-pulse"></i> Create your status page</h2>' +
      '<p class="st-m-hint"></p></div>' +
      '<div><label class="lbl" for="stmNewTitle">Name</label><input class="field" id="stmNewTitle" name="title" maxlength="120" placeholder="Acme status"></div>' +
      '<div><label class="lbl" for="stmNewSlug">Address</label><div class="st-m-addr"><input class="field" id="stmNewSlug" name="slug" maxlength="30" autocomplete="off" spellcheck="false" placeholder="acme-status"><span class="st-m-suffix"></span></div></div>' +
      '<p class="st-m-err" hidden></p>' +
      '<div><button type="button" class="btn-primary" data-stm="create-page"><i class="bx bx-plus"></i> Create status page</button></div></div></div>');
    $('.st-m-hint', box).textContent = 'Your page runs at its own address. You can check up to ' + fmtNum(lim.checks || 0) + ' websites and report incidents and maintenance.';
    $('.st-m-suffix', box).textContent = '.' + (S.opts.baseHost || '');
    S.root.appendChild(box);
  }

  function createPage(btn) {
    var title = $('#stmNewTitle', S.root).value.trim(), slug = $('#stmNewSlug', S.root).value.trim().toLowerCase();
    var err = $('.st-m-err', S.root);
    btn.disabled = true;
    api('status-create', { title: title, slug: slug }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { err.hidden = false; err.textContent = r.error || 'Something went wrong. Please try again.'; return; }
      toast('Your status page is live.');
      S.tab = 'components';
      loadAll();
    });
  }

  function deletePage() {
    var p = S.state.page;
    UI.confirm({ title: 'Delete ' + p.title + '?', text: 'Its components, checks, incidents and history are removed. The address stays reserved for you for 90 days. This can’t be undone.', ok: 'Delete status page', tone: 'danger' }).then(function (yes) {
      if (!yes) return;
      api('status-page-delete', {}).then(function (r) {
        if (!r.ok) { toast(r.error, 'err'); return; }
        toast('Status page deleted.');
        S.state = r;
        S.mons = null;
        S.incs = null;
        renderCreate();
      });
    });
  }

  function pill(status) {
    return '<span class="st-m-pill st-m-s-' + esc(status) + '"><span class="st-m-dot"></span>' + esc(STATUS_TEXT[status] || STATUS_TEXT.unknown) + '</span>';
  }

  function renderHead() {
    var st = S.state, p = st.page, head = $('#stmHead', S.root);
    if (!head) return;
    var url = p.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    var html = '<div class="panel st-m-headcard">' +
      '<div class="st-m-title"><div class="min-w-0"><h2>' + esc(p.title) + ' ' + (p.online ? '<span class="bdg green">Online</span>' : '<span class="bdg amber">Offline</span>') + '</h2>' +
      '<a href="' + esc(p.url) + '" target="_blank" rel="noopener" class="st-m-url">' + esc(url) + ' <i class="bx bx-link-external"></i></a></div>' + pill(p.status) + '</div>';
    var notes = [];
    if (st.gate && st.gate.state === 'frozen') notes.push('Checks are paused – a problem on our side since ' + when(st.gate.since) + '. Nothing is counted as down meanwhile.');
    if (!st.worker.ok) notes.push('Checks are delayed – the status checker isn’t running' + (st.worker.at ? ' (last seen ' + ago(st.worker.at) + ')' : '') + '.');
    if (!st.notifier.ok) notes.push('Alerts can’t go out – the status notifier isn’t running' + (st.notifier.at ? ' (last seen ' + ago(st.notifier.at) + ')' : '') + '.');
    if (p.clash) notes.push('The address ' + p.slug + ' is used by another page – decide what to do before publishing.');
    notes.forEach(function (n) { html += '<p class="st-m-note"><i class="bx bx-error"></i> ' + esc(n) + '</p>'; });
    html += '</div>';
    var k = p.kpis;
    html += '<div class="kpis st-m-kpis">' +
      kpi('bx-line-chart', k.uptime30 === null ? '—' : k.uptime30.toFixed(2) + '%', 'Uptime (30 days)', '#4ade80') +
      kpi('bx-timer', k.avgMs === null ? '—' : fmtNum(k.avgMs) + ' ms', 'Avg. response', '#818cf8') +
      kpi('bx-error', fmtNum(k.openIncidents), 'Open incidents', '#f87171') +
      kpi('bx-list-ul', fmtNum(k.components), 'Public components', '#fbbf24') + '</div>';
    head.innerHTML = html;
  }
  function kpi(icon, value, label, color) {
    return '<div class="kpi" style="--c:' + color + '"><i class="bx ' + icon + '"></i><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>';
  }

  function renderBody() {
    var body = $('#stmBody', S.root);
    if (!body) return;
    $$('[data-stm-tab]', S.root).forEach(function (b) {
      var on = b.getAttribute('data-stm-tab') === S.tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    body.innerHTML = '';
    if (S.tab === 'components') body.appendChild(componentsView());
    else if (S.tab === 'incidents') body.appendChild(incidentsView());
    else if (S.tab === 'alerts') body.appendChild(alertsView());
    else body.appendChild(settingsView());
  }

  // ---------------------------------------------------------------- Bestandteile

  function targetText(m) {
    if (m.type === 'http') return m.prettyTarget;
    if (m.type === 'heartbeat') return 'Heartbeat · every ' + dur(m.config.period || m.interval);
    if (m.type === 'manual') return 'Set by hand';
    return 'OnYourSite check';
  }

  function badges(m) {
    var b = [];
    if (!m.public) b.push('<span class="bdg">Private</span>');
    if (m.adminPaused) b.push('<span class="bdg amber">Paused by the team</span>');
    else if (m.overLimit) b.push('<span class="bdg amber">Paused – over the limit</span>');
    else if (m.autoPaused === 'refused') b.push('<span class="bdg amber">Paused: the site asked us to stop</span>');
    else if (m.autoPaused === 'robots') b.push('<span class="bdg amber">Paused: robots.txt</span>');
    else if (m.autoPaused === 'private_ip') b.push('<span class="bdg red">Paused: private network</span>');
    else if (m.paused) b.push('<span class="bdg">Paused</span>');
    if (m.state.refusedSince) b.push('<span class="bdg amber">Rate-limited by the site</span>');
    if (m.state.throttled) b.push('<span class="bdg">Delayed</span>');
    if (m.state.flapping) b.push('<span class="bdg amber">Flapping</span>');
    return b.join(' ');
  }

  function strip(m) {
    if (!m.strip || !m.strip.length) return '';
    var html = '<span class="st-m-strip" aria-hidden="true">';
    for (var i = 0; i < 30 - m.strip.length; i++) html += '<i></i>';
    m.strip.forEach(function (c) { html += '<i class="' + (c.ok ? 'ok' : 'bad') + '" title="' + esc(when(c.at) + (c.ms !== null ? ' · ' + c.ms + ' ms' : '')) + '"></i>'; });
    return html + '</span>';
  }

  function stateLine(m) {
    if (m.type === 'manual') return esc((MANUAL.filter(function (x) { return x[0] === m.manualStatus; })[0] || ['', 'Not set'])[1]);
    if (m.state.status === 'paused') return 'Not checked right now';
    if (!m.state.lastCheck) return 'Waiting for the first check…';
    var t = (m.state.lastMs !== null ? m.state.lastMs + ' ms · ' : '') + ago(m.state.lastCheck);
    if (m.state.status === 'down' && m.state.errorText) t = m.state.errorText + ' · ' + t;
    return esc(t);
  }

  function componentsView() {
    var wrap = h('<div class="st-m-pane"></div>');
    var mons = S.mons;
    if (!mons) { wrap.innerHTML = '<div class="panel empty-state"><i class="bx bx-error-circle"></i>The components couldn’t be loaded.</div>'; return wrap; }
    var u = mons.usage;
    wrap.appendChild(h('<div class="st-m-toolbar"><button type="button" class="btn-primary" data-stm="add"><i class="bx bx-plus"></i> Add component</button>' +
      '<span class="hint">' + esc(u.components + ' of ' + u.componentsMax + ' components · ' + u.checks + ' checks') + '</span></div>'));
    if (mons.gate && mons.gate.state === 'frozen') {
      wrap.appendChild(h('<p class="st-m-note"><i class="bx bx-error"></i> Checks are paused – a problem on our side since ' + esc(when(mons.gate.since)) + '. Nothing is counted as down meanwhile.</p>'));
    }
    if (!mons.monitors.length) {
      wrap.appendChild(h('<div class="panel empty-state"><i class="bx bx-pulse"></i><b class="text-white">No components yet</b><p class="mt-1">Add your website, your API or anything you want to show – we’ll check it every few minutes.</p></div>'));
      return wrap;
    }
    var list = h('<div class="st-m-list" id="stmList"></div>');
    var group = null;
    mons.monitors.forEach(function (m) {
      if (m.group !== group) {
        group = m.group;
        if (group) list.appendChild(h('<p class="st-m-group">' + esc(group) + '</p>'));
      }
      list.appendChild(monitorRow(m));
    });
    wrap.appendChild(list);
    if (window.Sortable) {
      window.Sortable.create(list, {
        handle: '.st-m-drag', draggable: '.st-m-row', animation: 150,
        onEnd: function () {
          var ids = $$('.st-m-row', list).map(function (r) { return Number(r.getAttribute('data-id')); });
          api('status-monitor-order', { ids: ids }).then(function (r) {
            if (!r.ok) toast(r.error, 'err');
            refreshMonitors();
          });
        }
      });
    }
    return wrap;
  }

  function monitorRow(m) {
    var dot = m.type === 'manual' ? (MANUAL_TONE[m.manualStatus] || 'none') : (DOT[m.state.status] || 'none');
    var menu = '<button type="button" class="icon-btn" data-stm="edit" title="Edit" aria-label="Edit"><i class="bx bx-pencil"></i></button>';
    if (m.type === 'http' || m.type === 'system') menu += '<button type="button" class="icon-btn" data-stm="run" title="Check now" aria-label="Check now"><i class="bx bx-refresh"></i></button>';
    if (m.type !== 'manual') menu += '<button type="button" class="icon-btn" data-stm="pause" title="' + (m.paused ? 'Resume' : 'Pause') + '" aria-label="' + (m.paused ? 'Resume' : 'Pause') + '"><i class="bx ' + (m.paused ? 'bx-play' : 'bx-pause') + '"></i></button>';
    if (m.type === 'heartbeat') menu += '<button type="button" class="icon-btn" data-stm="hb" title="Heartbeat URL" aria-label="Heartbeat URL"><i class="bx bx-link"></i></button>';
    if (m.type !== 'system') menu += '<button type="button" class="icon-btn danger" data-stm="del" title="Delete" aria-label="Delete"><i class="bx bx-trash"></i></button>';
    // Zustandsfarbe der Zeile (Leiste links, Zustandsabzeichen) – derselbe Schlüssel wie der Punkt
    var row = h('<div class="st-m-row st-m-r-' + dot + (m.paused ? ' st-m-r-paused' : '') + '" data-id="' + m.id + '">' +
      '<div class="st-m-main"><span class="st-m-drag" title="Drag to reorder"><i class="bx bx-grid-vertical"></i></span>' +
      '<span class="st-m-dot st-m-d-' + dot + '"></span>' +
      '<button type="button" class="st-m-name" data-stm="toggle"><i class="bx ' + (TYPE_ICON[m.type] || 'bx-pulse') + '"></i> <span></span></button>' +
      '<span class="st-m-target"></span>' + strip(m) + '<span class="st-m-state">' + stateLine(m) + '</span>' +
      '<span class="st-m-badges">' + badges(m) + '</span><span class="st-m-menu">' + menu + '</span></div>' +
      '<div class="st-m-detail" hidden></div></div>');
    $('.st-m-name span', row).textContent = m.name;
    $('.st-m-target', row).textContent = targetText(m);
    if (S.open[m.id]) loadDetail(row, m.id);
    return row;
  }

  function monitorById(id) {
    return (S.mons && S.mons.monitors || []).filter(function (m) { return m.id === id; })[0] || null;
  }

  function loadDetail(row, id) {
    var box = $('.st-m-detail', row);
    box.hidden = false;
    box.innerHTML = '<div class="hint"><i class="bx bx-loader-alt bx-spin"></i> Loading…</div>';
    api('status-monitor?id=' + id).then(function (r) {
      if (!r.ok) { box.textContent = r.error || 'The details couldn’t be loaded.'; return; }
      var m = r.monitor, html = '';
      html += '<div class="st-m-chart">' + chart(r.hourly) + '</div>';
      var facts = [];
      if (m.state.lastCheck) facts.push('Last check ' + ago(m.state.lastCheck));
      if (m.state.certExpires) facts.push('Certificate valid until ' + when(m.state.certExpires));
      if (m.state.error) facts.push('Last error: ' + m.state.errorText);
      if (m.description) facts.push(m.description);
      if (m.heartbeatUrl) facts.push('Ping URL: ' + m.heartbeatUrl);
      html += '<p class="hint">' + facts.map(esc).join(' · ') + '</p>';
      html += '<p class="lbl mt-3">History</p>';
      if (!r.events.length) html += '<p class="hint">No changes in the last 90 days.</p>';
      html += '<ul class="st-m-events">' + r.events.slice(0, 15).map(function (ev) {
        return '<li><span class="bdg ' + (ev.kind === 'down' ? 'red' : ev.kind === 'up' || ev.kind === 'recovered' ? 'green' : 'amber') + '">' + esc(ev.kind) + '</span> ' + esc(when(ev.at)) + '</li>';
      }).join('') + '</ul>';
      box.innerHTML = html;
    });
  }

  // Antwortzeiten der letzten 48 Stunden (SVG, Durchschnitt je Stunde)
  function chart(hourly) {
    var pts = hourly.filter(function (x) { return x.avg !== null; });
    if (pts.length < 2) return '<p class="hint">Not enough data for a chart yet.</p>';
    var max = Math.max.apply(null, pts.map(function (x) { return x.avg; })) || 1;
    var first = hourly[0].hour, span = Math.max(1, hourly[hourly.length - 1].hour - first);
    var line = pts.map(function (x) { return ((x.hour - first) / span * 600).toFixed(1) + ',' + (110 - x.avg / max * 100).toFixed(1); }).join(' ');
    return '<svg viewBox="0 0 600 120" preserveAspectRatio="none" role="img" aria-label="Response time, last 48 hours"><polyline points="' + line + '" fill="none" stroke="#818cf8" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>' +
      '<p class="hint">Response time, last 48 hours · up to ' + fmtNum(Math.round(max)) + ' ms</p>';
  }

  // Dialog „Add component“ / „Edit“
  function componentDialog(m) {
    var isNew = !m;
    var type = m ? m.type : 'http';
    var c = (m && m.config) || {};
    var intervals = S.state.limits.intervals || [60, 120, 180, 300];
    function fields(t) {
      var html = '<div class="space-y-4">';
      if (isNew) {
        html += '<div class="st-m-types" role="radiogroup" aria-label="Kind of component">' + [['http', 'bx-globe', 'Website check', 'We open your address every few minutes.'], ['heartbeat', 'bx-time-five', 'Heartbeat', 'Your server or job pings us. If the ping is missing, we alert you.'], ['manual', 'bx-slider-alt', 'Manual', 'You set the status yourself.']].map(function (x) {
          return '<label class="st-m-type' + (x[0] === t ? ' on' : '') + '"><input type="radio" name="type" value="' + x[0] + '"' + (x[0] === t ? ' checked' : '') + '><i class="bx ' + x[1] + '"></i><b>' + esc(x[2]) + '</b><small>' + esc(x[3]) + '</small></label>';
        }).join('') + '</div>';
      }
      html += '<div><label class="lbl">Name</label><input class="field" name="name" maxlength="80" value="' + esc(m ? m.name : '') + '"></div>';
      if (t === 'http') {
        html += '<div><label class="lbl">Address</label><input class="field" name="url" maxlength="500" placeholder="https://" value="' + esc(m ? m.target : '') + '"></div>';
        html += '<div class="field-row cols-2"><div><label class="lbl">Check every</label><select class="field" name="interval">' + options(intervals.map(function (i) { return [String(i), (i / 60) + ' min']; }), String(m ? m.interval : 300)) + '</select></div>' +
          '<div><label class="lbl">Timeout</label><select class="field" name="timeout">' + options([[5, '5 s'], [10, '10 s'], [15, '15 s'], [20, '20 s'], [30, '30 s']].map(function (x) { return [String(x[0]), x[1]]; }), String(c.timeout || 10)) + '</select></div></div>';
        html += '<details class="st-m-adv"><summary>Advanced</summary><div class="space-y-4 mt-3">' +
          '<div class="field-row cols-2"><div><label class="lbl">Method</label><select class="field" name="method">' + options([['GET', 'GET'], ['HEAD', 'HEAD']], c.method || 'GET') + '</select></div>' +
          '<div><label class="lbl">Expected status codes</label><input class="field" name="expect" value="' + esc(c.expect || '200-299') + '"></div></div>' +
          '<div class="field-row cols-2"><div><label class="lbl">Keyword <small>(optional)</small></label><input class="field" name="keyword" maxlength="100" value="' + esc(c.keyword || '') + '"></div>' +
          '<div><label class="lbl">The keyword</label><select class="field" name="keyword_mode">' + options([['contains', 'must be on the page'], ['absent', 'must not be on the page']], c.keyword_mode || 'contains') + '</select></div></div>' +
          '<div class="field-row cols-2"><div><label class="lbl">Slow above (ms, 0 = off)</label><input class="field" name="slow_ms" inputmode="numeric" value="' + esc(c.slow_ms || 0) + '"></div>' +
          '<div><label class="lbl">Retries before alerting</label><select class="field" name="retries">' + options([['0', '0'], ['1', '1'], ['2', '2'], ['3', '3']], String(c.retries === undefined ? 1 : c.retries)) + '</select></div></div>' +
          sw('keyword_case', 'Match case', c.keyword_case === true) + sw('redirects', 'Follow redirects', c.redirects !== false) +
          sw('cert_warn', 'Warn 14 and 3 days before the certificate expires', c.cert_warn !== false) +
          sw('tls_ignore', 'Ignore certificate errors', c.tls_ignore === true, 'Only for test servers – it hides real problems.') + '</div></details>';
      } else if (t === 'heartbeat') {
        html += '<div class="field-row cols-2"><div><label class="lbl">Expected every</label><select class="field" name="period">' + options([[300, '5 min'], [900, '15 min'], [3600, '1 hour'], [21600, '6 hours'], [43200, '12 hours'], [86400, '24 hours']].map(function (x) { return [String(x[0]), x[1]]; }), String(c.period || 3600)) + '</select></div>' +
          '<div><label class="lbl">Grace period</label><select class="field" name="grace">' + options([[60, '1 min'], [300, '5 min'], [900, '15 min'], [1800, '30 min'], [3600, '1 hour']].map(function (x) { return [String(x[0]), x[1]]; }), String(c.grace || 300)) + '</select></div></div>';
      } else if (t === 'manual') {
        html += '<div><label class="lbl">Status</label><select class="field" name="status">' + options(MANUAL, (m && m.manualStatus) || 'operational') + '</select></div>';
      }
      html += '<div class="field-row cols-2"><div><label class="lbl">Group <small>(optional)</small></label><input class="field" name="group" maxlength="60" list="stmGroups" value="' + esc(m ? m.group : '') + '"></div>' +
        '<div><label class="lbl">Description <small>(optional)</small></label><input class="field" name="description" maxlength="200" value="' + esc(m ? m.description : '') + '"></div></div>';
      html += sw('public', 'Show on the public page', m ? m.public : true);
      var groups = {};
      ((S.mons && S.mons.monitors) || []).forEach(function (x) { if (x.group) groups[x.group] = 1; });
      html += '<datalist id="stmGroups">' + Object.keys(groups).map(function (g) { return '<option value="' + esc(g) + '">'; }).join('') + '</datalist></div>';
      return html;
    }
    UI.confirm({
      title: isNew ? 'Add component' : 'Edit ' + m.name, ok: isNew ? 'Add component' : 'Save', icon: 'bx-pulse',
      content: function (body, ctl) {
        body.innerHTML = fields(type);
        body.addEventListener('change', function (ev) {
          if (ev.target.name === 'type') {
            type = ev.target.value;
            var keep = ctl.values();
            body.innerHTML = fields(type);
            if (keep.name) $('[name=name]', body).value = keep.name;
          }
        });
      },
      onConfirm: function (v) {
        var data = { type: type, name: v.name, group: v.group, description: v.description, public: v.public };
        if (m) data.id = m.id;
        if (type === 'http') {
          ['url', 'interval', 'timeout', 'method', 'expect', 'keyword', 'keyword_mode', 'slow_ms', 'retries'].forEach(function (k) { data[k] = v[k]; });
          ['interval', 'timeout', 'slow_ms', 'retries'].forEach(function (k) { data[k] = Number(data[k]); });
          ['keyword_case', 'redirects', 'cert_warn', 'tls_ignore'].forEach(function (k) { data[k] = v[k]; });
        } else if (type === 'heartbeat') {
          data.period = Number(v.period);
          data.grace = Number(v.grace);
        } else if (type === 'manual') {
          data.status = v.status;
        }
        return api('status-monitor-save', data).then(function (r) {
          if (!r.ok) return r.error || 'It couldn’t be saved.';
          toast(isNew ? 'Component added.' : 'Saved.');
          if (r.warning) toast(r.warning, 'warn');
          refreshMonitors();
          refreshState();
          if (isNew && r.monitor && r.monitor.heartbeatUrl) showHeartbeat(r.monitor);
        });
      }
    });
  }

  function sw(name, label, on, hint) {
    return '<label class="switch"><input type="checkbox" name="' + name + '"' + (on ? ' checked' : '') + '><span class="track"></span><span class="sw-text">' + esc(label) + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</span></label>';
  }

  // Adresse eines Heartbeats: kopieren, Beispiel für cron, auf Wunsch eine neue Adresse (die alte gilt dann nicht mehr)
  function showHeartbeat(m) {
    UI.alert({
      title: 'Heartbeat URL of ' + m.name, icon: 'bx-time-five', ok: 'Close',
      content: function (body, ctl) {
        function fill(url) {
          body.innerHTML = '<p class="hint">Call this address from your job. If no ping arrives in time, we alert you. Add /fail to report a failure.</p>' +
            '<div class="st-m-copy mt-3"><input class="field" readonly aria-label="Heartbeat URL"><button type="button" class="btn-secondary" data-copy><i class="bx bx-copy"></i> Copy</button></div>' +
            '<pre class="st-m-code"></pre>' +
            '<button type="button" class="btn-ghost mt-3" data-new><i class="bx bx-revision"></i> Make a new URL</button>';
          $('input', body).value = url;
          $('pre', body).textContent = 'curl -fsS ' + url + ' >/dev/null';
          $('[data-copy]', body).addEventListener('click', function () { copy(url); });
          $('[data-new]', body).addEventListener('click', function () {
            UI.confirm({ title: 'Make a new URL?', text: 'The current URL stops working right away – update your job afterwards.', ok: 'Make a new URL', tone: 'warn' }).then(function (yes) {
              if (!yes) return;
              api('status-monitor-token', { id: m.id }).then(function (r) {
                if (!r.ok) { ctl.error(r.error || 'It didn’t work. Please try again.'); return; }
                m = r.monitor;
                fill(m.heartbeatUrl || '');
                toast('New URL made.');
                refreshMonitors();
              });
            });
          });
        }
        fill(m.heartbeatUrl || '');
      }
    });
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('Copied.'); }, function () { toast('Copying didn’t work – select the address and copy it.', 'warn'); });
    else toast('Copying didn’t work – select the address and copy it.', 'warn');
  }

  // ---------------------------------------------------------------- Vorfälle

  function incidentsView() {
    var wrap = h('<div class="st-m-pane"></div>');
    var incs = S.incs;
    wrap.appendChild(h('<div class="st-m-toolbar"><button type="button" class="btn-primary" data-stm="report"><i class="bx bx-error"></i> Report incident</button>' +
      '<button type="button" class="btn-secondary" data-stm="maint"><i class="bx bx-wrench"></i> Schedule maintenance</button></div>'));
    if (!incs) { wrap.appendChild(h('<div class="panel empty-state"><i class="bx bx-error-circle"></i>The incidents couldn’t be loaded.</div>')); return wrap; }
    if (!incs.open.length && !incs.upcoming.length && !incs.past.length) {
      wrap.appendChild(h('<div class="panel empty-state"><i class="bx bx-check-shield"></i>No incidents – nice.</div>'));
      return wrap;
    }
    [['Active', incs.open], ['Upcoming', incs.upcoming], ['Past', incs.past]].forEach(function (sec) {
      if (!sec[1].length) return;
      wrap.appendChild(h('<h3 class="section-title mt-6">' + esc(sec[0]) + '</h3>'));
      sec[1].forEach(function (inc) { wrap.appendChild(incidentCard(inc)); });
    });
    if (incs.more) wrap.appendChild(h('<button type="button" class="btn-ghost mt-3" data-stm="more">Show more</button>'));
    return wrap;
  }

  function incidentCard(inc) {
    var last = inc.updates[inc.updates.length - 1];
    var final = inc.status === 'resolved' || inc.status === 'completed';
    var impact = final ? 'resolved' : inc.kind === 'maintenance' ? 'maint' : inc.impact;
    var card = h('<div class="panel st-m-inc st-m-i-' + esc(impact) + '" data-inc="' + inc.id + '">' +
      '<div class="st-m-inc-head"><b class="st-m-inc-title"></b> <span class="bdg ' + (final ? 'green' : inc.kind === 'maintenance' ? 'brand' : 'amber') + '">' + esc(inc.statusLabel) + '</span>' + (inc.isAuto ? ' <span class="bdg">Auto</span>' : '') + '</div>' +
      '<p class="st-m-inc-meta"></p><p class="st-m-inc-last"></p>' +
      '<div class="st-m-inc-actions">' +
      (final ? '' : '<button type="button" class="btn-secondary" data-stm="update"><i class="bx bx-message-add"></i> Post update</button>' +
        '<button type="button" class="btn-ghost" data-stm="resolve"><i class="bx bx-check"></i> ' + (inc.kind === 'maintenance' ? 'Complete' : 'Resolve') + '</button>') +
      '<button type="button" class="icon-btn" data-stm="inc-edit" title="Edit" aria-label="Edit"><i class="bx bx-pencil"></i></button>' +
      '<button type="button" class="icon-btn" data-stm="inc-updates" title="Edit updates" aria-label="Edit updates"><i class="bx bx-list-ul"></i></button>' +
      '<button type="button" class="icon-btn danger" data-stm="inc-del" title="Delete" aria-label="Delete"><i class="bx bx-trash"></i></button></div></div>');
    $('.st-m-inc-title', card).textContent = inc.title;
    var meta = [];
    if (inc.kind === 'maintenance' && inc.status === 'scheduled') meta.push('Scheduled for ' + when(inc.startsAt) + ' – ' + when(inc.endsAt));
    else meta.push((final ? 'Lasted ' + dur((inc.resolvedAt || 0) - inc.startsAt) : 'Started ' + when(inc.startsAt)));
    if (inc.monitors.length) meta.push('Affected: ' + inc.monitors.map(function (m) { return m.name; }).join(', '));
    if (last) meta.push('Updated ' + ago(last.createdAt));
    (inc.discord || []).forEach(function (d) { meta.push('Discord: ' + (d.state === 'posted' ? 'posted' : d.state === 'queued' ? 'waiting for the bot' : d.state === 'removing' ? 'being removed' : 'failed' + (d.error ? ' (' + d.error + ')' : ''))); });
    $('.st-m-inc-meta', card).textContent = meta.join(' · ');
    $('.st-m-inc-last', card).textContent = last ? last.body : '';
    return card;
  }

  function incidentById(id) {
    var all = [].concat(S.incs.open, S.incs.upcoming, S.incs.past);
    return all.filter(function (i) { return i.id === id; })[0] || null;
  }

  function monitorChecks(selected, withEffect) {
    var sel = {};
    (selected || []).forEach(function (m) { sel[m.id] = m.effect; });
    return '<div class="st-m-affected">' + ((S.mons && S.mons.monitors) || []).map(function (m) {
      return '<div class="st-m-aff"><label class="switch"><input type="checkbox" data-mon="' + m.id + '"' + (sel[m.id] ? ' checked' : '') + '><span class="track"></span><span class="sw-text"></span></label>' +
        (withEffect ? '<select class="field" data-effect="' + m.id + '">' + options(EFFECTS, sel[m.id] && sel[m.id] !== 'maintenance' ? sel[m.id] : 'partial') + '</select>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function fillNames(body) {
    $$('[data-mon]', body).forEach(function (cb) {
      var m = monitorById(Number(cb.getAttribute('data-mon')));
      var t = cb.parentNode.querySelector('.sw-text');
      if (m && t) t.textContent = m.name + (m.public ? '' : ' (private)');
    });
  }
  function readChecks(body, withEffect) {
    return $$('[data-mon]', body).filter(function (cb) { return cb.checked; }).map(function (cb) {
      var id = Number(cb.getAttribute('data-mon'));
      var o = { id: id };
      if (withEffect) o.effect = $('[data-effect="' + id + '"]', body).value;
      return o;
    });
  }

  function discordBox(on) {
    return S.incs && S.incs.discord ? sw('discord', 'Post to Discord (#status)', on) : '';
  }

  function reportDialog() {
    UI.confirm({
      title: 'Report incident', ok: 'Post incident', icon: 'bx-error',
      content: function (body) {
        body.innerHTML = '<div class="space-y-4"><div><label class="lbl">Title</label><input class="field" name="title" maxlength="160" placeholder="Website is slow"></div>' +
          '<div class="field-row cols-2"><div><label class="lbl">Status</label><select class="field" name="status">' + options(INC_STATUS.slice(0, 3), 'investigating') + '</select></div>' +
          '<div><label class="lbl">Impact</label><select class="field" name="impact">' + options(IMPACTS, 'minor') + '</select></div></div>' +
          '<div><label class="lbl">Affected components</label>' + monitorChecks([], true) + '</div>' +
          '<div><label class="lbl">Message</label><textarea class="field" name="body" rows="4" maxlength="5000"></textarea><p class="hint">Simple formatting: **bold**, lists, links.</p></div>' +
          discordBox(true) + '</div>';
        fillNames(body);
      },
      onConfirm: function (v, ctl) {
        return api('status-incident-save', { kind: 'incident', title: v.title, status: v.status, impact: v.impact, body: v.body, monitors: readChecks(ctl.body, true), discord: v.discord !== false }).then(function (r) {
          if (!r.ok) return r.error || 'It couldn’t be posted.';
          toast('Incident posted.');
          refreshIncidents();
          refreshState();
        });
      }
    });
  }

  function maintenanceDialog() {
    var start = Math.ceil(Date.now() / 3600000) * 3600 + 3600;
    UI.confirm({
      title: 'Schedule maintenance', ok: 'Schedule', icon: 'bx-wrench',
      content: function (body) {
        body.innerHTML = '<div class="space-y-4"><div><label class="lbl">Title</label><input class="field" name="title" maxlength="160" placeholder="Database upgrade"></div>' +
          '<div class="field-row cols-2"><div><label class="lbl">Starts</label><input class="field" type="datetime-local" name="starts" value="' + localInput(start) + '"></div>' +
          '<div><label class="lbl">Ends</label><input class="field" type="datetime-local" name="ends" value="' + localInput(start + 3600) + '"></div></div>' +
          '<div><label class="lbl">Components</label>' + monitorChecks([], false) + '</div>' +
          '<div><label class="lbl">Message</label><textarea class="field" name="body" rows="3" maxlength="5000"></textarea></div>' +
          '<p class="hint">It starts and ends automatically. Alerts for these components are muted during the window.</p>' + discordBox(true) + '</div>';
        fillNames(body);
      },
      onConfirm: function (v, ctl) {
        var s = fromInput(v.starts), e = fromInput(v.ends);
        if (s === null || e === null) return 'Please enter when the maintenance starts and ends.';
        return api('status-incident-save', { kind: 'maintenance', title: v.title, starts_at: s, ends_at: e, body: v.body, monitors: readChecks(ctl.body, false), discord: v.discord !== false }).then(function (r) {
          if (!r.ok) return r.error || 'It couldn’t be scheduled.';
          toast('Maintenance scheduled.');
          refreshIncidents();
        });
      }
    });
  }

  function updateDialog(inc, resolve) {
    var statuses = inc.kind === 'maintenance' ? MAINT_STATUS : INC_STATUS;
    var cur = resolve ? (inc.kind === 'maintenance' ? 'completed' : 'resolved') : inc.status;
    var posted = (inc.discord || []).length > 0;
    UI.confirm({
      title: resolve ? (inc.kind === 'maintenance' ? 'Complete maintenance' : 'Resolve incident') : 'Post update', ok: resolve ? (inc.kind === 'maintenance' ? 'Complete' : 'Resolve') : 'Post update', icon: 'bx-message-add',
      content: function (body) {
        body.innerHTML = '<div class="space-y-4"><div><label class="lbl">Status</label><select class="field" name="status">' + options(statuses, cur) + '</select></div>' +
          '<div><label class="lbl">Message</label><textarea class="field" name="body" rows="4" maxlength="5000">' + (resolve ? (inc.kind === 'maintenance' ? 'The maintenance is complete.' : 'This incident has been resolved.') : '') + '</textarea></div>' +
          (posted ? '' : discordBox(false)) + '</div>';
      },
      onConfirm: function (v) {
        return api('status-incident-update', { id: inc.id, status: v.status, body: v.body, discord: v.discord === true }).then(function (r) {
          if (!r.ok) return r.error || 'It couldn’t be posted.';
          toast('Update posted.');
          refreshIncidents();
          refreshState();
        });
      }
    });
  }

  function editIncidentDialog(inc) {
    var maint = inc.kind === 'maintenance';
    UI.confirm({
      title: 'Edit ' + (maint ? 'maintenance' : 'incident'), ok: 'Save', icon: 'bx-pencil',
      content: function (body) {
        body.innerHTML = '<div class="space-y-4"><div><label class="lbl">Title</label><input class="field" name="title" maxlength="160"></div>' +
          (maint ? '<div class="field-row cols-2"><div><label class="lbl">Starts</label><input class="field" type="datetime-local" name="starts" value="' + localInput(inc.startsAt) + '"' + (inc.status !== 'scheduled' ? ' disabled' : '') + '></div>' +
            '<div><label class="lbl">Ends</label><input class="field" type="datetime-local" name="ends" value="' + localInput(inc.endsAt || inc.startsAt + 3600) + '"></div></div>'
            : '<div><label class="lbl">Impact</label><select class="field" name="impact">' + options(IMPACTS, inc.impact) + '</select></div>') +
          '<div><label class="lbl">' + (maint ? 'Components' : 'Affected components') + '</label>' + monitorChecks(inc.monitors, !maint) + '</div></div>';
        $('[name=title]', body).value = inc.title;
        fillNames(body);
      },
      onConfirm: function (v, ctl) {
        var data = { id: inc.id, title: v.title, monitors: readChecks(ctl.body, !maint) };
        if (maint) {
          if (inc.status === 'scheduled') data.starts_at = fromInput(v.starts);
          if (inc.status !== 'completed') data.ends_at = fromInput(v.ends);
        } else data.impact = v.impact;
        return api('status-incident-save', data).then(function (r) {
          if (!r.ok) return r.error || 'It couldn’t be saved.';
          toast('Saved.');
          refreshIncidents();
        });
      }
    });
  }

  function updatesDialog(inc) {
    UI.alert({
      title: 'Updates of ' + inc.title, icon: 'bx-list-ul', ok: 'Close',
      content: function (body, ctl) {
        var list = h('<div class="st-m-updates"></div>');
        inc.updates.slice().reverse().forEach(function (u) {
          var row = h('<div class="st-m-upd"><p class="hint"></p><p class="st-m-upd-body"></p><div class="flex gap-2"><button type="button" class="btn-ghost" data-u="edit">Edit</button><button type="button" class="btn-ghost text-red-400" data-u="del">Delete</button></div></div>');
          $('.hint', row).textContent = (u.isAuto ? 'Auto · ' : '') + statusLabel(u.status) + ' · ' + when(u.createdAt) + (u.editedAt ? ' (edited)' : '');
          $('.st-m-upd-body', row).textContent = u.body;
          $('[data-u=edit]', row).addEventListener('click', function () {
            ctl.close();
            UI.confirm({
              title: 'Edit update', ok: 'Save', icon: 'bx-pencil',
              content: function (b) {
                b.innerHTML = '<label class="lbl">Message</label><textarea class="field" name="body" rows="6" maxlength="5000"></textarea>';
                $('textarea', b).value = u.body;
              },
              onConfirm: function (v) {
                return api('status-incident-edit', { id: inc.id, update_id: u.id, body: v.body }).then(function (r) {
                  if (!r.ok) return r.error || 'It couldn’t be saved.';
                  toast('Saved.');
                  refreshIncidents();
                });
              }
            });
          });
          $('[data-u=del]', row).addEventListener('click', function () {
            ctl.close();
            UI.confirm({ title: 'Delete this update?', text: 'It disappears from the status page.', ok: 'Delete', tone: 'danger' }).then(function (yes) {
              if (!yes) return;
              api('status-incident-edit', { id: inc.id, update_id: u.id, delete: true }).then(function (r) {
                if (!r.ok) { toast(r.error, 'err'); return; }
                toast('Update deleted.');
                refreshIncidents();
              });
            });
          });
          list.appendChild(row);
        });
        body.appendChild(list);
      }
    });
  }

  function statusLabel(s) {
    var all = INC_STATUS.concat(MAINT_STATUS);
    for (var i = 0; i < all.length; i++) if (all[i][0] === s) return all[i][1];
    return s;
  }

  // ---------------------------------------------------------------- Alarme

  function alertsView() {
    var wrap = h('<div class="st-m-pane"></div>');
    var a = S.alerts;
    if (!a) { wrap.appendChild(h('<div class="panel empty-state"><i class="bx bx-error-circle"></i>The alerts couldn’t be loaded.</div>')); return wrap; }
    var events = {};
    a.admins.events.forEach(function (e) { events[e] = 1; });
    var mail = h('<div class="panel space-y-4"><h3 class="section-title">Email and bell</h3>' +
      sw('admins', 'Email all admins (' + a.admins.count + ')', a.admins.enabled, 'The bell of every admin always shows them.') +
      '<div class="st-m-events-pick">' + EVENTS.map(function (e) { return '<label class="st-m-check"><input type="checkbox" data-ev="' + e[0] + '"' + (events[e[0]] ? ' checked' : '') + '> ' + esc(e[1]) + '</label>'; }).join('') + '</div>' +
      '<button type="button" class="btn-secondary" data-stm="save-alerts"><i class="bx bx-save"></i> Save</button></div>');
    wrap.appendChild(mail);
    wrap.appendChild(botCard(a.bot));
    var recent = h('<div class="panel"><h3 class="section-title">Recent alerts</h3><div class="st-m-recent"></div></div>');
    var list = $('.st-m-recent', recent);
    if (!a.recent.length) list.appendChild(h('<p class="hint">No alerts yet.</p>'));
    a.recent.forEach(function (r) {
      var row = h('<p class="st-m-rec"><span class="bdg ' + (r.state === 'sent' ? 'green' : r.state === 'failed' ? 'red' : '') + '"></span> <span class="st-m-rec-t"></span></p>');
      $('.bdg', row).textContent = r.state === 'sent' ? 'Sent' : r.state === 'failed' ? 'Failed' : r.state === 'merged' ? 'Merged' : r.state === 'skipped' ? 'Skipped' : 'Waiting';
      $('.st-m-rec-t', row).textContent = when(r.at) + ' · ' + r.title + ' · ' + (r.channel === 'admins' ? 'email to admins' : r.channel === 'bell' ? 'bell' : r.channel === 'bot' ? 'Discord #alerts' : r.channel) + (r.error ? ' – ' + r.error : '');
      list.appendChild(row);
    });
    wrap.appendChild(recent);
    return wrap;
  }

  function botCard(b) {
    var card = h('<div class="panel space-y-4"><h3 class="section-title"><span><i class="bx bxl-discord-alt text-[#8b93ff]"></i> Discord bot</span></h3></div>');
    if (!b.installed) {
      card.appendChild(h('<p class="hint">The Discord bot isn’t set up on this server.</p>'));
      return card;
    }
    var line = !b.reportedAt ? 'The bot hasn’t reported yet.'
      : !b.supported ? 'The bot doesn’t support status messages yet – update it with discord-bot/install.sh --update.'
        : 'Bot ' + (b.ready === false ? 'disconnected from Discord' : 'ready') + ' · reported ' + ago(b.reportedAt) + (b.version ? ' · version ' + b.version : '');
    card.appendChild(h('<p class="hint"></p>'));
    $('p.hint', card).textContent = line;
    var choices = [['', 'Off']].concat(b.choices.filter(function (c) { return c.canPost; }).map(function (c) { return [c.id, '#' + c.name]; }));
    var form = h('<div class="field-row cols-2"><div><label class="lbl">Public incident posts</label><select class="field" data-bot="status">' + options(choices, b.statusChannel) + '</select><p class="hint">Read-only for members, e.g. #status.</p></div>' +
      '<div><label class="lbl">Team alerts</label><select class="field" data-bot="alerts">' + options(choices, b.saved ? b.alertsChannel : ((b.suggested && b.suggested.alerts) || '')) + '</select><p class="hint">Only the team should see it, e.g. #alerts.</p></div></div>');
    card.appendChild(form);
    if (b.alertsNote) {
      var note = h('<p class="hint"></p>');
      note.textContent = 'Team alerts are off: ' + b.alertsNote;
      card.appendChild(note);
    }
    card.appendChild(h('<div class="flex items-center gap-3 flex-wrap"><button type="button" class="btn-secondary" data-stm="save-bot"' + (b.supported ? '' : ' disabled') + '><i class="bx bx-save"></i> Save channels</button>' +
      (b.saved ? '' : '<span class="hint">Suggested by the bot – team alerts start once you save the channels.</span>') + '</div>'));
    return card;
  }

  // ---------------------------------------------------------------- Einstellungen

  function settingsView() {
    var p = S.state.page, s = p.settings;
    var wrap = h('<div class="st-m-pane"><div class="panel space-y-4">' +
      '<div class="field-row cols-2"><div><label class="lbl">Name</label><input class="field" name="title" maxlength="120"></div>' +
      '<div><label class="lbl">Description</label><input class="field" name="description" maxlength="300"></div></div>' +
      sw('online', 'Online', p.online, p.online ? 'Visitors see the page.' : 'Visitors get “This status page is offline”.') +
      sw('show_uptime', 'Show uptime', s.show_uptime) + sw('show_response', 'Show response times', s.show_response) +
      '<div class="field-row cols-2"><div><label class="lbl">Open an incident automatically</label><select class="field" name="auto_incident">' + options([['0', 'Off'], ['300', 'When a check is down for 5 min'], ['900', 'When a check is down for 15 min']], String(s.auto_incident)) + '</select></div>' +
      '<div><label class="lbl">Past incidents on the page (days)</label><input class="field" name="history_days" type="number" min="0" max="30" value="' + esc(s.history_days) + '"></div></div>' +
      '<div class="flex items-center gap-3 flex-wrap"><button type="button" class="btn-primary" data-stm="save-page"><i class="bx bx-save"></i> Save</button>' +
      '<a class="btn-ghost" target="_blank" rel="noopener"><i class="bx bx-link-external"></i> View page</a></div></div>' +
      (userScope() ? '<div class="panel st-m-danger"><div><b>Delete status page</b><p>Removes the page with all components and incidents.</p></div>' +
        '<button type="button" class="btn-danger" data-stm="delete-page"><i class="bx bx-trash"></i> Delete</button></div>' : '') + '</div>');
    $('[name=title]', wrap).value = p.title;
    $('[name=description]', wrap).value = p.description;
    $('a.btn-ghost', wrap).href = p.online ? p.url : (p.preview || p.url);
    return wrap;
  }

  // ---------------------------------------------------------------- Aktionen

  function onClick(ev) {
    var tabBtn = ev.target.closest('[data-stm-tab]');
    if (tabBtn) {
      S.tab = tabBtn.getAttribute('data-stm-tab');
      renderBody();
      if (S.tab === 'components') refreshMonitors();
      if (S.tab === 'incidents') refreshIncidents();
      if (S.tab === 'alerts') refreshAlerts();
      return;
    }
    var btn = ev.target.closest('[data-stm]');
    if (!btn) return;
    var act = btn.getAttribute('data-stm');
    var row = btn.closest('[data-id]');
    var m = row ? monitorById(Number(row.getAttribute('data-id'))) : null;
    var card = btn.closest('[data-inc]');
    var inc = card ? incidentById(Number(card.getAttribute('data-inc'))) : null;
    if (act === 'create-page') return createPage(btn);
    if (act === 'delete-page') return deletePage();
    if (act === 'add') return componentDialog(null);
    if (act === 'edit' && m) return componentDialog(m);
    if (act === 'toggle' && m) {
      S.open[m.id] = !S.open[m.id];
      if (S.open[m.id]) loadDetail(row, m.id);
      else $('.st-m-detail', row).hidden = true;
      return;
    }
    if (act === 'run' && m) {
      api('status-monitor-run', { id: m.id }).then(function (r) { if (r.ok) toast('Checking now – the result shows in a few seconds.', 'info'); else toast(r.error, 'err'); });
      return;
    }
    if (act === 'pause' && m) {
      api('status-monitor-pause', { id: m.id, paused: !m.paused }).then(function (r) { if (!r.ok) toast(r.error, 'err'); else toast(m.paused ? 'Checks resumed.' : 'Checks paused.'); refreshMonitors(); });
      return;
    }
    if (act === 'hb' && m) return showHeartbeat(m);
    if (act === 'del' && m) {
      UI.confirm({ title: 'Delete ' + m.name + '?', text: 'Its checks and history are removed. This can’t be undone.', ok: 'Delete', tone: 'danger' }).then(function (yes) {
        if (!yes) return;
        api('status-monitor-delete', { id: m.id }).then(function (r) { if (!r.ok) toast(r.error, 'err'); else toast('Component deleted.'); refreshMonitors(); refreshState(); });
      });
      return;
    }
    if (act === 'report') return reportDialog();
    if (act === 'maint') return maintenanceDialog();
    if (act === 'update' && inc) return updateDialog(inc, false);
    if (act === 'resolve' && inc) return updateDialog(inc, true);
    if (act === 'inc-edit' && inc) return editIncidentDialog(inc);
    if (act === 'inc-updates' && inc) return updatesDialog(inc);
    if (act === 'inc-del' && inc) {
      UI.confirm({ title: 'Delete this ' + (inc.kind === 'maintenance' ? 'maintenance' : 'incident') + '?', text: 'It disappears from the status page, and its Discord post is removed. This can’t be undone.', ok: 'Delete', tone: 'danger' }).then(function (yes) {
        if (!yes) return;
        api('status-incident-delete', { id: inc.id }).then(function (r) { if (!r.ok) toast(r.error, 'err'); else toast('Deleted.'); refreshIncidents(); refreshState(); });
      });
      return;
    }
    if (act === 'more') {
      var past = S.incs.past, before = past.length ? past[past.length - 1].id : 0;
      api('status-incidents?before=' + before).then(function (r) { if (r.ok) { S.incs.past = past.concat(r.past); S.incs.more = r.more; renderBody(); } });
      return;
    }
    if (act === 'save-alerts') {
      var evs = $$('[data-ev]', S.root).filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-ev'); });
      api('status-alerts-owner', { admins: $('[name=admins]', S.root).checked, events: evs }).then(function (r) { if (!r.ok) toast(r.error, 'err'); else { S.alerts = r; toast('Alerts saved.'); renderBody(); } });
      return;
    }
    if (act === 'save-bot') {
      api('status-bot-channels', { status_channel_id: $('[data-bot=status]', S.root).value, alerts_channel_id: $('[data-bot=alerts]', S.root).value }).then(function (r) {
        if (!r.ok) toast(r.error, 'err');
        else { S.alerts = r; toast('Channels saved.'); renderBody(); }
      });
      return;
    }
    if (act === 'save-page') {
      var root = S.root;
      api('status-page', {
        title: $('[name=title]', root).value, description: $('[name=description]', root).value, online: $('[name=online]', root).checked,
        show_uptime: $('[name=show_uptime]', root).checked, show_response: $('[name=show_response]', root).checked,
        auto_incident: Number($('[name=auto_incident]', root).value), history_days: Number($('[name=history_days]', root).value)
      }).then(function (r) {
        if (!r.ok) { toast(r.error, 'err'); return; }
        S.state = r;
        toast('Settings saved.');
        renderHead();
        renderBody();
      });
    }
  }

  window.OYS_STATUS = { mount: mount };
})();
