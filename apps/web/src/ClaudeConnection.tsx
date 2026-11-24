import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from './api';
import { openExternal } from './external-link';
import type { ClaudeCodeState } from '../../server/claude-code';
export function ClaudeConnection({
  act,
}: {
  act: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const [state, setState] = useState<ClaudeCodeState>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const catalog = useRef(false);
  const load = async () => {
    const next = await api<ClaudeCodeState>('/credentials/manager/claude-code');
    setState(next);
    return next;
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (state?.status !== 'connecting' && state?.status !== 'installing' && !busy) return;
    const timer = window.setInterval(() => {
      void load().catch((e) => setError(e.message));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [state?.status, busy]);
  useEffect(() => {
    if (state?.status !== 'connected') {
      catalog.current = false;
      return;
    }
    if (!catalog.current) {
      catalog.current = true;
      void act(
        () => api('/credentials/manager/claude-code/models', 'POST', {}),
        'Claude is connected. Choose which models to use below.',
      );
    }
  }, [state?.status, act]);
  const action = async (path: string) => {
    setBusy(true);
    setError('');
    try {
      await api(`/credentials/manager/claude-code/${path}`, 'POST', {});
      await load();
      if (path === 'disconnect') await act(async () => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Claude connection failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p>
        Sign in through the official Claude Code browser handshake using your own account. Claude
        Code keeps the login credentials.
      </p>
      {state?.email && (
        <p>
          <strong>{state.email}</strong>
        </p>
      )}
      <div className="button-row">
        {state?.status === 'connected' ? (
          <>
            <span className="status-badge online">Connected</span>
            <button
              className="secondary small"
              disabled={busy}
              onClick={() => void action('disconnect')}
            >
              Sign out of Claude Code
            </button>
          </>
        ) : (
          <button
            className="primary"
            disabled={busy || state?.status === 'connecting'}
            onClick={() => void action('signin')}
          >
            <ExternalLink size={15} />
            {busy ? 'Opening Claude…' : 'Continue with Claude'}
          </button>
        )}
        {(state?.status === 'connecting' || state?.status === 'installing') && (
          <>
            <span role="status">
              {state.status === 'installing'
                ? 'Installing official Claude Code…'
                : 'Finish sign-in in your browser…'}
            </span>
            <button className="secondary small" onClick={() => void action('cancel')}>
              Cancel
            </button>
          </>
        )}
        {state?.loginUrl && (
          <button className="secondary small" onClick={() => void openExternal(state.loginUrl!)}>
            Open Claude sign-in again
          </button>
        )}
      </div>
      {!state?.installed && (
        <small>
          The first connection downloads Anthropic’s official Claude Code tool and verifies its
          checksum.
        </small>
      )}
      {(error || state?.error) && (
        <p className="error-text" role="alert">
          {error || state?.error}
        </p>
      )}
    </>
  );
}
