import type { Model, Provider } from './types';

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof EFFORTS)[number];

/** Unknown models use service defaults rather than sending unsupported parameters. */
export function effortOptions(
  model: Model | undefined,
  provider: Provider | undefined,
): ReasoningEffort[] {
  if (!model || !provider) return [];
  if (provider.local) return ['none', 'low', 'medium', 'high'];
  const name = model.name.toLowerCase();
  if (provider.kind === 'claude-code' || provider.kind === 'anthropic') {
    if (
      /^(opus|sonnet|haiku|fable)$/.test(name) ||
      /claude-(?:(?:opus|sonnet|haiku)-5|(?:fable|mythos)-5|opus-4-[7-9])/.test(name)
    )
      return ['low', 'medium', 'high', 'xhigh', 'max'];
    if (/claude-(?:opus|sonnet)-4-6/.test(name)) return ['low', 'medium', 'high', 'max'];
    if (/claude-opus-4-5/.test(name)) return ['low', 'medium', 'high'];
    return [];
  }
  if (/^gpt-6/.test(name)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (/^gpt-5\.[2-9]/.test(name)) return ['none', 'low', 'medium', 'high', 'xhigh'];
  if (/^gpt-5\.1/.test(name)) return ['none', 'low', 'medium', 'high'];
  if (/^gpt-5(?:-|$)/.test(name)) return ['minimal', 'low', 'medium', 'high'];
  if (/^o[134](?:-|$)/.test(name) && !/^o1-(?:mini|preview)/.test(name))
    return ['low', 'medium', 'high'];
  return [];
}
