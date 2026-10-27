/* OnYourSite – Editor
   Zustand im Browser, Live-Vorschau über den echten Seiten-Renderer (1:1 wie die öffentliche Seite). */
(function () {
  'use strict';

  var E = window.OYS_EDITOR || {};
  var state = {
    page: E.page,
    blocks: (E.blocks || []).map(normBlock),
    pages: E.pages || []
  };
  var dirty = false;
  var version = 0;
  var saving = false;
  var newCounter = 0;
  var openBlocks = {};
  var extrasTab = {};
  var activeTab = 'inhalte';

  // ================================================================
  // Helfer
  // ================================================================
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function h(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  }
  function setPath(obj, path, value) {
    var keys = path.split('.');
    var o = obj;
    for (var i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = /^\d+$/.test(keys[i + 1]) ? [] : {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
  }
  function debounce(fn, ms) { var t; return function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); }; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function fmtNum(n) { return Number(n || 0).toLocaleString('de-DE'); }
  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).slice(0, 2);
    var s = parts.map(function (p) { return p.charAt(0).toUpperCase(); }).join('');
    return s || '?';
  }
  function uploadUrl(f) { return f ? '/static/uploads/' + encodeURIComponent(f) : ''; }

  function toast(msg, type) {
    var icon = type === 'err' ? 'bx-error-circle' : type === 'info' ? 'bx-info-circle' : 'bx-check-circle';
    var el = h('<div class="toast ' + (type || 'ok') + '"><i class="bx ' + icon + '"></i><span>' + esc(msg) + '</span></div>');
    $('#toasts').appendChild(el);
    setTimeout(function () { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 300); }, type === 'err' ? 5200 : 3000);
  }

  function api(action, body, asText) {
    var opts = { credentials: 'same-origin', headers: { 'X-CSRF-Token': E.csrf } };
    var url = '/dashboard/api/' + action;
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      if (state.page && body && typeof body === 'object' && !body.page && body.page_id === undefined) body.page_id = state.page.id;
      opts.body = JSON.stringify(body);
    } else if (state.page) {
      url += (url.indexOf('?') === -1 ? '?' : '&') + 'page=' + state.page.id;
    }
    return fetch(url, opts).then(function (r) {
      if (asText) return r.text();
      return r.json().catch(function () { return { ok: false, error: 'Unerwartete Antwort vom Server.' }; });
    }).catch(function () {
      return asText ? '' : { ok: false, error: 'Keine Verbindung zum Server.' };
    });
  }
  function apiGet(action) { return api(action); }

  function upload(kind, file) {
    var fd = new FormData();
    fd.append('kind', kind);
    fd.append('file', file);
    if (state.page) fd.append('page_id', state.page.id);
    return fetch('/dashboard/api/upload', { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-CSRF-Token': E.csrf } })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: 'Upload fehlgeschlagen (Verbindung).' }; });
  }

  function pickFile(accept, multiple) {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = !!multiple;
      input.addEventListener('change', function () { resolve(Array.prototype.slice.call(input.files || [])); });
      input.click();
    });
  }

  function brand(key) {
    for (var i = 0; i < E.brands.length; i++) if (E.brands[i].key === key) return E.brands[i];
    return null;
  }
  function brandSvg(key, cls) {
    var b = brand(key);
    return b ? '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + b.svg + '</svg>' : '';
  }
  function detectBrand(url) {
    url = String(url || '').toLowerCase();
    if (url.indexOf('mailto:') === 0) return 'email';
    var m = url.match(/^https?:\/\/([^\/?#]+)/);
    if (!m) return null;
    var host = m[1].replace(/^(www|m|mobile|open|music|vm)\./, '');
    for (var i = 0; i < E.brands.length; i++) {
      var d = E.brands[i].domains;
      for (var j = 0; j < d.length; j++) {
        if (host === d[j] || host.slice(-(d[j].length + 1)) === '.' + d[j]) return E.brands[i].key;
      }
    }
    return null;
  }
  function prettyUrl(url) {
    url = String(url || '');
    if (url.indexOf('mailto:') === 0) return url.slice(7);
    if (url.indexOf('tel:') === 0) return url.slice(4);
    return url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  }
  function normalizeUrl(v) {
    v = String(v || '').trim().replace(/\s+/g, '');
    if (!v) return '';
    if (/^\/[^\/]/.test(v)) return v;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v) && /^[^@\s\/]+@[^@\s\/]+\.[a-z]{2,}$/i.test(v)) return 'mailto:' + v;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v) && /^(\+|00)[0-9 ()\/-]{6,}$/.test(v)) return 'tel:' + v.replace(/[^0-9+]/g, '');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) return 'https://' + v.replace(/^\/+/, '');
    return v;
  }
  function detectEmbed(url) {
    url = String(url || '');
    if (/(youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(url)) return 'youtube';
    if (/twitch\.tv/i.test(url)) return 'twitch';
    if (/open\.spotify\.com\/(intl-[a-z-]+\/)?(embed\/)?(track|album|playlist|episode|show|artist)\//i.test(url) || /^spotify:/i.test(url)) return 'spotify';
    return null;
  }

  // ================================================================
  // Blöcke: Typen & Standardwerte
  // ================================================================
  var TYPES = {
    link:      { name: 'Link', icon: 'bx bx-link', color: '#818cf8', desc: 'Beliebige Adresse mit passendem Symbol', group: 'Links & Social' },
    socials:   { name: 'Social-Icons', icon: 'bx bx-share-alt', color: '#ec4899', desc: 'Instagram, TikTok, YouTube & mehr', group: 'Links & Social' },
    youtube:   { type: 'embed', provider: 'youtube', name: 'YouTube', brand: 'youtube', color: '#ff0033', desc: 'Video direkt auf der Seite', group: 'Videos, Musik & Bilder' },
    twitch:    { type: 'embed', provider: 'twitch', name: 'Twitch', brand: 'twitch', color: '#9146ff', desc: 'Livestream, Video oder Clip', group: 'Videos, Musik & Bilder' },
    spotify:   { type: 'embed', provider: 'spotify', name: 'Spotify', brand: 'spotify', color: '#1ed760', desc: 'Song, Album oder Playlist', group: 'Videos, Musik & Bilder' },
    image:     { name: 'Bild', icon: 'bx bx-image', color: '#22c55e', desc: 'Ein Foto, optional mit Link', group: 'Videos, Musik & Bilder' },
    gallery:   { name: 'Galerie', icon: 'bx bx-images', color: '#14b8a6', desc: 'Mehrere Bilder zum Wischen', group: 'Videos, Musik & Bilder' },
    heading:   { name: 'Überschrift', icon: 'bx bx-heading', color: '#a1a1aa', desc: 'Gliedert deine Seite', group: 'Text' },
    text:      { name: 'Text', icon: 'bx bx-paragraph', color: '#a1a1aa', desc: 'Absatz mit klickbaren Links', group: 'Text' },
    divider:   { name: 'Trenner', icon: 'bx bx-minus', color: '#71717a', desc: 'Linie, Punkte oder Abstand', group: 'Text' },
    countdown: { name: 'Countdown', icon: 'bx bx-timer', color: '#f59e0b', desc: 'Bis zum nächsten Release', group: 'Aktionen' },
    contact:   { name: 'Kontaktformular', icon: 'bx bx-message-square-dots', color: '#38bdf8', desc: 'Besucher schreiben dir direkt', group: 'Aktionen' },
    booking:   { name: 'Termin buchen', icon: 'bx bx-calendar-check', color: '#a78bfa', desc: 'Eingebauter Kalender oder Calendly', group: 'Aktionen' },
    file:      { name: 'Datei', icon: 'bx bx-download', color: '#fb923c', desc: 'PDF oder Kontaktkarte (.vcf)', group: 'Aktionen' }
  };
  var CLICKABLE = { link: 1, booking: 1, file: 1 };
  var EFFECTS = { none: 'Kein Effekt', shine: 'Glanz', wobble: 'Wackeln', pulse: 'Pulsieren' };
  var DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

  function typeInfo(b) {
    if (b.type === 'embed') {
      var p = b.data.provider || detectEmbed(b.data.url) || 'youtube';
      return TYPES[p] || TYPES.youtube;
    }
    return TYPES[b.type] || TYPES.link;
  }

  function emptySchedule() { return { enabled: false, days: [], from: '', to: '', start: '', end: '' }; }

  function normBlock(b) {
    b.data = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {};
    b.schedule = b.schedule && typeof b.schedule === 'object' ? Object.assign(emptySchedule(), b.schedule) : emptySchedule();
    b.schedule.days = Array.isArray(b.schedule.days) ? b.schedule.days.map(Number) : [];
    if (b.visible === undefined) b.visible = true;
    b.protection = b.protection || 'none';
    b.effect = b.effect || 'none';
    b.password = '';
    return b;
  }

  function defaultData(type, extra) {
    var target = new Date(Date.now() + 7 * 864e5);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var targetStr = target.getFullYear() + '-' + pad(target.getMonth() + 1) + '-' + pad(target.getDate()) + 'T18:00';
    switch (type) {
      case 'link': return { title: '', url: '', subtitle: '', icon: '', thumb: '', featured: false };
      case 'socials': return { items: [{ p: 'instagram', v: '' }, { p: 'tiktok', v: '' }, { p: 'youtube', v: '' }], style: 'icons' };
      case 'heading': return { text: 'Neue Überschrift', size: 'm', align: 'center' };
      case 'text': return { text: '', align: 'center' };
      case 'divider': return { style: 'line' };
      case 'image': return { src: '', alt: '', caption: '', url: '', ratio: 'auto' };
      case 'gallery': return { images: [], ratio: 'square', autoplay: false };
      case 'embed': return { url: '', title: '', provider: (extra && extra.provider) || '' };
      case 'countdown': return { title: 'Neue Single erscheint in', target: targetStr, done_text: 'Jetzt verfügbar!', url: '', url_label: '' };
      case 'contact': return { title: 'Schreib mir', intro: '', button: 'Nachricht senden', success: 'Danke! Deine Nachricht ist angekommen.' };
      case 'booking': return { title: 'Termin buchen', url: '/kalender' };
      case 'file': return { title: 'Datei herunterladen', src: '' };
    }
    return {};
  }

  function newBlock(key, data) {
    var info = TYPES[key];
    var type = info.type || key;
    var b = normBlock({ id: 'n' + (++newCounter), type: type, visible: true, data: Object.assign(defaultData(type, info), data || {}), protection: 'none', effect: 'none', clicks: 0 });
    return b;
  }

  function findBlock(id) {
    for (var i = 0; i < state.blocks.length; i++) if (String(state.blocks[i].id) === String(id)) return state.blocks[i];
    return null;
  }

  // ================================================================
  // Zeitsteuerung (gleiche Logik wie auf dem Server, in der Zeitzone der Seite)
  // ================================================================
  function nowParts() {
    try {
      var f = new Intl.DateTimeFormat('de-DE', { timeZone: E.timezone || 'Europe/Berlin', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      var p = {};
      f.formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
      var wd = { 'Mo': 1, 'Di': 2, 'Mi': 3, 'Do': 4, 'Fr': 5, 'Sa': 6, 'So': 7 }[p.weekday.replace('.', '').slice(0, 2)] || 1;
      return { day: wd, time: p.hour.replace('24', '00') + ':' + p.minute, stamp: p.year + '-' + p.month + '-' + p.day + 'T' + p.hour.replace('24', '00') + ':' + p.minute };
    } catch (e) {
      var d = new Date();
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      return { day: (d.getDay() + 6) % 7 + 1, time: pad(d.getHours()) + ':' + pad(d.getMinutes()), stamp: d.toISOString().slice(0, 16) };
    }
  }
  function scheduleActive(s) {
    if (!s || !s.enabled) return true;
    var n = nowParts();
    if (s.start && n.stamp < s.start) return false;
    if (s.end && n.stamp >= s.end) return false;
    var days = s.days || [];
    var all = !days.length || days.length === 7;
    var dayOk = function (d) { return all || days.indexOf(d) !== -1; };
    if (s.from && s.to) {
      if (s.from <= s.to) return dayOk(n.day) && n.time >= s.from && n.time < s.to;
      if (n.time >= s.from) return dayOk(n.day);
      if (n.time < s.to) return dayOk(n.day === 1 ? 7 : n.day - 1);
      return false;
    }
    if (s.from) return dayOk(n.day) && n.time >= s.from;
    if (s.to) return dayOk(n.day) && n.time < s.to;
    return dayOk(n.day);
  }
  function scheduleText(s) {
    if (!s || !s.enabled) return '';
    var days = (s.days || []).slice().sort();
    var dayTxt;
    if (!days.length || days.length === 7) dayTxt = 'täglich';
    else if (days.join() === '1,2,3,4,5') dayTxt = 'Mo–Fr';
    else if (days.join() === '6,7') dayTxt = 'Sa & So';
    else dayTxt = days.map(function (d) { return DAYS[d - 1]; }).join(', ');
    var time = s.from || s.to ? ' ' + (s.from || '00:00') + '–' + (s.to || '24:00') : '';
    var range = '';
    var fmt = function (v) { return v ? v.slice(8, 10) + '.' + v.slice(5, 7) + '. ' + v.slice(11) : ''; };
    if (s.start) range += ' ab ' + fmt(s.start);
    if (s.end) range += ' bis ' + fmt(s.end);
    return dayTxt + time + range;
  }

  // ================================================================
  // Änderungen, Speichern
  // ================================================================
  function markDirty(opts) {
    dirty = true;
    version++;
    setSaveState('dirty');
    if (!opts || opts.preview !== false) preview.schedule(opts && opts.fast ? 120 : 380);
    if (activeTab === 'design') refreshMinisSoon();
  }

  function setSaveState(s) {
    var btn = $('#saveBtn'), label = $('#saveLabel'), icon = $('#saveIcon');
    if (!btn) return;
    btn.disabled = s === 'saving';
    icon.classList.toggle('hidden', s !== 'saved');
    label.textContent = s === 'saving' ? 'Speichert …' : s === 'saved' ? 'Gespeichert' : 'Speichern';
    btn.classList.toggle('ring-2', s === 'dirty');
    btn.classList.toggle('ring-brand-500', s === 'dirty');
  }

  function payload() {
    return {
      page: {
        id: state.page.id,
        title: state.page.title,
        subtitle: state.page.subtitle,
        bio: state.page.bio,
        avatar: state.page.avatar,
        bg_image: state.page.bg_image,
        theme: state.page.theme,
        layout: state.page.layout,
        settings: state.page.settings
      },
      blocks: state.blocks.map(function (b) {
        return { id: b.id, type: b.type, visible: b.visible, data: b.data, schedule: b.schedule, protection: b.protection, password: b.password, has_password: b.has_password, effect: b.effect };
      })
    };
  }

  function save() {
    if (!state.page || saving) return;
    var missingPw = state.blocks.filter(function (b) { return b.protection === 'password' && !b.has_password && !b.password; });
    if (missingPw.length) {
      openBlocks[missingPw[0].id] = true;
      extrasTab[missingPw[0].id] = 'protect';
      switchTab('inhalte');
      renderBlocks();
      toast('Bitte lege für den geschützten Link ein Passwort fest.', 'err');
      return;
    }
    saving = true;
    var sentVersion = version;
    setSaveState('saving');
    api('save', payload()).then(function (res) {
      saving = false;
      if (!res || !res.ok) {
        setSaveState('dirty');
        toast((res && res.error) || 'Speichern fehlgeschlagen.', 'err');
        return;
      }
      var map = res.idmap || {};
      Object.keys(map).forEach(function (oldId) {
        if (openBlocks[oldId]) { openBlocks[map[oldId]] = true; delete openBlocks[oldId]; }
        if (extrasTab[oldId]) { extrasTab[map[oldId]] = extrasTab[oldId]; delete extrasTab[oldId]; }
      });
      if (version === sentVersion) {
        state.page = res.page;
        state.blocks = res.blocks.map(normBlock);
        dirty = false;
        setSaveState('saved');
      } else {
        // Während des Speicherns weiter bearbeitet: nur IDs übernehmen
        state.blocks.forEach(function (b) {
          if (map[b.id]) b.id = map[b.id];
          if (b.protection === 'password' && b.password) { b.has_password = true; }
        });
        setSaveState('dirty');
      }
      state.blocks.forEach(function (b) { if (b.password) { b.password = ''; b.has_password = true; } });
      updatePageInfo();
      renderBlocks();
      preview.refresh();
      toast('Änderungen gespeichert – deine Seite ist aktuell.');
      (res.warnings || []).forEach(function (w) { toast(w, 'info'); });
    });
  }

  $('#saveBtn').addEventListener('click', save);

  window.addEventListener('beforeunload', function (ev) {
    if (dirty) { ev.preventDefault(); ev.returnValue = ''; }
  });
  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
    if (ev.key === 'Escape') { closeModal(); closeDropdowns(); }
  });

  // ================================================================
  // Live-Vorschau (zwei iframes, damit nichts flackert)
  // ================================================================
  var preview = (function () {
    var frames = [$('#pvA'), $('#pvB')];
    var active = 0;
    var seq = 0;
    var timer = null;
    var lastHtml = '';
    var hover = { theme: null, layout: null };

    function doc() {
      var f = frames[active];
      try { return f && f.contentDocument; } catch (e) { return null; }
    }

    function refresh(opts) {
      opts = opts || {};
      if (!state.page || !frames[0]) return;
      var id = ++seq;
      var live = $('.pv-live');
      if (live) live.classList.add('busy');
      var body = payload();
      body.entrance = opts.entrance ? 'show' : 'skip';
      api('preview', body, true).then(function (html) {
        if (id !== seq || !html) return;
        if (html.charAt(0) === '{') {
          try { var err = JSON.parse(html); toast(err.error || 'Vorschau fehlgeschlagen.', 'err'); } catch (e) { /* egal */ }
          if (live) live.classList.remove('busy');
          return;
        }
        lastHtml = html;
        var cur = frames[active];
        var next = frames[1 - active];
        var scrollY = 0;
        try { scrollY = cur.contentWindow ? cur.contentWindow.scrollY : 0; } catch (e) { /* egal */ }
        next.onload = function () {
          if (id !== seq) return;
          try { if (!opts.top) next.contentWindow.scrollTo(0, scrollY); } catch (e) { /* egal */ }
          next.classList.add('on');
          cur.classList.remove('on');
          active = 1 - active;
          $('#pvLoading').style.display = 'none';
          if (live) live.classList.remove('busy');
          applyHover();
          var big = $('#bigPreviewFrame');
          if (big && !$('#bigPreview').classList.contains('hidden')) big.srcdoc = html;
        };
        next.srcdoc = html;
      });
    }

    var stale = false;
    function visible() { var pane = $('#previewPane'); return pane && pane.offsetParent !== null; }
    function schedule(ms) {
      clearTimeout(timer);
      if (!visible()) { stale = true; return; }
      timer = setTimeout(refresh, ms == null ? 380 : ms);
    }
    function refreshIfStale() { if (stale) { stale = false; refresh(); } }

    // Sofort-Vorschau beim Überfahren: Klassen im aktuellen iframe tauschen
    function applyHover() {
      var d = doc();
      if (!d || !d.body) return;
      var theme = hover.theme || state.page.theme;
      var layout = hover.layout || state.page.layout;
      d.body.className = d.body.className.replace(/\bt-[a-z0-9-]+/, 't-' + theme).replace(/\bl-[a-z0-9-]+/, 'l-' + layout);
      $$('.oys-links', d).forEach(function (g) { g.className = g.className.replace(/\blay-[a-z0-9-]+/, 'lay-' + layout); });
      setGlow(theme);
    }
    function setHover(kind, value) { hover[kind] = value; applyHover(); }

    function patchText(selector, text) {
      var d = doc();
      if (!d) return;
      var el = d.querySelector(selector);
      if (el) el.textContent = text;
    }
    function patchAccent() {
      var d = doc();
      if (!d || !d.body) return;
      if (state.page.settings.accent) d.body.style.setProperty('--accent', state.page.settings.accent);
      else d.body.style.removeProperty('--accent');
      setGlow(state.page.theme);
    }

    return { refresh: refresh, schedule: schedule, refreshIfStale: refreshIfStale, setHover: setHover, patchText: patchText, patchAccent: patchAccent, html: function () { return lastHtml; } };
  })();

  function themeAccent(key) {
    if (state.page && state.page.settings.accent && key === state.page.theme) return state.page.settings.accent;
    return (E.themes[key] || {}).accent || '#6366f1';
  }
  function hexToRgba(hex, a) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return 'rgba(99,102,241,' + a + ')';
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
  }
  function setGlow(themeKey) {
    var c = themeAccent(themeKey);
    $$('.preview-stage').forEach(function (st) {
      st.style.setProperty('--glow', hexToRgba(c, .3));
      st.style.setProperty('--dot', c);
    });
  }

  // Handy auf die verfügbare Höhe skalieren
  function fitPhone() {
    $$('.preview-stage').forEach(function (stage) {
      var phone = $('.phone', stage), wrap = $('.phone-wrap', stage);
      if (!phone || !stage.clientHeight) return;
      var dots = $('.preview-dots', stage);
      var availH = stage.clientHeight - (dots && dots.children.length ? 40 : 18) - 12;
      var availW = stage.clientWidth - 24;
      var s = Math.max(.3, Math.min(1, availH / 864, availW / 410));
      phone.style.transform = 'scale(' + s + ')';
      wrap.style.width = Math.round(410 * s) + 'px';
      wrap.style.height = Math.round(864 * s) + 'px';
    });
  }
  window.addEventListener('resize', debounce(fitPhone, 80));

  // ================================================================
  // Kopfzeile: Seitenwechsler, Glocke, Ansehen-Link
  // ================================================================
  function updatePageInfo() {
    if (!state.page) return;
    var url = state.page.url || '';
    $('#viewPageLink').href = url;
    $('#viewPageLabel').textContent = prettyUrl(url);
    $('#pvOpen').href = url;
    $('#bigPreviewUrl').textContent = prettyUrl(url);
    $('#psLabel').textContent = prettyUrl(url);
    var av = $('#psAvatar');
    av.innerHTML = state.page.avatar ? '<img src="' + esc(uploadUrl(state.page.avatar)) + '" alt="">' : esc(initials(state.page.title || state.page.slug));
    for (var i = 0; i < state.pages.length; i++) {
      if (state.pages[i].id === state.page.id) {
        state.pages[i].slug = state.page.slug;
        state.pages[i].title = state.page.title;
        state.pages[i].url = prettyUrl(url);
        state.pages[i].avatar = state.page.avatar ? uploadUrl(state.page.avatar) : '';
      }
    }
    renderPageDots();
  }

  function renderPageDots() {
    var dots = $('#previewDots');
    if (!dots) return;
    if (state.pages.length < 2) { dots.innerHTML = ''; return; }
    dots.innerHTML = state.pages.map(function (p) {
      return '<button type="button" class="' + (state.page && p.id === state.page.id ? 'on' : '') + '" data-page="' + p.id + '" title="' + esc(p.url) + '"></button>';
    }).join('');
  }

  function goToPage(id) {
    if (state.page && id === state.page.id) return;
    if (dirty && !confirm('Du hast ungespeicherte Änderungen. Trotzdem die Seite wechseln?')) return;
    dirty = false;
    location.href = '/dashboard?page=' + id + location.hash;
  }

  function renderPageMenu() {
    var max = E.maxPages || 3;
    var html = '<div class="dd-head">Deine Seiten <span>' + state.pages.length + ' / ' + max + '</span></div>';
    state.pages.forEach(function (p) {
      var cur = state.page && p.id === state.page.id;
      html += '<button type="button" class="dd-item' + (cur ? ' current' : '') + '" data-page="' + p.id + '">' +
        '<span class="ps-avatar">' + (p.avatar ? '<img src="' + esc(p.avatar) + '" alt="">' : esc(initials(p.title || p.slug))) + '</span>' +
        '<span class="flex-1 min-w-0"><span class="block truncate text-white">' + esc(p.title || p.slug) + '</span><small class="truncate">' + esc(p.url) + '</small></span>' +
        (cur ? '<i class="bx bx-check text-brand-400 text-lg"></i>' : '') + '</button>';
    });
    html += '<div class="dd-sep"></div>';
    if (state.pages.length < max || E.premium) {
      html += '<button type="button" class="dd-item" data-action="new-page"><span class="ps-avatar"><i class="bx bx-plus"></i></span><span>Neue Seite anlegen<small>Eigene Adresse und eigene Statistik</small></span></button>';
    } else {
      html += '<div class="px-3 py-2 text-xs text-gray-500">Maximal ' + max + ' Seiten pro Konto.</div>';
    }
    $('#pageMenu').innerHTML = html;
  }

  function closeDropdowns() { $$('.dropdown').forEach(function (d) { d.classList.add('hidden'); }); }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t.closest('#pageSwitcherBtn')) {
      var menu = $('#pageMenu');
      var wasHidden = menu.classList.contains('hidden');
      closeDropdowns();
      if (wasHidden) { renderPageMenu(); menu.classList.remove('hidden'); }
      return;
    }
    if (t.closest('#bellBtn')) {
      var bm = $('#bellMenu');
      var hid = bm.classList.contains('hidden');
      closeDropdowns();
      if (hid) { bm.classList.remove('hidden'); loadNotifications(true); }
      return;
    }
    var pageBtn = t.closest('[data-page]');
    if (pageBtn) { closeDropdowns(); goToPage(Number(pageBtn.dataset.page)); return; }
    var act = t.closest('[data-action]');
    if (act) { handleAction(act.dataset.action, act); return; }
    if (!t.closest('.dropdown')) closeDropdowns();
  });

  function handleAction(action, el) {
    switch (action) {
      case 'new-page': closeDropdowns(); openNewPageModal(); break;
      case 'add-block': openAddBlockModal(); break;
      case 'quick-add': quickAdd(); break;
      case 'notif-read':
        api('notifications-read', {}).then(function () { loadNotifications(true); });
        break;
      case 'open-messages': closeDropdowns(); switchTab('nachrichten'); break;
    }
  }

  // Glocke
  var lastUnread = -1;
  function loadNotifications(render) {
    apiGet('notifications').then(function (res) {
      if (!res || !res.ok) return;
      var badge = $('#bellBadge');
      badge.hidden = !res.unread;
      badge.textContent = res.unread > 9 ? '9+' : res.unread;
      if (lastUnread >= 0 && res.unread > lastUnread) {
        var bell = $('#bellBtn i');
        bell.classList.remove('bell-ring'); void bell.offsetWidth; bell.classList.add('bell-ring');
        toast('Neue Benachrichtigung: ' + (res.items[0] ? res.items[0].title : ''), 'info');
      }
      lastUnread = res.unread;
      var nb = $('#navMsgBadge');
      nb.hidden = !res.messages_unread;
      nb.textContent = res.messages_unread;
      if (!render) return;
      var html = '<div class="dd-head">Benachrichtigungen' + (res.unread ? '<button type="button" data-action="notif-read">Alle gelesen</button>' : '') + '</div>';
      if (!res.items.length) {
        html += '<div class="empty-state" style="padding:24px 10px"><i class="bx bx-bell-off"></i>Noch nichts Neues.</div>';
      } else {
        html += '<div class="max-h-96 overflow-y-auto custom-scrollbar">' + res.items.map(function (n) {
          var ic = n.type === 'booking' ? 'bx-calendar-check' : n.type === 'message' ? 'bx-envelope' : 'bx-bell';
          return '<button type="button" class="notif w-full text-left' + (n.read ? '' : ' unread') + '" data-action="open-messages"><span class="ni"><i class="bx ' + ic + '"></i></span><span class="min-w-0"><b>' + esc(n.title) + '</b>' + (n.body ? '<p>' + esc(n.body) + '</p>' : '') + '<small>' + esc(n.ago) + '</small></span></button>';
        }).join('') + '</div>';
      }
      $('#bellMenu').innerHTML = html;
    });
  }

  // ================================================================
  // Modal
  // ================================================================
  function openModal(title, bodyHtml, footHtml, onMount) {
    var box = $('#modalBox');
    box.innerHTML = '<div class="modal-head"><h3>' + esc(title) + '</h3><button type="button" class="icon-btn" data-close><i class="bx bx-x"></i></button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' + (footHtml ? '<div class="modal-foot">' + footHtml + '</div>' : '');
    $('#modal').classList.remove('hidden');
    if (onMount) onMount(box);
    var first = $('input, textarea', box);
    if (first) setTimeout(function () { first.focus(); }, 40);
  }
  function closeModal() { $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; }
  $('#modal').addEventListener('click', function (ev) {
    if (ev.target.id === 'modal' || ev.target.closest('[data-close]')) closeModal();
  });

  function openNewPageModal() {
    var max = E.maxPages || 3;
    if (state.pages.length >= max && !E.premium) { toast('Du hast schon ' + max + ' Seiten.', 'err'); return; }
    openModal('Neue Seite anlegen',
      '<p class="text-sm text-gray-400 mb-4">Jede Seite hat ihre eigene Adresse, ihr eigenes Design und ihre eigene Statistik – zum Beispiel eine für dich und eine fürs Projekt.</p>' +
      '<label class="lbl">Adresse</label>' +
      '<div class="input-group"><input class="field" id="npSlug" placeholder="projektname" maxlength="30" autocomplete="off"><span class="addon right">.' + esc(E.baseHost) + '</span></div>' +
      '<p class="hint">2–30 Zeichen: a–z, 0–9 und Bindestrich. Auch erreichbar unter ' + esc(E.baseHost) + '/projektname.</p>' +
      '<label class="lbl mt-4">Name auf der Seite</label><input class="field" id="npTitle" maxlength="120" placeholder="z. B. Mein Projekt">' +
      '<p class="text-sm text-red-400 mt-3 hidden" id="npErr"></p>',
      '<button type="button" class="btn-ghost" data-close>Abbrechen</button><button type="button" class="btn-primary" id="npCreate"><i class="bx bx-plus"></i> Seite anlegen</button>',
      function (box) {
        var slug = $('#npSlug', box);
        slug.addEventListener('input', function () { slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); });
        var go = function () {
          var btn = $('#npCreate', box);
          btn.disabled = true;
          api('page-create', { slug: slug.value, title: $('#npTitle', box).value, page_id: 0 }).then(function (res) {
            btn.disabled = false;
            if (res && res.ok) { dirty = false; location.href = '/dashboard?page=' + res.id; return; }
            var err = $('#npErr', box);
            err.textContent = (res && res.error) || 'Das hat nicht geklappt.';
            err.classList.remove('hidden');
          });
        };
        $('#npCreate', box).addEventListener('click', go);
        slug.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go(); });
      });
  }

  // ================================================================
  // Tabs
  // ================================================================
  var TAB_TITLES = { inhalte: 'Inhalte', design: 'Design', statistik: 'Statistik', nachrichten: 'Nachrichten', einstellungen: 'Einstellungen' };
  function switchTab(name) {
    if (!TAB_TITLES[name]) name = 'inhalte';
    activeTab = name;
    $$('.tab-content').forEach(function (t) { t.classList.add('hidden'); });
    $('#tab-' + name).classList.remove('hidden');
    $$('#mainNav .nav-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    $('#pageTitle').textContent = TAB_TITLES[name];
    if (history.replaceState) history.replaceState(null, '', '#' + name);
    $('#editorScroll').scrollTop = 0;
    if (!state.page) return;
    if (name === 'design') { renderDesign(); }
    if (name === 'statistik') loadStats(statsRange);
    if (name === 'nachrichten') loadMessages();
    if (name === 'einstellungen') renderSettings();
  }
  $$('#mainNav .nav-btn').forEach(function (b) { b.addEventListener('click', function () { switchTab(b.dataset.tab); }); });
  $('#tab-design').addEventListener('click', function (ev) { onDesignClick(ev); });

  // ================================================================
  // Daten-Bindung für Felder (data-bind="page.title")
  // ================================================================
  function bindValue(el, value) {
    if (el.type === 'color') { if (value) el.value = value; return; }
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value == null ? '' : value;
  }
  function readValue(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'range' || el.dataset.num) return Number(el.value);
    return el.value;
  }
  function bindAll(root) {
    $$('[data-bind]', root).forEach(function (el) { bindValue(el, getPath(state, el.dataset.bind)); });
  }
  document.addEventListener('input', onBindInput);
  document.addEventListener('change', onBindInput);
  function onBindInput(ev) {
    var el = ev.target;
    if (!el.dataset || !el.dataset.bind) return;
    var isToggle = el.type === 'checkbox' || el.tagName === 'SELECT';
    if (isToggle !== (ev.type === 'change')) return;
    var path = el.dataset.bind;
    setPath(state, path, readValue(el));
    var fast = false;
    if (path === 'page.title') { preview.patchText('.oys-name', el.value); fast = true; }
    if (path === 'page.subtitle') { preview.patchText('.oys-sub', el.value); }
    if (path === 'page.bio') { preview.patchText('.oys-bio', el.value); updateCounter(el); }
    if (path === 'page.settings.accent') { preview.patchAccent(); $('#accentHex') && ($('#accentHex').value = el.value); }
    if (el.dataset.rerender) renderCurrentTab();
    markDirty({ fast: fast });
    if (path === 'page.title') updatePageInfoSoon();
  }
  var updatePageInfoSoon = debounce(updatePageInfo, 300);
  function updateCounter(el) {
    var c = el.parentNode.querySelector('.counter');
    if (c) c.textContent = el.value.length + ' / ' + (el.maxLength > 0 ? el.maxLength : '');
  }
  function renderCurrentTab() {
    if (activeTab === 'design') renderDesign();
    if (activeTab === 'einstellungen') renderSettings();
  }

  // ================================================================
  // Tab: Inhalte
  // ================================================================
  function renderInhalte() {
    var root = $('#tab-inhalte');
    if (!state.page) { root.innerHTML = ''; return; }
    var p = state.page;
    root.innerHTML =
      '<section>' +
      '<h2 class="section-title">Profil <small>Name, Bild und ein paar Worte über dich</small></h2>' +
      '<div class="panel"><div class="flex flex-col sm:flex-row gap-5 items-start">' +
      '<div class="flex flex-col items-center gap-2"><button type="button" class="avatar-up" id="avatarUp" title="Profilbild hochladen">' +
      (p.avatar ? '<img src="' + esc(uploadUrl(p.avatar)) + '" alt="">' : '<i class="bx bx-camera text-2xl"></i>') +
      '<span class="ov"><i class="bx bx-upload"></i></span></button>' +
      (p.avatar ? '<button type="button" class="text-xs text-gray-500 hover:text-red-400" id="avatarDel">Entfernen</button>' : '<span class="text-[11px] text-gray-500">Profilbild</span>') +
      '</div>' +
      '<div class="flex-1 w-full space-y-4">' +
      '<div class="field-row cols-2"><div><label class="lbl">Name</label><input class="field" data-bind="page.title" maxlength="120" placeholder="Dein Name"></div>' +
      '<div><label class="lbl">Untertitel <small>(optional)</small></label><input class="field" data-bind="page.subtitle" maxlength="160" placeholder="z. B. Musikerin & Streamerin"></div></div>' +
      '<div><label class="lbl">Bio</label><textarea class="field" rows="3" data-bind="page.bio" maxlength="1000" placeholder="Erzähl kurz, was Besucher hier finden."></textarea><div class="counter"></div></div>' +
      '</div></div></div></section>' +

      '<section class="mt-8">' +
      '<h2 class="section-title">Deine Blöcke <button type="button" class="btn-secondary" data-action="add-block"><i class="bx bx-plus"></i> Block hinzufügen</button></h2>' +
      '<div class="quick-add mb-4"><div class="input-group"><span class="addon left"><i class="bx bx-link text-base"></i></span>' +
      '<input class="field" id="quickUrl" placeholder="Link einfügen – z. B. instagram.com/deinname" autocomplete="off"></div>' +
      '<button type="button" class="btn-primary" data-action="quick-add"><i class="bx bx-plus"></i><span class="hidden sm:inline">Link</span></button></div>' +
      '<div class="blocks" id="blockList"></div>' +
      '<button type="button" data-action="add-block" class="w-full mt-3 py-3 rounded-xl border border-dashed border-bordercolor text-gray-500 hover:text-white hover:border-brand-500 transition-colors text-sm font-medium flex items-center justify-center gap-2"><i class="bx bx-plus text-lg"></i> Block hinzufügen</button>' +
      '<p class="hint text-center mt-3"><i class="bx bx-info-circle"></i> Ziehe Blöcke am Griff links, um die Reihenfolge zu ändern. Strg + S speichert.</p>' +
      '</section>';

    bindAll(root);
    var bio = $('[data-bind="page.bio"]', root);
    if (bio) updateCounter(bio);
    $('#avatarUp').addEventListener('click', function () {
      pickFile('image/*').then(function (files) {
        if (!files[0]) return;
        toast('Profilbild wird hochgeladen …', 'info');
        upload('avatar', files[0]).then(function (res) {
          if (!res.ok) { toast(res.error, 'err'); return; }
          state.page.avatar = res.file;
          renderInhalte();
          updatePageInfo();
          markDirty({ fast: true });
        });
      });
    });
    var del = $('#avatarDel');
    if (del) del.addEventListener('click', function () { state.page.avatar = ''; renderInhalte(); updatePageInfo(); markDirty({ fast: true }); });
    $('#quickUrl').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); quickAdd(); } });
    renderBlocks();
  }

  function quickAdd() {
    var input = $('#quickUrl');
    var url = normalizeUrl(input.value);
    if (!url) { input.focus(); return; }
    var embed = detectEmbed(url);
    var b;
    if (embed && /youtube\.com\/watch|youtu\.be\/|twitch\.tv\/(videos|[a-z0-9_]+\/clip)|open\.spotify\.com\/(intl-[a-z-]+\/)?(track|album|playlist|episode|show)/i.test(url) &&
        confirm('Das sieht nach ' + TYPES[embed].name + ' aus. Direkt auf der Seite einbetten? (Abbrechen = als normalen Link anlegen)')) {
      b = newBlock(embed, { url: url, provider: embed });
    } else {
      var br = detectBrand(url);
      var title = br ? brand(br).name : prettyUrl(url).split('/')[0];
      b = newBlock('link', { url: url, title: title });
    }
    state.blocks.push(b);
    input.value = '';
    openBlocks[b.id] = true;
    renderBlocks();
    markDirty({ fast: true });
    scrollToBlock(b.id);
  }

  function scrollToBlock(id) {
    setTimeout(function () {
      var el = $('.blk[data-id="' + id + '"]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  }

  function openAddBlockModal() {
    var groups = {};
    Object.keys(TYPES).forEach(function (k) { (groups[TYPES[k].group] = groups[TYPES[k].group] || []).push(k); });
    var html = Object.keys(groups).map(function (g) {
      return '<div class="add-group">' + esc(g) + '</div><div class="add-grid">' + groups[g].map(function (k) {
        var t = TYPES[k];
        var ic = t.brand ? brandSvg(t.brand) : '<i class="' + t.icon + '"></i>';
        return '<button type="button" class="add-item" data-add="' + k + '" style="--c:' + t.color + '"><span class="ai">' + ic + '</span><span><b>' + esc(t.name) + '</b><small>' + esc(t.desc) + '</small></span></button>';
      }).join('') + '</div>';
    }).join('');
    openModal('Block hinzufügen', html, '', function (box) {
      $('.modal-body', box).addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-add]');
        if (!btn) return;
        var b = newBlock(btn.dataset.add);
        state.blocks.push(b);
        openBlocks[b.id] = true;
        closeModal();
        if (activeTab !== 'inhalte') switchTab('inhalte');
        renderBlocks();
        markDirty({ fast: true });
        scrollToBlock(b.id);
      });
    });
  }

  // ---------- Blockliste ----------
  var sortable = null;
  function renderBlocks() {
    var list = $('#blockList');
    if (!list) return;
    list.innerHTML = '';
    if (!state.blocks.length) {
      list.innerHTML = '<div class="empty-state panel"><i class="bx bx-layer-plus"></i>Noch keine Blöcke. Füge oben einen Link ein oder wähle einen Block.</div>';
    }
    state.blocks.forEach(function (b) { list.appendChild(blockCard(b)); });
    if (window.Sortable && !sortable) {
      sortable = new Sortable(list, {
        handle: '.blk-drag', animation: 160, ghostClass: 'sortable-ghost', chosenClass: 'sortable-chosen',
        onEnd: function () {
          var order = $$('.blk', list).map(function (el) { return el.dataset.id; });
          state.blocks.sort(function (a, b) { return order.indexOf(String(a.id)) - order.indexOf(String(b.id)); });
          markDirty({ fast: true });
        }
      });
    }
  }

  function blockIcon(b) {
    var d = b.data;
    if (b.type === 'link') {
      if (d.thumb) return '<img src="' + esc(uploadUrl(d.thumb)) + '" alt="">';
      if (d.icon && d.icon.indexOf('brand:') === 0) return brandSvg(d.icon.slice(6));
      if (d.icon && d.icon.indexOf('bx') === 0) return '<i class="' + esc(d.icon) + '"></i>';
      var br = detectBrand(d.url);
      if (br) return brandSvg(br);
    }
    var t = typeInfo(b);
    return t.brand ? brandSvg(t.brand) : '<i class="' + t.icon + '"></i>';
  }
  function blockColor(b) {
    if (b.type === 'link') {
      var br = b.data.icon && b.data.icon.indexOf('brand:') === 0 ? b.data.icon.slice(6) : detectBrand(b.data.url);
      if (br && brand(br)) {
        var c = brand(br).color;
        return /^#(000000|181717)$/i.test(c) ? '#e4e4e7' : c;
      }
    }
    return typeInfo(b).color;
  }

  function blockSummary(b) {
    var d = b.data, t = typeInfo(b);
    switch (b.type) {
      case 'link': return [d.title || prettyUrl(d.url) || 'Neuer Link', d.url ? prettyUrl(d.url) : 'Noch keine Adresse – der Link ist erst sichtbar, wenn du eine einträgst'];
      case 'socials':
        var filled = (d.items || []).filter(function (i) { return String(i.v || '').trim(); }).map(function (i) { return (brand(i.p) || {}).name; });
        return ['Social-Icons', filled.length ? filled.join(', ') : 'Noch leer – trag deine Profile ein'];
      case 'heading': return [d.text || 'Überschrift', 'Überschrift'];
      case 'text': return [(d.text || 'Leerer Text').slice(0, 70), 'Text'];
      case 'divider': return ['Trenner', { line: 'Linie', dots: 'Punkte', space: 'Abstand', wave: 'Welle' }[d.style] || ''];
      case 'image': return [d.alt || d.caption || 'Bild', d.src ? 'Bild hochgeladen' + (d.url ? ' · verlinkt' : '') : 'Noch kein Bild'];
      case 'gallery': return ['Galerie', plural((d.images || []).length, 'Bild', 'Bilder')];
      case 'embed': return [d.title || t.name, d.url ? prettyUrl(d.url) : 'Noch keine Adresse'];
      case 'countdown':
        var when = d.target ? d.target.slice(8, 10) + '.' + d.target.slice(5, 7) + '.' + d.target.slice(0, 4) + ' ' + d.target.slice(11) + ' Uhr' : 'Kein Datum';
        return [d.title || 'Countdown', 'Countdown bis ' + when];
      case 'contact': return [d.title || 'Kontaktformular', 'Kontaktformular · Nachrichten landen unter „Nachrichten“'];
      case 'booking': return [d.title || 'Termin buchen', d.url === '/kalender' || !d.url ? 'Eingebauter Terminkalender' : prettyUrl(d.url)];
      case 'file': return [d.title || 'Datei', d.src ? d.src.split('.').pop().toUpperCase() + '-Datei' : 'Noch keine Datei'];
    }
    return [t.name, ''];
  }

  function blockBadges(b) {
    var out = '';
    if (b.schedule && b.schedule.enabled) {
      var on = scheduleActive(b.schedule);
      out += '<span class="bdg amber" title="' + esc(scheduleText(b.schedule)) + '"><i class="bx bx-time-five"></i>' + (on ? 'Zeitplan · an' : 'Zeitplan · aus') + '</span>';
    }
    if (b.protection === 'password') out += '<span class="bdg red"><i class="bx bx-lock-alt"></i>Passwort</span>';
    if (b.protection === 'age') out += '<span class="bdg red">18+</span>';
    if (b.effect && b.effect !== 'none') out += '<span class="bdg brand"><i class="bx bx-star"></i>' + EFFECTS[b.effect] + '</span>';
    if (b.type === 'link' && b.data.featured) out += '<span class="bdg green">Hervorgehoben</span>';
    if (b.clicks > 0) out += '<span class="bdg hidden sm:inline-flex"><i class="bx bx-pointer"></i>' + fmtNum(b.clicks) + '</span>';
    return out;
  }

  function blockCard(b) {
    var sum = blockSummary(b);
    var open = !!openBlocks[b.id];
    var el = h('<div class="blk' + (open ? ' open' : '') + (b.visible ? '' : ' is-hidden') + '" data-id="' + esc(b.id) + '">' +
      '<div class="blk-head">' +
      '<span class="blk-drag" title="Ziehen zum Sortieren"><i class="bx bx-grid-vertical"></i></span>' +
      '<span class="blk-ico" style="--c:' + blockColor(b) + '">' + blockIcon(b) + '</span>' +
      '<div class="blk-main"><b>' + esc(sum[0]) + '</b><span>' + esc(sum[1]) + '</span></div>' +
      '<div class="blk-badges hidden md:flex">' + blockBadges(b) + '</div>' +
      '<button type="button" class="icon-btn" data-blk="visible" title="' + (b.visible ? 'Ausblenden' : 'Einblenden') + '"><i class="bx ' + (b.visible ? 'bx-show' : 'bx-hide') + '"></i></button>' +
      '<button type="button" class="icon-btn" data-blk="toggle" title="Bearbeiten"><i class="bx ' + (open ? 'bx-chevron-up' : 'bx-chevron-down') + '"></i></button>' +
      '</div></div>');
    if (open) el.appendChild(blockBody(b));
    return el;
  }

  function updateHead(b) {
    var el = $('.blk[data-id="' + b.id + '"]');
    if (!el) return;
    var sum = blockSummary(b);
    $('.blk-main b', el).textContent = sum[0];
    $('.blk-main span', el).textContent = sum[1];
    var ico = $('.blk-ico', el);
    ico.innerHTML = blockIcon(b);
    ico.style.setProperty('--c', blockColor(b));
    $('.blk-badges', el).innerHTML = blockBadges(b);
  }

  function rerenderBlock(b) {
    var el = $('.blk[data-id="' + b.id + '"]');
    if (el) el.replaceWith(blockCard(b));
  }

  // ---------- Felder ----------
  function inp(path, label, opts) {
    opts = opts || {};
    var type = opts.type || 'text';
    var attrs = ' data-f="' + path + '"' + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + (opts.max ? ' maxlength="' + opts.max + '"' : '') + (opts.extra || '');
    var field = type === 'textarea'
      ? '<textarea class="field" rows="' + (opts.rows || 3) + '"' + attrs + '></textarea>'
      : '<input class="field" type="' + type + '"' + attrs + (opts.list ? ' list="' + opts.list + '"' : '') + '>';
    return '<div class="' + (opts.cls || '') + '">' + (label ? '<label class="lbl">' + label + '</label>' : '') + field + (opts.hint ? '<p class="hint">' + opts.hint + '</p>' : '') + '</div>';
  }
  function chips(path, options, current) {
    return '<div class="chips">' + Object.keys(options).map(function (k) {
      return '<button type="button" class="chip' + (String(current) === k ? ' on' : '') + '" data-set="' + path + '" data-val="' + esc(k) + '">' + options[k] + '</button>';
    }).join('') + '</div>';
  }
  function sw(path, label, small) {
    return '<label class="switch"><input type="checkbox" data-f="' + path + '"><span class="track"></span><span class="sw-text">' + label + (small ? '<small>' + small + '</small>' : '') + '</span></label>';
  }
  function uploadBox(path, kind, file, label, accept) {
    var isImg = /\.(webp|jpe?g|png|gif)$/i.test(file || '');
    return '<div class="upload-box"><span class="thumb">' + (file ? (isImg ? '<img src="' + esc(uploadUrl(file)) + '" alt="">' : '<i class="bx bx-file"></i>') : '<i class="bx bx-image-add"></i>') + '</span>' +
      '<div class="flex-1 min-w-0"><div class="text-sm text-white truncate">' + (file ? esc(file) : esc(label)) + '</div><div class="text-xs text-gray-500">' + (file ? 'Hochgeladen' : 'Noch nichts ausgewählt') + '</div></div>' +
      '<button type="button" class="btn-secondary" data-up="' + path + '" data-kind="' + kind + '" data-accept="' + esc(accept || 'image/*') + '"><i class="bx bx-upload"></i>' + (file ? 'Ersetzen' : 'Hochladen') + '</button>' +
      (file ? '<button type="button" class="icon-btn danger" data-clear="' + path + '" title="Entfernen"><i class="bx bx-trash"></i></button>' : '') + '</div>';
  }

  function blockBody(b) {
    var d = b.data;
    var html = '';
    switch (b.type) {
      case 'link':
        var br = detectBrand(d.url);
        html += '<div class="field-row cols-2">' + inp('data.title', 'Titel', { placeholder: 'z. B. Mein YouTube-Kanal', max: 120 }) +
          '<div><label class="lbl">Adresse</label><input class="field" data-f="data.url" data-url="1" placeholder="https://…, name@mail.de oder +49 …" value="">' +
          '<div class="detect' + (br ? '' : ' hidden') + '" data-detect>' + (br ? brandSvg(br) + ' ' + esc(brand(br).name) + ' erkannt – passendes Symbol wird verwendet' : '') + '</div></div></div>';
        html += '<div class="field-row cols-2">' + inp('data.subtitle', 'Untertitel <small>(optional)</small>', { placeholder: 'Erscheint bei Karten, Kacheln & Co.', max: 90 }) +
          '<div><label class="lbl">Symbol</label><button type="button" class="btn-secondary w-full justify-between" data-blk="icon"><span class="flex items-center gap-2">' + iconPreview(d.icon, d.url) + '</span><i class="bx bx-chevron-right"></i></button></div></div>';
        html += '<div><label class="lbl">Vorschaubild <small>(optional – schön bei Kacheln, Bento, Karussell, Polaroid, Magazin)</small></label>' + uploadBox('data.thumb', 'thumb', d.thumb, 'Bild für diesen Link') + '</div>';
        html += sw('data.featured', 'Hervorheben', 'Wird größer bzw. in deiner Akzentfarbe angezeigt');
        break;

      case 'socials':
        html += '<div class="mini-list">' + (d.items || []).map(function (it, i) {
          var bb = brand(it.p) || {};
          var ph = it.p === 'email' ? 'deine@mail.de' : it.p === 'whatsapp' ? '+49 170 1234567' : (bb.url && bb.url.indexOf('{u}') !== -1 ? 'Benutzername oder Link' : 'https://…');
          return '<div class="mini-row"><span class="brand-ico" style="color:' + (/^#(000000|181717)$/i.test(bb.color) ? '#e4e4e7' : bb.color) + '">' + brandSvg(it.p) + '</span>' +
            '<select class="field" style="max-width:150px" data-f="data.items.' + i + '.p" data-rerender="1">' + E.brands.map(function (x) { return '<option value="' + x.key + '"' + (x.key === it.p ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select>' +
            '<input class="field" data-f="data.items.' + i + '.v" placeholder="' + esc(ph) + '">' +
            '<button type="button" class="icon-btn danger" data-soc-del="' + i + '" title="Entfernen"><i class="bx bx-x"></i></button></div>';
        }).join('') + '</div>';
        html += '<div class="flex flex-wrap gap-2 items-center justify-between"><button type="button" class="btn-secondary" data-blk="soc-add"><i class="bx bx-plus"></i> Plattform hinzufügen</button>' +
          chips('data.style', { icons: 'Nur Symbole', brand: 'Markenfarben', pills: 'Mit Namen' }, d.style) + '</div>';
        html += '<p class="hint">Instagram, TikTok, YouTube, Twitch, Discord und 22 weitere. Benutzername reicht – der Link wird automatisch gebaut.</p>';
        break;

      case 'heading':
        html += inp('data.text', 'Text', { max: 120 });
        html += '<div class="flex flex-wrap gap-4"><div><label class="lbl">Größe</label>' + chips('data.size', { s: 'Klein', m: 'Mittel', l: 'Groß' }, d.size) + '</div>' +
          '<div><label class="lbl">Ausrichtung</label>' + chips('data.align', { center: 'Mitte', left: 'Links' }, d.align) + '</div></div>';
        break;

      case 'text':
        html += inp('data.text', 'Text', { type: 'textarea', rows: 4, max: 3000, hint: 'Adressen wie https://… werden automatisch klickbar.' });
        html += '<div><label class="lbl">Ausrichtung</label>' + chips('data.align', { center: 'Mitte', left: 'Links' }, d.align) + '</div>';
        break;

      case 'divider':
        html += '<div><label class="lbl">Stil</label>' + chips('data.style', { line: 'Linie', dots: 'Punkte', wave: 'Welle', space: 'Nur Abstand' }, d.style) + '</div>';
        break;

      case 'image':
        html += uploadBox('data.src', 'image', d.src, 'Bild auswählen (JPG, PNG, WebP, GIF)');
        html += '<div class="field-row cols-2">' + inp('data.caption', 'Bildunterschrift <small>(optional)</small>', { max: 150 }) + inp('data.alt', 'Beschreibung für Screenreader', { max: 150 }) + '</div>';
        html += inp('data.url', 'Link beim Antippen <small>(optional)</small>', { placeholder: 'https://…', extra: ' data-url="1"' });
        html += '<div><label class="lbl">Format</label>' + chips('data.ratio', { auto: 'Original', square: 'Quadrat', portrait: 'Hochformat', wide: 'Breitbild' }, d.ratio) + '</div>';
        break;

      case 'gallery':
        html += '<div class="gal-grid">' + (d.images || []).map(function (img, i) {
          return '<div><div class="gal-item"><img src="' + esc(uploadUrl(img.src)) + '" alt=""><button type="button" data-gal-del="' + i + '" title="Entfernen"><i class="bx bx-x"></i></button></div>' +
            '<input class="field mt-1" style="padding:5px 8px;font-size:12px" data-f="data.images.' + i + '.caption" placeholder="Text (optional)"></div>';
        }).join('') + '<button type="button" class="gal-add" data-blk="gal-add"><span><i class="bx bx-image-add text-2xl block"></i>Bilder hinzufügen</span></button></div>';
        html += '<div class="flex flex-wrap gap-4 items-end"><div><label class="lbl">Format</label>' + chips('data.ratio', { square: 'Quadrat', portrait: 'Hochformat', wide: 'Breitbild' }, d.ratio) + '</div>' +
          sw('data.autoplay', 'Automatisch weiterblättern') + '</div>';
        html += '<p class="hint">Bis zu 20 Bilder. Besucher wischen durch – Punkte zeigen, wo sie sind.</p>';
        break;

      case 'embed':
        var prov = TYPES[d.provider] || typeInfo(b);
        var found = detectEmbed(d.url);
        var ph2 = { youtube: 'https://youtube.com/watch?v=…', twitch: 'https://twitch.tv/deinkanal', spotify: 'https://open.spotify.com/track/…' }[d.provider] || 'YouTube-, Twitch- oder Spotify-Adresse';
        html += '<div><label class="lbl">' + esc(prov.name) + '-Adresse</label><input class="field" data-f="data.url" data-url="1" placeholder="' + esc(ph2) + '">' +
          '<div class="detect' + (d.url ? (found ? '' : ' warn') : ' hidden') + '" data-detect-embed>' + (found ? brandSvg(found) + ' ' + TYPES[found].name + ' erkannt' : 'Adresse nicht erkannt – unterstützt: YouTube, Twitch, Spotify') + '</div></div>';
        html += inp('data.title', 'Beschriftung <small>(optional)</small>', { placeholder: 'z. B. Mein neues Video', max: 100 });
        html += '<p class="hint"><i class="bx bx-shield-quarter"></i> Datenschutzfreundlich: Das Video bzw. der Player lädt erst, wenn Besucher darauf tippen – vorher wird nichts an ' + esc(prov.name) + ' übertragen.</p>';
        break;

      case 'countdown':
        html += inp('data.title', 'Überschrift', { placeholder: 'z. B. Neue Single erscheint in', max: 100 });
        html += '<div class="field-row cols-2">' + inp('data.target', 'Datum & Uhrzeit', { type: 'datetime-local' }) + inp('data.done_text', 'Text, wenn die Zeit abgelaufen ist', { max: 100 }) + '</div>';
        html += '<div class="field-row cols-2">' + inp('data.url', 'Link <small>(optional)</small>', { placeholder: 'https://…', extra: ' data-url="1"' }) + inp('data.url_label', 'Link-Text', { placeholder: 'z. B. Jetzt vorspeichern', max: 60 }) + '</div>';
        break;

      case 'contact':
        html += '<div class="field-row cols-2">' + inp('data.title', 'Überschrift', { max: 80 }) + inp('data.button', 'Text auf dem Knopf', { max: 40 }) + '</div>';
        html += inp('data.intro', 'Einleitung <small>(optional)</small>', { type: 'textarea', rows: 2, max: 300 });
        html += inp('data.success', 'Bestätigung nach dem Senden', { max: 150 });
        html += '<p class="hint"><i class="bx bx-shield-quarter"></i> Mit Schutzfilter gegen Spam (unsichtbare Falle, Zeitprüfung, Inhaltsfilter). Neue Nachrichten erscheinen unter <b>Nachrichten</b> und an der Glocke oben.</p>';
        break;

      case 'booking':
        html += '<div class="field-row cols-2">' + inp('data.title', 'Text auf dem Knopf', { max: 80 }) + inp('data.url', 'Adresse', { placeholder: '/kalender', extra: ' data-url="1"' }) + '</div>';
        html += '<p class="hint">Mit <code class="text-brand-400">/kalender</code> nutzt du den eingebauten Terminkalender – Anfragen landen unter <b>Nachrichten</b>. Oder trage z. B. deinen Calendly-Link ein.</p>';
        break;

      case 'file':
        html += uploadBox('data.src', 'file', d.src, 'PDF (Lebenslauf), .vcf (Kontaktkarte) oder .zip', '.pdf,.vcf,.zip');
        html += inp('data.title', 'Text auf dem Knopf', { max: 80, placeholder: 'z. B. Lebenslauf herunterladen' });
        break;
    }

    // Extras: Effekt, Zeitsteuerung, Schutz
    var tabs = [];
    if (CLICKABLE[b.type]) tabs.push(['effect', 'bx-star', 'Effekt' + (b.effect !== 'none' ? ': ' + EFFECTS[b.effect] : '')]);
    tabs.push(['schedule', 'bx-time-five', 'Zeitsteuerung' + (b.schedule.enabled ? ' · an' : '')]);
    if (CLICKABLE[b.type]) tabs.push(['protect', 'bx-lock-alt', b.protection === 'password' ? 'Schutz: Passwort' : b.protection === 'age' ? 'Schutz: 18+' : 'Schutz']);
    var cur = extrasTab[b.id] || '';
    html += '<div class="blk-tabs">' + tabs.map(function (t) {
      return '<button type="button" class="chip' + (cur === t[0] ? ' on' : '') + '" data-extra="' + t[0] + '"><i class="bx ' + t[1] + '"></i>' + esc(t[2]) + '</button>';
    }).join('') + '</div>';
    if (cur === 'effect') html += effectPane(b);
    if (cur === 'schedule') html += schedulePane(b);
    if (cur === 'protect') html += protectPane(b);

    html += '<div class="flex justify-between items-center pt-1"><span class="text-xs text-gray-600">' + (typeof b.id === 'number' ? 'ID ' + b.id + (b.clicks ? ' · ' + plural(b.clicks, 'Klick', 'Klicks') + ' gesamt' : '') : 'Neu – noch nicht gespeichert') + '</span>' +
      '<div class="flex gap-1"><button type="button" class="btn-ghost" data-blk="dup"><i class="bx bx-copy"></i> Duplizieren</button>' +
      '<button type="button" class="btn-ghost hover:!text-red-400" data-blk="del"><i class="bx bx-trash"></i> Löschen</button></div></div>';

    var body = h('<div class="blk-body">' + html + '</div>');
    $$('[data-f]', body).forEach(function (el) { bindValue(el, getPath(b, el.dataset.f)); });
    $$('[data-show-if]', body).forEach(function (el) { el.classList.toggle('hidden', !getPath(b, el.dataset.showIf)); });
    return body;
  }

  function iconPreview(icon, url) {
    if (icon === 'none') return '<i class="bx bx-block text-lg"></i> Kein Symbol';
    if (icon && icon.indexOf('brand:') === 0) { var b = brand(icon.slice(6)); return '<span class="w-5 h-5 inline-block">' + brandSvg(icon.slice(6), 'w-5 h-5') + '</span> ' + esc(b ? b.name : ''); }
    if (icon && icon.indexOf('bx') === 0) return '<i class="' + esc(icon) + ' text-lg"></i> Eigenes Symbol';
    var br = detectBrand(url);
    return br ? '<span class="w-5 h-5 inline-block">' + brandSvg(br, 'w-5 h-5') + '</span> Automatisch (' + esc(brand(br).name) + ')' : '<i class="bx bx-magic-wand text-lg"></i> Automatisch';
  }

  function effectPane(b) {
    return '<div class="blk-pane"><div class="text-xs text-gray-400">Lässt diesen Link auffallen – zum Beispiel deinen wichtigsten.</div>' +
      chips('effect', { none: 'Kein Effekt', shine: '✨ Glanz', wobble: '〰️ Wackeln', pulse: '◎ Pulsieren' }, b.effect) + '</div>';
  }

  function schedulePane(b) {
    var s = b.schedule;
    var active = scheduleActive(s);
    var days = s.days && s.days.length ? s.days : [1, 2, 3, 4, 5, 6, 7];
    return '<div class="blk-pane">' +
      sw('schedule.enabled', 'Zeitsteuerung aktiv', 'Der Block erscheint und verschwindet automatisch') +
      '<div data-show-if="schedule.enabled" class="flex flex-col gap-3">' +
      '<div><label class="lbl">Wochentage</label><div class="day-chips">' + DAYS.map(function (n, i) {
        return '<button type="button" class="day-chip' + (days.indexOf(i + 1) !== -1 ? ' on' : '') + '" data-day="' + (i + 1) + '">' + n + '</button>';
      }).join('') + '</div></div>' +
      '<div class="field-row cols-2">' + inp('schedule.from', 'Von', { type: 'time' }) + inp('schedule.to', 'Bis', { type: 'time' }) + '</div>' +
      '<p class="hint" style="margin-top:-4px">Leer lassen = ganztägig. Über Mitternacht geht auch (z. B. 22:00–02:00).</p>' +
      '<div class="field-row cols-2">' + inp('schedule.start', 'Erst ab <small>(optional)</small>', { type: 'datetime-local' }) + inp('schedule.end', 'Nur bis <small>(optional)</small>', { type: 'datetime-local' }) + '</div>' +
      '<div><label class="lbl">Vorlagen</label><div class="chips">' +
      '<button type="button" class="chip" data-preset="live">„Jetzt live“ Fr 18–23 Uhr</button>' +
      '<button type="button" class="chip" data-preset="weekend">Nur am Wochenende</button>' +
      '<button type="button" class="chip" data-preset="work">Werktags 9–17 Uhr</button></div></div>' +
      '<div class="sched-status ' + (active ? 'on' : 'off') + '" data-sched-status><span class="dot"></span><span>' + (active ? 'Gerade sichtbar' : 'Gerade ausgeblendet') + ' · ' + esc(scheduleText(s)) + ' (' + esc(E.timezone) + ')</span></div>' +
      '</div></div>';
  }

  function protectPane(b) {
    var html = '<div class="blk-pane">' + chips('protection', { none: 'Kein Schutz', password: '🔒 Passwort', age: '🔞 Ab 18' }, b.protection);
    if (b.protection === 'password') {
      html += '<div><label class="lbl">Passwort</label><input class="field" type="text" autocomplete="off" data-f="password" placeholder="' + (b.has_password ? 'Passwort ist gesetzt – neues eingeben zum Ändern' : 'Passwort festlegen') + '" maxlength="100">' +
        '<p class="hint">Besucher müssen das Passwort eingeben, bevor der Link aufgeht. Die Zieladresse steht nicht im Quelltext deiner Seite.</p></div>';
    } else if (b.protection === 'age') {
      html += '<p class="hint" style="margin:0">Besucher bestätigen vorher, dass sie mindestens 18 Jahre alt sind. Die Zieladresse steht nicht im Quelltext deiner Seite.</p>';
    } else {
      html += '<p class="hint" style="margin:0">Schütze einzelne Links mit einem Passwort oder einer „Ab 18“-Abfrage.</p>';
    }
    return html + '</div>';
  }

  // ---------- Ereignisse in der Blockliste ----------
  document.addEventListener('input', onBlockField);
  document.addEventListener('change', onBlockField);
  function onBlockField(ev) {
    var el = ev.target;
    if (!el.dataset || !el.dataset.f) return;
    var card = el.closest('.blk');
    if (!card) return;
    var isToggle = el.type === 'checkbox' || el.tagName === 'SELECT';
    if (isToggle && ev.type !== 'change') return;
    if (!isToggle && ev.type === 'change' && !el.dataset.url) return;
    var b = findBlock(card.dataset.id);
    if (!b) return;
    var path = el.dataset.f;
    var value = readValue(el);
    if (ev.type === 'change' && el.dataset.url) {
      value = normalizeUrl(value);
      el.value = value;
    }
    setPath(b, path, value);
    if (path === 'schedule.enabled' && value && (!b.schedule.days || !b.schedule.days.length)) b.schedule.days = [1, 2, 3, 4, 5, 6, 7];

    if (path === 'data.title' && b.type === 'link') preview.patchText('[data-b="' + b.id + '"] .oys-link-title', value);
    if (path === 'data.url' && b.type === 'link') {
      var det = $('[data-detect]', card);
      var br = detectBrand(value);
      if (det) {
        det.classList.toggle('hidden', !br);
        det.innerHTML = br ? brandSvg(br) + ' ' + esc(brand(br).name) + ' erkannt – passendes Symbol wird verwendet' : '';
      }
    }
    if (path === 'data.url' && b.type === 'embed') {
      var de = $('[data-detect-embed]', card);
      var f = detectEmbed(value);
      if (f) b.data.provider = f;
      if (de) {
        de.classList.toggle('hidden', !value);
        de.classList.toggle('warn', !f);
        de.innerHTML = f ? brandSvg(f) + ' ' + TYPES[f].name + ' erkannt' : 'Adresse nicht erkannt – unterstützt: YouTube, Twitch, Spotify';
      }
    }
    if (el.dataset.rerender || path.indexOf('schedule.') === 0 && el.type === 'checkbox') {
      rerenderBlock(b);
    } else if (path.indexOf('schedule.') === 0) {
      var st = $('[data-sched-status]', card);
      if (st) {
        var on = scheduleActive(b.schedule);
        st.className = 'sched-status ' + (on ? 'on' : 'off');
        st.lastChild.textContent = (on ? 'Gerade sichtbar' : 'Gerade ausgeblendet') + ' · ' + scheduleText(b.schedule) + ' (' + E.timezone + ')';
      }
    }
    updateHead(b);
    markDirty();
  }

  document.addEventListener('click', function (ev) {
    var card = ev.target.closest('.blk');
    if (!card) return;
    var b = findBlock(card.dataset.id);
    if (!b) return;
    var t = ev.target;

    var blkBtn = t.closest('[data-blk]');
    var action = blkBtn ? blkBtn.dataset.blk : null;
    if (!action && t.closest('.blk-head') && !t.closest('.blk-drag')) action = 'toggle';

    if (action === 'toggle') {
      openBlocks[b.id] = !openBlocks[b.id];
      rerenderBlock(b);
      if (openBlocks[b.id]) { var first = $('.blk[data-id="' + b.id + '"] .blk-body input.field'); if (first && !first.value) first.focus(); }
      return;
    }
    if (action === 'visible') { b.visible = !b.visible; rerenderBlock(b); markDirty({ fast: true }); return; }
    if (action === 'del') {
      if (!confirm('Diesen Block wirklich löschen?')) return;
      state.blocks = state.blocks.filter(function (x) { return x !== b; });
      renderBlocks();
      markDirty({ fast: true });
      return;
    }
    if (action === 'dup') {
      var copy = normBlock(clone(b));
      copy.id = 'n' + (++newCounter);
      copy.clicks = 0;
      copy.has_password = false;
      if (copy.protection === 'password') copy.protection = 'none';
      state.blocks.splice(state.blocks.indexOf(b) + 1, 0, copy);
      openBlocks[copy.id] = true;
      renderBlocks();
      markDirty({ fast: true });
      toast('Block dupliziert' + (b.protection === 'password' ? ' – das Passwort musst du neu setzen.' : '.'), 'info');
      return;
    }
    if (action === 'icon') { openIconPicker(b); return; }
    if (action === 'soc-add') { openBrandPicker(b); return; }
    if (action === 'gal-add') {
      pickFile('image/*', true).then(function (files) {
        files = files.slice(0, 20 - (b.data.images || []).length);
        if (!files.length) return;
        toast(plural(files.length, 'Bild wird', 'Bilder werden') + ' hochgeladen …', 'info');
        var chain = Promise.resolve();
        files.forEach(function (f) {
          chain = chain.then(function () {
            return upload('gallery', f).then(function (res) {
              if (!res.ok) { toast(res.error, 'err'); return; }
              b.data.images = b.data.images || [];
              b.data.images.push({ src: res.file, caption: '' });
            });
          });
        });
        chain.then(function () { rerenderBlock(b); updateHead(b); markDirty({ fast: true }); });
      });
      return;
    }

    var galDel = t.closest('[data-gal-del]');
    if (galDel) { b.data.images.splice(Number(galDel.dataset.galDel), 1); rerenderBlock(b); updateHead(b); markDirty({ fast: true }); return; }
    var socDel = t.closest('[data-soc-del]');
    if (socDel) { b.data.items.splice(Number(socDel.dataset.socDel), 1); rerenderBlock(b); updateHead(b); markDirty({ fast: true }); return; }

    var up = t.closest('[data-up]');
    if (up) {
      pickFile(up.dataset.accept || 'image/*').then(function (files) {
        if (!files[0]) return;
        toast('Wird hochgeladen …', 'info');
        upload(up.dataset.kind, files[0]).then(function (res) {
          if (!res.ok) { toast(res.error, 'err'); return; }
          setPath(b, up.dataset.up, res.file);
          rerenderBlock(b); updateHead(b); markDirty({ fast: true });
        });
      });
      return;
    }
    var clr = t.closest('[data-clear]');
    if (clr) { setPath(b, clr.dataset.clear, ''); rerenderBlock(b); updateHead(b); markDirty({ fast: true }); return; }

    var chip = t.closest('[data-set]');
    if (chip) {
      setPath(b, chip.dataset.set, chip.dataset.val);
      rerenderBlock(b); updateHead(b); markDirty({ fast: true });
      return;
    }
    var extra = t.closest('[data-extra]');
    if (extra) { extrasTab[b.id] = extrasTab[b.id] === extra.dataset.extra ? '' : extra.dataset.extra; rerenderBlock(b); return; }
    var day = t.closest('[data-day]');
    if (day) {
      var dn = Number(day.dataset.day);
      var days = b.schedule.days && b.schedule.days.length ? b.schedule.days.slice() : [1, 2, 3, 4, 5, 6, 7];
      var i = days.indexOf(dn);
      if (i === -1) days.push(dn); else days.splice(i, 1);
      b.schedule.days = days.sort();
      rerenderBlock(b); updateHead(b); markDirty();
      return;
    }
    var preset = t.closest('[data-preset]');
    if (preset) {
      var p = { live: { days: [5], from: '18:00', to: '23:00' }, weekend: { days: [6, 7], from: '', to: '' }, work: { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' } }[preset.dataset.preset];
      Object.assign(b.schedule, p, { enabled: true });
      if (preset.dataset.preset === 'live' && b.type === 'link' && !b.data.title) b.data.title = 'Jetzt live';
      rerenderBlock(b); updateHead(b); markDirty();
    }
  });

  // ---------- Symbol-Auswahl ----------
  function openIconPicker(b) {
    var cur = b.data.icon || '';
    var html = '<div class="chips mb-3"><button type="button" class="chip' + (!cur ? ' on' : '') + '" data-icon=""><i class="bx bx-magic-wand"></i> Automatisch</button>' +
      '<button type="button" class="chip' + (cur === 'none' ? ' on' : '') + '" data-icon="none"><i class="bx bx-block"></i> Kein Symbol</button></div>' +
      '<div class="add-group">Marken</div><div class="icon-grid">' + E.brands.map(function (x) {
        return '<button type="button" class="brand' + (cur === 'brand:' + x.key ? ' on' : '') + '" style="--c:' + x.color + '" data-icon="brand:' + x.key + '" title="' + esc(x.name) + '">' + brandSvg(x.key) + '</button>';
      }).join('') + '</div>' +
      '<div class="add-group">Symbole</div><div class="icon-grid">' + E.bxIcons.map(function (ic) {
        return '<button type="button"' + (cur === ic ? ' class="on"' : '') + ' data-icon="' + ic + '"><i class="' + ic + '"></i></button>';
      }).join('') + '</div>';
    openModal('Symbol wählen', html, '', function (box) {
      $('.modal-body', box).addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-icon]');
        if (!btn) return;
        b.data.icon = btn.dataset.icon;
        closeModal();
        rerenderBlock(b); updateHead(b); markDirty({ fast: true });
      });
    });
  }

  function openBrandPicker(b) {
    var used = (b.data.items || []).map(function (i) { return i.p; });
    var html = '<p class="text-sm text-gray-400 mb-3">Tippe auf eine oder mehrere Plattformen.</p><div class="add-grid">' + E.brands.map(function (x) {
      var col = /^#(000000|181717)$/i.test(x.color) ? '#e4e4e7' : x.color;
      return '<button type="button" class="add-item' + (used.indexOf(x.key) !== -1 ? ' opacity-50' : '') + '" data-brand="' + x.key + '" style="--c:' + col + '"><span class="ai">' + brandSvg(x.key) + '</span><span><b>' + esc(x.name) + '</b></span></button>';
    }).join('') + '</div>';
    openModal('Plattform hinzufügen', html, '<button type="button" class="btn-primary" data-close>Fertig</button>', function (box) {
      $('.modal-body', box).addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-brand]');
        if (!btn) return;
        b.data.items = b.data.items || [];
        b.data.items.push({ p: btn.dataset.brand, v: '' });
        btn.classList.add('opacity-50');
        rerenderBlock(b); updateHead(b); markDirty({ fast: true });
      });
    });
  }

  // ================================================================
  // Tab: Design (bessere Theme-Ansicht)
  // ================================================================
  var themeFilter = 'all';
  var refreshMinisSoon = debounce(function () { if (activeTab === 'design') renderThemeGrid(); }, 700);

  function miniLinks() {
    var links = state.blocks.filter(function (b) { return b.type === 'link' && b.visible; }).slice(0, 3).map(function (b) {
      return { title: b.data.title || prettyUrl(b.data.url) || 'Link', brand: b.data.icon && b.data.icon.indexOf('brand:') === 0 ? b.data.icon.slice(6) : detectBrand(b.data.url) };
    });
    var defaults = [{ title: 'Instagram', brand: 'instagram' }, { title: 'Neues Video', brand: 'youtube' }, { title: 'Meine Website', brand: 'website' }];
    while (links.length < 3) links.push(defaults[links.length]);
    return links;
  }

  function miniHTML(key, layout) {
    var p = state.page, s = p.settings;
    var cls = 'oys oys-mini t-' + key + ' l-' + (layout || 'buttons') + (s.font ? ' f-' + s.font : '') + (s.button ? ' btn-' + s.button : '');
    var style = s.accent ? ' style="--accent:' + esc(s.accent) + '"' : '';
    var av = p.avatar ? '<img src="' + esc(uploadUrl(p.avatar)) + '" alt="">' : '<span class="oys-initials">' + esc(initials(p.title || p.slug)) + '</span>';
    var links = miniLinks().map(function (l, i) {
      return '<span class="oys-link" style="--i:' + i + '"><span class="oys-link-media"><span class="oys-link-icon">' + (l.brand ? brandSvg(l.brand, 'oys-ico') : '') + '</span></span><span class="oys-link-body"><span class="oys-link-title">' + esc(l.title) + '</span><span class="oys-link-sub">' + esc(p.slug + '.' + E.baseHost) + '</span></span><span class="oys-link-end"></span></span>';
    }).join('');
    return '<div class="' + cls + '"' + style + '><div class="oys-bg"><span class="oys-deco oys-deco-1"></span><span class="oys-deco oys-deco-2"></span><span class="oys-deco oys-deco-3"></span></div>' +
      '<div class="oys-main"><header class="oys-head"><div class="oys-avatar shape-' + esc(s.avatar_shape) + ' ring-' + esc(s.avatar_ring) + '"><div class="oys-avatar-inner">' + av + '</div></div>' +
      '<h1 class="oys-name">' + esc(p.title || 'Dein Name') + '</h1>' + (p.subtitle ? '<p class="oys-sub">' + esc(p.subtitle) + '</p>' : '') +
      '<p class="oys-bio">' + esc((p.bio || 'Deine Bio steht hier.').slice(0, 90)) + '</p></header>' +
      '<section class="oys-blocks"><div class="oys-links lay-' + (layout || 'buttons') + '">' + links + '</div></section></div></div>';
  }

  function renderDesign() {
    var root = $('#tab-design');
    var p = state.page, s = p.settings;
    var themes = E.themes;
    var counts = { all: 0, standard: 0, special: 0, dark: 0, light: 0 };
    Object.keys(themes).forEach(function (k) {
      counts.all++; counts[themes[k].group]++; counts[themes[k].dark ? 'dark' : 'light']++;
    });
    var filters = { all: 'Alle', standard: 'Standard', special: 'Besondere Vorlagen', dark: 'Dunkel', light: 'Hell' };

    root.innerHTML =
      '<section><h2 class="section-title">Design <small>' + counts.all + ' Designs · Drüberfahren zeigt es sofort in der Vorschau</small></h2>' +
      '<div class="chips mb-4" id="themeFilter">' + Object.keys(filters).map(function (k) {
        return '<button type="button" class="chip' + (themeFilter === k ? ' on' : '') + '" data-filter="' + k + '">' + filters[k] + ' <span class="cnt">' + counts[k] + '</span></button>';
      }).join('') + '</div>' +
      '<div class="theme-grid" id="themeGrid"></div></section>' +

      '<section class="mt-10"><h2 class="section-title">Anordnung <small>13 Arten, deine Links zu zeigen</small></h2><div class="layout-grid" id="layoutGrid"></div></section>' +

      '<section class="mt-10"><h2 class="section-title">Feinschliff <small>Gilt für jedes Design</small></h2><div class="panel space-y-5">' +
      '<div class="field-row cols-2"><div><label class="lbl">Akzentfarbe</label><div class="color-input"><input type="color" data-bind="page.settings.accent" value="' + esc(s.accent || themeAccent(p.theme)) + '">' +
      '<input class="field" id="accentHex" style="max-width:120px" value="' + esc(s.accent) + '" placeholder="Wie im Design" maxlength="7">' +
      '<button type="button" class="btn-ghost" id="accentReset"' + (s.accent ? '' : ' hidden') + '>Zurücksetzen</button></div></div>' +
      '<div><label class="lbl">Schrift</label><select class="field" data-bind="page.settings.font">' + Object.keys(E.fonts).map(function (k) { return '<option value="' + k + '">' + esc(E.fonts[k]) + '</option>'; }).join('') + '</select></div></div>' +
      '<div class="flex flex-wrap gap-6"><div><label class="lbl">Form der Knöpfe</label>' + designChips('button', { '': 'Wie im Design', rounded: 'Abgerundet', pill: 'Pille', square: 'Eckig' }, s.button) + '</div>' +
      '<div><label class="lbl">Form des Profilbilds</label>' + designChips('avatar_shape', { circle: 'Rund', rounded: 'Abgerundet', square: 'Eckig' }, s.avatar_shape) + '</div></div>' +
      '</div></section>' +

      '<section class="mt-10"><h2 class="section-title">Effekte</h2><div class="panel space-y-5">' +
      '<div><label class="lbl">Animierter Ring ums Profilbild</label><div class="chips">' + [['none', 'Kein Ring', 'background:#3f3f46'], ['accent', 'Akzentfarbe', 'background:conic-gradient(' + themeAccent(p.theme) + ',transparent,' + themeAccent(p.theme) + ')'], ['rainbow', 'Regenbogen', 'background:conic-gradient(#ff3b3b,#ffb13b,#f7ff3b,#3bff6e,#3bc8ff,#6b3bff,#ff3bd4,#ff3b3b)'], ['story', 'Story', 'background:conic-gradient(#feda75,#fa7e1e,#d62976,#962fbf,#4f5bd5,#feda75)'], ['pulse', 'Puls', 'background:' + themeAccent(p.theme)]].map(function (r) {
        return '<button type="button" class="chip' + (s.avatar_ring === r[0] ? ' on' : '') + '" data-dset="avatar_ring" data-val="' + r[0] + '"><span class="ring-demo" style="width:18px;height:18px;' + r[2] + '"></span>' + r[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div><label class="lbl">Über der Seite</label>' + designChips('particles', { none: 'Nichts', snow: '❄️ Schnee', confetti: '🎉 Konfetti', fireflies: '✨ Glühwürmchen' }, s.particles) + '</div>' +
      '<label class="switch"><input type="checkbox" data-bind="page.settings.cursor_sparks"><span class="track"></span><span class="sw-text">Funken hinter dem Mauszeiger<small>Kleine Funken in deiner Akzentfarbe folgen der Maus bzw. dem Finger</small></span></label>' +
      '<p class="hint"><i class="bx bx-info-circle"></i> Glanz, Wackeln und Pulsieren für einzelne Links stellst du direkt am Link unter <b>Inhalte → Effekt</b> ein. Besucher mit „Bewegung reduzieren“ sehen keine Animationen.</p>' +
      '</div></section>' +

      '<section class="mt-10"><h2 class="section-title">Hintergrundbild <small>Ersetzt den Hintergrund des Designs</small></h2><div class="panel space-y-4">' +
      '<div class="upload-box"><span class="thumb">' + (p.bg_image ? '<img src="' + esc(uploadUrl(p.bg_image)) + '" alt="">' : '<i class="bx bx-image"></i>') + '</span>' +
      '<div class="flex-1 text-sm text-white">' + (p.bg_image ? 'Hintergrundbild aktiv' : 'Kein Hintergrundbild') + '</div>' +
      '<button type="button" class="btn-secondary" id="bgUp"><i class="bx bx-upload"></i>' + (p.bg_image ? 'Ersetzen' : 'Hochladen') + '</button>' +
      (p.bg_image ? '<button type="button" class="icon-btn danger" id="bgDel"><i class="bx bx-trash"></i></button>' : '') + '</div>' +
      (p.bg_image ? '<div><label class="lbl">Abdunkeln für bessere Lesbarkeit <small id="ovVal">' + s.bg_overlay + ' %</small></label><input type="range" class="range" min="0" max="90" step="5" data-bind="page.settings.bg_overlay"></div>' : '') +
      '</div></section>' +

      '<section class="mt-10"><h2 class="section-title">Eingang mit Musik <small>Besucher tippen zum Betreten</small></h2><div class="panel space-y-5">' +
      '<label class="switch"><input type="checkbox" data-bind="page.settings.entrance.enabled" data-rerender="1"><span class="track"></span><span class="sw-text">Eingang aktivieren<small>Die Seite öffnet sich mit Animation und deine Musik startet</small></span></label>' +
      (s.entrance.enabled ?
        '<div class="field-row cols-2"><div><label class="lbl">Text zum Antippen</label><input class="field" data-bind="page.settings.entrance.text" maxlength="60"></div>' +
        '<div><label class="lbl">Animation</label>' + designChips('entrance.animation', { zoom: 'Zoom', fade: 'Einblenden', curtain: 'Vorhang', blur: 'Unschärfe', flip: 'Kippen' }, s.entrance.animation) + '</div></div>' +
        '<div><label class="lbl">Musik <small>(MP3, M4A, OGG – max. 15 MB)</small></label><div class="upload-box"><span class="thumb"><i class="bx bx-music"></i></span>' +
        '<div class="flex-1 min-w-0"><div class="text-sm text-white truncate">' + (s.entrance.music ? esc(s.entrance.music) : 'Noch keine Musik') + '</div>' +
        (s.entrance.music ? '<audio controls preload="none" src="' + esc(uploadUrl(s.entrance.music)) + '" class="mt-2 w-full" style="height:32px"></audio>' : '<div class="text-xs text-gray-500">Startet, sobald jemand eintritt</div>') + '</div>' +
        '<button type="button" class="btn-secondary" id="musicUp"><i class="bx bx-upload"></i>' + (s.entrance.music ? 'Ersetzen' : 'Hochladen') + '</button>' +
        (s.entrance.music ? '<button type="button" class="icon-btn danger" id="musicDel"><i class="bx bx-trash"></i></button>' : '') + '</div></div>' +
        '<div class="field-row cols-2"><div><label class="lbl">Lautstärke <small id="volVal">' + s.entrance.volume + ' %</small></label><input type="range" class="range" min="5" max="100" step="5" data-bind="page.settings.entrance.volume"></div>' +
        '<div class="flex items-end"><label class="switch"><input type="checkbox" data-bind="page.settings.entrance.loop"><span class="track"></span><span class="sw-text">In Dauerschleife</span></label></div></div>' +
        '<button type="button" class="btn-secondary" id="testEntrance"><i class="bx bx-play-circle"></i> Eingang in der Vorschau testen</button>'
        : '') +
      '</div></section>';

    bindAll(root);
    renderThemeGrid();
    renderLayoutGrid();

    $('#themeFilter').addEventListener('click', function (ev) {
      var c = ev.target.closest('[data-filter]');
      if (!c) return;
      themeFilter = c.dataset.filter;
      $$('#themeFilter .chip').forEach(function (x) { x.classList.toggle('on', x === c); });
      renderThemeGrid();
    });
    var hex = $('#accentHex');
    hex.addEventListener('input', function () {
      var v = hex.value.trim();
      if (v && v[0] !== '#') v = '#' + v;
      if (/^#[0-9a-f]{6}$/i.test(v) || v === '') {
        s.accent = v ? v.toLowerCase() : '';
        $('[data-bind="page.settings.accent"]').value = s.accent || themeAccent(p.theme);
        $('#accentReset').hidden = !s.accent;
        preview.patchAccent();
        markDirty({ fast: true });
      }
    });
    $('#accentReset').addEventListener('click', function () { s.accent = ''; renderDesign(); preview.patchAccent(); markDirty({ fast: true }); });
    $('[data-bind="page.settings.accent"]').addEventListener('input', function () { $('#accentReset').hidden = false; });
    var ov = $('[data-bind="page.settings.bg_overlay"]');
    if (ov) ov.addEventListener('input', function () { $('#ovVal').textContent = ov.value + ' %'; });
    var vol = $('[data-bind="page.settings.entrance.volume"]');
    if (vol) vol.addEventListener('input', function () { $('#volVal').textContent = vol.value + ' %'; });

    $('#bgUp').addEventListener('click', function () {
      pickFile('image/*').then(function (files) {
        if (!files[0]) return;
        toast('Hintergrund wird hochgeladen …', 'info');
        upload('bg', files[0]).then(function (res) {
          if (!res.ok) { toast(res.error, 'err'); return; }
          p.bg_image = res.file; renderDesign(); markDirty({ fast: true });
        });
      });
    });
    var bgDel = $('#bgDel');
    if (bgDel) bgDel.addEventListener('click', function () { p.bg_image = ''; renderDesign(); markDirty({ fast: true }); });
    var musicUp = $('#musicUp');
    if (musicUp) musicUp.addEventListener('click', function () {
      pickFile('audio/mpeg,audio/mp4,audio/ogg,audio/wav,.mp3,.m4a,.ogg,.wav').then(function (files) {
        if (!files[0]) return;
        toast('Musik wird hochgeladen …', 'info');
        upload('music', files[0]).then(function (res) {
          if (!res.ok) { toast(res.error, 'err'); return; }
          s.entrance.music = res.file; renderDesign(); markDirty({ fast: true });
        });
      });
    });
    var musicDel = $('#musicDel');
    if (musicDel) musicDel.addEventListener('click', function () { s.entrance.music = ''; renderDesign(); markDirty({ fast: true }); });
    var test = $('#testEntrance');
    if (test) test.addEventListener('click', function () { preview.refresh({ entrance: true, top: true }); toast('Tippe in der Vorschau auf den Eingang.', 'info'); });
    $('#pvEntrance').hidden = !s.entrance.enabled;
  }

  function designChips(key, options, current) {
    return '<div class="chips">' + Object.keys(options).map(function (k) {
      return '<button type="button" class="chip' + (String(current) === k ? ' on' : '') + '" data-dset="' + key + '" data-val="' + esc(k) + '">' + options[k] + '</button>';
    }).join('') + '</div>';
  }

  function onDesignClick(ev) {
    var t = ev.target;
    var dset = t.closest('[data-dset]');
    if (dset) {
      setPath(state.page.settings, dset.dataset.dset, dset.dataset.val);
      $$('[data-dset="' + dset.dataset.dset + '"]').forEach(function (x) { x.classList.toggle('on', x === dset); });
      if (dset.dataset.dset === 'button' || dset.dataset.dset === 'avatar_shape' || dset.dataset.dset === 'avatar_ring') refreshMinisSoon();
      markDirty({ fast: true });
      return;
    }
    var th = t.closest('[data-theme]');
    if (th) {
      state.page.theme = th.dataset.theme;
      $$('.theme-card').forEach(function (c) { c.classList.toggle('on', c === th); });
      preview.setHover('theme', null);
      markDirty({ fast: true });
      toast('Design „' + E.themes[th.dataset.theme].name + '“ gewählt.', 'info');
      return;
    }
    var lay = t.closest('[data-layout]');
    if (lay) {
      state.page.layout = lay.dataset.layout;
      $$('.layout-card').forEach(function (c) { c.classList.toggle('on', c === lay); });
      preview.setHover('layout', null);
      markDirty({ fast: true });
    }
  }

  function renderThemeGrid() {
    var grid = $('#themeGrid');
    if (!grid) return;
    preview.setHover('theme', null);
    var keys = Object.keys(E.themes).filter(function (k) {
      var t = E.themes[k];
      return themeFilter === 'all' || t.group === themeFilter || (themeFilter === 'dark' && t.dark) || (themeFilter === 'light' && !t.dark);
    });
    grid.innerHTML = keys.map(function (k) {
      var t = E.themes[k];
      var tag = k === 'trs' ? '<span class="theme-tag std">Standard</span>' : t.group === 'special' ? '<span class="theme-tag">Vorlage</span>' : '';
      return '<button type="button" class="theme-card' + (state.page.theme === k ? ' on' : '') + '" data-theme="' + k + '">' +
        '<div class="mini-frame">' + tag + '<span class="theme-check"><i class="bx bx-check"></i></span>' + miniHTML(k, 'buttons') + '</div>' +
        '<div class="theme-meta"><span class="min-w-0"><b>' + esc(t.name) + '</b><small>' + esc(t.desc) + '</small></span><span class="theme-swatch" style="background:' + t.accent + '"></span></div></button>';
    }).join('');
    scaleMinis();
    $$('.theme-card', grid).forEach(function (card) {
      card.addEventListener('mouseenter', function () { preview.setHover('theme', card.dataset.theme); });
      card.addEventListener('mouseleave', function () { preview.setHover('theme', null); });
      card.addEventListener('focus', function () { preview.setHover('theme', card.dataset.theme); });
      card.addEventListener('blur', function () { preview.setHover('theme', null); });
    });
  }

  function scaleMinis() {
    $$('.mini-frame').forEach(function (f) {
      var mini = $('.oys-mini', f);
      if (mini && f.clientWidth) mini.style.setProperty('--s', f.clientWidth / 390);
    });
  }
  if (window.ResizeObserver) {
    new ResizeObserver(debounce(scaleMinis, 50)).observe(document.body);
  }

  var LAYOUT_SVG = {
    buttons: '<rect x="8" y="12" width="44" height="10" rx="5"/><rect x="8" y="27" width="44" height="10" rx="5"/><rect x="8" y="42" width="44" height="10" rx="5"/><rect x="8" y="57" width="44" height="10" rx="5"/>',
    cards: '<rect x="6" y="10" width="48" height="16" rx="4"/><rect x="9" y="13" width="10" height="10" rx="2" class="a"/><rect x="6" y="31" width="48" height="16" rx="4"/><rect x="9" y="34" width="10" height="10" rx="2" class="a"/><rect x="6" y="52" width="48" height="16" rx="4"/><rect x="9" y="55" width="10" height="10" rx="2" class="a"/>',
    tiles: '<rect x="6" y="10" width="22" height="22" rx="4"/><rect x="32" y="10" width="22" height="22" rx="4"/><rect x="6" y="36" width="22" height="22" rx="4"/><rect x="32" y="36" width="22" height="22" rx="4"/><rect x="10" y="14" width="7" height="7" rx="2" class="a"/><rect x="36" y="14" width="7" height="7" rx="2" class="a"/>',
    apps: '<rect x="8" y="12" width="12" height="12" rx="3" class="a"/><rect x="24" y="12" width="12" height="12" rx="3"/><rect x="40" y="12" width="12" height="12" rx="3" class="a"/><rect x="8" y="32" width="12" height="12" rx="3"/><rect x="24" y="32" width="12" height="12" rx="3" class="a"/><rect x="40" y="32" width="12" height="12" rx="3"/><rect x="8" y="52" width="12" height="12" rx="3" class="a"/><rect x="24" y="52" width="12" height="12" rx="3"/>',
    timeline: '<rect x="10" y="10" width="2" height="60" class="a"/><circle cx="11" cy="17" r="3" class="a"/><circle cx="11" cy="37" r="3" class="a"/><circle cx="11" cy="57" r="3" class="a"/><rect x="18" y="11" width="36" height="12" rx="4"/><rect x="18" y="31" width="36" height="12" rx="4"/><rect x="18" y="51" width="36" height="12" rx="4"/>',
    cloud: '<rect x="6" y="14" width="22" height="9" rx="4.5"/><rect x="31" y="14" width="23" height="9" rx="4.5" class="a"/><rect x="10" y="27" width="16" height="9" rx="4.5" class="a"/><rect x="29" y="27" width="22" height="9" rx="4.5"/><rect x="6" y="40" width="26" height="9" rx="4.5"/><rect x="35" y="40" width="17" height="9" rx="4.5"/><rect x="14" y="53" width="30" height="9" rx="4.5" class="a"/>',
    columns: '<rect x="6" y="10" width="22" height="16" rx="4"/><rect x="32" y="10" width="22" height="16" rx="4"/><rect x="6" y="30" width="22" height="16" rx="4"/><rect x="32" y="30" width="22" height="16" rx="4"/><rect x="6" y="50" width="48" height="12" rx="4"/>',
    tree: '<rect x="29" y="8" width="2" height="64" class="a"/><rect x="6" y="14" width="18" height="10" rx="3"/><rect x="24" y="18" width="5" height="2" class="a"/><rect x="36" y="27" width="18" height="10" rx="3"/><rect x="31" y="31" width="5" height="2" class="a"/><rect x="6" y="40" width="18" height="10" rx="3"/><rect x="24" y="44" width="5" height="2" class="a"/><rect x="36" y="53" width="18" height="10" rx="3"/><rect x="31" y="57" width="5" height="2" class="a"/>',
    bento: '<rect x="6" y="8" width="48" height="24" rx="4" class="a"/><rect x="6" y="36" width="22" height="13" rx="4"/><rect x="32" y="36" width="22" height="13" rx="4"/><rect x="6" y="53" width="22" height="20" rx="4"/><rect x="32" y="53" width="22" height="9" rx="3"/><rect x="32" y="65" width="22" height="8" rx="3"/>',
    carousel: '<rect x="6" y="16" width="36" height="42" rx="5"/><rect x="45" y="16" width="14" height="42" rx="5" class="f"/><rect x="10" y="20" width="9" height="9" rx="2" class="a"/><circle cx="24" cy="66" r="2" class="a"/><circle cx="30" cy="66" r="2"/><circle cx="36" cy="66" r="2"/>',
    polaroid: '<g transform="rotate(-6 18 30)"><rect x="6" y="12" width="22" height="28" rx="1"/><rect x="9" y="15" width="16" height="16" class="a"/></g><g transform="rotate(5 42 36)"><rect x="32" y="20" width="22" height="28" rx="1"/><rect x="35" y="23" width="16" height="16" class="a"/></g><g transform="rotate(-3 20 60)"><rect x="9" y="46" width="22" height="26" rx="1"/><rect x="12" y="49" width="16" height="14" class="a"/></g>',
    magazine: '<rect x="6" y="8" width="48" height="26" rx="4" class="a"/><rect x="6" y="38" width="36" height="5" rx="2"/><rect x="6" y="48" width="4" height="6" class="a"/><rect x="13" y="49" width="38" height="4" rx="2"/><rect x="6" y="59" width="4" height="6" class="a"/><rect x="13" y="60" width="32" height="4" rx="2"/>',
    stack: '<rect x="10" y="12" width="40" height="22" rx="4" class="f"/><rect x="8" y="22" width="44" height="22" rx="4"/><rect x="6" y="32" width="48" height="24" rx="4"/><rect x="10" y="36" width="9" height="9" rx="2" class="a"/>'
  };

  function renderLayoutGrid() {
    var grid = $('#layoutGrid');
    if (!grid) return;
    preview.setHover('layout', null);
    grid.innerHTML = Object.keys(E.layouts).map(function (k) {
      var l = E.layouts[k];
      return '<button type="button" class="layout-card' + (state.page.layout === k ? ' on' : '') + '" data-layout="' + k + '">' +
        '<svg viewBox="0 0 60 80" aria-hidden="true"><rect x="1" y="1" width="58" height="78" rx="8" fill="none" stroke="#3f3f46" stroke-width="1.5"/><g fill="#52525b">' + (LAYOUT_SVG[k] || '') + '</g></svg>' +
        '<b>' + esc(l.name) + '</b><small>' + esc(l.desc) + '</small></button>';
    }).join('');
    $$('svg .a', grid).forEach(function (n) { n.setAttribute('fill', '#818cf8'); });
    $$('svg .f', grid).forEach(function (n) { n.setAttribute('fill', '#3f3f46'); });
    $$('.layout-card', grid).forEach(function (card) {
      card.addEventListener('mouseenter', function () { preview.setHover('layout', card.dataset.layout); });
      card.addEventListener('mouseleave', function () { preview.setHover('layout', null); });
    });
  }

  // ================================================================
  // Tab: Statistik
  // ================================================================
  var statsRange = 7;
  function loadStats(range) {
    statsRange = range;
    var root = $('#tab-statistik');
    if (!root.innerHTML) root.innerHTML = '<div class="empty-state"><i class="bx bx-loader-alt bx-spin"></i>Lade Statistik …</div>';
    apiGet('stats?range=' + range).then(function (res) {
      if (!res || !res.ok) { root.innerHTML = '<div class="empty-state">Statistik konnte nicht geladen werden.</div>'; return; }
      renderStats(res.stats);
    });
  }

  function renderStats(st) {
    var root = $('#tab-statistik');
    var ranges = { 7: '7 Tage', 30: '30 Tage', 90: '90 Tage', 0: 'Gesamt' };
    var maxClicks = st.links.reduce(function (m, l) { return Math.max(m, l.clicks); }, 0) || 1;
    var best = st.best;
    root.innerHTML =
      '<div class="flex flex-wrap items-center justify-between gap-3 mb-5"><h2 class="section-title" style="margin:0">Statistik <small>' + esc(prettyUrl(state.page.url)) + '</small></h2>' +
      '<div class="chips">' + [7, 30, 90, 0].map(function (k) { return '<button type="button" class="chip' + (k === st.range ? ' on' : '') + '" data-range="' + k + '">' + ranges[k] + '</button>'; }).join('') + '</div></div>' +
      '<div class="kpis mb-6">' +
      '<div class="kpi" style="--c:#818cf8"><i class="bx bx-show"></i><b>' + fmtNum(st.views) + '</b><span>Aufrufe</span></div>' +
      '<div class="kpi" style="--c:#f59e0b"><i class="bx bx-pointer"></i><b>' + fmtNum(st.clicks) + '</b><span>Klicks</span></div>' +
      '<div class="kpi" style="--c:#22c55e"><i class="bx bx-trending-up"></i><b>' + String(st.ctr).replace('.', ',') + ' %</b><span>Klickrate</span></div>' +
      '<div class="kpi best" style="--c:#ec4899"><i class="bx bx-trophy"></i><b>' + (best ? esc(best.title) : '–') + '</b><span>' + (best ? 'Bester Link · ' + plural(best.clicks, 'Klick', 'Klicks') : 'Bester Link') + '</span></div>' +
      '</div>' +
      '<div class="panel mb-6"><div class="flex items-center justify-between mb-3"><b class="text-white text-sm">Verlauf' + (st.bucket > 1 ? ' (pro Woche)' : '') + '</b><div class="legend"><span><i style="background:#6366f1"></i>Aufrufe</span><span><i style="background:#f59e0b"></i>Klicks</span></div></div>' + chartSvg(st.series) + '</div>' +
      '<h3 class="section-title">Klicks je Link <small>Seit Beginn insgesamt: ' + fmtNum(st.total_views) + ' Aufrufe</small></h3>' +
      '<div class="panel" style="padding:0">' + (st.links.length ? st.links.map(function (l) {
        var ic = l.icon && l.icon.indexOf('brand:') === 0 ? brandSvg(l.icon.slice(6)) : l.icon && l.icon.indexOf('bx') === 0 ? '<i class="' + esc(l.icon) + '"></i>' : (detectBrand(l.url || '') ? brandSvg(detectBrand(l.url)) : '<i class="bx bx-link"></i>');
        return '<div class="stat-row"><div class="t"><span class="stat-ico">' + ic + '</span><span class="min-w-0"><b>' + esc(l.title) + '</b><small>' + esc(l.kind) + (l.url ? ' · ' + esc(prettyUrl(l.url)) : '') + '</small></span></div>' +
          '<div class="n">' + fmtNum(l.clicks) + (l.total != null ? '<small>' + fmtNum(l.total) + ' gesamt</small>' : '') + '</div>' +
          '<div class="bar-bg"><span style="width:' + Math.round(l.clicks / maxClicks * 100) + '%"></span></div></div>';
      }).join('') : '<div class="empty-state"><i class="bx bx-bar-chart-alt-2"></i>Noch keine Links mit Klicks.</div>') + '</div>' +
      '<div class="privacy-note mt-6"><i class="bx bx-shield-quarter"></i><span><b>Statistik ohne Cookies:</b> Gezählt werden nur Aufrufe und Klicks pro Tag – ohne Cookies, ohne IP-Adressen, ohne Fingerabdruck. Deine Besucher brauchen deshalb keinen Cookie-Banner.</span></div>';
    $$('[data-range]', root).forEach(function (c) { c.addEventListener('click', function () { loadStats(Number(c.dataset.range)); }); });
  }

  function chartSvg(series) {
    var W = 700, H = 220, pl = 34, pr = 10, pt = 10, pb = 26;
    var n = series.length || 1;
    var max = Math.max(4, series.reduce(function (m, d) { return Math.max(m, d.views, d.clicks); }, 0));
    var step = Math.pow(10, Math.floor(Math.log10(max)));
    var top = Math.ceil(max / step) * step;
    var bw = (W - pl - pr) / n;
    var y = function (v) { return pt + (H - pt - pb) * (1 - v / top); };
    var svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';
    for (var g = 0; g <= 4; g++) {
      var gv = top / 4 * g, gy = y(gv);
      svg += '<line class="grid" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + gy + '" y2="' + gy + '"/><text x="' + (pl - 6) + '" y="' + (gy + 3) + '" text-anchor="end">' + Math.round(gv) + '</text>';
    }
    var pts = [];
    series.forEach(function (d, i) {
      var x = pl + i * bw;
      var bh = (H - pt - pb) * d.views / top;
      svg += '<rect class="bar" x="' + (x + bw * .18) + '" y="' + (H - pb - bh) + '" width="' + Math.max(1, bw * .64) + '" height="' + Math.max(0, bh) + '" rx="2"><title>' + d.day.split('-').reverse().join('.') + ': ' + d.views + ' Aufrufe, ' + d.clicks + ' Klicks</title></rect>';
      pts.push((x + bw / 2) + ',' + y(d.clicks));
      var every = Math.ceil(n / 8);
      if (i % every === 0 || i === n - 1) svg += '<text x="' + (x + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + d.day.slice(8, 10) + '.' + d.day.slice(5, 7) + '.</text>';
    });
    svg += '<polyline class="line" points="' + pts.join(' ') + '"/>';
    if (n <= 31) pts.forEach(function (p) { var xy = p.split(','); svg += '<circle class="pt" cx="' + xy[0] + '" cy="' + xy[1] + '" r="2.5"/>'; });
    return svg + '</svg>';
  }

  // ================================================================
  // Tab: Nachrichten
  // ================================================================
  function loadMessages() {
    var root = $('#tab-nachrichten');
    if (!root.innerHTML) root.innerHTML = '<div class="empty-state"><i class="bx bx-loader-alt bx-spin"></i>Lade Nachrichten …</div>';
    apiGet('messages').then(function (res) {
      if (!res || !res.ok) { root.innerHTML = '<div class="empty-state">Nachrichten konnten nicht geladen werden.</div>'; return; }
      renderMessages(res);
      loadNotifications(false);
    });
  }

  function renderMessages(res) {
    var root = $('#tab-nachrichten');
    var unread = res.messages.filter(function (m) { return !m.read; }).length;
    var hasContact = state.blocks.some(function (b) { return b.type === 'contact'; });
    root.innerHTML =
      '<h2 class="section-title">Nachrichten <small>' + (unread ? plural(unread, 'ungelesene', 'ungelesene') : 'Alles gelesen') + '</small></h2>' +
      (!hasContact ? '<div class="panel mb-4 flex flex-wrap items-center gap-3 justify-between"><span class="text-sm text-gray-400"><i class="bx bx-info-circle text-brand-400"></i> Füge ein <b class="text-white">Kontaktformular</b> zu deiner Seite hinzu, damit Besucher dir schreiben können.</span><button type="button" class="btn-secondary" id="addContact"><i class="bx bx-plus"></i> Kontaktformular</button></div>' : '') +
      (res.messages.length ? res.messages.map(function (m) {
        return '<div class="msg' + (m.read ? '' : ' unread') + '" data-msg="' + m.id + '"><div class="msg-head"><span class="msg-av">' + esc(initials(m.name)) + '</span>' +
          '<span class="min-w-0"><b>' + esc(m.name) + '</b><small>' + esc(m.email) + ' · ' + esc(m.ago) + (state.pages.length > 1 ? ' · ' + esc(m.page) : '') + '</small></span>' +
          '<span class="msg-actions"><a class="icon-btn" title="Antworten" href="mailto:' + encodeURIComponent(m.email) + '?subject=' + encodeURIComponent('Re: Deine Nachricht') + '"><i class="bx bx-reply"></i></a>' +
          '<button type="button" class="icon-btn" data-msg-act="' + (m.read ? 'unread' : 'read') + '" title="' + (m.read ? 'Als ungelesen markieren' : 'Als gelesen markieren') + '"><i class="bx ' + (m.read ? 'bx-envelope' : 'bx-envelope-open') + '"></i></button>' +
          '<button type="button" class="icon-btn danger" data-msg-act="delete" title="Löschen"><i class="bx bx-trash"></i></button></span></div>' +
          '<div class="msg-text">' + esc(m.message) + '</div></div>';
      }).join('') : '<div class="panel empty-state"><i class="bx bx-envelope"></i>Noch keine Nachrichten.</div>') +

      '<h2 class="section-title mt-10">Termin-Anfragen <small>Über den eingebauten Kalender</small></h2>' +
      (res.bookings.length ? '<div class="panel" style="padding:0">' + res.bookings.map(function (b) {
        return '<div class="stat-row" data-booking="' + b.id + '" style="grid-template-columns:1fr auto"><div class="t"><span class="stat-ico"><i class="bx bx-calendar"></i></span><span class="min-w-0"><b>' + esc(b.date) + ' · ' + esc(b.time) + ' Uhr' + (b.past ? ' <span class="bdg">vorbei</span>' : '') + '</b><small>' + esc(b.name) + ' · <a class="hover:text-white" href="mailto:' + encodeURIComponent(b.email) + '">' + esc(b.email) + '</a></small></span></div>' +
          '<button type="button" class="icon-btn danger" data-booking-del="' + b.id + '" title="Löschen"><i class="bx bx-trash"></i></button></div>';
      }).join('') + '</div>' : '<div class="panel empty-state"><i class="bx bx-calendar-x"></i>Noch keine Termin-Anfragen. Füge einen „Termin buchen“-Block hinzu.</div>');

    var add = $('#addContact');
    if (add) add.addEventListener('click', function () {
      var b = newBlock('contact');
      state.blocks.push(b);
      openBlocks[b.id] = true;
      switchTab('inhalte');
      renderBlocks();
      markDirty({ fast: true });
      scrollToBlock(b.id);
    });
    $$('[data-msg-act]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.closest('[data-msg]').dataset.msg);
        var act = btn.dataset.msgAct;
        if (act === 'delete' && !confirm('Nachricht löschen?')) return;
        api('message', { id: id, action: act }).then(function () { loadMessages(); });
      });
    });
    $$('[data-booking-del]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('Termin-Anfrage löschen?')) return;
        api('booking-delete', { id: Number(btn.dataset.bookingDel) }).then(function () { loadMessages(); });
      });
    });
  }

  // ================================================================
  // Tab: Einstellungen
  // ================================================================
  function renderSettings() {
    var root = $('#settingsDynamic');
    var p = state.page, s = p.settings;
    var urls = p.urls || {};
    var max = E.maxPages || 3;
    root.innerHTML =
      '<section class="max-w-3xl mx-auto"><h2 class="section-title">Adresse <small>Zwei Adressen – du wählst, die andere leitet weiter</small></h2><div class="panel space-y-5">' +
      '<div><label class="lbl">Dein Name in der Adresse</label><div class="input-group"><input class="field" id="slugInput" value="' + esc(p.slug) + '" maxlength="30" autocomplete="off"' + (E.slugDaysLeft > 0 ? ' readonly' : '') + '></div>' +
      (E.slugDaysLeft > 0 ? '<p class="hint text-red-400"><i class="bx bx-lock-alt"></i> Du kannst deine Adresse in ' + E.slugDaysLeft + ' Tagen wieder ändern.</p>' : '<p class="hint">Änderbar alle 30 Tage. Erlaubt: a–z, 0–9 und Bindestrich.</p>') + '</div>' +
      '<div class="mode-cards">' +
      modeCard('subdomain', p.slug + '.' + E.baseHost, p.address_mode === 'subdomain') +
      modeCard('path', E.baseHost + '/' + p.slug, p.address_mode === 'path') +
      '</div><div class="flex justify-end"><button type="button" class="btn-primary" id="saveAddress"><i class="bx bx-check"></i> Adresse speichern</button></div></div></section>' +

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Deine Seiten <small>' + state.pages.length + ' von ' + max + ' · jede mit eigener Adresse & Statistik</small></h2><div class="panel">' +
      state.pages.map(function (pg) {
        var cur = pg.id === p.id;
        return '<div class="page-row' + (cur ? ' current' : '') + '"><span class="ps-avatar" style="width:36px;height:36px">' + (pg.avatar ? '<img src="' + esc(pg.avatar) + '" alt="">' : esc(initials(pg.title || pg.slug))) + '</span>' +
          '<span class="flex-1 min-w-0"><b class="truncate">' + esc(pg.title || pg.slug) + (cur ? ' <span class="bdg brand">Wird bearbeitet</span>' : '') + '</b><small>' + esc(pg.url) + '</small></span>' +
          (cur ? '' : '<button type="button" class="btn-secondary" data-page="' + pg.id + '">Bearbeiten</button>') +
          (state.pages.length > 1 ? '<button type="button" class="icon-btn danger" data-del-page="' + pg.id + '" data-slug="' + esc(pg.slug) + '" title="Seite löschen"><i class="bx bx-trash"></i></button>' : '') + '</div>';
      }).join('') +
      (state.pages.length < max || E.premium ? '<button type="button" class="btn-secondary mt-3" data-action="new-page"><i class="bx bx-plus"></i> Neue Seite anlegen</button>' : '') + '</div></section>' +

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Suchmaschinen (SEO) <small>Wird beim Speichern übernommen</small></h2><div class="panel space-y-4">' +
      '<div><label class="lbl">Titel</label><input class="field" data-bind="page.settings.seo.title" maxlength="120" placeholder="Standard: ' + esc((p.title || p.slug) + ' | OnYourSite') + '"></div>' +
      '<div><label class="lbl">Beschreibung</label><textarea class="field" rows="2" data-bind="page.settings.seo.description" maxlength="300" placeholder="Standard: deine Bio"></textarea></div>' +
      '<div><label class="lbl">Schlüsselwörter</label><input class="field" data-bind="page.settings.seo.keywords" maxlength="255" placeholder="durch, Komma, getrennt"></div></div></section>' +

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Benachrichtigungen</h2><div class="panel space-y-5">' +
      '<label class="switch"><input type="checkbox" data-bind="page.settings.notify_email"><span class="track"></span><span class="sw-text">E-Mail bei neuer Nachricht<small>Zusätzlich zum Hinweis an der Glocke (gilt für diese Seite, wird beim Speichern übernommen)</small></span></label>' +
      '<div class="flex flex-wrap items-center justify-between gap-3"><label class="switch"><input type="checkbox" id="weeklyToggle"' + (E.user.weekly ? ' checked' : '') + '><span class="track"></span><span class="sw-text">Wochenbericht per Mail<small>Jeden Montag: Aufrufe, Klicks und dein bester Link – für alle deine Seiten</small></span></label>' +
      '<button type="button" class="btn-secondary" id="weeklyTest"><i class="bx bx-send"></i> Testbericht senden</button></div></div></section>' +

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Branding & eigenes CSS</h2><div class="panel space-y-5">' +
      '<div class="flex items-center justify-between gap-4"><div><div class="text-sm text-white font-medium flex items-center gap-2">„Erstellt mit OnYourSite“ ausblenden ' + (E.premium ? '' : '<span class="premium-pill"><i class="bx bxs-lock"></i> Premium</span>') + '</div><p class="hint" style="margin-top:2px">Entfernt den Hinweis unten auf deiner Seite.</p></div>' +
      '<label class="switch"><input type="checkbox" data-bind="page.settings.hide_branding"' + (E.premium ? '' : ' disabled') + '><span class="track"></span></label></div>' +
      '<div><label class="lbl">Eigenes CSS <small>(für Profis)</small></label><textarea class="field css-editor" rows="6" data-bind="page.settings.custom_css" placeholder="/* z. B. .oys-name { letter-spacing: .1em; } */"></textarea>' +
      '<p class="hint">Alle Elemente haben Klassen wie <code>.oys-name</code>, <code>.oys-link</code>, <code>.oys-socials</code>.</p></div></div></section>' +

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Integrationen</h2><div class="panel space-y-3">' +
      '<label class="lbl flex items-center gap-2">Discord-ID <span class="text-[10px] text-[#5865F2] bg-[#5865F2]/10 px-1.5 rounded">Auto-Rolle</span></label>' +
      '<div class="flex gap-2"><div class="input-group flex-1"><span class="addon left" style="color:#5865F2"><i class="bx bxl-discord-alt text-lg"></i></span><input class="field" id="discordId" value="' + esc(E.user.discord) + '" placeholder="1234567890" inputmode="numeric"></div>' +
      '<button type="button" class="btn-secondary" id="saveDiscord">Speichern</button></div>' +
      '<p class="hint">Verknüpfe deine Discord-ID, um auf unserem Server automatisch die Kunden-Rolle zu bekommen.</p></div></section>';

    bindAll(root);
    var slug = $('#slugInput');
    slug.addEventListener('input', function () {
      slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
      $$('[data-mode-url="subdomain"]').forEach(function (x) { x.textContent = (slug.value || '…') + '.' + E.baseHost; });
      $$('[data-mode-url="path"]').forEach(function (x) { x.textContent = E.baseHost + '/' + (slug.value || '…'); });
    });
    var mode = p.address_mode;
    $$('.mode-card', root).forEach(function (c) {
      c.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); c.click(); } });
      c.addEventListener('click', function () {
        mode = c.dataset.mode;
        $$('.mode-card', root).forEach(function (x) { x.classList.toggle('on', x === c); });
        $$('.mode-card [data-badge]', root).forEach(function (x) { x.textContent = x.closest('.mode-card') === c ? 'Hauptadresse' : 'leitet weiter'; });
      });
    });
    $('#saveAddress').addEventListener('click', function () {
      api('address', { slug: slug.value, mode: mode }).then(function (res) {
        if (!res || !res.ok) { toast((res && res.error) || 'Fehler', 'err'); return; }
        var changed = res.page.slug !== state.page.slug;
        state.page.slug = res.page.slug;
        state.page.address_mode = res.page.address_mode;
        state.page.urls = res.page.urls;
        state.page.url = res.page.url;
        if (changed) E.slugDaysLeft = E.premium ? 0 : 30;
        updatePageInfo();
        renderSettings();
        toast('Adresse gespeichert: ' + prettyUrl(res.page.url));
      });
    });
    $$('[data-del-page]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var s2 = btn.dataset.slug;
        var typed = prompt('Seite „' + s2 + '“ mit allen Blöcken, Statistiken und Nachrichten löschen?\nTippe zur Bestätigung die Adresse ein: ' + s2);
        if (typed === null) return;
        api('page-delete', { id: Number(btn.dataset.delPage), confirm: typed.trim() }).then(function (res) {
          if (!res || !res.ok) { toast((res && res.error) || 'Fehler', 'err'); return; }
          dirty = false;
          location.href = '/dashboard#einstellungen';
        });
      });
    });
    $('#weeklyToggle').addEventListener('change', function (ev) {
      var on = ev.target.checked;
      api('weekly', { enabled: on }).then(function (res) {
        if (res && res.ok) { E.user.weekly = on; toast(on ? 'Wochenbericht aktiviert – jeden Montag in deinem Postfach.' : 'Wochenbericht deaktiviert.'); }
        else toast('Fehler beim Speichern.', 'err');
      });
    });
    $('#weeklyTest').addEventListener('click', function (ev) {
      var btn = ev.currentTarget;
      btn.disabled = true;
      api('weekly-test', {}).then(function (res) {
        btn.disabled = false;
        if (res && res.ok) toast('Testbericht an ' + E.user.email + ' gesendet.');
        else toast((res && res.error) || 'Senden fehlgeschlagen.', 'err');
      });
    });
    $('#saveDiscord').addEventListener('click', function () {
      api('discord', { discord_id: $('#discordId').value }).then(function (res) {
        if (res && res.ok) { E.user.discord = $('#discordId').value.replace(/\D/g, ''); toast('Discord-ID gespeichert.'); }
        else toast('Fehler beim Speichern.', 'err');
      });
    });
  }

  function modeCard(mode, url, on) {
    var other = mode === 'subdomain' ? 'Unterdomain' : 'Pfad';
    return '<div class="mode-card' + (on ? ' on' : '') + '" data-mode="' + mode + '" role="button" tabindex="0">' +
      '<div class="flex items-center justify-between mb-1"><small>' + other + '</small><span class="bdg ' + (on ? 'green' : '') + '" data-badge>' + (on ? 'Hauptadresse' : 'leitet weiter') + '</span></div>' +
      '<b data-mode-url="' + mode + '">' + esc(url) + '</b></div>';
  }

  // ================================================================
  // Vorschau-Steuerung
  // ================================================================
  $('#pvReload').addEventListener('click', function () { preview.refresh(); });
  $('#pvEntrance').addEventListener('click', function () { preview.refresh({ entrance: true, top: true }); });
  $('#pvBig').addEventListener('click', function () {
    $('#bigPreview').classList.remove('hidden');
    $('#bigPreviewFrame').srcdoc = preview.html();
  });
  $('#bigPreviewClose').addEventListener('click', function () { $('#bigPreview').classList.add('hidden'); $('#bigPreviewFrame').srcdoc = ''; });
  $('#bigPreview').addEventListener('click', function (ev) { if (ev.target.id === 'bigPreview') $('#bigPreviewClose').click(); });

  // Auf kleinen Bildschirmen: Vorschau als Vollbild
  var pane = $('#previewPane');
  var paneHome = pane ? pane.parentNode : null;
  $('#mobilePreviewBtn').addEventListener('click', function () {
    $('#mobilePreviewHolder').appendChild(pane);
    $('#mobilePreview').classList.remove('hidden');
    setTimeout(function () { fitPhone(); preview.refreshIfStale(); }, 30);
  });
  $('#mobilePreviewClose').addEventListener('click', function () {
    $('#mobilePreview').classList.add('hidden');
    paneHome.appendChild(pane);
  });

  // ================================================================
  // Start
  // ================================================================
  if (window.OYS_FLASH) {
    if (window.OYS_FLASH.success) toast(window.OYS_FLASH.success);
    if (window.OYS_FLASH.error) toast(window.OYS_FLASH.error, 'err');
  }

  if (state.page) {
    updatePageInfo();
    setGlow(state.page.theme);
    renderInhalte();
    var initial = (location.hash || '#inhalte').slice(1);
    switchTab(TAB_TITLES[initial] ? initial : 'inhalte');
    fitPhone();
    preview.refresh();
    $('#pvEntrance').hidden = !state.page.settings.entrance.enabled;
    loadNotifications(false);
    setInterval(function () { if (!document.hidden) loadNotifications(!$('#bellMenu').classList.contains('hidden')); }, 60000);
  } else {
    $('#saveBtn').disabled = true;
    $('#mobilePreviewBtn').classList.add('hidden');
    $('#viewPageLink').classList.add('hidden');
    $('#psLabel').textContent = 'Noch keine Seite';
  }
})();
