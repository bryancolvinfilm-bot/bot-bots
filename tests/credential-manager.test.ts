import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/app';
import { Credentials } from '../apps/server/credentials';
import { providerHeaders } from '../apps/server/models';
import { seedTestTeam as seed } from './fixtures/team';
import { Store } from '../apps/server/store';
import type { SecretBackend } from '../apps/server/host-secrets';

class MemorySecrets implements SecretBackend {
  kind = 'Isolated OS-store adapter';
  values = new Map<string, string>();
  get(id: string) {
    return this.values.get(id) ?? null;
  }
  set(id: string, value: string) {
    this.values.set(id, value);
  }
  delete(id: string) {
    return this.values.delete(id);
  }
}
const hidden = 'PRIVATE_GUI_KEY_8f1fbf0_not_for_models';
async function fixture() {
  mkdirSync('test-results/credential-manager', { recursive: true });
  const dir = mkdtempSync(resolve('test-results/credential-manager/case-'));
  const external = join(dir, 'external');
  const backend = new MemorySecrets(),
    store = new Store(join(dir, 'team.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  let requests = 0,
    auth = '';
  const broker = new Credentials(external, backend, join(dir, 'workspace'), (async (_url, init) => {
    requests++;
    auth = String((init?.headers as Record<string, string>)?.Authorization);
    return new Response(JSON.stringify({ id: 'ok', password: hidden }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch);
  const token = 'owner-credential-window-test-token';
  const host = createApp(store, dir, resolve('dist/web'), token, undefined, undefined, broker);
  const server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function api(
    path = '',
    method = 'GET',
    body?: unknown,
    key = token,
    extra: Record<string, string> = {},
  ) {
    const response = await fetch(`${base}/api/credentials/manager${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      data: await response.json(),
      cache: response.headers.get('cache-control'),
    };
  }
  const state = async () => (await api()).data;
  return {
    dir,
    external,
    backend,
    store,
    broker,
    host,
    api,
    state,
    requests: () => requests,
    auth: () => auth,
    async close() {
      host.runtime.events.emit('shutdown');
      host.computer.dispose();
      await host.terminal.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

test('owner window saves and rotates API keys, auto-binds a model, never returns values, and removes/revokes them', async () => {
  const f = await fixture();
  try {
    const first = await f.api();
    assert.equal(first.status, 200);
    assert.equal(first.cache, 'no-store');
    const saved = await f.api('/secrets', 'POST', {
      version: first.data.version,
      name: 'My model key',
      kind: 'api-key',
      value: hidden,
      target: {
        type: 'model',
        provider: {
          name: 'My provider',
          kind: 'openai-compatible',
          baseUrl: 'https://service.test/v1',
        },
      },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    const id = saved.data.id,
      provider = f.store.all('providers').find((provider) => provider.name === 'My provider')!;
    assert.equal(f.backend.get(id), hidden);
    assert.equal(providerHeaders(provider, f.broker).Authorization, `Bearer ${hidden}`);
    assert.ok(!JSON.stringify(saved.data).includes(hidden));
    assert.ok(!JSON.stringify(f.store.export()).includes(hidden));
    for (const file of ['manager.json', 'permissions.json'])
      assert.ok(!readFileSync(join(f.external, file), 'utf8').includes(hidden));
    assert.equal((await f.api(`/secrets/${id}`)).status, 404);
    const rotated = await f.api('/secrets', 'POST', {
      version: saved.data.state.version,
      id,
      name: 'Renamed key',
      kind: 'api-key',
      value: 'ROTATED_KEY_33',
      target: { type: 'store' },
    });
    assert.equal(rotated.status, 201);
    assert.equal(providerHeaders(provider, f.broker).Authorization, 'Bearer ROTATED_KEY_33');
    assert.ok(!JSON.stringify(rotated.data).includes('ROTATED_KEY_33'));
    const removed = await f.api(`/secrets/${id}`, 'DELETE', {
      version: rotated.data.state.version,
    });
    assert.equal(removed.status, 200);
    assert.equal(f.backend.get(id), null);
    assert.equal(removed.data.state.connections.length, 0);
    assert.throws(
      () => providerHeaders({ ...provider, apiKeyEnv: 'LEGACY_KEY' }, f.broker),
      /missing|revoked/,
    );
  } finally {
    await f.close();
  }
});

test('passwords stay in the store and scoped Basic-auth service actions still wait for one exact owner approval', async () => {
  const f = await fixture();
  try {
    const password = 'a long pässword with spaces';
    const saved = await f.api('/secrets', 'POST', {
      version: (await f.state()).version,
      name: 'My service login',
      kind: 'password',
      value: password,
      target: {
        type: 'operation',
        label: 'Read service status',
        url: 'https://service.test/status',
        method: 'GET',
        authType: 'basic',
        username: 'owner',
        botIds: ['calendar'],
        inputFields: [],
        responseFields: ['id'],
      },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    assert.equal(f.backend.get(saved.data.id), password);
    const simplePassword = await f.api('/secrets', 'POST', {
      version: (await f.state()).version,
      name: 'Another login',
      kind: 'password',
      value: 'password',
      target: { type: 'store' },
    });
    assert.equal(
      simplePassword.status,
      201,
      'Metadata type names must not restrict valid stored password values.',
    );
    assert.ok(!JSON.stringify(saved.data).includes(password));
    assert.equal(f.broker.capabilities(f.store.get('bots', 'worker1')!).length, 0);
    const pending = f.broker.requestUse(
      saved.data.grantId,
      {},
      f.store.get('bots', 'calendar')!,
      'run',
      new AbortController().signal,
    );
    assert.equal(f.requests(), 0);
    const action = f.broker.state().actions[0];
    assert.equal(action.status, 'awaiting-approval');
    await f.broker.decide(action.id, true);
    assert.deepEqual(await pending, { id: 'ok' });
    assert.equal(f.requests(), 1);
    assert.equal(f.auth(), `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`);
    const revoked = await f.api(`/connections/${saved.data.grantId}`, 'DELETE', {
      version: (await f.state()).version,
    });
    assert.equal(revoked.status, 200);
    assert.equal(f.broker.capabilities().length, 0);
    assert.equal(f.backend.get(saved.data.id), password);
  } finally {
    await f.close();
  }
});

test('stale windows cannot overwrite external revocation; a new explicit connection does not reactivate older grants', async () => {
  const f = await fixture();
  try {
    const saved = await f.api('/secrets', 'POST', {
      version: (await f.state()).version,
      name: 'First key',
      kind: 'api-key',
      value: hidden,
      target: {
        type: 'model',
        provider: { name: 'First', kind: 'openai-compatible', baseUrl: 'https://one.test/v1' },
      },
    });
    const file = join(f.external, 'permissions.json'),
      policy = JSON.parse(readFileSync(file, 'utf8'));
    policy.enabled = false;
    writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
    const stale = await f.api('/secrets', 'POST', {
      version: saved.data.state.version,
      id: saved.data.id,
      name: 'Stale edit',
      kind: 'api-key',
      value: 'BAD_OVERWRITE',
      target: { type: 'store' },
    });
    assert.equal(stale.status, 409);
    assert.equal(f.backend.get(saved.data.id), hidden);
    const second = await f.api('/secrets', 'POST', {
      version: (await f.state()).version,
      name: 'Second key',
      kind: 'api-key',
      value: 'NEW_KEY',
      target: {
        type: 'model',
        provider: { name: 'Second', kind: 'anthropic', baseUrl: 'https://two.test/v1' },
      },
    });
    assert.equal(second.status, 201);
    assert.equal(
      second.data.state.connections.find((connection: any) => connection.id === saved.data.grantId)
        .enabled,
      false,
    );
    assert.throws(
      () => f.broker.binding(saved.data.grantId, 'model', 'https://one.test/v1'),
      /revoked/,
    );
    f.backend.delete(second.data.id);
    assert.equal(
      (await f.state()).secrets.find((secret: any) => secret.id === second.data.id).present,
      false,
    );
    assert.throws(
      () => f.broker.binding(second.data.grantId, 'model', 'https://two.test/v1'),
      /missing|revoked/,
    );
  } finally {
    await f.close();
  }
});

test('management rejects non-owners, hostile origins, reserved aliases, unsafe grants and native errors without leaking submitted secrets', async () => {
  const f = await fixture();
  try {
    const operator = f.host.access.issue('Operator', 'operator').token;
    assert.equal((await f.api('', 'GET', undefined, operator)).status, 403);
    assert.equal((await f.api('', 'GET', undefined, 'wrong')).status, 401);
    const input = {
      version: (await f.state()).version,
      name: 'Key',
      kind: 'api-key',
      value: hidden,
      target: { type: 'store' },
    };
    assert.equal(
      (await f.api('/secrets', 'POST', input, undefined, { Origin: 'https://hostile.test' }))
        .status,
      403,
    );
    assert.equal(
      (await f.api('/secrets', 'POST', { ...input, id: 'google-vault-protected' })).status,
      400,
    );
    assert.equal(
      (
        await f.api('/secrets', 'POST', {
          ...input,
          target: {
            type: 'model',
            provider: {
              name: 'Unsafe',
              kind: 'openai-compatible',
              baseUrl: 'http://service.test/v1',
            },
          },
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.api('/secrets', 'POST', { ...input, id: 'Google-Vault-protected' })).status,
      400,
    );
    assert.equal((await f.api('/secrets', 'POST', { ...input, name: hidden })).status, 400);
    f.backend.set = () => {
      throw Error(`Native failure leaked ${hidden}`);
    };
    const failure = await f.api('/secrets', 'POST', input);
    assert.equal(failure.status, 503);
    assert.ok(!JSON.stringify(failure.data).includes(hidden));
    assert.equal(f.backend.values.size, 0);
  } finally {
    await f.close();
  }
});

test('frontier account routes are owner-only and the Claude shortcut uses existing private model-key setup', async () => {
  const f = await fixture();
  try {
    const operator = f.host.access.issue('Operator', 'operator').token;
    for (const path of [
      '/chatgpt',
      '/chatgpt/signin',
      '/chatgpt/disconnect',
      '/chatgpt/select',
      '/chatgpt/models',
      '/claude',
    ])
      assert.equal(
        (
          await f.api(
            path,
            path === '/chatgpt' ? 'GET' : 'POST',
            path === '/chatgpt' ? undefined : {},
            operator,
          )
        ).status,
        403,
      );
    const state = await f.api('/chatgpt');
    assert.equal(state.status, 200);
    assert.equal(state.cache, 'no-store');
    assert.equal(state.data.sharing, false);
    assert.equal(
      (await f.api('/chatgpt/signin', 'POST', {}, undefined, { Origin: 'https://hostile.test' }))
        .status,
      403,
    );
    assert.equal((await f.api('/claude', 'POST', {})).status, 200);
    assert.equal(f.store.get('providers', 'anthropic')!.kind, 'anthropic');
    assert.equal(f.store.get('providers', 'anthropic')!.local, false);
    assert.equal(f.store.settings().localOnly, true);
  } finally {
    await f.close();
  }
});

test('legacy API permissions migrate to all bots while disabled grants and bot duties stay intact', async () => {
  const f = await fixture();
  try {
    const original = f.store.all('bots');
    const saved = await f.api('/secrets', 'POST', {
      version: (await f.state()).version,
      name: 'Shared token',
      kind: 'api-key',
      value: hidden,
      target: {
        type: 'operation',
        label: 'Read status',
        url: 'https://service.test/status',
        method: 'GET',
        authType: 'bearer',
        botIds: ['worker1'],
        inputFields: [],
        responseFields: ['id'],
      },
    });
    assert.equal(saved.status, 201);
    const path = join(f.external, 'permissions.json');
    const policy = JSON.parse(readFileSync(path, 'utf8'));
    policy.operations[0].botIds = ['worker1'];
    policy.operations[0].enabled = false;
    writeFileSync(path, JSON.stringify(policy));
    assert.equal(f.broker.manager().shareApiConnections(), true);
    const migrated = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(migrated.operations[0].botIds, ['*']);
    assert.equal(migrated.operations[0].enabled, false);
    assert.equal(migrated.operations[0].id, saved.data.grantId);
    assert.equal(f.backend.get(saved.data.id), hidden);
    assert.deepEqual(f.store.all('bots'), original);
    assert.equal(f.broker.manager().shareApiConnections(), false);
  } finally {
    await f.close();
  }
});

test('alert credentials connect automatically without sending a warning', async () => {
  const f = await fixture();
  try {
    const saved = await f.api('/secrets', 'POST', {
      version: (await f.state()).version,
      name: 'Warning key',
      kind: 'api-key',
      value: hidden,
      target: { type: 'alert', channel: 'email', url: 'https://alerts.test/deliver' },
    });
    assert.equal(saved.status, 201);
    assert.equal(f.store.settings().alertEmail.credentialId, saved.data.grantId);
    assert.equal(f.store.settings().alertEmail.url, 'https://alerts.test/deliver');
    assert.equal(f.store.settings().alertEmail.enabled, false);
    assert.equal(
      f.broker.binding(saved.data.grantId, 'alert', 'https://alerts.test/deliver'),
      hidden,
    );
    assert.equal(f.requests(), 0);
  } finally {
    await f.close();
  }
});

test('saving secrets cancels permission for an older bot command before it can execute', async () => {
  const f = await fixture();
  try {
    const pending = f.host.terminal.request(
      'Write-Output should-not-run',
      '.',
      'Test stale permission',
      1000,
      'worker1',
      'test-run',
      new AbortController().signal,
    );
    const id = f.host.terminal.state().jobs[0].id;
    const saved = await f.api('/secrets', 'POST', {
      version: (await f.state()).version,
      name: 'Private key',
      kind: 'api-key',
      value: hidden,
      target: { type: 'store' },
    });
    assert.equal(saved.status, 201);
    assert.equal(f.broker.botTerminalBlocked(), true);
    const result = f.host.terminal.decide(id, true);
    assert.equal(result.status, 'cancelled');
    assert.equal((await pending).output, '');
    assert.ok(existsSync(join(f.external, 'permissions.json')));
  } finally {
    await f.close();
  }
});
