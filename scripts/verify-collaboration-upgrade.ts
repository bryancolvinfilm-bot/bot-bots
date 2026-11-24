import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createApp } from '../apps/server/app';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import { Store } from '../apps/server/store';

const dir = resolve(`test-results/collaboration-upgrade/ui-${Date.now()}`);
async function until(ready: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('UI state did not reach the expected result');
}
mkdirSync(dir, { recursive: true });
const store = new Store(join(dir, 'host/team.sqlite'));
seed(store, resolve('reference/grok-backup'));
store.setConfig('settings', { ...store.settings(), mainBotId: 'boss-man' });
store.put('bots', { ...store.get('bots', 'worker3')!, isPrototype: true });
const calls: any[] = [];
const answer = (content: string) => ({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { total_tokens: 9 },
});
const call = (name: string, args: unknown) => ({
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
  usage: { total_tokens: 9 },
});
const start = '<!doctype html><html><body><h1>Building together</h1>',
  end =
    '<p>Second live step</p><button onclick="this.textContent=\'It works\'">Try me</button></body></html>';
let more = () => {},
  finish = () => {},
  builderCalls = 0;
const provider = createServer(async (req, res) => {
  let text = '';
  for await (const part of req) text += part;
  const body = JSON.parse(text);
  calls.push(body);
  let result: unknown;
  if (body.messages[0].content.includes('You are Research'))
    result = answer('ACTUAL_RESEARCH: Scoped facts returned for this isolated test.');
  else {
    builderCalls++;
    const last = body.messages.filter((message: any) => message.role === 'tool').at(-1);
    const saved = last ? JSON.parse(last.content) : undefined;
    if (builderCalls === 1) {
      assert.match(body.messages.at(-1).content, /ACTUAL_RESEARCH/);
      result = call('draft_start', { filename: 'team-page.html' });
    } else if (builderCalls === 2) {
      res.setHeader('Content-Type', 'text/event-stream');
      const frame = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      const args = JSON.stringify({
        id: saved.id,
        expectedRevision: saved.revision,
        content: start,
      }).slice(0, -2);
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'stream', function: { name: 'draft_append', arguments: args } },
              ],
            },
          },
        ],
      });
      more = () =>
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: JSON.stringify(end).slice(1, -1) } },
                ],
              },
            },
          ],
        });
      finish = () => {
        frame({
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        });
        res.end('data: [DONE]\n\n');
      };
      return;
    } else if (builderCalls === 3) result = answer('Click Continue to finish the saved page.');
    else if (builderCalls === 4) result = call('draft_finish', { id: saved.id });
    else
      result = answer(
        'Your saved local page is ready to view. Public publishing needs a configured hosting connection.',
      );
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(result));
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
try {
  const page = await app.firstWindow(),
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1700, height: 1050 });
  await page.getByRole('button', { name: 'Open Boss Man', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message Boss Man', exact: true })
    .fill('Find the best options and build a website with the results.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page
    .locator('.live-build-card')
    .getByRole('button', { name: 'Watch live build', exact: true })
    .waitFor();
  assert.equal(store.all('drafts')[0].content, '');
  await page
    .locator('.live-build-card')
    .getByRole('button', { name: 'Watch live build', exact: true })
    .click();
  const panel = page.getByRole('complementary', { name: 'Website preview', exact: true });
  await panel.locator('.preview-build-code').waitFor();
  await panel.frameLocator('iframe').getByRole('heading', { name: 'Building together' }).waitFor();
  assert.match(await panel.locator('.preview-build-code').innerText(), /Building together/);
  await page.screenshot({ path: join(dir, 'live-first-step.png') });
  more();
  await panel.frameLocator('iframe').getByText('Second live step', { exact: true }).waitFor();
  assert.equal(
    store.all('drafts')[0].content,
    '',
    'The partial tool remains unexecuted while the preview updates.',
  );
  await page.screenshot({ path: join(dir, 'live-second-step.png') });
  finish();
  await page
    .locator('.live-build-card')
    .getByRole('button', { name: 'View page', exact: true })
    .waitFor();
  await until(() =>
    store
      .all('runs')
      .some(
        (run) =>
          run.status === 'completed' &&
          run.prompt === 'Find the best options and build a website with the results.',
      ),
  );
  assert.equal(builderCalls, 5, 'The unfinished file was continued automatically.');
  assert.equal(store.all('pages').length, 1);
  assert.equal(store.all('pages')[0].content, start + end);
  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page
    .locator('.artifact-card[data-page-id]')
    .getByRole('button', { name: 'View page', exact: true })
    .first()
    .click();
  assert.equal(
    await panel.locator('.preview-build-code').count(),
    0,
    'Saved pages open rendered, with code optional.',
  );
  await panel.frameLocator('iframe').getByRole('button', { name: 'Try me' }).click();
  await panel.frameLocator('iframe').getByRole('button', { name: 'It works' }).waitFor();
  await page.screenshot({ path: join(dir, 'saved-page.png') });
  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();
  const bot = store.get('bots', 'comparison')!,
    originalInstructions = bot.instructions;
  const target = store
    .all('categories')
    .find(
      (category) =>
        category.id !== bot.categoryId &&
        store
          .all('bots')
          .some((b) => b.categoryId === category.id && !b.prototypeId && b.id !== 'boss-man'),
    )!;
  await page
    .locator(`.bot-roster-row[data-bot-id="${bot.id}"]`)
    .dragTo(
      page.locator(`.roster-category-group[data-category-id="${target.id}"] .roster-category`),
    );
  await until(() => store.get('bots', bot.id)!.categoryId === target.id);
  assert.equal(store.get('bots', bot.id)!.instructions, originalInstructions);
  await page.reload();
  await page
    .locator(`.roster-category-group[data-category-id="${target.id}"] [data-bot-id="${bot.id}"]`)
    .waitFor({ state: 'attached' });
  await page.getByRole('button', { name: 'Open Worker3', exact: true }).click();
  await page.getByRole('heading', { name: 'A whole team starts here.', exact: true }).waitFor();
  assert.match(await page.locator('.prototype-notice').innerText(), /Ask another bot to delegate/);
  assert.equal(
    await page.getByRole('textbox', { name: 'Message Worker3', exact: true }).count(),
    0,
  );
  await page.screenshot({ path: join(dir, 'prototype.png') });
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(store.all('deliveries').filter((d) => d.status === 'completed').length, 2);
  assert.ok(
    calls.every(
      (body) =>
        body.messages[0].role === 'system' &&
        body.messages.filter((m: any) => m.role === 'system').length === 1,
    ),
  );
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify(
      {
        verified: true,
        version: await app.evaluate(({ app }) => app.getVersion()),
        implicitHandoffs: 2,
        liveFrames: 2,
        automaticContinuation: true,
        interactivePage: true,
        categoryDragPersisted: true,
        prototypeDirectChatBlocked: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ verified: true, result: dir }));
} catch (error) {
  const page = (await app.windows())[0];
  if (page) {
    await page.screenshot({ path: join(dir, 'failure.png') });
    writeFileSync(join(dir, 'failure.txt'), await page.locator('body').innerText());
  }
  throw error;
} finally {
  finish();
  await app.close();
  for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
  for (let i = 0; i < 300 && host.runtime.controllers.size; i++)
    await new Promise((r) => setTimeout(r, 10));
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
