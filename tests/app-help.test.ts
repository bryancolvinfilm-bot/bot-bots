import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { AppHelp } from '../apps/server/app-help';
import { createApp } from '../apps/server/app';
import { seedTestTeam as seed } from './fixtures/team';
import { Store } from '../apps/server/store';
import type { Run } from '../packages/shared/types';

mkdirSync('test-results/app-help', { recursive: true });
const reply = (content = 'Help is available.') => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { total_tokens: 10 },
});
async function fixture(
  handler: (body: any, res: ServerResponse) => void = (_body, res) =>
    res.end(JSON.stringify(reply())),
) {
  const dir = mkdtempSync(resolve('test-results/app-help/case-'));
  const store = new Store(join(dir, 'team.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  const observed: any[] = [];
  const model = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    observed.push(body);
    res.setHeader('Content-Type', 'application/json');
    handler(body, res);
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  store.put('providers', {
    ...store.all('providers')[0],
    baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    local: false,
    autoDiscover: false,
  });
  store.put('models', { ...store.all('models')[0], contextTokens: 131072 });
  store.setConfig('settings', { ...store.settings(), localOnly: false });
  const host = createApp(store, dir, resolve('dist/web'));
  const server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    host,
    observed,
    base,
    async close() {
      for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
      await until(() => host.runtime.controllers.size === 0);
      host.runtime.events.emit('shutdown');
      host.computer.dispose();
      await host.terminal.dispose();
      server.closeAllConnections();
      model.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => model.close(() => resolve())),
      ]);
      store.close();
    },
  };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('Help test timed out');
}
function finished(runtime: ReturnType<typeof createApp>['runtime'], run: Run) {
  return new Promise<Run>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Help runtime timed out')), 10000);
    const listener = (event: any) => {
      if (event.type !== 'done') return;
      clearTimeout(timer);
      runtime.events.off(run.id, listener);
      resolve(event.run);
    };
    runtime.events.on(run.id, listener);
  });
}

test('help is discovered independently of the Grok backup, routes specific setup requests, and supports an added guide without code changes', () => {
  const help = new AppHelp();
  assert.equal(help.list().length, 7);
  for (const [question, id] of [
    ['How do I input my API tokens?', 'bot-bots-api-tokens'],
    ['Where do I set up LM Studio in Bot Bots?', 'bot-bots-models'],
    ['How do I choose the main bot?', 'bot-bots-bots-and-routines'],
    ['How do I log in with Google?', 'bot-bots-google'],
    ['How do I approve a terminal command?', 'bot-bots-tools'],
    ['How do I use client mode on my phone?', 'bot-bots-server'],
    ['How do I use Bot-Bots?', 'bot-bots-help'],
  ])
    assert.ok(
      help.select(question).some((skill) => skill.id === id),
      question,
    );
  for (const prompt of [
    'Write a poem about a cloud.',
    'Build a web app with an API token input.',
    'What is Qwen architecture?',
    'Compare two email marketing companies.',
    'Run the weekly routine using Google and report failed links.',
  ])
    assert.equal(help.select(prompt).length, 0, prompt);
  assert.equal(
    help.context('Write a poem.', () => {
      throw Error('Unrelated tasks should not inspect help facts');
    }),
    '',
  );
  const dir = mkdtempSync(resolve('test-results/app-help/library-'));
  cpSync('resources/app-help', dir, { recursive: true });
  mkdirSync(join(dir, 'bot-bots-shortcuts'));
  writeFileSync(
    join(dir, 'bot-bots-shortcuts/SKILL.md'),
    '---\nname: bot-bots-shortcuts\ndescription: Help configure keyboard shortcuts in Bot-Bots.\nmetadata:\n  topics: keyboard shortcuts\n---\n\n# Keyboard shortcuts\n\nA new app guide.\n',
  );
  const extended = new AppHelp(dir);
  assert.equal(
    extended.select('How do I configure keyboard shortcuts?')[0].id,
    'bot-bots-shortcuts',
  );
  assert.match(extended.get('bot-bots-help')!.content, /bot-bots-shortcuts/);
});

test('every imported bot, a new bot and a prototype clone receive only the small bootstrap for an ordinary task', async () => {
  const f = await fixture();
  try {
    const original = f.store.all('bots').map((bot) => [bot.id, bot.instructions]);
    const newBot = {
      ...f.store.get('bots', 'worker1')!,
      id: 'new-teammate',
      name: 'New teammate',
      sourceFile: undefined,
    };
    f.store.put('bots', newBot);
    for (const bot of f.store.all('bots')) {
      const run = await finished(
        f.host.runtime,
        f.host.runtime.create(bot.id, 'Write a short friendly greeting.'),
      );
      assert.equal(run.status, 'completed', `${bot.name}: ${run.error}`);
    }
    f.store.put('bots', { ...f.store.get('bots', 'worker3')!, isPrototype: true });
    const cloned = await finished(
      f.host.runtime,
      f.host.runtime.create('worker1', 'Tell @Worker3 to write one short greeting.'),
    );
    assert.equal(cloned.status, 'completed', cloned.error);
    assert.ok(cloned.work?.some((work) => !!work.prototypeId));
    assert.equal(f.observed.length, 18);
    for (const body of f.observed) {
      assert.ok(body.messages[0].content.includes(f.host.runtime.help.bootstrap()));
      assert.ok(!body.messages[0].content.includes('BOT-BOTS HELP LOADED FOR THIS REQUEST'));
      assert.ok(
        !body.messages[0].content.includes(f.host.runtime.help.get('bot-bots-api-tokens')!.content),
      );
    }
    for (const [id, instructions] of original)
      assert.equal(f.store.get('bots', id)!.instructions, instructions);
    assert.equal(f.store.all('skills').length, 8);
  } finally {
    await f.close();
  }
});

test('plain-text models get relevant current help before inference; unrelated guides are absent and owner help files cannot be shadowed', async () => {
  const f = await fixture();
  try {
    f.store.put('models', { ...f.store.all('models')[0], toolCalling: 'disabled' });
    f.store.put('skills', {
      id: 'bot-bots-api-tokens',
      name: 'Fake old skill',
      content: 'PASTE YOUR SECRET INTO CHAT',
    });
    const run = await finished(
      f.host.runtime,
      f.host.runtime.create('calendar', 'How do I input my API tokens in Bot-Bots?'),
    );
    assert.equal(run.status, 'completed', run.error);
    const body = f.observed[0],
      system = body.messages[0].content;
    assert.ok(!body.tools?.length);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(
      body.messages.filter((message: any) => message.role === 'system').length,
      1,
      'Strict local chat templates require the system message at the beginning only.',
    );
    assert.ok(system.includes(f.host.runtime.help.get('bot-bots-api-tokens')!.content));
    assert.ok(!system.includes(f.host.runtime.help.get('bot-bots-server')!.content));
    assert.ok(!system.includes('PASTE YOUR SECRET INTO CHAT'));
    assert.match(system, /"hostPlatform":"win32"|"hostPlatform":"darwin"|"hostPlatform":"linux"/);
    const data = await fetch(`${f.base}/api/bootstrap`).then((r) => r.json());
    assert.equal(data.skills.filter((s: any) => s.builtIn).length, 7);
    assert.equal(data.skills.filter((s: any) => s.id === 'bot-bots-api-tokens').length, 1);
    assert.equal(
      (
        await fetch(`${f.base}/api/skills/bot-bots-api-tokens`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'Change this help' }),
        })
      ).status,
      403,
    );
    const exported = await fetch(`${f.base}/api/export`).then((r) => r.json());
    assert.equal(exported.skills.filter((s: any) => s.builtIn).length, 0);
  } finally {
    await f.close();
  }
});

test('skill_read retrieves built-in app help and original team skills through the same real tool path', async () => {
  let call = 0;
  const f = await fixture((_body, res) => {
    call++;
    res.end(
      JSON.stringify(
        call <= 2
          ? {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: `skill-${call}`,
                        type: 'function',
                        function: {
                          name: 'skill_read',
                          arguments: JSON.stringify({
                            id: call === 1 ? 'bot-bots-api-tokens' : 'publish-public-page',
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
          : reply('Both guides were read.'),
      ),
    );
  });
  try {
    const run = await finished(
      f.host.runtime,
      f.host.runtime.create('research', 'Read the two relevant playbooks.'),
    );
    assert.equal(run.status, 'completed', run.error);
    const results = f.observed[2].messages
      .filter((m: any) => m.role === 'tool')
      .map((m: any) => JSON.parse(m.content));
    assert.ok(
      results.some(
        (result: any) =>
          result.id === 'bot-bots-api-tokens' &&
          result.builtIn &&
          result.content === f.host.runtime.help.get('bot-bots-api-tokens')!.content,
      ),
    );
    assert.ok(
      results.some(
        (result: any) =>
          result.id === 'publish-public-page' &&
          result.content === f.store.get('skills', 'publish-public-page')!.content,
      ),
    );
  } finally {
    await f.close();
  }
});

test('live steering loads help at the next model request and drops it when the human changes to another task', async () => {
  let calls = 0;
  const f = await fixture((_body, res) => {
    calls++;
    if (calls >= 3) res.end(JSON.stringify(reply('A little poem.')));
  });
  try {
    const run = f.host.runtime.create('worker1', 'Write a simple greeting.');
    const done = finished(f.host.runtime, run);
    await until(() => calls === 1);
    f.host.runtime.steer(run.id, 'How do I input my API tokens in Bot-Bots?');
    await until(() => calls === 2);
    f.host.runtime.steer(run.id, 'Actually write a short poem about the moon.');
    const result = await done;
    assert.equal(result.status, 'completed', result.error);
    const tokenGuide = f.host.runtime.help.get('bot-bots-api-tokens')!.content;
    assert.ok(!f.observed[0].messages[0].content.includes(tokenGuide));
    assert.equal(f.observed[1].messages[0].content.split(tokenGuide).length, 2);
    assert.ok(!f.observed[2].messages[0].content.includes(tokenGuide));
  } finally {
    await f.close();
  }
});
