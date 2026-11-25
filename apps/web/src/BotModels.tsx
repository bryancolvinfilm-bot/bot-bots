import { useCallback, useEffect, useState } from 'react';
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
import { RunningModelOptions } from './RunningModelOptions';

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
  const preference =
    conversation?.modelId !== undefined ? conversation.modelId : (bot.chatModelId ?? bot.modelId);
  const selected = choices.find((m) => m.id === preference) ?? model ?? choices[0];
  const provider = data.providers.find((p) => p.id === selected?.providerId);
  const efforts = effortOptions(selected, provider);
  const inheritedEffort =
    conversation?.modelId !== undefined
      ? conversation.reasoningEffort
      : bot.chatModelId
        ? bot.chatReasoningEffort
        : bot.reasoningEffort;
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
          <RunningModelOptions models={choices} providers={data.providers} />
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
  const [refreshing, setRefreshing] = useState(false),
    [error, setError] = useState('');
  useEffect(() => setCatalog(data), [data.models, data.providers]);
  const providers = [
    ...new Map([...data.providers, ...catalog.providers].map((p) => [p.id, p])).values(),
  ];
  const models = [...new Map([...data.models, ...catalog.models].map((m) => [m.id, m])).values()];
  const choices = runningChatModels(models, providers);
  const selected = choices.find((model) => model.id === bot.modelId);
  const provider = providers.find((p) => p.id === selected?.providerId);
  const efforts = effortOptions(selected, provider);
  const [connect, setConnect] = useState(false);
  const act = useCallback(async (fn: () => Promise<unknown>) => {
    await fn();
    setCatalog(await api<Bootstrap>('/bootstrap'));
  }, []);
  return (
    <div className="bot-model-picker">
      <Field label="Default model suggestion">
        <select
          aria-label="Bot model"
          disabled={refreshing}
          value={bot.modelId && !selected ? '__unavailable__' : (bot.modelId ?? '')}
          onChange={(e) => {
            const model = choices.find((m) => m.id === e.target.value);
            change({
              ...bot,
              providerId: model?.providerId ?? null,
              modelId: model?.id ?? null,
              reasoningEffort: null,
            });
          }}
        >
          <option value="">
            {bot.providerId
              ? `Auto · prefer ${providers.find((provider) => provider.id === bot.providerId)?.name ?? 'saved service'}`
              : 'Auto · team router'}
          </option>
          {bot.modelId && !selected && (
            <option disabled value="__unavailable__">
              Saved suggestion is unavailable
            </option>
          )}
          <RunningModelOptions models={choices} providers={providers} />
        </select>
      </Field>
      <Field label="Effort">
        <select
          aria-label="Bot effort"
          disabled={!efforts.length || refreshing}
          value={
            bot.reasoningEffort && efforts.includes(bot.reasoningEffort) ? bot.reasoningEffort : ''
          }
          onChange={(e) =>
            change({ ...bot, reasoningEffort: (e.target.value as Bot['reasoningEffort']) || null })
          }
        >
          <option value="">{efforts.length ? 'Default' : 'Model managed'}</option>
          {efforts.map((e) => (
            <option key={e} value={e}>
              {e[0].toUpperCase() + e.slice(1)}
            </option>
          ))}
        </select>
      </Field>
      <div className="button-row">
        <button
          type="button"
          className="secondary small"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            setError('');
            void act(() => api('/models/refresh', 'POST', {}))
              .catch((e) => setError(e.message))
              .finally(() => setRefreshing(false));
          }}
        >
          Refresh running models
        </button>
        <button type="button" className="secondary small" onClick={() => setConnect(true)}>
          Connect ChatGPT or Claude
        </button>
      </div>
      <small>
        Saved suggestions are defaults. Each conversation can choose another model in chat.
        {bot.isPrototype
          ? ' Worker clones follow this prototype’s conversation selection and effort.'
          : ''}
      </small>
      {bot.chatModelId && (
        <small>
          Team selection:{' '}
          {models.find((model) => model.id === bot.chatModelId)?.name ?? 'unavailable'}. Change this
          bot’s current conversation in chat, or return the team to defaults.
        </small>
      )}
      {error && (
        <small className="error-text" role="alert">
          {error}
        </small>
      )}
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
