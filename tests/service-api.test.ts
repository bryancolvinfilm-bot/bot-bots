import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { Credentials } from '../apps/server/credentials';
import type { SecretBackend } from '../apps/server/host-secrets';
import { seedTestTeam as seed } from './fixtures/team';
import { pageZip } from '../apps/server/page-zip';
import { publishIntent } from '../apps/server/services';
import { Store } from '../apps/server/store';
import { PAGES_API } from '../packages/shared/service-api';
import { wantsPrivateEntry } from '../packages/shared/credential-setup';
import { Computer, type BrowserDriver } from '../apps/server/computer';
import type { BrowserTab } from '../packages/shared/computer';

const secret = 'TEST_ONLY_SHARED_API_TOKEN';

test('publishing intent recognizes putting pages on Bottools and short URLs including live steering', () => {
  assert.deepEqual(
    publishIntent({ prompt: 'can you put a simple hello world webpage on bottools?' }),
    { wanted: true, short: false },
  );
  assert.deepEqual(
    publishIntent({
      prompt: 'you didnt make a pag',
      steering: [
        {
          content:
            "also at the end you're supposed to put it on bottools.online and give me back a short url",
        } as any,
      ],
    }),
    { wanted: true, short: true },
  );
  assert.deepEqual(publishIntent({ prompt: 'Give me a short URL for this page.' }), {
    wanted: true,
    short: true,
  });
  assert.deepEqual(publishIntent({ prompt: 'can you post that on bottools?' }), {
    wanted: true,
    short: false,
  });
  assert.deepEqual(publishIntent({ prompt: "Don't put this page on bottools.online." }), {
    wanted: false,
    short: false,
  });
});
class Secrets implements SecretBackend {
  kind = 'Test OS store';
  values = new Map<string, string>();
  get(id: string) {
    return this.values.get(id) ?? null;
  }
  set(id: string, value: string) {
    this.values.set(id, value);
  }
  delete(id: string) {
    return this.values.delete(id);
  }
}
async function until(fn: () => boolean) {
  for (let n = 0; n < 700; n++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Service check timed out');
}
async function fixture(
  reply: (body: any) => unknown = () => ({
    choices: [
      {
        message: { content: '```html\n<!doctype html><h1>Published counter</h1>\n```' },
        finish_reason: 'stop',
      },
    ],
  }),
) {
  mkdirSync('test-results/unit', { recursive: true });
  const dir = mkdtempSync(resolve('test-results/unit/service-api-')),
    store = new Store(join(dir, 'team.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  const bodies: any[] = [],
    requests: { url: string; method: string; body?: Buffer; auth?: string }[] = [];
  const backend = new Secrets();
  const broker = new Credentials(join(dir, 'external'), backend, join(dir, 'workspace'), (async (
    url,
    init,
  ) => {
    const headers = init?.headers as Record<string, string>;
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : undefined;
    requests.push({
      url: String(url),
      method: String(init?.method),
      body,
      auth: headers.Authorization,
    });
    const pathname = new URL(String(url)).pathname;
    let data: any = { ok: true };
    if (pathname.endsWith('/deploys') && init?.method === 'POST') {
      assert.ok(body);
      assert.equal(body.readUInt32LE(0), 0x04034b50);
      assert.equal(headers['Content-Type'], 'application/zip');
      assert.equal(Number(headers['Content-Length']), body.length);
      const site = pathname.split('/').at(-2)!;
      data = { state: 'ready', ssl_url: `${PAGES_API.baseUrl}/sites/${site}/`, id: 'deploy-id' };
    } else if (pathname.endsWith('/short-links') && init?.method === 'POST')
      data = { short_url: 'https://bottools.online/s/test-only', code: 'test-only' };
    else if (init?.method === 'GET')
      data = [
        {
          id: 'site-id',
          name: 'test',
          metadata: { description: 'Useful nested info', token: secret },
          echo: secret,
        },
      ];
    return new Response(JSON.stringify(data), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch);
  const model = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    bodies.push(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(reply(body)));
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  for (const p of store.all('providers'))
    store.put('providers', {
      ...p,
      autoDiscover: false,
      baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    });
  const host = createApp(store, dir, resolve('dist/web'), '', undefined, undefined, broker),
    server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const connect = () =>
    broker.manager().save({
      version: broker.manager().state().version,
      name: 'pages',
      kind: 'api-key',
      value: secret,
      target: {
        type: 'service',
        api: PAGES_API,
        botIds: ['info-page-generate'],
        approval: 'connected',
      },
    });
  return {
    dir,
    store,
    host,
    broker,
    backend,
    bodies,
    requests,
    api,
    connect,
    async close() {
      for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
      await until(() => !host.runtime.controllers.size);
      host.runtime.events.emit('shutdown');
      host.computer.dispose();
      await host.terminal.dispose();
      model.closeAllConnections();
      server.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => model.close(() => r())),
        new Promise<void>((r) => server.close(() => r())),
      ]);
      store.close();
    },
  };
}
test('local API validation failures create no uncertain receipt and can be corrected safely', async () => {
  const f = await fixture();
  try {
    const { grantId } = f.connect();
    const bot = f.store.get('bots', 'info-page-generate')!;
    const run = f.host.runtime.create(bot.id, 'Local preview only.');
    await until(() => !f.host.runtime.controllers.size);
    for (let n = 0; n < 2; n++)
      await assert.rejects(
        f.host.runtime.services.call(
          grantId!,
          'deploy',
          { site: 'example' },
          {},
          bot,
          run,
          new AbortController().signal,
        ),
        /saved page ID/,
      );
    assert.equal(f.requests.length, 0);
    assert.equal(f.store.all('serviceActions').length, 0);
    const page = f.store.all('pages').find((page) => page.runId === run.id)!;
    await f.host.runtime.services.call(
      grantId!,
      'deploy',
      { site: 'example' },
      {},
      bot,
      run,
      new AbortController().signal,
      page.id,
    );
    assert.equal(f.requests.length, 1);
    assert.equal(f.store.all('serviceActions')[0].status, 'completed');
  } finally {
    await f.close();
  }
});

test('a model raw deploy without a page ID uses its saved HTML and the authorized publishing adapter', async () => {
  let count = 0;
  const tool = (name: string, args: unknown) => ({
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
  });
  const f = await fixture(() => {
    if (++count === 1)
      return tool('page_create', {
        title: 'Hello',
        format: 'html',
        content: '<!doctype html><h1>Hello world</h1>',
      });
    if (count === 2)
      return tool('service_call', {
        serviceId: 'bottools-pages',
        operationId: 'deploy',
        paramsJson: '{"site":"https://bottools.online/wrong"}',
        inputJson: '{"html":"wrong raw input"}',
      });
    return { choices: [{ message: { content: 'The page is published.' }, finish_reason: 'stop' }] };
  });
  try {
    f.connect();
    const run = f.host.runtime.create(
      'info-page-generate',
      'Put a hello world page on bottools.online and give me a short URL.',
    );
    await until(() => !f.host.runtime.controllers.size);
    assert.equal(
      f.store.get('runs', run.id)!.status,
      'completed',
      f.store.get('runs', run.id)!.error,
    );
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests[0].body?.includes(Buffer.from('Hello world')));
    assert.equal(
      f.store.all('pages')[0].publication?.shortUrl,
      'https://bottools.online/s/test-only',
    );
  } finally {
    await f.close();
  }
});

test('explicitly publishing a saved page ID does not ask a model to regenerate it', async () => {
  const f = await fixture();
  try {
    f.connect();
    f.store.put('pages', {
      id: 'saved-family-page',
      botId: 'family-events',
      title: 'Existing page',
      content: '<!doctype html><h1>Existing saved page</h1>',
      format: 'html',
      createdAt: new Date().toISOString(),
    });
    const run = f.host.runtime.create(
      'info-page-generate',
      'Publish page ID saved-family-page on bottools.online as a short URL.',
    );
    await until(() => !f.host.runtime.controllers.size);
    assert.equal(
      f.store.get('runs', run.id)!.status,
      'completed',
      f.store.get('runs', run.id)!.error,
    );
    assert.equal(f.bodies.length, 0);
    assert.equal(f.requests.length, 2);
    assert.equal(f.store.all('drafts').length, 0);
    assert.equal(
      f.store.get('pages', 'saved-family-page')!.publication?.shortUrl,
      'https://bottools.online/s/test-only',
    );
  } finally {
    await f.close();
  }
});

test('post that publishes the page in this conversation with its earlier short-link preference and no model calls', async () => {
  const f = await fixture();
  try {
    f.connect();
    const botId = 'info-page-generate';
    const first = f.host.runtime.create(botId, 'Prepare an HTML page locally.');
    await until(() => !f.host.runtime.controllers.size);
    const page = f.store.all('pages').find((p) => p.runId === first.id)!;
    assert.ok(page);
    f.store.put('messages', {
      id: 'earlier-short-preference',
      botId,
      conversationId: first.conversationId,
      role: 'user',
      content: 'When you publish it, give me a short URL.',
      createdAt: new Date().toISOString(),
    });
    f.store.put('pages', {
      ...page,
      id: 'unrelated-page',
      runId: undefined,
      content: '<h1>Unrelated conversation</h1>',
      createdAt: new Date().toISOString(),
    });
    const before = f.bodies.length;
    const next = f.host.runtime.create(
      botId,
      'can you post that on bottools?',
      first.conversationId,
    );
    await until(() => !f.host.runtime.controllers.size);
    assert.equal(
      f.store.get('runs', next.id)!.status,
      'completed',
      f.store.get('runs', next.id)!.error,
    );
    assert.equal(f.bodies.length, before);
    assert.equal(
      f.store.get('pages', page.id)!.publication?.shortUrl,
      'https://bottools.online/s/test-only',
    );
    assert.equal(f.store.get('pages', 'unrelated-page')!.publication, undefined);
  } finally {
    await f.close();
  }
});

test('one stored token connects the entire API, supports ZIP and nested results, and never reaches a model or export', async () => {
  const f = await fixture();
  try {
    const { grantId } = f.connect(),
      bot = f.store.get('bots', 'info-page-generate')!;
    assert.equal(
      f.broker.serviceCapabilities(bot)[0].api.operations.length,
      PAGES_API.operations.length,
    );
    assert.equal(f.broker.serviceCapabilities(f.store.get('bots', 'worker1')!).length, 1);
    const data = await f.broker.serviceRequest(
      grantId!,
      'list-sites',
      {},
      {},
      bot,
      new AbortController().signal,
    );
    assert.equal(data[0].metadata.description, 'Useful nested info');
    assert.ok(!JSON.stringify(data).includes(secret));
    assert.equal(data[0].echo, '[secret hidden]');
    assert.equal(f.requests[0].auth, `Bearer ${secret}`);
    assert.ok(!JSON.stringify(f.store.export()).includes(secret));
    await assert.rejects(
      f.broker.serviceRequest(
        grantId!,
        'get-site',
        { site: '../elsewhere' },
        {},
        bot,
        new AbortController().signal,
      ),
      /path parameters/,
    );
    const run = f.host.runtime.create(bot.id, 'Make me a site and pass back a short link.');
    await until(() => !f.host.runtime.controllers.has(run.id));
    assert.equal(
      f.store.get('runs', run.id)!.status,
      'completed',
      f.store.get('runs', run.id)!.error,
    );
    assert.equal(f.requests.filter((request) => request.method === 'POST').length, 2);
    const page = f.store.all('pages').find((page) => page.runId === run.id)!;
    assert.equal(page.publication?.shortUrl, 'https://bottools.online/s/test-only');
    assert.equal(
      f.store
        .all('messages')
        .findLast((message) => message.runId === run.id && message.role === 'assistant')!.content,
      'https://bottools.online/s/test-only',
    );
    assert.ok(f.bodies[0].messages[0].content.includes(grantId));
    assert.ok(!JSON.stringify(f.bodies).includes(secret));
    await f.host.runtime.services.publish(page, bot, run, new AbortController().signal, true);
    for (const alias of [
      'bottools-pages',
      'Pages publishing',
      'Bottools Pages',
      'bottools.online/nettools/webhost',
      'https://bottools.online/nettools/webhost/',
    ]) {
      const published = await f.host.runtime.services.publish(
        page,
        bot,
        run,
        new AbortController().signal,
        true,
        alias,
      );
      assert.equal(published.shortUrl, 'https://bottools.online/s/test-only');
      assert.equal(f.host.runtime.services.connection(bot, alias)!.id, grantId);
    }
    assert.equal(
      f.requests.filter((request) => request.method === 'POST').length,
      2,
      'A completed publication is not repeated.',
    );
    f.broker.manager().revoke(grantId!, f.broker.manager().state().version);
    assert.equal(f.broker.serviceCapabilities(bot).length, 0);
    await assert.rejects(
      f.broker.serviceRequest(grantId!, 'list-sites', {}, {}, bot, new AbortController().signal),
      /unavailable|revoked/,
    );
  } finally {
    await f.close();
  }
});
test('an existing private token upgrades once without re-entry or one-grant-per-endpoint loops', async () => {
  const f = await fixture();
  try {
    const saved = f.broker.manager().save({
      version: f.broker.manager().state().version,
      name: 'pages',
      kind: 'api-key',
      value: secret,
      target: { type: 'store' },
    });
    const response = await f.api('/credentials/manager/connect-service', 'POST', {
      version: f.broker.manager().state().version,
      secretId: saved.id,
      api: PAGES_API,
      botIds: ['info-page-generate'],
      approval: 'connected',
    });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(f.backend.values.size, 1);
    assert.ok(!JSON.stringify(response.data).includes(secret));
    const request = await f.api('/credentials/manager/requests', 'POST', {
      botId: 'info-page-generate',
      service: 'Pages publishing',
    });
    assert.equal(request.data.api.id, PAGES_API.id);
    const apiDump =
      'Here is the full API documentation:\n' +
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Example API' },
        servers: [{ url: 'https://example.test/v1' }],
        paths: { '/records': { get: { operationId: 'listRecords', summary: 'List records' } } },
      });
    assert.equal(wantsPrivateEntry(apiDump), false);
    const run = f.host.runtime.create('worker1', apiDump);
    await until(() => !f.host.runtime.controllers.has(run.id));
    assert.ok(f.store.all('apiDefinitions').some((api) => api.name === 'Example API'));
  } finally {
    await f.close();
  }
});
test('chat messages keep stable identities across retries, steering and reloads; publishing respects explicit local-only intent', async () => {
  const f = await fixture(() => ({
    choices: [{ message: { content: 'Done' }, finish_reason: 'stop' }],
  }));
  try {
    const id = crypto.randomUUID(),
      prompt = 'Make me a site and pass back a short link';
    assert.equal(wantsPrivateEntry(prompt), false);
    const first = await f.api('/runs', 'POST', {
      botId: 'info-page-generate',
      prompt,
      clientMessageId: id,
    });
    assert.equal(first.status, 202);
    const second = await f.api('/runs', 'POST', {
      botId: 'info-page-generate',
      prompt,
      clientMessageId: id,
    });
    assert.equal(second.data.id, first.data.id);
    await until(() => !f.host.runtime.controllers.size);
    const messages = await f.api(`/conversations/${first.data.conversationId}/messages`);
    assert.equal(messages.data.filter((message: any) => message.id === id).length, 1);
    assert.equal(messages.data.find((message: any) => message.id === id).content, prompt);
    assert.deepEqual(
      publishIntent({
        prompt,
        steering: [{ content: 'Do not publish; local preview only.' } as any],
      }),
      { wanted: false, short: false },
    );
    assert.deepEqual(
      publishIntent({
        prompt:
          'Here is the full API documentation: POST /deploy to publish a page and return a short link.',
        steering: [],
      }),
      { wanted: false, short: false },
    );
  } finally {
    await f.close();
  }
});

test('a token connected during a running conversation is usable immediately without reopening its private window', async () => {
  const call = (name: string, args: unknown) => ({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: crypto.randomUUID(),
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  const f = await fixture((body) => {
    const results = body.messages.filter((message: any) => message.role === 'tool');
    if (results.length < 2)
      return call('credential_setup_request', {
        service: results.length === 0 ? 'Pages publishing' : 'bottools.online/nettools/webhost',
        purpose: 'Connect the complete supplied API',
      });
    if (results.length === 2) return call('service_list', {});
    return {
      choices: [{ message: { content: 'The full service is ready.' }, finish_reason: 'stop' }],
    };
  });
  try {
    const run = f.host.runtime.create(
      'info-page-generate',
      'Connect my Pages API and tell me when it is ready.',
    );
    await until(() =>
      f.host.runtime.setups.list().some((request) => request.status === 'awaiting-entry'),
    );
    const setup = f.host.runtime.setups.list()[0];
    const saved = await f.api('/credentials/manager/secrets', 'POST', {
      version: f.broker.manager().state().version,
      requestId: setup.id,
      name: 'Pages publishing',
      kind: 'api-key',
      value: secret,
      target: {
        type: 'service',
        api: PAGES_API,
        botIds: ['info-page-generate'],
        approval: 'connected',
      },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    await until(() => !f.host.runtime.controllers.has(run.id));
    assert.equal(
      f.store.get('runs', run.id)!.status,
      'completed',
      f.store.get('runs', run.id)!.error,
    );
    assert.equal(
      f.host.runtime.setups.list().length,
      1,
      'Already-connected setup requests must not reopen the form.',
    );
    assert.equal(f.host.runtime.setups.list()[0].connected, true);
    const grant = f.broker.serviceCapabilities(f.store.get('bots', 'info-page-generate')!)[0];
    for (const body of f.bodies.slice(1))
      assert.ok(
        body.messages[0].content.includes(grant.id),
        'Live model context must refresh after private entry.',
      );
    assert.match(
      f.bodies[1].messages.findLast((message: any) => message.role === 'tool').content,
      /complete API catalog/,
    );
    assert.match(
      f.bodies[2].messages.findLast((message: any) => message.role === 'tool').content,
      /already connected/,
    );
    assert.ok(!JSON.stringify(f.bodies).includes(secret));
    for (const operation of PAGES_API.operations) {
      const params = Object.fromEntries(
        [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => [match[1], 'test-site']),
      );
      await f.broker.serviceRequest(
        grant.id,
        operation.id,
        params,
        {},
        f.store.get('bots', 'info-page-generate')!,
        new AbortController().signal,
        operation.body === 'page-zip' ? pageZip('<h1>Test</h1>') : undefined,
      );
    }
    assert.equal(f.requests.length, PAGES_API.operations.length);
    assert.ok(f.requests.every((request) => request.auth === `Bearer ${secret}`));
    await f.host.runtime.services.call(
      'Bottools Pages',
      'info',
      {},
      {},
      f.store.get('bots', 'info-page-generate')!,
      f.store.get('runs', run.id)!,
      new AbortController().signal,
    );
    f.broker.manager().revoke(grant.id, f.broker.manager().state().version);
    const requests = await f.api('/credentials/manager/requests');
    assert.equal(
      requests.data.find((request: any) => request.id === setup.id).connected,
      false,
      'A revoked connection must not remain Ready in chat.',
    );
  } finally {
    await f.close();
  }
});

test('API accounts are shared team-wide; explicit IDs survive and new requests use the latest connection', async () => {
  const f = await fixture();
  try {
    const original = f.connect();
    const added = f.broker.manager().save({
      version: f.broker.manager().state().version,
      name: 'Other Pages account',
      kind: 'api-key',
      value: 'OTHER_TEST_TOKEN',
      target: { type: 'service', api: PAGES_API, botIds: ['worker1'], approval: 'connected' },
    });
    assert.equal(
      f.broker.serviceCapabilities(f.store.get('bots', 'info-page-generate')!).length,
      2,
    );
    assert.equal(f.broker.serviceCapabilities(f.store.get('bots', 'worker1')!).length, 2);
    const bot = f.store.get('bots', 'worker1')!;
    assert.equal(f.host.runtime.services.connection(bot, '', PAGES_API.id)?.id, added.grantId);
    assert.equal(f.host.runtime.services.connection(bot, original.grantId)?.id, original.grantId);
    assert.equal(
      f.broker
        .manager()
        .state()
        .connections.filter((connection) => connection.purpose === 'service').length,
      2,
    );
  } finally {
    await f.close();
  }
});

test('restarting the host retains uncertain external write receipts and never silently repeats them', async () => {
  const f = await fixture();
  try {
    const { grantId } = f.connect(),
      bot = f.store.get('bots', 'info-page-generate')!;
    const run = f.host.runtime.create(bot.id, 'Local preview only.');
    await until(() => !f.host.runtime.controllers.size);
    const result = await f.host.runtime.services.call(
      grantId!,
      'create-site',
      {},
      { name: 'example' },
      bot,
      run,
      new AbortController().signal,
    );
    assert.ok(result);
    const receipt = f.store.all('serviceActions')[0];
    f.store.put('serviceActions', { ...receipt, status: 'running', result: undefined });
    const { Services } = await import('../apps/server/services');
    const restored = new Services(f.store, f.broker);
    assert.equal(f.store.get('serviceActions', receipt.id)!.status, 'failed');
    await assert.rejects(
      restored.call(
        grantId!,
        'create-site',
        {},
        { name: 'example' },
        bot,
        run,
        new AbortController().signal,
      ),
      /already attempted/,
    );
    assert.equal(f.requests.length, 1);
    assert.equal(f.store.export().serviceActions.length, 1);
  } finally {
    await f.close();
  }
});
test('generated ZIP has a verified CRC and a root index.html without a shell command', () => {
  const zip = pageZip('123456789');
  assert.equal(zip.readUInt32LE(14), 0xcbf43926);
  assert.equal(zip.subarray(30, 40).toString(), 'index.html');
  assert.equal(zip.subarray(40, 49).toString(), '123456789');
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});
test('thirty workers obtain bounded independent browser sessions fairly; cancellation and delegation yield slots', async () => {
  const tabs: BrowserTab[] = [];
  const driver: BrowserDriver = {
    tabs: () => tabs,
    create: (tab) => {
      tabs.push(tab);
    },
    select: () => {},
    close: (id) => {
      tabs.splice(
        tabs.findIndex((tab) => tab.id === id),
        1,
      );
    },
    dispose: () => {},
    capture: async () => ({ image: '', width: 1, height: 1 }),
    act: async (id) => ({
      tabId: id,
      title: 'ok',
      url: 'https://example.test',
      text: 'source',
      elements: [],
    }),
  };
  const computer = new Computer(driver);
  computer.maxBotSessions = 2;
  const a = await computer.acquireBotTab('a', 'run'),
    b = await computer.acquireBotTab('b', 'run');
  let acquired = false;
  const abort = new AbortController();
  const cancelled = computer.acquireBotTab('cancel', 'run', '', abort.signal);
  const waiting = computer.acquireBotTab('c', 'run').then((id) => {
    acquired = true;
    return id;
  });
  assert.equal(computer.state().pool!.waiting.length, 2);
  abort.abort(Error('Cancelled browser'));
  await assert.rejects(cancelled, /Cancelled/);
  assert.equal(acquired, false);
  computer.yieldBrowserSlot('a', 'run');
  const c = await waiting;
  assert.notEqual(c, a);
  computer.releaseWork('b', 'run');
  assert.equal(
    await computer.acquireBotTab('a', 'run'),
    a,
    'A delegator retains its own page when it reacquires a slot.',
  );
  computer.releaseWork('a', 'run');
  computer.releaseWork('c', 'run');
  const ids = new Set<string>();
  await Promise.all(
    Array.from({ length: 30 }, async (_, n) => {
      const id = await computer.acquireBotTab(`worker-${n}`, 'batch');
      ids.add(id);
      assert.ok(computer.state().pool!.active <= 2);
      await new Promise((r) => setTimeout(r, 2));
      computer.releaseWork(`worker-${n}`, 'batch');
    }),
  );
  assert.equal(ids.size, 30);
  assert.equal(computer.state().pool!.waiting.length, 0);
  assert.ok(computer.state().tabs.length < 20);
  assert.ok(b);
  computer.dispose();
});
