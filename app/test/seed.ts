// Test-Datenbank anlegen: `npm run test:seed` (Name aus db.name in config.json bzw. OYS_CONFIG, muss mit oys_test
// beginnen). Die Datenbank wird gelöscht und neu gebaut: zuerst alte Profile wie in einer 2.x-Installation (eine Zeile je
// Konto in users, mit Links), dann führt ensureSchema() alle Schritte aus – die Übernahme der alten Profile legt daraus
// die Seiten an, genau wie bei einem echten Update (die Tabellen kommen aus diesem Code, haben also schon alle neuen
// Spalten – die Übernahme selbst läuft aber wie aus 2.x). Die Testdateien kopieren diese Datenbank (testDatabase()) und
// verlassen sich auf diese Konten (Passwort aller Konten: das der Browser-Tests, OYS_E2E_PASSWORD):
//   3 admin@test.de  „Pixel Admin“  Admin, Seite 1 „pixel“
//   5 mia@test.de    „Mia Müller“   Seite 2 „mia“
//   6 tom@test.de    „Tom Weber“    Seite 3 „tom“
//   7 lea@test.de    „Lea“          Seite 4 „lea“
//   8 noname@test.de „Ohne Domain“  ohne Adresse → keine Seite
//   9 nopage@test.de „No Page“      leere Adresse → keine Seite
// Blöcke in der Reihenfolge der Übernahme (die Tests nennen einige Nummern): 1–3 Links des Admins, 4 Termin-Block
// (/kalender), 5–6 „About me“, 7–9 Links von Mia, 10 Datei, 11–13 Links von Tom, 14 Link von Lea.
import mysql from 'mysql2/promise';
import { configString, loadConfig, setConfigForTests } from '../src/config.js';
import { closePool, timeZone, tzOffset } from '../src/db.js';
import { ensureSchema } from '../src/schema.js';
import { encryptData, passwordHash } from '../src/crypto.js';

const NAME = configString('db.name');
const CREATED = '2026-01-15 10:00:00';
// Passwort aller Konten für die Browser-Tests (OYS_E2E_PASSWORD, Vorgabe wie dort zur Laufzeit zusammengesetzt)
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');

interface LegacyUser {
  id: number; email: string; fullName: string; username: string | null; admin?: boolean; profession?: string; bio?: string;
  booking?: string; cv?: string; about?: string; links?: Array<[string, string, string]>;
}
const USERS: LegacyUser[] = [
  { id: 3, email: 'admin@test.de', fullName: 'Pixel Admin', username: 'pixel', admin: true, bio: 'Hallo',
    links: [['Instagram', 'https://instagram.com/pixel', 'bx bxl-instagram'], ['GitHub', 'https://github.com/pixel', 'bx bxl-github'], ['Website', 'https://pixel.example', 'bx bx-globe']] },
  { id: 5, email: 'mia@test.de', fullName: 'Mia Müller', username: 'mia', profession: 'Designerin', bio: 'Design & Illustration',
    booking: '/kalender', about: 'Ich gestalte Logos und Websites.',
    links: [['Portfolio', 'https://mia.design', 'bx bx-palette'], ['Instagram', 'https://instagram.com/mia', 'bx bxl-instagram'], ['Email', 'mailto:mia@test.de', 'bx bx-envelope']] },
  { id: 6, email: 'tom@test.de', fullName: 'Tom Weber', username: 'tom', profession: 'Fotograf', cv: 'card.vcf',
    links: [['Twitch', 'https://twitch.tv/tom', 'bx bxl-twitch'], ['YouTube', 'https://youtube.com/@tom', 'bx bxl-youtube'], ['Shop', 'https://tom.example/shop', 'bx bx-store']] },
  { id: 7, email: 'lea@test.de', fullName: 'Lea', username: 'lea', bio: 'Bio', links: [['Blog', 'https://lea.example', 'bx bx-book']] },
  { id: 8, email: 'noname@test.de', fullName: 'Ohne Domain', username: null },
  { id: 9, email: 'nopage@test.de', fullName: 'No Page', username: '' },
];

// Was die Übernahme anlegen muss (Seite:Konto:Adresse, Block:Seite:Art)
const EXPECTED = {
  pages: '1:3:pixel 2:5:mia 3:6:tom 4:7:lea',
  blocks: '1:1:link 2:1:link 3:1:link 4:2:booking 5:2:heading 6:2:text 7:2:link 8:2:link 9:2:link 10:3:file 11:3:link 12:3:link 13:3:link 14:4:link',
};

async function main(): Promise<void> {
  if (!/^oys_test[a-z0-9_]*$/.test(NAME)) {
    process.stderr.write(`Refusing to seed "${NAME}": the test database name must start with oys_test and contain only a–z, 0–9 and _.\n`);
    process.exit(1);
  }
  const admin = await mysql.createConnection({
    host: configString('db.host', 'localhost'), user: configString('db.user', ''), password: configString('db.pass', ''),
    charset: 'utf8mb4_unicode_ci', multipleStatements: false,
  });
  // Zeiten in der Zeitzone der Seite schreiben, wie die Seite selbst (users.created_at ist TIMESTAMP)
  await admin.query('SET time_zone = ?', [tzOffset(timeZone())]);
  const tmp = NAME + '_seedtmp';
  try {
    // Einmal in einer leeren Hilfsdatenbank alles bauen, um Tabellen daraus zu übernehmen
    for (const db of [NAME, tmp]) {
      await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
      await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    }
    await withDb(tmp, () => ensureSchema());
    // Die Tabellen der alten Profile (users, user_links) so, wie dieser Code sie anlegt
    for (const table of ['users', 'user_links']) await admin.query(`CREATE TABLE \`${NAME}\`.${table} LIKE \`${tmp}\`.${table}`);
    await admin.query(`DROP DATABASE \`${tmp}\``);

    const hash = await passwordHash(PASSWORD);
    for (const u of USERS) {
      await admin.query(`INSERT INTO \`${NAME}\`.users (id, email, password, full_name, username, is_admin, profession, bio, booking_url, cv_file, detailed_bio, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [u.id, u.email, hash, u.fullName, u.username, u.admin ? 1 : 0, u.profession ?? '', u.bio ?? '',
        u.booking ? encryptData(u.booking) ?? null : null, u.cv ?? null, u.about ?? '', CREATED]);
      for (const [i, [title, url, icon]] of (u.links ?? []).entries()) {
        await admin.query(`INSERT INTO \`${NAME}\`.user_links (user_id, title, url, icon_class, sort_order) VALUES (?, ?, ?, ?, ?)`, [u.id, title, url, icon, i]);
      }
    }
    // Alle Schritte, die Übernahme der alten Profile zuerst
    await withDb(NAME, () => ensureSchema());
    // Die Übernahme überspringt ein Profil bei einem Fehler nur mit einer Meldung: dann stimmen die Nummern nicht, die
    // die Tests nennen – lieber hier deutlich scheitern als später in vielen Tests
    const [pages] = await admin.query(`SELECT id, user_id, slug FROM \`${NAME}\`.pages ORDER BY id`);
    const [blocks] = await admin.query(`SELECT id, page_id, type FROM \`${NAME}\`.page_blocks ORDER BY id`);
    const got = {
      pages: (pages as Array<{ id: number; user_id: number; slug: string }>).map((p) => `${p.id}:${p.user_id}:${p.slug}`).join(' '),
      blocks: (blocks as Array<{ id: number; page_id: number; type: string }>).map((b) => `${b.id}:${b.page_id}:${b.type}`).join(' '),
    };
    if (got.pages !== EXPECTED.pages || got.blocks !== EXPECTED.blocks) {
      process.stderr.write(`The seed came out differently than the tests expect.\n  pages:  ${got.pages}\n  wanted: ${EXPECTED.pages}\n  blocks: ${got.blocks}\n  wanted: ${EXPECTED.blocks}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Seeded ${NAME}: ${USERS.length} accounts, ${(pages as unknown[]).length} pages, ${(blocks as unknown[]).length} blocks.\n`);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS \`${tmp}\``).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

// ensureSchema() arbeitet auf der Datenbank der Einstellungen – für die Hilfsdatenbank kurz umstellen
async function withDb(name: string, fn: () => Promise<void>): Promise<void> {
  const base = loadConfig();
  await closePool();
  setConfigForTests({ ...base, db: { ...(base.db as Record<string, string>), name } });
  try {
    await fn();
  } finally {
    await closePool();
    setConfigForTests(base);
  }
}

await main();
