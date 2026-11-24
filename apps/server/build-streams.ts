import type { Run, WorkRecord } from '../../packages/shared/types';
import type { Draft } from '../../packages/shared/drafts';
import { mergeContinuation } from '../../packages/shared/drafts';
import { htmlFromReply, type LiveBuild, type LiveBuildSummary } from '../../packages/shared/builds';
import type { CompletionProgress } from './chat-stream';
import { Drafts, partialStrings } from './drafts';
import { filenameFor } from '../../packages/shared/artifacts';

/** In-flight code is an observable preview, never an executed tool or a committed file revision. */
export class BuildStreams {
  private items = new Map<string, LiveBuild>();
  constructor(private drafts: Drafts) {}
  private save(
    run: Run,
    work: WorkRecord,
    filename: string,
    content: string,
    extra: Partial<LiveBuild> = {},
  ) {
    if (content.length > 250000) return;
    const id = `build-${work.id}`,
      old = this.items.get(id);
    if (!old && this.items.size >= 256) {
      const expired = [...this.items.values()].find((build) => build.status !== 'writing');
      if (expired) this.items.delete(expired.id);
    }
    if (old?.content === content && old.status === extra.status && old.pageId === extra.pageId)
      return;
    this.items.set(id, {
      ...old,
      id,
      runId: run.id,
      workId: work.id,
      botId: work.botId,
      filename,
      content,
      status: 'writing',
      ...extra,
      version: (old?.version ?? 0) + 1,
    });
    const updated = this.items.get(id)!;
    updated.content = content;
    updated.filename = filename;
  }
  observer(run: Run, work: WorkRecord) {
    let last = 0;
    const reply =
      this.drafts.store
        .all('drafts')
        .findLast(
          (draft) =>
            draft.workId === work.id && draft.kind === 'reply' && draft.status !== 'complete',
        )?.content ?? '';
    return (snapshot: CompletionProgress) => {
      if (Date.now() - last < 100 && this.items.get(`build-${work.id}`)?.content.length) return;
      last = Date.now();
      for (const call of snapshot.toolCalls) {
        if (!['draft_append', 'page_create', 'workspace_write'].includes(call.function.name))
          continue;
        const fields = partialStrings(call.function.arguments);
        if (fields.content === undefined) continue;
        if (call.function.name === 'draft_append' && fields.id) {
          try {
            const draft = this.drafts.get(fields.id);
            if (draft.workId === work.id && /\.(html?|svg)$/i.test(draft.filename))
              this.save(run, work, draft.filename, draft.content + fields.content, {
                draftId: draft.id,
              });
          } catch {
            /* Wait for a real draft. */
          }
        } else {
          const filename = fields.path ?? filenameFor('html', fields.title ?? 'website');
          if (
            /\.(html?|svg)$/i.test(filename) &&
            (fields.format === 'html' ||
              call.function.name === 'workspace_write' ||
              htmlFromReply(fields.content) !== undefined)
          )
            this.save(run, work, filename, fields.content);
        }
      }
      const html = htmlFromReply(mergeContinuation(reply, snapshot.text));
      if (html !== undefined) this.save(run, work, 'website.html', html);
    };
  }
  fromDraft(run: Run, work: WorkRecord, draft: Draft) {
    const saved = this.items.get(`build-${work.id}`);
    if (!draft.content.length && !draft.pageId && saved?.status === 'complete' && saved.pageId)
      return;
    const content =
      draft.kind === 'reply'
        ? htmlFromReply(draft.content)
        : /\.(html?|svg)$/i.test(draft.filename)
          ? draft.content
          : undefined;
    if (content !== undefined)
      this.save(run, work, draft.kind === 'reply' ? 'website.html' : draft.filename, content, {
        draftId: draft.id,
        pageId: draft.pageId,
        status:
          draft.status === 'complete'
            ? 'complete'
            : draft.status === 'writing'
              ? 'writing'
              : 'partial',
      });
  }
  page(run: Run, work: WorkRecord, page: { id: string; filename?: string; content: string }) {
    this.save(run, work, page.filename ?? 'website.html', page.content, {
      status: 'complete',
      pageId: page.id,
    });
  }
  finish(workId: string) {
    const build = this.items.get(`build-${workId}`);
    if (build && build.status === 'writing') {
      build.status = 'partial';
      build.version++;
    }
  }
  get(id: string) {
    return this.items.get(id);
  }
  list(runId: string): LiveBuildSummary[] {
    return [...this.items.values()]
      .filter((build) => build.runId === runId)
      .map(({ content, ...build }) => ({ ...build, characters: content.length }));
  }
}
