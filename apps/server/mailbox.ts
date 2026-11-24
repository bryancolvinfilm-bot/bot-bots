import { createHash, randomUUID } from 'node:crypto';
import type { BotDelivery } from '../../packages/shared/delivery';
import { Store } from './store';
import { TeamConversations } from './team-conversations';

export class Mailbox {
  constructor(private store: Store) {
    for (const d of store.all('deliveries'))
      if (['received', 'working'].includes(d.status))
        this.finish(
          d.id,
          'failed',
          undefined,
          'Host restarted during this handoff. The request is retained; no action was replayed.',
        );
    // Only real historical handoff events count. A plain mention or a model's claim never creates a receipt.
    for (const run of store.all('runs')) {
      const last = new Map(run.events.filter((e) => e.handoff).map((e) => [e.handoff!.id, e]));
      for (const [id, event] of last) {
        if (store.get('deliveries', id)) continue;
        const h = event.handoff!,
          first = run.events.find((e) => e.handoffId === id || e.handoff?.id === id) ?? event;
        const work = run.work?.find((w) => w.handoffId === id);
        const message = store.all('messages').find((m) => m.workId === work?.id && !!work);
        const d = this.accept({
          key: `legacy:${run.id}:${id}`,
          id,
          runId: run.id,
          parentId: h.parentId,
          fromBotId: h.fromBotId,
          toBotId: h.toBotId,
          senderConversationId: run.conversationId,
          brief: h.brief,
          source: 'legacy',
          receivedAt: first.at,
          conversationId: message?.conversationId,
        });
        this.finish(
          d.id,
          h.status === 'working' ? 'failed' : h.status,
          h.answer,
          h.error ??
            (h.status === 'working'
              ? 'Historical handoff ended without a recorded answer.'
              : undefined),
        );
      }
    }
  }
  id(key: string) {
    return createHash('sha256').update(key).digest('hex').slice(0, 32);
  }
  get(id: string) {
    return this.store.get('deliveries', id);
  }
  byKey(key: string) {
    return this.get(this.id(key));
  }
  inbox(botId: string) {
    return this.store
      .all('deliveries')
      .filter(
        (d) => d.toBotId === botId || this.store.get('bots', d.toBotId)?.prototypeId === botId,
      )
      .reverse();
  }
  accept(
    input: Omit<BotDelivery, 'id' | 'status' | 'receivedAt' | 'conversationId'> & {
      id?: string;
      receivedAt?: string;
      conversationId?: string;
    },
  ) {
    const id = input.id ?? this.id(input.key),
      existing = this.get(id);
    if (existing) {
      if (
        existing.toBotId !== input.toBotId ||
        existing.fromBotId !== input.fromBotId ||
        existing.brief !== input.brief
      )
        throw Error('A delivery ID cannot be reused for a different request.');
      return existing;
    }
    const receivedAt = input.receivedAt ?? new Date().toISOString();
    const spaces = new TeamConversations(this.store);
    const sender = this.store.get('conversations', input.senderConversationId);
    const spaceId = sender && spaces.adopt(sender).spaceId;
    const d: BotDelivery = {
      ...input,
      id,
      receivedAt,
      conversationId:
        input.conversationId ??
        (spaceId ? spaces.channel(spaceId, input.toBotId).id : randomUUID()),
      status: 'received',
    };
    const from = this.store.get('bots', d.fromBotId)?.name ?? d.fromBotId;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.store.get('conversations', d.conversationId))
        this.store.put('conversations', {
          id: d.conversationId,
          botId: d.toBotId,
          title: `From ${from}: ${d.brief.slice(0, 42)}`,
          createdAt: receivedAt,
        });
      this.store.put('deliveries', d);
      this.store.put('messages', {
        id: `delivery-${id}`,
        botId: d.toBotId,
        conversationId: d.conversationId,
        role: 'user',
        content: `Handoff from ${from}: ${d.brief}`,
        createdAt: receivedAt,
        runId: d.runId,
        deliveryId: id,
        senderBotId: d.fromBotId,
      });
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    return d;
  }
  start(id: string) {
    const d = this.get(id)!;
    return this.store.put('deliveries', {
      ...d,
      status: 'working',
      startedAt: new Date().toISOString(),
    });
  }
  finish(
    id: string,
    status: 'completed' | 'failed' | 'cancelled',
    answer?: string,
    error?: string,
  ) {
    const d = this.get(id)!;
    return this.store.put('deliveries', {
      ...d,
      status,
      answer,
      error,
      finishedAt: new Date().toISOString(),
    });
  }
  context(botId: string, conversationId?: string) {
    const ids = conversationId ? new TeamConversations(this.store).ids(conversationId) : undefined;
    return this.inbox(botId)
      .filter((d) => !ids || ids.has(d.conversationId))
      .slice(0, 12)
      .map((d) => ({
        receiptId: d.id,
        from: this.store.get('bots', d.fromBotId)?.name ?? d.fromBotId,
        receivedAt: d.receivedAt,
        status: d.status,
        request: d.brief.slice(0, 650),
        error: d.error,
      }))
      .map((d) => JSON.stringify(d))
      .join('\n');
  }
  confirmation(botId: string, fromId: string, conversationId?: string) {
    const ids = conversationId ? new TeamConversations(this.store).ids(conversationId) : undefined;
    const from = this.store.get('bots', fromId)?.name ?? fromId,
      d = this.inbox(botId).find(
        (d) => d.fromBotId === fromId && (!ids || ids.has(d.conversationId)),
      );
    return d
      ? `Yes. I received a recorded request from ${from}.\n\nReceipt: ${d.id}\nReceived: ${d.receivedAt}\nStatus: ${d.status}\n\nRequest: ${d.brief.slice(0, 1800)}${d.error ? `\n\nNeeds attention: ${d.error}` : ''}\n\nReceived confirms delivery; completed means a reply was returned, not independent verification of every requested action.`
      : `There is no recorded delivery from ${from} in my inbox. An @mention or a drafted message is not proof of a handoff.`;
  }
}
