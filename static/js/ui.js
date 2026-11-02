/* OnYourSite – eigene Dialoge, Hinweise und Formularprüfungen (window.OYSUI). Vertrag: static/js/ui.d.ts.
   Ohne Abhängigkeiten und ohne Build. App-Seiten bekommen das Aussehen aus ui.css, Profilseiten aus page.css (Theme);
   die gemeinsamen Grundregeln fügt diese Datei als erstes <style> in <head> ein. Alle Texte gehen als textContent
   hinein – nie als HTML. */
(function () {
  'use strict';
  if (window.OYSUI) return;
  var d = document, root = d.documentElement;
  var SAFE_LINK = /^\/(?!\/)[A-Za-z0-9\/_.~%#?=&-]*$/;
  var BX = /^bx[sl]?-[a-z0-9-]+$/;
  var MAX_LAYERS = 5, MAX_TOASTS = 4, uid = 0;
  var T = { ok: 'OK', cancel: 'Cancel', close: 'Close', confirm: 'Confirm', dismiss: 'Dismiss', oops: 'Something went wrong. Please try again.' };
  var TONES = { 'default': 1, warn: 1, danger: 1, hc: 1 };
  var TOAST_TONES = { ok: 1, info: 1, warn: 1, err: 1, hc: 1 };

  // ---------- Grundregeln beider Skins (die Skins liefern nur das Aussehen) ----------
  var BASE = 'html.ui-lock{overflow:hidden}html.ui-lock.ui-gutter{scrollbar-gutter:stable}' +
    '.ui-layer{position:fixed;top:0;right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:center;padding:16px;overscroll-behavior:contain;box-sizing:border-box}' +
    '.ui-dialog{width:100%;max-height:86vh;max-height:min(86vh,86dvh);display:flex;flex-direction:column;box-sizing:border-box}' +
    '.ui-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}.ui-content:empty,.ui-list:empty{display:none}' +
    '.ui-toasts{position:fixed;top:var(--ui-toast-top,76px);left:50%;transform:translateX(-50%);z-index:1000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}' +
    '.ui-toast{pointer-events:auto;display:flex;align-items:center;gap:8px;max-width:92vw;box-sizing:border-box;animation:ui-in .2s;transition:opacity .3s}' +
    '.ui-toast.is-out{opacity:0}.ui-toast-text{min-width:0;overflow-wrap:anywhere}.ui-svg{width:1.15em;height:1.15em;flex:none;fill:currentColor}' +
    '.ui-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
    '.ui-spin{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:ui-spin .7s linear infinite;box-sizing:border-box}' +
    '@media (prefers-reduced-motion:reduce){.ui-layer,.ui-dialog,.ui-toast{animation:none!important;transition:none!important}}' +
    '@keyframes ui-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}@keyframes ui-spin{to{transform:rotate(360deg)}}';
  (function () {
    if (d.getElementById('oys-ui-base')) return;
    var s = d.createElement('style');
    s.id = 'oys-ui-base';
    s.textContent = BASE;
    var head = d.head || root;
    head.insertBefore(s, head.firstChild);
  })();

  // ---------- Hilfen ----------
  function el(tag, cls, text) {
    var n = d.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function assign(t) {
    for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (has(s, k)) t[k] = s[k]; }
    return t;
  }
  // Unbekannte Optionen melden (Platzhalter-Namen aus älteren Entwürfen fallen so im ersten Testlauf auf)
  function warnKeys(o, keys, where) {
    if (!o || typeof o !== 'object') return;
    for (var k in o) if (has(o, k) && keys.indexOf(k) < 0) console.warn('OYSUI.' + where + ': unknown option "' + k + '"');
  }
  function skin() { return d.body && d.body.classList.contains('oys') ? 'page' : 'app'; }
  function focusEl(n) {
    if (!n || !n.focus) return;
    try { n.focus({ preventScroll: true }); } catch (e) { n.focus(); }
  }
  function cut(s, max) {
    s = String(s === undefined || s === null ? '' : s);
    if (s.length <= max) return s;
    var end = max - 1, c = s.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--;
    return s.slice(0, end) + '…';
  }
  var reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  // Symbole: Boxicons auf App-Seiten, kleine SVGs auf Profilseiten (dort ist Boxicons nicht immer geladen)
  var SVG = {
    ok: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    err: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
    info: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
    warn: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
    hc: 'M12 2 3.34 7v10L12 22l8.66-5V7z',
    help: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'
  };
  var BXI = { ok: 'bx-check-circle', err: 'bx-error-circle', info: 'bx-info-circle', warn: 'bx-error', hc: 'bx-hive', help: 'bx-help-circle', close: 'bx-x' };
  function icon(name, bx) {
    if (skin() === 'page') {
      var w = el('span');
      w.innerHTML = '<svg class="ui-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + SVG[name] + '"/></svg>';
      return w.firstChild;
    }
    var i = el('i', 'bx ' + (bx && BX.test(bx) ? bx : BXI[name]));
    i.setAttribute('aria-hidden', 'true');
    return i;
  }

  // ================================================================
  // Ebenen: Stapel, inert, Fokus, Escape, Zurück-Geste, Scroll-Sperre
  // ================================================================
  var stack = [], inerted = [], lockPad = null, watcher = null;
  var FOCUSABLE = 'a[href],area[href],button,input:not([type=hidden]),select,textarea,iframe,[tabindex],[contenteditable=""],[contenteditable=true]';

  function focusables(box) {
    var out = [], list = box.querySelectorAll(FOCUSABLE);
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.tabIndex >= 0 && !n.disabled && n.getClientRects().length) out.push(n);
    }
    return out;
  }
  function canFocus(n) { return n && n.isConnected && n !== d.body && n.tabIndex >= 0 && !n.disabled && !n.closest('[inert]'); }

  function lockScroll() {
    var gap = window.innerWidth - root.clientWidth;
    var cls = ['ui-lock'];
    lockPad = null;
    if (gap > 0) {
      if (window.CSS && CSS.supports && CSS.supports('scrollbar-gutter', 'stable')) cls.push('ui-gutter');
      else {
        lockPad = root.style.paddingRight;
        root.style.paddingRight = (parseFloat(getComputedStyle(root).paddingRight) || 0) + gap + 'px';
      }
    }
    for (var i = 0; i < cls.length; i++) root.classList.add(cls[i]);
  }
  function unlockScroll() {
    root.classList.remove('ui-lock', 'ui-gutter');
    if (lockPad !== null) { root.style.paddingRight = lockPad; lockPad = null; }
  }

  // Alles außer der obersten Ebene und den Hinweisen ist inert; nur selbst gesetzte Attribute werden wieder entfernt
  function applyInert() {
    var top = stack.length ? stack[stack.length - 1].el : null, keep = [], i;
    if (top && d.body) {
      var kids = d.body.children;
      for (i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k === top || k === toastBox || k.tagName === 'SCRIPT' || k.tagName === 'STYLE') continue;
        if (inerted.indexOf(k) >= 0) { keep.push(k); continue; }
        if (k.hasAttribute('inert')) continue;
        k.setAttribute('inert', '');
        keep.push(k);
      }
    }
    for (i = 0; i < inerted.length; i++) if (keep.indexOf(inerted[i]) < 0) inerted[i].removeAttribute('inert');
    inerted = keep;
  }

  // Ein CloseWatcher steht immer für die oberste Ebene (Zurück-Geste auf Android, Chromium)
  function syncWatcher() {
    if (typeof window.CloseWatcher !== 'function') return;
    if (stack.length && !watcher) {
      try { watcher = new window.CloseWatcher(); } catch (e) { watcher = null; return; }
      var w = watcher;
      w.onclose = function () {
        if (watcher === w) watcher = null;
        var top = stack[stack.length - 1];
        if (top && top.onEscape) top.onEscape();
        syncWatcher();
      };
    } else if (!stack.length && watcher) {
      var old = watcher;
      watcher = null;
      old.onclose = null;
      try { old.destroy(); } catch (e) { /* schon zu */ }
    }
  }

  function pushLayer(entry) {
    var a = d.activeElement, chain = [];
    for (var p = a && a.parentElement; p && p !== d.body; p = p.parentElement) chain.push(p);
    entry.prev = a;
    entry.chain = chain;
    entry.z = entry.el.style.zIndex;
    if (!stack.length) lockScroll();
    stack.push(entry);
    entry.el.style.zIndex = String(300 + 2 * stack.length);
    applyInert();
    syncWatcher();
    holdToasts();
  }
  function popLayer(entry) {
    var i = stack.indexOf(entry);
    if (i < 0) return;
    stack.splice(i, 1);
    entry.el.style.zIndex = entry.z;
    applyInert();
    if (!stack.length) unlockScroll();
    syncWatcher();
    // Fokus zurück: Auslöser, sonst fallbackFocus(), sonst der nächste fokussierbare Vorfahr
    if (i === stack.length) {
      if (canFocus(entry.prev)) focusEl(entry.prev);
      else {
        var f = entry.fallbackFocus ? entry.fallbackFocus() : null;
        if (f) focusEl(f);
        else for (var j = 0; j < entry.chain.length; j++) if (canFocus(entry.chain[j])) { focusEl(entry.chain[j]); break; }
      }
    }
    if (!stack.length) releaseToasts();
  }

  d.addEventListener('keydown', function (ev) {
    if (!stack.length) return;
    var top = stack[stack.length - 1];
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      if (ev.isComposing || ev.keyCode === 229) return;
      // Nur die oberste Ebene; keine Taste erreicht editor.js oder einen weiteren CloseWatcher
      ev.preventDefault();
      ev.stopPropagation();
      if (top.onEscape) top.onEscape();
      return;
    }
    if (ev.key === 'Tab') {
      var f = focusables(top.el);
      if (!f.length) { ev.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1], a = d.activeElement, inside = top.el.contains(a);
      if (ev.shiftKey && (a === first || !inside)) { ev.preventDefault(); focusEl(last); }
      else if (!ev.shiftKey && (a === last || !inside)) { ev.preventDefault(); focusEl(first); }
    }
  }, true);

  // Overlay der Seite als Ebene (z. B. das Passwort-Fenster im Admin): el muss direktes Kind von <body> sein
  function layer(n, o) {
    o = o || {};
    warnKeys(o, ['labelledBy', 'onEscape', 'fallbackFocus'], 'layer');
    if (!n || n.parentNode !== d.body) { console.error('OYSUI.layer: the element must be a direct child of <body>'); return null; }
    for (var i = 0; i < stack.length; i++) if (stack[i].el === n) return stack[i].handle;
    if (stack.length >= MAX_LAYERS) { console.warn('OYSUI.layer: too many layers'); return null; }
    var entry = { el: n, onEscape: o.onEscape || null, fallbackFocus: o.fallbackFocus || null };
    if (o.labelledBy) {
      var box = n.querySelector('[role=dialog],[role=alertdialog]') || n;
      if (!box.hasAttribute('aria-labelledby')) box.setAttribute('aria-labelledby', o.labelledBy);
    }
    pushLayer(entry);
    if (!n.contains(d.activeElement)) { var f = focusables(n); if (f.length) focusEl(f[0]); }
    entry.handle = { release: function () { popLayer(entry); } };
    return entry.handle;
  }

  // ================================================================
  // Dialoge: alert, confirm, prompt, choice
  // ================================================================
  var DIALOG_KEYS = ['title', 'text', 'list', 'tone', 'icon', 'ok', 'cancel', 'content', 'canConfirm', 'onConfirm', 'focus', 'fallbackFocus'];
  var PROMPT_KEYS = DIALOG_KEYS.concat(['label', 'value', 'placeholder', 'type', 'maxLength', 'inputMode', 'autocomplete', 'match', 'matchLabel', 'normalize', 'transform', 'validate']);
  var KEYS = { alert: DIALOG_KEYS, confirm: DIALOG_KEYS, prompt: PROMPT_KEYS, choice: DIALOG_KEYS.concat(['options']) };

  function toneIcon(kind, tone) {
    return tone === 'danger' ? 'err' : tone === 'warn' ? 'warn' : tone === 'hc' ? 'hc' : kind === 'alert' ? 'info' : 'help';
  }
  function btnClass(tone, primary) {
    return tone === 'danger' ? 'is-danger' : tone === 'hc' ? 'is-hc' : primary ? 'is-primary' : 'is-ghost';
  }

  function dialog(kind, o, quiet) {
    if (typeof o === 'string') o = { title: o };
    o = o || {};
    if (!quiet) warnKeys(o, KEYS[kind], kind);
    var empty = kind === 'alert' ? undefined : kind === 'confirm' ? false : null;
    return new Promise(function (resolve) {
      if (stack.length >= MAX_LAYERS) { console.warn('OYSUI.' + kind + ': too many layers – answered as Cancel'); resolve(empty); return; }
      var tone = TONES[o.tone] ? o.tone : 'default';
      var norm = normFn(o.normalize);
      var busy = false, done = false, forced = false, okBtn = null, cancelBtn = null, input = null, primary = null, entry;
      var layerEl = el('div', 'ui-layer'), box = el('div', 'ui-dialog is-' + tone);
      box.setAttribute('aria-modal', 'true');
      var head = el('div', 'ui-head'), ico = el('span', 'ui-ico'), title = el('h2', 'ui-title'), x = el('button', 'ui-x');
      ico.setAttribute('aria-hidden', 'true');
      title.id = 'ui-t' + (++uid);
      x.type = 'button';
      x.setAttribute('aria-label', T.close);
      x.appendChild(icon('close'));
      head.appendChild(ico);
      head.appendChild(title);
      head.appendChild(x);
      var body = el('div', 'ui-body'), text = el('p', 'ui-text'), list = el('ul', 'ui-list'), content = el('div', 'ui-content');
      text.id = 'ui-d' + (++uid);
      body.appendChild(text);
      body.appendChild(list);
      body.appendChild(content);
      var foot = el('div', 'ui-foot'), msg = el('p', 'ui-msg');
      msg.hidden = true;
      foot.appendChild(msg);
      box.appendChild(head);
      box.appendChild(body);
      box.appendChild(foot);
      layerEl.appendChild(box);

      function setTitle(s) {
        title.textContent = s;
        if (s) box.setAttribute('aria-labelledby', title.id);
        else box.setAttribute('aria-labelledby', text.id);
      }
      function setText(s) {
        text.textContent = s === undefined || s === null ? '' : String(s);
        text.hidden = !text.textContent;
        if (text.textContent) box.setAttribute('aria-describedby', text.id); else box.removeAttribute('aria-describedby');
      }
      function setList(items) {
        list.textContent = '';
        for (var i = 0; items && i < items.length; i++) list.appendChild(el('li', null, items[i]));
      }
      function setTone(t) {
        tone = TONES[t] ? t : 'default';
        box.className = 'ui-dialog is-' + tone;
        ico.textContent = '';
        ico.appendChild(icon(toneIcon(kind, tone), o.icon));
        if (okBtn) okBtn.className = 'ui-btn ' + btnClass(tone, true);
      }
      function setContent(c) {
        content.textContent = '';
        if (!c) return;
        if (typeof c === 'function') c(content, ctl);
        else content.appendChild(c);
      }
      function message(s, kind2) {
        s = s === undefined || s === null ? '' : String(s);
        msg.textContent = s;
        msg.hidden = !s;
        msg.className = 'ui-msg' + (kind2 === 'info' ? '' : ' is-err');
        if (s) msg.setAttribute('role', kind2 === 'info' ? 'status' : 'alert'); else msg.removeAttribute('role');
      }
      function values() {
        var out = {}, f = body.querySelectorAll('input[name],select[name],textarea[name]');
        for (var i = 0; i < f.length; i++) {
          var n = f[i];
          if (n.type === 'checkbox') out[n.name] = n.checked;
          else if (n.type === 'radio') { if (n.checked) out[n.name] = n.value; else if (!has(out, n.name)) out[n.name] = ''; }
          else out[n.name] = n.value;
        }
        return out;
      }
      function hasFields() { return !!body.querySelector('input:not([type=hidden]),select,textarea'); }
      // OK freigeben: Tippen zum Bestätigen, canConfirm und ctl.update({okDisabled})
      function refresh() {
        if (!okBtn || busy) return;
        var ok = !forced;
        if (ok && input && o.match !== undefined && o.match !== null) ok = norm(input.value) === norm(String(o.match));
        if (ok && o.canConfirm) { try { ok = !!o.canConfirm(values()); } catch (e) { console.error(e); ok = false; } }
        okBtn.disabled = !ok;
      }
      function setBusy(on, btn) {
        busy = on;
        if (on) box.setAttribute('aria-busy', 'true'); else box.removeAttribute('aria-busy');
        var all = foot.querySelectorAll('button');
        for (var i = 0; i < all.length; i++) all[i].disabled = on;
        x.disabled = on;
        var sp = foot.querySelector('.ui-spin');
        if (sp) sp.remove();
        if (on && btn) btn.insertBefore(el('span', 'ui-spin'), btn.firstChild);
        if (!on) refresh();
      }
      function finish(result) {
        if (done) return;
        done = true;
        popLayer(entry);
        layerEl.remove();
        resolve(result);
      }
      function cancel() { if (!busy) finish(empty); }
      function attempt(btn) {
        if (busy || done || (btn && btn.disabled)) return;
        var value;
        if (kind === 'prompt') {
          value = norm(input.value);
          if (o.match !== undefined && o.match !== null && value !== norm(String(o.match))) return;
          if (o.validate) {
            var bad = o.validate(value);
            if (bad) { message(bad, 'err'); input.setAttribute('aria-invalid', 'true'); focusEl(input); return; }
            input.removeAttribute('aria-invalid');
          }
        } else if (kind === 'choice') value = btn.__v;
        else if (kind === 'confirm') value = values();
        var result = kind === 'confirm' ? true : kind === 'alert' ? undefined : value;
        if (!o.onConfirm) { finish(result); return; }
        message('');
        var r;
        try { r = o.onConfirm(value, ctl); } catch (e) { console.error(e); message(T.oops, 'err'); return; }
        function after(v) {
          if (done) return;
          if (v === false) { refresh(); return; }
          if (typeof v === 'string') { message(v, 'err'); refresh(); return; }
          finish(result);
        }
        if (r && typeof r.then === 'function') {
          setBusy(true, btn || okBtn);
          r.then(function (v) { setBusy(false); after(v); }, function (e) { console.error(e); setBusy(false); if (!done) message(T.oops, 'err'); });
        } else after(r);
      }
      function addBtn(label, cls, value, onClick) {
        var b = el('button', 'ui-btn ' + cls);
        b.type = 'button';
        b.appendChild(el('span', 'ui-btn-label', label));
        b.__v = value;
        b.addEventListener('click', onClick || function () { attempt(b); });
        foot.appendChild(b);
        return b;
      }
      function focusFirst() {
        var t = null, f = o.focus;
        if (f === 'ok') t = okBtn || primary;
        else if (f === 'cancel') t = cancelBtn;
        else if (f === 'input') t = input;
        else if (typeof f === 'string' && f) { try { t = box.querySelector(f); } catch (e) { t = null; } }
        if (!t) t = input || ((tone === 'warn' || tone === 'danger') ? cancelBtn : null) || primary;
        if (!t || t.disabled || !t.getClientRects().length) t = focusables(box)[0] || x;
        focusEl(t);
      }

      var ctl = {
        body: body,
        values: values,
        update: function (p) {
          p = p || {};
          warnKeys(p, ['title', 'text', 'list', 'tone', 'ok', 'okDisabled', 'content'], 'update');
          var had = box.contains(d.activeElement) ? d.activeElement : null;
          if (p.title !== undefined) setTitle(String(p.title));
          if (p.text !== undefined) setText(p.text);
          if (p.list !== undefined) setList(p.list);
          if (p.tone !== undefined) setTone(p.tone);
          if (p.ok !== undefined && okBtn) okBtn.querySelector('.ui-btn-label').textContent = String(p.ok);
          if (p.okDisabled !== undefined) forced = !!p.okDisabled;
          if (p.content !== undefined) setContent(p.content);
          if (hasFields() || kind === 'prompt' || kind === 'choice') box.setAttribute('role', 'dialog');
          refresh();
          // Der Fokus bleibt im Dialog, auch wenn sein Element ersetzt wurde
          if (had && !box.contains(had)) focusFirst();
        },
        message: message,
        error: function (s) { message(s, 'err'); },
        close: function () { busy = false; finish(empty); }
      };

      setTitle(o.title !== undefined && o.title !== null ? String(o.title) : (kind === 'alert' ? '' : T.confirm));
      setText(o.text);
      setList(o.list);
      if (kind === 'prompt') {
        var lab = el('label', 'ui-label'), shown = o.matchLabel || o.match;
        input = el('input', 'ui-input');
        input.id = 'ui-i' + (++uid);
        lab.htmlFor = input.id;
        lab.textContent = o.label || (o.match !== undefined && o.match !== null ? 'Type ' + shown + ' to confirm' : '');
        input.type = ['text', 'email', 'url', 'password'].indexOf(o.type) >= 0 ? o.type : 'text';
        if (o.value !== undefined && o.value !== null) input.value = String(o.value);
        if (o.placeholder) input.placeholder = String(o.placeholder);
        if (o.maxLength) input.maxLength = o.maxLength;
        if (o.inputMode) input.setAttribute('inputmode', o.inputMode);
        input.setAttribute('autocomplete', o.autocomplete || 'off');
        if (o.match !== undefined || o.transform) { input.setAttribute('autocapitalize', 'off'); input.spellcheck = false; }
        if (lab.textContent) body.appendChild(lab);
        body.appendChild(input);
        var tf = o.transform;
        var applyTf = function () {
          if (!tf) return;
          var v = input.value, t = tf === 'lower' ? v.toLowerCase() : tf === 'slug' ? v.toLowerCase().replace(/[^a-z0-9-]/g, '') : typeof tf === 'function' ? String(tf(v)) : v;
          if (t === v) return;
          var pos = Math.max(0, (input.selectionStart || 0) - (v.length - t.length));
          input.value = t;
          try { input.setSelectionRange(pos, pos); } catch (e) { /* Typ ohne Auswahl */ }
        };
        input.addEventListener('input', function (ev) { if (!ev.isComposing) applyTf(); });
        input.addEventListener('compositionend', applyTf);
        input.addEventListener('keydown', function (ev) {
          if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229) return;
          ev.preventDefault();
          if (okBtn && !okBtn.disabled) attempt(okBtn);
        });
      }
      if (kind === 'choice') {
        var opts = o.options || [], anyPrimary = false, i;
        for (i = 0; i < opts.length; i++) if (opts[i] && opts[i].primary) anyPrimary = true;
        for (i = 0; i < opts.length; i++) {
          var op = opts[i] || {}, isPrimary = op.primary || (!anyPrimary && i === opts.length - 1);
          var b = addBtn(String(op.text === undefined ? op.value : op.text), btnClass(op.tone, isPrimary), String(op.value));
          if (isPrimary) primary = b;
        }
        if (tone === 'warn' || tone === 'danger') {
          for (i = 0; i < opts.length; i++) if (opts[i] && opts[i].tone !== 'danger' && !opts[i].primary) { cancelBtn = foot.querySelectorAll('.ui-btn')[i]; break; }
        }
      } else {
        if (kind !== 'alert') cancelBtn = addBtn(o.cancel || T.cancel, 'is-ghost', null, cancel);
        okBtn = primary = addBtn(o.ok || T.ok, btnClass(tone, true));
      }
      setTone(tone);
      setContent(o.content);
      if (done) return;                    // der Builder hat schon geschlossen
      box.setAttribute('role', (kind === 'alert' || kind === 'confirm') && !hasFields() ? 'alertdialog' : 'dialog');
      x.addEventListener('click', cancel);
      body.addEventListener('input', refresh);
      body.addEventListener('change', refresh);
      // Klick auf den Hintergrund = Abbrechen (nicht bei Eingaben, die verloren gingen); Ziehen aus dem Dialog zählt nicht
      var downOutside = false;
      layerEl.addEventListener('mousedown', function (ev) {
        downOutside = ev.target === layerEl;
        if (downOutside) ev.preventDefault();   // der Fokus bleibt im Dialog (z. B. im Feld eines prompt)
      });
      layerEl.addEventListener('click', function (ev) {
        if (ev.target !== layerEl || !downOutside || kind === 'prompt' || hasFields()) return;
        cancel();
      });

      d.body.appendChild(layerEl);
      entry = { el: layerEl, onEscape: cancel, fallbackFocus: o.fallbackFocus || null };
      pushLayer(entry);
      refresh();
      focusFirst();
    });
  }

  // ================================================================
  // Hinweise (Toasts) und Notices
  // ================================================================
  var toastBox = null, shown = [], waiting = [];
  var TOAST_KEYS = ['text', 'tone', 'title', 'amount', 'action', 'duration', 'id', 'icon'];
  var DUR = { ok: 3000, info: 3000, hc: 3000, warn: 5000, err: 5200 };

  function tbox() {
    if (!toastBox || !toastBox.isConnected) {
      toastBox = el('div', 'ui-toasts');
      toastBox.setAttribute('aria-live', 'polite');
      d.body.appendChild(toastBox);
    }
    return toastBox;
  }
  function findToast(fn) {
    var all = shown.concat(waiting);
    for (var i = 0; i < all.length; i++) if (fn(all[i])) return all[i];
    return null;
  }
  function fmtAmount(n) {
    var s = Math.abs(n).toLocaleString('en-US');
    return (n > 0 ? '+' : n < 0 ? '−' : '') + s;
  }
  function renderToast(t) {
    var o = t.o, n = t.el || el('div');
    n.className = 'ui-toast ' + o.tone;
    n.textContent = '';
    if (o.tone === 'err') n.setAttribute('role', 'alert'); else n.removeAttribute('role');
    n.appendChild(icon(o.tone, o.icon));
    var txt = el('span', 'ui-toast-text');
    if (o.title) txt.appendChild(el('b', null, o.title));
    txt.appendChild(d.createTextNode(o.text));
    n.appendChild(txt);
    if (o.amount) {
      var amt = el('span', 'ui-amt');
      amt.appendChild(icon('hc'));
      amt.appendChild(d.createTextNode(fmtAmount(o.amount)));
      amt.appendChild(el('span', 'ui-sr', ' honeycombs'));
      n.appendChild(amt);
    }
    if (o.action) {
      var a = el('button', 'ui-toast-act', o.action.label);
      a.type = 'button';
      a.addEventListener('click', function (ev) { ev.stopPropagation(); act(t); });
      n.appendChild(a);
    }
    if (!o.duration || o.tone === 'err' || o.action) {
      var c = el('button', 'ui-toast-x');
      c.type = 'button';
      c.setAttribute('aria-label', T.dismiss);
      c.appendChild(icon('close'));
      c.addEventListener('click', function (ev) { ev.stopPropagation(); dismiss(t); });
      n.appendChild(c);
    }
    t.el = n;
  }
  function act(t) {
    var a = t.o.action;
    dismiss(t);
    if (stack.length || !a) return;          // unter einem offenen Dialog: nur schließen
    if (a.link) openLink(a.link);
    else if (a.run) { try { a.run(); } catch (e) { console.error(e); } }
  }
  function startTimer(t) {
    clearTimeout(t.timer);
    t.timer = null;
    if (t.closed || !t.o.duration || t.hover || t.focus || (t.o.action && stack.length)) return;
    t.started = Date.now();
    t.timer = setTimeout(function () { dismiss(t); }, t.left);
  }
  function pauseTimer(t) {
    if (!t.timer) return;
    clearTimeout(t.timer);
    t.timer = null;
    t.left = Math.max(600, t.left - (Date.now() - t.started));
  }
  function showToast(t) {
    renderToast(t);
    shown.push(t);
    t.left = t.o.duration;
    var n = t.el;
    n.addEventListener('mouseenter', function () { t.hover = true; pauseTimer(t); });
    n.addEventListener('mouseleave', function () { t.hover = false; startTimer(t); });
    n.addEventListener('focusin', function () { t.focus = true; pauseTimer(t); });
    n.addEventListener('focusout', function () { t.focus = false; startTimer(t); });
    n.addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('button')) return;
      if (t.o.action) act(t); else dismiss(t);
    });
    tbox().appendChild(n);
    startTimer(t);
  }
  function dismiss(t) {
    if (t.closed) return;
    t.closed = true;
    clearTimeout(t.timer);
    var i = waiting.indexOf(t);
    if (i >= 0) { waiting.splice(i, 1); return; }
    i = shown.indexOf(t);
    if (i >= 0) shown.splice(i, 1);
    var n = t.el;
    if (n) {
      n.classList.add('is-out');
      setTimeout(function () { n.remove(); }, reduced && reduced.matches ? 0 : 300);
    }
    while (waiting.length && shown.length < MAX_TOASTS) showToast(waiting.shift());
  }
  // Hinweise mit Aktion warten, solange eine Ebene offen ist
  function holdToasts() { for (var i = 0; i < shown.length; i++) if (shown[i].o.action) pauseTimer(shown[i]); }
  function releaseToasts() { for (var i = 0; i < shown.length; i++) if (!shown[i].timer) startTimer(shown[i]); }

  function toast(o, tone) {
    if (o === null || o === undefined || typeof o !== 'object') o = { text: o === undefined || o === null ? '' : String(o), tone: tone };
    else warnKeys(o, TOAST_KEYS, 'toast');
    var tn = TOAST_TONES[o.tone] ? o.tone : 'ok';
    var a = o.action && typeof o.action === 'object' && o.action.label ? { label: String(o.action.label), link: o.action.link, run: o.action.run } : null;
    var dur = typeof o.duration === 'number' && o.duration >= 0 ? o.duration : DUR[tn];
    if (a && dur) dur = Math.max(dur, 8000);
    var no = { text: cut(o.text, 300), tone: tn, title: o.title ? cut(o.title, 120) : '', amount: typeof o.amount === 'number' && isFinite(o.amount) ? o.amount : 0,
      action: a, duration: dur, id: o.id ? String(o.id) : '', icon: o.icon };
    // Während eines Sitzungsdialogs (oder des Hinweises „abgemeldet“) keine Fehler-Hinweise je Anfrage
    if (tn === 'err' && sessionQuiet()) return { close: function () {} };
    var t;
    if (no.id && (t = findToast(function (x) { return x.o.id === no.id; }))) {
      t.o = no;
      if (t.el && shown.indexOf(t) >= 0) { renderToast(t); t.left = no.duration; startTimer(t); }
      return t.handle;
    }
    var key = tn + '|' + no.title + '|' + no.text;
    if ((t = findToast(function (x) { return x.key === key && Date.now() - x.at < 2000; }))) {
      t.at = Date.now();
      if (shown.indexOf(t) >= 0) { t.left = t.o.duration; startTimer(t); }
      return t.handle;
    }
    t = { o: no, key: key, at: Date.now() };
    t.handle = { close: function () { dismiss(t); } };
    if (shown.length < MAX_TOASTS) showToast(t); else waiting.push(t);
    return t.handle;
  }

  function notices(list, more) {
    if (!list || !list.length) return;
    var ok = [];
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (!n || typeof n !== 'object' || typeof n.text !== 'string') continue;
      ok.push({ text: n.text, tone: TOAST_TONES[n.tone] ? n.tone : 'info', title: n.title || '', amount: n.amount,
        action: n.action && n.action.label && n.action.link ? { label: n.action.label, link: n.action.link } : undefined });
    }
    var items = ok.length > 6 ? ok.slice(0, 5) : ok;
    if (ok.length > 6) {
      items.push({ text: '+' + (ok.length - 5) + ' more', tone: 'info',
        action: more && more.label && more.link ? { label: more.label, link: more.link } : undefined });
    }
    items.forEach(function (o, j) { if (j === 0) toast(o); else setTimeout(function () { toast(o); }, j * 700); });
  }

  // ================================================================
  // Antworten des Servers: Sitzung, Neuladen, notices
  // ================================================================
  var sess = { open: false, kind: '' };
  function sessionQuiet() {
    return sess.open || !!findToast(function (x) { return x.o.id === 'oys-session'; });
  }
  function draftNote() { return !!G && srcs.some(function (s) { return !!s.keepsDraft; }); }
  function sessionDialog(kind, data) {
    if (sess.open || findToast(function (x) { return x.o.id === 'oys-session'; })) return;
    var drafts = draftNote(), c;
    if (kind === 'login') {
      c = { title: 'You’re logged out', ok: 'Log in', note: 'You’re logged out.',
        text: 'Log in again to continue.' + (drafts ? ' Your unsaved changes are kept in this browser and offered again after you log in.' : ''),
        go: function () { go('/login', true, false); } };
    } else if (kind === 'expired') {
      c = { title: 'Your session has expired', ok: 'Reload', note: 'Your session has expired.',
        text: drafts ? 'Reload the editor to continue. Your unsaved changes are kept in this browser.' : 'Reload the page to continue.',
        go: function () { go(null, true, true); } };
    } else {
      var t = data && typeof data.error === 'string' && data.error ? data.error : 'This page was changed elsewhere. Reload it to continue.';
      c = { title: drafts ? 'Reload the editor' : 'Reload the page', ok: 'Reload', note: t, text: t, go: function () { go(null, true, true); } };
    }
    sess.open = true;
    sess.kind = kind;
    dialog('choice', { title: c.title, text: c.text, tone: 'warn', options: [{ value: 'close', text: T.close }, { value: 'go', text: c.ok, primary: true }] }, true)
      .then(function (v) {
        sess.open = false;
        if (v === 'go') { c.go(); return; }
        toast({ id: 'oys-session', text: c.note, tone: 'warn', duration: 0, action: { label: c.ok, run: c.go } });
      });
  }
  function handle(status, data) {
    var s = +status;
    if (s === 401) sessionDialog('login', data);
    else if (s === 419) sessionDialog('expired', data);
    else if ((s === 409 || s === 400) && data && data.reload) sessionDialog('reload', data);
    if (data && Array.isArray(data.notices) && data.notices.length) notices(data.notices.slice(0, 12));
    return data;
  }

  // ================================================================
  // Formulare: eigene Meldungen statt Browser-Blasen
  // ================================================================
  var round = [], roundTimer = null;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || '');
    return m ? MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1] : v;
  }
  function messageFor(f) {
    var v = f.validity, t = (f.type || '').toLowerCase(), isDate = /^(date|datetime-local|month|week)$/.test(t);
    var own = function (k) { return f.getAttribute('data-error-' + k); };
    if (v.valueMissing) {
      return own('required') || (f.tagName === 'SELECT' || t === 'radio' ? 'Please choose an option.' : t === 'checkbox' ? 'Please tick this box.'
        : isDate ? 'Please choose a date.' : t === 'time' ? 'Please choose a time.' : t === 'file' ? 'Please choose a file.' : 'Please fill in this field.');
    }
    if (v.typeMismatch) return own('type') || (t === 'email' ? 'Please enter a valid email address.' : t === 'url' ? 'Please enter a full link, e.g. https://example.com.' : 'Please check this field.');
    if (v.badInput) return own('number') || (isDate ? 'Please choose a date.' : 'Please enter a number.');
    if (v.tooShort) return own('short') || 'Please use at least ' + f.minLength + ' characters.';
    if (v.tooLong) return own('long') || 'Please use at most ' + f.maxLength + ' characters.';
    if (v.rangeUnderflow) return own('min') || (isDate ? 'Please choose ' + fmtDate(f.min) + ' or later.' : 'Please enter ' + f.min + ' or more.');
    if (v.rangeOverflow) return own('max') || (isDate ? 'Please choose ' + fmtDate(f.max) + ' or earlier.' : 'Please enter ' + f.max + ' or less.');
    if (v.stepMismatch) return own('step') || 'Please enter a whole number.';
    if (v.patternMismatch) return own('pattern') || f.title || 'Please match the requested format.';
    if (f.hasAttribute('data-match') && v.customError) return own('match') || 'The values don’t match.';
    return f.validationMessage || 'Please check this field.';
  }
  function anchorOf(f) {
    var w = f.closest('[data-field]');
    if (w) return w;
    if ((f.type === 'checkbox' || f.type === 'radio') && f.closest('label')) return f.closest('label');
    return f;
  }
  // Optionsgruppe (Optionsfelder mit gleichem Namen im selben Formular): eine gemeinsame Meldung nach der letzten Option
  function radioGroup(f) {
    if (!f || f.type !== 'radio' || !f.name) return null;
    var list = f.form ? f.form.elements : d.querySelectorAll('input[type=radio]'), out = [];
    for (var i = 0; i < list.length; i++) if (list[i].type === 'radio' && list[i].name === f.name && list[i].form === f.form) out.push(list[i]);
    return out.length > 1 ? out : null;
  }
  function showFieldError(f, s) {
    var list = radioGroup(f) || [f], p = null, i;
    for (i = 0; i < list.length && !p; i++) { var id = list[i].getAttribute('data-ui-err'); p = id ? d.getElementById(id) : null; }
    var a = anchorOf(list[list.length - 1]);
    if (!p) {
      p = el('p', 'ui-field-err');
      p.id = 'ui-e' + (++uid);
      a.insertAdjacentElement('afterend', p);
    }
    p.textContent = '';
    p.appendChild(icon('err'));
    p.appendChild(el('span', null, s));
    for (i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.getAttribute('data-ui-err') !== p.id) {
        m.setAttribute('data-ui-err', p.id);
        var db = m.getAttribute('aria-describedby');
        m.setAttribute('aria-describedby', db ? db + ' ' + p.id : p.id);
      }
      m.setAttribute('aria-invalid', 'true');
      m.__oysChecked = true;
    }
    if (a.hasAttribute('data-field')) a.setAttribute('data-invalid', '');
  }
  function clearFieldError(f) {
    var list = radioGroup(f) || [f];
    for (var i = 0; i < list.length; i++) {
      var m = list[i], id = m.getAttribute('data-ui-err');
      if (id) {
        var p = d.getElementById(id);
        if (p) p.remove();
        m.removeAttribute('data-ui-err');
        var db = (m.getAttribute('aria-describedby') || '').split(' ').filter(function (x) { return x && x !== id; }).join(' ');
        if (db) m.setAttribute('aria-describedby', db); else m.removeAttribute('aria-describedby');
      }
      m.removeAttribute('aria-invalid');
      var w = m.closest('[data-field]');
      if (w) w.removeAttribute('data-invalid');
    }
  }
  function rendered(f) { return !!f.getClientRects().length; }
  function labelOf(f) {
    var s = f.labels && f.labels.length ? f.labels[0].textContent : '';
    for (var n = f, depth = 0; !s && n && depth < 3; n = n.parentElement, depth++) {
      for (var p = n.previousElementSibling; p; p = p.previousElementSibling) if (p.tagName === 'LABEL') { s = p.textContent; break; }
    }
    s = s || f.getAttribute('aria-label') || f.getAttribute('placeholder') || f.name || '';
    return s.replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }
  function endRound() {
    var list = round;
    round = [];
    roundTimer = null;
    list.sort(function (a, b) { return a === b ? 0 : (a.compareDocumentPosition(b) & 4 ? -1 : 1); });
    var hidden = null, target = null;
    for (var i = 0; i < list.length; i++) {
      if (!list[i].isConnected) continue;
      if (rendered(list[i])) { if (!target) target = list[i]; } else if (!hidden) hidden = list[i];
    }
    if (hidden) {
      var l = labelOf(hidden);
      toast({ text: l ? 'Please check “' + l + '”.' : 'Please check the form.', tone: 'err' });
    }
    if (target) {
      focusEl(target);
      if (target.scrollIntoView) target.scrollIntoView({ block: 'center' });
    }
  }
  // Ein abgebrochenes invalid-Ereignis unterdrückt die Blase des Browsers; danach das erste Feld fokussieren
  d.addEventListener('invalid', function (ev) {
    var f = ev.target;
    if (!f || !f.validity) return;
    ev.preventDefault();
    if (rendered(f)) showFieldError(f, messageFor(f));
    round.push(f);
    if (!roundTimer) roundTimer = setTimeout(endRound, 0);
  }, true);

  // data-match="anderesFeld": gleich halten über setCustomValidity, damit die Prüfung des Browsers es einschließt
  function syncMatch(form) {
    if (!form || !form.querySelectorAll) return;
    var list = form.querySelectorAll('[data-match]');
    for (var i = 0; i < list.length; i++) {
      var f = list[i], other = null, els = form.elements;
      for (var j = 0; j < els.length; j++) if (els[j].name === f.getAttribute('data-match')) { other = els[j]; break; }
      if (!other || !f.setCustomValidity) continue;
      f.setCustomValidity(f.value !== '' && f.value !== other.value ? (f.getAttribute('data-error-match') || 'The values don’t match.') : '');
    }
  }
  // minlength auch dann, wenn ein Skript den Wert beim Tippen umschreibt (dann meldet der Browser tooShort nicht mehr)
  function syncLength(f) {
    if (!f || !f.setCustomValidity || !f.hasAttribute || !f.hasAttribute('minlength') || f.hasAttribute('data-match')) return;
    var min = f.minLength, n = String(f.value).length;
    if (n > 0 && min > 0 && n < min) {
      f.__oysShort = true;
      f.setCustomValidity(f.getAttribute('data-error-short') || 'Please use at least ' + min + ' characters.');
    } else if (f.__oysShort) {
      f.__oysShort = false;
      f.setCustomValidity('');
    }
  }
  function recheck(ev) {
    var f = ev.target;
    if (!f || !f.form && !f.validity) return;
    // nach den Handlern der Seite (die den Wert vielleicht noch ändern)
    setTimeout(function () { syncLength(f); }, 0);
    syncLength(f);
    if (f.form) syncMatch(f.form);
    var els = f.form ? f.form.elements : [f];
    for (var i = 0; i < els.length; i++) {
      var n = els[i];
      if (!n.__oysChecked || !n.validity) continue;
      if (n.validity.valid) clearFieldError(n);
      else if (n === f || n.hasAttribute('data-match')) showFieldError(n, messageFor(n));
    }
  }
  d.addEventListener('input', recheck, true);
  d.addEventListener('change', recheck, true);
  // Zurücksetzen (z. B. ein Fenster, das für die nächste Zeile wieder öffnet): Meldungen und eigene Prüfungen weg
  d.addEventListener('reset', function (ev) {
    var form = ev.target;
    if (!form || form.tagName !== 'FORM') return;
    for (var i = 0; i < form.elements.length; i++) {
      var f = form.elements[i];
      if (!f.validity) continue;
      clearFieldError(f);
      f.__oysChecked = false;
      if (f.setCustomValidity && (f.__oysShort || f.hasAttribute('data-match'))) { f.__oysShort = false; f.setCustomValidity(''); }
    }
  }, true);

  function validate(form) {
    if (!form || !form.elements) return true;
    syncMatch(form);
    var els = form.elements;
    for (var i = 0; i < els.length; i++) {
      syncLength(els[i]);
      if (els[i].validity && els[i].validity.valid) clearFieldError(els[i]);
    }
    return form.checkValidity();
  }

  // ================================================================
  // Bestätigungen für Formulare vom Server (data-confirm, beforeSubmit, _confirmed)
  // ================================================================
  var locked = [];
  function confirmedField(form) {
    var els = form.elements;
    for (var i = 0; i < els.length; i++) if (els[i].name === '_confirmed') return els[i];
    return null;
  }
  function isSubmitter(b) {
    var t = (b.getAttribute('type') || '').toLowerCase();
    return (b.tagName === 'BUTTON' && (t === '' || t === 'submit')) || (b.tagName === 'INPUT' && (t === 'submit' || t === 'image'));
  }
  function lockForm(form) {
    var els = form.elements;
    for (var i = 0; i < els.length; i++) {
      var b = els[i];
      if (isSubmitter(b) && !b.disabled) { b.disabled = true; b.setAttribute('aria-busy', 'true'); locked.push(b); }
    }
    form.setAttribute('aria-busy', 'true');
  }
  window.addEventListener('pageshow', function () {
    // Zurück aus dem Cache: Knöpfe wieder frei, nichts gilt mehr als bestätigt
    for (var i = 0; i < locked.length; i++) { locked[i].disabled = false; locked[i].removeAttribute('aria-busy'); }
    locked = [];
    var f = d.querySelectorAll('form[aria-busy]'), c = d.querySelectorAll('input[name="_confirmed"]'), tmp = d.querySelectorAll('input[data-ui-tmp]'), i2;
    for (i2 = 0; i2 < f.length; i2++) { f[i2].removeAttribute('aria-busy'); f[i2].__oysAsking = false; }
    for (i2 = 0; i2 < c.length; i2++) c[i2].value = '0';
    for (i2 = 0; i2 < tmp.length; i2++) tmp[i2].remove();
  });
  // Bestätigt: Formular erneut absenden – mit dem gedrückten Knopf (name/value), damit z. B. ticket_close ankommt
  function resubmit(form, btn) {
    var b = btn && btn.form === form && isSubmitter(btn) ? btn : null;
    if (typeof form.requestSubmit === 'function') {
      form.__oysPass = true;
      if (b) form.requestSubmit(b); else form.requestSubmit();
      form.__oysPass = false;            // scheitert die Prüfung, darf nichts durchrutschen
      return;
    }
    // Safari 15.5–15.x: kein requestSubmit – der Knopf als verstecktes Feld, dann ohne submit-Ereignis senden
    if (b && b.name) {
      var h = el('input');
      h.type = 'hidden';
      h.name = b.name;
      h.value = b.value;
      h.setAttribute('data-ui-tmp', '');
      form.appendChild(h);
    }
    // Ziel, Methode, Kodierung und Fenster des Knopfs (formaction …) gelten wie beim Klick: kurz an das Formular,
    // submit() liest sie sofort, danach wieder wie vorher
    var saved = [], ATTRS = [['formaction', 'action'], ['formmethod', 'method'], ['formenctype', 'enctype'], ['formtarget', 'target']];
    for (var i = 0; b && i < ATTRS.length; i++) {
      if (!b.hasAttribute(ATTRS[i][0])) continue;
      saved.push([ATTRS[i][1], form.getAttribute(ATTRS[i][1])]);
      form.setAttribute(ATTRS[i][1], b.getAttribute(ATTRS[i][0]));
    }
    try { HTMLFormElement.prototype.submit.call(form); } finally {
      for (var j = 0; j < saved.length; j++) { if (saved[j][1] === null) form.removeAttribute(saved[j][0]); else form.setAttribute(saved[j][0], saved[j][1]); }
    }
    setTimeout(function () { lockForm(form); }, 0);
  }
  function attrOptions(n) {
    var g = function (k) { var v = n.getAttribute('data-confirm' + k); return v === null ? undefined : v; };
    var o = { title: g(''), text: g('-text'), ok: g('-ok'), tone: g('-tone'), match: g('-match'), label: g('-label'), normalize: g('-normalize'), into: g('-into') };
    for (var k in o) if (o[k] === undefined) delete o[k];
    return o;
  }
  function ask(o, form) {
    var into = o.into, p = assign({}, o);
    delete p.into;
    if (p.match !== undefined && p.match !== null && p.match !== '') {
      if (!p.normalize) p.normalize = 'trim';
      if (!p.transform && (p.normalize === 'slug' || p.normalize === 'lower')) p.transform = p.normalize;
      return dialog('prompt', p).then(function (v) {
        if (v === null) return false;
        if (into) {
          var f = null, els = form.elements;
          for (var i = 0; i < els.length; i++) if (els[i].name === into) { f = els[i]; break; }
          if (!f) { f = el('input'); f.type = 'hidden'; f.name = into; form.appendChild(f); }
          f.value = v;
        }
        return true;
      });
    }
    return dialog('confirm', p);
  }
  // Erfassen vor allen anderen Handlern: erst fragen, dann einmal durchlassen
  d.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form || form.tagName !== 'FORM') return;
    if (form.__oysPass) {
      form.__oysPass = false;
      ev.__oysPassed = true;
      setTimeout(function () { if (!ev.defaultPrevented) lockForm(form); }, 0);
      return;
    }
    var btn = ev.submitter || null;
    var src = btn && btn.hasAttribute && btn.hasAttribute('data-confirm') ? btn : form.hasAttribute('data-confirm') ? form : null;
    var fn = form.__oysBefore, field = confirmedField(form);
    if (!fn && !src) { if (field) field.value = '1'; return; }   // für diesen Knopf ist keine Frage nötig
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (form.__oysAsking) return;
    form.__oysAsking = true;
    var res;
    try { res = fn ? fn(form, btn) : undefined; } catch (e) { console.error(e); res = false; }
    Promise.resolve(res).then(function (r) {
      if (r === false) return false;
      if (r === null) return true;
      var o = r && typeof r === 'object' ? r : src ? attrOptions(src) : null;
      return o ? ask(o, form) : true;
    }).then(function (ok) {
      form.__oysAsking = false;
      if (!ok) return;
      if (field) field.value = '1';
      // Erst nach diesem Ereignis: solange es läuft, ignoriert der Browser requestSubmit()
      setTimeout(function () { resubmit(form, btn); }, 0);
    }, function (e) { form.__oysAsking = false; console.error(e); });
  }, true);

  // ================================================================
  // Wache gegen das Verlassen mit ungespeicherten Änderungen
  // ================================================================
  var G = null, srcs = [], bypassUntil = 0;
  var LEAVE = { title: 'Leave without saving?', text: 'You have changes that aren’t saved yet. They’re lost if you leave now.',
    ok: 'Leave without saving', cancel: 'Stay', tone: 'danger' };
  function isDirty() {
    for (var i = 0; i < srcs.length; i++) { try { if (srcs[i].isDirty()) return true; } catch (e) { console.error(e); } }
    return false;
  }
  // D19: das Fenster des Browsers nur, wenn eine ungespeicherte Quelle keinen Entwurf im Browser hat
  function draftsKept() {
    for (var i = 0; i < srcs.length; i++) {
      var s = srcs[i], dirty = false, kept = false;
      try { dirty = s.isDirty(); } catch (e) { dirty = true; }
      if (!dirty) continue;
      try { kept = typeof s.keepsDraft === 'function' ? !!s.keepsDraft() : !!s.keepsDraft; } catch (e) { kept = false; }
      if (!kept) return false;
    }
    return true;
  }
  function discard() {
    for (var i = 0; i < srcs.length; i++) if (srcs[i].onDiscard) { try { srcs[i].onDiscard(); } catch (e) { console.error(e); } }
  }
  function bypass() { bypassUntil = Date.now() + 1500; }
  function guardConfirm(o) {
    if (!isDirty()) return Promise.resolve(true);
    var p = assign({}, LEAVE, o || {});
    return dialog('confirm', p).then(function (ok) { if (ok) discard(); return ok; });
  }
  function go(url, force, reload) {
    var p = force || !G ? Promise.resolve(true) : guardConfirm();
    return p.then(function (ok) {
      if (!ok) return false;
      bypass();
      if (reload) location.reload(); else location.href = url;
      return true;
    });
  }
  function guard(o) {
    if (!o || typeof o.isDirty !== 'function') throw new TypeError('OYSUI.guard: isDirty() is required');
    warnKeys(o, ['isDirty', 'onDiscard', 'keepsDraft'], 'guard');
    srcs.push(o);
    if (G) return G;
    G = {
      isDirty: isDirty,
      confirm: guardConfirm,
      navigate: function (url, p) { return go(url, !!(p && p.force), false); },
      reload: function (p) { return go(null, !!(p && p.force), true); }
    };
    window.addEventListener('beforeunload', function (ev) {
      var b = bypassUntil > Date.now();
      bypassUntil = 0;
      if (b || !isDirty() || draftsKept()) return;
      ev.preventDefault();
      ev.returnValue = '';
      return '';
    });
    window.addEventListener('focus', function () { bypassUntil = 0; });
    window.addEventListener('pageshow', function () { bypassUntil = 0; });
    // Links im selben Tab (auch zu anderen Seiten); mailto:, tel: … nur kurz ohne Schutz
    d.addEventListener('click', function (ev) {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!a || a.hasAttribute('download')) return;
      if (a.closest('[data-guard="off"]')) { bypass(); return; }     // ausdrücklich ohne Schutz, auch ohne Browser-Fenster
      var tg = (a.getAttribute('target') || '').toLowerCase();
      if (tg && tg !== '_self') return;
      var url;
      try { url = new URL(a.href, location.href); } catch (e) { return; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') { bypass(); return; }
      // Anker auf derselben Seite verlassen sie nicht – auch ein leerer (href="#": url.hash ist dann '', href endet auf #)
      if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search && url.href.indexOf('#') >= 0) return;
      if (!isDirty()) return;
      ev.preventDefault();
      guardConfirm().then(function (ok) { if (ok) { bypass(); location.href = url.href; } });
    });
    d.addEventListener('submit', function (ev) {
      var form = ev.target;
      if (ev.defaultPrevented || ev.__oysPassed || !form || form.tagName !== 'FORM') return;
      var btn = ev.submitter || null;
      if (form.closest('[data-guard="off"]') || (btn && btn.closest && btn.closest('[data-guard="off"]'))) { bypass(); return; }
      var tg = ((btn && btn.getAttribute('formtarget')) || form.getAttribute('target') || '').toLowerCase();
      if (tg && tg !== '_self') return;
      if (!isDirty()) return;
      ev.preventDefault();
      guardConfirm().then(function (ok) { if (ok) setTimeout(function () { bypass(); resubmit(form, btn); }, 0); });
    });
    return G;
  }

  // ================================================================
  // Eigene Links (Hinweise, Glocke): nur eigene Pfade derselben Herkunft
  // ================================================================
  var linkFns = [];
  function openLink(link) {
    if (typeof link !== 'string' || link.length > 255 || !SAFE_LINK.test(link)) return false;
    var url;
    try { url = new URL(link, location.origin); } catch (e) { return false; }
    if (url.origin !== location.origin) return false;
    for (var i = linkFns.length - 1; i >= 0; i--) { try { if (linkFns[i](url) === true) return true; } catch (e) { console.error(e); } }
    go(url.href, !G, false);
    return true;
  }

  var normalize = {
    // String#trim nimmt dieselben Zeichen weg wie \s, aber ohne das quadratische Zurückgehen von /\s+$/ bei langen
    // Eingaben (eingefügter Text in einem Feld zum Bestätigen würde den Tab sonst sekundenlang einfrieren)
    trim: function (s) { return String(s === undefined || s === null ? '' : s).trim(); },
    lower: function (s) { return normalize.trim(s).toLowerCase(); },
    slug: function (s) { return normalize.trim(s).toLowerCase().replace(/[^a-z0-9-]/g, ''); },
    // Domain: Schema, Pfad und Anmeldedaten weg, Unicode → Punycode (xn--…), wie gespeichert. Den Pfad schneidet eine
    // Suche nach dem ersten / ? # \ ab (/[\/?#\\].*$/ ginge bei langen Eingaben quadratisch zurück)
    host: function (s) {
      s = normalize.trim(s).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
      var cutAt = s.search(/[\/?#\\]/);
      if (cutAt >= 0) s = s.slice(0, cutAt);
      s = s.replace(/^[^@]*@/, '');
      if (!s) return '';
      try { s = new URL('http://' + s).hostname; } catch (e) { s = s.toLowerCase(); }
      return s.replace(/\.$/, '');
    }
  };
  function normFn(n) { return typeof n === 'function' ? function (s) { return String(n(String(s))); } : normalize[n] || normalize.trim; }

  // Hinweis-Banner vom Server (data-flash) werden Toasts: Erfolg 5 s, Fehler bleibt bis zum Schließen
  function flashToasts() {
    var list = d.querySelectorAll('[data-flash]');
    for (var i = 0; i < list.length; i++) {
      var b = list[i], tone = b.getAttribute('data-flash') === 'err' ? 'err' : 'ok', s = b.textContent.replace(/\s+/g, ' ').replace(/^ | $/g, '');
      b.remove();
      if (s) toast({ text: s, tone: tone, duration: tone === 'err' ? 0 : 5000 });
    }
  }

  var api = {
    alert: function (o) { return dialog('alert', o).then(function () {}); },
    confirm: function (o) { return dialog('confirm', o); },
    prompt: function (o) { return dialog('prompt', o); },
    choice: function (o) { return dialog('choice', o); },
    toast: toast,
    notices: notices,
    handle: handle,
    layer: layer,
    isOpen: function () { return stack.length > 0; },
    validate: validate,
    beforeSubmit: function (form, fn) { if (form) form.__oysBefore = typeof fn === 'function' ? fn : null; },
    guard: guard,
    navigate: function (url) { return go(String(url), !G, false); },
    reload: function () { return go(null, !G, true); },
    openLink: openLink,
    onLink: function (fn) { if (typeof fn === 'function') linkFns.push(fn); },
    normalize: normalize
  };
  Object.defineProperty(api, 'skin', { get: skin, enumerable: true });
  window.OYSUI = api;

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', flashToasts); else flashToasts();
})();
