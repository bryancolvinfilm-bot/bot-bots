import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { credentialPolicySchema, type Policy } from './credential-policy';
import { secretAlias, type SecretBackend } from './host-secrets';
import type { CredentialManagerState, SavedSecret } from '../../packages/shared/credentials';
import { serviceApiSchema } from './service-api-schema';

const alias = z
  .string()
  .regex(secretAlias)
  .refine((value) => !value.toLowerCase().startsWith('google-vault-'));
const secretRecord = z.object({
  id: alias,
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['api-key', 'password']),
  updatedAt: z.string().datetime(),
});
const catalogSchema = z.object({ version: z.literal(1), secrets: z.array(secretRecord).max(200) });
const targetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('store') }).strict(),
  z
    .object({
      type: z.literal('service'),
      api: serviceApiSchema,
      botIds: z.array(z.string().min(1)).min(1).max(100).default(['*']),
      approval: z.literal('connected').default('connected'),
    })
    .strict(),
  z
    .object({
      type: z.literal('model'),
      providerId: z.string().optional(),
      provider: z
        .object({
          name: z.string().trim().min(1).max(100),
          kind: z.enum(['openai-compatible', 'openai-responses', 'anthropic']),
          baseUrl: z.string().url(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('alert'), channel: z.enum(['email', 'sms']), url: z.string().url() })
    .strict(),
  z
    .object({
      type: z.literal('operation'),
      label: z.string().trim().min(1).max(120),
      url: z.string().url(),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      authType: z.enum(['bearer', 'header', 'basic']),
      header: z.string().max(64).optional(),
      username: z.string().max(200).optional(),
      botIds: z.array(z.string().min(1)).min(1).max(100),
      inputFields: z.array(z.string()).max(20),
      responseFields: z.array(z.string()).min(1).max(30),
    })
    .strict(),
]);
export const saveSecretSchema = z
  .object({
    version: z.string().length(64),
    id: alias.optional(),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['api-key', 'password']),
    value: z.string().max(4096).optional(),
    requestId: z.string().uuid().optional(),
    target: targetSchema,
  })
  .strict();
export type SaveSecret = z.infer<typeof saveSecretSchema>;
type Metadata = z.infer<typeof secretRecord>;

export class CredentialManagerError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
/** Owner-only write surface. There is deliberately no method to return a secret value. */
export class CredentialManager {
  constructor(
    private directory: string,
    private policy: () => Policy,
    private backend: () => SecretBackend,
    private workspace?: string,
  ) {}
  private bytes(file: string) {
    const path = join(this.directory, file);
    if (!existsSync(path)) return '';
    const info = lstatSync(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 2000000 ||
      (process.platform !== 'win32' && (info.mode & 0o077 || info.uid !== process.getuid!()))
    )
      throw new CredentialManagerError(
        'Credential controls are unavailable. Check their ownership and permissions.',
      );
    return readFileSync(path, 'utf8');
  }
  private ensureDirectory() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== 'win32' && (info.mode & 0o077 || info.uid !== process.getuid!()))
    )
      throw new CredentialManagerError(
        'The credential directory must be private and owned by the host account.',
      );
    if (this.workspace) {
      const workspace = existsSync(this.workspace)
        ? realpathSync(this.workspace)
        : resolve(this.workspace);
      const rel = relative(workspace, realpathSync(this.directory));
      if (!isAbsolute(rel) && !rel.startsWith('..'))
        throw new CredentialManagerError(
          'Secrets must be stored outside the shared bot workspace.',
        );
    }
  }
  private version() {
    return createHash('sha256')
      .update(this.bytes('permissions.json'))
      .update('\0')
      .update(this.bytes('manager.json'))
      .digest('hex');
  }
  private check(version: string) {
    if (version !== this.version())
      throw new CredentialManagerError(
        'Credential settings changed. Reload this window before saving.',
        409,
      );
  }
  private records(): Metadata[] {
    const text = this.bytes('manager.json');
    return text ? catalogSchema.parse(JSON.parse(text)).secrets : [];
  }
  private write(file: string, value: unknown) {
    this.ensureDirectory();
    this.bytes(file); // Validate an existing destination before replacing it.
    const temporary = join(this.directory, `.${file}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, join(this.directory, file));
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  private known(policy: Policy) {
    const records = this.records();
    const ids = new Set(records.map((entry) => entry.id));
    for (const grant of [
      ...policy.bindings.map((binding) => ({ secret: binding.secret, kind: 'api-key' as const })),
      ...policy.operations.map((operation) => ({
        secret: operation.auth.secret,
        kind: operation.auth.type === 'basic' ? ('password' as const) : ('api-key' as const),
      })),
      ...policy.services.map((service) => ({ secret: service.secret, kind: 'api-key' as const })),
    ])
      if (!ids.has(grant.secret) && !grant.secret.toLowerCase().startsWith('google-vault-')) {
        records.push({
          id: grant.secret,
          name: grant.secret,
          kind: grant.kind,
          updatedAt: new Date(0).toISOString(),
        });
        ids.add(grant.secret);
      }
    return records;
  }
  state(): CredentialManagerState {
    const policy = this.policy(),
      backend = this.backend();
    const secrets: SavedSecret[] = this.known(policy).map((entry) => ({
      ...entry,
      present: backend.get(entry.id) !== null,
    }));
    return {
      version: this.version(),
      backend: backend.kind,
      enabled: policy.enabled,
      secrets,
      connections: [
        ...policy.services.map((service) => ({
          id: service.id,
          secretId: service.secret,
          label: service.api.name,
          purpose: 'service' as const,
          url: service.api.baseUrl,
          enabled: policy.enabled && service.enabled,
          botIds: service.botIds,
          api: service.api,
        })),
        ...policy.bindings.map((binding) => ({
          id: binding.id,
          secretId: binding.secret,
          label: binding.purpose === 'model' ? 'Model connection' : 'Alert connection',
          purpose: binding.purpose,
          url: binding.url,
          enabled: policy.enabled && binding.enabled !== false,
        })),
        ...policy.operations.map((operation) => ({
          id: operation.id,
          secretId: operation.auth.secret,
          label: operation.label,
          purpose: 'operation' as const,
          url: operation.url,
          enabled: policy.enabled && operation.enabled,
          botIds: operation.botIds,
        })),
      ],
    };
  }
  shareApiConnections() {
    const policy = this.policy();
    const kinds = new Map(this.known(policy).map((entry) => [entry.id, entry.kind]));
    const shared = (ids: string[]) => ids.length === 1 && ids[0] === '*';
    if (
      policy.services.every((service) => shared(service.botIds)) &&
      policy.operations.every(
        (operation) =>
          (operation.auth.type === 'basic' && kinds.get(operation.auth.secret) !== 'api-key') ||
          shared(operation.botIds),
      )
    )
      return false;
    const version = this.version();
    this.ensureDirectory();
    this.check(version);
    this.write('permissions.json', {
      ...policy,
      services: policy.services.map((service) => ({ ...service, botIds: ['*'] })),
      operations: policy.operations.map((operation) =>
        operation.auth.type !== 'basic' || kinds.get(operation.auth.secret) === 'api-key'
          ? { ...operation, botIds: ['*'] }
          : operation,
      ),
    });
    return true;
  }
  save(input: SaveSecret, connection?: { purpose: 'model' | 'alert'; url: string }) {
    this.check(input.version);
    const before = this.policy(),
      records = this.known(before);
    const existing = input.id ? records.find((entry) => entry.id === input.id) : undefined;
    if (input.id && !existing)
      throw new CredentialManagerError('That saved secret no longer exists.', 404);
    const id = existing?.id ?? `secret-${randomUUID()}`;
    const backend = this.backend();
    const oldValue = existing ? backend.get(id) : null;
    const value = input.value || oldValue;
    if (!value || Buffer.byteLength(value) > 4096 || /[\0\r\n]/.test(value))
      throw new CredentialManagerError('Enter a secret of up to 4096 bytes without line breaks.');
    if (
      (input.kind === 'api-key' ||
        connection ||
        (input.target.type === 'operation' && input.target.authType !== 'basic')) &&
      /[^\x21-\x7e]/.test(value)
    )
      throw new CredentialManagerError(
        'This API key must contain printable characters without spaces.',
      );
    let next = structuredClone(before);
    next.allowBotTerminal = false;
    const hasGrant =
      !!connection || input.target.type === 'operation' || input.target.type === 'service';
    if (hasGrant && !next.enabled) {
      // Connecting a new service must not silently reactivate previously revoked grants.
      next.bindings = next.bindings.map((binding) => ({ ...binding, enabled: false }));
      next.operations = next.operations.map((operation) => ({ ...operation, enabled: false }));
      next.services = next.services.map((service) => ({ ...service, enabled: false }));
      next.enabled = true;
    }
    const grantId = hasGrant ? `connection-${randomUUID()}` : undefined;
    if (input.target.type === 'service') {
      const t = input.target;
      next.services = next.services.filter(
        (service) =>
          service.secret !== id ||
          service.api.id !== t.api.id ||
          service.api.baseUrl !== t.api.baseUrl,
      );
      next.services.push({
        id: grantId!,
        secret: id,
        api: t.api,
        enabled: true,
        botIds: ['*'],
        approval: t.approval,
      });
      next.operations = next.operations.map((operation) =>
        operation.url.startsWith(`${t.api.baseUrl.replace(/\/$/, '')}/`) &&
        operation.botIds.some((botId) => t.botIds.includes(botId) || t.botIds.includes('*'))
          ? { ...operation, enabled: false }
          : operation,
      );
    }
    if (connection) next.bindings.push({ id: grantId!, secret: id, ...connection, enabled: true });
    if (input.target.type === 'operation') {
      const t = input.target;
      next.operations.push({
        id: grantId!,
        label: t.label,
        enabled: true,
        botIds: input.kind === 'api-key' || t.authType !== 'basic' ? ['*'] : t.botIds,
        url: t.url,
        method: t.method,
        auth:
          t.authType === 'basic'
            ? { type: 'basic', secret: id, username: t.username ?? '' }
            : t.authType === 'header'
              ? { type: 'header', secret: id, header: t.header ?? '' }
              : { type: 'bearer', secret: id },
        inputFields: t.inputFields,
        responseFields: t.responseFields,
      });
    }
    next = credentialPolicySchema.parse(next);
    if (Buffer.byteLength(JSON.stringify(next)) > 2000000)
      throw new CredentialManagerError(
        'The API catalog is too large. Keep endpoint metadata compact.',
      );
    const metadata: Metadata = {
      id,
      name: input.name,
      kind: input.kind,
      updatedAt: new Date().toISOString(),
    };
    const nextRecords = [...records.filter((entry) => entry.id !== id), metadata];
    catalogSchema.parse({ version: 1, secrets: nextRecords });
    const publicFields = [
      input.name,
      connection?.url ?? '',
      ...(input.target.type === 'service' ? [JSON.stringify(input.target.api)] : []),
      input.target.type === 'model' ? (input.target.provider?.name ?? '') : '',
      ...(input.target.type === 'operation'
        ? [
            input.target.label,
            input.target.url,
            input.target.username ?? '',
            input.target.header ?? '',
            ...input.target.inputFields,
            ...input.target.responseFields,
          ]
        : []),
    ];
    if (
      value.length >= 8 &&
      [value, encodeURIComponent(value), Buffer.from(value).toString('base64')].some((form) =>
        publicFields.some((field) => field.includes(form)),
      )
    )
      throw new CredentialManagerError(
        'Keep the secret value only in the private value field, not in names, usernames or URLs.',
      );
    this.ensureDirectory();
    this.check(input.version);
    // Block new bot terminal executions before putting a new secret into the OS store.
    this.write('permissions.json', { ...before, allowBotTerminal: false });
    try {
      backend.set(id, value);
      if (backend.get(id) !== value) throw new Error('Storage verification failed.');
      this.write('manager.json', { version: 1, secrets: nextRecords });
      this.write('permissions.json', next);
    } catch {
      // Leave permissions in the safer blocked state if storage fails; never echo native errors.
      try {
        if (oldValue !== null) backend.set(id, oldValue);
        else backend.delete(id);
      } catch {
        /* Remains revoked. */
      }
      throw new CredentialManagerError(
        'The secret could not be saved. Check that the host credential store is available.',
        503,
      );
    }
    return { id, grantId };
  }
  remove(id: string, version: string) {
    alias.parse(id);
    this.check(version);
    const policy = this.policy(),
      records = this.known(policy);
    if (!records.some((entry) => entry.id === id))
      throw new CredentialManagerError('That saved secret no longer exists.', 404);
    this.ensureDirectory();
    // Revoke grants before deleting the value, even if the OS later refuses deletion.
    this.write('permissions.json', {
      ...policy,
      allowBotTerminal: false,
      bindings: policy.bindings.filter((binding) => binding.secret !== id),
      operations: policy.operations.filter((operation) => operation.auth.secret !== id),
      services: policy.services.filter((service) => service.secret !== id),
    });
    try {
      this.backend().delete(id);
    } catch {
      throw new CredentialManagerError(
        'Access was revoked, but the OS store could not remove the secret.',
        503,
      );
    }
    this.write('manager.json', { version: 1, secrets: records.filter((entry) => entry.id !== id) });
    return { removed: true };
  }
  revoke(id: string, version: string) {
    alias.parse(id);
    this.check(version);
    const policy = this.policy();
    this.ensureDirectory();
    this.write('permissions.json', {
      ...policy,
      bindings: policy.bindings.filter((binding) => binding.id !== id),
      operations: policy.operations.filter((operation) => operation.id !== id),
      services: policy.services.filter((service) => service.id !== id),
    });
    return { revoked: true };
  }
}
