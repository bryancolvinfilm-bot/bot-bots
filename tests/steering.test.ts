import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { Computer, type BrowserDriver } from '../apps/server/computer';
import { seedTestTeam as seed } from './fixtures/team';
import type { PreviewDriver } from '../apps/server/preview';
import { Store } from '../apps/server/store';
import { fitContext } from '../apps/server/models';
import { mergeRunState } from '../packages/shared/collaboration';
import type { Run } from '../packages/shared/types';
mkdirSync('test-results/unit', { recursive: true });
const answer = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { total_tokens: 11 },
});
const calls = (...tools: { name: string; args: unknown }[]) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: tools.map((t, n) => ({
          id: `call-${n}`,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        })),
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { total_tokens: 7 },
});
async function fixture(
  handler: (body: any, res: ServerResponse) => void,
  computer?: Computer,
  preview?: PreviewDriver,
) {
  const dir = mkdtempSync(resolve('test-results/unit/steering-')),
    store = new Store(join(dir, 'test.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  for (const provider of store.all('providers'))
    store.put('providers', { ...provider, autoDiscover: false, autoEnableModels: false });
  const model = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      handler(body ? JSON.parse(body) : {}, res);
    });
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  store.put('providers', {
    ...store.all('providers')[0],
    baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  });
  const host = createApp(store, dir, resolve('dist/web'), '', computer, preview);
  async function cleanup() {
    for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
    await until(() => host.runtime.controllers.size === 0);
    await host.terminal.dispose();
    host.computer.dispose();
    host.runtime.events.emit('shutdown');
    model.closeAllConnections();
    await new Promise<void>((r) => model.close(() => r()));
    store.close();
  }
  return { dir, store, host, cleanup };
}
async function until(ready: () => boolean) {
  for (let n = 0; n < 400; n++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Steering test timed out');
}
function finished(runtime: ReturnType<typeof createApp>['runtime'], run: Run) {
  return new Promise<Run>((r) => {
    const listener = (e: any) => {
      if (e.type === 'done') {
        runtime.events.off(run.id, listener);
        r(e.run);
      }
    };
    runtime.events.on(run.id, listener);
  });
}
test('multiple live messages interrupt stale inference, stay ordered, and do not count as model failure', async () => {
  const observed: any[] = [];
  const f = await fixture((body, res) => {
    observed.push(body);
    if (observed.length > 1) res.end(JSON.stringify(answer('blue and concise')));
  });
  let server: ReturnType<typeof f.host.app.listen> | undefined;
  try {
    const run = f.host.runtime.create('worker1', 'Write a long red answer'),
      done = finished(f.host.runtime, run);
    await until(() => observed.length === 1);
    assert.equal(
      f.host.runtime.create('worker1', 'Use blue instead', run.conversationId).id,
      run.id,
    );
    f.host.runtime.create('worker1', 'Keep it concise', run.conversationId);
    const completed = await done;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.steering?.length, 2);
    assert.ok(completed.steering?.every((s) => s.appliedWorkIds.length === 1));
    assert.match(observed.at(-1).messages.at(-2).content, /blue instead/);
    assert.match(observed.at(-1).messages.at(-1).content, /Keep it concise/);
    assert.equal(completed.events.filter((e) => e.kind === 'fallback').length, 0);
    assert.equal(f.store.all('models')[0].status, 'online');
    assert.equal(f.store.all('incidents').length, 0);
    assert.equal(completed.work![0].attempts[0].usageKnown, false);
    assert.deepEqual(
      f.store
        .all('messages')
        .filter((m) => m.role === 'user')
        .map((m) => m.content),
      ['Write a long red answer', 'Use blue instead', 'Keep it concise'],
    );
    server = f.host.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server!.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const restore = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(f.store.export()),
    });
    assert.equal(restore.status, 200, await restore.text());
    assert.equal(f.store.get('runs', run.id)?.steering?.[1].content, 'Keep it concise');
    assert.equal(f.store.all('messages').filter((m) => m.steeringId).length, 2);
    const next = f.host.runtime.create(
      'worker1',
      'A follow-up after completion',
      run.conversationId,
    );
    assert.notEqual(next.id, run.id);
    assert.equal((await finished(f.host.runtime, next)).status, 'completed');
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await f.cleanup();
  }
});
test('steering preserves completed tool work and skips unstarted tools from the old batch', async () => {
  let count = 0,
    previewStarted = false,
    release!: () => void;
  const bodies: any[] = [];
  const preview: PreviewDriver = {
    render: async () => {
      previewStarted = true;
      await new Promise<void>((r) => (release = r));
      return { title: 'Checked', text: 'Actual preview result', errors: [] };
    },
  };
  const f = await fixture(
    (body, res) => {
      bodies.push(body);
      res.end(
        JSON.stringify(
          ++count === 1
            ? calls(
                {
                  name: 'workspace_write',
                  args: { path: 'kept.txt', content: 'Keep this completed action' },
                },
                { name: 'page_preview', args: { id: 'fixture-page' } },
                {
                  name: 'workspace_write',
                  args: { path: 'stale.txt', content: 'Do not execute obsolete work' },
                },
              )
            : answer('Updated answer'),
        ),
      );
    },
    undefined,
    preview,
  );
  try {
    f.store.put('pages', {
      id: 'fixture-page',
      botId: 'worker1',
      title: 'Fixture',
      content: '<p>Hi</p>',
      format: 'html',
      createdAt: new Date().toISOString(),
    });
    const run = f.host.runtime.create('worker1', 'Create the initial files'),
      done = finished(f.host.runtime, run);
    await until(() => previewStarted);
    f.host.runtime.steer(
      run.id,
      'Do not create any more files. Just summarize what is already done.',
    );
    release();
    const result = await done;
    assert.equal(result.status, 'completed');
    assert.equal(existsSync(join(f.dir, 'workspace', 'kept.txt')), true);
    assert.equal(existsSync(join(f.dir, 'workspace', 'stale.txt')), false);
    const messages = bodies[1].messages;
    assert.equal(messages.filter((m: any) => m.role === 'tool').length, 3);
    assert.match(messages.find((m: any) => m.tool_call_id === 'call-2').content, /Not executed/);
    assert.match(messages.at(-1).content, /Just summarize/);
    assert.equal(result.events.filter((e) => e.tool === 'workspace_write').length, 1);
  } finally {
    release?.();
    await f.cleanup();
  }
});
test('live human direction reaches a delegated bot and its coordinator without repeating the handoff', async () => {
  let childCalls = 0,
    rootCalls = 0;
  const seen: any[] = [];
  const f = await fixture((body, res) => {
    seen.push(body);
    const child = body.messages[0].content.startsWith('You are Worker2,');
    if (child) {
      if (++childCalls > 1) res.end(JSON.stringify(answer('Worker used the new budget')));
    } else
      res.end(
        JSON.stringify(
          ++rootCalls === 1
            ? calls({
                name: 'delegate',
                args: { botId: 'worker2', task: 'Compare the first plan' },
              })
            : answer('Coordinator used the new budget'),
        ),
      );
  });
  try {
    const run = f.host.runtime.create('boss-man', 'Compare the plans'),
      done = finished(f.host.runtime, run);
    await until(() => childCalls === 1);
    f.host.runtime.steer(run.id, 'Use a budget of 42 instead.');
    const result = await done;
    assert.equal(result.status, 'completed');
    assert.equal(result.steering?.[0].appliedWorkIds.length, 2);
    assert.equal(rootCalls, 2);
    assert.equal(childCalls, 2);
    assert.ok(
      seen.filter((b) =>
        b.messages.some((m: any) => m.role === 'user' && m.content.includes('budget of 42')),
      ).length >= 2,
    );
    assert.equal(result.events.filter((e) => e.phase === 'delegating').length, 1);
  } finally {
    await f.cleanup();
  }
});
test('a steering message withdraws an old terminal approval without executing or granting a new permission', async () => {
  let count = 0;
  const f = await fixture((_body, res) =>
    res.end(
      JSON.stringify(
        ++count === 1
          ? calls({
              name: 'terminal_request',
              args: { command: "Write-Output 'Must not run'", reason: 'Old plan' },
            })
          : answer('No terminal used'),
      ),
    ),
  );
  try {
    const run = f.host.runtime.create('worker1', 'Propose a command'),
      done = finished(f.host.runtime, run);
    await until(() => f.host.terminal.state().jobs.some((j) => j.status === 'awaiting-approval'));
    const old = f.host.terminal.state().jobs[0];
    f.host.runtime.steer(run.id, 'No commands. Reply in plain text instead.');
    assert.equal((await done).status, 'completed');
    const job = f.store.get('terminal', old.id)!;
    assert.equal(job.status, 'cancelled');
    assert.equal(job.startedAt, undefined);
    assert.equal(job.output, '');
    assert.throws(() => f.host.terminal.decide(job.id, true), /no longer/);
  } finally {
    await f.cleanup();
  }
});
test('steering releases a bot waiting for browser control without taking control away from the human', async () => {
  let actions = 0,
    count = 0;
  const tabs: any[] = [];
  const driver: BrowserDriver = {
    tabs: () => tabs,
    create: (t) => tabs.push(t),
    select: () => {},
    close: () => {},
    dispose: () => {},
    capture: async () => ({ image: '', width: 1, height: 1 }),
    act: async (id) => {
      actions++;
      return { tabId: id, title: 'Page', url: 'https://example.com/', text: '', elements: [] };
    },
  };
  const computer = new Computer(driver);
  computer.setPaused(true);
  const f = await fixture(
    (_body, res) =>
      res.end(
        JSON.stringify(
          ++count === 1
            ? calls({ name: 'browser_open', args: { url: 'https://example.com/' } })
            : answer('Browser no longer needed'),
        ),
      ),
    computer,
  );
  try {
    const run = f.host.runtime.create('worker1', 'Open the browser'),
      done = finished(f.host.runtime, run);
    await until(() => tabs.length === 1);
    f.host.runtime.steer(
      run.id,
      'Stop browsing and answer from the information already available.',
    );
    assert.equal((await done).status, 'completed');
    assert.equal(actions, 0);
    assert.equal(computer.paused, true);
  } finally {
    await f.cleanup();
  }
});
test('a human update renews the bounded tool allowance at the end of a task without replaying completed writes', async () => {
  let count = 0;
  const seen: any[] = [];
  const f = await fixture((body, res) => {
    seen.push(body);
    count++;
    if (count === 2) return;
    res.end(
      JSON.stringify(
        count === 1
          ? calls({
              name: 'workspace_write',
              args: { path: 'first.txt', content: 'Original completed file' },
            })
          : count === 3
            ? calls({
                name: 'workspace_write',
                args: { path: 'second.txt', content: 'Fresh human direction' },
              })
            : answer('Done'),
      ),
    );
  });
  try {
    f.store.setConfig('settings', { ...f.store.settings(), maxToolSteps: 1 });
    const run = f.host.runtime.create('worker1', 'Write the first file'),
      done = finished(f.host.runtime, run);
    await until(() => count === 2);
    f.host.runtime.steer(run.id, 'Also create a second file now.');
    assert.equal((await done).status, 'completed');
    assert.equal(count, 4);
    assert.ok(seen[1].tools.length > 0);
    assert.ok(seen[2].tools.length > 0);
    assert.equal(existsSync(join(f.dir, 'workspace', 'first.txt')), true);
    assert.equal(existsSync(join(f.dir, 'workspace', 'second.txt')), true);
    assert.equal(f.store.all('pages').filter((p) => p.filename === 'first.txt').length, 1);
  } finally {
    await f.cleanup();
  }
});
test('older snapshots cannot erase steering uptake, and a newly created run is not confused with a rated previous one', () => {
  const base = {
    id: 'run',
    botId: 'worker1',
    conversationId: 'c',
    prompt: 'Task',
    task: 'general' as const,
    status: 'running' as const,
    startedAt: new Date().toISOString(),
    tokens: 0,
    events: [],
    revision: 1,
  };
  const latest = {
    ...base,
    revision: 3,
    steering: [
      {
        id: 's',
        messageId: 'm',
        content: 'Update',
        createdAt: base.startedAt,
        appliedWorkIds: ['work'],
      },
    ],
  };
  assert.equal(mergeRunState(latest, base), latest);
  const next = { ...base, id: 'new-run' };
  assert.equal(mergeRunState({ ...latest, feedbackRevision: 5 }, next), next);
});
test('context trimming cannot split completed tool calls from their results after a live steering message', () => {
  const chain = [
    { role: 'user', content: 'Original task' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'saved',
          type: 'function' as const,
          function: { name: 'workspace_write', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'saved', content: 'File already created' },
    { role: 'user', content: 'Now make it blue' },
  ];
  const context = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Old history '.repeat(2000) },
    { role: 'assistant', content: 'Previous completed answer '.repeat(2000) },
    ...chain,
  ];
  const fitted = fitContext(context, [], 4096, 512);
  assert.deepEqual(fitted, [context[0], ...chain]);
  assert.throws(
    () =>
      fitContext(
        [
          { role: 'system', content: 'System' },
          ...chain.map((m) => ({ ...m, content: (m.content ?? '') + 'x'.repeat(9000) })),
        ],
        [],
        4096,
        512,
      ),
    /context window/,
  );
});
