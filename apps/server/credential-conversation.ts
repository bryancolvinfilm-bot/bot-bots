import {
  apiKeyValue,
  credentialService,
  wantsPrivateEntry,
} from '../../packages/shared/credential-setup';
import { knownApi } from '../../packages/shared/service-api';
import { Credentials } from './credentials';
import { CredentialSetups } from './credential-setup';
import { Services } from './services';
import { Store } from './store';

export class CredentialConversation {
  constructor(
    private store: Store,
    private credentials: Credentials,
    private services: Services,
    private setups: CredentialSetups,
  ) {}
  accepts(text: string, conversationId?: string) {
    if (wantsPrivateEntry(text)) return true;
    const context = this.store
      .all('messages')
      .filter((message) => message.conversationId === conversationId)
      .slice(-12);
    if (
      this.setups
        .list()
        .some(
          (request) =>
            request.conversationId === conversationId &&
            request.status === 'awaiting-entry' &&
            request.kind === 'api-key',
        ) &&
      apiKeyValue(text, true)
    )
      return true;
    if (
      context.some((message) => credentialService(message.content).service) &&
      apiKeyValue(text, true)
    )
      return true;
    const previous = this.setups
      .list()
      .findLast(
        (request) =>
          request.conversationId === conversationId &&
          request.secretId &&
          !request.connected &&
          request.status === 'saved',
      );
    return (
      !!previous &&
      text.length < 300 &&
      !/\b(?:make|build|publish|post|deploy|write)\b/i.test(text) &&
      !!credentialService(text).service
    );
  }
  handle(input: { botId: string; conversationId?: string; runId?: string; text: string }) {
    const prior = this.setups
      .list()
      .findLast(
        (request) =>
          request.conversationId === input.conversationId &&
          request.secretId &&
          !request.connected &&
          request.status === 'saved',
      );
    const context = this.store
      .all('messages')
      .filter((message) => message.conversationId === input.conversationId)
      .slice(-12);
    const pending = this.setups
      .list()
      .findLast(
        (request) =>
          request.botId === input.botId &&
          request.conversationId === input.conversationId &&
          request.status === 'awaiting-entry',
      );
    let preset = credentialService(input.text);
    if (!preset.service && pending) preset = credentialService(pending.service);
    if (!preset.service)
      preset = credentialService(
        context.findLast((message) => credentialService(message.content).service)?.content ?? '',
      );
    const api =
      pending?.api ?? this.services.apiFor(preset.service, input.botId, input.conversationId);
    const value = apiKeyValue(input.text, !!api || !!prior || pending?.kind === 'api-key');
    const state = this.credentials.manager().state();
    const bot = this.store.get('bots', input.botId);
    if (!bot) throw Error('Choose an available bot.');
    const connected = api ? this.services.connection(bot, '', api.id) : undefined;
    const connection = connected
      ? state.connections.find((connection) => connection.id === connected.id)
      : undefined;
    const secret = state.secrets.find(
      (secret) =>
        secret.present &&
        (secret.id === prior?.secretId ||
          secret.id === connection?.secretId ||
          (preset.service &&
            (secret.name.toLowerCase() === preset.service.toLowerCase() ||
              (!!api && knownApi(secret.name)?.id === api.id)))),
    );
    const request =
      pending ??
      this.setups.create(
        {
          botId: input.botId,
          conversationId: input.conversationId,
          runId: input.runId,
          service: api?.name ?? preset.service,
          api,
          kind: /\bpassword\b/i.test(input.text) ? 'password' : 'api-key',
          purpose: 'Connect this service for the whole team from our conversation',
        },
        'human',
      );
    if (request.kind === 'password')
      return { credentialRequest: request, conversationId: request.conversationId };
    if (!this.store.get('messages', `private-${request.id}`))
      this.store.put('messages', {
        id: `private-${request.id}`,
        botId: bot.id,
        conversationId: request.conversationId,
        role: 'user',
        content: `Connect ${api?.name ?? (preset.service || 'my API key')} privately for all bots. The secret value is omitted.`,
        createdAt: request.createdAt,
      });
    if (!value && connected && connection)
      return this.finish(
        request.id,
        connection.secretId,
        connection.id,
        api?.name ?? preset.service,
        true,
      );
    if (!value && !secret)
      return { credentialRequest: request, conversationId: request.conversationId };
    const name = api?.name ?? (preset.service || pending?.service || 'Shared API key');
    let target: any = api
      ? { type: 'service', api, botIds: ['*'], approval: 'connected' }
      : { type: 'store' };
    let provider;
    if (!api && pending?.connection && pending.kind === 'api-key')
      target = {
        ...pending.connection,
        label: pending.service || 'Shared API connection',
        botIds: ['*'],
      };
    if (preset.providerId) {
      const existing = this.store.get('providers', preset.providerId);
      provider = existing ?? {
        id: preset.providerId,
        name: preset.providerId === 'openai' ? 'OpenAI' : 'Claude',
        kind:
          preset.providerId === 'openai' ? ('openai-compatible' as const) : ('anthropic' as const),
        baseUrl:
          preset.providerId === 'openai'
            ? 'https://api.openai.com/v1'
            : 'https://api.anthropic.com/v1',
        apiKeyEnv: '',
        enabled: true,
        local: false,
        timeoutMs: 180000,
        autoDiscover: false,
      };
      target = { type: 'model', providerId: provider.id };
    }
    const saved = this.credentials.manager().save(
      {
        version: state.version,
        ...(secret ? { id: secret.id } : {}),
        name,
        kind: 'api-key',
        ...(value ? { value } : {}),
        target,
      },
      provider ? { purpose: 'model', url: provider.baseUrl } : undefined,
    );
    if (provider) this.store.put('providers', { ...provider, credentialId: saved.grantId });
    if (api) this.services.observe(api.baseUrl, bot.id, request.conversationId);
    return this.finish(request.id, saved.id, saved.grantId, name, !!saved.grantId);
  }
  private finish(
    id: string,
    secretId: string,
    grantId: string | undefined,
    name: string,
    connected: boolean,
  ) {
    const request = this.setups.finish(id, 'saved', { secretId, grantId, connected });
    const message = connected
      ? `${name} is connected for all current and future bots. The key is saved privately; each bot follows its own role instructions.`
      : `Your API key is saved privately for the team. ${name === 'Shared API key' ? 'Which service is it for?' : `Send the ${name} API documentation so I can connect it.`} You do not need to enter it again.`;
    this.store.put('messages', {
      id: `private-saved-${id}`,
      botId: request.botId,
      conversationId: request.conversationId,
      role: 'assistant',
      content: message,
      createdAt: new Date().toISOString(),
    });
    return {
      credentialRequest: request,
      conversationId: request.conversationId,
      connected,
      message,
    };
  }
}
