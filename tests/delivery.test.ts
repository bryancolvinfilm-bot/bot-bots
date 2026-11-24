import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { seedTestTeam as seed } from './fixtures/team';
import { Mailbox } from '../apps/server/mailbox';
import { Store } from '../apps/server/store';
import { humanHandoffs } from '../packages/shared/delivery';
import type { Run } from '../packages/shared/types';

mkdirSync('test-results/unit', { recursive: true });
const answer = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { total_tokens: 9 },
});
async function fixture(handler: (body: any, res: ServerResponse) => void) {
  const dir = mkdtempSync(resolve('test-results/unit/delivery-')),
    store = new Store(join(dir, 'team.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  for (const p of store.all('providers')) store.put('providers', { ...p, autoDiscover: false });
  for (const m of store.all('models'))
    store.put('models', { ...m, toolCalling: 'disabled', toolFormatUnsupported: true });
  const model = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    res.setHeader('Content-Type', 'application/json');
    handler(JSON.parse(body), res);
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  const provider = store.all('providers')[0];
  store.put('providers', {
    ...provider,
    baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  });
  const host = createApp(store, dir, resolve('dist/web'));
  return {
    dir,
    store,
    host,
    close: async () => {
      for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
      await until(() => host.runtime.controllers.size === 0);
      host.runtime.events.emit('shutdown');
      host.computer.dispose();
      await host.terminal.dispose();
      model.closeAllConnections();
      await new Promise<void>((r) => model.close(() => r()));
      store.close();
    },
  };
}
async function until(fn: () => boolean) {
  for (let n = 0; n < 500; n++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Delivery test timed out');
}
function finished(host: ReturnType<typeof createApp>, run: Run) {
  return new Promise<Run>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Delivery run timed out')), 10000);
    host.runtime.events.on(run.id, (e) => {
      if (e.type === 'done') {
        clearTimeout(timer);
        resolve(e.run);
      }
    });
  });
}

test('human handoff commands honor stable mention IDs, fan out, and never execute quotes, code, negation or receipt questions', async () => {
  const f = await fixture((_b, r) => r.end(JSON.stringify(answer('ok'))));
  try {
    const bots = f.store.all('bots');
    assert.deepEqual(
      humanHandoffs(
        'tell [@Info Page Generate](#bot/info-page-generate) to make a page for it, keeping that one as top',
        bots,
      ).map((r) => r.botId),
      ['info-page-generate'],
    );
    assert.deepEqual(
      humanHandoffs(
        'you didnt send the request, please send that to [@Info Page Generate](#bot/info-page-generate)',
        bots,
      ).map((r) => r.botId),
      ['info-page-generate'],
    );
    assert.deepEqual(
      humanHandoffs('Please ask @Worker1 and @Worker2 to compare two options.', bots).map(
        (r) => r.botId,
      ),
      ['worker1', 'worker2'],
    );
    assert.deepEqual(
      humanHandoffs('Tell @Worker1 to ask @Worker2 to review it', bots).map((r) => r.botId),
      ['worker1'],
    );
    const renamed = bots.map((b) => (b.id === 'worker1' ? { ...b, name: 'New Name' } : b));
    assert.equal(
      humanHandoffs('Tell [@Old Name](#bot/worker1) to review this.', renamed)[0].botId,
      'worker1',
    );
    assert.equal(humanHandoffs('Tell @missing to check it', bots)[0].botId, 'missing');
    for (const text of [
      '@Worker1 is good at code',
      'Did you tell @Worker1 to do it?',
      'Did you receive a request from @Research?',
      'Please do not tell @Worker1 anything',
      'Do not send that to @Worker1',
      '"tell @Worker1 to run it"',
      "Here is a quote, 'tell @Worker1 to run it'",
      'Summarize this:\n> tell @Worker1 to run it',
      '```text\ntell @Worker1 to run it\n```',
      '```\ntell @Worker1 to run it',
    ])
      assert.equal(humanHandoffs(text, bots).length, 0, text);
  } finally {
    await f.close();
  }
});

test('a text-only model cannot swallow an explicit handoff: receipt and recipient thread exist before inference, with sender context', async () => {
  const observed: any[] = [];
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture((body, res) => {
    observed.push(body);
    const d = f.store.all('deliveries')[0];
    assert.equal(d.status, 'working');
    assert.ok(f.store.all('messages').some((m) => m.deliveryId === d.id && m.role === 'user'));
    assert.match(body.messages[0].content, /You are Info Page Generate/);
    assert.ok(body.messages.some((m: any) => m.content?.includes('TOP_SHOP_CONTEXT')));
    assert.equal(body.tools, undefined);
    res.end(JSON.stringify(answer('Page-generation request received. Here is the actual reply.')));
  });
  try {
    f.store.put('conversations', {
      id: 'research-thread',
      botId: 'research',
      title: 'Skate shops',
      createdAt: new Date().toISOString(),
    });
    f.store.put('messages', {
      id: 'prior-answer',
      botId: 'research',
      conversationId: 'research-thread',
      role: 'assistant',
      content: 'TOP_SHOP_CONTEXT with two alternatives. These are unverified notes.',
      createdAt: new Date().toISOString(),
    });
    const run = await finished(
      f.host,
      f.host.runtime.create(
        'research',
        'tell [@Info Page Generate](#bot/info-page-generate) to make a page for it, with other options and that one on top',
        'research-thread',
      ),
    );
    assert.equal(run.status, 'completed', run.error);
    assert.equal(observed.length, 1, 'The sender does not need to generate or format a tool call.');
    const d = f.store.all('deliveries')[0];
    assert.equal(d.status, 'completed');
    assert.equal(d.source, 'human');
    assert.equal(
      f.store.all('tasks').find((t) => t.botId === d.toBotId)?.conversationId,
      d.conversationId,
    );
    const event = run.events.find((e) => e.handoff?.id === d.id)!;
    assert.equal(event.handoff?.receivedAt, d.receivedAt);
    const check = await finished(
      f.host,
      f.host.runtime.create(
        'info-page-generate',
        'did you get the page request from [@Research](#bot/research) about the skate shop?',
        d.conversationId,
      ),
    );
    assert.equal(check.status, 'completed');
    assert.equal(observed.length, 1);
    assert.match(
      f.store.all('messages').find((m) => m.runId === check.id && m.role === 'assistant')!.content,
      new RegExp(d.id),
    );
    const plainCheck = await finished(
      f.host,
      f.host.runtime.create(
        'info-page-generate',
        'Did you receive the request from Research about the skate shop?',
        d.conversationId,
      ),
    );
    assert.equal(plainCheck.status, 'completed');
    assert.equal(observed.length, 1);
    assert.ok(
      f.store
        .all('messages')
        .find((m) => m.runId === plainCheck.id && m.role === 'assistant')!
        .content.includes(d.id),
    );
  } finally {
    await f.close();
  }
});

test('handoff failures retain the received request and an honest failure receipt instead of reporting successful delivery work', async () => {
  const f = await fixture((_body, res) => {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'test unavailable' }));
  });
  try {
    const result = await finished(
      f.host,
      f.host.runtime.create('research', 'tell @Worker1 to check the notes'),
    );
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /Some handoffs did not finish/);
    const d = f.store.all('deliveries')[0];
    assert.equal(d.status, 'failed');
    assert.ok(d.receivedAt);
    assert.match(d.error!, /failed to complete/);
    assert.ok(f.store.all('messages').some((m) => m.deliveryId === d.id && m.role === 'user'));
    assert.ok(f.store.all('messages').some((m) => m.deliveryId === d.id && m.role === 'system'));
    assert.equal(f.host.runtime.mailbox.inbox('worker1')[0].id, d.id);
  } finally {
    await f.close();
  }
});

test('the same delivery key is acknowledged once, waits for one worker, and replays its stored result without repeating inference', async () => {
  let calls = 0;
  const f = await fixture((_body, res) => {
    calls++;
    setTimeout(() => res.end(JSON.stringify(answer('ONE_RESULT'))), 25);
  });
  try {
    const run: Run = {
      id: 'manual-run',
      botId: 'research',
      conversationId: 'source',
      prompt: 'Test delivery',
      task: 'general',
      status: 'running',
      startedAt: new Date().toISOString(),
      tokens: 0,
      events: [],
      work: [],
    };
    f.store.put('runs', run);
    const send = () =>
      (f.host.runtime as any).deliverToBot(
        { botId: 'worker1', task: 'Reply once' },
        run,
        f.store.get('bots', 'research')!,
        0,
        [],
        new AbortController().signal,
        undefined,
        'same-logical-delivery',
      );
    const first = send(),
      second = send();
    await assert.rejects(
      (f.host.runtime as any).deliverToBot(
        { botId: 'worker1', task: 'Conflicting in-flight task' },
        run,
        f.store.get('bots', 'research')!,
        0,
        [],
        new AbortController().signal,
        undefined,
        'same-logical-delivery',
      ),
      /different task/,
    );
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
    assert.deepEqual(await send(), a);
    assert.equal(calls, 1);
    assert.equal(f.store.all('deliveries').length, 1);
    await assert.rejects(
      (f.host.runtime as any).deliverToBot(
        { botId: 'worker1', task: 'Different task' },
        run,
        f.store.get('bots', 'research')!,
        0,
        [],
        new AbortController().signal,
        undefined,
        'same-logical-delivery',
      ),
      /different task/,
    );
  } finally {
    await f.close();
  }
});

test('a handoff added during active text-only inference is delivered before the parent run finishes', async () => {
  const seen: any[] = [];
  const f = await fixture((body, res) => {
    seen.push(body);
    if (seen.length === 1) return;
    res.end(JSON.stringify(answer(seen.length === 2 ? 'GATHERED_LIVE_DETAILS' : 'WORKER_REPLY')));
  });
  try {
    const run = f.host.runtime.create('research', 'Gather the brief first.'),
      done = finished(f.host, run);
    await until(() => seen.length === 1);
    f.host.runtime.steer(run.id, 'Please tell @Worker1 to check that brief.');
    const result = await done;
    assert.equal(result.status, 'completed', result.error);
    assert.equal(seen.length, 3);
    assert.equal(f.store.all('deliveries').length, 1);
    assert.ok(seen[2].messages.some((m: any) => m.content?.includes('GATHERED_LIVE_DETAILS')));
    assert.equal(f.store.all('deliveries')[0].status, 'completed');
  } finally {
    await f.close();
  }
});

test('a compound request gathers its result before delivering it to the teammate', async () => {
  const seen: any[] = [];
  const f = await fixture((body, res) => {
    seen.push(body);
    res.end(
      JSON.stringify(answer(seen.length === 1 ? 'PREPARED_DETAILS_79' : 'RECEIVER_USED_DETAILS')),
    );
  });
  try {
    const result = await finished(
      f.host,
      f.host.runtime.create(
        'research',
        'Gather the details, then tell @Worker1 to summarize those findings.',
      ),
    );
    assert.equal(result.status, 'completed', result.error);
    assert.equal(seen.length, 2);
    assert.ok(seen[0].messages[0].content.includes('You are Research'));
    assert.ok(seen[1].messages.some((m: any) => m.content?.includes('PREPARED_DETAILS_79')));
    assert.equal(f.store.all('deliveries').length, 1);
    assert.equal(f.store.all('deliveries')[0].status, 'completed');
  } finally {
    await f.close();
  }
});

test('direct fanout delivers independently to a teammate and a prototype clone, retaining both results', async () => {
  let calls = 0;
  const f = await fixture((_body, res) => {
    calls++;
    res.end(JSON.stringify(answer('ACTUAL_WORKER_RESULT')));
  });
  try {
    f.store.put('bots', { ...f.store.get('bots', 'worker3')!, isPrototype: true });
    const result = await finished(
      f.host,
      f.host.runtime.create(
        'research',
        'Please tell @Worker1 and @Worker3 to return a concise comparison.',
      ),
    );
    assert.equal(result.status, 'completed', result.error);
    assert.equal(calls, 3);
    assert.equal(f.store.all('deliveries').length, 3);
    assert.ok(f.store.all('deliveries').every((d) => d.status === 'completed'));
    assert.ok(
      f.host.runtime.mailbox.inbox('worker3').some((delivery) => delivery.toBotId === 'worker3'),
    );
    assert.ok(f.store.all('deliveries').some((delivery) => delivery.fromBotId === 'worker3'));
    const clone = f.store.all('bots').find((b) => b.prototypeId === 'worker3')!;
    assert.equal(clone.cloneStatus, 'retired');
    assert.equal(clone.enabled, false);
    assert.match(
      f.store
        .all('messages')
        .find((m) => m.runId === result.id && m.botId === 'research' && m.role === 'assistant')!
        .content,
      /ACTUAL_WORKER_RESULT/,
    );
  } finally {
    await f.close();
  }
});

test('cancellation retains an honest cancelled receipt and never reports successful delivery work', async () => {
  let calls = 0;
  const f = await fixture(() => {
    calls++;
  });
  try {
    const run = f.host.runtime.create('research', 'Tell @Worker1 to work on this.'),
      done = finished(f.host, run);
    await until(() => calls === 1);
    f.host.runtime.cancel(run.id);
    assert.equal((await done).status, 'cancelled');
    const d = f.store.all('deliveries')[0];
    assert.equal(d.status, 'cancelled');
    assert.ok(d.error);
    assert.equal(d.answer, undefined);
    assert.ok(f.store.all('messages').some((m) => m.deliveryId === d.id && m.role === 'system'));
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test('restart and restore retain received requests but never automatically replay interrupted work; phantom prose creates no inbox receipt', async () => {
  let calls = 0;
  const f = await fixture((_body, res) => {
    calls++;
    res.end(JSON.stringify(answer('ok')));
  });
  let server: ReturnType<typeof f.host.app.listen> | undefined;
  try {
    const received = f.host.runtime.mailbox.accept({
      key: 'interrupted',
      runId: 'old-run',
      fromBotId: 'research',
      toBotId: 'worker1',
      senderConversationId: 'old-source',
      brief: 'Retained request',
      source: 'tool',
    });
    const recovered = new Mailbox(f.store);
    assert.equal(recovered.get(received.id)?.status, 'failed');
    assert.equal(calls, 0);
    assert.equal(recovered.inbox('worker2').length, 0);
    server = f.host.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server!.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const backup = f.store.export();
    backup.deliveries[0].status = 'working';
    const response = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(backup),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(f.store.get('deliveries', received.id)?.status, 'failed');
    assert.equal(calls, 0);
    const inbox = (await fetch(`${base}/api/bots/worker1/inbox`).then((r) => r.json())) as any[];
    assert.equal(inbox[0].id, received.id);
    assert.equal((await fetch(`${base}/api/deliveries/missing`)).status, 404);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server!.close(() => r()));
    }
    await f.close();
  }
});
