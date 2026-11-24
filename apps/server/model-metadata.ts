import type { Provider } from '../../packages/shared/types';
export interface NativeModel {
  modelType: 'llm' | 'embedding' | 'other';
  loadState: 'loaded' | 'unloaded';
  loadedContextTokens?: number;
  maxContextTokens?: number;
  instanceId?: string;
  supportsTools?: boolean;
}
const positive = (n: unknown) =>
  typeof n === 'number' && Number.isFinite(n) && n >= 512 && n <= 2000000
    ? Math.floor(n)
    : undefined;
export async function nativeModels(
  provider: Provider,
  headers: Record<string, string>,
): Promise<
  { source: 'lm-studio-v1' | 'lm-studio-v0'; models: Map<string, NativeModel> } | undefined
> {
  if (!provider.local || provider.kind !== 'openai-compatible') return;
  const base = provider.baseUrl.replace(/\/v1$/, '');
  for (const version of ['v1', 'v0'] as const)
    try {
      const res = await fetch(`${base}/api/${version}/models`, {
        headers,
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
      });
      if (!res.ok) continue;
      const json = (await res.json()) as any;
      const list = version === 'v1' ? json.models : json.data;
      if (!Array.isArray(list) || !list.every((m) => m && typeof m === 'object')) continue;
      const valid = list.filter((m) =>
        version === 'v1'
          ? typeof m.key === 'string' &&
            Array.isArray(m.loaded_instances) &&
            typeof m.type === 'string'
          : typeof m.id === 'string' &&
            ['loaded', 'not-loaded'].includes(m.state) &&
            typeof m.type === 'string',
      );
      if (!valid.length && list.length) continue;
      const models = new Map<string, NativeModel>();
      for (const item of valid) {
        const instances = version === 'v1' ? item.loaded_instances : [];
        const loaded = version === 'v1' ? instances.length > 0 : item.state === 'loaded';
        const type = /embedd/.test(item.type)
          ? 'embedding'
          : ['llm', 'vlm'].includes(item.type) &&
              !/(?:qwen_image|diffusion|dflash|flux)/i.test(item.architecture ?? item.arch ?? '')
            ? 'llm'
            : 'other';
        const common: NativeModel = {
          modelType: type,
          loadState: loaded ? 'loaded' : 'unloaded',
          loadedContextTokens: loaded
            ? positive(
                version === 'v1'
                  ? instances[0]?.config?.context_length
                  : item.loaded_context_length,
              )
            : undefined,
          maxContextTokens: positive(item.max_context_length),
          instanceId: loaded
            ? version === 'v1'
              ? typeof instances[0]?.id === 'string'
                ? instances[0].id
                : undefined
              : item.id
            : undefined,
          supportsTools:
            version === 'v1'
              ? typeof item.capabilities?.trained_for_tool_use === 'boolean'
                ? item.capabilities.trained_for_tool_use
                : undefined
              : Array.isArray(item.capabilities)
                ? item.capabilities.includes('tool_use')
                : undefined,
        };
        models.set(version === 'v1' ? item.key : item.id, common);
        for (const instance of instances)
          if (typeof instance.id === 'string')
            models.set(instance.id, {
              ...common,
              instanceId: instance.id,
              loadedContextTokens: positive(instance.config?.context_length),
            });
      }
      return { source: version === 'v1' ? 'lm-studio-v1' : 'lm-studio-v0', models };
    } catch {
      /* Native metadata is optional; ordinary compatible servers still work. */
    }
}
