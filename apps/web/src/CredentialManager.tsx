import { useEffect, useRef, useState } from 'react';
import { KeyRound, LockKeyhole, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { Bootstrap } from '../../../packages/shared/types';
import type { CredentialManagerState, SavedSecret } from '../../../packages/shared/credentials';
import type { CredentialSetup } from '../../../packages/shared/credential-setup';
import { credentialService } from '../../../packages/shared/credential-setup';
import { knownApi } from '../../../packages/shared/service-api';
import { api } from './api';
import { Avatar } from './Avatar';
import { Field, Modal } from './ui';
import './credentials.css';
import { openCredentials } from './credential-events';
export { openCredentials } from './credential-events';
type Use = 'store' | 'model' | 'operation' | 'alert' | 'service';
const fields = (value: string) =>
  value
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);

export function CredentialManager({
  data,
  refresh,
  notify,
}: {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [state, setState] = useState<CredentialManagerState>();
  const [setup, setSetup] = useState<CredentialSetup>();
  const offered = useRef(new Set<string>());
  const [editing, setEditing] = useState<SavedSecret | 'new'>(),
    [removing, setRemoving] = useState<SavedSecret>();
  const [name, setName] = useState(''),
    [kind, setKind] = useState<'api-key' | 'password'>('api-key'),
    [value, setValue] = useState('');
  const [use, setUse] = useState<Use>('store'),
    [providerId, setProviderId] = useState('openai');
  const [providerName, setProviderName] = useState('My model server'),
    [providerUrl, setProviderUrl] = useState('https://'),
    [providerKind, setProviderKind] = useState('openai-compatible');
  const [url, setUrl] = useState('https://'),
    [method, setMethod] = useState('GET'),
    [authType, setAuthType] = useState('bearer');
  const [username, setUsername] = useState(''),
    [header, setHeader] = useState('X-API-Key'),
    [botIds, setBotIds] = useState<string[]>([]);
  const [inputFields, setInputFields] = useState(''),
    [responseFields, setResponseFields] = useState('id, name, status, url');
  const [channel, setChannel] = useState('email'),
    [formVersion, setFormVersion] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const allowed = !data.accessRole || data.accessRole === 'owner';
  const knownProvider = (id: string) =>
    data.providers.find(
      (provider) =>
        provider.baseUrl.replace(/\/$/, '') ===
        (id === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1'),
    )?.id ?? id;
  const load = async () => {
    const next = await api<CredentialManagerState>('/credentials/manager');
    setState(next);
    return next;
  };
  function clear() {
    setValue('');
    setError('');
    setEditing(undefined);
    setRemoving(undefined);
  }
  function close() {
    if (busy) return;
    if (setup?.status === 'awaiting-entry')
      void api(`/credentials/manager/requests/${setup.id}/cancel`, 'POST', {}).catch(() => {});
    setSetup(undefined);
    clear();
    setOpen(false);
    setState(undefined);
  }
  function begin(secret?: SavedSecret, selectedProvider?: string, version = state?.version ?? '') {
    clear();
    setName(
      secret?.name ??
        data.providers.find((provider) => provider.id === selectedProvider)?.name ??
        (selectedProvider === 'anthropic'
          ? 'Claude'
          : selectedProvider === 'openai'
            ? 'OpenAI'
            : ''),
    );
    setKind(secret?.kind ?? 'api-key');
    setFormVersion(version);
    const connected = state?.connections.find(
      (connection) =>
        connection.secretId === secret?.id &&
        connection.purpose === 'service' &&
        connection.enabled,
    );
    setUse(selectedProvider ? 'model' : connected ? 'service' : 'store');
    setProviderId(selectedProvider ?? 'openai');
    setUrl('https://');
    setMethod('GET');
    setAuthType(secret?.kind === 'password' ? 'basic' : 'bearer');
    setUsername('');
    setHeader('X-API-Key');
    setBotIds(connected?.botIds ?? []);
    setInputFields('');
    setResponseFields('id, name, status, url');
    setChannel('email');
    setEditing(secret ?? 'new');
  }
  useEffect(() => {
    const listener = (event: Event) => {
      if (!allowed) return;
      const detail =
        (
          event as CustomEvent<{
            add?: boolean;
            providerId?: string;
            request?: CredentialSetup;
            requestId?: string;
          }>
        ).detail ?? {};
      clear();
      setOpen(true);
      void load()
        .then((next) => {
          const show = (request?: CredentialSetup) => {
            if (request) offered.current.add(request.id);
            setSetup(request);
            if (request) {
              const secret = next.secrets.find(
                (secret) =>
                  secret.present &&
                  (secret.name.toLowerCase() === request.service.toLowerCase() ||
                    (!!request.api && knownApi(secret.name)?.id === request.api.id)),
              );
              begin(
                secret,
                request.providerId ? knownProvider(request.providerId) : undefined,
                next.version,
              );
              setName(request.service);
              setKind(request.kind);
              setBotIds([
                ...new Set([
                  data.bots.find((bot) => bot.id === request.botId)?.prototypeId ?? request.botId,
                  ...next.connections
                    .filter(
                      (connection) =>
                        connection.enabled &&
                        connection.secretId === secret?.id &&
                        connection.api?.id === request.api?.id,
                    )
                    .flatMap((connection) => connection.botIds ?? []),
                ]),
              ]);
              if (request.connection) {
                const target = request.connection;
                setUse('operation');
                setUrl(target.url);
                setMethod(target.method);
                setAuthType(target.authType);
                setHeader(target.header ?? 'X-API-Key');
                setInputFields(target.inputFields.join(', '));
                setResponseFields(target.responseFields.join(', '));
              }
              if (request.api) setUse('service');
            } else if (detail.add || detail.providerId)
              begin(undefined, detail.providerId, next.version);
          };
          if (detail.requestId)
            void api<CredentialSetup[]>('/credentials/manager/requests')
              .then((requests) =>
                show(
                  requests.find(
                    (request) =>
                      request.id === detail.requestId && request.status === 'awaiting-entry',
                  ),
                ),
              )
              .catch((error) => setError(error.message));
          else show(detail.request);
        })
        .catch((error) => setError(error.message));
    };
    window.addEventListener('bot-bots:credentials', listener);
    return () => window.removeEventListener('bot-bots:credentials', listener);
  }, [allowed, data.bots, data.providers]);
  useEffect(() => {
    if (!allowed || open) return;
    let active = true;
    const poll = () =>
      void api<CredentialSetup[]>('/credentials/manager/requests').then(
        (requests) => {
          const pending = requests.find(
            (request) =>
              request.status === 'awaiting-entry' &&
              request.source === 'bot' &&
              !offered.current.has(request.id),
          );
          if (active && pending) {
            offered.current.add(pending.id);
            openCredentials({ request: pending });
          }
        },
        () => {},
      );
    poll();
    const timer = setInterval(poll, 1200);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [allowed, open]);
  async function save() {
    if (!editing || !state) return;
    setBusy(true);
    setError('');
    let target: unknown = { type: 'store' };
    if (use === 'service')
      target = {
        type: 'service',
        api: fullApi,
        botIds: ['*'],
        approval: 'connected',
      };
    else if (use === 'model') {
      const preset =
        providerId === 'openai'
          ? { name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' }
          : providerId === 'anthropic'
            ? { name: 'Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }
            : providerId === 'custom'
              ? { name: providerName, kind: providerKind, baseUrl: providerUrl }
              : undefined;
      target = {
        type: 'model',
        ...(data.providers.some((provider) => provider.id === providerId)
          ? { providerId }
          : preset
            ? { provider: preset }
            : { providerId }),
      };
    } else if (use === 'operation')
      target = {
        type: 'operation',
        label: name,
        url,
        method,
        authType,
        header,
        username,
        botIds: kind === 'api-key' ? ['*'] : botIds,
        inputFields: fields(inputFields),
        responseFields: fields(responseFields),
      };
    else if (use === 'alert') target = { type: 'alert', channel, url };
    try {
      const result = await api<{
        state: CredentialManagerState;
        request?: CredentialSetup;
        run?: import('../../../packages/shared/types').Run;
      }>('/credentials/manager/secrets', 'POST', {
        version: formVersion,
        ...(setup ? { requestId: setup.id } : {}),
        ...(editing !== 'new' ? { id: editing.id } : {}),
        name,
        kind,
        ...(value ? { value } : {}),
        target,
      });
      setValue('');
      setState(result.state);
      setEditing(undefined);
      if (setup) {
        setSetup(undefined);
        setOpen(false);
        if (result.run)
          window.dispatchEvent(new CustomEvent('bot-bots:open-run', { detail: result.run }));
      }
      await refresh();
      notify(use === 'store' ? 'Saved securely on your host' : 'Secret saved and connection ready');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!removing || !state) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ state: CredentialManagerState }>(
        `/credentials/manager/secrets/${removing.id}`,
        'DELETE',
        { version: state.version },
      );
      setState(result.state);
      setRemoving(undefined);
      await refresh();
      notify('Secret removed and access revoked');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    if (!state) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ state: CredentialManagerState }>(
        `/credentials/manager/connections/${id}`,
        'DELETE',
        { version: state.version },
      );
      setState(result.state);
      await refresh();
      notify('Connection access revoked');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const fullApi =
    setup?.api ??
    (editing && editing !== 'new'
      ? state?.connections.find(
          (connection) => connection.secretId === editing.id && connection.api,
        )?.api
      : undefined) ??
    knownApi(name);
  if (!open || !allowed) return null;
  return (
    <Modal
      title={
        setup
          ? setup.kind === 'password'
            ? 'Private password entry'
            : 'Private key entry'
          : removing
            ? 'Remove this secret?'
            : editing
              ? editing === 'new'
                ? 'Add a key or password'
                : `Update ${editing.name}`
              : 'Keys & passwords'
      }
      close={close}
      wide
    >
      <div className="secret-manager">
        <div className="secret-reassurance">
          <ShieldCheck size={24} />
          <div>
            <strong>{state?.backend ?? 'Your host’s secure storage'}</strong>
            <p>
              <strong>The bot cannot read the secret value entered in this box.</strong>{' '}
              {state?.backend.includes('plaintext')
                ? 'This host uses permission-protected private files, not encryption.'
                : state?.backend === 'Windows Credential Manager' ||
                    state?.backend === 'macOS Keychain'
                  ? 'It is encrypted in your operating system’s credential store.'
                  : 'It is stored in your host’s secure credential system.'}{' '}
              Values stay out of chats, shared files and team backups.
            </p>
          </div>
        </div>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {!state ? (
          <p>Opening your credential store…</p>
        ) : removing ? (
          <>
            <p>
              Remove <strong>{removing.name}</strong> from the secure store? Its connected model and
              service requests will stop working.
            </p>
            <div className="modal-footer">
              <button className="secondary" disabled={busy} onClick={() => setRemoving(undefined)}>
                Keep secret
              </button>
              <button className="danger" disabled={busy} onClick={() => void remove()}>
                Remove secret
              </button>
            </div>
          </>
        ) : editing ? (
          <form
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {setup && (
              <div className="private-entry-context">
                <Avatar
                  avatar={
                    data.bots.find((bot) => bot.id === setup.botId)?.avatar ?? data.bots[0].avatar
                  }
                  size={38}
                />
                <div>
                  <strong>
                    {data.bots.find((bot) => bot.id === setup.botId)?.name} will only learn whether
                    the connection is ready.
                  </strong>
                  <p>{setup.purpose}</p>
                </div>
              </div>
            )}
            {setup ? (
              <Field label="Which service is this for?">
                <input
                  aria-label="Secret name"
                  list="private-entry-services"
                  required
                  value={name}
                  maxLength={100}
                  placeholder="For example, Netlify or Claude"
                  onChange={(event) => {
                    setName(event.target.value);
                    const match = state.secrets.find(
                      (secret) =>
                        secret.present &&
                        secret.name.toLowerCase() === event.target.value.toLowerCase(),
                    );
                    if (editing !== 'new' && editing.id !== match?.id) setValue('');
                    setEditing(match ?? 'new');
                    const preset = credentialService(event.target.value);
                    if (preset.providerId) {
                      setUse('model');
                      setProviderId(knownProvider(preset.providerId));
                    } else
                      setUse(
                        setup.api || knownApi(event.target.value)
                          ? 'service'
                          : setup.connection
                            ? 'operation'
                            : 'store',
                      );
                  }}
                />
                <datalist id="private-entry-services">
                  <option>OpenAI</option>
                  <option>Claude</option>
                  <option>Netlify</option>
                  <option>Pages publishing</option>
                  <option>GitHub</option>
                </datalist>
              </Field>
            ) : (
              <div className="secret-fields">
                <Field label="Name">
                  <input
                    aria-label="Secret name"
                    required
                    maxLength={100}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="My OpenAI key, website login…"
                  />
                </Field>
                <Field label="What are you saving?">
                  <select
                    aria-label="Secret type"
                    value={kind}
                    onChange={(event) => {
                      const next = event.target.value as typeof kind;
                      setKind(next);
                      setAuthType(next === 'password' ? 'basic' : 'bearer');
                    }}
                  >
                    <option value="api-key">API key / token</option>
                    <option value="password">Password</option>
                  </select>
                </Field>
              </div>
            )}
            <Field
              label={
                editing === 'new'
                  ? kind === 'password'
                    ? 'Password'
                    : 'API key or token'
                  : 'Replacement value (leave empty to keep the current secret)'
              }
            >
              <input
                aria-label="Secret value"
                type="password"
                autoFocus={!!setup && !!name}
                autoComplete="new-password"
                spellCheck={false}
                required={editing === 'new'}
                maxLength={4096}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={
                  editing === 'new'
                    ? 'Paste it here — it stays private'
                    : 'Enter a replacement only if you want to change it'
                }
              />
            </Field>
            {setup && use === 'model' && (
              <p>
                We’ll connect this to <strong>{name}</strong> automatically. You choose which cloud
                models to enable separately.
              </p>
            )}
            {fullApi && (setup || use === 'service') && (
              <section className="private-connection-review">
                <strong>One token for the complete {fullApi.name} API</strong>
                <p>
                  {fullApi.baseUrl} · {fullApi.operations.length} documented actions
                  {fullApi.id === 'bottools-pages'
                    ? ', including deployments and short links.'
                    : '.'}
                </p>
                <p>
                  Shared with all current and future bots. Each bot follows its own role
                  instructions.
                </p>
                <p>
                  The same saved token covers every action listed below. No extra key or separate
                  connection is needed per endpoint. Terminal commands still need your approval.
                </p>
                <details>
                  <summary>Available API actions</summary>
                  <ul>
                    {fullApi.operations.map((operation) => (
                      <li key={operation.id}>
                        {operation.label} · {operation.method} {operation.path}
                      </li>
                    ))}
                  </ul>
                </details>
              </section>
            )}
            {setup && use === 'store' && (
              <p>
                Save this privately for <strong>{name || 'your service'}</strong>. Your bot can help
                with the connection next, without seeing or asking you to paste the value again.
              </p>
            )}
            {setup?.connection && (
              <section className="private-connection-review">
                <strong>
                  {kind === 'api-key'
                    ? 'Shared API connection for all bots'
                    : `Allow ${data.bots.find((bot) => bot.id === botIds[0])?.name ?? 'this bot'} to request this connection?`}
                </strong>
                <p>
                  {setup.connection.method} {new URL(setup.connection.url).host}
                  {new URL(setup.connection.url).pathname}
                </p>
                <p>
                  You still approve each exact action. Saving a key does not approve a publication,
                  email, or command.
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={use === 'operation'}
                    onChange={(event) => setUse(event.target.checked ? 'operation' : 'store')}
                  />{' '}
                  Allow this reviewed service connection
                </label>
                <details>
                  <summary>Connection details</summary>
                  <p>
                    Authentication: {setup.connection.authType}. Allowed inputs:{' '}
                    {setup.connection.inputFields.join(', ') || 'none'}. Bot-visible result fields:{' '}
                    {setup.connection.responseFields.join(', ')}.
                  </p>
                </details>
              </section>
            )}
            {!setup && (
              <Field label="Use it with">
                <select
                  aria-label="Credential use"
                  value={use}
                  onChange={(event) => setUse(event.target.value as Use)}
                >
                  <option value="store">Save privately for now</option>
                  <option value="model">A model provider</option>
                  {fullApi && <option value="service">Complete {fullApi.name} API</option>}
                  <option value="operation">Advanced single-endpoint operation</option>
                  <option value="alert">Email or text warnings</option>
                </select>
              </Field>
            )}
            {!setup && use === 'model' && (
              <>
                <Field label="Model provider">
                  <select
                    aria-label="Model credential provider"
                    value={providerId}
                    onChange={(event) => setProviderId(event.target.value)}
                  >
                    <optgroup label="Connect a new provider">
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Claude / Anthropic</option>
                      <option value="custom">Another model provider</option>
                    </optgroup>
                    <optgroup label="Your model servers">
                      {data.providers.map((provider) => (
                        <option
                          key={provider.id}
                          value={provider.id}
                          disabled={!provider.baseUrl.startsWith('https:')}
                        >
                          {provider.name}
                          {provider.baseUrl.startsWith('https:')
                            ? ''
                            : ' · no HTTPS authentication'}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </Field>
                {providerId === 'custom' && (
                  <>
                    <Field label="Provider name">
                      <input
                        required
                        value={providerName}
                        onChange={(event) => setProviderName(event.target.value)}
                      />
                    </Field>
                    <Field label="HTTPS API base URL">
                      <input
                        required
                        type="url"
                        value={providerUrl}
                        onChange={(event) => setProviderUrl(event.target.value)}
                      />
                    </Field>
                    <Field label="API format">
                      <select
                        value={providerKind}
                        onChange={(event) => setProviderKind(event.target.value)}
                      >
                        <option value="openai-compatible">OpenAI compatible</option>
                        <option value="openai-responses">OpenAI Responses</option>
                        <option value="anthropic">Anthropic</option>
                      </select>
                    </Field>
                  </>
                )}
                <p className="muted">
                  This connects the saved credential automatically. Cloud models still need your
                  opt-in in Model workshop. Local LM Studio usually needs no key.
                </p>
              </>
            )}
            {!setup && use === 'alert' && (
              <>
                <Field label="Warning channel">
                  <select
                    value={channel}
                    onChange={(event) => {
                      setChannel(event.target.value);
                      setUrl(
                        event.target.value === 'email'
                          ? data.settings.alertEmail.url || 'https://'
                          : data.settings.alertSms.url || 'https://',
                      );
                    }}
                  >
                    <option value="email">Email warnings</option>
                    <option value="sms">Text warnings</option>
                  </select>
                </Field>
                <Field label="HTTPS delivery endpoint">
                  <input
                    required
                    type="url"
                    aria-label="Alert endpoint"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </Field>
                <p>
                  Finish the destination and enable warnings in Settings & connections. Saving this
                  does not send a message.
                </p>
              </>
            )}
            {!setup && use === 'operation' && (
              <>
                <div className="secret-fields">
                  <Field label="HTTPS API endpoint">
                    <input
                      required
                      type="url"
                      aria-label="Service endpoint"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                    />
                  </Field>
                  <Field label="Request method">
                    <select
                      aria-label="Service method"
                      value={method}
                      onChange={(event) => setMethod(event.target.value)}
                    >
                      {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                        <option key={method}>{method}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="Authentication">
                  <select
                    aria-label="Service authentication"
                    value={authType}
                    onChange={(event) => setAuthType(event.target.value)}
                  >
                    <option value="bearer">Bearer token</option>
                    <option value="header">API key in a header</option>
                    <option value="basic">Username and password</option>
                  </select>
                </Field>
                {authType === 'basic' && (
                  <Field label="Username">
                    <input
                      required
                      aria-label="Service username"
                      autoComplete="off"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                    />
                  </Field>
                )}
                {authType === 'header' && (
                  <Field label="Header name">
                    <input
                      required
                      aria-label="Authentication header"
                      value={header}
                      onChange={(event) => setHeader(event.target.value)}
                    />
                  </Field>
                )}
                {kind === 'password' && (
                  <fieldset className="secret-bot-choices">
                    <legend>Which bots may request this?</legend>
                    {data.bots
                      .filter((bot) => !bot.prototypeId)
                      .map((bot) => (
                        <label key={bot.id}>
                          <input
                            type="checkbox"
                            checked={botIds.includes(bot.id)}
                            onChange={(event) =>
                              setBotIds(
                                event.target.checked
                                  ? [...botIds, bot.id]
                                  : botIds.filter((id) => id !== bot.id),
                              )
                            }
                          />
                          <Avatar avatar={bot.avatar} size={25} />
                          {bot.name}
                        </label>
                      ))}
                  </fieldset>
                )}
                {kind === 'api-key' && (
                  <p>
                    Shared with all current and future bots. Each bot follows its own role
                    instructions.
                  </p>
                )}
                <Field label="Response fields bots may see">
                  <input
                    required
                    aria-label="Allowed response fields"
                    value={responseFields}
                    onChange={(event) => setResponseFields(event.target.value)}
                    placeholder="id, name, status"
                  />
                  <small>
                    Comma-separated fields from the API result. Tokens, passwords and nested content
                    are withheld.
                  </small>
                </Field>
                <details>
                  <summary>Optional request fields</summary>
                  <Field label="Fields bots may supply">
                    <input
                      aria-label="Allowed input fields"
                      value={inputFields}
                      onChange={(event) => setInputFields(event.target.value)}
                      placeholder="title, message"
                    />
                  </Field>
                </details>
                <p className="notice">
                  <ShieldCheck size={18} />
                  Every service action will still ask for your approval. Saving this does not run
                  the request.
                </p>
              </>
            )}
            {setup && authType === 'basic' && use === 'operation' && (
              <Field label="Service username">
                <input
                  aria-label="Service username"
                  required
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
            )}
            <div className="modal-footer">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={setup ? close : clear}
              >
                {setup ? 'Cancel' : 'Back'}
              </button>
              <button
                className="primary"
                disabled={busy || (use === 'operation' && kind === 'password' && !botIds.length)}
              >
                {busy ? 'Saving securely…' : use === 'store' ? 'Save securely' : 'Save and connect'}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="secret-list-heading">
              <p>Save a key or password, then choose where it can be used.</p>
              <button className="primary" onClick={() => begin()}>
                <Plus size={16} />
                Add key or password
              </button>
            </div>
            {!state.secrets.length && (
              <div className="secret-empty">
                <KeyRound size={36} />
                <h3>A private place for your keys</h3>
                <p>
                  Add your first secret here. No terminal commands or configuration files needed.
                </p>
              </div>
            )}
            {state.secrets.map((secret) => (
              <article className="secret-card" key={secret.id} data-secret-id={secret.id}>
                <div className="secret-card-heading">
                  {secret.kind === 'password' ? <LockKeyhole size={22} /> : <KeyRound size={22} />}
                  <div>
                    <h3>{secret.name}</h3>
                    <small>
                      {secret.kind === 'password' ? 'Password' : 'API key / token'} ·{' '}
                      {secret.present ? 'Saved securely' : 'Missing from the host store'}
                    </small>
                  </div>
                  <button className="secondary small" onClick={() => begin(secret)}>
                    Update or connect
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Remove ${secret.name}`}
                    onClick={() => setRemoving(secret)}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
                {state.connections
                  .filter((connection) => connection.secretId === secret.id)
                  .map((connection) => (
                    <div className="secret-connection" key={connection.id}>
                      <span>
                        <strong>{connection.label}</strong> ·{' '}
                        {connection.enabled ? 'Connected' : 'Paused'}
                        <small>
                          {connection.url}
                          {connection.botIds?.includes('*')
                            ? ' · All bots'
                            : connection.botIds?.length
                              ? ` · ${connection.botIds.map((id) => data.bots.find((bot) => bot.id === id)?.name ?? id).join(', ')}`
                              : ''}
                        </small>
                      </span>
                      <button
                        className="secondary small"
                        disabled={busy}
                        onClick={() => void revoke(connection.id)}
                      >
                        Revoke access
                      </button>
                    </div>
                  ))}
              </article>
            ))}
            <div className="modal-footer">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void load().catch((error) => setError(error.message))}
              >
                Refresh
              </button>
              <button className="primary" onClick={close}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
