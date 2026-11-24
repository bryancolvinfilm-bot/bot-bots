import { createHash, randomUUID } from 'node:crypto';
import type { Bot, Page, Run } from '../../packages/shared/types';
import { knownApi, PAGES_API, type ServiceApi } from '../../packages/shared/service-api';
import { serviceApiSchema } from './service-api-schema';
import { Credentials } from './credentials';
import { pageZip } from './page-zip';
import { Store } from './store';
import { TeamConversations } from './team-conversations';
import { saveApiSkill } from './skills';

export function publishIntent(run: Pick<Run, 'prompt' | 'steering'>) {
  let wanted = false,
    short = false;
  for (const text of [run.prompt, ...(run.steering ?? []).map((message) => message.content)]) {
    if (
      /^(?:here(?:'s| is)\s+)?(?:the |a )?(?:full )?api\s+(?:dump|documentation|handoff|spec)/i.test(
        text.trim(),
      ) ||
      (/^\s*\{/.test(text) && /"openapi"\s*:/.test(text))
    )
      continue;
    if (
      /\b(?:do not|don't|never|no)\s+(?:publish|deploy|host|put|post|upload)|\blocal (?:only|preview is sufficient)\b/i.test(
        text,
      )
    ) {
      wanted = false;
      short = false;
      continue;
    }
    if (
      /\b(?:publish|deploy|public (?:url|link)|short\s*(?:link|url)|shorten)\b|\b(?:give|return|pass|send)\b.{0,40}\b(?:a |the )?link\b|\b(?:put|post|upload|host)\b[^\n.!?]{0,160}\b(?:on|to|at)\s+(?:https?:\/\/)?(?:www\.)?bottools(?:\.online)?\b/i.test(
        text,
      )
    )
      wanted = true;
    if (/\b(?:short\s*(?:link|url)|shorten)\b/i.test(text)) short = true;
  }
  return { wanted, short };
}
/** Public API catalogs are separate from the external OS-secret grants. */
export class Services {
  constructor(
    private store: Store,
    private credentials?: Credentials,
  ) {
    // Register old catalogs once. The marker prevents deleted playbooks reappearing on restart.
    for (const api of store.all('apiDefinitions'))
      if (!api.skillRegistered) {
        saveApiSkill(store, api, api.botId);
        store.put('apiDefinitions', { ...api, skillRegistered: true });
      }
    for (const action of store.all('serviceActions'))
      if (action.status === 'running')
        store.put('serviceActions', {
          ...action,
          status: 'failed',
          error:
            'Server restarted before the API receipt was saved. Check the service before retrying this uncertain action.',
        });
  }
  observe(text: string, botId: string, conversationId: string) {
    const known = knownApi(text);
    if (known) {
      if (!this.store.get('apiDefinitions', known.id)?.skillRegistered)
        saveApiSkill(this.store, known, botId);
      this.store.put('apiDefinitions', { ...known, botId, conversationId, skillRegistered: true });
    }
    // Import supplied OpenAPI JSON, retaining endpoint metadata rather than its examples/auth values.
    const candidates = [...text.matchAll(/```(?:json|openapi)?\s*\n([\s\S]*?)```/gi)].map(
      (match) => match[1],
    );
    candidates.push(text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    try {
      let document: any;
      for (const candidate of candidates) {
        try {
          const value = JSON.parse(candidate);
          if (value.openapi && value.paths && value.servers?.[0]?.url) {
            document = value;
            break;
          }
        } catch {
          /* Try the next supplied JSON block. */
        }
      }
      if (!document) return known;
      const baseUrl = String(document.servers[0].url).replace(/\/$/, '');
      const api: ServiceApi = {
        id: `api-${createHash('sha256').update(baseUrl).digest('hex').slice(0, 16)}`,
        name: String(document.info?.title ?? 'Service API').slice(0, 100),
        baseUrl,
        authType: 'bearer',
        operations: [],
      };
      const auth = Object.values(document.components?.securitySchemes ?? {}).find(
        (scheme: any) => scheme.type === 'apiKey' && scheme.in === 'header',
      ) as { name?: string } | undefined;
      if (auth?.name) {
        api.authType = 'header';
        api.header = auth.name;
      }
      for (const [path, methods] of Object.entries(document.paths))
        for (const [method, raw] of Object.entries(methods as Record<string, any>)) {
          if (!['get', 'head', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
          const op = raw as any,
            content = op.requestBody?.content ?? {},
            body =
              ['get', 'head', 'delete'].includes(method) && !Object.keys(content).length
                ? 'none'
                : content['application/zip']
                  ? 'page-zip'
                  : 'json';
          api.operations.push({
            id: String(op.operationId ?? `${method}-${path}`)
              .toLowerCase()
              .replace(/[^a-z0-9_-]/g, '-')
              .slice(0, 71),
            label: String(op.summary ?? `${method.toUpperCase()} ${path}`).slice(0, 120),
            method: method.toUpperCase() as any,
            path,
            body,
            inputFields: content['application/json']?.schema?.properties
              ? Object.keys(content['application/json'].schema.properties)
              : undefined,
            queryFields: [...((methods as any).parameters ?? []), ...(op.parameters ?? [])]
              .filter((parameter: any) => parameter.in === 'query')
              .map((parameter: any) => parameter.name),
          });
        }
      const validated = serviceApiSchema.parse(api);
      if (!this.store.get('apiDefinitions', validated.id)?.skillRegistered)
        saveApiSkill(this.store, validated, botId);
      this.store.put('apiDefinitions', {
        ...validated,
        botId,
        conversationId,
        skillRegistered: true,
      });
      return validated;
    } catch {
      return known;
    }
  }
  apiFor(service: string, botId?: string, conversationId?: string) {
    const all = this.store.all('apiDefinitions'),
      same = all.filter(
        (api) =>
          (!botId || api.botId === botId) &&
          (!conversationId || api.conversationId === conversationId),
      );
    const selected =
      all.findLast(
        (api) =>
          api.name.toLowerCase() === service.toLowerCase() ||
          api.id === service ||
          knownApi(service)?.id === api.id,
      ) ??
      knownApi(service) ??
      (!service.trim() && same.length === 1 ? same[0] : undefined);
    if (!selected) return undefined;
    const {
      botId: _bot,
      conversationId: _conversation,
      skillRegistered: _skillRegistered,
      ...api
    } = selected as ServiceApi & {
      botId?: string;
      conversationId?: string;
      skillRegistered?: boolean;
    };
    return api;
  }
  capabilities(bot: Bot) {
    return this.credentials?.serviceCapabilities(bot) ?? [];
  }
  intent(run: Run) {
    const ids = new TeamConversations(this.store).ids(run.conversationId);
    const current = publishIntent(run);
    if (!current.wanted || current.short) return current;
    const text = [run.prompt, ...(run.steering ?? []).map((message) => message.content)].join('\n');
    if (
      /\b(?:full|long|direct)\s+(?:url|link)|\b(?:no|without|don't|do not)\s+(?:a\s+)?short/i.test(
        text,
      )
    )
      return current;
    const prior = this.store
      .all('messages')
      .filter(
        (message) =>
          ids.has(message.conversationId) &&
          message.role === 'user' &&
          !message.senderBotId &&
          message.runId !== run.id &&
          message.createdAt <= run.startedAt,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const history = publishIntent({
      prompt: '',
      steering: prior.map((message) => ({ content: message.content })) as Run['steering'],
    });
    return { ...current, short: history.short };
  }
  savedPages(run: Run, prompt: string) {
    const ids = new TeamConversations(this.store).ids(run.conversationId);
    const pages = this.store
      .all('pages')
      .filter((page) => page.format === 'html' && page.content.trim());
    const unique = (items: Page[]) => [
      ...new Map(items.map((page) => [page.content, page])).values(),
    ];
    const explicit = pages.filter((page) => prompt.includes(page.id));
    if (explicit.length) return unique(explicit);
    const messages = this.store
      .all('messages')
      .filter(
        (message) =>
          ids.has(message.conversationId) &&
          message.runId !== run.id &&
          message.role === 'assistant',
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const referenced = pages.filter((page) => messages.at(-1)?.content.includes(page.id));
    if (referenced.length) return unique(referenced);
    const runs = new Set(
      this.store
        .all('runs')
        .filter((item) => ids.has(item.conversationId))
        .map((item) => item.id),
    );
    const scoped = pages
      .filter((page) => page.runId && runs.has(page.runId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = scoped.at(-1);
    return latest ? unique(scoped.filter((page) => page.runId === latest.runId)) : [];
  }
  connection(bot: Bot, reference = '', apiId?: string) {
    const available = this.capabilities(bot).filter(
      (service) => !apiId || service.api.id === apiId,
    );
    const exact = available.find((service) => service.id === reference);
    if (exact) return exact;
    const normalize = (value: string) =>
      value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '')
        .replace(/[ _-]+/g, '');
    const known = knownApi(reference.replace(/\s+api$/i, ''));
    const matches = available.filter(
      (service) =>
        known?.id === service.api.id ||
        [service.api.id, service.api.name, service.api.baseUrl].some(
          (alias) => normalize(alias) === normalize(reference),
        ),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1 && matches.every((service) => service.botIds.includes('*')))
      return matches.at(-1);
    if (matches.length > 1)
      throw Error(
        `Several accounts are connected for this API. Choose a connection ID from service_list: ${matches.map((service) => service.id).join(', ')}. No new token is needed.`,
      );
    if (
      available.length === 1 &&
      (!reference || (apiId && /^connection-[a-f0-9-]{36}$/i.test(reference)))
    )
      return available[0];
    if (
      !reference &&
      available.length > 1 &&
      available.every(
        (service) => service.botIds.includes('*') && service.api.id === available[0].api.id,
      )
    )
      return available.at(-1);
    return undefined;
  }
  async call(
    serviceId: string,
    operationId: string,
    params: Record<string, string>,
    input: Record<string, unknown>,
    bot: Bot,
    run: Run,
    signal: AbortSignal,
    pageId?: string,
  ) {
    if (!this.credentials) throw Error('The host credential store is unavailable.');
    const service = this.connection(bot, serviceId);
    if (!service)
      throw Error(
        'No current service matches that name or ID. Check service_list for connected APIs before requesting another key.',
      );
    serviceId = service.id;
    if (
      service.api.id === PAGES_API.id &&
      /^(?:delete-|rollback)/.test(operationId) &&
      !/\b(?:delete|remove|roll\s*back|rollback)\b/i.test(
        [run.prompt, ...(run.steering ?? []).map((message) => message.content)].join('\n'),
      )
    )
      throw Error('This task did not request deleting or rolling back a published site.');
    const page = pageId ? this.store.get('pages', pageId) : undefined;
    if (pageId && (!page || page.format !== 'html'))
      throw Error('Choose a saved HTML page for deployment.');
    const operation = service.api.operations.find((operation) => operation.id === operationId);
    const signature = createHash('sha256')
      .update(
        JSON.stringify([
          run.id,
          bot.id,
          serviceId,
          operationId,
          params,
          input,
          pageId,
          page?.content,
        ]),
      )
      .digest('hex');
    const old = this.store
      .all('serviceActions')
      .find(
        (action) =>
          action.signature === signature &&
          operation?.method !== 'GET' &&
          operation?.method !== 'HEAD',
      );
    if (old?.status === 'completed') return old.result;
    if (old)
      throw Error(
        'This service action was already attempted. Inspect its receipt before retrying an uncertain external write.',
      );
    const action = {
      id: randomUUID(),
      signature,
      runId: run.id,
      botId: bot.id,
      serviceId,
      operationId,
      status: 'running' as 'running' | 'completed' | 'failed',
      startedAt: new Date().toISOString(),
      result: undefined as unknown,
      error: undefined as string | undefined,
    };
    // Validation happens in the credential broker before any request leaves the host.
    // Record an uncertain write only at the actual dispatch boundary.
    let dispatched = false;
    try {
      const result = await this.credentials.serviceRequest(
        serviceId,
        operationId,
        params,
        input,
        bot,
        signal,
        operation?.body === 'page-zip' && page ? pageZip(page.content) : undefined,
        () => {
          dispatched = true;
          this.store.put('serviceActions', action);
        },
      );
      this.store.put('serviceActions', { ...action, status: 'completed', result });
      return result;
    } catch (error) {
      if (dispatched)
        this.store.put('serviceActions', {
          ...action,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Service action failed',
        });
      throw error;
    }
  }
  async publish(
    page: Page,
    bot: Bot,
    run: Run,
    signal: AbortSignal,
    short = true,
    serviceId?: string,
  ) {
    const service = this.connection(bot, serviceId, PAGES_API.id);
    if (!service)
      throw Error(
        this.capabilities(bot).some((service) => service.api.id === PAGES_API.id)
          ? 'Pages is already connected. Call page_publish without serviceId, or use its current ID/name/URL from service_list. No new token or grant is needed.'
          : 'Connect the Pages API once with the saved token to publish. A private key alone is not an API connection.',
      );
    const hash = createHash('sha256').update(page.content).digest('hex');
    if (page.publication?.contentHash === hash && (!short || page.publication.shortUrl))
      return page.publication;
    const site = page.publication?.site ?? `botbots-${page.id.replace(/-/g, '').slice(0, 16)}`;
    const deployment = (await this.call(
      service.id,
      'deploy',
      { site },
      {},
      bot,
      run,
      signal,
      page.id,
    )) as Record<string, unknown>;
    if (deployment.state !== 'ready')
      throw Error('The publishing API has not reported the deployment ready.');
    const publicUrl = String(deployment.ssl_url ?? deployment.url ?? '');
    if (!publicUrl.startsWith(`${service.api.baseUrl}/sites/`))
      throw Error('The API did not return a public URL on the connected host.');
    let publication = {
      serviceId: service.id,
      site,
      publicUrl,
      shortUrl: undefined as string | undefined,
      contentHash: hash,
      publishedAt: new Date().toISOString(),
    };
    this.store.put('pages', { ...page, publication });
    if (short) {
      const link = (await this.call(
        service.id,
        'create-link',
        {},
        { site },
        bot,
        run,
        signal,
      )) as Record<string, unknown>;
      const shortUrl = String(link.short_url ?? '');
      if (new URL(shortUrl).origin !== new URL(service.api.baseUrl).origin)
        throw Error('The API did not return a short URL on the connected host.');
      publication = { ...publication, shortUrl };
      this.store.put('pages', { ...page, publication });
    }
    return publication;
  }
}
