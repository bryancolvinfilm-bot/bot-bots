import type { Model } from '../../packages/shared/types';
import type { Store } from './store';

/** Claude Code's model windows, including its legacy opt-in [1m] variants.
 * https://code.claude.com/docs/en/model-config#extended-context
 */
export function claudeCodeContextTokens(
  name: string,
  env: Record<string, string | undefined> = process.env,
): number {
  let model = name.toLowerCase();
  const alias = model.replace(/\[1m\]$/, '');
  if (['opus', 'sonnet', 'haiku', 'fable'].includes(alias)) {
    const pinned = env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`];
    if (pinned) model = pinned.toLowerCase() + (model.endsWith('[1m]') ? '[1m]' : '');
  }
  const nativeMillion =
    /^(?:opus|sonnet|haiku|fable)$/.test(model) ||
    /^claude-(?:fable|mythos)-/.test(model) ||
    /^claude-(?:opus|sonnet|haiku)-(?:[5-9]|\d{2})/.test(model) ||
    /^claude-opus-4-[7-9]/.test(model);
  const capacity = nativeMillion || model.endsWith('[1m]') ? 1000000 : 200000;
  return env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1' ? Math.min(capacity, 200000) : capacity;
}

export function withClaudeContext(model: Model, env?: Record<string, string | undefined>): Model {
  const capacity = claudeCodeContextTokens(model.name, env);
  return {
    ...model,
    contextTokens: model.contextSource === 'manual' ? model.contextTokens : capacity,
    contextSource: model.contextSource ?? 'server',
    maxContextTokens: capacity,
    // A local server's loaded context is not a limit reported by the Claude service.
    loadedContextTokens: undefined,
  };
}

export function migrateClaudeContexts(store: Store) {
  const providers = new Set(
    store
      .all('providers')
      .filter((p) => p.kind === 'claude-code')
      .map((p) => p.id),
  );
  for (const model of store.all('models')) {
    if (!providers.has(model.providerId)) continue;
    const updated = withClaudeContext(model);
    if (JSON.stringify(updated) !== JSON.stringify(model)) store.put('models', updated);
  }
}
