import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const dir = resolve(`test-results/workshop/run-${Date.now()}`);
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
let client;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
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
      await page.waitForTimeout(100);
    }
    throw Error('Workshop verification timed out');
  }
  async function waitRun(id) {
    return until(async () => {
      const run = await api(`/runs/${id}`);
      return run.status !== 'running' && run;
    });
  }
  // Render the repository's SVG using Chromium, including the actual Windows app icon.
  const icons = await app.evaluate(async ({ BrowserWindow }, url) => {
    const win = new BrowserWindow({
      show: false,
      width: 512,
      height: 512,
      transparent: true,
      webPreferences: { sandbox: true, backgroundThrottling: false },
    });
    try {
      await win.loadURL(`${url}/logo.svg`);
      await new Promise((r) => setTimeout(r, 300));
      const image = await win.webContents.capturePage(undefined, { stayHidden: true });
      return {
        png: image.resize({ width: 512, height: 512 }).toPNG().toString('base64'),
        small: image.resize({ width: 256, height: 256 }).toPNG().toString('base64'),
      };
    } finally {
      win.destroy();
    }
  }, new URL(page.url()).origin);
  if (!process.env.BOT_BOTS_TEST_EXECUTABLE) {
    mkdirSync('resources', { recursive: true });
    writeFileSync('apps/web/public/icon.png', Buffer.from(icons.png, 'base64'));
    const png = Buffer.from(icons.small, 'base64'),
      header = Buffer.alloc(22);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    header.writeUInt16LE(1, 10);
    header.writeUInt16LE(32, 12);
    header.writeUInt32LE(png.length, 14);
    header.writeUInt32LE(22, 18);
    writeFileSync('resources/bot-bots.ico', Buffer.concat([header, png]));
  }
  assert.equal((await api('/bootstrap')).categories.length, 4);
  assert.equal(await page.locator('.roster-category').count(), 4);
  await page.getByRole('button', { name: 'Edit Worker3', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal
    .getByRole('textbox', { name: 'New category name', exact: true })
    .fill('Worker prototypes');
  await modal.getByRole('button', { name: 'Add category', exact: true }).click();
  await until(async () => (await api('/categories')).some((c) => c.name === 'Worker prototypes'));
  await modal.getByLabel('Worker prototype', { exact: true }).check();
  await modal.getByRole('button', { name: 'Activity', exact: true }).click();
  await modal
    .getByRole('button', { name: 'Suggest from instructions & experience', exact: true })
    .click();
  await modal.getByRole('button', { name: 'Use these suggestions', exact: true }).click();
  const general = modal.getByRole('textbox', { name: 'General phrases', exact: false });
  await general.fill('Rolling up sleeves');
  await general.press('Enter');
  await general.pressSequentially('Cracking knuckles');
  assert.equal(await general.inputValue(), 'Rolling up sleeves\nCracking knuckles');
  await modal.getByRole('button', { name: 'Save your bot', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  const prototype = (await api('/bootstrap')).bots.find((b) => b.id === 'worker3');
  assert.equal(prototype.isPrototype, true);
  assert.deepEqual(prototype.processingPhrases.general, [
    'Rolling up sleeves',
    'Cracking knuckles',
  ]);
  await page.getByRole('button', { name: 'Chat with Worker1', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle bot panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Worker1 panel' });
  await panel.waitFor();
  await panel.getByRole('button', { name: 'New', exact: true }).click();
  const routine = page.getByRole('dialog');
  await routine
    .getByRole('textbox', { name: 'Routine name', exact: true })
    .fill('Morning workshop check');
  assert.equal(
    await routine.getByRole('combobox', { name: 'Which bot?', exact: true }).inputValue(),
    'worker1',
  );
  await routine
    .getByRole('textbox', { name: 'What should happen?', exact: true })
    .fill('Use no tools. Reply exactly ROUTINE OK.');
  await routine.getByRole('button', { name: 'Save routine', exact: true }).click();
  await routine.waitFor({ state: 'hidden' });
  await panel.getByText('Morning workshop check', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Run now', exact: true }).click();
  const routineRun = await until(async () =>
    (await api('/bootstrap')).runs.find((r) => r.prompt.includes('Reply exactly ROUTINE OK.')),
  );
  assert.equal((await waitRun(routineRun.id)).status, 'completed');
  await panel.getByRole('button', { name: 'History', exact: true }).click();
  await panel
    .getByText('Use no tools. Reply exactly ROUTINE OK.', { exact: false })
    .first()
    .waitFor();
  await page.screenshot({ path: `${dir}/bot-history-and-routines.png`, fullPage: true });
  console.log(
    'Bot-specific routines, phrase suggestions/editing, categories and real Qwen history passed.',
  );
  await page
    .getByRole('navigation', { name: 'Your bots', exact: true })
    .getByRole('button', { name: 'Open Boss Man', exact: true })
    .click();
  await page.getByRole('button', { name: 'Close bot panel', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Message Boss Man' });
  await editor.fill(
    'Use progress_update once to set percent 10, label "Gathering the crew", milestones [{label:"Brief",percent:10},{label:"Findings",percent:70},{label:"Wrap-up",percent:100}]. Then call delegate_workers EXACTLY ONCE with prototypeId "worker3" and these 3 tasks: "ALPHA: use memory_save once to remember the world fact that 2 + 3 = 5, then return ALPHA 5; use no other tools", "BETA: return exactly BETA 7 without tools", "GAMMA: return exactly GAMMA 9 without tools". Wait for their actual results, then summarize all three in one short sentence. Do not delegate using another tool or prototype.',
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const teamRun = await until(async () =>
    (await api('/bootstrap')).runs.find((r) => r.botId === 'boss-man' && r.status === 'running'),
  );
  await until(
    async () =>
      (await api('/bootstrap')).bots.filter((b) => b.cloneStatus === 'active').length === 3,
  );
  await until(async () => (await page.locator('.bot-roster-row.is-clone').count()) === 3);
  await page.locator('.bot-roster-row.is-clone').first().scrollIntoViewIfNeeded();
  await page.getByRole('region', { name: 'Team progress', exact: true }).waitFor();
  await page.screenshot({ path: `${dir}/workers-on-the-road.png`, fullPage: true });
  const finished = await waitRun(teamRun.id);
  writeFileSync(`${dir}/qwen-worker-run.json`, JSON.stringify(finished, null, 2));
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.events.filter((e) => e.kind === 'fallback').length, 0);
  assert.equal(finished.work.filter((w) => w.handoffId).length, 3);
  await until(async () => (await page.locator('.bot-roster-row.is-clone').count()) === 0);
  const history = await api('/bots/worker3/history');
  assert.equal(history.length, 3);
  assert.ok(history.every((t) => t.status === 'completed' && t.result));
  assert.ok(history.some((t) => t.memoryIds.length > 0));
  assert.ok(finished.work.every((w) => w.status === 'completed'));
  await page.screenshot({ path: `${dir}/workers-finished.png`, fullPage: true });
  console.log(
    'Real Qwen collaboration passed: 3 temporary workers, durable results/learning, milestones, retirement.',
  );
  await page
    .getByRole('navigation', { name: 'Your bots', exact: true })
    .getByRole('button', { name: 'Open Worker3', exact: true })
    .click();
  await page.getByRole('button', { name: 'Toggle bot panel', exact: true }).click();
  const protoPanel = page.getByRole('complementary', { name: 'Worker3 panel' });
  await protoPanel.getByRole('button', { name: 'History', exact: true }).click();
  assert.equal(await protoPanel.locator('.task-history-entry').count(), 3);
  await protoPanel.getByRole('button', { name: 'Memory', exact: true }).click();
  await protoPanel.getByRole('slider').fill('75');
  await protoPanel.getByRole('button', { name: 'Preview compaction', exact: true }).click();
  await protoPanel.getByText(/less active detail/).waitFor();
  await page.screenshot({ path: `${dir}/memory-controls.png`, fullPage: true });
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('button', { name: 'Add Google plugin', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Enable gmail.search', exact: true }).check();
  const row = page
    .locator('tr')
    .filter({ has: page.getByRole('checkbox', { name: 'Enable gmail.search', exact: true }) });
  await row.locator('summary').click();
  await row.getByLabel('All bots', { exact: true }).check();
  await row.locator('summary').click();
  await page.getByRole('button', { name: 'Save permissions', exact: true }).click();
  await until(
    async () => (await api('/plugins/google')).config.permissions['gmail.search']?.enabled,
  );
  assert.equal((await api('/plugins/google')).connected, false);
  await page.screenshot({ path: `${dir}/google-permissions.png`, fullPage: true });
  await page.getByRole('button', { name: 'Settings & connections', exact: true }).click();
  await page.getByRole('textbox', { name: 'Owner name', exact: true }).fill('qa-owner');
  await page
    .getByRole('textbox', { name: 'Owner password', exact: true })
    .fill('Only for this isolated QA profile 2026');
  await page.getByRole('button', { name: 'Create owner login', exact: true }).click();
  await until(async () => (await api('/access')).ownerConfigured);
  const pair = await api('/access/pairing', 'POST', { role: 'viewer' });
  await api('/access/public-url', 'PUT', { url: 'https://qa-bots.example.test' });
  const clientDir = `${dir}/client`,
    serverUrl = new URL(page.url()).origin;
  client = await electron.launch({
    args: process.env.BOT_BOTS_TEST_EXECUTABLE ? [] : ['.'],
    executablePath: process.env.BOT_BOTS_TEST_EXECUTABLE,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      BOT_BOTS_DATA_DIR: clientDir,
      BOT_BOTS_MODE: 'client',
      BOT_BOTS_SERVER_URL: serverUrl,
    },
    timeout: 30000,
  });
  const phone = await client.firstWindow();
  await phone.getByRole('heading', { name: 'Back with your little team.' }).waitFor();
  assert.equal(await phone.evaluate(() => window.botBotsDesktop.mode), 'client');
  assert.equal(existsSync(`${clientDir}/bot-bots.sqlite`), false);
  await phone.getByRole('button', { name: 'Pair device', exact: true }).click();
  await phone.getByRole('textbox', { name: 'Six-digit pairing code', exact: true }).fill(pair.code);
  await phone.getByRole('button', { name: 'Pair this device', exact: true }).click();
  await phone.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
  assert.equal(
    await phone.getByRole('button', { name: 'Create a bot', exact: true }).isDisabled(),
    true,
  );
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.screenshot({ path: `${dir}/phone-client.png`, fullPage: true });
  assert.equal(
    await phone.evaluate(async () => {
      const r = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'worker1', prompt: 'Viewer must not submit this' }),
      });
      return r.status;
    }),
    403,
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    `${dir}/verification.json`,
    JSON.stringify(
      {
        version: await api('/health'),
        features: [
          'per-bot routines',
          'phrase suggestions and editing',
          'categories',
          '3 real Qwen worker clones',
          'durable results and learning',
          'milestone progress',
          'memory preview',
          'Google permissions setup',
          'client mode without host',
          'one-use viewer pairing',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`Workshop and client mode verified. Results: ${dir}`);
} finally {
  if (client) await client.close();
  await app.close();
}
