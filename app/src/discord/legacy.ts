// Schon gepostete Updates aus der Zeit vor update_discord_posts (Spalten updates.discord_message_id/discord_target)
// als Zeilen – nur für den Schritt V_DISCORD_DELIVERY und für Tests, die den alten Stand nachstellen.
//
// Gespeicherte Ziele: 'webhook:{webhookId}' (Nachricht im Kanal), 'webhook:{webhookId}:{threadId}' (in einem Thread
// oder Forenbeitrag – ist die Thread-ID die ID der Nachricht, war es ein neuer Forenbeitrag) und 'bot:{channelId}'
// (alter Bot-Token).

export type LegacyKind = 'message' | 'thread_msg' | 'forum_post';
export interface LegacyPost { via: 'webhook' | 'token' | 'bot'; target: string; kind: LegacyKind; channel_id: string | null; legacy: 0 | 1 }

// tokenStored: der alte Token ist noch gespeichert (seine Beiträge bleiben bei ihm); sonst übernimmt der installierte
// Bot sie (legacy); ohne beides werden sie nicht übernommen (wie bisher nicht erreichbare Beiträge)
export function legacyPostRow(target: string, messageId: string, opts: { tokenStored: boolean; botInstalled: boolean }): LegacyPost | null {
  let m = /^webhook:(\d{5,25})(?::(\d{15,25}))?$/.exec(target);
  if (m) {
    const thread = m[2] ?? '';
    return {
      via: 'webhook', target: 'webhook:' + m[1], kind: thread === '' ? 'message' : thread === messageId ? 'forum_post' : 'thread_msg',
      channel_id: thread === '' ? null : thread, legacy: 0,
    };
  }
  m = /^bot:(\d{15,25})$/.exec(target);
  if (!m) return null;
  if (opts.tokenStored) return { via: 'token', target, kind: 'message', channel_id: m[1], legacy: 1 };
  if (opts.botInstalled) return { via: 'bot', target: 'bot', kind: 'message', channel_id: m[1], legacy: 1 };
  return null;
}
