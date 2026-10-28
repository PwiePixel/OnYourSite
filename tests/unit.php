<?php
// Schnelltest der Kernfunktionen: php tests/unit.php (nur Kommandozeile)
if (PHP_SAPI !== "cli") { http_response_code(403); exit; }
chdir(dirname(__DIR__));
require dirname(__DIR__) . '/lib/bootstrap.php';
$fails = 0;
function t($name, $got, $want) { global $fails; $ok = $got === $want; if (!$ok) $fails++; echo ($ok ? 'PASS ' : 'FAIL ') . $name . ($ok ? '' : ' → got ' . var_export($got, true) . ', want ' . var_export($want, true)) . "\n"; }
$tz = new DateTimeZone('Europe/Berlin');
// Zeitsteuerung: Fr 18–23
$s = oys_schedule_normalize(['enabled' => 1, 'days' => [5], 'from' => '18:00', 'to' => '23:00']);
t('Fri 19:00 active', oys_schedule_active($s, new DateTimeImmutable('2026-10-30 19:00', $tz)), true);
t('Fri 23:00 inactive', oys_schedule_active($s, new DateTimeImmutable('2026-10-30 23:00', $tz)), false);
t('Sat 19:00 inactive', oys_schedule_active($s, new DateTimeImmutable('2026-10-31 19:00', $tz)), false);
// Über Mitternacht: Fr 22–02
$s2 = oys_schedule_normalize(['enabled' => 1, 'days' => [5], 'from' => '22:00', 'to' => '02:00']);
t('Fri 23:30 active', oys_schedule_active($s2, new DateTimeImmutable('2026-10-30 23:30', $tz)), true);
t('Sat 01:30 active (Friday night)', oys_schedule_active($s2, new DateTimeImmutable('2026-10-31 01:30', $tz)), true);
t('Sat 02:30 inactive', oys_schedule_active($s2, new DateTimeImmutable('2026-10-31 02:30', $tz)), false);
t('Fri 01:00 inactive (Thursday night not selected)', oys_schedule_active($s2, new DateTimeImmutable('2026-10-30 01:00', $tz)), false);
// Zeitraum
$s3 = oys_schedule_normalize(['enabled' => 1, 'start' => '2026-11-01T10:00', 'end' => '2026-11-02T10:00']);
t('inactive before start', oys_schedule_active($s3, new DateTimeImmutable('2026-11-01 09:59', $tz)), false);
t('active within period', oys_schedule_active($s3, new DateTimeImmutable('2026-11-01 12:00', $tz)), true);
t('inactive after end', oys_schedule_active($s3, new DateTimeImmutable('2026-11-02 10:00', $tz)), false);
t('off = always active', oys_schedule_active(oys_schedule_normalize(['enabled' => 0]), new DateTimeImmutable('now', $tz)), true);
// Einbettungen
$e = fn($u) => ($p = oys_parse_embed($u)) ? $p['provider'] . ':' . $p['kind'] . ':' . $p['id'] . (isset($p['start']) && $p['start'] ? '@' . $p['start'] : '') : null;
t('YouTube watch', $e('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube:video:dQw4w9WgXcQ');
t('YouTube short link + t', $e('https://youtu.be/dQw4w9WgXcQ?t=90'), 'youtube:video:dQw4w9WgXcQ@90');
t('YouTube shorts', $e('https://youtube.com/shorts/dQw4w9WgXcQ'), 'youtube:video:dQw4w9WgXcQ');
t('YouTube playlist', $e('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'), 'youtube:playlist:PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG');
t('YouTube channel = no embed', $e('https://youtube.com/@pixel'), null);
t('Twitch channel', $e('https://www.twitch.tv/Pixel_Live'), 'twitch:channel:pixel_live');
t('Twitch video', $e('https://www.twitch.tv/videos/123456'), 'twitch:video:123456');
t('Twitch clip', $e('https://www.twitch.tv/pixel/clip/FunnyClip-abc'), 'twitch:clip:FunnyClip-abc');
t('Spotify track', $e('https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT?si=x'), 'spotify:track:4cOdK2wGLETKBW3PvgPWqT');
t('Spotify playlist', $e('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
t('Other site', $e('https://vimeo.com/123'), null);
// URLs säubern
t('Domain without https', oys_clean_url('instagram.com/abc'), 'https://instagram.com/abc');
t('Email', oys_clean_url('max@test.de'), 'mailto:max@test.de');
t('Phone', oys_clean_url('+49 170 1234567'), 'tel:+491701234567');
t('javascript blocked', oys_clean_url('javascript:alert(1)'), '');
t('data blocked', oys_clean_url('data:text/html,<b>x'), '');
t('JaVaScRiPt blocked', oys_clean_url(' JaVaScRiPt:alert(1)'), '');
t('relative only when allowed', oys_clean_url('/kalender', true), '/kalender');
t('//evil not allowed as relative', oys_clean_url('//evil.com', true), 'https://evil.com');
// Social-Links
t('Instagram @name', oys_social_url('instagram', '@mia'), 'https://instagram.com/mia');
t('TikTok name', oys_social_url('tiktok', 'mia'), 'https://www.tiktok.com/@mia');
t('WhatsApp number', oys_social_url('whatsapp', '+49 170 123'), 'https://wa.me/49170123');
t('Email', oys_social_url('email', 'a@b.de'), 'mailto:a@b.de');
t('Mastodon handle', oys_social_url('mastodon', '@mia@mastodon.social'), 'https://mastodon.social/@mia');
t('URL stays', oys_social_url('discord', 'https://discord.gg/abc'), 'https://discord.gg/abc');
t('Name with special characters', oys_social_url('github', 'a"b<c'), 'https://github.com/abc');
// Markenerkennung
t('youtu.be → youtube', oys_detect_brand('https://youtu.be/x'), 'youtube');
t('x.com → x', oys_detect_brand('https://x.com/abc'), 'x');
t('m.facebook.com → facebook', oys_detect_brand('https://m.facebook.com/abc'), 'facebook');
t('evilinstagram.com not matched', oys_detect_brand('https://evilinstagram.com/'), null);
// Adressen
t('Address ok', oys_slug_problem($pdo, 'mein-name-42'), null);
t('Address admin forbidden', oys_slug_problem($pdo, 'admin') !== null, true);
t('Double hyphen forbidden', oys_slug_problem($pdo, 'a--b') !== null, true);
t('dashboard reserved', oys_slug_problem($pdo, 'dashboard') !== null, true);
// Spamfilter
t('Spam: many links', oys_looks_like_spam('see http://a.de http://b.de http://c.de'), true);
t('Spam: casino', oys_looks_like_spam('Best Casino bonus'), true);
t('Not spam', oys_looks_like_spam('Hi, I have a question about your merch.'), false);
// Eigenes CSS kann nicht aus <style> ausbrechen und lädt nichts von fremden Servern
t('CSS without <', strpos(oys_clean_css('a{color:red}</style><script>alert(1)</script>'), '<'), false);
t('CSS: url(https://…) removed', oys_clean_css('b{background:url(https://evil.example/x.png)}'), 'b{background:url("")}');
t('CSS: disguised u\\72l( removed', oys_clean_css('b{background:u\\72l(https://evil.example)}'), 'b{background:url("")}');
t('CSS: @\\69mport removed', strpos(oys_clean_css('@\\69mport "https://evil.example/a.css"; a{color:red}'), 'evil'), false);
t('CSS: external image-set removed', strpos(oys_clean_css('b{background:image-set("https://evil.example/a.png" 1x)}'), 'evil'), false);
t('CSS: own images stay', oys_clean_css('b{background:url(/static/uploads/bg_3_1_ab.webp)}'), 'b{background:url(/static/uploads/bg_3_1_ab.webp)}');
t('CSS: text with a colon stays', oys_clean_css('.a::before{content:"Tip: https://x"}'), '.a::before{content:"Tip: https://x"}');
// Texte: Steuerzeichen raus, Emoji-Verbinder bleiben
t('Emoji with ZWJ stays', oys_clean_text("Dev 👨\u{200D}💻"), "Dev 👨\u{200D}💻");
t('Direction override removed', oys_clean_text("abc\u{202E}fed"), 'abcfed');
t('Control characters removed, line break stays', oys_clean_text("a\x07b\nc", 50, true), "ab\nc");
// Termin-Block: eingebauter Kalender?
$cp = ['id' => 1, 'slug' => 'mia', 'address_mode' => 'subdomain'];
t('Calendar: /kalender internal', oys_booking_is_internal(['url' => '/kalender'], $cp), true);
t('Calendar: own full address internal', oys_booking_is_internal(['url' => oys_page_urls($cp)['path'] . '/kalender'], $cp), true);
t('Calendar: Calendly external', oys_booking_is_internal(['url' => 'https://calendly.com/mia'], $cp), false);
t('Calendar: other page external', oys_booking_is_internal(['url' => oys_page_urls(['slug' => 'tom'] + $cp)['subdomain'] . '/kalender'], $cp), false);
// Block-Validierung: fremde Datei wird abgelehnt
$b = oys_block_normalize(['type' => 'image', 'data' => ['src' => 'img_99_123_abc.webp']], 3);
t('Another user’s upload rejected', $b['data']['src'], '');
$b = oys_block_normalize(['type' => 'image', 'data' => ['src' => '../../config.php']], 3);
t('Path traversal rejected', $b['data']['src'], '');
$b = oys_block_normalize(['type' => 'link', 'protection' => 'password', 'password' => '', 'data' => ['url' => 'https://a.de']], 3);
t('Password protection without password → protected, but hidden + warning', $b['protection'] . '|' . $b['is_visible'] . '|' . ($b['warning'] ? 'w' : ''), 'password|0|w');
$b = oys_block_normalize(['type' => 'link', 'protection' => 'password', 'password' => '1234', 'data' => ['url' => 'https://a.de']], 3);
t('Too-short link password is not saved', $b['is_visible'] . '|' . ($b['password_hash'] === null ? 'no hash' : 'hash'), '0|no hash');
$b = oys_block_normalize(['type' => 'link', 'protection' => 'password', 'password' => '', 'data' => ['url' => 'https://a.de']], 3, ['password_hash' => '$2y$10$abc']);
t('Existing password is kept on save', $b['password_hash'] . '|' . $b['is_visible'], '$2y$10$abc|1');
$b = oys_block_normalize(['type' => 'heading', 'protection' => 'password', 'password' => 'x', 'data' => ['text' => 'Hi']], 3);
t('Protection only for clickable blocks', $b['protection'], 'none');
// Updates: Markdown wird sicher umgewandelt
t('Markdown: bold, HTML stays text', oys_markdown('**Hi** <img src=x onerror=alert(1)>'), '<p><strong>Hi</strong> &lt;img src=x onerror=alert(1)&gt;</p>');
t('Markdown: javascript: link is not a link', strpos(oys_markdown('[x](javascript:alert(1))'), 'href'), false);
t('Markdown: link', oys_markdown('[OnYourSite](https://on-your.site)'), '<p><a href="https://on-your.site" target="_blank" rel="noopener noreferrer">OnYourSite</a></p>');
t('Markdown: no attribute break-out', strpos(oys_markdown('[x](https://a.de/"onmouseover=alert(1))'), '"onmouseover'), false);
t('Markdown: list and heading', oys_markdown("## New\n- a\n- b"), '<h4>New</h4><ul><li>a</li><li>b</li></ul>');
t('Markdown: code is not formatted', oys_markdown('`**<b>**`'), '<p><code>**&lt;b&gt;**</code></p>');
t('Markdown: placeholder characters from input are removed', oys_markdown("a\x010\x02b"), '<p>a0b</p>');
t('Markdown: bare link without the trailing dot', strpos(oys_markdown('See https://a.de/x.'), 'href="https://a.de/x"') !== false, true);
t('Markdown: underscores inside links stay', strpos(oys_markdown('*https://a.de/x_y_z*'), 'href="https://a.de/x_y_z"') !== false, true);
t('Markdown: bold link', oys_markdown('**https://a.de/x**'), '<p><strong><a href="https://a.de/x" target="_blank" rel="noopener noreferrer">' . e(oys_pretty_url('https://a.de/x')) . '</a></strong></p>');
t('Markdown: brackets inside a bare link', strpos(oys_markdown('https://en.wikipedia.org/wiki/Foo_(bar)'), 'href="https://en.wikipedia.org/wiki/Foo_(bar)"') !== false, true);
t('Markdown: link in brackets keeps the bracket outside', strpos(oys_markdown('(see https://a.de/x)'), 'href="https://a.de/x"') !== false, true);
t('Markdown: brackets inside a [link](…)', strpos(oys_markdown('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))'), 'href="https://en.wikipedia.org/wiki/Foo_(bar)"') !== false, true);
t('Markdown: plain text for feeds', oys_md_plain("**Bold** [link](https://x.de)\n`code`"), 'Bold link code');
// Roadmap: Fortschritt nur aus abgehakten Aufgaben
$task = fn($done) => ['id' => 1, 'title' => 't', 'is_done' => $done, 'done_at' => null];
t('Progress 1 of 3', oys_milestone_progress(['status' => 'now', 'tasks' => [$task(true), $task(false), $task(false)]]), ['done' => 1, 'total' => 3, 'percent' => 33]);
t('Progress without tasks', oys_milestone_progress(['status' => 'next', 'tasks' => []]), null);
t('Shipped = 100%', oys_milestone_progress(['status' => 'done', 'tasks' => [$task(false)]])['percent'], 100);
// Discord: nur echte Webhook-Links von Discord
$tok = str_repeat('aB3_-', 8);
t('Webhook: discord.com', oys_discord_parse_webhook('https://discord.com/api/webhooks/123456789012345678/' . $tok), ['123456789012345678', $tok]);
t('Webhook: discordapp.com with API version', oys_discord_parse_webhook('https://discordapp.com/api/v10/webhooks/123456789012345678/' . $tok) !== null, true);
t('Webhook: canary', oys_discord_parse_webhook('https://canary.discord.com/api/webhooks/123456789012345678/' . $tok) !== null, true);
t('Webhook: http rejected', oys_discord_parse_webhook('http://discord.com/api/webhooks/123456789012345678/' . $tok), null);
t('Webhook: look-alike host rejected', oys_discord_parse_webhook('https://discord.com.evil.io/api/webhooks/123456789012345678/' . $tok), null);
t('Webhook: hidden in a query rejected', oys_discord_parse_webhook('https://evil.io/?u=https://discord.com/api/webhooks/123456789012345678/' . $tok), null);
t('Webhook: extra path rejected', oys_discord_parse_webhook('https://discord.com/api/webhooks/123456789012345678/' . $tok . '/messages/1'), null);
$ds = array_replace(oys_discord_defaults(), ['webhook_url' => 'https://discord.com/api/webhooks/123456789012345678/' . $tok, 'username' => 'News']);
t('Discord: nobody is pinged by default', oys_discord_with_mention(['embeds' => []], $ds), ['embeds' => [], 'allowed_mentions' => ['parse' => []], 'username' => 'News']);
$m = oys_discord_with_mention([], array_replace($ds, ['mention' => '987654321098765432']));
t('Discord: role ping only for that role', [$m['content'], $m['allowed_mentions']], ['<@&987654321098765432>', ['parse' => [], 'roles' => ['987654321098765432']]]);
$m = oys_discord_with_mention([], array_replace($ds, ['mention' => 'everyone', 'mode' => 'bot']));
t('Discord: @everyone, bot without webhook name', [$m['content'], $m['allowed_mentions']['parse'], isset($m['username'])], ['@everyone', ['everyone'], false]);
$u = ['id' => 7, 'title' => 'Big one', 'version' => '3.0', 'category' => 'new', 'body' => str_repeat('word ', 1200), 'published_at' => '2026-10-28 12:00:00'];
$emb = oys_discord_update_payload($u, $ds)['embeds'][0];
t('Discord: long text is shortened with a link', mb_strlen($emb['description']) <= 4096 && strpos($emb['description'], 'Read the full update') !== false, true);
t('Discord: title with version', $emb['title'], '3.0 – Big one');
t('Discord: message from another target is never touched', oys_discord_change($ds, 'bot:1', '123456', null)['error'], 'gone');
echo $fails ? "\n$fails FAILED\n" : "\nAll tests passed\n";
