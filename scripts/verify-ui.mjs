import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('test-results/ui', { recursive: true });
const errors = [];
const app = await electron.launch({
  args: process.env.BOT_BOTS_TEST_EXECUTABLE ? [] : ['.'],
  executablePath: process.env.BOT_BOTS_TEST_EXECUTABLE,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    BOT_BOTS_DATA_DIR: resolve(`test-results/ui/team-${Date.now()}`),
    BOT_BOTS_DESKTOP_PORT: '0',
  },
  timeout: 30000,
});
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    'rgb(20, 26, 22)',
  );
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('.bot-card').count(), 15);
  const roster = page.getByRole('navigation', { name: 'Your bots', exact: true });
  assert.equal(await roster.getByRole('button').count(), 15);
  assert.equal(await roster.isVisible(), true);
  assert.equal(
    await roster.evaluate((list) => {
      const bounds = list.getBoundingClientRect();
      return [...list.querySelectorAll('.bot-roster-row')].every((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
      });
    }),
    true,
  );
  await page.screenshot({ path: 'test-results/ui/team.png', fullPage: true });
  await page.getByRole('button', { name: 'Settings & connections', exact: true }).click();
  assert.equal(
    await page.getByRole('radio', { name: 'Dark theme', exact: true }).isChecked(),
    true,
  );
  await page.getByRole('radio', { name: 'Light theme', exact: true }).check();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.screenshot({ path: 'test-results/ui/settings-light.png', fullPage: true });
  await page.reload();
  await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    'rgb(248, 247, 243)',
  );
  await page.getByRole('button', { name: 'Settings & connections', exact: true }).click();
  assert.equal(
    await page.getByRole('radio', { name: 'Light theme', exact: true }).isChecked(),
    true,
  );
  await page.getByRole('radio', { name: 'Dark theme', exact: true }).check();
  await page.screenshot({ path: 'test-results/ui/settings-dark.png', fullPage: true });
  await page.reload();
  await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.getByRole('button', { name: 'Edit Boss Man', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.screenshot({ path: 'test-results/ui/avatar-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'cat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Body color hex' }).fill('#78a0b8');
  await page.getByRole('button', { name: 'Save your bot', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
  const b = await page.evaluate(async () => {
    const r = await fetch('/api/bootstrap');
    return (await r.json()).bots.find((b) => b.id === 'boss-man');
  });
  assert.equal(b.avatar.shape, 'cat');
  assert.equal(b.avatar.color, '#78a0b8');
  await page.getByRole('button', { name: 'Model workshop', exact: true }).click();
  await page.getByRole('heading', { name: 'Model workshop', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Discover models', exact: true }).click();
  await page.getByText('Model list refreshed', { exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'qwen/qwen3.5-9b', exact: true }).count());
  const models = await page.evaluate(async () => {
    const r = await fetch('/api/bootstrap');
    return (await r.json()).models.filter((m) => m.enabled).map((m) => m.name);
  });
  assert.deepEqual(models, ['qwen/qwen3.5-9b']);
  await page.screenshot({ path: 'test-results/ui/models.png', fullPage: true });
  // Observe a real delegated task from an unrelated view, without a chat stream open.
  const handoff = await page.evaluate(async () => {
    const response = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botId: 'boss-man',
        prompt:
          'Use delegate exactly twice: ask Worker2 to write ten short numbered tips for organizing a writing project; then ask Worker3 for three short mistakes to avoid in that project. Tell each worker to use no other tools, ask no questions, and return its actual answer. Return both answers here.',
      }),
    });
    if (!response.ok) throw Error(await response.text());
    return response.json();
  });
  await roster
    .locator('[data-bot-id="boss-man"][data-work-phase="waiting"]')
    .waitFor({ timeout: 180000 });
  await roster.locator('[data-bot-id="worker2"].working').waitFor();
  assert.equal(await roster.locator('[data-bot-id="worker2"] .bot-working-spinner').count(), 1);
  assert.equal(await roster.locator('[data-bot-id="worker2"] .avatar.is-busy').count(), 1);
  await page.screenshot({ path: 'test-results/ui/sidebar-working.png', fullPage: true });
  await roster.getByRole('button', { name: 'Open Boss Man', exact: true }).click();
  const collaboration = page.getByRole('region', { name: 'Bot collaboration', exact: true });
  await collaboration.waitFor();
  assert.equal(await collaboration.locator('[data-participant-id="boss-man"] svg').count(), 1);
  assert.equal(await collaboration.locator('[data-participant-id="worker2"] svg').count(), 1);
  await collaboration
    .locator('.collaboration-card[data-to-bot-id="worker2"][data-status="working"]')
    .waitFor();
  assert.equal(await page.locator('.thinking').count(), 0);
  await page.screenshot({ path: 'test-results/ui/collaboration-live.png', fullPage: true });
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  assert.equal(await roster.isVisible(), true);
  await roster.locator('[data-bot-id="boss-man"]:not(.working)').waitFor({ timeout: 180000 });
  await roster.locator('[data-bot-id="worker2"]:not(.working)').waitFor();
  const completed = await page.evaluate(
    async (id) => fetch(`/api/runs/${id}`).then((r) => r.json()),
    handoff.id,
  );
  assert.equal(completed.status, 'completed');
  await roster.getByRole('button', { name: 'Open Boss Man', exact: true }).click();
  await page
    .locator('.message.user')
    .filter({ hasText: 'write ten short numbered tips' })
    .waitFor();
  await page.locator('.message.assistant').waitFor();
  assert.equal(await collaboration.locator('.collaboration-card').count(), 2);
  assert.equal(await collaboration.locator('[data-participant-id]').count(), 3);
  assert.equal(
    await collaboration.locator('.collaboration-card[data-status="completed"]').count(),
    2,
  );
  const workerReply = collaboration.locator('.collaboration-card[data-to-bot-id="worker2"]');
  await workerReply.getByRole('button', { name: 'Rate 4 out of 5' }).click();
  await workerReply.locator('button[aria-label="Rate 4 out of 5"][aria-pressed="true"]').waitFor();
  await workerReply.locator('.feedback-details summary').click();
  await workerReply.getByLabel('Response timing').selectOption('worth-the-wait');
  await workerReply
    .getByLabel('Feedback note')
    .fill('I like Worker2 for writing. Taking time is fine.');
  await workerReply.getByRole('button', { name: 'Save feedback', exact: true }).click();
  await workerReply.getByText('Timing & feedback · Note saved', { exact: true }).waitFor();
  await workerReply.locator('.feedback-details summary').click();
  await workerReply.locator('.collaboration-details summary').click();
  assert.ok(
    (await workerReply.locator('.collaboration-answer-full').innerText()).trim().length > 60,
  );
  assert.ok((await workerReply.locator('.collaboration-work-log li').count()) > 0);
  await workerReply.locator('.collaboration-details summary').click();
  await collaboration.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/ui/collaboration-complete.png', fullPage: true });
  const desktopViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector('.sidebar').getBoundingClientRect().width <= 65,
  );
  await collaboration.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'test-results/ui/collaboration-mobile.png', fullPage: true });
  await page.setViewportSize(desktopViewport);
  // Saved collaboration must remain available even when the recent-run bootstrap omits it.
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.runs = [];
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await roster.getByRole('button', { name: 'Open Boss Man', exact: true }).click();
  await collaboration
    .locator('.collaboration-card[data-to-bot-id="worker3"][data-status="completed"]')
    .waitFor();
  assert.equal(await collaboration.locator('[data-participant-id]').count(), 3);
  assert.equal(
    await collaboration
      .locator('[data-to-bot-id="worker2"]')
      .getByRole('button', { name: 'Rate 4 out of 5' })
      .getAttribute('aria-pressed'),
    'true',
  );
  await page.unroute('**/api/bootstrap');
  await page.getByRole('button', { name: 'Your team', exact: false }).first().click();
  await page.getByRole('button', { name: 'Chat with Worker1', exact: true }).click();
  assert.equal(await page.getByLabel('Job urgency', { exact: true }).inputValue(), 'relaxed');
  await page.locator('.conversation-options > summary').click();
  await page.getByLabel('Job urgency', { exact: true }).selectOption('soon');
  await page.getByLabel('Job importance', { exact: true }).selectOption('high');
  await page.getByLabel('Job task category', { exact: true }).selectOption('writing');
  await page
    .getByRole('textbox', { name: 'Message Worker1' })
    .fill('Use no tools. Reply with exactly: Desktop chat works.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.locator('.message.assistant').waitFor({ timeout: 180000 });
  assert.match(
    await page.locator('.message.assistant .message-content').innerText(),
    /Desktop chat works/i,
  );
  await page.screenshot({ path: 'test-results/ui/chat.png', fullPage: true });
  const workerFeedback = page.getByRole('region', { name: 'Feedback for Worker1', exact: true });
  await workerFeedback.getByText('Reply details', { exact: true }).click();
  await workerFeedback.getByText('soon', { exact: true }).waitFor();
  await workerFeedback.getByText('High importance', { exact: true }).waitFor();
  assert.match(await workerFeedback.innerText(), /\d[\d,]* tokens/);
  assert.match(await workerFeedback.innerText(), /elapsed/);
  assert.equal(await page.getByLabel('Job urgency', { exact: true }).inputValue(), 'relaxed');
  await page.getByRole('button', { name: 'Rate 5 out of 5' }).click();
  await workerFeedback.locator('.feedback-details summary').click();
  await workerFeedback.getByLabel('Response timing').selectOption('worth-the-wait');
  await workerFeedback.getByLabel('Feedback note').fill('Excellent local draft. No rush.');
  await workerFeedback.getByRole('button', { name: 'Save feedback', exact: true }).click();
  await workerFeedback.getByText('Timing & feedback · Note saved', { exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/ui/human-feedback.png', fullPage: true });
  await workerFeedback.locator('.feedback-details summary').click();
  // Mentions use real bot identities, not decorated plaintext.
  const editor = page.getByRole('textbox', { name: 'Message Worker1' });
  await editor.fill('Use no tools. Reply with exactly: Mention received. Ask ');
  await editor.press('End');
  await editor.pressSequentially('@rese');
  await page.getByRole('listbox', { name: 'Mention a bot' }).waitFor();
  await editor.press('Enter');
  const chip = editor.locator('[data-bot-id="research"]');
  await chip.waitFor();
  assert.equal(await chip.locator('svg').count(), 1);
  assert.equal(
    await chip.evaluate((node) => node.style.getPropertyValue('--mention-color')),
    '#da7bdf',
  );
  assert.equal(await page.getByRole('listbox', { name: 'Mention a bot' }).count(), 0);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const sentMention = page
    .locator('.message.user')
    .last()
    .getByRole('button', { name: "Open Research's space", exact: true });
  await sentMention.waitFor();
  await page.locator('.message.assistant').nth(1).waitFor({ timeout: 180000 });
  const stored = await page.evaluate(async () => {
    const conversations = await fetch('/api/conversations?botId=worker1').then((r) => r.json());
    const messages = await fetch(`/api/conversations/${conversations[0].id}/messages`).then((r) =>
      r.json(),
    );
    return messages.filter((m) => m.role === 'user').at(-1).content;
  });
  assert.match(stored, /\[@Research\]\(#bot\/research\)/);
  await page.screenshot({ path: 'test-results/ui/mentions.png', fullPage: true });
  await sentMention.click();
  await page
    .locator('.chat-top h3')
    .filter({ hasText: /^Research$/ })
    .waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Choose bot' }).inputValue(), 'research');
  await page.getByRole('button', { name: 'Model workshop', exact: true }).click();
  const experience = page.getByRole('region', { name: 'Bot and model experience', exact: true });
  await experience.getByLabel('Experience bot', { exact: true }).selectOption('worker1');
  await experience.getByLabel('Experience task', { exact: true }).selectOption('writing');
  await experience.getByText('★ 5.0 / 5', { exact: true }).waitFor();
  await experience.locator('td').filter({ hasText: '1 worth the wait' }).waitFor();
  await page.screenshot({ path: 'test-results/ui/model-experience.png', fullPage: true });
  const report = await page.evaluate(async () => {
    const response = await fetch('/api/experience/report');
    return { status: response.status, text: await response.text() };
  });
  assert.equal(report.status, 200);
  assert.match(report.text, /Excellent local draft/);
  assert.match(report.text, /I like Worker2 for writing/);
  await page.getByRole('button', { name: 'Routines', exact: true }).click();
  assert.equal(await page.locator('.routine-card').count(), 12);
  assert.equal(await page.locator('.routine-card input:checked').count(), 0);
  for (const name of ['Memory', 'Shared skills', 'Pages', 'Activity', 'Settings & connections']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.waitForTimeout(150);
    assert.ok(await page.locator('main h1').innerText());
    assert.equal(await roster.isVisible(), true);
    assert.equal(await roster.getByRole('button').count(), 15);
  }
  // Responsive UI verification in the same production renderer.
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await roster.isVisible(), true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Your team', exact: false }).first().click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/ui/mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  writeFileSync(
    'test-results/ui/results.json',
    JSON.stringify(
      {
        passed: true,
        checks: [
          '15 restored bots',
          'persistent bot roster across every view and on mobile',
          'real coordinator and delegated-worker live activity',
          'live collaboration avatars and handoff cards in chat',
          'collaboration fits a phone-width chat',
          'two real Qwen worker handoffs with delivered answers and work logs',
          'collaboration history survives reload without recent-run bootstrap data',
          'working avatar and spinning loader',
          'activity clears without opening the running chat',
          'roster returns to the bot’s latest conversation',
          'dark by default even with a light OS preference',
          'immediate light/dark theme switching',
          'saved theme applied across reloads',
          'avatar persistence',
          'model discovery without auto-enabling',
          'real Qwen desktop chat',
          'reply rating',
          'separate human ratings for coordinator and delegated bot work',
          'human stars, timing preference and notes persist through reload',
          'explicit urgency, importance and task category with relaxed defaults',
          'per-bot elapsed time, model time and real provider token counts',
          'model experience table and generated Markdown lookup report',
          'mention suggestions and keyboard selection',
          'avatar and color mention chips',
          'persistent bot mention IDs',
          'sent mention opens the bot space',
          'paused restored schedules',
          'all navigation views',
          '390px responsive layout',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'Electron UI verification passed, including real Qwen chat. Screenshots: test-results/ui',
  );
} finally {
  await app.close();
}
