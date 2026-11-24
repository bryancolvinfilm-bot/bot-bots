import { useState } from 'react';
import { connection } from './api';
export function LoginCard({ refresh }: { refresh: () => Promise<void> }) {
  const [mode, setMode] = useState('login'),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [code, setCode] = useState(''),
    [name, setName] = useState('My device'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="panel login-card"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        void fetch(`${connection().base}/auth/${mode}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(mode === 'login' ? { username, password } : { code, name }),
        })
          .then(
            async (res) => {
              if (!res.ok) throw Error((await res.json()).error ?? 'Could not sign in.');
              await refresh();
            },
            (e) => setError(e.message),
          )
          .catch((e) => setError(e.message))
          .finally(() => setBusy(false));
      }}
    >
      <img src="/logo.svg" width="70" height="70" alt="Three smiling bots" />
      <h2>Back with your little team.</h2>
      <div className="tabs">
        <button
          type="button"
          className={mode === 'login' ? 'active' : ''}
          onClick={() => setMode('login')}
        >
          Sign in
        </button>
        <button
          type="button"
          className={mode === 'pair' ? 'active' : ''}
          onClick={() => setMode('pair')}
        >
          Pair device
        </button>
      </div>
      {mode === 'login' ? (
        <>
          <label>
            Owner name
            <input
              required
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              required
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          <label>
            Six-digit pairing code
            <input
              required
              inputMode="numeric"
              pattern="[0-9]{6}"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <label>
            Device name
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <p>Get a one-use code from Settings on the host.</p>
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy ? 'Connecting…' : mode === 'login' ? 'Sign in' : 'Pair this device'}
      </button>
    </form>
  );
}
