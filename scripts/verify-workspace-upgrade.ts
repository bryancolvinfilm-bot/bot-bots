import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createApp } from '../apps/server/app';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import { Store } from '../apps/server/store';
import { changeBotLifecycle } from '../apps/server/bot-lifecycle';

const dir = resolve(`test-results/workspace-upgrade/ui-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const store = new Store(join(dir, 'host/team.sqlite'));
seed(store, resolve('reference/grok-backup'));
const errors: string[] = [];
let held: ServerResponse | undefined;
const answer = (content: string) => ({
  choices: [{ message: { content }, finish_reason: 'stop' }],
});
const skillContent =
  '# Regression API playbook\n\nGET https://example.com/items\nUse a separately granted connection.';
const provider = createServer(async (req, res) => {
  let text = '';
  for await (const part of req) text += part;
  const body = JSON.parse(text);
  const prompt = body.messages.filter((m: any) => m.role === 'user').at(-1)?.content ?? '';
  res.setHeader('Content-Type', 'application/json');
  if (prompt.includes('Keep working while I review earlier messages')) {
    held = res;
    return;
  }
  if (
    prompt.includes('Create a shared skill named Regression API playbook') &&
    body.messages.at(-1)?.role !== 'tool'
  ) {
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'save',
                  type: 'function',
                  function: {
                    name: 'skill_save',
                    arguments: JSON.stringify({
                      name: 'Regression API playbook',
                      content: skillContent,
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    return;
  }
  res.end(JSON.stringify(answer('The shared playbook is saved for every bot.')));
});
await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
for (const p of store.all('providers'))
  store.put('providers', {
    ...p,
    autoDiscover: false,
    baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
  });
const model = store.all('models')[0];
for (const m of store.all('models')) store.put('models', { ...m, enabled: m.id === model.id });
store.put('models', { ...model, enabled: true, toolCalling: 'enabled', contextTokens: 131072 });
store.put('providers', { ...store.get('providers', model.providerId)!, local: false });
store.setConfig('settings', { ...store.settings(), localOnly: false, mainBotId: null });
store.put('categories', { id: 'regression-empty', name: 'Empty test group', color: '#91b472' });
store.put('conversations', {
  id: 'regression-history',
  botId: 'boss-man',
  title: 'Workspace regression conversation',
  createdAt: new Date().toISOString(),
});
for (let i = 0; i < 20; i++)
  store.put('messages', {
    id: `regression-message-${i}`,
    botId: 'boss-man',
    conversationId: 'regression-history',
    role: i % 2 ? 'assistant' : 'user',
    content: `Saved message ${i}. ${'This text gives the conversation enough history to scroll. '.repeat(20)}`,
    createdAt: new Date(Date.now() - (20 - i) * 1000).toISOString(),
  });
const host = createApp(store, join(dir, 'host'), resolve('dist/web'));
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
async function until(ready: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Workspace UI timed out');
}
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.getByRole('button', { name: 'Toggle browser panel', exact: true }).click();
  await page.getByRole('complementary', { name: 'Browser workspace' }).waitFor();
  await page.getByRole('button', { name: 'Close browser', exact: true }).click();

  const row = page.locator('.bot-roster-row[data-bot-id="research"]');
  const group = page.locator('.roster-category-group[data-category-id="regression-empty"]');
  assert.ok(await group.isVisible());
  const beforeHeight = (await group.boundingBox())!.height;
  await row.dragTo(group.locator('.roster-category'));
  await until(() => store.get('bots', 'research')?.categoryId === 'regression-empty');
  await group.locator('.bot-roster-row[data-bot-id="research"]').waitFor();
  assert.ok(beforeHeight > 0);
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to group…' }).click();
  await page.getByRole('combobox', { name: 'Move bot to group' }).selectOption('');
  await page.getByRole('dialog').getByRole('button', { name: 'Move bot', exact: true }).click();
  await until(() => !store.get('bots', 'research')?.categoryId);

  await page.getByRole('button', { name: 'Open Boss Man', exact: true }).click();
  await page.getByRole('button', { name: 'Workspace regression conversation' }).click();
  const input = page.getByRole('textbox', { name: 'Message Boss Man', exact: true });
  await input.waitFor();
  const pasted = 'A long pasted line with [unfinished brackets and plain text.\n'.repeat(17000);
  const paste = await input.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    (element as HTMLElement).focus();
    const started = performance.now();
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    );
    return {
      elapsed: performance.now() - started,
      nodes: element.querySelectorAll('*').length,
      length: element.textContent?.length,
    };
  }, pasted);
  assert.equal(paste.length, pasted.length);
  assert.ok(paste.nodes < 10, `Large paste created ${paste.nodes} nodes`);
  assert.ok(paste.elapsed < 1500, `Paste handler blocked for ${paste.elapsed} ms`);
  await input.press('Control+z');
  assert.equal(await input.textContent(), '');
  const largeMessage = '['.repeat(100000);
  await input.fill(largeMessage);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(
    () =>
      store.all('messages').some((m) => m.role === 'user' && m.content === largeMessage) &&
      !host.runtime.controllers.size,
  );
  await page.getByRole('button', { name: 'Read complete message (100,000 characters)' }).waitFor();
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    (globalThis as any).__testClipboard = await Promise.all(
      (await clipboard.read())
        .filter((item) => item.types.length)
        .map(
          async (item) =>
            new ClipboardItem(
              Object.fromEntries(
                await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
              ),
            ),
        ),
    );
  });
  await app.evaluate(({ clipboard }: any, value) => clipboard.writeText(value), pasted);
  await input.press('Control+v');
  assert.equal(await input.textContent(), pasted);
  await input.press('Control+z');
  assert.equal(await input.textContent(), '');
  await input.fill('Create a shared skill named Regression API playbook for our test API.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(
    () =>
      store.all('skills').some((skill) => skill.name === 'Regression API playbook') &&
      !host.runtime.controllers.size,
  );
  const skill = store.all('skills').find((s) => s.name === 'Regression API playbook')!;
  assert.equal(skill.originBotId, 'boss-man');
  await page.getByRole('button', { name: 'Toggle bot panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Boss Man panel', exact: true });
  await panel.getByRole('button', { name: 'Skills', exact: true }).click();
  await panel.getByText('Regression API playbook', { exact: true }).waitFor();
  await page.screenshot({ path: join(dir, 'bot-skills.png') });
  await page.getByRole('button', { name: 'Close bot panel', exact: true }).click();

  await input.fill('Keep working while I review earlier messages.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(() => !!held);
  const messages = page.locator('.messages');
  await messages.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.getByRole('complementary', { name: 'Live bot progress', exact: true }).waitFor();
  const topScroll = await messages.evaluate((e) => e.scrollTop);
  await page.waitForTimeout(150);
  assert.equal(await messages.evaluate((e) => e.scrollTop), topScroll);
  const user = await page.locator('.message.user').first().boundingBox();
  const bot = await page.locator('.message.assistant').first().boundingBox();
  assert.ok(user && bot && user.x > bot.x + 40, 'User and bot messages must occupy opposite sides');
  await page.screenshot({ path: join(dir, 'pinned-progress-and-alignment.png') });
  held!.end(JSON.stringify(answer('The work is complete.')));
  held = undefined;
  await until(() => !host.runtime.controllers.size);
  await page
    .getByRole('complementary', { name: 'Live bot progress', exact: true })
    .waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'Shared skills', exact: true }).click();
  const card = page.locator('.skill-card').filter({ hasText: 'Regression API playbook' });
  await card.waitFor();
  await card.click();
  const editor = page.getByRole('dialog');
  await editor.getByRole('button', { name: 'Edit Markdown', exact: true }).click();
  const modified = skillContent + '\n\n## Updated\nReturn only the requested fields.';
  await editor.getByRole('textbox', { name: 'Skill Markdown', exact: true }).fill(modified);
  await editor.getByRole('button', { name: 'Save skill', exact: true }).click();
  await until(() => store.get('skills', skill.id)?.content === modified);
  await editor.getByRole('button', { name: 'Delete skill', exact: true }).click();
  const warning = page.getByRole('dialog', { name: 'Are you sure?', exact: true });
  await warning.waitFor();
  await warning.getByRole('button', { name: 'No', exact: true }).click();
  assert.ok(store.get('skills', skill.id));

  changeBotLifecycle(store, 'boss-man', 'archive');
  assert.ok(store.get('skills', skill.id));
  changeBotLifecycle(store, 'boss-man', 'delete');
  await page.reload();
  await page.getByRole('button', { name: 'Shared skills', exact: true }).click();
  await card.click();
  await page
    .getByRole('dialog')
    .getByText('Originally made with Boss Man', { exact: false })
    .waitFor();
  assert.equal(store.get('skills', skill.id)?.originBotName, 'Boss Man');
  await page.screenshot({ path: join(dir, 'shared-skills-after-origin-deletion.png') });
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Edit Markdown', exact: true })
    .click();
  assert.equal(
    await page.getByRole('textbox', { name: 'Skill Markdown', exact: true }).inputValue(),
    modified,
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Delete skill', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Are you sure?', exact: true })
    .getByRole('button', { name: 'Yes', exact: true })
    .click();
  await until(() => !store.get('skills', skill.id));
  assert.deepEqual(errors, []);
  const result = {
    verified: true,
    version: await app.evaluate(({ app }) => app.getVersion()),
    paste,
    pastedCharacters: pasted.length,
    nativePasteAndUndo: true,
    sentCharacters: largeMessage.length,
    browserRename: true,
    emptyGroupDrag: true,
    menuMove: true,
    skillCreatedByBot: true,
    botSkills: true,
    markdownEdit: true,
    deleteNoAndYes: true,
    survivesOriginArchiveAndDeletion: true,
    pinnedProgress: true,
    chatAlignment: true,
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
  await app.evaluate(async ({ clipboard }) => {
    if ((globalThis as any).__testClipboard) {
      if ((globalThis as any).__testClipboard.length)
        await clipboard.write((globalThis as any).__testClipboard);
      else clipboard.clear();
    }
  });
  held?.end(JSON.stringify(answer('Isolated check stopped.')));
  await app.close();
  for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
  await until(() => !host.runtime.controllers.size);
  host.runtime.events.emit('shutdown');
  host.computer.dispose();
  await host.terminal.dispose();
  provider.closeAllConnections();
  server.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => provider.close(() => r())),
    new Promise<void>((r) => server.close(() => r())),
  ]);
  store.close();
}
