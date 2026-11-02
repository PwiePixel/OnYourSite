// Statusseiten, robots.txt (robots.ts): nur die Gruppe „OnYourSite-Monitor“ (Groß-/Kleinschreibung egal, „*“ zählt
// nicht), längste Regel gewinnt, bei Gleichstand Allow, „*“ und „$“, 4xx = keine Regeln, 5xx = die alten bleiben,
// höchstens 64 KiB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROBOTS_MAX, parseRobots, robotsAfterFetch, robotsAllows, rulesFromJson } from '../src/status/robots.js';

test('only a group naming OnYourSite-Monitor counts; groups for * are ignored', () => {
  const txt = [
    'User-agent: *', 'Disallow: /', '',
    'User-agent: Googlebot', 'Disallow: /private', '',
    'user-agent: onyoursite-monitor', 'Disallow: /admin  # our own group', 'Allow: /admin/health', '',
    'User-agent: Other', 'User-agent: OnYourSite-Monitor/1.0', 'Disallow: /tmp',
  ].join('\r\n');
  const rules = parseRobots(txt);
  assert.deepEqual(rules, [['disallow', '/admin'], ['allow', '/admin/health'], ['disallow', '/tmp']]);
  assert.equal(robotsAllows(rules, '/'), true, 'the * group does not stop us');
  assert.equal(robotsAllows(rules, '/private'), true);
  assert.equal(robotsAllows(rules, '/admin/users'), false);
  assert.equal(robotsAllows(rules, '/admin/health'), true, 'the longer allow wins');
  assert.equal(robotsAllows(rules, '/tmp/x'), false);
  assert.deepEqual(parseRobots('User-agent: *\nDisallow: /'), []);
  assert.deepEqual(parseRobots('User-agent: OnYourSite-Monitor\nDisallow:'), [], 'an empty Disallow allows everything');
});

test('longest match, ties go to Allow, * and $ patterns, the query counts, percent-encoding is normalised', () => {
  const rules = parseRobots([
    'User-agent: OnYourSite-Monitor',
    'Disallow: /shop',
    'Allow: /shop',
    'Disallow: /*.php$',
    'Disallow: /search?q=',
    'Allow: /a%2fb',
    'Disallow: /%7Euser',
  ].join('\n'));
  assert.equal(robotsAllows(rules, '/shop/cart'), true, 'same length: allow');
  assert.equal(robotsAllows(rules, '/index.php'), false);
  assert.equal(robotsAllows(rules, '/index.php?x=1'), true, '$ anchors the end');
  assert.equal(robotsAllows(rules, '/x/y/z.php'), false);
  assert.equal(robotsAllows(rules, '/search?q=test'), false);
  assert.equal(robotsAllows(rules, '/search'), true);
  assert.equal(robotsAllows(rules, '/~user/page'), false, '%7E is ~');
  assert.equal(robotsAllows(rules, '/robots.txt'), true, 'robots.txt itself is always allowed');
  assert.equal(robotsAllows(parseRobots('User-agent: onyoursite-monitor\nDisallow: /'), '/robots.txt'), true);
  assert.equal(robotsAllows(parseRobots('User-agent: onyoursite-monitor\nDisallow: /'), '/'), false);
  assert.equal(robotsAllows([], '/anything'), true);
});

test('fetch results: 2xx parses, 4xx means no rules, 5xx and unreachable keep the last rules', () => {
  const prev = parseRobots('User-agent: OnYourSite-Monitor\nDisallow: /x');
  assert.deepEqual(robotsAfterFetch(200, 'User-agent: OnYourSite-Monitor\nDisallow: /y', prev), { rules: [['disallow', '/y']], error: null });
  assert.deepEqual(robotsAfterFetch(404, null, prev), { rules: [], error: null });
  assert.deepEqual(robotsAfterFetch(403, 'x', prev), { rules: [], error: null });
  assert.deepEqual(robotsAfterFetch(503, null, prev), { rules: prev, error: 'status' });
  assert.deepEqual(robotsAfterFetch(null, null, prev), { rules: prev, error: 'unreachable' });
  assert.deepEqual(robotsAfterFetch(null, null, null), { rules: [], error: 'unreachable' });
});

test('only the first 64 KiB are read; stored rules are read back safely', () => {
  const filler = '# ' + 'x'.repeat(ROBOTS_MAX) + '\n';
  assert.deepEqual(parseRobots(filler + 'User-agent: OnYourSite-Monitor\nDisallow: /'), []);
  assert.deepEqual(rulesFromJson('[["disallow","/a"],["allow","/b"],["evil",1],"x"]'), [['disallow', '/a'], ['allow', '/b']]);
  assert.deepEqual(rulesFromJson('{broken'), []);
  assert.deepEqual(rulesFromJson(null), []);
});

// Prüfbericht: Muster mit vielen „*“ aus einer fremden robots.txt liefen als regulärer Ausdruck mit Rückverfolgung –
// neun Sterne gegen einen Pfad aus 40 Zeichen dauerten Sekunden, 40 Sterne hielten den Prüfdienst (und später das
// Speichern im Editor) praktisch für immer an. Der Abgleich muss linear bleiben, auch bei 64 KiB Regeln.
test('hostile wildcard rules cannot stall the checker: matching stays fast and exact', () => {
  const nine = parseRobots('User-agent: OnYourSite-Monitor\nDisallow: /' + 'a*'.repeat(9) + 'b\n');
  let start = Date.now();
  assert.equal(robotsAllows(nine, '/' + 'a'.repeat(40)), true);
  assert.ok(Date.now() - start < 250, `nine stars took ${Date.now() - start} ms`);
  const hostile = parseRobots([
    'User-agent: OnYourSite-Monitor',
    'Disallow: /' + 'a*'.repeat(40) + 'b',
    'Disallow: /x' + '*'.repeat(5000) + 'y$',
    ...Array.from({ length: 300 }, (_v, i) => `Disallow: /${'*q'.repeat(60)}${i}`),
  ].join('\n'));
  start = Date.now();
  assert.equal(robotsAllows(hostile, '/' + 'a'.repeat(450)), true);
  assert.equal(robotsAllows(hostile, '/' + 'a'.repeat(450) + 'b'), false);
  assert.equal(robotsAllows(hostile, '/x' + 'z'.repeat(450) + 'y'), false);
  assert.equal(robotsAllows(hostile, '/x' + 'z'.repeat(450) + 'y?'), true, '$ still anchors the end');
  assert.ok(Date.now() - start < 1000, `hostile rules took ${Date.now() - start} ms`);
  // Dieselben Muster wie bisher: „*“ in der Mitte, „$“ nur am Ende, ein „$“ mitten im Muster ist ein Zeichen
  const plain = parseRobots('User-agent: OnYourSite-Monitor\nDisallow: /a*c\nDisallow: /p$q\nDisallow: /end$');
  assert.equal(robotsAllows(plain, '/abc'), false);
  assert.equal(robotsAllows(plain, '/ac'), false);
  assert.equal(robotsAllows(plain, '/ab'), true);
  assert.equal(robotsAllows(plain, '/p$q/x'), false);
  assert.equal(robotsAllows(plain, '/pq'), true);
  assert.equal(robotsAllows(plain, '/end'), false);
  assert.equal(robotsAllows(plain, '/endless'), true);
});
