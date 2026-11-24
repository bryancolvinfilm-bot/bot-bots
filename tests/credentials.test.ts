import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Credentials, credentialPolicySchema } from '../apps/server/credentials';
import type { SecretBackend } from '../apps/server/host-secrets';
import { SecretVault } from '../apps/server/secret-vault';
import { providerHeaders } from '../apps/server/models';
import { createApp } from '../apps/server/app';
import { Store } from '../apps/server/store';
import { seedTestTeam as seed } from './fixtures/team';
import type { Bot } from '../packages/shared/types';

class MemorySecrets implements SecretBackend {
  kind = 'Isolated test secrets';
  values = new Map<string, string>();
  get(alias: string) {
    return this.values.get(alias) ?? null;
  }
  set(alias: string, value: string) {
    this.values.set(alias, value);
  }
  delete(alias: string) {
    return this.values.delete(alias);
  }
}
const hidden = 'TEST_ONLY_PRIVATE_TOKEN_92';
const bot: Bot = {
  id: 'research',
  name: 'Research',
  title: '',
  description: '',
  instructions: '',
  enabled: true,
  modelId: null,
  avatar: { shape: 'blob', color: '#aabbcc', accent: '#112233' },
};
function fixture(
  response?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  mkdirSync('test-results/unit', { recursive: true });
  const dir = mkdtempSync(resolve('test-results/unit/credentials-'));
  const backend = new MemorySecrets();
  backend.set('service-token', hidden);
  const policy = {
    version: 1,
    enabled: true,
    storage: 'os',
    allowBotTerminal: false,
    bindings: [
      {
        id: 'model-main',
        purpose: 'model',
        secret: 'service-token',
        url: 'https://service.test/v1',
      },
    ],
    operations: [
      {
        id: 'list-sites',
        label: 'List sites',
        enabled: true,
        botIds: ['research'],
        url: 'https://service.test/sites',
        method: 'GET',
        auth: { type: 'bearer', secret: 'service-token' },
        inputFields: [],
        responseFields: ['id', 'name', 'echo', 'encoded'],
      },
    ],
  };
  const save = () =>
    writeFileSync(join(dir, 'permissions.json'), JSON.stringify(policy), { mode: 0o600 });
  save();
  let calls = 0;
  const broker = new Credentials(dir, backend, join(dir, 'workspace'), (async (
    url: any,
    init: any,
  ) => {
    calls++;
    assert.equal(String(url), 'https://service.test/sites');
    assert.equal(init.redirect, 'error');
    return response
      ? response(url, init)
      : new Response(
          JSON.stringify([
            {
              id: 'site-42',
              name: 'A site',
              echo: hidden,
              encoded: Buffer.from(hidden).toString('base64'),
              privateField: hidden,
            },
          ]),
          { headers: { 'Content-Type': 'application/json', 'Set-Cookie': hidden } },
        );
  }) as typeof fetch);
  return { dir, backend, broker, policy, save, calls: () => calls };
}
async function approve(f: ReturnType<typeof fixture>, input: unknown = {}) {
  const pending = f.broker.requestUse(
    'list-sites',
    input,
    bot,
    'run',
    new AbortController().signal,
  );
  const result = pending.then(
    (value) => ({ value }),
    (error) => ({ error: error.message }),
  );
  const action = f.broker.state().actions[0];
  await f.broker.decide(action.id, true);
  return result;
}
test('credential operation requires exact approval, injects the key only into the fixed host request, and projects/redacts the result', async () => {
  const f = fixture(async (_url, init) => {
    assert.equal((init!.headers as any).Authorization, `Bearer ${hidden}`);
    return new Response(
      JSON.stringify([
        {
          id: 'site-42',
          name: 'A site',
          echo: hidden,
          encoded: Buffer.from(hidden).toString('base64'),
          privateField: hidden,
        },
      ]),
      { headers: { 'Content-Type': 'application/json', 'Set-Cookie': hidden } },
    );
  });
  const pending = f.broker.requestUse('list-sites', {}, bot, 'run', new AbortController().signal);
  assert.equal(f.calls(), 0);
  const state = f.broker.state(),
    action = state.actions[0];
  assert.equal(action.status, 'awaiting-approval');
  assert.ok(!JSON.stringify(state).includes(hidden));
  await f.broker.decide(action.id, true);
  const result = await pending;
  assert.deepEqual(result, [
    { id: 'site-42', name: 'A site', echo: '[secret hidden]', encoded: '[secret hidden]' },
  ]);
  assert.equal(f.calls(), 1);
  assert.ok(!JSON.stringify(f.broker.state()).includes(hidden));
  await assert.rejects(f.broker.decide(action.id, true), /no longer/);
  assert.equal(f.calls(), 1);
});
test('external revocation and edits take effect before approval, with no replay or environment fallback', async () => {
  const f = fixture();
  const pending = f.broker
    .requestUse('list-sites', {}, bot, 'run', new AbortController().signal)
    .catch((e) => e.message);
  f.policy.enabled = false;
  f.save();
  await f.broker.decide(f.broker.state().actions[0].id, true);
  assert.match(String(await pending), /failed/);
  assert.equal(f.calls(), 0);
  f.policy.enabled = true;
  f.save();
  f.backend.delete('service-token');
  assert.ok('error' in (await approve(f)));
  assert.equal(f.calls(), 0);
  assert.throws(
    () =>
      providerHeaders(
        {
          id: 'p',
          name: 'p',
          kind: 'openai-compatible',
          baseUrl: 'https://service.test/v1',
          credentialId: 'model-main',
          apiKeyEnv: 'PATH',
          enabled: true,
          local: false,
          timeoutMs: 1000,
        },
        f.broker,
      ),
    /missing|revoked/,
  );
  f.backend.set('service-token', hidden);
  const changed = f.broker
    .requestUse('list-sites', {}, bot, 'run', new AbortController().signal)
    .catch((e) => e.message);
  f.policy.operations[0].url = 'https://service.test/new-path';
  f.save();
  await f.broker.decide(f.broker.state().actions[0].id, true);
  assert.match(String(await changed), /failed/);
  assert.equal(f.calls(), 0);
});
test('unknown bots, extra payload fields, unsafe destinations and invalid policies fail closed', async () => {
  const f = fixture();
  assert.throws(
    () =>
      f.broker.requestUse(
        'list-sites',
        {},
        { ...bot, id: 'untrusted' },
        'r',
        new AbortController().signal,
      ),
    /not granted/,
  );
  assert.throws(
    () =>
      f.broker.requestUse(
        'list-sites',
        { url: 'https://attacker.test' },
        bot,
        'r',
        new AbortController().signal,
      ),
    /input fields/,
  );
  assert.throws(
    () => f.broker.binding('model-main', 'model', 'https://attacker.test/v1'),
    /different destination/,
  );
  for (const url of [
    'http://service.test/sites',
    'https://user:password@service.test/sites',
    'file:///tmp/password',
  ])
    assert.equal(
      credentialPolicySchema.safeParse({
        ...f.policy,
        operations: [{ ...f.policy.operations[0], url }],
      }).success,
      false,
    );
  writeFileSync(join(f.dir, 'permissions.json'), '{invalid');
  assert.deepEqual(f.broker.capabilities(bot), []);
  assert.equal(f.broker.botTerminalBlocked(), true);
  assert.equal(f.broker.state().enabled, false);
});
test('denial, cancellation and transport errors never release a credential or retain permission', async () => {
  const f = fixture(async () => {
    throw Error(`network echoed ${hidden}`);
  });
  assert.ok('error' in (await approve(f)));
  assert.ok(!JSON.stringify(f.broker.state()).includes(hidden));
  const denied = f.broker
    .requestUse('list-sites', {}, bot, 'r2', new AbortController().signal)
    .catch((e) => e.message);
  await f.broker.decide(f.broker.state().actions[0].id, false);
  assert.match(String(await denied), /denied/);
  assert.throws(
    () => f.broker.requestUse('list-sites', {}, bot, 'r2', new AbortController().signal),
    /denied/,
  );
  const controller = new AbortController();
  const cancelled = f.broker
    .requestUse('list-sites', {}, bot, 'r3', controller.signal)
    .catch((e) => e.message);
  controller.abort();
  assert.match(String(await cancelled), /cancelled/);
  assert.equal(f.calls(), 1);
});
test('OS-backed vault migration removes the adjacent plaintext master key and deletion outside the app blocks future reads', () => {
  const f = fixture(),
    dir = join(f.dir, 'oauth');
  new SecretVault(dir).write({ refreshToken: hidden });
  assert.equal(existsSync(join(dir, 'master.key')), true);
  const protectedVault = new SecretVault(dir, f.broker.vaultKey(dir));
  assert.equal(protectedVault.read<{ refreshToken: string }>().refreshToken, hidden);
  assert.equal(existsSync(join(dir, 'master.key')), false);
  assert.ok(!readFileSync(join(dir, 'google.vault'), 'utf8').includes(hidden));
  const keyAlias = [...f.backend.values.keys()].find((k) => k.startsWith('google-vault-'))!;
  f.backend.delete(keyAlias);
  assert.throws(() => protectedVault.read(), /revoked/);
  assert.throws(() => protectedVault.write({ refreshToken: 'replacement' }), /revoked/);
  assert.equal(f.backend.values.has(keyAlias), false);
});
test('raw-secret and legacy grant endpoints remain unavailable, and team exports contain neither keys nor external grants', async () => {
  const f = fixture(),
    store = new Store(join(f.dir, 'team.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  const host = createApp(store, f.dir, resolve('dist/web'), '', undefined, undefined, f.broker);
  const server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    assert.equal((await fetch(`${url}/api/credentials/service-token`)).status, 404);
    assert.equal(
      (
        await fetch(`${url}/api/credentials`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: hidden }),
        })
      ).status,
      404,
    );
    const exported = JSON.stringify(store.export());
    assert.ok(!exported.includes(hidden));
    assert.ok(!exported.includes('list-sites'));
    const oauthDir = join(f.dir, 'secrets');
    new SecretVault(oauthDir, f.broker.vaultKey(oauthDir)).write({ refreshToken: hidden });
    f.backend.delete([...f.backend.values.keys()].find((k) => k.startsWith('google-vault-'))!);
    assert.equal(
      (await fetch(`${url}/api/bootstrap`)).status,
      200,
      'OS revocation must not break the whole UI.',
    );
    assert.equal(host.google.state().connected, false);
    assert.equal(
      host.access.allowed('operator', {
        path: '/api/credentials/approval/decision',
        method: 'POST',
      } as any),
      false,
    );
    const request = host.terminal.request(
      'echo nope',
      '.',
      'No shell with credentials',
      1000,
      bot.id,
      'r',
      new AbortController().signal,
    );
    await assert.rejects(request, /external credential policy/);
    assert.equal(store.all('terminal').length, 0);
  } finally {
    f.broker.cancelRun();
    host.runtime.events.emit('shutdown');
    host.computer.dispose();
    await host.terminal.dispose();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
