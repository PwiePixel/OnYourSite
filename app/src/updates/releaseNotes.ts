// Texte für /updates zu jeder Version ab 3.2 (für Besucher geschrieben, nicht die Entwickler-Notizen aus CHANGELOG.md).
// Der Hintergrund-Job legt jeden Eintrag, den es noch nicht gibt, einmal als Entwurf an: Der Admin liest ihn unter
// Admin → Updates und veröffentlicht ihn mit einem Klick (und kündigt ihn damit in Discord an, wenn announce gesetzt
// ist). Was einmal angelegt wurde, steht in oys_meta['release_notes'] – ein gelöschter Entwurf kommt nicht wieder. Gibt
// es die Version schon (selbst eingetragen), wird nichts angelegt.
// Neue Version: hier einen Eintrag ergänzen (release.test.ts prüft, dass jede Version ab 3.2 einen hat).
import { exec, q, value } from '../db.js';
import { date } from '../php.js';
import { V_UPDATE_HISTORY } from '../schema.js';
import { registerJob, type JobContext } from '../jobs/registry.js';

export interface ReleaseNote {
  version: string; // wie in VERSION, z. B. 3.2.0
  category: 'new' | 'improved' | 'fixed' | 'news';
  title: string;
  body: string; // Markdown wie im Admin (**fett**, - Listen)
  announce: boolean; // beim Veröffentlichen in Discord ankündigen
}

export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    version: '3.4.2', category: 'new', title: 'Say hello to Bea', announce: true,
    body: 'Meet **Bea**, the OnYourSite bee:\n\n'
      + '- This winter she sits in the snow at the bottom of our pages – with a Santa hat and a warm scarf\n'
      + '- She wears the same hat as our logo',
  },
  {
    version: '3.4.1', category: 'improved', title: 'More winter on OnYourSite', announce: false,
    body: '- The fairy lights along the top now hang on one wire and twinkle gently, and our logo wears a new Santa hat\n'
      + '- Snow has settled at the bottom of our pages',
  },
  {
    version: '3.4.0', category: 'improved', title: 'OnYourSite gets ready for winter', announce: true,
    body: '- **A winter look for OnYourSite** – gently falling snow, fairy lights and a Santa hat on our logo, on the home page, the log in page, updates and roadmap during the holidays\n'
      + '- Your own page stays exactly as you made it – pick one of the five winter themes in the editor under **Design → Winter & Christmas** if you like',
  },
  {
    version: '3.3.0', category: 'new', title: 'Five new themes for winter and Christmas', announce: true,
    body: 'Get your page ready for the holidays:\n\n'
      + '- **Snowy Night** – falling snow under the moon\n'
      + '- **Candy Cane** – red and white stripes, sweet and festive\n'
      + '- **Gingerbread** – cookie brown with white icing\n'
      + '- **Christmas Market** – fairy lights on a winter evening\n'
      + '- **Frost** – icy blue and frosted glass\n\n'
      + 'Find them in the editor under **Design → Winter & Christmas**.',
  },
  {
    version: '3.2.0', category: 'improved', title: 'A bigger block picker – and dragging blocks works again', announce: true,
    body: '- **Bigger block picker** – large tiles with a short description of every block, and a search: type “video” or “countdown” and press Enter\n'
      + '- **Reorder your blocks again** – drag them by the handle on the left, on your phone and on your computer, also after changing your profile picture\n'
      + '- On phones, the handle now moves the block instead of scrolling the page',
  },
];

export const RELEASE_NOTES_META_KEY = 'release_notes';

// 3.2.0 → „3.2“ (so stehen Versionen auf /updates)
export const shortVersion = (v: string): string => v.replace(/\.0$/, '');

async function handled(): Promise<string[]> {
  const raw = await value('SELECT meta_value FROM oys_meta WHERE meta_key = ?', [RELEASE_NOTES_META_KEY]);
  try {
    const list = JSON.parse(String(raw ?? '[]')) as unknown;
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

// Fehlende Einträge als Entwürfe anlegen; gibt die Versionen zurück, die neu angelegt wurden
export async function seedReleaseNotes(notes: readonly ReleaseNote[] = RELEASE_NOTES): Promise<string[]> {
  const done = await handled();
  const added: string[] = [];
  const now = date('Y-m-d H:i:s');
  for (const n of notes) {
    if (done.includes(n.version)) continue;
    const short = shortVersion(n.version);
    const have = await q("SELECT id FROM updates WHERE TRIM(LEADING 'v' FROM LOWER(version)) IN (?, ?) LIMIT 1", [n.version, short]);
    if (!have.length) {
      await exec('INSERT INTO updates (title, body, version, category, is_published, published_at, discord_announce, created_at, updated_at) VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)',
        [n.title, n.body, short, n.category, n.announce ? 1 : 0, now, now]);
      added.push(n.version);
    }
    done.push(n.version);
    await exec('REPLACE INTO oys_meta (meta_key, meta_value) VALUES (?, ?)', [RELEASE_NOTES_META_KEY, JSON.stringify(done)]);
  }
  return added;
}

let registered = false;
// Beim Laden des Läufers (cli.ts jobs:tick) – einmal; nach einem Update steht der Entwurf beim nächsten Lauf im Admin
export function registerReleaseNotesJob(): void {
  if (registered) return;
  registered = true;
  registerJob({
    name: 'release_notes', everyMinutes: 60, minSchema: V_UPDATE_HISTORY, budgetSec: 30,
    run: async (c: JobContext) => {
      const added = await seedReleaseNotes();
      if (added.length) c.log(`release notes waiting as drafts: ${added.join(', ')}`);
    },
  });
}
