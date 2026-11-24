import { Hand, LoaderCircle, Play, ShieldCheck, Square, TerminalSquare, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TerminalState } from '../../../packages/shared/terminal';
import type { Bot } from '../../../packages/shared/types';
import { api, connection, watchTerminal } from './api';
import { CopyButton } from './CodeBlock';
import { Avatar } from './Avatar';
export function TerminalPanel({
  open,
  close,
  draft,
  setDraft,
  bots,
  onState,
  attention,
}: {
  open: boolean;
  close: () => void;
  draft: string;
  setDraft: (value: string) => void;
  bots: Bot[];
  onState: (state: TerminalState) => void;
  attention: () => void;
}) {
  const [state, setState] = useState<TerminalState>(),
    [cwd, setCwd] = useState('.'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const known = useRef(new Set<string>()),
    input = useRef<HTMLTextAreaElement>(null),
    history = useRef<HTMLDivElement>(null),
    following = useRef(true);
  const base = connection().base;
  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    const connect = () =>
      void watchTerminal((next) => {
        setState(next);
        onState(next);
        const pending = next.jobs.filter((j) => j.status === 'awaiting-approval');
        if (pending.some((j) => !known.current.has(j.id))) attention();
        for (const j of pending) known.current.add(j.id);
      }, controller.signal)
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) retry = setTimeout(connect, 2500);
        });
    connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [base, onState, attention]);
  useEffect(() => {
    if (open && draft) input.current?.focus();
  }, [open, draft]);
  useEffect(() => {
    if (open && history.current) {
      history.current.scrollTop = history.current.scrollHeight;
      following.current = true;
    }
  }, [open, state?.jobs[0]?.id]);
  useEffect(() => {
    if (following.current && history.current)
      history.current.scrollTop = history.current.scrollHeight;
  }, [state?.jobs[0]?.output.length, state?.jobs[0]?.status]);
  async function action(path: string, body?: unknown) {
    setError('');
    setBusy(true);
    try {
      await api(path, 'POST', body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    if (!draft.trim() || busy) return;
    const command = draft;
    await action('/terminal/manual', { command, cwd });
  }
  if (!open) return null;
  return (
    <section className="terminal-panel" aria-label="Terminal panel">
      <header>
        <TerminalSquare size={17} />
        <strong>Terminal</strong>
        <span>{state?.shell ?? 'Host shell'}</span>
        <small>
          <ShieldCheck size={12} />
          Bots need your approval for every command
        </small>
        <button className="icon-button" aria-label="Hide terminal" onClick={close}>
          <X size={17} />
        </button>
      </header>
      <div
        ref={history}
        className="terminal-jobs"
        aria-label="Terminal history"
        onScroll={() => {
          const pane = history.current;
          if (pane) following.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 30;
        }}
      >
        {!state?.jobs.length && (
          <div className="terminal-empty">
            Paste a command below, or review a bot’s request here. Commands run on the host as your
            user account.
          </div>
        )}
        {[...(state?.jobs ?? [])].reverse().map((job) => {
          const bot = bots.find((b) => b.id === job.botId);
          return (
            <details
              className={`terminal-job ${job.status}`}
              key={job.id}
              data-terminal-id={job.id}
              data-status={job.status}
              open={
                ['running', 'awaiting-approval'].includes(job.status) ||
                state?.jobs[0]?.id === job.id
              }
            >
              <summary>
                {bot && <Avatar avatar={bot.avatar} size={22} />}
                <strong>{bot?.name ?? 'You'}</strong>
                <span>{job.status === 'awaiting-approval' ? 'Permission needed' : job.status}</span>
                <code>{job.command.slice(0, 100)}</code>
                {job.exitCode !== undefined && <small>exit {job.exitCode}</small>}
              </summary>
              <div className="terminal-job-body">
                <p>{job.reason}</p>
                <div className="terminal-cwd">
                  Working folder: <code>{job.cwd}</code> · Limit: {job.timeoutMs / 1000}s
                </div>
                <div className="terminal-command">
                  <pre>{job.command}</pre>
                  <CopyButton text={job.command} label="Copy command" />
                </div>
                {job.status === 'awaiting-approval' && (
                  <div className="terminal-permission">
                    <Hand size={17} />
                    <span>
                      Approve this exact command once? It can affect files and programs outside the
                      starting folder.
                    </span>
                    <button
                      className="primary small"
                      disabled={busy}
                      onClick={() => void action(`/terminal/${job.id}/decision`, { approve: true })}
                    >
                      Approve once
                    </button>
                    <button
                      className="secondary small"
                      disabled={busy}
                      onClick={() =>
                        void action(`/terminal/${job.id}/decision`, { approve: false })
                      }
                    >
                      Deny
                    </button>
                  </div>
                )}
                {job.output && (
                  <pre className="terminal-output" aria-label="Command output">
                    {job.output}
                  </pre>
                )}
                {job.error && <div className="terminal-error">{job.error}</div>}
                {job.status === 'running' && (
                  <button
                    className="secondary small"
                    onClick={() => void action(`/terminal/${job.id}/cancel`)}
                  >
                    <Square size={12} />
                    Stop command
                  </button>
                )}
              </div>
            </details>
          );
        })}
      </div>
      {error && (
        <div className="terminal-error" role="alert">
          {error}
        </div>
      )}
      <form
        className="terminal-input"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label>
          Folder
          <input
            aria-label="Terminal working folder"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
          />
        </label>
        <textarea
          ref={input}
          aria-label="Terminal command"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Paste a ${state?.shell ?? 'shell'} command…`}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void run();
            }
          }}
        />
        <CopyButton text={draft} label="Copy terminal input" />
        <button className="primary small" disabled={!draft.trim() || busy}>
          {busy ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}Run command
        </button>
      </form>
    </section>
  );
}
