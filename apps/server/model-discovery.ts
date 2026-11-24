import type { Model, Provider } from '../../packages/shared/types';
import { Store } from './store';
import { nativeModels } from './model-metadata';
const flights = new WeakMap<Store, Map<string, Promise<Model[]>>>();
export function discoverModels(
  store: Store,
  p: Provider,
  headers: Record<string, string>,
  maxAgeMs = 0,
): Promise<Model[]> {
  if (
    maxAgeMs > 0 &&
    !p.error &&
    p.discoveredAt &&
    Date.now() - Date.parse(p.discoveredAt) < maxAgeMs
  )
    return Promise.resolve(store.all('models').filter((m) => m.providerId === p.id));
  let pending = flights.get(store);
  if (!pending) {
    pending = new Map();
    flights.set(store, pending);
  }
  const key = `${p.id}:${p.baseUrl}:${p.apiKeyEnv}`;
  const running = pending.get(key);
  if (running) return running;
  const promise = (async () => {
    try {
      const [response, metadata] = await Promise.all([
        fetch(`${p.baseUrl}/models`, {
          headers,
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        }),
        nativeModels(p, headers),
      ]);
      if (!response.ok) throw Error(`Model discovery returned HTTP ${response.status}`);
      const data = (await response.json()) as { data?: { id?: unknown }[] };
      if (!Array.isArray(data.data)) throw Error('Expected an OpenAI-compatible model list.');
      const current = store.get('providers', p.id);
      if (!current || current.baseUrl !== p.baseUrl || current.apiKeyEnv !== p.apiKeyEnv)
        return store.all('models').filter((m) => m.providerId === p.id);
      const names = new Set(
        data.data
          .filter((x) => typeof x.id === 'string' && x.id.length > 0 && x.id.length <= 160)
          .map((x) => x.id as string),
      );
      for (const model of store
        .all('models')
        .filter((m) => m.providerId === p.id && !names.has(m.name)))
        store.put('models', {
          ...model,
          status: 'offline',
          loadState: metadata ? 'unloaded' : model.loadState,
          lastError: 'Model no longer advertised by server',
        });
      for (const name of names) {
        const id = `${p.id}::${name}`,
          existing = store.get('models', id),
          native = metadata?.models.get(name);
        const modelType =
          native?.modelType ??
          (/(?:^text-embedding|embed-text|embedding)/i.test(name) ? 'embedding' : 'llm');
        const automatic =
          p.local && p.kind === 'openai-compatible' && current.autoEnableModels !== false;
        const enablement = existing?.enablement ?? (automatic ? 'auto' : 'manual');
        const contextSource =
          existing?.contextSource ??
          (existing && existing.contextTokens !== 32768 ? 'manual' : 'server');
        store.put('models', {
          id,
          providerId: p.id,
          name,
          priority: existing?.priority ?? 50,
          costPerMillion: existing?.costPerMillion ?? 0,
          tasks: existing?.tasks ?? ['general'],
          ...existing,
          enabled:
            modelType === 'llm'
              ? enablement === 'manual'
                ? (existing?.enabled ?? false)
                : automatic
                  ? true
                  : (existing?.enabled ?? false)
              : false,
          enablement,
          contextSource,
          contextTokens:
            contextSource === 'manual'
              ? (existing?.contextTokens ?? 32768)
              : (native?.loadedContextTokens ?? existing?.contextTokens ?? 32768),
          modelType,
          loadState: native?.loadState ?? (metadata ? 'unloaded' : 'unknown'),
          loadedContextTokens: native?.loadedContextTokens,
          maxContextTokens: native?.maxContextTokens,
          instanceId: native?.instanceId,
          supportsTools: native?.supportsTools,
          status: 'online',
          lastError: undefined,
          lastSeen: new Date().toISOString(),
        });
      }
      store.put('providers', {
        ...current,
        metadataSource: metadata?.source ?? 'openai',
        discoveredAt: new Date().toISOString(),
        error: undefined,
      });
      return store.all('models').filter((m) => m.providerId === p.id);
    } catch (error) {
      const current = store.get('providers', p.id);
      if (current?.baseUrl !== p.baseUrl)
        return store.all('models').filter((m) => m.providerId === p.id);
      const message = error instanceof Error ? error.message : String(error);
      store.put('providers', { ...current, error: message });
      for (const m of store.all('models').filter((m) => m.providerId === p.id))
        store.put('models', { ...m, status: 'offline', lastError: message });
      throw error;
    }
  })().finally(() => pending!.delete(key));
  pending.set(key, promise);
  return promise;
}
