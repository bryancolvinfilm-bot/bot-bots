import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const native = async () =>
  (await (await fetch('http://127.0.0.1:1234/api/v1/models')).json()).models;
const loadedBefore = (await native()).filter((m) => m.loaded_instances.length && m.type === 'llm');
assert.equal(
  loadedBefore.length,
  1,
  'This verification requires exactly one loaded local chat model.',
);
const expected = loadedBefore[0],
  context = expected.loaded_instances[0].config.context_length;
const dir = resolve(`test-results/discovery/ui-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const app = await electron.launch({
  args: process.env.BOT_BOTS_TEST_EXECUTABLE ? [] : ['.'],
  executablePath: process.env.BOT_BOTS_TEST_EXECUTABLE,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    BOT_BOTS_DATA_DIR: `${dir}/team`,
    BOT_BOTS_DESKTOP_PORT: '0',
  },
  timeout: 30000,
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
  const api = (path, method = 'GET', body) =>
    page.evaluate(
      async ({ path, method, body }) => {
        const res = await fetch(`/api${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!res.ok) throw Error(await res.text());
        return res.json();
      },
      { path, method, body },
    );
  async function until(fn, timeout = 300000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = await fn();
      if (result) return result;
      await page.waitForTimeout(150);
    }
    throw Error('Model discovery verification timed out');
  }
  let data = await until(async () => {
    const d = await api('/bootstrap');
    return d.models.some((m) => m.name === expected.key && m.loadState === 'loaded') && d;
  });
  const model = data.models.find((m) => m.name === expected.key);
  assert.equal(model.contextTokens, context);
  assert.equal(model.loadedContextTokens, context);
  assert.ok(data.models.some((m) => m.name === 'qwen/qwen3.5-9b' && m.loadState === 'unloaded'));
  assert.ok(
    data.models
      .filter((m) => m.modelType === 'embedding' || m.modelType === 'other')
      .every((m) => !m.enabled),
  );
  await api('/settings', 'PUT', { ...data.settings, maxOutputTokens: 512 });
  await page.getByRole('button', { name: 'Chat with Worker1', exact: true }).click();
  await until(async () =>
    (await page.locator('.composer-model').textContent()).includes(expected.key),
  );
  const label = await page.locator('.composer-model').textContent();
  assert.match(label, /Replying with/);
  assert.ok(
    (await page.locator('.composer-model').getAttribute('title')).includes(
      context.toLocaleString('en-US'),
    ),
  );
  await page.screenshot({ path: `${dir}/chat-auto-model.png`, fullPage: true });
  let result, reply;
  if (process.env.BOT_BOTS_TEST_SKIP_INFERENCE !== '1') {
    await page
      .getByRole('textbox', { name: 'Message Worker1', exact: true })
      .fill('Use no tools. Reply exactly LOCAL_MODEL_READY.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    result = await until(async () => {
      const d = await api('/bootstrap');
      return d.runs.find((r) => r.botId === 'worker1' && r.status !== 'running');
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.modelId, model.id);
    reply = (await api(`/conversations/${result.conversationId}/messages`)).findLast(
      (m) => m.role === 'assistant' && m.runId === result.id,
    )?.content;
    assert.match(reply ?? '', /LOCAL_MODEL_READY/);
    assert.ok(result.work.every((w) => w.attempts.every((a) => a.modelId === model.id)));
    await page.screenshot({ path: `${dir}/real-model-reply.png`, fullPage: true });
  }
  // Wait for an idle periodic refresh without pressing Discover.
  const before = (await api('/bootstrap')).providers.find(
    (p) => p.id === model.providerId,
  ).discoveredAt;
  await until(
    async () =>
      (await api('/bootstrap')).providers.find((p) => p.id === model.providerId).discoveredAt !==
      before,
    22000,
  );
  await page.getByRole('button', { name: 'Model workshop', exact: true }).click();
  await page.getByRole('radio', { name: 'Automatically follow available models' }).waitFor();
  assert.equal(
    await page.getByRole('radio', { name: 'Automatically follow available models' }).isChecked(),
    true,
  );
  const enable = page.getByRole('checkbox', { name: `Enable ${expected.key}`, exact: true });
  await enable.click();
  await until(async () => !(await api('/bootstrap')).models.find((m) => m.id === model.id).enabled);
  await api(`/providers/${model.providerId}/discover`, 'POST');
  assert.equal((await api('/bootstrap')).models.find((m) => m.id === model.id).enabled, false);
  await enable.click();
  await until(async () => (await api('/bootstrap')).models.find((m) => m.id === model.id).enabled);
  await page.getByRole('button', { name: expected.key, exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.waitFor();
  await page.screenshot({ path: `${dir}/loaded-context-editor.png`, fullPage: true });
  assert.deepEqual(errors, []);
  const after = (await native()).filter((m) => m.loaded_instances.length && m.type === 'llm');
  assert.deepEqual(
    after.map((m) => m.key),
    loadedBefore.map((m) => m.key),
  );
  const evidence = {
    model: model.name,
    loadedContextTokens: context,
    label,
    inferenceVerified: !!result,
    runId: result?.id,
    reply,
    tokens: result?.tokens,
    periodicRefresh: true,
    explicitDisablePreserved: true,
    pageErrors: errors,
    version: (await api('/health')).version,
  };
  writeFileSync(`${dir}/result.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ dir, ...evidence }));
} finally {
  await app.close();
}
