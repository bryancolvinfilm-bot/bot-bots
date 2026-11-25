import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { seedTestTeam as seed } from './fixtures/team';
import {
  candidates,
  complete,
  discover,
  fitContext,
  normalizeBaseUrl,
} from '../apps/server/models';
import { nextRun } from '../apps/server/scheduler';
import { Store } from '../apps/server/store';
import { acquireHostLock } from '../apps/server/host-lock';
import type { Run } from '../packages/shared/types';
import { collaborationHandoffs } from '../packages/shared/collaboration';
mkdirSync('test-results/unit', { recursive: true });
test('one active host owns a team and releasing the lock allows a new host', () => {
  const dir = mkdtempSync(resolve('test-results/unit/host-'));
  const unlock = acquireHostLock(dir);
  assert.throws(() => acquireHostLock(dir), /active host/);
  unlock();
  const next = acquireHostLock(dir);
  next();
});
function fixture() {
  const dir = mkdtempSync(resolve('test-results/unit/case-'));
  const store = new Store(join(dir, 'test.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  for (const provider of store.all('providers'))
    store.put('providers', { ...provider, autoDiscover: false, autoEnableModels: false });
  return { store, dir };
}
test('team activity streams real run transitions and shuts down cleanly', async () => {
  const { store, dir } = fixture();
  store.put('providers', {
    ...store.all('providers')[0],
    baseUrl: 'http://127.0.0.1:1/v1',
    timeoutMs: 1000,
  });
  const { app, runtime } = createApp(store, dir, resolve('dist/web'), 'activity-test-token');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/activity/events`;
  const controller = new AbortController();
  try {
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, {
      headers: { Authorization: 'Bearer activity-test-token' },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    let buffer = '';
    const decoder = new TextDecoder();
    async function next() {
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw Error('Stream ended early');
        buffer += decoder.decode(chunk.value);
      }
      const end = buffer.indexOf('\n\n');
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return JSON.parse(frame.slice(6));
    }
    assert.deepEqual(await next(), { type: 'snapshot', runs: [] });
    const created = runtime.create('worker1', 'Check the outage');
    const finished = done(runtime, created);
    const update = await next();
    assert.equal(update.type, 'run');
    assert.equal(update.run.id, created.id);
    assert.equal(update.run.status, 'running');
    assert.equal((await finished).status, 'failed');
    let final = update;
    while (final.type !== 'run' || final.run.status === 'running') final = await next();
    assert.equal(final.run.status, 'failed');
    runtime.events.emit('shutdown');
    await reader.cancel();
  } finally {
    controller.abort();
    runtime.events.emit('shutdown');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
async function mock(response: (body: any) => unknown) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.url?.endsWith('/models')
          ? { data: [{ id: 'test-model' }] }
          : response(body ? JSON.parse(body) : {}),
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
async function done(runtime: ReturnType<typeof createApp>['runtime'], run: Run) {
  return new Promise<Run>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('test timeout')), 10000);
    runtime.events.on(run.id, (e) => {
      if (e.type === 'done') {
        clearTimeout(t);
        resolve(e.run);
      }
    });
  });
}
test('real nested runtime handoffs persist full collaboration data and serve it with conversation history', async () => {
  let calls = 0;
  const brief = 'Full task detail. '.repeat(30);
  const call = (name: string, args: unknown) => ({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: `call-${calls}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  const model = await mock(() => {
    calls++;
    if (calls === 1) return call('delegate', { botId: 'worker1', task: brief });
    if (calls === 2) return call('delegate', { botId: 'worker2', task: 'Check the second angle' });
    return {
      choices: [
        {
          message: {
            content:
              calls === 3
                ? 'Worker2 actual result'
                : calls === 4
                  ? 'Worker1 actual result'
                  : 'Coordinator final result',
          },
          finish_reason: 'stop',
        },
      ],
    };
  });
  const { store, dir } = fixture();
  let server: ReturnType<ReturnType<typeof createApp>['app']['listen']> | undefined;
  try {
    store.put('providers', { ...store.all('providers')[0], baseUrl: model.url });
    const { app, runtime } = createApp(store, dir, resolve('dist/web'));
    const completed = await done(runtime, runtime.create('boss-man', 'Coordinate this task'));
    assert.equal(completed.status, 'completed');
    const nodes = collaborationHandoffs(completed);
    assert.equal(completed.work?.length, 3);
    assert.equal(completed.work?.find((w) => w.botId === 'worker2')?.attempts[0].calls, 1);
    assert.equal(completed.work?.find((w) => w.botId === 'worker1')?.attempts[0].calls, 2);
    assert.ok(completed.work?.every((w) => w.urgency === 'relaxed'));
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].brief, brief);
    assert.equal(nodes[1].parentId, nodes[0].id);
    assert.equal(nodes[1].answer, 'Worker2 actual result');
    assert.ok(
      nodes[1].events.some((event) => event.botId === 'worker2' && event.handoffId === nodes[1].id),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const history = (await fetch(`${url}/api/conversations/${completed.conversationId}/runs`).then(
      (response) => response.json(),
    )) as Run[];
    assert.equal(collaborationHandoffs(history[0])[0].brief, brief);
    const child = completed.work!.find((w) => w.botId === 'worker2')!;
    const childMessage = store.all('messages').find((m) => m.workId === child.id)!;
    assert.ok(childMessage);
    const childHistory = (await fetch(
      `${url}/api/conversations/${childMessage.conversationId}/runs`,
    ).then((r) => r.json())) as Run[];
    assert.equal(childHistory[0].id, completed.id);
    const rated = await fetch(`${url}/api/runs/${completed.id}/rating`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 5, workId: child.id, timing: 'worth-the-wait' }),
    });
    assert.equal(rated.status, 200);
    assert.equal(store.get('runs', completed.id)?.rating, undefined);
    assert.equal(
      store.get('runs', completed.id)?.work?.find((w) => w.id === child.id)?.feedback?.rating,
      5,
    );
    const restored = await fetch(`${url}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(store.export()),
    });
    assert.equal(restored.status, 200, await restored.text());
    assert.equal(
      collaborationHandoffs(store.get('runs', completed.id)!)[1].answer,
      'Worker2 actual result',
    );
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    store.close();
    await model.close();
  }
});
test('synthetic team setup preserves profiles and paused schedules across repeated initialization', () => {
  const { store } = fixture();
  assert.equal(store.all('bots').length, 15);
  assert.equal(store.all('skills').length, 8);
  assert.equal(store.all('routines').length, 12);
  assert.ok(store.all('routines').every((r) => !r.enabled));
  assert.ok(store.all('memory').length > 10);
  assert.match(store.get('bots', 'boss-man')!.instructions, /synthetic test teammate/);
  seed(store, resolve('reference/grok-backup'));
  for (const provider of store.all('providers'))
    store.put('providers', { ...provider, autoDiscover: false, autoEnableModels: false });
  assert.equal(store.all('bots').length, 15);
  assert.equal(store.all('providers').length, 1);
  assert.equal(store.all('models').filter((m) => m.enabled).length, 1);
  store.close();
});
test('compatible URL normalization handles roots, /v1, LAN addresses, and accidental endpoint URLs', () => {
  for (const url of [
    'http://127.0.0.1:1234',
    'http://127.0.0.1:1234/v1/',
    'http://127.0.0.1:1234/v1/chat/completions',
  ])
    assert.equal(normalizeBaseUrl(url), 'http://127.0.0.1:1234/v1');
  assert.equal(normalizeBaseUrl('http://192.168.1.9:8080/v1'), 'http://192.168.1.9:8080/v1');
  assert.throws(() => normalizeBaseUrl('file:///secret'));
  assert.throws(() => normalizeBaseUrl('https://secret:password@example.com'));
});
test('routing uses measured task ratings and honors local-only policy and disabled models', () => {
  const { store } = fixture();
  const qwen = store.all('models')[0];
  store.put('providers', { ...store.all('providers')[0], id: 'cloud', local: false });
  store.put('models', { ...qwen, id: 'cloud::best', providerId: 'cloud', priority: 0 });
  store.put('models', { ...qwen, id: 'local-2', name: 'local-2', priority: 20 });
  assert.ok(candidates(store, 'coding').every((m) => m.providerId !== 'cloud'));
  for (let n = 0; n < 3; n++)
    store.put('runs', {
      id: `r${n}`,
      botId: 'worker1',
      conversationId: 'c',
      prompt: 'test',
      task: 'coding',
      status: 'completed',
      startedAt: new Date().toISOString(),
      tokens: 10,
      events: [],
      modelId: 'local-2',
      rating: 5,
    });
  assert.equal(candidates(store, 'coding')[0].id, 'local-2');
  assert.equal(candidates(store, 'general')[0].id, qwen.id);
  store.close();
});
test('scheduled next occurrences are timezone-aware across the Pacific DST boundary', () => {
  assert.equal(
    nextRun(
      { cron: '0 9 * * *', timezone: 'America/Los_Angeles' },
      new Date('2026-03-07T18:00:00Z'),
    ),
    '2026-03-08T16:00:00.000Z',
  );
  assert.throws(() => nextRun({ cron: 'not cron', timezone: 'America/Los_Angeles' }));
});
test('discovery respects disabled automatic enablement; offline first model fails over to a healthy server', async () => {
  const good = await mock(() => ({
    choices: [{ message: { content: 'Fallback succeeded' }, finish_reason: 'stop' }],
    usage: { total_tokens: 11 },
  }));
  const { store, dir } = fixture();
  try {
    const original = store.all('providers')[0];
    store.put('providers', { ...original, baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 1000 });
    store.put('providers', { ...original, id: 'backup', name: 'Backup', baseUrl: good.url });
    await discover(store, 'backup');
    assert.equal(store.get('models', 'backup::test-model')!.enabled, false);
    store.put('models', { ...store.get('models', 'backup::test-model')!, enabled: true });
    const { runtime } = createApp(store, dir, resolve('dist/web'));
    const r = await done(runtime, runtime.create('worker1', 'Say hello.'));
    assert.equal(r.status, 'completed');
    assert.equal(r.modelId, 'backup::test-model');
    assert.ok(r.events.some((e) => e.kind === 'fallback'));
    assert.equal(store.all('incidents').length, 0);
  } finally {
    store.close();
    await good.close();
  }
});
test('all-model outage triggers direct alert APIs, deduplicates warnings, and records recovery', async () => {
  let alerts = 0;
  const webhook = await mock(() => {
    alerts++;
    return { ok: true };
  });
  const { store, dir } = fixture();
  try {
    store.put('providers', {
      ...store.all('providers')[0],
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 1000,
    });
    store.setConfig('settings', {
      ...store.settings(),
      alertEmail: {
        enabled: true,
        url: `${webhook.url}/alerts`,
        destination: 'test@example.invalid',
        tokenEnv: '',
      },
    });
    const { runtime, alerts: manager } = createApp(store, dir, resolve('dist/web'));
    const first = await done(runtime, runtime.create('worker1', 'hello'));
    assert.equal(first.status, 'failed');
    assert.equal(alerts, 1);
    assert.equal(store.all('incidents').length, 1);
    await done(runtime, runtime.create('worker1', 'hello again'));
    assert.equal(alerts, 1);
    manager.recovered();
    assert.ok(store.all('incidents')[0].resolvedAt);
  } finally {
    store.close();
    await webhook.close();
  }
});
test('tool calls persist real artifacts and refuse workspace escapes', async () => {
  let calls = 0;
  const model = await mock(() => {
    calls++;
    if (calls === 1)
      return {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'one',
                  type: 'function',
                  function: {
                    name: 'workspace_write',
                    arguments: JSON.stringify({ path: '../../escaped.txt', content: 'no' }),
                  },
                },
                {
                  id: 'two',
                  type: 'function',
                  function: {
                    name: 'page_create',
                    arguments: JSON.stringify({
                      title: 'Tool test',
                      content: '<h1>Real page</h1>',
                      format: 'html',
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
    return {
      choices: [
        {
          message: { content: 'The page was saved. The outside path was blocked.' },
          finish_reason: 'stop',
        },
      ],
    };
  });
  const { store, dir } = fixture();
  try {
    store.put('providers', { ...store.all('providers')[0], baseUrl: model.url });
    const { runtime } = createApp(store, dir, resolve('dist/web'));
    const r = await done(runtime, runtime.create('worker1', 'Do the test'));
    assert.equal(r.status, 'completed');
    assert.equal(store.all('pages').length, 1);
    assert.equal(store.all('pages')[0].title, 'Tool test');
    assert.equal(calls, 2);
  } finally {
    store.close();
    await model.close();
  }
});
test('HTTP API blocks hostile origins and unauthenticated network access, validates settings, and exports without secrets', async () => {
  const { store, dir } = fixture();
  const { app } = createApp(
    store,
    dir,
    resolve('dist/web'),
    'test-token-with-at-least-24-characters',
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${url}/api/bootstrap`)).status, 401);
    const headers = { Authorization: 'Bearer test-token-with-at-least-24-characters' };
    assert.equal(
      (
        await fetch(`${url}/api/bootstrap`, {
          headers: { ...headers, Origin: 'https://evil.invalid' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${url}/api/settings`, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...store.settings(), maxOutputTokens: 1 }),
        })
      ).status,
      400,
    );
    const backup = (await fetch(`${url}/api/export`, { headers }).then((r) => r.json())) as any;
    assert.equal(backup.bots.length, 15);
    assert.ok(!JSON.stringify(backup).includes('test-token-with-at-least-24-characters'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
test('Claude adapter converts tool use and results without calling a paid API', async () => {
  let observed: any;
  const server = await mock((body) => {
    observed = body;
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'claude-call', name: 'memory_search', input: { query: 'hello' } },
      ],
      usage: { input_tokens: 20, output_tokens: 5 },
    };
  });
  const { store } = fixture();
  try {
    const p = { ...store.all('providers')[0], kind: 'anthropic' as const, baseUrl: server.url };
    const result = await complete(
      p,
      store.all('models')[0],
      [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'previous',
              type: 'function',
              function: { name: 'memory_search', arguments: '{"query":"x"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'previous', content: '[]' },
      ],
      [
        {
          type: 'function',
          function: {
            name: 'memory_search',
            description: 'Search',
            parameters: { type: 'object' },
          },
        },
      ],
      4096,
      new AbortController().signal,
    );
    assert.equal(observed.system, 'System');
    assert.equal(observed.messages.at(-1).content[0].type, 'tool_result');
    assert.equal(observed.tools[0].name, 'memory_search');
    assert.equal(result.message.tool_calls![0].id, 'claude-call');
    assert.equal(result.tokens, 25);
  } finally {
    store.close();
    await server.close();
  }
});
test('OpenAI Responses adapter preserves reasoning items and function call output across tool turns', async () => {
  let observed: any;
  const server = await mock((body) => {
    observed = body;
    return {
      status: 'completed',
      output: [
        { type: 'reasoning', encrypted_content: 'opaque-test-data' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
      ],
      usage: { total_tokens: 31 },
    };
  });
  const { store } = fixture();
  try {
    const p = {
      ...store.all('providers')[0],
      kind: 'openai-responses' as const,
      baseUrl: server.url,
    };
    const result = await complete(
      p,
      store.all('models')[0],
      [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: null,
          rawOutput: [
            { type: 'reasoning', encrypted_content: 'opaque-previous' },
            {
              type: 'function_call',
              call_id: 'f1',
              name: 'memory_search',
              arguments: '{"query":"x"}',
            },
          ],
        },
        { role: 'tool', tool_call_id: 'f1', content: '[]' },
      ],
      [],
      4096,
      new AbortController().signal,
    );
    assert.equal(observed.store, false);
    assert.ok(observed.input.some((x: any) => x.encrypted_content === 'opaque-previous'));
    assert.ok(
      observed.input.some((x: any) => x.type === 'function_call_output' && x.call_id === 'f1'),
    );
    assert.equal(result.message.content, 'Done');
    assert.equal(result.message.rawOutput?.length, 2);
  } finally {
    store.close();
    await server.close();
  }
});
test('context budgeting retains the current tool chain and rejects an oversized system prompt', () => {
  const current = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'x'.repeat(10000) },
    { role: 'assistant', content: 'y'.repeat(10000) },
    { role: 'user', content: 'current' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'a', type: 'function' as const, function: { name: 'a', arguments: '{}' } },
      ],
    },
    { role: 'tool', content: 'done', tool_call_id: 'a' },
  ];
  const fitted = fitContext(current, [], 4096, 512);
  assert.equal(fitted[1].content, 'current');
  assert.equal(fitted.at(-1)?.tool_call_id, 'a');
  assert.throws(() =>
    fitContext(
      [
        { role: 'system', content: 'a'.repeat(30000) },
        { role: 'user', content: 'current' },
      ],
      [],
      4096,
      512,
    ),
  );
});
test('backup restore validates all records, merges data, pauses schedules, and keeps a rollback snapshot', async () => {
  const { store, dir } = fixture();
  const { app } = createApp(store, dir, resolve('dist/web'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const backup = store.export() as any;
    const malformed = { ...backup, models: [{ id: 'bad' }] };
    assert.equal(
      (
        await fetch(`${url}/api/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(malformed),
        })
      ).status,
      400,
    );
    backup.bots[0].name = 'Restored Boss';
    backup.routines[0].enabled = true;
    const response = await fetch(`${url}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(backup),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(store.all('bots')[0].name, 'Restored Boss');
    assert.ok(store.all('routines').every((r) => !r.enabled));
    assert.ok(store.config('preImportBackup'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
