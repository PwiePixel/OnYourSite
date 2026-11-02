// Prüfung über die Kante (premium-domains PD-3) gegen einen echten HTTPS-Server mit Test-CA: richtige Antwort → ok;
// fremdes, abgelaufenes oder kein Zertifikat für den Namen → eindeutig falsch; 404 eines fremden Dienstes → falsch;
// 530, Herausforderung (cf-mitigated) und Zeitüberschreitung → unbekannt. Verbunden wird nur mit der Adresse der Kante,
// nie mit einer Adresse aus dem Namen; IP-Adressen als Name werden abgelehnt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { hasOpenssl, testPki, type TestPki } from './helpers/certs.js';
import { startTestEdge, type TestEdge } from './support/testEdge.js';
import { probeHost } from '../src/domains/worker/probe.js';

const skip = !hasOpenssl();
let pki: TestPki;
let edge: TestEdge;
const EXPECTED = 'a'.repeat(32);

before(async () => {
  if (skip) return;
  pki = testPki();
  edge = await startTestEdge(pki, async (host) => ({ status: 200, headers: { 'Content-Type': 'text/plain' }, body: host === 'links.example.com' ? EXPECTED : 'something else' }));
});

after(async () => {
  if (skip) return;
  await edge.close();
  pki.done();
});

const probe = (hostname: string, timeoutMs = 3000) => probeHost({ hostname, ips: ['127.0.0.1'], port: edge.port, expected: EXPECTED, ca: Buffer.from(pki.ca), timeoutMs });

test('the probe through a test edge: ok, wrong certificates, foreign answers, unknown errors', { skip }, async () => {
  const ok = await probe('links.example.com');
  assert.equal(ok.result, 'ok', JSON.stringify(ok));
  assert.match(String(ok.certValidTo), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(edge.requests.at(-1)?.host, 'links.example.com', 'Host header = the domain');
  // Antwort eines anderen Dienstes (200, aber nicht unsere Kennung)
  assert.deepEqual([(await probe('other.example.com')).result, (await probe('other.example.com')).reason], ['wrong', 'not_ours_200']);
  edge.certs.set('links.example.com', 'other');
  assert.deepEqual([(await probe('links.example.com')).result, (await probe('links.example.com')).reason], ['wrong', 'cert_invalid']);
  edge.certs.set('links.example.com', 'expired');
  assert.equal((await probe('links.example.com')).reason, 'cert_expired');
  edge.certs.set('links.example.com', 'none');
  const none = await probe('links.example.com');
  assert.equal(none.result, 'wrong', JSON.stringify(none));
  edge.certs.delete('links.example.com');
  edge.modes.set('links.example.com', { kind: 'status', status: 404, body: 'not found' });
  assert.deepEqual([(await probe('links.example.com')).result], ['wrong']);
  edge.modes.set('links.example.com', { kind: 'status', status: 530, body: 'error 1033' });
  assert.equal((await probe('links.example.com')).result, 'unknown');
  edge.modes.set('links.example.com', { kind: 'challenge' });
  assert.deepEqual([(await probe('links.example.com')).result, (await probe('links.example.com')).reason], ['unknown', 'challenge']);
  edge.modes.set('links.example.com', { kind: 'hang' });
  assert.deepEqual([(await probe('links.example.com', 400)).result, (await probe('links.example.com', 400)).reason], ['unknown', 'timeout']);
  edge.modes.delete('links.example.com');
  // Kein Name als IP, keine Kante: nie eine Verbindung
  const before = edge.requests.length;
  assert.equal((await probeHost({ hostname: '127.0.0.1', ips: ['127.0.0.1'], port: edge.port, expected: EXPECTED })).reason, 'invalid_name');
  assert.equal((await probeHost({ hostname: 'links.example.com', ips: [], port: edge.port, expected: EXPECTED })).reason, 'no_edge');
  assert.equal(edge.requests.length, before);
  // Ohne die Test-CA ist das Zertifikat nicht vertrauenswürdig → falsch (eindeutig)
  const untrusted = await probeHost({ hostname: 'links.example.com', ips: ['127.0.0.1'], port: edge.port, expected: EXPECTED, timeoutMs: 3000 });
  assert.deepEqual([untrusted.result, untrusted.reason], ['wrong', 'cert_invalid']);
});
