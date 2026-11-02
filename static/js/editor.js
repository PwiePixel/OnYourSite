/* OnYourSite – Editor
   Zustand im Browser, Live-Vorschau über den echten Seiten-Renderer (1:1 wie die öffentliche Seite).
   Dialoge, Hinweise und die Wache gegen das Verlassen kommen aus static/js/ui.js (window.OYSUI, Vertrag ui.d.ts). */
(function () {
  'use strict';

  // Ohne die Dialog-Bibliothek wird nicht bearbeitet: ein Hinweis in der Seite statt halber Funktionen
  var UI = window.OYSUI;
  if (!UI) { editorUnavailable(); return; }

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
  var activeTab = 'content';
  // Umbenennungen beim Speichern (alte ID → neue ID): Dialoge suchen ihren Block danach wieder über die ID
  var renamed = {};

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
  function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }
  function fmtDate(v, year) { var p = String(v || '').split(/\D/); return new Date(+p[0], p[1] - 1, +p[2]).toLocaleDateString('en-US', year ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' }); }
  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).slice(0, 2);
    var s = parts.map(function (p) { return p.charAt(0).toUpperCase(); }).join('');
    return s || '?';
  }
  function uploadUrl(f) { return f ? '/static/uploads/' + encodeURIComponent(f) : ''; }

  // Hinweise zeichnet ui.js (Warteschlange, Schließen, Live-Region) – die Aufrufe im Editor bleiben, wie sie sind
  function toast(msg, type) { return UI.toast(msg, type); }

  // Eine Anfrage für alles (JSON, Formular mit Datei, HTML der Vorschau): CSRF-Kopf, Antwort über UI.handle()
  // (Sitzungsdialog bei 401/419/409 mit reload, notices), ohne Verbindung ein Fehlertext statt einer Ausnahme.
  // o.json: Daten (POST als JSON) · o.form: FormData (POST) · o.text: HTML erwartet (Fehler kommen trotzdem als JSON)
  function request(url, o) {
    o = o || {};
    var opts = { credentials: 'same-origin', headers: { 'X-CSRF-Token': E.csrf } };
    if (o.json !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(o.json);
    } else if (o.form) {
      opts.method = 'POST';
      opts.body = o.form;
    }
    return fetch(url, opts).then(function (r) {
      var isJson = /application\/json/i.test(r.headers.get('Content-Type') || '');
      if (o.text && !isJson) return r.text();
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!data || typeof data !== 'object') data = { ok: false, error: 'Unexpected response from the server.' };
        return UI.handle(r.status, data);
      });
    }, function () {
      return o.text ? '' : { ok: false, error: o.offline || 'No connection to the server.' };
    });
  }

  function api(action, body, asText) {
    var url = '/dashboard/api/' + action, json;
    if (body !== undefined) {
      if (state.page && body && typeof body === 'object' && !body.page && body.page_id === undefined) body.page_id = state.page.id;
      json = body;
    } else if (state.page) {
      url += (url.indexOf('?') === -1 ? '?' : '&') + 'page=' + state.page.id;
    }
    return request(url, { json: json, text: !!asText });
  }
  function apiGet(action) { return api(action); }

  // Große Fotos schon im Browser verkleinern (viele Server erlauben nur 2 MB pro Datei)
  var PW_MIN = 6; // Mindestlänge für Link-Passwörter (wie OYS_LINK_PASSWORD_MIN)
  var MAX_PX = { avatar: 900, bg: 2200, image: 1800, gallery: 1800, thumb: 1000 };
  var EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
  function shrinkImage(kind, file) {
    if (!MAX_PX[kind] || !EXT[file.type] || !window.createImageBitmap) return Promise.resolve(file);
    return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
      var scale = Math.min(1, MAX_PX[kind] / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 1.5 * 1048576) return file;
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      // Fotos als JPEG (kann jeder Browser), sonst WebP – Safari liefert dafür PNG, das Transparenz behält
      var type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
      return new Promise(function (resolve) {
        c.toBlob(function (blob) {
          if (!blob || !EXT[blob.type] || blob.size >= file.size) { resolve(file); return; }
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, '') + '.' + EXT[blob.type], { type: blob.type }));
        }, type, .9);
      });
    }).catch(function () { return file; });
  }

  function upload(kind, file) {
    return shrinkImage(kind, file).then(function (f) {
      var limit = E.uploadLimitMb || 0;
      if (limit && f.size > limit * 1048576) {
        return { ok: false, error: 'The file is ' + (f.size / 1048576).toFixed(1) + ' MB – the server only allows ' + String(limit) + ' MB (raise “upload_max_filesize” in Plesk under PHP Settings).' };
      }
      return uploadRaw(kind, f);
    });
  }

  function uploadRaw(kind, file) {
    var fd = new FormData();
    fd.append('kind', kind);
    fd.append('file', file);
    if (state.page) fd.append('page_id', state.page.id);
    return request('/dashboard/api/upload', { form: fd, offline: 'Upload failed (connection error).' });
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
    link:      { name: 'Link', icon: 'bx bx-link', color: '#818cf8', desc: 'Any link with a matching icon', group: 'Links & social' },
    socials:   { name: 'Social icons', icon: 'bx bx-share-alt', color: '#ec4899', desc: 'Instagram, TikTok, YouTube & more', group: 'Links & social' },
    youtube:   { type: 'embed', provider: 'youtube', name: 'YouTube', brand: 'youtube', color: '#ff0033', desc: 'Video right on your page', group: 'Videos, music & images' },
    twitch:    { type: 'embed', provider: 'twitch', name: 'Twitch', brand: 'twitch', color: '#9146ff', desc: 'Livestream, video or clip', group: 'Videos, music & images' },
    spotify:   { type: 'embed', provider: 'spotify', name: 'Spotify', brand: 'spotify', color: '#1ed760', desc: 'Song, album or playlist', group: 'Videos, music & images' },
    image:     { name: 'Image', icon: 'bx bx-image', color: '#22c55e', desc: 'A photo, optionally with a link', group: 'Videos, music & images' },
    gallery:   { name: 'Gallery', icon: 'bx bx-images', color: '#14b8a6', desc: 'Several images to swipe through', group: 'Videos, music & images' },
    heading:   { name: 'Heading', icon: 'bx bx-heading', color: '#a1a1aa', desc: 'Structures your page', group: 'Text' },
    text:      { name: 'Text', icon: 'bx bx-paragraph', color: '#a1a1aa', desc: 'Paragraph with clickable links', group: 'Text' },
    divider:   { name: 'Divider', icon: 'bx bx-minus', color: '#71717a', desc: 'Line, dots or spacing', group: 'Text' },
    countdown: { name: 'Countdown', icon: 'bx bx-timer', color: '#f59e0b', desc: 'Until your next release', group: 'Actions' },
    contact:   { name: 'Contact form', icon: 'bx bx-message-square-dots', color: '#38bdf8', desc: 'Visitors message you directly', group: 'Actions' },
    booking:   { name: 'Book a meeting', icon: 'bx bx-calendar-check', color: '#a78bfa', desc: 'Built-in calendar or Calendly', group: 'Actions' },
    file:      { name: 'File', icon: 'bx bx-download', color: '#fb923c', desc: 'PDF or contact card (.vcf)', group: 'Actions' }
  };
  var CLICKABLE = { link: 1, booking: 1, file: 1 };
  var EFFECTS = { none: 'No effect', shine: 'Shine', wobble: 'Wobble', pulse: 'Pulse' };
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
      case 'heading': return { text: 'New heading', size: 'm', align: 'center' };
      case 'text': return { text: '', align: 'center' };
      case 'divider': return { style: 'line' };
      case 'image': return { src: '', alt: '', caption: '', url: '', ratio: 'auto' };
      case 'gallery': return { images: [], ratio: 'square', autoplay: false };
      case 'embed': return { url: '', title: '', provider: (extra && extra.provider) || '' };
      case 'countdown': return { title: 'New single drops in', target: targetStr, done_text: 'Out now!', url: '', url_label: '' };
      case 'contact': return { title: 'Message me', intro: '', button: 'Send message', success: 'Thanks! Your message has been sent.' };
      case 'booking': return { title: 'Book a meeting', url: '/kalender' };
      case 'file': return { title: 'Download file', src: '' };
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
    if (!days.length || days.length === 7) dayTxt = 'daily';
    else if (days.join() === '1,2,3,4,5') dayTxt = 'Mon–Fri';
    else if (days.join() === '6,7') dayTxt = 'Sat & Sun';
    else dayTxt = days.map(function (d) { return DAYS[d - 1]; }).join(', ');
    var time = s.from || s.to ? ' ' + (s.from || '00:00') + '–' + (s.to || '24:00') : '';
    var range = '';
    var fmt = function (v) { return v ? fmtDate(v) + ', ' + v.slice(11) : ''; };
    if (s.start) range += ' from ' + fmt(s.start);
    if (s.end) range += ' until ' + fmt(s.end);
    return dayTxt + time + range;
  }

  // ================================================================
  // Änderungen, Speichern
  // ================================================================
  function markDirty(opts) {
    dirty = true;
    version++;
    setSaveState('dirty');
    draft.later();
    if (!opts || opts.preview !== false) preview.schedule(opts && opts.fast ? 120 : 380);
    if (activeTab === 'design') refreshMinisSoon();
  }

  // Der Speichern-Knopf oben speichert die Seite – im Tab „Code page“ die Code-Seite
  var pageSaveState = '';
  function setSaveState(s) {
    pageSaveState = s;
    if (activeTab !== 'code') paintSave(s);
  }
  function paintSave(s) {
    var btn = $('#saveBtn'), label = $('#saveLabel'), icon = $('#saveIcon');
    if (!btn) return;
    btn.disabled = s === 'saving' || (activeTab === 'code' ? !(code.st && code.st.site) : !state.page);
    icon.classList.toggle('hidden', s !== 'saved');
    label.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved' : 'Save';
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
    if (activeTab === 'code') { codeSave(); return; }
    if (!state.page || saving) return;
    var badPw = state.blocks.filter(function (b) {
      return b.protection === 'password' && ((!b.has_password && !b.password) || (b.password && b.password.trim().length < PW_MIN));
    });
    if (badPw.length) {
      openBlocks[badPw[0].id] = true;
      extrasTab[badPw[0].id] = 'protect';
      switchTab('content');
      renderBlocks();
      toast(badPw[0].password ? 'The password for the protected link needs at least ' + PW_MIN + ' characters.' : 'Please set a password for the protected link.', 'err');
      return;
    }
    saving = true;
    var sentVersion = version;
    setSaveState('saving');
    api('save', payload()).then(function (res) {
      saving = false;
      if (!res || !res.ok) {
        setSaveState('dirty');
        toast((res && res.error) || 'Saving failed.', 'err');
        return;
      }
      var map = res.idmap || {};
      Object.keys(map).forEach(function (oldId) {
        // Für Dialoge, die während des Speicherns offen waren: neue Blöcke heißen jetzt anders
        renamed[oldId] = map[oldId];
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
      draft.pageSaved(res.page, res.blocks);
      updatePageInfo();
      renderBlocks();
      preview.refresh();
      toast('Changes saved – your page is up to date.');
      (res.warnings || []).forEach(function (w) { toast(w, 'info'); });
      // Eigenes CSS spricht den Hinweis an, der ohne Premium sichtbar bleibt
      showCssWarning(res.cssWarning);
      if (cssWarning) toast(cssWarning, 'info');
    });
  }

  $('#saveBtn').addEventListener('click', save);

  // Wache gegen das Verlassen mit ungespeicherten Änderungen (Links, Formulare, Seitenwechsel im Code). Ungespeichertes
  // liegt als Entwurf im Browser – dann fragt der Browser beim Schließen des Tabs nicht mehr (D19), nur wenn das
  // Sichern scheitert. „Leave without saving“ löscht den Entwurf.
  var guard = window.OYSUI.guard({
    isDirty: function () { return dirty || codeUnsaved(); },
    onDiscard: function () { draft.discard(); },
    keepsDraft: function () { return draft.flush(); }
  });

  document.addEventListener('keydown', function (ev) {
    // Strg+S speichert nie die Seite des Browsers; unter einem offenen Dialog wird nicht gespeichert
    if ((ev.ctrlKey || ev.metaKey) && ev.key && ev.key.toLowerCase() === 's') { ev.preventDefault(); if (!UI.isOpen()) save(); return; }
    // Escape schließt Fenster über ui.js (oberste Ebene); hier nur die Menüs
    if (ev.key === 'Escape' && !UI.isOpen()) closeDropdowns();
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
        // Fehler kommen als JSON (über UI.handle(): bei abgelaufener Sitzung der Dialog statt vieler Hinweise)
        if (typeof html !== 'string') {
          toast(html.error || 'Preview failed.', 'err');
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
      if (!el) return;
      el.textContent = text;
      if (el.hasAttribute('data-text')) el.setAttribute('data-text', text); // Retro-Leuchten
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

  function pageById(id) {
    for (var i = 0; i < state.pages.length; i++) if (state.pages[i].id === id) return state.pages[i];
    return null;
  }

  // Editor neu laden – auch wenn das Ziel nur im Anker von der aktuellen Adresse abweicht (das lädt sonst nicht neu)
  function reloadTo(url) {
    var u = new URL(url, location.href);
    if (u.pathname !== location.pathname || u.search !== location.search) return guard.navigate(u.href, { force: true });
    if (history.replaceState) history.replaceState(null, '', u.hash || location.pathname + location.search);
    return guard.reload({ force: true });
  }

  function goToPage(id) {
    if (state.page && id === state.page.id) return;
    guard.confirm({ title: 'Switch pages?', text: 'You have unsaved changes. They’re lost if you switch now.', ok: 'Switch without saving', cancel: 'Stay', tone: 'danger' })
      .then(function (ok) {
        // Nach dem Dialog: das Ziel gibt es noch und es ist nicht die aktuelle Seite
        if (!ok || !pageById(id) || (state.page && id === state.page.id)) return;
        guard.navigate('/dashboard?page=' + id + location.hash, { force: true });
      });
  }

  function renderPageMenu() {
    var max = E.maxPages || 3;
    var html = '<div class="dd-head">Your pages <span>' + state.pages.length + ' / ' + max + '</span></div>';
    state.pages.forEach(function (p) {
      var cur = state.page && p.id === state.page.id;
      html += '<button type="button" class="dd-item' + (cur ? ' current' : '') + '" data-page="' + p.id + '">' +
        '<span class="ps-avatar">' + (p.avatar ? '<img src="' + esc(p.avatar) + '" alt="">' : esc(initials(p.title || p.slug))) + '</span>' +
        '<span class="flex-1 min-w-0"><span class="block truncate text-white">' + esc(p.title || p.slug) + '</span><small class="truncate">' + esc(p.url) + '</small></span>' +
        (cur ? '<i class="bx bx-check text-brand-400 text-lg"></i>' : '') + '</button>';
    });
    html += '<div class="dd-sep"></div>';
    if (state.pages.length < max || E.pagesUnlimited) {
      html += '<button type="button" class="dd-item" data-action="new-page"><span class="ps-avatar"><i class="bx bx-plus"></i></span><span>Create a new page<small>With its own address and stats</small></span></button>';
    } else {
      html += '<div class="px-3 py-2 text-xs text-gray-500">Up to ' + max + ' pages per account.</div>';
    }
    $('#pageMenu').innerHTML = html;
  }

  // Alle Menüs zu; die Glocke über bell.js, damit aria-expanded stimmt und der Fokus nicht in einer versteckten Liste bleibt
  function closeDropdowns() {
    if (bell) bell.close();
    $$('.dropdown').forEach(function (d) { d.classList.add('hidden'); });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t.closest('#pageSwitcherBtn')) {
      var menu = $('#pageMenu');
      var wasHidden = menu.classList.contains('hidden');
      closeDropdowns();
      if (wasHidden) { renderPageMenu(); menu.classList.remove('hidden'); }
      return;
    }
    // Die Glocke (bell.js) öffnet und schließt ihre Liste selbst
    if (t.closest('[data-bell]')) return;
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
      case 'share': openShareModal(); break;
      case 'honeycombs': openShop(el && el.dataset ? el.dataset.feature : ''); break;
    }
  }

  // Glocke (static/js/bell.js): fragt selbst ab – jede Minute, sofort beim Zurückkehren in den Tab, auch ohne Seite.
  // Ihre Ziele öffnen über OYSUI.openLink() die Bereiche hier (DEEP_LINKS); neue Nachrichten laden den offenen Eingang neu.
  var bell = null;
  function startBell() {
    if (!window.OYSBell) return;
    bell = window.OYSBell.mount($('[data-bell]'), {
      onOpen: closeDropdowns,
      onAnswer: function (res) {
        var nb = $('#navMsgBadge');
        nb.hidden = !res.messages_unread;
        nb.textContent = res.messages_unread;
      },
      onNew: function (list) {
        if (activeTab === 'messages' && list.some(function (n) { return n.type === 'message' || n.type === 'booking'; })) loadMessages();
      }
    });
  }
  function refreshBell() { if (bell) bell.poll(); }

  // ================================================================
  // Modal
  // ================================================================
  // Das Fenster des Editors (#modal) ist eine Ebene von ui.js: Fokus bleibt darin, Escape und die Zurück-Geste
  // schließen es, der Hintergrund ist inert, und beim Schließen kehrt der Fokus zum Auslöser zurück
  var modalLayer = null;
  function openModal(title, bodyHtml, footHtml, onMount) {
    var box = $('#modalBox');
    shareOpen = null;
    box.classList.remove('wide');
    box.innerHTML = '<div class="modal-head"><h3 id="modalTitle">' + esc(title) + '</h3><button type="button" class="icon-btn" data-close aria-label="Close"><i class="bx bx-x"></i></button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' + (footHtml ? '<div class="modal-foot">' + footHtml + '</div>' : '');
    $('#modal').classList.remove('hidden');
    if (!modalLayer) modalLayer = UI.layer($('#modal'), { labelledBy: 'modalTitle', onEscape: closeModal });
    if (onMount) onMount(box);
    var first = $('input, textarea', box);
    if (first) setTimeout(function () { first.focus(); }, 40);
  }
  function closeModal() {
    $('#modal').classList.add('hidden');
    $('#modalBox').innerHTML = '';
    $('#modalBox').classList.remove('wide');
    shareOpen = null;
    if (modalLayer) { var l = modalLayer; modalLayer = null; l.release(); }
  }
  $('#modal').addEventListener('click', function (ev) {
    // Beim Zuschneiden endet ein Ziehen manchmal neben dem Fenster – das soll es nicht schließen
    if ((ev.target.id === 'modal' && Date.now() - cropGuard > 400) || ev.target.closest('[data-close]')) closeModal();
  });

  function openNewPageModal() {
    var max = E.maxPages || 3;
    if (state.pages.length >= max && !E.pagesUnlimited) { toast('You already have ' + max + ' pages.', 'err'); return; }
    openModal('Create a new page',
      '<p class="text-sm text-gray-400 mb-4">Each page has its own address, its own theme and its own stats – for example, one for you and one for your project.</p>' +
      '<label class="lbl">Address</label>' +
      '<div class="input-group"><input class="field" id="npSlug" placeholder="projectname" maxlength="30" autocomplete="off"><span class="addon right">.' + esc(E.baseHost) + '</span></div>' +
      '<p class="hint">2–30 characters: a–z, 0–9 and hyphens. Also reachable at ' + esc(E.baseHost) + '/projectname.</p>' +
      '<label class="lbl mt-4">Name on the page</label><input class="field" id="npTitle" maxlength="120" placeholder="e.g. My Project">' +
      '<p class="text-sm text-red-400 mt-3 hidden" id="npErr"></p>',
      '<button type="button" class="btn-ghost" data-close>Cancel</button><button type="button" class="btn-primary" id="npCreate"><i class="bx bx-plus"></i> Create page</button>',
      function (box) {
        var slug = $('#npSlug', box);
        slug.addEventListener('input', function () { slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); });
        var go = function () {
          var btn = $('#npCreate', box);
          if (btn.disabled) return;
          // Ungespeichertes gibt es auf der neuen Seite nicht: vorher fragen (eine inzwischen fertige Speicherung → keine Frage)
          var ask = guard.isDirty()
            ? UI.confirm({ title: 'Create the page without saving?', text: 'You have unsaved changes on this page. They’re lost if you continue.', ok: 'Create without saving', tone: 'danger' })
            : Promise.resolve(true);
          ask.then(function (ok) {
            if (!ok || !box.contains(btn) || btn.disabled) return;
            btn.disabled = true;
            api('page-create', { slug: slug.value, title: $('#npTitle', box).value, page_id: 0 }).then(function (res) {
              btn.disabled = false;
              if (res && res.ok) {
                // Die ungespeicherten Änderungen wurden verworfen: ihr Entwurf geht mit
                draft.discard();
                guard.navigate('/dashboard?page=' + res.id, { force: true });
                return;
              }
              var err = $('#npErr', box);
              if (!err) return;
              err.textContent = (res && res.error) || 'That didn’t work.';
              err.classList.remove('hidden');
            });
          });
        };
        $('#npCreate', box).addEventListener('click', go);
        slug.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go(); });
      });
  }

  // ================================================================
  // Profilbild zuschneiden: verschieben, zoomen, drehen, Hintergrund für Logos, Form
  // ================================================================
  var AVATAR_OUT = 640;  // so groß speichert der Server Profilbilder (oys_upload_kinds: avatar)
  var cropGuard = 0;     // gerade gezogen: ein Klick daneben schließt das Fenster dann nicht

  // Bild laden und für die Bearbeitung auf höchstens 2048 px bringen (SVG-Logos werden scharf gerastert)
  function loadCropSource(source) {
    return new Promise(function (resolve, reject) {
      var isFile = typeof source !== 'string';
      var isSvg = isFile && (source.type === 'image/svg+xml' || /\.svg$/i.test(source.name || ''));
      var url = isFile ? URL.createObjectURL(source) : source;
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
        var k = isSvg ? 1600 / Math.max(w, h) : Math.min(1, 2048 / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(h * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        if (isFile) URL.revokeObjectURL(url);
        resolve({ canvas: c, alpha: cropHasAlpha(c) });
      };
      img.onerror = function () { if (isFile) URL.revokeObjectURL(url); reject(); };
      img.src = url;
    });
  }
  function cropHasAlpha(c) {
    var t = document.createElement('canvas');
    t.width = t.height = 48;
    var x = t.getContext('2d');
    x.drawImage(c, 0, 0, 48, 48);
    try {
      var d = x.getImageData(0, 0, 48, 48).data;
      for (var i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    } catch (e) { /* egal */ }
    return false;
  }
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // keep: das aktuelle Profilbild nachbearbeiten – es erscheint zuerst genau so wie jetzt
  function openAvatarCropper(source, keep) {
    var waiting = setTimeout(function () { toast('Opening the picture…', 'info'); }, 400);
    loadCropSource(source).then(function (loaded) {
      clearTimeout(waiting);
      showAvatarCropper(loaded, keep);
    }).catch(function () {
      clearTimeout(waiting);
      toast('This picture can’t be opened – please use a JPG, PNG, WebP or SVG file.', 'err');
    });
  }

  function showAvatarCropper(loaded, keep) {
    var src = loaded.canvas;
    var accent = themeAccent(state.page.theme);
    var shapes = { circle: 'Circle', rounded: 'Rounded', square: 'Square' };
    // Alles in Anteilen der Fläche: x/y = Verschiebung der Bildmitte, z = Bildpunkte → Flächenbreite
    var st = { rot: 0, x: 0, y: 0, z: 1, bg: '', shape: shapes[state.page.settings.avatar_shape] ? state.page.settings.avatar_shape : 'circle' };
    var canvas, slider, raf = 0;

    function dims() { return st.rot % 180 ? [src.height, src.width] : [src.width, src.height]; }
    function fillZoom() { var d = dims(); return 1 / Math.min(d[0], d[1]); }
    function fitZoom() {
      var d = dims();
      // ganz sichtbar innerhalb der Form (Kreis: die Bildecken liegen auf dem Rand)
      return (st.shape === 'circle' ? 1 / Math.sqrt(d[0] * d[0] + d[1] * d[1]) : (st.shape === 'rounded' ? .92 : .96) / Math.max(d[0], d[1])) * .96;
    }
    function zMin() { return Math.min(fitZoom(), fillZoom()) * .5; }
    function zMax() { return fillZoom() * 6; }
    function zoomAt(f, px, py) {
      var nz = Math.max(zMin(), Math.min(zMax(), st.z * f));
      f = nz / st.z;
      st.x = px + (st.x - px) * f;
      st.y = py + (st.y - py) * f;
      st.z = nz;
    }
    function view(kind) { st.x = 0; st.y = 0; st.z = kind === 'fit' ? fitZoom() : fillZoom(); }

    function draw(ctx, size, guide) {
      ctx.clearRect(0, 0, size, size);
      if (st.bg) {
        ctx.fillStyle = st.bg;
        ctx.fillRect(0, 0, size, size);
      } else if (guide) {
        // Schachbrett = durchsichtig (dort scheint auf der Seite das Design durch)
        var q = Math.max(6, Math.round(size / 28));
        for (var gy = 0; gy < size; gy += q) for (var gx = 0; gx < size; gx += q) {
          ctx.fillStyle = ((gx + gy) / q) % 2 ? '#26262b' : '#1a1a1e';
          ctx.fillRect(gx, gy, q, q);
        }
      }
      ctx.save();
      ctx.translate(size / 2 + st.x * size, size / 2 + st.y * size);
      ctx.rotate(st.rot * Math.PI / 180);
      ctx.scale(st.z * size, st.z * size);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, -src.width / 2, -src.height / 2);
      ctx.restore();
      if (!guide) return;
      // Was außerhalb der Form liegt, ist auf der Seite nicht zu sehen
      var r = st.shape === 'circle' ? size / 2 : st.shape === 'rounded' ? size * .28 : size * 14 / 124;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, size, size);
      roundRectPath(ctx, 0, 0, size, size, r);
      ctx.fillStyle = 'rgba(0, 0, 0, .55)';
      ctx.fill('evenodd');
      ctx.beginPath();
      roundRectPath(ctx, 1, 1, size - 2, size - 2, r);
      ctx.strokeStyle = 'rgba(255, 255, 255, .85)';
      ctx.lineWidth = Math.max(1.5, size / 220);
      ctx.stroke();
      ctx.restore();
    }

    function paint() {
      raf = 0;
      if (!canvas || !document.body.contains(canvas)) { window.removeEventListener('resize', redraw); return; }
      var size = Math.round(canvas.getBoundingClientRect().width * (window.devicePixelRatio || 1));
      if (size < 2) return;
      if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
      draw(canvas.getContext('2d'), size, true);
      var lo = zMin(), hi = zMax();
      slider.value = String(Math.round(1000 * Math.log(st.z / lo) / Math.log(hi / lo)));
    }
    function redraw() { if (!raf) raf = requestAnimationFrame(paint); }

    function swatch(bg, cls, title, style) {
      return '<button type="button" class="crop-swatch' + (cls ? ' ' + cls : '') + '" data-bg="' + esc(bg) + '" title="' + esc(title) + '" aria-label="' + esc(title) + '"' + (style ? ' style="' + style + '"' : '') + '></button>';
    }
    var body =
      '<div id="cropRoot"><div class="crop-stage"><canvas id="cropCanvas" tabindex="0" aria-label="Profile picture: drag to move, + and − to zoom, arrow keys to move"></canvas></div>' +
      '<div class="crop-zoom"><button type="button" class="icon-btn" data-crop="out" aria-label="Zoom out" title="Zoom out"><i class="bx bx-zoom-out"></i></button>' +
        '<input type="range" id="cropZoom" min="0" max="1000" step="1" aria-label="Zoom">' +
        '<button type="button" class="icon-btn" data-crop="in" aria-label="Zoom in" title="Zoom in"><i class="bx bx-zoom-in"></i></button></div>' +
      '<div class="crop-tools">' +
        '<button type="button" class="chip" data-crop="left" title="Rotate left"><i class="bx bx-rotate-left"></i> Rotate</button>' +
        '<button type="button" class="chip" data-crop="right" title="Rotate right" aria-label="Rotate right"><i class="bx bx-rotate-right"></i></button>' +
        '<button type="button" class="chip" data-crop="fit" title="Show the whole picture – good for logos"><i class="bx bx-collapse"></i> Show all</button>' +
        '<button type="button" class="chip" data-crop="fill" title="Fill the whole shape"><i class="bx bx-expand"></i> Fill</button>' +
      '</div>' +
      '<label class="lbl mt-5">Background <small>– for logos with a transparent background</small></label>' +
      '<div class="crop-swatches" id="cropBg">' +
        swatch('', 'is-none', 'None – your design shows through') +
        swatch('#ffffff', '', 'White', '--c:#ffffff') +
        swatch('#000000', '', 'Black', '--c:#000000') +
        swatch(accent, '', 'Theme color', '--c:' + esc(accent)) +
        '<label class="crop-swatch is-custom" title="Pick a color"><input type="color" id="cropColor" value="#6366f1" aria-label="Pick a color"><i class="bx bx-palette"></i></label>' +
      '</div>' +
      '<label class="lbl mt-5">Shape</label>' +
      '<div class="chips" id="cropShape">' + Object.keys(shapes).map(function (k) {
        return '<button type="button" class="chip" data-shape="' + k + '">' + shapes[k] + '</button>';
      }).join('') + '</div>' +
      '<p class="hint mt-4"><span class="hover-only">Drag the picture to move it, scroll to zoom.</span><span class="touch-only">Drag the picture to move it, pinch to zoom.</span> Everything inside the outline is shown on your page.</p></div>';

    openModal('Adjust your profile picture', body,
      '<button type="button" class="btn-ghost" data-close>Cancel</button><button type="button" class="btn-primary" id="cropSave"><i class="bx bx-check"></i> Save picture</button>',
      function (box) {
        canvas = $('#cropCanvas', box);
        slider = $('#cropZoom', box);
        // Neue Logos mit durchsichtigem Hintergrund ganz zeigen, Fotos füllen die Form
        view(!keep && loaded.alpha ? 'fit' : 'fill');

        function mark() {
          $$('#cropBg .crop-swatch', box).forEach(function (b) { b.classList.toggle('on', b.dataset.bg !== undefined ? b.dataset.bg === st.bg : false); });
          var custom = $('#cropBg .is-custom', box);
          custom.classList.toggle('on', !!st.bg && !$$('#cropBg [data-bg]', box).some(function (b) { return b.dataset.bg === st.bg; }));
          $$('#cropShape .chip', box).forEach(function (b) { b.classList.toggle('on', b.dataset.shape === st.shape); });
        }
        mark();

        // Ziehen mit Maus/Finger, zwei Finger zoomen
        var pts = {}, moved = false;
        canvas.addEventListener('pointerdown', function (e) {
          canvas.setPointerCapture(e.pointerId);
          pts[e.pointerId] = { x: e.clientX, y: e.clientY };
          moved = false;
        });
        canvas.addEventListener('pointermove', function (e) {
          var prev = pts[e.pointerId];
          if (!prev) return;
          var cur = { x: e.clientX, y: e.clientY }, rect = canvas.getBoundingClientRect(), S = rect.width || 1;
          var ids = Object.keys(pts);
          if (ids.length === 1) {
            st.x += (cur.x - prev.x) / S;
            st.y += (cur.y - prev.y) / S;
          } else {
            var other = pts[ids[0] === String(e.pointerId) ? ids[1] : ids[0]];
            var d0 = Math.hypot(prev.x - other.x, prev.y - other.y), d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
            st.x += (cur.x - prev.x) / 2 / S;
            st.y += (cur.y - prev.y) / 2 / S;
            if (d0 > 0) zoomAt(d1 / d0, ((cur.x + other.x) / 2 - rect.left) / S - .5, ((cur.y + other.y) / 2 - rect.top) / S - .5);
          }
          pts[e.pointerId] = cur;
          moved = true;
          cropGuard = Date.now();
          redraw();
        });
        ['pointerup', 'pointercancel'].forEach(function (t) {
          canvas.addEventListener(t, function (e) { delete pts[e.pointerId]; if (moved) cropGuard = Date.now(); });
        });
        canvas.addEventListener('wheel', function (e) {
          e.preventDefault();
          var rect = canvas.getBoundingClientRect();
          zoomAt(Math.exp(-e.deltaY * .0015), (e.clientX - rect.left) / rect.width - .5, (e.clientY - rect.top) / rect.height - .5);
          redraw();
        }, { passive: false });
        canvas.addEventListener('keydown', function (e) {
          var step = e.shiftKey ? .05 : .01, keys = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
          if (keys[e.key]) { st.x += keys[e.key][0]; st.y += keys[e.key][1]; }
          else if (e.key === '+' || e.key === '=') zoomAt(1.1, 0, 0);
          else if (e.key === '-') zoomAt(1 / 1.1, 0, 0);
          else return;
          e.preventDefault();
          redraw();
        });
        slider.addEventListener('input', function () {
          var lo = zMin(), hi = zMax();
          zoomAt(lo * Math.pow(hi / lo, Number(slider.value) / 1000) / st.z, 0, 0);
          redraw();
        });
        $('#cropRoot', box).addEventListener('click', function (e) {
          var b = e.target.closest('[data-crop], [data-bg], [data-shape]');
          if (!b) return;
          if (b.dataset.crop === 'in') zoomAt(1.15, 0, 0);
          if (b.dataset.crop === 'out') zoomAt(1 / 1.15, 0, 0);
          if (b.dataset.crop === 'left' || b.dataset.crop === 'right') {
            // um die Mitte der Fläche drehen
            var cw = b.dataset.crop === 'right', x = st.x;
            st.rot = (st.rot + (cw ? 90 : 270)) % 360;
            st.x = cw ? -st.y : st.y;
            st.y = cw ? x : -x;
          }
          if (b.dataset.crop === 'fit' || b.dataset.crop === 'fill') view(b.dataset.crop);
          if (b.dataset.bg !== undefined) st.bg = b.dataset.bg;
          if (b.dataset.shape) st.shape = b.dataset.shape;
          mark();
          redraw();
        });
        $('#cropColor', box).addEventListener('input', function () { st.bg = this.value; mark(); redraw(); });
        window.addEventListener('resize', redraw);
        redraw();

        $('#cropSave', box).addEventListener('click', function () {
          var btn = this;
          btn.disabled = true;
          btn.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Saving…';
          var out = document.createElement('canvas');
          out.width = out.height = AVATAR_OUT;
          draw(out.getContext('2d'), AVATAR_OUT, false);
          new Promise(function (resolve, reject) {
            try { out.toBlob(function (b) { if (b) resolve(b); else reject(); }, 'image/webp', .92); } catch (e) { reject(e); }
          }).then(function (blob) {
            // Browser ohne WebP liefern PNG – das behält die Durchsichtigkeit
            var ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
            return uploadRaw('avatar', new File([blob], 'profile-picture.' + ext, { type: blob.type }));
          }).then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || '');
            closeModal();
            state.page.avatar = res.file;
            state.page.settings.avatar_shape = st.shape;
            renderInhalte();
            updatePageInfo();
            markDirty({ fast: true });
          }).catch(function (err) {
            btn.disabled = false;
            btn.innerHTML = '<i class="bx bx-check"></i> Save picture';
            toast((err && err.message) || 'The picture couldn’t be saved – please try another file.', 'err');
          });
        });
      });
  }

  // ================================================================
  // Tabs
  // ================================================================
  var TAB_TITLES = { content: 'Content', design: 'Design', stats: 'Stats', messages: 'Messages', code: 'Code page', status: 'Status', honeycombs: 'Honeycombs', settings: 'Settings' };
  function switchTab(name) {
    // Den Bereich „Status“ gibt es nur für Admins: ohne seinen Container bleibt alles beim Inhalt
    if (!TAB_TITLES[name] || !$('#tab-' + name)) name = 'content';
    var wasCode = activeTab === 'code';
    var wasStatus = activeTab === 'status';
    activeTab = name;
    $$('.tab-content').forEach(function (t) { t.classList.add('hidden'); });
    $('#tab-' + name).classList.remove('hidden');
    $$('#mainNav .nav-btn[data-tab]').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    $('#pageTitle').textContent = TAB_TITLES[name];
    if (history.replaceState) history.replaceState(null, '', '#' + name);
    $('#editorScroll').scrollTop = 0;
    document.body.classList.toggle('code-mode', name === 'code');
    // Statusseite: ohne Vorschau des Profils und ohne den Speichern-Knopf (der Bereich speichert jede Änderung selbst)
    document.body.classList.toggle('status-mode', name === 'status');
    if ($('#noPageBox')) $('#noPageBox').hidden = name === 'code' || name === 'status' || name === 'honeycombs';
    if (wasCode !== (name === 'code') || wasStatus !== (name === 'status')) fitPhone();
    paintSave(name === 'code' ? code.state : pageSaveState);
    if (name === 'code') loadCode();
    if (wasCode && name !== 'code' && state.page) {
      updatePageInfo();
      $('#pvLiveLabel').textContent = 'Live preview';
      preview.refreshIfStale();
    }
    // Nachrichten und Termine gehören zum Konto: auch ohne Seite (ebenso die Honigwaben)
    if (name === 'messages') loadMessages();
    if (name === 'status') loadStatus();
    if (name === 'honeycombs') loadShop();
    if (!state.page) return;
    if (name === 'design') { renderDesign(); }
    if (name === 'stats') loadStats(statsRange);
    if (name === 'settings') renderSettings();
  }
  $$('#mainNav .nav-btn[data-tab]').forEach(function (b) { b.addEventListener('click', function () { switchTab(b.dataset.tab); }); });
  // Telefone: „OnYourSite status“ in den Einstellungen öffnet den Bereich
  document.addEventListener('click', function (ev) {
    if (ev.target.closest && ev.target.closest('[data-open-status]')) switchTab('status');
  });

  // ================================================================
  // OnYourSites eigene Statusseite (nur Admins): static/js/status-manage.js, erst beim ersten Öffnen geladen
  // ================================================================
  var statusLoading = null;
  function loadStatus() {
    var root = $('#tab-status');
    if (!root || !E.statusManage) return;
    if (!statusLoading) {
      statusLoading = new Promise(function (resolve, reject) {
        var css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = E.statusManage.css;
        document.head.appendChild(css);
        var js = document.createElement('script');
        js.src = E.statusManage.js;
        js.onload = resolve;
        js.onerror = reject;
        document.head.appendChild(js);
      });
    }
    statusLoading.then(function () {
      if (window.OYS_STATUS) window.OYS_STATUS.mount(root, { api: '/dashboard/api/', csrf: E.csrf, scope: 'system', baseHost: E.baseHost, user: E.user || {} });
    }, function () {
      statusLoading = null;
      root.textContent = '';
      var box = document.createElement('div');
      box.className = 'panel max-w-3xl mx-auto';
      box.textContent = 'The status page manager couldn’t load. Please reload the page.';
      root.appendChild(box);
    });
  }
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
    if (activeTab === 'settings') renderSettings();
  }

  // ================================================================
  // Tab: Inhalte
  // ================================================================
  function renderInhalte() {
    var root = $('#tab-content');
    if (!state.page) { root.innerHTML = ''; return; }
    var p = state.page;
    root.innerHTML =
      '<section>' +
      '<h2 class="section-title">Profile <small>Name, picture and a few words about you</small></h2>' +
      '<div class="panel"><div class="flex flex-col sm:flex-row gap-5 items-start">' +
      '<div class="flex flex-col items-center gap-2"><button type="button" class="avatar-up" id="avatarUp" title="Upload profile picture">' +
      (p.avatar ? '<img src="' + esc(uploadUrl(p.avatar)) + '" alt="">' : '<i class="bx bx-camera text-2xl"></i>') +
      '<span class="ov"><i class="bx bx-upload"></i></span></button>' +
      (p.avatar ? '<div class="flex items-center gap-3"><button type="button" class="text-xs text-gray-400 hover:text-white flex items-center gap-1" id="avatarEdit"><i class="bx bx-crop"></i> Adjust</button>' +
        '<button type="button" class="text-xs text-gray-500 hover:text-red-400" id="avatarDel">Remove</button></div>' : '<span class="text-[11px] text-gray-500">Profile picture</span>') +
      '</div>' +
      '<div class="flex-1 w-full space-y-4">' +
      '<div class="field-row cols-2"><div><label class="lbl">Name</label><input class="field" data-bind="page.title" maxlength="120" placeholder="Your name"></div>' +
      '<div><label class="lbl">Subtitle <small>(optional)</small></label><input class="field" data-bind="page.subtitle" maxlength="160" placeholder="e.g. Musician & streamer"></div></div>' +
      '<div><label class="lbl">Bio</label><textarea class="field" rows="3" data-bind="page.bio" maxlength="1000" placeholder="Tell visitors briefly what they’ll find here."></textarea><div class="counter"></div></div>' +
      '</div></div></div></section>' +

      '<section class="mt-8">' +
      '<h2 class="section-title">Your blocks <button type="button" class="btn-secondary" data-action="add-block"><i class="bx bx-plus"></i> Add block</button></h2>' +
      '<div class="quick-add mb-4"><div class="input-group"><span class="addon left"><i class="bx bx-link text-base"></i></span>' +
      '<input class="field" id="quickUrl" placeholder="Paste a link – e.g. instagram.com/yourname" autocomplete="off"></div>' +
      '<button type="button" class="btn-primary" data-action="quick-add"><i class="bx bx-plus"></i><span class="hidden sm:inline">Link</span></button></div>' +
      '<div class="blocks" id="blockList"></div>' +
      '<button type="button" data-action="add-block" class="w-full mt-3 py-3 rounded-xl border border-dashed border-bordercolor text-gray-500 hover:text-white hover:border-brand-500 transition-colors text-sm font-medium flex items-center justify-center gap-2"><i class="bx bx-plus text-lg"></i> Add block</button>' +
      '<p class="hint text-center mt-3"><i class="bx bx-info-circle"></i> Drag blocks by the handle on the left to reorder them.<span class="hover-only"> Ctrl + S saves.</span></p>' +
      '</section>';

    bindAll(root);
    var bio = $('[data-bind="page.bio"]', root);
    if (bio) updateCounter(bio);
    $('#avatarUp').addEventListener('click', function () {
      pickFile('image/*').then(function (files) {
        var file = files[0];
        if (!file) return;
        // Neue Bilder erst zuschneiden. Animierte GIFs bleiben, wie sie sind (sonst ginge die Animation verloren).
        if (file.type !== 'image/gif') { openAvatarCropper(file); return; }
        toast('Uploading profile picture…', 'info');
        upload('avatar', file).then(function (res) {
          if (!res.ok) { toast(res.error, 'err'); return; }
          state.page.avatar = res.file;
          renderInhalte();
          updatePageInfo();
          markDirty({ fast: true });
        });
      });
    });
    var edit = $('#avatarEdit');
    if (edit) edit.addEventListener('click', function () { openAvatarCropper(uploadUrl(state.page.avatar), true); });
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
    var canEmbed = embed && /youtube\.com\/watch|youtu\.be\/|twitch\.tv\/(videos|[a-z0-9_]+\/clip)|open\.spotify\.com\/(intl-[a-z-]+\/)?(track|album|playlist|episode|show)/i.test(url);
    // Zwei Wege statt OK/Abbrechen: ✕ und Escape fügen nichts hinzu, die Adresse bleibt im Feld
    var ask = canEmbed
      ? UI.choice({
        title: 'Embed this ' + TYPES[embed].name + ' link?',
        text: 'Show it right on your page, or add it as a normal link button.',
        options: [{ value: 'link', text: 'Add as link' }, { value: 'embed', text: 'Embed it', primary: true }],
        fallbackFocus: function () { return $('#quickUrl'); }
      })
      : Promise.resolve('link');
    ask.then(function (how) {
      var field = $('#quickUrl');
      if (how === null) { if (field) field.focus(); return; }
      // Nach dem Dialog: es gibt noch eine Seite; der Block kommt in die aktuelle Liste
      if (!state.page) return;
      var b;
      if (how === 'embed') {
        b = newBlock(embed, { url: url, provider: embed });
      } else {
        var br = detectBrand(url);
        var title = br ? brand(br).name : prettyUrl(url).split('/')[0];
        b = newBlock('link', { url: url, title: title });
      }
      state.blocks.push(b);
      // Das Feld nur leeren, wenn darin noch dieselbe Adresse steht
      if (field && normalizeUrl(field.value) === url) field.value = '';
      openBlocks[b.id] = true;
      renderBlocks();
      markDirty({ fast: true });
      scrollToBlock(b.id);
    });
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
    openModal('Add block', html, '', function (box) {
      $('.modal-body', box).addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-add]');
        if (!btn) return;
        var b = newBlock(btn.dataset.add);
        state.blocks.push(b);
        openBlocks[b.id] = true;
        closeModal();
        if (activeTab !== 'content') switchTab('content');
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
      list.innerHTML = '<div class="empty-state panel"><i class="bx bx-layer-plus"></i>No blocks yet. Paste a link above or choose a block.</div>';
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
      case 'link': return [d.title || prettyUrl(d.url) || 'New link', d.url ? prettyUrl(d.url) : 'No URL yet – the link only shows up once you add one'];
      case 'socials':
        var filled = (d.items || []).filter(function (i) { return String(i.v || '').trim(); }).map(function (i) { return (brand(i.p) || {}).name; });
        return ['Social icons', filled.length ? filled.join(', ') : 'Still empty – add your profiles'];
      case 'heading': return [d.text || 'Heading', 'Heading'];
      case 'text': return [(d.text || 'Empty text').slice(0, 70), 'Text'];
      case 'divider': return ['Divider', { line: 'Line', dots: 'Dots', space: 'Spacing', wave: 'Wave' }[d.style] || ''];
      case 'image': return [d.alt || d.caption || 'Image', d.src ? 'Image uploaded' + (d.url ? ' · linked' : '') : 'No image yet'];
      case 'gallery': return ['Gallery', plural((d.images || []).length, 'image', 'images')];
      case 'embed': return [d.title || t.name, d.url ? prettyUrl(d.url) : 'No URL yet'];
      case 'countdown':
        var when = d.target ? fmtDate(d.target, true) + ', ' + d.target.slice(11) : 'No date set';
        return [d.title || 'Countdown', 'Countdown to ' + when];
      case 'contact': return [d.title || 'Contact form', 'Contact form · Messages go to the “Messages” tab'];
      case 'booking': return [d.title || 'Book a meeting', d.url === '/kalender' || !d.url ? 'Built-in booking calendar' : prettyUrl(d.url)];
      case 'file': return [d.title || 'File', d.src ? d.src.split('.').pop().toUpperCase() + ' file' : 'No file yet'];
    }
    return [t.name, ''];
  }

  function blockBadges(b) {
    var out = '';
    if (b.schedule && b.schedule.enabled) {
      var on = scheduleActive(b.schedule);
      out += '<span class="bdg amber" title="' + esc(scheduleText(b.schedule)) + '"><i class="bx bx-time-five"></i>' + (on ? 'Schedule · on' : 'Schedule · off') + '</span>';
    }
    if (b.protection === 'password') out += '<span class="bdg red"><i class="bx bx-lock-alt"></i>Password</span>';
    if (b.protection === 'age') out += '<span class="bdg red">18+</span>';
    if (b.effect && b.effect !== 'none') out += '<span class="bdg brand"><i class="bx bx-star"></i>' + EFFECTS[b.effect] + '</span>';
    if (b.type === 'link' && b.data.featured) out += '<span class="bdg green">Highlighted</span>';
    if (b.clicks > 0) out += '<span class="bdg hidden sm:inline-flex"><i class="bx bx-pointer"></i>' + fmtNum(b.clicks) + '</span>';
    return out;
  }

  function blockCard(b) {
    var sum = blockSummary(b);
    var open = !!openBlocks[b.id];
    var el = h('<div class="blk' + (open ? ' open' : '') + (b.visible ? '' : ' is-hidden') + '" data-id="' + esc(b.id) + '">' +
      '<div class="blk-head">' +
      '<span class="blk-drag" title="Drag to reorder"><i class="bx bx-grid-vertical"></i></span>' +
      '<span class="blk-ico" style="--c:' + blockColor(b) + '">' + blockIcon(b) + '</span>' +
      '<div class="blk-main"><b>' + esc(sum[0]) + '</b><span>' + esc(sum[1]) + '</span></div>' +
      '<div class="blk-badges hidden md:flex">' + blockBadges(b) + '</div>' +
      '<button type="button" class="icon-btn" data-blk="visible" title="' + (b.visible ? 'Hide' : 'Show') + '"><i class="bx ' + (b.visible ? 'bx-show' : 'bx-hide') + '"></i></button>' +
      '<button type="button" class="icon-btn" data-blk="toggle" title="Edit"><i class="bx ' + (open ? 'bx-chevron-up' : 'bx-chevron-down') + '"></i></button>' +
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
      '<div class="flex-1 min-w-0"><div class="text-sm text-white truncate">' + (file ? esc(file) : esc(label)) + '</div><div class="text-xs text-gray-500">' + (file ? 'Uploaded' : 'Nothing selected yet') + '</div></div>' +
      '<button type="button" class="btn-secondary" data-up="' + path + '" data-kind="' + kind + '" data-accept="' + esc(accept || 'image/*') + '"><i class="bx bx-upload"></i>' + (file ? 'Replace' : 'Upload') + '</button>' +
      (file ? '<button type="button" class="icon-btn danger" data-clear="' + path + '" title="Remove"><i class="bx bx-trash"></i></button>' : '') + '</div>';
  }

  function blockBody(b) {
    var d = b.data;
    var html = '';
    switch (b.type) {
      case 'link':
        var br = detectBrand(d.url);
        html += '<div class="field-row cols-2">' + inp('data.title', 'Title', { placeholder: 'e.g. My YouTube channel', max: 120 }) +
          '<div><label class="lbl">URL</label><input class="field" data-f="data.url" data-url="1" placeholder="https://…, name@example.com or +1 …" value="">' +
          '<div class="detect' + (br ? '' : ' hidden') + '" data-detect>' + (br ? brandSvg(br) + ' ' + esc(brand(br).name) + ' detected – using the matching icon' : '') + '</div></div></div>';
        html += '<div class="field-row cols-2">' + inp('data.subtitle', 'Subtitle <small>(optional)</small>', { placeholder: 'Shown on cards, tiles & more', max: 90 }) +
          '<div><label class="lbl">Icon</label><button type="button" class="btn-secondary w-full justify-between" data-blk="icon"><span class="flex items-center gap-2">' + iconPreview(d.icon, d.url) + '</span><i class="bx bx-chevron-right"></i></button></div></div>';
        html += '<div><label class="lbl">Thumbnail <small>(optional – looks great with tiles, bento, carousel, polaroid, magazine)</small></label>' + uploadBox('data.thumb', 'thumb', d.thumb, 'Image for this link') + '</div>';
        html += sw('data.featured', 'Highlight', 'Shown larger or in your accent color');
        break;

      case 'socials':
        html += '<div class="mini-list">' + (d.items || []).map(function (it, i) {
          var bb = brand(it.p) || {};
          var ph = it.p === 'email' ? 'you@example.com' : it.p === 'whatsapp' ? '+1 555 123 4567' : (bb.url && bb.url.indexOf('{u}') !== -1 ? 'Username or link' : 'https://…');
          return '<div class="mini-row"><span class="brand-ico" style="color:' + (/^#(000000|181717)$/i.test(bb.color) ? '#e4e4e7' : bb.color) + '">' + brandSvg(it.p) + '</span>' +
            '<select class="field" style="max-width:150px" data-f="data.items.' + i + '.p" data-rerender="1">' + E.brands.map(function (x) { return '<option value="' + x.key + '"' + (x.key === it.p ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select>' +
            '<input class="field" data-f="data.items.' + i + '.v" placeholder="' + esc(ph) + '">' +
            '<button type="button" class="icon-btn danger" data-soc-del="' + i + '" title="Remove"><i class="bx bx-x"></i></button></div>';
        }).join('') + '</div>';
        html += '<div class="flex flex-wrap gap-2 items-center justify-between"><button type="button" class="btn-secondary" data-blk="soc-add"><i class="bx bx-plus"></i> Add platform</button>' +
          chips('data.style', { icons: 'Icons only', brand: 'Brand colors', pills: 'With names' }, d.style) + '</div>';
        html += '<p class="hint">Instagram, TikTok, YouTube, Twitch, Discord and 22 more. A username is enough – the link is built automatically.</p>';
        break;

      case 'heading':
        html += inp('data.text', 'Text', { max: 120 });
        html += '<div class="flex flex-wrap gap-4"><div><label class="lbl">Size</label>' + chips('data.size', { s: 'Small', m: 'Medium', l: 'Large' }, d.size) + '</div>' +
          '<div><label class="lbl">Alignment</label>' + chips('data.align', { center: 'Center', left: 'Left' }, d.align) + '</div></div>';
        break;

      case 'text':
        html += inp('data.text', 'Text', { type: 'textarea', rows: 4, max: 3000, hint: 'URLs like https://… become clickable automatically.' });
        html += '<div><label class="lbl">Alignment</label>' + chips('data.align', { center: 'Center', left: 'Left' }, d.align) + '</div>';
        break;

      case 'divider':
        html += '<div><label class="lbl">Style</label>' + chips('data.style', { line: 'Line', dots: 'Dots', wave: 'Wave', space: 'Spacing only' }, d.style) + '</div>';
        break;

      case 'image':
        html += uploadBox('data.src', 'image', d.src, 'Choose an image (JPG, PNG, WebP, GIF)');
        html += '<div class="field-row cols-2">' + inp('data.caption', 'Caption <small>(optional)</small>', { max: 150 }) + inp('data.alt', 'Description for screen readers', { max: 150 }) + '</div>';
        html += inp('data.url', 'Link on tap <small>(optional)</small>', { placeholder: 'https://…', extra: ' data-url="1"' });
        html += '<div><label class="lbl">Aspect ratio</label>' + chips('data.ratio', { auto: 'Original', square: 'Square', portrait: 'Portrait', wide: 'Widescreen' }, d.ratio) + '</div>';
        break;

      case 'gallery':
        html += '<div class="gal-grid">' + (d.images || []).map(function (img, i) {
          return '<div><div class="gal-item"><img src="' + esc(uploadUrl(img.src)) + '" alt=""><button type="button" data-gal-del="' + i + '" title="Remove"><i class="bx bx-x"></i></button></div>' +
            '<input class="field mt-1" style="padding:5px 8px;font-size:12px" data-f="data.images.' + i + '.caption" placeholder="Caption (optional)"></div>';
        }).join('') + '<button type="button" class="gal-add" data-blk="gal-add"><span><i class="bx bx-image-add text-2xl block"></i>Add images</span></button></div>';
        html += '<div class="flex flex-wrap gap-4 items-end"><div><label class="lbl">Aspect ratio</label>' + chips('data.ratio', { square: 'Square', portrait: 'Portrait', wide: 'Widescreen' }, d.ratio) + '</div>' +
          sw('data.autoplay', 'Advance automatically') + '</div>';
        html += '<p class="hint">Up to 20 images. Visitors swipe through – dots show where they are.</p>';
        break;

      case 'embed':
        var prov = TYPES[d.provider] || typeInfo(b);
        var found = detectEmbed(d.url);
        var ph2 = { youtube: 'https://youtube.com/watch?v=…', twitch: 'https://twitch.tv/yourchannel', spotify: 'https://open.spotify.com/track/…' }[d.provider] || 'YouTube, Twitch or Spotify URL';
        html += '<div><label class="lbl">' + esc(prov.name) + ' URL</label><input class="field" data-f="data.url" data-url="1" placeholder="' + esc(ph2) + '">' +
          '<div class="detect' + (d.url ? (found ? '' : ' warn') : ' hidden') + '" data-detect-embed>' + (found ? brandSvg(found) + ' ' + TYPES[found].name + ' detected' : 'URL not recognized – supported: YouTube, Twitch, Spotify') + '</div></div>';
        html += inp('data.title', 'Label <small>(optional)</small>', { placeholder: 'e.g. My new video', max: 100 });
        html += '<p class="hint"><i class="bx bx-shield-quarter"></i> Privacy-friendly: the video or player only loads when visitors tap it – nothing is sent to ' + esc(prov.name) + ' before that.</p>';
        break;

      case 'countdown':
        html += inp('data.title', 'Heading', { placeholder: 'e.g. New single drops in', max: 100 });
        html += '<div class="field-row cols-2">' + inp('data.target', 'Date & time', { type: 'datetime-local' }) + inp('data.done_text', 'Text when the time is up', { max: 100 }) + '</div>';
        html += '<div class="field-row cols-2">' + inp('data.url', 'Link <small>(optional)</small>', { placeholder: 'https://…', extra: ' data-url="1"' }) + inp('data.url_label', 'Link text', { placeholder: 'e.g. Pre-save now', max: 60 }) + '</div>';
        break;

      case 'contact':
        html += '<div class="field-row cols-2">' + inp('data.title', 'Heading', { max: 80 }) + inp('data.button', 'Button text', { max: 40 }) + '</div>';
        html += inp('data.intro', 'Intro <small>(optional)</small>', { type: 'textarea', rows: 2, max: 300 });
        html += inp('data.success', 'Confirmation after sending', { max: 150 });
        html += '<p class="hint"><i class="bx bx-shield-quarter"></i> Comes with a spam filter (invisible trap, timing check, content filter). New messages show up under <b>Messages</b> and at the bell at the top.</p>';
        break;

      case 'booking':
        html += '<div class="field-row cols-2">' + inp('data.title', 'Button text', { max: 80 }) + inp('data.url', 'URL', { placeholder: '/kalender', extra: ' data-url="1"' }) + '</div>';
        html += '<p class="hint">With <code class="text-brand-400">/kalender</code> you use the built-in booking calendar – requests arrive under <b>Messages</b>. Or enter your Calendly link, for example.</p>';
        break;

      case 'file':
        html += uploadBox('data.src', 'file', d.src, 'PDF (resume), .vcf (contact card) or .zip', '.pdf,.vcf,.zip');
        html += inp('data.title', 'Button text', { max: 80, placeholder: 'e.g. Download my resume' });
        break;
    }

    // Extras: Effekt, Zeitsteuerung, Schutz
    var tabs = [];
    if (CLICKABLE[b.type]) tabs.push(['effect', 'bx-star', 'Effect' + (b.effect !== 'none' ? ': ' + EFFECTS[b.effect] : '')]);
    tabs.push(['schedule', 'bx-time-five', 'Scheduling' + (b.schedule.enabled ? ' · on' : '')]);
    if (CLICKABLE[b.type]) tabs.push(['protect', 'bx-lock-alt', b.protection === 'password' ? 'Protection: password' : b.protection === 'age' ? 'Protection: 18+' : 'Protection']);
    var cur = extrasTab[b.id] || '';
    html += '<div class="blk-tabs">' + tabs.map(function (t) {
      return '<button type="button" class="chip' + (cur === t[0] ? ' on' : '') + '" data-extra="' + t[0] + '"><i class="bx ' + t[1] + '"></i>' + esc(t[2]) + '</button>';
    }).join('') + '</div>';
    if (cur === 'effect') html += effectPane(b);
    if (cur === 'schedule') html += schedulePane(b);
    if (cur === 'protect') html += protectPane(b);

    html += '<div class="flex justify-between items-center pt-1"><span class="text-xs text-gray-600">' + (typeof b.id === 'number' ? 'ID ' + b.id + (b.clicks ? ' · ' + plural(b.clicks, 'click', 'clicks') + ' total' : '') : 'New – not saved yet') + '</span>' +
      '<div class="flex gap-1"><button type="button" class="btn-ghost" data-blk="dup"><i class="bx bx-copy"></i> Duplicate</button>' +
      '<button type="button" class="btn-ghost hover:!text-red-400" data-blk="del"><i class="bx bx-trash"></i> Delete</button></div></div>';

    var body = h('<div class="blk-body">' + html + '</div>');
    $$('[data-f]', body).forEach(function (el) { bindValue(el, getPath(b, el.dataset.f)); });
    $$('[data-show-if]', body).forEach(function (el) { el.classList.toggle('hidden', !getPath(b, el.dataset.showIf)); });
    return body;
  }

  function iconPreview(icon, url) {
    if (icon === 'none') return '<i class="bx bx-block text-lg"></i> No icon';
    if (icon && icon.indexOf('brand:') === 0) { var b = brand(icon.slice(6)); return '<span class="w-5 h-5 inline-block">' + brandSvg(icon.slice(6), 'w-5 h-5') + '</span> ' + esc(b ? b.name : ''); }
    if (icon && icon.indexOf('bx') === 0) return '<i class="' + esc(icon) + ' text-lg"></i> Custom icon';
    var br = detectBrand(url);
    return br ? '<span class="w-5 h-5 inline-block">' + brandSvg(br, 'w-5 h-5') + '</span> Automatic (' + esc(brand(br).name) + ')' : '<i class="bx bxs-magic-wand text-lg"></i> Automatic';
  }

  function effectPane(b) {
    return '<div class="blk-pane"><div class="text-xs text-gray-400">Makes this link stand out – for example, your most important one.</div>' +
      chips('effect', { none: 'No effect', shine: '✨ Shine', wobble: '〰️ Wobble', pulse: '◎ Pulse' }, b.effect) + '</div>';
  }

  function schedulePane(b) {
    var s = b.schedule;
    var active = scheduleActive(s);
    var days = s.days && s.days.length ? s.days : [1, 2, 3, 4, 5, 6, 7];
    return '<div class="blk-pane">' +
      sw('schedule.enabled', 'Enable scheduling', 'The block appears and disappears automatically') +
      '<div data-show-if="schedule.enabled" class="flex flex-col gap-3">' +
      '<div><label class="lbl">Days</label><div class="day-chips">' + DAYS.map(function (n, i) {
        return '<button type="button" class="day-chip' + (days.indexOf(i + 1) !== -1 ? ' on' : '') + '" data-day="' + (i + 1) + '">' + n + '</button>';
      }).join('') + '</div></div>' +
      '<div class="field-row cols-2">' + inp('schedule.from', 'From', { type: 'time' }) + inp('schedule.to', 'To', { type: 'time' }) + '</div>' +
      '<p class="hint" style="margin-top:-4px">Leave empty = all day. Past midnight works too (e.g. 22:00–02:00).</p>' +
      '<div class="field-row cols-2">' + inp('schedule.start', 'Show from <small>(optional)</small>', { type: 'datetime-local' }) + inp('schedule.end', 'Show until <small>(optional)</small>', { type: 'datetime-local' }) + '</div>' +
      '<div><label class="lbl">Presets</label><div class="chips">' +
      '<button type="button" class="chip" data-preset="live">“Live now” Fri 18:00–23:00</button>' +
      '<button type="button" class="chip" data-preset="weekend">Weekends only</button>' +
      '<button type="button" class="chip" data-preset="work">Weekdays 9:00–17:00</button></div></div>' +
      '<div class="sched-status ' + (active ? 'on' : 'off') + '" data-sched-status><span class="dot"></span><span>' + (active ? 'Visible now' : 'Hidden right now') + ' · ' + esc(scheduleText(s)) + ' (' + esc(E.timezone) + ')</span></div>' +
      '</div></div>';
  }

  function protectPane(b) {
    var html = '<div class="blk-pane">' + chips('protection', { none: 'No protection', password: '🔒 Password', age: '🔞 18+' }, b.protection);
    if (b.protection === 'password') {
      html += '<div><label class="lbl">Password</label><input class="field" type="text" autocomplete="off" data-f="password" placeholder="' + (b.has_password ? 'Password is set – enter a new one to change it' : 'Set a password (min. ' + PW_MIN + ' characters)') + '" maxlength="100">' +
        '<p class="hint">Visitors have to enter the password before the link opens. The target URL isn’t in your page’s source code.</p></div>';
    } else if (b.protection === 'age') {
      html += '<p class="hint" style="margin:0">Visitors first confirm that they’re at least 18 years old. The target URL isn’t in your page’s source code.</p>';
    } else {
      html += '<p class="hint" style="margin:0">Protect individual links with a password or an “18+” check.</p>';
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
        det.innerHTML = br ? brandSvg(br) + ' ' + esc(brand(br).name) + ' detected – using the matching icon' : '';
      }
    }
    if (path === 'data.url' && b.type === 'embed') {
      var de = $('[data-detect-embed]', card);
      var f = detectEmbed(value);
      if (f) b.data.provider = f;
      if (de) {
        de.classList.toggle('hidden', !value);
        de.classList.toggle('warn', !f);
        de.innerHTML = f ? brandSvg(f) + ' ' + TYPES[f].name + ' detected' : 'URL not recognized – supported: YouTube, Twitch, Spotify';
      }
    }
    if (el.dataset.rerender || path.indexOf('schedule.') === 0 && el.type === 'checkbox') {
      rerenderBlock(b);
    } else if (path.indexOf('schedule.') === 0) {
      var st = $('[data-sched-status]', card);
      if (st) {
        var on = scheduleActive(b.schedule);
        st.className = 'sched-status ' + (on ? 'on' : 'off');
        st.lastChild.textContent = (on ? 'Visible now' : 'Hidden right now') + ' · ' + scheduleText(b.schedule) + ' (' + E.timezone + ')';
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
      var delId = b.id;
      UI.confirm({
        title: 'Delete this block?', text: 'It’s removed from your page when you save.', ok: 'Delete', tone: 'danger',
        // Der Knopf ist nach dem Löschen weg: Fokus auf den nächsten Block oder „Add block“
        fallbackFocus: function () { return $('#blockList .blk-head [data-blk="toggle"]') || $('[data-action="add-block"]'); }
      }).then(function (yes) {
        if (!yes) return;
        // Während des Dialogs kann eine Speicherung die Blöcke ersetzt haben: über die ID neu suchen
        var cur = findBlock(renamed[delId] || delId);
        if (!cur) return;
        var idx = state.blocks.indexOf(cur);
        state.blocks = state.blocks.filter(function (x) { return String(x.id) !== String(cur.id); });
        renderBlocks();
        markDirty({ fast: true });
        // Der Knopf ist mit dem Block verschwunden: Fokus auf den Block an seiner Stelle (sonst „Add block“)
        var heads = $$('#blockList .blk-head [data-blk="toggle"]');
        var next = heads[Math.min(idx, heads.length - 1)] || $('[data-action="add-block"]');
        if (next) next.focus({ preventScroll: true });
      });
      return;
    }
    if (action === 'dup') {
      var copy = normBlock(clone(b));
      copy.id = 'n' + (++newCounter);
      copy.clicks = 0;
      // Der Schutz bleibt; ein Passwort-Link bekommt vor dem Speichern ein eigenes Passwort
      copy.has_password = false;
      copy.password = '';
      state.blocks.splice(state.blocks.indexOf(b) + 1, 0, copy);
      openBlocks[copy.id] = true;
      if (copy.protection === 'password') extrasTab[copy.id] = 'protect';
      renderBlocks();
      markDirty({ fast: true });
      toast('Block duplicated' + (b.protection === 'password' ? ' – set a password for the copy.' : '.'), 'info');
      return;
    }
    if (action === 'icon') { openIconPicker(b); return; }
    if (action === 'soc-add') { openBrandPicker(b); return; }
    if (action === 'gal-add') {
      pickFile('image/*', true).then(function (files) {
        files = files.slice(0, 20 - (b.data.images || []).length);
        if (!files.length) return;
        toast('Uploading ' + plural(files.length, 'image', 'images') + '…', 'info');
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
        toast('Uploading…', 'info');
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
      if (i !== -1 && days.length === 1) { toast('At least one day has to be selected.', 'info'); return; }
      if (i === -1) days.push(dn); else days.splice(i, 1);
      b.schedule.days = days.sort();
      rerenderBlock(b); updateHead(b); markDirty();
      return;
    }
    var preset = t.closest('[data-preset]');
    if (preset) {
      var p = { live: { days: [5], from: '18:00', to: '23:00' }, weekend: { days: [6, 7], from: '', to: '' }, work: { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' } }[preset.dataset.preset];
      Object.assign(b.schedule, p, { enabled: true });
      if (preset.dataset.preset === 'live' && b.type === 'link' && !b.data.title) b.data.title = 'Live now';
      rerenderBlock(b); updateHead(b); markDirty();
    }
  });

  // ---------- Symbol-Auswahl ----------
  function openIconPicker(b) {
    var cur = b.data.icon || '';
    var html = '<div class="chips mb-3"><button type="button" class="chip' + (!cur ? ' on' : '') + '" data-icon=""><i class="bx bxs-magic-wand"></i> Automatic</button>' +
      '<button type="button" class="chip' + (cur === 'none' ? ' on' : '') + '" data-icon="none"><i class="bx bx-block"></i> No icon</button></div>' +
      '<div class="add-group">Brands</div><div class="icon-grid">' + E.brands.map(function (x) {
        return '<button type="button" class="brand' + (cur === 'brand:' + x.key ? ' on' : '') + '" style="--c:' + x.color + '" data-icon="brand:' + x.key + '" title="' + esc(x.name) + '">' + brandSvg(x.key) + '</button>';
      }).join('') + '</div>' +
      '<div class="add-group">Icons</div><div class="icon-grid">' + E.bxIcons.map(function (ic) {
        return '<button type="button"' + (cur === ic ? ' class="on"' : '') + ' data-icon="' + ic + '"><i class="' + ic + '"></i></button>';
      }).join('') + '</div>';
    openModal('Choose an icon', html, '', function (box) {
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
    var html = '<p class="text-sm text-gray-400 mb-3">Tap one or more platforms.</p><div class="add-grid">' + E.brands.map(function (x) {
      var col = /^#(000000|181717)$/i.test(x.color) ? '#e4e4e7' : x.color;
      return '<button type="button" class="add-item' + (used.indexOf(x.key) !== -1 ? ' opacity-50' : '') + '" data-brand="' + x.key + '" style="--c:' + col + '"><span class="ai">' + brandSvg(x.key) + '</span><span><b>' + esc(x.name) + '</b></span></button>';
    }).join('') + '</div>';
    openModal('Add platform', html, '<button type="button" class="btn-primary" data-close>Done</button>', function (box) {
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
    var defaults = [{ title: 'Instagram', brand: 'instagram' }, { title: 'New video', brand: 'youtube' }, { title: 'My website', brand: 'website' }];
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
      '<h1 class="oys-name" data-text="' + esc(p.title || 'Your name') + '">' + esc(p.title || 'Your name') + '</h1>' + (p.subtitle ? '<p class="oys-sub">' + esc(p.subtitle) + '</p>' : '') +
      '<p class="oys-bio">' + esc((p.bio || 'Your bio goes here.').slice(0, 90)) + '</p></header>' +
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
    var filters = { all: 'All', standard: 'Standard', special: 'Special templates', dark: 'Dark', light: 'Light' };

    root.innerHTML =
      '<section><h2 class="section-title">Theme <small>' + counts.all + ' themes · <span class="hover-only">Hover over one to see it in the preview right away</span><span class="touch-only">Tap one to try it – check it with Preview</span></small></h2>' +
      '<div class="chips mb-4" id="themeFilter">' + Object.keys(filters).map(function (k) {
        return '<button type="button" class="chip' + (themeFilter === k ? ' on' : '') + '" data-filter="' + k + '">' + filters[k] + ' <span class="cnt">' + counts[k] + '</span></button>';
      }).join('') + '</div>' +
      '<div class="theme-grid" id="themeGrid"></div></section>' +

      '<section class="mt-10"><h2 class="section-title">Layout <small>13 ways to show your links</small></h2><div class="layout-grid" id="layoutGrid"></div></section>' +

      '<section class="mt-10"><h2 class="section-title">Fine-tuning <small>Applies to every theme</small></h2><div class="panel space-y-5">' +
      '<div class="field-row cols-2"><div><label class="lbl">Accent color</label><div class="color-input"><input type="color" data-bind="page.settings.accent" value="' + esc(s.accent || themeAccent(p.theme)) + '">' +
      '<input class="field" id="accentHex" style="max-width:120px" value="' + esc(s.accent) + '" placeholder="Theme default" maxlength="7">' +
      '<button type="button" class="btn-ghost" id="accentReset"' + (s.accent ? '' : ' hidden') + '>Reset</button></div></div>' +
      '<div><label class="lbl">Font</label><select class="field" data-bind="page.settings.font">' + Object.keys(E.fonts).map(function (k) { return '<option value="' + k + '">' + esc(E.fonts[k]) + '</option>'; }).join('') + '</select></div></div>' +
      '<div class="flex flex-wrap gap-6"><div><label class="lbl">Button shape</label>' + designChips('button', { '': 'Theme default', rounded: 'Rounded', pill: 'Pill', square: 'Square' }, s.button) + '</div>' +
      '<div><label class="lbl">Profile picture shape</label>' + designChips('avatar_shape', { circle: 'Circle', rounded: 'Rounded', square: 'Square' }, s.avatar_shape) + '</div></div>' +
      '</div></section>' +

      '<section class="mt-10"><h2 class="section-title">Effects</h2><div class="panel space-y-5">' +
      '<div><label class="lbl">Animated ring around your profile picture</label><div class="chips">' + [['none', 'No ring', 'background:#3f3f46'], ['accent', 'Accent color', 'background:conic-gradient(' + themeAccent(p.theme) + ',transparent,' + themeAccent(p.theme) + ')'], ['rainbow', 'Rainbow', 'background:conic-gradient(#ff3b3b,#ffb13b,#f7ff3b,#3bff6e,#3bc8ff,#6b3bff,#ff3bd4,#ff3b3b)'], ['story', 'Story', 'background:conic-gradient(#feda75,#fa7e1e,#d62976,#962fbf,#4f5bd5,#feda75)'], ['pulse', 'Pulse', 'background:' + themeAccent(p.theme)]].map(function (r) {
        return '<button type="button" class="chip' + (s.avatar_ring === r[0] ? ' on' : '') + '" data-dset="avatar_ring" data-val="' + r[0] + '"><span class="ring-demo" style="width:18px;height:18px;' + r[2] + '"></span>' + r[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div><label class="lbl">Across the page</label>' + designChips('particles', { none: 'None', snow: '❄️ Snow', confetti: '🎉 Confetti', fireflies: '✨ Fireflies' }, s.particles) + '</div>' +
      '<label class="switch"><input type="checkbox" data-bind="page.settings.cursor_sparks"><span class="track"></span><span class="sw-text">Cursor sparks<small>Little sparks in your accent color follow the mouse or finger</small></span></label>' +
      '<p class="hint"><i class="bx bx-info-circle"></i> You set shine, wobble and pulse for single links right on the link under <b>Content → Effect</b>. Visitors with “Reduce motion” turned on don’t see any animations.</p>' +
      '</div></section>' +

      '<section class="mt-10"><h2 class="section-title">Background image <small>Replaces the theme’s background</small></h2><div class="panel space-y-4">' +
      '<div class="upload-box"><span class="thumb">' + (p.bg_image ? '<img src="' + esc(uploadUrl(p.bg_image)) + '" alt="">' : '<i class="bx bx-image"></i>') + '</span>' +
      '<div class="flex-1 text-sm text-white">' + (p.bg_image ? 'Background image active' : 'No background image') + '</div>' +
      '<button type="button" class="btn-secondary" id="bgUp"><i class="bx bx-upload"></i>' + (p.bg_image ? 'Replace' : 'Upload') + '</button>' +
      (p.bg_image ? '<button type="button" class="icon-btn danger" id="bgDel"><i class="bx bx-trash"></i></button>' : '') + '</div>' +
      (p.bg_image ? '<div><label class="lbl">Darken for better readability <small id="ovVal">' + s.bg_overlay + '%</small></label><input type="range" class="range" min="0" max="90" step="5" data-bind="page.settings.bg_overlay"></div>' : '') +
      '</div></section>' +

      '<section class="mt-10"><h2 class="section-title">Entrance with music <small>Visitors tap to enter</small></h2><div class="panel space-y-5">' +
      '<label class="switch"><input type="checkbox" data-bind="page.settings.entrance.enabled" data-rerender="1"><span class="track"></span><span class="sw-text">Enable entrance<small>Your page opens with an animation and your music starts</small></span></label>' +
      (s.entrance.enabled ?
        '<div class="field-row cols-2"><div><label class="lbl">Entrance text</label><input class="field" data-bind="page.settings.entrance.text" maxlength="60"></div>' +
        '<div><label class="lbl">Animation</label>' + designChips('entrance.animation', { zoom: 'Zoom', fade: 'Fade', curtain: 'Curtain', blur: 'Blur', flip: 'Flip' }, s.entrance.animation) + '</div></div>' +
        '<div><label class="lbl">Music <small>(MP3, M4A, OGG – max. ' + String(Math.min(15, E.uploadLimitMb || 15)) + ' MB)</small></label><div class="upload-box"><span class="thumb"><i class="bx bx-music"></i></span>' +
        '<div class="flex-1 min-w-0"><div class="text-sm text-white truncate">' + (s.entrance.music ? esc(s.entrance.music) : 'No music yet') + '</div>' +
        (s.entrance.music ? '<audio controls preload="none" src="' + esc(uploadUrl(s.entrance.music)) + '" class="mt-2 w-full" style="height:32px"></audio>' : '<div class="text-xs text-gray-500">Starts as soon as someone enters</div>') + '</div>' +
        '<button type="button" class="btn-secondary" id="musicUp"><i class="bx bx-upload"></i>' + (s.entrance.music ? 'Replace' : 'Upload') + '</button>' +
        (s.entrance.music ? '<button type="button" class="icon-btn danger" id="musicDel"><i class="bx bx-trash"></i></button>' : '') + '</div>' +
        '<label class="lbl mt-4">…or paste a link <small>YouTube video, YouTube Music, playlist or an MP3 link</small></label>' +
        '<div class="input-group"><span class="addon left" id="musicLinkIcon"><i class="bx bx-link"></i></span><input class="field" data-bind="page.settings.entrance.music_url" id="musicLink" placeholder="https://youtube.com/watch?v=…" autocomplete="off"></div>' +
        '<p class="hint" id="musicLinkHint"></p></div>' +
        '<div class="field-row cols-2"><div><label class="lbl">Volume <small id="volVal">' + s.entrance.volume + '%</small></label><input type="range" class="range" min="5" max="100" step="5" data-bind="page.settings.entrance.volume"></div>' +
        '<div class="flex items-end"><label class="switch"><input type="checkbox" data-bind="page.settings.entrance.loop"><span class="track"></span><span class="sw-text">Play on loop</span></label></div></div>' +
        '<button type="button" class="btn-secondary" id="testEntrance"><i class="bx bx-play-circle"></i> Test the entrance in the preview</button>'
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
    if (ov) ov.addEventListener('input', function () { $('#ovVal').textContent = ov.value + '%'; });
    var vol = $('[data-bind="page.settings.entrance.volume"]');
    if (vol) vol.addEventListener('input', function () { $('#volVal').textContent = vol.value + '%'; });

    $('#bgUp').addEventListener('click', function () {
      pickFile('image/*').then(function (files) {
        if (!files[0]) return;
        toast('Uploading background…', 'info');
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
        toast('Uploading music…', 'info');
        upload('music', files[0]).then(function (res) {
          if (!res.ok) { toast(res.error, 'err'); return; }
          s.entrance.music = res.file; renderDesign(); markDirty({ fast: true });
        });
      });
    });
    // Hinweis zum Musik-Link: YouTube erkannt? Wird die hochgeladene Datei bevorzugt?
    var musicLink = $('#musicLink');
    function musicLinkHint() {
      var v = (musicLink.value || '').trim(), hint = $('#musicLinkHint'), icon = $('#musicLinkIcon');
      var isYt = detectEmbed(v) === 'youtube', isList = isYt && /[?&]list=/.test(v) && !/[?&]v=|youtu\.be\//.test(v);
      icon.innerHTML = isYt ? '<i class="bx bxl-youtube" style="color:#ff0033"></i>' : '<i class="bx bx-link"></i>';
      if (!v) hint.textContent = 'YouTube only loads after a visitor taps the entrance.';
      else if (s.entrance.music) hint.textContent = 'Your uploaded music is used – remove it to play this link instead.';
      else if (isYt) hint.textContent = isList ? 'YouTube playlist – plays in order after the tap.' : 'YouTube video – only the sound plays, the video stays hidden.';
      else if (/\.(mp3|m4a|ogg|wav)(\?|$)/i.test(v)) hint.textContent = 'Music file – plays directly.';
      else hint.textContent = 'Use a YouTube link or a direct link to an MP3 file.';
    }
    if (musicLink) { musicLink.addEventListener('input', musicLinkHint); musicLinkHint(); }
    var musicDel = $('#musicDel');
    if (musicDel) musicDel.addEventListener('click', function () { s.entrance.music = ''; renderDesign(); markDirty({ fast: true }); });
    var test = $('#testEntrance');
    if (test) test.addEventListener('click', function () { preview.refresh({ entrance: true, top: true }); toast('Tap the entrance in the preview.', 'info'); });
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
      toast('Theme “' + E.themes[th.dataset.theme].name + '” selected.', 'info');
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
      var tag = k === E.defaultTheme ? '<span class="theme-tag std">Default</span>' : t.group === 'special' ? '<span class="theme-tag">Template</span>' : '';
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
    var root = $('#tab-stats');
    if (!root.innerHTML) root.innerHTML = '<div class="empty-state"><i class="bx bx-loader-alt bx-spin"></i>Loading stats…</div>';
    apiGet('stats?range=' + range).then(function (res) {
      if (!res || !res.ok) { root.innerHTML = '<div class="empty-state">Couldn’t load stats.</div>'; return; }
      renderStats(res.stats);
    });
  }

  function renderStats(st) {
    var root = $('#tab-stats');
    var ranges = { 7: '7 days', 30: '30 days', 90: '90 days', 0: 'All time' };
    var maxClicks = st.links.reduce(function (m, l) { return Math.max(m, l.clicks); }, 0) || 1;
    var best = st.best;
    root.innerHTML =
      '<div class="flex flex-wrap items-center justify-between gap-3 mb-5"><h2 class="section-title" style="margin:0">Stats <small>' + esc(prettyUrl(state.page.url)) + '</small></h2>' +
      '<div class="chips">' + [7, 30, 90, 0].map(function (k) { return '<button type="button" class="chip' + (k === st.range ? ' on' : '') + '" data-range="' + k + '">' + ranges[k] + '</button>'; }).join('') + '</div></div>' +
      '<div class="kpis mb-6">' +
      '<div class="kpi" style="--c:#818cf8"><i class="bx bx-show"></i><b>' + fmtNum(st.views) + '</b><span>Views</span></div>' +
      '<div class="kpi" style="--c:#f59e0b"><i class="bx bx-pointer"></i><b>' + fmtNum(st.clicks) + '</b><span>Clicks</span></div>' +
      '<div class="kpi" style="--c:#22c55e"><i class="bx bx-trending-up"></i><b>' + String(st.ctr) + '%</b><span>Click rate</span></div>' +
      '<div class="kpi best" style="--c:#ec4899"><i class="bx bx-trophy"></i><b>' + (best ? esc(best.title) : '–') + '</b><span>' + (best ? 'Best link · ' + plural(best.clicks, 'click', 'clicks') : 'Best link') + '</span></div>' +
      '</div>' +
      '<div class="panel mb-6"><div class="flex items-center justify-between mb-3"><b class="text-white text-sm">Over time' + (st.bucket > 1 ? ' (per week)' : '') + '</b><div class="legend"><span><i style="background:#6366f1"></i>Views</span><span><i style="background:#f59e0b"></i>Clicks</span></div></div>' + chartSvg(st.series) + '</div>' +
      '<h3 class="section-title">Clicks per link <small>All time: ' + fmtNum(st.total_views) + ' views</small></h3>' +
      '<div class="panel" style="padding:0">' + (st.links.length ? st.links.map(function (l) {
        var ic = l.icon && l.icon.indexOf('brand:') === 0 ? brandSvg(l.icon.slice(6)) : l.icon && l.icon.indexOf('bx') === 0 ? '<i class="' + esc(l.icon) + '"></i>' : (detectBrand(l.url || '') ? brandSvg(detectBrand(l.url)) : '<i class="bx bx-link"></i>');
        return '<div class="stat-row"><div class="t"><span class="stat-ico">' + ic + '</span><span class="min-w-0"><b>' + esc(l.title) + '</b><small>' + esc(l.kind) + (l.url ? ' · ' + esc(prettyUrl(l.url)) : '') + '</small></span></div>' +
          '<div class="n">' + fmtNum(l.clicks) + (l.total != null ? '<small>' + fmtNum(l.total) + ' total</small>' : '') + '</div>' +
          '<div class="bar-bg"><span style="width:' + Math.round(l.clicks / maxClicks * 100) + '%"></span></div></div>';
      }).join('') : '<div class="empty-state"><i class="bx bx-bar-chart-alt-2"></i>No links with clicks yet.</div>') + '</div>' +
      '<div class="privacy-note mt-6"><i class="bx bx-shield-quarter"></i><span><b>Stats without cookies:</b> Only views and clicks per day are counted – no cookies, no IP addresses, no fingerprinting. So there’s no cookie banner for your visitors.</span></div>';
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
      svg += '<rect class="bar" x="' + (x + bw * .18) + '" y="' + (H - pb - bh) + '" width="' + Math.max(1, bw * .64) + '" height="' + Math.max(0, bh) + '" rx="2"><title>' + fmtDate(d.day, true) + ': ' + plural(d.views, 'view', 'views') + ', ' + plural(d.clicks, 'click', 'clicks') + '</title></rect>';
      pts.push((x + bw / 2) + ',' + y(d.clicks));
      var every = Math.ceil(n / 8);
      if (i % every === 0 || i === n - 1) svg += '<text x="' + (x + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + fmtDate(d.day) + '</text>';
    });
    svg += '<polyline class="line" points="' + pts.join(' ') + '"/>';
    if (n <= 31) pts.forEach(function (p) { var xy = p.split(','); svg += '<circle class="pt" cx="' + xy[0] + '" cy="' + xy[1] + '" r="2.5"/>'; });
    return svg + '</svg>';
  }

  // ================================================================
  // Tab: Nachrichten
  // ================================================================
  // refocus: nach dem Löschen – der Knopf verschwand mit der Zeile, der Fokus bleibt in der Liste
  function loadMessages(refocus) {
    var root = $('#tab-messages');
    if (!root.innerHTML) root.innerHTML = '<div class="empty-state"><i class="bx bx-loader-alt bx-spin"></i>Loading messages…</div>';
    apiGet('messages').then(function (res) {
      if (!res || !res.ok) { root.innerHTML = '<div class="empty-state">Couldn’t load messages.</div>'; return; }
      renderMessages(res);
      refreshBell();
      var a = document.activeElement;
      if (refocus === true && (!a || a === document.body || !a.isConnected)) {
        var n = $('#tab-messages [data-msg-act], #tab-messages [data-booking-del]') || $('#mainNav [data-tab="messages"]');
        if (n) n.focus({ preventScroll: true });
      }
    });
  }

  function renderMessages(res) {
    var root = $('#tab-messages');
    var unread = res.messages.filter(function (m) { return !m.read; }).length;
    // Ohne Seite gibt es nichts, wohin ein Kontaktformular käme
    var hasContact = !state.page || state.blocks.some(function (b) { return b.type === 'contact'; });
    root.innerHTML =
      '<h2 class="section-title">Messages <small>' + (unread ? plural(unread, 'unread', 'unread') : 'All read') + '</small></h2>' +
      (!hasContact ? '<div class="panel mb-4 flex flex-wrap items-center gap-3 justify-between"><span class="text-sm text-gray-400"><i class="bx bx-info-circle text-brand-400"></i> Add a <b class="text-white">contact form</b> to your page so visitors can message you.</span><button type="button" class="btn-secondary" id="addContact"><i class="bx bx-plus"></i> Contact form</button></div>' : '') +
      (res.messages.length ? res.messages.map(function (m) {
        return '<div class="msg' + (m.read ? '' : ' unread') + '" data-msg="' + m.id + '"><div class="msg-head"><span class="msg-av">' + esc(initials(m.name)) + '</span>' +
          '<span class="min-w-0"><b>' + esc(m.name) + '</b><small>' + esc(m.email) + ' · ' + esc(m.ago) + (state.pages.length > 1 ? ' · ' + esc(m.page) : '') + '</small></span>' +
          '<span class="msg-actions"><a class="icon-btn" title="Reply" href="mailto:' + encodeURIComponent(m.email) + '?subject=' + encodeURIComponent('Re: Your message') + '"><i class="bx bx-reply"></i></a>' +
          '<button type="button" class="icon-btn" data-msg-act="' + (m.read ? 'unread' : 'read') + '" title="' + (m.read ? 'Mark as unread' : 'Mark as read') + '"><i class="bx ' + (m.read ? 'bx-envelope' : 'bx-envelope-open') + '"></i></button>' +
          '<button type="button" class="icon-btn danger" data-msg-act="delete" title="Delete"><i class="bx bx-trash"></i></button></span></div>' +
          '<div class="msg-text">' + esc(m.message) + '</div></div>';
      }).join('') : '<div class="panel empty-state"><i class="bx bx-envelope"></i>No messages yet.</div>') +

      '<h2 class="section-title mt-10">Booking requests <small>Via the built-in calendar</small></h2>' +
      (res.bookings.length ? '<div class="panel" style="padding:0">' + res.bookings.map(function (b) {
        return '<div class="stat-row" data-booking="' + b.id + '" style="grid-template-columns:1fr auto"><div class="t"><span class="stat-ico"><i class="bx bx-calendar"></i></span><span class="min-w-0"><b>' + esc(b.date) + ' · ' + esc(b.time) + (b.past ? ' <span class="bdg">past</span>' : '') + '</b><small>' + esc(b.name) + ' · <a class="hover:text-white" href="mailto:' + encodeURIComponent(b.email) + '">' + esc(b.email) + '</a></small></span></div>' +
          '<button type="button" class="icon-btn danger" data-booking-del="' + b.id + '" title="Delete"><i class="bx bx-trash"></i></button></div>';
      }).join('') + '</div>' : '<div class="panel empty-state"><i class="bx bx-calendar-x"></i>No booking requests yet. Add a “Book a meeting” block.</div>');

    var add = $('#addContact');
    if (add) add.addEventListener('click', function () {
      var b = newBlock('contact');
      state.blocks.push(b);
      openBlocks[b.id] = true;
      switchTab('content');
      renderBlocks();
      markDirty({ fast: true });
      scrollToBlock(b.id);
    });
    $$('[data-msg-act]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.closest('[data-msg]').dataset.msg);
        var act = btn.dataset.msgAct;
        if (act !== 'delete') { api('message', { id: id, action: act }).then(function () { loadMessages(); }); return; }
        var m = res.messages.filter(function (x) { return x.id === id; })[0] || {};
        // Löschen läuft im Dialog; der Server löscht nach ID und Konto (mehrfach unschädlich)
        UI.confirm({
          title: 'Delete this message?', text: 'The message from ' + (m.name || 'this visitor') + ' is deleted for good.', ok: 'Delete', tone: 'danger',
          fallbackFocus: function () { return $('#tab-messages [data-msg-act]') || $('#mainNav [data-tab="messages"]'); },
          onConfirm: function () {
            return api('message', { id: id, action: 'delete' }).then(function (r) {
              if (!r || !r.ok) return (r && r.error) || 'Something went wrong. Please try again.';
              toast('Message deleted.');
              loadMessages(true);
            });
          }
        });
      });
    });
    $$('[data-booking-del]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.dataset.bookingDel);
        var bk = res.bookings.filter(function (x) { return x.id === id; })[0] || {};
        UI.confirm({
          title: 'Delete this booking request?', text: [bk.date, bk.time].filter(Boolean).join(' · ') + ' from ' + (bk.name || 'this visitor') + ' is deleted for good.',
          ok: 'Delete', tone: 'danger',
          fallbackFocus: function () { return $('#tab-messages [data-booking-del]') || $('#mainNav [data-tab="messages"]'); },
          onConfirm: function () {
            return api('booking-delete', { id: id }).then(function (r) {
              if (!r || !r.ok) return (r && r.error) || 'Something went wrong. Please try again.';
              toast('Booking request deleted.');
              loadMessages(true);
            });
          }
        });
      });
    });
  }

  // ================================================================
  // Honigwaben: Kontostand oben – der Knopf öffnet den Bereich „Honeycombs“
  // ================================================================
  var hc = E.honeycombs || { balance: 0, earned: [], history: [], rules: {} };
  function setBalance(n, pop) {
    hc.balance = n;
    $('#hcBalance').textContent = fmtNum(n);
    if (pop) { var b = $('#hcBtn'); b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  }

  // ================================================================
  // Tab: Honeycombs – Shop, eigene Freischaltungen, Verdienen und Verlauf (Stand vom Server: /dashboard/api/shop)
  // ================================================================
  // st: Stand vom Server · sel: gewählte Option je Funktion · focus: Ziel nach dem Laden (Funktion, earn, history)
  var shop = { st: null, loading: false, focus: '', sel: {}, hist: null, next: null, histLoading: false };
  var BX_ICON = /^bx[sl]?-[a-z0-9-]+$/;
  function bxIcon(name, fallback) { return BX_ICON.test(name || '') ? name : fallback; }
  function lcFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }

  // Bereich öffnen und zu einer Karte (Funktion), „earn“ oder „history“ springen – auch aus anderen Bereichen
  // (Pill oben, /dashboard#honeycombs/<ziel>, „Get Premium“)
  function openShop(target) {
    closeDropdowns();
    shop.focus = /^[a-z0-9_-]{1,40}$/.test(target || '') ? target : '';
    if (activeTab !== 'honeycombs') switchTab('honeycombs');
    else if (shop.st && !shop.loading) shopFocus();
  }

  // Bei jedem Öffnen neu laden (Preise und Angebote ändern sich); der alte Stand bleibt sichtbar, bis der neue da ist
  function loadShop() {
    var root = $('#tab-honeycombs');
    if (!root || shop.loading) return;
    shop.loading = true;
    if (!shop.st) root.innerHTML = '<div class="empty-state"><i class="bx bx-loader-alt bx-spin"></i>Loading…</div>';
    var hist = apiGet('hc-history');
    apiGet('shop').then(function (res) {
      return hist.then(function (h) {
        shop.loading = false;
        if (!res || !res.ok || !res.shop) {
          shop.st = null;
          shop.focus = '';
          root.innerHTML = '<div class="panel empty-state"><i class="bx bx-error-circle"></i>Couldn’t load your honeycombs – please reload.</div>';
          return;
        }
        shop.st = res.shop;
        if (h && h.ok) { shop.hist = h.items; shop.next = h.next; }
        setBalance(res.shop.balance);
        if (activeTab !== 'honeycombs') return;
        renderShop();
        shopFocus();
      });
    });
  }

  function shopFocus() {
    var t = shop.focus;
    shop.focus = '';
    if (!t) return;
    var el = t === 'earn' ? $('#shopEarn') : t === 'history' ? $('#shopHistory') : $('#shop-' + t);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (el.classList.contains('shop-card')) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }

  function shopCard(feature) {
    var list = shop.st ? shop.st.features : [];
    for (var i = 0; i < list.length; i++) if (list[i].feature === feature) return list[i];
    return null;
  }
  // Gewählte Option einer Karte: die zuletzt gewählte, sonst die erste, die dieses Konto kaufen kann
  function shopSel(c) {
    var o = null;
    c.options.forEach(function (x) { if (x.item === shop.sel[c.feature]) o = x; });
    if (!o) o = c.options.filter(function (x) { return !x.note; })[0] || c.options[0];
    shop.sel[c.feature] = o.item;
    return o;
  }

  function shopBanner(kind, icon, text) {
    return '<div class="shop-banner ' + kind + '"><i class="bx ' + icon + '"></i><span>' + esc(text) + '</span></div>';
  }

  function renderShop() {
    var st = shop.st, root = $('#tab-honeycombs'), html = '';
    if (st.readOnly) html += shopBanner('info', 'bx-mask', 'Admin mode – you can look around, but buying is turned off. Use the admin area to give honeycombs or unlocks.');
    if (st.frozen) {
      html += shopBanner('warn', 'bx-pause-circle', 'Your honeycombs are on hold' + (st.frozenReason ? ': ' + st.frozenReason.replace(/[.\s]+$/, '') : '') +
        '. Earning and buying are paused – your unlocks keep working.');
    }
    html += '<div class="panel shop-wallet"><div class="hc-big"><i class="bx bx-hive"></i><div><b>' + fmtNum(st.balance) + '</b><small>honeycombs</small></div></div>' +
      '<div class="shop-wallet-actions"><button type="button" class="btn-ghost" data-shop-go="earn"><i class="bx bx-trending-up"></i> How to earn</button>' +
      '<button type="button" class="btn-ghost" data-shop-go="history"><i class="bx bx-history"></i> History</button></div></div>';
    html += '<h2 class="section-title mt-8">Unlock</h2>' + (st.features.length
      ? '<div class="shop-grid">' + st.features.map(shopCardHtml).join('') + '</div>'
      : '<div class="panel empty-state"><i class="bx bx-store-alt"></i>Nothing to unlock right now – check back soon.</div>');
    html += '<h2 class="section-title mt-8">Your unlocks</h2>' + (st.owned.length
      ? '<div class="panel"><div class="hc-rules">' + st.owned.map(ownedHtml).join('') + '</div></div>'
      : '<div class="panel"><p class="hint m-0">Nothing unlocked yet. Pick something above.</p></div>');
    html += '<h2 class="section-title mt-8" id="shopEarn">Earn honeycombs</h2><div class="hc-rules">' + st.earn.rules.map(earnHtml).join('') + '</div>';
    html += '<h2 class="section-title mt-8" id="shopHistory">History</h2><div class="panel" id="shopHist">' + histHtml() + '</div>';
    root.innerHTML = html;
  }

  function shopCardHtml(c) {
    var o = shopSel(c);
    var html = '<div class="panel shop-card" id="shop-' + esc(c.feature) + '" data-feature="' + esc(c.feature) + '">' +
      '<div class="shop-card-head"><span class="code-mini-ico"><i class="bx ' + esc(bxIcon(c.icon, 'bx-hive')) + '"></i></span>' +
      '<div class="min-w-0"><h3>' + esc(c.title) + '</h3><p>' + esc(c.description) + '</p></div></div>';
    if (c.perks.length) html += '<ul class="shop-perks">' + c.perks.map(function (p) { return '<li><i class="bx bx-check"></i><span>' + esc(p) + '</span></li>'; }).join('') + '</ul>';
    if (c.options.length > 1) {
      html += '<div class="chips">' + c.options.map(function (x) {
        return '<button type="button" class="chip' + (x.item === o.item ? ' on' : '') + '" data-shop-opt="' + esc(x.item) + '">' + esc(x.label) + '</button>';
      }).join('') + '</div>';
    }
    return html + shopPriceHtml(o) + '<div class="shop-foot">' + shopActionHtml(c, o) + '</div></div>';
  }

  function shopPriceHtml(o) {
    var html = '<div class="shop-price"><i class="bx bx-hive hc-icon"></i><b>' + (o.price === 0 ? 'Free' : fmtNum(o.price)) + '</b>' +
      (o.offer && o.listPrice > o.price ? '<s>' + fmtNum(o.listPrice) + '</s>' : '') + '</div>';
    var badges = '';
    if (o.offer) {
      badges += '<span class="bdg hc"><i class="bx bx-purchase-tag"></i> ' + esc(o.offer.label) + ' · ' +
        (o.offer.percentOff ? '−' + o.offer.percentOff + ' % · ' : '') + 'ends ' + esc(fmtDate(o.offer.endsAt)) + '</span>';
    }
    if (o.availableUntil) badges += '<span class="bdg amber"><i class="bx bx-time-five"></i> Limited · until ' + esc(fmtDate(o.availableUntil)) + '</span>';
    return html + (badges ? '<div class="shop-badges">' + badges + '</div>' : '');
  }

  function shopNote(text, icon) {
    return text ? '<p class="shop-note"><i class="bx ' + (icon || 'bx-lock-alt') + '"></i><span>' + esc(text) + '</span></p>' : '';
  }

  // Knopf oder Grund unter dem Preis (der Server prüft beim Kauf trotzdem alles noch einmal)
  function shopActionHtml(c, o) {
    var st = shop.st;
    if (c.state === 'owned') {
      return '<span class="bdg green"><i class="bx bx-check"></i> Owned</span>' +
        (c.href && c.href.indexOf('#honeycombs') !== 0 ? '<button type="button" class="btn-secondary" data-shop-open="' + esc(c.feature) + '">Open</button>' : '') +
        shopNote(c.note, 'bx-check-circle');
    }
    if (c.state === 'included') return '<span class="bdg green"><i class="bx bx-check"></i> Included</span>' + shopNote(c.note, 'bx-check-circle');
    if (c.state === 'max' || c.state === 'locked') return shopNote(c.note);
    if (o.note) return shopNote(o.note);
    var packs = c.stack > 1 && c.lotsActive ? '<span class="bdg">' + c.lotsActive + ' of ' + c.stack + ' packs</span>' : '';
    if (!o.affordable) {
      return packs + '<button type="button" class="btn-primary" disabled><i class="bx bx-lock-alt"></i> ' + fmtNum(o.price - st.balance) + ' more needed</button>' +
        '<button type="button" class="shop-link" data-shop-go="earn">How to earn honeycombs</button>';
    }
    var off = st.readOnly ? 'Buying is turned off in admin mode.' : st.frozen ? 'Your honeycombs are on hold.' : '';
    return packs + '<button type="button" class="btn-primary" data-shop-buy="' + esc(c.feature) + '"' + (off ? ' disabled title="' + esc(off) + '"' : '') + '>' +
      '<i class="bx bx-lock-open-alt"></i> ' + esc(buyLabel(c, o.price)) + '</button>';
  }
  function buyLabel(c, price) {
    if (price === 0) return 'Get it free';
    return (c.kind === 'timed' && c.activeUntil && c.stack === 1 ? 'Extend for ' : 'Buy for ') + fmtNum(price);
  }

  function ownedHtml(u) {
    var status, cls = '', btn = '', c = shopCard(u.feature);
    if (u.active && u.permanent) {
      status = u.kind === 'count' || u.kind === 'consumable' ? 'You have ' + fmtNum(u.quantity) : 'Unlocked for good';
    } else if (u.active) {
      status = (c && c.stack > 1 ? 'Pack ' + (u.lot + 1) + ' · until ' : 'Active until ') + fmtDate(u.expiresAt, true);
      if (u.endsInDays !== null && u.endsInDays <= 3) {
        status = u.endsInDays <= 0 ? 'Ends today' : 'Ends in ' + plural(u.endsInDays, 'day', 'days');
        cls = ' soon';
      }
    } else {
      status = 'Ended on ' + fmtDate(u.expiresAt) + ' – paused, your content is kept';
      cls = ' ended';
      if (c) btn = '<button type="button" class="btn-secondary" data-shop-renew="' + esc(u.feature) + '">Renew</button>';
    }
    if (u.source === 'admin') status += ' · from the team';
    return '<div class="hc-rule' + cls + '"><span class="ri"><i class="bx ' + esc(bxIcon(u.icon, 'bx-hive')) + '"></i></span>' +
      '<span class="min-w-0"><b>' + esc(u.title) + '</b><small>' + esc(status) + '</small></span>' + btn + '</div>';
  }

  function earnHtml(r) {
    var p = r.progress && r.progress.goal > 0 ? r.progress : null;
    var text = r.done ? r.doneText : r.text + (p ? ' (' + fmtNum(p.value) + ' of ' + fmtNum(p.goal) + ' collected)' : '');
    return '<div class="hc-rule' + (r.done ? ' done' : '') + '"><span class="ri"><i class="bx ' + esc(r.done ? 'bx-check' : bxIcon(r.icon, 'bx-hive')) + '"></i></span>' +
      '<div class="min-w-0 flex-1"><b>' + esc(r.title) + '</b><small>' + esc(text) + '</small>' +
      (p && !r.done ? '<div class="hc-bar mt-2"><span style="width:' + Math.min(100, Math.round(p.value / p.goal * 100)) + '%"></span></div>' : '') + '</div>' +
      (r.amount ? '<span class="amt">+' + fmtNum(r.amount) + '</span>' : '') + '</div>';
  }

  function histHtml() {
    if (!shop.hist || !shop.hist.length) return '<p class="hint m-0">Nothing yet – your first honeycombs are on their way.</p>';
    return shop.hist.map(function (x) {
      var cls = x.amount > 0 ? 'plus' : x.amount < 0 ? 'minus' : 'zero';
      return '<div class="hc-hist-row"><span class="min-w-0">' + esc(x.text) + '<small>' + esc(fmtDate(x.at, true)) + '</small></span>' +
        '<span class="amt ' + cls + '">' + (x.amount > 0 ? '+' + fmtNum(x.amount) : x.amount < 0 ? '−' + fmtNum(-x.amount) : 'free') + '</span></div>';
    }).join('') + (shop.next ? '<button type="button" class="btn-ghost w-full justify-center mt-2" data-shop-more>Show more</button>' : '');
  }

  function moreHistory(btn) {
    if (shop.histLoading || !shop.next) return;
    shop.histLoading = true;
    btn.disabled = true;
    apiGet('hc-history?before=' + encodeURIComponent(shop.next)).then(function (h) {
      shop.histLoading = false;
      if (!h || !h.ok) { btn.disabled = false; toast((h && h.error) || 'Couldn’t load more – please try again.', 'err'); return; }
      shop.hist = (shop.hist || []).concat(h.items);
      shop.next = h.next;
      var box = $('#shopHist');
      if (box) box.innerHTML = histHtml();
    });
  }

  // Regeln zum Ankreuzen im Kaufdialog (Funktionen mit needsTerms)
  function shopTermsHtml(feature, checked) {
    var text = feature === 'code_page'
      ? 'I’ve read the <a href="' + esc(E.codeTerms) + '" target="_blank" rel="noopener">rules for code pages</a>. My page won’t sell anything or make money – it’s only there to inform or to promote something.'
      : 'I’ve read and accept the <a href="/terms" target="_blank" rel="noopener">rules</a> for this.';
    return '<label class="code-terms"><input type="checkbox" name="terms"' + (checked ? ' checked' : '') + '><span>' + text + '</span></label>';
  }

  // Ende eines Zeitraums für den Text im Dialog (der Server rechnet beim Kauf genau so: ab dem laufenden Ende, sonst ab jetzt)
  function periodEnd(c, o, mode) {
    var from = new Date();
    if (c.activeUntil && (c.stack === 1 || mode === 'extend')) {
      var p = String(c.activeUntil).split(/\D/), until = new Date(+p[0], p[1] - 1, +p[2], +p[3] || 0, +p[4] || 0);
      if (until > from) from = until;
    }
    from.setDate(from.getDate() + (o.days || 0));
    return from.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function shopDialogTitle(c, o) {
    if (c.kind === 'permanent') return /^more /i.test(c.title) ? 'Unlock ' + lcFirst(c.title) + '?' : 'Unlock your ' + lcFirst(c.title) + '?';
    if (c.kind === 'timed') return c.title + ' for ' + o.label + '?';
    return 'Get ' + c.title + ' (' + o.label + ')?';
  }

  // Kaufdialog: Kennung beim Öffnen (Doppelklick und erneutes Senden buchen einmal), der gezeigte Preis geht mit.
  // Neuer Preis vom Server: der Dialog bleibt offen, zeigt ihn und kauft mit derselben Kennung zum neuen Preis.
  function openPurchase(feature) {
    var st = shop.st, c = shopCard(feature);
    if (!st || !c || st.readOnly || st.frozen) return;
    var o = shopSel(c), rid = purchaseId(), price = o.price, terms = false;
    var mode = c.stack > 1 ? (c.lotsActive < c.stack ? 'stack' : 'extend') : '';
    function content(body) {
      var left = st.balance - price, line;
      if (c.kind === 'permanent') line = 'You unlock it once and keep it for good.';
      else if (c.kind === 'timed') line = c.title + ' runs until ' + periodEnd(c, o, mode) + '.';
      else line = 'You get ' + o.label + '.';
      var html = '<div class="hc-big mb-4"><i class="bx bx-hive"></i><div><b>' + fmtNum(price) + '</b><small>honeycombs · you have ' + fmtNum(st.balance) + '</small></div></div>' +
        '<p class="text-sm text-gray-400">' + esc(line) + ' ' + esc(left >= 0 ? 'Afterwards you have ' + fmtNum(left) + ' honeycombs left.' : 'You need ' + fmtNum(-left) + ' more honeycombs.') + '</p>';
      if (c.perks.length) html += '<ul class="shop-perks mt-3">' + c.perks.map(function (p) { return '<li><i class="bx bx-check"></i><span>' + esc(p) + '</span></li>'; }).join('') + '</ul>';
      if (c.stack > 1) {
        html += '<div class="shop-mode mt-4">' +
          '<label class="code-terms"><input type="radio" name="mode" value="stack"' + (mode === 'stack' ? ' checked' : '') + (c.lotsActive >= c.stack ? ' disabled' : '') + '><span>Add a pack</span></label>' +
          '<label class="code-terms"><input type="radio" name="mode" value="extend"' + (mode === 'extend' ? ' checked' : '') + (c.lotsActive ? '' : ' disabled') + '><span>Extend the pack that ends first</span></label></div>';
      }
      if (c.needsTerms) html += '<div class="mt-4">' + shopTermsHtml(c.feature, terms) + '</div>';
      body.innerHTML = html;
    }
    UI.confirm({
      title: shopDialogTitle(c, o),
      tone: 'hc',
      icon: 'bx-hive',
      ok: buyLabel(c, price),
      content: content,
      canConfirm: function (v) { return (!c.needsTerms || v.terms === true) && st.balance >= price; },
      fallbackFocus: function () { return $('#shop-' + c.feature + ' [data-shop-buy]') || $('#mainNav [data-tab="honeycombs"]'); },
      onConfirm: function (v, ctl) {
        terms = v.terms === true;
        if (v.mode === 'stack' || v.mode === 'extend') mode = v.mode;
        return api('shop-buy', { item: o.item, request_id: rid, expected_price: price, terms: terms, mode: mode || undefined }).then(function (res) {
          if (res && res.code === 'price_changed' && typeof res.price === 'number') {
            var was = price;
            price = res.price;
            ctl.update({ ok: buyLabel(c, price), content: content });
            return 'The price changed – this now costs ' + fmtNum(price) + ' honeycombs (it was ' + fmtNum(was) + ').';
          }
          if (!res || !res.ok) return (res && res.error) || 'Something went wrong. Please try again.';
          afterPurchase(res, c);
        });
      }
    });
  }

  // Nach dem Kauf: neuer Stand, Kontostand oben, Verlauf neu; den Code-Tab beim nächsten Öffnen frisch laden (ohne
  // ungespeicherte Dateien zu verwerfen – die gibt es nur, wenn schon eine Code-Seite besteht)
  function afterPurchase(res, c) {
    shop.st = res.shop;
    setBalance(res.shop.balance, true);
    if (c.feature === 'code_page') hc.codeUnlocked = true;
    if (code.st) {
      if (!code.st.site) { code.st = null; $('#tab-code').innerHTML = ''; } else code.st.balance = res.shop.balance;
    }
    if (activeTab === 'honeycombs') renderShop();
    apiGet('hc-history').then(function (h) {
      if (!h || !h.ok) return;
      shop.hist = h.items;
      shop.next = h.next;
      var box = $('#shopHist');
      if (box) box.innerHTML = histHtml();
    });
  }

  function renewFeature(feature) {
    var c = shopCard(feature);
    if (!c) return;
    var o = shopSel(c);
    if (c.state === 'buy' && !o.note && o.affordable && !shop.st.readOnly && !shop.st.frozen) { openPurchase(feature); return; }
    shop.focus = feature;
    shopFocus();
  }

  var shopRoot = $('#tab-honeycombs');
  if (shopRoot) {
    shopRoot.addEventListener('click', function (ev) {
      var t = ev.target, el;
      if ((el = t.closest('[data-shop-opt]'))) {
        var card = el.closest('.shop-card'), c = card && shopCard(card.dataset.feature);
        if (!c) return;
        shop.sel[c.feature] = el.dataset.shopOpt;
        card.replaceWith(h(shopCardHtml(c)));
        var again = $('#shop-' + c.feature + ' [data-shop-opt="' + el.dataset.shopOpt + '"]');
        if (again) again.focus();
        return;
      }
      if ((el = t.closest('[data-shop-buy]'))) { openPurchase(el.dataset.shopBuy); return; }
      if ((el = t.closest('[data-shop-renew]'))) { renewFeature(el.dataset.shopRenew); return; }
      if ((el = t.closest('[data-shop-go]'))) { shop.focus = el.dataset.shopGo; shopFocus(); return; }
      if ((el = t.closest('[data-shop-open]'))) {
        var oc = shopCard(el.dataset.shopOpen);
        if (oc && oc.href) deepLink(oc.href);
        return;
      }
      if ((el = t.closest('[data-shop-more]'))) moreHistory(el);
    });
  }

  // ================================================================
  // Tab: Code-Seite – eigene Website aus HTML, CSS und JavaScript
  // ================================================================
  var code = { st: null, files: {}, saved: {}, cur: 'index.html', docs: {}, cm: null, saving: false, loading: false, state: '', previewed: false };
  var CODE_PATH = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?:\/[a-z0-9_-]+(?:\.[a-z0-9_-]+)*){0,3}$/;
  var CODE_ICONS = { html: 'bxl-html5', htm: 'bxl-html5', css: 'bxl-css3', js: 'bxl-javascript', mjs: 'bxl-javascript', json: 'bx-code-curly', svg: 'bx-shape-polygon', xml: 'bx-code', md: 'bx-file', txt: 'bx-file', webmanifest: 'bx-mobile-alt' };
  var utf8 = window.TextEncoder ? new TextEncoder() : null;
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function utf8Len(s) { return utf8 ? utf8.encode(s).length : unescape(encodeURIComponent(s)).length; }
  function fmtBytes(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B'; }
  function codeExt(p) { var m = /\.([a-z0-9]+)$/.exec(p); return m ? m[1] : ''; }
  function codeMode(p) {
    var x = codeExt(p);
    if (x === 'html' || x === 'htm') return 'htmlmixed';
    if (x === 'css') return 'css';
    if (x === 'js' || x === 'mjs') return 'javascript';
    if (x === 'json' || x === 'webmanifest') return { name: 'javascript', json: true };
    if (x === 'svg' || x === 'xml') return 'xml';
    return null;
  }
  // gleiche Regeln wie oys_code_valid_path() auf dem Server
  function codeCheckPath(p) {
    p = String(p || '').trim().toLowerCase().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!p || p.length > 120 || !CODE_PATH.test(p)) return { error: 'Use lowercase letters, numbers, - and _ – folders with “/”, e.g. about.html or css/theme.css.' };
    var types = code.st.site.limits.types;
    if (types.indexOf(codeExt(p)) === -1) return { error: 'Allowed file types: ' + types.join(', ') + '.' };
    return { path: p };
  }
  function codeSort(a, b) {
    if (a === 'index.html') return -1;
    if (b === 'index.html') return 1;
    var da = a.indexOf('/') !== -1, db = b.indexOf('/') !== -1;
    return da !== db ? (da ? 1 : -1) : a < b ? -1 : a > b ? 1 : 0;
  }
  function codeUnsaved() {
    if (!code.st || !code.st.site) return false;
    var k;
    for (k in code.files) if (has(code.files, k) && code.files[k] !== code.saved[k]) return true;
    for (k in code.saved) if (has(code.saved, k) && !has(code.files, k)) return true;
    return false;
  }
  function codeErr(box, msg) {
    var el = $('#codeErr', box);
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
  }

  function loadCode() {
    var root = $('#tab-code');
    codeLayout();
    if (code.st) {
      if (!root.innerHTML) renderCode();
      else if (code.cm) setTimeout(function () { code.cm.refresh(); }, 0); // war ausgeblendet
      codePreview();
      return;
    }
    if (code.loading) return;
    code.loading = true;
    root.innerHTML = '<div class="empty-state"><i class="bx bx-loader-alt bx-spin"></i>Loading…</div>';
    apiGet('code').then(function (res) {
      code.loading = false;
      if (!res || !res.ok) { root.innerHTML = '<div class="panel empty-state"><i class="bx bx-error-circle"></i>Couldn’t load your code page – please reload.</div>'; return; }
      setCodeState(res);
      renderCode();
      draft.offerCode();
    });
  }

  // Antwort vom Server übernehmen. keepEdits: eigene, noch nicht gespeicherte Änderungen behalten
  function setCodeState(res, keepEdits) {
    code.st = res;
    setBalance(res.balance);
    hc.codeUnlocked = res.unlocked;
    if (res.site) {
      if (!keepEdits) { code.files = clone(res.site.files); code.docs = {}; }
      code.saved = clone(res.site.files);
      if (!has(code.files, code.cur)) code.cur = has(code.files, 'index.html') ? 'index.html' : Object.keys(code.files).sort(codeSort)[0];
    }
    codeLayout();
  }

  // Ohne Code-Seite gibt es nichts in der Handy-Vorschau zu zeigen
  function codeLayout() {
    var hide = !(code.st && code.st.site) || !state.page;
    if (document.body.classList.contains('code-nosite') === hide) return;
    document.body.classList.toggle('code-nosite', hide);
    fitPhone(); // die Vorschau war evtl. ausgeblendet und muss neu vermessen werden
  }

  function renderCode() {
    var st = code.st, root = $('#tab-code');
    if (!st.unlocked) root.innerHTML = codeLockedHtml(st);
    else if (!st.site) root.innerHTML = codeCreateHtml(st);
    else renderCodeEditor();
    paintSave(activeTab === 'code' ? code.state : pageSaveState);
  }

  function codeTermsHtml() {
    return '<label class="code-terms"><input type="checkbox" id="codeTerms"><span>I’ve read the <a href="' + esc(E.codeTerms) + '" target="_blank" rel="noopener">rules for code pages</a>. My page won’t sell anything or make money – it’s only there to inform or to promote something.</span></label>';
  }

  function codeLockedHtml(st) {
    var enough = st.balance >= st.cost;
    var pct = st.cost > 0 ? Math.min(100, Math.round(st.balance / st.cost * 100)) : 100;
    return '<div class="panel code-hero">' +
      '<div class="code-hero-ico"><i class="bx bx-code-alt"></i></div>' +
      '<span class="bdg hc"><i class="bx bx-hive"></i> Unlock with honeycombs</span>' +
      '<h2>Your own website on OnYourSite</h2>' +
      '<p>Build your own page with HTML, CSS and JavaScript and host it at <b class="text-white">yourname.' + esc(E.baseHost) + '</b> – for everyone who wants more than a link page.</p>' +
      '<ul class="code-feats">' +
        '<li><i class="bx bx-check"></i> Code editor with syntax highlighting</li>' +
        '<li><i class="bx bx-check"></i> Up to 30 files: HTML, CSS, JS, JSON, SVG …</li>' +
        '<li><i class="bx bx-check"></i> Your own address – live as soon as you save</li>' +
        '<li><i class="bx bx-check"></i> Use the images you upload</li>' +
      '</ul>' +
      '<div class="code-price">' +
        '<div class="flex items-center justify-between text-sm mb-2"><span class="text-gray-400">Your honeycombs</span><b class="text-white">' + fmtNum(st.balance) + ' / ' + fmtNum(st.cost) + ' <i class="bx bx-hive hc-icon"></i></b></div>' +
        '<div class="hc-bar"><span style="width:' + pct + '%"></span></div>' +
        '<button type="button" class="btn-primary w-full justify-center mt-4" data-code="unlock"' + (enough ? '' : ' disabled') + '><i class="bx bx-lock-open-alt"></i> ' +
          (enough ? 'Unlock for ' + fmtNum(st.cost) + ' honeycombs' : fmtNum(st.cost - st.balance) + ' more honeycombs needed') + '</button>' +
        '<button type="button" class="btn-ghost w-full justify-center mt-2" data-action="honeycombs" data-feature="earn"><i class="bx bx-hive hc-icon"></i> How to earn honeycombs</button>' +
      '</div>' +
      '<p class="hint mt-6">Code pages are for personal, informational and promotional pages – no shops and no selling. <a href="' + esc(E.codeTerms) + '" target="_blank" rel="noopener" class="text-brand-400 hover:text-white">Rules for code pages</a></p>' +
    '</div>';
  }

  // Kennung eines Kaufs (32 hex), erzeugt beim Öffnen des Dialogs: Doppelklick oder erneutes Senden bucht nur einmal
  function purchaseId() {
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
  }

  function openUnlockModal() {
    var st = code.st, rid = purchaseId(), price = st.cost;
    // Was nach dem Kauf übrig bleibt – oder wie viele fehlen, falls der Preis im offenen Dialog über den Kontostand steigt
    function leftHtml() {
      return 'You unlock it once and keep it for good. ' + (st.balance >= price
        ? 'Afterwards you have <span id="codeAfter">' + fmtNum(st.balance - price) + '</span> honeycombs left.'
        : 'You need ' + fmtNum(price - st.balance) + ' more honeycombs.');
    }
    openModal('Unlock your code page',
      '<div class="hc-big mb-4"><i class="bx bx-hive"></i><div><b id="codePrice">' + fmtNum(price) + '</b><small>honeycombs · you have ' + fmtNum(st.balance) + '</small></div></div>' +
      '<p class="text-sm text-gray-400 mb-4" id="codeLeft">' + leftHtml() + '</p>' +
      (st.terms ? '' : codeTermsHtml()) +
      '<p class="text-sm text-red-400 mt-3 hidden" id="codeErr"></p>',
      '<button type="button" class="btn-ghost" data-close>Cancel</button><button type="button" class="btn-primary" id="codeUnlockGo"><i class="bx bx-lock-open-alt"></i> Unlock</button>',
      function (box) {
        $('#codeUnlockGo', box).addEventListener('click', function () {
          var btn = this, terms = $('#codeTerms', box);
          if (terms && !terms.checked) { codeErr(box, 'Please accept the rules for code pages first.'); return; }
          btn.disabled = true;
          api('code-unlock', { terms: true, request_id: rid, expected_price: price }).then(function (res) {
            btn.disabled = false;
            // Neuer Preis (Angebot begonnen oder vorbei, Preis geändert): Dialog bleibt offen, gleiche Kennung, neuer Preis
            if (res && res.code === 'price_changed' && typeof res.price === 'number') {
              price = res.price;
              $('#codePrice', box).textContent = fmtNum(price);
              $('#codeLeft', box).innerHTML = leftHtml();
              // Jetzt zu teuer: kein Kauf aus diesem Dialog (wie der Knopf im Code-Tab, „… more honeycombs needed“)
              btn.disabled = st.balance < price;
              codeErr(box, res.error);
              apiGet('code').then(function (fresh) { if (fresh && fresh.ok) { setCodeState(fresh); renderCode(); } });
              return;
            }
            if (!res || !res.ok) { codeErr(box, (res && res.error) || 'That didn’t work.'); return; }
            closeModal();
            setCodeState(res);
            setBalance(res.balance, true);
            renderCode();
            // Abgebucht wurde, was der Hinweis des Servers sagt (schon freigeschaltet oder kostenlos: nichts)
            var spent = res.notices && res.notices[0] && res.notices[0].amount < 0 ? -res.notices[0].amount : 0;
            toast(spent ? 'Code page unlocked – ' + fmtNum(spent) + ' honeycombs spent.' : 'Code page unlocked.', 'hc');
          });
        });
      });
  }

  function codeCreateHtml(st) {
    var suggestion = state.page ? (state.page.slug + '-dev').slice(0, 30) : '';
    return '<div class="panel max-w-xl mx-auto">' +
      '<div class="flex items-center gap-3 mb-5"><span class="code-mini-ico"><i class="bx bx-code-alt"></i></span><div><h2 class="text-base font-semibold text-white">Create your code page</h2><p class="text-xs text-gray-500">Choose the address of your website – you can change it later.</p></div></div>' +
      '<label class="lbl">Address</label>' +
      '<div class="input-group"><input class="field" id="codeSlug" maxlength="30" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="yourname-dev" value="' + esc(suggestion) + '"><span class="addon right">.' + esc(E.baseHost) + '</span></div>' +
      '<p class="hint">2–30 characters: a–z, 0–9 and hyphens. It can’t be the address of a link page.</p>' +
      '<label class="lbl mt-4">Name</label><input class="field" id="codeTitle" maxlength="120" placeholder="e.g. My portfolio">' +
      (st.terms ? '' : '<div class="mt-4">' + codeTermsHtml() + '</div>') +
      '<p class="text-sm text-red-400 mt-3 hidden" id="codeErr"></p>' +
      '<button type="button" class="btn-primary mt-5" data-code="create"><i class="bx bx-plus"></i> Create code page</button>' +
    '</div>';
  }

  function createCodeSite(btn) {
    var root = $('#tab-code'), terms = $('#codeTerms', root);
    if (terms && !terms.checked) { codeErr(root, 'Please accept the rules for code pages first.'); return; }
    btn.disabled = true;
    api('code-create', { slug: $('#codeSlug').value, title: $('#codeTitle').value, terms: true }).then(function (res) {
      btn.disabled = false;
      if (!res || !res.ok) { codeErr(root, (res && res.error) || 'That didn’t work.'); return; }
      setCodeState(res);
      code.previewed = false;
      renderCode();
      toast('Your code page is live at ' + prettyUrl(res.site.url) + '.');
    });
  }

  function renderCodeEditor() {
    $('#tab-code').innerHTML =
      '<div id="codeHead"></div>' +
      '<div class="code-ide">' +
        '<div class="code-files"><div class="code-files-head"><span>Files</span><button type="button" class="icon-btn sm" data-code="new" title="New file" aria-label="New file"><i class="bx bx-plus"></i></button></div>' +
          '<div class="code-file-list custom-scrollbar" id="codeFileList"></div><div class="code-files-foot" id="codeUsage"></div></div>' +
        '<div class="code-main"><div class="code-bar"><b id="codeCur"></b><span class="acts">' +
          '<button type="button" class="icon-btn sm" data-code="image" title="Upload an image and insert its link" aria-label="Insert image"><i class="bx bx-image-add"></i></button>' +
          '<button type="button" class="icon-btn sm" data-code="rename" title="Rename file" aria-label="Rename file"><i class="bx bx-rename"></i></button>' +
          '<button type="button" class="icon-btn sm danger" data-code="delete" title="Delete file" aria-label="Delete file"><i class="bx bx-trash"></i></button>' +
        '</span></div><div class="code-editor" id="codeEditor"></div></div>' +
      '</div>' +
      '<p class="hint"><span class="hover-only">Ctrl+S saves. </span>Visitors see your changes as soon as you save.</p>' +
      '<div class="code-settings grid gap-4 md:grid-cols-2 mt-8">' +
        '<div class="panel"><h3 class="text-sm font-semibold text-white mb-3 flex items-center gap-2"><i class="bx bx-purchase-tag-alt text-brand-400"></i> Name</h3>' +
          '<input class="field" id="codeTitleEdit" maxlength="120"><button type="button" class="btn-secondary mt-3" data-code="title">Save name</button></div>' +
        '<div class="panel"><h3 class="text-sm font-semibold text-white mb-3 flex items-center gap-2"><i class="bx bx-link text-brand-400"></i> Address</h3>' +
          '<div class="input-group"><input class="field" id="codeSlugEdit" maxlength="30" autocomplete="off" autocapitalize="off" spellcheck="false"><span class="addon right">.' + esc(E.baseHost) + '</span></div>' +
          '<button type="button" class="btn-secondary mt-3" data-code="address">Change address</button></div>' +
      '</div>' +
      '<div class="panel mt-4 text-sm text-gray-400 code-info"><i class="bx bx-shield-quarter text-xl text-brand-400 shrink-0"></i><div><b class="text-white">Good to know</b><ul>' +
        '<li>Code pages are made of HTML, CSS and JavaScript – there’s no PHP or other server code.</li>' +
        '<li>For everyone’s safety your page runs in a sandbox: cookies and localStorage aren’t available, and a small “OnYourSite” badge is shown.</li>' +
        '<li>Personal, informational and promotional pages only – no shops, no payments, no selling. <a href="' + esc(E.codeTerms) + '" target="_blank" rel="noopener">Rules for code pages</a></li>' +
      '</ul></div></div>';
    var site = code.st.site;
    $('#codeTitleEdit').value = site.title;
    $('#codeSlugEdit').value = site.slug;
    renderCodeHead();
    mountCodeEditor();
    renderCodeFiles();
    codePreview();
  }

  function renderCodeHead() {
    var site = code.st.site, head = $('#codeHead');
    if (!head) return;
    var badge = site.blocked ? '<span class="bdg red">Blocked</span>' : site.online ? '<span class="bdg green">Online</span>' : '<span class="bdg">Offline</span>';
    head.innerHTML = '<div class="code-head">' +
        '<div class="min-w-0"><h2 class="text-base font-semibold text-white flex items-center gap-2 flex-wrap"><span class="truncate">' + esc(site.title || site.slug) + '</span> ' + badge + '</h2>' +
          '<a class="code-url" id="codeUrl" href="' + esc(site.url) + '/" target="_blank" rel="noopener">' + esc(prettyUrl(site.url)) + ' <i class="bx bx-link-external"></i></a></div>' +
        '<div class="flex items-center gap-3 flex-wrap"><span class="text-xs text-gray-500">' + esc(plural(site.views, 'view', 'views')) + '</span>' +
          '<label class="switch"><input type="checkbox" id="codeOnline"' + (site.online ? ' checked' : '') + (site.blocked ? ' disabled' : '') + '><span class="track"></span><span class="sw-text">Online</span></label>' +
          '<button type="button" class="btn-secondary" data-code="preview"><i class="bx bx-show"></i> Preview</button></div>' +
      '</div>' +
      (site.blocked ? '<div class="code-blocked"><i class="bx bx-block"></i><div><b>Your code page has been blocked by the team.</b><p>' + esc(site.blocked_reason || 'It broke the rules for code pages.') + ' Visitors can’t see it right now. If you think this is a mistake, please contact us.</p></div></div>' : '');
  }

  function renderCodeFiles() {
    var list = $('#codeFileList');
    if (!list) return;
    var paths = Object.keys(code.files).sort(codeSort), bytes = 0;
    list.innerHTML = paths.map(function (p) {
      bytes += utf8Len(code.files[p]);
      return '<button type="button" class="code-file' + (p === code.cur ? ' on' : '') + '" data-file="' + esc(p) + '" title="' + esc(p) + '"><i class="bx ' + (CODE_ICONS[codeExt(p)] || 'bx-file') + '"></i><span>' + esc(p) + '</span>' +
        (code.files[p] !== code.saved[p] ? '<i class="chg" title="Not saved yet"></i>' : '') + '</button>';
    }).join('');
    var lim = code.st.site.limits;
    $('#codeUsage').innerHTML = esc(paths.length + ' / ' + lim.files + ' files') + '<br>' + esc(fmtBytes(bytes) + ' / ' + fmtBytes(lim.total));
    $('#codeCur').textContent = code.cur;
    $('[data-code="rename"]').disabled = $('[data-code="delete"]').disabled = code.cur === 'index.html' || code.st.site.blocked;
  }
  var renderCodeFilesSoon = debounce(renderCodeFiles, 300);

  // Editor: sofort ein Textfeld, CodeMirror (Farben, Klammern, Zeilennummern) wird nachgeladen
  var cmLoading = null;
  function loadCodeMirror() {
    if (window.CodeMirror) return Promise.resolve(window.CodeMirror);
    if (!cmLoading) {
      cmLoading = new Promise(function (resolve, reject) {
        var css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = E.cm.css;
        document.head.appendChild(css);
        var js = document.createElement('script');
        js.src = E.cm.js;
        js.onload = function () { window.CodeMirror ? resolve(window.CodeMirror) : reject(); };
        js.onerror = reject;
        document.head.appendChild(js);
      });
      cmLoading.catch(function () { cmLoading = null; });
    }
    return cmLoading;
  }
  function codeDoc(p) {
    if (!code.docs[p]) code.docs[p] = window.CodeMirror.Doc(code.files[p] || '', codeMode(p));
    return code.docs[p];
  }
  function mountCodeEditor() {
    var holder = $('#codeEditor'), readOnly = code.st.site.blocked;
    code.cm = null;
    holder.innerHTML = '<textarea class="code-area custom-scrollbar" id="codeArea" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-label="Code"></textarea>';
    var ta = $('#codeArea');
    ta.value = code.files[code.cur] || '';
    ta.readOnly = readOnly;
    ta.addEventListener('input', function () { code.files[code.cur] = ta.value; codeChanged(); });
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) { ev.preventDefault(); codeInsertText(ta, '  '); }
    });
    loadCodeMirror().then(function (CM) {
      if (!document.body.contains(ta)) return; // Tab inzwischen neu aufgebaut
      code.docs = {};
      var cm = CM(function (el) { holder.replaceChild(el, ta); }, {
        value: codeDoc(code.cur), theme: 'oys', lineNumbers: true, tabSize: 2, indentUnit: 2, indentWithTabs: false,
        autoCloseTags: true, autoCloseBrackets: true, matchBrackets: true, styleActiveLine: true, readOnly: readOnly,
        extraKeys: {
          Tab: function (c) { if (c.somethingSelected()) c.indentSelection('add'); else c.replaceSelection('  ', 'end'); },
          'Shift-Tab': 'indentLess'
        }
      });
      code.cm = cm;
      cm.on('change', function () { code.files[code.cur] = cm.getValue(); codeChanged(); });
    }).catch(function () { /* das Textfeld bleibt */ });
  }
  function codeInsertText(ta, text) {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function codeChanged() {
    setCodeSaveState(codeUnsaved() ? 'dirty' : '');
    renderCodeFilesSoon();
    draft.later();
  }

  function openCodeFile(p) {
    if (!has(code.files, p)) p = 'index.html';
    code.cur = p;
    if (code.cm) { code.cm.swapDoc(codeDoc(p)); code.cm.focus(); }
    else if ($('#codeArea')) $('#codeArea').value = code.files[p];
    renderCodeFiles();
  }

  function codeTemplate(p) {
    if (!/\.html?$/.test(p)) return '';
    var name = p.replace(/^.*\//, '').replace(/\.html?$/, '').replace(/[-_]+/g, ' ');
    var title = name.charAt(0).toUpperCase() + name.slice(1);
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>' + title + '</title>\n  <link rel="stylesheet" href="/style.css">\n</head>\n<body>\n  <main class="card">\n    <h1>' + title + '</h1>\n    <p><a href="/">Back to the start page</a></p>\n  </main>\n</body>\n</html>\n';
  }

  function openCodeFileModal(rename) {
    var lim = code.st.site.limits, old = code.cur;
    if (!rename && Object.keys(code.files).length >= lim.files) { toast('A code page can have up to ' + lim.files + ' files.', 'err'); return; }
    openModal(rename ? 'Rename file' : 'New file',
      '<label class="lbl">File name</label><input class="field" id="cfName" maxlength="120" placeholder="about.html" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + (rename ? esc(old) : '') + '">' +
      '<p class="hint">Allowed: ' + esc(lim.types.join(', ')) + '. Use “/” for folders, e.g. css/theme.css. A page like about.html opens at /about, and a 404.html is shown for addresses that don’t exist.</p>' +
      '<p class="text-sm text-red-400 mt-3 hidden" id="codeErr"></p>',
      '<button type="button" class="btn-ghost" data-close>Cancel</button><button type="button" class="btn-primary" id="cfGo"><i class="bx ' + (rename ? 'bx-check' : 'bx-plus') + '"></i> ' + (rename ? 'Rename' : 'Create file') + '</button>',
      function (box) {
        var input = $('#cfName', box);
        var go = function () {
          var r = codeCheckPath(input.value);
          if (r.error) { codeErr(box, r.error); return; }
          if (rename && r.path === old) { closeModal(); return; }
          if (has(code.files, r.path)) { codeErr(box, 'There’s already a file called ' + r.path + '.'); return; }
          if (rename) {
            code.files[r.path] = code.files[old];
            delete code.files[old];
            delete code.docs[old];
          } else {
            code.files[r.path] = codeTemplate(r.path);
          }
          closeModal();
          openCodeFile(r.path);
          codeChanged();
        };
        $('#cfGo', box).addEventListener('click', go);
        input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go(); });
      });
  }

  function deleteCodeFile() {
    var p = code.cur, siteId = code.st && code.st.site ? code.st.site.id : 0;
    if (p === 'index.html') return;
    UI.confirm({ title: 'Delete ' + p + '?', text: 'It’s removed from your code page when you save.', ok: 'Delete file', tone: 'danger' }).then(function (yes) {
      // Nach dem Dialog: dieselbe Code-Seite, die Datei gibt es noch
      if (!yes || !code.st || !code.st.site || code.st.site.id !== siteId || !has(code.files, p) || p === 'index.html') return;
      delete code.files[p];
      delete code.docs[p];
      if (code.cur === p) openCodeFile('index.html'); else renderCodeFiles();
      codeChanged();
    });
  }

  function insertCodeImage() {
    pickFile('image/*').then(function (files) {
      if (!files.length) return;
      toast('Uploading image…', 'info');
      upload('image', files[0]).then(function (res) {
        if (!res || !res.ok) { toast((res && res.error) || 'Upload failed.', 'err'); return; }
        var ext = codeExt(code.cur);
        var snippet = ext === 'css' ? 'url("' + res.url + '")' : /^html?$/.test(ext) ? '<img src="' + res.url + '" alt="">' : res.url;
        if (code.cm) { code.cm.replaceSelection(snippet); code.cm.focus(); }
        else codeInsertText($('#codeArea'), snippet);
        toast('Image uploaded – its link is now in ' + code.cur + '. Save to keep it.');
      });
    });
  }

  function setCodeSaveState(s) {
    code.state = s;
    if (activeTab === 'code') paintSave(s);
  }

  function codeSave() {
    var st = code.st;
    if (!st || !st.site || code.saving) return;
    if (st.site.blocked) { toast('Your code page is blocked and can’t be changed right now.', 'err'); return; }
    var files = {}, deleted = [];
    Object.keys(code.files).forEach(function (p) { if (code.files[p] !== code.saved[p]) files[p] = code.files[p]; });
    Object.keys(code.saved).forEach(function (p) { if (!has(code.files, p)) deleted.push(p); });
    if (!Object.keys(files).length && !deleted.length) { toast('Nothing to save – your page is up to date.', 'info'); return; }
    code.saving = true;
    setCodeSaveState('saving');
    api('code-save', { site: st.site.id, files: files, deleted: deleted }).then(function (res) {
      code.saving = false;
      if (!res || !res.ok) { setCodeSaveState('dirty'); toast((res && res.error) || 'Saving failed.', 'err'); return; }
      setCodeState(res, true);
      setCodeSaveState(codeUnsaved() ? 'dirty' : 'saved');
      renderCodeFiles();
      codePreview(true);
      draft.codeSaved();
      toast('Saved – your code page is up to date.');
    });
  }

  // Name, Adresse und Online-Schalter (ohne die Dateien anzufassen)
  function codeSettings(action, body, done) {
    // Jede Änderung nennt die Code-Seite, die der Tab zeigt (der Server lehnt Anfragen ohne sie ab)
    if (code.st && code.st.site) body.site = code.st.site.id;
    return api(action, body).then(function (res) {
      if (!res || !res.ok) { toast((res && res.error) || 'That didn’t work.', 'err'); return false; }
      setCodeState(res, true);
      renderCodeHead();
      if (done) done(res);
      return true;
    });
  }

  function onCodeClick(ev) {
    var f = ev.target.closest('[data-file]');
    if (f) { openCodeFile(f.dataset.file); return; }
    var b = ev.target.closest('[data-code]');
    if (!b || b.disabled) return;
    switch (b.dataset.code) {
      case 'unlock': openUnlockModal(); break;
      case 'create': createCodeSite(b); break;
      case 'new': openCodeFileModal(false); break;
      case 'rename': openCodeFileModal(true); break;
      case 'delete': deleteCodeFile(); break;
      case 'image': insertCodeImage(); break;
      case 'preview': openCodeBig(); break;
      case 'title':
        codeSettings('code-save', { files: {}, deleted: [], title: $('#codeTitleEdit').value }, function () {
          $('#codeTitleEdit').value = code.st.site.title;
          toast('Name saved.');
        });
        break;
      case 'address':
        var slug = $('#codeSlugEdit').value, siteId = code.st.site.id;
        if (slug === code.st.site.slug) return;
        UI.confirm({ title: 'Move your code page?', text: 'New address: ' + slug + '.' + E.baseHost + '. The old address stops working right away.', ok: 'Move', tone: 'warn' }).then(function (yes) {
          // Nach dem Dialog: dieselbe Code-Seite, im Feld steht noch die bestätigte Adresse, und sie ist neu
          var field = $('#codeSlugEdit');
          if (!yes || !code.st || !code.st.site || code.st.site.id !== siteId || !field || field.value !== slug || slug === code.st.site.slug) return;
          codeSettings('code-address', { slug: slug }, function (res) {
            var f = $('#codeSlugEdit');
            if (f) f.value = res.site.slug;
            codePreview(true);
            toast('Your code page is now at ' + prettyUrl(res.site.url) + '.');
          });
        });
        break;
    }
  }
  $('#tab-code').addEventListener('click', onCodeClick);
  $('#tab-code').addEventListener('input', function (ev) {
    if (ev.target.id === 'codeSlug' || ev.target.id === 'codeSlugEdit') ev.target.value = ev.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
  });
  $('#tab-code').addEventListener('change', function (ev) {
    if (ev.target.id !== 'codeOnline') return;
    var on = ev.target.checked;
    codeSettings('code-save', { files: {}, deleted: [], online: on }, function () {
      toast(on ? 'Your code page is online.' : 'Your code page is offline – visitors see a notice, you still see it in the preview.');
      codePreview(true);
    }).then(function (ok) { if (!ok) ev.target.checked = !on; });
  });

  // Vorschau: im Handy-Rahmen rechts (gespeicherter Stand) und als große Ansicht
  function codeUrl() { return code.st && code.st.site ? code.st.site.url + '/' : ''; }
  // Die Vorschau-Adresse enthält einen Schlüssel: so sieht nur der Besitzer die Seite, auch wenn sie offline ist
  function codePreviewSrc() { return code.st.site.preview + '&r=' + Date.now(); }
  function codePreview(reload) {
    var url = codeUrl(), frame = $('#pvCode');
    frame.classList.toggle('on', !!url);
    if (!url || activeTab !== 'code') return;
    $('#pvOpen').href = url;
    $('#pvLiveLabel').textContent = 'Saved version';
    $('#bigPreviewUrl').textContent = prettyUrl(url);
    if (reload || !code.previewed) {
      code.previewed = true;
      frame.src = codePreviewSrc();
    }
  }
  function openCodeBig() {
    var url = codeUrl(), big = $('#bigPreviewFrame');
    if (!url) return;
    big.removeAttribute('srcdoc');
    // Ohne allow-modals: Browser-Popups aus dem Code des Nutzers (alert, confirm, prompt) öffnen im Editor keine
    // Fenster – sie erschienen sonst über on-your.site/dashboard. Auf der Live-Seite dürfen sie (D18).
    big.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
    big.src = codePreviewSrc();
    $('#bigPreviewUrl').textContent = prettyUrl(url);
    openBig();
  }

  // ================================================================
  // Tab: Einstellungen
  // ================================================================
  // ================================================================
  // Teilen: QR-Code (PNG/SVG), Link kopieren, WhatsApp, X, Discord
  // ================================================================
  var X_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-7.6 8.7L23 22h-6.8l-5.3-6.9L4.8 22H1.7l8.1-9.3L1 2h7l4.8 6.3zm-1.2 18h1.7L7.4 3.9H5.6z"/></svg>';
  var shareOpen = null; // { url, title } solange das Teilen-Fenster offen ist
  function openShareModal() {
    if (!state.page || !window.OYSShare) return;
    var S = window.OYSShare, url = state.page.url, title = state.page.title || state.page.slug;
    var l = S.links(url, title);
    var body =
      '<div class="share-grid">' +
        '<div><div class="share-qr" id="shareQr"><i class="bx bx-loader-alt bx-spin"></i></div>' +
        '<div class="grid grid-cols-2 gap-2 mt-3"><button type="button" class="btn-secondary justify-center" data-share="png"><i class="bx bx-download"></i> PNG</button>' +
        '<button type="button" class="btn-secondary justify-center" data-share="svg"><i class="bx bx-download"></i> SVG</button></div></div>' +
        '<div class="min-w-0">' +
          '<label class="lbl">Your link</label>' +
          '<div class="flex gap-2"><input class="field" id="shareUrl" readonly value="' + esc(url) + '"><button type="button" class="btn-primary shrink-0" data-share="copy"><i class="bx bx-copy"></i> Copy</button></div>' +
          '<label class="lbl mt-5">Share it</label>' +
          '<div class="share-btns">' +
            '<a class="share-btn" style="--c:#25D366" href="' + esc(l.whatsapp) + '" target="_blank" rel="noopener" data-share="whatsapp"><i class="bx bxl-whatsapp"></i> WhatsApp</a>' +
            '<a class="share-btn" style="--c:#e7e9ea" href="' + esc(l.x) + '" target="_blank" rel="noopener" data-share="x">' + X_ICON + ' X</a>' +
            '<button type="button" class="share-btn" style="--c:#5865F2" data-share="discord"><i class="bx bxl-discord-alt"></i> Discord</button>' +
            (S.canNativeShare() ? '<button type="button" class="share-btn" style="--c:#a5b4fc" data-share="native"><i class="bx bx-share-alt"></i> More</button>' : '') +
          '</div>' +
          '<p class="hint mt-4">Print the QR code on posters and flyers, show it on stream or put it in your videos – it always opens your page.</p>' +
        '</div>' +
      '</div>' +
      (state.page.og ? '<div class="share-preview"><label class="lbl">How your link looks when it’s shared <small>on Discord, WhatsApp, X …</small></label><img src="' + esc(state.page.og) + '" alt="Preview card of your page" loading="lazy">' +
        (dirty ? '<p class="hint">Save your changes to update the preview.</p>' : '') + '</div>' : '');
    openModal('Share your page', body, '', function (box) {
      box.classList.add('wide');
      shareOpen = { url: url, title: title };
      S.load(E.qrJs).then(function () {
        var qr = $('#shareQr', box);
        if (qr) qr.innerHTML = S.svg(url);
      }).catch(function () {
        var qr = $('#shareQr', box);
        if (qr) qr.innerHTML = '<p class="hint p-4 text-center">The QR code couldn’t be loaded – please reload the page.</p>';
      });
    });
  }
  // Ein Klick-Handler für alle Knöpfe im Teilen-Fenster (das Fenster wird jedes Mal neu gefüllt)
  $('#modal').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-share]');
    if (!b || !shareOpen) return;
    var S = window.OYSShare, url = shareOpen.url, title = shareOpen.title, kind = b.dataset.share;
    if (kind === 'copy' || kind === 'discord') {
      S.copy(url).then(function () {
        toast(kind === 'discord' ? 'Link copied – paste it in Discord, it shows up as a preview card.' : 'Link copied.');
      }).catch(function () { $('#shareUrl').select(); toast('Copying failed – the link is selected, press Ctrl+C.', 'err'); });
    } else if (kind === 'native') {
      S.nativeShare(url, title).catch(function () { /* abgebrochen */ });
    } else if (kind === 'png' || kind === 'svg') {
      S.load(E.qrJs).then(function () {
        if (kind === 'svg') return S.download(new Blob([S.svg(url)], { type: 'image/svg+xml' }), S.fileName(url, 'svg'));
        return S.png(url, 1200).then(function (blob) { S.download(blob, S.fileName(url, 'png')); });
      }).catch(function () { toast('The QR code couldn’t be created.', 'err'); });
    }
  });

  // Schalter „Made with OnYourSite“ (Premium): frei mit Premium oder als Team, mit Bestandsschutz nur zum Ausschalten.
  // Der gespeicherte Wert bleibt auch ohne Premium erhalten – er wirkt dann nur nicht.
  var cssWarning = '';
  function cssWarningHtml() {
    return cssWarning ? '<p class="hint text-amber-400" id="cssWarning"><i class="bx bx-error"></i> ' + esc(cssWarning) + '</p>' : '';
  }
  // Nach dem Speichern: Hinweis unter dem CSS-Feld setzen oder entfernen (ohne die Einstellungen neu zu zeichnen)
  function showCssWarning(text) {
    cssWarning = text || '';
    var old = $('#cssWarning');
    if (old) old.remove();
    var area = $('[data-bind="page.settings.custom_css"]');
    if (cssWarning && area) area.insertAdjacentHTML('afterend', cssWarningHtml());
  }
  // Standard-Titel für Suchmaschinen: mit Premium und ausgeblendetem Branding ohne „| OnYourSite“
  function seoTitleDefault(p, hidden) {
    return 'Default: ' + (p.title || p.slug) + (hidden && E.premium ? '' : ' | OnYourSite');
  }
  function brandingSwitch(s) {
    var legacy = !!(s.branding_legacy && s.hide_branding);
    var free = E.premium || E.staff || legacy;
    // Bestandsschutz ohne Premium blendet nur den Hinweis aus (Titel und Vorschaubild-Zeichen nicht)
    var hint = !E.premium && legacy ? 'Removes the note at the bottom of your page.'
      : 'Removes the note at the bottom of your page, “| OnYourSite” from the default page title and the OnYourSite mark on your preview image.';
    var note = '';
    if (!E.premium && legacy) note = '<p class="hint">Kept from before Premium existed. If you turn it off, you’ll need Premium to turn it back on.</p>';
    else if (!E.premium && s.hide_branding && !E.staff) note = '<p class="hint text-amber-400">' + (E.premiumUntil ? 'Premium ended – the note is shown again. Renew Premium to hide it.' : 'The note is still shown – hiding it is part of Premium.') + '</p>';
    else if (!E.premium && E.staff) note = '<p class="hint text-amber-400">Only takes effect while this account has Premium.</p>';
    else if (!E.premium) hint += ' Included in Premium.';
    return '<div class="flex items-center justify-between gap-4"><div><div class="text-sm text-white font-medium flex items-center gap-2">Hide “Made with OnYourSite” ' + (E.premium || E.staff ? '' : '<span class="premium-pill"><i class="bx bxs-lock"></i> Premium</span>') + '</div><p class="hint" style="margin-top:2px">' + hint + '</p>' + note + '</div>' +
      '<label class="switch"><input type="checkbox" data-bind="page.settings.hide_branding"' + (free ? '' : ' disabled') + '><span class="track"></span></label></div>';
  }

  // ================================================================
  // Einstellungen → Eigene Domain (PD-4): eigener Abschnitt, den renderDomain() allein neu zeichnet. Nach „Connect
  // domain“ oder „Check now“ fragt der Editor nach (alle 3 s, solange geprüft wird, höchstens 60 s; danach alle 15 s
  // bis 15 Minuten nach dem Klick) – nie bei verborgenem Tab, nie über das Ende hinaus, nie mit einer neuen Prüfung.
  // ================================================================
  var dom = { data: null, pageId: 0, timer: 0, fastUntil: 0, checkingSince: 0, claim: null, err: '', busy: false };
  var DOMAIN_BADGES = { verifying: ['amber', 'Waiting for DNS'], pending: ['amber', 'Setting up HTTPS'], active: ['green', 'Live'], broken: ['red', 'Not reachable'], suspended: ['', 'Paused'], failed: ['red', 'Couldn’t be verified'], blocked: ['red', 'Disabled by the team'], removing: ['', 'Removing…'] };
  var DOMAIN_STEP_ICONS = { done: 'bx-check-circle text-emerald-400', waiting: 'bx-time-five text-amber-400', problem: 'bx-error-circle text-red-400', unchecked: 'bx-circle text-white/40' };
  var DOMAIN_FINAL = ['active', 'failed', 'blocked', 'suspended'];

  function domainSectionHtml() {
    return E.domains && E.domains.available ? '<section class="max-w-3xl mx-auto mt-8" id="domainSection"></section>' : '';
  }
  function stopDomainPoll() { clearTimeout(dom.timer); dom.timer = 0; }
  function scheduleDomainPoll() {
    stopDomainPoll();
    var d = dom.data && dom.data.domain;
    if (!d || DOMAIN_FINAL.indexOf(d.state) !== -1 || document.hidden || activeTab !== 'settings' || !$('#domainSection')) return;
    var now = Date.now(), wait = 0;
    if (d.checking && now - dom.checkingSince < 60000) wait = 3000;
    else if (now < dom.fastUntil) wait = 15000;
    if (wait) dom.timer = setTimeout(function () { dom.timer = 0; loadDomain(); }, wait);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopDomainPoll();
    else if (activeTab === 'settings') scheduleDomainPoll();
  });
  function loadDomain() {
    if (!state.page || !$('#domainSection')) return;
    var pid = state.page.id;
    api('domain').then(function (r) {
      if (!state.page || state.page.id !== pid) return;
      if (r && r.ok) { dom.data = r; dom.pageId = pid; dom.err = ''; } else dom.err = (r && r.error) || 'Couldn’t load your custom domain.';
      renderDomain();
      scheduleDomainPoll();
    });
  }
  function domainUse(r) {
    // Antwort mit Domain: anzeigen und die Nachfrage starten
    if (!dom.data) dom.data = { ok: true, available: true, enabled: true, premium: { active: true }, linkPage: true };
    dom.data.domain = r.domain || null;
    if (r.domain && r.domain.checking) dom.checkingSince = Date.now();
    dom.fastUntil = Date.now() + 15 * 60000;
    renderDomain();
    scheduleDomainPoll();
  }
  function dnsRows(list) {
    return list.map(function (r) {
      var st = r.status === 'ok' ? '<i class="bx bx-check-circle text-emerald-400" title="Found"></i>'
        : r.status === 'missing' || r.status === 'wrong' ? '<i class="bx bx-error-circle text-red-400" title="' + (r.status === 'missing' ? 'Missing' : 'Wrong value') + '"></i>'
          : '<i class="bx bx-circle text-white/40" title="Not checked yet"></i>';
      return '<div class="dns-row"><span class="dns-type">' + esc(r.type) + '</span>' +
        '<span class="dns-cell"><code>' + esc(r.host) + '</code><button type="button" class="btn-ghost" data-copy="' + esc(r.host) + '" title="Copy name"><i class="bx bx-copy"></i></button></span>' +
        '<span class="dns-cell"><code>' + esc(r.value) + '</code><button type="button" class="btn-ghost" data-copy="' + esc(r.value) + '" title="Copy value"><i class="bx bx-copy"></i></button></span>' +
        '<span class="dns-st">' + st + '</span>' +
        (r.found ? '<small class="dns-note text-red-400">Found: ' + esc(r.found) + '</small>' : '') +
        (r.note ? '<small class="dns-note hint">' + esc(r.note) + '</small>' : '') + '</div>';
    }).join('');
  }
  function dnsTableHtml(d) {
    return '<div class="dns-table"><div class="dns-row dns-head"><span>Type</span><span>Name</span><span>Value</span><span></span></div>' + dnsRows(d.records) + '</div>' +
      '<p class="hint">Name: some providers want only the part before your domain (shown), others the full name.</p>' +
      '<p class="hint">Using Cloudflare DNS? Set the CNAME to “DNS only” (grey cloud).</p>' +
      '<p class="hint">Remove other records (A, AAAA) for this name first – a CNAME can’t share its name.</p>' +
      '<p class="hint">Using CAA records? Allow letsencrypt.org, pki.goog and ssl.com.</p>' +
      '<p class="hint">Keep the TXT record – it lets us switch your domain back on automatically after a break.</p>' +
      (d.apex ? '<p class="hint">If you move ' + esc(d.display) + ' away, remove it here first.</p>' : '') +
      (d.extra && d.extra.length ? '<h3 class="lbl mt-4">Additional records</h3><div class="dns-table">' + dnsRows(d.extra) + '</div><p class="hint">Cloudflare needs these for root domains.</p>' : '');
  }
  function domainFormHtml(r) {
    var c = dom.claim;
    return '<div><label class="lbl" for="domainInput">Your domain</label>' +
      '<div class="flex gap-2 flex-wrap"><div class="input-group flex-1"><span class="addon left">https://</span><input class="field" id="domainInput" placeholder="links.yourname.com" autocomplete="off" inputmode="url" maxlength="253" value="' + esc(dom.input || '') + '"></div>' +
      '<button type="button" class="btn-primary" data-dom="connect"' + (dom.busy ? ' disabled' : '') + '><i class="bx bx-link"></i> Connect domain</button></div>' +
      '<p class="hint">Use a domain you own. You’ll get two DNS records to add at your domain provider.</p>' +
      (dom.err ? '<p class="hint text-red-400" role="alert">' + esc(dom.err) + '</p>' : '') + '</div>' +
      (c ? '<div class="panel space-y-3" id="domainClaim"><p class="text-sm text-white/80">' + esc(c.error) + '</p><div class="dns-table">' + dnsRows([{ type: c.challenge.type, host: c.challenge.host, value: c.challenge.value, status: 'unchecked' }]) + '</div>' +
        '<div class="flex justify-end"><button type="button" class="btn-primary" data-dom="claim"' + (dom.busy ? ' disabled' : '') + '><i class="bx bx-check"></i> I’ve added it</button></div></div>' : '');
  }
  function renderDomain() {
    var sec = $('#domainSection');
    if (!sec) return;
    var r = dom.data && dom.pageId === (state.page && state.page.id) ? dom.data : null;
    var body;
    if (!r) body = dom.err ? '<p class="hint text-red-400">' + esc(dom.err) + '</p>' : '<p class="hint">Loading…</p>';
    else if (!r.available) body = '<p class="hint">Custom domains aren’t available right now.</p>';
    else if (!r.domain && r.linkPage === false) body = '<p class="hint">Custom domains work for link pages only.</p>';
    else if (!r.domain && !(r.premium && r.premium.active)) {
      body = '<div class="flex flex-wrap items-center gap-4"><i class="bx bx-globe text-white/80" style="font-size:32px"></i><div class="flex-1 min-w-0"><p class="text-sm text-white">Use your own domain, like links.yourname.com, for this page.</p><p class="hint">Included in Premium</p></div>' +
        '<button type="button" class="btn-primary" data-dom="shop" data-arg="premium"><i class="bx bx-crown"></i> Get Premium</button></div>';
    } else if (!r.domain && !r.enabled) body = '<p class="hint">New custom domains are paused right now.</p>';
    else if (!r.domain) body = domainFormHtml(r);
    else {
      var d = r.domain, b = DOMAIN_BADGES[d.state] || ['', d.state];
      var label = d.state === 'verifying' && d.waiting ? 'Waiting for a free place' : b[1];
      var cool = d.state === 'removing' || d.state === 'blocked';
      body = '<div class="flex flex-wrap items-center justify-between gap-3"><div class="min-w-0"><b class="text-white break-all" id="domainName">' + esc(d.display) + '</b>' +
        (d.display !== d.hostname ? ' <small class="hint">' + esc(d.hostname) + '</small>' : '') + ' <span class="bdg ' + b[0] + '">' + esc(label) + '</span></div>' +
        '<div class="flex items-center gap-2">' +
        (cool ? '' : '<button type="button" class="btn-secondary" data-dom="check"' + (d.checking || dom.busy ? ' disabled' : '') + '><i class="bx bx-refresh' + (d.checking ? ' bx-spin' : '') + '"></i> ' + (d.state === 'failed' ? 'Check again' : 'Check now') + '</button>') +
        (d.state === 'active' ? '<a class="btn-ghost" href="' + esc(d.url) + '" target="_blank" rel="noopener"><i class="bx bx-link-external"></i> Open</a>' : '') +
        '<button type="button" class="icon-btn danger" data-dom="remove" title="Remove domain"><i class="bx bx-trash"></i></button></div></div>';
      if (r.delayed) body += '<p class="hint text-amber-400"><i class="bx bx-time-five"></i> Checks are delayed right now – your page and domain keep working.</p>';
      if (['verifying', 'pending', 'broken'].indexOf(d.state) !== -1) {
        body += '<ul class="check-steps">' + [['ownership', 'Ownership confirmed'], ['dns', 'Domain points to OnYourSite'], ['https', 'Secure connection (HTTPS)']].map(function (s) {
          return '<li><i class="bx ' + DOMAIN_STEP_ICONS[d.steps[s[0]]] + '"></i> ' + s[1] + '</li>';
        }).join('') + '</ul>';
      }
      if (d.message) body += '<p class="text-sm text-white/80" id="domainMessage">' + esc(d.message) + '</p>';
      if (d.checkedAt) body += '<p class="hint">Last checked: ' + esc(d.checkedAt) + '</p>';
      if (dom.err) body += '<p class="hint text-red-400" role="alert">' + esc(dom.err) + '</p>';
      if (d.state === 'active') {
        body += '<p class="text-sm text-white/80">Your page is live at ' + esc(d.url) + '. Your OnYourSite addresses, QR codes and shared links lead here.</p>' +
          '<label class="switch"><input type="checkbox" id="domainRedirect"' + (d.redirect ? ' checked' : '') + '><span class="track"></span><span class="sw-text">Forward my OnYourSite addresses to this domain</span></label>' +
          '<details class="mt-2"><summary class="hint cursor-pointer">DNS records</summary>' + dnsTableHtml(d) + '</details>';
      } else if (d.state === 'suspended') {
        body += (d.graceUntil ? '<p class="hint">Your domain forwards to your OnYourSite address until ' + esc(d.graceUntil) + '.</p>' : '') +
          '<button type="button" class="btn-primary" data-dom="shop" data-arg="premium"><i class="bx bx-crown"></i> Renew Premium</button>';
      } else if (d.state === 'blocked') {
        if (d.blockedReason) body += '<p class="hint">' + esc(d.blockedReason) + '</p>';
      } else if (d.state !== 'removing') body += dnsTableHtml(d);
    }
    sec.innerHTML = '<h2 class="section-title">Custom domain <small>Show this page on your own domain</small></h2><div class="panel space-y-4">' + body + '</div>';
  }
  function domainAdd(claim, apexOk) {
    var input = $('#domainInput');
    if (input) dom.input = input.value;
    var host = dom.input;
    dom.busy = true;
    dom.err = '';
    renderDomain();
    api('domain-add', { hostname: host || '', apex_ok: !!apexOk, claim: !!claim }).then(function (r) {
      dom.busy = false;
      if (r && r.ok) {
        dom.claim = null;
        dom.input = '';
        toast(r.transferred ? 'Domain moved to this page – we’re checking it now.' : 'Domain added – add the DNS records below.', 'ok');
        domainUse(r);
        return;
      }
      if (r && r.confirm === 'apex') {
        renderDomain();
        UI.choice({
          title: 'Use a root domain?', text: r.error,
          options: [{ value: 'cancel', text: 'Cancel' }, { value: 'www', text: 'Use ' + r.suggest }, { value: 'apex', text: 'Continue', primary: true }],
          fallbackFocus: function () { return $('#domainInput'); }
        }).then(function (how) {
          if (how === 'www') { dom.input = r.suggest; renderDomain(); domainAdd(false, false); }
          else if (how === 'apex') domainAdd(false, true);
        });
        return;
      }
      dom.claim = r && r.challenge ? r : null;
      if (dom.claim) dom.claimApex = !!apexOk;
      dom.err = dom.claim ? '' : (r && r.error) || 'Something went wrong. Please try again.';
      renderDomain();
    });
  }
  function domainCheck() {
    dom.busy = true;
    api('domain-check', {}).then(function (r) {
      dom.busy = false;
      if (r && r.ok) {
        dom.err = r.cooldown ? 'Please wait a moment before checking again.' : '';
        domainUse(r);
      } else { dom.err = (r && r.error) || 'Something went wrong. Please try again.'; renderDomain(); }
    });
  }
  function domainRemove() {
    var d = dom.data && dom.data.domain;
    if (!d) return;
    UI.prompt({
      title: 'Remove ' + d.display + '?',
      text: 'Your page goes back to its OnYourSite address right away. Links and QR codes that use ' + d.display + ' stop working. Afterwards, delete the CNAME and TXT records at your domain provider.',
      match: d.hostname, normalize: 'host', matchLabel: 'Type ' + d.display + ' to confirm', tone: 'danger', ok: 'Remove domain',
      fallbackFocus: function () { return $('#domainSection [data-dom="remove"]'); }
    }).then(function (typed) {
      if (typed === null || typed === undefined) return;
      api('domain-remove', { confirm: typed }).then(function (r) {
        if (r && r.ok) {
          stopDomainPoll();
          dom.data.domain = null;
          dom.err = '';
          toast('Domain removed.', 'ok');
          renderDomain();
        } else toast((r && r.error) || 'Couldn’t remove the domain.', 'err');
      });
    });
  }
  document.addEventListener('click', function (e) {
    var sec = $('#domainSection');
    if (!sec || !sec.contains(e.target)) return;
    var cp = e.target.closest('[data-copy]');
    if (cp) {
      window.OYSShare.copy(cp.getAttribute('data-copy')).then(function () { toast('Copied.', 'ok'); });
      return;
    }
    var b = e.target.closest('[data-dom]');
    if (!b || b.disabled) return;
    var what = b.getAttribute('data-dom');
    if (what === 'connect') domainAdd(false, false);
    else if (what === 'claim') domainAdd(true, dom.claimApex);
    else if (what === 'check') domainCheck();
    else if (what === 'remove') domainRemove();
    else if (what === 'shop') openShop(b.getAttribute('data-arg'));
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.id === 'domainInput') { e.preventDefault(); domainAdd(false, false); }
  });
  document.addEventListener('change', function (e) {
    if (!e.target || e.target.id !== 'domainRedirect') return;
    var on = e.target.checked;
    api('domain-settings', { redirect: on }).then(function (r) {
      if (r && r.ok) { dom.data.domain = r.domain; toast(on ? 'Your OnYourSite addresses forward to your domain.' : 'Forwarding is off.', 'ok'); }
      else toast((r && r.error) || 'Couldn’t save that.', 'err');
      renderDomain();
    });
  });

  function renderSettings() {
    var root = $('#settingsDynamic');
    var p = state.page, s = p.settings;
    var urls = p.urls || {};
    var max = E.maxPages || 3;
    root.innerHTML =
      '<section class="max-w-3xl mx-auto"><h2 class="section-title">Address <small>Two addresses – you choose, the other one redirects</small></h2><div class="panel space-y-5">' +
      '<div><label class="lbl">Your name in the address</label><div class="input-group"><input class="field" id="slugInput" value="' + esc(p.slug) + '" maxlength="30" autocomplete="off"' + (E.slugDaysLeft > 0 ? ' readonly' : '') + '></div>' +
      (E.slugDaysLeft > 0 ? '<p class="hint text-red-400"><i class="bx bx-lock-alt"></i> You can change your address again in ' + plural(E.slugDaysLeft, 'day', 'days') + '.</p>' : '<p class="hint">Can be changed every 30 days. Allowed: a–z, 0–9 and hyphens.</p>') + '</div>' +
      '<div class="mode-cards">' +
      modeCard('subdomain', p.slug + '.' + E.baseHost, p.address_mode === 'subdomain') +
      modeCard('path', E.baseHost + '/' + p.slug, p.address_mode === 'path') +
      '</div><div class="flex justify-end"><button type="button" class="btn-primary" id="saveAddress"><i class="bx bx-check"></i> Save address</button></div></div></section>' +

      domainSectionHtml() +

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Your pages <small>' + state.pages.length + ' of ' + max + ' · each with its own address & stats</small></h2><div class="panel">' +
      state.pages.map(function (pg) {
        var cur = pg.id === p.id;
        return '<div class="page-row' + (cur ? ' current' : '') + '"><span class="ps-avatar" style="width:36px;height:36px">' + (pg.avatar ? '<img src="' + esc(pg.avatar) + '" alt="">' : esc(initials(pg.title || pg.slug))) + '</span>' +
          '<span class="flex-1 min-w-0"><b class="truncate">' + esc(pg.title || pg.slug) + (cur ? ' <span class="bdg brand">Editing</span>' : '') + '</b><small>' + esc(pg.url) + '</small></span>' +
          (cur ? '' : '<button type="button" class="btn-secondary" data-page="' + pg.id + '">Edit</button>') +
          (state.pages.length > 1 ? '<button type="button" class="icon-btn danger" data-del-page="' + pg.id + '" data-slug="' + esc(pg.slug) + '" title="Delete page"><i class="bx bx-trash"></i></button>' : '') + '</div>';
      }).join('') +
      (state.pages.length < max || E.pagesUnlimited ? '<button type="button" class="btn-secondary mt-3" data-action="new-page"><i class="bx bx-plus"></i> Create a new page</button>' : '') + '</div></section>' +

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Search engines (SEO) <small>Applied when you save</small></h2><div class="panel space-y-4">' +
      '<div><label class="lbl">Title</label><input class="field" data-bind="page.settings.seo.title" maxlength="120" placeholder="' + esc(seoTitleDefault(p, s.hide_branding)) + '"></div>' +
      '<div><label class="lbl">Description</label><textarea class="field" rows="2" data-bind="page.settings.seo.description" maxlength="300" placeholder="Default: your bio"></textarea></div>' +
      '<div><label class="lbl">Keywords</label><input class="field" data-bind="page.settings.seo.keywords" maxlength="255" placeholder="separated, by, commas"></div></div></section>' +

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Sharing</h2><div class="panel space-y-5">' +
      '<div class="flex flex-wrap items-center justify-between gap-3"><label class="switch"><input type="checkbox" data-bind="page.settings.share_button"><span class="track"></span><span class="sw-text">Share button on your page<small>Visitors can copy your link, scan the QR code or share it on WhatsApp, X and Discord (takes effect when you save)</small></span></label>' +
      '<button type="button" class="btn-secondary" data-action="share"><i class="bx bx-qr"></i> QR code & links</button></div></div></section>' +

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Notifications</h2><div class="panel space-y-5">' +
      '<label class="switch"><input type="checkbox" data-bind="page.settings.notify_email"><span class="track"></span><span class="sw-text">Email me about new messages<small>In addition to the heads-up via the bell (applies to this page, takes effect when you save)</small></span></label>' +
      '<div class="flex flex-wrap items-center justify-between gap-3"><label class="switch"><input type="checkbox" id="weeklyToggle"' + (E.user.weekly ? ' checked' : '') + '><span class="track"></span><span class="sw-text">Weekly report by email<small>Every Monday: views, clicks and your best link – for all your pages</small></span></label>' +
      '<button type="button" class="btn-secondary" id="weeklyTest"><i class="bx bx-send"></i> Send test report</button></div></div></section>' +

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Branding & custom CSS</h2><div class="panel space-y-5">' +
      brandingSwitch(s) +
      '<div><label class="lbl">Custom CSS <small>(for pros)</small></label><textarea class="field css-editor" rows="6" data-bind="page.settings.custom_css" placeholder="/* e.g. .oys-name { letter-spacing: .1em; } */"></textarea>' +
      cssWarningHtml() +
      '<p class="hint">All elements have classes like <code>.oys-name</code>, <code>.oys-link</code>, <code>.oys-socials</code>. URLs pointing to other servers (<code>url(https://…)</code>, <code>@import</code>) are removed for privacy reasons – upload images here in the editor instead.</p></div></div></section>' +

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Integrations</h2><div class="panel space-y-3">' +
      '<label class="lbl flex items-center gap-2">Discord ID <span class="text-[10px] text-[#5865F2] bg-[#5865F2]/10 px-1.5 rounded">Auto role</span></label>' +
      '<div class="flex gap-2"><div class="input-group flex-1"><span class="addon left" style="color:#5865F2"><i class="bx bxl-discord-alt text-lg"></i></span><input class="field" id="discordId" value="' + esc(E.user.discord) + '" placeholder="1234567890" inputmode="numeric"></div>' +
      '<button type="button" class="btn-secondary" id="saveDiscord">Save</button></div>' +
      '<p class="hint">Link your Discord ID to automatically get the customer role on our server.</p></div></section>';

    bindAll(root);
    // Eigene Domain: eigener Abschnitt mit eigenem Stand
    renderDomain();
    loadDomain();
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
        $$('.mode-card [data-badge]', root).forEach(function (x) { x.textContent = x.closest('.mode-card') === c ? 'Primary address' : 'Redirects'; });
      });
    });
    $('#saveAddress').addEventListener('click', function () {
      api('address', { slug: slug.value, mode: mode }).then(function (res) {
        if (!res || !res.ok) { toast((res && res.error) || 'Something went wrong.', 'err'); return; }
        var changed = res.page.slug !== state.page.slug;
        state.page.slug = res.page.slug;
        state.page.address_mode = res.page.address_mode;
        state.page.urls = res.page.urls;
        state.page.url = res.page.url;
        if (changed) E.slugDaysLeft = E.staff ? 0 : 30;
        updatePageInfo();
        renderSettings();
        toast('Address saved: ' + prettyUrl(res.page.url));
      });
    });
    $$('[data-del-page]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var s2 = btn.dataset.slug, delId = Number(btn.dataset.delPage), deleted = false;
        // Bestätigen durch Tippen der Adresse; der Server prüft sie noch einmal. Fehler bleiben im Dialog.
        UI.prompt({
          title: 'Delete page “' + s2 + '”?',
          text: 'All its blocks, stats and messages are deleted. This can’t be undone.',
          match: s2, normalize: 'slug', transform: 'slug', ok: 'Delete page', tone: 'danger',
          fallbackFocus: function () { return $('#settingsDynamic [data-del-page]') || $('#mainNav [data-tab="settings"]'); },
          onConfirm: function (typed) {
            return api('page-delete', { id: delId, confirm: typed }).then(function (res) {
              if (!res || !res.ok) return (res && res.error) || 'Something went wrong. Please try again.';
              deleted = true;
              draft.dropPage(delId);
            });
          }
        }).then(function () {
          // Entwürfe anderer Seiten bleiben und werden nach dem Neuladen angeboten
          if (deleted) reloadTo('/dashboard#settings');
        });
      });
    });
    // Der Standard-Titel folgt dem Schalter für das Branding
    var brandingBox = $('[data-bind="page.settings.hide_branding"]', root);
    if (brandingBox) brandingBox.addEventListener('change', function () {
      var seoTitle = $('[data-bind="page.settings.seo.title"]', root);
      if (seoTitle) seoTitle.placeholder = seoTitleDefault(state.page, brandingBox.checked);
    });
    $('#weeklyToggle').addEventListener('change', function (ev) {
      var on = ev.target.checked;
      api('weekly', { enabled: on }).then(function (res) {
        if (res && res.ok) { E.user.weekly = on; toast(on ? 'Weekly report on – it arrives in your inbox every Monday.' : 'Weekly report off.'); }
        else toast('Saving failed.', 'err');
      });
    });
    $('#weeklyTest').addEventListener('click', function (ev) {
      var btn = ev.currentTarget;
      btn.disabled = true;
      api('weekly-test', {}).then(function (res) {
        btn.disabled = false;
        if (res && res.ok) toast('Test report sent to ' + E.user.email + '.');
        else toast((res && res.error) || 'Sending failed.', 'err');
      });
    });
    $('#saveDiscord').addEventListener('click', function () {
      api('discord', { discord_id: $('#discordId').value }).then(function (res) {
        if (res && res.ok) { E.user.discord = $('#discordId').value.replace(/\D/g, ''); toast('Discord ID saved.'); }
        else toast('Saving failed.', 'err');
      });
    });
  }

  function modeCard(mode, url, on) {
    var other = mode === 'subdomain' ? 'Subdomain' : 'Path';
    return '<div class="mode-card' + (on ? ' on' : '') + '" data-mode="' + mode + '" role="button" tabindex="0">' +
      '<div class="flex items-center justify-between mb-1"><small>' + other + '</small><span class="bdg ' + (on ? 'green' : '') + '" data-badge>' + (on ? 'Primary address' : 'Redirects') + '</span></div>' +
      '<b data-mode-url="' + mode + '">' + esc(url) + '</b></div>';
  }

  // ================================================================
  // Vorschau-Steuerung
  // ================================================================
  $('#pvReload').addEventListener('click', function () { if (activeTab === 'code') codePreview(true); else preview.refresh(); });
  $('#pvEntrance').addEventListener('click', function () { preview.refresh({ entrance: true, top: true }); });
  // Große Ansicht und Handy-Vorschau sind Ebenen von ui.js: Escape und die Zurück-Geste schließen sie
  var bigLayer = null, mobileLayer = null;
  function openBig() {
    $('#bigPreview').classList.remove('hidden');
    if (!bigLayer) bigLayer = UI.layer($('#bigPreview'), { onEscape: closeBig });
  }
  function closeBig() {
    $('#bigPreview').classList.add('hidden');
    $('#bigPreviewFrame').srcdoc = '';
    if (bigLayer) { var l = bigLayer; bigLayer = null; l.release(); }
  }
  $('#pvBig').addEventListener('click', function () {
    if (activeTab === 'code') { openCodeBig(); return; }
    $('#bigPreviewFrame').removeAttribute('sandbox');
    openBig();
    $('#bigPreviewFrame').srcdoc = preview.html();
  });
  $('#bigPreviewClose').setAttribute('aria-label', 'Close');
  $('#bigPreviewClose').addEventListener('click', closeBig);
  $('#bigPreview').addEventListener('click', function (ev) { if (ev.target.id === 'bigPreview') closeBig(); });

  // Auf kleinen Bildschirmen: Vorschau als Vollbild
  var pane = $('#previewPane');
  var paneHome = pane ? pane.parentNode : null;
  $('#mobilePreviewBtn').addEventListener('click', function () {
    $('#mobilePreviewHolder').appendChild(pane);
    $('#mobilePreview').classList.remove('hidden');
    if (!mobileLayer) mobileLayer = UI.layer($('#mobilePreview'), { onEscape: closeMobilePreview });
    setTimeout(function () { fitPhone(); preview.refreshIfStale(); }, 30);
  });
  // Auf dem Handy sitzt „Preview“ in der Leiste unten
  $('#navPreviewBtn').addEventListener('click', function () { $('#mobilePreviewBtn').click(); });
  function closeMobilePreview() {
    $('#mobilePreview').classList.add('hidden');
    paneHome.appendChild(pane);
    if (mobileLayer) { var l = mobileLayer; mobileLayer = null; l.release(); }
  }
  $('#mobilePreviewClose').setAttribute('aria-label', 'Close');
  $('#mobilePreviewClose').addEventListener('click', closeMobilePreview);

  // ================================================================
  // Ziele im Editor (/dashboard#<ziel>[/<argument>]) – aus der Glocke, aus Hinweisen und beim Laden
  // ================================================================
  // Weitere Ziele tragen die Funktionen hier ein (z. B. honeycombs/<feature>, settings/domain, status/system)
  var DEEP_LINKS = {
    content: function () { switchTab('content'); },
    design: function () { if (state.page) switchTab('design'); },
    stats: function () { if (state.page) switchTab('stats'); },
    messages: function () { switchTab('messages'); },
    code: function () { switchTab('code'); },
    settings: function (arg) {
      if (!state.page) return;
      switchTab('settings');
      // settings/domain: zum Abschnitt „Custom domain“
      var sec = arg === 'domain' && $('#domainSection');
      if (sec) sec.scrollIntoView({ block: 'start' });
    },
    honeycombs: function (arg) { openShop(arg); },
    // status/system: OnYourSites eigene Statusseite (Admin → Status verlinkt hierher); ohne den Bereich nichts
    status: function () { if ($('#tab-status')) switchTab('status'); }
  };
  // Alte Adressen (z. B. #nachrichten aus früheren Benachrichtigungen) weiter unterstützen
  var OLD_TARGETS = { inhalte: 'content', statistik: 'stats', nachrichten: 'messages', einstellungen: 'settings', shop: 'honeycombs' };
  function deepLink(hash) {
    var m = /^#?([a-z]+)(?:\/([a-z0-9_-]+))?$/.exec(hash || '');
    if (!m) return false;
    var target = OLD_TARGETS[m[1]] || m[1];
    if (!has(DEEP_LINKS, target)) return false;
    closeDropdowns();
    DEEP_LINKS[target](m[2] || '');
    return true;
  }
  // Ein Ziel ohne ?page= meint diesen Editor; mit ?page= nur, wenn es die offene Seite ist (sonst neu laden über die Wache)
  UI.onLink(function (url) {
    if (url.pathname !== '/dashboard') return false;
    var pm = /^\?page=(\d+)$/.exec(url.search);
    if (url.search && !(pm && state.page && Number(pm[1]) === state.page.id)) return false;
    if (!url.hash) return false;
    return deepLink(url.hash);
  });

  // ================================================================
  // Entwürfe: ungespeicherte Arbeit bleibt im Browser (Absturz, geschlossener Tab, abgelaufene Sitzung)
  // ================================================================
  // oys.draft.<Konto>.<Seite> = {v: 1, at, base, page} (payload() ohne Passwörter) und oys.draft.<Konto>.code.<Code-Seite>
  // = {v: 1, at, base, site, files, deleted} (nur geänderte und gelöschte Dateien). base: Prüfsumme des Stands vom
  // Server, auf dem die Änderungen aufbauen. Nach 7 Tagen weg; nie an den Server geschickt; je Konto getrennt.
  var draft = (function () {
    var uid = E.user && /^\d+$/.test(String(E.user.id)) ? String(E.user.id) : '';
    var PREFIX = 'oys.draft.', MAX_AGE = 7 * 864e5;
    var timer = null, pageKept = true, codeKept = true, discarded = false, pageGone = false;
    // Stand vom Server, auf dem die Änderungen der Seite aufbauen (bei der Code-Seite ist das code.saved)
    var pageBase = '';

    function store() { try { return window.localStorage || null; } catch (e) { return null; } }
    function get(key) {
      var s = store();
      if (!s) return null;
      try { var v = JSON.parse(s.getItem(key) || 'null'); return v && typeof v === 'object' && v.v === 1 ? v : null; } catch (e) { return null; }
    }
    function put(key, value) {
      var s = store();
      if (!s) return false;
      try { s.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    }
    function drop(key) { var s = store(); if (s) { try { s.removeItem(key); } catch (e) { /* egal */ } } }
    function keys() {
      var s = store(), out = [];
      if (!s) return out;
      try { for (var i = 0; i < s.length; i++) { var k = s.key(i); if (k && k.indexOf(PREFIX) === 0) out.push(k); } } catch (e) { /* egal */ }
      return out;
    }
    function pageKey(id) { return PREFIX + uid + '.' + id; }
    function codeKey(id) { return PREFIX + uid + '.code.' + id; }

    // Kurze Prüfsumme (FNV-1a, 32 Bit) über den bearbeitbaren Inhalt
    function hash(s) {
      var h = 0x811c9dc5;
      for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      return ('0000000' + h.toString(16)).slice(-8);
    }
    function contentOf(page, blocks) {
      return JSON.stringify({
        page: { title: page.title, subtitle: page.subtitle, bio: page.bio, avatar: page.avatar, bg_image: page.bg_image, theme: page.theme, layout: page.layout, settings: page.settings },
        blocks: blocks.map(function (b) { return { id: b.id, type: b.type, visible: b.visible, data: b.data, schedule: b.schedule, protection: b.protection, has_password: !!b.has_password, effect: b.effect }; })
      });
    }
    function pageHash(page, blocks) { return hash(contentOf(page, blocks)); }
    function codeHash(files) {
      var ks = Object.keys(files || {}).sort(), parts = [];
      ks.forEach(function (k) { parts.push(k, files[k]); });
      return hash(JSON.stringify(parts));
    }
    function codeSiteId() { return code.st && code.st.site ? code.st.site.id : 0; }

    // Seite: payload() ohne Passwörter (geschützte Links fragen beim Speichern wieder danach).
    // 'ok' gesichert (oder nichts zu sichern) · 'squeezed' erst nach dem Löschen der Code-Entwürfe · 'fail'
    function writePage() {
      if (!state.page || pageGone) return 'ok';
      if (!dirty) { drop(pageKey(state.page.id)); return 'ok'; }
      var p = payload();
      p.blocks.forEach(function (b) { b.password = ''; });
      var value = { v: 1, at: Date.now(), base: pageBase, page: p };
      if (put(pageKey(state.page.id), value)) return 'ok';
      // Speicher voll: zuerst die Code-Entwürfe dieses Kontos opfern, dann aufgeben
      keys().forEach(function (k) { if (k.indexOf(PREFIX + uid + '.code.') === 0) drop(k); });
      return put(pageKey(state.page.id), value) ? 'squeezed' : 'fail';
    }
    function writeCode() {
      var id = codeSiteId();
      if (!id) return true;
      if (!codeUnsaved()) { drop(codeKey(id)); return true; }
      var files = {}, deleted = [];
      Object.keys(code.files).forEach(function (p) { if (code.files[p] !== code.saved[p]) files[p] = code.files[p]; });
      Object.keys(code.saved).forEach(function (p) { if (!has(code.files, p)) deleted.push(p); });
      return put(codeKey(id), { v: 1, at: Date.now(), base: codeHash(code.saved), site: id, files: files, deleted: deleted });
    }
    function write() {
      clearTimeout(timer);
      timer = null;
      if (!uid || discarded) return;
      var r = writePage();
      pageKept = r !== 'fail';
      codeKept = r === 'ok' ? writeCode() : !codeUnsaved();
    }

    // Nach jeder Änderung (gebündelt, 800 ms nach der letzten)
    function later() {
      if (!uid) return;
      discarded = false;
      pageKept = codeKept = false;
      clearTimeout(timer);
      timer = setTimeout(write, 800);
    }
    // Sofort sichern (Tab wird verlassen oder versteckt). true: alles Ungespeicherte liegt im Browser – dann ist
    // das Fenster des Browsers beim Schließen nicht nötig (D19)
    function flush() {
      if (!uid || discarded) return false;
      if (timer || !pageKept || !codeKept) write();
      return pageKept && codeKept;
    }
    // „Leave without saving“ und Ähnliches: die Entwürfe dieser Seite und der Code-Seite verwerfen
    function discard() {
      clearTimeout(timer);
      timer = null;
      discarded = true;
      if (!uid) return;
      if (state.page) drop(pageKey(state.page.id));
      if (codeSiteId()) drop(codeKey(codeSiteId()));
    }
    function dropPage(id) {
      if (!uid) return;
      drop(pageKey(id));
      if (state.page && state.page.id === id) pageGone = true;
    }
    // Gespeichert: neuer Stand vom Server; was danach noch ungespeichert ist, kommt wieder in den Entwurf
    function pageSaved(page, blocks) {
      pageBase = pageHash(page, blocks.map(function (b) { return normBlock(clone(b)); }));
      if (!uid || !state.page) return;
      if (!dirty) { drop(pageKey(state.page.id)); pageKept = true; } else later();
    }
    function codeSaved() {
      if (!uid || !codeSiteId()) return;
      if (!codeUnsaved()) { drop(codeKey(codeSiteId())); codeKept = true; } else later();
    }

    function when(at) {
      var d = new Date(at), now = new Date();
      var hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + hm;
    }
    // 'restore' · 'discard' · null (✕, Escape: der Entwurf bleibt bis zur nächsten Änderung)
    function askRestore(at, changedSince) {
      return UI.choice({
        title: 'Restore unsaved changes?',
        text: 'You have changes from ' + when(at) + ' that weren’t saved.' + (changedSince ? ' This page was saved again after that – restoring replaces that version when you save.' : ''),
        options: [{ value: 'discard', text: 'Discard' }, { value: 'restore', text: 'Restore', primary: true }]
      });
    }

    // Beim Laden: alte Entwürfe weg, den der offenen Seite anbieten, andere Seiten als Hinweis mit „Open“
    function start() {
      var now = Date.now();
      keys().forEach(function (k) {
        var d = get(k);
        if (!d || typeof d.at !== 'number' || now - d.at > MAX_AGE || d.at > now + 864e5) drop(k);
      });
      if (state.page) pageBase = pageHash(state.page, state.blocks);
      if (!uid) return;
      var mine = PREFIX + uid + '.';
      keys().forEach(function (k) {
        var rest = k.slice(mine.length);
        if (k.indexOf(mine) !== 0 || !/^\d+$/.test(rest)) return;
        var id = Number(rest), p = pageById(id);
        // Entwürfe gelöschter (oder fremder) Seiten verwerfen
        if (!p) { drop(k); return; }
        if (state.page && id === state.page.id) return;
        toast({ id: 'oys-draft-' + id, text: 'Unsaved changes on “' + (p.title || p.slug) + '”.', tone: 'info', duration: 0,
          action: { label: 'Open', link: '/dashboard?page=' + id } });
      });
      if (!state.page) return;
      var d = get(pageKey(state.page.id));
      if (!d || !d.page || !d.page.page || !Array.isArray(d.page.blocks)) return;
      var pageId = state.page.id;
      askRestore(d.at, d.base !== pageBase).then(function (how) {
        if (!state.page || state.page.id !== pageId || !how) return;
        if (how === 'discard') { drop(pageKey(pageId)); return; }
        applyPage(d.page);
      });
    }
    // Entwurf übernehmen: Inhalt ersetzen, als ungespeichert markieren – gespeichert wird erst mit „Save“
    function applyPage(p) {
      var src = p.page || {}, clicks = {};
      // Klicks der gespeicherten Blöcke weiter anzeigen
      state.blocks.forEach(function (b) { clicks[b.id] = b.clicks; });
      ['title', 'subtitle', 'bio', 'avatar', 'bg_image', 'theme', 'layout'].forEach(function (k) { if (typeof src[k] === 'string') state.page[k] = src[k]; });
      if (src.settings && typeof src.settings === 'object' && !Array.isArray(src.settings)) state.page.settings = Object.assign({}, state.page.settings, src.settings);
      state.blocks = p.blocks.filter(function (b) { return b && typeof b === 'object' && typeof b.type === 'string'; }).map(function (b) {
        var nb = normBlock({ id: b.id, type: b.type, visible: b.visible !== false, data: b.data, schedule: b.schedule, protection: b.protection, effect: b.effect, has_password: !!b.has_password, clicks: clicks[b.id] || 0 });
        var m = /^n(\d+)$/.exec(String(nb.id));
        if (m) newCounter = Math.max(newCounter, Number(m[1]));
        return nb;
      });
      updatePageInfo();
      renderInhalte();
      renderCurrentTab();
      markDirty({ fast: true });
      toast('Unsaved changes restored – save to keep them.', 'info');
    }
    // Code-Tab geladen: Entwurf der Code-Seite anbieten (nicht, solange sie gesperrt ist)
    function offerCode() {
      var id = codeSiteId();
      if (!uid || !id || code.st.site.blocked) return;
      var d = get(codeKey(id));
      if (!d || !d.files || typeof d.files !== 'object' || !Array.isArray(d.deleted)) return;
      askRestore(d.at, d.base !== codeHash(code.saved)).then(function (how) {
        if (codeSiteId() !== id || !how) return;
        if (how === 'discard') { drop(codeKey(id)); return; }
        Object.keys(d.files).forEach(function (p) { if (typeof d.files[p] === 'string' && codeCheckPath(p).path === p) code.files[p] = d.files[p]; });
        d.deleted.forEach(function (p) { if (p !== 'index.html') delete code.files[p]; });
        code.docs = {};
        if (!has(code.files, code.cur)) code.cur = 'index.html';
        if (activeTab === 'code') renderCode();
        codeChanged();
        toast('Unsaved changes restored – save to keep them.', 'info');
      });
    }

    // Tab wird verlassen oder versteckt: sofort sichern
    window.addEventListener('pagehide', function () { flush(); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });

    return { later: later, flush: flush, discard: discard, dropPage: dropPage, pageSaved: pageSaved, codeSaved: codeSaved, start: start, offerCode: offerCode };
  })();

  // ================================================================
  // Start
  // ================================================================
  if (window.OYS_FLASH) {
    if (window.OYS_FLASH.success) toast(window.OYS_FLASH.success);
    if (window.OYS_FLASH.error) toast(window.OYS_FLASH.error, 'err');
  }
  // Beim Öffnen verdiente Honigwaben (notices vom Server): gelbe Hinweise, 700 ms versetzt, nichts geht verloren
  if (E.notices && E.notices.length) {
    UI.notices(E.notices, { label: 'History', link: '/dashboard#honeycombs/history' });
    setBalance(hc.balance, true);
  }

  // Ohne Verbindung: ein Hinweis, der bleibt, bis sie wieder da ist
  var offlineNote = null;
  function wentOffline() {
    if (!offlineNote) offlineNote = UI.toast({ id: 'oys-offline', text: 'You’re offline. Keep this tab open and save again when you’re back online.', tone: 'warn', duration: 0, icon: 'bx-wifi-off' });
  }
  window.addEventListener('offline', wentOffline);
  window.addEventListener('online', function () {
    if (!offlineNote) return;
    offlineNote.close();
    offlineNote = null;
    UI.toast('Back online.', 'info');
  });
  if (navigator.onLine === false) wentOffline();

  // Anker beim Laden (switchTab schreibt ihn gleich um)
  var startHash = location.hash;
  if (state.page) {
    updatePageInfo();
    setGlow(state.page.theme);
    renderInhalte();
    var initial = (startHash || '#content').slice(1).split('/')[0];
    initial = OLD_TARGETS[initial] || initial;
    switchTab(TAB_TITLES[initial] ? initial : 'content');
    fitPhone();
    preview.refresh();
    $('#pvEntrance').hidden = !state.page.settings.entrance.enabled;
  } else {
    $('#saveBtn').disabled = true;
    $('#mobilePreviewBtn').classList.add('hidden');
    $('#navPreviewBtn').classList.add('hidden');
    $('#viewPageLink').classList.add('hidden');
    $('#shareBtn').classList.add('hidden');
    $('#psLabel').textContent = 'No page yet';
    if (startHash === '#code') switchTab('code');
    else if (/^#messages\b/.test(startHash)) switchTab('messages');
    else if (/^#status\b/.test(startHash) && $('#tab-status')) switchTab('status');
  }
  draft.start();
  startBell();
  // Ziele, die kein Tab sind, öffnen beim Laden ebenso – und Honeycombs auch mit Ziel (#honeycombs/premium, ohne Seite)
  var startTarget = startHash.slice(1).split('/')[0];
  startTarget = OLD_TARGETS[startTarget] || startTarget;
  if (startTarget && (!TAB_TITLES[startTarget] || startTarget === 'honeycombs')) deepLink(startHash);

  // ui.js fehlt (blockiert oder nicht geladen): Hinweis statt eines halb funktionierenden Editors
  function editorUnavailable() {
    var main = document.getElementById('editorScroll');
    if (!main) return;
    var box = document.createElement('div');
    box.id = 'editorOff';
    box.className = 'max-w-lg mx-auto mt-10 bg-card border border-bordercolor rounded-2xl p-8 text-center';
    box.setAttribute('role', 'alert');
    box.innerHTML = '<div class="w-14 h-14 mx-auto rounded-2xl bg-red-500/10 text-red-400 flex items-center justify-center text-3xl mb-4"><i class="bx bx-error-circle"></i></div>' +
      '<p class="text-white font-semibold mb-6">The editor couldn’t load completely. Please reload the page.</p>' +
      '<a class="btn-primary mx-auto justify-center" style="width:max-content"><i class="bx bx-refresh"></i> Reload</a>';
    // Neu laden = dieselbe Adresse ohne Anker aufrufen
    box.querySelector('a').href = location.pathname + location.search;
    main.insertBefore(box, main.firstChild);
    var nb = document.getElementById('noPageBox');
    if (nb) nb.hidden = true;
    var save = document.getElementById('saveBtn');
    if (save) save.disabled = true;
  }
})();
