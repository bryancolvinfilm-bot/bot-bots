import { createHash, randomUUID } from 'node:crypto';
import { Store } from './store';
import type { Conversation, TeamConversation } from '../../packages/shared/types';

/** A team space contains exactly one persistent channel per bot. */
export class TeamConversations {
  constructor(private store: Store) {}
  create(title = 'New conversation') {
    const now = new Date().toISOString();
    return this.store.put('teamConversations', {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
    });
  }
  list() {
    return this.store
      .all('teamConversations')
      .sort(
        (a, b) => Number(!!a.legacy) - Number(!!b.legacy) || b.updatedAt.localeCompare(a.updatedAt),
      );
  }
  channel(spaceId: string, botId: string): Conversation {
    if (!this.store.get('teamConversations', spaceId)) throw Error('Team conversation not found.');
    const bot = this.store.get('bots', botId);
    if (!bot || bot.deletedAt) throw Error('Bot not found.');
    const existing = this.store
      .all('conversations')
      .find((c) => c.spaceId === spaceId && c.botId === botId);
    if (existing) return existing;
    return this.store.put('conversations', {
      id: `team-${createHash('sha256').update(`${spaceId}:${botId}`).digest('hex').slice(0, 32)}`,
      botId,
      spaceId,
      title: bot.name,
      createdAt: new Date().toISOString(),
    });
  }
  adopt(conversation: Conversation) {
    if (conversation.spaceId) return conversation;
    const space = this.create(conversation.title);
    return this.store.put('conversations', { ...conversation, spaceId: space.id });
  }
  touch(conversationId: string, prompt: string) {
    const conversation = this.store.get('conversations', conversationId);
    const space =
      conversation?.spaceId && this.store.get('teamConversations', conversation.spaceId);
    if (space)
      this.store.put('teamConversations', {
        ...space,
        updatedAt: new Date().toISOString(),
        title:
          space.title === 'New conversation'
            ? prompt.replace(/\s+/g, ' ').slice(0, 75)
            : space.title,
      });
  }
  ids(conversationId: string) {
    const channel = this.store.get('conversations', conversationId);
    return new Set(
      channel?.spaceId
        ? this.store
            .all('conversations')
            .filter((c) => c.spaceId === channel.spaceId)
            .map((c) => c.id)
        : [conversationId],
    );
  }
  context(conversationId: string, botId: string, runId: string) {
    const ids = this.ids(conversationId);
    const messages = this.store
      .all('messages')
      .filter((m) => {
        const reset = this.store.get('conversations', m.conversationId)?.contextResetAt;
        return (
          ids.has(m.conversationId) &&
          m.botId !== botId &&
          m.runId !== runId &&
          m.role !== 'system' &&
          (!reset || m.createdAt >= reset)
        );
      })
      .slice(-16);
    const brief = this.store
      .all('messages')
      .find(
        (m) =>
          ids.has(m.conversationId) &&
          m.role === 'user' &&
          !m.senderBotId &&
          m.runId !== runId &&
          (!this.store.get('conversations', m.conversationId)?.contextResetAt ||
            m.createdAt >= this.store.get('conversations', m.conversationId)!.contextResetAt!),
      );
    return (
      `${brief ? `Initial human brief in this space: ${brief.content.slice(0, 4000)}\n\n` : ''}` +
      messages
        .map(
          (m) =>
            `${this.store.get('bots', m.botId)?.name ?? m.botId} / ${m.senderBotId ? 'handoff' : m.role}: ${m.content.slice(0, 1000)}`,
        )
        .join('\n\n')
        .slice(-14000)
    );
  }
  migrate() {
    const old = this.store.all('conversations').filter((c) => !c.spaceId);
    if (old.length) {
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        const now = new Date().toISOString();
        const legacy: TeamConversation = {
          id: 'legacy-team-conversation',
          title: 'Earlier conversations',
          createdAt: old[0].createdAt,
          updatedAt: now,
          legacy: true,
        };
        this.store.put('teamConversations', legacy);
        const aliases = new Map<string, string>(),
          channels = new Map<string, Conversation>();
        for (const conversation of old) {
          const canonical =
            channels.get(conversation.botId) ??
            this.store
              .all('conversations')
              .find((c) => c.spaceId === legacy.id && c.botId === conversation.botId) ??
            conversation;
          channels.set(conversation.botId, canonical);
          aliases.set(conversation.id, canonical.id);
        }
        const rewrite = (value: any): any =>
          Array.isArray(value)
            ? value.map(rewrite)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                  Object.entries(value).map(([key, item]) => [
                    key,
                    ['conversationId', 'senderConversationId'].includes(key) &&
                    typeof item === 'string'
                      ? (aliases.get(item) ?? item)
                      : rewrite(item),
                  ]),
                )
              : value;
        for (const row of this.store.db
          .prepare("SELECT collection,id,data FROM documents WHERE collection != 'conversations'")
          .all()) {
          const before = String(row.data),
            after = JSON.stringify(rewrite(JSON.parse(before)));
          if (before !== after)
            this.store.db
              .prepare('UPDATE documents SET data=? WHERE collection=? AND id=?')
              .run(after, String(row.collection), String(row.id));
        }
        for (const c of old) this.store.remove('conversations', c.id);
        for (const c of channels.values())
          this.store.put('conversations', { ...c, spaceId: legacy.id });
        this.store.setConfig('legacy-conversation-aliases', Object.fromEntries(aliases));
        this.store.db.exec('COMMIT');
      } catch (e) {
        this.store.db.exec('ROLLBACK');
        throw e;
      }
    }
    if (!this.list().some((space) => !space.legacy)) this.create();
  }
}
