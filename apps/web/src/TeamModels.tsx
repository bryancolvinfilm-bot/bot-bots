import { Fragment, useState } from 'react';
import type { Bootstrap } from '../../../packages/shared/types';
import { runningChatModels } from '../../../packages/shared/chat-models';
import { effortOptions } from '../../../packages/shared/model-effort';
import { Field, Modal } from './ui';
import { api } from './api';

export function TeamModels({
  data,
  close,
  refresh,
  workshop,
}: {
  data: Bootstrap;
  close: () => void;
  refresh: () => Promise<void>;
  workshop: () => void;
}) {
  const choices = runningChatModels(data.models, data.providers);
  const [id, setId] = useState(choices[0]?.id ?? ''),
    [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const model = choices.find((m) => m.id === id),
    provider = data.providers.find((p) => p.id === model?.providerId);
  const efforts = effortOptions(model, provider);
  const owner = !data.accessRole || data.accessRole === 'owner';
  async function save(action: 'apply' | 'reset') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ bots: number }>('/models/team-selection', 'POST', {
        action,
        ...(action === 'apply' ? { modelId: id, reasoningEffort: effort || null } : {}),
      });
      await refresh();
      setNotice(
        action === 'apply'
          ? `Updated ${result.bots} bots. You can change any chat individually.`
          : 'All bots now follow their profile defaults.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the team.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Team model" close={close}>
      <p>
        Choose a brain for every bot and conversation at once. This applies once; individual chats
        can change models afterward. Profile defaults stay saved.
      </p>
      <Field label="Model for all bots">
        <select
          aria-label="Team model"
          value={id}
          disabled={busy || !owner || !choices.length}
          onChange={(e) => {
            setId(e.target.value);
            setEffort('');
          }}
        >
          {!choices.length && <option value="">No running models</option>}
          {[false, true].map((local) => {
            const group = choices.filter(
              (m) => !!data.providers.find((p) => p.id === m.providerId)?.local === local,
            );
            return group.length ? (
              <Fragment key={String(local)}>
                {local &&
                  choices.some(
                    (m) => !data.providers.find((p) => p.id === m.providerId)?.local,
                  ) && (
                    <option disabled value="__separator__">
                      ────────────────
                    </option>
                  )}
                <optgroup label={local ? 'Local · running models' : 'Online · frontier models'}>
                  {group.map((m) => (
                    <option key={m.id} value={m.id}>
                      {data.providers.find((p) => p.id === m.providerId)?.name} · {m.name}
                    </option>
                  ))}
                </optgroup>
              </Fragment>
            ) : null;
          })}
        </select>
      </Field>
      <Field label="Effort">
        <select
          aria-label="Team effort"
          value={effort}
          disabled={busy || !owner || !efforts.length}
          onChange={(e) => setEffort(e.target.value)}
        >
          <option value="">{efforts.length ? 'Default' : 'Model managed'}</option>
          {efforts.map((e) => (
            <option key={e} value={e}>
              {e[0].toUpperCase() + e.slice(1)}
            </option>
          ))}
        </select>
      </Field>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="modal-actions">
        <button className="secondary" disabled={busy || !owner} onClick={() => void save('reset')}>
          Return all to defaults
        </button>
        <button
          className="primary"
          disabled={busy || !owner || !model}
          onClick={() => void save('apply')}
        >
          {busy ? 'Updating…' : 'Use for all bots'}
        </button>
      </div>
      <p className="subtle">
        Defaults use each bot’s profile suggestion and clear individual chat overrides.
      </p>
      <button className="secondary" onClick={workshop}>
        Open model workshop
      </button>
    </Modal>
  );
}
