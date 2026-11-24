import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { readChatStream } from '../apps/server/chat-stream';
import { seedTestTeam as seed } from './fixtures/team';
import { normalizeSystemMessages } from '../apps/server/models';
import { Store } from '../apps/server/store';
import { safeCredentialAdvice } from '../packages/shared/credential-advice';
import { collaborationHandoffs } from '../packages/shared/collaboration';
import { delegationPlan, workerAssignments } from '../packages/shared/delegation';
import { visibleBots } from '../packages/shared/team';
import type { Run } from '../packages/shared/types';

const answer = (content: string) => ({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { total_tokens: 7 },
});
const call = (name: string, args: unknown) => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          { id: 'call', type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { total_tokens: 7 },
});
async function until(ready: () => boolean) {
  for (let i = 0; i < 700; i++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Upgrade test timed out');
}
async function fixture(handler: (body: any, res: ServerResponse) => unknown) {
  mkdirSync('test-results/unit', { recursive: true });
  const dir = mkdtempSync(resolve('test-results/unit/upgrade-')),
    store = new Store(join(dir, 'team.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  const bodies: any[] = [];
  const provider = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    bodies.push(body);
    const result = handler(body, res);
    if (result !== undefined) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    }
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  for (const p of store.all('providers'))
    store.put('providers', {
      ...p,
      autoDiscover: false,
      baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
    });
  store.setConfig('settings', { ...store.settings(), mainBotId: 'boss-man' });
  const host = createApp(store, dir, resolve('dist/web')),
    server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    host,
    bodies,
    base,
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
async function done(f: Awaited<ReturnType<typeof fixture>>, run: Run) {
  await until(() => !f.host.runtime.controllers.has(run.id));
  return f.store.get('runs', run.id)!;
}

test('transport places all system instructions first without disturbing native tool pairs', () => {
  const messages = normalizeSystemMessages([
    { role: 'system', content: 'initial' },
    { role: 'user', content: 'task' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 't', type: 'function', function: { name: 'draft_read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 't', content: 'saved' },
    { role: 'system', content: 'late checkpoint' },
  ]);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'tool'],
  );
  assert.match(messages[0].content!, /initial\n\nlate checkpoint/);
  assert.equal(messages[2].tool_calls![0].id, messages[3].tool_call_id);
});

test('SSE handles fragmented UTF-8 and tool arguments, never forwards reasoning, and treats abrupt EOF as incomplete', async () => {
  const frames = [
    { choices: [{ delta: { reasoning_content: 'PRIVATE_THOUGHT', content: 'Café ' } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 't', function: { name: 'page_create', arguments: '{"content":"' } },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '<h1>Hello</h1>"}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    },
    { choices: [], usage: { total_tokens: 43 } },
  ];
  const bytes = new TextEncoder().encode(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\n\n',
  );
  const snapshots: unknown[] = [];
  const result = await readChatStream(
    new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
          controller.close();
        },
      }),
    ),
    (value) => snapshots.push(value),
  );
  assert.equal(result.choices[0].message.content, 'Café ');
  assert.equal(
    result.choices[0].message.tool_calls![0].function.arguments,
    '{"content":"<h1>Hello</h1>"}',
  );
  assert.equal(result.usage.total_tokens, 43);
  assert.ok(!JSON.stringify(snapshots).includes('PRIVATE_THOUGHT'));
  assert.equal(
    (await readChatStream(new Response('data: {"choices":[{"delta":{"content":"unfinished"}}]}\n')))
      .choices[0].finish_reason,
    'length',
  );
});

test('main bot assigns real research then real website work without relying on model tool calling, and saves local HTML without keys', async () => {
  const f = await fixture((body) => {
    const system = body.messages[0].content;
    assert.equal(body.messages.filter((m: any) => m.role === 'system').length, 1);
    if (system.includes('You are Research'))
      return answer('ACTUAL_RESEARCH: Compare the verified choices. Access limitations disclosed.');
    assert.match(system, /You are Info Page Generate/);
    assert.match(body.messages.at(-1).content, /ACTUAL_RESEARCH/);
    return answer(
      '```html\n<!doctype html><h1>Local comparison</h1>\n```\n\nProvide the API token value to publish this.',
    );
  });
  try {
    for (const m of f.store.all('models')) f.store.put('models', { ...m, toolCalling: 'disabled' });
    const run = await done(
      f,
      f.host.runtime.create(
        'boss-man',
        'Find the best options and build a website with the comparison.',
      ),
    );
    assert.equal(run.status, 'completed', run.error);
    assert.equal(f.bodies.length, 2);
    assert.equal(
      collaborationHandoffs(run).length,
      2,
      'Only real receipts appear as handoffs, without phantom waiting cards.',
    );
    assert.ok(collaborationHandoffs(run).every((handoff) => handoff.status === 'completed'));
    assert.deepEqual(
      f.store.all('deliveries').map((d) => [d.fromBotId, d.toBotId, d.status]),
      [
        ['boss-man', 'research', 'completed'],
        ['boss-man', 'info-page-generate', 'completed'],
      ],
    );
    const page = f.store.all('pages')[0];
    assert.match(page.content, /Local comparison/);
    const final = f.store
      .all('messages')
      .findLast((m) => m.botId === 'boss-man' && m.role === 'assistant')!.content;
    assert.doesNotMatch(final, /Provide the API token value/);
    assert.match(final, /Add key or password/);
    assert.match(final, new RegExp(`/api/pages/${page.id}/view`));
    assert.equal(
      delegationPlan('Handle this yourself, do not delegate: build a website', f.store.all('bots'))
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});

test('streaming code is visible before an unfinished tool executes, then saved exactly once and finished automatically', async () => {
  let release = () => {},
    calls = 0;
  const html = '<!doctype html><h1>First visible step</h1><p>Finished live</p>';
  const f = await fixture((body, res) => {
    calls++;
    if (calls === 1) return call('draft_start', { filename: 'live.html' });
    const result = JSON.parse(body.messages.filter((m: any) => m.role === 'tool').at(-1).content);
    if (calls === 2) {
      assert.equal(body.stream, true);
      res.setHeader('Content-Type', 'text/event-stream');
      const frame = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      const prefix = JSON.stringify({
        id: result.id,
        expectedRevision: result.revision,
        content: html,
      }).slice(0, -2);
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'live', function: { name: 'draft_append', arguments: prefix } },
              ],
            },
          },
        ],
      });
      release = () => {
        frame({
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        });
        res.end('data: [DONE]\n\n');
      };
      return;
    }
    if (calls === 3) return answer('Click Continue to finish.');
    if (calls === 4) return call('draft_finish', { id: result.id });
    return answer('Your local page is finished.');
  });
  try {
    const run = f.host.runtime.create('worker1', 'Build a local HTML page.');
    await until(() => f.host.runtime.builds.list(run.id).some((b) => b.characters > 10));
    const build = f.host.runtime.builds.list(run.id)[0];
    assert.equal(
      f.store.all('drafts')[0].content,
      '',
      'An in-flight tool is a preview, not a committed file.',
    );
    assert.match(
      (await fetch(`${f.base}/api/live-builds/${build.id}`).then((r) => r.json())).content,
      /First visible step/,
    );
    release();
    const result = await done(f, run);
    assert.equal(result.status, 'completed', result.error);
    assert.equal(calls, 5);
    assert.equal(f.store.all('drafts')[0].content, html);
    assert.equal(f.store.all('drafts')[0].status, 'complete');
    assert.equal(f.store.all('pages').length, 1);
    assert.equal(f.host.runtime.builds.list(run.id)[0].status, 'complete');
    assert.ok(
      f.bodies.every(
        (body) =>
          body.messages[0].role === 'system' &&
          body.messages.filter((m: any) => m.role === 'system').length === 1,
      ),
    );
  } finally {
    release();
    await f.close();
  }
});

test('prototype owns clone receipts and synthesis, hides retired workers, and rejects direct human runs', async () => {
  const f = await fixture((body) =>
    body.messages[0].content.includes('PROTOTYPE COORDINATOR:')
      ? answer('ONE_COMBINED_BEST_OF: verified findings from all returned workers.')
      : answer('ACTUAL_CLONE_FINDING'),
  );
  try {
    f.store.put('bots', { ...f.store.get('bots', 'worker3')!, isPrototype: true });
    assert.throws(() => f.host.runtime.create('worker3', 'hi'), /Ask another bot to delegate/);
    const blocked = await fetch(`${f.base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: 'worker3', prompt: 'hi' }),
    });
    assert.equal(blocked.status, 409);
    assert.equal(
      workerAssignments('fire up a bunch of @Worker3 to research programs for under 2').length,
      4,
    );
    const run = await done(
      f,
      f.host.runtime.create('boss-man', 'Fire up 3 of @Worker3 to research useful alternatives.'),
    );
    assert.equal(run.status, 'completed', run.error);
    const receipts = f.store.all('deliveries'),
      parent = receipts.find((d) => d.toBotId === 'worker3')!;
    assert.equal(parent.fromBotId, 'boss-man');
    assert.match(parent.answer!, /ONE_COMBINED_BEST_OF/);
    assert.equal(
      receipts.filter((d) => d.fromBotId === 'worker3' && d.parentId === parent.id).length,
      3,
    );
    assert.ok(!visibleBots(f.store.all('bots')).some((b) => b.prototypeId));
    assert.equal(f.store.all('tasks').filter((t) => t.prototypeId === 'worker3').length, 3);
    assert.equal(f.bodies.length, 4);
  } finally {
    await f.close();
  }
});

test('category moves change only placement, reject clones and unknown groups, and preserve profiles', async () => {
  const f = await fixture(() => answer('ok'));
  try {
    const bot = f.store.get('bots', 'worker1')!,
      category = f.store.all('categories').find((c) => c.id !== bot.categoryId)!;
    const move = (id: string, categoryId: string | null) =>
      fetch(`${f.base}/api/bots/${id}/category`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId }),
      });
    assert.equal((await move(bot.id, category.id)).status, 200);
    assert.deepEqual(f.store.get('bots', bot.id), { ...bot, categoryId: category.id });
    assert.equal((await move(bot.id, 'missing')).status, 400);
    assert.equal((await move(bot.id, null)).status, 200);
    assert.equal(f.store.get('bots', bot.id)!.categoryId, undefined);
    f.store.put('bots', { ...bot, id: 'active-clone', prototypeId: bot.id, cloneStatus: 'active' });
    assert.equal((await move('active-clone', category.id)).status, 400);
    assert.equal((await move(bot.id, category.id)).status, 200);
    assert.equal(f.store.get('bots', 'active-clone')!.categoryId, category.id);
    assert.equal(
      f.host.access.allowed('operator', {
        path: `/api/bots/${bot.id}/category`,
        method: 'PATCH',
      } as any),
      false,
    );
  } finally {
    await f.close();
  }
});

test('credential guidance preserves safe instructions and removes requests to expose values', () => {
  assert.equal(
    safeCredentialAdvice('Never paste your API key in chat.'),
    'Never paste your API key in chat.',
  );
  assert.equal(
    safeCredentialAdvice('Paste the API key into the masked private form.'),
    'Paste the API key into the masked private form.',
  );
  assert.doesNotMatch(
    safeCredentialAdvice(
      'Approve a terminal command to read the token from the environment.',
      'page',
    ),
    /Approve a terminal/,
  );
});

test('empty final-summary retries preserve completed teammate answers and keep a reachable model online', async () => {
  let rootCalls = 0;
  const f = await fixture((body) => {
    if (body.messages[0].content.includes('You are Worker2'))
      return answer('ACTUAL_COMPLETED_TEAMMATE_RESULT');
    if (++rootCalls === 1)
      return call('delegate', { botId: 'worker2', task: 'Return your actual scoped result.' });
    assert.equal(body.messages.filter((message: any) => message.role === 'system').length, 1);
    return answer('');
  });
  try {
    const run = await done(
      f,
      f.host.runtime.create('worker1', 'Carry out this scoped collaboration exercise.'),
    );
    assert.equal(run.status, 'completed', run.error);
    assert.equal(
      rootCalls,
      4,
      'Empty visible output is retried twice, then returns saved results.',
    );
    const message = f.store
      .all('messages')
      .findLast((message) => message.botId === 'worker1' && message.role === 'assistant')!;
    assert.match(message.content, /ACTUAL_COMPLETED_TEAMMATE_RESULT/);
    assert.match(message.content, /could not write a separate final summary/);
    assert.ok(!run.events.some((event) => event.kind === 'fallback'));
    assert.ok(f.store.all('models').some((model) => model.status === 'online'));
    assert.equal(f.store.all('incidents').length, 0);
  } finally {
    await f.close();
  }
});
