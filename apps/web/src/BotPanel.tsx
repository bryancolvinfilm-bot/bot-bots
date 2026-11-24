import { useCallback, useEffect, useState } from 'react';
import { Clock3, Plus, X, Pencil, Play, Trash2, ArchiveRestore, Pin } from 'lucide-react';
import type { Bootstrap, Bot, Routine, Run } from '../../../packages/shared/types';
import type { TaskRecord, CompactionRecord } from '../../../packages/shared/team';
import { api } from './api';
import { RoutineEditor } from './Routines';
import { BotMessage } from './BotMentions';
import { BotInbox } from './BotInbox';
import { SkillLibrary } from './Skills';
const size = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);
export function BotPanel({
  bot,
  data,
  close,
  refresh,
  notify,
  openBot,
  onRun,
}: {
  bot: Bot;
  data: Bootstrap;
  close: () => void;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  openBot: (id: string, conversationId?: string) => void;
  onRun: (r: Run) => void;
}) {
  const [tab, setTab] = useState('routines'),
    [editing, setEditing] = useState<Routine | null>(),
    [tasks, setTasks] = useState<TaskRecord[]>([]),
    [archives, setArchives] = useState<Omit<CompactionRecord, 'archive'>[]>([]),
    [amount, setAmount] = useState(50),
    [plan, setPlan] = useState<any>(),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [history, compactions] = await Promise.all([
      api<TaskRecord[]>(`/bots/${bot.id}/history`),
      api<Omit<CompactionRecord, 'archive'>[]>(`/bots/${bot.id}/compactions`),
    ]);
    setTasks(history);
    setArchives(compactions);
  }, [bot.id]);
  useEffect(() => {
    setTasks([]);
    setPlan(undefined);
    void load().catch((e) => notify(e.message));
  }, [load]);
  useEffect(() => {
    void load().catch((e) => notify(e.message));
  }, [data.runs, load]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
      await load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const routines = data.routines.filter((r) => r.botId === bot.id),
    memories = data.memory.filter((m) => m.botId === bot.id);
  return (
    <aside className="bot-details-panel" aria-label={`${bot.name} panel`}>
      <header>
        <div>
          <strong>{bot.name}</strong>
          <small>
            {bot.isPrototype
              ? 'Worker prototype · shared task history'
              : 'Routines, experience, skills & memory'}
          </small>
        </div>
        <button className="icon-button" onClick={close} aria-label="Close bot panel">
          <X size={18} />
        </button>
      </header>
      <div className="tabs">
        {['routines', 'inbox', 'history', 'memory', 'skills'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="bot-panel-content">
        {tab === 'inbox' && <BotInbox bot={bot} bots={data.bots} openBot={openBot} />}
        {tab === 'skills' && (
          <SkillLibrary key={bot.id} botId={bot.prototypeId ?? bot.id} data={data} act={act} />
        )}
        {tab === 'routines' && (
          <>
            <div className="panel-title">
              <h3>
                <Clock3 size={17} />
                Bot routines
              </h3>
              <button
                className="secondary small"
                disabled={!!bot.prototypeId || bot.isPrototype}
                onClick={() => setEditing(null)}
              >
                <Plus size={14} />
                New
              </button>
            </div>
            {bot.isPrototype && (
              <p>
                Schedule a coordinator to launch this prototype’s workers. Clones retire when their
                task ends.
              </p>
            )}
            {routines.length === 0 && <p className="subtle">No routines for this bot yet.</p>}
            {routines.map((r) => (
              <article className="bot-routine" key={r.id}>
                <strong>{r.name}</strong>
                <small>
                  {r.cron} · {r.timezone}
                </small>
                <small>
                  {r.nextRun ? `Next: ${new Date(r.nextRun).toLocaleString()}` : 'Paused'}
                </small>
                {r.error && <p className="error-text">{r.error}</p>}
                <div className="button-row">
                  <button
                    className="secondary small"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => onRun(await api(`/routines/${r.id}/run`, 'POST')))
                    }
                  >
                    <Play size={12} />
                    Run now
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Edit ${r.name}`}
                    onClick={() => setEditing(r)}
                  >
                    <Pencil size={14} />
                  </button>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      aria-label={`Enable ${r.name}`}
                      checked={r.enabled}
                      onChange={(e) =>
                        void act(() =>
                          api(`/routines/${r.id}`, 'PUT', { ...r, enabled: e.target.checked }),
                        )
                      }
                    />
                    Enabled
                  </label>
                  <button
                    className="icon-button"
                    aria-label={`Delete ${r.name}`}
                    onClick={() => void act(() => api(`/routines/${r.id}`, 'DELETE'))}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </article>
            ))}
          </>
        )}
        {tab === 'history' && (
          <>
            <h3>Every little job</h3>
            <p className="subtle">
              Results, milestones and learned memories stay attached to durable task IDs. Prototype
              history includes its retired workers.
            </p>
            {tasks.length === 0 && <p>No task history yet.</p>}
            {tasks.map((t) => (
              <details className="task-history-entry" key={t.id}>
                <summary>
                  <strong>{t.prompt.slice(0, 90)}</strong>
                  <small>
                    {t.botName} · {t.status} · {new Date(t.startedAt).toLocaleString()}
                  </small>
                </summary>
                <small className="task-id">
                  Task {t.id} · {t.tokens.toLocaleString()} tokens
                </small>
                {t.compacted && (
                  <small>Older detail compacted · full conversation is retained</small>
                )}
                <p>{t.prompt}</p>
                {t.result && (
                  <BotMessage content={t.result} bots={data.bots} openBot={openBot} />
                )}{' '}
                {t.error && <p className="error-text">{t.error}</p>}
                {t.milestones.length > 0 && (
                  <p>Milestones: {t.milestones.map((m) => m.label).join(' → ')}</p>
                )}
                <p>
                  {t.memoryIds.length} learned/remembered{' '}
                  {t.memoryIds.length === 1 ? 'item' : 'items'}
                </p>
                {data.memory
                  .filter((m) => t.memoryIds.includes(m.id))
                  .map((m) => (
                    <blockquote key={m.id}>{m.content}</blockquote>
                  ))}
                <button
                  className="secondary small"
                  onClick={() => void act(async () => onRun(await api<Run>(`/runs/${t.runId}`)))}
                >
                  Open conversation
                </button>
              </details>
            ))}
          </>
        )}
        {tab === 'memory' && (
          <>
            <h3>What stays with {bot.name}</h3>
            <p className="subtle">
              Core/profile/behavior information, first records and the latest ten items are
              protected. Pin anything else you want to keep whole.
            </p>
            {memories.map((m) => (
              <details className="memory-note" key={m.id}>
                <summary>
                  {m.pinned && '📌 '}
                  {m.content.slice(0, 100)}
                </summary>
                <p>{m.content}</p>
                <button
                  className="secondary small"
                  onClick={() =>
                    void act(() =>
                      api(`/memory/${m.id}`, 'PUT', { content: m.content, pinned: !m.pinned }),
                    )
                  }
                >
                  <Pin size={12} />
                  {m.pinned ? 'Unpin' : 'Keep as core memory'}
                </button>
              </details>
            ))}
            <div className="compaction-control">
              <h3>Make a little room</h3>
              <label>
                Trim older middle detail <strong>{amount}%</strong>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={amount}
                  onChange={(e) => {
                    setAmount(Number(e.target.value));
                    setPlan(undefined);
                  }}
                />
              </label>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () =>
                    setPlan(await api(`/bots/${bot.id}/compaction/preview`, 'POST', { amount })),
                  )
                }
              >
                Preview compaction
              </button>
              {plan && (
                <div>
                  <p>
                    {plan.records} records · about <strong>{size(plan.activeBytesSaved)}</strong>{' '}
                    less active detail
                  </p>
                  <p>
                    Undo archive: {size(plan.archiveBytes)}. Estimated net record storage reduction:{' '}
                    {size(plan.estimatedNetBytesSaved)}.
                  </p>
                  <small>{plan.notice}</small>
                  <button
                    className="primary"
                    disabled={!plan.records || busy}
                    onClick={() =>
                      void act(async () => {
                        await api(`/bots/${bot.id}/compaction`, 'POST', {
                          amount,
                          hash: plan.hash,
                        });
                        setPlan(undefined);
                      })
                    }
                  >
                    Apply reviewed compaction
                  </button>
                </div>
              )}
            </div>
            {archives
              .filter((a) => !a.restoredAt)
              .map((a) => (
                <div className="undo-archive" key={a.id}>
                  <small>Compacted {new Date(a.createdAt).toLocaleString()}</small>
                  <button
                    className="secondary small"
                    disabled={busy}
                    onClick={() => void act(() => api(`/compactions/${a.id}/undo`, 'POST'))}
                  >
                    <ArchiveRestore size={13} />
                    Undo
                  </button>
                </div>
              ))}
          </>
        )}
      </div>
      {editing !== undefined && (
        <RoutineEditor
          routine={editing}
          bots={[bot]}
          defaultBotId={bot.id}
          close={() => setEditing(undefined)}
          save={async (r) => {
            await api(
              editing ? `/routines/${editing.id}` : '/routines',
              editing ? 'PUT' : 'POST',
              r,
            );
            setEditing(undefined);
            await refresh();
          }}
        />
      )}
    </aside>
  );
}
