import { CronExpressionParser } from 'cron-parser';
import type { Routine } from '../../packages/shared/types';
import { Runtime } from './runtime';
import { Store } from './store';
export function nextRun(routine: Pick<Routine, 'cron' | 'timezone'>, date = new Date()) {
  return CronExpressionParser.parse(routine.cron, { tz: routine.timezone, currentDate: date })
    .next()
    .toISOString()!;
}
export function scheduler(store: Store, runtime: Runtime) {
  // No surprise catch-up after sleep/restart; the next future occurrence is persisted.
  for (const r of store.all('routines').filter((r) => r.enabled))
    store.put('routines', { ...r, nextRun: nextRun(r) });
  const timer = setInterval(() => {
    for (const r of store
      .all('routines')
      .filter((r) => r.enabled && r.nextRun && Date.parse(r.nextRun) <= Date.now())) {
      try {
        if (store.all('runs').some((run) => run.botId === r.botId && run.status === 'running'))
          continue;
        runtime.create(
          r.botId,
          `Scheduled routine: ${r.name}\n\n${r.prompt}`,
          undefined,
          {},
          undefined,
          'routine',
        );
        store.put('routines', {
          ...r,
          lastRun: new Date().toISOString(),
          nextRun: nextRun(r),
          error: undefined,
        });
      } catch (error) {
        store.put('routines', {
          ...r,
          nextRun: nextRun(r),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, 15000);
  timer.unref();
  return () => clearInterval(timer);
}
