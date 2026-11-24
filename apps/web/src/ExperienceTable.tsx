import { Download, Star } from 'lucide-react';
import { useState } from 'react';
import type { Bootstrap } from '../../../packages/shared/types';
import { durationLabel } from '../../../packages/shared/experience';
import { connection } from './api';
import './experience.css';

export function ExperienceTable({ data }: { data: Bootstrap }) {
  const [scope, setScope] = useState(''),
    [task, setTask] = useState('');
  const [error, setError] = useState('');
  const rows = data.assessments.filter(
    (a) => (a.botId ?? '') === scope && (!task || a.task === task),
  );
  async function download() {
    try {
      const { base, token } = connection();
      const res = await fetch(`${base}/api/experience/report`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error('Could not download the experience report.');
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'model-experience.md';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="experience-panel" aria-label="Bot and model experience">
      <div className="section-heading">
        <h2>
          <Star size={19} /> Learning what works for you
        </h2>
      </div>
      <p>
        Your stars are the strongest quality signal, starting with your first vote. Bot-specific
        ratings take precedence over a model’s general task ratings. Unrated models start neutral.
        Completing a job never counts as a positive review.
      </p>
      <p>
        Relaxed jobs have no speed penalty. “Soon” and “Urgent” use your timing feedback and
        measured model time among equally rated choices. Speed averages influence routing after
        three completed jobs per model and task. Your explicit bot model choice is respected when
        available.
      </p>
      <div className="experience-controls">
        <label>
          Bot
          <select
            aria-label="Experience bot"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="">All bots · model overview</option>
            {data.bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Task
          <select
            aria-label="Experience task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
          >
            <option value="">All tasks</option>
            {['general', 'research', 'coding', 'writing', 'planning'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <button className="secondary small" onClick={() => void download()}>
          <Download size={14} /> Markdown report
        </button>
      </div>
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Model / task</th>
              <th>Your stars</th>
              <th>Outcomes</th>
              <th>Avg elapsed</th>
              <th>Avg model time</th>
              <th>Avg tokens</th>
              <th>Your timing votes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={`${a.modelId}:${a.task}`}>
                <td>
                  <strong>{data.models.find((m) => m.id === a.modelId)?.name ?? a.modelId}</strong>
                  <small>{a.task}</small>
                </td>
                <td>
                  <strong className="experience-stars">
                    {a.samples ? `★ ${a.average.toFixed(1)} / 5` : 'Unrated'}
                  </strong>
                  <small>
                    {a.samples} human {a.samples === 1 ? 'vote' : 'votes'}
                  </small>
                </td>
                <td>
                  {a.successes} completed<small>{a.failures} failed attempts</small>
                </td>
                <td>{durationLabel(a.averageDurationMs)}</td>
                <td>{durationLabel(a.averageModelTimeMs)}</td>
                <td>
                  {a.averageTokens === undefined
                    ? 'Not reported'
                    : Math.round(a.averageTokens).toLocaleString()}
                  <small>{a.tokenSamples ?? 0} measured jobs</small>
                </td>
                <td>
                  {a.worthTheWait ?? 0} worth the wait<small>{a.slowReports ?? 0} too slow</small>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={7}>
                  No experience for this selection yet. Finish a job and rate the reply to start
                  teaching your team.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p>
        <small>
          SQLite keeps the history. A readable model-experience.md lookup report is refreshed beside
          the database after jobs and ratings. Elapsed time includes tools and delegation; model
          time excludes them. Unreported usage stays unknown.
        </small>
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </section>
  );
}
