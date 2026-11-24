import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { AppHelp } from '../apps/server/app-help';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import { Store } from '../apps/server/store';

const dir = resolve(`test-results/app-help/ui-${Date.now()}`),
  dataDir = join(dir, 'host');
mkdirSync(dataDir, { recursive: true });
const help = new AppHelp();
const calls: any[] = [];
const answer =
  'Open Settings & connections > Secrets stay with your computer > Add key or password. Enter the value in that private window and click Save securely or Save and connect. Keep the token out of this chat.';
const model = createServer(async (req, res) => {
  let input = '';
  for await (const chunk of req) input += chunk;
  const body = JSON.parse(input);
  calls.push(body);
  assert.ok(body.messages[0].content.includes(help.get('bot-bots-api-tokens')!.content));
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      usage: { total_tokens: 25 },
    }),
  );
});
await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
const store = new Store(join(dataDir, 'bot-bots.sqlite'));
seed(store, resolve('reference/grok-backup'));
const before = store.all('bots').map((bot) => [bot.id, bot.instructions]);
store.put('providers', {
  ...store.all('providers')[0],
  baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  local: false,
  autoDiscover: false,
});
store.put('models', { ...store.all('models')[0], contextTokens: 131072, toolCalling: 'disabled' });
store.setConfig('settings', { ...store.settings(), localOnly: false });
store.close();
const executablePath = process.env.BOT_BOTS_TEST_EXECUTABLE;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE',
  ),
) as Record<string, string>;
const app = await electron.launch({
  executablePath,
  args: executablePath ? [] : ['.'],
  env: { ...env, BOT_BOTS_DATA_DIR: dataDir, BOT_BOTS_MODE: 'server', BOT_BOTS_DESKTOP_PORT: '0' },
});
try {
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Shared skills', exact: true }).click();
  await page.getByRole('heading', { name: 'Shared skills', exact: true }).waitFor();
  const data = await page.evaluate(() =>
    fetch('/api/bootstrap').then((response) => response.json()),
  );
  assert.equal(data.skills.filter((skill: any) => skill.builtIn).length, 7);
  assert.equal(data.skills.filter((skill: any) => !skill.builtIn).length, 8);
  await page.screenshot({ path: join(dir, 'help-library.png'), fullPage: true });
  await page.getByRole('button', { name: /API tokens and passwords/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Edit playbook', exact: true }).count(), 0);
  await dialog
    .getByText('Included with Bot-Bots. This help is updated with the app.', { exact: true })
    .waitFor();
  await page.screenshot({ path: join(dir, 'api-token-guide.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Your bots', exact: true })
    .getByRole('button', { name: 'Open Calendar', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Message Calendar', exact: true })
    .fill('How do I input my API tokens in Bot-Bots?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText(answer, { exact: true }).waitFor();
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].tools?.length);
  await page.screenshot({ path: join(dir, 'help-in-chat.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const version = await app.evaluate(({ app }) => app.getVersion());
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify(
      {
        version,
        packaged: !!executablePath,
        builtInHelp: 7,
        importedSkills: 8,
        requests: calls.length,
        nativeTools: false,
        checks: [
          'packaged help assets',
          'read-only help UI',
          'separate imported skills',
          'automatic token guide injection',
          'plain-text model support',
          'no UI errors',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
}
const reopened = new Store(join(dataDir, 'bot-bots.sqlite'));
try {
  for (const [id, instructions] of before)
    assert.equal(reopened.get('bots', id)!.instructions, instructions);
  assert.equal(reopened.all('skills').length, 8);
} finally {
  reopened.close();
}
console.log(`App help verified: ${dir}`);
