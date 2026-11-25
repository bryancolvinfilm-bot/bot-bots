import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { Store } from './store';
export type AccessRole = 'owner' | 'operator' | 'viewer';
interface Credential {
  id: string;
  name: string;
  hash: string;
  role: AccessRole;
  kind: 'key' | 'session';
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export function trustedLocal(req: Request) {
  const remote = req.socket.remoteAddress ?? '';
  return (
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) &&
    ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(req.hostname) &&
    !req.get('forwarded') &&
    !req.get('x-forwarded-for') &&
    !req.get('cf-connecting-ip') &&
    !req.get('x-real-ip')
  );
}
export class AccessControl {
  private attempts = new Map<string, { count: number; until: number }>();
  private pairs = new Map<string, { role: AccessRole; expires: number; attempts: number }>();
  constructor(
    private store: Store,
    private master = '',
  ) {}
  private credentials() {
    return this.store.config<Credential[]>('access-credentials') ?? [];
  }
  info() {
    const owner = this.store.config<{ username: string }>('access-owner');
    return {
      ownerConfigured: !!owner,
      username: owner?.username,
      publicUrl: this.store.config<string>('public-url') ?? '',
      keys: this.credentials()
        .filter((c) => c.kind === 'key')
        .map(({ hash, ...entry }) => entry),
      devices: this.credentials()
        .filter((c) => c.kind === 'session')
        .map(({ hash, ...entry }) => entry),
    };
  }
  setup(username: string, password: string) {
    if (
      username.trim().length < 1 ||
      username.length > 80 ||
      password.length < 12 ||
      password.length > 300
    )
      throw Error('Use a name and a password of at least 12 characters.');
    const salt = randomBytes(32).toString('base64url');
    this.store.setConfig('access-owner', {
      username: username.trim(),
      salt,
      password: scryptSync(password, salt, 64).toString('hex'),
    });
    this.store.setConfig(
      'access-credentials',
      this.credentials().filter((c) => c.kind === 'key'),
    );
    return this.info();
  }
  role(req: Request): AccessRole | undefined {
    const bearer = (req.get('authorization') ?? '').replace(/^Bearer /, '');
    if (this.master && bearer && safeEqual(bearer, this.master)) return 'owner';
    if (this.master && !bearer && !req.headers.cookie) return undefined;
    const cookie = (req.headers.cookie ?? '')
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('botbots_session='))
      ?.slice('botbots_session='.length);
    const supplied = bearer || cookie;
    if (supplied) {
      const value = digest(supplied);
      const record = this.credentials().find(
        (c) => safeEqual(c.hash, value) && (!c.expiresAt || Date.parse(c.expiresAt) > Date.now()),
      );
      if (record) return record.role;
      return undefined;
    }
    if (!this.master && trustedLocal(req) && !this.store.config('public-url')) return 'owner';
    return undefined;
  }
  issue(name: string, role: AccessRole, kind: 'key' | 'session' = 'key') {
    const token = `bb_${randomBytes(32).toString('base64url')}`;
    const record: Credential = {
      id: randomBytes(16).toString('hex'),
      name: name.slice(0, 100),
      hash: digest(token),
      role,
      kind,
      createdAt: new Date().toISOString(),
      ...(kind === 'session'
        ? { expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }
        : {}),
    };
    const existing = this.credentials().filter(
      (c) => !c.expiresAt || Date.parse(c.expiresAt) > Date.now(),
    );
    if (existing.length >= 200) throw Error('Revoke an old device or key before adding another.');
    this.store.setConfig('access-credentials', [...existing, record]);
    return { token, ...record, hash: undefined };
  }
  revoke(id: string) {
    this.store.setConfig(
      'access-credentials',
      this.credentials().filter((c) => c.id !== id),
    );
  }
  private rate(req: Request) {
    const key = req.socket.remoteAddress ?? 'unknown',
      now = Date.now();
    for (const [k, v] of this.attempts) if (v.until < now) this.attempts.delete(k);
    if (this.attempts.size > 1000) this.attempts.delete(this.attempts.keys().next().value!);
    const attempt = this.attempts.get(key) ?? { count: 0, until: now + 15 * 60000 };
    if (++attempt.count > 8) throw Error('Too many login attempts. Try again in 15 minutes.');
    this.attempts.set(key, attempt);
  }
  login(req: Request, username: string, password: string) {
    this.rate(req);
    const owner = this.store.config<{ username: string; salt: string; password: string }>(
      'access-owner',
    );
    const calculated = scryptSync(
      password.slice(0, 300),
      owner?.salt ?? 'no-account-configured',
      64,
    ).toString('hex');
    if (!owner || !safeEqual(owner.username, username) || !safeEqual(owner.password, calculated))
      throw Error('Name or password is incorrect.');
    return this.issue(`Login: ${username}`, 'owner', 'session');
  }
  pairing(role: 'operator' | 'viewer') {
    for (const [k, v] of this.pairs) if (v.expires < Date.now()) this.pairs.delete(k);
    this.pairs.clear();
    const code = String(randomInt(100000, 1000000)),
      expires = Date.now() + 5 * 60000;
    this.pairs.set(digest(code), { role, expires, attempts: 0 });
    return { code, expiresAt: new Date(expires).toISOString(), role };
  }
  pair(req: Request, code: string, name: string) {
    this.rate(req);
    for (const [k, v] of this.pairs) {
      v.attempts++;
      if (v.expires < Date.now() || v.attempts > 20) this.pairs.delete(k);
    }
    const key = digest(code),
      pending = this.pairs.get(key);
    if (!pending) throw Error('Pairing code is invalid or expired.');
    this.pairs.delete(key);
    return this.issue(`Device: ${name.slice(0, 80)}`, pending.role, 'session');
  }
  setCookie(res: Response, req: Request, token: string) {
    const publicUrl = this.store.config<string>('public-url') ?? '';
    res.cookie('botbots_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure || (publicUrl.startsWith('https:') && !trustedLocal(req)),
      path: '/',
      maxAge: 30 * 86400000,
    });
  }
  logout(req: Request, res: Response) {
    const token = (req.headers.cookie ?? '')
      .split(';')
      .map((x) => x.trim())
      .find((s) => s.startsWith('botbots_session='))
      ?.slice(16);
    if (token) {
      const found = this.credentials().find((c) => c.hash === digest(token));
      if (found) this.revoke(found.id);
    }
    res.clearCookie('botbots_session', { path: '/' });
  }
  allowed(role: AccessRole, req: Request) {
    if (role === 'owner') return true;
    const path = req.path;
    if (req.method === 'POST' && path === '/api/previews') return true;
    if (/^\/api\/(access|export|import)/.test(path)) return false;
    if (req.method === 'GET') return true;
    if (
      role === 'operator' &&
      req.method === 'PUT' &&
      /^\/api\/conversations\/[^/]+\/model$/.test(path)
    )
      return true;
    return (
      role === 'operator' &&
      req.method === 'POST' &&
      (/^\/api\/runs(?:\/[^/]+\/(?:messages|cancel))?$/.test(path) ||
        /^\/api\/team-conversations(?:\/[^/]+\/bots\/[^/]+)?$/.test(path) ||
        /^\/api\/routines\/[^/]+\/run$/.test(path))
    );
  }
}
