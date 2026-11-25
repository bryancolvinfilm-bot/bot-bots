import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ContextManager,
  contextTokens,
  monitoredContextWindow,
} from '../apps/server/context-manager';
import { Store } from '../apps/server/store';
import { seedStarterTeam } from '../apps/server/starter-team';
import type { Model, Provider, Run, WorkRecord } from '../packages/shared/types';
import type { WireMessage } from '../apps/server/models';

const local: Provider = {
  id: 'local',
  name: 'Loaded server',
  kind: 'openai-compatible',
  local: true,
  enabled: true,
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKeyEnv: '',
  timeoutMs: 10000,
};
const model: Model = {
  id: 'loaded',
  providerId: local.id,
  name: 'loaded-model',
  enabled: true,
  priority: 1,
  costPerMillion: 0,
  tasks: ['general'],
  status: 'online',
  contextSource: 'server',
  contextTokens: 131072,
  loadedContextTokens: 16384,
  maxContextTokens: 131072,
  loadState: 'loaded',
};
function fixture() {
  const store = new Store(':memory:');
  seedStarterTeam(store);
  store.put('conversations', {
    id: 'channel',
    botId: 'boss-man',
    title: 'Context test',
    createdAt: new Date().toISOString(),
  });
  const manager = new ContextManager(store);
  const run = { id: 'run', botId: 'boss-man', conversationId: 'channel' } as Run;
  const work = { id: 'work', botId: 'boss-man', status: 'running' } as WorkRecord;
  return { store, manager, run, work };
}
const round = (id: string, failed = false): WireMessage[] => [
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name: failed ? 'terminal_request' : 'web_search', arguments: '{}' },
      },
    ],
  },
  {
    role: 'tool',
    tool_call_id: id,
    content: JSON.stringify({
      ...(failed
        ? { error: 'Denied by the human. Do not retry.', status: 'denied' }
        : { url: `https://example.test/${id}`, fact: 'IMPORTANT_SOURCE_FACT' }),
      detail: 'archived research text '.repeat(1500),
    }),
  },
];

test('automatic context compaction preserves the current request, steering, source archive and failure ledger', async () => {
  const f = fixture();
  try {
    const system: WireMessage = {
      role: 'system',
      content: 'Current trusted runtime instructions.',
    };
    const prompt = f.manager.human({
      role: 'user',
      content: 'Research tacos. Keep the dietary constraint exactly.',
    });
    const steering = f.manager.human({
      role: 'user',
      content: 'Newest human direction: vegetarian only.',
    });
    const messages = [
      system,
      prompt,
      ...round('source-a'),
      ...round('denied-command', true),
      steering,
      ...round('source-b'),
    ];
    const before = contextTokens(messages);
    let calls = 0;
    const changed = await f.manager.prepare({
      ...f,
      conversationId: 'channel',
      messages,
      tools: [],
      model,
      provider: local,
      maxOutputTokens: 512,
      signal: new AbortController().signal,
      summarize: async (input, max) => {
        calls++;
        assert.ok(max < 2048);
        assert.match(input[0].content!, /untrusted data/);
        return 'IMPORTANT_SOURCE_FACT from https://example.test/source-a. The human denied the command. The remaining task is vegetarian taco research.';
      },
      changed: () => {},
    });
    assert.equal(changed, true);
    assert.ok(calls > 0);
    assert.ok(contextTokens(messages) < before / 2);
    assert.ok(messages.includes(system));
    assert.ok(messages.includes(prompt));
    assert.ok(messages.includes(steering));
    assert.equal(f.work.context?.compactions, 1);
    assert.equal(f.work.context?.windowTokens, 16384);
    const checkpoint = f.store.all('contextCheckpoints')[0];
    assert.match(checkpoint.ledger, /denied-command/);
    assert.match(checkpoint.ledger, /Denied by the human/);
    assert.match(JSON.stringify(f.manager.read(checkpoint.id, 'boss-man', 'channel')), /source-a/);
    assert.throws(() => f.manager.read(checkpoint.id, 'another-bot', 'channel'), /not found/);
    assert.equal(f.store.export().contextCheckpoints.length, 1);
    for (const message of messages)
      for (const call of message.tool_calls ?? [])
        assert.ok(messages.some((m) => m.tool_call_id === call.id));
  } finally {
    f.store.close();
  }
});

test('compacted history is reusable without deleting visible messages, and survives a new context manager', async () => {
  const f = fixture();
  try {
    const history = [1, 2, 3, 4].map((i) =>
      f.store.put('messages', {
        id: `history-${i}`,
        botId: 'boss-man',
        conversationId: 'channel',
        role: i % 2 ? ('user' as const) : ('assistant' as const),
        content: `Fact ${i}: ` + 'historical detail '.repeat(1800),
        createdAt: new Date().toISOString(),
      }),
    );
    const messages = [
      { role: 'system', content: 'Trusted instructions.' },
      ...history.map((m) => f.manager.history({ role: m.role, content: m.content }, m.id)),
      f.manager.human({ role: 'user', content: 'Continue the same project.' }),
    ];
    await f.manager.prepare({
      ...f,
      conversationId: 'channel',
      messages,
      tools: [],
      model,
      provider: local,
      maxOutputTokens: 512,
      signal: new AbortController().signal,
      summarize: async () => 'The historical facts and original constraints remain in effect.',
      changed: () => {},
    });
    assert.equal(f.store.all('messages').length, 4);
    assert.ok(f.store.get('conversations', 'channel')?.contextCheckpointId);
    const restored = new ContextManager(f.store).restore('channel');
    assert.equal(restored.length, 1);
    assert.match(restored[0].content!, /historical facts/);
  } finally {
    f.store.close();
  }
});

test('online automatic context is monitored only when known, without treating the old placeholder as a cap', async () => {
  const f = fixture();
  try {
    const online = { ...local, local: false };
    const unknown = {
      ...model,
      contextTokens: 32768,
      loadedContextTokens: undefined,
      maxContextTokens: undefined,
    };
    assert.equal(monitoredContextWindow(unknown, online), undefined);
    assert.equal(monitoredContextWindow({ ...unknown, contextSource: 'manual' }, online), 32768);
    assert.equal(
      monitoredContextWindow({ ...unknown, maxContextTokens: 1000000 }, online),
      1000000,
    );
    let summaries = 0;
    const messages = [
      { role: 'system', content: 'Trusted.' },
      f.manager.human({ role: 'user', content: 'Current goal.' }),
      ...round('large-source'),
    ];
    const options = {
      ...f,
      conversationId: 'channel',
      messages,
      tools: [],
      model: unknown,
      provider: online,
      maxOutputTokens: 512,
      signal: new AbortController().signal,
      summarize: async () => {
        summaries++;
        return 'Source facts saved.';
      },
      changed: () => {},
    };
    assert.equal(await f.manager.prepare(options), false);
    assert.equal(summaries, 0);
    assert.equal(await f.manager.prepare({ ...options, force: true, reportedWindow: 8192 }), true);
    assert.equal(f.work.context?.windowTokens, 8192);
    assert.ok(summaries > 0);
  } finally {
    f.store.close();
  }
});

test('cancelled compaction never replaces the working messages or records a misleading completed checkpoint', async () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    const messages = [
      f.manager.human({ role: 'user', content: 'Current request.' }),
      ...round('source'),
    ];
    const original = [...messages];
    await assert.rejects(
      f.manager.prepare({
        ...f,
        conversationId: 'channel',
        messages,
        tools: [],
        model,
        provider: local,
        maxOutputTokens: 512,
        force: true,
        signal: controller.signal,
        summarize: async () => {
          controller.abort();
          return 'Do not save this interrupted summary.';
        },
        changed: () => {},
      }),
    );
    assert.deepEqual(messages, original);
    assert.equal(f.store.all('contextCheckpoints').length, 0);
  } finally {
    f.store.close();
  }
});
