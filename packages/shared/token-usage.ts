import type { Run, WorkRecord } from './types';

export interface TokenUsage {
  total: number;
  input?: number;
  output?: number;
  estimated: boolean;
}
export interface UsageUpdate {
  type: 'usage';
  runId: string;
  workId: string;
  revision: number;
  usage?: TokenUsage;
  liveUsage?: TokenUsage;
}
export const estimateTextTokens = (text: string) => Math.ceil(text.length / 4);
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function providerTokenUsage(raw: any, anthropic = false): TokenUsage | undefined {
  if (!raw) return;
  const input = count(raw.input_tokens ?? raw.prompt_tokens);
  const output = count(raw.output_tokens ?? raw.completion_tokens);
  const cached = anthropic
    ? (count(raw.cache_creation_input_tokens) ?? 0) + (count(raw.cache_read_input_tokens) ?? 0)
    : 0;
  const total =
    count(raw.total_tokens) ??
    (input !== undefined && output !== undefined ? input + cached + output : undefined);
  if (total === undefined) return;
  return {
    total,
    input: input === undefined ? undefined : input + cached,
    output,
    estimated: false,
  };
}
export function addTokenUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
  if (!a) return b && { ...b };
  if (!b) return { ...a };
  return {
    total: a.total + b.total,
    input: a.input !== undefined && b.input !== undefined ? a.input + b.input : undefined,
    output: a.output !== undefined && b.output !== undefined ? a.output + b.output : undefined,
    estimated: a.estimated || b.estimated,
  };
}
export function workTokenUsage(work?: WorkRecord) {
  const legacy =
    !work?.usage &&
    work?.attempts?.some((attempt) => attempt.calls > 0) &&
    work.attempts.every((attempt) => attempt.usageKnown)
      ? {
          total: work.attempts.reduce((total, attempt) => total + attempt.tokens, 0),
          estimated: false,
        }
      : undefined;
  return addTokenUsage(work?.usage ?? legacy, work?.liveUsage);
}
export function applyUsageUpdate(run: Run | undefined, update: UsageUpdate): Run | undefined {
  if (!run || run.id !== update.runId || run.status !== 'running') return run;
  const work = run.work?.find((work) => work.id === update.workId);
  if (!work || (work.usageRevision ?? 0) >= update.revision) return run;
  return {
    ...run,
    revision: Math.max(run.revision ?? 0, update.revision),
    work: run.work?.map((work) =>
      work.id === update.workId && (work.usageRevision ?? 0) < update.revision
        ? {
            ...work,
            usage: update.usage,
            liveUsage: update.liveUsage,
            usageRevision: update.revision,
          }
        : work,
    ),
  };
}
