import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createApp } from '../apps/server/app';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import { candidates, refreshLocalModels } from '../apps/server/models';
import { Store } from '../apps/server/store';
import type { BotDelivery } from '../packages/shared/delivery';
import type { Run } from '../packages/shared/types';

const live = process.env.BOT_BOTS_DELIVERY_LIVE === '1';
const dir = resolve(`test-results/delivery/${live ? 'live' : 'mock'}-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const store = new Store(join(dir, 'host/team.sqlite'));
seed(store, resolve('reference/grok-backup'));
let calls = 0;
const simulated = createServer(async (req, res) => {
  let text = '';
  for await (const c of req) text += c;
  const body = JSON.parse(text);
  calls++;
  assert.equal(body.tools, undefined);
  res.setHeader('Content-Type', 'application/json');
  // Keep it working long enough to inspect the recipient's durable inbox while inference is pending.
  setTimeout(
    () =>
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: 'DELIVERY_RECEIVED_42', role: 'assistant' },
              finish_reason: 'stop',
            },
          ],
          usage: { total_tokens: 12 },
        }),
      ),
    1800,
  );
});
if (live) {
  await refreshLocalModels(store);
  const loaded = candidates(store, 'general').filter(
    (m) => m.status === 'online' && m.loadState === 'loaded',
  );
  assert.equal(loaded.length, 1, 'Load exactly one local chat model for the live delivery check.');
  for (const m of store.all('models'))
    store.put('models', {
      ...m,
      enabled: m.id === loaded[0].id,
      enablement: 'manual',
      toolCalling: 'disabled',
    });
  console.log(`Testing only the loaded local model: ${loaded[0].name}`);
} else {
  await new Promise<void>((r) => simulated.listen(0, '127.0.0.1', r));
  for (const p of store.all('providers'))
    store.put('providers', {
      ...p,
      autoDiscover: false,
      baseUrl: `http://127.0.0.1:${(simulated.address() as AddressInfo).port}/v1`,
    });
  for (const m of store.all('models'))
    store.put('models', { ...m, toolCalling: 'disabled', toolFormatUnsupported: true });
}
store.setConfig('settings', { ...store.settings(), maxOutputTokens: 256 });
store.put('conversations', {
  id: 'delivery-research',
  botId: 'research',
  title: 'Delivery check',
  createdAt: new Date().toISOString(),
});
store.put('messages', {
  id: 'context-42',
  botId: 'research',
  conversationId: 'delivery-research',
  role: 'assistant',
  content: 'The reference code for the handoff is 42. These are test notes.',
  createdAt: new Date().toISOString(),
});
const host = createApp(store, join(dir, 'host'), resolve('dist/web'));
const server = host.app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const desktopEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env))
  if (typeof value === 'string' && key !== 'ELECTRON_RUN_AS_NODE') desktopEnv[key] = value;
const app = await electron.launch({
  args: process.env.BOT_BOTS_TEST_EXECUTABLE ? [] : ['.'],
  executablePath: process.env.BOT_BOTS_TEST_EXECUTABLE,
  env: {
    ...desktopEnv,
    BOT_BOTS_DATA_DIR: join(dir, 'client'),
    BOT_BOTS_MODE: 'client',
    BOT_BOTS_SERVER_URL: url,
  },
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
  await page.getByRole('button', { name: 'Chat with Research', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Message Research', exact: true });
  await editor.fill(
    'Tell @Info Page Generate to reply exactly DELIVERY_RECEIVED_42. Use no tools.',
  );
  await page.getByText(/Sends a handoff to Info Page Generate/).waitFor();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  async function until<T>(fn: () => T | undefined | false, timeout = 240000): Promise<T> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = fn();
      if (result) return result;
      await page.waitForTimeout(100);
    }
    throw Error('Delivery verification timed out');
  }
  const receipt = await until<BotDelivery>(() => store.all('deliveries')[0]);
  assert.equal(receipt.fromBotId, 'research');
  assert.equal(receipt.toBotId, 'info-page-generate');
  assert.ok(
    store.all('messages').some((m) => m.deliveryId === receipt.id && m.senderBotId === 'research'),
  );
  const card = page.locator(`[data-handoff-id="${receipt.id}"]`);
  await card.getByText(/Received .*Receipt/).waitFor();
  await page.screenshot({ path: `${dir}/received-before-reply.png`, fullPage: true });
  const finished = await until<Run>(() => {
    const r = store.get('runs', receipt.runId);
    return r?.status !== 'running' && r;
  });
  assert.equal(finished.status, 'completed', finished.error);
  const delivered = store.get('deliveries', receipt.id)!;
  assert.equal(delivered.status, 'completed');
  assert.match(delivered.answer!, /DELIVERY_RECEIVED_42/);
  assert.equal(
    finished.work![0].attempts.length,
    0,
    'The sender must not rely on a native model tool call to dispatch.',
  );
  await card.getByRole('button', { name: 'Open inbox conversation', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Info Page Generate', exact: true }).waitFor();
  await page.getByText(`Received handoff · Receipt ${receipt.id}`, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Toggle bot panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Info Page Generate panel', exact: true });
  await panel.getByRole('button', { name: 'Inbox', exact: true }).click();
  const entry = panel.locator(`[data-delivery-id="${receipt.id}"]`);
  await entry.getByText('From Research', { exact: true }).waitFor();
  await entry.getByText('Reply returned', { exact: true }).waitFor();
  await page.screenshot({ path: `${dir}/recipient-inbox.png`, fullPage: true });
  await page.getByRole('button', { name: 'Close bot panel', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message Info Page Generate', exact: true })
    .fill('Did you receive the request from @Research?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const check = await until<Run>(() =>
    store.all('runs').find((r) => r.botId === 'info-page-generate' && r.status !== 'running'),
  );
  const reply = store.all('messages').find((m) => m.runId === check.id && m.role === 'assistant')!;
  assert.ok(reply.content.includes(receipt.id));
  assert.equal(check.work![0].attempts.length, 0);
  if (!live) assert.equal(calls, 1);
  await page.reload();
  await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
  assert.equal(host.runtime.mailbox.inbox('info-page-generate')[0].id, receipt.id);
  assert.deepEqual(errors, []);
  const evidence = {
    mode: live ? 'Loaded local LM Studio model' : 'Simulated text-only model',
    receiptId: receipt.id,
    from: 'Research',
    to: 'Info Page Generate',
    receivedAt: receipt.receivedAt,
    status: delivered.status,
    answer: delivered.answer,
    modelId: finished.work?.find((w) => w.handoffId === receipt.id)?.modelId,
    senderInferenceCalls: 0,
    nativeToolsDisabled: true,
    recipientQuestionUsedModel: false,
    inboxVerified: true,
    pageErrors: errors,
  };
  writeFileSync(`${dir}/result.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ dir, ...evidence }));
} finally {
  for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
  for (let n = 0; n < 250 && host.runtime.controllers.size; n++)
    await new Promise((r) => setTimeout(r, 10));
  await app.close();
  host.runtime.events.emit('shutdown');
  host.computer.dispose();
  await host.terminal.dispose();
  server.closeAllConnections();
  if (!live) simulated.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  if (!live) await new Promise<void>((r) => simulated.close(() => r()));
  store.close();
}
