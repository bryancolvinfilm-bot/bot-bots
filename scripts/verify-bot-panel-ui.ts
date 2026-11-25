import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createApp } from '../apps/server/app';
import { Credentials } from '../apps/server/credentials';
import { Store } from '../apps/server/store';
import { seedTestTeam } from '../tests/fixtures/team';

const dir = resolve(`test-results/bot-panel/ui-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const store = new Store(join(dir, 'host/team.sqlite'));
seedTestTeam(store);
const calls: any[] = [];
const model = createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  calls.push(body);
  const prompt = (body.messages.findLast((m: any) => m.role === 'user')?.content ?? '').split(
    '\n\n[HOST ACTION ADAPTER]',
  )[0];
  const routine = store.all('routines').find((r) => r.name === 'Morning check');
  if (prompt.includes('TOKEN_STREAM_PROBE')) {
    assert.equal(body.stream, true);
    res.setHeader('Content-Type', 'text/event-stream');
    for (let part = 0; part < 5; part++) {
      await new Promise((r) => setTimeout(r, 250));
      if (res.destroyed) return;
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Streaming token progress. '.repeat(4) } }] })}\n\n`,
      );
    }
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'TOKEN_STREAM_DONE' }, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 } })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  const action = /remove/i.test(prompt)
    ? { action: 'routine_delete', id: routine?.id }
    : /pause/i.test(prompt)
      ? { action: 'routine_save', id: routine?.id, changes: { enabled: false } }
      : {
          action: 'routine_save',
          changes: { name: 'Morning check', cron: '0 9 * * 1-5', prompt: 'Review my calendar.' },
        };
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content:
              /routine/i.test(prompt) || /pause that/i.test(prompt)
                ? JSON.stringify({ botPanel: action })
                : 'Online model reply.',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { total_tokens: 10 },
    }),
  );
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
const provider = store.all('providers')[0],
  chosen = store.all('models')[0];
for (const m of store.all('models')) store.put('models', { ...m, enabled: m.id === chosen.id });
store.put('providers', {
  ...provider,
  enabled: true,
  autoDiscover: false,
  baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
});
store.put('models', {
  ...chosen,
  enabled: true,
  status: 'online',
  loadState: 'loaded',
  loadedContextTokens: 122112,
  contextTokens: 122112,
  toolCalling: 'disabled',
});
store.put('models', {
  ...chosen,
  id: 'unloaded-test',
  name: 'Unloaded test model',
  status: 'online',
  loadState: 'unloaded',
});
for (const name of ['ChatGPT', 'Claude']) {
  const id = `test-${name.toLowerCase()}`;
  store.put('providers', {
    ...provider,
    id,
    name,
    local: false,
    enabled: true,
    autoDiscover: false,
    baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  });
  for (const suffix of ['a', 'b'])
    store.put('models', {
      ...chosen,
      id: `${id}-${suffix}`,
      name:
        name === 'ChatGPT'
          ? `gpt-5.1${suffix === 'b' ? '-mini' : ''}`
          : `claude-sonnet-4-6${suffix === 'b' ? '-test' : ''}`,
      providerId: id,
      enabled: false,
      status: 'online',
    });
}
store.setConfig('settings', { ...store.settings(), mainBotId: null });
const values = new Map<string, string>();
const credentials = new Credentials(
  join(dir, 'external'),
  {
    kind: 'Isolated UI verification',
    get: (id) => values.get(id) ?? null,
    set: (id, value) => {
      values.set(id, value);
    },
    delete: (id) => {
      return values.delete(id);
    },
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
(host.claude as any).state = async () => ({ status: 'disconnected', installed: false });
const server = host.app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE',
  ),
) as Record<string, string>;
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
const page = await app.firstWindow(),
  errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Bot panel UI verification timed out.');
}
try {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('button', { name: 'Open Calendar', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle bot panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Calendar panel', exact: true });
  async function send(text: string) {
    await page.getByRole('textbox', { name: 'Message Calendar', exact: true }).fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await until(
      () => store.all('runs').length > 0 && store.all('runs').every((r) => r.status !== 'running'),
    );
  }
  await send('Make a routine for yourself: review my calendar every weekday at 9 am.');
  await panel.getByText('Morning check', { exact: true }).waitFor();
  await page.locator('.message.assistant').filter({ hasText: 'Created routine' }).waitFor();
  await page.screenshot({ path: join(dir, 'routine-created-in-chat.png') });
  await send('Pause that routine.');
  await until(
    () => store.all('routines').find((r) => r.name === 'Morning check')?.enabled === false,
  );
  await send('Remove that routine.');
  await until(async () => (await panel.getByText('Morning check', { exact: true }).count()) === 0);
  await page.getByRole('button', { name: 'Customize', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'A little more Calendar', exact: true });
  await editor.getByRole('tab', { name: 'Local', exact: true }).click();
  assert.equal(
    await editor
      .getByLabel('Local model', { exact: true })
      .locator('option')
      .filter({ hasText: 'gpt-5.1' })
      .count(),
    0,
  );
  await editor.getByRole('tab', { name: 'Online', exact: true }).click();
  await editor.getByRole('button', { name: 'Connect ChatGPT or Claude', exact: true }).click();
  const connection = page.getByRole('dialog', { name: 'Connect an online service', exact: true });
  await connection.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).waitFor();
  await connection.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await editor.isVisible(), true);
  await editor.getByLabel('Online service', { exact: true }).selectOption('test-chatgpt');
  await page.screenshot({ path: join(dir, 'local-online-service-picker.png') });
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  const originalBot = store.get('bots', 'calendar')!;
  const currentChannel = () => store.all('conversations').find((c) => c.botId === 'calendar')!;
  assert.deepEqual(
    await page
      .getByLabel('Chat model', { exact: true })
      .locator('optgroup')
      .evaluateAll((elements) => elements.map((e) => e.getAttribute('label'))),
    ['Online · frontier models', 'Local · running models'],
  );
  assert.equal(
    await page
      .getByLabel('Chat model', { exact: true })
      .locator('option[value="unloaded-test"]')
      .count(),
    0,
  );
  await page.getByLabel('Chat model', { exact: true }).selectOption('test-chatgpt-b');
  await until(() => currentChannel().modelId === 'test-chatgpt-b');
  await page.getByLabel('Reasoning effort', { exact: true }).selectOption('high');
  await until(() => currentChannel().reasoningEffort === 'high');
  assert.deepEqual(store.get('bots', 'calendar'), originalBot);
  await send('Hello.');
  await page.locator('.message.assistant').filter({ hasText: 'Online model reply.' }).waitFor();
  assert.equal(calls.at(-1).reasoning_effort, 'high');
  await page.reload();
  await page.getByRole('button', { name: 'Open Calendar', exact: true }).click();
  await page.getByLabel('Chat model', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Chat model', { exact: true }).inputValue(), 'test-chatgpt-b');
  assert.equal(await page.getByLabel('Reasoning effort', { exact: true }).inputValue(), 'high');
  await page.screenshot({ path: join(dir, 'chat-model-and-effort.png') });
  async function streamTokens(label: string) {
    const before = store.all('runs').length;
    await page
      .getByRole('textbox', { name: 'Message Calendar', exact: true })
      .fill(`TOKEN_STREAM_PROBE ${label}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const live = page.getByLabel('Live response tokens', { exact: true }).last();
    await live.waitFor();
    await until(async () => Number(await live.getAttribute('data-token-output')) > 0);
    const first = Number(await live.getAttribute('data-token-output'));
    await until(async () => Number(await live.getAttribute('data-token-output')) > first);
    await page.screenshot({ path: join(dir, `live-token-counter-${label}.png`) });
    await until(
      () =>
        store.all('runs').length > before && store.all('runs').every((r) => r.status !== 'running'),
    );
    const final = page
      .locator('.message.assistant')
      .filter({ hasText: 'TOKEN_STREAM_DONE' })
      .last()
      .getByLabel('Response tokens', { exact: true });
    await final.waitFor();
    assert.equal(await final.getAttribute('data-token-total'), '250');
    assert.equal(await final.getAttribute('data-token-output'), '150');
    assert.ok(await page.getByLabel('Message tokens', { exact: true }).last().isVisible());
  }
  await streamTokens('online');
  await page.getByRole('button', { name: 'Choose model for all bots', exact: true }).click();
  let team = page.getByRole('dialog', { name: 'Team model', exact: true });
  await team.getByLabel('Team model', { exact: true }).selectOption('test-chatgpt-b');
  await team.getByLabel('Team effort', { exact: true }).selectOption('high');
  await team.getByRole('button', { name: 'Use for all bots', exact: true }).click();
  await until(() => store.all('bots').every((b) => b.chatModelId === 'test-chatgpt-b'));
  await team.getByRole('status').waitFor();
  await page.screenshot({ path: join(dir, 'team-model-applied.png') });
  await team.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await until(
    async () =>
      (await page.getByLabel('Chat model', { exact: true }).inputValue()) === 'test-chatgpt-b',
  );
  await page.getByLabel('Chat model', { exact: true }).selectOption(chosen.id);
  await until(() => currentChannel().modelId === chosen.id);
  assert.equal(store.get('bots', 'research')?.chatModelId, 'test-chatgpt-b');
  await streamTokens('local');
  await page.getByRole('button', { name: 'Choose model for all bots', exact: true }).click();
  team = page.getByRole('dialog', { name: 'Team model', exact: true });
  await team.getByRole('button', { name: 'Return all to defaults', exact: true }).click();
  await until(() => store.all('bots').every((b) => b.chatModelId === undefined));
  await team.getByRole('status').waitFor();
  await team.getByRole('button', { name: 'Close dialog', exact: true }).click();
  assert.deepEqual(store.get('bots', 'calendar'), originalBot);
  assert.equal(currentChannel().modelId, undefined);
  await page.getByLabel('Chat model', { exact: true }).selectOption(chosen.id);
  await until(() => currentChannel().modelId === chosen.id);
  assert.ok((await page.locator('.chat-context-status').innerText()).includes('122,112'));
  for (const remote of store.all('models').filter((m) => m.providerId.startsWith('test-')))
    store.put('models', { ...remote, status: 'offline' });
  await page.reload();
  await page.getByRole('button', { name: 'Open Calendar', exact: true }).click();
  await page.getByLabel('Chat model', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('Chat model', { exact: true }).locator('optgroup option').count(),
    1,
  );
  assert.equal(await page.getByLabel('Reasoning effort', { exact: true }).isVisible(), true);
  await page.screenshot({ path: join(dir, 'single-running-model-dropdown.png') });
  assert.deepEqual(errors, []);
  writeFileSync(
    join(dir, 'verified.json'),
    JSON.stringify(
      {
        routineCreatedInChat: true,
        pausedInChat: true,
        deletedInChat: true,
        panelUpdated: true,
        localOnlineSeparated: true,
        connectionModalPreservedEditor: true,
        selectedServiceEnablesModel: true,
        chatModelAndEffortPersist: true,
        effortReachedInference: true,
        allRunningModelsGroupedInChat: true,
        unloadedModelsHidden: true,
        oneModelStillHasDropdown: true,
        botDefaultsUnchanged: true,
        liveTokensOnlineAndLocal: true,
        providerTotalsPersist: true,
        teamSwitchAndReset: true,
        individualOverrideAfterTeamSwitch: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ verified: true, directory: dir }));
} catch (error) {
  await page.screenshot({ path: join(dir, 'failure.png') });
  writeFileSync(join(dir, 'failure.txt'), await page.locator('body').innerText());
  throw error;
} finally {
  await app.close();
  host.runtime.events.emit('shutdown');
  host.computer.dispose();
  host.google.cancelRun();
  await host.terminal.dispose();
  server.closeAllConnections();
  model.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => server.close(() => r())),
    new Promise<void>((r) => model.close(() => r())),
  ]);
  store.close();
}
