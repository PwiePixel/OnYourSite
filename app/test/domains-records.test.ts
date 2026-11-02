// Zusatz-Einträge von Cloudflare (PD-4, Schritt V_DOMAIN_RECORDS): nur nötige und gültige Einträge, höchstens 6,
// Spalte hin und zurück, kaputte oder fremd geschriebene Werte werden verworfen (kein Markup in der Ansicht).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeExtraRecords, encodeExtraRecords, extraRecordsFrom, EXTRA_MAX } from '../src/domains/records.js';
import type { CfHostname } from '../src/domains/worker/cloudflare.js';

const host = (o: Partial<CfHostname>): CfHostname => ({ id: 'h1', hostname: 'example.com', status: 'pending', ...o });

test('apex: ownership TXT and DCV TXT while pending, delegated DCV always', () => {
  const h = host({
    ownership_verification: { type: 'txt', name: '_cf-custom-hostname.Example.com.', value: 'abc-123' },
    ssl: { status: 'pending_validation', validation_records: [{ txt_name: '_acme-challenge.example.com', txt_value: 'tok-1' }],
      dcv_delegation_records: [{ cname: '_acme-challenge.example.com', cname_target: 'example.com.abcd.dcv.cloudflare.com' }] },
  });
  assert.deepEqual(extraRecordsFrom(h), [
    { type: 'TXT', name: '_cf-custom-hostname.example.com', value: 'abc-123' },
    { type: 'TXT', name: '_acme-challenge.example.com', value: 'tok-1' },
    { type: 'CNAME', name: '_acme-challenge.example.com', value: 'example.com.abcd.dcv.cloudflare.com' },
  ]);
  // Aktiv mit aktivem Zertifikat: nur der delegierte Eintrag bleibt
  const live = extraRecordsFrom({ ...h, status: 'active', ssl: { ...h.ssl, status: 'active' } });
  assert.deepEqual(live.map((r) => r.type), ['CNAME']);
  assert.deepEqual(extraRecordsFrom(null), []);
  assert.equal(encodeExtraRecords([]), null);
});

test('invalid names or values are dropped, list capped', () => {
  const bad = host({
    ownership_verification: { type: 'txt', name: '<img src=x onerror=alert(1)>', value: 'v' },
    ssl: { status: 'pending_validation', validation_records: [
      { txt_name: 'ok.example.com', txt_value: '"><script>alert(1)</script>\n' },
      { txt_name: 'ok.example.com', txt_value: 'line\nbreak' },
      ...Array.from({ length: 10 }, (_, i) => ({ txt_name: `_a${i}.example.com`, txt_value: 'v' + i })),
    ] },
  });
  const list = extraRecordsFrom(bad);
  assert.equal(list.length, EXTRA_MAX);
  assert.ok(list.every((r) => /^[a-z0-9_.-]+$/.test(r.name) && !/[\n]/.test(r.value)));
  assert.ok(!list.some((r) => r.name.includes('<')));
});

test('column round trip and broken column values', () => {
  const list = [{ type: 'TXT' as const, name: '_cf-custom-hostname.example.com', value: 'abc' }];
  assert.deepEqual(decodeExtraRecords(encodeExtraRecords(list)), list);
  assert.deepEqual(decodeExtraRecords('{not json'), []);
  assert.deepEqual(decodeExtraRecords(null), []);
  assert.deepEqual(decodeExtraRecords(JSON.stringify([{ type: 'A', name: 'x.com', value: '1.2.3.4' }, { type: 'TXT', name: 'a b', value: 'x' }])), []);
});
