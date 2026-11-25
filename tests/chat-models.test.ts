import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Store } from '../apps/server/store';
import { seedStarterTeam } from '../apps/server/starter-team';
import { createApp } from '../apps/server/app';
import { selectConversationModel } from '../apps/server/bot-models';
import { complete, portableMessages, type WireMessage } from '../apps/server/models';
import { runningChatModels } from '../packages/shared/chat-models';
import type { Model, Provider } from '../packages/shared/types';

const provider: Provider = {
  id: 'online',
  name: 'Online',
  kind: 'openai-compatible',
  baseUrl: 'http://127.0.0.1',
  apiKeyEnv: '',
  enabled: true,
  local: false,
  timeoutMs: 10000,
  autoDiscover: false,
};
const model: Model = {
  id: 'online-model',
  providerId: provider.id,
  name: 'gpt-5.1',
  enabled: true,
  priority: 1,
  costPerMillion: 0,
  contextTokens: 32768,
  status: 'online',
  tasks: ['general'],
  supportsTools: true,
};
const reply = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { total_tokens: 5 },
});
const call = (name: string, input: object) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `${name}-call`,
            type: 'function',
            function: { name, arguments: JSON.stringify(input) },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { total_tokens: 5 },
});
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Chat model test timed out.');
}
async function fixture(handler: (body: any, res: ServerResponse) => void, local = false) {
  mkdirSync('test-results/unit', { recursive: true });
  const dir = mkdtempSync(resolve('test-results/unit/chat-models-'));
  const store = new Store(join(dir, 'team.sqlite'));
  seedStarterTeam(store);
  const bodies: any[] = [];
  const llm = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    bodies.push(body);
    res.setHeader('Content-Type', 'application/json');
    handler(body, res);
  });
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
  const p = {
    ...provider,
    local,
    baseUrl: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`,
  };
  store.put('providers', p);
  store.put('models', {
    ...model,
    ...(local
      ? { loadedContextTokens: 16384, contextTokens: 131072, loadState: 'loaded' as const }
      : {}),
  });
  store.put('bots', { ...store.get('bots', 'boss-man')!, modelId: model.id, providerId: p.id });
  store.setConfig('settings', {
    ...store.settings(),
    mainBotId: null,
    localOnly: false,
    maxOutputTokens: 512,
  });
  store.put('conversations', {
    id: 'channel',
    botId: 'boss-man',
    title: 'Test',
    createdAt: new Date().toISOString(),
  });
  const host = createApp(store, dir, resolve('dist/web'));
  writeFileSync(
    join(dir, 'workspace/research.txt'),
    'IMPORTANT_SOURCE_FACT https://example.test/source\n' +
      'Observed research details. '.repeat(3000),
  );
  const server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function request(path: string, body: unknown) {
    return fetch(base + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return {
    dir,
    store,
    host,
    bodies,
    request,
    async run(prompt: string) {
      const run = host.runtime.create('boss-man', prompt, 'channel', { panelAccess: true });
      await until(() => store.get('runs', run.id)?.status !== 'running');
      return store.get('runs', run.id)!;
    },
    async close() {
      for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
      await until(() => host.runtime.controllers.size === 0);
      host.runtime.events.emit('shutdown');
      host.computer.dispose();
      host.google.cancelRun();
      await host.terminal.dispose();
      server.closeAllConnections();
      llm.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => server.close(() => r())),
        new Promise<void>((r) => llm.close(() => r())),
      ]);
      store.close();
    },
  };
}

test('chat choices list connected online models first and only loaded local chat models', () => {
  const local = { ...provider, id: 'local', local: true };
  const options = runningChatModels(
    [
      { ...model, id: 'loaded', providerId: local.id, loadState: 'loaded' },
      { ...model, id: 'unloaded', providerId: local.id, loadState: 'unloaded' },
      { ...model, id: 'unknown-local', providerId: local.id, loadState: 'unknown' },
      {
        ...model,
        id: 'embedding',
        providerId: local.id,
        loadState: 'loaded',
        modelType: 'embedding',
      },
      { ...model, id: 'offline', status: 'offline' },
      { ...model, enabled: false },
    ],
    [provider, local],
  );
  assert.deepEqual(
    options.map((m) => m.id),
    ['online-model', 'loaded'],
  );
});

test('model swaps keep visible context and tool receipts while provider-specific opaque state stays scoped', () => {
  const responseProvider = { ...provider, kind: 'openai-responses' as const };
  const source: WireMessage = {
    role: 'assistant',
    content: 'The verified result.',
    tool_calls: [
      { id: 'receipt', type: 'function', function: { name: 'workspace_write', arguments: '{}' } },
    ],
    rawOutput: [{ type: 'reasoning', encrypted_content: 'opaque-provider-state' }],
    rawOutputProviderId: provider.id,
    rawOutputModelId: model.id,
  };
  assert.ok(portableMessages([source], responseProvider, model)[0].rawOutput);
  const changedModel = portableMessages([source], responseProvider, {
    ...model,
    id: 'another-model',
  })[0];
  assert.equal(changedModel.rawOutput, undefined);
  assert.equal(changedModel.content, source.content);
  assert.deepEqual(changedModel.tool_calls, source.tool_calls);
  const local = portableMessages([source], { ...provider, local: true }, model)[0];
  assert.equal(local.rawOutput, undefined);
  assert.equal('rawOutputProviderId' in local, false);
  assert.ok(source.rawOutput, 'Transport normalization must not erase archived provider state.');
});

test('chat model and effort preferences belong to the conversation and do not rewrite bot defaults', async () => {
  const f = await fixture((_body, res) => res.end(JSON.stringify(reply('Hi.'))));
  try {
    const original = f.store.get('bots', 'boss-man')!;
    f.store.put('providers', { ...provider, id: 'local', local: true });
    f.store.put('models', {
      ...model,
      id: 'local-model',
      providerId: 'local',
      loadState: 'loaded',
    });
    const response = await f.request('/conversations/channel/model', {
      modelId: 'local-model',
      reasoningEffort: 'high',
    });
    assert.equal(response.status, 200);
    assert.equal(f.store.get('conversations', 'channel')?.modelId, 'local-model');
    assert.equal(f.store.get('conversations', 'channel')?.reasoningEffort, 'high');
    assert.deepEqual(f.store.get('bots', 'boss-man'), original);
    f.store.put('models', { ...f.store.get('models', 'local-model')!, loadState: 'unloaded' });
    assert.throws(
      () => selectConversationModel(f.store, 'channel', { modelId: 'local-model' }, true),
      /not currently running/,
    );
    assert.equal(
      f.store.export().conversations.find((c) => c.id === 'channel')?.modelId,
      'local-model',
    );
  } finally {
    await f.close();
  }
});

test('online inference has no app context cap by default but an explicit manual cap is enforced', async () => {
  let requests = 0;
  const f = await fixture((_body, res) => {
    requests++;
    res.end(JSON.stringify(reply('Accepted.')));
  });
  try {
    const p = f.store.get('providers', provider.id)!;
    const messages = [
      { role: 'system', content: 'Useful instructions.' },
      { role: 'user', content: 'x'.repeat(120000) },
    ];
    await complete(p, model, messages, [], 512, new AbortController().signal);
    assert.equal(requests, 1);
    await assert.rejects(
      complete(
        p,
        { ...model, contextSource: 'manual' },
        messages,
        [],
        512,
        new AbortController().signal,
      ),
      /context window/,
    );
    assert.equal(requests, 1);
  } finally {
    await f.close();
  }
});

test('operator chat choices cannot enable a disabled model or change the owner’s local-only policy', async () => {
  const f = await fixture((_body, res) => res.end(JSON.stringify(reply('Ready.'))));
  try {
    f.store.setConfig('settings', { ...f.store.settings(), localOnly: true });
    assert.throws(
      () => selectConversationModel(f.store, 'channel', { modelId: model.id }, false),
      /owner must enable/,
    );
    assert.equal(f.store.settings().localOnly, true);
    f.store.setConfig('settings', { ...f.store.settings(), localOnly: false });
    f.store.put('models', { ...model, enabled: false });
    assert.throws(
      () => selectConversationModel(f.store, 'channel', { modelId: model.id }, false),
      /owner must enable/,
    );
    f.store.put('models', model);
    selectConversationModel(
      f.store,
      'channel',
      { modelId: model.id, reasoningEffort: 'medium' },
      false,
    );
    assert.equal(f.store.get('conversations', 'channel')?.reasoningEffort, 'medium');
  } finally {
    await f.close();
  }
});

for (const local of [true, false])
  test(`${local ? 'local near-limit' : 'provider-reported overflow'} compaction resumes a task without replaying completed writes`, async () => {
    let step = 0,
      summaries = 0,
      writes = 0,
      refused = false;
    const f = await fixture((body, res) => {
      if (body.messages[0].content.includes('Summarize these background task records')) {
        summaries++;
        res.end(
          JSON.stringify(
            reply(
              'IMPORTANT_SOURCE_FACT from https://example.test/source. The receipt.txt write returned successfully. Continue with the answer; do not write it again.',
            ),
          ),
        );
        return;
      }
      step++;
      if (step === 1) {
        writes++;
        res.end(
          JSON.stringify(call('workspace_write', { path: 'receipt.txt', content: 'WRITTEN_ONCE' })),
        );
        return;
      }
      if (step === 2) {
        res.end(JSON.stringify(call('workspace_read', { path: 'research.txt' })));
        return;
      }
      if (!local && !refused) {
        refused = true;
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'Maximum context length is 32768 tokens.' } }));
        return;
      }
      assert.ok(body.messages.some((m: any) => m.content?.includes('SAVED WORKING CONTEXT')));
      assert.ok(body.messages.some((m: any) => m.content?.includes('IMPORTANT_SOURCE_FACT')));
      res.end(JSON.stringify(reply('Finished using IMPORTANT_SOURCE_FACT.')));
    }, local);
    try {
      const run = await f.run(
        'Read the saved research source and write the requested receipt once, then give the answer.',
      );
      assert.equal(run.status, 'completed', run.error);
      assert.equal(writes, 1);
      assert.ok(summaries > 0);
      assert.equal(readFileSync(join(f.dir, 'workspace/receipt.txt'), 'utf8'), 'WRITTEN_ONCE');
      assert.ok(run.work?.[0].context?.compactions);
      assert.equal(f.store.get('models', model.id)?.status, 'online');
      assert.equal(f.store.all('messages').filter((m) => m.role === 'user').length, 1);
    } finally {
      await f.close();
    }
  });

test('changing a chat model interrupts old inference and continues with its completed tool results', async () => {
  let step = 0,
    held: ServerResponse | undefined,
    writes = 0;
  const f = await fixture((body, res) => {
    if (body.model === 'gpt-5.1-mini') {
      assert.equal(body.reasoning_effort, 'low');
      assert.ok(
        body.messages.some((m: any) => m.role === 'tool' && m.content?.includes('receipt.txt')),
      );
      res.end(JSON.stringify(reply('MODEL_SWITCHED_WITH_RECEIPT')));
      return;
    }
    if (++step === 1) {
      writes++;
      res.end(JSON.stringify(call('workspace_write', { path: 'receipt.txt', content: 'ONCE' })));
    } else held = res;
  });
  try {
    f.store.put('models', { ...model, id: 'other-model', name: 'gpt-5.1-mini' });
    const original = f.store.get('bots', 'boss-man')!;
    const started = f.host.runtime.create(
      'boss-man',
      'Write the receipt and give your answer.',
      'channel',
    );
    await until(() => !!held);
    const response = await f.request('/conversations/channel/model', {
      modelId: 'other-model',
      reasoningEffort: 'low',
    });
    assert.equal(response.status, 200);
    await until(() => f.store.get('runs', started.id)?.status !== 'running');
    const done = f.store.get('runs', started.id)!;
    assert.equal(done.status, 'completed', done.error);
    assert.equal(done.modelId, 'other-model');
    assert.equal(writes, 1);
    assert.deepEqual(f.store.get('bots', 'boss-man'), original);
    assert.ok(done.work?.[0].attempts.some((a) => a.status === 'switched'));
  } finally {
    held?.end();
    await f.close();
  }
});
