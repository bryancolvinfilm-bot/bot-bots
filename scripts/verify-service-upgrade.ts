import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createApp } from '../apps/server/app';
import { Credentials } from '../apps/server/credentials';
import type { SecretBackend } from '../apps/server/host-secrets';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import { Store } from '../apps/server/store';
import { PAGES_API } from '../packages/shared/service-api';

const dir = resolve(`test-results/service-upgrade/ui-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const executablePath = process.env.BOT_BOTS_TEST_EXECUTABLE;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE',
  ),
) as Record<string, string>;
const answer = (content: string) => ({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { total_tokens: 8 },
});
const call = (name: string, args: unknown) => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          { id: 'tool', type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { total_tokens: 8 },
});
async function until(fn: () => boolean, limit = 1500) {
  for (let i = 0; i < limit; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Service upgrade UI check timed out');
}

// Phase one: a complete connection and publication through a simulated remote API.
class Secrets implements SecretBackend {
  kind = 'Isolated OS store';
  value = new Map<string, string>();
  get(id: string) {
    return this.value.get(id) ?? null;
  }
  set(id: string, value: string) {
    this.value.set(id, value);
  }
  delete(id: string) {
    return this.value.delete(id);
  }
}
const store = new Store(join(dir, 'service-host/team.sqlite'));
seed(store, resolve('reference/grok-backup'));
const backend = new Secrets(),
  apiCalls: { method: string; url: string; zip: boolean }[] = [],
  bodies: any[] = [];
let releaseModel = () => {};
const broker = new Credentials(join(dir, 'external'), backend, join(dir, 'workspace'), (async (
  url,
  init,
) => {
  const path = new URL(String(url)).pathname,
    zip = String((init?.headers as any)?.['Content-Type']) === 'application/zip';
  apiCalls.push({ method: String(init?.method), url: String(url), zip });
  const site = path.split('/').at(-2);
  return new Response(
    JSON.stringify(
      zip
        ? { state: 'ready', ssl_url: `${PAGES_API.baseUrl}/sites/${site}/` }
        : { short_url: 'https://bottools.online/s/simulated-ui' },
    ),
    { status: 201, headers: { 'Content-Type': 'application/json' } },
  );
}) as typeof fetch);
const model = createServer(async (req, res) => {
  let text = '';
  for await (const part of req) text += part;
  const body = JSON.parse(text);
  bodies.push(body);
  res.setHeader('Content-Type', 'application/json');
  const prompt =
    body.messages.filter((message: any) => message.role === 'user').at(-1)?.content ?? '';
  if (prompt === 'Make me a site and pass back a short link.') {
    releaseModel = () =>
      res.end(
        JSON.stringify(answer('```html\n<!doctype html><h1>Real saved publication</h1>\n```')),
      );
    return;
  }
  res.end(JSON.stringify(answer('The supplied Pages API documentation is understood.')));
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
for (const p of store.all('providers'))
  store.put('providers', {
    ...p,
    autoDiscover: false,
    baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  });
store.put('conversations', {
  id: 'old-thread',
  botId: 'info-page-generate',
  title: 'An older thread',
  createdAt: new Date(0).toISOString(),
});
const host = createApp(
    store,
    join(dir, 'service-host'),
    resolve('dist/web'),
    '',
    undefined,
    undefined,
    broker,
  ),
  server = host.app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
let app = await electron.launch({
  executablePath,
  args: executablePath ? [] : ['.'],
  env: {
    ...env,
    BOT_BOTS_DATA_DIR: join(dir, 'service-client'),
    BOT_BOTS_MODE: 'client',
    BOT_BOTS_SERVER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  },
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1500, height: 1000 });
  let releaseOld = () => {},
    held = false;
  await page.route('**/api/conversations?botId=info-page-generate', async (route) => {
    if (held) {
      await route.continue();
      return;
    }
    held = true;
    const response = await route.fetch();
    await new Promise<void>((r) => {
      releaseOld = r;
    });
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Open Info Page Generate', exact: true }).click();
  const doc =
    'Here is the full API documentation: https://bottools.online/nettools/webhost/ . The API includes sites, ZIP deployments, expiration, rollback, and short links. One bearer token applies to the whole API.';
  await page.getByRole('textbox', { name: 'Message Info Page Generate', exact: true }).fill(doc);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(() => store.all('messages').some((message) => message.content === doc));
  releaseOld();
  await page.locator('.message.user').filter({ hasText: doc }).waitFor();
  await until(() => !host.runtime.controllers.size);
  await page
    .getByRole('textbox', { name: 'Message Info Page Generate', exact: true })
    .fill('Let me give you my Pages API token.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Private key entry' }).waitFor();
  assert.match(await dialog.innerText(), /complete Bottools Pages API/);
  assert.match(
    await dialog.innerText(),
    new RegExp(`${PAGES_API.operations.length} documented actions`),
  );
  const secret = 'TEST_ONLY_FULL_API_UI';
  await page.getByLabel('Secret value', { exact: true }).fill(secret);
  await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click();
  await until(
    () =>
      !host.runtime.controllers.size &&
      broker.serviceCapabilities(store.get('bots', 'info-page-generate')!).length === 1,
  );
  const prompt = 'Make me a site and pass back a short link.';
  await page.getByRole('textbox', { name: 'Message Info Page Generate', exact: true }).fill(prompt);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.locator('.message.user').filter({ hasText: prompt }).waitFor();
  await until(() => bodies.some((body) => body.messages.at(-1)?.content === prompt));
  await page.screenshot({ path: join(dir, 'original-message-working.png') });
  await page.locator('.messages').evaluate((pane) => {
    pane.scrollTop = 0;
    pane.dispatchEvent(new Event('scroll'));
  });
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).waitFor();
  releaseModel();
  await until(() => !host.runtime.controllers.size);
  await page
    .locator('.message.assistant')
    .filter({ hasText: 'https://bottools.online/s/simulated-ui' })
    .waitFor();
  assert.equal(apiCalls.length, 2);
  assert.equal(apiCalls[0].zip, true);
  assert.ok(!JSON.stringify(bodies).includes(secret));
  assert.ok(
    await page.locator('.messages').evaluate((pane) => pane.scrollTop < 10),
    'Finishing work must not pull someone away from earlier messages.',
  );
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await page.screenshot({ path: join(dir, 'published-chat.png') });
  await page.reload();
  await page.getByRole('button', { name: 'Open Info Page Generate', exact: true }).click();
  await page.locator('.message.user').filter({ hasText: prompt }).waitFor();
  assert.equal(await page.locator('.message.user').filter({ hasText: prompt }).count(), 1);
  writeFileSync(
    join(dir, 'service-result.json'),
    JSON.stringify(
      {
        verified: true,
        version: await app.evaluate(({ app }) => app.getVersion()),
        apiActions: PAGES_API.operations.length,
        zipUpload: true,
        shortLinkReturned: true,
        originalMessageRetained: true,
        scrollingBackRespected: true,
        staleNavigationIgnored: true,
        secretReadByModel: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const page = (await app.windows())[0];
  await page.screenshot({ path: join(dir, 'service-failure.png') });
  throw error;
} finally {
  releaseModel();
  await app.close();
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
}

// Phase two: thirty actual Chromium worker views, six active, twenty-four queued.
const browserStore = new Store(join(dir, 'browser-host/bot-bots.sqlite'));
seed(browserStore, resolve('reference/grok-backup'));
browserStore.setConfig('settings', {
  ...browserStore.settings(),
  mainBotId: 'boss-man',
  maxBrowserSessions: 6,
  maxParallelModels: 2,
});
browserStore.put('bots', { ...browserStore.get('bots', 'worker3')!, isPrototype: true });
let releasePages = false;
const heldPages: { res: ServerResponse; name: string }[] = [],
  cookies: { name: string; cookie: string; verify: boolean }[] = [];
const pages = createServer((req, res) => {
  const name = decodeURIComponent(req.url!.split('/').at(-1)!),
    verify = req.url!.startsWith('/verify/');
  if (!req.url!.startsWith('/worker/') && !verify) {
    res.end('ok');
    return;
  }
  cookies.push({ name, cookie: req.headers.cookie ?? '', verify });
  const send = () => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<!doctype html><script>document.cookie=${JSON.stringify(`worker=${encodeURIComponent(name)}; path=/`)};</script><body><h1>${verify ? 'Verified' : 'Worker'} ${name}</h1><p>Isolated browser page</p></body>`,
    );
  };
  if (!verify && !releasePages) {
    heldPages.push({ res, name });
    return;
  }
  send();
});
await new Promise<void>((r) => pages.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
const browserModel = createServer(async (req, res) => {
  let text = '';
  for await (const part of req) text += part;
  const body = JSON.parse(text),
    system = body.messages[0].content;
  res.setHeader('Content-Type', 'application/json');
  if (system.includes('TEMPORARY CLONE:')) {
    const name = /You are ([^,\n]+)/.exec(system)![1],
      last = body.messages.filter((message: any) => message.role === 'tool').at(-1);
    if (!last) {
      res.end(
        JSON.stringify(
          call('browser_open', { url: `${origin}/worker/${encodeURIComponent(name)}` }),
        ),
      );
      return;
    }
    const snapshot = JSON.parse(last.content);
    if (snapshot.url?.includes('/worker/'))
      res.end(
        JSON.stringify(
          call('browser_open', { url: `${origin}/verify/${encodeURIComponent(name)}` }),
        ),
      );
    else res.end(JSON.stringify(answer(`Browser verified for ${name}.`)));
  } else res.end(JSON.stringify(answer('All thirty independent browser jobs returned.')));
});
await new Promise<void>((r) => browserModel.listen(0, '127.0.0.1', r));
for (const p of browserStore.all('providers'))
  browserStore.put('providers', {
    ...p,
    autoDiscover: false,
    baseUrl: `http://127.0.0.1:${(browserModel.address() as AddressInfo).port}/v1`,
  });
browserStore.close();
app = await electron.launch({
  executablePath,
  args: executablePath ? [] : ['.'],
  env: {
    ...env,
    BOT_BOTS_DATA_DIR: join(dir, 'browser-host'),
    BOT_BOTS_CREDENTIALS_DIR: join(dir, 'browser-external'),
    BOT_BOTS_MODE: 'server',
    BOT_BOTS_DESKTOP_PORT: '0',
    BOT_BOTS_BROWSER_TEST_ORIGIN: origin,
  },
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('button', { name: 'Open Boss Man', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message Boss Man', exact: true })
    .fill(
      'Ask @Worker3 to launch 30 workers to inspect their assigned browser pages independently.',
    );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  let state: any;
  for (let i = 0; i < 700; i++) {
    state = await page.evaluate(async () =>
      fetch('/api/computer').then((response) => response.json()),
    );
    if (state.pool?.waiting.length === 24 && heldPages.length === 6) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(state.pool.active, 6);
  assert.equal(state.pool.waiting.length, 24);
  assert.equal(heldPages.length, 6);
  await page.getByRole('button', { name: 'Toggle computer panel', exact: true }).click();
  await page.getByText(/24 searches queued/).waitFor();
  await page.screenshot({ path: join(dir, 'six-browsers-queued.png') });
  releasePages = true;
  for (const { res, name } of heldPages) {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<!doctype html><script>document.cookie=${JSON.stringify(`worker=${encodeURIComponent(name)}; path=/`)};</script><h1>Worker ${name}</h1>`,
    );
  }
  let run: any;
  for (let i = 0; i < 1200; i++) {
    const data = await page.evaluate(async () =>
      fetch('/api/bootstrap').then((response) => response.json()),
    );
    run = data.runs.find((run: any) => run.prompt.includes('launch 30 workers'));
    if (run && run.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(run.status, 'completed', run.error);
  assert.equal(cookies.filter((item) => !item.verify).length, 30);
  assert.ok(
    cookies.filter((item) => !item.verify).every((item) => !item.cookie),
    'No worker starts with another worker cookie.',
  );
  assert.equal(cookies.filter((item) => item.verify).length, 30);
  assert.ok(
    cookies
      .filter((item) => item.verify)
      .every((item) => item.cookie === `worker=${encodeURIComponent(item.name)}`),
    'Every worker retains only its own cookie.',
  );
  state = await page.evaluate(async () =>
    fetch('/api/computer').then((response) => response.json()),
  );
  assert.equal(state.pool.active, 0);
  assert.equal(state.pool.waiting.length, 0);
  assert.ok(state.tabs.length < 20);
  writeFileSync(
    join(dir, 'browser-result.json'),
    JSON.stringify(
      {
        verified: true,
        version: await app.evaluate(({ app }) => app.getVersion()),
        workerCount: 30,
        parallelSessions: 6,
        queued: 24,
        cookieIsolation: true,
        completed: run.status,
        tabsAfter: state.tabs.length,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ verified: true, result: dir }));
} catch (error) {
  const page = (await app.windows())[0];
  await page.screenshot({ path: join(dir, 'browser-failure.png') });
  writeFileSync(join(dir, 'browser-failure.txt'), await page.locator('body').innerText());
  throw error;
} finally {
  releasePages = true;
  for (const { res } of heldPages) if (!res.writableEnded) res.end('Stopped isolated test.');
  await app.close();
  pages.closeAllConnections();
  browserModel.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => pages.close(() => r())),
    new Promise<void>((r) => browserModel.close(() => r())),
  ]);
}
