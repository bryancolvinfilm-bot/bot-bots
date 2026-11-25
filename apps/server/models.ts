import type { Model, Provider, TaskType, Urgency } from '../../packages/shared/types';
import { Store } from './store';
import { TaskLimitError, ModelToolFormatError, ModelEmptyAnswerError } from './generation-errors';
import { providerContextError, ContextBudgetError } from './generation-errors';
import { readChatStream, type CompletionProgress } from './chat-stream';
import { discoverModels } from './model-discovery';
import { rankModels, effectiveContext } from '../../packages/shared/model-routing';
import { Credentials, redactSecrets } from './credentials';
import { ChatGPTAuth } from './chatgpt-auth';
import { ClaudeCode } from './claude-code';
import { withClaudeContext } from './frontier-context';
const claudeConnections = new WeakMap<Credentials, ClaudeCode>();
const storeClaude = new WeakMap<Store, ClaudeCode>();
export function attachClaudeCode(store: Store, credentials: Credentials, claude: ClaudeCode) {
  claudeConnections.set(credentials, claude);
  storeClaude.set(store, claude);
}
const chatGPTConnections = new WeakMap<Credentials, ChatGPTAuth>();
const storeChatGPT = new WeakMap<Store, ChatGPTAuth>();
export function attachChatGPT(store: Store, credentials: Credentials, auth: ChatGPTAuth) {
  chatGPTConnections.set(credentials, auth);
  storeChatGPT.set(store, auth);
}
const hostCredentials = new WeakMap<Store, Credentials>();
export function attachModelCredentials(store: Store, credentials: Credentials) {
  hostCredentials.set(store, credentials);
}
export class ModelSelectionChanged extends Error {}
export function normalizeBaseUrl(input: string) {
  const url = new URL(input.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Use an HTTP(S) base URL without credentials, query, or fragment.');
  url.pathname = url.pathname.replace(/\/(chat\/completions|models)\/?$/, '').replace(/\/$/, '');
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
  return url.toString().replace(/\/$/, '');
}
export function providerHeaders(p: Provider, credentials?: Credentials): Record<string, string> {
  const key = p.credentialId
    ? credentials?.binding(p.credentialId, 'model', p.baseUrl)
    : p.apiKeyEnv
      ? process.env[p.apiKeyEnv]
      : '';
  if ((p.credentialId || p.apiKeyEnv) && !key)
    throw new Error(
      'The model credential is unavailable. Check its external grant or server environment.',
    );
  if (key && /[^\x21-\x7e]/.test(key))
    throw Error('The configured API credential has an invalid header format.');
  return {
    'Content-Type': 'application/json',
    ...(p.kind === 'anthropic'
      ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
      : key
        ? { Authorization: `Bearer ${key}` }
        : {}),
  };
}
export async function discover(
  store: Store,
  providerId: string,
  options: { maxAgeMs?: number } = {},
) {
  const provider = store.get('providers', providerId);
  if (!provider) throw Error('Provider not found');
  if (provider.kind === 'claude-code') {
    const claude = storeClaude.get(store);
    if (!claude || (await claude.state()).status !== 'connected')
      throw Error('Connect Claude in Model workshop first.');
    for (const name of ['sonnet', 'opus', 'haiku', 'fable']) {
      const id = `${providerId}::${name}`,
        old = store.get('models', id);
      store.put(
        'models',
        withClaudeContext({
          id,
          providerId,
          name,
          enabled: false,
          enablement: 'manual',
          priority: 50,
          costPerMillion: 0,
          tasks: ['general'],
          contextTokens: 32768,
          supportsTools: true,
          ...old,
          status: 'online',
          loadState: 'loaded',
          lastError: undefined,
          lastSeen: new Date().toISOString(),
        }),
      );
    }
    store.put('providers', {
      ...provider,
      enabled: true,
      error: undefined,
      discoveredAt: new Date().toISOString(),
    });
    return store.all('models').filter((m) => m.providerId === providerId);
  }
  if (provider.kind === 'chatgpt') {
    const auth = storeChatGPT.get(store);
    if (!auth) throw Error('ChatGPT sign-in is unavailable on this host.');
    try {
      const catalog = await auth.models();
      const session = await auth.state();
      const changedAccount = store.config<string>('chatgpt-catalog-account') !== session.active;
      const names = new Set(catalog.map((m) => m.slug));
      for (const old of store
        .all('models')
        .filter((m) => m.providerId === providerId && !names.has(m.name)))
        store.put('models', {
          ...old,
          status: 'offline',
          enabled: false,
          lastError: 'Unavailable to the selected ChatGPT account',
        });
      for (const item of catalog) {
        const id = `${providerId}::${item.slug}`,
          old = store.get('models', id);
        store.put('models', {
          id,
          providerId,
          name: item.slug,
          enabled: false,
          enablement: 'manual',
          priority: 50,
          costPerMillion: 0,
          tasks: ['general'],
          contextTokens: 32768,
          supportsTools: true,
          ...old,
          ...(changedAccount ? { enabled: false } : {}),
          status: 'online',
          loadState: 'loaded',
          lastSeen: new Date().toISOString(),
          lastError: undefined,
        });
      }
      store.put('providers', {
        ...provider,
        enabled: true,
        discoveredAt: new Date().toISOString(),
        error: undefined,
      });
      store.setConfig('chatgpt-catalog-account', session.active);
      return store.all('models').filter((m) => m.providerId === providerId);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'ChatGPT discovery failed.';
      store.put('providers', { ...provider, error: message });
      for (const m of store.all('models').filter((m) => m.providerId === providerId))
        store.put('models', { ...m, status: 'offline', lastError: message });
      throw e;
    }
  }
  return discoverModels(
    store,
    provider,
    providerHeaders(provider, hostCredentials.get(store)),
    options.maxAgeMs ?? 0,
  );
}
export async function refreshLocalModels(store: Store, maxAgeMs = 0) {
  return Promise.allSettled(
    store
      .all('providers')
      .filter(
        (p) => p.enabled && p.local && p.kind === 'openai-compatible' && p.autoDiscover !== false,
      )
      .map((p) => discover(store, p.id, { maxAgeMs })),
  );
}
export function candidates(
  store: Store,
  task: TaskType,
  preferred?: string | null,
  context: { botId?: string; urgency?: Urgency } = {},
): Model[] {
  return rankModels(
    store.all('models'),
    store.all('providers'),
    store.settings(),
    store.assessments(),
    task,
    preferred,
    {
      ...context,
      providerId: context.botId ? store.get('bots', context.botId)?.providerId : undefined,
    },
  );
}
export interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  rawOutput?: unknown[];
  rawOutputProviderId?: string;
  rawOutputModelId?: string;
}
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface Completion {
  message: WireMessage;
  tokens?: number;
  truncated: boolean;
  stopReason?: string;
}
export function fitContext(
  messages: WireMessage[],
  tools: unknown[],
  contextTokens: number,
  maxTokens: number,
) {
  const input = [...messages];
  const budget = contextTokens - maxTokens - 512;
  const estimate = () =>
    Math.ceil((JSON.stringify(input).length + JSON.stringify(tools).length) / 3);
  // Drop old conversation messages, never the current prompt or tool call/result chain.
  while (estimate() > budget) {
    // A live steering message is another user message inside the same task.
    // Keep the task's initial prompt and its tool/result chain together.
    const previousReply = input.findLastIndex(
      (m) => m.role === 'assistant' && !m.tool_calls?.length,
    );
    const currentPrompt = input.findIndex((m, index) => index > previousReply && m.role === 'user');
    if (currentPrompt <= 1)
      throw new ContextBudgetError(
        `Bot-Bots' configured context window is too small for this request: approximately ${estimate().toLocaleString()} input tokens, ${maxTokens.toLocaleString()} output tokens reserved, and a ${contextTokens.toLocaleString()}-token effective window. Check the model's context source/cap in Model workshop. This check stopped the request before provider inference.`,
        contextTokens,
      );
    input.splice(1, 1);
  }
  return input;
}
export function normalizeSystemMessages(messages: WireMessage[]): WireMessage[] {
  const system = messages.filter((message) => message.role === 'system');
  if (!system.length) return messages;
  return [
    { ...system[0], content: system.map((message) => message.content ?? '').join('\n\n') },
    ...messages.filter((message) => message.role !== 'system'),
  ];
}
export function portableMessages(
  messages: WireMessage[],
  provider: Provider,
  model: Model,
): WireMessage[] {
  return messages.map(({ rawOutput, rawOutputProviderId, rawOutputModelId, ...message }) => {
    const compatible =
      ['openai-responses', 'chatgpt'].includes(provider.kind) &&
      (!rawOutputProviderId || rawOutputProviderId === provider.id) &&
      (!rawOutputModelId || rawOutputModelId === model.id);
    return rawOutput && compatible ? { ...message, rawOutput } : message;
  });
}
export async function complete(
  p: Provider,
  m: Model,
  messages: WireMessage[],
  tools: unknown[],
  maxTokens: number,
  signal: AbortSignal,
  credentials?: Credentials,
  progress?: (snapshot: CompletionProgress) => void,
): Promise<Completion> {
  messages = portableMessages(normalizeSystemMessages(messages), p, m);
  if (p.local || m.contextSource === 'manual')
    messages = fitContext(messages, tools, effectiveContext(m), maxTokens);
  if (p.kind === 'claude-code') {
    const claude = credentials && claudeConnections.get(credentials);
    if (!claude) throw Error('Connect Claude in Model workshop first.');
    return claude.complete(
      m.name,
      messages,
      tools,
      maxTokens,
      AbortSignal.any([signal, AbortSignal.timeout(p.timeoutMs)]),
      m.reasoningEffort,
    );
  }
  if (p.kind === 'chatgpt') {
    const auth = credentials && chatGPTConnections.get(credentials);
    if (!auth) throw Error('Sign in with ChatGPT in the Model workshop first.');
    return auth.authenticated(
      (token, activeSignal) =>
        completeResponses(
          { ...p, baseUrl: 'https://api.openai.com/v1' },
          m,
          messages,
          tools,
          maxTokens,
          activeSignal,
          undefined,
          progress,
          token,
        ),
      signal,
    );
  }
  if (p.kind === 'anthropic')
    return completeAnthropic(p, m, messages, tools, maxTokens, signal, credentials);
  if (p.kind === 'openai-responses')
    return completeResponses(p, m, messages, tools, maxTokens, signal, credentials);
  const headers = providerHeaders(p, credentials);
  const timeout = AbortSignal.timeout(p.timeoutMs);
  const res = await fetch(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    redirect: 'error',
    signal: AbortSignal.any([signal, timeout]),
    body: JSON.stringify({
      model: m.instanceId ?? m.name,
      messages,
      temperature: 0.6,
      max_tokens: maxTokens,
      stream: !!progress,
      ...(progress ? { stream_options: { include_usage: true } } : {}),
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...(m.reasoningEffort ? { reasoning_effort: m.reasoningEffort } : {}),
      ...(p.local && m.reasoningEffort === 'none'
        ? { chat_template_kwargs: { enable_thinking: false } }
        : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    const contextError = providerContextError(detail);
    if (contextError && [400, 413, 422, 500].includes(res.status)) throw contextError;
    const text = p.credentialId
      ? 'Credential-backed provider error details withheld.'
      : detail.slice(0, 350);
    if (
      p.local &&
      tools.length &&
      [400, 500].includes(res.status) &&
      /does not match the expected.{0,40}format|tool.{0,50}(?:not supported|unsupported)|does not support.{0,20}tools/i.test(
        text,
      )
    )
      throw new ModelToolFormatError(`The local model's tool-call format was rejected. ${text}`);
    if (
      res.status === 400 &&
      /context.{0,50}(length|window|limit|exceed)|too many tokens|exceed.{0,30}context/i.test(text)
    )
      throw new TaskLimitError(
        `The configured/loaded context window was exceeded. Saved drafts are preserved. ${text}`,
      );
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const secrets = [
    headers.Authorization?.replace(/^Bearer /, '') ?? '',
    (headers as Record<string, string>)['x-api-key'] ?? '',
  ];
  const raw = res.headers.get('content-type')?.includes('text/event-stream')
    ? await readChatStream(res, (snapshot) =>
        progress?.(JSON.parse(redactSecrets(JSON.stringify(snapshot), secrets))),
      )
    : await res.json();
  const data = JSON.parse(
    redactSecrets(JSON.stringify(raw), [
      headers.Authorization?.replace(/^Bearer /, '') ?? '',
      (headers as Record<string, string>)['x-api-key'] ?? '',
    ]),
  ) as {
    choices?: { message?: { content?: string; tool_calls?: ToolCall[] }; finish_reason?: string }[];
    usage?: { total_tokens?: number };
  };
  const choice = data.choices?.[0];
  if (!choice?.message) throw new Error('Provider returned no assistant message');
  if (
    choice.finish_reason !== 'length' &&
    !choice.message.content?.trim() &&
    !choice.message.tool_calls?.length
  )
    throw new ModelEmptyAnswerError(
      'The model returned no visible answer. Completed work is preserved.',
    );
  return {
    message: {
      role: 'assistant',
      content: choice.message.content ?? null,
      tool_calls: choice.message.tool_calls,
    } as WireMessage,
    tokens: data.usage?.total_tokens,
    truncated: choice.finish_reason === 'length',
    stopReason: choice.finish_reason,
  };
}
interface FunctionTool {
  type: string;
  function: { name: string; description: string; parameters: unknown };
}
export async function completeAnthropic(
  p: Provider,
  m: Model,
  messages: WireMessage[],
  tools: unknown[],
  maxTokens: number,
  signal: AbortSignal,
  credentials?: Credentials,
): Promise<Completion> {
  const system = messages
    .filter((x) => x.role === 'system')
    .map((x) => x.content)
    .join('\n');
  const input: { role: string; content: unknown[] }[] = [];
  for (const message of messages.filter((x) => x.role !== 'system')) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content: unknown[] =
      message.role === 'tool'
        ? [
            {
              type: 'tool_result',
              tool_use_id: message.tool_call_id,
              content: message.content ?? '',
            },
          ]
        : [
            ...(message.content ? [{ type: 'text', text: message.content }] : []),
            ...(message.tool_calls ?? []).map((t) => ({
              type: 'tool_use',
              id: t.id,
              name: t.function.name,
              input: JSON.parse(t.function.arguments),
            })),
          ];
    if (input.at(-1)?.role === role) input.at(-1)!.content.push(...content);
    else input.push({ role, content });
  }
  const headers = providerHeaders(p, credentials);
  const response = await fetch(`${p.baseUrl}/messages`, {
    method: 'POST',
    headers,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(p.timeoutMs)]),
    body: JSON.stringify({
      model: m.name,
      system,
      messages: input,
      max_tokens: maxTokens,
      ...(m.reasoningEffort ? { output_config: { effort: m.reasoningEffort } } : {}),
      ...(tools.length
        ? {
            tools: (tools as FunctionTool[]).map((t) => ({
              name: t.function.name,
              description: t.function.description,
              input_schema: t.function.parameters,
            })),
          }
        : {}),
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    const contextError = providerContextError(detail);
    if (contextError && [400, 413, 422, 500].includes(response.status)) throw contextError;
    throw new Error(
      `Anthropic HTTP ${response.status}: ${p.credentialId ? 'Credential-backed error details withheld.' : detail.slice(0, 300)}`,
    );
  }
  const data = JSON.parse(
    redactSecrets(JSON.stringify(await response.json()), [
      (headers as Record<string, string>)['x-api-key'] ?? '',
    ]),
  ) as {
    stop_reason: string;
    content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    usage?: { input_tokens: number; output_tokens: number };
  };
  const text = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const calls = data.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      id: b.id!,
      type: 'function' as const,
      function: { name: b.name!, arguments: JSON.stringify(b.input) },
    }));
  const truncated = ['max_tokens', 'model_context_window_exceeded'].includes(data.stop_reason);
  if (!truncated && !text && !calls.length) throw new Error('Claude returned an empty answer');
  return {
    message: { role: 'assistant', content: text || null, tool_calls: calls } as WireMessage,
    tokens: data.usage ? data.usage.input_tokens + data.usage.output_tokens : undefined,
    truncated,
    stopReason: data.stop_reason,
  };
}
export async function completeResponses(
  p: Provider,
  m: Model,
  messages: WireMessage[],
  tools: unknown[],
  maxTokens: number,
  signal: AbortSignal,
  credentials?: Credentials,
  progress?: (snapshot: CompletionProgress) => void,
  oauthToken?: string,
): Promise<Completion> {
  const input: unknown[] = [];
  for (const message of messages.filter((x) => x.role !== 'system')) {
    if (message.role === 'tool')
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content ?? '',
      });
    else if (
      message.rawOutput &&
      (!message.rawOutputProviderId || message.rawOutputProviderId === p.id) &&
      (!message.rawOutputModelId || message.rawOutputModelId === m.id)
    )
      input.push(...message.rawOutput);
    else {
      if (message.content) input.push({ role: message.role, content: message.content });
      for (const t of message.tool_calls ?? [])
        input.push({
          type: 'function_call',
          call_id: t.id,
          name: t.function.name,
          arguments: t.function.arguments,
        });
    }
  }
  const headers = oauthToken
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${oauthToken}` }
    : providerHeaders(p, credentials);
  const response = await fetch(`${p.baseUrl}/responses`, {
    method: 'POST',
    headers,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(p.timeoutMs)]),
    body: JSON.stringify({
      model: m.name,
      instructions: messages
        .filter((x) => x.role === 'system')
        .map((x) => x.content)
        .join('\n'),
      input,
      max_output_tokens: maxTokens,
      store: false,
      ...(oauthToken ? { stream: true } : {}),
      include: ['reasoning.encrypted_content'],
      ...(m.reasoningEffort ? { reasoning: { effort: m.reasoningEffort } } : {}),
      ...(tools.length
        ? {
            tools: (tools as FunctionTool[]).map((t) => ({
              type: 'function',
              ...t.function,
              strict: false,
            })),
          }
        : {}),
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    const contextError = providerContextError(detail);
    if (contextError && [400, 413, 422, 500].includes(response.status)) throw contextError;
    throw new Error(
      `OpenAI HTTP ${response.status}: ${p.credentialId || oauthToken ? 'Check the model connection and account usage limits.' : detail.slice(0, 300)}`,
    );
  }
  const data = JSON.parse(
    redactSecrets(
      JSON.stringify(
        oauthToken
          ? await readResponsesStream(response, (snapshot) =>
              progress?.(JSON.parse(redactSecrets(JSON.stringify(snapshot), [oauthToken]))),
            )
          : await response.json(),
      ),
      [headers.Authorization?.replace(/^Bearer /, '') ?? ''],
    ),
  ) as {
    status: string;
    incomplete_details?: { reason?: string };
    output: {
      type: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      content?: { type: string; text?: string }[];
    }[];
    usage?: { total_tokens: number };
  };
  if (data.status === 'failed') throw new Error('OpenAI response failed.');
  const truncated =
    data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens';
  if (data.status === 'incomplete' && !truncated)
    throw new TaskLimitError(
      `The response could not complete: ${data.incomplete_details?.reason ?? 'unknown reason'}.`,
    );
  const text = data.output
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('\n');
  const calls = data.output
    .filter((o) => o.type === 'function_call')
    .map((o) => ({
      id: o.call_id!,
      type: 'function' as const,
      function: { name: o.name!, arguments: o.arguments! },
    }));
  if (!truncated && !text && !calls.length) throw new Error('OpenAI returned an empty answer');
  return {
    message: {
      role: 'assistant',
      content: text || null,
      tool_calls: calls,
      rawOutput: data.output,
      rawOutputProviderId: p.id,
      rawOutputModelId: m.id,
    } as WireMessage,
    tokens: data.usage?.total_tokens,
    truncated,
    stopReason: data.incomplete_details?.reason ?? data.status,
  };
}
export async function readResponsesStream(
  response: Response,
  progress?: (snapshot: CompletionProgress) => void,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error('ChatGPT returned no response stream.');
  let buffer = '',
    text = '',
    bytes = 0,
    terminal: unknown;
  const decoder = new TextDecoder();
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') return;
    const event = JSON.parse(value);
    if (event.type === 'response.failed' || event.type === 'error')
      throw Error(
        'ChatGPT could not complete this request. Check the account connection and ChatGPT usage limits.',
      );
    if (event.type === 'response.output_text.delta') {
      text += event.delta ?? '';
      progress?.({ text, toolCalls: [] });
    }
    if (event.type === 'response.completed' || event.type === 'response.incomplete')
      terminal = event.response;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 32 * 1024 * 1024)
        throw new TaskLimitError('ChatGPT output exceeded the response limit.');
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, end).replace(/\r$/, ''));
        buffer = buffer.slice(end + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!terminal)
      throw Error('ChatGPT stream ended before completion. The reply was not completed.');
    return terminal;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
