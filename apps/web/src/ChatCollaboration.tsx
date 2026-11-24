import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  LoaderCircle,
  Users,
  AlertCircle,
  LayoutGrid,
  List,
  X,
} from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import { activeBotWork, workLabel } from '../../../packages/shared/activity';
import { collaborationHandoffs } from '../../../packages/shared/collaboration';
import { plainMentionText } from '../../../packages/shared/mentions';
import type { Bot, Model, Run } from '../../../packages/shared/types';
import { Avatar, emptyAvatar } from './Avatar';
import { BotMessage } from './BotMentions';
import './collaboration.css';
import { WorkFeedback } from './WorkFeedback';

export function ChatCollaboration({
  run,
  bots,
  now,
  openBot,
  models,
  onReviewed,
}: {
  run: Run;
  bots: Bot[];
  now: number;
  openBot: (id: string, conversationId?: string) => void;
  models: Model[];
  onReviewed: (run: Run) => void;
}) {
  const handoffs = useMemo(() => collaborationHandoffs(run), [run]);
  const active = useMemo(() => activeBotWork([run]), [run]);
  const [layout, setLayout] = useState<'auto' | 'grid' | 'details'>('auto');
  const [selected, setSelected] = useState<string>();
  if (!handoffs.length) return null;
  const ids = [
    ...new Set([run.botId, ...handoffs.flatMap((handoff) => [handoff.fromBotId, handoff.toBotId])]),
  ];
  const identity = (id: string) =>
    bots.find((bot) => bot.id === id) ?? { id, name: 'Teammate', avatar: emptyAvatar };
  const busy = run.status === 'running';
  const grid = layout === 'grid' || (layout === 'auto' && ids.length > 3);
  const shown = grid ? handoffs.filter((handoff) => handoff.toBotId === selected) : handoffs;
  return (
    <section className="collaboration" aria-label="Bot collaboration" data-run-id={run.id}>
      <header className="collaboration-heading">
        {!grid && (
          <div className="collaboration-participants">
            {ids.map((id) => {
              const bot = identity(id);
              return (
                <button
                  type="button"
                  key={id}
                  className={active.has(id) ? 'participant active' : 'participant'}
                  data-participant-id={id}
                  aria-label={`Open ${bot.name}`}
                  title={bot.name}
                  onClick={() => openBot(id)}
                >
                  <Avatar avatar={bot.avatar} size={34} busy={active.has(id)} />
                </button>
              );
            })}
          </div>
        )}
        <div>
          <strong>
            <Users size={13} />
            {busy
              ? 'Your team is on it'
              : run.status === 'completed'
                ? 'A little teamwork'
                : 'Teamwork paused'}
          </strong>
          <small>
            {ids.length} bots · {handoffs.length} {handoffs.length === 1 ? 'handoff' : 'handoffs'}
          </small>
        </div>
        {busy && (
          <LoaderCircle
            size={15}
            className="collaboration-spinner"
            aria-label="Team working"
            role="img"
          />
        )}
        {ids.length > 3 && (
          <div className="collaboration-view-controls" role="group" aria-label="Team display">
            <button
              className={grid ? 'selected' : ''}
              aria-label="Compact worker grid"
              aria-pressed={grid}
              onClick={() => setLayout('grid')}
            >
              <LayoutGrid size={15} />
              Grid
            </button>
            <button
              className={!grid ? 'selected' : ''}
              aria-label="Detailed handoff list"
              aria-pressed={!grid}
              onClick={() => setLayout('details')}
            >
              <List size={15} />
              Details
            </button>
          </div>
        )}
      </header>
      {grid && (
        <>
          <p className="worker-grid-hint">
            Click a bot to see its individual reply. The work log stays tucked away.
          </p>
          <div className="worker-cluster" aria-label="Working bot grid">
            {ids.map((id) => {
              const bot = identity(id),
                work = active.get(id),
                latest = handoffs.findLast((handoff) => handoff.toBotId === id);
              const status = work
                ? workLabel(
                    work,
                    id,
                    now,
                    bots.find((bot) => bot.id === id),
                  )
                : latest?.status === 'completed'
                  ? 'Finished'
                  : latest?.status === 'failed'
                    ? 'Needs help'
                    : latest?.status === 'cancelled'
                      ? 'Stopped'
                      : run.status === 'completed'
                        ? 'Finished'
                        : 'Coordinating';
              return (
                <button
                  key={id}
                  className={`worker-tile ${work ? 'working' : ''} ${selected === id ? 'selected' : ''}`}
                  aria-label={`Show ${bot.name}'s reply`}
                  aria-pressed={selected === id}
                  data-worker-bot={id}
                  onClick={() => setSelected(selected === id ? undefined : id)}
                >
                  <span className="worker-tile-avatar">
                    <Avatar avatar={bot.avatar} size={48} busy={!!work} />
                    {work && <LoaderCircle size={14} className="collaboration-spinner" />}
                  </span>
                  <strong>{bot.name}</strong>
                  <small>{status}</small>
                </button>
              );
            })}
          </div>
          {selected && (
            <div className="worker-selection-heading">
              <strong>{identity(selected).name}’s space in this task</strong>
              <button
                className="icon-button"
                aria-label="Close individual worker reply"
                onClick={() => setSelected(undefined)}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {selected === run.botId && !shown.length && (
            <p className="subtle">
              This bot coordinates the team. Its combined response appears below in the
              conversation.
            </p>
          )}
        </>
      )}
      <div className="collaboration-handoffs">
        {shown.map((handoff) => {
          const from = identity(handoff.fromBotId),
            to = identity(handoff.toBotId);
          let depth = 0,
            parentId = handoff.parentId;
          const visited = new Set([handoff.id]);
          while (parentId && depth < 3 && !visited.has(parentId)) {
            visited.add(parentId);
            depth++;
            parentId = handoffs.find((node) => node.id === parentId)?.parentId;
          }
          const working = handoff.status === 'working';
          const status = working
            ? active.has(to.id)
              ? workLabel(
                  active.get(to.id)!,
                  to.id,
                  now,
                  bots.find((b) => b.id === to.id),
                )
              : 'Rolling up the sleeves'
            : handoff.status === 'completed'
              ? 'Reported back'
              : handoff.status === 'cancelled'
                ? 'Stopped for now'
                : 'Needs a little help';
          const answer = handoff.answer ?? '';
          return (
            <article
              key={handoff.id}
              className={`collaboration-card ${handoff.status}`}
              data-handoff-id={handoff.id}
              data-to-bot-id={to.id}
              data-status={handoff.status}
              aria-label={`Handoff to ${to.name}`}
              aria-busy={working}
              style={
                {
                  '--handoff-color': to.avatar.color,
                  marginLeft: grid ? 0 : depth * 12,
                } as CSSProperties
              }
            >
              <div className="collaboration-route">
                <button
                  type="button"
                  className="collaboration-identity"
                  aria-label={`Open ${from.name}`}
                  onClick={() => openBot(from.id)}
                >
                  <Avatar avatar={from.avatar} size={27} />
                  <span>{from.name}</span>
                </button>
                <ArrowRight size={13} />
                <button
                  type="button"
                  className="collaboration-identity recipient"
                  aria-label={`Open ${to.name}`}
                  onClick={() => openBot(to.id, handoff.conversationId)}
                >
                  <Avatar avatar={to.avatar} size={34} busy={working && active.has(to.id)} />
                  <span>{to.name}</span>
                </button>
                <time dateTime={handoff.startedAt}>
                  {new Date(handoff.startedAt).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </time>
              </div>
              <p className="collaboration-brief">{plainMentionText(handoff.brief)}</p>
              {handoff.receivedAt && (
                <small className="delivery-ack" title={handoff.id}>
                  Received {new Date(handoff.receivedAt).toLocaleTimeString()} · Receipt{' '}
                  {handoff.id.slice(0, 10)}{' '}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => openBot(to.id, handoff.conversationId)}
                  >
                    Open inbox conversation
                  </button>
                </small>
              )}
              <div className={`collaboration-status ${handoff.status}`}>
                {working ? (
                  <LoaderCircle
                    size={13}
                    className="collaboration-spinner"
                    aria-label={`${to.name} working`}
                    role="img"
                  />
                ) : handoff.status === 'completed' ? (
                  <CheckCircle2 size={13} />
                ) : (
                  <AlertCircle size={13} />
                )}
                <span>
                  {status}
                  {working ? '…' : ''}
                </span>
              </div>
              {answer && (
                <div className="collaboration-answer-preview">
                  <BotMessage
                    content={
                      !grid && answer.length > 350 ? `${answer.slice(0, 350).trim()}…` : answer
                    }
                    bots={bots}
                    openBot={openBot}
                  />
                </div>
              )}
              {handoff.error && <p className="collaboration-error">{handoff.error}</p>}
              {run.work?.find((w) => w.handoffId === handoff.id) && (
                <WorkFeedback
                  run={run}
                  work={run.work.find((w) => w.handoffId === handoff.id)}
                  bot={to}
                  models={models}
                  onSaved={onReviewed}
                />
              )}
              <details className="collaboration-details">
                <summary>
                  {answer ? 'Read full reply & work log' : 'View task & work log'}
                  <ChevronDown size={12} />
                </summary>
                <div className="collaboration-detail-body">
                  <h4>The task</h4>
                  <BotMessage content={handoff.brief} bots={bots} openBot={openBot} />
                  {answer && (
                    <>
                      <h4>{to.name}’s reply</h4>
                      <div className="collaboration-answer-full message-content">
                        <BotMessage content={answer} bots={bots} openBot={openBot} />
                      </div>
                    </>
                  )}
                  {handoff.legacy && !answer && (
                    <p className="subtle">
                      This older run saved the handoff events. Open the bot’s space to read its
                      conversation.
                    </p>
                  )}
                  <h4>Work log</h4>
                  <ol className="collaboration-work-log">
                    {handoff.events.map((event, index) => (
                      <li key={index}>
                        <span className={`log-dot ${event.kind}`} />
                        <span>{event.text}</span>
                        <time dateTime={event.at}>
                          {new Date(event.at).toLocaleTimeString([], {
                            hour: 'numeric',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </time>
                      </li>
                    ))}
                  </ol>
                </div>
              </details>
            </article>
          );
        })}
      </div>
    </section>
  );
}
