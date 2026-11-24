import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Draft } from '../../packages/shared/drafts';
import { mergeContinuation, summarizeDraft } from '../../packages/shared/drafts';
import type { Run, WorkRecord } from '../../packages/shared/types';
import { Store } from './store';
import { TaskLimitError } from './generation-errors';

export class Drafts {
  events = new EventEmitter();
  constructor(public store: Store) {
    for (const draft of store.all('drafts'))
      if (draft.status === 'writing')
        store.put('drafts', {
          ...draft,
          status: 'partial',
          reason: 'Host restarted. The saved text is available to continue.',
          updatedAt: new Date().toISOString(),
        });
    // Older runs could save the complete workspace file while leaving its notebook
    // placeholder empty. Reconnect only an exact file from that same task and bot.
    for (const draft of store.all('drafts')) {
      if (draft.kind !== 'file' || draft.status !== 'partial' || draft.content.length) continue;
      const page = store
        .all('pages')
        .findLast(
          (page) =>
            page.runId === draft.activeRunId &&
            page.botId === draft.botId &&
            page.workspacePath?.replaceAll('\\', '/') === draft.filename.replaceAll('\\', '/') &&
            page.content.trim() &&
            Date.parse(page.createdAt) >= Date.parse(draft.createdAt),
        );
      if (!page) continue;
      this.save({
        ...draft,
        content: page.content,
        revision: draft.revision + 1,
        chunks: draft.chunks + 1,
        pageId: page.id,
        status: 'complete',
        reason: 'Recovered the file already saved by this task. No publishing action was retried.',
      });
    }
  }
  list(conversationId?: string) {
    return this.store
      .all('drafts')
      .filter((d) => !conversationId || d.conversationId === conversationId)
      .map(summarizeDraft);
  }
  get(id: string) {
    const draft = this.store.get('drafts', id);
    if (!draft) throw new Error('Draft not found');
    return draft;
  }
  replaceFromHost(id: string, content: string, runId: string) {
    const draft = this.get(id);
    if (draft.activeRunId !== runId || content.length > 250000)
      throw new Error('Cannot replace this saved draft.');
    return this.save({
      ...draft,
      content,
      revision: draft.revision + 1,
      chunks: draft.chunks + 1,
      status: 'writing',
    });
  }
  private save(draft: Draft) {
    draft.updatedAt = new Date().toISOString();
    this.store.put('drafts', draft);
    this.events.emit('change', draft);
    return draft;
  }
  create(run: Run, work: WorkRecord, filename: string, kind: Draft['kind'] = 'file', content = '') {
    if (content.length > 250000)
      throw new TaskLimitError('Split the output into files under 250,000 characters.');
    if (
      !filename ||
      filename.length > 160 ||
      filename.includes(':') ||
      filename.startsWith('/') ||
      filename.startsWith('\\') ||
      filename.split(/[\\/]/).includes('..')
    )
      throw new Error('Choose a relative draft filename inside the shared workspace.');
    if (this.store.all('drafts').filter((d) => d.activeRunId === run.id).length >= 20)
      throw new TaskLimitError(
        'This run has 20 saved drafts. Finish or continue them before starting more.',
      );
    const ext = filename.split('.').at(-1)?.toLowerCase() ?? 'text';
    const language =
      (
        {
          js: 'javascript',
          ts: 'typescript',
          py: 'python',
          ps1: 'powershell',
          sh: 'bash',
          md: 'markdown',
        } as Record<string, string>
      )[ext] ?? ext;
    return this.save({
      id: randomUUID(),
      runId: run.id,
      activeRunId: run.id,
      workId: work.id,
      botId: work.botId,
      rootBotId: run.botId,
      conversationId: run.conversationId,
      objective: (
        run.events.find((e) => e.handoffId === work.handoffId && e.handoff)?.handoff?.brief ??
        run.prompt
      ).slice(0, 10000),
      filename,
      language,
      kind,
      status: 'writing',
      content,
      revision: 0,
      chunks: content ? 1 : 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  append(
    id: string,
    content: string,
    revision: number,
    runId: string,
    automatic: false | 'text' | 'recovered' = false,
  ) {
    const draft = this.get(id);
    if (revision !== draft.revision)
      throw new Error(`Draft changed. Read it again; current revision is ${draft.revision}.`);
    if (draft.status === 'superseded' || draft.status === 'complete')
      throw new Error(
        'This draft is complete or superseded. Start a new draft, or patch the existing file intentionally.',
      );
    if (typeof content !== 'string' || !content.length || (!automatic && content.length > 6000))
      throw new Error('Append a nonempty chunk of at most 6000 characters.');
    const combined =
      automatic === 'text' ? mergeContinuation(draft.content, content) : draft.content + content;
    if (combined.length === draft.content.length)
      throw new TaskLimitError(
        'The continuation repeated saved text without making progress. The draft is preserved; use Continue to revise the approach.',
      );
    if (combined.length > 250000)
      throw new TaskLimitError(
        'This draft reached the 250,000-character limit. Split the project into smaller files; the saved text is preserved.',
      );
    draft.content = combined;
    draft.revision++;
    draft.chunks++;
    draft.activeRunId = runId;
    draft.status = 'writing';
    draft.reason = undefined;
    return this.save(draft);
  }
  /** Keep complete, valid tool output even when a model ignores the suggested chunk size. */
  appendFromTool(id: string, content: string, revision: number, runId: string) {
    const draft = this.get(id);
    if (revision !== draft.revision)
      throw new Error(`Draft changed. Read it again; current revision is ${draft.revision}.`);
    if (typeof content !== 'string' || !content.length)
      throw new Error('Append a nonempty text chunk.');
    if (draft.content.length + content.length > 250000)
      throw new TaskLimitError(
        'This draft reached the 250,000-character limit. Split the project into smaller files; the saved text is preserved.',
      );
    // The whole request is validated before saving its first chunk. Stale retries cannot
    // duplicate any prefix because each committed chunk advances the revision.
    for (let offset = 0; offset < content.length; offset += 6000)
      this.append(id, content.slice(offset, offset + 6000), revision++, runId);
    return this.get(id);
  }
  patch(id: string, oldText: string, newText: string, revision: number, runId: string) {
    const draft = this.get(id);
    if (revision !== draft.revision)
      throw new Error(`Read the latest draft revision ${draft.revision} before editing.`);
    if (!oldText || oldText.length > 6000 || newText.length > 6000)
      throw new Error(
        'Use an exact nonempty match and replacement of at most 6000 characters each.',
      );
    const index = draft.content.indexOf(oldText);
    if (index < 0 || draft.content.indexOf(oldText, index + 1) >= 0)
      throw new Error(
        'The old text must match exactly once. Read the needed section and try again.',
      );
    const next =
      draft.content.slice(0, index) + newText + draft.content.slice(index + oldText.length);
    if (next.length > 250000) throw new TaskLimitError('Split this draft into smaller files.');
    draft.content = next;
    draft.revision++;
    draft.chunks++;
    draft.activeRunId = runId;
    draft.status = 'writing';
    draft.reason = undefined;
    return this.save(draft);
  }
  checkpoint(id: string) {
    const draft = this.get(id),
      lines = draft.content.split('\n');
    const outline = lines
      .map((text, index) => ({ line: index + 1, text: text.trim().slice(0, 160) }))
      .filter((x) => /\b(function|class|def|const|let)\s+\w+|\bid=["']|^#{1,3}\s/.test(x.text))
      .slice(0, 24);
    return {
      ...summarizeDraft(draft),
      latestHumanDirection: this.store.get('runs', draft.activeRunId)?.steering?.at(-1)?.content,
      head: draft.content.slice(0, 800),
      tail: draft.content.slice(-2400),
      outline,
      notice:
        'The complete text is in persistent draft storage. Continue with new text only; use draft_read for earlier sections.',
    };
  }
  read(id: string, offset?: number, length = 3500) {
    const draft = this.get(id),
      start = offset ?? Math.max(0, draft.content.length - length);
    if (
      !Number.isInteger(start) ||
      start < 0 ||
      start > draft.content.length ||
      !Number.isInteger(length) ||
      length < 1 ||
      length > 5000
    )
      throw new Error('Use a valid character offset and a length from 1 to 5000.');
    return {
      ...summarizeDraft(draft),
      objective: draft.objective ?? this.store.get('runs', draft.runId)?.prompt.slice(0, 10000),
      latestHumanDirection: this.store.get('runs', draft.activeRunId)?.steering?.at(-1)?.content,
      offset: start,
      content: draft.content.slice(start, start + length),
      nextOffset: Math.min(draft.content.length, start + length),
    };
  }
  status(id: string, status: Draft['status'], reason?: string, pageId?: string) {
    const draft = this.get(id);
    draft.status = status;
    draft.reason = reason;
    if (pageId) draft.pageId = pageId;
    return this.save(draft);
  }
  claim(id: string, run: Run, work: WorkRecord) {
    const draft = this.get(id);
    draft.activeRunId = run.id;
    draft.workId = work.id;
    draft.conversationId = run.conversationId;
    draft.rootBotId = run.botId;
    return this.save(draft);
  }
  closeRun(runId: string, reason: string) {
    for (const draft of this.store.all('drafts'))
      if (draft.activeRunId === runId && draft.status === 'writing')
        this.status(draft.id, 'partial', reason);
  }
}

/** Decode only verified JSON string prefixes. This never repairs or executes a partial tool call. */
export function partialStrings(text: string): Record<string, string> {
  const fields: Record<string, string> = Object.create(null);
  function stringAt(start: number) {
    let value = '',
      i = start + 1;
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') return { value, end: i, complete: true };
      if (c < ' ') return { value, end: i, complete: false };
      if (c !== '\\') {
        value += c;
        continue;
      }
      if (i >= text.length) break;
      const escaped = text[i++],
        simple: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };
      if (escaped === 'u') {
        const digits = text.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) break;
        value += String.fromCharCode(parseInt(digits, 16));
        i += 4;
      } else if (escaped in simple) value += simple[escaped];
      else break;
    }
    return { value, end: i, complete: false };
  }
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') {
      i++;
      continue;
    }
    const key = stringAt(i);
    i = key.end;
    if (!key.complete) break;
    while (/\s/.test(text[i] ?? '') && i < text.length) i++;
    if (text[i] !== ':') continue;
    i++;
    while (/\s/.test(text[i] ?? '') && i < text.length) i++;
    if (text[i] !== '"') {
      // A recovery may append only with an unambiguously completed revision value.
      const revision =
        key.value === 'expectedRevision' ? /^(\d+)\s*[,}]/.exec(text.slice(i)) : null;
      if (revision) fields.expectedRevision = revision[1];
      continue;
    }
    const value = stringAt(i);
    fields[key.value] = value.value;
    i = value.end;
    if (!value.complete) break;
  }
  return fields;
}
