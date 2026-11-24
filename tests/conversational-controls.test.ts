import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { Credentials } from '../apps/server/credentials';
import { CredentialSetups } from '../apps/server/credential-setup';
import type { SecretBackend } from '../apps/server/host-secrets';
import { seedTestTeam as seed } from './fixtures/team';
import { Store } from '../apps/server/store';
import { wantsPrivateEntry, credentialService } from '../packages/shared/credential-setup';
import { visibleBots } from '../packages/shared/team';

const hidden = 'TEST_ONLY_CONVERSATIONAL_KEY_9e6f35';
const answer = (content: string) => ({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { total_tokens: 8 },
});
const call = (args: unknown) => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: 'private',
            type: 'function',
            function: { name: 'credential_setup_request', arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
});
class MemorySecrets implements SecretBackend {
  kind = 'Isolated credential store';
  values = new Map<string, string>();
  get(id: string) {
    return this.values.get(id) ?? null;
  }
  set(id: string, value: string) {
    this.values.set(id, value);
  }
  delete(id: string) {
    return this.values.delete(id);
  }
}
async function until(ready: () => boolean) {
  for (let i = 0; i < 700; i++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Conversational check timed out');
}
async function fixture(
  handler: (body: any) => unknown = () =>
    answer('Connection status acknowledged without reading any secret.'),
) {
  mkdirSync('test-results/unit', { recursive: true });
  const dir = mkdtempSync(resolve('test-results/unit/conversation-')),
    store = new Store(join(dir, 'team.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  const bodies: any[] = [],
    backend = new MemorySecrets();
  const provider = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    bodies.push(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(handler(body)));
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  for (const p of store.all('providers'))
    store.put('providers', {
      ...p,
      autoDiscover: false,
      baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
    });
  const credentials = new Credentials(join(dir, 'external'), backend, join(dir, 'workspace'));
  const host = createApp(store, dir, resolve('dist/web'), '', undefined, undefined, credentials),
    server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function api(path: string, method = 'GET', body?: unknown, token?: string) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  return {
    store,
    host,
    backend,
    bodies,
    api,
    async close() {
      for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
      await until(() => !host.runtime.controllers.size);
      host.runtime.events.emit('shutdown');
      host.computer.dispose();
      await host.terminal.dispose();
      provider.closeAllConnections();
      server.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => provider.close(() => r())),
        new Promise<void>((r) => server.close(() => r())),
      ]);
      store.close();
    },
  };
}

test('conversational keys are saved immediately without passing values to chat/model history or opening another entry window', async () => {
  for (const text of [
    'Let me give you the API key',
    'Where do I enter my password?',
    'Here is my API key: sk-secret01234567890',
    'sk-secret01234567890',
  ])
    assert.equal(wantsPrivateEntry(text), true, text);
  for (const text of [
    'Never paste your API key into chat.',
    'Build an API key manager UI',
    'Can you add API key handling to my app?',
    '> Let me give you an API key',
  ])
    assert.equal(wantsPrivateEntry(text), false, text);
  assert.deepEqual(credentialService('my Claude API key'), {
    service: 'Claude',
    providerId: 'anthropic',
  });
  const f = await fixture();
  try {
    const entry = await f.api('/runs', 'POST', {
      botId: 'worker1',
      prompt: `Here is my Netlify API key: ${hidden}`,
    });
    assert.equal(entry.status, 202);
    assert.equal(f.bodies.length, 0);
    const request = entry.data.credentialRequest;
    assert.equal(request.service, 'Netlify');
    assert.ok(!JSON.stringify(f.store.export()).includes(hidden));
    assert.equal(request.status, 'saved');
    assert.equal(f.backend.get(request.secretId), hidden);
    assert.equal(request.connected, false);
    await until(() => !f.host.runtime.controllers.size);
    assert.equal(f.bodies.length, 0);
    assert.ok(!JSON.stringify(f.bodies).includes(hidden));
    assert.ok(!JSON.stringify(f.store.export()).includes(hidden));
    assert.ok(!JSON.stringify(await f.api('/credentials/manager/requests')).includes(hidden));
    assert.equal((await f.api(`/credentials/manager/secrets/${request.secretId}`)).status, 404);
  } finally {
    await f.close();
  }
});

test('a bot opens private entry, waits for the owner, receives only readiness/opaque IDs, and gains only the reviewed operation', async () => {
  let calls = 0;
  const connection = {
    type: 'operation',
    url: 'https://service.test/pages',
    method: 'POST',
    authType: 'bearer',
    inputFields: ['title'],
    responseFields: ['id', 'url'],
  };
  const f = await fixture((body) =>
    ++calls === 1
      ? call({
          service: 'Example publishing',
          purpose: 'Publish the requested page to the chosen host',
          connectionJson: JSON.stringify(connection),
        })
      : answer(`Ready: ${body.messages.at(-1).content}`),
  );
  try {
    const run = f.host.runtime.create('worker1', 'Connect the required publishing service.');
    await until(() => f.host.runtime.setups.list().length === 1);
    const request = f.host.runtime.setups.list()[0];
    assert.equal(request.status, 'awaiting-entry');
    assert.equal(calls, 1);
    const state = (await f.api('/credentials/manager')).data;
    const saved = await f.api('/credentials/manager/secrets', 'POST', {
      requestId: request.id,
      version: state.version,
      name: 'Example publishing',
      kind: 'api-key',
      value: hidden,
      target: { ...connection, label: 'Publish page', botIds: ['worker1'] },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    await until(() => !f.host.runtime.controllers.has(run.id));
    assert.equal(f.store.get('runs', run.id)!.status, 'completed');
    assert.ok(!JSON.stringify(f.bodies).includes(hidden));
    assert.match(f.bodies[1].messages.at(-1).content, /No secret value was returned/);
    assert.match(f.bodies[1].messages.at(-1).content, new RegExp(saved.data.grantId));
    const policy = f.host.runtime.credentials!.capabilities(f.store.get('bots', 'worker1')!);
    assert.equal(policy.length, 1);
    assert.equal(policy[0].id, saved.data.grantId);
    assert.equal(
      f.host.runtime.credentials!.capabilities(f.store.get('bots', 'worker2')!).length,
      1,
    );
    assert.equal(
      f.host.runtime.credentials!.state().actions.length,
      0,
      'Saving does not execute a remote action.',
    );
  } finally {
    await f.close();
  }
});

test('a key supplied to one bot connects for every bot; unknown keys can be identified later without re-entry', async () => {
  const f = await fixture();
  try {
    const profiles = f.store.all('bots').map((b) => ({ id: b.id, instructions: b.instructions }));
    const entered = await f.api('/runs', 'POST', {
      botId: 'worker1',
      prompt: `Here is my API key: ${hidden}`,
    });
    assert.equal(entered.data.credentialRequest.status, 'saved');
    assert.equal(entered.data.connected, false);
    const clarified = await f.api('/runs', 'POST', {
      botId: 'worker1',
      conversationId: entered.data.conversationId,
      prompt: 'It is for bottools.online.',
    });
    assert.equal(clarified.data.connected, true, JSON.stringify(clarified.data));
    assert.equal(
      clarified.data.credentialRequest.secretId,
      entered.data.credentialRequest.secretId,
    );
    const credentials = f.host.runtime.credentials!;
    for (const id of ['worker1', 'worker2', 'info-page-generate'])
      assert.equal(credentials.serviceCapabilities(f.store.get('bots', id)!).length, 1);
    const prototype = f.store.get('bots', 'worker1')!;
    f.store.put('bots', { ...prototype, id: 'future-bot' });
    assert.equal(credentials.serviceCapabilities(f.store.get('bots', 'future-bot')!).length, 1);
    const repeated = await f.api('/runs', 'POST', {
      botId: 'worker2',
      prompt: 'Let me give you my bottools API key',
    });
    assert.equal(repeated.data.credentialRequest.status, 'saved');
    assert.equal(repeated.data.connected, true);
    assert.equal(f.bodies.length, 0);
    assert.equal(credentials.manager().state().secrets.length, 1);
    assert.ok(!JSON.stringify(f.store.export()).includes(hidden));
    assert.deepEqual(
      f.store
        .all('bots')
        .filter((b) => b.id !== 'future-bot')
        .map((b) => ({ id: b.id, instructions: b.instructions })),
      profiles,
    );
    const operator = f.host.access.issue('Operator', 'operator').token;
    assert.equal(
      (
        await f.api(
          '/credentials/manager/conversation',
          'POST',
          { botId: 'worker2', text: `bottools API key: ${hidden}` },
          operator,
        )
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test('typing the key while a bot waits completes its existing request and resumes the task', async () => {
  let calls = 0;
  const f = await fixture(() =>
    ++calls === 1
      ? call({
          service: 'Example publishing',
          connectionJson: JSON.stringify({
            type: 'operation',
            url: 'https://service.test/pages',
            method: 'POST',
            authType: 'bearer',
            inputFields: ['title'],
            responseFields: ['id', 'url'],
          }),
        })
      : answer('The existing connection is ready.'),
  );
  try {
    const run = f.host.runtime.create('worker1', 'Connect this publishing service.');
    await until(() => f.host.runtime.setups.list().length === 1);
    const pending = f.host.runtime.setups.list()[0];
    const result = await f.api(`/runs/${run.id}/messages`, 'POST', {
      content: `Here is my API key: ${hidden}`,
    });
    assert.equal(result.data.credentialRequest.id, pending.id);
    assert.equal(result.data.connected, true);
    await until(() => !f.host.runtime.controllers.size);
    assert.equal(f.store.get('runs', run.id)!.status, 'completed');
    assert.equal(
      f.host.runtime.credentials!.capabilities(f.store.get('bots', 'worker2')!).length,
      1,
    );
    assert.ok(!JSON.stringify(f.bodies).includes(hidden));
    assert.ok(!JSON.stringify(f.store.export()).includes(hidden));
  } finally {
    await f.close();
  }
});

test('private entry cancellation is honored without reopening; non-owners cannot enter keys; restart never reopens old requests', async () => {
  let calls = 0;
  const f = await fixture(() =>
    ++calls <= 2
      ? call({ service: 'Netlify', purpose: 'Connect publishing privately' })
      : answer('Private entry was cancelled.'),
  );
  try {
    const operator = f.host.access.issue('Operator', 'operator').token;
    assert.equal(
      (await f.api('/credentials/manager/requests', 'POST', { botId: 'worker1' }, operator)).status,
      403,
    );
    const run = f.host.runtime.create('worker1', 'Connect this service.');
    await until(() => f.host.runtime.setups.list().length === 1);
    const request = f.host.runtime.setups.list()[0];
    assert.equal(
      (await f.api(`/credentials/manager/requests/${request.id}/cancel`, 'POST', {})).status,
      200,
    );
    await until(() => !f.host.runtime.controllers.has(run.id));
    assert.equal(f.host.runtime.setups.list().length, 1);
    assert.equal(calls, 3);
    assert.equal(f.backend.values.size, 0);
    const pending = f.host.runtime.setups.create({ botId: 'worker2', service: 'Example' }, 'human');
    new CredentialSetups(f.store);
    assert.equal(f.store.get('credentialSetups', pending.id)!.status, 'cancelled');
  } finally {
    await f.close();
  }
});

test('archiving preserves profiles/category/history, clears main selection, pauses routines, and restores without starting work', async () => {
  const f = await fixture();
  try {
    const original = f.store.get('bots', 'boss-man')!;
    f.store.setConfig('settings', { ...f.store.settings(), mainBotId: original.id });
    const routine = f.store.all('routines').find((r) => r.botId === original.id)!;
    f.store.put('routines', { ...routine, enabled: true });
    const archived = await f.api(`/bots/${original.id}/archive`, 'POST', {});
    assert.equal(archived.status, 200);
    assert.equal(archived.data.instructions, original.instructions);
    assert.equal(archived.data.categoryId, original.categoryId);
    assert.equal(f.store.settings().mainBotId, null);
    assert.equal(f.store.get('routines', routine.id)!.enabled, false);
    assert.ok(!visibleBots(f.store.all('bots')).some((b) => b.id === original.id));
    assert.throws(() => f.host.runtime.create(original.id, 'hi'), /not available/);
    const backup = f.store.export();
    assert.equal((await f.api('/import', 'POST', backup)).status, 200);
    assert.ok(
      f.store.get('bots', original.id)!.archivedAt,
      'Archive state survives backup restore.',
    );
    assert.equal((await f.api(`/bots/${original.id}/restore`, 'POST', {})).status, 200);
    assert.deepEqual(f.store.get('bots', original.id), original);
    assert.equal(f.store.get('routines', routine.id)!.enabled, false);
    assert.equal(f.bodies.length, 0);
  } finally {
    await f.close();
  }
});

test('delete removes current instructions/memory/routines but keeps attribution/results; active families and non-owners are protected', async () => {
  const f = await fixture();
  try {
    const bot = f.store.get('bots', 'research')!,
      operator = f.host.access.issue('Operator', 'operator').token;
    assert.equal((await f.api(`/bots/${bot.id}`, 'DELETE', {}, operator)).status, 403);
    f.store.put('bots', { ...bot, id: 'clone', prototypeId: bot.id, cloneStatus: 'active' });
    f.store.put('runs', {
      id: 'active-family',
      botId: 'worker1',
      conversationId: 'c',
      prompt: 'Working',
      task: 'general',
      status: 'running',
      startedAt: new Date().toISOString(),
      tokens: 0,
      events: [],
      work: [
        {
          id: 'child',
          botId: 'clone',
          task: 'general',
          urgency: 'relaxed',
          importance: 'normal',
          startedAt: new Date().toISOString(),
          status: 'running',
          attempts: [],
        },
      ],
    });
    assert.equal((await f.api(`/bots/${bot.id}/archive`, 'POST', {})).status, 409);
    assert.equal((await f.api(`/bots/${bot.id}`, 'DELETE', {})).status, 409);
    f.store.put('runs', { ...f.store.get('runs', 'active-family')!, status: 'completed' });
    assert.equal((await f.api(`/bots/${bot.id}`, 'DELETE', {})).status, 200);
    const deleted = f.store.get('bots', bot.id)!;
    assert.ok(deleted.deletedAt);
    assert.equal(deleted.instructions, '');
    assert.deepEqual(deleted.avatar, bot.avatar);
    assert.equal(f.store.all('memory').filter((m) => m.botId === bot.id).length, 0);
    assert.equal(f.store.all('routines').filter((r) => r.botId === bot.id).length, 0);
    assert.ok(!visibleBots(f.store.all('bots')).some((b) => b.id === bot.id));
    assert.equal((await f.api(`/bots/${bot.id}/restore`, 'POST', {})).status, 404);
    const snapshot = f.store.export();
    assert.equal((await f.api('/import', 'POST', snapshot)).status, 200);
    assert.ok(f.store.get('bots', bot.id)!.deletedAt);
  } finally {
    await f.close();
  }
});
