import { Code2, Download, Play, RotateCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type PreviewDocument } from '../../../packages/shared/artifacts';
import { api, connection } from './api';
import { CodeBlock, downloadCode } from './CodeBlock';
export function PreviewPanel({ doc, close }: { doc: PreviewDocument; close: () => void }) {
  const [mode, setMode] = useState<'preview' | 'code' | 'build'>(doc.mode ?? 'preview'),
    [running, setRunning] = useState(true),
    [revision, setRevision] = useState(0);
  const [src, setSrc] = useState(''),
    [error, setError] = useState('');
  const [content, setContent] = useState(doc.content),
    [following, setFollowing] = useState(true),
    [status, setStatus] = useState('writing');
  const version = useRef(-1);
  useEffect(() => {
    setContent(doc.content);
    version.current = -1;
  }, [doc.content, doc.buildId, doc.draftId]);
  useEffect(() => {
    if ((!doc.buildId && !doc.draftId) || !following) return;
    let current = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const path = doc.buildId ? `/live-builds/${doc.buildId}` : `/drafts/${doc.draftId}/build`;
        const value = await api<{
          content?: string;
          version: number;
          status: string;
          unchanged?: boolean;
        }>(`${path}?since=${version.current}`);
        if (current) {
          setStatus(value.status);
          if (!value.unchanged && value.content !== undefined) {
            version.current = value.version;
            setContent(value.content);
          }
        }
      } catch (error) {
        if (current) setError((error as Error).message);
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 700);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [doc.buildId, doc.draftId, following]);
  useEffect(() => {
    let current = true;
    setError('');
    if (running)
      void api<{ url: string }>('/previews', 'POST', {
        content: content || '<!doctype html><p>The page will appear as code arrives…</p>',
      }).then(
        (result) => {
          if (current) setSrc(`${connection().base}${result.url}`);
        },
        (e) => {
          if (current) setError(e.message);
        },
      );
    return () => {
      current = false;
    };
  }, [content, running, revision]);
  return (
    <aside className="preview-panel" aria-label="Website preview">
      <header className="computer-heading">
        <Code2 size={18} />
        <div>
          <strong>{doc.title}</strong>
          <small>
            {doc.buildId || doc.draftId
              ? `${status === 'writing' ? 'Building live' : status === 'complete' ? 'Saved page' : 'Partial page'} · isolated preview`
              : 'Isolated website preview'}
          </small>
        </div>
        <button className="icon-button" aria-label="Close preview" onClick={close}>
          <X size={18} />
        </button>
      </header>
      <div className="preview-toolbar">
        <button className={mode === 'preview' ? 'selected' : ''} onClick={() => setMode('preview')}>
          <Play size={13} />
          Preview
        </button>
        <button className={mode === 'code' ? 'selected' : ''} onClick={() => setMode('code')}>
          <Code2 size={13} />
          Code
        </button>
        <button className={mode === 'build' ? 'selected' : ''} onClick={() => setMode('build')}>
          Code + page
        </button>
        {(doc.buildId || doc.draftId) && (
          <button aria-pressed={following} onClick={() => setFollowing(!following)}>
            {following ? 'Pause live updates' : 'Follow live updates'}
          </button>
        )}
        <button
          aria-label="Restart website preview"
          onClick={() => {
            setRunning(true);
            setRevision(revision + 1);
          }}
        >
          <RotateCw size={14} />
        </button>
        <button onClick={() => setRunning(!running)}>{running ? 'Stop' : 'Run'}</button>
        <button onClick={() => downloadCode(content, doc.filename)}>
          <Download size={13} />
          Download
        </button>
      </div>
      {mode === 'code' ? (
        <div className="preview-code">
          <CodeBlock
            code={content}
            language={doc.language}
            filename={doc.filename}
            allowPreview={false}
          />
        </div>
      ) : mode === 'build' ? (
        <div className="preview-build-layout">
          <div className="preview-build-code" aria-label="Live source code">
            <CodeBlock
              code={content}
              language={doc.language}
              filename={doc.filename}
              allowPreview={false}
            />
          </div>
          <div className="preview-build-page">
            {running && src ? (
              <iframe
                key={revision}
                title={`Preview: ${doc.title}`}
                className="website-frame"
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                src={src}
              />
            ) : (
              <p>{error || 'Waiting for page content…'}</p>
            )}
          </div>
        </div>
      ) : running && src ? (
        <iframe
          key={revision}
          title={`Preview: ${doc.title}`}
          className="website-frame"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={src}
        />
      ) : running ? (
        <div className="computer-empty">{error || 'Preparing website preview…'}</div>
      ) : (
        <div className="computer-empty">
          <Play size={40} />
          <h3>Preview stopped</h3>
          <button className="primary" onClick={() => setRunning(true)}>
            Run website
          </button>
        </div>
      )}
      <footer className="computer-status">
        HTML, CSS and JavaScript run here. Network access, host files and terminal access stay
        blocked.
      </footer>
    </aside>
  );
}
