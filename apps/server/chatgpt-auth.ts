import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync } from 'node:fs';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import lockfile from 'proper-lockfile';
import { SecretVault } from './secret-vault';

// Independent implementation of OpenAI's documented public-client protocol.
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const planScope = 'chatgpt.tokens.use.direct';
type Tokens = {
  access: string;
  refresh: string;
  id?: string;
  expires: number;
  earliest?: number;
  scopes: string[];
};
type Profile = {
  id: string;
  label: string;
  client: string;
  subject?: string;
  email?: string;
  name?: string;
  tokens?: Tokens;
  pending?: Tokens;
};
type Saved = { host: string; active?: string; profiles: Profile[] };
type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
};
export interface ChatGPTState {
  status: 'disconnected' | 'connecting' | 'connected';
  sharing: boolean;
  active?: string;
  error?: string;
  profiles: { id: string; label: string; email?: string; name?: string; connected: boolean }[];
}
export class ChatGPTAuth {
  private pending?: { server: Server; timer: NodeJS.Timeout; controller: AbortController };
  private starting = false;
  private requests = new Set<AbortController>();
  private error?: string;
  private config?: Promise<Discovery>;
  private keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  constructor(
    private dir: string,
    private vault: SecretVault,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  private async locked<T>(operation: (saved: Saved) => Promise<T> | T) {
    const release = await lockfile.lock(this.dir, {
      retries: { retries: 20, minTimeout: 50, maxTimeout: 500 },
      stale: 120000,
    });
    try {
      const value = this.vault.read<Partial<Saved>>();
      const saved: Saved = {
        host: value.host ?? `urn:uuid:${randomUUID()}`,
        profiles: value.profiles ?? [],
        active: value.active,
      };
      if (!value.host) this.vault.write(saved);
      return await operation(saved);
    } finally {
      await release();
    }
  }
  private discovery() {
    this.config ??= (async () => {
      const r = await fetch(`${issuer}/.well-known/openid-configuration`, {
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      const d = (await r.json()) as Discovery;
      if (!r.ok || d.issuer !== issuer)
        throw Error('ChatGPT sign-in configuration could not be verified.');
      for (const key of [
        'authorization_endpoint',
        'token_endpoint',
        'jwks_uri',
        'revocation_endpoint',
      ] as const) {
        if (!d[key] && key === 'revocation_endpoint') continue;
        const url = new URL(d[key]!);
        if (url.origin !== issuer || url.username || url.password || url.hash)
          throw Error('ChatGPT sign-in configuration could not be verified.');
      }
      this.keys = createRemoteJWKSet(new URL(d.jwks_uri));
      return d;
    })().catch(() => {
      this.config = undefined;
      throw Error('Could not reach ChatGPT sign-in. Try again.');
    });
    return this.config;
  }
  async state(): Promise<ChatGPTState> {
    return this.locked((saved) => {
      const p = saved.profiles.find((p) => p.id === saved.active);
      return {
        status:
          this.pending || this.starting ? 'connecting' : p?.tokens ? 'connected' : 'disconnected',
        sharing: !!p?.tokens?.scopes.includes(planScope),
        active: saved.active,
        error: this.error,
        profiles: saved.profiles.map((p) => ({
          id: p.id,
          label: p.label,
          email: p.email,
          name: p.name,
          connected: !!p.tokens,
        })),
      };
    });
  }
  private stopRequests() {
    for (const r of this.requests) r.abort();
  }
  cancel() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.controller.abort();
      this.pending.server.close();
      this.pending = undefined;
    }
  }
  async signIn(profileId?: string): Promise<{ url: string }> {
    if (this.pending || this.starting)
      throw Error('Finish or cancel the current ChatGPT sign-in first.');
    this.starting = true;
    this.error = undefined;
    try {
      const d = await this.discovery();
      const { profile, host } = await this.locked((saved) => {
        let profile = profileId ? saved.profiles.find((p) => p.id === profileId) : undefined;
        if (profileId && !profile) throw Error('ChatGPT account not found.');
        profile ??= {
          id: randomUUID(),
          label: `Account ${saved.profiles.length + 1}`,
          client: 'dynamic_agent_client',
        };
        if (!saved.profiles.some((p) => p.id === profile!.id)) {
          saved.profiles.push(profile);
          this.vault.write(saved);
        }
        return { profile: structuredClone(profile), host: saved.host };
      });
      const state = randomBytes(32).toString('base64url'),
        nonce = randomBytes(32).toString('base64url'),
        verifier = randomBytes(64).toString('base64url');
      const controller = new AbortController();
      let consumed = false;
      const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const actual = Buffer.from(url.searchParams.get('state') ?? '');
        if (
          req.method !== 'GET' ||
          url.pathname !== '/auth/callback' ||
          consumed ||
          actual.length !== state.length ||
          !timingSafeEqual(actual, Buffer.from(state))
        ) {
          res.writeHead(400).end('Invalid or expired sign-in callback.');
          return;
        }
        consumed = true;
        try {
          if (url.searchParams.has('error'))
            throw Error('ChatGPT sign-in was declined. You can try again.');
          const code = url.searchParams.get('code'),
            client = url.searchParams.get('client_id') ?? profile.client;
          if (
            !code ||
            !client ||
            client === 'dynamic_agent_client' ||
            (profile.client !== 'dynamic_agent_client' && client !== profile.client)
          )
            throw Error('ChatGPT registration did not complete. Try signing in again.');
          // Retain the issued registration even if exchange fails; never register it twice.
          await this.locked((saved) => {
            const p = saved.profiles.find((p) => p.id === profile.id)!;
            p.client = client;
            this.vault.write(saved);
          });
          const raw = await this.exchange(
            d.token_endpoint,
            {
              grant_type: 'authorization_code',
              client_id: client,
              code,
              code_verifier: verifier,
              redirect_uri: redirect,
              resource,
            },
            controller.signal,
          );
          const tokens = this.parseTokens(raw);
          if (!tokens.id) throw Error('ChatGPT did not return a verified identity.');
          const identity = await this.identity(tokens.id, client, nonce);
          if (profile.subject && identity.sub !== profile.subject)
            throw Error(
              'This sign-in belongs to a different ChatGPT account. Add another account instead.',
            );
          await this.locked((saved) => {
            controller.signal.throwIfAborted();
            const p = saved.profiles.find((p) => p.id === profile.id)!;
            Object.assign(p, {
              client,
              subject: identity.sub,
              email: identity.email,
              name: identity.name,
              tokens,
              pending: undefined,
            });
            saved.active = p.id;
            this.vault.write(saved);
          });
          this.stopRequests();
          res.end('ChatGPT is connected. You can close this tab and return to Bot-Bots.');
        } catch (e) {
          this.error =
            e instanceof AuthError
              ? e.message
              : e instanceof Error && /^(ChatGPT|This sign-in)/.test(e.message)
                ? e.message
                : 'ChatGPT sign-in could not be verified. Try again.';
          res.writeHead(400).end(this.error);
        } finally {
          if (this.pending?.controller === controller) this.cancel();
        }
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const port = (server.address() as { port: number }).port;
      const redirect = `http://127.0.0.1:${port}/auth/callback`;
      const timer = setTimeout(() => {
        this.error = 'ChatGPT sign-in expired. Try again.';
        this.cancel();
      }, 10 * 60000);
      timer.unref();
      this.pending = { server, timer, controller };
      const url = new URL(d.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: profile.client,
        ext_agent_host_id: host,
        response_type: 'code',
        redirect_uri: redirect,
        scope: scopes,
        resource,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        ...(profile.client === 'dynamic_agent_client' ? { agent_name_hint: 'Bot-Bots' } : {}),
        ...(profile.email ? { login_hint: profile.email } : {}),
      }).toString();
      return { url: url.toString() };
    } finally {
      this.starting = false;
    }
  }
  private async identity(token: string, client: string, nonce?: string) {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer,
      audience: client,
      requiredClaims: ['sub', 'exp', 'iat'],
      algorithms: ['RS256', 'ES256'],
    });
    if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce))
      throw Error('ChatGPT identity could not be verified.');
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  }
  private parseTokens(raw: Record<string, unknown>, previous?: Tokens): Tokens {
    if (
      raw.token_type !== 'Bearer' ||
      typeof raw.access_token !== 'string' ||
      !/^[\x21-\x7e]+$/.test(raw.access_token) ||
      typeof raw.refresh_token !== 'string' ||
      !raw.refresh_token ||
      typeof raw.expires_in !== 'number' ||
      !Number.isFinite(raw.expires_in) ||
      raw.expires_in <= 0
    )
      throw Error('ChatGPT returned an invalid token response. Sign in again.');
    const earliest =
      typeof raw.earliest_refresh_at === 'number'
        ? raw.earliest_refresh_at * 1000
        : typeof raw.earliest_refresh_at === 'string'
          ? Date.parse(raw.earliest_refresh_at)
          : undefined;
    return {
      access: raw.access_token,
      refresh: raw.refresh_token,
      id: typeof raw.id_token === 'string' ? raw.id_token : previous?.id,
      expires: Date.now() + raw.expires_in * 1000,
      earliest,
      scopes: typeof raw.scope === 'string' ? raw.scope.split(/\s+/) : (previous?.scopes ?? []),
    };
  }
  private async exchange(url: string, body: Record<string, string>, signal: AbortSignal) {
    const r = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    });
    if (!r.ok) {
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      throw new AuthError(
        data.error === 'invalid_grant'
          ? 'ChatGPT authorization expired or was revoked. Sign in again.'
          : `ChatGPT authorization failed (HTTP ${r.status}). Try again.`,
        data.error === 'invalid_grant',
      );
    }
    return (await r.json()) as Record<string, unknown>;
  }
  async select(id: string) {
    this.cancel();
    this.stopRequests();
    await this.locked((saved) => {
      if (!saved.profiles.some((p) => p.id === id)) throw Error('ChatGPT account not found.');
      saved.active = id;
      this.vault.write(saved);
    });
    this.error = undefined;
  }
  async disconnect() {
    this.cancel();
    this.stopRequests();
    await this.locked(async (saved) => {
      const p = saved.profiles.find((p) => p.id === saved.active);
      if (!p) return;
      try {
        const d = await this.discovery();
        const token = p.pending?.refresh ?? p.tokens?.refresh;
        if (token && d.revocation_endpoint) {
          const r = await fetch(d.revocation_endpoint, {
            method: 'POST',
            redirect: 'error',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token,
              token_type_hint: 'refresh_token',
              client_id: p.client,
            }),
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) throw Error();
        }
        this.error = undefined;
      } catch {
        this.error =
          'Signed out locally. Remote revocation was not confirmed; disconnect Bot-Bots in ChatGPT Settings if needed.';
      }
      delete p.tokens;
      delete p.pending;
      this.vault.write(saved);
    });
  }
  async authenticated<T>(
    operation: (token: string, signal: AbortSignal) => Promise<T>,
    caller: AbortSignal,
  ): Promise<T> {
    if (this.pending || this.starting)
      throw Error('Finish ChatGPT sign-in before running a bot with it.');
    const controller = new AbortController();
    this.requests.add(controller);
    const signal = AbortSignal.any([caller, controller.signal]);
    try {
      const token = await this.locked(async (saved) => {
        signal.throwIfAborted();
        const p = saved.profiles.find((p) => p.id === saved.active);
        if (!p?.tokens) throw Error('Sign in with ChatGPT in the Model workshop first.');
        if (p.pending || p.tokens.expires <= Date.now() + 60000) {
          if (!p.pending && p.tokens.earliest && p.tokens.earliest > Date.now()) {
            if (p.tokens.expires <= Date.now())
              throw Error('ChatGPT cannot refresh yet. Try again shortly.');
          } else {
            try {
              if (!p.pending) {
                const d = await this.discovery();
                // Complete and checkpoint rotation even if the bot is cancelled.
                const raw = await this.exchange(
                  d.token_endpoint,
                  {
                    grant_type: 'refresh_token',
                    client_id: p.client,
                    refresh_token: p.tokens.refresh,
                    resource,
                  },
                  AbortSignal.timeout(60000),
                );
                p.pending = this.parseTokens(raw, p.tokens);
                this.vault.write(saved);
              }
              if (p.pending.id && p.pending.id !== p.tokens.id) {
                const who = await this.identity(p.pending.id, p.client);
                if (who.sub !== p.subject)
                  throw new AuthError(
                    'ChatGPT refreshed a different account. Sign in again.',
                    true,
                  );
              }
              p.tokens = p.pending;
              delete p.pending;
              this.vault.write(saved);
            } catch (e) {
              if (e instanceof AuthError && e.reauth) {
                delete p.tokens;
                delete p.pending;
                this.vault.write(saved);
              }
              throw e;
            }
          }
        }
        if (!p.tokens.scopes.includes(planScope))
          throw Error(
            'Enable ChatGPT plan usage for Bot-Bots in ChatGPT Settings, then sign in again.',
          );
        signal.throwIfAborted();
        return p.tokens.access;
      });
      return await operation(token, signal);
    } finally {
      this.requests.delete(controller);
    }
  }
  async models() {
    return this.authenticated(async (token, signal) => {
      const r = await fetch(`${resource}/models`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      if (!r.ok) throw Error(`ChatGPT model discovery failed (HTTP ${r.status}).`);
      const data = (await r.json()) as {
        models?: { slug: string; display_name?: string; visibility: string }[];
      };
      if (!Array.isArray(data.models)) throw Error('ChatGPT returned an invalid model catalog.');
      return data.models.filter(
        (m) => m.visibility === 'list' && typeof m.slug === 'string' && m.slug.length <= 160,
      );
    }, AbortSignal.timeout(20000));
  }
}
class AuthError extends Error {
  constructor(
    message: string,
    readonly reauth = false,
  ) {
    super(message);
  }
}
