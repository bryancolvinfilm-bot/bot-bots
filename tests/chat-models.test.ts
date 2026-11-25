import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Store } from '../apps/server/store';
import { seedStarterTeam } from '../apps/server/starter-team';
import { createApp } from '../apps/server/app';
import { selectConversationModel, selectTeamModel } from '../apps/server/bot-models';
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
  async function request(path: string, body: unknown, method = 'PUT') {
    return fetch(base + path, {
      method,
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

test('a team model switch applies once across bots and spaces; individual choices remain editable and reset restores profile defaults', async () => {
  const f = await fixture((_body, res) => res.end(JSON.stringify(reply('Ready.'))));
  try {
    const original = f.store.get('bots', 'boss-man')!;
    f.store.put('bots', { ...original, id: 'another-bot', name: 'Another bot' });
    f.store.put('bots', {
      ...original,
      id: 'archived-bot',
      name: 'Archived',
      archivedAt: new Date().toISOString(),
    });
    f.store.put('conversations', {
      ...f.store.get('conversations', 'channel')!,
      id: 'other-channel',
      botId: 'another-bot',
      spaceId: 'another-space',
    });
    f.store.put('models', { ...model, id: 'team-brain', name: 'gpt-5.1-mini', enabled: false });
    const result = await f.request(
      '/models/team-selection',
      { action: 'apply', modelId: 'team-brain', reasoningEffort: 'high' },
      'POST',
    );
    assert.equal(result.status, 200);
    assert.equal(
      f.store.get('bots', 'boss-man')?.modelId,
      original.modelId,
      'Profile suggestions stay saved.',
    );
    assert.equal(f.store.get('bots', 'another-bot')?.chatModelId, 'team-brain');
    assert.equal(f.store.get('conversations', 'other-channel')?.modelId, 'team-brain');
    assert.equal(f.store.get('bots', 'archived-bot')?.chatModelId, undefined);
    await f.request('/conversations/channel/model', { modelId: model.id, reasoningEffort: 'low' });
    assert.equal(f.store.get('conversations', 'channel')?.modelId, model.id);
    assert.equal(f.store.get('conversations', 'other-channel')?.modelId, 'team-brain');
    f.store.put('conversations', {
      ...f.store.get('conversations', 'channel')!,
      id: 'new-channel',
      modelId: undefined,
      reasoningEffort: undefined,
    });
    assert.equal(
      f.store.get('bots', 'boss-man')?.chatModelId,
      'team-brain',
      'Future channels inherit the one-time bot preference.',
    );
    const revision = f.store.config<string>('model-selection-revision');
    const reset = await f.request('/models/team-selection', { action: 'reset' }, 'POST');
    assert.equal(reset.status, 200);
    assert.deepEqual(f.store.get('bots', 'boss-man'), original);
    for (const c of f.store.all('conversations')) assert.equal(c.modelId, undefined);
    assert.notEqual(f.store.config<string>('model-selection-revision'), revision);
    const before = f.store.all('bots');
    assert.throws(
      () => selectTeamModel(f.store, { action: 'apply', modelId: 'missing' }),
      /currently running/,
    );
    assert.deepEqual(f.store.all('bots'), before);
  } finally {
    await f.close();
  }
});

test('live per-work token updates precede completion, preserve provider totals and never replay a completed tool', async () => {
  let step = 0;
  const f = await fixture((_body, res) => {
    if (++step === 1) {
      res.end(
        JSON.stringify({
          ...call('workspace_write', { path: 'counted.txt', content: 'ONCE' }),
          usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 },
        }),
      );
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(
      'data: ' +
        JSON.stringify({ choices: [{ delta: { content: 'Working on it. '.repeat(12) } }] }) +
        '\n\n',
    );
    setTimeout(() => {
      res.end(
        'data: ' +
          JSON.stringify({ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }) +
          '\n\ndata: ' +
          JSON.stringify({
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            choices: [],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    }, 200);
  });
  try {
    const updates: any[] = [];
    f.host.runtime.events.on('usage', (update) => updates.push(structuredClone(update)));
    const run = await f.run('Write counted.txt once and reply.');
    assert.equal(run.status, 'completed', run.error);
    assert.ok(updates.some((update) => update.liveUsage?.output > 0));
    assert.deepEqual(run.work?.[0].usage, { input: 190, output: 30, total: 220, estimated: false });
    assert.equal(run.work?.[0].liveUsage, undefined);
    assert.equal(readFileSync(join(f.dir, 'workspace/counted.txt'), 'utf8'), 'ONCE');
    assert.equal(step, 2);
    assert.ok(
      updates.every((update) => JSON.stringify(update).length < 600),
      'Token events must stay bounded independently of chat size.',
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

for (const action of ['chat', 'team', 'reset'])
  test(`${action} model change interrupts old inference and continues with its completed tool results`, async () => {
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
      if (action === 'reset')
        f.store.put('bots', {
          ...f.store.get('bots', 'boss-man')!,
          modelId: 'other-model',
          reasoningEffort: 'low',
        });
      const original = f.store.get('bots', 'boss-man')!;
      if (action === 'reset') selectTeamModel(f.store, { action: 'apply', modelId: model.id });
      const started = f.host.runtime.create(
        'boss-man',
        'Write the receipt and give your answer.',
        'channel',
      );
      await until(() => !!held);
      const response = await f.request(
        action === 'chat' ? '/conversations/channel/model' : '/models/team-selection',
        {
          ...(action === 'chat' ? {} : { action: action === 'team' ? 'apply' : 'reset' }),
          ...(action === 'reset' ? {} : { modelId: 'other-model', reasoningEffort: 'low' }),
        },
        action === 'chat' ? 'PUT' : 'POST',
      );
      assert.equal(response.status, 200);
      await until(() => f.store.get('runs', started.id)?.status !== 'running');
      const done = f.store.get('runs', started.id)!;
      assert.equal(done.status, 'completed', done.error);
      assert.equal(done.modelId, 'other-model');
      assert.equal(writes, 1);
      if (action !== 'team') assert.deepEqual(f.store.get('bots', 'boss-man'), original);
      else assert.equal(f.store.get('bots', 'boss-man')?.modelId, original.modelId);
      assert.ok(done.work?.[0].attempts.some((a) => a.status === 'switched'));
    } finally {
      held?.end();
      await f.close();
    }
  });
