/* OnYourSite – Teilen: QR-Code (SVG und PNG), Link kopieren, WhatsApp, X, Discord und das Teilen-Menü
   des Geräts. Wird im Editor geladen und auf Profilseiten erst, wenn jemand auf „Teilen“ tippt.
   Der QR-Code kommt aus static/vendor/qrcode (qrcode-generator, MIT). */
(function (global) {
  'use strict';

  var loading = null;

  // QR-Bibliothek nachladen (nur einmal)
  function load(src) {
    if (global.qrcode) return Promise.resolve();
    if (!loading) {
      loading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = function () { if (global.qrcode) resolve(); else reject(new Error('QR code library missing')); };
        s.onerror = function () { loading = null; reject(new Error('QR code library could not be loaded')); };
        document.head.appendChild(s);
      });
    }
    return loading;
  }

  // Raster des QR-Codes (true = dunkles Feld), Fehlerkorrektur M – bleibt auch etwas verschmutzt lesbar
  function matrix(text) {
    var lib = global.qrcode;
    if (lib.stringToBytesFuncs && lib.stringToBytesFuncs['UTF-8']) lib.stringToBytes = lib.stringToBytesFuncs['UTF-8'];
    var qr = lib(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount(), rows = [];
    for (var r = 0; r < n; r++) {
      var row = [];
      for (var c = 0; c < n; c++) row.push(qr.isDark(r, c));
      rows.push(row);
    }
    return rows;
  }

  var QUIET = 4; // Ruhezone rundherum (Feldbreiten), damit Scanner den Code sicher finden

  function svg(text, opts) {
    opts = opts || {};
    var m = matrix(text), n = m.length, size = n + QUIET * 2, d = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (m[r][c]) d += 'M' + (c + QUIET) + ' ' + (r + QUIET) + 'h1v1h-1z';
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges"' +
      (opts.size ? ' width="' + opts.size + '" height="' + opts.size + '"' : '') + ' role="img" aria-label="QR code">' +
      '<rect width="' + size + '" height="' + size + '" fill="' + (opts.light || '#ffffff') + '"/>' +
      '<path d="' + d + '" fill="' + (opts.dark || '#000000') + '"/></svg>';
  }

  // PNG mit mindestens px Pixeln Kantenlänge (ganzzahlige Feldgröße → scharfe Kanten)
  function png(text, px, opts) {
    opts = opts || {};
    var m = matrix(text), n = m.length, size = n + QUIET * 2;
    var scale = Math.max(1, Math.ceil((px || 1024) / size)), dim = size * scale;
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = dim;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = opts.light || '#ffffff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = opts.dark || '#000000';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (m[r][c]) ctx.fillRect((c + QUIET) * scale, (r + QUIET) * scale, scale, scale);
      }
    }
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error('PNG could not be created')); }, 'image/png');
    });
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  function copy(text) {
    if (navigator.clipboard && global.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return copyFallback(text); });
    }
    return copyFallback(text);
  }
  function copyFallback(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      if (ok) resolve(); else reject(new Error('Copying failed'));
    });
  }

  // Adressen zum Teilen (Discord hat keine – dort wird der Link eingefügt und als Karte angezeigt)
  function links(url, title) {
    return {
      whatsapp: 'https://wa.me/?text=' + encodeURIComponent(title ? title + ' ' + url : url),
      x: 'https://x.com/intent/tweet?url=' + encodeURIComponent(url) + (title ? '&text=' + encodeURIComponent(title) : '')
    };
  }

  function canNativeShare() { return typeof navigator.share === 'function'; }
  function nativeShare(url, title) { return navigator.share({ title: title || '', url: url }); }

  // Dateiname für Downloads, z. B. „mia-qr.png“
  function fileName(url, ext) {
    var host = String(url).replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    return (host || 'page') + '-qr.' + ext;
  }

  global.OYSShare = {
    load: load, svg: svg, png: png, download: download, copy: copy, links: links,
    canNativeShare: canNativeShare, nativeShare: nativeShare, fileName: fileName
  };
})(window);
