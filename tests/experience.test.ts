import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { seedTestTeam as seed } from './fixtures/team';
import { candidates } from '../apps/server/models';
import { Store } from '../apps/server/store';
import { assessRuns, workMetrics } from '../packages/shared/experience';
import type { Run, WorkRecord } from '../packages/shared/types';

mkdirSync('test-results/unit', { recursive: true });
function fixture() {
  const dir = mkdtempSync(resolve('test-results/unit/experience-'));
  const store = new Store(join(dir, 'test.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  for (const provider of store.all('providers'))
    store.put('providers', { ...provider, autoDiscover: false, autoEnableModels: false });
  return { dir, store };
}
function job(id: string, modelId: string, botId: string, rating?: number, ms = 1000): Run {
  const startedAt = '2026-11-21T10:00:00.000Z',
    finishedAt = new Date(Date.parse(startedAt) + ms).toISOString();
  return {
    id,
    botId,
    conversationId: 'test',
    prompt: 'Write a draft',
    task: 'writing',
    status: 'completed',
    startedAt,
    finishedAt,
    tokens: 10,
    events: [],
    modelId,
    work: [
      {
        id: `${id}-work`,
        botId,
        task: 'writing',
        urgency: 'relaxed',
        importance: 'normal',
        startedAt,
        finishedAt,
        status: 'completed',
        modelId,
        attempts: [
          {
            modelId,
            startedAt,
            finishedAt,
            status: 'completed',
            modelTimeMs: ms,
            tokens: 10,
            usageKnown: true,
            calls: 1,
          },
        ],
        feedback: rating
          ? { rating, timing: 'unspecified', note: '', updatedAt: finishedAt }
          : undefined,
      },
    ],
  };
}
test('human quality leads price, priority, task declarations and speed; bot-specific votes override model-wide votes', () => {
  const { store } = fixture();
  try {
    const base = store.all('models')[0];
    store.put('models', {
      ...base,
      id: 'cheap',
      tasks: ['writing'],
      costPerMillion: 0,
      priority: 0,
    });
    store.put('models', {
      ...base,
      id: 'liked',
      tasks: ['general'],
      costPerMillion: 9999,
      priority: 1000,
    });
    store.put('models', { ...base, enabled: false });
    store.put('runs', job('one-human-vote', 'liked', 'worker1', 5, 60000));
    store.put('runs', job('cheaper-faster', 'cheap', 'worker1', 3, 500));
    assert.equal(
      candidates(store, 'writing', null, { botId: 'worker1', urgency: 'urgent' })[0].id,
      'liked',
    );
    store.put('runs', job('different-bot', 'liked', 'worker2', 1));
    assert.equal(candidates(store, 'writing', null, { botId: 'worker2' })[0].id, 'cheap');
    assert.equal(candidates(store, 'writing', 'cheap', { botId: 'worker1' })[0].id, 'cheap');
    store.put('models', { ...store.get('models', 'liked')!, status: 'offline' });
    assert.equal(candidates(store, 'writing', null, { botId: 'worker1' })[0].id, 'cheap');
    store.put('models', { ...store.get('models', 'cheap')!, enabled: false });
    assert.deepEqual(
      candidates(store, 'writing').map((m) => m.id),
      ['liked'],
    );
  } finally {
    store.close();
  }
});
test('relaxed jobs never penalize slowness; explicit urgency uses measured speed only among equally rated choices', () => {
  const { store } = fixture();
  try {
    const base = store.all('models')[0];
    store.put('models', { ...base, id: 'slow', tasks: ['writing'], priority: 0 });
    store.put('models', { ...base, id: 'fast', tasks: ['writing'], priority: 100 });
    store.put('models', { ...base, enabled: false });
    for (let n = 0; n < 3; n++) {
      store.put('runs', job(`slow-${n}`, 'slow', 'worker1', 4, 60000));
      store.put('runs', job(`fast-${n}`, 'fast', 'worker1', 4, 1000));
    }
    assert.equal(candidates(store, 'writing', null, { botId: 'worker1' })[0].id, 'slow');
    assert.equal(
      candidates(store, 'writing', null, { botId: 'worker1', urgency: 'relaxed' })[0].id,
      'slow',
    );
    assert.equal(
      candidates(store, 'writing', null, { botId: 'worker1', urgency: 'soon' })[0].id,
      'fast',
    );
    assert.equal(
      candidates(store, 'writing', null, { botId: 'worker1', urgency: 'urgent' })[0].id,
      'fast',
    );
    store.put('runs', job('preferred-slow', 'slow', 'worker1', 5, 80000));
    assert.equal(
      candidates(store, 'writing', null, { botId: 'worker1', urgency: 'urgent' })[0].id,
      'slow',
    );
  } finally {
    store.close();
  }
});
test('delegates and fallback attempts retain their own credit; unknown token counts and unrated successes stay unknown', () => {
  const run = job('root', 'winner', 'boss-man', 5, 10000);
  const root = run.work![0];
  root.attempts.unshift({
    ...root.attempts[0],
    modelId: 'failed',
    status: 'failed',
    usageKnown: false,
    tokens: 0,
  });
  const child: WorkRecord = {
    ...structuredClone(root),
    id: 'child',
    botId: 'worker2',
    handoffId: 'handoff',
    modelId: 'child-model',
    feedback: undefined,
    attempts: [{ ...root.attempts[1], modelId: 'child-model', usageKnown: false, tokens: 0 }],
  };
  run.work!.push(child);
  const rows = assessRuns([run]);
  const global = rows.filter((a) => !a.botId);
  assert.equal(global.find((a) => a.modelId === 'winner')?.average, 5);
  assert.equal(global.find((a) => a.modelId === 'failed')?.samples, 0);
  assert.equal(global.find((a) => a.modelId === 'failed')?.failures, 1);
  assert.equal(global.find((a) => a.modelId === 'child-model')?.samples, 0);
  assert.equal(global.find((a) => a.modelId === 'child-model')?.averageTokens, undefined);
  assert.equal(workMetrics(root).usageKnown, false);
  const legacy = { ...run, id: 'legacy', work: undefined, tokens: 9999, rating: 4 };
  assert.equal(assessRuns([legacy])[0].average, 4);
  assert.equal(assessRuns([legacy])[0].averageTokens, undefined);
});
test('runtime measures real calls; human feedback, corrected task, clear, report and backup restore round-trip', async () => {
  const { store, dir } = fixture();
  let count = 0;
  const modelServer = createServer(async (_req, res) => {
    for await (const _ of _req) {
      /* drain */
    }
    count++;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Actual result' } }],
        ...(count === 1 ? { usage: { total_tokens: 23 } } : {}),
      }),
    );
  });
  await new Promise<void>((r) => modelServer.listen(0, '127.0.0.1', r));
  store.put('providers', {
    ...store.all('providers')[0],
    baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`,
  });
  const { app, runtime } = createApp(store, dir, resolve('dist/web'), '');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function request(path: string, method: string, body?: unknown) {
    return fetch(`${url}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  function finish(run: Run) {
    return new Promise<Run>((r) =>
      runtime.events.on(run.id, (event) => {
        if (event.type === 'done') r(event.run);
      }),
    );
  }
  try {
    const first = (await (
      await request('/runs', 'POST', {
        botId: 'worker1',
        prompt: 'Write a draft',
        urgency: 'urgent',
        importance: 'high',
        task: 'planning',
      })
    ).json()) as Run;
    const done = await finish(first),
      work = done.work![0];
    assert.equal(work.urgency, 'urgent');
    assert.equal(work.importance, 'high');
    assert.equal(work.task, 'planning');
    assert.equal(work.attempts[0].tokens, 23);
    assert.equal(work.attempts[0].usageKnown, true);
    assert.ok(work.attempts[0].modelTimeMs >= 0);
    assert.equal(work.attempts[0].calls, 1);
    const payload = {
      rating: 5,
      workId: work.id,
      timing: 'worth-the-wait',
      note: 'Great | drafting\nSlow is fine.',
      task: 'writing',
    };
    const rated = (await (
      await request(`/runs/${done.id}/rating`, 'PATCH', payload)
    ).json()) as Run;
    assert.equal(rated.task, 'writing');
    assert.equal(rated.taskSource, 'human');
    assert.equal(rated.work![0].feedback?.note, payload.note);
    let row = store.assessments().find((a) => a.botId === 'worker1' && a.task === 'writing')!;
    assert.equal(row.samples, 1);
    assert.equal(row.worthTheWait, 1);
    assert.equal(row.averageTokens, 23);
    const report = await fetch(`${url}/experience/report`);
    assert.equal(report.status, 200);
    assert.match(await report.text(), /Great \\\| drafting Slow is fine/);
    assert.match(
      readFileSync(join(dir, 'model-experience.md'), 'utf8'),
      /Human quality ratings take priority/,
    );
    const exported = await (await fetch(`${url}/export`)).json();
    await request(`/runs/${done.id}/rating`, 'PATCH', { rating: null, workId: work.id });
    assert.equal(store.get('runs', done.id)?.work?.[0].feedback, undefined);
    assert.equal((await request('/import', 'POST', exported)).status, 200);
    assert.equal(store.get('runs', done.id)?.work?.[0].feedback?.rating, 5);
    const second = runtime.create('worker1', 'Hello');
    const secondDone = await finish(second);
    assert.equal(secondDone.urgency, 'relaxed');
    assert.equal(secondDone.importance, 'normal');
    assert.equal(secondDone.work![0].attempts[0].usageKnown, false);
    assert.equal((await request(`/runs/${done.id}/rating`, 'PATCH', { rating: 6 })).status, 400);
  } finally {
    runtime.events.emit('shutdown');
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => modelServer.close(() => r()));
    store.close();
  }
});
