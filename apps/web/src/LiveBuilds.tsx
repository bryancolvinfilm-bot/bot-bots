import { useEffect, useState } from 'react';
import { Eye, LoaderCircle } from 'lucide-react';
import type { LiveBuild, LiveBuildSummary } from '../../../packages/shared/builds';
import { showPreview } from '../../../packages/shared/artifacts';
import { api } from './api';
export function LiveBuilds({ runId }: { runId?: string }) {
  const [builds, setBuilds] = useState<LiveBuildSummary[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    setBuilds([]);
    if (!runId) return;
    let active = true;
    const load = () =>
      void api<LiveBuildSummary[]>(`/runs/${runId}/builds`).then(
        (value) => {
          if (active) setBuilds(value);
        },
        () => {},
      );
    load();
    const timer = setInterval(load, 800);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [runId]);
  async function open(build: LiveBuildSummary) {
    try {
      const current = await api<LiveBuild>(`/live-builds/${build.id}`);
      showPreview({
        title: current.filename,
        filename: current.filename,
        content: current.content,
        language: 'html',
        buildId: current.id,
        pageId: current.pageId,
        mode: current.status === 'writing' ? 'build' : 'preview',
      });
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <>
      {builds.map((build) => (
        <div className="artifact-card live-build-card" key={build.id} data-live-build={build.id}>
          {build.status === 'writing' ? (
            <LoaderCircle className="spin" size={20} />
          ) : (
            <Eye size={20} />
          )}
          <div>
            <strong>{build.filename}</strong>
            <small>
              {build.status === 'writing'
                ? 'Writing live'
                : build.status === 'complete'
                  ? 'Page ready'
                  : build.characters
                    ? 'Saved partial build'
                    : 'No page content saved'}{' '}
              · {build.characters.toLocaleString()} characters
            </small>
          </div>
          {(build.characters > 0 || build.status === 'writing') && (
            <button className="primary small" onClick={() => void open(build)}>
              <Eye size={14} />
              {build.status === 'writing' ? 'Watch live build' : 'View page'}
            </button>
          )}
        </div>
      ))}
      {error && <p className="error-text">{error}</p>}
    </>
  );
}
