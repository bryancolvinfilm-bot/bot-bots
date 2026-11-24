import { Clock3, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import type { Bootstrap, Bot, Routine, Run } from '../../../packages/shared/types';
import { Avatar } from './Avatar';
import { api } from './api';

import { Field, Heading, Modal } from './ui';
export function Routines({
  data,
  act,
  onRun,
}: {
  data: Bootstrap;
  act: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
  onRun: (r: Run) => void;
}) {
  const [editing, setEditing] = useState<Routine | null>();
  return (
    <main className="page">
      <Heading
        eyebrow="A RHYTHM FOR YOUR TEAM"
        title="Little routines, lasting help."
        description="Scheduled work, on the machine hosting your team. All times use each routine’s timezone."
      >
        <button className="primary" onClick={() => setEditing(null)}>
          <Plus size={16} />
          New routine
        </button>
      </Heading>
      <div className="notice">
        <Clock3 size={21} />
        <div>
          <strong>Restored, and taking a breather.</strong>
          <p>
            Imported routines start paused. Review their prompts and reconnect required services
            before enabling them. The host must be awake for routines to run.
          </p>
        </div>
      </div>
      <div className="routine-list">
        {data.routines.map((r) => {
          const b = data.bots.find((b) => b.id === r.botId);
          return (
            <article className="panel routine-card" key={r.id}>
              {b && <Avatar avatar={b.avatar} size={55} />}
              <div>
                <h3>{r.name}</h3>
                <p>
                  {b?.name} <span>·</span> <code>{r.cron}</code> <span>·</span> {r.timezone}
                </p>
                <small>
                  {r.nextRun ? `Next: ${new Date(r.nextRun).toLocaleString()}` : 'Paused'}
                  {r.error && ` · ${r.error}`}
                </small>
              </div>
              <button
                className="secondary small"
                onClick={() =>
                  void act(async () => onRun(await api<Run>(`/routines/${r.id}/run`, 'POST')))
                }
              >
                Run now
              </button>
              <button
                className="icon-button"
                aria-label={`Edit ${r.name}`}
                onClick={() => setEditing(r)}
              >
                <Pencil size={16} />
              </button>
              <label className="switch">
                <input
                  aria-label={`Enable ${r.name}`}
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) =>
                    void act(() =>
                      api(`/routines/${r.id}`, 'PUT', { ...r, enabled: e.target.checked }),
                    )
                  }
                />
                <span />
              </label>
            </article>
          );
        })}
      </div>
      {editing !== undefined && (
        <RoutineEditor
          routine={editing}
          bots={data.bots.filter(
            (b) => !b.prototypeId && !b.isPrototype && !b.archivedAt && !b.deletedAt,
          )}
          close={() => setEditing(undefined)}
          save={async (r) => {
            await api(
              editing ? `/routines/${editing.id}` : '/routines',
              editing ? 'PUT' : 'POST',
              r,
            );
            setEditing(undefined);
            await act(async () => {}, 'Routine saved');
          }}
        />
      )}
    </main>
  );
}

export function RoutineEditor({
  routine,
  bots,
  close,
  save,
  defaultBotId = 'boss-man',
}: {
  routine: Routine | null;
  bots: Bot[];
  close: () => void;
  save: (r: Routine) => Promise<void>;
  defaultBotId?: string;
}) {
  const [r, setR] = useState<Routine>(
    routine ?? {
      id: '',
      name: '',
      botId: defaultBotId,
      cron: '0 9 * * 1',
      timezone: 'America/Los_Angeles',
      prompt: '',
      enabled: false,
    },
  );
  const [error, setError] = useState('');
  return (
    <Modal title="Make a little routine" close={close} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(r).catch((e) => setError(e.message));
        }}
      >
        <Field label="Routine name">
          <input required value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} />
        </Field>
        <Field label="Which bot?">
          <select value={r.botId} onChange={(e) => setR({ ...r, botId: e.target.value })}>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="two-columns">
          <Field label="Cron expression">
            <input required value={r.cron} onChange={(e) => setR({ ...r, cron: e.target.value })} />
            <small>Minute · hour · day · month · weekday</small>
          </Field>
          <Field label="Timezone">
            <input
              required
              value={r.timezone}
              onChange={(e) => setR({ ...r, timezone: e.target.value })}
            />
          </Field>
        </div>
        <Field label="What should happen?">
          <textarea
            rows={12}
            required
            value={r.prompt}
            onChange={(e) => setR({ ...r, prompt: e.target.value })}
          />
        </Field>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => setR({ ...r, enabled: e.target.checked })}
          />
          Enable this routine
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="modal-footer">
          <button className="primary">Save routine</button>
        </div>
      </form>
    </Modal>
  );
}
