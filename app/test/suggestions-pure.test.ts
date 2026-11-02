// Öffentliche Vorschlagsseite ohne Datenbank: der Text für die Webseite (Discord-Zeichen, Leerzeilen, Anfang), keine
// Muster mit Backtracking-Risiko, die Seite selbst gegen Skripte in Titel, Text und Notiz, Filter, Seiten und Links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excerpt, hiddenReason, suggestionText, visible, EXCERPT_CHARS } from '../src/community/suggestions.js';
import { suggestionsView, type SuggestionsPageData } from '../src/community/suggestionsPage.js';
import type { PublicSuggestion } from '../src/community/suggestions.js';

test('suggestionText: Discord mentions, channels and custom emojis become plain words; blank lines are collapsed', () => {
  const id = '930000000000000001';
  assert.equal(suggestionText(`Hi <@${id}> and <@!${id}>, ask <@&${id}> in <#${id}> <:party:${id}> <a:wave:${id}>`),
    'Hi @member and @member, ask @role in #channel :party: :wave:');
  assert.equal(suggestionText('one\n\n\n\n\n\ntwo   \n  three\t\n'), 'one\n\n\ntwo\n  three');
  // Unvollständige oder zu lange Zeichen bleiben Text (e() maskiert sie später)
  assert.equal(suggestionText('<@abc> <#x> <:a b:1> <script>'), '<@abc> <#x> <:a b:1> <script>');
  assert.equal(suggestionText(null), '');
});

test('the excerpt is the first 280 code points (emojis count once) and says whether there is more', () => {
  const text = '😀'.repeat(EXCERPT_CHARS + 5);
  const ex = excerpt(text);
  assert.equal(Array.from(ex.text).length, EXCERPT_CHARS);
  assert.equal(ex.more, true);
  assert.deepEqual(excerpt('short'), { text: 'short', more: false });
});

test('no pattern can be slowed down by crafted text (ReDoS)', () => {
  const evil = ['<@' + '1'.repeat(200000), '<a:' + 'a'.repeat(200000), ' '.repeat(200000) + 'x', '\n'.repeat(200000) + 'x',
    '<@&'.repeat(50000), ('<:' + 'a'.repeat(32) + ':').repeat(5000), ' \n'.repeat(100000)];
  for (const input of evil) {
    const started = performance.now();
    suggestionText(input);
    assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms for ${JSON.stringify(input.slice(0, 12))}…`);
  }
});

test('visible(): off means nothing; hiddenReason explains in the order deleted, hidden, not told, open', () => {
  assert.equal(visible(false), '(1 = 0)');
  assert.match(visible(true), /removed_at IS NULL/);
  assert.equal(hiddenReason({ removed_at: '2026-11-01 10:00:00', web_state: 'shown', web_notice: 1, status: 'accepted' }), 'deleted in Discord');
  assert.equal(hiddenReason({ removed_at: null, web_state: 'hidden', web_notice: 1, status: 'accepted' }), 'hidden by the team');
  assert.equal(hiddenReason({ removed_at: null, web_state: 'auto', web_notice: 0, status: 'open' }), 'the author wasn’t told it could appear on the website');
  assert.equal(hiddenReason({ removed_at: null, web_state: 'auto', web_notice: 1, status: 'open' }), 'waiting for a decision');
});

const row = (over: Partial<PublicSuggestion> = {}): PublicSuggestion => ({
  id: 7, thread_id: '940000000000000007', title: 'Dark mode', body: 'Please add it.', status: 'accepted', reason: 'Coming in 3.1',
  created_at: '2026-11-01 10:00:00', decided_at: '2026-11-03 12:00:00', ...over,
});
const page = (over: Partial<SuggestionsPageData> = {}): string => suggestionsView({
  loggedIn: false, filter: 'all', counts: { all: 1, open: 0, accepted: 1, declined: 0 }, pageNo: 1, lastPage: 1, items: [row()],
  invite: 'https://discord.gg/x', guildId: '950000000000000001', ...over,
});

test('the page escapes title, text and note – no script, no attribute break-out, links stay plain text', () => {
  const evil = '"><img src=x onerror=alert(1)><script>alert(2)</script> https://evil.example';
  const html = page({ items: [row({ title: evil, body: evil + '\n' + 'x'.repeat(400), reason: evil, thread_id: '"><x' })] });
  assert.doesNotMatch(html, /<script>alert|<img src=x|onerror=alert\(1\)>/);
  assert.match(html, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /href="https:\/\/evil/, 'links are not made clickable');
  assert.doesNotMatch(html, /discord\.com\/channels\/[^"]*"&gt;/, 'a broken thread ID gives no link');
  // Die Karte: Abzeichen, Daten, Notiz, Link zum Beitrag
  const ok = page();
  assert.match(ok, /id="suggestion-7"/);
  assert.match(ok, />Accepted<\/span>/);
  assert.match(ok, /Suggested Nov 1, 2026 · Accepted Nov 3, 2026/);
  assert.match(ok, /Note from the team<\/p>\s*<p class="mt-1 whitespace-pre-line break-words">Coming in 3\.1<\/p>/);
  assert.match(ok, /href="https:\/\/discord\.com\/channels\/950000000000000001\/940000000000000007" target="_blank" rel="noopener"/);
  assert.doesNotMatch(page({ guildId: '' }), /Discuss on Discord/, 'no link while the server is unknown');
  // Langer Text: Anfang, dann „Show more“
  const long = page({ items: [row({ body: 'word '.repeat(100) })] });
  assert.match(long, /Show more/);
});

test('filters, pages and indexing: Open only with open suggestions, filtered views are noindex, the query stays when paging', () => {
  const all = page({ counts: { all: 45, open: 0, accepted: 40, declined: 5 }, pageNo: 2, lastPage: 3 });
  assert.doesNotMatch(all, />Open <span/);
  assert.match(all, /href="\/suggestions#list" aria-current="page"[^>]*>All <span class="text-gray-500">45<\/span>/);
  assert.match(all, /<link rel="canonical" href="http:\/\/[^"]+\/suggestions\?page=2">/);
  assert.doesNotMatch(all, /name="robots"/);
  assert.match(all, /href="\/suggestions#list" class="[^"]*"><i class='bx bx-left-arrow-alt'><\/i> Newer/);
  assert.match(all, /href="\/suggestions\?page=3#list"[^>]*>Older/);
  const filtered = page({ filter: 'accepted', counts: { all: 45, open: 2, accepted: 40, declined: 3 }, pageNo: 2, lastPage: 2 });
  assert.match(filtered, /<meta name="robots" content="noindex, follow">/);
  assert.match(filtered, />Open <span class="text-gray-500">2<\/span>/);
  assert.match(filtered, /href="\/suggestions\?status=accepted#list"[^>]*>[^<]*<i class='bx bx-left-arrow-alt'>/);
  assert.match(filtered, /<link rel="canonical" href="http:\/\/[^"]+\/suggestions">/);
  // Leere Listen
  assert.match(page({ items: [], counts: { all: 0, open: 0, accepted: 0, declined: 0 } }), /No suggestions on the website yet\. Post yours in #suggestions/);
  assert.match(page({ items: [], filter: 'declined' }), /No declined suggestions yet\./);
  // Unternavigation: Suggestions ist aktiv
  assert.match(all, /<a href="\/suggestions" aria-current="page"[^>]*><i class='bx bx-bulb hidden sm:inline-block'><\/i> Suggestions<\/a>/);
});
