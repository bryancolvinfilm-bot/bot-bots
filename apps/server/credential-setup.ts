import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CredentialSetup } from '../../packages/shared/credential-setup';
import { credentialService } from '../../packages/shared/credential-setup';
import { Store } from './store';
import { TeamConversations } from './team-conversations';
import { credentialPolicySchema } from './credential-policy';
import { serviceApiSchema } from './service-api-schema';

const publicText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (value) =>
        !/\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{15,}|Bearer\s+\S+)|[A-Za-z0-9_-]{55,}/i.test(
          value,
        ),
      'Use a service name or purpose, never a secret value.',
    );
export const setupInput = z
  .object({
    botId: z.string().min(1),
    conversationId: z.string().optional(),
    runId: z.string().optional(),
    service: publicText(100).default(''),
    purpose: publicText(500).default('Connect this service privately'),
    kind: z.enum(['api-key', 'password']).default('api-key'),
    api: serviceApiSchema.optional(),
    connection: z
      .object({
        type: z.literal('operation'),
        url: z
          .string()
          .url()
          .refine((value) => {
            const u = new URL(value);
            return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
          }),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        authType: z.enum(['bearer', 'header', 'basic']),
        header: z.string().max(64).optional(),
        inputFields: z.array(z.string().max(64)).max(20),
        responseFields: z.array(z.string().max(64)).min(1).max(30),
      })
      .strict()
      .refine(
        (connection) =>
          credentialPolicySchema.safeParse({
            version: 1,
            enabled: true,
            operations: [
              {
                id: 'setup',
                label: 'Service setup',
                enabled: true,
                botIds: ['bot'],
                url: connection.url,
                method: connection.method,
                inputFields: connection.inputFields,
                responseFields: connection.responseFields,
                auth:
                  connection.authType === 'basic'
                    ? { type: 'basic', secret: 'private', username: '' }
                    : connection.authType === 'header'
                      ? {
                          type: 'header',
                          secret: 'private',
                          header: connection.header ?? 'X-API-Key',
                        }
                      : { type: 'bearer', secret: 'private' },
              },
            ],
          }).success,
        'Propose a safe operation with non-secret result fields.',
      )
      .optional(),
  })
  .strict();
export const setupRecordSchema = setupInput.extend({
  id: z.string().uuid(),
  conversationId: z.string().min(1),
  source: z.enum(['human', 'bot']),
  status: z.enum(['awaiting-entry', 'saved', 'cancelled']),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  secretId: z.string().max(96).optional(),
  grantId: z.string().max(200).optional(),
  connected: z.boolean().optional(),
  providerId: z.string().max(200).optional(),
});

/** Requests contain setup metadata only. Values go exclusively to the OS-backed manager. */
export class CredentialSetups {
  constructor(private store: Store) {
    for (const request of this.list())
      if (request.status === 'awaiting-entry') this.finish(request.id, 'cancelled');
  }
  list() {
    return this.store.all('credentialSetups');
  }
  create(input: z.input<typeof setupInput>, source: CredentialSetup['source']) {
    const data = setupInput.parse(input),
      bot = this.store.get('bots', data.botId);
    if (!bot?.enabled || bot.archivedAt || bot.deletedAt)
      throw Error('Choose an available bot for credential setup.');
    let conversation = data.conversationId
      ? this.store.get('conversations', data.conversationId)
      : undefined;
    if (data.conversationId && conversation?.botId !== bot.id)
      throw Error('Conversation does not belong to this bot.');
    if (!conversation)
      conversation = this.store.put('conversations', {
        id: randomUUID(),
        botId: bot.id,
        title: 'Private connection setup',
        createdAt: new Date().toISOString(),
      });
    conversation = new TeamConversations(this.store).adopt(conversation);
    if (data.runId) {
      const run = this.store.get('runs', data.runId);
      if (
        !run ||
        run.status !== 'running' ||
        (source === 'human'
          ? run.conversationId !== conversation.id
          : !run.work?.some((work) => work.botId === bot.id && work.status === 'running'))
      )
        throw Error('Choose the active task for this connection.');
    }
    const existing = this.list().find(
      (request) =>
        request.botId === bot.id &&
        request.conversationId === conversation.id &&
        request.status === 'awaiting-entry',
    );
    if (existing) return existing;
    const preset = credentialService(data.service);
    const request: CredentialSetup = {
      ...data,
      service: data.service || data.api?.name || '',
      id: randomUUID(),
      conversationId: conversation.id,
      source,
      status: 'awaiting-entry',
      createdAt: new Date().toISOString(),
      ...(preset.providerId ? { providerId: preset.providerId } : {}),
    };
    this.store.put('credentialSetups', request);
    return request;
  }
  pending(id: string) {
    const request = this.store.get('credentialSetups', id);
    if (!request || request.status !== 'awaiting-entry')
      throw Error('This private entry request is no longer waiting. Open a new one from chat.');
    return request;
  }
  finish(
    id: string,
    status: 'saved' | 'cancelled',
    result: Partial<
      Pick<CredentialSetup, 'secretId' | 'grantId' | 'connected' | 'service' | 'kind' | 'api'>
    > = {},
  ) {
    const request = this.pending(id);
    return this.store.put('credentialSetups', {
      ...request,
      ...result,
      status,
      finishedAt: new Date().toISOString(),
    });
  }
  cancelRun(runId: string) {
    for (const request of this.list())
      if (request.runId === runId && request.status === 'awaiting-entry')
        this.finish(request.id, 'cancelled');
  }
  async wait(id: string, signal: AbortSignal) {
    const deadline = Date.now() + 10 * 60000;
    while (true) {
      signal.throwIfAborted();
      const request = this.store.get('credentialSetups', id)!;
      if (request.status !== 'awaiting-entry')
        return {
          requestId: id,
          status: request.status,
          connected: !!request.connected,
          credentialId: request.grantId,
          notice:
            request.status === 'saved'
              ? request.connected
                ? request.api
                  ? 'Saved privately and connected for the complete API catalog. No secret value was returned. Use service_call or page_publish now; the same token covers all listed actions without another endpoint grant.'
                  : 'Saved privately and connected. No secret value was returned. Use only granted operations; exact action approval still applies.'
                : 'Saved privately. No service operation is connected yet. Storage alone grants no bot access. No secret value was returned.'
              : 'The human cancelled private entry. Do not request it again during this task.',
        };
      if (Date.now() >= deadline) {
        this.finish(id, 'cancelled');
        throw Error('Private entry timed out. No secret was read.');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
