import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createApp } from '../apps/server/app';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import { Store } from '../apps/server/store';

const dir = resolve(`test-results/main-bot/ui-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const store = new Store(join(dir, 'host/team.sqlite'));
seed(store, resolve('reference/grok-backup'));
store.put('bots', { ...store.get('bots', 'worker3')!, isPrototype: true });
const calls: any[] = [];
const provider = createServer(async (req, res) => {
  let text = '';
  for await (const c of req) text += c;
  const body = JSON.parse(text);
  calls.push(body);
  const main = body.messages[0].content.includes(
    'MAIN DELEGATION BOT — DIRECT HUMAN CONVERSATION:',
  );
  const message =
    main && body.messages.at(-1).role !== 'tool'
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'main-bot-review',
              type: 'function',
              function: {
                name: 'delegate',
                arguments: JSON.stringify({
                  botId: 'worker1',
                  task: 'Return a concise scoped review for this test.',
                }),
              },
            },
          ],
        }
      : {
          role: 'assistant',
          content: main
            ? 'Our teammate checked the details. Here are their actual findings, brought together.'
            : 'A direct reply from this teammate.',
        };
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [{ message, finish_reason: 'tool_calls' in message ? 'tool_calls' : 'stop' }],
      usage: { total_tokens: 12 },
    }),
  );
});
await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
for (const p of store.all('providers'))
  store.put('providers', {
    ...p,
    autoDiscover: false,
    baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
  });
const host = createApp(store, join(dir, 'host'), resolve('dist/web'));
const server = host.app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
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
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
  const picker = page.getByRole('combobox', { name: 'Main delegation bot', exact: true });
  assert.equal(await picker.inputValue(), '');
  assert.equal(await picker.getByRole('option', { name: 'Worker3', exact: true }).count(), 0);
  await picker.selectOption('research');
  await page.getByRole('heading', { name: 'Big plans? Start with Research.' }).waitFor();
  await page.locator('.bot-card[data-bot-id="research"] .main-bot-badge').waitFor();
  assert.equal(await page.locator('.bot-card .main-bot-badge').count(), 1);
  assert.equal(calls.length, 0);
  const roster = page.getByRole('navigation', { name: 'Your bots', exact: true });
  const mainRow = roster.locator('.main-bot-row');
  assert.equal(await mainRow.getAttribute('data-bot-id'), 'research');
  assert.equal(await roster.locator('[data-bot-id="research"]').count(), 1);
  assert.equal(await roster.locator('.bot-roster-groups [data-bot-id="research"]').count(), 0);
  const placement = await roster.evaluate((el) => {
    const main = el.querySelector('.main-bot-row')!,
      ordinary = el.querySelector('.bot-roster-groups .bot-roster-row')!;
    return {
      firstId: el.querySelector('.bot-roster-row')?.getAttribute('data-bot-id'),
      mainHeight: main.getBoundingClientRect().height,
      ordinaryHeight: ordinary.getBoundingClientRect().height,
      mainAvatar: main.querySelector('.avatar')!.getBoundingClientRect().width,
      ordinaryAvatar: ordinary.querySelector('.avatar')!.getBoundingClientRect().width,
    };
  });
  assert.equal(placement.firstId, 'research');
  assert.ok(placement.mainHeight > placement.ordinaryHeight);
  assert.ok(placement.mainAvatar > placement.ordinaryAvatar);
  const pinnedTop = (await mainRow.boundingBox())!.y;
  const scrolledGroups = await roster.locator('.bot-roster-groups').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return { top: el.scrollTop, height: el.clientHeight, contentHeight: el.scrollHeight };
  });
  assert.ok(scrolledGroups.contentHeight > scrolledGroups.height, JSON.stringify(scrolledGroups));
  assert.ok(scrolledGroups.top > 0, JSON.stringify(scrolledGroups));
  assert.equal((await mainRow.boundingBox())!.y, pinnedTop);
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${dir}/main-bot-pinned.png` });
  await roster.locator('.bot-roster-groups').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: `${dir}/main-bot-team.png`, fullPage: true });
  await picker.selectOption('worker1');
  await page.locator('.bot-card[data-bot-id="worker1"] .main-bot-badge').waitFor();
  assert.equal(await page.locator('.bot-card[data-bot-id="research"] .main-bot-badge').count(), 0);
  assert.equal(await mainRow.getAttribute('data-bot-id'), 'worker1');
  assert.equal(await roster.locator('.bot-roster-groups [data-bot-id="research"]').count(), 1);
  assert.equal(await roster.locator('.bot-roster-groups [data-bot-id="worker1"]').count(), 0);
  await picker.selectOption('');
  await page.getByRole('heading', { name: 'Who shall we start with?' }).waitFor();
  assert.equal(await page.locator('.roster-main-mark').count(), 0);
  assert.equal(await roster.locator('.roster-main-section').count(), 0);
  assert.equal(await roster.locator('.bot-roster-groups .bot-roster-row').count(), 15);
  await picker.selectOption('research');
  await page.getByRole('heading', { name: 'Big plans? Start with Research.' }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Big plans? Start with Research.' }).waitFor();
  await page.getByRole('button', { name: 'Talk to main bot Research', exact: true }).click();
  await page.locator('.chat-top .main-bot-badge').waitFor();
  await page
    .getByRole('textbox', { name: 'Message Research', exact: true })
    .fill('Please coordinate a useful scoped review with a teammate.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page
    .getByText(
      'Our teammate checked the details. Here are their actual findings, brought together.',
      { exact: true },
    )
    .waitFor();
  assert.equal(store.all('deliveries').length, 1);
  assert.equal(store.all('deliveries')[0].status, 'completed');
  await page.screenshot({ path: `${dir}/main-bot-delegation.png`, fullPage: true });
  const beforeOther = calls.length;
  await page
    .getByRole('navigation', { name: 'Your bots', exact: true })
    .getByRole('button', { name: 'Open Worker2', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Message Worker2', exact: true })
    .fill('Hello, answer directly please.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('A direct reply from this teammate.', { exact: true }).waitFor();
  assert.equal(calls.length, beforeOther + 1);
  assert.ok(
    !calls.at(-1).messages[0].content.includes('MAIN DELEGATION BOT — DIRECT HUMAN CONVERSATION:'),
  );
  assert.equal(store.all('deliveries').length, 1);
  await page.getByRole('button', { name: 'Settings & connections', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Main delegation bot', exact: true })
    .selectOption('worker1');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Settings saved', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Your team', exact: true }).click();
  await page.getByRole('heading', { name: 'Big plans? Start with Worker1.' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${dir}/main-bot-phone.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const crown = await page.locator('.bot-roster [data-bot-id="worker1"] .roster-main-mark').count();
  assert.equal(crown, 1);
  assert.equal(await mainRow.getAttribute('data-bot-id'), 'worker1');
  assert.equal(await mainRow.isVisible(), true);
  assert.ok(
    (await mainRow.boundingBox())!.height >
      (await roster.locator('.bot-roster-groups .bot-roster-row').first().boundingBox())!.height,
  );
  await picker.selectOption('');
  await page.getByRole('heading', { name: 'Who shall we start with?' }).waitFor();
  assert.equal(store.settings().mainBotId, null);
  assert.deepEqual(errors, []);
  const result = {
    dir,
    selectedAndCleared: true,
    exclusiveRole: true,
    storedAcrossReload: true,
    mainGuidanceUsed: true,
    realReceipt: true,
    otherBotChatStayedDirect: true,
    phoneLayout: true,
    mainBotPinnedAboveCategories: true,
    largerMainBot: true,
    noDuplicateInCategory: true,
    scrolledGroups,
    model: 'Simulated compatible provider',
    errors,
  };
  writeFileSync(`${dir}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
  for (let n = 0; n < 250 && host.runtime.controllers.size; n++)
    await new Promise((r) => setTimeout(r, 10));
  await app.close();
  host.runtime.events.emit('shutdown');
  host.computer.dispose();
  await host.terminal.dispose();
  server.closeAllConnections();
  provider.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => server.close(() => r())),
    new Promise<void>((r) => provider.close(() => r())),
  ]);
  store.close();
}
