import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { _electron as electron } from 'playwright';
import { createApp } from '../apps/server/app';
import { Credentials } from '../apps/server/credentials';
import { Store } from '../apps/server/store';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import type { ChatGPTState } from '../apps/server/chatgpt-auth';

const dir = resolve(`test-results/frontier/ui-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const store = new Store(join(dir, 'host/team.sqlite'));
seed(store, resolve('reference/grok-backup'));
const values = new Map<string, string>();
const credentials = new Credentials(
  join(dir, 'external'),
  {
    kind: 'Isolated UI test',
    get: (id) => values.get(id) ?? null,
    set: (id, value) => {
      values.set(id, value);
    },
    delete: (id) => values.delete(id),
  },
  join(dir, 'host/workspace'),
);
const host = createApp(
  store,
  join(dir, 'host'),
  resolve('dist/web'),
  '',
  undefined,
  undefined,
  credentials,
);
let status: ChatGPTState['status'] = 'disconnected';
const state = (): ChatGPTState => ({
  status,
  sharing: status === 'connected',
  ...(status === 'connected' ? { active: 'test-account' } : {}),
  profiles:
    status === 'connected'
      ? [{ id: 'test-account', label: 'Test account', email: 'test@example.test', connected: true }]
      : [],
});
host.chatgpt!.state = async () => state();
host.chatgpt!.signIn = async () => {
  status = 'connecting';
  setTimeout(() => {
    status = 'connected';
  }, 1000);
  return { url: 'https://auth.openai.com/api/accounts/authorize?state=SIMULATED_UI_ONLY' };
};
host.chatgpt!.models = async () => [
  { slug: 'test-frontier-model', display_name: 'Test frontier model', visibility: 'list' },
];
host.chatgpt!.disconnect = async () => {
  status = 'disconnected';
};
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
const network: unknown[] = [];
async function until(fn: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Frontier UI check timed out.');
}
try {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('app:open-external');
    ipcMain.handle('app:open-external', (_event, url) => {
      (globalThis as any).frontierTestURL = url;
    });
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (r.url().includes('/chatgpt'))
      network.push({ url: r.url(), status: r.status(), method: r.request().method() });
  });
  await page.setViewportSize({ width: 1500, height: 1050 });
  await page.getByRole('button', { name: 'Model workshop', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).waitFor();
  await page.screenshot({ path: join(dir, 'frontier-options.png') });
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await until(() => !!store.get('models', 'chatgpt::test-frontier-model'));
  assert.match(
    await app.evaluate(() => (globalThis as any).frontierTestURL),
    /^https:\/\/auth\.openai\.com/,
  );
  await page.getByRole('button', { name: 'Refresh models', exact: true }).waitFor();
  assert.equal(store.settings().localOnly, true);
  assert.equal(store.get('models', 'chatgpt::test-frontier-model')!.enabled, false);
  await page.screenshot({ path: join(dir, 'chatgpt-connected.png') });
  await page.getByRole('button', { name: 'Connect Claude API', exact: true }).click();
  await page.getByLabel('Secret value', { exact: true }).fill('TEST_ONLY_CLAUDE_UI_KEY');
  await page.getByRole('button', { name: 'Save and connect', exact: true }).click();
  await until(() => !!store.get('providers', 'anthropic')?.credentialId);
  assert.equal(store.settings().localOnly, true);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Open Info Page Generate', exact: true }).click();
  const key = 'TEST_ONLY_CONVERSATIONAL_UI_API';
  await page
    .getByRole('textbox', { name: 'Message Info Page Generate', exact: true })
    .fill(`Here is my bottools API key: ${key}`);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page
    .locator('.message.assistant')
    .filter({ hasText: 'connected for all current and future bots' })
    .waitFor();
  assert.equal(await page.getByLabel('Secret value', { exact: true }).count(), 0);
  assert.equal(credentials.serviceCapabilities(store.get('bots', 'worker2')!).length, 1);
  assert.ok(!JSON.stringify(store.export()).includes(key));
  assert.ok(!(await page.locator('body').innerText()).includes(key));
  await page.screenshot({ path: join(dir, 'conversational-global-key.png') });
  await page.reload();
  await page.getByRole('button', { name: 'Open Info Page Generate', exact: true }).click();
  await page
    .locator('.message.assistant')
    .filter({ hasText: 'connected for all current and future bots' })
    .waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes(key));
  assert.deepEqual(errors, []);
  const result = {
    verified: true,
    version: await app.evaluate(({ app }) => app.getVersion()),
    chatgptBrowserBridge: true,
    simulatedChatGPTConnection: true,
    cloudOptInPreserved: true,
    claudePrivateKeySetup: true,
    conversationalKeyNoSecondForm: true,
    otherBotsShared: true,
    privateValueOmittedAfterReload: true,
    rendererErrors: errors,
    realExternalWrites: false,
    evidence: dir,
  };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  writeFileSync(
    join(dir, 'network.json'),
    JSON.stringify({ network, providers: store.all('providers'), auth: state() }, null, 2),
  );
  const page = (await app.windows())[0];
  if (page) {
    await page.screenshot({ path: join(dir, 'failure.png') });
    writeFileSync(join(dir, 'failure.txt'), await page.locator('body').innerText());
  }
  throw error;
} finally {
  await app.close();
  host.chatgpt!.cancel();
  host.runtime.events.emit('shutdown');
  host.computer.dispose();
  await host.terminal.dispose();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
}
