import { Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Bot, Model, Run, TaskType, WorkRecord } from '../../../packages/shared/types';
import { durationLabel, workMetrics } from '../../../packages/shared/experience';
import { api } from './api';
import './experience.css';

export function WorkFeedback({
  run,
  work,
  bot,
  models,
  onSaved,
}: {
  run: Run;
  work?: WorkRecord;
  bot: Pick<Bot, 'name'>;
  models: Model[];
  onSaved: (run: Run) => void;
}) {
  const feedback = work?.feedback ?? (!work?.handoffId ? run.feedback : undefined);
  const rating = feedback?.rating ?? (!work?.handoffId ? run.rating : undefined);
  const [note, setNote] = useState(feedback?.note ?? '');
  const [timing, setTiming] = useState(feedback?.timing ?? 'unspecified');
  const [task, setTask] = useState<TaskType>(work?.task ?? run.task);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setNote(feedback?.note ?? '');
    setTiming(feedback?.timing ?? 'unspecified');
    setTask(work?.task ?? run.task);
  }, [feedback?.updatedAt, work?.task, run.task]);
  if (run.status === 'running' || (work ? work.status !== 'completed' : run.status !== 'completed'))
    return null;
  const metrics = work ? workMetrics(work) : undefined;
  const model = models.find((m) => m.id === (work?.modelId ?? run.modelId));
  async function save(value: number | null) {
    setBusy(true);
    setError('');
    try {
      onSaved(
        await api<Run>(`/runs/${run.id}/rating`, 'PATCH', {
          rating: value,
          workId: work?.id,
          timing,
          note,
          task,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="work-feedback"
      aria-label={`Feedback for ${bot.name}`}
      data-work-id={work?.id ?? run.id}
    >
      <details className="reply-details">
        <summary>Reply details</summary>
        <div className="work-measurements">
          <span>{model?.name ?? work?.modelId ?? run.modelId ?? 'Model not recorded'}</span>
          <span>{work?.task ?? run.task}</span>
          <span>{work?.urgency ?? run.urgency ?? 'relaxed'}</span>
          {(work?.importance ?? run.importance) === 'high' && <span>High importance</span>}
          {metrics && (
            <>
              <span title="Includes tools and delegation">
                {durationLabel(metrics.durationMs)} elapsed
              </span>
              <span title="Only this bot's model requests; excludes teammate time">
                {durationLabel(metrics.modelTimeMs)} model time
              </span>
              <span>
                {metrics.usageKnown
                  ? `${metrics.tokens.toLocaleString()} tokens`
                  : metrics.tokens
                    ? `${metrics.tokens.toLocaleString()}+ tokens · partial usage`
                    : 'Tokens not reported'}
              </span>
            </>
          )}
        </div>
      </details>
      <div className="rating" role="group" aria-label={`Rate ${bot.name}'s work`}>
        <span>How did {bot.name} do?</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            type="button"
            key={n}
            aria-label={`Rate ${n} out of 5`}
            aria-pressed={rating === n}
            className={(rating ?? 0) >= n ? 'rated' : ''}
            disabled={busy}
            onClick={() => void save(n)}
          >
            <Star size={18} />
          </button>
        ))}
        {rating && <small>{rating}/5 · Your vote leads</small>}
      </div>
      <details className="feedback-details">
        <summary>Timing & feedback{feedback?.note ? ' · Note saved' : ''}</summary>
        <div className="feedback-fields">
          <label>
            Was the wait okay?
            <select
              aria-label="Response timing"
              value={timing}
              onChange={(e) => setTiming(e.target.value as typeof timing)}
            >
              <option value="unspecified">No timing preference</option>
              <option value="worth-the-wait">Worth the wait</option>
              <option value="too-slow">Too slow for this job</option>
            </select>
          </label>
          <label>
            Task category
            <select
              aria-label="Feedback task category"
              value={task}
              onChange={(e) => setTask(e.target.value as TaskType)}
            >
              {['general', 'research', 'coding', 'writing', 'planning'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label className="feedback-note">
            What worked, or what should improve?
            <textarea
              aria-label="Feedback note"
              maxLength={2000}
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="I like this bot for drafting. Taking a few minutes is fine."
            />
          </label>
          <small>
            1–2: needs improvement · 3: usable · 4: good · 5: excellent. Ratings guide model choice;
            notes are saved for your review.
          </small>
          <div className="feedback-actions">
            <button
              type="button"
              className="secondary small"
              disabled={!rating || busy}
              onClick={() => void save(rating!)}
            >
              Save feedback
            </button>
            {rating && (
              <button
                type="button"
                className="secondary small"
                disabled={busy}
                onClick={() => void save(null)}
              >
                Clear rating
              </button>
            )}
          </div>
        </div>
      </details>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </section>
  );
}
