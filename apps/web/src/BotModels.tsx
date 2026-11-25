import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  Bootstrap,
  Bot,
  Model,
  Conversation,
  WorkRecord,
} from '../../../packages/shared/types';
import { runningChatModels, contextDescription } from '../../../packages/shared/chat-models';
import { effortOptions } from '../../../packages/shared/model-effort';
import { api } from './api';
import { Field, Modal } from './ui';
import { FrontierConnections } from './FrontierConnections';

export function ChatModelControls({
  bot,
  data,
  model,
  conversation,
  changed,
  refresh,
  context,
}: {
  bot: Bot;
  data: Bootstrap;
  model?: Model;
  conversation?: Conversation;
  changed: (value: Conversation) => void;
  refresh: () => Promise<void>;
  context?: WorkRecord['context'];
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const choices = runningChatModels(data.models, data.providers).filter(
    (m) =>
      !data.accessRole ||
      data.accessRole === 'owner' ||
      (m.enabled &&
        (!data.settings.localOnly || data.providers.find((p) => p.id === m.providerId)?.local)),
  );
  const online = choices.filter((m) => !data.providers.find((p) => p.id === m.providerId)?.local);
  const local = choices.filter((m) => data.providers.find((p) => p.id === m.providerId)?.local);
  const preference = conversation?.modelId !== undefined ? conversation.modelId : bot.modelId;
  const selected = choices.find((m) => m.id === preference) ?? model ?? choices[0];
  const provider = data.providers.find((p) => p.id === selected?.providerId);
  const efforts = effortOptions(selected, provider);
  const inheritedEffort =
    conversation?.modelId !== undefined ? conversation.reasoningEffort : bot.reasoningEffort;
  const effort = preference && selected?.id !== preference ? null : inheritedEffort;
  const disabled =
    busy || data.accessRole === 'viewer' || !conversation || bot.cloneStatus === 'retired';
  async function update(patch: object) {
    if (!conversation) return;
    setBusy(true);
    setError('');
    try {
      changed(await api<Conversation>(`/conversations/${conversation.id}/model`, 'PUT', patch));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the model.');
    } finally {
      setBusy(false);
    }
  }
  const option = (m: Model) => {
    const p = data.providers.find((p) => p.id === m.providerId)!;
    return (
      <option key={m.id} value={m.id}>
        {p.kind === 'claude-code' ? 'Claude' : p.kind === 'chatgpt' ? 'ChatGPT' : p.name} · {m.name}
      </option>
    );
  };
  return (
    <div className="chat-model-controls">
      <label>
        <span>Model</span>
        <select
          aria-label="Chat model"
          disabled={disabled || !choices.length}
          value={preference && choices.some((m) => m.id === preference) ? preference : ''}
          onChange={(e) => void update({ modelId: e.target.value || null, reasoningEffort: null })}
        >
          <option value="">
            {choices.length ? `Suggested · ${model?.name ?? choices[0].name}` : 'No running models'}
          </option>
          {!!online.length && (
            <optgroup label="Online · frontier models">{online.map(option)}</optgroup>
          )}
          {!!online.length && !!local.length && (
            <option disabled value="__separator__">
              ────────────────
            </option>
          )}
          {!!local.length && (
            <optgroup label="Local · running models">{local.map(option)}</optgroup>
          )}
        </select>
      </label>
      <label>
        <span>Effort</span>
        <select
          aria-label="Reasoning effort"
          disabled={disabled || !efforts.length}
          value={effort && efforts.includes(effort) ? effort : ''}
          onChange={(e) =>
            void update({ modelId: selected?.id, reasoningEffort: e.target.value || null })
          }
        >
          <option value="">{efforts.length ? 'Default' : 'Model managed'}</option>
          {efforts.map((e) => (
            <option key={e} value={e}>
              {e[0].toUpperCase() + e.slice(1)}
            </option>
          ))}
        </select>
      </label>
      {(!data.accessRole || data.accessRole === 'owner') && (
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          aria-label="Refresh running models"
          title="Refresh running models"
          onClick={() => {
            setBusy(true);
            setError('');
            void api('/models/refresh', 'POST', {})
              .then(refresh)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          ↻
        </button>
      )}
      {selected && (
        <small
          className="chat-context-status"
          title={
            context
              ? 'Estimated working context. Your visible chat history stays saved when older working context is compacted.'
              : contextDescription(selected, provider)
          }
        >
          {context
            ? `${context.status === 'compacting' ? 'Making room · ' : ''}Context ~${context.inputTokens.toLocaleString()}${context.windowTokens ? ` / ${context.windowTokens.toLocaleString()}` : ' · provider managed'}${context.compactions ? ` · compacted ${context.compactions}×` : ''}`
            : contextDescription(selected, provider)}
        </small>
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
