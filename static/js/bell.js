/* OnYourSite – Glocke für den Editor und den Kopf des Admin-Bereichs (window.OYSBell). Braucht ui.js (window.OYSUI).
   Fragt /dashboard/api/notifications ab (jede Minute, solange der Tab sichtbar ist, und sofort, wenn er wieder sichtbar
   wird), zeigt die letzten Einträge mit Symbol und Farbe ihres Typs und öffnet ihr Ziel über OYSUI.openLink().
   Neues erscheint als Hinweis: beim ersten Abruf nur, was neuer ist als der zuletzt gezeigte Eintrag dieses Kontos in
   diesem Browser (oys.notify.<Konto>), höchstens 3 Hinweise und „+N more notifications“. Alle Texte als Text. */
(function () {
  'use strict';
  if (window.OYSBell) return;
  var BX = /^bx[sl]?-[a-z0-9-]+$/;
  var TONES = { ok: 1, info: 1, warn: 1, err: 1, hc: 1 };
  var POLL_MS = 60000, REFRESH_MS = 15000, MAX_TOASTS = 3;

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // root: Element mit data-bell (bellMarkup() auf dem Server: data-csrf, data-user, data-readonly im Nutzer-Modus)
  // opts: onOpen() – vor dem Öffnen (andere Menüs schließen) · onAnswer(res) – nach jedem Abruf · onNew(items) – neue
  // ungelesene Einträge · handle/toast/openLink – Ersatz für die Funktionen aus ui.js (Tests)
  function mount(root, opts) {
    var UI = window.OYSUI;
    if (!root || !UI) return null;
    opts = opts || {};
    var btn = root.querySelector('#bellBtn'), menu = root.querySelector('#bellMenu'), badge = root.querySelector('#bellBadge');
    if (!btn || !menu) return null;
    var handle = opts.handle || UI.handle, toast = opts.toast || UI.toast, openLink = opts.openLink || UI.openLink;
    var csrf = root.getAttribute('data-csrf') || '';
    var user = /^\d+$/.test(root.getAttribute('data-user') || '') ? root.getAttribute('data-user') : '';
    var readonly = root.hasAttribute('data-readonly');
    var KEY = 'oys.notify.' + user;
    var items = [], latest = 0, unread = 0, seen = null, lastPoll = 0, busy = null, ok = false;
    // Offene Hinweise der Glocke: beim Öffnen der Liste überflüssig (sie stehen dort) und sonst über der Liste
    var notes = [];

    // Zuletzt als Hinweis gezeigte Nummer – je Konto im Browser, damit zwei Tabs nichts doppelt zeigen
    function stored() {
      if (!user) return null;
      try { var v = localStorage.getItem(KEY); return v !== null && /^\d+$/.test(v) ? Number(v) : null; } catch (e) { return null; }
    }
    function store(id) {
      if (!user) return;
      try { if (id > (stored() || 0)) localStorage.setItem(KEY, String(id)); } catch (e) { /* ohne Speicher: nur in diesem Tab */ }
    }

    // bg: Abfrage im Hintergrund – der Server zählt sie nicht als Aktivität (ohne Bedienung läuft die Sitzung ab)
    function request(path, body, bg) {
      var o = { credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } };
      if (bg) o.headers['X-OYS-Poll'] = '1';
      if (body !== undefined) {
        o.method = 'POST';
        o.headers['Content-Type'] = 'application/json';
        o.body = JSON.stringify(body);
        // „Gelesen“ kommt auch an, wenn das Ziel gleich eine andere Seite lädt (z. B. vom Editor in den Admin-Bereich)
        o.keepalive = true;
      }
      return fetch('/dashboard/api/' + path, o).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (data) {
          return handle(r.status, data && typeof data === 'object' ? data : { ok: false });
        });
      }, function () { return null; });
    }

    function look(n) {
      return {
        icon: typeof n.icon === 'string' && BX.test(n.icon) ? n.icon : 'bx-bell',
        tone: TONES[n.tone] ? n.tone : 'info'
      };
    }
    function render() {
      var html = '<div class="dd-head">Notifications' + (unread && !readonly ? '<button type="button" data-bell-read>Mark all as read</button>' : '') + '</div>';
      if (!items.length) {
        html += '<div class="empty-state" style="padding:24px 10px"><i class="bx bx-bell-off"></i>' + (ok ? 'Nothing new yet.' : 'Loading…') + '</div>';
      } else {
        html += '<div class="max-h-96 overflow-y-auto custom-scrollbar">' + items.map(function (n) {
          var l = look(n);
          return '<button type="button" class="notif w-full text-left' + (n.read ? '' : ' unread') + '" data-bell-item="' + esc(n.id) + '">' +
            '<span class="ni tone-' + l.tone + '"><i class="bx ' + l.icon + '"></i></span><span class="min-w-0"><b>' + esc(n.title) + '</b>' +
            (n.body ? '<p>' + esc(n.body) + '</p>' : '') + '<small>' + esc(n.ago) + '</small></span></button>';
        }).join('') + '</div>';
      }
      menu.innerHTML = html;
    }
    function paintBadge() {
      if (!badge) return;
      badge.hidden = !unread;
      badge.textContent = unread > 9 ? '9+' : String(unread);
    }
    function ring() {
      var i = btn.querySelector('i');
      if (!i) return;
      i.classList.remove('bell-ring');
      void i.offsetWidth;
      i.classList.add('bell-ring');
    }
    function isOpen() { return !menu.classList.contains('hidden'); }
    function open() {
      if (opts.onOpen) opts.onOpen();
      notes.splice(0).forEach(function (h) { if (h && h.close) h.close(); });
      menu.classList.remove('hidden');
      btn.setAttribute('aria-expanded', 'true');
      render();
      poll();
    }
    // Schließen; stand der Fokus in der Liste, geht er zur Glocke zurück (nicht ins Leere)
    function close() {
      var inside = menu.contains(document.activeElement);
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
      if (inside) btn.focus();
    }

    // Eintrag gelesen (nicht im Nutzer-Modus eines Admins – der Server schreibt dann ohnehin nichts)
    function markRead(n) {
      if (!n || n.read) return;
      n.read = true;
      unread = Math.max(0, unread - 1);
      paintBadge();
      if (isOpen()) render();
      if (!readonly) request('notifications-read', { id: n.id });
    }
    function follow(n) {
      markRead(n);
      if (n.link) openLink(n.link);
    }

    // Neue ungelesene Einträge als Hinweise: die neuesten zuerst, höchstens 3, dann „+N more notifications“.
    // Mit Ziel öffnet ein Klick es (und markiert den Eintrag gelesen); ohne Ziel schließt ein Klick nur den Hinweis.
    function announce(fresh) {
      fresh.slice(0, MAX_TOASTS).forEach(function (n) {
        var l = look(n);
        notes.push(toast({ title: String(n.title || ''), text: String(n.body || ''), tone: l.tone, icon: l.icon,
          action: n.link ? { label: 'Open', run: function () { follow(n); } } : undefined }));
      });
      if (fresh.length > MAX_TOASTS) {
        notes.push(toast({ text: '+' + (fresh.length - MAX_TOASTS) + ' more notifications', tone: 'info', action: { label: 'Show', run: open } }));
      }
      if (notes.length > 20) notes.splice(0, notes.length - 20);
    }

    function poll(bg) {
      if (busy) return busy;
      lastPoll = Date.now();
      busy = request('notifications', undefined, bg).then(function (res) {
        busy = null;
        if (!res || !res.ok || !Array.isArray(res.items)) return res;
        ok = true;
        items = res.items.filter(function (n) { return n !== null && typeof n === 'object'; });
        unread = Number(res.unread) || 0;
        latest = Number(res.latest) || 0;
        paintBadge();
        // Erster Abruf: die gespeicherte Nummer dieses Kontos zählt, sonst nur eine Grundlinie
        var last = stored();
        var base = seen === null ? (last === null ? latest : last) : Math.max(seen, last || 0);
        var fresh = items.filter(function (n) { return !n.read && Number(n.id) > base; });
        seen = Math.max(base, latest);
        store(seen);
        if (fresh.length) {
          // Bei offener Liste stehen sie dort – keine Hinweise darüber
          if (!isOpen()) {
            ring();
            announce(fresh);
          }
          if (opts.onNew) opts.onNew(fresh);
        }
        if (isOpen()) render();
        if (opts.onAnswer) opts.onAnswer(res);
        return res;
      });
      return busy;
    }

    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', function () { if (isOpen()) close(); else open(); });
    menu.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-bell-read]')) {
        // Nur bis zum neuesten Eintrag, den die Liste gezeigt hat – was danach kam, bleibt ungelesen
        if (readonly || !latest) return;
        request('notifications-read', { upTo: latest }).then(function () { poll(); });
        items.forEach(function (n) { n.read = true; });
        unread = 0;
        paintBadge();
        // Neu zeichnen erst nach diesem Klick: andere Empfänger des Klicks (z. B. „außerhalb geklickt“ im Editor) sehen
        // den Knopf sonst nicht mehr in der Glocke und schließen die Liste
        setTimeout(function () { if (isOpen()) render(); }, 0);
        return;
      }
      var b = ev.target.closest('[data-bell-item]');
      if (!b) return;
      var id = Number(b.getAttribute('data-bell-item'));
      var n = items.filter(function (x) { return Number(x.id) === id; })[0];
      if (!n) return;
      close();
      follow(n);
    });
    // Außerhalb klicken oder Escape schließt die Liste
    document.addEventListener('click', function (ev) { if (isOpen() && !root.contains(ev.target)) close(); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && isOpen() && !UI.isOpen()) { close(); btn.focus(); } });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && Date.now() - lastPoll > REFRESH_MS) poll(true);
    });
    setInterval(function () { if (!document.hidden) poll(true); }, POLL_MS);
    poll(true);
    return { poll: poll, open: open, close: close };
  }

  window.OYSBell = { mount: mount };
})();
