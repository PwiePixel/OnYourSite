// Branding (premium-domains PD-1) ohne Datenbank: wann der Hinweis „Made with OnYourSite“ wegfällt (Premium des
// Besitzers × Schalter × Bestandsschutz), die Regeln beim Speichern (nur mit Premium oder als Team frei, mit
// Bestandsschutz nur zum Ausschalten), die Kennung des Vorschaubilds (Werte von PHP), die festen Stile der Fußzeile
// und die Erkennung von eigenem CSS, das den Hinweis anspricht bzw. heute ausblendet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, setConfigForTests } from '../src/config.js';
import { createHash } from 'node:crypto';
import {
  BRANDED, DEFAULT_FAVICON, FOOTER_LINK_STYLE, FOOTER_STRONG_STYLE, FOOTER_STYLE, brandingFooter, brandingFor, cssHidesBranding, cssTouchesBranding,
  faviconUrl, footerHidden, fullyUnbranded, iconHash,
} from '../src/content/branding.js';
import { codeAddBadge, codeBadge } from '../src/code/serve.js';
import { renderSimple } from '../src/content/render.js';
import { mainUrl } from '../src/helpers.js';
import { cssHides, cssRules, cssTouches, selectorTargetsBranding } from '../src/content/brandingCss.js';
import { settingsNormalize } from '../src/content/pages.js';
import { ogHash } from '../src/content/share.js';
import { renderPage } from '../src/content/render.js';
import { cleanCss } from '../src/css.js';
import { premiumPerks } from '../src/honeycombs/features.js';
import { premiumReady } from '../src/honeycombs/premium.js';
import { jsonDecode } from '../src/content/util.js';

const BASE = loadConfig();

test('footerHidden: the stored switch counts only with the owner’s Premium or the legacy flag', () => {
  const FLAGS: unknown[] = [true, false, 1, 0, '1', '0', '', null, undefined, 'yes'];
  for (const hide of FLAGS) {
    for (const legacy of FLAGS) {
      for (const premium of [true, false]) {
        const s: Record<string, unknown> = {};
        if (hide !== undefined) s.hide_branding = hide;
        if (legacy !== undefined) s.branding_legacy = legacy;
        const truthy = (v: unknown) => !(v === false || v === 0 || v === '0' || v === '' || v === null || v === undefined);
        assert.equal(footerHidden(s, premium), truthy(hide) && (premium || truthy(legacy)), JSON.stringify({ hide, legacy, premium }));
      }
    }
  }
  // Nur eigene Schlüssel – nichts aus dem Prototyp
  const proto = Object.create({ hide_branding: true, branding_legacy: true }) as Record<string, unknown>;
  assert.equal(footerHidden(proto, true), false);
  assert.equal(footerHidden(null, true), false);
  assert.equal(footerHidden('x', true), false);
  assert.deepEqual(brandingFor({ hide_branding: true }, true), { footerHidden: true, fullyUnbranded: true });
  assert.deepEqual(brandingFor({ hide_branding: true }, false), BRANDED);
  assert.deepEqual(brandingFor({ hide_branding: true, branding_legacy: true }, false), { footerHidden: true, fullyUnbranded: false });
});

test('fullyUnbranded: title, alt text and favicon only with the owner’s Premium – the legacy flag never counts', () => {
  const FLAGS: unknown[] = [true, false, 1, 0, '1', '0', '', null, undefined, 'yes'];
  const truthy = (v: unknown) => !(v === false || v === 0 || v === '0' || v === '' || v === null || v === undefined);
  for (const hide of FLAGS) {
    for (const legacy of FLAGS) {
      for (const premium of [true, false]) {
        const s: Record<string, unknown> = {};
        if (hide !== undefined) s.hide_branding = hide;
        if (legacy !== undefined) s.branding_legacy = legacy;
        assert.equal(fullyUnbranded(s, premium), truthy(hide) && premium, JSON.stringify({ hide, legacy, premium }));
        // Was fullyUnbranded ausblendet, blendet footerHidden immer auch aus
        if (fullyUnbranded(s, premium)) assert.equal(footerHidden(s, premium), true);
        assert.deepEqual(brandingFor(s, premium), { footerHidden: footerHidden(s, premium), fullyUnbranded: fullyUnbranded(s, premium) });
      }
    }
  }
  const proto = Object.create({ hide_branding: true }) as Record<string, unknown>;
  assert.equal(fullyUnbranded(proto, true), false);
  assert.equal(fullyUnbranded(null, true), false);
});

test('the page with Premium: no “| OnYourSite” in the default title or the alt text, the avatar as favicon; legacy keeps them', () => {
  const avatar = 'avatar_5_1700000000_abcdef01.webp';
  const page = { id: 3, user_id: 5, slug: 'mia', title: 'Mia', theme: 'minimal', layout: 'buttons', address_mode: 'subdomain', avatar, settings: '{"hide_branding":true}' };
  const hash = createHash('sha1').update('icon-1|' + avatar).digest('hex').slice(0, 12);
  assert.equal(iconHash(avatar), hash);
  const icon = `/_/icon/3-${hash}.png`;
  const full = renderPage(page, [], { mode: 'public', branding: { footerHidden: true, fullyUnbranded: true } });
  assert.match(full, /<title>Mia<\/title>/);
  assert.ok(full.includes('<meta name="twitter:title" content="Mia">'));
  assert.ok(full.includes(`<link rel="icon" type="image/png" href="${icon}">`));
  if (full.includes('og:image:alt')) assert.ok(full.includes('<meta property="og:image:alt" content="Mia">'), 'alt text without “on OnYourSite”');
  assert.ok(!full.includes('OnYourSite'), 'no OnYourSite name anywhere on the page');
  // Bestandsschutz (nur footerHidden): Titel, Alternativtext und Favicon bleiben
  const legacy = renderPage(page, [], { mode: 'public', branding: { footerHidden: true, fullyUnbranded: false } });
  assert.match(legacy, /<title>Mia \| OnYourSite<\/title>/);
  assert.ok(legacy.includes(`<link rel="icon" type="image/png" href="${DEFAULT_FAVICON}">`));
  if (legacy.includes('og:image:alt')) assert.ok(legacy.includes('<meta property="og:image:alt" content="Mia on OnYourSite">'));
  // Ohne Angabe wie bisher
  assert.match(renderPage(page, [], { mode: 'public' }), /<title>Mia \| OnYourSite<\/title>/);
  // Ein eigener SEO-Titel bleibt, wie er ist
  const seo = { ...page, settings: '{"hide_branding":true,"seo":{"title":"Mia | Design studio"}}' };
  assert.match(renderPage(seo, [], { mode: 'public', branding: { footerHidden: true, fullyUnbranded: true } }), /<title>Mia \| Design studio<\/title>/);
  // Ohne Profilbild: das Favicon von OnYourSite (auch mit Premium)
  const noAvatar = renderPage({ ...page, avatar: null }, [], { mode: 'public', branding: { footerHidden: true, fullyUnbranded: true } });
  assert.ok(noAvatar.includes(`<link rel="icon" type="image/png" href="${DEFAULT_FAVICON}">`));
  assert.equal(faviconUrl({ id: 3, avatar }, true), icon);
  assert.equal(faviconUrl({ id: 3, avatar }, false), DEFAULT_FAVICON);
  assert.equal(faviconUrl({ id: 0, avatar }, true), DEFAULT_FAVICON, 'a draft without an id');
  assert.equal(faviconUrl({ id: 3, avatar: '' }, true), DEFAULT_FAVICON);
  // Kleine Seiten (Kalender, Passwort-Abfrage) bekommen das Favicon der Seite
  assert.ok(renderSimple(page, 'Protected link', '<p>x</p>', icon).includes(`<link rel="icon" type="image/png" href="${icon}">`));
  assert.ok(renderSimple(page, 'Protected link', '<p>x</p>').includes(`href="${DEFAULT_FAVICON}"`));
});

test('code page badge: the OnYourSite badge, or with Premium a plain “Report” link – same place and target, the report link always there', () => {
  const free = codeBadge(false);
  const premium = codeBadge(true);
  const target = 'href="' + mainUrl('/terms/code-pages') + '#report"';
  for (const b of [free, premium]) {
    assert.ok(b.includes(target), 'link to report the page');
    assert.ok(b.includes('position:fixed;right:10px;bottom:10px;z-index:2147483647;'), 'same place');
    assert.ok(b.includes('target="_blank" rel="noopener"'));
  }
  assert.ok(free.includes('&#x2B21;</span> OnYourSite</a>') && free.includes('title="Hosted on OnYourSite – report this page"'));
  assert.ok(premium.endsWith('title="Report this page">Report</a>'));
  assert.ok(!premium.includes('&#x2B21;') && !premium.includes('Hosted on') && !premium.includes('>OnYourSite') && !premium.includes(' OnYourSite'));
  // Eingefügt vor dem letzten </body> – ohne Angabe wie bisher (PHP-Gleichheit in codesites.test.ts)
  const html = '<html><body><p>Hi</p></BODY></html>';
  assert.equal(codeAddBadge(html, {}), '<html><body><p>Hi</p>' + free + '</BODY></html>');
  assert.equal(codeAddBadge(html, {}, true), '<html><body><p>Hi</p>' + premium + '</BODY></html>');
  assert.equal(codeAddBadge('<p>no body</p>', {}, true), '<p>no body</p>' + premium);
});

test('settingsNormalize: Premium or staff switch freely; legacy pages can only turn it off; everyone else keeps the stored value', () => {
  const norm = (input: unknown, can: boolean, old: unknown) => {
    const s = settingsNormalize(input, 5, can, old);
    return { hide: s.hide_branding, legacy: (s as { branding_legacy?: boolean }).branding_legacy };
  };
  // Premium (oder Team): frei
  assert.deepEqual(norm({ hide_branding: true }, true, {}), { hide: true, legacy: undefined });
  assert.deepEqual(norm({ hide_branding: false }, true, { hide_branding: true }), { hide: false, legacy: undefined });
  // Ohne Premium: der gespeicherte Wert bleibt, egal was kommt
  assert.deepEqual(norm({ hide_branding: true }, false, { hide_branding: false }), { hide: false, legacy: undefined });
  assert.deepEqual(norm({ hide_branding: false }, false, { hide_branding: true }), { hide: true, legacy: undefined });
  assert.deepEqual(norm({}, false, { hide_branding: true }), { hide: true, legacy: undefined });
  // Bestandsschutz: bleibt an, solange er an bleibt …
  assert.deepEqual(norm({ hide_branding: true }, false, { hide_branding: true, branding_legacy: true }), { hide: true, legacy: true });
  // … und fällt weg, sobald er aus ist – danach braucht es Premium
  assert.deepEqual(norm({ hide_branding: false }, false, { hide_branding: true, branding_legacy: true }), { hide: false, legacy: undefined });
  assert.deepEqual(norm({ hide_branding: true }, false, { hide_branding: false }), { hide: false, legacy: undefined });
  // Mit Premium bleibt der Bestandsschutz erhalten (endet Premium, bleibt die Seite, wie sie war)
  assert.deepEqual(norm({ hide_branding: true }, true, { hide_branding: true, branding_legacy: true }), { hide: true, legacy: true });
  assert.deepEqual(norm({ hide_branding: false }, true, { hide_branding: true, branding_legacy: true }), { hide: false, legacy: undefined });
  // Ein Bestandsschutz-Flag ohne Schalter zählt nicht, und aus der Eingabe wird er nie übernommen
  assert.deepEqual(norm({ hide_branding: true }, false, { hide_branding: false, branding_legacy: true }), { hide: false, legacy: undefined });
  assert.deepEqual(norm({ hide_branding: true, branding_legacy: true }, false, {}), { hide: false, legacy: undefined });
  assert.deepEqual(norm({ hide_branding: true, branding_legacy: true }, true, {}), { hide: true, legacy: undefined });
  // Der Schlüssel steht am Ende und nur dann (ohne ihn bleibt die Ausgabe wie in PHP)
  const keys = Object.keys(settingsNormalize({ hide_branding: true }, 5, false, { hide_branding: true, branding_legacy: true }));
  assert.equal(keys[keys.length - 1], 'branding_legacy');
  assert.ok(!Object.keys(settingsNormalize({ hide_branding: true }, 5, true, {})).includes('branding_legacy'));
});

test('OG card hash: the effective value replaces the stored switch – PHP’s vectors stay the same', () => {
  setConfigForTests({ ...BASE, base_domain: 'on-your.site', scheme: 'https' });
  try {
    const mia = { id: 2, slug: 'mia', address_mode: 'subdomain', title: 'Mia', subtitle: 'Design', bio: 'Hi', avatar: 'avatar_5_1_ab.webp', theme: 'aurora' };
    const tom = { id: 9, slug: 'tom', address_mode: 'path', title: 'Tom 🎧', subtitle: '', bio: '', avatar: '', theme: 'galaxy' };
    // Von PHP (oys_og_hash) berechnet: Schalter aus, Schalter an (Premium), Seite mit Bestandsschutz
    assert.equal(ogHash({ ...mia, settings: '{"accent":"#ff0055"}' }, false), 'ebead49cf1f9');
    assert.equal(ogHash({ ...mia, settings: '{"accent":"#ff0055","hide_branding":true}' }, true), '4225efba6d68');
    assert.equal(ogHash({ ...tom, settings: '{"hide_branding":false}' }, false), '846858cdbad2');
    assert.equal(ogHash({ ...tom, settings: '{"hide_branding":true,"branding_legacy":true}' }, true), '7baadadd54e9');
    // Gespeichert an, aber ohne Premium: dieselbe Karte wie mit Schalter aus (das Zeichen ist zu sehen)
    assert.equal(ogHash({ ...mia, settings: '{"accent":"#ff0055","hide_branding":true}' }, false), 'ebead49cf1f9');
  } finally {
    setConfigForTests(BASE);
  }
});

test('the footer carries pinned styles; the page renders it unless the effective branding hides it', () => {
  for (const d of ['display:block!important', 'visibility:visible!important', 'opacity:1!important', 'position:relative!important', 'z-index:2147483647!important',
    'transform:none!important', 'scale:none!important', 'clip-path:none!important', 'filter:none!important', 'height:auto!important', 'max-height:none!important',
    'overflow:visible!important', 'content-visibility:visible!important', 'font-size:max(.78em,11px)!important', 'text-indent:0!important', 'inset:auto!important']) {
    assert.ok(FOOTER_STYLE.split(';').includes(d), d);
  }
  for (const d of ['display:inline-block!important', 'opacity:.75!important', 'position:static!important', 'font-size:max(1em,11px)!important', 'transform:none!important']) {
    assert.ok(FOOTER_LINK_STYLE.split(';').includes(d), d);
  }
  for (const d of ['display:inline!important', 'visibility:visible!important', 'font-size:inherit!important']) assert.ok(FOOTER_STRONG_STYLE.split(';').includes(d), d);
  const page = { id: 3, user_id: 5, slug: 'mia', title: 'Mia', theme: 'minimal', layout: 'buttons', address_mode: 'subdomain', settings: '{"hide_branding":true,"custom_css":".oys-foot{display:none}"}' };
  // Ohne Angabe: der Besitzer zählt als ohne Premium – der Hinweis bleibt
  const plain = renderPage(page, [], { mode: 'public' });
  assert.ok(plain.includes(brandingFooter()), 'footer without branding option');
  assert.ok(plain.includes('<footer class="oys-foot" style="display:block!important;'));
  assert.ok(renderPage(page, [], { mode: 'public', branding: { footerHidden: false, fullyUnbranded: false } }).includes(brandingFooter()));
  const hidden = renderPage(page, [], { mode: 'public', branding: { footerHidden: true, fullyUnbranded: false } });
  assert.ok(!hidden.includes('oys-foot"'), 'no footer with Premium');
  assert.ok(!hidden.includes('Made with'));
  // Bestandsschutz ohne Angabe: wirkt auch so
  assert.ok(!renderPage({ ...page, settings: '{"hide_branding":true,"branding_legacy":true}' }, [], { mode: 'public' }).includes('Made with'));
});

const TOUCHES = [
  '.oys-foot{display:none}', 'footer{opacity:0}', '.o\\79s-foot{display:none}', '/**/.oys-foot{color:red}', 'main>:last-child{display:none}',
  'a[href*="on-your"]{display:none}', '.oys-main > :last-child { visibility: hidden }', '.profile-container :nth-last-child(1){opacity:0}',
  '@media (max-width: 600px) { .oys-foot a { font-size: 0 } }', '.oys-main { & > :last-of-type { display: none } }', 'body footer strong{color:red}',
  '[class*=foot]{display:none}', 'a[href^="https://on-your.site"]{opacity:0}', 'FOOTER{display:none}', '.x, .oys-foot{display:none}',
  'main :last-child{display:none}', '.oys-foot{display:none', 'a[href*=onyoursite]{display:none}',
];
const NOT_TOUCHING = [
  '', '.oys-name{letter-spacing:.1em}', '.my-footer{display:none}', '#footer{display:none}', '.oys-link:last-child{color:red}',
  'section:first-child{color:red}', '.footer-note{color:red}', 'p{content:"footer{}"}', '.oys-main{padding:0}', 'footers{display:none}',
  'a[href*="instagram"]{color:red}', '.oys-blocks > :last-child { margin: 0 }', '.oys-foot',
];

test('cssTouchesBranding: rules that name the note, its element, the last child of main or its link', () => {
  for (const css of TOUCHES) assert.equal(cssTouchesBranding(cleanCss(css)), true, css);
  for (const css of NOT_TOUCHING) assert.equal(cssTouchesBranding(cleanCss(css)), false, css);
  // Die Adresse der Seite als Attribut (z. B. auf einem eigenen Server)
  assert.equal(cssTouches('a[href*="links.example.org"]{display:none}', 'links.example.org'), true);
  assert.equal(selectorTargetsBranding('.oys-name'), false);
});

test('cssHidesBranding: a rule for the note AND a declaration that hides it – not just restyling, hover or pseudo-elements', () => {
  const HIDES = [
    '.oys-foot{display:none}', '.oys-foot{display:none !important}', 'footer{visibility:hidden}', '.oys-foot{opacity:0}', '.oys-foot{opacity:.0}',
    '.oys-foot a{font-size:0}', '.oys-foot{height:0;overflow:hidden}', '.oys-foot{max-height:0px}', '.oys-foot{clip-path:inset(50%)}',
    '.oys-foot{transform:scale(0)}', '.oys-foot{transform: scaleY(0)}', '.oys-foot{scale:0}', '.oys-main > :last-child{display:none}',
    '.oys-foot{position:absolute;left:-9999px}', '.oys-foot{text-indent:-10000px}', '.oys-foot{filter:opacity(0)}', '.o\\79s-foot{display:none}',
    '@media screen{.oys-foot{display:none}}', 'footer strong{display:none}', '.oys-foot{content-visibility:hidden}', '.oys-foot{width:0;overflow:hidden}',
    '.oys-foot{mask-image:linear-gradient(transparent,transparent)}', '.x:hover, .oys-foot{display:none}', '.oys-foot{transform:translateX(-5000px)}',
  ];
  const KEEPS = [
    '.oys-foot{color:#fff}', '.oys-foot a{text-decoration:underline}', '.oys-foot a:hover{opacity:0}', '.oys-foot::after{display:none}',
    '.oys-foot:before{display:none}', '.oys-foot{opacity:.5}', '.oys-foot{height:40px}', '.oys-foot{width:0}', '.oys-name{display:none}',
    '.oys-main > :not(.oys-foot){display:none}', '.oys-foot{transform:scale(0.5)}', '.oys-foot{left:-10px}', '', 'p{content:".oys-foot{display:none}"}',
  ];
  for (const css of HIDES) assert.equal(cssHidesBranding(cleanCss(css)), true, css);
  for (const css of KEEPS) assert.equal(cssHidesBranding(cleanCss(css)), false, css);
  assert.equal(cssHides('a[href*="me.example"]{display:none}', 'me.example'), true);
});

test('the CSS scanner follows nesting, skips strings and stays fast on hostile input', () => {
  assert.deepEqual(cssRules('.a{color:red;.b{x:1}} @media (x){.c{y:2}}'), [
    { selector: '.a .b', body: 'x:1' }, { selector: '.a', body: 'color:red;' }, { selector: '.c', body: 'y:2' }]);
  assert.deepEqual(cssRules('p{content:"{"} .q{a:b}'), [{ selector: 'p', body: 'content:"{"' }, { selector: '.q', body: 'a:b' }]);
  const started = Date.now();
  for (const css of ['{'.repeat(20000), '}'.repeat(20000), '.oys-foot{' + 'a:b;'.repeat(5000), '['.repeat(20000), 'translate('.repeat(2000) + '-9999'.repeat(10),
    ('.oys-main :last-child{transform:translate(' + '1'.repeat(30) + ')}').repeat(300)]) {
    cssTouchesBranding(css);
    cssHidesBranding(css);
  }
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});

test('the branding perk makes Premium ready (honeycomb-shop shows Premium only then)', () => {
  assert.ok(premiumPerks().some((p) => p.owner === 'premium-domains' && p.text === 'No OnYourSite branding on your pages' && p.ready()));
  assert.equal(premiumReady(), true);
});

test('stored settings with the legacy flag decode and keep it (the editor shows the hint)', () => {
  const s = jsonDecode('{"hide_branding":true,"branding_legacy":true}') as Record<string, unknown>;
  assert.equal(footerHidden(s, false), true);
});
