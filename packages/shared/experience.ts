import type { Assessment, Run, WorkRecord } from './types';

export function elapsedMs(start: string, end?: string) {
  if (!end) return undefined;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) ? Math.max(0, value) : undefined;
}
export function workMetrics(work: WorkRecord) {
  return {
    durationMs: elapsedMs(work.startedAt, work.finishedAt),
    modelTimeMs: work.attempts.reduce((sum, attempt) => sum + attempt.modelTimeMs, 0),
    tokens: work.attempts.reduce((sum, attempt) => sum + attempt.tokens, 0),
    usageKnown: work.attempts.length > 0 && work.attempts.every((attempt) => attempt.usageKnown),
  };
}
export function durationLabel(ms?: number) {
  if (ms === undefined) return 'Not recorded';
  if (ms < 1000) return '<1s';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// Human scores and measured outcomes stay separate. Completing a job is never a quality vote.
export function assessRuns(runs: Run[]): Assessment[] {
  const groups = new Map<string, Assessment & { durationSamples: number; modelSamples: number }>();
  const add = (
    botId: string | undefined,
    task: Run['task'],
    modelId: string,
    status: string,
    rating?: number,
    timing?: string,
    duration?: number,
    modelTime?: number,
    tokens?: number,
  ) => {
    const key = JSON.stringify([botId, task, modelId]);
    const a = groups.get(key) ?? {
      botId,
      task,
      modelId,
      samples: 0,
      average: 0,
      successes: 0,
      failures: 0,
      tokenSamples: 0,
      slowReports: 0,
      worthTheWait: 0,
      durationSamples: 0,
      modelSamples: 0,
    };
    if (rating !== undefined) {
      a.average = (a.average * a.samples + rating) / ++a.samples;
      if (timing === 'too-slow') a.slowReports!++;
      if (timing === 'worth-the-wait') a.worthTheWait!++;
    }
    if (status === 'completed') {
      a.successes++;
      if (duration !== undefined)
        a.averageDurationMs =
          ((a.averageDurationMs ?? 0) * a.durationSamples + duration) / ++a.durationSamples;
      if (modelTime !== undefined)
        a.averageModelTimeMs =
          ((a.averageModelTimeMs ?? 0) * a.modelSamples + modelTime) / ++a.modelSamples;
      if (tokens !== undefined)
        a.averageTokens = ((a.averageTokens ?? 0) * a.tokenSamples! + tokens) / ++a.tokenSamples!;
    } else a.failures++;
    groups.set(key, a);
  };
  for (const run of runs) {
    if (run.work?.length) {
      for (const work of run.work) {
        if (work.status === 'running' || work.status === 'cancelled') continue;
        // A successful result is attributed only to the model that delivered it. Failed
        // fallbacks retain their own telemetry and never inherit a teammate's rating.
        for (const attempt of work.attempts) {
          if (
            attempt.status === 'running' ||
            attempt.status === 'cancelled' ||
            attempt.status === 'switched'
          )
            continue;
          const delivered =
            attempt.status === 'completed' &&
            work.status === 'completed' &&
            work.modelId === attempt.modelId;
          const feedback = delivered ? work.feedback : undefined;
          for (const scope of [undefined, work.prototypeId ?? work.botId])
            add(
              scope,
              work.task,
              attempt.modelId,
              delivered ? 'completed' : 'failed',
              feedback?.rating,
              feedback?.timing,
              delivered ? elapsedMs(work.startedAt, work.finishedAt) : undefined,
              delivered ? attempt.modelTimeMs : undefined,
              delivered && attempt.usageKnown ? attempt.tokens : undefined,
            );
        }
      }
    } else if (run.modelId && run.status !== 'running' && run.status !== 'cancelled') {
      // Old runs have aggregate token counts which may include delegation: do not
      // pretend those are per-model measurements.
      for (const scope of [undefined, run.botId])
        add(
          scope,
          run.task,
          run.modelId,
          run.status,
          run.feedback?.rating ?? run.rating,
          run.feedback?.timing,
        );
    }
  }
  return [...groups.values()].map(({ durationSamples, modelSamples, ...a }) => a);
}
