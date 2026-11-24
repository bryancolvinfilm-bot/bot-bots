import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Store } from '../apps/server/store';
import { seedStarterTeam } from '../apps/server/starter-team';
import { ClaudeCode } from '../apps/server/claude-code';
import { Credentials } from '../apps/server/credentials';
import { createApp } from '../apps/server/app';
import {
  attachClaudeCode,
  complete,
  discover,
  fitContext,
  type WireMessage,
} from '../apps/server/models';
import {
  claudeCodeContextTokens,
  migrateClaudeContexts,
  withClaudeContext,
} from '../apps/server/frontier-context';
import { effectiveContext } from '../packages/shared/model-routing';
import type { Model, Provider } from '../packages/shared/types';

function fixture() {
  mkdirSync('test-results/unit', { recursive: true });
  const dir = mkdtempSync(resolve('test-results/unit/frontier-context-'));
  const store = new Store(join(dir, 'team.sqlite'));
  seedStarterTeam(store);
  const provider: Provider = {
    id: 'test-claude',
    name: 'Claude test',
    kind: 'claude-code',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: '',
    enabled: true,
    local: false,
    timeoutMs: 60000,
  };
  const model: Model = {
    id: 'test-claude::opus',
    providerId: provider.id,
    name: 'opus',
    contextTokens: 32768,
    enabled: true,
    priority: 7,
    costPerMillion: 0,
    tasks: ['research'],
    status: 'online',
  };
  store.put('providers', provider);
  store.put('models', model);
  return { dir, store, provider, model };
}

test('Claude Code context follows current aliases, older model windows, pins and the host opt-out', () => {
  for (const name of [
    'opus',
    'sonnet',
    'haiku',
    'fable',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-opus-4-7',
  ])
    assert.equal(claudeCodeContextTokens(name, {}), 1000000, name);
  for (const name of [
    'claude-opus-4-5',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ])
    assert.equal(claudeCodeContextTokens(name, {}), 200000, name);
  assert.equal(claudeCodeContextTokens('claude-opus-4-6[1m]', {}), 1000000);
  assert.equal(
    claudeCodeContextTokens('opus', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6' }),
    200000,
  );
  assert.equal(claudeCodeContextTokens('opus', { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' }), 200000);
});

test('migration upgrades the old Claude placeholder without changing enablement, effort or local windows', () => {
  const { store, model } = fixture();
  try {
    const local = store.all('models').find((m) => m.providerId === 'lm-studio')!;
    store.put('models', { ...model, reasoningEffort: 'medium' });
    const manual = {
      ...model,
      id: 'manual',
      name: 'sonnet',
      contextTokens: 65536,
      contextSource: 'manual' as const,
    };
    store.put('models', manual);
    migrateClaudeContexts(store);
    const migrated = store.get('models', model.id)!;
    assert.equal(migrated.contextTokens, 1000000);
    assert.equal(migrated.maxContextTokens, 1000000);
    assert.equal(migrated.contextSource, 'server');
    assert.equal(migrated.enabled, true);
    assert.equal(migrated.priority, model.priority);
    assert.equal(migrated.reasoningEffort, 'medium');
    assert.equal(store.get('models', manual.id)?.contextTokens, 65536);
    assert.deepEqual(store.get('models', local.id), local);
    assert.equal(
      effectiveContext(withClaudeContext({ ...manual, contextTokens: 2000000 }, {})),
      1000000,
    );
  } finally {
    store.close();
  }
});

test('Claude discovery accepts a research tool chain beyond the old 32K guard and preserves all source results', async () => {
  const { store, dir, provider, model } = fixture();
  const claude = new ClaudeCode(join(dir, 'claude'));
  writeFileSync(claude.binary, 'synthetic executable');
  let requests = 0;
  (claude as any).run = async (args: string[], input: string) => {
    if (args[0] === 'auth') return { code: 0, output: JSON.stringify({ loggedIn: true }) };
    requests++;
    const envelope = JSON.parse(input.slice(input.indexOf('\n') + 1));
    assert.equal(envelope.messages.filter((m: any) => m.role === 'tool').length, 3);
    assert.ok(envelope.messages.at(-1).content.endsWith('LAST_SOURCE_MARKER'));
    assert.equal(args[args.indexOf('--effort') + 1], 'medium');
    return {
      code: 0,
      output: JSON.stringify({
        structured_output: { text: 'Verified the research sources.', calls: [] },
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    };
  };
  const values = new Map<string, string>();
  const credentials = new Credentials(join(dir, 'external'), {
    kind: 'Isolated context test',
    get: (id) => values.get(id) ?? null,
    set: (id, value) => {
      values.set(id, value);
    },
    delete: (id) => values.delete(id),
  });
  attachClaudeCode(store, credentials, claude);
  try {
    await discover(store, provider.id);
    const discovered = store.get('models', model.id)!;
    assert.equal(discovered.contextTokens, 1000000);
    assert.equal(discovered.enabled, true);
    const messages: WireMessage[] = [
      { role: 'system', content: 'Research using observed source facts.' },
      { role: 'user', content: 'Research tacos in Santa Monica.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [1, 2, 3].map((i) => ({
          id: `search-${i}`,
          type: 'function',
          function: { name: 'web_search', arguments: JSON.stringify({ query: `source ${i}` }) },
        })),
      },
      ...[1, 2, 3].map((i) => ({
        role: 'tool',
        tool_call_id: `search-${i}`,
        content: `https://example.test/source-${i}\n${'source evidence '.repeat(3500)}LAST_SOURCE_MARKER`,
      })),
    ];
    assert.throws(
      () => fitContext(messages, [], 32768, 4096),
      /32,768-token effective window.*before provider inference/,
    );
    const result = await complete(
      provider,
      { ...discovered, reasoningEffort: 'medium' },
      messages,
      [],
      4096,
      new AbortController().signal,
      credentials,
    );
    assert.equal(result.message.content, 'Verified the research sources.');
    assert.equal(requests, 1);
  } finally {
    store.close();
  }
});

test('startup and model settings repair automatic Claude context while preserving and clearing a manual cap', async () => {
  const { store, dir, model } = fixture();
  const host = createApp(store, dir, resolve('dist/web'));
  const server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function save(value: Model) {
    const r = await fetch(`${base}/models/${encodeURIComponent(value.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    assert.equal(r.status, 200);
    return (await r.json()) as Model;
  }
  try {
    assert.equal(store.get('models', model.id)?.contextTokens, 1000000);
    const capped = await save({
      ...store.get('models', model.id)!,
      contextSource: 'manual',
      contextTokens: 32768,
    });
    assert.equal(effectiveContext(capped), 32768);
    const automatic = await save({ ...capped, contextSource: 'server' });
    assert.equal(automatic.contextTokens, 1000000);
    assert.equal(effectiveContext(automatic), 1000000);
  } finally {
    host.runtime.events.emit('shutdown');
    host.google.cancelRun();
    host.computer.dispose();
    await host.terminal.dispose();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
