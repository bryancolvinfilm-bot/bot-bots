import { useEffect, useRef, useState } from 'react';
import { Puzzle, ShieldCheck, ExternalLink, Unplug, LoaderCircle } from 'lucide-react';
import {
  googleOperations,
  type GoogleConfig,
  type GoogleState,
  type GoogleOperation,
} from '../../../packages/shared/plugins';
import type { Bootstrap } from '../../../packages/shared/types';
import { api } from './api';
import { Field, Heading } from './ui';
export function openExternal(url: string) {
  if (window.botBotsDesktop?.openExternal) return window.botBotsDesktop.openExternal(url);
  window.open(url, '_blank', 'noopener,noreferrer');
  return Promise.resolve();
}
export function Plugins({ data, notify }: { data: Bootstrap; notify: (s: string) => void }) {
  const [state, setState] = useState<GoogleState>(),
    [config, setConfig] = useState<GoogleConfig>(),
    [secret, setSecret] = useState(''),
    [busy, setBusy] = useState(false),
    [authUrl, setAuthUrl] = useState(''),
    [advancedOpen, setAdvancedOpen] = useState(false);
  const awaiting = useRef(false);
  async function load() {
    const value = await api<GoogleState>('/plugins/google');
    setState(value);
    if (awaiting.current && value.connected && value.signIn.status === 'idle') {
      awaiting.current = false;
      setAuthUrl('');
      notify('Google connected. Choose the apps and bots you want to allow.');
    }
    setConfig((old) => old ?? value.config);
  }
  useEffect(() => {
    void load().catch((e) => notify(e.message));
    const timer = setInterval(() => void load().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, []);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(value = config) {
    const result = await api<GoogleState>('/plugins/google', 'PUT', {
      config: value,
      ...(secret ? { clientSecret: secret } : {}),
    });
    setState(result);
    setConfig(result.config);
    setSecret('');
  }
  async function connect(identityOnly: boolean) {
    if (!config || !state) return;
    if (!state.signIn.ready) {
      setAdvancedOpen(true);
      notify(
        'The app owner needs to finish one-time Google setup. After that, everyone connects through their browser.',
      );
      return;
    }
    const popup = !window.botBotsDesktop?.openExternal
      ? window.open('about:blank', '_blank')
      : null;
    if (popup) popup.opener = null;
    await act(async () => {
      try {
        await save({ ...config, installed: true });
        const result = await api<{ url: string }>('/plugins/google/authorize', 'POST', {
          identityOnly,
        });
        setAuthUrl(result.url);
        awaiting.current = true;
        if (popup) popup.location.href = result.url;
        else await openExternal(result.url);
      } catch (error) {
        popup?.close();
        throw error;
      }
    });
  }
  const waiting = state?.signIn.status === 'waiting' || state?.signIn.status === 'exchanging';
  function permission(
    id: GoogleOperation,
    change: Partial<{ enabled: boolean; botIds: string[] }>,
  ) {
    if (config)
      setConfig({
        ...config,
        permissions: {
          ...config.permissions,
          [id]: { enabled: false, botIds: [], ...config.permissions[id], ...change },
        },
      });
  }
  return (
    <main className="page plugins-page">
      <Heading
        eyebrow="A FEW MORE HELPING HANDS"
        title="A workshop for connections."
        description="Curated plugins with clear permissions. Add a connection once, then choose what each bot may do."
      />
      <section className="panel plugin-card">
        <div className="plugin-heading">
          <div className="google-mark">G</div>
          <div>
            <h2>Google Workspace</h2>
            {state?.accountEmail && <small>Connected as {state.accountEmail}</small>}
            <p>Gmail · Drive · Sheets · Docs · Calendar · Contacts</p>
          </div>
          <span className="status-pill">
            {state?.connected
              ? 'Connected'
              : waiting
                ? 'Signing in'
                : state?.signIn.ready
                  ? 'Ready to connect'
                  : 'App setup needed'}
          </span>
        </div>
        <p>
          One Google account for the apps you select. Read permissions can run directly. Every
          change or outgoing email asks for your approval of the exact action.
        </p>
        {config && (
          <>
            <div className="google-connect">
              {!state?.connected && !waiting && (
                <>
                  <button
                    className="google-signin"
                    disabled={busy}
                    onClick={() => void connect(true)}
                  >
                    <GoogleG /> Sign in with Google
                  </button>
                  <p>
                    Choose your account in your browser, then return here. Your Google password
                    stays with Google.
                  </p>
                </>
              )}
              {state?.connected && !waiting && (
                <div className="button-row">
                  <span className="subtle">
                    Your account is connected. App and bot access stays under your control.
                  </span>
                  <button
                    className="secondary small"
                    disabled={busy}
                    onClick={() => void connect(true)}
                  >
                    Switch Google account
                  </button>
                  <button
                    className="secondary small"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api('/plugins/google/disconnect', 'POST');
                        setAuthUrl('');
                        awaiting.current = false;
                      })
                    }
                  >
                    <Unplug size={14} /> Disconnect
                  </button>
                </div>
              )}
              {waiting && (
                <div role="status" className="google-waiting">
                  <LoaderCircle size={20} className="spin" />
                  <div>
                    <strong>
                      {state?.signIn.status === 'exchanging'
                        ? 'Finishing your connection…'
                        : 'Waiting for Google…'}
                    </strong>
                    <p>Finish signing in in your browser. Bot-Bots will reconnect automatically.</p>
                    <div className="button-row">
                      {authUrl && (
                        <button className="text-button" onClick={() => void openExternal(authUrl)}>
                          Open browser again <ExternalLink size={12} />
                        </button>
                      )}
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api('/plugins/google/authorize/cancel', 'POST');
                            setAuthUrl('');
                            awaiting.current = false;
                          })
                        }
                      >
                        Cancel sign-in
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {state?.signIn.status === 'failed' && (
                <p className="error-text" role="alert">
                  {state.signIn.message}
                </p>
              )}
              {!state?.signIn.ready && (
                <p className="subtle">
                  Google sign-in needs one-time setup by the app owner. Once configured, users only
                  click Sign in with Google.
                </p>
              )}
            </div>
            <details
              className="plugin-setup"
              open={advancedOpen}
              onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
            >
              <summary>Advanced · app owner and custom OAuth setup</summary>
              <p>
                Regular users do not need API keys. The app owner registers Bot-Bots with Google
                once, or you can use your own OAuth client below.
              </p>
              <Field label="Google sign-in provider">
                <select
                  value={config.clientSource ?? 'custom'}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      clientSource: e.target.value as 'app' | 'custom',
                      ...(e.target.value === 'app' ? { clientId: '', redirectUri: '' } : {}),
                    })
                  }
                >
                  <option value="app">Default Bot-Bots sign-in</option>
                  <option value="custom">My own Google OAuth client</option>
                </select>
              </Field>
              <Field label="Import Google client file (.json)">
                <input
                  type="file"
                  aria-label="Import Google client file (.json)"
                  accept=".json,application/json"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    void act(async () => {
                      if (file.size > 16000)
                        throw Error(
                          'Choose the small OAuth client JSON file downloaded from Google Cloud.',
                        );
                      const result = await api<GoogleState>(
                        '/plugins/google/client/import',
                        'POST',
                        JSON.parse(await file.text()),
                      );
                      setState(result);
                      setConfig(result.config);
                      setSecret('');
                      notify('Google app setup saved. You can now sign in with Google.');
                    });
                  }}
                />
                <small>
                  App owner only: import the downloaded Desktop or Web client file instead of
                  copying fields.
                </small>
              </Field>
              {config.clientSource === 'custom' && (
                <>
                  <div className="two-columns">
                    <Field label="OAuth client type">
                      <select
                        value={config.clientType}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            clientType: e.target.value as GoogleConfig['clientType'],
                          })
                        }
                      >
                        <option value="desktop">Desktop · authorize on the host</option>
                        <option value="web">Web · authorize through a server URL</option>
                      </select>
                    </Field>
                    <Field label="Google OAuth client ID">
                      <input
                        value={config.clientId}
                        onChange={(e) => setConfig({ ...config, clientId: e.target.value })}
                        placeholder="…apps.googleusercontent.com"
                      />
                    </Field>
                  </div>
                  <Field label="Callback URL">
                    <input
                      value={config.redirectUri}
                      onChange={(e) => setConfig({ ...config, redirectUri: e.target.value })}
                    />
                    <small>
                      Register this exact URL for a Web client. Desktop clients use a loopback URL
                      on the computer hosting Bot-Bots.
                    </small>
                  </Field>
                </>
              )}
              <Field label="Client secret (if required)">
                <input
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={
                    state?.hasClientSecret
                      ? 'Stored securely on this host · enter to replace'
                      : 'Required for a Web client'
                  }
                />
                <small>
                  Credentials and Google tokens stay encrypted on the host and are excluded from
                  team JSON backups.
                </small>
              </Field>
              <details className="plugin-setup">
                <summary>Google Cloud setup steps</summary>
                <ol>
                  <li>
                    Create/select your Google Cloud project and enable the Gmail, Drive, Sheets,
                    Docs, Calendar and People APIs you intend to use.
                  </li>
                  <li>
                    Configure the Google consent screen and add your account as a test user while
                    developing.
                  </li>
                  <li>
                    Create a Desktop OAuth client for this computer, or a Web client for a hosted
                    server. Enter its ID and secret above.
                  </li>
                  <li>
                    Select only the capabilities you want below, save, then authorize in your system
                    browser.
                  </li>
                </ol>
                <p>
                  Google may require verification for sensitive/restricted scopes; testing refresh
                  tokens may expire. The permission matrix below further limits Google’s grant.
                </p>
                <button
                  className="text-button"
                  onClick={() =>
                    void openExternal(
                      'https://developers.google.com/identity/protocols/oauth2/native-app',
                    )
                  }
                >
                  Google’s authorization guide <ExternalLink size={12} />
                </button>
              </details>
              <button
                className="secondary"
                disabled={busy || waiting}
                onClick={() => void act(() => save())}
              >
                Save app setup
              </button>
            </details>
            <details className="google-access" open={state?.connected || undefined}>
              <summary>Google apps and bot access</summary>
              <h3>
                <ShieldCheck size={17} />
                Choose abilities and bots
              </h3>
              <div className="permissions-table">
                <table>
                  <thead>
                    <tr>
                      <th>Google ability</th>
                      <th>Enabled</th>
                      <th>Allowed bots</th>
                      <th>Execution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {googleOperations.map((op) => {
                      const p = config.permissions[op.id] ?? { enabled: false, botIds: [] };
                      return (
                        <tr key={op.id}>
                          <td>
                            <strong>{op.service}</strong>
                            <small>{op.label}</small>
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Enable ${op.id}`}
                              checked={p.enabled}
                              onChange={(e) => permission(op.id, { enabled: e.target.checked })}
                            />
                          </td>
                          <td>
                            <details>
                              <summary>
                                {p.botIds.includes('*')
                                  ? 'All bots'
                                  : `${p.botIds.length} selected`}
                              </summary>
                              <div className="bot-permissions">
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={p.botIds.includes('*')}
                                    onChange={(e) =>
                                      permission(op.id, { botIds: e.target.checked ? ['*'] : [] })
                                    }
                                  />
                                  All bots
                                </label>
                                {data.bots
                                  .filter((b) => !b.prototypeId)
                                  .map((b) => (
                                    <label key={b.id}>
                                      <input
                                        type="checkbox"
                                        checked={p.botIds.includes('*') || p.botIds.includes(b.id)}
                                        onChange={(e) =>
                                          permission(op.id, {
                                            botIds: e.target.checked
                                              ? [...p.botIds.filter((id) => id !== '*'), b.id]
                                              : p.botIds.filter((id) => id !== '*' && id !== b.id),
                                          })
                                        }
                                      />
                                      {b.name}
                                      {b.isPrototype ? ' (and its workers)' : ''}
                                    </label>
                                  ))}
                              </div>
                            </details>
                          </td>
                          <td>{op.write ? 'Ask every time' : 'Allowed reads'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void act(() => save())}
                >
                  Save permissions
                </button>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    waiting ||
                    !googleOperations.some((op) => config.permissions[op.id]?.enabled)
                  }
                  onClick={() => void connect(false)}
                >
                  {state?.connected ? 'Connect selected apps' : 'Sign in and connect selected apps'}{' '}
                  <ExternalLink size={14} />
                </button>
              </div>
              {state?.needsAuthorization.length ? (
                <p className="subtle">
                  Still needs your Google approval:{' '}
                  {googleOperations
                    .filter((op) => state.needsAuthorization.includes(op.id))
                    .map((op) => `${op.service} — ${op.label}`)
                    .join(', ')}
                </p>
              ) : null}
              {state?.error && <p className="error-text">{state.error}</p>}
            </details>
          </>
        )}
      </section>
      <section className="panel plugin-approvals">
        <h2>Requests waiting for you</h2>
        <p>
          Approve only the exact action you intend. Changing a task or stopping its bot withdraws
          pending requests.
        </p>
        {state?.actions
          .filter((a) => a.status === 'awaiting-approval')
          .map((a) => (
            <article className="plugin-request" key={a.id}>
              <h3>
                {data.bots.find((b) => b.id === a.botId)?.name ?? 'Bot'} · {a.operation}
              </h3>
              <pre>{JSON.stringify(a.params, null, 2)}</pre>
              <div className="button-row">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      api(`/plugins/google/actions/${a.id}/decision`, 'POST', { approve: true }),
                    )
                  }
                >
                  Approve this exact action once
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      api(`/plugins/google/actions/${a.id}/decision`, 'POST', { approve: false }),
                    )
                  }
                >
                  Deny
                </button>
              </div>
            </article>
          ))}
        {!state?.actions.some((a) => a.status === 'awaiting-approval') && (
          <p className="subtle">Nothing waiting. The bots will ask here before making changes.</p>
        )}
        <details>
          <summary>Action history</summary>
          {state?.actions
            .filter((a) => a.status !== 'awaiting-approval')
            .map((a) => (
              <div className="plugin-history" key={a.id}>
                <strong>
                  {a.operation} · {a.status}
                </strong>
                <small>{new Date(a.createdAt).toLocaleString()}</small>
                {a.error && <p>{a.error}</p>}
              </div>
            ))}
        </details>
      </section>
      <div className="notice">
        <Puzzle size={22} />
        <p>
          More plugins can be added to this catalog over time. This release includes the Google
          adapter; it does not install arbitrary executable code from a marketplace.
        </p>
      </div>
    </main>
  );
}
function GoogleG() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 48 48">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6C44.4 38.03 46.98 31.86 46.98 24.55Z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59A14.4 14.4 0 0 1 9.77 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"
      />
    </svg>
  );
}
