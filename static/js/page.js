/* OnYourSite – Profilseite
   Statistik ohne Cookies, geschützte Links, Einbettungen per Klick, Countdown, Galerie,
   Kontaktformular, Eingang mit Musik, Partikel und Funken. Keine Abhängigkeiten. */
(function () {
  'use strict';

  var cfgEl = document.getElementById('oys-config');
  var cfg = {};
  try { cfg = JSON.parse(cfgEl ? cfgEl.textContent : '{}'); } catch (e) { cfg = {}; }
  var isPublic = cfg.mode === 'public';
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var body = document.body;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---------------------------------------------------------------
  // Statistik: nur ein Zähler, keine Cookies, kein Speicher im Browser
  // ---------------------------------------------------------------
  function beacon(url, data) {
    if (!isPublic) return;
    var params = new URLSearchParams(data);
    if (navigator.sendBeacon && navigator.sendBeacon(url, params)) return;
    try { fetch(url, { method: 'POST', body: params, keepalive: true, credentials: 'omit' }); } catch (e) { /* egal */ }
  }
  if (isPublic && cfg.page) {
    beacon('/_/v', { p: cfg.page });
  }

  document.addEventListener('click', function (ev) {
    var a = ev.target.closest ? ev.target.closest('a[data-b]') : null;
    if (!a) return;
    if (a.dataset.protect) {
      ev.preventDefault();
      openProtected(a);
      return;
    }
    if (a.getAttribute('href') === '#') {
      ev.preventDefault();
      return;
    }
    if (/^\d+$/.test(a.dataset.b)) {
      beacon('/_/c', { b: a.dataset.b, s: a.dataset.s || '' });
    }
  });

  // ---------------------------------------------------------------
  // Dialog (Passwort / Ab 18)
  // ---------------------------------------------------------------
  var modal = $('#oys-modal');
  var modalBody = modal ? $('.oys-modal-body', modal) : null;
  var lastFocus = null;

  function openModal(html) {
    if (!modal) return;
    lastFocus = document.activeElement;
    modalBody.innerHTML = html;
    modal.hidden = false;
    var first = $('input, a.oys-btn, button.oys-btn', modalBody);
    if (first) setTimeout(function () { first.focus(); }, 30);
  }
  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    modalBody.innerHTML = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  if (modal) {
    modal.addEventListener('click', function (ev) {
      if (ev.target === modal || ev.target.closest('.oys-modal-close') || ev.target.closest('[data-close]')) closeModal();
    });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !modal.hidden) closeModal(); });
  }

  var ICON_LOCK = '<svg class="oys-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  var ICON_OPEN = '<svg class="oys-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';

  function openProtected(a) {
    var id = a.dataset.b;
    var title = ($('.oys-link-title', a) || a).textContent.trim();
    var previewNote = isPublic ? '' : '<p class="oys-err">Vorschau: Speichere und teste den Link auf deiner echten Seite.</p>';

    if (a.dataset.protect === 'age') {
      openModal(
        '<div class="oys-modal-icon">18+</div>' +
        '<h2 id="oys-modal-title">Ab 18 Jahren</h2>' +
        '<p>„' + esc(title) + '“ ist nur für Erwachsene. Bist du mindestens 18 Jahre alt?</p>' + previewNote +
        (isPublic
          ? '<a class="oys-btn" href="/_/go/' + encodeURIComponent(id) + '?age=yes" target="_blank" rel="noopener noreferrer" data-close>Ja, ich bin 18 oder älter</a>'
          : '<button type="button" class="oys-btn" data-close>Ja, ich bin 18 oder älter</button>') +
        '<button type="button" class="oys-btn ghost" data-close>Nein, zurück</button>'
      );
      return;
    }

    openModal(
      '<div class="oys-modal-icon">' + ICON_LOCK + '</div>' +
      '<h2 id="oys-modal-title">Geschützter Link</h2>' +
      '<p>„' + esc(title) + '“ ist mit einem Passwort geschützt.</p>' + previewNote +
      '<form class="oys-unlock" autocomplete="off">' +
      '<input type="password" name="pw" placeholder="Passwort" required maxlength="100" aria-label="Passwort">' +
      '<p class="oys-err" hidden></p>' +
      '<button type="submit" class="oys-btn">' + ICON_LOCK + '<span>Entsperren</span></button>' +
      '</form>'
    );
    var form = $('.oys-unlock', modalBody);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var err = $('.oys-err', form);
      if (!isPublic) return;
      var btn = $('button', form);
      btn.disabled = true;
      fetch('/_/unlock', {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: new URLSearchParams({ b: id, pw: form.pw.value }),
        credentials: 'omit'
      }).then(function (r) { return r.json(); }).then(function (res) {
        btn.disabled = false;
        if (res && res.ok && res.url) {
          modalBody.innerHTML =
            '<div class="oys-modal-icon">' + ICON_OPEN + '</div>' +
            '<h2 id="oys-modal-title">Entsperrt</h2>' +
            '<p>Du kannst „' + esc(title) + '“ jetzt öffnen.</p>' +
            '<a class="oys-btn" href="' + esc(res.url) + '" target="_blank" rel="noopener noreferrer" data-close>' + ICON_OPEN + '<span>Link öffnen</span></a>';
          var open = $('a.oys-btn', modalBody);
          if (open) open.focus();
        } else {
          err.hidden = false;
          err.textContent = (res && res.error) || 'Das Passwort stimmt nicht.';
          form.pw.select();
        }
      }).catch(function () {
        btn.disabled = false;
        err.hidden = false;
        err.textContent = 'Verbindung fehlgeschlagen. Bitte versuche es erneut.';
      });
    });
  }

  // ---------------------------------------------------------------
  // YouTube, Twitch, Spotify erst nach Klick laden (Datenschutz)
  // ---------------------------------------------------------------
  $all('.oys-embed[data-src]').forEach(function (box) {
    var btn = $('.oys-embed-load', box);
    if (!btn) return;
    btn.addEventListener('click', function () {
      var src = box.dataset.src;
      if (box.dataset.provider === 'twitch') {
        var hosts = (cfg.hosts || []).slice();
        if (location.hostname && hosts.indexOf(location.hostname) === -1) hosts.unshift(location.hostname);
        src += hosts.map(function (h) { return '&parent=' + encodeURIComponent(h); }).join('');
      }
      var frame = document.createElement('iframe');
      frame.src = src;
      frame.title = ($('.oys-embed-title', box) || {}).textContent || 'Eingebetteter Inhalt';
      frame.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
      frame.setAttribute('allowfullscreen', '');
      frame.loading = 'lazy';
      box.innerHTML = '';
      box.appendChild(frame);
      if (/^\d+$/.test(box.dataset.b || '')) beacon('/_/c', { b: box.dataset.b });
    });
  });

  // ---------------------------------------------------------------
  // Countdown
  // ---------------------------------------------------------------
  var countdowns = $all('.oys-countdown[data-target]');
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function tick() {
    var now = Date.now();
    countdowns.forEach(function (el) {
      var target = Date.parse(el.dataset.target);
      if (isNaN(target)) return;
      var diff = Math.max(0, Math.floor((target - now) / 1000));
      var parts = { d: Math.floor(diff / 86400), h: Math.floor(diff % 86400 / 3600), m: Math.floor(diff % 3600 / 60), s: diff % 60 };
      $all('[data-u]', el).forEach(function (n) { n.textContent = pad(parts[n.dataset.u]); });
      if (diff === 0 && !el.classList.contains('is-done')) {
        el.classList.add('is-done');
        var grid = $('.oys-cd-grid', el); if (grid) grid.hidden = true;
        var done = $('.oys-cd-done', el); if (done) done.hidden = false;
      }
    });
  }
  if (countdowns.length) { tick(); setInterval(tick, 1000); }

  // ---------------------------------------------------------------
  // Galerie zum Wischen
  // ---------------------------------------------------------------
  $all('.oys-gallery').forEach(function (gal) {
    var track = $('.oys-gal-track', gal);
    var items = $all('.oys-gal-item', gal);
    var dots = $all('.oys-gal-dots button', gal);
    if (!track || items.length < 1) return;
    var index = 0;
    function go(i) {
      index = (i + items.length) % items.length;
      track.scrollTo({ left: items[index].offsetLeft, behavior: reduceMotion ? 'auto' : 'smooth' });
    }
    function sync() {
      var i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      if (i !== index) index = i;
      dots.forEach(function (d, k) { d.classList.toggle('on', k === index); });
    }
    var t;
    track.addEventListener('scroll', function () { clearTimeout(t); t = setTimeout(sync, 60); }, { passive: true });
    dots.forEach(function (d, k) { d.addEventListener('click', function () { go(k); }); });
    var prev = $('.oys-gal-nav.prev', gal), next = $('.oys-gal-nav.next', gal);
    if (prev) prev.addEventListener('click', function () { go(index - 1); });
    if (next) next.addEventListener('click', function () { go(index + 1); });
    if (gal.dataset.autoplay && items.length > 1 && !reduceMotion) {
      var timer = setInterval(function () { go(index + 1); }, 4500);
      ['pointerdown', 'touchstart', 'wheel'].forEach(function (e) {
        gal.addEventListener(e, function () { clearInterval(timer); }, { passive: true, once: true });
      });
    }
    items.forEach(function (it) {
      var img = $('img', it);
      img.addEventListener('click', function () {
        var lb = document.createElement('div');
        lb.className = 'oys-lightbox';
        lb.innerHTML = '<img src="' + esc(img.currentSrc || img.src) + '" alt="' + esc(img.alt) + '">';
        lb.addEventListener('click', function () { lb.remove(); });
        document.body.appendChild(lb);
      });
    });
  });

  // ---------------------------------------------------------------
  // Kontaktformular
  // ---------------------------------------------------------------
  $all('form.oys-contact').forEach(function (form) {
    var status = $('.oys-contact-status', form);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      status.className = 'oys-contact-status';
      if (!isPublic) {
        status.classList.add('err');
        status.textContent = 'Vorschau: Das Formular sendet erst auf deiner echten Seite.';
        return;
      }
      if (!form.checkValidity()) {
        status.classList.add('err');
        status.textContent = 'Bitte fülle alle Felder richtig aus.';
        return;
      }
      var btn = $('.oys-contact-send', form);
      btn.disabled = true;
      fetch(form.action, { method: 'POST', body: new FormData(form), headers: { 'Accept': 'application/json' }, credentials: 'omit' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          btn.disabled = false;
          if (res && res.ok) {
            form.classList.add('is-sent');
            status.classList.add('ok');
            status.textContent = status.dataset.success;
          } else {
            status.classList.add('err');
            status.textContent = (res && res.error) || 'Senden fehlgeschlagen.';
          }
        })
        .catch(function () {
          btn.disabled = false;
          status.classList.add('err');
          status.textContent = 'Verbindung fehlgeschlagen. Bitte versuche es erneut.';
        });
    });
  });

  // ---------------------------------------------------------------
  // Eingang mit Musik
  // ---------------------------------------------------------------
  var entrance = $('.oys-entrance');
  var audio = $('#oys-audio');
  var mute = $('.oys-mute');
  if (audio) audio.volume = Math.max(0, Math.min(1, cfg.volume == null ? .7 : cfg.volume));

  function enter() {
    if (!entrance || entrance.classList.contains('is-leaving')) return;
    entrance.classList.add('is-leaving');
    body.classList.add('is-entered');
    if (audio) {
      var p = audio.play();
      if (p && p.catch) p.catch(function () { if (mute) mute.classList.add('is-muted'); });
      if (mute) mute.hidden = false;
    }
    setTimeout(function () { if (entrance.parentNode) entrance.parentNode.removeChild(entrance); body.classList.remove('has-entrance'); }, 1300);
  }
  if (entrance) {
    entrance.addEventListener('click', enter);
    entrance.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); enter(); } });
    entrance.focus({ preventScroll: true });
  }
  if (mute && audio) {
    mute.addEventListener('click', function () {
      if (audio.paused) {
        audio.play();
        mute.classList.remove('is-muted');
        mute.setAttribute('aria-label', 'Musik stumm schalten');
      } else {
        audio.pause();
        mute.classList.add('is-muted');
        mute.setAttribute('aria-label', 'Musik abspielen');
      }
    });
  }

  // ---------------------------------------------------------------
  // Partikel: Schnee, Konfetti, Glühwürmchen
  // ---------------------------------------------------------------
  function makeCanvas() {
    var c = document.createElement('canvas');
    c.className = 'oys-fx-canvas';
    c.setAttribute('aria-hidden', 'true');
    body.appendChild(c);
    var ctx = c.getContext('2d');
    var state = { c: c, ctx: ctx, w: 0, h: 0 };
    function resize() {
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      state.w = c.clientWidth || window.innerWidth;
      state.h = c.clientHeight || window.innerHeight;
      c.width = Math.round(state.w * dpr);
      c.height = Math.round(state.h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);
    return state;
  }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function accentColor() {
    var v = getComputedStyle(body).getPropertyValue('--accent').trim();
    return v || '#ff7a1a';
  }

  function startParticles(kind) {
    var s = makeCanvas();
    var ctx = s.ctx;
    var parts = [];
    var palette = ['#ff4d6d', '#ffd23f', '#3bc8ff', '#7cfc8a', '#b388ff', '#ff9f43', accentColor()];
    var snowColor = cfg.dark ? '255,255,255' : '148,163,184';
    var count = kind === 'snow' ? Math.min(140, Math.max(45, Math.round(s.w * s.h / 9000))) : kind === 'confetti' ? 70 : 26;
    function spawn(p, initial) {
      p.x = rand(0, s.w);
      p.y = initial ? rand(0, s.h) : rand(-40, -10);
      if (kind === 'snow') { p.r = rand(1, 3.4); p.vy = rand(.35, 1.2); p.a = rand(.45, .95); p.sway = rand(.4, 1.4); p.ph = rand(0, 6.28); }
      if (kind === 'confetti') { p.w = rand(6, 10); p.h = rand(3, 6); p.vy = rand(1, 2.4); p.vx = rand(-.6, .6); p.rot = rand(0, 6.28); p.vr = rand(-.12, .12); p.col = palette[Math.floor(Math.random() * palette.length)]; p.ph = rand(0, 6.28); }
      if (kind === 'fireflies') { p.y = rand(0, s.h); p.vx = rand(-.35, .35); p.vy = rand(-.35, .35); p.r = rand(1.5, 2.8); p.ph = rand(0, 6.28); p.sp = rand(.01, .03); }
      return p;
    }
    for (var i = 0; i < count; i++) parts.push(spawn({}, true));
    var t = 0;
    function frame() {
      if (document.hidden) { requestAnimationFrame(frame); return; }
      t += 1;
      ctx.clearRect(0, 0, s.w, s.h);
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (kind === 'snow') {
          p.y += p.vy; p.x += Math.sin(t / 50 + p.ph) * p.sway * .5;
          if (p.y > s.h + 10) spawn(p, false);
          ctx.beginPath(); ctx.fillStyle = 'rgba(' + snowColor + ',' + p.a + ')'; ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
        } else if (kind === 'confetti') {
          p.y += p.vy; p.x += p.vx + Math.sin(t / 30 + p.ph) * .6; p.rot += p.vr;
          if (p.y > s.h + 20) spawn(p, false);
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, Math.cos(t / 12 + p.ph));
          ctx.fillStyle = p.col; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
        } else {
          p.vx += rand(-.03, .03); p.vy += rand(-.03, .03);
          p.vx = Math.max(-.6, Math.min(.6, p.vx)); p.vy = Math.max(-.6, Math.min(.6, p.vy));
          p.x += p.vx; p.y += p.vy;
          if (p.x < -20) p.x = s.w + 20; if (p.x > s.w + 20) p.x = -20;
          if (p.y < -20) p.y = s.h + 20; if (p.y > s.h + 20) p.y = -20;
          var a = .35 + .65 * Math.abs(Math.sin(t * p.sp + p.ph));
          var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 6);
          g.addColorStop(0, 'rgba(253,240,130,' + a + ')');
          g.addColorStop(.25, 'rgba(250,204,21,' + a * .55 + ')');
          g.addColorStop(1, 'rgba(250,204,21,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 6, 0, 6.283); ctx.fill();
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------
  // Funken hinter dem Mauszeiger
  // ---------------------------------------------------------------
  function startSparks() {
    var s = null, sparks = [], running = false, color = accentColor();
    function loop() {
      var ctx = s.ctx;
      ctx.clearRect(0, 0, s.w, s.h);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = sparks.length - 1; i >= 0; i--) {
        var p = sparks[i];
        p.x += p.vx; p.y += p.vy; p.vy += .07; p.life -= .028;
        if (p.life <= 0) { sparks.splice(i, 1); continue; }
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.white ? '#fff' : color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * p.life + .4, 0, 6.283); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (sparks.length) requestAnimationFrame(loop); else { running = false; ctx.clearRect(0, 0, s.w, s.h); }
    }
    var last = 0;
    window.addEventListener('pointermove', function (ev) {
      var now = Date.now();
      if (now - last < 16) return;
      last = now;
      if (!s) s = makeCanvas();
      for (var i = 0; i < 3; i++) {
        sparks.push({ x: ev.clientX, y: ev.clientY, vx: rand(-1.6, 1.6), vy: rand(-2.2, .4), r: rand(1.2, 3), life: 1, white: Math.random() < .3 });
      }
      if (sparks.length > 220) sparks.splice(0, sparks.length - 220);
      if (!running) { running = true; requestAnimationFrame(loop); }
    }, { passive: true });
  }

  if (!reduceMotion) {
    if (cfg.particles && cfg.particles !== 'none') startParticles(cfg.particles);
    if (cfg.sparks) startSparks();
  }
})();
