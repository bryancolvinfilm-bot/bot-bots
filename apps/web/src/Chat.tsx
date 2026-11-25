import {
  Activity,
  AlertCircle,
  ArrowUp,
  MessageCircle,
  History,
  Plus,
  SlidersHorizontal,
  Square,
  Clock3,
  Crown,
  KeyRound,
} from 'lucide-react';
import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  Bootstrap,
  Bot,
  TeamConversation,
  Message,
  Run,
  RunEvent,
  JobOptions,
  Conversation,
} from '../../../packages/shared/types';
import { Avatar } from './Avatar';
import { api, watchRun } from './api';
import { BotMessage, MentionComposer, type MentionComposerHandle } from './BotMentions';
import { plainMentionText } from '../../../packages/shared/mentions';
import { workLabel, type BotWork } from '../../../packages/shared/activity';
import { collaborationHandoffs, mergeRunState } from '../../../packages/shared/collaboration';
import { ChatCollaboration } from './ChatCollaboration';
import { WorkFeedback } from './WorkFeedback';
import { ArtifactCard } from './ArtifactCard';
import type { DraftSummary } from '../../../packages/shared/drafts';
import { DraftCard } from './DraftCard';
import { BotPanel } from './BotPanel';
import { ChatModelControls } from './BotModels';
import { MessageTokens, WorkingTokens } from './TokenCounter';
import { applyUsageUpdate } from '../../../packages/shared/token-usage';
import { contextDescription } from '../../../packages/shared/chat-models';
import { TaskJourney } from './TaskJourney';
import { LiveBuilds } from './LiveBuilds';
import { VoiceInput, type VoiceInputHandle } from './VoiceInput';
import { rankModels, classifyTask, canUseTools } from '../../../packages/shared/model-routing';
import { humanHandoffs } from '../../../packages/shared/delivery';
import {
  credentialService,
  apiKeyValue,
  wantsPrivateEntry,
  type CredentialSetup,
} from '../../../packages/shared/credential-setup';
import { openCredentials } from './CredentialManager';
import { PrivateCredentialCards } from './PrivateCredentialCards';
import './chat-comfort.css';

export function Chat({
  data,
  botId,
  setBotId,
  conversationId,
  setConversationId,
  teamSpaces,
  teamSpaceId,
  selectTeamSpace,
  newTeamSpace,
  refresh,
  notify,
  edit,
  work,
  workClock,
  panelOpen,
  togglePanel,
}: {
  data: Bootstrap;
  botId: string;
  setBotId: (id: string, conversationId?: string) => void;
  conversationId?: string;
  setConversationId: (id: string | undefined) => void;
  teamSpaces: TeamConversation[];
  teamSpaceId?: string;
  selectTeamSpace: (id: string) => void;
  newTeamSpace: () => void;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  edit: (b: Bot) => void;
  work: Map<string, BotWork>;
  workClock: number;
  panelOpen: boolean;
  togglePanel: () => void;
}) {
  const bot = data.bots.find((b) => b.id === botId) ?? data.bots[0];
  const [messages, setMessages] = useState<Message[]>([]);
  const [outbox, setOutbox] = useState<Message[]>([]);
  const followTail = useRef(true);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [historyRuns, setHistoryRuns] = useState<Run[]>([]);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [channel, setChannel] = useState<Conversation>();
  const context = `${bot.id}:${conversationId ?? ''}`;
  const currentContext = useRef(context);
  const loadSequence = useRef(0);
  currentContext.current = context;
  const [prompt, setPrompt] = useState('');
  const composerDrafts = useRef(new Map<string, string>());
  const promptSnapshot = useRef(prompt);
  promptSnapshot.current = prompt;
  const draftKey = `${bot.id}:${teamSpaceId ?? ''}`;
  useEffect(() => {
    setPrompt(composerDrafts.current.get(draftKey) ?? '');
    return () => {
      composerDrafts.current.set(draftKey, promptSnapshot.current);
    };
  }, [draftKey]);
  const [jobOptions, setJobOptions] = useState<JobOptions>({
    urgency: 'relaxed',
    importance: 'normal',
  });
  const composer = useRef<MentionComposerHandle>(null);
  const voice = useRef<VoiceInputHandle>(null);
  const [run, setRun] = useState<Run>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const messagePane = useRef<HTMLDivElement>(null);
  const [progressDocked, setProgressDocked] = useState(false);
  const stream = useRef<AbortController | null>(null);
  const [sending, setSending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const load = useCallback(async () => {
    const key = `${bot.id}:${conversationId ?? ''}`;
    if (currentContext.current !== key) return;
    const sequence = ++loadSequence.current;
    const [chatMessages, runs, savedDrafts, preferences] = await Promise.all([
      conversationId
        ? api<Message[]>(`/conversations/${conversationId}/messages`)
        : Promise.resolve([]),
      conversationId ? api<Run[]>(`/conversations/${conversationId}/runs`) : Promise.resolve([]),
      conversationId
        ? api<DraftSummary[]>(`/conversations/${conversationId}/drafts`)
        : Promise.resolve([]),
      conversationId
        ? api<Conversation>(`/conversations/${conversationId}`)
        : Promise.resolve(undefined),
    ]);
    if (currentContext.current !== key || sequence !== loadSequence.current) return;
    setChannel(preferences);
    setMessages((old) =>
      [
        ...new Map(
          [
            ...old.filter((message) => message.conversationId === conversationId),
            ...chatMessages,
          ].map((message) => [message.id, message]),
        ).values(),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
    setOutbox((old) =>
      old.filter((message) => !chatMessages.some((saved) => saved.id === message.id)),
    );
    setHistoryRuns(runs);
    setDrafts(savedDrafts);
  }, [bot.id, conversationId]);
  useEffect(() => {
    followTail.current = true;
    setFollowingLatest(true);
    setRun(undefined);
    setEvents([]);
    setMessages([]);
    setHistoryRuns([]);
    setDrafts([]);
    setChannel(undefined);
    setHistoryOpen(false);
    void load().catch((e) => notify(e.message));
    return () => stream.current?.abort();
  }, [load]);
  useEffect(() => {
    void load().catch((e) => notify(e.message));
  }, [data.modelSelectionRevision]);
  useEffect(() => {
    if (followTail.current) bottom.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages, events, outbox]);
  useEffect(() => {
    if (!conversationId) return;
    const active = data.runs.find((r) => r.conversationId === conversationId);
    if (active) {
      setRun(active);
      setEvents(active.events);
      if (active.status === 'running') subscribe(active);
      else void load();
    }
  }, [
    conversationId,
    data.runs.find((r) => r.conversationId === conversationId)?.id,
    data.runs.find((r) => r.conversationId === conversationId)?.status,
  ]);
  function subscribe(r: Run) {
    stream.current?.abort();
    const controller = new AbortController();
    stream.current = controller;
    void watchRun(
      r.id,
      (event) => {
        if (currentContext.current !== `${r.botId}:${r.conversationId}`) return;
        if (event.type === 'snapshot') {
          setRun(event.run);
          setEvents(event.run.events);
        }
        if (event.type === 'event') setEvents((old) => [...old, event.event]);
        if (event.type === 'usage') setRun((old) => applyUsageUpdate(old, event));
        if (event.type === 'update') {
          setRun((old) => mergeRunState(old, event.run));
          setEvents(event.run.events);
          void load();
        }
        if (event.type === 'done') {
          setRun(event.run);
          void load();
          void refresh();
        }
      },
      controller.signal,
    ).catch((e) => {
      if (!controller.signal.aborted) {
        notify(e.message);
        void refresh();
        void load();
      }
    });
  }
  async function send(text = prompt) {
    if (bot.isPrototype) {
      notify(
        'Ask another bot to delegate to this prototype so it can return its clones’ combined answers.',
      );
      return;
    }
    if (bot.prototypeId) {
      notify(
        'Temporary workers have one assigned task. Open the team task to steer it, or send new work to the prototype.',
      );
      return;
    }
    if (data.accessRole === 'viewer') {
      notify('This device has viewer access. Pair as an operator to send tasks.');
      return;
    }
    if (!text.trim() || sending || !conversationId) return;
    voice.current?.cancel();
    if (
      wantsPrivateEntry(text) ||
      (credentialService(
        messages
          .slice(-12)
          .map((message) => message.content)
          .join('\n'),
      ).service &&
        apiKeyValue(text, true))
    ) {
      if (data.accessRole && data.accessRole !== 'owner') {
        notify('Only the owner can enter keys in the private credential window.');
        return;
      }
      setSending(true);
      setPrompt('');
      try {
        const result = await api<{ credentialRequest: CredentialSetup; message?: string }>(
          '/credentials/manager/conversation',
          'POST',
          {
            botId: bot.id,
            conversationId,
            ...(run?.status === 'running' ? { runId: run.id } : {}),
            text,
          },
        );
        const request = result.credentialRequest;
        if (currentContext.current !== `${bot.id}:${conversationId ?? ''}`) {
          await refresh();
          return;
        }
        setConversationId(request.conversationId);
        if (request.status === 'awaiting-entry') openCredentials({ request });
        if (result.message) notify(result.message);
        await load();
        await refresh();
      } catch (error) {
        notify((error as Error).message);
      } finally {
        setSending(false);
      }
      return;
    }
    const key = currentContext.current,
      previousId = run?.id;
    const clientMessageId = crypto.randomUUID();
    followTail.current = true;
    setFollowingLatest(true);
    setOutbox((old) => [
      ...old,
      {
        id: clientMessageId,
        botId: bot.id,
        conversationId: conversationId ?? '',
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      },
    ]);
    setSending(true);
    setPrompt('');
    try {
      const response = await api<Run | { credentialRequest: CredentialSetup; message?: string }>(
        '/runs',
        'POST',
        {
          botId: bot.id,
          prompt: text,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          clientMessageId,
          conversationId,
          ...(run?.status === 'running' ? {} : jobOptions),
        },
      );
      if ('credentialRequest' in response) {
        setOutbox((old) => old.filter((message) => message.id !== clientMessageId));
        if (currentContext.current !== key) {
          await refresh();
          return;
        }
        setConversationId(response.credentialRequest.conversationId);
        if (response.credentialRequest.status === 'awaiting-entry')
          openCredentials({ request: response.credentialRequest });
        if (response.message) notify(response.message);
        await load();
        await refresh();
        return;
      }
      const r = response;
      if (bot.isPrototype) {
        await refresh();
        window.dispatchEvent(new CustomEvent('bot-bots:open-run', { detail: r }));
        return;
      }
      setOutbox((old) =>
        old.map((message) =>
          message.id === clientMessageId
            ? { ...message, conversationId: r.conversationId, runId: r.id }
            : message,
        ),
      );
      if (currentContext.current !== key) {
        await refresh();
        return;
      }
      setJobOptions({ urgency: 'relaxed', importance: 'normal' });
      setConversationId(r.conversationId);
      setRun((old) => mergeRunState(old, r));
      setEvents((old) => (previousId === r.id && old.length > r.events.length ? old : r.events));
      if (conversationId) {
        await load();
        subscribe(r);
      }
      await refresh();
    } catch (e) {
      setOutbox((old) => old.filter((message) => message.id !== clientMessageId));
      if (currentContext.current === key) setPrompt((old) => old || plainMentionText(text));
      notify((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  const busy = sending || run?.status === 'running';
  const transcript = useMemo(
    () =>
      [
        ...messages,
        ...outbox.filter(
          (message) =>
            message.botId === bot.id &&
            (!message.conversationId || message.conversationId === conversationId) &&
            !messages.some((saved) => saved.id === message.id),
        ),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [messages, outbox, bot.id, conversationId],
  );
  const runById = useMemo(() => {
    const known = new Map(historyRuns.map((item) => [item.id, item]));
    for (const item of data.runs)
      if (item.conversationId === conversationId || known.has(item.id))
        known.set(item.id, mergeRunState(known.get(item.id), item));
    if (run && run.conversationId === conversationId) {
      const live = { ...run, events: events.length >= run.events.length ? events : run.events };
      known.set(run.id, mergeRunState(known.get(run.id), live));
    }
    return known;
  }, [historyRuns, data.runs, conversationId, run, events]);
  const collaborating = run ? collaborationHandoffs(runById.get(run.id) ?? run).length > 0 : false;
  const activeRun = run?.status === 'running' ? (runById.get(run.id) ?? run) : undefined;
  const progressLayout = new Set(activeRun?.work?.map((item) => item.botId)).size > 3;
  useEffect(() => {
    const pane = messagePane.current;
    if (!pane || !busy) {
      setProgressDocked(false);
      return;
    }
    const id = activeRun && CSS.escape(activeRun.id);
    const anchor =
      (id &&
        (pane.querySelector(`.task-journey[data-run-id="${id}"]`) ??
          pane.querySelector(`.collaboration[data-run-id="${id}"] .worker-cluster`) ??
          pane.querySelector(`.collaboration[data-run-id="${id}"] .collaboration-heading`))) ||
      pane.querySelector('.thinking');
    if (!anchor) {
      setProgressDocked(false);
      return;
    }
    // The dock overlays the scroller, so appearing cannot move this anchor and
    // create an intersection/layout feedback loop.
    const observer = new IntersectionObserver(
      ([entry]) => {
        setProgressDocked(
          !entry.isIntersecting || entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0),
        );
      },
      { root: pane, threshold: [0, 1] },
    );
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [
    busy,
    activeRun?.id,
    activeRun?.work?.length,
    transcript.length,
    progressLayout,
    collaborating,
  ]);
  // Draft hints are deliberately bounded and deferred. The complete original
  // draft is always used by Send and by server-side routing.
  const previewPrompt = useDeferredValue(prompt.slice(0, 16000));
  const nextModel = rankModels(
    data.models,
    data.providers,
    data.settings,
    data.assessments,
    jobOptions.task ?? classifyTask(previewPrompt),
    channel?.modelId !== undefined ? channel.modelId : (bot.chatModelId ?? bot.modelId),
    { botId: bot.prototypeId ?? bot.id, providerId: bot.providerId, urgency: jobOptions.urgency },
  ).find((m) => m.status !== 'offline');
  const usedModel =
    run?.status === 'running' ? data.models.find((m) => m.id === run.modelId) : undefined;
  const shownModel = usedModel ?? nextModel;
  const plannedHandoffs = useMemo(
    () =>
      previewPrompt.includes('@') || previewPrompt.includes('#bot/')
        ? humanHandoffs(previewPrompt, data.bots)
        : [],
    [previewPrompt, data.bots],
  );
  function reviewed(updated: Run) {
    setHistoryRuns((old) => [...old.filter((r) => r.id !== updated.id), updated]);
    setRun((old) => (old?.id === updated.id ? updated : old));
    void refresh();
  }
  return (
    <div className="chat-layout">
      <aside className={`chat-history ${historyOpen ? 'mobile-history-open' : ''}`}>
        <div className="chat-history-head">
          <h3>Team conversations</h3>
          <button
            className="icon-button"
            aria-label="New conversation"
            onClick={() => {
              newTeamSpace();
              setHistoryOpen(false);
            }}
          >
            <Plus size={18} />
          </button>
        </div>
        <select aria-label="Choose bot" value={bot.id} onChange={(e) => setBotId(e.target.value)}>
          {data.bots
            .filter(
              (b) =>
                !b.archivedAt && !b.deletedAt && (b.cloneStatus !== 'retired' || b.id === bot.id),
            )
            .map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
        </select>
        <div className="conversation-list">
          {teamSpaces.map((c) => (
            <button
              className={teamSpaceId === c.id ? 'active' : ''}
              key={c.id}
              onClick={() => {
                selectTeamSpace(c.id);
                setHistoryOpen(false);
              }}
            >
              <MessageCircle size={14} />
              <span>{plainMentionText(c.title)}</span>
            </button>
          ))}
        </div>
        <small>One space for the whole team. Switching conversations switches every bot.</small>
      </aside>
      <section className="chat-main">
        <div className="chat-top">
          <button
            className="icon-button mobile-history-toggle"
            type="button"
            aria-label="Conversation history"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            <History size={18} />
          </button>
          <Avatar avatar={bot.avatar} size={48} />
          <div>
            <h3>
              {bot.name}
              {data.settings.mainBotId === bot.id && (
                <span className="main-bot-badge" title="Extra delegation guidance in direct chats">
                  <Crown size={12} /> Main bot
                </span>
              )}
            </h3>
            <small>
              {work.has(bot.id) ? workLabel(work.get(bot.id)!, bot.id, workClock, bot) : bot.title}
            </small>
          </div>
          <button
            className="secondary small"
            disabled={!!bot.prototypeId || (!!data.accessRole && data.accessRole !== 'owner')}
            onClick={() => edit(bot)}
          >
            <SlidersHorizontal size={14} />
            Customize
          </button>
          <button
            className={`secondary small ${panelOpen ? 'selected' : ''}`}
            onClick={togglePanel}
            aria-label="Toggle bot panel"
            aria-expanded={panelOpen}
          >
            <Clock3 size={14} />
            Bot panel
          </button>
        </div>
        <div className="chat-scroll-region">
          <div
            ref={messagePane}
            className="messages"
            onScroll={(event) => {
              const pane = event.currentTarget;
              const near = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100;
              followTail.current = near;
              setFollowingLatest(near);
            }}
          >
            {bot.prototypeId && (
              <div className="notice">
                <div>
                  <strong>
                    {bot.cloneStatus === 'retired'
                      ? 'This little worker has wrapped up.'
                      : 'This worker has an assigned job.'}
                  </strong>
                  <p>Its result and learning stay in History. New jobs start from the prototype.</p>
                  <div className="button-row">
                    <button className="secondary small" onClick={() => setBotId(bot.prototypeId!)}>
                      Open prototype
                    </button>
                    {data.runs.find((r) => r.work?.some((w) => w.botId === bot.id)) && (
                      <button
                        className="secondary small"
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent('bot-bots:open-run', {
                              detail: data.runs.find((r) =>
                                r.work?.some((w) => w.botId === bot.id),
                              ),
                            }),
                          )
                        }
                      >
                        Open team task
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
            {teamSpaces.find((c) => c.id === teamSpaceId)?.legacy && (
              <p className="context-refresh-note" role="note">
                Your earlier bot chats are preserved here. New team conversations keep each bot's
                history together in one shared space.
              </p>
            )}
            {!transcript.length && !busy ? (
              <div className="chat-empty">
                <Avatar avatar={bot.avatar} size={128} />
                <div className="eyebrow">A familiar face. A fresh start.</div>
                <h2>{bot.isPrototype ? 'A whole team starts here.' : 'What’s on your mind?'}</h2>
                <p>
                  {bot.isPrototype
                    ? 'Ask another bot to delegate to this prototype. Its temporary workers return here, and the prototype combines their answers for the requesting bot.'
                    : bot.name === 'Boss Man'
                      ? 'Tell me what you’re working on. I’ll bring in a teammate when it helps.'
                      : `You’re chatting with ${bot.name}. Let’s make something happen.`}
                </p>
                {!bot.isPrototype && (
                  <div className="suggestion-grid">
                    {[
                      'What can our team do locally?',
                      'Remember that I prefer concise updates.',
                      'Ask Comparison to compare two ways to organize a project.',
                      'Make a simple HTML page about our bot team.',
                    ].map((s) => (
                      <button key={s} onClick={() => void send(s)}>
                        {s}
                        <ArrowUp size={14} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              transcript.map((m) => (
                <Fragment key={m.id}>
                  <div className={`message ${m.senderBotId ? 'assistant' : m.role}`} key={m.id}>
                    {(m.role === 'assistant' || m.senderBotId) && (
                      <Avatar
                        avatar={data.bots.find((b) => b.id === m.senderBotId)?.avatar ?? bot.avatar}
                        size={42}
                      />
                    )}
                    <div>
                      <div className="message-byline">
                        {m.senderBotId
                          ? (data.bots.find((b) => b.id === m.senderBotId)?.name ?? m.senderBotId)
                          : m.role === 'user'
                            ? 'You'
                            : m.role === 'system'
                              ? 'Team update'
                              : bot.name}
                        <small>
                          {new Date(m.createdAt).toLocaleTimeString([], {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </small>
                        <MessageTokens
                          message={m}
                          run={m.runId ? runById.get(m.runId) : undefined}
                        />
                      </div>
                      {m.senderBotId && m.deliveryId && (
                        <small className="delivery-ack">
                          Received handoff · Receipt {m.deliveryId}
                        </small>
                      )}
                      <div className="message-content">
                        <BotMessage
                          content={m.role === 'user' ? (m.displayContent ?? m.content) : m.content}
                          bots={data.bots}
                          openBot={setBotId}
                        />
                      </div>
                      {m.steeringId &&
                        (() => {
                          const job = m.runId ? runById.get(m.runId) : undefined;
                          const update = job?.steering?.find((s) => s.id === m.steeringId);
                          const names = [
                            ...new Set(
                              job?.work
                                ?.filter((w) => update?.appliedWorkIds.includes(w.id))
                                .map(
                                  (w) => data.bots.find((b) => b.id === w.botId)?.name ?? w.botId,
                                ),
                            ),
                          ];
                          return (
                            <small
                              className={`steering-status ${names.length ? 'applied' : 'queued'}`}
                              data-steering-id={m.steeringId}
                            >
                              {names.length
                                ? `Picked up by ${names.join(', ')}`
                                : job?.status === 'running'
                                  ? 'Queued · waiting for the next safe step'
                                  : 'Saved in the conversation · not picked up before this run ended'}
                            </small>
                          );
                        })()}
                      {m.role === 'assistant' &&
                        m.runId &&
                        data.pages
                          .filter(
                            (p) =>
                              p.runId === m.runId &&
                              (p.botId === bot.id || runById.get(m.runId!)?.botId === bot.id),
                          )
                          .map((p) => <ArtifactCard key={p.id} page={p} />)}
                      {m.role === 'assistant' &&
                        m.runId &&
                        runById.has(m.runId) &&
                        (m.workId || runById.get(m.runId)!.botId === bot.id) && (
                          <WorkFeedback
                            run={runById.get(m.runId)!}
                            work={runById
                              .get(m.runId)!
                              .work?.find((w) =>
                                m.workId ? w.id === m.workId : w.botId === bot.id && !w.handoffId,
                              )}
                            bot={bot}
                            models={data.models}
                            onSaved={reviewed}
                          />
                        )}
                    </div>
                  </div>
                  {m.role === 'user' &&
                    !m.steeringId &&
                    m.runId &&
                    runById.has(m.runId) &&
                    runById.get(m.runId)!.botId === bot.id &&
                    new Set(runById.get(m.runId)!.work?.map((work) => work.botId)).size <= 3 && (
                      <TaskJourney
                        run={runById.get(m.runId)!}
                        bots={data.bots}
                        now={workClock}
                        openBot={setBotId}
                      />
                    )}
                  {m.role === 'user' &&
                    !m.steeringId &&
                    m.runId &&
                    runById.has(m.runId) &&
                    runById.get(m.runId)!.botId === bot.id && (
                      <ChatCollaboration
                        run={runById.get(m.runId)!}
                        bots={data.bots}
                        now={workClock}
                        openBot={setBotId}
                        models={data.models}
                        onReviewed={reviewed}
                      />
                    )}
                  {m.role === 'user' &&
                    !m.steeringId &&
                    m.runId &&
                    ['failed', 'cancelled'].includes(runById.get(m.runId)?.status ?? '') &&
                    !transcript.some(
                      (message) => message.runId === m.runId && message.role === 'assistant',
                    ) &&
                    data.pages
                      .filter(
                        (page) =>
                          page.runId === m.runId &&
                          (page.botId === bot.id || runById.get(m.runId!)?.botId === bot.id),
                      )
                      .map((page) => <ArtifactCard key={page.id} page={page} />)}
                  {m.role === 'user' &&
                    !m.steeringId &&
                    m.runId &&
                    drafts
                      .filter((d) => d.activeRunId === m.runId)
                      .map((d) => (
                        <DraftCard
                          key={d.id}
                          draft={d}
                          bot={data.bots.find((b) => b.id === d.botId)}
                          onContinued={refresh}
                        />
                      ))}
                </Fragment>
              ))
            )}
            <PrivateCredentialCards
              botId={bot.id}
              conversationId={conversationId}
              owner={!data.accessRole || data.accessRole === 'owner'}
            />
            {[...runById.values()]
              .filter((r) => r.status === 'running')
              .flatMap(
                (r) =>
                  r.work
                    ?.filter(
                      (w) =>
                        w.botId === bot.id &&
                        w.status === 'running' &&
                        (!w.handoffId
                          ? r.conversationId === conversationId
                          : r.events.some(
                              (e) =>
                                e.handoff?.id === w.handoffId &&
                                e.handoff?.conversationId === conversationId,
                            )),
                    )
                    .map((w) => (
                      <WorkingTokens
                        key={w.id}
                        work={w}
                        name={bot.name}
                        model={data.models.find((model) => model.id === w.modelId)?.name}
                      />
                    )) ?? [],
              )}
            <LiveBuilds runId={run?.id ?? historyRuns.at(-1)?.id} />
            {events.length > 0 && (
              <details className="run-trace">
                <summary>
                  <Activity size={14} />
                  {collaborating
                    ? 'Full activity log'
                    : busy
                      ? 'Your team is working…'
                      : run?.status === 'failed'
                        ? 'Something needs a little help'
                        : 'Behind this reply'}
                  <span>{events.length} steps</span>
                </summary>
                <div>
                  {events.map((e, i) => (
                    <div className={`trace-event ${e.kind}`} key={i}>
                      <span />
                      {e.text}
                    </div>
                  ))}
                </div>
              </details>
            )}
            {run?.status === 'failed' && (
              <div className="inline-error">
                <AlertCircle size={16} />
                {run.error}
              </div>
            )}
            {busy && !collaborating && (
              <div className="thinking">
                <Avatar avatar={bot.avatar} busy size={42} />
                <span>
                  {work.has(bot.id)
                    ? workLabel(work.get(bot.id)!, bot.id, workClock, bot)
                    : 'Rolling up the sleeves'}
                  <span className="dots">…</span>
                </span>
              </div>
            )}
            <div ref={bottom} />
          </div>
          {busy && progressDocked && (
            <aside className="chat-progress-dock" aria-label="Live bot progress">
              {activeRun?.work?.length ? (
                <TaskJourney
                  run={activeRun}
                  bots={data.bots}
                  now={workClock}
                  openBot={setBotId}
                  compact
                />
              ) : (
                <div className="thinking">
                  <Avatar avatar={bot.avatar} busy size={34} />
                  <span>
                    {work.has(bot.id)
                      ? workLabel(work.get(bot.id)!, bot.id, workClock, bot)
                      : 'Rolling up the sleeves'}
                  </span>
                </div>
              )}
            </aside>
          )}
        </div>
        {!followingLatest && (
          <button
            type="button"
            className="secondary small jump-to-latest"
            onClick={() => {
              followTail.current = true;
              setFollowingLatest(true);
              bottom.current?.scrollIntoView({ behavior: 'auto' });
            }}
          >
            Jump to latest
          </button>
        )}
        {bot.isPrototype ? (
          <div className="composer-wrap prototype-notice" role="note">
            <ChatModelControls
              key={conversationId ?? bot.id}
              bot={bot}
              data={data}
              model={nextModel}
              conversation={channel}
              changed={(value) => {
                if (currentContext.current === `${value.botId}:${value.id}`) {
                  loadSequence.current++;
                  setChannel(value);
                }
              }}
              refresh={refresh}
            />
            <strong>This is a worker prototype</strong>
            <p>
              Ask another bot to delegate to this prototype bot so it can hand back the clones’
              answers. The prototype combines their best findings into one response. Temporary
              clones close when done; their results stay in task history.
            </p>
            {data.settings.mainBotId && (
              <button className="primary" onClick={() => setBotId(data.settings.mainBotId!)}>
                Ask your main bot
              </button>
            )}
          </div>
        ) : (
          <form
            className="composer-wrap"
            onSubmit={(e) => {
              e.preventDefault();
              void send(composer.current?.getMarkdown() ?? prompt);
            }}
          >
            <div className="composer">
              <ChatModelControls
                key={conversationId ?? bot.id}
                bot={bot}
                data={data}
                model={nextModel}
                conversation={channel}
                changed={(value) => {
                  if (currentContext.current === `${value.botId}:${value.id}`) {
                    loadSequence.current++;
                    setChannel(value);
                  }
                }}
                refresh={refresh}
                context={
                  run?.modelId === nextModel?.id
                    ? run?.work?.find((w) => w.botId === bot.id)?.context
                    : undefined
                }
              />
              {!!plannedHandoffs.length && (
                <small className="delivery-plan">
                  Sends a handoff to{' '}
                  {plannedHandoffs
                    .map(
                      (r) =>
                        data.bots.find((b) => b.id === r.botId)?.name ?? `unknown bot @${r.botId}`,
                    )
                    .join(', ')}
                  . Delivery will appear in their inbox.
                </small>
              )}
              <MentionComposer
                ref={composer}
                bots={data.bots.filter(
                  (b) => b.cloneStatus !== 'retired' && !b.archivedAt && !b.deletedAt,
                )}
                label={`Message ${bot.name}`}
                value={prompt}
                onChange={setPrompt}
                onSend={(text) => void send(text)}
                busy={sending}
              />
              <VoiceInput
                key={context}
                ref={voice}
                disabled={
                  sending || !conversationId || data.accessRole === 'viewer' || !!bot.prototypeId
                }
                target={() => composer.current?.dictation()}
              />
              <div className="composer-bottom">
                <span
                  className="composer-model"
                  title={
                    shownModel
                      ? `${usedModel ? 'Current reply' : 'Next reply'} · ${contextDescription(
                          shownModel,
                          data.providers.find((p) => p.id === shownModel.providerId),
                        )}`
                      : 'Load or enable a chat model in Model workshop.'
                  }
                >
                  {shownModel && <span className="green-dot" />}
                  {shownModel
                    ? `${usedModel ? 'Using' : 'Replying with'} ${shownModel.name}${!canUseTools(shownModel) ? ' · chat only' : ''}`
                    : 'No loaded model available'}
                </span>
                <div className="composer-actions">
                  {(!data.accessRole || data.accessRole === 'owner') && (
                    <button
                      className="icon-button private-key-shortcut"
                      type="button"
                      aria-label="Add a key privately"
                      title="Give this bot a key privately"
                      onClick={() => void send('Let me give you an API key.')}
                    >
                      <KeyRound size={18} />
                    </button>
                  )}
                  {run?.status === 'running' && data.accessRole !== 'viewer' && (
                    <button
                      className="send-button stop"
                      type="button"
                      aria-label="Stop bot"
                      onClick={() => run && void api(`/runs/${run.id}/cancel`, 'POST')}
                    >
                      <Square size={15} />
                    </button>
                  )}
                  <button
                    className="send-button"
                    aria-label="Send message"
                    title={
                      run?.status === 'running'
                        ? 'Add direction to the current task'
                        : 'Send message'
                    }
                    disabled={
                      !conversationId ||
                      sending ||
                      !prompt.trim() ||
                      data.accessRole === 'viewer' ||
                      !!bot.prototypeId
                    }
                  >
                    <ArrowUp size={18} />
                  </button>
                </div>
              </div>
            </div>
            <details className="conversation-options">
              <summary>
                Conversation options
                {(jobOptions.urgency !== 'relaxed' ||
                  jobOptions.importance !== 'normal' ||
                  jobOptions.task) &&
                  ' · Customized'}
              </summary>
              <div className="job-preferences" aria-label="Job preferences">
                <label>
                  Urgency
                  <select
                    aria-label="Job urgency"
                    disabled={!!busy}
                    value={jobOptions.urgency}
                    onChange={(e) =>
                      setJobOptions({
                        ...jobOptions,
                        urgency: e.target.value as JobOptions['urgency'],
                      })
                    }
                  >
                    <option value="relaxed">Relaxed · take your time</option>
                    <option value="soon">Soon · prefer faster</option>
                    <option value="urgent">Urgent · speed matters</option>
                  </select>
                </label>
                <label>
                  Importance
                  <select
                    aria-label="Job importance"
                    disabled={!!busy}
                    value={jobOptions.importance}
                    onChange={(e) =>
                      setJobOptions({
                        ...jobOptions,
                        importance: e.target.value as JobOptions['importance'],
                      })
                    }
                  >
                    <option value="normal">Normal</option>
                    <option value="high">High · extra care</option>
                  </select>
                </label>
                <label>
                  Task
                  <select
                    aria-label="Job task category"
                    disabled={!!busy}
                    value={jobOptions.task ?? ''}
                    onChange={(e) =>
                      setJobOptions({
                        ...jobOptions,
                        task: (e.target.value || undefined) as JobOptions['task'],
                      })
                    }
                  >
                    <option value="">Auto-detect</option>
                    {['general', 'research', 'coding', 'writing', 'planning'].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
              </div>
            </details>
            <small>
              {run?.status === 'running'
                ? 'Keep chatting. Your team will pick up your new direction as they go.'
                : 'Take your time. Your team is here to help.'}
            </small>
          </form>
        )}
      </section>
      {panelOpen && (
        <BotPanel
          key={bot.id}
          bot={bot}
          data={data}
          close={togglePanel}
          refresh={refresh}
          notify={notify}
          openBot={setBotId}
          onRun={(r) => window.dispatchEvent(new CustomEvent('bot-bots:open-run', { detail: r }))}
        />
      )}
    </div>
  );
}
