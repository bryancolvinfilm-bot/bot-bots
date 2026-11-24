import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../apps/server/store';
import { seedTestTeam as seed } from './fixtures/team';
import { TeamConversations } from '../apps/server/team-conversations';
import { createApp } from '../apps/server/app';
import { Mailbox } from '../apps/server/mailbox';

function fixture() {
  mkdirSync('test-results/unit', { recursive: true });
  const dir = mkdtempSync(resolve('test-results/unit/team-space-'));
  const store = new Store(join(dir, 'team.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  return { dir, store, spaces: new TeamConversations(store) };
}
test('a team conversation has one stable channel per bot, independent of bot switching and other spaces', () => {
  const f = fixture();
  try {
    const a = f.spaces.create('Alpha'),
      b = f.spaces.create('Beta');
    const one = f.spaces.channel(a.id, 'worker1'),
      two = f.spaces.channel(a.id, 'worker2');
    assert.equal(f.spaces.channel(a.id, 'worker1').id, one.id);
    assert.notEqual(two.id, one.id);
    assert.notEqual(f.spaces.channel(b.id, 'worker1').id, one.id);
    assert.equal(f.store.all('conversations').filter((c) => c.spaceId === a.id).length, 2);
  } finally {
    f.store.close();
  }
});
test('legacy migration preserves messages, result IDs and handoffs while merging old per-bot lists into one legacy team space', () => {
  const f = fixture();
  try {
    const now = new Date().toISOString();
    for (const id of ['old-a', 'old-b'])
      f.store.put('conversations', { id, botId: 'worker1', title: id, createdAt: now });
    f.store.put('messages', {
      id: 'kept-message',
      botId: 'worker1',
      conversationId: 'old-b',
      role: 'assistant',
      content: 'Saved answer',
      createdAt: now,
    });
    f.store.put('deliveries', {
      id: 'receipt',
      key: 'receipt',
      runId: 'run',
      fromBotId: 'worker1',
      toBotId: 'worker2',
      senderConversationId: 'old-b',
      conversationId: 'old-a',
      brief: 'Kept handoff',
      source: 'human',
      status: 'completed',
      receivedAt: now,
    });
    f.spaces.migrate();
    const legacy = f.spaces.list().find((s) => s.legacy)!;
    const channel = f.spaces.channel(legacy.id, 'worker1');
    assert.equal(f.store.all('messages')[0].id, 'kept-message');
    assert.equal(f.store.all('messages')[0].conversationId, channel.id);
    assert.equal(f.store.get('deliveries', 'receipt')!.senderConversationId, channel.id);
    assert.equal(f.store.all('conversations').filter((c) => c.botId === 'worker1').length, 1);
    assert.ok(f.spaces.list().some((s) => !s.legacy));
    const before = f.store.export();
    f.spaces.migrate();
    assert.deepEqual(f.store.export().teamConversations, before.teamConversations);
  } finally {
    f.store.close();
  }
});
test('every handoff reuses the recipient channel in its sender’s team space', () => {
  const f = fixture();
  try {
    const a = f.spaces.create('Alpha'),
      b = f.spaces.create('Beta');
    const sender = f.spaces.channel(a.id, 'worker1'),
      recipient = f.spaces.channel(a.id, 'worker2');
    const box = new Mailbox(f.store);
    const deliver = (key: string, senderConversationId: string) =>
      box.accept({
        key,
        runId: key,
        fromBotId: 'worker1',
        toBotId: 'worker2',
        senderConversationId,
        brief: 'Compare this',
        source: 'human',
      });
    assert.equal(deliver('first', sender.id).conversationId, recipient.id);
    assert.equal(deliver('second', sender.id).conversationId, recipient.id);
    assert.notEqual(
      deliver('third', f.spaces.channel(b.id, 'worker1').id).conversationId,
      recipient.id,
    );
    assert.match(box.context('worker2', recipient.id), new RegExp(box.id('first')));
    assert.doesNotMatch(box.context('worker2', recipient.id), new RegExp(box.id('third')));
  } finally {
    f.store.close();
  }
});
test('team context follows the selected space and honors refreshed channel context boundaries', () => {
  const f = fixture();
  try {
    const a = f.spaces.create('Alpha'),
      b = f.spaces.create('Beta');
    const own = f.spaces.channel(a.id, 'worker1'),
      other = f.spaces.channel(a.id, 'worker2'),
      unrelated = f.spaces.channel(b.id, 'worker2');
    for (const [id, conversationId, content, createdAt] of [
      ['one', other.id, 'RELEVANT_TEAM_FACT', '2026-01-01T00:00:00.000Z'],
      ['two', unrelated.id, 'OTHER_SPACE_SECRET', '2026-01-01T00:00:00.000Z'],
    ])
      f.store.put('messages', {
        id,
        botId: 'worker2',
        conversationId,
        role: 'assistant',
        content,
        createdAt,
      });
    assert.match(f.spaces.context(own.id, 'worker1', 'new-run'), /RELEVANT_TEAM_FACT/);
    assert.doesNotMatch(f.spaces.context(own.id, 'worker1', 'new-run'), /OTHER_SPACE_SECRET/);
    f.store.put('conversations', { ...other, contextResetAt: '2026-02-01T00:00:00.000Z' });
    assert.doesNotMatch(f.spaces.context(own.id, 'worker1', 'new-run'), /RELEVANT_TEAM_FACT/);
  } finally {
    f.store.close();
  }
});
test('bot inference receives the same-space team context and backups preserve the space/channel mapping', async () => {
  const f = fixture();
  const bodies: any[] = [];
  const model = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    bodies.push(JSON.parse(text));
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: 'Acknowledged the selected team space.' }, finish_reason: 'stop' },
        ],
      }),
    );
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  for (const p of f.store.all('providers'))
    f.store.put('providers', {
      ...p,
      baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      autoDiscover: false,
    });
  const host = createApp(f.store, f.dir, resolve('dist/web'));
  const server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  try {
    const a = f.spaces.create('Shared job'),
      b = f.spaces.create('Separate job');
    const channel = f.spaces.channel(a.id, 'worker1'),
      other = f.spaces.channel(a.id, 'worker2');
    f.store.put('messages', {
      id: 'team-fact',
      botId: 'worker2',
      conversationId: other.id,
      role: 'assistant',
      content: 'TEAM_FACT_42',
      createdAt: new Date().toISOString(),
    });
    f.store.put('messages', {
      id: 'other-fact',
      botId: 'worker2',
      conversationId: f.spaces.channel(b.id, 'worker2').id,
      role: 'assistant',
      content: 'UNRELATED_FACT_99',
      createdAt: new Date().toISOString(),
    });
    const run = host.runtime.create('worker1', 'What is the current context?', channel.id);
    for (let i = 0; i < 500 && host.runtime.controllers.size; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.store.get('runs', run.id)!.status, 'completed');
    assert.match(JSON.stringify(bodies), /TEAM_FACT_42/);
    assert.doesNotMatch(JSON.stringify(bodies), /UNRELATED_FACT_99/);
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/import`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(f.store.export()),
      },
    );
    assert.equal(response.status, 200, await response.text());
    assert.equal(f.spaces.channel(a.id, 'worker1').id, channel.id);
  } finally {
    host.runtime.events.emit('shutdown');
    host.computer.dispose();
    await host.terminal.dispose();
    model.closeAllConnections();
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => model.close(() => r())),
      new Promise<void>((r) => server.close(() => r())),
    ]);
    f.store.close();
  }
});
