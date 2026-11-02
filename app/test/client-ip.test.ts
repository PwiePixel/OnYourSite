// Adresse des Besuchers hinter Apache: Mit client_ip_header (vom Installer gesetzt) zählt nur der Kopf, den Apache nach
// mod_remoteip setzt – und nur, wenn die Anfrage über localhost (von Apache) kommt. Ein mitgeschicktes CF-Connecting-IP
// oder ein gefälschter X-OYS-Client-IP von außen ändern nichts. Ohne den Schlüssel bleibt alles wie bisher
// (CF-Connecting-IP nur vom eigenen cloudflared, wie mod_remoteip mit RemoteIPInternalProxy 127.0.0.1).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, setConfigForTests, type ConfigData } from '../src/config.js';
import { makeTestCtx } from '../src/web/ctx.js';
import { clientKey } from '../src/web/security.js';

const BASE = loadConfig();
const without = (): ConfigData => {
  const c: ConfigData = { ...BASE };
  delete c.client_ip_header;
  return c;
};
after(() => setConfigForTests(BASE));

const ip = (peer: string, headers: Record<string, string> = {}) => makeTestCtx({ url: '/', ip: peer, headers }).ip;

test('without client_ip_header the address is taken like before (development and tests)', () => {
  setConfigForTests(without());
  assert.equal(ip('203.0.113.7'), '203.0.113.7');
  assert.equal(ip('::ffff:203.0.113.7'), '203.0.113.7');
  // cloudflared auf demselben Rechner: CF-Connecting-IP gilt
  assert.equal(ip('127.0.0.1', { 'cf-connecting-ip': '198.51.100.1' }), '198.51.100.1');
  assert.equal(ip('::1', { 'cf-connecting-ip': ' 2001:db8::1 ' }), '2001:db8::1');
  // Von außen nie
  assert.equal(ip('203.0.113.7', { 'cf-connecting-ip': '198.51.100.1' }), '203.0.113.7');
  // Der neue Kopf hat ohne Einstellung keine Bedeutung
  assert.equal(ip('127.0.0.1', { 'x-oys-client-ip': '198.51.100.9' }), '127.0.0.1');
});

test('with client_ip_header only the header set by Apache counts, and only from localhost', () => {
  setConfigForTests({ ...without(), client_ip_header: 'x-oys-client-ip' });
  // Apache (localhost) meldet die Adresse des Besuchers
  assert.equal(ip('127.0.0.1', { 'x-oys-client-ip': '198.51.100.9' }), '198.51.100.9');
  assert.equal(ip('::ffff:127.0.0.1', { 'x-oys-client-ip': '2001:db8::9' }), '2001:db8::9');
  assert.equal(ip('::1', { 'x-oys-client-ip': '198.51.100.9' }), '198.51.100.9');
  // Ein Besucher schickt CF-Connecting-IP mit (direkte Installation ohne Tunnel): zählt nicht – Apache hat die echte
  // Adresse in X-OYS-Client-IP geschrieben
  assert.equal(ip('127.0.0.1', { 'cf-connecting-ip': '6.6.6.6', 'x-oys-client-ip': '198.51.100.9' }), '198.51.100.9');
  // Fehlt der Kopf (z. B. eine Prüfung direkt auf Port 3000), bleibt es localhost – nie CF-Connecting-IP
  assert.equal(ip('127.0.0.1', { 'cf-connecting-ip': '6.6.6.6' }), '127.0.0.1');
  // Gefälscht von außen (Node direkt erreichbar): weder X-OYS-Client-IP noch CF-Connecting-IP zählen
  assert.equal(ip('203.0.113.7', { 'x-oys-client-ip': '6.6.6.6' }), '203.0.113.7');
  assert.equal(ip('203.0.113.7', { 'cf-connecting-ip': '6.6.6.6' }), '203.0.113.7');
  assert.equal(ip('::ffff:203.0.113.7', { 'x-oys-client-ip': '6.6.6.6', 'cf-connecting-ip': '7.7.7.7' }), '203.0.113.7');
  // Unbrauchbare Werte: localhost bleibt
  for (const v of ['', 'not-an-ip', '1.2.3.4, 5.6.7.8', '999.1.1.1', '1.2.3.4 x', '<script>']) {
    assert.equal(ip('127.0.0.1', { 'x-oys-client-ip': v }), '127.0.0.1', v);
  }
});

test('the header name is configurable and case-insensitive', () => {
  setConfigForTests({ ...without(), client_ip_header: ' X-Real-Visitor ' });
  assert.equal(ip('127.0.0.1', { 'x-real-visitor': '198.51.100.3', 'x-oys-client-ip': '6.6.6.6' }), '198.51.100.3');
  setConfigForTests({ ...without(), client_ip_header: '' });
  assert.equal(ip('127.0.0.1', { 'cf-connecting-ip': '198.51.100.1' }), '198.51.100.1');
});

test('rate limits key on the real visitor: spoofed headers can’t create new keys', () => {
  setConfigForTests({ ...without(), client_ip_header: 'x-oys-client-ip' });
  const key = (peer: string, headers: Record<string, string>) => clientKey(makeTestCtx({ url: '/', ip: peer, headers }));
  const real = key('127.0.0.1', { 'x-oys-client-ip': '198.51.100.9' });
  // Derselbe Besucher mit wechselnden CF-Connecting-IP-Werten bleibt derselbe Schlüssel
  for (const fake of ['1.1.1.1', '2.2.2.2', '2001:db8::5']) {
    assert.equal(key('127.0.0.1', { 'x-oys-client-ip': '198.51.100.9', 'cf-connecting-ip': fake }), real);
  }
  assert.notEqual(key('127.0.0.1', { 'x-oys-client-ip': '198.51.100.10' }), real);
});
