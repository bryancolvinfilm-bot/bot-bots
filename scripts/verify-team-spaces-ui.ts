import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { _electron as electron } from 'playwright';
import { Store } from '../apps/server/store';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import { createApp } from '../apps/server/app';
import { Credentials } from '../apps/server/credentials';
import { TeamConversations } from '../apps/server/team-conversations';
import type { ClaudeCodeState } from '../apps/server/claude-code';
const dir = resolve(`test-results/team-spaces/ui-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const store = new Store(join(dir, 'host/team.sqlite'));
seed(store, resolve('reference/grok-backup'));
const bodies: any[] = [];
const model = createServer(async (req, res) => {
  let text = '';
  for await (const part of req) text += part;
  bodies.push(JSON.parse(text));
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [{ message: { content: 'BETA_CONTEXT_CONFIRMED' }, finish_reason: 'stop' }],
    }),
  );
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
for (const p of store.all('providers'))
  store.put('providers', {
    ...p,
    baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    autoDiscover: false,
  });
const values = new Map<string, string>();
const credentials = new Credentials(
  join(dir, 'external'),
  {
    kind: 'Isolated test',
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
const spaces = new TeamConversations(store),
  alpha = spaces.create('Alpha project'),
  beta = spaces.create('Beta project');
for (const space of [alpha, beta])
  for (const botId of ['info-page-generate', 'research']) {
    const channel = spaces.channel(space.id, botId);
    store.put('messages', {
      id: `${space.id}-${botId}`,
      botId,
      conversationId: channel.id,
      role: 'assistant',
      content: `${space.id === alpha.id ? 'ALPHA' : 'BETA'}_${botId === 'research' ? 'RESEARCH' : 'INFO'}`,
      createdAt: new Date().toISOString(),
    });
  }
let claudeStatus: ClaudeCodeState['status'] = 'disconnected';
host.claude.state = async () => ({ installed: true, status: claudeStatus });
host.claude.signIn = async () => {
  claudeStatus = 'connecting';
  setTimeout(() => {
    claudeStatus = 'connected';
  }, 700);
};
host.claude.disconnect = async () => {
  claudeStatus = 'disconnected';
};
const server = host.app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE',
  ),
) as Record<string, string>;
const clientEnv = {
  ...env,
  BOT_BOTS_DATA_DIR: join(dir, 'client'),
  BOT_BOTS_MODE: 'client',
  BOT_BOTS_SERVER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
};
const executablePath = process.env.BOT_BOTS_TEST_EXECUTABLE;
const app = await electron.launch({
  executablePath,
  args: executablePath ? [] : ['.'],
  env: clientEnv,
});
const errors: string[] = [];
async function until(fn: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Team UI check timed out.');
}
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.getByRole('button', { name: 'Open Info Page Generate', exact: true }).click();
  const spaceButton = (name: string) =>
    page.locator('.conversation-list').getByRole('button', { name, exact: true });
  const message = (text: string) => page.locator('.message.assistant').filter({ hasText: text });
  await spaceButton('Alpha project').click();
  await message('ALPHA_INFO').waitFor();
  await page.getByRole('button', { name: 'Open Research', exact: true }).click();
  await message('ALPHA_RESEARCH').waitFor();
  assert.equal(await message('BETA_RESEARCH').count(), 0);
  await spaceButton('Beta project').click();
  await message('BETA_RESEARCH').waitFor();
  await page.getByRole('button', { name: 'Open Info Page Generate', exact: true }).click();
  await message('BETA_INFO').waitFor();
  assert.equal(await message('ALPHA_INFO').count(), 0);
  await spaceButton('Beta project').click();
  await message('BETA_INFO').waitFor();
  await page
    .getByRole('textbox', { name: 'Message Info Page Generate', exact: true })
    .fill('Continue this project.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await message('BETA_CONTEXT_CONFIRMED').waitFor();
  assert.match(JSON.stringify(bodies), /BETA_RESEARCH/);
  assert.doesNotMatch(JSON.stringify(bodies), /ALPHA_RESEARCH/);
  await page.screenshot({ path: join(dir, 'shared-team-space.png') });
  await page.getByLabel('New conversation', { exact: true }).click();
  await until(() => store.all('teamConversations').filter((s) => !s.legacy).length === 4);
  await until(async () => (await page.locator('.message').count()) === 0);
  await page.getByRole('button', { name: 'Open Research', exact: true }).click();
  await until(async () => (await page.locator('.message').count()) === 0);
  assert.equal(
    await page.getByRole('heading', { name: 'Team conversations', exact: true }).count(),
    1,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Open Info Page Generate', exact: true }).click();
  await until(async () => (await page.locator('.message').count()) === 0);
  await spaceButton('Alpha project').click();
  await message('ALPHA_INFO').waitFor();
  await page.getByRole('button', { name: 'Open Research', exact: true }).click();
  await message('ALPHA_RESEARCH').waitFor();
  await page.getByRole('button', { name: 'Model workshop', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Continue with Claude', exact: true }).click();
  await until(() => store.all('models').some((m) => m.providerId === 'claude-code'));
  assert.equal(store.settings().localOnly, true);
  assert.ok(
    store
      .all('models')
      .filter((m) => m.providerId === 'claude-code')
      .every((m) => !m.enabled),
  );
  await page.screenshot({ path: join(dir, 'both-browser-login-options.png') });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].hide();
  });
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    false,
  );
  const launchExecutable = executablePath ?? (await app.evaluate(() => process.execPath));
  const second = spawn(launchExecutable, executablePath ? [] : ['.'], {
    env: clientEnv,
    windowsHide: true,
    stdio: 'ignore',
  });
  await new Promise<void>((r, reject) => {
    const timer = setTimeout(() => {
      second.kill();
      reject(Error('Second app instance did not exit.'));
    }, 15000);
    second.once('error', reject);
    second.once('exit', () => {
      clearTimeout(timer);
      r();
    });
  });
  await until(() =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
  );
  assert.deepEqual(errors, []);
  for (const space of [alpha, beta])
    for (const id of ['research', 'info-page-generate'])
      assert.equal(
        store.all('conversations').filter((c) => c.spaceId === space.id && c.botId === id).length,
        1,
      );
  const result = {
    verified: true,
    version: await app.evaluate(({ app }) => app.getVersion()),
    allBotsFollowSpace: true,
    oneChannelPerBotPerSpace: true,
    contextIsolation: true,
    newSpaceClearsEveryBot: true,
    selectionSurvivesReload: true,
    claudeBrowserLoginButton: true,
    chatgptBrowserLoginButton: true,
    hiddenWindowRestoredOnReopen: true,
    rendererErrors: errors,
    evidence: dir,
  };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.log('Original UI error:', error instanceof Error ? error.message : String(error));
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.show();
  });
  const page = (await app.windows())[0];
  if (page) {
    await page.screenshot({ path: join(dir, 'failure.png') });
    writeFileSync(join(dir, 'failure.txt'), await page.locator('body').innerText());
  }
  throw error;
} finally {
  await app.close();
  host.claude.cancel();
  host.chatgpt?.cancel();
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
