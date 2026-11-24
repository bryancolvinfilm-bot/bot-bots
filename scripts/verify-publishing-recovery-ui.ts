import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createApp } from '../apps/server/app';
import { Credentials } from '../apps/server/credentials';
import type { SecretBackend } from '../apps/server/host-secrets';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import { Store } from '../apps/server/store';
import { PAGES_API } from '../packages/shared/service-api';

const dir = resolve(`test-results/publishing-recovery/ui-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const store = new Store(join(dir, 'host/team.sqlite'));
seed(store, resolve('reference/grok-backup'));
const html =
  '<!doctype html><html><body><h1>Recovered family page</h1>' +
  '<p>Saved content survives.</p>'.repeat(270) +
  '</body></html>';
const now = new Date().toISOString();
store.put('conversations', {
  id: 'old-conversation',
  botId: 'info-page-generate',
  title: 'Recovered failed task',
  createdAt: now,
});
store.put('runs', {
  id: 'old-run',
  botId: 'info-page-generate',
  conversationId: 'old-conversation',
  prompt: 'Make a page',
  task: 'coding',
  status: 'failed',
  startedAt: now,
  finishedAt: now,
  tokens: 0,
  events: [],
  error: 'Earlier failure',
});
store.put('messages', {
  id: 'old-message',
  botId: 'info-page-generate',
  conversationId: 'old-conversation',
  runId: 'old-run',
  role: 'user',
  content: 'Make a page',
  createdAt: now,
});
store.put('drafts', {
  id: 'old-draft',
  runId: 'old-run',
  activeRunId: 'old-run',
  workId: 'old-work',
  botId: 'info-page-generate',
  rootBotId: 'info-page-generate',
  conversationId: 'old-conversation',
  filename: 'family-events-page/index.html',
  kind: 'file',
  language: 'html',
  content: '',
  revision: 0,
  chunks: 0,
  status: 'partial',
  createdAt: now,
  updatedAt: now,
});
store.put('pages', {
  id: 'old-page',
  runId: 'old-run',
  botId: 'info-page-generate',
  title: 'index.html',
  filename: 'index.html',
  workspacePath: 'family-events-page/index.html',
  format: 'html',
  content: html,
  createdAt: now,
});
class Secrets implements SecretBackend {
  kind = 'Isolated test';
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
const requests: string[] = [];
const broker = new Credentials(
  join(dir, 'external'),
  new Secrets(),
  join(dir, 'host/workspace'),
  (async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (path.endsWith('/deploys')) {
      assert.ok(Buffer.from(init?.body as Uint8Array).includes(Buffer.from(html)));
      return new Response(
        JSON.stringify({ state: 'ready', ssl_url: `${PAGES_API.baseUrl}/sites/ui-recovery/` }),
        { status: 201 },
      );
    }
    return new Response(
      JSON.stringify({ short_url: 'https://bottools.online/s/ui-recovery-simulated' }),
      { status: 201 },
    );
  }) as typeof fetch,
);
broker
  .manager()
  .save({
    version: broker.manager().state().version,
    name: 'Test API',
    kind: 'api-key',
    value: 'TEST_ONLY_NEVER_REAL',
    target: {
      type: 'service',
      api: PAGES_API,
      botIds: ['info-page-generate'],
      approval: 'connected',
    },
  });
let count = 0,
  draftId = '';
const tool = (name: string, args: unknown) => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: `call-${count}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
});
const model = createServer(async (req, res) => {
  let text = '';
  for await (const part of req) text += part;
  const body = JSON.parse(text);
  const last = body.messages.filter((message: any) => message.role === 'tool').at(-1);
  if (last) draftId ||= JSON.parse(last.content).id;
  const result =
    ++count === 1
      ? tool('draft_start', { filename: 'family-events-page/index.html' })
      : count === 2
        ? tool('draft_append', { id: draftId, expectedRevision: 0, content: html })
        : count === 3
          ? tool('workspace_write', { path: 'family-events-page/index.html', content: html })
          : count === 4
            ? tool('service_call', {
                serviceId: 'bottools-pages',
                operationId: 'deploy',
                paramsJson: '{"site":"https://wrong-url"}',
                inputJson: '{}',
              })
            : {
                choices: [
                  {
                    message: { content: 'The page is saved and published.' },
                    finish_reason: 'stop',
                  },
                ],
              };
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(result));
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
const selected = store.all('models')[0];
for (const provider of store.all('providers'))
  store.put('providers', {
    ...provider,
    enabled: provider.id === selected.providerId,
    local: false,
    autoDiscover: false,
    baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  });
for (const model of store.all('models'))
  store.put('models', {
    ...model,
    enabled: model.id === selected.id,
    toolCalling: 'enabled',
    contextTokens: 131072,
  });
store.setConfig('settings', { ...store.settings(), mainBotId: null, localOnly: false });
const host = createApp(
  store,
  join(dir, 'host'),
  resolve('dist/web'),
  '',
  undefined,
  undefined,
  broker,
);
assert.equal(store.get('drafts', 'old-draft')!.content, html);
const server = host.app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const executablePath = process.env.BOT_BOTS_TEST_EXECUTABLE;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE',
  ),
) as Record<string, string>;
const app = await electron.launch({
  executablePath,
  args: executablePath ? [] : ['.'],
  env: {
    ...env,
    BOT_BOTS_DATA_DIR: join(dir, 'client'),
    BOT_BOTS_MODE: 'client',
    BOT_BOTS_SERVER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  },
});
const errors: string[] = [];
async function until(fn: () => boolean) {
  for (let n = 0; n < 1000; n++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('UI recovery check timed out');
}
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.getByRole('button', { name: 'Open Info Page Generate', exact: true }).click();
  await page
    .locator('.artifact-card[data-page-id="old-page"]')
    .getByRole('button', { name: 'View page', exact: true })
    .click();
  await page
    .frameLocator('.preview-panel iframe')
    .getByRole('heading', { name: 'Recovered family page', exact: true })
    .waitFor();
  await page.screenshot({ path: join(dir, 'recovered-original-file.png') });
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message Info Page Generate', exact: true })
    .fill('Put this page on bottools.online and give me a short URL.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(() => count >= 5 && !host.runtime.controllers.size);
  const run = store.all('runs').find((run) => run.id !== 'old-run')!;
  assert.equal(run.status, 'completed', run.error);
  await page
    .locator('.message.assistant')
    .filter({ hasText: 'https://bottools.online/s/ui-recovery-simulated' })
    .waitFor();
  assert.equal(requests.length, 2);
  const draft = store.all('drafts').find((draft) => draft.activeRunId === run.id)!;
  assert.equal(draft.content, html);
  assert.equal(draft.status, 'complete');
  assert.equal(host.runtime.builds.list(run.id)[0].characters, html.length);
  await page.screenshot({ path: join(dir, 'saved-and-published.png') });
  assert.deepEqual(errors, []);
  const result = {
    verified: true,
    version: await app.evaluate(({ app }) => app.getVersion()),
    recoveredFailedFileVisible: true,
    oversizedAppendCharacters: html.length,
    modelCalls: count,
    emptyPreviewPrevented: true,
    shortLinkReturned: true,
    apiWrites: requests.length,
    realExternalWrites: false,
    rendererErrors: errors,
  };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, evidence: dir }));
} catch (error) {
  const page = (await app.windows())[0];
  if (page) {
    await page.screenshot({ path: join(dir, 'failure.png') });
    writeFileSync(join(dir, 'failure.txt'), await page.locator('body').innerText());
  }
  throw error;
} finally {
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
