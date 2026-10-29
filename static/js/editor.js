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
  var activeTab = 'content';

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

  function toast(msg, type) {
    var icon = type === 'err' ? 'bx-error-circle' : type === 'info' ? 'bx-info-circle' : type === 'hc' ? 'bx-hive' : 'bx-check-circle';
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
      return r.json().catch(function () { return { ok: false, error: 'Unexpected response from the server.' }; });
    }).catch(function () {
      return asText ? '' : { ok: false, error: 'No connection to the server.' };
    });
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
    return fetch('/dashboard/api/upload', { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-CSRF-Token': E.csrf } })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: 'Upload failed (connection error).' }; });
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
      toast('Changes saved – your page is up to date.');
      (res.warnings || []).forEach(function (w) { toast(w, 'info'); });
    });
  }

  $('#saveBtn').addEventListener('click', save);

  window.addEventListener('beforeunload', function (ev) {
    if (dirty || codeUnsaved()) { ev.preventDefault(); ev.returnValue = ''; }
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
          try { var err = JSON.parse(html); toast(err.error || 'Preview failed.', 'err'); } catch (e) { /* egal */ }
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
    if ((dirty || codeUnsaved()) && !confirm('You have unsaved changes. Switch pages anyway?')) return;
    dirty = false;
    code.saved = code.files;
    location.href = '/dashboard?page=' + id + location.hash;
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
    if (state.pages.length < max || E.premium) {
      html += '<button type="button" class="dd-item" data-action="new-page"><span class="ps-avatar"><i class="bx bx-plus"></i></span><span>Create a new page<small>With its own address and stats</small></span></button>';
    } else {
      html += '<div class="px-3 py-2 text-xs text-gray-500">Up to ' + max + ' pages per account.</div>';
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
      case 'open-messages': closeDropdowns(); switchTab('messages'); break;
      case 'share': openShareModal(); break;
      case 'honeycombs': openHoneycombs(); break;
      case 'open-code': closeModal(); switchTab('code'); break;
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
        toast('New notification: ' + (res.items[0] ? res.items[0].title : ''), 'info');
      }
      lastUnread = res.unread;
      var nb = $('#navMsgBadge');
      nb.hidden = !res.messages_unread;
      nb.textContent = res.messages_unread;
      if (!render) return;
      var html = '<div class="dd-head">Notifications' + (res.unread ? '<button type="button" data-action="notif-read">Mark all as read</button>' : '') + '</div>';
      if (!res.items.length) {
        html += '<div class="empty-state" style="padding:24px 10px"><i class="bx bx-bell-off"></i>Nothing new yet.</div>';
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
    shareOpen = null;
    box.classList.remove('wide');
    box.innerHTML = '<div class="modal-head"><h3>' + esc(title) + '</h3><button type="button" class="icon-btn" data-close><i class="bx bx-x"></i></button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' + (footHtml ? '<div class="modal-foot">' + footHtml + '</div>' : '');
    $('#modal').classList.remove('hidden');
    if (onMount) onMount(box);
    var first = $('input, textarea', box);
    if (first) setTimeout(function () { first.focus(); }, 40);
  }
  function closeModal() { $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; $('#modalBox').classList.remove('wide'); shareOpen = null; }
  $('#modal').addEventListener('click', function (ev) {
    if (ev.target.id === 'modal' || ev.target.closest('[data-close]')) closeModal();
  });

  function openNewPageModal() {
    var max = E.maxPages || 3;
    if (state.pages.length >= max && !E.premium) { toast('You already have ' + max + ' pages.', 'err'); return; }
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
          btn.disabled = true;
          api('page-create', { slug: slug.value, title: $('#npTitle', box).value, page_id: 0 }).then(function (res) {
            btn.disabled = false;
            if (res && res.ok) { dirty = false; location.href = '/dashboard?page=' + res.id; return; }
            var err = $('#npErr', box);
            err.textContent = (res && res.error) || 'That didn’t work.';
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
  var TAB_TITLES = { content: 'Content', design: 'Design', stats: 'Stats', messages: 'Messages', code: 'Code page', settings: 'Settings' };
  function switchTab(name) {
    if (!TAB_TITLES[name]) name = 'content';
    var wasCode = activeTab === 'code';
    activeTab = name;
    $$('.tab-content').forEach(function (t) { t.classList.add('hidden'); });
    $('#tab-' + name).classList.remove('hidden');
    $$('#mainNav .nav-btn[data-tab]').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    $('#pageTitle').textContent = TAB_TITLES[name];
    if (history.replaceState) history.replaceState(null, '', '#' + name);
    $('#editorScroll').scrollTop = 0;
    document.body.classList.toggle('code-mode', name === 'code');
    if ($('#noPageBox')) $('#noPageBox').hidden = name === 'code';
    if (wasCode !== (name === 'code')) fitPhone();
    paintSave(name === 'code' ? code.state : pageSaveState);
    if (name === 'code') loadCode();
    if (wasCode && name !== 'code' && state.page) {
      updatePageInfo();
      $('#pvLiveLabel').textContent = 'Live preview';
      preview.refreshIfStale();
    }
    if (!state.page) return;
    if (name === 'design') { renderDesign(); }
    if (name === 'stats') loadStats(statsRange);
    if (name === 'messages') loadMessages();
    if (name === 'settings') renderSettings();
  }
  $$('#mainNav .nav-btn[data-tab]').forEach(function (b) { b.addEventListener('click', function () { switchTab(b.dataset.tab); }); });
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
      (p.avatar ? '<button type="button" class="text-xs text-gray-500 hover:text-red-400" id="avatarDel">Remove</button>' : '<span class="text-[11px] text-gray-500">Profile picture</span>') +
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
        if (!files[0]) return;
        toast('Uploading profile picture…', 'info');
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
        confirm('This looks like ' + TYPES[embed].name + '. Embed it right on your page? (Cancel = add it as a normal link)')) {
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
      if (!confirm('Delete this block?')) return;
      state.blocks = state.blocks.filter(function (x) { return x !== b; });
      renderBlocks();
      markDirty({ fast: true });
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
      '<h1 class="oys-name">' + esc(p.title || 'Your name') + '</h1>' + (p.subtitle ? '<p class="oys-sub">' + esc(p.subtitle) + '</p>' : '') +
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
  function loadMessages() {
    var root = $('#tab-messages');
    if (!root.innerHTML) root.innerHTML = '<div class="empty-state"><i class="bx bx-loader-alt bx-spin"></i>Loading messages…</div>';
    apiGet('messages').then(function (res) {
      if (!res || !res.ok) { root.innerHTML = '<div class="empty-state">Couldn’t load messages.</div>'; return; }
      renderMessages(res);
      loadNotifications(false);
    });
  }

  function renderMessages(res) {
    var root = $('#tab-messages');
    var unread = res.messages.filter(function (m) { return !m.read; }).length;
    var hasContact = state.blocks.some(function (b) { return b.type === 'contact'; });
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
        if (act === 'delete' && !confirm('Delete this message?')) return;
        api('message', { id: id, action: act }).then(function () { loadMessages(); });
      });
    });
    $$('[data-booking-del]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('Delete this booking request?')) return;
        api('booking-delete', { id: Number(btn.dataset.bookingDel) }).then(function () { loadMessages(); });
      });
    });
  }

  // ================================================================
  // Honigwaben: Kontostand oben, Fenster mit „So verdienst du mehr“ und Verlauf
  // ================================================================
  var hc = E.honeycombs || { balance: 0, earned: [], history: [], rules: {} };
  function setBalance(n, pop) {
    hc.balance = n;
    $('#hcBalance').textContent = fmtNum(n);
    if (pop) { var b = $('#hcBtn'); b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  }

  function hcBody() {
    var r = hc.rules || {};
    var rules = [
      { icon: 'bx-calendar-check', title: 'Be active', text: 'Open your editor – once a day', amount: r.daily, done: hc.today, doneText: 'Collected today – come back tomorrow' },
      { icon: 'bx-user-check', title: 'Complete your profile', text: 'A profile picture, a bio and at least 3 links', amount: r.profile, done: hc.profile, doneText: 'Done – thanks!' },
      { icon: 'bx-trending-up', title: 'Get visitors', text: 'For every ' + fmtNum(r.views_step) + ' views of your pages – one reward a day (' + hc.viewRewards + ' of ' + hc.maxViewRewards + ' collected)', amount: r.views, done: hc.viewRewards >= hc.maxViewRewards, doneText: 'All ' + hc.maxViewRewards + ' rewards collected' },
      { icon: 'bx-gift', title: 'Gifts from the team', text: 'For great pages, events and helping others', amount: null }
    ].filter(function (x) { return x.amount === null || x.amount > 0; });
    var html = '<div class="hc-big"><i class="bx bx-hive"></i><div><b>' + fmtNum(hc.balance) + '</b><small>honeycombs</small></div></div>' +
      '<h4 class="hc-h">How to earn them</h4><div class="hc-rules">' + rules.map(function (x) {
        return '<div class="hc-rule' + (x.done ? ' done' : '') + '"><span class="ri"><i class="bx ' + (x.done ? 'bx-check' : x.icon) + '"></i></span>' +
          '<span class="min-w-0"><b>' + esc(x.title) + '</b><small>' + esc(x.done ? x.doneText : x.text) + '</small></span>' +
          (x.amount ? '<span class="amt">+' + fmtNum(x.amount) + '</span>' : '') + '</div>';
      }).join('') + '</div>' +
      '<h4 class="hc-h">What you can unlock</h4>' +
      '<div class="hc-rule"><span class="ri"><i class="bx bx-code-alt"></i></span><span class="min-w-0"><b>Your own code page</b><small>Host a website you build yourself with HTML, CSS and JavaScript</small></span>' +
        '<button type="button" class="btn-secondary" data-action="open-code">' + (hc.codeUnlocked ? 'Open' : fmtNum(r.code_page) + ' <i class="bx bx-hive"></i>') + '</button></div>' +
      '<h4 class="hc-h">History</h4>';
    if (!hc.history || !hc.history.length) return html + '<p class="hint">Nothing yet – your first honeycombs are on their way.</p>';
    return html + '<div>' + hc.history.map(function (x) {
      var cls = x.amount > 0 ? 'plus' : x.amount < 0 ? 'minus' : 'zero';
      return '<div class="hc-hist-row"><span class="min-w-0">' + esc(x.text) + '<small>' + esc(fmtDate(x.at, true)) + '</small></span>' +
        '<span class="amt ' + cls + '">' + (x.amount > 0 ? '+' + fmtNum(x.amount) : x.amount < 0 ? '−' + fmtNum(-x.amount) : 'free') + '</span></div>';
    }).join('') + '</div>';
  }

  function openHoneycombs() {
    closeDropdowns();
    openModal('Your honeycombs', '<div id="hcModal">' + hcBody() + '</div>');
    api('honeycombs').then(function (res) {
      if (!res || !res.ok) return;
      hc = res.honeycombs;
      setBalance(hc.balance);
      var box = $('#hcModal');
      if (box) box.innerHTML = hcBody();
    });
  }

  // ================================================================
  // Tab: Code-Seite – eigene Website aus HTML, CSS und JavaScript
  // ================================================================
  var code = { st: null, files: {}, saved: {}, cur: 'index.html', docs: {}, cm: null, saving: false, state: '', previewed: false };
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
    root.innerHTML = '<div class="empty-state"><i class="bx bx-loader-alt bx-spin"></i>Loading…</div>';
    apiGet('code').then(function (res) {
      if (!res || !res.ok) { root.innerHTML = '<div class="panel empty-state"><i class="bx bx-error-circle"></i>Couldn’t load your code page – please reload.</div>'; return; }
      setCodeState(res);
      renderCode();
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
      '<span class="bdg brand"><i class="bx bx-hive"></i> Unlock with honeycombs</span>' +
      '<h2>Your own website on OnYourSite</h2>' +
      '<p>Build your own page with HTML, CSS and JavaScript and host it at <b class="text-white">yourname.' + esc(E.baseHost) + '</b> – for everyone who wants more than a link page.</p>' +
      '<ul class="code-feats">' +
        '<li><i class="bx bx-check"></i> Code editor with syntax highlighting</li>' +
        '<li><i class="bx bx-check"></i> Up to 30 files: HTML, CSS, JS, JSON, SVG …</li>' +
        '<li><i class="bx bx-check"></i> Your own address – live as soon as you save</li>' +
        '<li><i class="bx bx-check"></i> Use the images you upload</li>' +
      '</ul>' +
      '<div class="code-price">' +
        '<div class="flex items-center justify-between text-sm mb-2"><span class="text-gray-400">Your honeycombs</span><b class="text-white">' + fmtNum(st.balance) + ' / ' + fmtNum(st.cost) + ' <i class="bx bx-hive text-brand-400"></i></b></div>' +
        '<div class="hc-bar"><span style="width:' + pct + '%"></span></div>' +
        '<button type="button" class="btn-primary w-full justify-center mt-4" data-code="unlock"' + (enough ? '' : ' disabled') + '><i class="bx bx-lock-open-alt"></i> ' +
          (enough ? 'Unlock for ' + fmtNum(st.cost) + ' honeycombs' : fmtNum(st.cost - st.balance) + ' more honeycombs needed') + '</button>' +
        '<button type="button" class="btn-ghost w-full justify-center mt-2" data-action="honeycombs"><i class="bx bx-hive"></i> How to earn honeycombs</button>' +
      '</div>' +
      '<p class="hint mt-6">Code pages are for personal, informational and promotional pages – no shops and no selling. <a href="' + esc(E.codeTerms) + '" target="_blank" rel="noopener" class="text-brand-400 hover:text-white">Rules for code pages</a></p>' +
    '</div>';
  }

  function openUnlockModal() {
    var st = code.st;
    openModal('Unlock your code page',
      '<div class="hc-big mb-4"><i class="bx bx-hive"></i><div><b>' + fmtNum(st.cost) + '</b><small>honeycombs · you have ' + fmtNum(st.balance) + '</small></div></div>' +
      '<p class="text-sm text-gray-400 mb-4">You unlock it once and keep it for good. Afterwards you have ' + fmtNum(st.balance - st.cost) + ' honeycombs left.</p>' +
      (st.terms ? '' : codeTermsHtml()) +
      '<p class="text-sm text-red-400 mt-3 hidden" id="codeErr"></p>',
      '<button type="button" class="btn-ghost" data-close>Cancel</button><button type="button" class="btn-primary" id="codeUnlockGo"><i class="bx bx-lock-open-alt"></i> Unlock</button>',
      function (box) {
        $('#codeUnlockGo', box).addEventListener('click', function () {
          var btn = this, terms = $('#codeTerms', box);
          if (terms && !terms.checked) { codeErr(box, 'Please accept the rules for code pages first.'); return; }
          btn.disabled = true;
          api('code-unlock', { terms: true }).then(function (res) {
            btn.disabled = false;
            if (!res || !res.ok) { codeErr(box, (res && res.error) || 'That didn’t work.'); return; }
            closeModal();
            setCodeState(res);
            setBalance(res.balance, true);
            renderCode();
            toast('Code page unlocked – ' + fmtNum(st.cost) + ' honeycombs spent.', 'hc');
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
    var p = code.cur;
    if (p === 'index.html' || !confirm('Delete ' + p + '? It’s removed from your page when you save.')) return;
    delete code.files[p];
    delete code.docs[p];
    openCodeFile('index.html');
    codeChanged();
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
    api('code-save', { files: files, deleted: deleted }).then(function (res) {
      code.saving = false;
      if (!res || !res.ok) { setCodeSaveState('dirty'); toast((res && res.error) || 'Saving failed.', 'err'); return; }
      setCodeState(res, true);
      setCodeSaveState(codeUnsaved() ? 'dirty' : 'saved');
      renderCodeFiles();
      codePreview(true);
      toast('Saved – your code page is up to date.');
    });
  }

  // Name, Adresse und Online-Schalter (ohne die Dateien anzufassen)
  function codeSettings(action, body, done) {
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
        var slug = $('#codeSlugEdit').value;
        if (slug === code.st.site.slug) return;
        if (!confirm('Move your code page to ' + slug + '.' + E.baseHost + '? The old address stops working right away.')) return;
        codeSettings('code-address', { slug: slug }, function (res) {
          $('#codeSlugEdit').value = res.site.slug;
          codePreview(true);
          toast('Your code page is now at ' + prettyUrl(res.site.url) + '.');
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
      toast(on ? 'Your code page is online.' : 'Your code page is offline – visitors see a notice.');
      codePreview(true);
    }).then(function (ok) { if (!ok) ev.target.checked = !on; });
  });

  // Vorschau: im Handy-Rahmen rechts (gespeicherter Stand) und als große Ansicht
  function codeUrl() { return code.st && code.st.site ? code.st.site.url + '/' : ''; }
  function codePreview(reload) {
    var url = codeUrl(), frame = $('#pvCode');
    frame.classList.toggle('on', !!url);
    if (!url || activeTab !== 'code') return;
    $('#pvOpen').href = url;
    $('#pvLiveLabel').textContent = 'Saved version';
    $('#bigPreviewUrl').textContent = prettyUrl(url);
    if (reload || !code.previewed) {
      code.previewed = true;
      frame.src = url + '?oys-preview=' + Date.now();
    }
  }
  function openCodeBig() {
    var url = codeUrl(), big = $('#bigPreviewFrame');
    if (!url) return;
    big.removeAttribute('srcdoc');
    big.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');
    big.src = url + '?oys-preview=' + Date.now();
    $('#bigPreviewUrl').textContent = prettyUrl(url);
    $('#bigPreview').classList.remove('hidden');
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

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Your pages <small>' + state.pages.length + ' of ' + max + ' · each with its own address & stats</small></h2><div class="panel">' +
      state.pages.map(function (pg) {
        var cur = pg.id === p.id;
        return '<div class="page-row' + (cur ? ' current' : '') + '"><span class="ps-avatar" style="width:36px;height:36px">' + (pg.avatar ? '<img src="' + esc(pg.avatar) + '" alt="">' : esc(initials(pg.title || pg.slug))) + '</span>' +
          '<span class="flex-1 min-w-0"><b class="truncate">' + esc(pg.title || pg.slug) + (cur ? ' <span class="bdg brand">Editing</span>' : '') + '</b><small>' + esc(pg.url) + '</small></span>' +
          (cur ? '' : '<button type="button" class="btn-secondary" data-page="' + pg.id + '">Edit</button>') +
          (state.pages.length > 1 ? '<button type="button" class="icon-btn danger" data-del-page="' + pg.id + '" data-slug="' + esc(pg.slug) + '" title="Delete page"><i class="bx bx-trash"></i></button>' : '') + '</div>';
      }).join('') +
      (state.pages.length < max || E.premium ? '<button type="button" class="btn-secondary mt-3" data-action="new-page"><i class="bx bx-plus"></i> Create a new page</button>' : '') + '</div></section>' +

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Search engines (SEO) <small>Applied when you save</small></h2><div class="panel space-y-4">' +
      '<div><label class="lbl">Title</label><input class="field" data-bind="page.settings.seo.title" maxlength="120" placeholder="Default: ' + esc((p.title || p.slug) + ' | OnYourSite') + '"></div>' +
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
      '<div class="flex items-center justify-between gap-4"><div><div class="text-sm text-white font-medium flex items-center gap-2">Hide “Made with OnYourSite” ' + (E.premium ? '' : '<span class="premium-pill"><i class="bx bxs-lock"></i> Premium</span>') + '</div><p class="hint" style="margin-top:2px">Removes the note at the bottom of your page.</p></div>' +
      '<label class="switch"><input type="checkbox" data-bind="page.settings.hide_branding"' + (E.premium ? '' : ' disabled') + '><span class="track"></span></label></div>' +
      '<div><label class="lbl">Custom CSS <small>(for pros)</small></label><textarea class="field css-editor" rows="6" data-bind="page.settings.custom_css" placeholder="/* e.g. .oys-name { letter-spacing: .1em; } */"></textarea>' +
      '<p class="hint">All elements have classes like <code>.oys-name</code>, <code>.oys-link</code>, <code>.oys-socials</code>. URLs pointing to other servers (<code>url(https://…)</code>, <code>@import</code>) are removed for privacy reasons – upload images here in the editor instead.</p></div></div></section>' +

      '<section class="max-w-3xl mx-auto mt-8"><h2 class="section-title">Integrations</h2><div class="panel space-y-3">' +
      '<label class="lbl flex items-center gap-2">Discord ID <span class="text-[10px] text-[#5865F2] bg-[#5865F2]/10 px-1.5 rounded">Auto role</span></label>' +
      '<div class="flex gap-2"><div class="input-group flex-1"><span class="addon left" style="color:#5865F2"><i class="bx bxl-discord-alt text-lg"></i></span><input class="field" id="discordId" value="' + esc(E.user.discord) + '" placeholder="1234567890" inputmode="numeric"></div>' +
      '<button type="button" class="btn-secondary" id="saveDiscord">Save</button></div>' +
      '<p class="hint">Link your Discord ID to automatically get the customer role on our server.</p></div></section>';

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
        if (changed) E.slugDaysLeft = E.premium ? 0 : 30;
        updatePageInfo();
        renderSettings();
        toast('Address saved: ' + prettyUrl(res.page.url));
      });
    });
    $$('[data-del-page]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var s2 = btn.dataset.slug;
        var typed = prompt('Delete page “' + s2 + '” with all its blocks, stats and messages?\nType the address to confirm: ' + s2);
        if (typed === null) return;
        api('page-delete', { id: Number(btn.dataset.delPage), confirm: typed.trim() }).then(function (res) {
          if (!res || !res.ok) { toast((res && res.error) || 'Something went wrong.', 'err'); return; }
          dirty = false;
          location.href = '/dashboard#settings';
        });
      });
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
  $('#pvBig').addEventListener('click', function () {
    if (activeTab === 'code') { openCodeBig(); return; }
    $('#bigPreviewFrame').removeAttribute('sandbox');
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
  // Auf dem Handy sitzt „Preview“ in der Leiste unten
  $('#navPreviewBtn').addEventListener('click', function () { $('#mobilePreviewBtn').click(); });
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
  (hc.earned || []).forEach(function (x, i) {
    setTimeout(function () {
      toast('+' + fmtNum(x.amount) + ' honeycombs ' + x.text, 'hc');
      if (i === 0) setBalance(hc.balance, true);
    }, 700 + i * 700);
  });

  if (state.page) {
    updatePageInfo();
    setGlow(state.page.theme);
    renderInhalte();
    var initial = (location.hash || '#content').slice(1);
    // Alte Adressen (z. B. #nachrichten aus früheren Benachrichtigungen) weiter unterstützen
    initial = { inhalte: 'content', statistik: 'stats', nachrichten: 'messages', einstellungen: 'settings' }[initial] || initial;
    switchTab(TAB_TITLES[initial] ? initial : 'content');
    fitPhone();
    preview.refresh();
    $('#pvEntrance').hidden = !state.page.settings.entrance.enabled;
    loadNotifications(false);
    setInterval(function () { if (!document.hidden) loadNotifications(!$('#bellMenu').classList.contains('hidden')); }, 60000);
  } else {
    $('#saveBtn').disabled = true;
    $('#mobilePreviewBtn').classList.add('hidden');
    $('#navPreviewBtn').classList.add('hidden');
    $('#viewPageLink').classList.add('hidden');
    $('#shareBtn').classList.add('hidden');
    $('#psLabel').textContent = 'No page yet';
    if (location.hash === '#code') switchTab('code');
  }
})();
