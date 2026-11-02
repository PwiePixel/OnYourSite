// Admin-Aktionen für Updates, Roadmap und Discord (lib/updates.php: oys_admin_updates_handle). Die Formulare stehen in
// adminView.ts; views/admin.php ruft das hier für jedes POST mit oys_action auf und leitet danach weiter.
// Die Discord-Einstellungen (discord_*) behandelt app/src/discord/admin.ts.
import type { Ctx } from '../web/ctx.js';
import { configString } from '../config.js';
import { LockBusyError, withNamedLock } from '../db.js';
import { intval, phpRtrim, phpStr, phpTrim, phpTruthy } from '../php.js';
import {
  MILESTONE_STATUSES, isMilestoneStatus, milestoneDelete, milestoneGet, milestoneMove, milestoneSave, milestoneSetStatus,
  taskAdd, taskDelete, taskGet, taskToggle, updateDelete, updateGet, updateSave, updateSetPublished, type Input,
} from './updates.js';
import { discordAdminHandle, type AdminResult } from '../discord/admin.js';
import {
  TEXTS, announce, anyDestination, delivery, isOnDiscord, postsOf, remove, removeNote, stillPosting, syncEdit,
  type AnnounceOutcome, type Delivery, type EditOutcome, type RemoveOutcome,
} from '../discord/posts.js';

// ['tab', 'ok'|'error', 'query'?] – admin.php macht daraus die Meldung und leitet nach /admin{query}#{tab} weiter
export type { AdminResult };

const ok = (tab: string, text: string): AdminResult => ({ tab, ok: text });
const fail = (tab: string, text: string, query?: string): AdminResult => (query === undefined ? { tab, error: text } : { tab, error: text, query });

// Aktionen, die ein Update in Discord posten, ändern oder entfernen, laufen je Update nacheinander: ein zweiter Klick
// während des Postens wartet nicht, sondern bekommt sofort Bescheid (kein doppelter Beitrag)
const DISCORD_ACTIONS = new Set(['update_save', 'update_publish', 'update_discord', 'update_discord_remove', 'update_delete']);
export const ALREADY_POSTING = 'Already posting to Discord – this takes a few seconds.';

// oys_admin_updates_handle(): null, wenn die Aktion nicht hierher gehört (dann geht es in admin.php weiter)
export async function adminUpdatesHandle(post: Input, ctx?: Ctx): Promise<AdminResult | null> {
  const action = phpStr(post.oys_action ?? '');
  if (action.startsWith('discord_')) return discordAdminHandle(action, post, ctx);
  const id = intval(post.id ?? 0);
  if (DISCORD_ACTIONS.has(action) && id > 0) {
    try {
      // Sperren gelten für den ganzen Datenbank-Server – darum mit dem Namen der Datenbank
      return await withNamedLock(configString('db.name') + ':discord_update:' + id, 0, () => handle(action, id, post), 'fail');
    } catch (err) {
      if (err instanceof LockBusyError) return fail('updates', ALREADY_POSTING);
      throw err;
    }
  }
  return handle(action, id, post);
}

async function handle(action: string, id: number, post: Input): Promise<AdminResult | null> {
  switch (action) {
    case 'update_save': {
      const existing = id ? await updateGet(id) : null;
      const [newId, error] = await updateSave(post, existing);
      if (error) return fail('updates', error, existing ? '?edit_update=' + existing.id : '');
      const u = (await updateGet(newId as number))!;
      const msg = u.is_published ? 'Update published.' : 'Draft saved.';
      const d = await delivery();
      const onDiscord = isOnDiscord((await postsOf([u.id])).get(u.id));
      // Schon in Discord: die Beiträge anpassen, aber nie neu posten
      if (u.is_published && onDiscord) return editResult(msg, await syncEdit(u, d));
      if (u.is_published && anyDestination(d) && phpTruthy(post.post_discord)) return announceResult('save', msg, await announce(u, d), d);
      if (!u.is_published && onDiscord) return removeResult('save', msg, (await remove(u, d)).outcomes);
      return ok('updates', msg);
    }

    case 'update_publish': {
      let u = await updateGet(id);
      if (!u) return fail('updates', 'Update not found.');
      const publish = phpTruthy(post.state);
      await updateSetPublished(u, publish);
      u = (await updateGet(id))!;
      const d = await delivery();
      const rows = (await postsOf([u.id])).get(u.id);
      const onDiscord = isOnDiscord(rows);
      // Wie bisher: der Text sagt „aktualisiert“, wenn vorher schon ein Beitrag (Webhook/Token) da war
      const hadSync = !!rows && rows.some((r) => r.via !== 'bot' && r.state !== 'failed');
      if (!publish) {
        if (!onDiscord) return ok('updates', 'Moved back to drafts.');
        return removeResult('unpublish', 'Moved back to drafts.', (await remove(u, d)).outcomes);
      }
      // Ankündigen nur, wenn es beim Schreiben so gewählt wurde; ein vorhandener Beitrag wird aktualisiert
      if (anyDestination(d) && (onDiscord || u.discord_announce)) return announceResult('publish', 'Published.', await announce(u, d), d, hadSync);
      return ok('updates', 'Update published.');
    }

    case 'update_discord': {
      const u = await updateGet(id);
      if (!u || !u.is_published) return fail('updates', 'Only published updates can be posted to Discord.');
      const d = await delivery();
      if (!anyDestination(d)) {
        return fail('updates', isOnDiscord((await postsOf([u.id])).get(u.id)) ? 'Discord isn’t connected.' : 'Discord isn’t set up yet (Admin → Discord).');
      }
      return announceResult('discord', '', await announce(u, d), d);
    }

    case 'update_discord_remove': {
      const u = await updateGet(id);
      if (!u || !isOnDiscord((await postsOf([u.id])).get(u.id))) return fail('updates', 'This update isn’t on Discord.');
      return removeResult('remove', '', (await remove(u, await delivery())).outcomes);
    }

    case 'update_delete': {
      const u = await updateGet(id);
      if (!u) return fail('updates', 'Update not found.');
      // Während gerade gesendet wird, nicht löschen (die Nachricht könnte gleich entstehen)
      if (await stillPosting(u.id)) return fail('updates', TEXTS.stillPosting);
      const res = await remove(u, await delivery(), { deleting: true });
      if (res.abort) {
        // Kurzer Aussetzer bei Discord: nichts löschen, damit ein neuer Versuch die Nachricht noch findet
        return fail('updates', 'Nothing was deleted, because its Discord post couldn’t be removed: ' + phpStr(res.abort.error));
      }
      await updateDelete(id);
      return removeResult('delete', 'Update deleted.', res.outcomes);
    }

    case 'milestone_save': {
      const existing = id ? await milestoneGet(id) : null;
      const [, error] = await milestoneSave(post, existing);
      if (error) return fail('roadmap', error, existing ? '?edit_milestone=' + existing.id : '');
      return ok('roadmap', existing ? 'Milestone saved.' : 'Milestone added.');
    }

    case 'milestone_status': {
      const ms = await milestoneGet(id);
      const status = phpStr(post.status ?? '');
      if (ms && isMilestoneStatus(status)) {
        await milestoneSetStatus(ms, status);
        return ok('roadmap', '“' + ms.title + '” moved to ' + MILESTONE_STATUSES[status].label + '.');
      }
      return fail('roadmap', 'Milestone not found.');
    }

    case 'milestone_move': {
      const ms = await milestoneGet(id);
      if (ms) await milestoneMove(ms, post.dir === 'up' ? 'up' : 'down');
      return ok('roadmap', 'Order updated.');
    }

    case 'milestone_delete':
      await milestoneDelete(id);
      return ok('roadmap', 'Milestone deleted.');

    case 'task_add':
      if ((await milestoneGet(id)) && phpTrim(phpStr(post.title ?? '')) !== '') {
        await taskAdd(id, phpStr(post.title));
        return ok('roadmap', 'Task added.');
      }
      return fail('roadmap', 'Please enter a task.');

    case 'task_toggle':
    case 'task_delete': {
      const task = await taskGet(id);
      if (!task) return fail('roadmap', 'Task not found.');
      if (action === 'task_toggle') await taskToggle(task);
      else await taskDelete(task);
      return ok('roadmap', action === 'task_toggle' ? 'Task updated.' : 'Task removed.');
    }
  }
  return null;
}

// ------------------------------------------------------------------ Meldungen

interface Part { text: string; bad: boolean }
const good = (text: string): Part => ({ text, bad: false });
const bad = (text: string): Part => ({ text, bad: true });

// Meldung aus einem Anfang und Sätzen je Ziel; ein Fehler macht daraus eine Fehlermeldung
function compose(head: string, parts: Part[]): AdminResult {
  const text = [head, ...parts.map((p) => p.text)].filter((t) => t !== '').join(' ');
  return parts.some((p) => p.bad) ? fail('updates', text) : ok('updates', text);
}

// Der Bot hat einen neuen Beitrag in der Warteschlange: wann er kommt
function botPostSentence(d: Delivery): string {
  if (!d.botCanPost) return 'The bot needs an update before it can post it.';
  if (!d.botOnline) return 'The bot is offline – it posts it when it’s back, within 24 hours.';
  return 'The bot posts it to Discord within a few seconds.';
}

// Ergebnis „bearbeiten“ (Webhook/Token wie bisher, Bot über die Warteschlange)
function editResult(msg: string, outcomes: EditOutcome[]): AdminResult {
  const parts: Part[] = [];
  for (const o of outcomes) {
    if (o.what === 'queued') parts.push(good('The bot updates its post within a few seconds.'));
    else if (o.what === 'no_bot') parts.push(bad('Its Discord post wasn’t updated – the Discord bot isn’t set up.'));
    else {
      const c = o.change;
      if (c.state === 'ok') parts.push(good('The Discord post was updated too.'));
      else if (c.state === 'missing') parts.push(bad('Its Discord post had been deleted – use “Post to Discord” to announce it again.'));
      else if (c.state === 'unreachable') parts.push(bad('Its Discord post can’t be edited from here (' + phpRtrim(phpStr(c.error), '.') + ') – use “Post to Discord” to announce it again.'));
      else if (c.state === 'disconnected') parts.push(good('Discord isn’t connected, so its post there wasn’t updated.'));
      else parts.push(bad('But Discord: ' + phpStr(c.error)));
    }
  }
  return compose(msg, parts);
}

// Fehlertext eines Ziels beim Ankündigen (wie oys_discord_announce_update)
function announceError(o: AnnounceOutcome): string | null {
  if (o.what === 'failed') return o.error;
  if (o.what === 'busy') return o.text;
  if (o.what === 'edited' && o.change.state !== 'ok') return phpRtrim(phpStr(o.change.error), '.') + '.';
  return null;
}

// Ergebnis „ankündigen“ – kind: save (update_save), publish (update_publish), discord („Post to Discord“)
function announceResult(kind: 'save' | 'publish' | 'discord', msg: string, outcomes: AnnounceOutcome[], d: Delivery, hadSync = false): AdminResult {
  const errors = outcomes.map(announceError).filter((e): e is string => e !== null);
  const posted = outcomes.some((o) => o.what === 'posted');
  const edited = outcomes.some((o) => o.what === 'edited' && o.change.state === 'ok');
  const botPost = outcomes.some((o) => o.what === 'queued' && o.job === 'post');
  const botEdit = outcomes.some((o) => o.what === 'queued' && o.job === 'edit');
  const botSentences: string[] = [];
  if (botPost) botSentences.push(kind === 'discord' ? queuedSentence(d) : botPostSentence(d));
  if (botEdit) botSentences.push(kind === 'discord' ? 'Queued for the bot.' : 'The bot updates its post within a few seconds.');
  const sync = posted || edited;
  if (kind === 'discord') {
    if (errors.length) return fail('updates', [...errors, ...botSentences].join(' '));
    return ok('updates', [...(sync ? ['Posted to Discord.'] : []), ...botSentences].join(' '));
  }
  if (kind === 'save') {
    if (errors.length) return fail('updates', [msg + ' But Discord: ' + errors.join(' '), ...botSentences].join(' '));
    return ok('updates', [msg, ...(sync ? ['It was posted to Discord.'] : []), ...botSentences].join(' '));
  }
  // publish
  if (errors.length) return fail('updates', ['Published. But Discord: ' + errors.join(' '), ...botSentences].join(' '));
  if (sync) return ok('updates', [hadSync ? 'Published – its Discord post was updated.' : 'Published and posted to Discord.', ...botSentences].join(' '));
  if (botSentences.length) return ok('updates', 'Published – ' + lowerFirst(botSentences.join(' ')));
  return ok('updates', 'Update published.');
}

// „Post to Discord“ mit dem Bot
function queuedSentence(d: Delivery): string {
  if (!d.botCanPost) return 'Queued for the bot – it needs an update before it can post it.';
  if (!d.botOnline) return 'Queued for the bot – it is offline and posts it when it’s back, within 24 hours.';
  return 'Queued for the bot.';
}

const lowerFirst = (t: string): string => t.charAt(0).toLowerCase() + t.slice(1);

// Ergebnis „entfernen“ – kind: save (Entwurf gespeichert), unpublish, remove („Remove from Discord“), delete
function removeResult(kind: 'save' | 'unpublish' | 'remove' | 'delete', msg: string, outcomes: RemoveOutcome[]): AdminResult {
  const removed = outcomes.some((o) => o.what === 'removed');
  const queued = outcomes.some((o) => o.what === 'queued');
  const notes: string[] = [];
  for (const o of outcomes) {
    if (o.what === 'change') {
      const note = removeNote(o.change, kind === 'delete');
      if (note !== '') notes.push(note);
    } else if (o.what === 'busy') notes.push(o.text);
  }
  const botSentence = queued ? ['The bot removes its post within a few seconds.'] : [];
  if (notes.length) return fail('updates', [msg, ...botSentence, ...notes].filter((t) => t !== '').join(' '));
  switch (kind) {
    case 'save':
      return ok('updates', [msg, ...(removed || !queued ? ['The Discord post was removed.'] : []), ...botSentence].join(' '));
    case 'unpublish':
      return ok('updates', [removed || !queued ? 'Moved back to drafts and removed from Discord.' : msg, ...botSentence].join(' '));
    case 'remove':
      return ok('updates', [...(removed || !queued ? ['Removed from Discord.'] : []), ...botSentence].join(' '));
    default:
      return ok('updates', [msg, ...botSentence].join(' '));
  }
}
