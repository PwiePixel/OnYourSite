'use strict';
// Verbindung zur Webseite (/_/bot/…). Jede Anfrage ist mit BOT_SECRET signiert:
// HMAC-SHA256 über "Zeitstempel \n METHODE \n Pfad?Query \n Inhalt" – das Geheimnis selbst wird nie gesendet.
const crypto = require('crypto');

class SiteClient {
  constructor(baseUrl, secret, { timeoutMs = 10000 } = {}) {
    this.base = new URL(baseUrl);
    this.secret = secret;
    this.timeoutMs = timeoutMs;
  }

  sign(timestamp, method, uri, body) {
    return crypto.createHmac('sha256', this.secret).update(`${timestamp}\n${method}\n${uri}\n${body}`).digest('hex');
  }

  async request(method, route, data) {
    const url = new URL(this.base.pathname.replace(/\/$/, '') + route, this.base);
    const uri = url.pathname + url.search;
    const body = method === 'GET' ? '' : JSON.stringify(data || {});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'OnYourSite-Bot/0.1',
      'X-OYS-Timestamp': timestamp,
      'X-OYS-Signature': this.sign(timestamp, method, uri, body),
    };
    if (body) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Keine Weiterleitungen folgen (z. B. http → https): die Signatur gilt nur für genau diese Adresse
      const res = await fetch(url, { method, headers, body: body || undefined, signal: controller.signal, redirect: 'error' });
      let json = null;
      try { json = await res.json(); } catch (e) { /* keine JSON-Antwort */ }
      if (!json || typeof json !== 'object') json = { ok: false, error: `The website answered with HTTP ${res.status}.` };
      json.httpStatus = res.status;
      return json;
    } catch (err) {
      return { ok: false, httpStatus: 0, error: err.name === 'AbortError' ? 'The website did not answer in time.' : 'The website could not be reached.' };
    } finally {
      clearTimeout(timer);
    }
  }

  get(route) { return this.request('GET', route); }
  post(route, data) { return this.request('POST', route, data); }
}

module.exports = { SiteClient };
