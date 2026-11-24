import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { Store } from '../apps/server/store';
import { seedTestTeam as seed } from './fixtures/team';
import { GooglePlugin } from '../apps/server/google';
import { SecretVault } from '../apps/server/secret-vault';
import {
  applyCompaction,
  compactionPlan,
  migrateTeam,
  phraseSuggestions,
  tasksFor,
  undoCompaction,
} from '../apps/server/team';
import { Semaphore } from '../apps/server/semaphore';
import { progressPosition, visibleBots } from '../packages/shared/team';
import { assessRuns } from '../packages/shared/experience';
import { workLabel } from '../packages/shared/activity';
import type { Run, WorkRecord } from '../packages/shared/types';
mkdirSync('test-results/unit', { recursive: true });
function storage() {
  const dir = mkdtempSync(resolve('test-results/unit/team-v2-')),
    store = new Store(join(dir, 'test.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  for (const provider of store.all('providers'))
    store.put('providers', { ...provider, autoDiscover: false, autoEnableModels: false });
  return { dir, store };
}
async function until(ready: () => boolean) {
  for (let i = 0; i < 600; i++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Team-v2 test timeout');
}
const answer = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { total_tokens: 10 },
});
const call = (name: string, args: unknown) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c', type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { total_tokens: 8 },
});
async function fixture(handler: (body: any, res: ServerResponse) => unknown) {
  const { dir, store } = storage();
  const model = createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    const result = handler(JSON.parse(text || '{}'), res);
    if (result !== undefined) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    }
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  store.put('providers', {
    ...store.all('providers')[0],
    baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  });
  const host = createApp(store, dir, resolve('dist/web'));
  return {
    dir,
    store,
    host,
    async cleanup() {
      for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
      await until(() => host.runtime.controllers.size === 0);
      host.google.cancelRun();
      await host.terminal.dispose();
      host.computer.dispose();
      host.runtime.events.emit('shutdown');
      model.closeAllConnections();
      await new Promise<void>((r) => model.close(() => r()));
      store.close();
    },
  };
}
function done(host: Awaited<ReturnType<typeof fixture>>['host'], run: Run) {
  return new Promise<Run>((resolve) => {
    const listener = (e: any) => {
      if (e.type === 'done') {
        host.runtime.events.off(run.id, listener);
        resolve(e.run);
      }
    };
    host.runtime.events.on(run.id, listener);
  });
}

test('compaction protects formation/core/recent information, estimates real record deltas, and supports guarded undo', () => {
  const { store } = storage();
  try {
    migrateTeam(store);
    const bot = store.all('bots')[0];
    const originalIds = new Set(store.all('memory').map((m) => m.id));
    for (let i = 0; i < 40; i++)
      store.put('memory', {
        id: `memory-${i}`,
        botId: bot.id,
        category: i === 12 ? 'behavior' : 'world',
        content: `Memory ${i}: ${'Repeated detail '.repeat(300)}`,
        createdAt: new Date(1700000000000 + i * 1000).toISOString(),
        pinned: i === 15,
      });
    for (let i = 0; i < 35; i++)
      store.put('tasks', {
        id: `task-${i}`,
        runId: 'run',
        conversationId: 'conversation',
        botId: bot.id,
        botName: bot.name,
        avatar: bot.avatar,
        task: 'research',
        prompt: `Job ${i}: ${'Earlier brief '.repeat(200)}`,
        result: 'Detailed result '.repeat(500),
        status: 'completed',
        startedAt: new Date(1700000000000 + i * 1000).toISOString(),
        tokens: 100,
        memoryIds: [],
        milestones: [],
      });
    assert.equal(compactionPlan(store, bot.id, 0).records, 0);
    const plan = compactionPlan(store, bot.id, 100);
    assert.ok(plan.records > 20);
    assert.ok(plan.activeBytesSaved > 10000);
    assert.ok(plan.estimatedNetBytesSaved > 0);
    const snapshot = JSON.stringify(store.all('memory')),
      result = applyCompaction(store, bot.id, 100, plan.hash);
    assert.ok(!store.get('tasks', 'task-0')?.compacted);
    assert.ok(!store.get('tasks', 'task-34')?.compacted);
    assert.ok(!store.get('memory', 'memory-12')?.compacted);
    assert.ok(!store.get('memory', 'memory-15')?.compacted);
    assert.ok(store.get('tasks', 'task-8')?.compacted);
    for (const id of originalIds) assert.ok(store.get('memory', id));
    undoCompaction(store, result.id);
    assert.equal(JSON.stringify(store.all('memory')), snapshot);
    assert.ok(!store.get('tasks', 'task-8')?.compacted);
    const second = compactionPlan(store, bot.id, 100);
    store.put('memory', { ...store.get('memory', 'memory-8')!, content: 'A new human edit' });
    assert.throws(() => applyCompaction(store, bot.id, 100, second.hash), /History changed/);
  } finally {
    store.close();
  }
});

test('phrase suggestions use instructions, history and routines; personal wording respects the current activity', () => {
  const { store } = storage();
  try {
    const bot = {
      ...store.get('bots', 'worker1')!,
      processingPhrases: { coding: ['Cracking knuckles'] },
    };
    store.put('bots', bot);
    const suggested = phraseSuggestions(store, bot);
    assert.ok(suggested.phrases.coding?.includes('Rolling up sleeves'));
    assert.equal(suggested.basis.instructions, true);
    const work = {
      phase: 'thinking' as const,
      task: 'coding' as const,
      since: new Date().toISOString(),
      runId: 'r',
      botId: bot.id,
      detail: '',
    };
    assert.equal(workLabel(work, bot.id, Date.now(), bot), 'Cracking knuckles');
    assert.notEqual(
      workLabel({ ...work, phase: 'tool', tool: 'web_search' }, bot.id, Date.now(), bot),
      'Cracking knuckles',
    );
  } finally {
    store.close();
  }
});

test('restart recovery retires cloned workers and closes unfinished task journals without resuming them', () => {
  const { dir, store } = storage();
  const prototype = store.get('bots', 'worker3')!;
  store.put('bots', {
    ...prototype,
    id: 'interrupted-clone',
    prototypeId: prototype.id,
    isPrototype: false,
    cloneStatus: 'active',
    cloneTaskId: 'interrupted-task',
  });
  store.put('tasks', {
    id: 'interrupted-task',
    runId: 'interrupted-run',
    conversationId: 'c',
    botId: 'interrupted-clone',
    botName: 'Worker',
    avatar: prototype.avatar,
    prototypeId: prototype.id,
    task: 'coding',
    prompt: 'Interrupted work',
    status: 'running',
    startedAt: new Date().toISOString(),
    tokens: 0,
    memoryIds: [],
    milestones: [],
  });
  const host = createApp(store, dir, resolve('dist/web'));
  try {
    assert.equal(store.get('bots', 'interrupted-clone')?.cloneStatus, 'retired');
    assert.equal(store.get('tasks', 'interrupted-task')?.status, 'failed');
    assert.match(store.get('tasks', 'interrupted-task')?.error ?? '', /No work resumed/);
    assert.equal(host.runtime.controllers.size, 0);
  } finally {
    host.computer.dispose();
    host.runtime.events.emit('shutdown');
    store.close();
  }
});

test('progress never reaches completion from elapsed time or an estimate alone', () => {
  const w: WorkRecord = {
    id: 'w',
    botId: 'worker1',
    task: 'coding',
    urgency: 'relaxed',
    importance: 'normal',
    status: 'running',
    startedAt: new Date(0).toISOString(),
    attempts: [],
  };
  assert.ok(progressPosition(w, Date.now()).percent < 100);
  assert.equal(progressPosition({ ...w, status: 'completed' }, 1).percent, 100);
  assert.equal(
    progressPosition(
      {
        ...w,
        progress: {
          percent: 95,
          label: 'Waiting at the review milestone',
          milestones: [{ label: 'Review', percent: 60 }],
          updatedAt: new Date().toISOString(),
        },
      },
      Date.now(),
    ).percent,
    95,
  );
});

test('legacy runs without work records appear in history without duplicating results on restart', () => {
  const { store } = storage();
  try {
    const now = new Date().toISOString();
    store.put('runs', {
      id: 'legacy-run',
      botId: 'worker1',
      conversationId: 'old-c',
      prompt: 'Earlier job',
      task: 'writing',
      status: 'completed',
      startedAt: now,
      finishedAt: now,
      tokens: 13,
      events: [],
    });
    store.put('messages', {
      id: 'old-reply',
      botId: 'worker1',
      conversationId: 'old-c',
      runId: 'legacy-run',
      role: 'assistant',
      content: 'A real earlier result',
      createdAt: now,
    });
    migrateTeam(store);
    migrateTeam(store);
    const history = tasksFor(store, 'worker1');
    assert.equal(history.length, 1);
    assert.equal(history[0].result, 'A real earlier result');
    assert.equal(history[0].id, 'legacy-legacy-run');
  } finally {
    store.close();
  }
});

test('bounded inference releases slots on cancellation without running queued work', async () => {
  const gate = new Semaphore(() => 2),
    controller = new AbortController();
  let active = 0,
    max = 0,
    called = 0;
  let release!: () => void;
  const block = new Promise<void>((r) => (release = r));
  const work = () => {
    called++;
    active++;
    max = Math.max(max, active);
    return block.finally(() => {
      active--;
    });
  };
  const first = gate.use(new AbortController().signal, work),
    second = gate.use(new AbortController().signal, work);
  const third = gate.use(controller.signal, work);
  controller.abort(Error('cancelled'));
  await assert.rejects(third, /cancelled/);
  release();
  await Promise.all([first, second]);
  assert.equal(max, 2);
  assert.equal(called, 2);
  await gate.use(new AbortController().signal, async () => {});
});

test('prototype workers collaborate, retain results/learning by task ID, then disappear from the active roster', async () => {
  const f = await fixture((body) => {
    const system = body.messages[0].content,
      last = body.messages.at(-1);
    if (system.includes('You are Boss Man'))
      return last.role === 'tool'
        ? answer('Both findings received')
        : call('delegate_workers', {
            prototypeId: 'worker3',
            tasks: [
              'ALPHA: save one useful world memory and report ALPHA RESULT',
              'BETA: report BETA RESULT',
            ],
          });
    if (system.includes('PROTOTYPE COORDINATOR:'))
      return answer('Refactored best-of: ALPHA RESULT and BETA RESULT.');
    if (last.role === 'tool') return answer('ALPHA RESULT');
    return body.messages.some((m: any) => m.content?.includes('ALPHA:'))
      ? call('memory_save', { category: 'world', content: 'The ALPHA finding is durable.' })
      : answer('BETA RESULT');
  });
  try {
    const prototype = {
      ...f.store.get('bots', 'worker3')!,
      isPrototype: true,
      processingPhrases: { coding: ['Cracking knuckles'] },
    };
    f.store.put('bots', prototype);
    const finished = await done(f.host, f.host.runtime.create('boss-man', 'Use two worker clones'));
    assert.equal(finished.status, 'completed', finished.error);
    const clones = f.store.all('bots').filter((b) => b.prototypeId === prototype.id);
    assert.equal(clones.length, 2);
    assert.ok(clones.every((b) => b.cloneStatus === 'retired' && !b.enabled));
    assert.ok(clones.every((b) => b.modelId === prototype.modelId && b.instructions === ''));
    assert.equal(visibleBots(f.store.all('bots')).filter((b) => b.prototypeId).length, 0);
    const tasks = tasksFor(f.store, prototype.id).filter(
      (task) => task.prototypeId === prototype.id,
    );
    assert.match(
      tasksFor(f.store, prototype.id).find((task) => task.botId === prototype.id)!.result!,
      /ALPHA RESULT and BETA RESULT/,
    );
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t) => t.status === 'completed' && t.result));
    assert.ok(tasks.some((t) => t.memoryIds.length === 1));
    assert.ok(tasks.every((t) => clones.some((c) => c.cloneTaskId === t.id)));
    assert.equal(
      finished.events.filter((e) => e.kind === 'handoff' && e.handoff?.status === 'completed')
        .length,
      3,
    );
  } finally {
    await f.cleanup();
  }
});

test('cancelling a team retires running and queued clones and keeps their task results', async () => {
  const f = await fixture((body) =>
    body.messages[0].content.includes('You are Boss Man')
      ? call('delegate_workers', {
          prototypeId: 'worker3',
          tasks: Array.from({ length: 8 }, (_, i) => `Task ${i}`),
        })
      : undefined,
  );
  try {
    f.store.put('bots', { ...f.store.get('bots', 'worker3')!, isPrototype: true });
    const run = f.host.runtime.create('boss-man', 'Start eight clones'),
      finished = done(f.host, run);
    await until(() => f.store.all('bots').filter((b) => b.prototypeId).length === 8);
    const active = f.store.all('bots').find((b) => b.prototypeId)!;
    assert.throws(() => f.host.runtime.create(active.id, 'Do a second job'), /already assigned/);
    f.host.runtime.cancel(run.id);
    assert.equal((await finished).status, 'cancelled');
    assert.equal(f.store.all('bots').filter((b) => b.cloneStatus === 'active').length, 0);
    assert.equal(tasksFor(f.store, 'worker3').length, 9);
    assert.ok(tasksFor(f.store, 'worker3').every((t) => t.status === 'cancelled'));
  } finally {
    await f.cleanup();
  }
});

test('prototypes reject direct human chat and launch no standalone worker', async () => {
  const f = await fixture(() => answer('Should not run'));
  try {
    f.store.put('bots', { ...f.store.get('bots', 'worker3')!, isPrototype: true });
    assert.throws(
      () => f.host.runtime.create('worker3', 'Do one task'),
      /Ask another bot to delegate/,
    );
    assert.equal(f.store.all('bots').filter((bot) => bot.prototypeId).length, 0);
    assert.equal(tasksFor(f.store, 'worker3').length, 0);
  } finally {
    await f.cleanup();
  }
});

test('Google OAuth uses PKCE/state, honors granular grants, refreshes once and keeps secrets out of backups', async () => {
  const { dir, store } = storage();
  let tokenCalls = 0;
  let holdNext = false,
    held: ServerResponse | undefined;
  const requests: { url: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url!, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/token') {
      tokenCalls++;
      if (holdNext) {
        holdNext = false;
        held = res;
        return;
      }
      res.end(
        JSON.stringify({
          access_token: 'ACCESS_SECRET',
          refresh_token: 'REFRESH_SECRET',
          expires_in: 3600,
          scope:
            'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
        }),
      );
    } else if (req.url === '/userinfo')
      res.end(
        JSON.stringify({ sub: 'account-1', email: 'owner@example.com', email_verified: true }),
      );
    else if (req.url?.includes('/messages/send')) res.end(JSON.stringify({ id: 'SENT_RECEIPT' }));
    else res.end(JSON.stringify({ messages: [{ id: 'one' }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    vault = new SecretVault(join(dir, 'secrets')),
    google = new GooglePlugin(store, vault, {
      authorize: `${origin}/authorize`,
      token: `${origin}/token`,
      revoke: `${origin}/revoke`,
      api: () => origin,
    });
  try {
    google.configure(
      {
        installed: true,
        clientType: 'desktop',
        clientId: 'public-client',
        redirectUri: 'http://127.0.0.1:3211/oauth/google/callback',
        permissions: {
          'gmail.search': { enabled: true, botIds: ['worker3'] },
          'gmail.send': { enabled: true, botIds: ['worker3'] },
          'sheets.read': { enabled: true, botIds: ['worker3'] },
        },
      },
      'CLIENT_SECRET',
    );
    const start = google.authorize(),
      url = new URL(start.url);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    await assert.rejects(google.callback('wrong', 'code'), /expired/);
    await google.callback(url.searchParams.get('state')!, 'CODE');
    await assert.rejects(google.callback(url.searchParams.get('state')!, 'CODE'), /expired/);
    const exchange = new URLSearchParams(requests[0].body);
    assert.equal(
      createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'),
      url.searchParams.get('code_challenge'),
    );
    assert.ok(google.state().needsAuthorization.includes('sheets.read'));
    await assert.rejects(
      google.read('gmail.search', { query: 'hello' }, 'worker1', new AbortController().signal),
      /permission/,
    );
    await google.read('gmail.search', { query: 'hello' }, 'worker3', new AbortController().signal);
    vault.write({ ...vault.read(), expiresAt: 0 });
    await Promise.all([
      google.read('gmail.search', { query: 'one' }, 'worker3', new AbortController().signal),
      google.read('gmail.search', { query: 'two' }, 'worker3', new AbortController().signal),
    ]);
    assert.equal(tokenCalls, 2);
    const controller = new AbortController(),
      pending = google.request(
        'gmail.send',
        { to: ['friend@example.com'], subject: 'Original subject', body: 'Original body' },
        'worker3',
        'run',
        controller.signal,
      );
    const request = store.all('pluginActions')[0];
    assert.equal(request.status, 'awaiting-approval');
    assert.equal(requests.filter((r) => r.url.includes('messages/send')).length, 0);
    store.put('pluginActions', { ...request, params: { ...request.params, subject: 'TAMPERED' } });
    await google.decide(request.id, true);
    assert.equal((await pending).status, 'completed');
    const sent = JSON.parse(requests.find((r) => r.url.includes('messages/send'))!.body);
    const mime = Buffer.from(sent.raw, 'base64url').toString();
    assert.ok(mime.includes(Buffer.from('Original subject').toString('base64')));
    assert.ok(!mime.includes('TAMPERED'));
    await assert.rejects(google.decide(request.id, true), /no longer/);
    const waiting = google.request(
      'gmail.send',
      { to: ['friend@example.com'], subject: 'Wait', body: 'Wait' },
      'worker3',
      'cancel-run',
      controller.signal,
    );
    google.cancelRun('cancel-run');
    assert.equal((await waiting).status, 'cancelled');
    const exported = JSON.stringify(store.export());
    for (const secret of ['ACCESS_SECRET', 'REFRESH_SECRET', 'CLIENT_SECRET']) {
      assert.ok(!exported.includes(secret));
      assert.ok(!readFileSync(join(dir, 'secrets', 'google.vault'), 'utf8').includes(secret));
    }
    vault.write({ ...vault.read(), expiresAt: 0 });
    holdNext = true;
    const oldRefresh = google.read(
      'gmail.search',
      { query: 'in flight' },
      'worker3',
      new AbortController().signal,
    );
    const rejected = assert.rejects(oldRefresh, /authorization changed/);
    await until(() => !!held);
    await google.disconnect();
    held!.end(
      JSON.stringify({
        access_token: 'MUST_NOT_RECONNECT',
        refresh_token: 'OLD_REFRESH',
        expires_in: 3600,
      }),
    );
    await rejected;
    assert.equal(google.state().connected, false);
    assert.ok(!JSON.stringify(vault.read()).includes('MUST_NOT_RECONNECT'));
  } finally {
    google.cancelRun();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test('owner login, one-use pairing and scoped revocable API keys protect a public host even through loopback', async () => {
  const f = await fixture(() => answer('A remote task result'));
  const server = f.host.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  try {
    assert.equal(
      (
        await request('/api/access/setup', 'POST', {
          username: 'owner',
          password: 'a long unique password',
        })
      ).status,
      200,
    );
    const key = await (
      await request('/api/access/keys', 'POST', { name: 'Phone progress', role: 'viewer' })
    ).json();
    const operator = await (
      await request('/api/access/keys', 'POST', { name: 'Task submitter', role: 'operator' })
    ).json();
    const pair = await (await request('/api/access/pairing', 'POST', { role: 'viewer' })).json();
    const exposed = await request('/api/access/public-url', 'PUT', {
      url: 'https://bots.example.test',
    });
    const cookie = exposed.headers.get('set-cookie')!.split(';')[0];
    assert.equal(exposed.status, 200);
    assert.equal((await request('/api/bootstrap')).status, 401);
    const proxied = await new Promise<{ status: number; body: string; cookies: string[] }>(
      (resolve, reject) => {
        const req = httpRequest(
          `${base}/auth/login`,
          {
            method: 'POST',
            headers: {
              Host: 'bots.example.test',
              Origin: 'https://bots.example.test',
              'Content-Type': 'application/json',
            },
          },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () =>
              resolve({ status: res.statusCode!, body, cookies: res.headers['set-cookie'] ?? [] }),
            );
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ username: 'owner', password: 'a long unique password' }));
      },
    );
    assert.equal(proxied.status, 200, proxied.body);
    assert.ok(proxied.cookies[0]?.includes('Secure'));
    assert.equal(
      (await request('/api/bootstrap', 'GET', undefined, { 'x-forwarded-for': '203.0.113.1' }))
        .status,
      401,
    );
    assert.equal(
      (await request('/api/bootstrap', 'GET', undefined, { Authorization: `Bearer ${key.token}` }))
        .status,
      200,
    );
    assert.equal(
      (
        await request(
          '/api/runs',
          'POST',
          { botId: 'worker1', prompt: 'Unauthorized' },
          { Authorization: `Bearer ${key.token}` },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          '/api/plugins/google',
          'PUT',
          {},
          { Authorization: `Bearer ${operator.token}` },
        )
      ).status,
      403,
    );
    const paired = await request('/auth/pair', 'POST', { code: pair.code, name: 'Phone' });
    assert.equal(paired.status, 200);
    const pairedCookie = paired.headers.get('set-cookie')!.split(';')[0];
    assert.equal(
      (await request('/api/bootstrap', 'GET', undefined, { Cookie: pairedCookie })).status,
      200,
    );
    assert.ok(
      (await request('/auth/pair', 'POST', { code: pair.code, name: 'Second phone' })).status >=
        400,
    );
    const logged = await request('/auth/login', 'POST', {
      username: 'owner',
      password: 'a long unique password',
    });
    assert.equal(logged.status, 200);
    assert.ok(logged.headers.get('set-cookie')?.includes('HttpOnly'));
    const loginCookie = logged.headers.get('set-cookie')!.split(';')[0];
    assert.equal(
      (await request('/api/access', 'GET', undefined, { Cookie: loginCookie })).status,
      200,
    );
    await request(`/api/access/keys/${key.id}`, 'DELETE', undefined, { Cookie: cookie });
    assert.equal(
      (await request('/api/bootstrap', 'GET', undefined, { Authorization: `Bearer ${key.token}` }))
        .status,
      401,
    );
    const exported = JSON.stringify(f.store.export());
    assert.ok(!exported.includes(key.token));
    assert.ok(!exported.includes('a long unique password'));
    assert.ok(!exported.includes('access-owner'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('human ratings from temporary workers teach their prototype without inventing quality votes', () => {
  const run: Run = {
    id: 'run',
    botId: 'boss-man',
    conversationId: 'c',
    task: 'coding',
    prompt: 'work',
    status: 'completed',
    startedAt: '2026-11-21T00:00:00Z',
    tokens: 5,
    events: [],
    work: [
      {
        id: 'task',
        botId: 'temporary-worker',
        prototypeId: 'worker3',
        task: 'coding',
        urgency: 'relaxed',
        importance: 'normal',
        status: 'completed',
        startedAt: '2026-11-21T00:00:00Z',
        finishedAt: '2026-11-21T00:00:05Z',
        modelId: 'qwen',
        feedback: {
          rating: 5,
          timing: 'worth-the-wait',
          note: 'Good work',
          updatedAt: '2026-11-21T00:00:06Z',
        },
        attempts: [
          {
            modelId: 'qwen',
            startedAt: '2026-11-21T00:00:00Z',
            status: 'completed',
            modelTimeMs: 5000,
            tokens: 5,
            usageKnown: true,
            calls: 1,
          },
        ],
      },
    ],
  };
  const assessments = assessRuns([run]);
  assert.equal(assessments.find((a) => a.botId === 'worker3')?.average, 5);
  assert.equal(
    assessments.some((a) => a.botId === 'temporary-worker'),
    false,
  );
});
