import { useEffect, useState } from 'react';
import { CopyButton } from './CodeBlock';
import { api, connection } from './api';
import { Field } from './ui';
interface AccessInfo {
  devices?: { id: string; name: string; role: string; expiresAt?: string }[];
  ownerConfigured: boolean;
  username?: string;
  publicUrl: string;
  keys: { id: string; name: string; role: string; createdAt: string }[];
}
export function AccessSettings({
  notify,
  accessRole = 'owner',
}: {
  notify: (s: string) => void;
  accessRole?: 'owner' | 'operator' | 'viewer';
}) {
  const [info, setInfo] = useState<AccessInfo>(),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [name, setName] = useState(''),
    [role, setRole] = useState('viewer'),
    [key, setKey] = useState(''),
    [pair, setPair] = useState<{ code: string; expiresAt: string }>(),
    [url, setUrl] = useState(''),
    [remote, setRemote] = useState(''),
    [mode, setMode] = useState(window.botBotsDesktop?.mode ?? 'client'),
    [busy, setBusy] = useState(false);
  async function load() {
    const value = await api<AccessInfo>('/access');
    setInfo(value);
    setUrl(value.publicUrl);
    setUsername(value.username ?? '');
  }
  useEffect(() => {
    if (accessRole === 'owner') void load().catch((e) => notify(e.message));
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
  if (accessRole !== 'owner')
    return (
      <section className="panel settings-panel">
        <h2>Connected as {accessRole}</h2>
        <p>
          {accessRole === 'viewer'
            ? 'You can check progress, conversations and results.'
            : 'You can also send tasks and steer work.'}{' '}
          The owner manages permissions, credentials and devices on the server.
        </p>
        <button
          className="secondary"
          onClick={() =>
            void fetch(`${connection().base}/auth/logout`, {
              method: 'POST',
              credentials: 'include',
            }).then(() => {
              sessionStorage.removeItem('bot-bots-token');
              location.reload();
            })
          }
        >
          Sign out this device
        </button>
      </section>
    );
  return (
    <section className="panel settings-panel access-settings">
      <h2>Server, clients & devices</h2>
      <p>
        {window.botBotsDesktop?.mode === 'server'
          ? 'This desktop app hosts the team.'
          : 'This is a client of the hosting computer.'}{' '}
        Phones, tablets and other computers can use the same team through its server address.
      </p>
      {window.botBotsDesktop && (
        <div className="host-mode">
          <Field label="Desktop role">
            <select value={mode} onChange={(e) => setMode(e.target.value as 'server' | 'client')}>
              <option value="server">Server · host this team here</option>
              <option value="client">Client · connect to a host</option>
            </select>
          </Field>
          {mode === 'client' && (
            <Field label="Existing server URL">
              <input
                type="url"
                placeholder="https://bots.example.com"
                value={remote}
                onChange={(e) => setRemote(e.target.value)}
              />
            </Field>
          )}
          <button
            className="secondary"
            disabled={busy || (mode === 'client' && !remote)}
            onClick={() =>
              void window.botBotsDesktop
                ?.setMode?.({ mode: mode as 'server' | 'client', serverUrl: remote })
                .catch((e) => notify(e.message))
            }
          >
            Apply role & restart app
          </button>
        </div>
      )}
      <h3>{info?.ownerConfigured ? 'Owner login' : 'Set up an owner login'}</h3>
      <p className="subtle">
        Use this login when opening the server address on your phone. Pairing codes and API keys
        offer limited access for other devices and apps.
      </p>
      <div className="two-columns">
        <Field label="Owner name">
          <input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Owner password">
          <input
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 12 characters"
          />
        </Field>
      </div>
      <button
        className="secondary"
        disabled={busy || password.length < 12 || !username}
        onClick={() =>
          void act(async () => {
            await api('/access/setup', 'POST', { username, password });
            setPassword('');
            notify('Owner login saved.');
          })
        }
      >
        {info?.ownerConfigured ? 'Change login' : 'Create owner login'}
      </button>
      <h3>Pair a device</h3>
      <Field label="Device access">
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="viewer">Viewer · check progress and history</option>
          <option value="operator">Operator · also send tasks and steer work</option>
        </select>
      </Field>
      <button
        className="secondary"
        disabled={busy}
        onClick={() =>
          void act(async () => setPair(await api('/access/pairing', 'POST', { role })))
        }
      >
        Make a one-use pairing code
      </button>
      {pair && (
        <div className="pairing-code">
          <strong>{pair.code}</strong>
          <CopyButton text={pair.code} />
          <small>
            Expires {new Date(pair.expiresAt).toLocaleTimeString()} · open the server URL on the
            other device and choose Pair device.
          </small>
        </div>
      )}
      <h3>API keys for apps</h3>
      {info?.devices?.length ? (
        <details>
          <summary>Signed-in devices ({info.devices.length})</summary>
          {info.devices.map((device) => (
            <div className="access-key" key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <small>
                  {device.role} · expires{' '}
                  {device.expiresAt
                    ? new Date(device.expiresAt).toLocaleDateString()
                    : 'when revoked'}
                </small>
              </div>
              <button
                className="secondary small"
                onClick={() => void act(() => api(`/access/keys/${device.id}`, 'DELETE'))}
              >
                Revoke device
              </button>
            </div>
          ))}
        </details>
      ) : null}
      <Field label="App or device name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My phone dashboard"
        />
      </Field>
      <button
        className="secondary"
        disabled={busy || !name.trim()}
        onClick={() =>
          void act(async () => {
            const created = await api<{ token: string }>('/access/keys', 'POST', { name, role });
            setKey(created.token);
            setName('');
          })
        }
      >
        Create {role} key
      </button>
      {key && (
        <div className="issued-key">
          <p>Copy this key now. Only its hash is stored.</p>
          <input readOnly value={key} aria-label="New API key" />
          <CopyButton text={key} />
        </div>
      )}
      {info?.keys.map((k) => (
        <div className="access-key" key={k.id}>
          <div>
            <strong>{k.name}</strong>
            <small>
              {k.role} · {new Date(k.createdAt).toLocaleDateString()}
            </small>
          </div>
          <button
            className="secondary small"
            onClick={() => void act(() => api(`/access/keys/${k.id}`, 'DELETE'))}
          >
            Revoke
          </button>
        </div>
      ))}
      <h3>Reach this computer from the web</h3>
      <p>
        A stable HTTPS tunnel can reach the host without router port forwarding or a fixed home IP.
        Configure your hostname/tunnel first, then save its public address here so Bot-Bots accepts
        that hostname.
      </p>
      <Field label="Public HTTPS server URL">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://bots.example.com"
        />
      </Field>
      <button
        className="secondary"
        disabled={busy || (!info?.ownerConfigured && !!url)}
        onClick={() => void act(() => api('/access/public-url', 'PUT', { url }))}
      >
        Save public address
      </button>
      <p className="subtle">
        Set up the owner login before exposing the host. This form records the address; it does not
        open ports or create a tunnel. See docs/REMOTE-ACCESS.md for Cloudflare Tunnel,
        private-network access and deployment details.
      </p>
      {!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) && (
        <button
          className="secondary"
          onClick={() =>
            void fetch(`${connection().base}/auth/logout`, {
              method: 'POST',
              credentials: 'include',
            }).then(() => {
              sessionStorage.removeItem('bot-bots-token');
              location.reload();
            })
          }
        >
          Sign out this device
        </button>
      )}
    </section>
  );
}
