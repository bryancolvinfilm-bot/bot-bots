import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { GooglePlugin } from '../apps/server/google';
import { loadGoogleRegistration } from '../apps/server/google-registration';
import { seedTestTeam as seed } from './fixtures/team';
import { SecretVault } from '../apps/server/secret-vault';
import { Store } from '../apps/server/store';

mkdirSync('test-results/unit', { recursive: true });
async function fixture() {
  const dir = mkdtempSync(resolve('test-results/unit/google-signin-'));
  const store = new Store(join(dir, 'team.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  for (const p of store.all('providers')) store.put('providers', { ...p, autoDiscover: false });
  const exchanges: URLSearchParams[] = [];
  const provider = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/token') {
      exchanges.push(new URLSearchParams(text));
      res.end(
        JSON.stringify({
          access_token: 'ACCESS_PRIVATE',
          refresh_token: 'REFRESH_PRIVATE',
          expires_in: 3600,
          scope: 'openid email',
        }),
      );
    } else if (req.url === '/userinfo')
      res.end(
        JSON.stringify({ sub: 'account-one', email: 'person@example.com', email_verified: true }),
      );
    else res.end('{}');
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const urls = {
    authorize: `${origin}/authorize`,
    token: `${origin}/token`,
    revoke: `${origin}/revoke`,
    api: () => origin,
  };
  const google = new GooglePlugin(store, new SecretVault(join(dir, 'secrets')), urls, {
    clientId: 'default.apps.googleusercontent.com',
    clientType: 'desktop',
  });
  return {
    dir,
    store,
    google,
    urls,
    exchanges,
    close: async () => {
      provider.closeAllConnections();
      await new Promise<void>((r) => provider.close(() => r()));
      store.close();
    },
  };
}

test('default app registration signs in through a loopback callback without user credentials or app permissions', async () => {
  const f = await fixture();
  try {
    assert.equal(f.google.state().signIn.ready, true);
    assert.equal(f.google.state().signIn.source, 'app');
    const auth = new URL(
      f.google.authorize({ callbackOrigin: 'http://127.0.0.1:4321', identityOnly: true }).url,
    );
    assert.equal(auth.searchParams.get('client_id'), 'default.apps.googleusercontent.com');
    assert.equal(
      auth.searchParams.get('redirect_uri'),
      'http://127.0.0.1:4321/oauth/google/callback',
    );
    assert.equal(auth.searchParams.get('scope'), 'openid email');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(f.google.state().signIn.status, 'waiting');
    await assert.rejects(f.google.callback('unrelated', 'CODE'), /expired/);
    assert.equal(f.google.state().signIn.status, 'waiting');
    await f.google.callback(auth.searchParams.get('state')!, 'CODE');
    assert.equal(f.google.state().connected, true);
    assert.equal(f.google.state().accountEmail, 'person@example.com');
    assert.equal(f.google.state().signIn.status, 'idle');
    assert.deepEqual(f.google.capabilities('worker1'), []);
    assert.ok(f.exchanges[0].get('code_verifier'));
    assert.equal(f.exchanges[0].has('client_secret'), false);
    assert.ok(!JSON.stringify(f.store.export()).includes('ACCESS_PRIVATE'));
    assert.ok(!JSON.stringify(f.store.export()).includes('REFRESH_PRIVATE'));
    await assert.rejects(f.google.callback(auth.searchParams.get('state')!, 'CODE'), /expired/);
  } finally {
    await f.close();
  }
});

test('cancellation, denial and replacing a sign-in invalidate old browser attempts while preserving permission limits', async () => {
  const f = await fixture();
  try {
    const auth = () =>
      new URL(f.google.authorize({ callbackOrigin: 'http://127.0.0.1:4321' }).url).searchParams.get(
        'state',
      )!;
    const cancelled = auth();
    f.google.cancelAuthorization();
    await assert.rejects(f.google.callback(cancelled, 'CODE'), /expired/);
    const previous = auth(),
      current = auth();
    await assert.rejects(f.google.callback(previous, 'CODE'), /expired/);
    await assert.rejects(f.google.callback(current, '', 'access_denied'), /declined/);
    assert.equal(f.google.state().signIn.status, 'failed');
    assert.equal(f.google.state().connected, false);
    assert.equal(f.exchanges.length, 0);
    f.google.configure({
      ...f.google.config(),
      permissions: { 'gmail.read': { enabled: true, botIds: ['worker1'] } },
    });
    const url = new URL(f.google.authorize().url);
    assert.match(url.searchParams.get('scope')!, /gmail.readonly/);
    await f.google.callback(url.searchParams.get('state')!, 'CODE');
    assert.deepEqual(f.google.state().needsAuthorization, ['gmail.read']);
    assert.deepEqual(f.google.capabilities('worker1'), []);
  } finally {
    await f.close();
  }
});

test('custom Google client files are imported once, secrets stay private and foreign OAuth endpoints are rejected', async () => {
  const f = await fixture();
  try {
    f.google.importClient({
      installed: {
        client_id: 'own.apps.googleusercontent.com',
        client_secret: 'CLIENT_PRIVATE',
        redirect_uris: ['http://localhost'],
      },
    });
    assert.equal(f.google.config().clientSource, 'custom');
    assert.equal(f.google.config().redirectUri, '');
    const auth = new URL(f.google.authorize({ callbackOrigin: 'http://127.0.0.1:4321' }).url);
    await f.google.callback(auth.searchParams.get('state')!, 'CODE');
    assert.equal(f.exchanges[0].get('client_secret'), 'CLIENT_PRIVATE');
    assert.ok(!JSON.stringify(f.google.state()).includes('CLIENT_PRIVATE'));
    assert.ok(!JSON.stringify(f.store.export()).includes('CLIENT_PRIVATE'));
    assert.throws(() =>
      f.google.importClient({
        installed: {
          client_id: 'own.apps.googleusercontent.com',
          token_uri: 'https://attacker.example/token',
        },
      }),
    );
    assert.throws(() => f.google.importClient({ web: { client_id: 'invalid' } }));
  } finally {
    await f.close();
  }
});

test('HTTP sign-in derives its own callback port and reports success without granting access to any Google app', async () => {
  const f = await fixture();
  const host = createApp(f.store, f.dir, resolve('dist/web'));
  (host.google as unknown as { urls: typeof f.urls }).urls = f.urls;
  host.google.importClient({ installed: { client_id: 'http.apps.googleusercontent.com' } });
  const server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/api/plugins/google/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityOnly: true }),
    });
    assert.equal(response.status, 200);
    const url = new URL(((await response.json()) as { url: string }).url);
    assert.equal(url.searchParams.get('redirect_uri'), `${base}/oauth/google/callback`);
    let focused = false;
    host.runtime.events.once('google-connected', () => {
      focused = true;
    });
    const callback = await fetch(
      `${base}/oauth/google/callback?state=${url.searchParams.get('state')}&code=CODE`,
    );
    assert.equal(callback.status, 200);
    assert.match(await callback.text(), /You’re connected/);
    assert.equal(focused, true);
    assert.deepEqual(host.google.capabilities('worker1'), []);
    const denied = await fetch(`${base}/api/plugins/google/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.9' },
      body: '{}',
    });
    assert.notEqual(denied.status, 200);
  } finally {
    host.runtime.events.emit('shutdown');
    host.computer.dispose();
    await host.terminal.dispose();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.close();
  }
});

test('cancelling during token exchange cannot reconnect the account or replace the cancelled UI state', async () => {
  const f = await fixture();
  let held!: ServerResponse, arrived!: () => void;
  const ready = new Promise<void>((r) => {
    arrived = r;
  });
  const tokens = createServer((req, res) => {
    req.resume();
    held = res;
    arrived();
  });
  await new Promise<void>((r) => tokens.listen(0, '127.0.0.1', r));
  (f.google as unknown as { urls: typeof f.urls }).urls = {
    ...f.urls,
    token: `http://127.0.0.1:${(tokens.address() as AddressInfo).port}/token`,
  };
  try {
    const url = new URL(f.google.authorize({ callbackOrigin: 'http://127.0.0.1:4321' }).url);
    const callback = f.google.callback(url.searchParams.get('state')!, 'CODE');
    const rejected = assert.rejects(callback, /authorization changed/);
    await ready;
    assert.equal(f.google.state().signIn.status, 'exchanging');
    f.google.cancelAuthorization();
    held.setHeader('Content-Type', 'application/json');
    held.end(
      JSON.stringify({
        access_token: 'LATE_PRIVATE',
        refresh_token: 'LATE_REFRESH',
        expires_in: 3600,
        scope: 'openid email',
      }),
    );
    await rejected;
    assert.equal(f.google.state().connected, false);
    assert.equal(f.google.state().signIn.status, 'idle');
    assert.equal(
      new SecretVault(join(f.dir, 'secrets')).read<{ accessToken?: string }>().accessToken,
      undefined,
    );
  } finally {
    tokens.closeAllConnections();
    await new Promise<void>((r) => tokens.close(() => r()));
    await f.close();
  }
});

test('publisher registration loads a public desktop client and omits any secret fields', () => {
  const root = mkdtempSync(resolve('test-results/unit/google-registration-'));
  mkdirSync(join(root, 'resources'));
  writeFileSync(
    join(root, 'resources/google-oauth.json'),
    JSON.stringify({
      clientId: 'app.apps.googleusercontent.com',
      clientType: 'desktop',
      clientSecret: 'NEVER_BUNDLE',
    }),
  );
  assert.deepEqual(loadGoogleRegistration(root), {
    clientId: 'app.apps.googleusercontent.com',
    clientType: 'desktop',
  });
});
