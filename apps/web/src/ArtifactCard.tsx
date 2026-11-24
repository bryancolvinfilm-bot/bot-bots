import { Download, FileCode2, Play } from 'lucide-react';
import type { Page } from '../../../packages/shared/types';
import { filenameFor, showPreview } from '../../../packages/shared/artifacts';
import { downloadCode } from './CodeBlock';
import { openExternal } from './external-link';
export function ArtifactCard({ page }: { page: Page }) {
  const filename = page.filename ?? filenameFor(page.format, page.title);
  return (
    <div className="artifact-card" data-page-id={page.id}>
      <FileCode2 size={22} />
      <div>
        <strong>{page.title}</strong>
        <small>{filename} · Saved on your host</small>
      </div>
      {page.publication && (
        <button
          className="primary small"
          onClick={() =>
            void openExternal(page.publication!.shortUrl ?? page.publication!.publicUrl)
          }
        >
          Open published page
        </button>
      )}
      {page.format === 'html' && (
        <button
          type="button"
          className="secondary small"
          onClick={() =>
            showPreview({
              title: page.title,
              content: page.content,
              filename,
              language: 'html',
              pageId: page.id,
            })
          }
        >
          <Play size={13} />
          View page
        </button>
      )}
      <button
        type="button"
        className="secondary small"
        onClick={() => downloadCode(page.content, filename)}
      >
        <Download size={13} />
        Download
      </button>
    </div>
  );
}
