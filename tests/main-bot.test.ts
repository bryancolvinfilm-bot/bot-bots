import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { seedTestTeam as seed } from './fixtures/team';
import { Store } from '../apps/server/store';
import type { Run } from '../packages/shared/types';

const role = 'MAIN DELEGATION BOT — DIRECT HUMAN CONVERSATION:';
const answer = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { total_tokens: 12 },
});
const delegate = (botId: string) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `delegate-${botId}`,
            type: 'function',
            function: {
              name: 'delegate',
              arguments: JSON.stringify({ botId, task: 'Return a concise scoped review.' }),
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { total_tokens: 12 },
});

async function fixture(reply: (body: any) => unknown = () => answer('OK')) {
  mkdirSync('test-results/unit', { recursive: true });
  const dir = mkdtempSync(resolve('test-results/unit/main-bot-'));
  const store = new Store(join(dir, 'team.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  const calls: any[] = [];
  const provider = createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    const body = JSON.parse(text);
    calls.push(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(reply(body)));
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  for (const p of store.all('providers'))
    store.put('providers', {
      ...p,
      autoDiscover: false,
      baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
    });
  const host = createApp(store, dir, resolve('dist/web'));
  const server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', body?: unknown) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    dir,
    store,
    host,
    calls,
    request,
    close: async () => {
      for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
      for (let n = 0; n < 250 && host.runtime.controllers.size; n++)
        await new Promise((r) => setTimeout(r, 10));
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
function done(host: Awaited<ReturnType<typeof fixture>>['host'], run: Run) {
  return new Promise<Run>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Main-bot test timed out')), 10000);
    const listener = (event: any) => {
      if (event.type === 'done') {
        clearTimeout(timer);
        host.runtime.events.off(run.id, listener);
        resolve(event.run);
      }
    };
    host.runtime.events.on(run.id, listener);
  });
}

test('main bot is optional, singular, owner-controlled and validated; role changes preserve profiles and unrelated settings', async () => {
  const f = await fixture();
  try {
    assert.equal(f.store.settings().mainBotId, null);
    const original = f.store.get('bots', 'research')!;
    f.store.put('bots', { ...f.store.get('bots', 'worker3')!, isPrototype: true });
    f.store.put('bots', { ...original, id: 'disabled', enabled: false });
    f.store.put('bots', {
      ...original,
      id: 'temporary',
      prototypeId: 'worker3',
      cloneStatus: 'active',
    });
    for (const botId of ['missing', 'disabled', 'worker3', 'temporary', ''])
      assert.equal((await f.request('/settings/main-bot', 'PUT', { botId })).status, 400, botId);
    assert.equal((await f.request('/settings/main-bot', 'PUT', { botId: 'research' })).status, 200);
    assert.equal(f.store.settings().mainBotId, 'research');
    assert.deepEqual(f.store.get('bots', 'research'), original);
    const legacySettings = { ...f.store.settings() };
    delete legacySettings.mainBotId;
    assert.equal((await f.request('/settings', 'PUT', legacySettings)).status, 200);
    assert.equal(
      f.store.settings().mainBotId,
      'research',
      'Older clients must not accidentally clear the role.',
    );
    assert.equal((await f.request('/settings/main-bot', 'PUT', { botId: 'worker1' })).status, 200);
    assert.equal(f.store.settings().mainBotId, 'worker1');
    assert.equal(f.store.settings().maxOutputTokens, legacySettings.maxOutputTokens);
    assert.equal(
      f.host.access.allowed('operator', { path: '/api/settings/main-bot', method: 'PUT' } as any),
      false,
    );
    assert.equal((await f.request('/settings/main-bot', 'PUT', { botId: null })).status, 200);
    assert.equal(f.store.settings().mainBotId, null);
    assert.equal(f.calls.length, 0, 'Selecting a main bot never wakes it or calls a model.');
  } finally {
    await f.close();
  }
});

test('a directly addressed main bot gets delegation guidance and uses real receipt-backed delegation, without intercepting another bot chat', async () => {
  const f = await fixture((body) => {
    const system = body.messages[0].content;
    if (system.includes('You are Research') && system.includes(role))
      return body.messages.at(-1).role === 'tool'
        ? answer('Actual teammate findings combined.')
        : delegate('worker1');
    return answer('Actual teammate findings.');
  });
  try {
    await f.request('/settings/main-bot', 'PUT', { botId: 'research' });
    const result = await done(
      f.host,
      f.host.runtime.create('research', 'Coordinate a useful scoped review.'),
    );
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.origin, 'chat');
    assert.ok(
      f.calls
        .filter((b) => b.messages[0].content.includes('You are Research'))
        .every((b) => b.messages[0].content.includes(role)),
    );
    assert.ok(
      f.calls
        .filter((b) => b.messages[0].content.includes('You are Worker1'))
        .every((b) => !b.messages[0].content.includes(role)),
    );
    const receipt = f.store.all('deliveries')[0];
    assert.equal(receipt.fromBotId, 'research');
    assert.equal(receipt.toBotId, 'worker1');
    assert.equal(receipt.status, 'completed');
    const priorCalls = f.calls.length;
    const other = await done(
      f.host,
      f.host.runtime.create('worker2', 'Hello, please answer directly.'),
    );
    assert.equal(other.status, 'completed', other.error);
    assert.equal(f.calls.length, priorCalls + 1);
    assert.ok(f.calls.at(-1).messages[0].content.includes('You are Worker2'));
    assert.ok(!f.calls.at(-1).messages[0].content.includes(role));
    assert.equal(f.store.all('deliveries').length, 1);
  } finally {
    await f.close();
  }
});

test('being called by another bot or a routine does not activate the extra main-bot instructions', async () => {
  const f = await fixture((body) =>
    body.messages[0].content.includes('You are Worker2') && body.messages.at(-1).role !== 'tool'
      ? delegate('research')
      : answer('A scoped reply.'),
  );
  try {
    await f.request('/settings/main-bot', 'PUT', { botId: 'research' });
    const delegated = await done(
      f.host,
      f.host.runtime.create('worker2', 'Get a scoped research review.'),
    );
    assert.equal(delegated.status, 'completed', delegated.error);
    const routine =
      f.store.all('routines').find((r) => r.botId === 'research') ?? f.store.all('routines')[0];
    f.store.put('routines', { ...routine, botId: 'research', enabled: false });
    const response = await f.request(`/routines/${routine.id}/run`, 'POST');
    assert.equal(response.status, 202);
    const started = (await response.json()) as Run;
    assert.equal(started.origin, 'routine');
    assert.equal((await done(f.host, started)).status, 'completed');
    assert.ok(f.calls.every((b) => !b.messages[0].content.includes(role)));
    await f.request('/settings/main-bot', 'PUT', { botId: null });
    assert.equal(
      (await done(f.host, f.host.runtime.create('research', 'A normal conversation.'))).status,
      'completed',
    );
    assert.ok(!f.calls.at(-1).messages[0].content.includes(role));
  } finally {
    await f.close();
  }
});

test('selection survives restart/backup restore, and disabling or converting the main bot clears the role without choosing a replacement', async () => {
  const f = await fixture();
  try {
    await f.request('/settings/main-bot', 'PUT', { botId: 'research' });
    const reopened = new Store(f.store.path);
    assert.equal(reopened.settings().mainBotId, 'research');
    reopened.close();
    const backup = f.store.export();
    await f.request('/settings/main-bot', 'PUT', { botId: null });
    assert.equal((await f.request('/import', 'POST', backup)).status, 200);
    assert.equal(f.store.settings().mainBotId, 'research');
    const bot = f.store.get('bots', 'research')!;
    assert.equal(
      (await f.request('/bots/research', 'PUT', { ...bot, enabled: false })).status,
      200,
    );
    assert.equal(f.store.settings().mainBotId, null);
    await f.request('/bots/research', 'PUT', bot);
    assert.equal(f.store.settings().mainBotId, null);
    await f.request('/settings/main-bot', 'PUT', { botId: 'research' });
    assert.equal(
      (await f.request('/bots/research', 'PUT', { ...bot, isPrototype: true })).status,
      200,
    );
    assert.equal(f.store.settings().mainBotId, null);
    backup.bots.find((b) => b.id === 'research')!.enabled = false;
    assert.equal((await f.request('/import', 'POST', backup)).status, 200);
    assert.equal(
      f.store.settings().mainBotId,
      null,
      'Stale backup references never elect an unavailable coordinator.',
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
