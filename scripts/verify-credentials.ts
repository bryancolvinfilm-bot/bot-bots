import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createApp } from '../apps/server/app';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import { Store } from '../apps/server/store';
import { Credentials } from '../apps/server/credentials';

const dir = resolve(`test-results/credentials/ui-${Date.now()}`);
mkdirSync(join(dir, 'external'), { recursive: true, mode: 0o700 });
const privateValue = 'TEST_ONLY_KEY_NEVER_IN_A_MODEL_794';
const policy = {
  version: 1,
  enabled: true,
  storage: 'os',
  allowBotTerminal: false,
  bindings: [],
  operations: [
    {
      id: 'list-sites',
      label: 'List test sites',
      enabled: true,
      botIds: ['research'],
      url: 'https://service.test/sites',
      method: 'GET',
      auth: { type: 'bearer', secret: 'test-service-key' },
      inputFields: [],
      responseFields: ['id', 'name', 'echo'],
    },
  ],
};
const savePolicy = () =>
  writeFileSync(join(dir, 'external/permissions.json'), JSON.stringify(policy), { mode: 0o600 });
savePolicy();
let authenticatedCalls = 0;
const credentials = new Credentials(
  join(dir, 'external'),
  { kind: 'Isolated test keyring', get: () => privateValue, set: () => {}, delete: () => true },
  join(dir, 'host/workspace'),
  (async (_url: any, init: RequestInit) => {
    authenticatedCalls++;
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${privateValue}`);
    return new Response(
      JSON.stringify([
        { id: '42', name: 'A demo site', echo: privateValue, unapproved: privateValue },
      ]),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch,
);
const store = new Store(join(dir, 'host/team.sqlite'));
seed(store, resolve('reference/grok-backup'));
const modelRequests: any[] = [];
let childResponse: ServerResponse | undefined;
const answer = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { total_tokens: 12 },
});
const call = (name: string, args: unknown) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `tool-${modelRequests.length}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { total_tokens: 12 },
});
const model = createServer(async (req, res) => {
  let text = '';
  for await (const c of req) text += c;
  const body = JSON.parse(text);
  modelRequests.push(body);
  res.setHeader('Content-Type', 'application/json');
  const system = body.messages[0].content,
    last = body.messages.at(-1);
  assert.ok(!text.includes(privateValue));
  if (system.includes('You are Info Page Generate')) {
    childResponse = res;
    return;
  }
  if (system.includes('You are Boss Man'))
    return res.end(
      JSON.stringify(
        last.role === 'tool'
          ? answer('The teammate reported back.')
          : call('delegate', { botId: 'info-page-generate', task: 'Return one concise result.' }),
      ),
    );
  res.end(
    JSON.stringify(
      last.role === 'tool'
        ? answer(
            last.content.includes('Error') || last.content.includes('failed')
              ? 'The operation was blocked; no account action was completed.'
              : 'Authenticated result received: A demo site.',
          )
        : call('credential_use', { operationId: 'list-sites', inputJson: '{}' }),
    ),
  );
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
for (const p of store.all('providers'))
  store.put('providers', {
    ...p,
    autoDiscover: false,
    baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  });
const host = createApp(
  store,
  join(dir, 'host'),
  resolve('dist/web'),
  '',
  undefined,
  undefined,
  credentials,
);
const server = host.app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env))
  if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
const executablePath = process.env.BOT_BOTS_TEST_EXECUTABLE;
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
try {
  const page = await app.firstWindow(),
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
  await page.getByRole('button', { name: 'Chat with Boss Man', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message Boss Man', exact: true })
    .fill('Please coordinate a scoped review.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Waiting for Info Page Generate', { exact: true }).waitFor();
  const parent = page.getByRole('progressbar', { name: 'Boss Man progress estimate', exact: true });
  assert.equal(await parent.getAttribute('aria-valuenow'), '0');
  await page.waitForTimeout(500);
  assert.equal(await parent.getAttribute('aria-valuenow'), '0');
  assert.ok(
    Number(
      await page
        .getByRole('progressbar', { name: 'Info Page Generate progress estimate', exact: true })
        .getAttribute('aria-valuenow'),
    ) > 0,
  );
  await page.screenshot({ path: `${dir}/coordinator-waiting.png` });
  assert.ok(childResponse);
  childResponse.end(JSON.stringify(answer('The scoped review is complete.')));
  await page.getByText('The teammate reported back.', { exact: true }).waitFor();
  assert.equal(await parent.getAttribute('aria-valuenow'), '100');
  await page
    .getByRole('navigation', { name: 'Your bots', exact: true })
    .getByRole('button', { name: 'Open Research', exact: true })
    .click();
  const sendCredential = async () => {
    await page
      .getByRole('textbox', { name: 'Message Research', exact: true })
      .fill('List the approved sites using the granted operation.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page
      .getByRole('button', { name: 'Review secret operation approvals', exact: true })
      .waitFor();
  };
  await sendCredential();
  assert.equal(authenticatedCalls, 0);
  await page
    .getByRole('button', { name: 'Review secret operation approvals', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'Host secrets and permissions', exact: true });
  await panel.getByRole('button', { name: 'Approve once', exact: true }).waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes(privateValue));
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${dir}/credential-approval.png` });
  await panel.getByRole('button', { name: 'Approve once', exact: true }).click();
  await panel.getByText('Research · completed', { exact: true }).waitFor();
  assert.equal(authenticatedCalls, 1);
  assert.ok(!JSON.stringify(modelRequests).includes(privateValue));
  assert.ok(!JSON.stringify(store.export()).includes(privateValue));
  await page
    .getByRole('navigation', { name: 'Your bots', exact: true })
    .getByRole('button', { name: 'Open Research', exact: true })
    .click();
  await page.getByText('Authenticated result received: A demo site.', { exact: true }).waitFor();
  await sendCredential();
  policy.enabled = false;
  savePolicy();
  await page
    .getByRole('button', { name: 'Review secret operation approvals', exact: true })
    .click();
  await panel.getByRole('button', { name: 'Approve once', exact: true }).click();
  await panel.getByText('Research · failed', { exact: true }).waitFor();
  assert.equal(
    authenticatedCalls,
    1,
    'External revocation must block the second authenticated request.',
  );
  assert.ok(!JSON.stringify(credentials.state()).includes(privateValue));
  assert.deepEqual(errors, []);
  const result = {
    dir,
    waitingCoordinatorAtLeft: true,
    workerProgressed: true,
    finishedCoordinatorAtRight: true,
    approvalRequired: true,
    hostOnlyAuthentication: true,
    externallyRevoked: true,
    secretAbsentFromPromptsAndExports: true,
    authenticatedCalls,
    errors,
  };
  writeFileSync(`${dir}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  credentials.cancelRun();
  for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
  for (let n = 0; n < 250 && host.runtime.controllers.size; n++)
    await new Promise((r) => setTimeout(r, 10));
  await app.close();
  host.runtime.events.emit('shutdown');
  host.computer.dispose();
  await host.terminal.dispose();
  server.closeAllConnections();
  model.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => server.close(() => r())),
    new Promise<void>((r) => model.close(() => r())),
  ]);
  store.close();
}
