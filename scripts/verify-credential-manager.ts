import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import { OsSecrets } from '../apps/server/host-secrets';
import { Store } from '../apps/server/store';

const dir = resolve(`test-results/credential-manager/ui-${Date.now()}`),
  dataDir = join(dir, 'host'),
  external = join(dir, 'external');
mkdirSync(external, { recursive: true, mode: 0o700 });
writeFileSync(
  join(external, 'permissions.json'),
  JSON.stringify({
    version: 1,
    enabled: false,
    storage: 'os',
    allowBotTerminal: false,
    bindings: [],
    operations: [],
  }),
  { mode: 0o600 },
);
const store = new Store(join(dataDir, 'bot-bots.sqlite'));
seed(store, resolve('reference/grok-backup'));
for (const provider of store.all('providers'))
  store.put('providers', { ...provider, enabled: false, autoDiscover: false });
store.close();
const backend = new OsSecrets();
const key = `TEST_ONLY_GUI_KEY_${Date.now()}`,
  replacement = `${key}_ROTATED`,
  password = 'TEST ONLY pässword 43';
const executablePath = process.env.BOT_BOTS_TEST_EXECUTABLE;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) => value !== undefined && name !== 'ELECTRON_RUN_AS_NODE',
  ),
) as Record<string, string>;
const app = await electron.launch({
  executablePath,
  args: executablePath ? [] : ['.'],
  env: {
    ...env,
    BOT_BOTS_DATA_DIR: dataDir,
    BOT_BOTS_CREDENTIALS_DIR: external,
    BOT_BOTS_MODE: 'server',
    BOT_BOTS_DESKTOP_PORT: '0',
  },
});
try {
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Settings & connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add key or password', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await page.getByRole('textbox', { name: 'Secret name', exact: true }).fill('Ephemeral model key');
  await page.getByLabel('Secret value', { exact: true }).fill(key);
  assert.equal(
    await page.getByLabel('Secret value', { exact: true }).getAttribute('type'),
    'password',
  );
  await page.getByRole('combobox', { name: 'Credential use', exact: true }).selectOption('model');
  await page
    .getByRole('combobox', { name: 'Model credential provider', exact: true })
    .selectOption('openai');
  await page.getByRole('button', { name: 'Save and connect', exact: true }).click();
  const keyCard = page
    .locator('.secret-card')
    .filter({ has: page.getByRole('heading', { name: 'Ephemeral model key', exact: true }) });
  await keyCard.waitFor();
  const keyId = (await keyCard.getAttribute('data-secret-id'))!;
  assert.equal(backend.get(keyId), key);
  assert.ok(!(await page.locator('body').innerText()).includes(key));
  const response = await page.evaluate(async () => ({
    exported: await fetch('/api/export').then((r) => r.json()),
    state: await fetch('/api/credentials/manager').then((r) => r.json()),
    bootstrap: await fetch('/api/bootstrap').then((r) => r.json()),
  }));
  assert.ok(!JSON.stringify(response).includes(key));
  const binding = response.state.connections.find(
    (connection: any) => connection.secretId === keyId,
  );
  assert.ok(
    response.bootstrap.providers.some(
      (provider: any) => provider.name === 'OpenAI' && provider.credentialId === binding.id,
    ),
  );
  for (const file of ['permissions.json', 'manager.json'])
    assert.ok(!readFileSync(join(external, file), 'utf8').includes(key));
  await keyCard.getByRole('button', { name: 'Update or connect', exact: true }).click();
  assert.equal(await page.getByLabel('Secret value', { exact: true }).inputValue(), '');
  await page.getByLabel('Secret value', { exact: true }).fill(replacement);
  await page.getByRole('button', { name: 'Save securely', exact: true }).click();
  await keyCard.waitFor();
  assert.equal(backend.get(keyId), replacement);
  await keyCard.getByRole('button', { name: 'Update or connect', exact: true }).click();
  await page.getByRole('combobox', { name: 'Credential use', exact: true }).selectOption('alert');
  await page
    .getByRole('textbox', { name: 'Alert endpoint', exact: true })
    .fill('https://alerts.test/deliver');
  await page.getByRole('button', { name: 'Save and connect', exact: true }).click();
  await keyCard.waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('input')].some(
      (input) => input.value === 'https://alerts.test/deliver',
    ),
  );
  await dialog.getByRole('button', { name: 'Add key or password', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Secret name', exact: true })
    .fill('Ephemeral service password');
  await page.getByRole('combobox', { name: 'Secret type', exact: true }).selectOption('password');
  await page.getByLabel('Secret value', { exact: true }).fill(password);
  await page
    .getByRole('combobox', { name: 'Credential use', exact: true })
    .selectOption('operation');
  await page
    .getByRole('textbox', { name: 'Service endpoint', exact: true })
    .fill('https://service.test/account');
  await page.getByRole('textbox', { name: 'Service username', exact: true }).fill('test-account');
  await page.getByRole('checkbox', { name: 'Worker1', exact: true }).check();
  await page.getByRole('button', { name: 'Save and connect', exact: true }).click();
  const passwordCard = page.locator('.secret-card').filter({
    has: page.getByRole('heading', { name: 'Ephemeral service password', exact: true }),
  });
  await passwordCard.waitFor();
  const passwordId = (await passwordCard.getAttribute('data-secret-id'))!;
  assert.equal(backend.get(passwordId), password);
  const policy = JSON.parse(readFileSync(join(external, 'permissions.json'), 'utf8'));
  assert.deepEqual(policy.operations[0].botIds, ['worker1']);
  assert.equal(policy.operations[0].auth.type, 'basic');
  assert.equal(policy.allowBotTerminal, false);
  const body = await page.locator('body').innerText();
  assert.ok(!body.includes(password) && !body.includes(replacement));
  await page.screenshot({ path: join(dir, 'keys-and-passwords.png'), fullPage: true });
  await passwordCard.getByRole('button', { name: 'Revoke access', exact: true }).click();
  await passwordCard.locator('.secret-connection').waitFor({ state: 'detached' });
  assert.equal(backend.get(passwordId), password);
  await passwordCard
    .getByRole('button', { name: 'Remove Ephemeral service password', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Remove secret', exact: true }).click();
  await passwordCard.waitFor({ state: 'detached' });
  assert.equal(backend.get(passwordId), null);
  await keyCard.getByRole('button', { name: 'Remove Ephemeral model key', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove secret', exact: true }).click();
  await keyCard.waitFor({ state: 'detached' });
  assert.equal(backend.get(keyId), null);
  await dialog.getByRole('button', { name: 'Add key or password', exact: true }).click();
  await page.getByLabel('Secret value', { exact: true }).fill('TEST_ONLY_CANCELLED_VALUE');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Add key or password', exact: true }).click();
  assert.equal(await page.getByLabel('Secret value', { exact: true }).inputValue(), '');
  await page.screenshot({ path: join(dir, 'add-secret-window.png'), fullPage: true });
  assert.deepEqual(errors, []);
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify(
      {
        packaged: !!executablePath,
        version: await app.evaluate(({ app }) => app.getVersion()),
        backend: backend.kind,
        checks: [
          'native OS key storage from owner UI',
          'masked entry',
          'automatic model binding',
          'replacement without readback',
          'password with Unicode and spaces',
          'bot-scoped service grant',
          'revoke without deleting secret',
          'delete revokes and removes OS values',
          'cancel clears input',
          'no values in metadata, export, DOM text or application errors',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  // Cleanup is restricted to this isolated test's own generated aliases.
  if (existsSync(join(external, 'manager.json')))
    for (const secret of JSON.parse(readFileSync(join(external, 'manager.json'), 'utf8')).secrets)
      if (secret.name.startsWith('Ephemeral ') && /^secret-[a-f\d-]+$/.test(secret.id))
        backend.delete(secret.id);
}
console.log(`Native credential window verified: ${dir}`);
