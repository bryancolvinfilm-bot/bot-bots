import { useEffect, useRef, useState } from 'react';
import { ExternalLink, KeyRound, LogOut } from 'lucide-react';
import { api } from './api';
import { openCredentials } from './credential-events';
import { openExternal } from './external-link';
import type { ChatGPTState } from '../../server/chatgpt-auth';
import { ClaudeConnection } from './ClaudeConnection';

export function FrontierConnections({
  act,
}: {
  act: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const [state, setState] = useState<ChatGPTState>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const catalogAccount = useRef<string | undefined>(undefined);
  const load = () =>
    api<ChatGPTState>('/credentials/manager/chatgpt').then((next) => {
      setState(next);
      return next;
    });
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (state?.status !== 'connecting') return;
    const timer = window.setInterval(() => {
      void load()
        .then(async (next) => {
          if (next.status !== 'connecting') {
            setLoginUrl('');
          }
        })
        .catch((e) => setError(e.message));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [state?.status, act]);
  useEffect(() => {
    if (state?.status === 'connecting' || !state?.sharing) {
      catalogAccount.current = undefined;
      return;
    }
    if (!state.active || catalogAccount.current === state.active) return;
    catalogAccount.current = state.active;
    void act(
      () => api('/credentials/manager/chatgpt/models', 'POST', {}),
      'ChatGPT models are ready. Choose which models to use below.',
    );
  }, [state?.status, state?.active, state?.sharing, act]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed.');
    } finally {
      setBusy(false);
    }
  };
  const open = async (url: string) => {
    if (new URL(url).origin !== 'https://auth.openai.com')
      throw Error('Unexpected ChatGPT sign-in address.');
    await openExternal(url);
  };
  const signIn = (profileId?: string) =>
    action(async () => {
      const result = await api<{ url: string }>('/credentials/manager/chatgpt/signin', 'POST', {
        profileId,
      });
      setLoginUrl(result.url);
      await load();
      await open(result.url);
    });
  const active = state?.profiles.find((p) => p.id === state.active);
  return (
    <section className="panel frontier-connections">
      <div className="section-heading">
        <div>
          <h2>Frontier models</h2>
          <p>Connect once for the whole team. Choose which models to use below.</p>
        </div>
      </div>
      <div className="provider-grid">
        <article className="provider-card">
          <h3>ChatGPT</h3>
          <p>Use your eligible ChatGPT plan through a secure browser sign-in.</p>
          {active && (
            <p>
              <strong>{active.name || active.email || active.label}</strong>
              {active.email && active.name ? ` · ${active.email}` : ''}
            </p>
          )}
          {state && state.profiles.length > 0 && (
            <label>
              Account{' '}
              <select
                aria-label="ChatGPT account"
                value={state.active ?? ''}
                disabled={busy || state.status === 'connecting'}
                onChange={(e) =>
                  void action(async () => {
                    catalogAccount.current = undefined;
                    await api('/credentials/manager/chatgpt/select', 'POST', {
                      profileId: e.target.value,
                    });
                    const next = await load();
                    if (!next.sharing) await act(async () => {});
                  })
                }
              >
                <option value="" disabled>
                  Choose an account
                </option>
                {state.profiles.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.label}
                    {p.email ? ` · ${p.email}` : ''}
                    {p.connected ? '' : ' · signed out'}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="button-row">
            {state?.status === 'connecting' ? (
              <>
                <span role="status">Waiting for browser sign-in…</span>
                <button
                  className="secondary small"
                  onClick={() =>
                    void action(async () => {
                      await api('/credentials/manager/chatgpt/cancel', 'POST', {});
                      setLoginUrl('');
                      await load();
                    })
                  }
                >
                  Cancel
                </button>
                {loginUrl && (
                  <button className="secondary small" onClick={() => void open(loginUrl)}>
                    Open sign-in again
                  </button>
                )}
              </>
            ) : (
              <>
                {!state?.sharing && (
                  <button
                    data-oai-siwc-button
                    className="primary"
                    disabled={busy || !state}
                    onClick={() => void signIn(state?.active)}
                  >
                    <ExternalLink size={15} />
                    Continue with ChatGPT
                  </button>
                )}
                {state?.sharing && (
                  <>
                    <span className="status-badge online">Connected</span>
                    <button
                      className="secondary small"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await act(
                            () => api('/credentials/manager/chatgpt/models', 'POST', {}),
                            'ChatGPT models refreshed',
                          );
                        })
                      }
                    >
                      Refresh models
                    </button>
                    <button
                      className="secondary small"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api('/credentials/manager/chatgpt/disconnect', 'POST', {});
                          await load();
                          await act(async () => {});
                        })
                      }
                    >
                      <LogOut size={14} />
                      Sign out
                    </button>
                  </>
                )}
                {!!state?.profiles.length && (
                  <button className="secondary small" disabled={busy} onClick={() => void signIn()}>
                    Add another account
                  </button>
                )}
              </>
            )}
          </div>
          {state?.status === 'connected' && !state.sharing && (
            <p>
              Allow plan usage for Bot-Bots in ChatGPT Settings, then continue with ChatGPT again.
            </p>
          )}
          <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">
            ChatGPT usage and limits
          </a>
        </article>
        <article className="provider-card">
          <h3>Claude</h3>
          <ClaudeConnection act={act} />
          <p>Or connect an Anthropic API key for direct API usage.</p>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await act(() => api('/credentials/manager/claude', 'POST', {}));
                openCredentials({ add: true, providerId: 'anthropic' });
              })
            }
          >
            <KeyRound size={15} />
            Connect Claude API
          </button>
          <p>
            <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">
              Get an Anthropic API key
            </a>
          </p>
        </article>
      </div>
      {(error || state?.error) && (
        <p className="error-text" role="alert">
          {error || state?.error}
        </p>
      )}
      <p className="subtle">
        Signing in keeps local-only mode and model choices under your control. Cloud models receive
        bot instructions and conversation context when selected.
      </p>
    </section>
  );
}
