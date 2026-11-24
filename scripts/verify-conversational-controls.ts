import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createApp } from '../apps/server/app';
import { Credentials } from '../apps/server/credentials';
import { OsSecrets } from '../apps/server/host-secrets';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import { Store } from '../apps/server/store';

const dir = resolve(`test-results/conversational-controls/ui-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const store = new Store(join(dir, 'host/team.sqlite'));
seed(store, resolve('reference/grok-backup'));
store.setConfig('settings', { ...store.settings(), mainBotId: 'boss-man' });
store.put('bots', { ...store.get('bots', 'worker3')!, isPrototype: true });
const backend = new OsSecrets(),
  credentials = new Credentials(join(dir, 'external'), backend, join(dir, 'workspace'));
const calls: any[] = [],
  held: ServerResponse[] = [];
let released = false;
const answer = (content: string) => ({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { total_tokens: 9 },
});
const privateArgs = {
  service: 'Example publishing',
  purpose: 'Connect the publishing service from this conversation',
  connectionJson: JSON.stringify({
    type: 'operation',
    url: 'https://service.test/pages',
    method: 'POST',
    authType: 'bearer',
    inputFields: ['title'],
    responseFields: ['id', 'url'],
  }),
};
const model = createServer(async (req, res) => {
  let text = '';
  for await (const part of req) text += part;
  const body = JSON.parse(text);
  calls.push(body);
  const system = body.messages[0].content;
  res.setHeader('Content-Type', 'application/json');
  if (system.includes('TEMPORARY CLONE:')) {
    if (!released) {
      held.push(res);
      return;
    }
    res.end(JSON.stringify(answer('INDIVIDUAL_CLONE_REPLY: the completed scoped findings.')));
    return;
  }
  if (system.includes('PROTOTYPE COORDINATOR:')) {
    res.end(
      JSON.stringify(answer('COMBINED_PROTOTYPE_REPLY: the best-of result from four workers.')),
    );
    return;
  }
  const prompt =
    body.messages.filter((message: any) => message.role === 'user').at(-1)?.content ?? '';
  if (
    prompt.includes('Set up the example publishing connection') &&
    body.messages.at(-1).role !== 'tool'
  ) {
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'private',
                  type: 'function',
                  function: {
                    name: 'credential_setup_request',
                    arguments: JSON.stringify(privateArgs),
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
  res.end(
    JSON.stringify(
      answer('The private connection status is ready. I cannot read your secret value.'),
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
  ),
  server = host.app.listen(0, '127.0.0.1');
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
const created = new Set<string>();
async function until(ready: () => boolean) {
  for (let i = 0; i < 600; i++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Conversational UI state timed out');
}
try {
  const page = await app.firstWindow(),
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1500, height: 1050 });
  await page.getByRole('button', { name: 'Open Boss Man', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message Boss Man', exact: true })
    .fill('Let me give you my OpenAI API key.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Private key entry', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Secret name', { exact: true }).inputValue(), 'OpenAI');
  assert.match(await dialog.innerText(), /bot cannot read the secret value entered in this box/i);
  assert.match(await dialog.innerText(), /encrypted in your operating system/);
  assert.equal(
    await page.getByLabel('Secret value', { exact: true }).getAttribute('type'),
    'password',
  );
  assert.equal(calls.length, 0, 'Opening key entry does not send the typed prompt to an LLM.');
  const key = `TEST_ONLY_CONVERSATIONAL_UI_${Date.now()}`;
  await page.getByLabel('Secret value', { exact: true }).fill(key);
  await page.screenshot({ path: join(dir, 'private-entry.png') });
  await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click();
  await until(() => store.all('credentialSetups').some((request) => request.status === 'saved'));
  const first = store.all('credentialSetups')[0];
  created.add(first.secretId!);
  assert.equal(backend.get(first.secretId!), key);
  assert.equal(first.connected, true);
  await until(() => !host.runtime.controllers.size);
  assert.ok(!JSON.stringify(calls).includes(key));
  assert.ok(!JSON.stringify(store.export()).includes(key));
  assert.ok(!(await page.locator('body').innerText()).includes(key));
  assert.ok(
    store
      .all('providers')
      .some((provider) => provider.name === 'OpenAI' && provider.credentialId === first.grantId),
  );
  await page
    .getByRole('textbox', { name: 'Message Boss Man', exact: true })
    .fill('Set up the example publishing connection.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Private key entry', exact: true }).waitFor();
  assert.match(await dialog.innerText(), /POST service.test\/pages/);
  const secondKey = `TEST_ONLY_PUBLISH_UI_${Date.now()}`;
  await page.getByLabel('Secret value', { exact: true }).fill(secondKey);
  await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click();
  await until(
    () =>
      store.all('credentialSetups').filter((request) => request.status === 'saved').length === 2,
  );
  created.add(store.all('credentialSetups').find((request) => request.id !== first.id)!.secretId!);
  await until(() => !host.runtime.controllers.size);
  assert.equal(credentials.capabilities(store.get('bots', 'boss-man')!).length, 1);
  assert.equal(credentials.state().actions.length, 0);
  assert.ok(!JSON.stringify(calls).includes(secondKey));
  await page.getByRole('button', { name: 'Add a key privately', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Private key entry', exact: true }).waitFor();
  await page.getByLabel('Secret value', { exact: true }).fill('TEST_ONLY_CANCELLED_VALUE');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await until(() =>
    store.all('credentialSetups').some((request) => request.status === 'cancelled'),
  );
  await page.waitForTimeout(1500);
  assert.equal(await dialog.count(), 0, 'Cancellation does not immediately reopen the window.');

  const before = store.get('bots', 'worker1')!;
  await page.getByRole('button', { name: 'Open Worker1', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive bot', exact: true }).waitFor();
  await page.screenshot({ path: join(dir, 'bot-menu.png') });
  await page.getByRole('menuitem', { name: 'Archive bot', exact: true }).click();
  await until(() => !!store.get('bots', 'worker1')!.archivedAt);
  await page.getByRole('button', { name: /Archived bots/ }).click();
  await dialog.getByRole('heading', { name: 'Archived bots', exact: true }).waitFor();
  await dialog.locator('[data-archived-bot="worker1"]').waitFor();
  assert.equal(await page.locator('.bot-roster-row[data-bot-id="worker1"]').count(), 0);
  await page.screenshot({ path: join(dir, 'archive.png') });
  await dialog.getByRole('button', { name: 'Unarchive', exact: true }).click();
  await until(() => !store.get('bots', 'worker1')!.archivedAt);
  assert.deepEqual(store.get('bots', 'worker1'), before);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Open Worker2', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete bot…', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Delete Worker2?', exact: true }).waitFor();
  await page.screenshot({ path: join(dir, 'delete-warning.png') });
  await dialog.getByRole('button', { name: 'Archive instead', exact: true }).click();
  await until(() => !!store.get('bots', 'worker2')!.archivedAt);
  await page.getByRole('button', { name: /Archived bots/ }).click();
  await dialog
    .locator('[data-archived-bot="worker2"]')
    .getByRole('button', { name: 'Unarchive', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Open Worker2', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete bot…', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete bot', exact: true }).click();
  await until(() => !!store.get('bots', 'worker2')!.deletedAt);
  assert.equal(store.get('bots', 'worker2')!.instructions, '');
  await page.reload();
  assert.equal(await page.locator('.bot-roster-row[data-bot-id="worker2"]').count(), 0);
  await page.getByRole('button', { name: 'Open Boss Man', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message Boss Man', exact: true })
    .fill(
      'Ask @Worker3 to launch 4 workers to review the supplied example from independent angles.',
    );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const grid = page.getByLabel('Working bot grid', { exact: true });
  await grid.waitFor();
  await until(() => held.length === 2);
  assert.equal(await grid.locator('.worker-tile').count(), 6);
  const tileBounds = (await grid.locator('.worker-tile').first().boundingBox())!,
    avatarBounds = (await grid.locator('.worker-tile .avatar').first().boundingBox())!;
  assert.ok(
    avatarBounds.y >= tileBounds.y + 8 &&
      avatarBounds.y + avatarBounds.height <= tileBounds.y + tileBounds.height,
  );
  assert.equal(avatarBounds.height, 48);
  assert.equal(await page.locator('.collaboration-card').count(), 0);
  assert.equal(await page.locator('.task-journey').count(), 0);
  await page.screenshot({ path: join(dir, 'worker-grid.png') });
  await grid.getByRole('button', { name: "Show Worker3 1's reply", exact: true }).click();
  assert.equal(await page.locator('.collaboration-card').count(), 1);
  released = true;
  for (const response of held)
    response.end(JSON.stringify(answer('INDIVIDUAL_CLONE_REPLY: the completed scoped findings.')));
  await until(() => !host.runtime.controllers.size);
  await page
    .locator('.collaboration-answer-preview')
    .getByText('INDIVIDUAL_CLONE_REPLY: the completed scoped findings.', { exact: true })
    .waitFor();
  await page.screenshot({ path: join(dir, 'individual-worker.png') });
  await page.getByRole('button', { name: 'Close individual worker reply', exact: true }).click();
  assert.equal(await page.locator('.collaboration-card').count(), 0);
  await page.getByRole('button', { name: 'Detailed handoff list', exact: true }).click();
  assert.equal(await page.locator('.collaboration-card').count(), 5);
  await page.getByRole('button', { name: 'Compact worker grid', exact: true }).click();
  assert.equal(await page.locator('.collaboration-card').count(), 0);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await page.screenshot({ path: join(dir, 'worker-grid-light.png') });
  assert.equal(errors.length, 0, errors.join('\n'));
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify(
      {
        verified: true,
        version: await app.evaluate(({ app }) => app.getVersion()),
        conversationalPrivateEntry: true,
        botRequestedPrivateEntry: true,
        nativeOsStorage: true,
        modelReadSecret: false,
        archiveRestore: true,
        deleteWarningAndArchiveAlternative: true,
        permanentProfileDeletion: true,
        workerGridCount: 6,
        individualReply: true,
        rendererErrors: errors,
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
  released = true;
  for (const response of held)
    if (!response.writableEnded) response.end(JSON.stringify(answer('Stopped isolated test.')));
  await app.close();
  for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
  await until(() => !host.runtime.controllers.size);
  host.runtime.events.emit('shutdown');
  host.computer.dispose();
  await host.terminal.dispose();
  // Only random aliases recorded by this isolated host are eligible for cleanup.
  for (const secret of credentials.manager().state().secrets)
    if (/^secret-[a-f0-9-]+$/.test(secret.id)) created.add(secret.id);
  for (const id of created) backend.delete(id);
  model.closeAllConnections();
  server.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => model.close(() => r())),
    new Promise<void>((r) => server.close(() => r())),
  ]);
  store.close();
}
