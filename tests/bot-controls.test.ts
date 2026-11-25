import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { BotControls, saveRoutine } from '../apps/server/bot-controls';
import { selectBotModel } from '../apps/server/bot-models';
import { candidates, complete } from '../apps/server/models';
import { Store } from '../apps/server/store';
import { seedTestTeam } from './fixtures/team';
import type { Run } from '../packages/shared/types';

function database() {
  mkdirSync('test-results/unit', { recursive: true });
  const dir = mkdtempSync(resolve('test-results/unit/bot-controls-'));
  const store = new Store(join(dir, 'team.sqlite'));
  seedTestTeam(store);
  store.setConfig('settings', { ...store.settings(), mainBotId: null });
  return { dir, store };
}
const reply = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { total_tokens: 10 },
});
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Bot controls test timed out.');
}
async function fixture(native: boolean) {
  const { dir, store } = database();
  let action: Record<string, unknown> | undefined;
  const observed: any[] = [];
  const modelServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    observed.push(body);
    res.setHeader('Content-Type', 'application/json');
    if (action) {
      const planned = action;
      action = undefined;
      const { changes, ...input } = planned;
      res.end(
        JSON.stringify(
          native
            ? {
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'panel-call',
                          type: 'function',
                          function: {
                            name: 'bot_panel',
                            arguments: JSON.stringify({
                              ...input,
                              ...(changes ? { changes } : {}),
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: { total_tokens: 10 },
              }
            : reply('I can do that.\n```json\n' + JSON.stringify({ botPanel: planned }) + '\n```'),
        ),
      );
    } else {
      const result = body.messages.findLast((m: any) => m.role === 'tool');
      res.end(
        JSON.stringify(
          reply(
            result
              ? (JSON.parse(result.content).message ?? 'Read the panel.')
              : 'Routine run completed.',
          ),
        ),
      );
    }
  });
  await new Promise<void>((r) => modelServer.listen(0, '127.0.0.1', r));
  const p = store.all('providers')[0],
    m = store.all('models')[0];
  for (const model of store.all('models'))
    store.put('models', { ...model, enabled: model.id === m.id });
  store.put('providers', {
    ...p,
    enabled: true,
    local: false,
    autoDiscover: false,
    baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`,
  });
  store.put('models', {
    ...m,
    enabled: true,
    contextTokens: 131072,
    toolCalling: native ? 'enabled' : 'disabled',
  });
  store.setConfig('settings', { ...store.settings(), localOnly: false });
  const host = createApp(store, dir, resolve('dist/web'));
  const server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let conversationId: string | undefined;
  async function run(prompt: string, next: Record<string, unknown>) {
    await until(() => host.runtime.controllers.size === 0);
    action = next;
    const response = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botId: 'calendar',
        prompt,
        conversationId,
        timezone: 'America/Los_Angeles',
      }),
    });
    assert.equal(response.status, 202);
    const started = (await response.json()) as Run;
    conversationId = started.conversationId;
    await until(() => store.get('runs', started.id)?.status !== 'running');
    const done = store.get('runs', started.id)!;
    assert.equal(done.status, 'completed', done.error);
    return store.all('messages').findLast((m) => m.runId === done.id && m.role === 'assistant')!
      .content;
  }
  return {
    store,
    observed,
    run,
    base,
    async close() {
      await until(() => host.runtime.controllers.size === 0);
      host.runtime.events.emit('shutdown');
      host.google.cancelRun();
      host.computer.dispose();
      await host.terminal.dispose();
      server.closeAllConnections();
      modelServer.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => server.close(() => r())),
        new Promise<void>((r) => modelServer.close(() => r())),
      ]);
      store.close();
    },
  };
}

for (const native of [true, false])
  test(`chat ${native ? 'native tools' : 'text-only bridge'} creates, edits, pauses, runs and deletes its own routine`, async () => {
    const f = await fixture(native);
    try {
      const answer = await f.run(
        'Make a routine for yourself: summarize my calendar every weekday at 9 am.',
        {
          action: 'routine_save',
          changes: {
            name: 'Morning calendar',
            cron: '0 9 * * 1-5',
            prompt: 'Summarize my calendar.',
          },
        },
      );
      assert.match(answer, /Created routine/);
      const r = f.store.all('routines').find((r) => r.name === 'Morning calendar')!;
      assert.equal(r.botId, 'calendar');
      assert.equal(r.enabled, true);
      assert.equal(r.timezone, 'America/Los_Angeles');
      assert.ok(r.nextRun);
      assert.match(
        await f.run('Pause that one.', {
          action: 'routine_save',
          id: r.id,
          changes: { enabled: false },
        }),
        /Paused/,
      );
      assert.equal(f.store.get('routines', r.id)?.nextRun, undefined);
      await f.run('Change it to 10 am and resume it.', {
        action: 'routine_save',
        id: r.id,
        changes: { cron: '0 10 * * 1-5', enabled: true },
      });
      assert.equal(f.store.get('routines', r.id)?.cron, '0 10 * * 1-5');
      assert.match(
        await f.run('Run that routine now.', { action: 'routine_run', id: r.id }),
        /Started routine/,
      );
      assert.ok(f.store.all('runs').some((run) => run.origin === 'routine'));
      assert.match(
        await f.run('Remove that routine.', { action: 'routine_delete', id: r.id }),
        /Removed routine/,
      );
      assert.equal(f.store.get('routines', r.id), undefined);
      if (!native) assert.ok(f.observed.every((b) => !b.tools));
    } finally {
      await f.close();
    }
  });

test('panel actions validate schedules, isolate bots and deny automatic/operator reconfiguration', () => {
  const { store } = database();
  try {
    const controls = new BotControls(store, () => {
      throw Error('Not used');
    });
    const bot = store.get('bots', 'calendar')!;
    const run = {
      id: 'human',
      conversationId: 'channel',
      botId: bot.id,
      origin: 'chat',
      panelAccess: true,
    } as Run;
    const changes = {
      name: 'Test',
      cron: '0 9 * * *',
      timezone: 'America/Los_Angeles',
      prompt: 'Check the calendar.',
      enabled: false,
      botId: bot.id,
    };
    assert.throws(() => saveRoutine(store, { ...changes, cron: 'nonsense' }));
    assert.throws(() => saveRoutine(store, { ...changes, timezone: 'Made/Up' }));
    assert.throws(
      () =>
        controls.execute({ action: 'routine_save', changes }, bot, { ...run, origin: 'routine' }),
      /owner chatting/,
    );
    assert.throws(
      () =>
        controls.execute({ action: 'routine_save', changes }, bot, { ...run, panelAccess: false }),
      /owner chatting/,
    );
    const r = saveRoutine(store, { ...changes, botId: 'research' });
    assert.throws(
      () => controls.execute({ action: 'routine_delete', id: r.id }, bot, run),
      /this bot/,
    );
    controls.execute(
      {
        action: 'profile_update',
        changes: {
          title: 'Calendar keeper',
          instructions: 'Stay in my calendar lane.',
          avatar: { ...bot.avatar, color: '#112233' },
          processingPhrases: { planning: ['Checking the week'] },
        },
      },
      bot,
      run,
    );
    assert.equal(store.get('bots', bot.id)?.avatar.color, '#112233');
    assert.equal(store.get('bots', 'research')?.title, 'Test Research');
    const saved = controls.execute(
      { action: 'memory_save', changes: { content: 'Use short summaries.', pinned: true } },
      bot,
      run,
    ) as any;
    controls.execute(
      {
        action: 'memory_update',
        id: saved.memory.id,
        changes: { content: 'Use very short summaries.', pinned: false },
      },
      bot,
      run,
    );
    assert.equal(store.get('memory', saved.memory.id)?.pinned, false);
    controls.execute({ action: 'memory_delete', id: saved.memory.id }, bot, run);
    assert.equal(store.get('memory', saved.memory.id), undefined);
  } finally {
    store.close();
  }
});

test('shared skill edits preserve attribution and conversational deletion needs a separate human Yes', () => {
  const { store } = database();
  try {
    const controls = new BotControls(store, () => {
        throw Error('Not used');
      }),
      bot = store.get('bots', 'calendar')!;
    const run = {
      id: 'one',
      botId: bot.id,
      conversationId: 'channel',
      panelAccess: true,
      origin: 'chat',
    } as Run;
    const saved = controls.execute(
      {
        action: 'skill_save',
        changes: { name: 'Calendar guide', content: '# Calendar guide\nCheck the week.' },
      },
      bot,
      run,
    ) as any;
    controls.execute(
      {
        action: 'skill_save',
        id: saved.skill.id,
        changes: { content: '# Calendar guide\nCheck weekdays.' },
      },
      bot,
      run,
    );
    assert.equal(store.get('skills', saved.skill.id)?.originBotId, bot.id);
    const deletion = controls.execute(
      { action: 'skill_delete', id: saved.skill.id },
      bot,
      run,
    ) as any;
    assert.equal(deletion.confirmationRequired, true);
    assert.ok(store.get('skills', saved.skill.id));
    assert.match(controls.confirmation({ ...run, id: 'two' }, bot, 'No')!, /Kept/);
    controls.execute({ action: 'skill_delete', id: saved.skill.id }, bot, run);
    assert.equal(
      controls.confirmation({ ...run, id: 'three', panelAccess: false }, bot, 'Yes'),
      undefined,
    );
    assert.ok(store.get('skills', saved.skill.id));
    assert.match(controls.confirmation({ ...run, id: 'four' }, bot, 'Yes')!, /Deleted/);
    assert.equal(store.get('skills', saved.skill.id), undefined);
  } finally {
    store.close();
  }
});

test('online service choice enables its catalog and keeps routing and effort scoped to the bot', async () => {
  const { store } = database();
  const oldFetch = global.fetch;
  try {
    const p = store.all('providers')[0],
      m = store.all('models')[0];
    store.put('providers', {
      ...p,
      id: 'online-test',
      name: 'Online test',
      local: false,
      enabled: false,
      kind: 'openai-responses',
      baseUrl: 'https://example.com/v1',
      apiKeyEnv: '',
    });
    store.put('models', {
      ...m,
      id: 'online-gpt',
      name: 'gpt-5.1',
      providerId: 'online-test',
      enabled: false,
    });
    const otherBot = store.get('bots', 'research')!;
    const selected = selectBotModel(store, 'calendar', {
      providerId: 'online-test',
      modelId: null,
    });
    assert.equal(selected.providerId, 'online-test');
    assert.equal(store.settings().localOnly, false);
    assert.deepEqual(
      candidates(store, 'general', null, { botId: 'calendar' }).map((m) => m.id),
      ['online-gpt', m.id],
    );
    selectBotModel(store, 'calendar', { modelId: 'online-gpt', reasoningEffort: 'high' });
    assert.deepEqual(store.get('bots', 'research'), otherBot);
    assert.equal(store.get('models', 'online-gpt')?.reasoningEffort, m.reasoningEffort);
    assert.throws(
      () => selectBotModel(store, 'calendar', { providerId: 'online-test', modelId: m.id }),
      /selected service/,
    );
    assert.throws(
      () => selectBotModel(store, 'calendar', { reasoningEffort: 'max' }),
      /does not support/,
    );
    let payload: any;
    global.fetch = (async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Hello.' }],
            },
          ],
          usage: { total_tokens: 4 },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    await complete(
      store.get('providers', 'online-test')!,
      {
        ...store.get('models', 'online-gpt')!,
        reasoningEffort: store.get('bots', 'calendar')!.reasoningEffort ?? undefined,
      },
      [{ role: 'user', content: 'Hi.' }],
      [],
      1000,
      new AbortController().signal,
    );
    assert.equal(payload.reasoning.effort, 'high');
    store.setConfig('settings', { ...store.settings(), localOnly: true });
    assert.ok(candidates(store, 'general', null, { botId: 'calendar' }).every(m => m.providerId !== 'online-test'));
  } finally {
    global.fetch = oldFetch;
    store.close();
  }
});
