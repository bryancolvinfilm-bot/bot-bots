import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const reuse = process.env.BOT_BOTS_DRAFT_RESUME_DIR;
const dir = resolve(reuse ?? `test-results/drafts/run-${Date.now()}`);
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
  await app.evaluate(
    ({ session }, dir) =>
      session.defaultSession.on('will-download', (_event, item) =>
        item.setSavePath(`${dir}/${item.getFilename()}`),
      ),
    dir,
  );
  async function api(path, method = 'GET', body) {
    return page.evaluate(
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
  }
  async function until(ready, timeout = 300000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await ready();
      if (value) return value;
      await page.waitForTimeout(200);
    }
    throw Error('Qwen draft verification timed out');
  }
  async function waitRun(id) {
    return until(async () => {
      const run = await api(`/runs/${id}`);
      return run.status !== 'running' && run;
    });
  }
  const initial = await api('/bootstrap');
  assert.deepEqual(
    initial.models.filter((m) => m.enabled).map((m) => m.name),
    ['qwen/qwen3.5-9b'],
  );
  // Retry an earlier isolated checkpoint after a failed model implementation.
  if (reuse && process.env.BOT_BOTS_DRAFT_RETRY_FILE === '1') {
    const backup = await api('/export');
    const checkpoint = backup.drafts.find((d) => d.kind === 'file');
    checkpoint.status = 'partial';
    checkpoint.reason = 'Retry the saved unfinished scaffold.';
    delete checkpoint.pageId;
    await api('/import', 'POST', backup);
  }
  await api('/settings', 'PUT', { ...initial.settings, maxOutputTokens: 512 });
  await page.getByRole('button', { name: 'Chat with Worker1', exact: true }).click();
  let editor = page.getByRole('textbox', { name: 'Message Worker1' });
  let run;
  if (reuse) run = JSON.parse(readFileSync(`${dir}/long-reply-run.json`, 'utf8'));
  else {
    await editor.fill(
      'Use NO tools. Write exactly 40 numbered items about organizing a creative project. Each item must have two full sentences and at least 20 words. Do not shorten the requested list. End after item 40 with the exact marker ALL FORTY COMPLETE.',
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    run = await until(async () =>
      (await api('/bootstrap')).runs.find((r) => r.botId === 'worker1'),
    );
  }
  const finished = await waitRun(run.id);
  writeFileSync(`${dir}/long-reply-run.json`, JSON.stringify(finished, null, 2));
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.events.filter((e) => e.kind === 'fallback').length, 0);
  const replyDrafts = await api(`/conversations/${run.conversationId}/drafts`),
    reply = replyDrafts.find((d) => d.kind === 'reply');
  assert.ok(
    reply,
    'The actual 512-token Qwen response must hit length and create a durable reply draft',
  );
  assert.ok(reply.chunks >= 2);
  assert.equal(reply.status, 'complete');
  const full = await api(`/drafts/${reply.id}`);
  assert.match(full.content, /ALL FORTY COMPLETE/);
  assert.ok(full.content.length > 2500);
  assert.equal((await api('/bootstrap')).incidents.length, 0);
  await page.locator(`.draft-card[data-draft-id="${reply.id}"]`).waitFor();
  await page.screenshot({ path: `${dir}/continued-reply.png`, fullPage: true });
  console.log(
    `Qwen text continuation passed: ${reply.chunks} chunks, ${reply.characters} saved characters.`,
  );
  await api('/settings', 'PUT', { ...(await api('/bootstrap')).settings, maxOutputTokens: 1024 });
  let saved = reuse && replyDrafts.find((d) => d.kind === 'file');
  const alreadyComplete = saved?.status === 'complete';
  if (!saved) {
    await editor.fill(
      'Build a complete self-contained counter website named notebook-counter.html using draft_start, small draft_append chunks, and draft_finish. STEP ORDER: your FIRST append must contain ONLY this exact scaffold: <!doctype html><html><head><title>Notebook Counter</title></head><body> . Wait for that append result before writing the next chunk. Then complete the file in later appends with a dark background, a visible number initially 0 in an element with id="count", and a button with id="add" labelled Add one that increments it. Include a styled title, brief explanation, and reset button with id="reset". Implement working JavaScript event handlers, finish, and verify Add and Reset with page_preview click/expect-text checks. Keep the final reply short.',
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    saved = await until(async () =>
      (await api(`/conversations/${run.conversationId}/drafts`)).find(
        (d) =>
          d.kind === 'file' &&
          d.filename === 'notebook-counter.html' &&
          d.characters > 0 &&
          d.status === 'writing',
      ),
    );
    await page.getByRole('button', { name: 'Stop bot', exact: true }).click();
    const stopped = await waitRun(saved.activeRunId);
    assert.equal(stopped.status, 'cancelled');
  }
  const before = alreadyComplete
    ? { content: readFileSync(`${dir}/partial-notebook-counter.html`, 'utf8'), chunks: 1 }
    : await api(`/drafts/${saved.id}`);
  let completed;
  if (alreadyComplete) completed = JSON.parse(readFileSync(`${dir}/notebook-run.json`, 'utf8'));
  else {
    assert.equal(before.status, 'partial');
    assert.ok(before.content.length > 0);
    await page.reload();
    await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
    await page.getByRole('button', { name: 'Chat with Worker1', exact: true }).click();
    const card = page.locator(`.draft-card[data-draft-id="${saved.id}"]`);
    await card.waitFor();
    await card.getByRole('button', { name: 'View draft', exact: true }).click();
    await card.locator('pre').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Preview', exact: true }).count(), 0);
    await card.getByRole('button', { name: 'Download partial', exact: true }).click();
    const downloadPath = `${dir}/partial-${before.filename.split(/[\\/]/).at(-1)}`;
    await until(async () => existsSync(downloadPath));
    assert.equal(readFileSync(downloadPath, 'utf8'), before.content);
    await page.screenshot({ path: `${dir}/saved-partial.png`, fullPage: true });
    await card.getByRole('button', { name: 'Continue draft', exact: true }).click();
    const resumed = await until(async () =>
      (await api(`/conversations/${run.conversationId}/runs`)).findLast(
        (r) => r.id !== saved.activeRunId && r.prompt.includes(saved.id),
      ),
    );
    completed = await waitRun(resumed.id);
    writeFileSync(`${dir}/notebook-run.json`, JSON.stringify(completed, null, 2));
  }
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.events.filter((e) => e.kind === 'fallback').length, 0);
  const result = await api(`/drafts/${saved.id}`);
  assert.equal(result.status, 'complete');
  assert.ok(result.content.startsWith(before.content.slice(0, 120)));
  assert.ok(result.chunks >= before.chunks + 1);
  assert.ok(result.pageId);
  await until(
    async () => (await page.locator(`.artifact-card[data-page-id="${result.pageId}"]`).count()) > 0,
  );
  await page
    .locator(`.artifact-card[data-page-id="${result.pageId}"]`)
    .getByRole('button', { name: 'Run preview', exact: true })
    .click();
  const preview = page.frameLocator('iframe[title^="Preview:"]');
  await preview.locator('#add').waitFor();
  await preview.locator('#add').click();
  await until(async () => /1/.test(await preview.locator('#count').innerText()));
  await page.screenshot({ path: `${dir}/finished-notebook-preview.png`, fullPage: true });
  const final = await api('/bootstrap');
  assert.equal(final.models.find((m) => m.enabled).status, 'online');
  assert.equal(final.incidents.length, 0);
  assert.deepEqual(errors, []);
  writeFileSync(
    `${dir}/verification.json`,
    JSON.stringify(
      {
        version: await api('/health'),
        replyChunks: reply.chunks,
        fileChunks: result.chunks,
        fileCharacters: result.content.length,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    `Qwen notebook/resume passed: ${result.chunks} saved chunks; download, reload, Continue, and working Chromium counter verified. Results: ${dir}`,
  );
} finally {
  await app.close();
}
