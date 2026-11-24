import { credentialPolicySchema, type Policy } from './credential-policy';
export { credentialPolicySchema } from './credential-policy';
import { CredentialManager } from './credential-manager';
import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { Bot } from '../../packages/shared/types';
import type {
  CredentialAction,
  CredentialCapability,
  CredentialsState,
} from '../../packages/shared/credentials';
import { credentialsDirectory, OsSecrets, FileSecrets, type SecretBackend } from './host-secrets';

const disabled: Policy = {
  version: 1,
  enabled: false,
  storage: 'os',
  allowBotTerminal: false,
  operations: [],
  bindings: [],
  services: [],
};
export function redactSecrets(text: string, values: string[]) {
  for (const value of values.filter(Boolean)) {
    const forms = [
      value,
      encodeURIComponent(value),
      Buffer.from(value).toString('base64'),
      Buffer.from(value).toString('hex'),
      JSON.stringify(value).slice(1, -1),
    ];
    for (const form of forms.sort((a, b) => b.length - a.length))
      text = text.split(form).join('[secret hidden]');
  }
  return text;
}
/** The model gets capability IDs, never a get-secret API. Grants live outside team storage. */
export class Credentials {
  private denied = new Set<string>();
  private actions = new Map<string, CredentialAction>();
  private waits = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      bot: Bot;
      signal: AbortSignal;
      controller: AbortController;
      fingerprint: string;
    }
  >();
  constructor(
    public directory = credentialsDirectory(),
    private suppliedBackend?: SecretBackend,
    private workspace?: string,
    private request = fetch,
  ) {}
  private policy(): Policy {
    try {
      return this.readPolicy();
    } catch {
      throw Error(
        'External credential permissions are invalid or inaccessible. Credential access is blocked.',
      );
    }
  }
  private readPolicy(): Policy {
    const path = join(this.directory, 'permissions.json');
    if (!existsSync(path)) return disabled;
    if (this.workspace) {
      const rel = relative(resolve(this.workspace), resolve(this.directory));
      if (!isAbsolute(rel) && !rel.startsWith('..'))
        throw Error('Credential permissions must live outside the bot workspace.');
    }
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2000000)
      throw Error('Invalid external credential policy.');
    const directory = lstatSync(this.directory);
    if (
      process.platform !== 'win32' &&
      (info.mode & 0o077 ||
        info.uid !== process.getuid!() ||
        directory.mode & 0o077 ||
        directory.uid !== process.getuid!() ||
        directory.isSymbolicLink())
    )
      throw Error('Credential permissions must be owned by the host account with mode 0600.');
    const p = credentialPolicySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    const ids = [
      ...p.bindings.map((b) => b.id),
      ...p.operations.map((o) => o.id),
      ...p.services.map((service) => service.id),
    ];
    if (new Set(ids).size !== ids.length) throw Error('Credential permission IDs must be unique.');
    return p;
  }
  private backend() {
    return (
      this.suppliedBackend ??
      (this.policy().storage === 'file'
        ? new FileSecrets(join(this.directory, 'secrets'))
        : new OsSecrets())
    );
  }
  manager() {
    return new CredentialManager(
      this.directory,
      () => this.policy(),
      () => this.backend(),
      this.workspace,
    );
  }
  serviceCapabilities(bot: Bot) {
    try {
      const p = this.policy();
      return p.enabled && bot.enabled
        ? p.services
            .filter(
              (service) =>
                service.enabled &&
                (service.botIds.includes('*') ||
                  service.botIds.includes(bot.id) ||
                  (!!bot.prototypeId && service.botIds.includes(bot.prototypeId))),
            )
            .map(({ secret: _secret, ...service }) => service)
        : [];
    } catch {
      return [];
    }
  }
  async serviceRequest(
    serviceId: string,
    operationId: string,
    params: Record<string, string>,
    input: Record<string, unknown>,
    bot: Bot,
    signal: AbortSignal,
    zip?: Uint8Array,
    onDispatch?: () => void,
  ) {
    signal.throwIfAborted();
    const permission = this.serviceCapabilities(bot).find((service) => service.id === serviceId);
    if (!permission)
      throw Error(
        'This service connection is unavailable or revoked. Reconnect the API in its private window.',
      );
    const service = this.policy().services.find((service) => service.id === serviceId)!;
    const operation = service.api.operations.find((operation) => operation.id === operationId);
    if (!operation) throw Error('Choose an action from the connected API catalog.');
    const required = [...operation.path.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]);
    if (
      Object.keys(params).some(
        (key) => !required.includes(key) && !operation.queryFields?.includes(key),
      ) ||
      required.some(
        (key) =>
          !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,100}$/.test(params[key] ?? '') || params[key] === '..',
      )
    )
      throw Error('Supply the named API path parameters without URLs or slashes.');
    const path = operation.path.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) =>
      encodeURIComponent(params[key]),
    );
    const query = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).filter(([key]) => operation.queryFields?.includes(key)),
      ),
    );
    const url = `${service.api.baseUrl.replace(/\/$/, '')}${path}${query.size ? `?${query}` : ''}`;
    if (
      operation.inputFields &&
      Object.keys(input).some((key) => !operation.inputFields!.includes(key))
    )
      throw Error('These fields are not part of this API action.');
    if (operation.body === 'none' && Object.keys(input).length)
      throw Error('This API action has no request body.');
    if (operation.body === 'page-zip' && !zip)
      throw Error('Deployments require a saved page ID so the host can package the ZIP.');
    const secret = this.backend().get(service.secret);
    if (!secret || /[^\x21-\x7e]/.test(secret))
      throw Error('The saved API token is missing or revoked in the operating system.');
    const auth = service.api.authType === 'bearer' ? `Bearer ${secret}` : secret;
    const body =
      operation.body === 'page-zip'
        ? Buffer.from(zip!)
        : operation.body === 'json'
          ? Buffer.from(JSON.stringify(input))
          : undefined;
    if (body && body.length > 1000000)
      throw Error('This API upload exceeds the one-megabyte saved-page limit.');
    const headers: Record<string, string> = {
      Accept: 'application/json',
      [service.api.authType === 'header' ? (service.api.header ?? 'X-API-Key') : 'Authorization']:
        auth,
      ...(body
        ? {
            'Content-Type': operation.body === 'page-zip' ? 'application/zip' : 'application/json',
            'Content-Length': String(body.length),
          }
        : {}),
    };
    let response: Response;
    try {
      onDispatch?.();
      response = await this.request(url, {
        method: operation.method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
      });
    } catch {
      throw Error('The connected API could not be reached. The saved token was not exposed.');
    }
    if (!response.ok)
      throw Error(
        `The connected API returned HTTP ${response.status}${response.status === 401 || response.status === 403 ? ': the service rejected this token or its access' : ''}. The connection exists; this is a service response, not a request to re-enter the key.`,
      );
    if (response.status === 204 || operation.method === 'HEAD')
      return { ok: true, status: response.status };
    const reader = response.body?.getReader();
    let text = '',
      bytes = 0;
    const decoder = new TextDecoder();
    if (reader)
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 1000000) {
          await reader.cancel();
          throw Error('The API response is too large.');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    text += decoder.decode();
    let raw: unknown;
    try {
      raw = JSON.parse(text || '{}');
    } catch {
      throw Error('The connected API did not return valid JSON.');
    }
    const safe = (value: unknown, depth = 0): unknown =>
      depth > 6
        ? '[Nested result omitted]'
        : Array.isArray(value)
          ? value.slice(0, 100).map((item) => safe(item, depth + 1))
          : value && typeof value === 'object'
            ? Object.fromEntries(
                Object.entries(value)
                  .filter(
                    ([key]) =>
                      !/token|secret|password|authorization|cookie|credential|private.?key|api.?key/i.test(
                        key,
                      ),
                  )
                  .slice(0, 100)
                  .map(([key, item]) => [key, safe(item, depth + 1)]),
              )
            : typeof value === 'string'
              ? value.slice(0, 8000)
              : value;
    const serialized = redactSecrets(JSON.stringify(safe(raw)), [secret, auth]);
    if (serialized.length > 64000)
      throw Error('The filtered API response is too large; narrow this action.');
    return JSON.parse(serialized);
  }
  botTerminalBlocked() {
    try {
      const p = this.policy();
      return existsSync(join(this.directory, 'permissions.json')) && !p.allowBotTerminal;
    } catch {
      return true;
    }
  }
  capabilities(bot?: Bot): CredentialCapability[] {
    try {
      const p = this.policy();
      return p.enabled
        ? p.operations
            .filter(
              (o) =>
                o.enabled &&
                (!bot ||
                  o.botIds.includes('*') ||
                  o.botIds.includes(bot.id) ||
                  (!!bot.prototypeId && o.botIds.includes(bot.prototypeId))),
            )
            .map((o) => ({
              id: o.id,
              label: o.label,
              method: o.method,
              destination: o.url,
              inputFields: o.inputFields,
            }))
        : [];
    } catch {
      return [];
    }
  }
  state(): CredentialsState {
    try {
      const p = this.policy();
      return {
        configured: existsSync(join(this.directory, 'permissions.json')),
        enabled: p.enabled,
        backend: this.backend().kind,
        directory: this.directory,
        botTerminalBlocked: this.botTerminalBlocked(),
        capabilities: this.capabilities(),
        actions: [...this.actions.values()].reverse().slice(0, 30),
      };
    } catch {
      return {
        configured: true,
        enabled: false,
        backend: 'Unavailable',
        directory: this.directory,
        botTerminalBlocked: true,
        capabilities: [],
        actions: [...this.actions.values()].reverse(),
        error:
          'The external credential policy is invalid or inaccessible. No credential operation is permitted.',
      };
    }
  }
  binding(id: string, purpose: 'model' | 'alert', url: string) {
    const p = this.policy(),
      b = p.bindings.find((b) => b.id === id);
    if (
      !p.enabled ||
      !b ||
      b.enabled === false ||
      b.purpose !== purpose ||
      new URL(b.url).toString().replace(/\/$/, '') !== new URL(url).toString().replace(/\/$/, '')
    )
      throw Error(
        'External credential permission is missing, revoked, or for a different destination.',
      );
    const value = this.backend().get(b.secret);
    if (!value) throw Error('The OS credential is missing, locked, or revoked.');
    if (/[^\x21-\x7e]/.test(value))
      throw Error('This API credential is not suitable for an HTTP authentication header.');
    return value;
  }
  vaultKey(dir: string) {
    const keyAlias = `google-vault-${createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 24)}`;
    return (create: boolean) => {
      const backend = this.backend(),
        saved = backend.get(keyAlias);
      const legacy = join(dir, 'master.key');
      if (saved) {
        const key = Buffer.from(saved, 'base64');
        if (key.length !== 32) throw Error('Invalid OS vault key.');
        if (existsSync(legacy)) {
          if (!readFileSync(legacy).equals(key))
            throw Error(
              'The legacy and OS vault keys conflict; restore the correct credential outside Bot-Bots.',
            );
          unlinkSync(legacy);
        }
        return key;
      }
      if (existsSync(legacy)) {
        const key = readFileSync(legacy);
        if (key.length !== 32) throw Error('Invalid legacy vault key.');
        backend.set(keyAlias, key.toString('base64'));
        if (backend.get(keyAlias) !== key.toString('base64'))
          throw Error('OS vault verification failed.');
        unlinkSync(legacy);
        return key;
      }
      if (!create)
        throw Error(
          'The OS vault key is missing or revoked. Reconnect this account after restoring access outside Bot-Bots.',
        );
      const key = randomBytes(32);
      backend.set(keyAlias, key.toString('base64'));
      return key;
    };
  }
  requestUse(operationId: string, input: unknown, bot: Bot, runId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.denied.has(`${runId}:${bot.id}:${operationId}`))
      throw Error('The human denied this operation in this run. Do not request it again.');
    const operation = this.operation(operationId, bot);
    const payload = z.record(z.string(), z.unknown()).parse(input ?? {});
    if (
      JSON.stringify(payload).length > 16000 ||
      Object.keys(payload).some((k) => !operation.inputFields.includes(k))
    )
      throw Error('This credential operation does not allow those input fields.');
    if (operation.method === 'GET' && Object.keys(payload).length)
      throw Error('This read operation does not accept a request body.');
    const action: CredentialAction = {
      id: randomUUID(),
      operationId,
      label: operation.label,
      botId: bot.id,
      runId,
      input: structuredClone(payload),
      method: operation.method,
      destination: operation.url,
      status: 'awaiting-approval',
      createdAt: new Date().toISOString(),
    };
    this.actions.set(action.id, action);
    const fingerprint = JSON.stringify(operation);
    for (const old of [...this.actions.values()].slice(0, -99))
      if (!['awaiting-approval', 'running'].includes(old.status)) this.actions.delete(old.id);
    const pending = new Promise<unknown>((resolve, reject) =>
      this.waits.set(action.id, {
        resolve,
        reject,
        bot,
        signal,
        controller: new AbortController(),
        fingerprint,
      }),
    );
    const abort = () => this.cancel(action.id);
    signal.addEventListener('abort', abort, { once: true });
    return pending.finally(() => signal.removeEventListener('abort', abort));
  }
  private operation(id: string, bot: Bot) {
    const p = this.policy(),
      o = p.operations.find((o) => o.id === id);
    if (
      !p.enabled ||
      !o?.enabled ||
      !bot.enabled ||
      !(
        o.botIds.includes('*') ||
        o.botIds.includes(bot.id) ||
        (!!bot.prototypeId && o.botIds.includes(bot.prototypeId))
      )
    )
      throw Error(
        'This credential operation is not granted to this bot, or has been revoked outside Bot-Bots.',
      );
    return o;
  }
  async decide(id: string, approve: boolean) {
    const a = this.actions.get(id),
      wait = this.waits.get(id);
    if (!a || !wait || a.status !== 'awaiting-approval')
      throw Error('This credential request is no longer awaiting approval.');
    if (!approve) {
      this.denied.add(`${a.runId}:${a.botId}:${a.operationId}`);
      a.status = 'denied';
      a.finishedAt = new Date().toISOString();
      this.waits.delete(id);
      wait.reject(Error('The human denied this credential operation.'));
      return a;
    }
    a.status = 'running';
    try {
      wait.signal.throwIfAborted();
      const o = this.operation(a.operationId, wait.bot);
      if (JSON.stringify(o) !== wait.fingerprint)
        throw Error('External permission changed; request fresh approval.');
      const secret = this.backend().get(o.auth.secret);
      if (!secret || (o.auth.type !== 'basic' && /[^\x20-\x7e]/.test(secret)))
        throw Error(
          'The OS credential is missing, locked, revoked, or unsuitable for this authentication method.',
        );
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      const auth =
        o.auth.type === 'basic'
          ? `Basic ${Buffer.from(`${o.auth.username}:${secret}`).toString('base64')}`
          : o.auth.type === 'bearer'
            ? `Bearer ${secret}`
            : secret;
      headers[o.auth.type === 'header' ? o.auth.header : 'Authorization'] = auth;
      const response = await this.request(o.url, {
        method: o.method,
        headers,
        body: o.method === 'GET' ? undefined : JSON.stringify(a.input),
        redirect: 'error',
        signal: AbortSignal.any([wait.signal, wait.controller.signal, AbortSignal.timeout(30000)]),
      });
      if (!response.ok)
        throw Error(
          `Authenticated service returned HTTP ${response.status}. Response details are withheld to protect credentials.`,
        );
      if (!/application\/(?:[\w.+-]*\+)?json/i.test(response.headers.get('content-type') ?? ''))
        throw Error('This operation requires a JSON response.');
      const reader = response.body?.getReader();
      let data = '',
        bytes = 0;
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1000000) {
            await reader.cancel();
            throw Error('Authenticated response exceeded the safe size limit.');
          }
          data += decoder.decode(value, { stream: true });
        }
        data += decoder.decode();
      }
      const raw = JSON.parse(data || '{}');
      const scalar = (v: unknown): unknown =>
        v === null || ['string', 'number', 'boolean'].includes(typeof v)
          ? v
          : '[Nested content withheld]';
      const project = (v: unknown) =>
        Object.fromEntries(
          o.responseFields
            .filter((k) => v && typeof v === 'object' && Object.hasOwn(v, k))
            .map((k) => [k, scalar((v as Record<string, unknown>)[k])]),
        );
      const safe = Array.isArray(raw) ? raw.slice(0, 100).map(project) : project(raw);
      const serialized = redactSecrets(JSON.stringify(safe), [
        secret,
        auth,
        o.auth.type === 'basic' ? `${o.auth.username}:${secret}` : '',
      ]);
      if (serialized.length > 20000)
        throw Error('Projected response is too large. Narrow the external response fields.');
      wait.signal.throwIfAborted();
      wait.controller.signal.throwIfAborted();
      a.status = 'completed';
      a.result = JSON.parse(serialized);
      wait.resolve(a.result);
    } catch (error) {
      a.status = wait.signal.aborted || wait.controller.signal.aborted ? 'cancelled' : 'failed';
      // Never relay transport/parser/OS errors; they may embed secret-bearing values.
      a.error =
        'Credential operation stopped or failed. Check the external grant, OS credential, and service status; no raw authentication details were returned.';
      wait.reject(Error(a.error));
    } finally {
      a.finishedAt = new Date().toISOString();
      this.waits.delete(id);
    }
    return a;
  }
  cancel(id: string) {
    const a = this.actions.get(id),
      w = this.waits.get(id);
    if (!a || !w) return;
    w.controller.abort();
    a.status = 'cancelled';
    a.finishedAt = new Date().toISOString();
    this.waits.delete(id);
    w.reject(Error('Credential operation cancelled. No permission is retained.'));
  }
  cancelRun(runId?: string) {
    for (const a of this.actions.values()) if (!runId || a.runId === runId) this.cancel(a.id);
  }
}
