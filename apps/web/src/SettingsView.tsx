import { AlertCircle, Check, Download, Link2, Moon, Plug, Sun, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Bootstrap, Settings } from '../../../packages/shared/types';
import { api, connection } from './api';
import { AccessSettings } from './AccessSettings';
import type { Theme } from './theme';
import { canBeMainBot } from '../../../packages/shared/main-bot';
import { CredentialsPanel } from './CredentialsPanel';

import { Field, Heading, Modal } from './ui';
export function SettingsView({
  data,
  act,
  connect,
  theme,
  changeTheme,
  notify,
}: {
  data: Bootstrap;
  act: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
  connect: () => void;
  theme: Theme;
  changeTheme: (theme: Theme) => void;
  notify: (message: string) => void;
}) {
  const [s, setS] = useState<Settings>(data.settings);
  useEffect(() => {
    setS((current) => ({
      ...current,
      alertEmail:
        current.alertEmail.credentialId === data.settings.alertEmail.credentialId
          ? current.alertEmail
          : {
              ...current.alertEmail,
              url: data.settings.alertEmail.url,
              credentialId: data.settings.alertEmail.credentialId,
            },
      alertSms:
        current.alertSms.credentialId === data.settings.alertSms.credentialId
          ? current.alertSms
          : {
              ...current.alertSms,
              url: data.settings.alertSms.url,
              credentialId: data.settings.alertSms.credentialId,
            },
    }));
  }, [data.settings.alertEmail.credentialId, data.settings.alertSms.credentialId]);
  const file = useRef<HTMLInputElement>(null);
  const backup = async () => {
    const value = await api('/export');
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `bot-bots-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  if (data.accessRole && data.accessRole !== 'owner')
    return (
      <main className="page">
        <Heading
          title="Your connection"
          eyebrow="AT HOME WITH THE TEAM"
          description="This device uses the team’s server."
        />
        <section className="panel settings-panel">
          <h2>Appearance</h2>
          <div className="button-row">
            <button className="secondary" onClick={() => changeTheme('dark')}>
              Dark mode
            </button>
            <button className="secondary" onClick={() => changeTheme('light')}>
              Light mode
            </button>
            <button className="secondary" onClick={connect}>
              Connect to another server
            </button>
          </div>
        </section>
        <AccessSettings notify={notify} accessRole={data.accessRole} />
      </main>
    );
  return (
    <main className="page">
      <Heading
        eyebrow="A PLACE FOR EVERYTHING"
        title="Settings & connections"
        description="Make this little team feel at home on your machine."
      >
        <button
          className="primary"
          onClick={() => void act(() => api('/settings', 'PUT', s), 'Settings saved')}
        >
          <Check size={15} />
          Save settings
        </button>
      </Heading>
      <section className="panel settings-panel theme-panel">
        <h2>Appearance</h2>
        <p>Choose how your workspace looks. Dark is the default.</p>
        <div className="theme-choices" role="radiogroup" aria-label="Color theme">
          <label className="theme-choice">
            <input
              type="radio"
              name="theme"
              aria-label="Dark theme"
              checked={theme === 'dark'}
              onChange={() => changeTheme('dark')}
            />
            <Moon size={21} />
            <span>
              <strong>Dark</strong>
              <small>Default · Easy on the eyes</small>
            </span>
          </label>
          <label className="theme-choice">
            <input
              type="radio"
              name="theme"
              aria-label="Light theme"
              checked={theme === 'light'}
              onChange={() => changeTheme('light')}
            />
            <Sun size={21} />
            <span>
              <strong>Light</strong>
              <small>A brighter workspace</small>
            </span>
          </label>
        </div>
        <small>Applies immediately and remembers your choice on this device.</small>
      </section>
      <AccessSettings notify={notify} />
      <CredentialsPanel bots={data.bots} />
      <section className="panel settings-panel">
        <h2>Your main bot</h2>
        <p>
          Pick an optional go-to teammate for delegation. It gets extra guidance to bring in
          suitable specialists when you chat with it directly. Your conversations with other bots
          stay their own.
        </p>
        <Field label="Main delegation bot">
          <select
            aria-label="Main delegation bot"
            value={s.mainBotId ?? ''}
            onChange={(e) => setS({ ...s, mainBotId: e.target.value || null })}
          >
            <option value="">No main bot</option>
            {data.bots.filter(canBeMainBot).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <small>
            Only one main bot at a time. Choose No main bot to clear it, then Save settings.
            Prototypes and temporary workers keep their own roles.
          </small>
        </Field>
      </section>
      <section className="panel settings-panel">
        <h2>When the models go quiet.</h2>
        <p>
          Email and SMS warnings run directly from the server, even when every LLM is offline.
          Configure your delivery APIs here when you’re ready.
        </p>
        <div className="two-columns">
          {(['alertEmail', 'alertSms'] as const).map((key) => (
            <div key={key}>
              <h3>{key === 'alertEmail' ? 'Email warning' : 'Text message warning'}</h3>
              <Field label="Delivery API endpoint">
                <input
                  type="url"
                  placeholder="https://your-alert-service.example/send"
                  value={s[key].url}
                  onChange={(e) => setS({ ...s, [key]: { ...s[key], url: e.target.value } })}
                />
              </Field>
              <Field label={key === 'alertEmail' ? 'Email destination' : 'Phone destination'}>
                <input
                  value={s[key].destination}
                  placeholder={key === 'alertEmail' ? 'Your email address' : '+1…'}
                  onChange={(e) =>
                    setS({ ...s, [key]: { ...s[key], destination: e.target.value } })
                  }
                />
              </Field>
              <Field label="Token environment variable">
                <input
                  value={s[key].tokenEnv}
                  placeholder="ALERT_API_TOKEN"
                  onChange={(e) => setS({ ...s, [key]: { ...s[key], tokenEnv: e.target.value } })}
                />
              </Field>
              <Field label="Saved credential connection (optional)">
                <input
                  value={s[key].credentialId ?? ''}
                  placeholder="External alert binding ID"
                  onChange={(e) =>
                    setS({ ...s, [key]: { ...s[key], credentialId: e.target.value || undefined } })
                  }
                />
                <small>This references an external grant; it is not the token value.</small>
              </Field>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={s[key].enabled}
                  onChange={(e) => setS({ ...s, [key]: { ...s[key], enabled: e.target.checked } })}
                />
                Enable {key === 'alertEmail' ? 'email' : 'SMS'} warnings
              </label>
            </div>
          ))}
        </div>
        <Field label="Repeat alert cooldown (minutes)">
          <input
            className="number-input"
            type="number"
            min="1"
            max="1440"
            value={s.alertCooldownMinutes}
            onChange={(e) => setS({ ...s, alertCooldownMinutes: Number(e.target.value) })}
          />
        </Field>
        <small>
          Alerts POST JSON with event, incidentId, channel, to, message, and openedAt. Delivery
          errors are recorded in the incident.
        </small>
        {data.incidents.map((i) => (
          <div className="incident" key={i.id}>
            <AlertCircle size={16} />
            <div>
              <strong>{i.resolvedAt ? 'Recovered' : 'Models unavailable'}</strong>
              <p>{i.message}</p>
              <small>
                {new Date(i.openedAt).toLocaleString()} ·{' '}
                {i.deliveries.map((d) => `${d.channel}: ${d.status}`).join(', ') ||
                  'No delivery channels configured'}
              </small>
            </div>
          </div>
        ))}
      </section>
      <section className="panel settings-panel">
        <h2>Connections</h2>
        <p>
          Restoring instructions doesn’t restore the original platform’s authenticated services.
        </p>
        {data.connections.map((c) => (
          <div className="connection-row" key={c.id}>
            <Plug size={19} />
            <div>
              <strong>{c.name}</strong>
              <p>{c.detail}</p>
            </div>
            <span className={`status-badge ${c.status === 'connected' ? 'online' : 'unknown'}`}>
              {c.status}
            </span>
          </div>
        ))}
      </section>
      <section className="panel settings-panel">
        <h2>Runtime limits</h2>
        <div className="three-columns">
          <Field label="Output tokens per model call">
            <input
              type="number"
              min="512"
              max="32768"
              value={s.maxOutputTokens}
              onChange={(e) => setS({ ...s, maxOutputTokens: Number(e.target.value) })}
            />
          </Field>
          <Field label="Tool steps per automatic stage">
            <input
              type="number"
              min="1"
              max="20"
              value={s.maxToolSteps}
              onChange={(e) => setS({ ...s, maxToolSteps: Number(e.target.value) })}
            />
          </Field>
          <Field label="Maximum handoff depth">
            <input
              type="number"
              min="0"
              max="3"
              value={s.maxDelegationDepth}
              onChange={(e) => setS({ ...s, maxDelegationDepth: Number(e.target.value) })}
            />
          </Field>
          <Field label="Parallel browser sessions">
            <input
              type="number"
              min="1"
              max="12"
              value={s.maxBrowserSessions ?? 6}
              onChange={(event) => setS({ ...s, maxBrowserSessions: Number(event.target.value) })}
            />
            <small>
              Each bot has its own browser. Extra searches wait their turn; choose 1 for a
              single-browser queue.
            </small>
          </Field>
        </div>
      </section>
      <section className="panel settings-panel">
        <h2>Your team travels with you.</h2>
        <p>
          Export a private JSON backup, restore one on another host, or connect this UI to a server.
          Backups include conversations and personal information; keys stay in the host’s credential
          store and are excluded. Workspace files are separate.
        </p>
        <div className="button-row">
          <button className="secondary" onClick={() => void act(backup)}>
            <Download size={16} />
            Export backup
          </button>
          <button className="secondary" onClick={() => file.current?.click()}>
            <Upload size={16} />
            Restore backup
          </button>
          <button className="secondary" onClick={connect}>
            <Link2 size={16} />
            Connect to server
          </button>
          <input
            ref={file}
            hidden
            type="file"
            accept=".json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f)
                void act(async () => {
                  const content = JSON.parse(await f.text());
                  await api('/import', 'POST', content);
                }, 'Backup merged. Imported routines are paused.');
            }}
          />
        </div>
      </section>
    </main>
  );
}

export function ServerDialog({
  close,
  refresh,
}: {
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [url, setUrl] = useState(connection().base);
  const [token, setToken] = useState(connection().token);
  return (
    <Modal title="Where does your team live?" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          localStorage.setItem('bot-bots-server', url.replace(/\/$/, ''));
          sessionStorage.setItem('bot-bots-token', token);
          void refresh();
          close();
        }}
      >
        <p className="form-intro">
          For this machine, leave the server URL blank. For a remote host, open its web UI directly
          and enter its token here. For a separate UI, allow its exact origin on the host with
          BOT_BOTS_ALLOWED_ORIGINS. This UI’s origin is {window.location.origin}.
        </p>
        <Field label="Server URL (optional)">
          <input
            type="url"
            placeholder="Use this app’s server"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label="Server access token">
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <small>Kept only for this browser session. Use HTTPS for remote access.</small>
        </Field>
        <div className="modal-footer">
          <button className="primary">Connect to team</button>
        </div>
      </form>
    </Modal>
  );
}
