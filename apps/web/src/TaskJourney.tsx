import { useState } from 'react';
import type { Bot, Run } from '../../../packages/shared/types';
import { progressPosition, waitingForDelegates } from '../../../packages/shared/team';
import { Avatar, emptyAvatar } from './Avatar';
export function TaskJourney({
  run,
  bots,
  now,
  openBot,
  compact = false,
}: {
  run: Run;
  bots: Bot[];
  now: number;
  openBot: (id: string) => void;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false),
    work = run.work ?? [];
  if (!work.length) return null;
  const milestones = work.find((w) => !w.handoffId)?.progress?.milestones ?? [];
  return (
    <section
      className={`task-journey ${compact ? 'compact' : ''}`}
      aria-label={compact ? 'Pinned team progress' : 'Team progress'}
      data-run-id={run.id}
    >
      <div className="journey-heading">
        <strong>
          {run.status === 'completed' && work.every((w) => w.status === 'completed')
            ? 'Everyone crossed the line'
            : run.status === 'running'
              ? compact
                ? 'Your team is working'
                : 'Little feet, steady progress'
              : 'The team’s progress'}
        </strong>
        {!compact && <small>Waiting bots stay on the left · finished bots stay on the right</small>}
      </div>
      {!compact && (
        <div className="journey-milestones">
          <span>Start</span>
          {milestones.map((m, i) => (
            <span key={i} style={{ left: `${m.percent}%` }} title={m.label}>
              ● <small>{m.label}</small>
            </span>
          ))}
          <span>Done</span>
        </div>
      )}
      {(expanded ? work : work.slice(0, 8)).map((w) => {
        const b = bots.find((b) => b.id === w.botId),
          waitingFor = waitingForDelegates(run, w).map(
            (id) => bots.find((b) => b.id === id)?.name ?? 'a teammate',
          ),
          waiting = w.status === 'running' && (w.queued || waitingFor.length > 0),
          position = progressPosition(w, now, 60000, waitingFor);
        return (
          <div
            className={`journey-row ${w.status} ${waiting ? 'waiting' : ''}`}
            key={w.id}
            data-work-id={w.id}
          >
            <div className="journey-byline">
              <strong>{b?.name ?? 'Teammate'}</strong>
              <small>{w.queued ? 'Waiting for a model slot' : position.label}</small>
            </div>
            <div
              className="journey-track"
              role="progressbar"
              aria-label={`${b?.name ?? 'Bot'} progress estimate`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(position.percent)}
              aria-valuetext={`${position.label}${position.estimated ? ' · estimate' : ''}`}
            >
              <div className="journey-fill" style={{ width: `${position.percent}%` }} />
              <button
                className="journey-runner"
                style={{ left: `${position.percent}%` }}
                onClick={() => openBot(w.botId)}
                aria-label={`Open ${b?.name ?? 'bot'}`}
              >
                <Avatar
                  avatar={b?.avatar ?? emptyAvatar}
                  size={30}
                  busy={w.status === 'running' && !waiting}
                />
              </button>
            </div>
          </div>
        );
      })}
      {work.length > 8 && (
        <button className="text-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer' : `Show all ${work.length} teammates`}
        </button>
      )}
    </section>
  );
}
