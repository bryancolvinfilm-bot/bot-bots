import { Pencil, Plus, Radio, RefreshCw, Server, ShieldCheck, Zap } from 'lucide-react';
import { useState } from 'react';
import type { Bootstrap, Model, Provider } from '../../../packages/shared/types';
import { api } from './api';
import { ExperienceTable } from './ExperienceTable';
import { openCredentials } from './CredentialManager';
import { FrontierConnections } from './FrontierConnections';
import { effectiveContext, canUseTools } from '../../../packages/shared/model-routing';

import { Field, Heading, Modal } from './ui';
export function Models({
  data,
  act,
}: {
  data: Bootstrap;
  act: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const [provider, setProvider] = useState<Provider | null>();
  const [model, setModel] = useState<Model>();
  const [manual, setManual] = useState('');
  const [manualProvider, setManualProvider] = useState('lm-studio');
  const [busy, setBusy] = useState('');
  const discover = async (p: Provider) => {
    setBusy(p.id);
    await act(() => api(`/providers/${p.id}/discover`, 'POST'), 'Model list refreshed');
    setBusy('');
  };
  return (
    <main className="page">
      <Heading
        eyebrow="THE RIGHT BRAIN FOR THE JOB"
        title="Model workshop"
        description="A home for models on this machine, across your network, and in the cloud."
      >
        {(!data.accessRole || data.accessRole === 'owner') && (
          <button className="secondary" onClick={() => openCredentials()}>
            Keys & passwords
          </button>
        )}
        <button className="primary" onClick={() => setProvider(null)}>
          <Plus size={16} />
          Add a model server
        </button>
      </Heading>
      {(!data.accessRole || data.accessRole === 'owner') && <FrontierConnections act={act} />}
      <div className="notice">
        <ShieldCheck size={20} />
        <div>
          <strong>
            {data.settings.localOnly ? 'Local-only mode is on' : 'Cloud models are allowed'}
          </strong>
          <p>
            {data.settings.localOnly
              ? 'All model inference uses your enabled local model servers. Browser searches still visit public websites.'
              : 'Enabled cloud models can receive bot instructions and conversation context.'}
          </p>
        </div>
        <label className="switch">
          <input
            aria-label="Local-only mode"
            type="checkbox"
            checked={data.settings.localOnly}
            onChange={(e) =>
              void act(() =>
                api('/settings', 'PUT', { ...data.settings, localOnly: e.target.checked }),
              )
            }
          />
          <span />
        </label>
      </div>
      <div className="section-heading">
        <div className="model-auto-choice">
          <label className="checkbox-label">
            <input
              type="radio"
              name="model-selection"
              aria-label="Automatically follow available models"
              checked={data.settings.modelSelection !== 'manual'}
              onChange={() =>
                void act(() =>
                  api('/settings', 'PUT', { ...data.settings, modelSelection: 'auto' }),
                )
              }
            />
            Auto · follow loaded local models
          </label>
          <small>
            Checks every 15 seconds and before bot requests. Explicitly disabled models stay
            disabled; cloud models require your opt-in.
          </small>
        </div>
      </div>
      <div className="section-heading">
        <h2>
          Your model servers <span>{data.providers.length}</span>
        </h2>
        <small>URLs with or without /v1 are supported.</small>
      </div>
      <div className="provider-grid">
        {data.providers.map((p) => (
          <article className="panel provider-card" key={p.id}>
            <div className="provider-top">
              <div className="server-icon">
                <Server size={21} />
              </div>
              <div>
                <h3>{p.name}</h3>
                <span className="subtle">
                  {p.local ? 'Local / network' : 'Cloud API'} · {p.enabled ? 'Enabled' : 'Paused'}
                </span>
              </div>
              {!['chatgpt', 'claude-code'].includes(p.kind) && (
                <button
                  className="icon-button"
                  aria-label={`Edit ${p.name}`}
                  onClick={() => setProvider(p)}
                >
                  <Pencil size={15} />
                </button>
              )}
            </div>
            <code>{p.baseUrl}</code>
            {p.error && <p className="error-text">{p.error}</p>}
            <div className="provider-footer">
              <small>
                {p.discoveredAt
                  ? `Checked ${new Date(p.discoveredAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                  : 'Not checked yet'}
              </small>
              <button
                className="secondary small"
                disabled={!!busy}
                onClick={() => void discover(p)}
              >
                <RefreshCw className={busy === p.id ? 'spin' : ''} size={13} />
                Discover models
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="section-heading">
        <h2>
          Available models <span>{data.models.length}</span>
        </h2>
        <small>
          Loaded models can receive work now. Other local chat models become ready when loaded on
          their server.
        </small>
      </div>
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Server</th>
              <th>Health</th>
              <th>Priority</th>
              <th>Default</th>
              <th>Use model</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m) => (
              <tr key={m.id}>
                <td>
                  <button className="model-name" onClick={() => setModel(m)}>
                    <strong>{m.name}</strong>
                    <Pencil size={11} />
                  </button>
                  <small>
                    {m.lastError ??
                      `${effectiveContext(m).toLocaleString()} ${m.loadedContextTokens ? 'loaded context' : 'configured context'}${m.modelType && m.modelType !== 'llm' ? ` · ${m.modelType} · excluded from chat` : ''}${m.maxContextTokens ? ` · ${m.maxContextTokens.toLocaleString()} model maximum` : ''}`}
                  </small>
                  {!canUseTools(m) && (
                    <small>
                      Text only{m.toolFormatUnsupported ? ' · tool format needs a retry' : ''}
                    </small>
                  )}
                </td>
                <td>{data.providers.find((p) => p.id === m.providerId)?.name}</td>
                <td>
                  <span className={`status-badge ${m.status}`}>
                    <span />
                    {m.status === 'online'
                      ? m.loadState === 'loaded'
                        ? 'Loaded'
                        : m.loadState === 'unloaded'
                          ? 'Not loaded'
                          : 'Advertised'
                      : m.status}
                  </span>
                </td>
                <td>
                  <input
                    aria-label={`Priority for ${m.name}`}
                    className="number-input"
                    type="number"
                    min="0"
                    max="1000"
                    defaultValue={m.priority}
                    onBlur={(e) => {
                      const priority = Number(e.target.value);
                      if (priority !== m.priority)
                        void act(() =>
                          api(`/models/${encodeURIComponent(m.id)}`, 'PUT', { ...m, priority }),
                        );
                    }}
                  />
                </td>
                <td>
                  <input
                    type="radio"
                    aria-label={`Default ${m.name}`}
                    checked={
                      data.settings.modelSelection === 'manual' &&
                      m.id === data.settings.defaultModelId
                    }
                    disabled={m.modelType !== undefined && m.modelType !== 'llm'}
                    onChange={() =>
                      void act(async () => {
                        if (!m.enabled)
                          await api(`/models/${encodeURIComponent(m.id)}`, 'PUT', {
                            ...m,
                            enabled: true,
                            enablement: 'manual',
                          });
                        await api('/settings', 'PUT', {
                          ...data.settings,
                          defaultModelId: m.id,
                          modelSelection: 'manual',
                        });
                      })
                    }
                  />
                </td>
                <td>
                  <label className="switch">
                    <input
                      aria-label={`Enable ${m.name}`}
                      type="checkbox"
                      checked={m.enabled}
                      disabled={m.modelType !== undefined && m.modelType !== 'llm'}
                      onChange={(e) =>
                        void act(() =>
                          api(`/models/${encodeURIComponent(m.id)}`, 'PUT', {
                            ...m,
                            enabled: e.target.checked,
                            enablement: 'manual',
                          }),
                        )
                      }
                    />
                    <span />
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(
            () => api('/models', 'POST', { providerId: manualProvider, name: manual }),
            'Model added; enable it when ready',
          );
          setManual('');
        }}
      >
        <select
          aria-label="Model server"
          value={manualProvider}
          onChange={(e) => setManualProvider(e.target.value)}
        >
          {data.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          aria-label="Manual model ID"
          placeholder="Or add a model by its exact API ID…"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          required
        />
        <button className="secondary">
          <Plus size={15} />
          Add model
        </button>
      </form>
      <ExperienceTable data={data} />
      <div className="two-columns">
        <div className="panel explanation">
          <div className="section-icon">
            <Zap size={21} />
          </div>
          <h3>Good enough, by experience.</h3>
          <p>
            Your ratings lead model selection for each bot and task. Timing feedback and measured
            speed help when you ask for a faster response. Cost and priority break ties.
          </p>
          <p>Give replies a star rating in chat to teach the router what works for you.</p>
        </div>
        <div className="panel explanation">
          <div className="section-icon">
            <Radio size={21} />
          </div>
          <h3>A backup plan, built in.</h3>
          <p>
            If a model fails, the task moves to the next enabled model. Lower priority numbers are
            preferred. Offline models are retried after healthy alternatives.
          </p>
          <p>
            If every enabled model is unavailable, the app records an incident and can call your
            email and SMS alert APIs. Configure those in Settings.
          </p>
          <small>
            “Advertised” means the server lists this model, not that it is loaded in GPU memory.
            Local servers default to following loaded models. Checking a downloaded model does not
            load its weights.
          </small>
        </div>
      </div>
      {provider !== undefined && (
        <ProviderEditor
          provider={provider}
          close={() => setProvider(undefined)}
          save={async (p) => {
            await api(
              provider ? `/providers/${provider.id}` : '/providers',
              provider ? 'PUT' : 'POST',
              p,
            );
            setProvider(undefined);
            await act(async () => {}, 'Model server saved');
          }}
        />
      )}
      {model && (
        <ModelEditor
          model={model}
          provider={data.providers.find((p) => p.id === model.providerId)}
          close={() => setModel(undefined)}
          save={async (m) => {
            await api(`/models/${encodeURIComponent(m.id)}`, 'PUT', m);
            setModel(undefined);
            await act(async () => {}, 'Model preferences saved');
          }}
        />
      )}
    </main>
  );
}

export function ProviderEditor({
  provider,
  close,
  save,
}: {
  provider: Provider | null;
  close: () => void;
  save: (p: Provider) => Promise<void>;
}) {
  const [p, setP] = useState<Provider>(
    provider ?? {
      id: '',
      name: '',
      kind: 'openai-compatible',
      baseUrl: 'http://192.168.1.100:1234/v1',
      apiKeyEnv: '',
      enabled: true,
      local: true,
      timeoutMs: 180000,
    },
  );
  const [error, setError] = useState('');
  return (
    <Modal title={provider ? 'Edit model server' : 'Meet another model server'} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(p).catch((e) => setError(e.message));
        }}
      >
        <p className="form-intro">
          Connect a local model server, OpenAI’s API (including available Codex models), or Claude’s
          API. Cloud APIs require your own server-side key and local-only mode to be off.
        </p>
        <Field label="Provider / protocol">
          <select
            value={p.kind}
            onChange={(e) => {
              const kind = e.target.value as Provider['kind'];
              setP({
                ...p,
                kind,
                ...(kind === 'anthropic'
                  ? {
                      name: 'Claude API',
                      baseUrl: 'https://api.anthropic.com/v1',
                      apiKeyEnv: 'ANTHROPIC_API_KEY',
                      local: false,
                    }
                  : kind === 'openai-responses'
                    ? {
                        name: 'OpenAI API',
                        baseUrl: 'https://api.openai.com/v1',
                        apiKeyEnv: 'OPENAI_API_KEY',
                        local: false,
                      }
                    : { local: true }),
              });
            }}
          >
            <option value="openai-compatible">LM Studio / OpenAI-compatible</option>
            <option value="openai-responses">OpenAI Responses · GPT / Codex API models</option>
            <option value="anthropic">Anthropic · Claude Messages</option>
          </select>
        </Field>
        <Field label="Server name">
          <input
            required
            value={p.name}
            onChange={(e) => setP({ ...p, name: e.target.value })}
            placeholder="GPU workstation"
          />
        </Field>
        <Field label="API base URL">
          <input
            required
            type="url"
            value={p.baseUrl}
            onChange={(e) => setP({ ...p, baseUrl: e.target.value })}
          />
        </Field>
        <Field label="API key environment variable (optional)">
          <input
            value={p.apiKeyEnv}
            onChange={(e) => setP({ ...p, apiKeyEnv: e.target.value })}
            placeholder="MODEL_API_KEY"
          />
          <small>Store the key on the server, never in the UI or a bot prompt.</small>
        </Field>
        <Field label="Saved credential connection (optional)">
          <input
            value={p.credentialId ?? ''}
            onChange={(e) => setP({ ...p, credentialId: e.target.value || undefined })}
            placeholder="External model binding ID, e.g. openai-main"
          />
          <small>
            The host uses its OS-stored key only for the URL granted outside Bot-Bots. A revoked
            connection never falls back to an environment key.
          </small>
        </Field>
        <Field label="Request timeout (seconds)">
          <input
            type="number"
            min="1"
            max="600"
            value={p.timeoutMs / 1000}
            onChange={(e) => setP({ ...p, timeoutMs: Number(e.target.value) * 1000 })}
          />
        </Field>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={p.autoDiscover ?? p.local}
            onChange={(e) => setP({ ...p, autoDiscover: e.target.checked })}
          />
          Refresh this server automatically
        </label>
        {p.local && p.kind === 'openai-compatible' && (
          <>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={p.autoEnableModels !== false}
                onChange={(e) => setP({ ...p, autoEnableModels: e.target.checked })}
              />
              Automatically enable discovered local chat models
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={p.followLoadedModels !== false}
                onChange={(e) => setP({ ...p, followLoadedModels: e.target.checked })}
              />
              Use only models already loaded when the server reports load state
            </label>
            <small>
              Downloaded models remain visible. Turning off the loaded-model restriction lets
              compatible servers load weights on demand.
            </small>
          </>
        )}
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={p.local}
            onChange={(e) => setP({ ...p, local: e.target.checked })}
          />
          This is a local or trusted network model server
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={p.enabled}
            onChange={(e) => setP({ ...p, enabled: e.target.checked })}
          />
          Enable this server
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="modal-footer">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary">Save server</button>
        </div>
      </form>
    </Modal>
  );
}

export function ModelEditor({
  model,
  provider,
  close,
  save,
}: {
  model: Model;
  provider?: Provider;
  close: () => void;
  save: (m: Model) => Promise<void>;
}) {
  const [m, setM] = useState({ ...model, contextSource: model.contextSource ?? 'server' });
  const serviceContext = provider?.kind === 'claude-code' ? model.maxContextTokens : undefined;
  const [error, setError] = useState('');
  return (
    <Modal title="A good fit for the job" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(m).catch((e) => setError(e.message));
        }}
      >
        <p className="form-intro">{m.name}</p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={m.enablement !== 'manual'}
            onChange={(e) => setM({ ...m, enablement: e.target.checked ? 'auto' : 'manual' })}
          />
          Follow automatic model availability
        </label>
        <Field label="Native tool calling">
          <select
            aria-label="Native tool calling"
            value={m.toolCalling ?? 'auto'}
            onChange={(e) =>
              setM({ ...m, toolCalling: e.target.value as NonNullable<Model['toolCalling']> })
            }
          >
            <option value="auto">Auto · use server capability and compatibility</option>
            <option value="enabled">Enabled · try native tools</option>
            <option value="disabled">Text only · no native tool calls</option>
          </select>
          <small>
            Some small models can chat but cannot reliably format tool calls. Text-only replies
            cannot run tools.
          </small>
          {m.toolFormatUnsupported && (
            <div className="notice">
              <div>
                <strong>Tool-call format was rejected by the server.</strong>
                <p>
                  Auto currently uses text only. Save after choosing retry to check tools on the
                  next task.
                </p>
                <button
                  type="button"
                  className="secondary small"
                  onClick={() => setM({ ...m, toolCalling: 'auto', toolFormatUnsupported: false })}
                >
                  Retry tools on next task
                </button>
              </div>
            </div>
          )}
        </Field>
        <Field label="Good at these tasks">
          <div className="task-options">
            {(['general', 'research', 'coding', 'writing', 'planning'] as const).map((task) => (
              <label className="checkbox-label" key={task}>
                <input
                  type="checkbox"
                  checked={m.tasks.includes(task)}
                  onChange={(e) =>
                    setM({
                      ...m,
                      tasks: e.target.checked
                        ? [...m.tasks, task]
                        : m.tasks.filter((t) => t !== task),
                    })
                  }
                />
                {task}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Blended cost per million tokens (USD)">
          <input
            type="number"
            min="0"
            step="0.01"
            value={m.costPerMillion}
            onChange={(e) => setM({ ...m, costPerMillion: Number(e.target.value) })}
          />
        </Field>
        <Field label="Context window (tokens)">
          <select
            aria-label="Context source"
            value={m.contextSource ?? 'server'}
            onChange={(e) =>
              setM({
                ...m,
                contextSource: e.target.value as NonNullable<Model['contextSource']>,
                ...(e.target.value === 'server' && (serviceContext ?? m.loadedContextTokens)
                  ? { contextTokens: (serviceContext ?? m.loadedContextTokens)! }
                  : {}),
              })
            }
          >
            <option value="server">
              {serviceContext ? 'Auto · use service context' : 'Auto · use loaded server context'}
            </option>
            <option value="manual">Manual context cap</option>
          </select>
          <input
            type="number"
            min="512"
            disabled={m.contextSource !== 'manual'}
            value={m.contextTokens}
            onChange={(e) => setM({ ...m, contextTokens: Number(e.target.value) })}
          />
          <small>
            {serviceContext
              ? `Service context: ${serviceContext.toLocaleString()} tokens. Auto uses this window; a manual cap can lower it.`
              : m.loadedContextTokens
                ? `Server loaded: ${m.loadedContextTokens.toLocaleString()} tokens. Effective budget: ${effectiveContext(m).toLocaleString()}.`
                : 'No loaded context is reported. A manual value is used for servers without context metadata.'}{' '}
            {serviceContext
              ? 'Reasoning effort does not set the context window.'
              : 'The model’s advertised maximum is separate from its current loaded context.'}
          </small>
        </Field>
        <Field label="Reasoning effort">
          <select
            value={m.reasoningEffort ?? ''}
            onChange={(e) =>
              setM({
                ...m,
                reasoningEffort: (e.target.value || undefined) as Model['reasoningEffort'],
              })
            }
          >
            <option value="">Server default</option>
            {['none', 'low', 'medium', 'high'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <small>
            Qwen on this LM Studio server is verified with “none”. Other servers may support
            different values.
          </small>
        </Field>
        {error && <p className="error-text">{error}</p>}
        <div className="modal-footer">
          <button className="primary">Save preferences</button>
        </div>
      </form>
    </Modal>
  );
}
