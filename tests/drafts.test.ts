import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { Drafts, partialStrings } from '../apps/server/drafts';
import { TaskLimitError } from '../apps/server/generation-errors';
import { seedTestTeam as seed } from './fixtures/team';
import {
  compactNotebook,
  compactTaskContext,
  OutputRecovery,
} from '../apps/server/output-recovery';
import { Store } from '../apps/server/store';
import { previewActions, type PreviewDriver } from '../apps/server/preview';
import type { WireMessage } from '../apps/server/models';
import { mergeContinuation } from '../packages/shared/drafts';
import type { Run, WorkRecord } from '../packages/shared/types';
mkdirSync('test-results/unit', { recursive: true });
const owner: Run = {
  id: 'run',
  botId: 'worker1',
  conversationId: 'conversation',
  prompt: 'Make a file',
  task: 'coding',
  status: 'running',
  startedAt: new Date().toISOString(),
  tokens: 0,
  events: [],
};
const work: WorkRecord = {
  id: 'work',
  botId: 'worker1',
  task: 'coding',
  urgency: 'relaxed',
  importance: 'normal',
  startedAt: owner.startedAt,
  status: 'running',
  attempts: [],
};
function storage() {
  const dir = mkdtempSync(resolve('test-results/unit/drafts-'));
  return { dir, store: new Store(join(dir, 'test.sqlite')) };
}
const answer = (content: string, truncated = false) => ({
  choices: [
    { message: { role: 'assistant', content }, finish_reason: truncated ? 'length' : 'stop' },
  ],
  usage: { total_tokens: 11 },
});
const call = (name: string, args: unknown, truncated = false, raw = false) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'tool-call',
            type: 'function',
            function: { name, arguments: raw ? args : JSON.stringify(args) },
          },
        ],
      },
      finish_reason: truncated ? 'length' : 'tool_calls',
    },
  ],
  usage: { total_tokens: 7 },
});
async function fixture(handler: (body: any) => unknown, preview?: PreviewDriver) {
  const { dir, store } = storage();
  seed(store, resolve('reference/grok-backup'));
  for (const provider of store.all('providers'))
    store.put('providers', { ...provider, autoDiscover: false, autoEnableModels: false });
  const bodies: any[] = [];
  const model = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || '{}');
    bodies.push(body);
    const result = handler(body);
    res.setHeader('Content-Type', 'application/json');
    if (result !== undefined) res.end(JSON.stringify(result));
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  store.put('providers', {
    ...store.all('providers')[0],
    baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  });
  const host = createApp(store, dir, resolve('dist/web'), '', undefined, preview);
  return {
    dir,
    store,
    host,
    bodies,
    async cleanup() {
      for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
      await until(() => host.runtime.controllers.size === 0);
      await host.terminal.dispose();
      host.computer.dispose();
      host.runtime.events.emit('shutdown');
      model.closeAllConnections();
      await new Promise<void>((r) => model.close(() => r()));
      store.close();
    },
  };
}
async function until(ready: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Draft test timed out');
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
function healthy(f: Awaited<ReturnType<typeof fixture>>, run: Run) {
  assert.equal(run.events.filter((e) => e.kind === 'fallback').length, 0);
  assert.equal(f.store.all('models')[0].status, 'online');
  assert.equal(f.store.all('incidents').length, 0);
}

test('a complete oversized model append is preserved and a direct file save closes its matching draft', async () => {
  const html =
    '<!doctype html><html><body>' + '<p>Saved content</p>'.repeat(450) + '</body></html>';
  let count = 0;
  const f = await fixture((body) => {
    count++;
    const last = body.messages.filter((m: any) => m.role === 'tool').at(-1);
    if (count === 1) return call('draft_start', { filename: 'family-events-page/index.html' });
    if (count === 2)
      return call('draft_append', {
        id: JSON.parse(last.content).id,
        content: html,
        expectedRevision: 0,
      });
    if (count === 3) {
      const saved = JSON.parse(last.content);
      assert.equal(saved.characters, html.length);
      assert.equal(saved.revision, Math.ceil(html.length / 6000));
      return call('workspace_write', { path: 'family-events-page/index.html', content: html });
    }
    return answer('The saved HTML file is ready.');
  });
  try {
    const run = await done(
      f.host,
      f.host.runtime.create('worker1', 'Make a local family events page.'),
    );
    assert.equal(run.status, 'completed', run.error);
    const draft = f.store.all('drafts')[0];
    assert.equal(draft.content, html);
    assert.equal(draft.status, 'complete');
    assert.ok(draft.pageId);
    const build = f.host.runtime.builds.list(run.id)[0];
    assert.equal(build.status, 'complete');
    assert.equal(build.characters, html.length);
    assert.equal(build.pageId, draft.pageId);
    assert.equal(count, 4);
    healthy(f, run);
  } finally {
    await f.cleanup();
  }
});

test('repeated identical tool errors stop promptly with the actual cause and do not count as progress', async () => {
  const f = await fixture(() => call('draft_read', { id: 'nonexistent-draft-id' }));
  try {
    const run = await done(f.host, f.host.runtime.create('worker1', 'Read my saved draft.'));
    assert.equal(run.status, 'failed');
    assert.match(run.error!, /draft_read.*Draft not found/);
    assert.equal(f.bodies.length, 4);
    healthy(f, run);
  } finally {
    await f.cleanup();
  }
});

test('restart recovers an empty notebook from the exact completed workspace file without replaying publishing', () => {
  const f = storage();
  try {
    const drafts = new Drafts(f.store);
    const draft = drafts.create(owner, work, 'family-events-page/index.html');
    drafts.status(draft.id, 'partial', 'Earlier failure');
    const html = '<!doctype html><h1>Recovered saved file</h1>';
    f.store.put('pages', {
      id: 'saved-page',
      botId: owner.botId,
      runId: owner.id,
      title: 'index.html',
      workspacePath: draft.filename,
      filename: 'index.html',
      format: 'html',
      content: html,
      createdAt: new Date().toISOString(),
    });
    const recovered = new Drafts(f.store).get(draft.id);
    assert.equal(recovered.content, html);
    assert.equal(recovered.status, 'complete');
    assert.equal(recovered.pageId, 'saved-page');
    assert.equal(f.store.all('serviceActions').length, 0);
    assert.equal(f.store.all('pages').length, 1);
    const version = recovered.revision;
    assert.equal(new Drafts(f.store).get(draft.id).revision, version);
  } finally {
    f.store.close();
  }
});

test('task context compaction never relabels a failed tool result as completed', () => {
  const failed = JSON.stringify({ error: 'Validation failed. '.repeat(80) });
  const messages: WireMessage[] = [
    { role: 'tool', tool_call_id: 'failed', content: failed },
    ...Array.from({ length: 7 }, (_, index) => ({
      role: 'tool' as const,
      tool_call_id: `ok-${index}`,
      content: '{"ok":true}',
    })),
  ];
  compactTaskContext(messages);
  assert.equal(messages[0].content, failed);
});

test('draft revisions prevent duplicate appends, exact patches are guarded, and restarts preserve unfinished files', () => {
  const { store } = storage();
  try {
    const drafts = new Drafts(store),
      draft = drafts.create(owner, work, 'src/example.ts');
    drafts.append(draft.id, 'const greeting = "hello";\n', 0, owner.id);
    assert.throws(() => drafts.append(draft.id, 'duplicate', 0, owner.id), /revision is 1/);
    assert.throws(() => drafts.patch(draft.id, 'absent', 'bye', 1, owner.id), /exactly once/);
    drafts.patch(draft.id, 'hello', 'goodbye', 1, owner.id);
    assert.equal(drafts.read(draft.id, 0, 500).content, 'const greeting = "goodbye";\n');
    assert.equal(drafts.checkpoint(draft.id).outline[0].line, 1);
    assert.equal(drafts.read(draft.id).objective, owner.prompt);
    assert.ok(!('content' in drafts.list()[0]));
    const restarted = new Drafts(store);
    assert.equal(restarted.get(draft.id).status, 'partial');
    assert.equal(restarted.get(draft.id).revision, 2);
    assert.throws(() => drafts.create(owner, work, '../escape.txt'), /relative/);
    assert.throws(() => drafts.append(draft.id, 'x'.repeat(6001), 2, owner.id), /6000/);
    assert.ok(store.export().drafts.some((d) => d.id === draft.id));
  } finally {
    store.close();
  }
});

test('partial tool strings preserve verified escapes only; text joins remove substantial exact overlap only', () => {
  assert.deepEqual(
    { ...partialStrings('{"path":"code.js","content":"let x = \\"hi\\";\\n\\u263a\\u12') },
    { path: 'code.js', content: 'let x = "hi";\n☺' },
  );
  assert.equal(partialStrings('{"content":"safe\\qBAD').content, 'safe');
  assert.equal(partialStrings('{"content":"safe\\').content, 'safe');
  const common = 'a'.repeat(128);
  assert.equal(mergeContinuation('prefix' + common, common + 'next'), 'prefix' + common + 'next');
  assert.equal(mergeContinuation('  }', '  }'), '  }  }');
});

test('notebook compaction keeps paired protocol calls, latest checkpoints, and complete storage outside context', () => {
  const messages: WireMessage[] = [];
  for (let i = 0; i < 5; i++)
    messages.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `c${i}`,
            type: 'function',
            function: {
              name: 'draft_append',
              arguments: JSON.stringify({ id: 'draft', content: `code-${i}`, expectedRevision: i }),
            },
          },
        ],
        rawOutput: [
          {
            type: 'function_call',
            call_id: `c${i}`,
            arguments: JSON.stringify({ id: 'draft', content: `code-${i}`, expectedRevision: i }),
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: `c${i}`,
        content: JSON.stringify({
          ok: true,
          id: 'draft',
          revision: i + 1,
          characters: 100,
          head: 'full code',
          tail: 'full code',
        }),
      },
    );
  compactNotebook(messages);
  assert.equal(messages.length, 5);
  assert.match(messages[0].tool_calls![0].function.arguments, /code-3/);
  assert.equal(
    (messages[0].rawOutput![0] as any).arguments,
    messages[0].tool_calls![0].function.arguments,
  );
  assert.match(messages[1].content!, /full code/);
  assert.match(messages[2].tool_calls![0].function.arguments, /code-4/);
  assert.match(messages[3].content!, /full code/);
  assert.match(messages[4].content!, /RUNTIME SAVED-FILE CHECKPOINT/);
  assert.match(messages[4].content!, /"revision":3/);
  assert.ok(
    !messages[4].content!.slice(messages[4].content!.indexOf('\n') + 1).includes('full code'),
  );
  compactNotebook(messages);
  assert.equal(
    messages.length,
    5,
    'Compaction is idempotent and preserves valid recent call/result pairs.',
  );
});

test('recovered append prefixes require the current explicit revision and the same work owner', () => {
  const { store } = storage();
  try {
    const drafts = new Drafts(store),
      draft = drafts.create(owner, work, 'safe.txt');
    const recover = new OutputRecovery(drafts, owner, work, 600),
      messages: WireMessage[] = [];
    function interrupted(revision: string) {
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c',
              type: 'function' as const,
              function: {
                name: 'draft_append',
                arguments: `{"id":"${draft.id}","expectedRevision":${revision},"content":"new`,
              },
            },
          ],
        },
        truncated: true,
      };
    }
    recover.handle(interrupted('7'), messages);
    assert.equal(drafts.get(draft.id).content, '');
    recover.handle(interrupted('0'), messages);
    assert.equal(drafts.get(draft.id).content, 'new');
    recover.handle(interrupted('0'), messages);
    assert.equal(drafts.get(draft.id).content, 'new');
  } finally {
    store.close();
  }
});

test('truncated replies continue on the same healthy model and publish one assembled answer with total usage', async () => {
  let count = 0;
  const shared = 'x'.repeat(128),
    f = await fixture(() =>
      ++count === 1 ? answer('Start ' + shared, true) : answer(shared + ' finished.'),
    );
  try {
    const run = f.host.runtime.create('worker1', 'Write one long answer');
    const finished = await done(f.host, run);
    assert.equal(finished.status, 'completed', finished.error);
    assert.equal(count, 2);
    healthy(f, finished);
    assert.equal(finished.tokens, 22);
    assert.equal(f.bodies[1].tools, undefined);
    assert.equal(f.store.all('messages').at(-1)?.content, 'Start ' + shared + ' finished.');
    const draft = f.store.all('drafts')[0];
    assert.equal(draft.status, 'complete');
    assert.equal(draft.chunks, 2);
    assert.ok(finished.events.some((e) => e.kind === 'draft'));
  } finally {
    await f.cleanup();
  }
});

test('an unfinished code tool never executes; its prefix becomes a revisioned draft and finishes as an exact file', async () => {
  let count = 0;
  const prefix = '<!doctype html><button id="go">Hello</button><script>let x = "';
  const f = await fixture(() => {
    count++;
    if (count === 1)
      return call(
        'workspace_write',
        '{"path":"recovered.html","content":' + JSON.stringify(prefix).slice(0, -1),
        true,
        true,
      );
    const draft = f.store.all('drafts').find((d) => d.kind === 'file')!;
    if (count === 2) {
      assert.equal(f.store.all('pages').length, 0);
      assert.equal(draft.content, prefix);
      return call('draft_append', {
        id: draft.id,
        content: 'world";</script>',
        expectedRevision: draft.revision,
      });
    }
    if (count === 3) return call('draft_finish', { id: draft.id });
    return answer('Saved recovered.html');
  });
  try {
    const finished = await done(f.host, f.host.runtime.create('worker1', 'Create an HTML file'));
    assert.equal(finished.status, 'completed', finished.error);
    healthy(f, finished);
    const page = f.store.all('pages').find((p) => p.filename === 'recovered.html')!;
    assert.equal(page.content, prefix + 'world";</script>');
    assert.equal(readFileSync(join(f.dir, 'workspace', 'recovered.html'), 'utf8'), page.content);
    assert.equal(f.store.all('drafts').find((d) => d.kind === 'file')?.status, 'complete');
    assert.equal(f.store.all('drafts').find((d) => d.kind === 'tool-payload')?.status, 'partial');
  } finally {
    await f.cleanup();
  }
});

test('continuation limit preserves text without model fallback or outage alerts', async () => {
  let count = 0;
  const f = await fixture(() => answer(`Chunk ${++count}. `, true));
  try {
    const finished = await done(f.host, f.host.runtime.create('worker1', 'Long answer'));
    assert.equal(finished.status, 'failed');
    assert.match(finished.error!, /safety limit/);
    assert.equal(count, 64);
    healthy(f, finished);
    assert.equal(f.store.all('drafts')[0].status, 'partial');
    assert.match(f.store.all('drafts')[0].content, /Chunk 64/);
  } finally {
    await f.cleanup();
  }
});

test('many small notebook chunks have a separate bounded allowance from normal tools', async () => {
  let count = 0;
  const f = await fixture(() => {
    count++;
    if (count === 1) return call('draft_start', { filename: 'many.txt' });
    const draft = f.store.all('drafts')[0];
    if (count <= 14)
      return call('draft_append', {
        id: draft.id,
        expectedRevision: draft.revision,
        content: `${count}\n`,
      });
    if (count === 15) return call('draft_finish', { id: draft.id });
    return answer('Done');
  });
  f.store.setConfig('settings', { ...f.store.settings(), maxToolSteps: 1 });
  try {
    const finished = await done(
      f.host,
      f.host.runtime.create('worker1', 'Write in many small chunks'),
    );
    assert.equal(finished.status, 'completed', finished.error);
    assert.equal(f.store.all('drafts')[0].chunks, 13);
    healthy(f, finished);
  } finally {
    await f.cleanup();
  }
});

test('automatic notebook work continues beyond the old 64-operation boundary and finishes without a manual Continue', async () => {
  let count = 0;
  const f = await fixture(() => {
    count++;
    if (count === 1) return call('draft_start', { filename: 'bounded.txt' });
    const draft = f.store.all('drafts')[0];
    if (count <= 75)
      return call('draft_append', { id: draft.id, expectedRevision: draft.revision, content: 'x' });
    if (count === 76) return call('draft_finish', { id: draft.id });
    return answer('All code completed automatically');
  });
  try {
    const finished = await done(
      f.host,
      f.host.runtime.create('worker1', 'Write the complete file'),
    );
    assert.equal(finished.status, 'completed', finished.error);
    assert.equal(count, 77);
    assert.equal(f.store.all('drafts')[0].content, 'x'.repeat(74));
    assert.equal(f.store.all('drafts')[0].status, 'complete');
    healthy(f, finished);
  } finally {
    await f.cleanup();
  }
});

test('human steering supersedes an automatic text draft instead of joining the obsolete answer', async () => {
  let count = 0;
  const f = await fixture(() => {
    count++;
    if (count === 1) return answer('OLD ANSWER ', true);
    if (count === 2) return undefined;
    return answer('NEW DIRECTION');
  });
  try {
    const run = f.host.runtime.create('worker1', 'Long old answer'),
      finished = done(f.host, run);
    await until(() => count === 2);
    f.host.runtime.create('worker1', 'Change direction completely', run.conversationId);
    assert.equal((await finished).status, 'completed');
    assert.equal(f.store.all('messages').at(-1)?.content, 'NEW DIRECTION');
    assert.equal(f.store.all('drafts')[0].status, 'superseded');
    healthy(f, run);
  } finally {
    await f.cleanup();
  }
});

test('context exhaustion is a task limit and does not mark a reachable model offline', async () => {
  const f = await fixture(() => answer('unused'));
  try {
    const model = f.store.all('models')[0];
    f.store.put('models', { ...model, status: 'online', contextTokens: 1024 });
    const finished = await done(f.host, f.host.runtime.create('worker1', 'Write something'));
    assert.match(finished.error!, /context window/);
    assert.equal(finished.status, 'failed');
    assert.equal(f.bodies.length, 0);
    healthy(f, finished);
    assert.ok(new TaskLimitError('test') instanceof Error);
  } finally {
    await f.cleanup();
  }
});

test('interrupted drafts survive backup restore and can be resumed through their original conversation', async () => {
  let count = 0;
  const f = await fixture(() => {
    count++;
    if (count === 1) return call('draft_start', { filename: 'resumed.txt' });
    const draft = f.store.all('drafts').find((d) => d.kind === 'file')!;
    if (count === 2)
      return call('draft_append', { id: draft.id, expectedRevision: 0, content: 'first\n' });
    if (count === 3) return undefined;
    if (count === 4) return call('draft_read', { id: draft.id });
    if (count === 5)
      return call('draft_append', { id: draft.id, expectedRevision: 1, content: 'last\n' });
    if (count === 6) return call('draft_finish', { id: draft.id });
    return answer('Finished saved file');
  });
  const server = f.host.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    const run = f.host.runtime.create('worker1', 'Create a saved text file');
    const cancelled = done(f.host, run);
    await until(() => count === 3);
    f.host.runtime.cancel(run.id);
    const failed = await cancelled;
    assert.equal(failed.status, 'cancelled');
    healthy(f, failed);
    const draft = f.store.all('drafts')[0];
    assert.equal(draft.status, 'partial');
    const backup = f.store.export();
    backup.drafts[0].status = 'writing';
    const restored = await fetch(`${base}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(backup),
    });
    assert.equal(restored.status, 200, await restored.text());
    assert.equal(f.store.get('drafts', draft.id)?.status, 'partial');
    assert.equal(f.host.runtime.controllers.size, 0);
    const response = await fetch(`${base}/drafts/${draft.id}/continue`, { method: 'POST' });
    assert.equal(response.status, 202);
    const resumed = (await response.json()) as Run;
    assert.equal(
      f.store.all('messages').findLast((m) => m.runId === resumed.id && m.role === 'user')
        ?.displayContent,
      'Continue resumed.txt from the saved draft.',
    );
    assert.equal(resumed.conversationId, run.conversationId);
    const finished = await done(f.host, resumed);
    assert.equal(finished.status, 'completed', finished.error);
    assert.equal(f.store.get('drafts', draft.id)?.content, 'first\nlast\n');
    assert.equal(f.store.get('drafts', draft.id)?.activeRunId, resumed.id);
    assert.equal(f.store.all('pages')[0].content, 'first\nlast\n');
    const downloaded = await fetch(`${base}/drafts/${draft.id}/download`);
    assert.equal(await downloaded.text(), 'first\nlast\n');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('page previews validate and forward bounded behavior checks and return observed failures to the model', async () => {
  let count = 0;
  const actions = [
    { type: 'click' as const, selector: '#add' },
    { type: 'expect-text' as const, selector: '#count', text: '1' },
  ];
  const f = await fixture(
    () => {
      count++;
      if (count === 1)
        return call('workspace_write', {
          path: 'interactive.html',
          content: '<button id="add">Add</button><div id="count">0</div>',
        });
      if (count === 2) return call('page_preview', { id: f.store.all('pages')[0].id, actions });
      return answer('The behavior check failed and needs a handler.');
    },
    {
      render: async (_content, received) => {
        assert.deepEqual(received, actions);
        return {
          title: 'Counter',
          text: '0',
          errors: [],
          checks: [
            { action: actions[0], passed: true },
            { action: actions[1], passed: false, observed: '0' },
          ],
        };
      },
    },
  );
  try {
    const finished = await done(f.host, f.host.runtime.create('worker1', 'Test a counter'));
    assert.equal(finished.status, 'completed');
    const observed = JSON.parse(f.bodies.at(-1).messages.at(-1).content);
    assert.equal(observed.checks[1].passed, false);
    assert.equal(observed.checks[1].observed, '0');
    assert.throws(() => previewActions.parse(Array(9).fill(actions[0])));
    assert.throws(() => previewActions.parse([{ type: 'expect-text', selector: '#count' }]));
  } finally {
    await f.cleanup();
  }
});
