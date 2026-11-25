import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { seedTestTeam as seed } from './fixtures/team';
import { candidates, complete, discover } from '../apps/server/models';
import { Store } from '../apps/server/store';
import { effectiveContext, canUseTools } from '../packages/shared/model-routing';
import type { Run } from '../packages/shared/types';

mkdirSync('test-results/unit', { recursive: true });
async function fixture(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void) {
  const dir = mkdtempSync(resolve('test-results/unit/discovery-'));
  const store = new Store(join(dir, 'team.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    handler(req, res, body ? JSON.parse(body) : {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const provider = store.all('providers')[0];
  for (const p of store.all('providers'))
    store.put('providers', { ...p, enabled: p.id === provider.id });
  store.put('providers', {
    ...provider,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    timeoutMs: 2000,
  });
  return {
    dir,
    store,
    providerId: provider.id,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    },
  };
}
const native = (key: string, loaded: boolean, context = 131072) => ({
  key,
  type: 'llm',
  architecture: 'llama',
  max_context_length: 262144,
  capabilities: { trained_for_tool_use: true },
  loaded_instances: loaded ? [{ id: key, config: { context_length: context } }] : [],
});
const answer = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { total_tokens: 12 },
});

test('legacy local context defaults follow the actual loaded window while explicit manual caps remain intact', async () => {
  const f = await fixture((req, res) => {
    if (req.url === '/api/v1/models')
      res.end(JSON.stringify({ models: [native('larger-local', true, 196608)] }));
    else if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'larger-local' }] }));
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  try {
    const template = f.store.all('models')[0];
    const id = `${f.providerId}::larger-local`;
    for (const oldCap of [32768, 65536]) {
      f.store.put('models', {
        ...template,
        id,
        providerId: f.providerId,
        name: 'larger-local',
        contextTokens: oldCap,
        contextSource: undefined,
        enabled: true,
      });
      await discover(f.store, f.providerId);
      const current = f.store.get('models', id)!;
      assert.equal(current.contextSource, 'server');
      assert.equal(current.loadedContextTokens, 196608);
      assert.equal(effectiveContext(current), 196608);
    }
    f.store.put('models', {
      ...f.store.get('models', id)!,
      contextSource: 'manual',
      contextTokens: 65536,
    });
    await discover(f.store, f.providerId);
    assert.equal(effectiveContext(f.store.get('models', id)!), 65536);
  } finally {
    await f.close();
  }
});
function finished(host: ReturnType<typeof createApp>, prompt: string) {
  const run = host.runtime.create('worker1', prompt);
  return new Promise<Run>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Run timed out')), 10000);
    host.runtime.events.on(run.id, (e) => {
      if (e.type === 'done') {
        clearTimeout(timeout);
        resolve(e.run);
      }
    });
  });
}

test('local tool-format errors retry once as text, retain compatibility knowledge and never dispatch disabled tools', async () => {
  const observed: any[] = [];
  let rogue = false;
  const f = await fixture((req, res, body) => {
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'small-model' }] }));
      return;
    }
    if (req.url === '/api/v1/models') {
      res.end(JSON.stringify({ models: [native('small-model', true)] }));
      return;
    }
    observed.push(body);
    if (body.tools?.length) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: 'The model produced output that does not match the expected peg-native format',
        }),
      );
    } else if (rogue)
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'forbidden',
                    type: 'function',
                    function: {
                      name: 'workspace_write',
                      arguments: JSON.stringify({ path: 'forbidden.txt', content: 'Do not write' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
    else res.end(JSON.stringify(answer('A text-only reply.')));
  });
  const host = createApp(f.store, f.dir, resolve('dist/web'));
  try {
    const first = await finished(host, 'Reply briefly.');
    assert.equal(first.status, 'completed', first.error);
    assert.equal(first.work![0].attempts[0].calls, 2);
    assert.equal(first.work![0].attempts[0].usageKnown, false);
    assert.equal(first.events.filter((e) => e.kind === 'fallback').length, 0);
    assert.ok(first.events.some((e) => /Retrying this reply as text only/.test(e.text)));
    const id = `${f.providerId}::small-model`;
    assert.equal(f.store.get('models', id)?.status, 'online');
    assert.equal(canUseTools(f.store.get('models', id)!), false);
    assert.match(observed[1].messages[0].content, /Do not emit tool calls/);
    assert.equal(
      observed[1].messages.filter((message: any) => message.role === 'system').length,
      1,
    );
    assert.equal(observed[1].messages.at(-1).content, 'Reply briefly.');
    const second = await finished(host, 'Reply again.');
    assert.equal(second.status, 'completed', second.error);
    assert.equal(observed.length, 3);
    assert.equal(observed[2].tools, undefined);
    const model = f.store.get('models', id)!;
    assert.equal(canUseTools({ ...model, toolCalling: 'enabled' }), true);
    assert.equal(canUseTools({ ...model, toolCalling: 'disabled' }), false);
    rogue = true;
    const blocked = await finished(host, 'Do not execute anything.');
    assert.equal(blocked.status, 'failed');
    assert.match(blocked.error!, /No actions were executed/);
    assert.equal(existsSync(join(f.dir, 'workspace/forbidden.txt')), false);
    assert.equal(f.store.get('models', id)?.status, 'online');
    assert.equal(f.store.all('incidents').length, 0);
  } finally {
    host.runtime.events.emit('shutdown');
    host.computer.dispose();
    await host.terminal.dispose();
    await f.close();
  }
});

test('automatic local discovery follows loaded context and preserves manual availability/context choices', async () => {
  let context = 131072,
    names = ['qwen/qwen3.5-9b', 'llama-small', 'embedding-only', 'image-only', 'missing-native'];
  const f = await fixture((req, res) =>
    res.end(
      JSON.stringify(
        req.url === '/v1/models'
          ? { data: names.map((id) => ({ id })) }
          : {
              models: [
                native(names[0], false),
                native('llama-small', true, context),
                { ...native('embedding-only', true), type: 'embedding' },
                { ...native('image-only', true), architecture: 'qwen_image' },
              ],
            },
      ),
    ),
  );
  try {
    await discover(f.store, f.providerId);
    const id = `${f.providerId}::llama-small`,
      model = f.store.get('models', id)!;
    assert.equal(model.contextTokens, 131072);
    assert.equal(model.maxContextTokens, 262144);
    assert.equal(model.contextSource, 'server');
    assert.deepEqual(
      candidates(f.store, 'general').map((m) => m.id),
      [id],
    );
    f.store.put('models', {
      ...model,
      enabled: false,
      enablement: 'manual',
      contextSource: 'manual',
      contextTokens: 65536,
    });
    context = 32768;
    names.push('new-download');
    await discover(f.store, f.providerId);
    const preserved = f.store.get('models', id)!;
    assert.equal(preserved.enabled, false);
    assert.equal(preserved.contextTokens, 65536);
    assert.equal(effectiveContext(preserved), 32768);
    assert.equal(f.store.get('models', `${f.providerId}::new-download`)?.enabled, true);
    assert.equal(f.store.get('models', `${f.providerId}::new-download`)?.loadState, 'unloaded');
    f.store.put('models', {
      ...preserved,
      enabled: true,
      enablement: 'auto',
      contextSource: 'server',
    });
    await discover(f.store, f.providerId);
    assert.equal(f.store.get('models', id)?.contextTokens, 32768);
    names = names.filter((name) => name !== 'llama-small');
    await discover(f.store, f.providerId);
    assert.equal(f.store.get('models', id)?.status, 'offline');
    assert.equal(candidates(f.store, 'general').length, 0);
  } finally {
    await f.close();
  }
});

test('native v0 loaded-context metadata is used when v1 is unavailable', async () => {
  const paths: string[] = [];
  const f = await fixture((req, res) => {
    paths.push(req.url!);
    if (req.url === '/api/v1/models') {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    res.end(
      JSON.stringify(
        req.url === '/v1/models'
          ? { data: [{ id: 'old-server' }] }
          : {
              data: [
                {
                  id: 'old-server',
                  type: 'llm',
                  state: 'loaded',
                  loaded_context_length: 98304,
                  max_context_length: 131072,
                },
              ],
            },
      ),
    );
  });
  try {
    await discover(f.store, f.providerId);
    assert.equal(candidates(f.store, 'general')[0].contextTokens, 98304);
    assert.equal(f.store.get('providers', f.providerId)?.metadataSource, 'lm-studio-v0');
    assert.ok(paths.includes('/api/v0/models'));
  } finally {
    await f.close();
  }
});

test('generic compatible servers auto-enable new chat models; cloud stays opt-in; concurrent refreshes share one request', async () => {
  let lists = 0;
  const f = await fixture((req, res) => {
    if (req.url === '/v1/models') {
      lists++;
      res.end(JSON.stringify({ data: [{ id: 'generic-chat' }] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  try {
    await Promise.all([discover(f.store, f.providerId), discover(f.store, f.providerId)]);
    assert.equal(lists, 1);
    const model = candidates(f.store, 'general')[0];
    assert.equal(model.name, 'generic-chat');
    assert.equal(model.loadState, 'unknown');
    f.store.put('providers', {
      ...f.store.get('providers', f.providerId)!,
      id: 'cloud',
      local: false,
    });
    await discover(f.store, 'cloud');
    assert.equal(f.store.get('models', 'cloud::generic-chat')?.enabled, false);
  } finally {
    await f.close();
  }
});

test('requests use the loaded instance and larger context while respecting the actual server cap', async () => {
  let received: any;
  const f = await fixture((_req, res, body) => {
    received = body;
    res.end(JSON.stringify(answer('ok')));
  });
  try {
    const provider = f.store.get('providers', f.providerId)!;
    const model = {
      ...f.store.all('models')[0],
      name: 'canonical',
      instanceId: 'loaded-instance',
      contextTokens: 131072,
      loadedContextTokens: 131072,
    };
    const messages = [
      { role: 'system', content: 'Helpful assistant.' },
      { role: 'user', content: 'x'.repeat(110000) },
    ];
    await complete(provider, model, messages, [], 32, new AbortController().signal);
    assert.equal(received.model, 'loaded-instance');
    assert.equal(received.messages[1].content.length, 110000);
    await assert.rejects(
      complete(
        provider,
        { ...model, loadedContextTokens: 32768 },
        messages,
        [],
        32,
        new AbortController().signal,
      ),
      /context window/,
    );
  } finally {
    await f.close();
  }
});

test('a server-side model switch preserves completed tool results and updates the live catalog without outage or replay', async () => {
  let loaded = 'first',
    chats = 0;
  const observed: any[] = [];
  const f = await fixture((req, res, body) => {
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'first' }, { id: 'second' }] }));
      return;
    }
    if (req.url === '/api/v1/models') {
      res.end(
        JSON.stringify({
          models: [native('first', loaded === 'first'), native('second', loaded === 'second')],
        }),
      );
      return;
    }
    chats++;
    observed.push(body);
    if (chats === 1) {
      loaded = 'second';
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'write-once',
                    type: 'function',
                    function: {
                      name: 'workspace_write',
                      arguments: JSON.stringify({ path: 'kept.txt', content: 'Saved work' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { total_tokens: 7 },
        }),
      );
    } else res.end(JSON.stringify(answer('Completed using saved result.')));
  });
  const host = createApp(f.store, f.dir, resolve('dist/web'));
  try {
    let catalogs = 0;
    host.runtime.events.on('models', () => catalogs++);
    const run = host.runtime.create('worker1', 'Save a short file and report it.');
    const result = await new Promise<Run>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Run timed out')), 10000);
      host.runtime.events.on(run.id, (e) => {
        if (e.type === 'done') {
          clearTimeout(timeout);
          resolve(e.run);
        }
      });
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(chats, 2);
    assert.deepEqual(
      observed.map((b) => b.model),
      ['first', 'second'],
    );
    assert.ok(
      observed[1].messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'write-once'),
    );
    assert.equal(readFileSync(join(f.dir, 'workspace/kept.txt'), 'utf8'), 'Saved work');
    assert.equal(result.events.filter((e) => e.tool === 'workspace_write').length, 1);
    assert.deepEqual(
      result.work![0].attempts.map((a) => a.status),
      ['switched', 'completed'],
    );
    assert.equal(result.modelId, `${f.providerId}::second`);
    assert.equal(f.store.all('incidents').length, 0);
    assert.ok(catalogs >= 3);
  } finally {
    host.runtime.events.emit('shutdown');
    host.computer.dispose();
    await host.terminal.dispose();
    await f.close();
  }
});
