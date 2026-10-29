<?php
// Atom-Feed der veröffentlichten Updates: /updates/feed.xml
/** @var PDO $pdo */
$updates = oys_updates_list($pdo, true, 30);
$x = function ($s) { return htmlspecialchars((string) $s, ENT_XML1 | ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); };
$iso = function ($dt) { return gmdate('Y-m-d\TH:i:s\Z', strtotime((string) $dt)); };
$host = oys_base_host();
$newest = $updates ? max(array_map(function ($u) { return strtotime((string) ($u['updated_at'] ?: $u['published_at'])); }, $updates)) : time();

header('Content-Type: application/atom+xml; charset=utf-8');
header('Cache-Control: public, max-age=600');
echo '<?xml version="1.0" encoding="utf-8"?>' . "\n";
?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>OnYourSite updates</title>
  <subtitle>What’s new at OnYourSite</subtitle>
  <id><?= $x(oys_main_url('/updates')) ?></id>
  <link rel="alternate" type="text/html" href="<?= $x(oys_main_url('/updates')) ?>"/>
  <link rel="self" type="application/atom+xml" href="<?= $x(oys_main_url('/updates/feed.xml')) ?>"/>
  <updated><?= gmdate('Y-m-d\TH:i:s\Z', $newest) ?></updated>
  <author><name>OnYourSite</name></author>
<?php foreach ($updates as $u): $cat = OYS_UPDATE_CATEGORIES[$u['category']]; ?>
  <entry>
    <title><?= $x(($u['version'] !== '' ? $u['version'] . ' – ' : '') . $u['title']) ?></title>
    <id>tag:<?= $x($host) ?>,<?= gmdate('Y-m-d', strtotime((string) ($u['created_at'] ?: $u['published_at']))) ?>:update-<?= $u['id'] ?></id>
    <link rel="alternate" type="text/html" href="<?= $x(oys_update_url($u['id'])) ?>"/>
    <published><?= $iso($u['published_at']) ?></published>
    <updated><?= $iso($u['updated_at'] ?: $u['published_at']) ?></updated>
    <category term="<?= $x($u['category']) ?>" label="<?= $x($cat['label']) ?>"/>
    <summary><?= $x(oys_md_plain($u['body'], 280)) ?></summary>
    <content type="html"><?= $x(oys_markdown($u['body'])) ?></content>
  </entry>
<?php endforeach; ?>
</feed>
