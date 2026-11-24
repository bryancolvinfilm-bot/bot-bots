import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { changeBotLifecycle } from '../apps/server/bot-lifecycle';
import { seedTestTeam as seed } from './fixtures/team';
import { Services } from '../apps/server/services';
import { skillFromReply, skillRequested } from '../apps/server/skills';
import { Store } from '../apps/server/store';
import type { Run } from '../packages/shared/types';

const reply = (content: string) => ({
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
          {
            id: 'skill-call',
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { total_tokens: 10 },
});
async function until(ready: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('Skills test timed out');
}
async function fixture(handler: (body: any, store: Store) => unknown = () => reply('Done.')) {
  mkdirSync('test-results/skills', { recursive: true });
  const dir = mkdtempSync(resolve('test-results/skills/case-'));
  const store = new Store(join(dir, 'team.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  const observed: any[] = [];
  const model = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    observed.push(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(handler(body, store)));
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  for (const provider of store.all('providers'))
    store.put('providers', { ...provider, enabled: false, autoDiscover: false });
  store.put('providers', {
    ...store.all('providers')[0],
    enabled: true,
    local: false,
    autoDiscover: false,
    baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  });
  const selectedModel = store.all('models')[0];
  for (const model of store.all('models'))
    store.put('models', { ...model, enabled: model.id === selectedModel.id });
  store.put('models', {
    ...selectedModel,
    enabled: true,
    contextTokens: 131072,
    toolCalling: 'enabled',
  });
  store.setConfig('settings', { ...store.settings(), localOnly: false, mainBotId: null });
  const host = createApp(store, dir, resolve('dist/web'));
  const server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function request(path: string, method = 'GET', body?: unknown) {
    return fetch(`${base}${path}`, {
      method,
      ...(body
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
  }
  async function run(botId: string, prompt: string) {
    const started = host.runtime.create(botId, prompt);
    await until(() => store.get('runs', started.id)?.status !== 'running');
    const done = store.get('runs', started.id)!;
    assert.equal(done.status, 'completed', done.error);
    return done as Run;
  }
  return {
    store,
    host,
    observed,
    request,
    run,
    async close() {
      for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
      await until(() => host.runtime.controllers.size === 0);
      host.runtime.events.emit('shutdown');
      host.google.cancelRun();
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

test('skill Markdown retains nested code fences and requires its matching outer closing fence', () => {
  const content =
    '# API request\n\n```sh\ncurl https://example.com/items\n```\n\nKeep this final instruction.';
  assert.deepEqual(
    skillFromReply('Here is the skill:\n````markdown\n' + content + '\n````\nSaved.'),
    { name: 'API request', content },
  );
  assert.deepEqual(skillFromReply('~~~md\r\n' + content + '\r\n~~~~'), {
    name: 'API request',
    content,
  });
  assert.equal(skillFromReply('````markdown\n' + content + '\n```'), undefined);
  assert.equal(skillFromReply('~~~skill\n' + content + '\n```'), undefined);
  assert.equal(skillRequested('Do not remember this API call for later.'), false);
  assert.equal(skillRequested("Don't keep this endpoint as a skill."), false);
});

test('shared Markdown skills can be created/edited, survive original bot lifecycle and backup restore, and require confirmed deletion', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/skills', 'POST', {
      name: 'Reusable request',
      content: '# Request\n\nGET /items',
      originBotId: 'research',
    });
    assert.equal(created.status, 201);
    const skill = await created.json();
    assert.equal(skill.originBotId, 'research');
    assert.equal(skill.originBotName, f.store.get('bots', 'research')!.name);
    assert.ok(skill.createdAt && skill.updatedAt);
    const edited = await f.request(`/skills/${skill.id}`, 'PUT', {
      name: 'Request v2',
      content: '# Request\n\nGET /items?limit=10',
      originBotId: 'worker1',
    });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).originBotId, 'research');
    changeBotLifecycle(f.store, 'research', 'archive');
    assert.equal(f.store.get('skills', skill.id)!.originBotName, skill.originBotName);
    changeBotLifecycle(f.store, 'research', 'delete');
    const bootstrap = await (await f.request('/bootstrap')).json();
    assert.equal(
      bootstrap.skills.find((entry: any) => entry.id === skill.id).content,
      '# Request\n\nGET /items?limit=10',
    );
    const backup = await (await f.request('/export')).json();
    f.store.remove('skills', skill.id);
    const restored = await f.request('/import', 'POST', backup);
    assert.equal(restored.status, 200, await restored.text());
    assert.equal(f.store.get('skills', skill.id)!.originBotName, skill.originBotName);
    assert.equal(f.store.get('skills', skill.id)!.originBotId, 'research');
    assert.equal((await f.request(`/skills/${skill.id}`, 'DELETE')).status, 400);
    assert.ok(f.store.get('skills', skill.id));
    assert.equal((await f.request(`/skills/${skill.id}`, 'DELETE', { confirm: true })).status, 200);
    assert.equal(f.store.get('skills', skill.id), undefined);
    assert.equal(
      (await f.request('/skills/bot-bots-help', 'DELETE', { confirm: true })).status,
      403,
    );
    assert.equal(
      (await f.request('/skills/bot-bots-help', 'PUT', { content: '# Changed' })).status,
      403,
    );
    assert.equal((await f.request('/skills', 'POST', { name: 'Empty', content: ' ' })).status, 400);
    assert.equal(
      (
        await f.request('/skills', 'POST', {
          name: 'Unknown',
          content: '# Skill',
          originBotId: 'missing',
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test('bot skill_save creates a real shared record and another bot can read its exact Markdown', async () => {
  const f = await fixture((body, store) => {
    if (body.messages.some((message: any) => message.role === 'tool'))
      return reply('The skill is saved or read.');
    if (body.messages.at(-1).content.includes('Read the reusable')) {
      const skill = store.all('skills').find((skill) => skill.name === 'Lookup items')!;
      return call('skill_read', { id: skill.id });
    }
    assert.ok(body.tools.some((tool: any) => tool.function.name === 'skill_save'));
    return call('skill_save', {
      name: 'Lookup items',
      content: '# Lookup items\n\nUse GET /items.',
    });
  });
  try {
    const savedRun = await f.run('research', 'Create a skill for looking up items.');
    const skill = f.store.all('skills').find((skill) => skill.name === 'Lookup items')!;
    assert.equal(skill.originBotId, 'research');
    assert.equal(skill.runId, savedRun.id);
    await f.run('boss-man', 'Read the reusable items playbook.');
    const results = f.observed
      .at(-1)
      .messages.filter((message: any) => message.role === 'tool')
      .map((message: any) => JSON.parse(message.content));
    assert.ok(
      results.some((result: any) => result.id === skill.id && result.content === skill.content),
    );
  } finally {
    await f.close();
  }
});

test('explicit skill requests save supplied or text-only Markdown artifacts, while ordinary code examples stay out of skills', async () => {
  const f = await fixture(() =>
    reply('```markdown\n# API checklist\n\n1. Read the operation.\n2. Run the request.\n```'),
  );
  try {
    const first = await f.run(
      'research',
      'Save this as a skill:\n```markdown\n# Direct skill\n\nUse the documented endpoint.\n```',
    );
    assert.equal(f.observed.length, 0, 'Supplied skill content needs no generation');
    assert.ok(
      f.store
        .all('skills')
        .some((skill) => skill.name === 'Direct skill' && skill.runId === first.id),
    );
    const model = f.store.all('models').find((model) => model.enabled)!;
    f.store.put('models', { ...model, toolCalling: 'disabled' });
    await f.run('research', 'Make a shared skill for an API checklist.');
    assert.ok(
      f.store
        .all('skills')
        .some((skill) => skill.name === 'API checklist' && skill.originBotId === 'research'),
    );
    const rememberedApi = await f.run(
      'research',
      'Remember this API call for future use: GET https://example.com/items',
    );
    assert.ok(f.store.all('skills').some((skill) => skill.runId === rememberedApi.id));
    const before = f.store.all('skills').length;
    await f.run('boss-man', 'Show a Markdown example.');
    assert.equal(f.store.all('skills').length, before);
    assert.equal(skillRequested('Do not create a skill. Show an example instead.'), false);
    assert.equal(skillRequested('Do not store this API call.'), false);
  } finally {
    await f.close();
  }
});

test('saved API catalogs produce reusable shared skills without examples/secrets and preserve owner edits on observation', async () => {
  const f = await fixture();
  try {
    const services = new Services(f.store);
    const api = services.observe(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Items' },
        servers: [{ url: 'https://example.com' }],
        paths: {
          '/items': {
            get: {
              operationId: 'list-items',
              summary: 'Read items',
              parameters: [{ in: 'query', name: 'limit', example: 'secret-example-value' }],
            },
          },
        },
      }),
      'research',
      'test-chat',
    );
    assert.ok(api);
    const skill = f.store.all('skills').find((skill) => skill.apiId === api!.id)!;
    assert.equal(skill.originBotId, 'research');
    assert.match(skill.content, /GET \/items/);
    assert.match(skill.content, /service_call/);
    assert.doesNotMatch(skill.content, /secret-example-value/);
    f.store.put('skills', { ...skill, content: '# Owner edit' });
    services.observe(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Items' },
        servers: [{ url: 'https://example.com' }],
        paths: { '/items': { get: { operationId: 'list-items' } } },
      }),
      'boss-man',
      'another-chat',
    );
    assert.equal(f.store.get('skills', skill.id)!.content, '# Owner edit');
    assert.equal(f.store.get('skills', skill.id)!.originBotId, 'research');
    assert.equal((await f.request(`/skills/${skill.id}`, 'DELETE', { confirm: true })).status, 200);
    new Services(f.store).observe(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Items' },
        servers: [{ url: 'https://example.com' }],
        paths: { '/items': { get: { operationId: 'list-items' } } },
      }),
      'boss-man',
      'another-chat',
    );
    assert.equal(f.store.get('skills', skill.id), undefined);
    assert.equal(
      f.store.all('skills').filter((entry) => entry.apiId === api!.id).length,
      0,
      'Deleted API skills must not reappear on restart or later observation',
    );
  } finally {
    await f.close();
  }
});
