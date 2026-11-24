import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const dir = resolve(`test-results/steering/run-${Date.now()}`);
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
  async function api(path) {
    return page.evaluate(async (path) => fetch(`/api${path}`).then((r) => r.json()), path);
  }
  async function until(ready, timeout = 180000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await ready();
      if (value) return value;
      await page.waitForTimeout(100);
    }
    throw Error('Live steering verification timed out');
  }
  await page.getByRole('button', { name: 'Chat with Worker1', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Message Worker1' }),
    send = page.getByRole('button', { name: 'Send message', exact: true });
  await editor.fill(
    'Use no tools. Write 200 detailed numbered paragraphs about organizing a large creative project. Each paragraph should be several sentences, with practical examples.',
  );
  await send.click();
  const initial = await until(async () => {
    const data = await api('/bootstrap');
    return data.runs.find(
      (r) =>
        r.botId === 'worker1' && r.status === 'running' && r.events.some((e) => e.kind === 'route'),
    );
  });
  await page.getByRole('button', { name: 'Stop bot', exact: true }).waitFor();
  await editor.fill(
    'Keep writing the full long list, but change its subject to organizing a garden. Still use no tools.',
  );
  assert.equal(await send.isEnabled(), true);
  await editor.press('Enter');
  await until(async () => (await api(`/runs/${initial.id}`)).steering?.length === 1);
  await editor.fill(
    'Actually stop the long list now. Latest direction: reply with exactly TEAL FOX 42 and nothing else. Use no tools.',
  );
  await send.click();
  await until(async () => (await api(`/runs/${initial.id}`)).steering?.length === 2);
  const completed = await until(async () => {
    const run = await api(`/runs/${initial.id}`);
    return run.status !== 'running' && run;
  });
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.steering.length, 2);
  assert.ok(completed.steering.every((s) => s.appliedWorkIds.length > 0));
  assert.equal(completed.events.filter((e) => e.kind === 'fallback').length, 0);
  await page.locator('.message.assistant').waitFor();
  assert.match(await page.locator('.message.assistant').last().innerText(), /TEAL FOX 42/);
  assert.equal(await page.locator('.message.user').count(), 3);
  assert.equal(await page.locator('.steering-status.applied').count(), 2);
  await page.screenshot({ path: `${dir}/steered-inference.png`, fullPage: true });
  await editor.fill('Use no tools. Reply with exactly NEXT TURN WORKS.');
  await send.click();
  await until(async () => {
    const runs = await api(`/conversations/${initial.conversationId}/runs`);
    return runs.some((r) => r.id !== initial.id && r.status === 'completed');
  });
  await until(async () =>
    /NEXT TURN WORKS/.test(await page.locator('.message.assistant').last().innerText()),
  );
  assert.equal((await api(`/conversations/${initial.conversationId}/runs`)).length, 2);
  // Pending terminal proposals are withdrawn by a correction; a chat message never approves them.
  await editor.fill(
    "Use terminal_request to propose exactly Write-Output 'OLD_PLAN_TEST', reason 'Check the original plan'. Wait for my decision. Do not use any other tools or commands.",
  );
  await send.click();
  await page.locator('.terminal-job[data-status="awaiting-approval"]').waitFor({ timeout: 180000 });
  const job = (await api('/terminal')).jobs.find((j) => j.status === 'awaiting-approval');
  assert.equal(job.startedAt, undefined);
  await editor.fill(
    'Cancel that old command request. Do not run or request any terminal commands. Instead reply with exactly DIRECTION CHANGED.',
  );
  assert.equal(await send.isEnabled(), true);
  await editor.press('Enter');
  await until(
    async () => (await api('/terminal')).jobs.find((j) => j.id === job.id)?.status === 'cancelled',
  );
  const changed = await until(async () => {
    const run = await api(`/runs/${job.runId}`);
    return run.status !== 'running' && run;
  });
  assert.equal(changed.status, 'completed', changed.error);
  assert.equal((await api('/terminal')).jobs.find((j) => j.id === job.id).output, '');
  assert.equal((await api('/terminal')).jobs.find((j) => j.id === job.id).startedAt, undefined);
  await until(async () =>
    /DIRECTION CHANGED/.test(await page.locator('.message.assistant').last().innerText()),
  );
  await page.screenshot({ path: `${dir}/steered-pending-command.png`, fullPage: true });
  await page.getByRole('button', { name: 'Hide terminal', exact: true }).click();
  // A coordinator update reaches its specialist and produces one collaboration transcript.
  await page
    .getByRole('navigation', { name: 'Your bots', exact: true })
    .getByRole('button', { name: 'Open Boss Man', exact: true })
    .click();
  const boss = page.getByRole('textbox', { name: 'Message Boss Man' });
  await boss.fill(
    'Delegate exactly one task to Worker2: write 100 detailed numbered tips for organizing a garden, each a full paragraph. Wait for the real answer. Do not use any tools besides delegation.',
  );
  await send.click();
  await page
    .locator('.collaboration-card[data-to-bot-id="worker2"][data-status="working"]')
    .waitFor({ timeout: 180000 });
  const bossRun = (await api('/bootstrap')).runs.find(
    (r) => r.botId === 'boss-man' && r.status === 'running',
  );
  assert.ok(bossRun);
  await boss.fill(
    'New direction for both you and Worker2: stop the long garden list. Worker2 should return exactly ORANGE LEAF 73. Boss Man should then reply with exactly TEAM UPDATED and nothing else. Do not delegate again and use no other tools.',
  );
  await send.click();
  const team = await until(async () => {
    const run = await api(`/runs/${bossRun.id}`);
    return run.status !== 'running' && run;
  });
  assert.equal(team.status, 'completed', team.error);
  assert.equal(team.steering.length, 1);
  assert.ok(team.steering[0].appliedWorkIds.length >= 2);
  assert.equal(team.events.filter((e) => e.phase === 'delegating').length, 1);
  await until(async () =>
    /TEAM UPDATED/.test(await page.locator('.message.assistant').last().innerText()),
  );
  assert.equal(
    await page.getByRole('region', { name: 'Bot collaboration', exact: true }).count(),
    1,
  );
  await page.screenshot({ path: `${dir}/steered-team.png`, fullPage: true });
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Your bots', exact: true })
    .getByRole('button', { name: 'Open Boss Man', exact: true })
    .click();
  await page.locator('.steering-status.applied').waitFor();
  assert.equal(
    await page.getByRole('region', { name: 'Bot collaboration', exact: true }).count(),
    1,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${dir}/steering-mobile.png`, fullPage: true });
  assert.deepEqual(errors, []);
  writeFileSync(
    `${dir}/results.json`,
    JSON.stringify(
      {
        passed: true,
        model: 'qwen/qwen3.5-9b',
        checks: [
          'send and Enter stay available while working',
          'multiple in-flight updates',
          'latest direction changes actual model reply',
          'updates persist in one conversation',
          'follow-up starts a normal turn after completion',
          'pending terminal approval withdrawn without execution',
          'live direction reaches a real delegated bot and coordinator',
          'one collaboration transcript',
          'uptake survives reload',
          'mobile layout',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Live steering verified with local Qwen. Evidence: ${dir}`);
} finally {
  await app.close();
}
