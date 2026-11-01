// Atom-Feed der veröffentlichten Updates: /updates/feed.xml (views/updates_feed.php). Der Text außerhalb der
// PHP-Teile ist mit view2ts Byte für Byte übernommen.
import { baseHost, mainUrl } from '../../helpers.js';
import { xmlEscape as x } from '../../html.js';
import { gmdate, strtotime } from '../../php.js';
import { markdown, mdPlain } from '../markdown.js';
import { UPDATE_CATEGORIES, updateUrl, type Update } from '../updates.js';

// strtotime() der Ortszeit; ohne Ergebnis 0 wie (int) false in PHP
const unix = (dt: string | null): number => {
  const t = strtotime(dt ?? '');
  return t === false ? 0 : t;
};
// gmdate('Y-m-d\TH:i:s\Z', strtotime($dt))
const iso = (dt: string | null): string => gmdate('Y-m-d\\TH:i:s\\Z', unix(dt));

export function feedView(updates: Update[], newest: number): string {
  let o = '';
  const host = baseHost();
  o += '<?xml version="1.0" encoding="utf-8"?>' + '\n';
  o += "<feed xmlns=\"http://www.w3.org/2005/Atom\">\n  <title>OnYourSite updates</title>\n  <subtitle>What’s new at OnYourSite</subtitle>\n  <id>";
  o += x(mainUrl('/updates'));
  o += "</id>\n  <link rel=\"alternate\" type=\"text/html\" href=\"";
  o += x(mainUrl('/updates'));
  o += "\"/>\n  <link rel=\"self\" type=\"application/atom+xml\" href=\"";
  o += x(mainUrl('/updates/feed.xml'));
  o += "\"/>\n  <updated>";
  o += gmdate('Y-m-d\\TH:i:s\\Z', newest);
  o += "</updated>\n  <author><name>OnYourSite</name></author>\n";
  for (const u of updates) {
    const cat = UPDATE_CATEGORIES[u.category];
    o += "  <entry>\n    <title>";
    o += x((u.version !== '' ? u.version + ' – ' : '') + u.title);
    o += "</title>\n    <id>tag:";
    o += x(host);
    o += ",";
    o += gmdate('Y-m-d', unix(u.created_at || u.published_at));
    o += ":update-";
    o += u.id;
    o += "</id>\n    <link rel=\"alternate\" type=\"text/html\" href=\"";
    o += x(updateUrl(u.id));
    o += "\"/>\n    <published>";
    o += iso(u.published_at);
    o += "</published>\n    <updated>";
    o += iso(u.updated_at || u.published_at);
    o += "</updated>\n    <category term=\"";
    o += x(u.category);
    o += "\" label=\"";
    o += x(cat.label);
    o += "\"/>\n    <summary>";
    o += x(mdPlain(u.body, 280));
    o += "</summary>\n    <content type=\"html\">";
    o += x(markdown(u.body));
    o += "</content>\n  </entry>\n";
  }
  o += "</feed>\n";
  return o;
}
