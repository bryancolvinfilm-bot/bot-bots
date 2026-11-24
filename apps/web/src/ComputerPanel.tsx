import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Hand,
  LoaderCircle,
  Play,
  Plus,
  RotateCw,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Bot } from '../../../packages/shared/types';
import type { BrowserAction, BrowserTab, ComputerState } from '../../../packages/shared/computer';
import { api, connection, watchComputer } from './api';
import { Avatar } from './Avatar';
import './computer.css';

export function ComputerPanel({
  open,
  close,
  bots,
  blocked,
  onState,
}: {
  open: boolean;
  close: () => void;
  bots: Bot[];
  blocked: boolean;
  onState: (state: ComputerState) => void;
}) {
  const [state, setState] = useState<ComputerState>();
  const [address, setAddress] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [capture, setCapture] = useState<{ image: string; width: number; height: number }>();
  const [text, setText] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const base = connection().base;
  const native = !!window.botBotsComputer && !base;
  const tab = state?.tabs.find((t) => t.id === state.activeTabId);
  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    function connect() {
      void watchComputer((next) => {
        setState(next);
        onState(next);
      }, controller.signal)
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) retry = setTimeout(connect, 2500);
        });
    }
    connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [base, onState]);
  useEffect(() => {
    setAddress(tab?.url ?? '');
    setCapture(undefined);
  }, [tab?.id, tab?.url]);
  useEffect(() => {
    if (!window.botBotsComputer) return;
    let pending = 0;
    const update = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const rect = viewport.current?.getBoundingClientRect();
        void window
          .botBotsComputer!.layout({
            visible: !!(native && open && !blocked && tab?.url && rect && rect.width > 0),
            x: Math.max(0, rect?.x ?? 0),
            y: Math.max(0, rect?.y ?? 0),
            width: Math.max(1, rect?.width ?? 1),
            height: Math.max(1, rect?.height ?? 1),
          })
          .catch((e) => setError(e.message));
      });
    };
    const observer = new ResizeObserver(update);
    if (viewport.current) observer.observe(viewport.current);
    window.addEventListener('resize', update);
    update();
    return () => {
      cancelAnimationFrame(pending);
      observer.disconnect();
      window.removeEventListener('resize', update);
      void window
        .botBotsComputer!.layout({ visible: false, x: 0, y: 0, width: 1, height: 1 })
        .catch(() => {});
    };
  }, [native, open, blocked, tab?.id, !!tab?.url]);
  useEffect(() => {
    if (!open || native || !tab?.url) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    setCapture(undefined);
    async function frame() {
      try {
        const shot = await api<{ image: string; width: number; height: number }>(
          `/computer/tabs/${tab!.id}/capture`,
        );
        if (!stopped) setCapture(shot);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) timer = setTimeout(frame, 1000);
      }
    }
    void frame();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [open, native, tab?.id, !!tab?.url]);
  async function act(action: BrowserAction) {
    setBusy(true);
    setError('');
    try {
      const current = tab ?? (await api<BrowserTab>('/computer/tabs', 'POST'));
      await api('/computer/action', 'POST', { tabId: current.id, action });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function command(path: string, method: string, body?: unknown) {
    try {
      setError('');
      await api(path, method, body);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!open) return null;
  return (
    <aside className="computer-panel" aria-label="Browser workspace">
      <header className="computer-heading">
        <Globe size={18} />
        <div>
          <strong>Browser</strong>
          <small>Your team’s shared browser</small>
        </div>
        <button type="button" className="icon-button" aria-label="Close browser" onClick={close}>
          <X size={18} />
        </button>
      </header>
      <div className="computer-kind">
        <Globe size={14} />
        <strong>Browser</strong>
        <span>Chromium</span>
        <small>Separate sessions for each bot</small>
      </div>
      {state?.available && (
        <label className="computer-search-provider">
          Search with
          <select
            aria-label="Web search provider"
            value={state.searchProvider}
            onChange={(e) =>
              void command('/computer/search-provider', 'POST', { provider: e.target.value })
            }
          >
            <option value="google">Google</option>
            <option value="bing">Bing</option>
            <option value="brave">Brave</option>
            <option value="duckduckgo">DuckDuckGo</option>
          </select>
          <span>Bots try alternatives if blocked</span>
        </label>
      )}
      {!state?.available ? (
        <div className="computer-empty">
          <Globe size={40} />
          <h3>A browser for your team</h3>
          <p>{state?.error ?? 'Connecting to the browser…'}</p>
        </div>
      ) : (
        <>
          {state.pool && (
            <div className="browser-pool-status" role="status">
              {state.pool.active} of {state.pool.limit} browser sessions working
              {state.pool.waiting.length
                ? ` · ${state.pool.waiting.length} searches queued: ${state.pool.waiting.map((job) => bots.find((bot) => bot.id === job.botId)?.name ?? 'Worker').join(', ')}`
                : ' · Each bot has its own isolated browser'}
            </div>
          )}
          <div className="computer-tabs" role="tablist" aria-label="Browser tabs">
            {state.tabs.map((t) => {
              const bot = bots.find((b) => b.id === t.botId);
              return (
                <div
                  className={t.id === tab?.id ? 'computer-tab selected' : 'computer-tab'}
                  key={t.id}
                >
                  <button
                    role="tab"
                    aria-selected={t.id === tab?.id}
                    title={`${bot?.name ?? 'You'} · ${t.title}`}
                    onClick={() => void command('/computer/select', 'POST', { tabId: t.id })}
                  >
                    {bot ? (
                      <Avatar avatar={bot.avatar} size={22} busy={t.loading} />
                    ) : (
                      <Globe size={14} />
                    )}
                    <span>
                      {bot?.name ?? 'You'}
                      <small>{t.title}</small>
                    </span>
                  </button>
                  <button
                    className="tab-close"
                    aria-label={`Close ${bot?.name ?? 'your'} browser tab`}
                    onClick={() => void command(`/computer/tabs/${t.id}`, 'DELETE')}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
            <button
              className="icon-button"
              aria-label="New browser tab"
              onClick={() => void command('/computer/tabs', 'POST')}
            >
              <Plus size={17} />
            </button>
          </div>
          <form
            className="computer-address"
            onSubmit={(e) => {
              e.preventDefault();
              const value = address.trim();
              if (!value) return;
              const url = /^https?:\/\//i.test(value)
                ? value
                : /^[^\s/]+\.[^\s]+/.test(value)
                  ? `https://${value}`
                  : `${state.searchProvider === 'duckduckgo' ? 'https://html.duckduckgo.com/html/?q=' : state.searchProvider === 'bing' ? 'https://www.bing.com/search?q=' : state.searchProvider === 'brave' ? 'https://search.brave.com/search?q=' : 'https://www.google.com/search?q='}${encodeURIComponent(value)}`;
              void act({ kind: 'open', url });
            }}
          >
            <button
              type="button"
              aria-label="Browser back"
              disabled={!tab?.canGoBack || busy}
              onClick={() => void act({ kind: 'back' })}
            >
              <ArrowLeft size={15} />
            </button>
            <button
              type="button"
              aria-label="Browser forward"
              disabled={!tab?.canGoForward || busy}
              onClick={() => void act({ kind: 'forward' })}
            >
              <ArrowRight size={15} />
            </button>
            <button
              type="button"
              aria-label="Reload browser page"
              disabled={!tab?.url || busy}
              onClick={() => void act({ kind: 'reload' })}
            >
              {tab?.loading ? <LoaderCircle size={14} className="spin" /> : <RotateCw size={14} />}
            </button>
            <input
              aria-label="Browser address or search"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Search the web or enter a URL"
            />
            <button aria-label="Go to browser address" disabled={busy}>
              <Search size={15} />
            </button>
          </form>
          <div className={`computer-control ${state.paused ? 'human-control' : ''}`}>
            <span>
              {state.paused
                ? 'You’re in control · bot actions wait'
                : 'Bots can browse · you can watch and assist'}
            </span>
            <button
              className="secondary small"
              onClick={() => void command('/computer/control', 'POST', { paused: !state.paused })}
            >
              {state.paused ? <Play size={13} /> : <Hand size={13} />}
              {state.paused ? 'Resume bots' : 'Take control'}
            </button>
          </div>
          {(error || tab?.error) && (
            <div className="computer-error" role="alert">
              {error || tab?.error}
              <button aria-label="Dismiss browser error" onClick={() => setError('')}>
                <X size={12} />
              </button>
            </div>
          )}
          <div
            ref={viewport}
            className={`computer-viewport ${native ? 'native-viewport' : 'remote-viewport'}`}
            aria-label="Browser page"
          >
            {!tab?.url ? (
              <div className="computer-empty">
                <Globe size={42} />
                <h3>A little window to the web</h3>
                <p>Search above, or ask a bot to research something. Its tab will appear here.</p>
              </div>
            ) : !native && capture ? (
              <img
                className="computer-frame"
                src={capture.image}
                alt="Live shared browser page"
                draggable={false}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  void act({
                    kind: 'pointer',
                    x: (e.clientX - rect.left) / rect.width,
                    y: (e.clientY - rect.top) / rect.height,
                  });
                }}
              />
            ) : !native ? (
              <div className="computer-empty">
                <LoaderCircle className="spin" />
                Loading the host’s browser view…
              </div>
            ) : null}
          </div>
          {!native && tab?.url && (
            <form
              className="remote-browser-input"
              onSubmit={(e) => {
                e.preventDefault();
                void act({ kind: 'keyboard', text, enter: true });
                setText('');
              }}
            >
              <button
                type="button"
                aria-label="Scroll browser up"
                onClick={() => void act({ kind: 'scroll', direction: 'up' })}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label="Scroll browser down"
                onClick={() => void act({ kind: 'scroll', direction: 'down' })}
              >
                ↓
              </button>
              <input
                aria-label="Type into focused browser field"
                placeholder="Click a field above, then type here"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <button className="secondary small">Type & enter</button>
            </form>
          )}
          <footer className="computer-status">
            {busy || tab?.loading ? (
              <LoaderCircle className="spin" size={12} />
            ) : (
              <span className="green-dot" />
            )}
            <span>{state.lastAction ?? 'Ready to explore'}</span>
          </footer>
        </>
      )}
    </aside>
  );
}
