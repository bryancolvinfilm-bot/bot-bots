import {
  Activity,
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  LayoutGrid,
  Menu,
  MessageCircle,
  Globe,
  TerminalSquare,
  Code2,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  X,
  Zap,
  Puzzle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ActivityUpdate,
  Bootstrap,
  Bot,
  Conversation,
  TeamConversation,
  Run,
} from '../../../packages/shared/types';
import { activeBotWork } from '../../../packages/shared/activity';
import { mergeRunState } from '../../../packages/shared/collaboration';
import { api, connection } from './api';
import { Avatar, emptyAvatar } from './Avatar';
import { BotEditor } from './BotEditor';
import { CredentialManager } from './CredentialManager';
import { BotActions } from './BotActions';
import { BotRoster } from './BotSidebar';
import { useLiveActivity } from './useActivity';
import { Chat } from './Chat';
import { Models } from './Models';
import { TeamModels } from './TeamModels';
import { applyUsageUpdate } from '../../../packages/shared/token-usage';
import { Routines } from './Routines';
import { ServerDialog, SettingsView } from './SettingsView';
import './theme.css';
import './style.css';
import './sidebar.css';
import { useTheme } from './theme';
import { Team } from './Team';
import { ActivityView, Memories, Pages, Skills } from './WorkspaceViews';
import { ComputerPanel } from './ComputerPanel';
import type { ComputerState } from '../../../packages/shared/computer';
import type { TerminalState } from '../../../packages/shared/terminal';
import type { PreviewDocument } from '../../../packages/shared/artifacts';
import { PreviewPanel } from './PreviewPanel';
import { TerminalPanel } from './TerminalPanel';
import './code.css';
import './steering.css';
import './drafts.css';
import './workshop.css';
import { Plugins } from './Plugins';
import { LoginCard } from './LoginCard';
import { rankModels } from '../../../packages/shared/model-routing';
type View =
  | 'team'
  | 'chat'
  | 'models'
  | 'routines'
  | 'memory'
  | 'skills'
  | 'pages'
  | 'activity'
  | 'settings'
  | 'plugins';
const nav = [
  ['team', 'Your team', LayoutGrid],
  ['chat', 'Conversations', MessageCircle],
  ['routines', 'Routines', Clock3],
  ['memory', 'Memory', BookOpen],
  ['pages', 'Pages', FileText],
] as const;
const toolNav = [
  ['plugins', 'Plugins', Puzzle],
  ['models', 'Model workshop', SlidersHorizontal],
  ['skills', 'Shared skills', Zap],
  ['activity', 'Activity', Activity],
] as const;
function App() {
  const { theme, changeTheme } = useTheme();
  const [data, setData] = useState<Bootstrap>();
  const [view, setView] = useState<View>('team');
  const [botId, setBotId] = useState('boss-man');
  const [conversationId, setConversationId] = useState<string>();
  const [teamSpaces, setTeamSpaces] = useState<TeamConversation[]>([]);
  const [teamSpaceId, setTeamSpaceId] = useState<string>();
  const [requestedChannel, setRequestedChannel] = useState<string>();
  const chatRef = useRef<(id: string, conversationId?: string) => void>(() => {});
  const [editing, setEditing] = useState<Bot | null>();
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [serverDialog, setServerDialog] = useState(false);
  const [teamModelsOpen, setTeamModelsOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [computerOpen, setComputerOpen] = useState(false);
  const [computer, setComputer] = useState<ComputerState>();
  const [previewDoc, setPreviewDoc] = useState<PreviewDocument>();
  const [botPanelOpen, setBotPanelOpen] = useState(false),
    [pluginPending, setPluginPending] = useState(0),
    [credentialPending, setCredentialPending] = useState(0);
  const [terminalOpen, setTerminalOpen] = useState(false),
    [terminalDraft, setTerminalDraft] = useState('');
  const [terminalState, setTerminalState] = useState<TerminalState>();
  const terminalAttention = useCallback(() => setTerminalOpen(true), []);
  useEffect(() => {
    const preview = (event: Event) => {
      setBotPanelOpen(false);
      setPreviewDoc((event as CustomEvent<PreviewDocument>).detail);
      setComputerOpen(false);
    };
    const paste = (event: Event) => {
      setTerminalDraft(String((event as CustomEvent<string>).detail));
      setTerminalOpen(true);
    };
    const openRun = (event: Event) => {
      const run = (event as CustomEvent<Run>).detail;
      chatRef.current(run.botId, run.conversationId);
    };
    window.addEventListener('bot-bots:preview', preview);
    window.addEventListener('bot-bots:terminal-paste', paste);
    window.addEventListener('bot-bots:open-run', openRun);
    return () => {
      window.removeEventListener('bot-bots:preview', preview);
      window.removeEventListener('bot-bots:terminal-paste', paste);
      window.removeEventListener('bot-bots:open-run', openRun);
    };
  }, []);
  const navigation = useRef(0);
  const work = useMemo(() => activeBotWork(data?.runs ?? []), [data?.runs]);
  const [workClock, setWorkClock] = useState(Date.now);
  const hasWork = work.size > 0;
  useEffect(() => {
    if (!hasWork) return;
    setWorkClock(Date.now());
    const clock = setInterval(() => setWorkClock(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [hasWork]);
  const onActivity = useCallback((update: ActivityUpdate) => {
    setData((current) => {
      if (!current) return current;
      if (update.type === 'models')
        return { ...current, models: update.models, providers: update.providers };
      if (update.type === 'usage')
        return {
          ...current,
          runs: current.runs.map((run) => applyUsageUpdate(run, update) ?? run),
        };
      const incoming = update.type === 'snapshot' ? update.runs : [update.run];
      const activeIds = new Set(incoming.map((run) => run.id));
      const runs = new Map(
        current.runs
          .filter(
            (run) =>
              update.type !== 'snapshot' || run.status !== 'running' || activeIds.has(run.id),
          )
          .map((run) => [run.id, run]),
      );
      for (const run of incoming) runs.set(run.id, mergeRunState(runs.get(run.id), run));
      return {
        ...current,
        bots: update.bots?.length
          ? [...new Map([...current.bots, ...update.bots].map((b) => [b.id, b])).values()]
          : current.bots,
        runs: [...runs.values()]
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
          .filter((run, index) => index < 100 || run.status === 'running'),
      };
    });
  }, []);
  const liveActivity = useLiveActivity(!!data, onActivity);
  const refresh = useCallback(async () => {
    try {
      const [incoming, spaces] = await Promise.all([
        api<Bootstrap>('/bootstrap'),
        api<TeamConversation[]>('/team-conversations'),
      ]);
      setTeamSpaces(spaces);
      setTeamSpaceId(
        (current) =>
          current ??
          spaces.find(
            (s) => s.id === localStorage.getItem(`bot-bots-team-space:${connection().base}`),
          )?.id ??
          spaces[0]?.id,
      );
      setData((current) => ({
        ...incoming,
        runs: incoming.runs.map((run) =>
          mergeRunState(
            current?.runs.find((known) => known.id === run.id),
            run,
          ),
        ),
      }));
      setError('');
    } catch (e) {
      setError(String((e as Error).message));
      if (/Sign in, pair this device/.test((e as Error).message)) setData(undefined);
    }
  }, []);
  useEffect(() => {
    if (teamSpaceId) localStorage.setItem(`bot-bots-team-space:${connection().base}`, teamSpaceId);
  }, [teamSpaceId]);
  useEffect(() => {
    if (view !== 'chat' || !teamSpaceId) return;
    const request = ++navigation.current;
    setConversationId(undefined);
    const load = requestedChannel
      ? api<Conversation>(`/conversations/${encodeURIComponent(requestedChannel)}`)
      : api<Conversation | null>(
          `/team-conversations/${encodeURIComponent(teamSpaceId)}/bots/${encodeURIComponent(botId)}`,
          data?.accessRole === 'viewer' ? 'GET' : 'POST',
          data?.accessRole === 'viewer' ? undefined : {},
        );
    void load
      .then((channel) => {
        if (!channel) return;
        if (navigation.current === request) {
          if (channel.spaceId !== teamSpaceId) setTeamSpaceId(channel.spaceId);
          setConversationId(channel.id);
          if (requestedChannel) setRequestedChannel(undefined);
        }
      })
      .catch((e) => {
        if (navigation.current === request) setToast(e.message);
      });
  }, [view, botId, teamSpaceId, requestedChannel, data?.accessRole]);
  useEffect(() => {
    if (data?.bots.some((bot) => bot.id === botId && (bot.archivedAt || bot.deletedAt)))
      setView('team');
  }, [data?.bots, botId]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 12000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!data) return;
    const load = () =>
      void api<{ actions: { status: string }[] }>('/plugins/google').then(
        (s) => setPluginPending(s.actions.filter((a) => a.status === 'awaiting-approval').length),
        () => {},
      );
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [!!data]);
  useEffect(() => {
    if (!data || (data.accessRole && data.accessRole !== 'owner')) {
      setCredentialPending(0);
      return;
    }
    const load = () =>
      void api<{ actions: { status: string }[] }>('/credentials').then(
        (s) =>
          setCredentialPending(s.actions.filter((a) => a.status === 'awaiting-approval').length),
        () => {},
      );
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [!!data, data?.accessRole]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  const act = async (fn: () => Promise<unknown>, message?: string) => {
    try {
      await fn();
      await refresh();
      if (message) setToast(message);
    } catch (e) {
      setToast((e as Error).message);
    }
  };
  const chat = (id: string, requestedConversation?: string) => {
    if (view === 'chat' && id === botId && !requestedConversation) {
      setMenu(false);
      return;
    }
    navigation.current++;
    setBotId(id);
    setRequestedChannel(requestedConversation);
    setConversationId(undefined);
    setView('chat');
    setMenu(false);
  };
  chatRef.current = chat;
  const selectTeamSpace = (id: string) => {
    if (id === teamSpaceId) return;
    navigation.current++;
    setRequestedChannel(undefined);
    setConversationId(undefined);
    setTeamSpaceId(id);
  };
  const newTeamSpace = () => {
    void api<TeamConversation>('/team-conversations', 'POST', {})
      .then((space) => {
        setTeamSpaces((old) => [space, ...old]);
        selectTeamSpace(space.id);
      })
      .catch((e) => setToast(e.message));
  };
  const online = data
    ? rankModels(data.models, data.providers, data.settings, data.assessments, 'general').filter(
        (m) => m.status === 'online',
      ).length
    : 0;
  return (
    <div
      className={`app-shell ${terminalOpen ? 'terminal-open' : ''} ${previewDoc?.mode === 'build' ? 'live-build-preview' : ''}`}
    >
      <aside className={`sidebar ${menu ? 'mobile-open' : ''}`} aria-label="Bot sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView('team');
          }}
        >
          <img src="/logo.svg" alt="Three smiling bots" />
          <span>
            bot-bots<span className="brand-dot">.</span>
          </span>
        </a>
        <button
          type="button"
          className="sidebar-close icon-button"
          aria-label="Close bot navigation"
          onClick={() => setMenu(false)}
        >
          <X size={18} />
        </button>
        <button className="workspace-switch" onClick={() => setServerDialog(true)}>
          <span className="workspace-icon">B</span>
          <span>
            My workspace
            <small>{connection().base ? 'Connected server' : 'Local workspace'}</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <nav className="sidebar-shortcuts" aria-label="Workspace views">
          {nav.slice(0, 2).map(([key, label, Icon]) => (
            <button
              key={key}
              className={view === key ? 'selected' : ''}
              title={label}
              onClick={() => {
                setView(key);
                setMenu(false);
              }}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {data ? (
          <BotRoster
            categories={data.categories}
            bots={data.bots}
            runs={data.runs}
            work={work}
            now={workClock}
            selectedBotId={view === 'chat' ? botId : undefined}
            mainBotId={data.settings.mainBotId}
            openBot={chat}
            moveBot={
              data.accessRole && data.accessRole !== 'owner'
                ? undefined
                : async (id, categoryId) => {
                    try {
                      await api(`/bots/${id}/category`, 'PATCH', { categoryId });
                      await refresh();
                      setToast('Bot moved');
                    } catch (error) {
                      setToast((error as Error).message);
                    }
                  }
            }
          />
        ) : (
          <div className="roster-loading">Waking up the crew?</div>
        )}
        <div className="sidebar-bottom">
          <nav className="workspace-tools" aria-label="Workspace tools">
            {[...nav.slice(2), ...toolNav].map(([key, label, Icon]) => (
              <button
                key={key}
                className={view === key ? 'selected' : ''}
                title={label}
                onClick={() => {
                  setView(key);
                  setMenu(false);
                }}
              >
                <Icon size={15} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <button
            className={view === 'settings' ? 'settings-nav selected' : 'settings-nav'}
            title="Settings & connections"
            onClick={() => {
              setView('settings');
              setMenu(false);
            }}
          >
            <Settings2 size={16} />
            <span>Settings & connections</span>
          </button>
          <div className="sidebar-sync">
            <span className={liveActivity ? 'green-dot' : 'gray-dot'} />
            <small>{liveActivity ? 'Team is in sync' : 'Checking in?'}</small>
            <ShieldCheck
              size={13}
              aria-label={data?.settings.localOnly ? 'Local models only' : 'Cloud models allowed'}
            />
          </div>
        </div>
      </aside>
      <div className={`main-shell ${computerOpen || previewDoc ? 'has-computer' : ''}`}>
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMenu(!menu)}
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb">Workspace</span>
            <ChevronRight size={13} />
            <span>{[...nav, ...toolNav].find((v) => v[0] === view)?.[1] ?? 'Settings'}</span>
          </div>
          <div className="topbar-tools">
            <button
              className={`computer-toggle ${computerOpen ? 'selected' : ''}`}
              aria-label="Toggle browser panel"
              aria-expanded={computerOpen}
              onClick={() => {
                setBotPanelOpen(false);
                setComputerOpen(!computerOpen);
                setPreviewDoc(undefined);
              }}
            >
              <Globe size={15} />
              Browser{computer?.tabs.some((t) => t.loading) && <span className="green-dot" />}
            </button>
            {previewDoc && (
              <button
                className="computer-toggle selected"
                aria-label="Website preview is open"
                onClick={() => setPreviewDoc(undefined)}
              >
                <Code2 size={15} />
                Preview
              </button>
            )}
            <button
              className={`computer-toggle ${terminalOpen ? 'selected' : ''}`}
              aria-label="Toggle terminal panel"
              aria-expanded={terminalOpen}
              onClick={() => setTerminalOpen(!terminalOpen)}
            >
              <TerminalSquare size={15} />
              Terminal
              {!!terminalState?.jobs.filter((j) => j.status === 'awaiting-approval').length && (
                <span className="terminal-badge">
                  {terminalState.jobs.filter((j) => j.status === 'awaiting-approval').length}
                </span>
              )}
            </button>
            {credentialPending > 0 && (
              <button
                className="computer-toggle selected"
                onClick={() => {
                  setView('settings');
                  setTimeout(
                    () =>
                      document
                        .getElementById('host-credentials')
                        ?.scrollIntoView({ block: 'center' }),
                    0,
                  );
                }}
                aria-label="Review secret operation approvals"
              >
                <ShieldCheck size={15} />
                {credentialPending} secret approval{credentialPending === 1 ? '' : 's'}
              </button>
            )}
            {pluginPending > 0 && (
              <button className="computer-toggle selected" onClick={() => setView('plugins')}>
                <ShieldCheck size={15} />
                {pluginPending} approval{pluginPending === 1 ? '' : 's'}
              </button>
            )}
            <button
              className={`connection-pill ${online ? '' : 'offline'}`}
              onClick={() => setTeamModelsOpen(true)}
              aria-label="Choose model for all bots"
            >
              <span className="green-dot" />
              {online
                ? `${online} ${data?.settings.localOnly ? 'local ' : ''}model${online === 1 ? '' : 's'} ready`
                : 'No enabled models ready'}
              <ChevronDown size={12} />
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner">
            <AlertCircle size={17} />
            {error}
            <button onClick={() => setServerDialog(true)}>Connect to server</button>
          </div>
        )}
        {!data ? (
          <div className="loading">
            <Avatar avatar={emptyAvatar} size={100} busy />
            {error ? <LoginCard refresh={refresh} /> : <p>Waking up your little team…</p>}
            <button className="secondary" onClick={() => setServerDialog(true)}>
              Connect to a server
            </button>
          </div>
        ) : (
          <>
            {view === 'team' && (
              <Team
                data={data}
                chat={chat}
                edit={setEditing}
                work={work}
                workClock={workClock}
                act={act}
              />
            )}
            {view === 'chat' && (
              <Chat
                data={data}
                botId={botId}
                setBotId={chat}
                conversationId={conversationId}
                teamSpaces={teamSpaces}
                teamSpaceId={teamSpaceId}
                selectTeamSpace={selectTeamSpace}
                newTeamSpace={newTeamSpace}
                setConversationId={(id) => {
                  navigation.current++;
                  setConversationId(id);
                }}
                refresh={refresh}
                notify={setToast}
                edit={setEditing}
                work={work}
                workClock={workClock}
                panelOpen={botPanelOpen}
                togglePanel={() => {
                  setBotPanelOpen(!botPanelOpen);
                  setComputerOpen(false);
                  setPreviewDoc(undefined);
                }}
              />
            )}
            {view === 'models' && (
              <Models data={data} act={act} openTeamModels={() => setTeamModelsOpen(true)} />
            )}
            {view === 'plugins' && <Plugins data={data} notify={setToast} />}
            {view === 'routines' && (
              <Routines
                data={data}
                act={act}
                onRun={(run) => {
                  chat(run.botId, run.conversationId);
                }}
              />
            )}
            {view === 'memory' && <Memories data={data} act={act} />}
            {view === 'skills' && <Skills data={data} act={act} />}
            {view === 'pages' && <Pages data={data} />}
            {view === 'activity' && <ActivityView data={data} chat={chat} />}
            {view === 'settings' && (
              <SettingsView
                data={data}
                act={act}
                connect={() => setServerDialog(true)}
                theme={theme}
                changeTheme={changeTheme}
                notify={setToast}
              />
            )}
          </>
        )}
      </div>
      <ComputerPanel
        open={computerOpen}
        close={() => setComputerOpen(false)}
        bots={data?.bots ?? []}
        blocked={menu || editing !== undefined || serverDialog || teamModelsOpen}
        onState={setComputer}
      />
      {previewDoc && (
        <PreviewPanel
          key={previewDoc.buildId ?? previewDoc.draftId ?? previewDoc.pageId ?? previewDoc.filename}
          doc={previewDoc}
          close={() => setPreviewDoc(undefined)}
        />
      )}
      <TerminalPanel
        open={terminalOpen}
        close={() => setTerminalOpen(false)}
        draft={terminalDraft}
        setDraft={setTerminalDraft}
        bots={data?.bots ?? []}
        onState={setTerminalState}
        attention={terminalAttention}
      />
      {editing !== undefined && (
        <BotEditor
          bot={editing}
          data={data!}
          close={() => setEditing(undefined)}
          save={async (bot) => {
            await api(editing ? `/bots/${editing.id}` : '/bots', editing ? 'PUT' : 'POST', bot);
            await refresh();
            setEditing(undefined);
            setToast('Your bot is ready');
          }}
        />
      )}
      {data && <CredentialManager data={data} refresh={refresh} notify={setToast} />}
      {data && <BotActions data={data} refresh={refresh} notify={setToast} />}
      {data && teamModelsOpen && (
        <TeamModels
          data={data}
          close={() => setTeamModelsOpen(false)}
          refresh={refresh}
          workshop={() => {
            setTeamModelsOpen(false);
            setView('models');
          }}
        />
      )}
      {serverDialog && <ServerDialog close={() => setServerDialog(false)} refresh={refresh} />}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
          <button aria-label="Dismiss" onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
