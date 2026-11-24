export interface LiveBuild {
  id: string;
  runId: string;
  workId: string;
  botId: string;
  filename: string;
  content: string;
  status: 'writing' | 'complete' | 'partial';
  version: number;
  draftId?: string;
  pageId?: string;
}
export type LiveBuildSummary = Omit<LiveBuild, 'content'> & { characters: number };
export function htmlFromReply(text: string) {
  const fenced = /```(?:html|svg)\s*\n([\s\S]*?)(?:```|$)/i.exec(text)?.[1];
  if (fenced !== undefined) return fenced;
  return /^\s*(?:<!doctype\s+html|<html\b|<svg\b)/i.test(text) ? text : undefined;
}
