import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { ChatGPTAuth } from '../apps/server/chatgpt-auth';
import { SecretVault } from '../apps/server/secret-vault';
import { attachChatGPT, complete, discover, readResponsesStream } from '../apps/server/models';
import { Credentials } from '../apps/server/credentials';
import { Store } from '../apps/server/store';
import { seedTestTeam as seed } from './fixtures/team';
import type { Model, Provider } from '../packages/shared/types';

const issuer = 'https://auth.openai.com';
const access = 'TEST_CHATGPT_ACCESS_VALUE',
  refresh = 'TEST_CHATGPT_REFRESH_VALUE';
const provider: Provider = {
  id: 'chatgpt',
  name: 'ChatGPT',
  kind: 'chatgpt',
  baseUrl: 'https://api.openai.com/v1',
  apiKeyEnv: '',
  local: false,
  enabled: true,
  timeoutMs: 20000,
};
const model: Model = {
  id: 'chatgpt::test-model',
  providerId: provider.id,
  name: 'test-model',
  enabled: true,
  priority: 50,
  costPerMillion: 0,
  tasks: ['general'],
  status: 'online',
  contextTokens: 32768,
};
async function fixture() {
  const dir = mkdtempSync(resolve('test-results/unit/chatgpt-'));
  const key = randomBytes(32),
    vault = new SecretVault(join(dir, 'auth'), () => key);
  const auth = new ChatGPTAuth(join(dir, 'auth'), vault);
  const pair = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const realFetch = global.fetch;
  let nonce = '',
    subject = 'verified-subject',
    claimNonce: string | undefined,
    claimAudience: string | undefined;
  let refreshes = 0,
    exchanges = 0,
    revocations = 0;
  let failRefresh = false,
    allowSharing = true;
  const requests: { url: string; init?: RequestInit }[] = [];
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  global.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
    requests.push({ url, init });
    if (url === `${issuer}/.well-known/openid-configuration`)
      return json({
        issuer,
        authorization_endpoint: `${issuer}/api/accounts/authorize`,
        token_endpoint: `${issuer}/api/accounts/oauth/token`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        revocation_endpoint: `${issuer}/api/accounts/oauth/revoke`,
      });
    if (url.endsWith('/jwks.json')) return json({ keys: [jwk] });
    if (url.endsWith('/oauth/token')) {
      const body = new URLSearchParams(init?.body as string),
        renewing = body.get('grant_type') === 'refresh_token';
      if (renewing) {
        refreshes++;
        if (failRefresh) return json({ error: 'invalid_grant' }, 400);
        assert.equal(body.get('refresh_token'), refresh);
      } else {
        exchanges++;
        assert.equal(body.get('client_id'), 'oaiapp_test');
      }
      const id = await new SignJWT({
        nonce: claimNonce ?? nonce,
        email: 'test@example.test',
        name: 'Test account',
      })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setIssuer(issuer)
        .setAudience(claimAudience ?? 'oaiapp_test')
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(pair.privateKey);
      return json({
        access_token: access,
        refresh_token: renewing ? `${refresh}_ROTATED` : refresh,
        id_token: id,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: `openid profile email offline_access resource.invoke${allowSharing ? ' chatgpt.tokens.use.direct' : ''}`,
      });
    }
    if (url.endsWith('/oauth/revoke')) {
      revocations++;
      return new Response('', { status: 200 });
    }
    if (url === 'https://api.openai.com/v1/models')
      return json({
        models: [
          { slug: 'test-model', display_name: 'Test Model', visibility: 'list' },
          { slug: 'hidden-model', visibility: 'hidden' },
        ],
      });
    if (url === 'https://api.openai.com/v1/responses') {
      const body = JSON.parse(init!.body as string);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal((init!.headers as Record<string, string>).Authorization, `Bearer ${access}`);
      return new Response(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Working' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'call-test', name: 'workspace_write', arguments: '{"path":"test.txt","content":"Hello"}' }], usage: { total_tokens: 42 } } })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    throw Error(`Unexpected test network request: ${url}`);
  }) as typeof fetch;
  const begin = async (profile?: string) => {
    const { url } = await auth.signIn(profile),
      parsed = new URL(url);
    nonce = parsed.searchParams.get('nonce')!;
    const callback = new URL(parsed.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({
      state: parsed.searchParams.get('state')!,
      code: 'one-time-code',
      client_id: 'oaiapp_test',
    }).toString();
    return { parsed, callback };
  };
  return {
    dir,
    auth,
    vault,
    requests,
    begin,
    counters: () => ({ exchanges, refreshes, revocations }),
    setIdentity: (changes: { subject?: string; nonce?: string; audience?: string }) => {
      subject = changes.subject ?? subject;
      claimNonce = changes.nonce;
      claimAudience = changes.audience;
    },
    noSharing: () => {
      allowSharing = false;
    },
    failRefresh: () => {
      failRefresh = true;
    },
    close: () => {
      auth.cancel();
      global.fetch = realFetch;
    },
  };
}
test('ChatGPT uses PKCE, validates one-time state and identity, encrypts tokens, and reuses issued registrations after restart', async () => {
  const f = await fixture();
  try {
    const { parsed, callback } = await f.begin();
    assert.equal(parsed.origin, issuer);
    assert.equal(parsed.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(parsed.searchParams.get('agent_name_hint'), 'Bot-Bots');
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
    const wrong = new URL(callback);
    wrong.searchParams.set('state', 'wrong');
    assert.equal((await fetch(wrong)).status, 400);
    assert.equal(f.counters().exchanges, 0);
    assert.equal((await fetch(callback)).status, 200);
    const exchange = f.requests.find((r) => r.url.endsWith('/oauth/token'))!;
    const form = new URLSearchParams(exchange.init!.body as string);
    assert.equal(
      createHash('sha256').update(form.get('code_verifier')!).digest('base64url'),
      parsed.searchParams.get('code_challenge'),
    );
    assert.equal(form.get('redirect_uri'), parsed.searchParams.get('redirect_uri'));
    const state = await f.auth.state();
    assert.equal(state.sharing, true);
    assert.equal(state.profiles[0].email, 'test@example.test');
    assert.ok(!JSON.stringify(state).includes(access));
    assert.ok(!JSON.stringify(state).includes(refresh));
    for (const file of readdirSync(join(f.dir, 'auth'))) {
      const data = readFileSync(join(f.dir, 'auth', file), 'utf8');
      assert.ok(!data.includes(access));
      assert.ok(!data.includes(refresh));
    }
    const next = await f.begin(state.active);
    assert.equal(next.parsed.searchParams.get('client_id'), 'oaiapp_test');
    assert.equal(
      next.parsed.searchParams.get('ext_agent_host_id'),
      parsed.searchParams.get('ext_agent_host_id'),
    );
    assert.equal(next.parsed.searchParams.has('agent_name_hint'), false);
    assert.notEqual(next.parsed.searchParams.get('state'), parsed.searchParams.get('state'));
    f.auth.cancel();
  } finally {
    f.close();
  }
});
test('ChatGPT rejects invalid nonce/audience and returning-account substitution before replacing credentials', async () => {
  for (const invalid of [{ nonce: 'wrong-nonce' }, { audience: 'other-client' }]) {
    const f = await fixture();
    try {
      const { callback } = await f.begin();
      f.setIdentity(invalid);
      assert.equal((await fetch(callback)).status, 400);
      assert.equal((await f.auth.state()).sharing, false);
      assert.ok(!JSON.stringify(f.vault.read()).includes(access));
    } finally {
      f.close();
    }
  }
  const f = await fixture();
  try {
    let flow = await f.begin();
    assert.equal((await fetch(flow.callback)).status, 200);
    const original = await f.auth.state();
    flow = await f.begin(original.active);
    f.setIdentity({ subject: 'attacker-account' });
    assert.equal((await fetch(flow.callback)).status, 400);
    assert.equal((await f.auth.state()).profiles[0].email, original.profiles[0].email);
    assert.equal((f.vault.read() as any).profiles[0].subject, 'verified-subject');
  } finally {
    f.close();
  }
});
test('ChatGPT refreshes once for concurrent bot requests, persists rotated tokens and clears revoked sessions', async () => {
  const f = await fixture();
  try {
    const { callback } = await f.begin();
    await fetch(callback);
    const saved = f.vault.read<any>();
    saved.profiles[0].tokens.expires = 0;
    f.vault.write(saved);
    const results = await Promise.all([f.auth.models(), f.auth.models(), f.auth.models()]);
    assert.equal(f.counters().refreshes, 1);
    assert.equal(results[0][0].slug, 'test-model');
    assert.equal(f.vault.read<any>().profiles[0].tokens.refresh, `${refresh}_ROTATED`);
    const next = f.vault.read<any>();
    next.profiles[0].tokens.expires = 0;
    f.vault.write(next);
    f.failRefresh();
    await assert.rejects(f.auth.models(), /expired|revoked/);
    assert.equal((await f.auth.state()).sharing, false);
    assert.equal(f.vault.read<any>().profiles[0].tokens, undefined);
  } finally {
    f.close();
  }
});
test('ChatGPT identity without plan permission cannot run inference; disconnect revokes and removes local tokens', async () => {
  const f = await fixture();
  try {
    f.noSharing();
    const { callback } = await f.begin();
    await fetch(callback);
    assert.equal((await f.auth.state()).sharing, false);
    await assert.rejects(f.auth.models(), /Enable ChatGPT plan usage/);
    await f.auth.disconnect();
    assert.equal(f.counters().revocations, 1);
    const saved = f.vault.read<any>();
    assert.equal(saved.profiles[0].tokens, undefined);
    assert.equal(saved.profiles[0].client, 'oaiapp_test');
  } finally {
    f.close();
  }
});
test('ChatGPT account models are opt-in, use streamed Responses with bot tools, and never export tokens', async () => {
  const f = await fixture();
  const store = new Store(join(f.dir, 'team.sqlite'));
  seed(store, resolve('reference/grok-backup'));
  const credentials = new Credentials(
    join(f.dir, 'external'),
    { kind: 'Test', get: () => null, set: () => {}, delete: () => true },
    join(f.dir, 'workspace'),
  );
  try {
    const { callback } = await f.begin();
    await fetch(callback);
    store.put('providers', provider);
    attachChatGPT(store, credentials, f.auth);
    const catalog = await discover(store, provider.id);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].enabled, false);
    assert.equal(store.settings().localOnly, true);
    const completion = await complete(
      provider,
      model,
      [
        { role: 'system', content: 'Follow the bot duties.' },
        { role: 'user', content: 'Save hello.' },
      ],
      [
        {
          type: 'function',
          function: {
            name: 'workspace_write',
            description: 'Save text',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      1000,
      new AbortController().signal,
      credentials,
    );
    assert.equal(completion.message.tool_calls?.[0].function.name, 'workspace_write');
    assert.equal(completion.tokens, 42);
    const inference = JSON.parse(
      f.requests.find((r) => r.url.endsWith('/responses'))!.init!.body as string,
    );
    assert.equal(inference.instructions, 'Follow the bot duties.');
    assert.equal(inference.tools[0].name, 'workspace_write');
    assert.ok(!JSON.stringify(store.export()).includes(access));
    assert.ok(!JSON.stringify(store.export()).includes(refresh));
  } finally {
    store.close();
    f.close();
  }
});
test('ChatGPT stream interruptions and late usage failures cannot be reported as completed answers', async () => {
  for (const stream of [
    'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n',
  ]) {
    await assert.rejects(
      readResponsesStream(new Response(stream)),
      /before completion|could not complete/,
    );
  }
});
