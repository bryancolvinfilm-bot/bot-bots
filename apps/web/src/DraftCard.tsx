import { Download, FilePenLine, Play, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Draft, DraftSummary } from '../../../packages/shared/drafts';
import type { Bot, Run } from '../../../packages/shared/types';
import { api } from './api';
import { Avatar } from './Avatar';
import { CodeBlock, downloadCode } from './CodeBlock';
import { showPreview } from '../../../packages/shared/artifacts';

export function DraftCard({
  draft,
  bot,
  onContinued,
}: {
  draft: DraftSummary;
  bot?: Bot;
  onContinued: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [full, setFull] = useState<Draft>();
  const [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void api<Draft>(`/drafts/${draft.id}`).then(
      (value) => {
        if (active) setFull(value);
      },
      (e) => {
        if (active) setError(e.message);
      },
    );
    return () => {
      active = false;
    };
  }, [open, draft.id, draft.updatedAt]);
  async function download() {
    try {
      const value = await api<Draft>(`/drafts/${draft.id}`);
      downloadCode(
        value.content,
        value.status === 'complete'
          ? value.filename
          : `partial-${value.filename.split(/[\\/]/).at(-1)}`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function resume() {
    setPending(true);
    setError('');
    try {
      const run = await api<Run>(`/drafts/${draft.id}/continue`, 'POST');
      await onContinued();
      window.dispatchEvent(new CustomEvent('bot-bots:open-run', { detail: run }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="draft-card" data-draft-id={draft.id} data-status={draft.status}>
      <div className="draft-heading">
        {bot ? (
          <Avatar avatar={bot.avatar} size={30} busy={draft.status === 'writing'} />
        ) : (
          <FilePenLine size={22} />
        )}
        <div className="draft-title">
          <strong>{draft.filename}</strong>
          <small>
            {bot?.name ?? 'Bot'} · {draft.characters.toLocaleString()} characters · {draft.chunks}{' '}
            saved {draft.chunks === 1 ? 'chunk' : 'chunks'}
          </small>
        </div>
        <span className={`draft-status ${draft.status}`}>
          {draft.status === 'writing'
            ? 'Saving chunks…'
            : draft.status === 'complete'
              ? 'Finished'
              : draft.status === 'superseded'
                ? 'Earlier direction'
                : 'Partial · saved'}
        </span>
      </div>
      {draft.reason && <p>{draft.reason}</p>}
      <div className="draft-actions">
        {(draft.characters > 0 || draft.status === 'writing') &&
          (/\.(html?|svg)$/i.test(draft.filename) || draft.language === 'html') && (
            <button
              className="primary small"
              onClick={() => {
                void api<Draft>(`/drafts/${draft.id}`)
                  .then((value) =>
                    showPreview({
                      title: value.filename,
                      filename: value.filename,
                      language: 'html',
                      content: value.content,
                      draftId: value.id,
                      pageId: value.pageId,
                      mode: value.status === 'writing' ? 'build' : 'preview',
                    }),
                  )
                  .catch((error) => setError(error.message));
              }}
            >
              <Play size={13} />
              {draft.status === 'writing' ? 'Watch live build' : 'View page'}
            </button>
          )}
        <button className="secondary small" onClick={() => setOpen(!open)}>
          {open ? 'Hide draft' : 'View draft'}
        </button>
        <button className="secondary small" onClick={() => void download()}>
          <Download size={13} />
          Download{draft.status !== 'complete' ? ' partial' : ''}
        </button>
        {draft.status === 'partial' && draft.kind !== 'tool-payload' && (
          <button className="secondary small" disabled={pending} onClick={() => void resume()}>
            <Play size={13} />
            {pending ? 'Resuming…' : 'Continue draft'}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {open &&
        (full ? (
          <CodeBlock
            code={full.content}
            language={full.language}
            filename={
              full.status === 'complete'
                ? full.filename
                : `partial-${full.filename.split(/[\\/]/).at(-1)}`
            }
            allowPreview={false}
          />
        ) : (
          <small>
            <RotateCw size={12} /> Loading saved text…
          </small>
        ))}
    </div>
  );
}
