import type { Run, WorkRecord } from '../../packages/shared/types';
import { filenameFor } from '../../packages/shared/artifacts';
import { Drafts, partialStrings } from './drafts';
import { TaskLimitError } from './generation-errors';
import type { Completion, WireMessage } from './models';

export const notebookTools = new Set([
  'draft_start',
  'draft_append',
  'draft_read',
  'draft_patch',
  'draft_finish',
]);
export function compactNotebook(messages: WireMessage[]) {
  const completed: {
    call: NonNullable<WireMessage['tool_calls']>[number];
    message: WireMessage;
    result: WireMessage;
  }[] = [];
  for (let i = 0; i < messages.length; i++)
    for (const call of messages[i].tool_calls ?? []) {
      if (!['draft_append', 'draft_patch', 'draft_read'].includes(call.function.name)) continue;
      const tail: WireMessage[] = [];
      for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++)
        tail.push(messages[j]);
      const result = tail.find((m) => m.tool_call_id === call.id);
      if (!result) continue;
      try {
        const data = JSON.parse(result.content ?? '{}');
        if (data.ok === true) completed.push({ call, message: messages[i], result });
      } catch {
        /* preserve unrecognized results */
      }
    }
  // Collapse old completed pairs into one file journal, rather than letting protocol overhead grow forever.
  const older = completed.slice(0, -2);
  if (!older.length) return;
  const marker = 'RUNTIME SAVED-FILE CHECKPOINT';
  const previous = messages.find(
    (message) => message.role === 'user' && message.content?.startsWith(marker),
  );
  let records: Record<string, unknown>[] = [];
  try {
    if (previous?.content)
      records = JSON.parse(previous.content.slice(previous.content.indexOf('\n') + 1));
  } catch {
    /* Rebuild from verified tool results. */
  }
  const files = new Map(records.map((record) => [String(record.id), record]));
  if (previous) messages.splice(messages.indexOf(previous), 1);
  for (const { call, message, result } of older) {
    const data = JSON.parse(result.content ?? '{}');
    if (data.id)
      files.set(String(data.id), {
        id: data.id,
        revision: data.revision,
        filename: data.filename,
        characters: data.characters,
        offset: data.offset,
      });
    message.tool_calls = message.tool_calls?.filter((entry) => entry.id !== call.id);
    if (message.rawOutput)
      message.rawOutput = message.rawOutput.filter(
        (raw) => (raw as { call_id?: string }).call_id !== call.id,
      );
    const at = messages.indexOf(result);
    if (at >= 0) messages.splice(at, 1);
    if (!message.tool_calls?.length && !message.content) {
      const at = messages.indexOf(message);
      if (at >= 0) messages.splice(at, 1);
    }
  }
  messages.push({
    role: 'user',
    content: `${marker} (completed operations; never repeat them; full code remains in draft storage):\n${JSON.stringify([...files.values()])}`,
  });
}
export class OutputRecovery {
  private textId?: string;
  private checkpoint?: WireMessage;
  private direction: number;
  private recoveries = 0;
  private lastSize = 0;
  private stalled = 0;
  private rawId?: string;
  constructor(
    private drafts: Drafts,
    private run: Run,
    private work: WorkRecord,
    private chunkSize: number,
  ) {
    this.direction = run.steering?.length ?? 0;
  }
  private removeCheckpoint(messages: WireMessage[]) {
    if (this.checkpoint) {
      const i = messages.indexOf(this.checkpoint);
      if (i >= 0) messages.splice(i, 1);
      this.checkpoint = undefined;
    }
  }
  private note(messages: WireMessage[], content: string) {
    this.removeCheckpoint(messages);
    this.checkpoint = {
      role: 'user',
      content: `RUNTIME OUTPUT CHECKPOINT (not a new human instruction and never terminal approval):\n${content}`,
    };
    messages.push(this.checkpoint);
  }
  prepare(messages: WireMessage[], tools: unknown[]) {
    const direction = this.run.steering?.length ?? 0;
    if (direction !== this.direction) {
      if (this.textId)
        this.drafts.status(
          this.textId,
          'superseded',
          'The human changed direction. Earlier output is preserved rather than joined to a different answer.',
        );
      this.textId = undefined;
      this.recoveries = 0;
      this.stalled = 0;
      this.lastSize = 0;
      this.direction = direction;
      this.removeCheckpoint(messages);
    }
    compactNotebook(messages);
    return this.textId ? [] : tools;
  }
  handle(response: Completion, messages: WireMessage[]): Completion | undefined {
    if (response.truncated) {
      this.recoveries++;
      if (response.message.tool_calls?.length) {
        if (this.textId) {
          this.drafts.status(
            this.textId,
            'partial',
            'The model changed output format while continuing. The text remains saved.',
          );
          this.textId = undefined;
        }
        const raw = this.rawId
          ? this.drafts.replaceFromHost(
              this.rawId,
              JSON.stringify(response.message).slice(0, 250000),
              this.run.id,
            )
          : this.drafts.create(
              this.run,
              this.work,
              `interrupted-tool-${this.recoveries}.json`,
              'tool-payload',
              JSON.stringify(response.message).slice(0, 250000),
            );
        this.rawId = raw.id;
        this.drafts.status(
          raw.id,
          'partial',
          'Output limit reached. This incomplete tool call was not executed.',
        );
        let fileId: string | undefined;
        for (const call of response.message.tool_calls) {
          const fields = partialStrings(call.function.arguments ?? '');
          if (!fields.content) continue;
          if (call.function.name === 'draft_append' && fields.id) {
            try {
              const existing = this.drafts.get(fields.id);
              if (
                existing.activeRunId === this.run.id &&
                existing.workId === this.work.id &&
                existing.status !== 'complete' &&
                fields.expectedRevision !== undefined &&
                Number(fields.expectedRevision) === existing.revision
              )
                fileId = this.drafts.append(
                  existing.id,
                  fields.content,
                  existing.revision,
                  this.run.id,
                  'recovered',
                ).id;
            } catch {
              /* preserve raw payload; never apply an uncertain edit */
            }
          } else if (['page_create', 'workspace_write'].includes(call.function.name)) {
            let filename =
              call.function.name === 'workspace_write'
                ? fields.path
                : filenameFor(
                    fields.format === 'markdown' ? 'markdown' : 'html',
                    fields.title ?? 'recovered-page',
                  );
            if (
              !filename ||
              filename.length > 160 ||
              filename.includes(':') ||
              filename.split(/[\\/]/).includes('..') ||
              /^[\\/]/.test(filename)
            )
              filename = 'recovered-code.html';
            fileId = this.drafts.create(this.run, this.work, filename, 'file', fields.content).id;
          }
        }
        this.note(
          messages,
          fileId
            ? `The previous tool call hit the output limit and was NOT executed. Its decoded code prefix is safely saved in draft ${fileId}.\n${JSON.stringify(this.drafts.checkpoint(fileId))}\nContinue using draft_append with expectedRevision and at most ${this.chunkSize} NEW characters per call. Do not repeat the prefix or restart the file. Use draft_read for earlier sections, draft_patch for fixes, then draft_finish when complete. After finishing HTML use page_preview. Return only a short summary and file ID; do not paste the entire file into another tool or delegation.`
            : `The attempted tool call hit the output limit and was NOT executed. Raw data is preserved in draft ${raw.id}. Retry using much smaller arguments. For code use draft_start and draft_append chunks under ${this.chunkSize} characters, not one giant page_create/workspace_write. Keep delegate briefs short and pass file/draft IDs rather than embedding code. Never execute or approve any unfinished command.`,
        );
      } else {
        const text = response.message.content ?? '';
        if (text) {
          if (!this.textId)
            this.textId = this.drafts.create(
              this.run,
              this.work,
              'continued-reply.md',
              'reply',
              text,
            ).id;
          else
            this.drafts.append(
              this.textId,
              text,
              this.drafts.get(this.textId).revision,
              this.run.id,
              'text',
            );
        }
        this.note(
          messages,
          this.textId
            ? `Your visible reply reached the per-response output limit, but its text is saved in draft ${this.textId}.\n${JSON.stringify(this.drafts.checkpoint(this.textId))}\nContinue the exact visible reply from the saved tail. Output only NEW text, without repeating earlier content or adding continuation commentary. Do not reopen a code fence that is already open; close it when the file is finished. Finish the original request. The host will join the chunks; tools are temporarily disabled for this text continuation.`
            : 'The output budget was exhausted without any visible text. Give a concise visible answer or use small notebook chunks. Do not spend another response on hidden reasoning.',
        );
      }
      const size = this.drafts.store
        .all('drafts')
        .filter((draft) => draft.workId === this.work.id && draft.kind !== 'tool-payload')
        .reduce((sum, draft) => sum + draft.content.length, 0);
      this.stalled = size > this.lastSize ? 0 : this.stalled + 1;
      this.lastSize = size;
      if (this.recoveries >= 64 || this.stalled >= 4)
        throw new TaskLimitError(
          'Automatic continuation stopped after repeated lack of progress or the per-task safety limit. Saved code and teammate results are preserved; the model server is still available.',
        );
      return undefined;
    }
    if (this.textId) {
      const draft = this.drafts.append(
        this.textId,
        response.message.content ?? '',
        this.drafts.get(this.textId).revision,
        this.run.id,
        'text',
      );
      this.drafts.status(draft.id, 'complete');
      this.removeCheckpoint(messages);
      this.textId = undefined;
      return { ...response, message: { role: 'assistant', content: draft.content } };
    }
    this.removeCheckpoint(messages);
    return response;
  }
}
export function compactTaskContext(messages: WireMessage[]) {
  compactNotebook(messages);
  const results = messages.filter((message) => message.role === 'tool');
  for (const result of results.slice(0, -6)) {
    try {
      if (JSON.parse(result.content ?? '{}')?.error) continue;
    } catch {
      // Preserve unrecognized results rather than asserting that they completed.
      continue;
    }
    if ((result.content?.length ?? 0) > 900)
      result.content = JSON.stringify({
        completed: true,
        summary: result.content!.slice(0, 650),
        notice:
          'Earlier result compacted. The action already ran; use saved file/task/delivery IDs for detail. Do not repeat it.',
      });
  }
}
