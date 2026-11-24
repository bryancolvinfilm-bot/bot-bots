import { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import type { CredentialsState } from '../../../packages/shared/credentials';
import type { Bot } from '../../../packages/shared/types';
import { api } from './api';
import { openCredentials } from './CredentialManager';

export function CredentialsPanel({ bots }: { bots: Bot[] }) {
  const [state, setState] = useState<CredentialsState>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  useEffect(() => {
    let current = true;
    const load = () =>
      void api<CredentialsState>('/credentials').then(
        (s) => {
          if (current) {
            setState(s);
            setError('');
          }
        },
        (e) => {
          if (current) setError(e.message);
        },
      );
    load();
    const timer = setInterval(load, 2000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, []);
  async function decide(id: string, approve: boolean) {
    setBusy(id);
    try {
      await api(`/credentials/${id}/decision`, 'POST', { approve });
      setState(await api<CredentialsState>('/credentials'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <section
      className="panel settings-panel credentials-panel"
      id="host-credentials"
      aria-label="Host secrets and permissions"
    >
      <h2>
        <KeyRound size={21} /> Secrets stay with your computer
      </h2>
      <p>
        Keep keys and passwords in your OS credential store. Bots can request only the operations
        you grant here, then wait for your approval. Secret values never need to go into chat.
      </p>
      {state && (
        <>
          <div className="credential-store-status">
            <ShieldCheck size={18} />
            <strong>{state.backend}</strong>
            <span>{state.enabled ? 'External grants enabled' : 'No external grants enabled'}</span>
          </div>
          <div className="button-row">
            <button className="primary" onClick={() => openCredentials({ add: true })}>
              Add key or password
            </button>
            <button className="secondary" onClick={() => openCredentials()}>
              Manage keys & passwords
            </button>
          </div>
          {state.directory && (
            <details>
              <summary>Where you control access</summary>
              <p>
                <code>{state.directory}</code>
              </p>
              <p>
                Your keys are held by the host’s credential store. You can also revoke them through
                the OS or edit <code>permissions.json</code> here. Normal setup and permissions are
                managed in the Keys & passwords window.
              </p>
            </details>
          )}
          {state.botTerminalBlocked && (
            <p className="notice">
              Bot terminal commands are paused by the external credential policy. Use approved
              credential operations. A full shell running as your OS user is not a secret-isolation
              boundary.
            </p>
          )}
          {!!state.capabilities.length && (
            <details>
              <summary>Granted operations ({state.capabilities.length})</summary>
              {state.capabilities.map((c) => (
                <p key={c.id}>
                  <strong>{c.label}</strong> · {c.method} <code>{c.destination}</code>
                </p>
              ))}
            </details>
          )}
          {state.actions.map((a) => (
            <article className="credential-action" key={a.id} data-credential-action={a.id}>
              <h3>{a.label}</h3>
              <p>
                {bots.find((b) => b.id === a.botId)?.name ?? 'A teammate'} · {a.status}
              </p>
              <p>
                <code>
                  {a.method} {a.destination}
                </code>
              </p>
              {Object.keys(a.input).length > 0 && <pre>{JSON.stringify(a.input, null, 2)}</pre>}
              {a.status === 'awaiting-approval' && (
                <div className="button-row">
                  <button
                    className="primary"
                    disabled={!!busy}
                    onClick={() => void decide(a.id, true)}
                  >
                    Approve once
                  </button>
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() => void decide(a.id, false)}
                  >
                    Deny
                  </button>
                </div>
              )}
              {a.error && <p className="error-text">{a.error}</p>}
            </article>
          ))}
          {state.error && <p className="error-text">{state.error}</p>}
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
