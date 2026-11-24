export interface Draft {
  id: string;
  runId: string;
  activeRunId: string;
  workId: string;
  botId: string;
  rootBotId: string;
  conversationId: string;
  objective?: string;
  filename: string;
  language: string;
  kind: 'file' | 'reply' | 'tool-payload';
  status: 'writing' | 'complete' | 'partial' | 'superseded';
  content: string;
  revision: number;
  chunks: number;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  pageId?: string;
}
export type DraftSummary = Omit<Draft, 'content'> & { characters: number; lines: number };
export function summarizeDraft(draft: Draft): DraftSummary {
  const { content, ...summary } = draft;
  return { ...summary, characters: content.length, lines: content.split('\n').length };
}
export function mergeContinuation(saved: string, next: string) {
  if (!saved) return next;
  // Only remove a substantial exact overlap. Repeated punctuation/indentation can be meaningful code.
  for (let n = Math.min(saved.length, next.length, 6000); n >= 128; n--)
    if (saved.endsWith(next.slice(0, n))) return saved + next.slice(n);
  return saved + next;
}
