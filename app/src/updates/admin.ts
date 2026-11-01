// Admin-Aktionen für Updates, Roadmap und Discord (lib/updates.php: oys_admin_updates_handle). Die Formulare stehen in
// adminView.ts; views/admin.php ruft das hier für jedes POST mit oys_action auf und leitet danach weiter.
import { intval, phpRtrim, phpStr, phpTrim, phpTruthy } from '../php.js';
import { baseHost, mainUrl } from '../helpers.js';
import {
  MILESTONE_STATUSES, isMilestoneStatus, milestoneDelete, milestoneGet, milestoneMove, milestoneSave, milestoneSetStatus,
  taskAdd, taskDelete, taskGet, taskToggle, updateDelete, updateGet, updateSave, updateSetPublished, type Input,
} from './updates.js';
import {
  discordAnnounceUpdate, discordConfigured, discordRemoveNote, discordRemoveUpdate, discordSaveSettings, discordSend, discordSettings,
  discordStore, discordSyncUpdate, discordWithMention,
} from './discord.js';

// ['tab', 'ok'|'error', 'query'?] – admin.php macht daraus die Meldung und leitet nach /admin{query}#{tab} weiter
export interface AdminResult { tab: string; ok?: string; error?: string; query?: string }

const ok = (tab: string, text: string): AdminResult => ({ tab, ok: text });
const fail = (tab: string, text: string, query?: string): AdminResult => (query === undefined ? { tab, error: text } : { tab, error: text, query });

// oys_admin_updates_handle(): null, wenn die Aktion nicht hierher gehört (dann geht es in admin.php weiter)
export async function adminUpdatesHandle(post: Input): Promise<AdminResult | null> {
  const action = phpStr(post.oys_action ?? '');
  const id = intval(post.id ?? 0);
  const discord = await discordSettings();
  const ready = discordConfigured(discord);

  switch (action) {
    case 'update_save': {
      const existing = id ? await updateGet(id) : null;
      const [newId, error] = await updateSave(post, existing);
      if (error) return fail('updates', error, existing ? '?edit_update=' + existing.id : '');
      const u = (await updateGet(newId as number))!;
      const msg = u.is_published ? 'Update published.' : 'Draft saved.';
      if (u.is_published && u.discord_message_id !== '') {
        // Schon in Discord: die Nachricht anpassen, aber nie neu posten
        const res = await discordSyncUpdate(u, discord);
        switch (res.state) {
          case 'ok':
            return ok('updates', msg + ' The Discord post was updated too.');
          case 'missing':
            return fail('updates', msg + ' Its Discord post had been deleted – use “Post to Discord” to announce it again.');
          case 'unreachable':
            return fail('updates', msg + ' Its Discord post can’t be edited from here (' + phpRtrim(phpStr(res.error), '.') + ') – use “Post to Discord” to announce it again.');
          case 'disconnected':
            return ok('updates', msg + ' Discord isn’t connected, so its post there wasn’t updated.');
        }
        return fail('updates', msg + ' But Discord: ' + phpStr(res.error));
      }
      if (u.is_published && ready && phpTruthy(post.post_discord)) {
        const err = await discordAnnounceUpdate(u, discord);
        return err ? fail('updates', msg + ' But Discord: ' + err) : ok('updates', msg + ' It was posted to Discord.');
      }
      if (!u.is_published && u.discord_message_id !== '') {
        const note = discordRemoveNote(await discordRemoveUpdate(u, discord));
        return note === '' ? ok('updates', msg + ' The Discord post was removed.') : fail('updates', msg + ' ' + note);
      }
      return ok('updates', msg);
    }

    case 'update_publish': {
      let u = await updateGet(id);
      if (!u) return fail('updates', 'Update not found.');
      const publish = phpTruthy(post.state);
      await updateSetPublished(u, publish);
      u = (await updateGet(id))!;
      if (!publish) {
        if (u.discord_message_id === '') return ok('updates', 'Moved back to drafts.');
        const note = discordRemoveNote(await discordRemoveUpdate(u, discord));
        return note === '' ? ok('updates', 'Moved back to drafts and removed from Discord.') : fail('updates', 'Moved back to drafts. ' + note);
      }
      // Ankündigen nur, wenn es beim Schreiben so gewählt wurde; eine noch vorhandene Nachricht wird aktualisiert
      if (ready && (u.discord_message_id !== '' || u.discord_announce)) {
        const had = u.discord_message_id !== '';
        const err = await discordAnnounceUpdate(u, discord);
        if (err) return fail('updates', 'Published. But Discord: ' + err);
        return ok('updates', had ? 'Published – its Discord post was updated.' : 'Published and posted to Discord.');
      }
      return ok('updates', 'Update published.');
    }

    case 'update_discord': {
      const u = await updateGet(id);
      if (!u || !u.is_published) return fail('updates', 'Only published updates can be posted to Discord.');
      const err = await discordAnnounceUpdate(u, discord);
      return err ? fail('updates', err) : ok('updates', 'Posted to Discord.');
    }

    case 'update_discord_remove': {
      const u = await updateGet(id);
      if (!u || u.discord_message_id === '') return fail('updates', 'This update isn’t on Discord.');
      const note = discordRemoveNote(await discordRemoveUpdate(u, discord));
      return note === '' ? ok('updates', 'Removed from Discord.') : fail('updates', note);
    }

    case 'update_delete': {
      const u = await updateGet(id);
      if (!u) return fail('updates', 'Update not found.');
      const res = await discordRemoveUpdate(u, discord);
      if (res.state === 'failed' && res.transient) {
        // Kurzer Aussetzer bei Discord: nichts löschen, damit ein neuer Versuch die Nachricht noch findet
        return fail('updates', 'Nothing was deleted, because its Discord post couldn’t be removed: ' + phpStr(res.error));
      }
      await updateDelete(id);
      const note = discordRemoveNote(res, true);
      return note === '' ? ok('updates', 'Update deleted.') : fail('updates', 'Update deleted. ' + note);
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

    case 'discord_save': {
      const err = await discordSaveSettings(post);
      return err ? fail('discord', err) : ok('discord', 'Discord settings saved.');
    }

    case 'discord_test': {
      if (!ready) return fail('discord', 'Please save a webhook link or bot first.');
      const payload = discordWithMention({
        embeds: [{
          title: 'Discord is connected',
          description: 'New updates from ' + baseHost() + ' will show up here.',
          url: mainUrl('/updates'),
          color: 0x6366f1,
          footer: { text: 'OnYourSite Updates' },
        }],
      }, { ...discord, mention: '' });
      const sent = await discordSend(discord, payload);
      return sent.ok ? ok('discord', 'Test message sent – check your Discord channel.') : fail('discord', phpStr(sent.error));
    }

    case 'discord_disconnect':
      await discordStore(null);
      return ok('discord', 'Discord disconnected.');
  }
  return null;
}
