import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Bot, Memory } from '../../packages/shared/types';
import type { CompactionRecord, TaskRecord, ProcessingPhrases } from '../../packages/shared/team';
import { Store } from './store';
const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x));
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const brief = (text: string, length = 360) =>
  text.length > length
    ? `${text.slice(0, length).trim()}\n[Earlier detail compacted; full original is in the undo archive.]`
    : text;
type Item = { collection: 'tasks'; value: TaskRecord } | { collection: 'memory'; value: Memory };
export function migrateTeam(store: Store) {
  for (const task of store.all('tasks'))
    if (task.status === 'running')
      store.put('tasks', {
        ...task,
        status: 'failed',
        error: 'Host restarted during this task. No work resumed automatically.',
        finishedAt: new Date().toISOString(),
      });
  if (!store.config('team-v2')) {
    const categories = [
      { id: 'leadership', name: 'Coordination', color: '#d77cdb' },
      { id: 'research', name: 'Research & planning', color: '#83b7d8' },
      { id: 'personal', name: 'Personal helpers', color: '#94ba80' },
      { id: 'workers', name: 'Workers', color: '#e7b974' },
    ];
    for (const c of categories) store.put('categories', c);
    for (const b of store.all('bots'))
      if (!b.categoryId)
        store.put('bots', {
          ...b,
          categoryId: /worker/i.test(b.id)
            ? 'workers'
            : /boss/.test(b.id)
              ? 'leadership'
              : /research|compar|network|market|job/i.test(b.id)
                ? 'research'
                : 'personal',
        });
    store.setConfig('team-v2', true);
  }
  for (const b of store.all('bots'))
    if (b.cloneStatus === 'active')
      store.put('bots', { ...b, cloneStatus: 'retired', enabled: false });
  for (const run of store.all('runs'))
    if (!run.work?.length && !store.get('tasks', `legacy-${run.id}`)) {
      const bot = store.get('bots', run.botId);
      if (!bot) continue;
      const result = store
        .all('messages')
        .find((m) => m.runId === run.id && m.botId === bot.id && m.role === 'assistant')?.content;
      store.put('tasks', {
        id: `legacy-${run.id}`,
        runId: run.id,
        conversationId: run.conversationId,
        botId: bot.id,
        botName: bot.name,
        avatar: bot.avatar,
        prototypeId: bot.prototypeId,
        task: run.task,
        prompt: run.prompt,
        result,
        error: run.status === 'running' ? 'Host restarted during this task.' : run.error,
        status: run.status === 'running' ? 'failed' : run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        tokens: run.tokens,
        memoryIds: [],
        milestones: [],
      });
    }
  for (const run of store.all('runs'))
    for (const work of run.work ?? [])
      if (!store.get('tasks', work.id)) {
        const bot = store.get('bots', work.botId);
        if (!bot) continue;
        const handoff = run.events.findLast(
          (e) => e.handoffId === work.handoffId && e.handoff,
        )?.handoff;
        const reply = store
          .all('messages')
          .find(
            (m) =>
              m.runId === run.id &&
              m.role === 'assistant' &&
              (m.workId === work.id || (!work.handoffId && m.botId === work.botId)),
          );
        store.put('tasks', {
          id: work.id,
          runId: run.id,
          conversationId: run.conversationId,
          botId: bot.id,
          botName: bot.name,
          avatar: bot.avatar,
          prototypeId: bot.prototypeId,
          task: work.task,
          prompt: handoff?.brief ?? run.prompt,
          result: handoff?.answer ?? reply?.content,
          error: handoff?.error ?? (work.status === 'failed' ? run.error : undefined),
          status: work.status === 'running' ? 'failed' : work.status,
          startedAt: work.startedAt,
          finishedAt: work.finishedAt,
          tokens: work.attempts.reduce((n, a) => n + a.tokens, 0),
          memoryIds: [],
          milestones: work.progress?.milestones ?? [],
        });
      }
}
export function tasksFor(store: Store, botId: string) {
  return store
    .all('tasks')
    .filter((t) => t.botId === botId || t.prototypeId === botId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
export function phraseSuggestions(store: Store, bot: Bot) {
  const tasks = tasksFor(store, bot.id),
    routines = store.all('routines').filter((r) => r.botId === bot.id);
  const text =
    `${bot.name} ${bot.title} ${bot.instructions} ${routines.map((r) => r.prompt.slice(0, 500)).join(' ')}`.toLowerCase();
  const worker =
    /worker|code|build|software|program/.test(text) || tasks.some((t) => t.task === 'coding');
  const researcher =
    /research|investigat|compar|source|planning/.test(text) ||
    tasks.some((t) => t.task === 'research');
  const phrases: ProcessingPhrases = {
    general: worker
      ? ['Rolling up sleeves', 'Cracking knuckles', 'Grinding it out', 'Chipping away']
      : ['Pouring a little coffee', 'Putting ideas in order', 'Getting the ducks in a row'],
    responding: ['Tying a tiny bow', 'Polishing the handoff'],
    waiting: ['Keeping a seat warm', 'Letting the crew cook'],
  };
  if (worker)
    phrases.coding = [
      'Rolling up sleeves',
      'Cracking knuckles',
      'Stitching the pieces together',
      'Grinding it out',
    ];
  if (researcher) {
    phrases.research = [
      'Pouring coffee',
      'Following the breadcrumbs',
      'Connecting a few dots',
      'Turning over the clues',
    ];
    phrases.planning = ['Planning the roadmap', 'Laying out the stepping stones'];
  }
  if (/write|story|draft|edit/.test(text))
    phrases.writing = ['Sharpening a pencil', 'Finding the right words', 'Polishing a little gem'];
  return {
    phrases,
    basis: { instructions: true, pastTasks: tasks.length, futureRoutines: routines.length },
    notice:
      'Suggestions are vocabulary, not claims that an action occurred. Review and edit before saving.',
  };
}
export function compactionPlan(store: Store, botId: string, amount: number) {
  if (!Number.isInteger(amount) || amount < 0 || amount > 100)
    throw Error('Choose a compaction amount from 0 to 100.');
  const tasks = tasksFor(store, botId).reverse(),
    memory = store
      .all('memory')
      .filter((m) => m.botId === botId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const eligible: Item[] = [
    ...tasks
      .slice(2, -10)
      .filter((t) => !t.pinned && !t.compacted && t.status !== 'running')
      .map((value) => ({ collection: 'tasks' as const, value })),
    ...memory
      .slice(3, -10)
      .filter((m) => !m.pinned && !m.compacted && !['profile', 'behavior'].includes(m.category))
      .map((value) => ({ collection: 'memory' as const, value })),
  ];
  const count = Math.round((eligible.length * amount) / 100),
    selected = Array.from(
      { length: count },
      (_, i) => eligible[Math.floor((i * eligible.length) / count)],
    );
  const after = selected
    .map((item) =>
      item.collection === 'tasks'
        ? {
            collection: item.collection,
            value: {
              ...item.value,
              prompt: brief(item.value.prompt, 240),
              result: item.value.result ? brief(item.value.result) : undefined,
              compacted: true,
            },
          }
        : {
            collection: item.collection,
            value: { ...item.value, content: brief(item.value.content), compacted: true },
          },
    )
    .filter((item, i) => bytes(item.value) < bytes(selected[i].value));
  const before = after.map((item) =>
    selected.find((x) => x.collection === item.collection && x.value.id === item.value.id)!,
  );
  const archive = gzipSync(Buffer.from(JSON.stringify(before))).toString('base64');
  const liveBefore = bytes(before),
    liveAfter = bytes(after),
    archiveBytes = Buffer.byteLength(archive);
  return {
    botId,
    amount,
    hash: hash(before),
    protected: {
      formationTasks: Math.min(2, tasks.length),
      recentTasks: Math.min(10, tasks.length),
      formationMemories: Math.min(3, memory.length),
      recentMemories: Math.min(10, memory.length),
    },
    eligible: eligible.length,
    records: after.length,
    liveBefore,
    liveAfter,
    activeBytesSaved: Math.max(0, liveBefore - liveAfter),
    archiveBytes,
    estimatedNetBytesSaved: Math.max(0, liveBefore - liveAfter - archiveBytes - 600),
    before,
    after,
    archive,
    notice:
      'Core profile/behavior and pinned memories, first tasks, and the latest 10 items are protected. Conversation, code, ratings and file copies remain unchanged. The compressed undo archive uses space; SQLite disk size will differ from these logical estimates.',
  };
}
export function applyCompaction(store: Store, botId: string, amount: number, expectedHash: string) {
  const plan = compactionPlan(store, botId, amount);
  if (plan.hash !== expectedHash) throw Error('History changed. Preview compaction again.');
  if (!plan.records) throw Error('No eligible detail would be reduced.');
  const record: CompactionRecord = {
    id: randomUUID(),
    botId,
    amount,
    createdAt: new Date().toISOString(),
    archive: plan.archive,
    afterHash: hash(plan.after),
    recordIds: plan.after.map((i) => ({ collection: i.collection, id: i.value.id })),
  };
  store.db.exec('BEGIN');
  try {
    for (const item of plan.after)
      if (item.collection === 'tasks') store.put('tasks', item.value as TaskRecord);
      else store.put('memory', item.value as Memory);
    store.put('compactions', record);
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
  return { id: record.id, records: plan.records, activeBytesSaved: plan.activeBytesSaved };
}
export function undoCompaction(store: Store, id: string) {
  const record = store.get('compactions', id);
  if (!record || record.restoredAt) throw Error('Choose an active compaction archive.');
  const current = record.recordIds.map((r) => ({
    collection: r.collection,
    value: store.get(r.collection, r.id),
  }));
  if (hash(current) !== record.afterHash)
    throw Error(
      'These records were edited after compaction. Restore from the archive manually to avoid overwriting newer edits.',
    );
  const before = JSON.parse(
    gunzipSync(Buffer.from(record.archive, 'base64'), { maxOutputLength: 20000000 }).toString(),
  ) as Item[];
  store.db.exec('BEGIN');
  try {
    for (const item of before)
      if (item.collection === 'tasks') store.put('tasks', item.value);
      else store.put('memory', item.value);
    store.put('compactions', { ...record, restoredAt: new Date().toISOString() });
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
}
