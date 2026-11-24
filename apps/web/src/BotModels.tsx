import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Bootstrap, Bot, Model } from '../../../packages/shared/types';
import { effortOptions } from '../../../packages/shared/model-effort';
import { api } from './api';
import { Field, Modal } from './ui';
import { FrontierConnections } from './FrontierConnections';

export function BotModelPicker({
  bot,
  data,
  change,
}: {
  bot: Bot;
  data: Bootstrap;
  change: (bot: Bot) => void;
}) {
  const [catalog, setCatalog] = useState(data);
  const providers = [
    ...new Map([...data.providers, ...catalog.providers].map((p) => [p.id, p])).values(),
  ];
  const models = [...new Map([...data.models, ...catalog.models].map((m) => [m.id, m])).values()];
  const selected = providers.find(
    (p) => p.id === (bot.providerId ?? models.find((m) => m.id === bot.modelId)?.providerId),
  );
  const [tab, setTab] = useState(selected && !selected.local ? 'online' : 'local');
  const [connect, setConnect] = useState(false);
  const act = useCallback(async (fn: () => Promise<unknown>) => {
    await fn();
    setCatalog(await api<Bootstrap>('/bootstrap'));
  }, []);
  return (
    <div className="bot-model-picker">
      <div className="tabs" role="tablist" aria-label="Model location">
        {['local', 'online'].map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'active' : ''}
            onClick={() => setTab(t)}
          >
            {t === 'local' ? 'Local' : 'Online'}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tab === 'local' ? 'Local models' : 'Online services'}>
        {tab === 'local' ? (
          <Field label="Local model">
            <select
              aria-label="Local model"
              value={selected?.local ? (bot.modelId ?? `provider:${selected.id}`) : ''}
              onChange={(e) => {
                const value = e.target.value;
                const model = models.find((m) => m.id === value);
                change({
                  ...bot,
                  providerId:
                    model?.providerId ?? (value.startsWith('provider:') ? value.slice(9) : null),
                  modelId: model?.id ?? null,
                  reasoningEffort: null,
                });
              }}
            >
              <option value="">Auto · team router</option>
              {providers
                .filter((p) => p.local)
                .map((p) => (
                  <optgroup key={p.id} label={p.name}>
                    <option value={`provider:${p.id}`}>Auto · {p.name}</option>
                    {models
                      .filter(
                        (m) => m.providerId === p.id && (!m.modelType || m.modelType === 'llm'),
                      )
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
            </select>
          </Field>
        ) : (
          <>
            <Field label="Online service">
              <select
                aria-label="Online service"
                value={selected && !selected.local ? selected.id : ''}
                onChange={(e) =>
                  change({
                    ...bot,
                    providerId: e.target.value || null,
                    modelId: null,
                    reasoningEffort: null,
                  })
                }
              >
                <option value="">Choose a connected service…</option>
                {providers
                  .filter((p) => !p.local)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>
            <div className="button-row">
              <button type="button" className="secondary small" onClick={() => setConnect(true)}>
                Connect ChatGPT or Claude
              </button>
            </div>
            <small>
              Connect once for the team. Choose the model and effort in chat. Selecting an online
              service allows it to receive this bot’s conversation context.
            </small>
          </>
        )}
      </div>
      {connect &&
        createPortal(
          <Modal title="Connect an online service" close={() => setConnect(false)} wide>
            <FrontierConnections act={act} />
            <button
              type="button"
              className="primary"
              onClick={() => {
                void api<Bootstrap>('/bootstrap').then(setCatalog);
                setConnect(false);
              }}
            >
              Done
            </button>
          </Modal>,
          document.body,
        )}
    </div>
  );
}

export function ChatModelControls({
  bot,
  data,
  model,
  refresh,
}: {
  bot: Bot;
  data: Bootstrap;
  model?: Model;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const providerId =
    bot.providerId ??
    data.models.find((m) => m.id === bot.modelId)?.providerId ??
    model?.providerId;
  const provider = data.providers.find((p) => p.id === providerId);
  const choices = data.models.filter(
    (m) => m.providerId === providerId && (!m.modelType || m.modelType === 'llm'),
  );
  const efforts = effortOptions(data.models.find((m) => m.id === bot.modelId) ?? model, provider);
  async function update(patch: object) {
    setBusy(true);
    setError('');
    try {
      await api(`/bots/${bot.id}/model`, 'PUT', patch);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the model.');
    } finally {
      setBusy(false);
    }
  }
  if ((data.accessRole && data.accessRole !== 'owner') || bot.prototypeId) return null;
  return (
    <div className="chat-model-controls">
      {provider && (
        <label>
          <span>{provider.name}</span>
          <select
            aria-label="Chat model"
            disabled={busy}
            value={bot.modelId ?? ''}
            onChange={(e) =>
              void update({ providerId, modelId: e.target.value || null, reasoningEffort: null })
            }
          >
            <option value="">Auto model</option>
            {choices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!!efforts.length && (
        <label>
          <span>Effort</span>
          <select
            aria-label="Reasoning effort"
            disabled={busy}
            value={bot.reasoningEffort ?? ''}
            onChange={(e) =>
              void update({
                providerId,
                modelId: bot.modelId ?? model?.id,
                reasoningEffort: e.target.value || null,
              })
            }
          >
            <option value="">Default</option>
            {efforts.map((e) => (
              <option key={e} value={e}>
                {e[0].toUpperCase() + e.slice(1)}
              </option>
            ))}
          </select>
        </label>
      )}
      {busy && <small>Saving…</small>}
      {error && (
        <small className="error-text" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
