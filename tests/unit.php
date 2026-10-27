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
t('Fr 19:00 aktiv', oys_schedule_active($s, new DateTimeImmutable('2026-10-30 19:00', $tz)), true);
t('Fr 23:00 inaktiv', oys_schedule_active($s, new DateTimeImmutable('2026-10-30 23:00', $tz)), false);
t('Sa 19:00 inaktiv', oys_schedule_active($s, new DateTimeImmutable('2026-10-31 19:00', $tz)), false);
// Über Mitternacht: Fr 22–02
$s2 = oys_schedule_normalize(['enabled' => 1, 'days' => [5], 'from' => '22:00', 'to' => '02:00']);
t('Fr 23:30 aktiv', oys_schedule_active($s2, new DateTimeImmutable('2026-10-30 23:30', $tz)), true);
t('Sa 01:30 aktiv (Nacht von Fr)', oys_schedule_active($s2, new DateTimeImmutable('2026-10-31 01:30', $tz)), true);
t('Sa 02:30 inaktiv', oys_schedule_active($s2, new DateTimeImmutable('2026-10-31 02:30', $tz)), false);
t('Fr 01:00 inaktiv (Do-Nacht nicht gewählt)', oys_schedule_active($s2, new DateTimeImmutable('2026-10-30 01:00', $tz)), false);
// Zeitraum
$s3 = oys_schedule_normalize(['enabled' => 1, 'start' => '2026-11-01T10:00', 'end' => '2026-11-02T10:00']);
t('vor Start inaktiv', oys_schedule_active($s3, new DateTimeImmutable('2026-11-01 09:59', $tz)), false);
t('im Zeitraum aktiv', oys_schedule_active($s3, new DateTimeImmutable('2026-11-01 12:00', $tz)), true);
t('nach Ende inaktiv', oys_schedule_active($s3, new DateTimeImmutable('2026-11-02 10:00', $tz)), false);
t('aus = immer aktiv', oys_schedule_active(oys_schedule_normalize(['enabled' => 0]), new DateTimeImmutable('now', $tz)), true);
// Einbettungen
$e = fn($u) => ($p = oys_parse_embed($u)) ? $p['provider'] . ':' . $p['kind'] . ':' . $p['id'] . (isset($p['start']) && $p['start'] ? '@' . $p['start'] : '') : null;
t('YouTube watch', $e('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube:video:dQw4w9WgXcQ');
t('YouTube kurz + t', $e('https://youtu.be/dQw4w9WgXcQ?t=90'), 'youtube:video:dQw4w9WgXcQ@90');
t('YouTube shorts', $e('https://youtube.com/shorts/dQw4w9WgXcQ'), 'youtube:video:dQw4w9WgXcQ');
t('YouTube Playlist', $e('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'), 'youtube:playlist:PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG');
t('YouTube Kanal = kein Embed', $e('https://youtube.com/@pixel'), null);
t('Twitch Kanal', $e('https://www.twitch.tv/Pixel_Live'), 'twitch:channel:pixel_live');
t('Twitch Video', $e('https://www.twitch.tv/videos/123456'), 'twitch:video:123456');
t('Twitch Clip', $e('https://www.twitch.tv/pixel/clip/FunnyClip-abc'), 'twitch:clip:FunnyClip-abc');
t('Spotify Track', $e('https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT?si=x'), 'spotify:track:4cOdK2wGLETKBW3PvgPWqT');
t('Spotify Playlist', $e('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
t('Fremde Seite', $e('https://vimeo.com/123'), null);
// URLs säubern
t('Domain ohne https', oys_clean_url('instagram.com/abc'), 'https://instagram.com/abc');
t('E-Mail', oys_clean_url('max@test.de'), 'mailto:max@test.de');
t('Telefon', oys_clean_url('+49 170 1234567'), 'tel:+491701234567');
t('javascript blockiert', oys_clean_url('javascript:alert(1)'), '');
t('data blockiert', oys_clean_url('data:text/html,<b>x'), '');
t('JaVaScRiPt blockiert', oys_clean_url(' JaVaScRiPt:alert(1)'), '');
t('relativ nur wenn erlaubt', oys_clean_url('/kalender', true), '/kalender');
t('//evil relativ nicht erlaubt', oys_clean_url('//evil.com', true), 'https://evil.com');
// Social-Links
t('Instagram @name', oys_social_url('instagram', '@mia'), 'https://instagram.com/mia');
t('TikTok name', oys_social_url('tiktok', 'mia'), 'https://www.tiktok.com/@mia');
t('WhatsApp Nummer', oys_social_url('whatsapp', '+49 170 123'), 'https://wa.me/49170123');
t('E-Mail', oys_social_url('email', 'a@b.de'), 'mailto:a@b.de');
t('Mastodon handle', oys_social_url('mastodon', '@mia@mastodon.social'), 'https://mastodon.social/@mia');
t('URL bleibt', oys_social_url('discord', 'https://discord.gg/abc'), 'https://discord.gg/abc');
t('Name mit Sonderzeichen', oys_social_url('github', 'a"b<c'), 'https://github.com/abc');
// Markenerkennung
t('youtu.be → youtube', oys_detect_brand('https://youtu.be/x'), 'youtube');
t('x.com → x', oys_detect_brand('https://x.com/abc'), 'x');
t('m.facebook.com → facebook', oys_detect_brand('https://m.facebook.com/abc'), 'facebook');
t('evilinstagram.com nicht', oys_detect_brand('https://evilinstagram.com/'), null);
// Adressen
t('Adresse ok', oys_slug_problem($pdo, 'mein-name-42'), null);
t('Adresse admin verboten', oys_slug_problem($pdo, 'admin') !== null, true);
t('Doppelstrich verboten', oys_slug_problem($pdo, 'a--b') !== null, true);
t('reserviert dashboard', oys_slug_problem($pdo, 'dashboard') !== null, true);
// Spamfilter
t('Spam: viele Links', oys_looks_like_spam('see http://a.de http://b.de http://c.de'), true);
t('Spam: casino', oys_looks_like_spam('Best Casino bonus'), true);
t('Kein Spam', oys_looks_like_spam('Hallo, ich habe eine Frage zu deinem Merch.'), false);
// Eigenes CSS kann nicht aus <style> ausbrechen und lädt nichts von fremden Servern
t('CSS ohne <', strpos(oys_clean_css('a{color:red}</style><script>alert(1)</script>'), '<'), false);
t('CSS: url(https://…) entfernt', oys_clean_css('b{background:url(https://evil.example/x.png)}'), 'b{background:url("")}');
t('CSS: getarntes u\\72l( entfernt', oys_clean_css('b{background:u\\72l(https://evil.example)}'), 'b{background:url("")}');
t('CSS: @\\69mport entfernt', strpos(oys_clean_css('@\\69mport "https://evil.example/a.css"; a{color:red}'), 'evil'), false);
t('CSS: image-set fremd entfernt', strpos(oys_clean_css('b{background:image-set("https://evil.example/a.png" 1x)}'), 'evil'), false);
t('CSS: eigene Bilder bleiben', oys_clean_css('b{background:url(/static/uploads/bg_3_1_ab.webp)}'), 'b{background:url(/static/uploads/bg_3_1_ab.webp)}');
t('CSS: Text mit Doppelpunkt bleibt', oys_clean_css('.a::before{content:"Tipp: https://x"}'), '.a::before{content:"Tipp: https://x"}');
// Texte: Steuerzeichen raus, Emoji-Verbinder bleiben
t('Emoji mit ZWJ bleibt', oys_clean_text("Dev 👨\u{200D}💻"), "Dev 👨\u{200D}💻");
t('Richtungs-Override entfernt', oys_clean_text("abc\u{202E}fed"), 'abcfed');
t('Steuerzeichen entfernt, Umbruch bleibt', oys_clean_text("a\x07b\nc", 50, true), "ab\nc");
// Termin-Block: eingebauter Kalender?
$cp = ['id' => 1, 'slug' => 'mia', 'address_mode' => 'subdomain'];
t('Kalender: /kalender intern', oys_booking_is_internal(['url' => '/kalender'], $cp), true);
t('Kalender: eigene volle Adresse intern', oys_booking_is_internal(['url' => oys_page_urls($cp)['path'] . '/kalender'], $cp), true);
t('Kalender: Calendly extern', oys_booking_is_internal(['url' => 'https://calendly.com/mia'], $cp), false);
t('Kalender: fremde Seite extern', oys_booking_is_internal(['url' => oys_page_urls(['slug' => 'tom'] + $cp)['subdomain'] . '/kalender'], $cp), false);
// Block-Validierung: fremde Datei wird abgelehnt
$b = oys_block_normalize(['type' => 'image', 'data' => ['src' => 'img_99_123_abc.webp']], 3);
t('Fremde Upload-Datei abgelehnt', $b['data']['src'], '');
$b = oys_block_normalize(['type' => 'image', 'data' => ['src' => '../../config.php']], 3);
t('Pfad-Traversal abgelehnt', $b['data']['src'], '');
$b = oys_block_normalize(['type' => 'link', 'protection' => 'password', 'password' => '', 'data' => ['url' => 'https://a.de']], 3);
t('Passwortschutz ohne Passwort → geschützt, aber ausgeblendet + Warnung', $b['protection'] . '|' . $b['is_visible'] . '|' . ($b['warning'] ? 'w' : ''), 'password|0|w');
$b = oys_block_normalize(['type' => 'link', 'protection' => 'password', 'password' => '1234', 'data' => ['url' => 'https://a.de']], 3);
t('Zu kurzes Link-Passwort wird nicht übernommen', $b['is_visible'] . '|' . ($b['password_hash'] === null ? 'kein Hash' : 'Hash'), '0|kein Hash');
$b = oys_block_normalize(['type' => 'link', 'protection' => 'password', 'password' => '', 'data' => ['url' => 'https://a.de']], 3, ['password_hash' => '$2y$10$abc']);
t('Bestehendes Passwort bleibt beim Speichern', $b['password_hash'] . '|' . $b['is_visible'], '$2y$10$abc|1');
$b = oys_block_normalize(['type' => 'heading', 'protection' => 'password', 'password' => 'x', 'data' => ['text' => 'Hi']], 3);
t('Schutz nur für klickbare Blöcke', $b['protection'], 'none');
echo $fails ? "\n$fails FEHLER\n" : "\nAlle Tests bestanden\n";
