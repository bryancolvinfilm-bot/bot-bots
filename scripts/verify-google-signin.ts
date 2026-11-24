import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createApp } from '../apps/server/app';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import { Store } from '../apps/server/store';

const dir = resolve(`test-results/google-signin/ui-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const store = new Store(join(dir, 'host/team.sqlite'));
seed(store, resolve('reference/grok-backup'));
for (const p of store.all('providers')) store.put('providers', { ...p, autoDiscover: false });
const codes = new Map<string, { challenge: string; scopes: string; redirect: string }>();
let granted = 'openid email',
  exchanges = 0;
const provider = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1');
  if (url.pathname === '/authorize') {
    res.setHeader('Content-Type', 'text/html');
    const target = `/approve?${url.searchParams}`
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;');
    res.end(
      `<!doctype html><title>Mock Google sign-in</title><h1>Choose your test account</h1><a href="${target}">Continue as demo@example.com</a>`,
    );
  } else if (url.pathname === '/approve') {
    const code = randomUUID();
    codes.set(code, {
      challenge: url.searchParams.get('code_challenge')!,
      scopes: url.searchParams.get('scope')!,
      redirect: url.searchParams.get('redirect_uri')!,
    });
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({
      state: url.searchParams.get('state')!,
      code,
    }).toString();
    res.writeHead(302, { Location: callback.toString() });
    res.end();
  } else if (url.pathname === '/token') {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = new URLSearchParams(text),
      pending = codes.get(body.get('code')!);
    if (
      !pending ||
      createHash('sha256')
        .update(body.get('code_verifier') ?? '')
        .digest('base64url') !== pending.challenge ||
      body.get('redirect_uri') !== pending.redirect
    ) {
      res.writeHead(400);
      res.end('{}');
      return;
    }
    codes.delete(body.get('code')!);
    granted = pending.scopes;
    exchanges++;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        access_token: 'MOCK_ACCESS_PRIVATE',
        refresh_token: 'MOCK_REFRESH_PRIVATE',
        scope: granted,
        expires_in: 3600,
      }),
    );
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        url.pathname === '/userinfo'
          ? { sub: 'demo-account', email: 'demo@example.com', email_verified: true }
          : {},
      ),
    );
  }
});
await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
const host = createApp(store, join(dir, 'host'), resolve('dist/web'));
(host.google as any).urls = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: `${providerOrigin}/token`,
  revoke: `${providerOrigin}/revoke`,
  api: () => providerOrigin,
};
const server = host.app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
    BOT_BOTS_SERVER_URL: origin,
  },
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
  await app.evaluate(({ shell }) => {
    (globalThis as any).googleTestURLs = [];
    shell.openExternal = async (url: string) => {
      (globalThis as any).googleTestURLs.push(url);
    };
  });
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in with Google', exact: true }).waitFor();
  const advanced = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'Advanced · app owner' }) })
    .first();
  assert.equal(await advanced.getAttribute('open'), null);
  assert.equal(await page.getByLabel('Google OAuth client ID', { exact: true }).isVisible(), false);
  await page.screenshot({ path: `${dir}/sign-in-default.png`, fullPage: true });
  await page.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
  await advanced.getByLabel('Import Google client file (.json)', { exact: true }).setInputFiles({
    name: 'google-client.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        installed: {
          client_id: 'test.apps.googleusercontent.com',
          client_secret: 'MOCK_CLIENT_PRIVATE',
        },
      }),
    ),
  });
  await page.getByText('Google app setup saved.', { exact: false }).waitFor();
  await advanced.locator(':scope > summary').click();
  async function until<T>(fn: () => Promise<T | undefined | false>, timeout = 15000): Promise<T> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await fn();
      if (value) return value;
      await page.waitForTimeout(100);
    }
    throw Error('Google UI verification timed out');
  }
  async function authorize(index: number, button: string) {
    await page.getByRole('button', { name: button, exact: true }).click();
    const url = await until(
      async () =>
        (await app.evaluate(() => (globalThis as any).googleTestURLs))[index] as string | undefined,
    );
    assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
    await page.getByText('Waiting for Google…', { exact: true }).waitFor();
    const expectedScope = index === 0 ? 'openid email' : 'gmail.readonly';
    assert.ok(new URL(url).searchParams.get('scope')!.includes(expectedScope));
    await page.screenshot({ path: `${dir}/browser-wait-${index}.png`, fullPage: true });
    const browserEvent = app.waitForEvent('window');
    await app.evaluate(
      async ({ BrowserWindow }, url) => {
        const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
        await win.loadURL(url);
      },
      `${providerOrigin}/authorize?${new URL(url).searchParams}`,
    );
    const browser = await browserEvent;
    await browser.getByRole('link', { name: 'Continue as demo@example.com', exact: true }).click();
    await browser.getByRole('heading', { name: 'You’re connected.' }).waitFor();
    await page.getByText('Connected as demo@example.com', { exact: true }).waitFor();
    await until(
      async () => (await page.getByText('Waiting for Google…', { exact: true }).count()) === 0,
    );
  }
  await authorize(0, 'Sign in with Google');
  assert.deepEqual(host.google.capabilities('worker1'), []);
  await page.getByLabel('Enable gmail.read', { exact: true }).click();
  const row = page
    .getByRole('row')
    .filter({ has: page.getByLabel('Enable gmail.read', { exact: true }) });
  await row.locator('summary').click();
  await row.getByRole('checkbox', { name: 'Worker1', exact: true }).click();
  await row.locator('summary').click();
  await authorize(1, 'Connect selected apps');
  assert.deepEqual(host.google.capabilities('worker1'), [
    { operation: 'gmail.read', approvalRequired: false },
  ]);
  assert.deepEqual(host.google.capabilities('worker2'), []);
  await page.screenshot({ path: `${dir}/connected-permissions.png`, fullPage: true });
  assert.ok(!JSON.stringify(store.export()).includes('MOCK_CLIENT_PRIVATE'));
  assert.ok(!JSON.stringify(store.export()).includes('MOCK_ACCESS_PRIVATE'));
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in with Google', exact: true }).waitFor();
  assert.equal(host.google.state().connected, false);
  assert.equal(existsSync(join(dir, 'client/bot-bots.sqlite')), false);
  assert.deepEqual(errors, []);
  const evidence = {
    provider: 'Local mock Google OAuth server',
    systemBrowserHandoffs: 2,
    verifiedPKCEExchanges: exchanges,
    identityOnlyFirst: true,
    granularAppGrant: true,
    credentialsHiddenByDefault: true,
    disconnectVerified: true,
    pageErrors: errors,
  };
  writeFileSync(`${dir}/result.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ dir, ...evidence }));
} finally {
  await app.close();
  host.runtime.events.emit('shutdown');
  host.computer.dispose();
  await host.terminal.dispose();
  server.closeAllConnections();
  provider.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => server.close(() => r())),
    new Promise<void>((r) => provider.close(() => r())),
  ]);
  store.close();
}
