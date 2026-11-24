import type { Bot } from '../../packages/shared/types';
import { Store } from './store';

export class BotLifecycleError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export function changeBotLifecycle(
  store: Store,
  id: string,
  action: 'archive' | 'restore' | 'delete',
) {
  const bot = store.get('bots', id);
  if (!bot || bot.deletedAt) throw new BotLifecycleError('This bot has already been deleted.', 404);
  if (bot.prototypeId)
    throw new BotLifecycleError(
      'Temporary workers close automatically. Manage their prototype instead.',
    );
  const family = new Set([
    id,
    ...store
      .all('bots')
      .filter((candidate) => candidate.prototypeId === id)
      .map((candidate) => candidate.id),
  ]);
  if (
    store
      .all('runs')
      .some(
        (run) =>
          run.status === 'running' &&
          (family.has(run.botId) || run.work?.some((work) => family.has(work.botId))),
      )
  )
    throw new BotLifecycleError(
      'This bot is part of a running team task. Let it finish or stop that task before archiving or deleting it.',
    );
  if (action === 'restore' && !bot.archivedAt) return bot;
  if (action === 'archive' && bot.archivedAt) return bot;
  const routines = store
    .all('routines')
    .filter((routine) => routine.botId === id && routine.enabled);
  const now = new Date().toISOString();
  let updated: Bot;
  if (action === 'restore') {
    const { archivedAt: _at, archiveState, ...profile } = bot;
    updated = { ...profile, enabled: archiveState?.enabled ?? true };
  } else if (action === 'archive')
    updated = {
      ...bot,
      enabled: false,
      archivedAt: now,
      archiveState: { enabled: bot.enabled, routineIds: routines.map((routine) => routine.id) },
    };
  else
    updated = {
      id: bot.id,
      name: bot.name,
      title: 'Deleted bot',
      description: '',
      instructions: '',
      avatar: bot.avatar,
      modelId: null,
      enabled: false,
      deletedAt: now,
    };
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.put('bots', updated);
    if (action !== 'restore')
      for (const clone of store.all('bots').filter((clone) => clone.prototypeId === id))
        store.put('bots', {
          ...clone,
          enabled: false,
          cloneStatus: 'retired',
          ...(action === 'delete' ? { instructions: '', description: '' } : {}),
        });
    for (const routine of routines)
      store.put('routines', { ...routine, enabled: false, nextRun: undefined });
    if (action !== 'restore' && store.settings().mainBotId === id)
      store.setConfig('settings', { ...store.settings(), mainBotId: null });
    for (const request of store.all('credentialSetups'))
      if (family.has(request.botId) && request.status === 'awaiting-entry')
        store.put('credentialSetups', { ...request, status: 'cancelled', finishedAt: now });
    if (action === 'delete') {
      for (const memory of store.all('memory'))
        if (memory.botId && family.has(memory.botId)) store.remove('memory', memory.id);
      for (const routine of store.all('routines'))
        if (routine.botId === id) store.remove('routines', routine.id);
    }
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return updated;
}
