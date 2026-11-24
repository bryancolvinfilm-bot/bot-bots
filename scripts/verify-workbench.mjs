import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const resultDir = resolve(`test-results/workbench/run-${Date.now()}`);
mkdirSync(resultDir, { recursive: true });
const app = await electron.launch({
  args: process.env.BOT_BOTS_TEST_EXECUTABLE ? [] : ['.'],
  executablePath: process.env.BOT_BOTS_TEST_EXECUTABLE,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    BOT_BOTS_DATA_DIR: resolve(`${resultDir}/team`),
    BOT_BOTS_DESKTOP_PORT: '0',
  },
  timeout: 30000,
});
let previousClipboard;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
  previousClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  await app.evaluate(
    ({ session }, dir) =>
      session.defaultSession.on('will-download', (_event, item) =>
        item.setSavePath(`${dir}/${item.getFilename()}`),
      ),
    resultDir,
  );
  async function api(path, method = 'GET', body) {
    return page.evaluate(
      async ({ path, method, body }) => {
        const r = await fetch(`/api${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: r.status, body: await r.json() };
      },
      { path, method, body },
    );
  }
  async function waitRun(id) {
    for (let n = 0; n < 900; n++) {
      const run = (await api(`/runs/${id}`)).body;
      if (run.status !== 'running') return run;
      await page.waitForTimeout(250);
    }
    throw new Error('Qwen run timed out');
  }
  await page.getByRole('button', { name: 'Chat with Worker1', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message Worker1' })
    .fill(
      'Create a complete tiny self-contained HTML website named Button garden. Give it a button labelled Grow and a visible counter initially 0; clicking Grow increments it. Use inline CSS and JavaScript, no external resources. Save it with page_create, then call page_preview on the actual page ID to check it. Reply with the complete source inside an html fenced code block. Do not delegate, browse or use terminal commands. Do the work now.',
    );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page
    .locator('.message.assistant .code-block[data-language="html"]')
    .waitFor({ timeout: 180000 });
  const savedCard = page.locator('.artifact-card').first();
  await savedCard.waitFor();
  const bootstrap = (await api('/bootstrap')).body,
    artifact = bootstrap.pages.find((p) => p.title.toLowerCase().includes('button'));
  assert.ok(artifact);
  assert.equal(artifact.format, 'html');
  const run = (await api(`/runs/${artifact.runId}`)).body;
  assert.ok(
    run.events.some((e) => e.tool === 'page_preview' && e.text.includes('Preview checked')),
  );
  const checked = await api(`/pages/${artifact.id}/check`, 'POST', {});
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.deepEqual(checked.body.errors, []);
  writeFileSync(
    `${resultDir}/verified-page.png`,
    Buffer.from(checked.body.screenshot.split(',')[1], 'base64'),
  );
  const codeBlock = page.locator('.message.assistant .code-block').first();
  assert.ok((await codeBlock.locator('.hljs-name').count()) > 0);
  await codeBlock.getByRole('button', { name: 'Copy code', exact: true }).click();
  await codeBlock.getByText('Copied', { exact: true }).waitFor();
  assert.match(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    /<(html|button|!doctype)/i,
  );
  await codeBlock.getByRole('button', { name: 'Download', exact: true }).click();
  for (let n = 0; n < 100 && !existsSync(`${resultDir}/generated.html`); n++)
    await page.waitForTimeout(50);
  assert.match(readFileSync(`${resultDir}/generated.html`, 'utf8'), /Grow/i);
  await savedCard.getByRole('button', { name: 'Run preview', exact: true }).click();
  const frame = page.frameLocator('.website-frame');
  await frame.getByRole('button', { name: 'Grow', exact: true }).click();
  assert.match(await frame.locator('body').innerText(), /1/);
  await page.locator('.preview-toolbar').getByRole('button', { name: 'Code', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Website preview' })
    .locator('.hljs-name')
    .first()
    .waitFor();
  await page
    .locator('.preview-toolbar')
    .getByRole('button', { name: 'Preview', exact: true })
    .click();
  await page
    .frameLocator('.website-frame')
    .getByRole('button', { name: 'Grow', exact: true })
    .click();
  await page.screenshot({ path: `${resultDir}/inline-code-and-preview.png`, fullPage: true });
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  // A generated document cannot reach app APIs, its parent, Node or the desktop bridge.
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('bot-bots:preview', {
        detail: {
          title: 'Isolation check',
          filename: 'isolated.html',
          language: 'html',
          content:
            '<h1>Isolated preview</h1><p id="result"></p><script>let access;try{parent.document.body;access="leaked"}catch{access="isolated"}fetch("/api/health").then(()=>document.getElementById("result").textContent="network leaked",()=>document.getElementById("result").textContent=access+" / blocked / "+typeof process+" / "+typeof window.botBotsComputer);</script>',
        },
      }),
    ),
  );
  await page
    .frameLocator('.website-frame')
    .getByText('isolated / blocked / undefined / undefined', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  // Copy/paste prepares terminal input without running it.
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('bot-bots:terminal-paste', { detail: "Write-Output 'Prepared only'" }),
    ),
  );
  await page.getByRole('region', { name: 'Terminal panel', exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('Terminal command', { exact: true }).inputValue(),
    "Write-Output 'Prepared only'",
  );
  assert.equal((await api('/terminal')).body.jobs.length, 0);
  await page.getByRole('button', { name: 'Hide terminal', exact: true }).click();
  const denied = (
    await api('/runs', 'POST', {
      botId: 'worker1',
      prompt:
        "Use terminal_request to request the exact PowerShell command Write-Output 'DENIED_TEST_MARKER' with reason 'Test terminal permission denial'. Wait for my decision. Do not run or request any other commands, and do not delegate.",
    })
  ).body;
  await page.locator('.terminal-job[data-status="awaiting-approval"]').waitFor({ timeout: 180000 });
  let pending = (await api('/terminal')).body.jobs.find((j) => j.status === 'awaiting-approval');
  assert.equal(pending.output, '');
  assert.equal(pending.startedAt, undefined);
  // Approval bodies cannot swap in another command.
  assert.equal(
    (
      await api(`/terminal/${pending.id}/decision`, 'POST', {
        approve: true,
        command: 'must not run',
      })
    ).status,
    400,
  );
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await waitRun(denied.id);
  assert.equal(
    (await api('/terminal')).body.jobs.find((j) => j.id === pending.id).status,
    'denied',
  );
  assert.equal((await api('/terminal')).body.jobs.find((j) => j.id === pending.id).output, '');
  const approved = (
    await api('/runs', 'POST', {
      botId: 'worker1',
      prompt:
        "Use terminal_request to request exactly Write-Output 'APPROVED_TEST_OK' with reason 'Check the approved terminal path'. Wait for permission and report actual stdout. Do not use any other tools or commands.",
    })
  ).body;
  await page.locator('.terminal-job[data-status="awaiting-approval"]').waitFor({ timeout: 180000 });
  pending = (await api('/terminal')).body.jobs.find((j) => j.status === 'awaiting-approval');
  await page.screenshot({ path: `${resultDir}/terminal-permission.png`, fullPage: true });
  await page.getByRole('button', { name: 'Approve once', exact: true }).click();
  await waitRun(approved.id);
  const job = (await api('/terminal')).body.jobs.find((j) => j.id === pending.id);
  assert.equal(job.status, 'completed', job.error);
  assert.match(job.output, /APPROVED_TEST_OK/);
  assert.notEqual(
    (await api(`/terminal/${pending.id}/decision`, 'POST', { approve: true })).status,
    200,
  );
  await page
    .getByLabel('Terminal command', { exact: true })
    .fill("Write-Output 'Manual terminal works'");
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  await page
    .getByLabel('Command output', { exact: true })
    .filter({ hasText: 'Manual terminal works' })
    .waitFor();
  await page.screenshot({ path: `${resultDir}/terminal-output.png`, fullPage: true });
  await page.getByRole('button', { name: 'Hide terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle terminal panel' }).click();
  await page
    .getByLabel('Command output', { exact: true })
    .filter({ hasText: 'Manual terminal works' })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${resultDir}/terminal-mobile.png`, fullPage: true });
  writeFileSync(
    `${resultDir}/results.json`,
    JSON.stringify(
      {
        passed: true,
        model: 'qwen/qwen3.5-9b',
        artifact: artifact.id,
        checks: [
          'highlighted inline source',
          'copy and download',
          'real JavaScript preview and interaction',
          'automated Chromium preview check',
          'sandbox blocks app/Node/bridge access',
          'paste without execution',
          'bot denial prevents execution',
          'one-time exact approval',
          'approval substitution rejected',
          'manual command output',
          'hide/show persistence',
          'mobile terminal layout',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Workbench verification passed with real Qwen. Evidence: ${resultDir}`);
} finally {
  if (previousClipboard !== undefined)
    await app
      .evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard)
      .catch(() => {});
  await app.close();
}
