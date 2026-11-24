export interface PreviewDocument {
  title: string;
  content: string;
  filename: string;
  language: string;
  pageId?: string;
  draftId?: string;
  buildId?: string;
  mode?: 'preview' | 'code' | 'build';
}
declare global {
  interface Window {
    botBotsDesktop?: {
      copyText(text: string): Promise<void>;
      mode?: 'server' | 'client';
      openExternal?(url: string): Promise<void>;
      setMode?(config: { mode: 'server' | 'client'; serverUrl?: string }): Promise<void>;
    };
  }
}
export const PREVIEW_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
export function previewHtml(content: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}"></head><body>${content}</body></html>`;
}
export function filenameFor(language: string, title = 'generated') {
  const extensions: Record<string, string> = {
    html: 'html',
    xml: 'html',
    svg: 'svg',
    javascript: 'js',
    js: 'js',
    typescript: 'ts',
    ts: 'ts',
    python: 'py',
    py: 'py',
    bash: 'sh',
    sh: 'sh',
    shell: 'sh',
    powershell: 'ps1',
    ps1: 'ps1',
    cmd: 'cmd',
    batch: 'bat',
    css: 'css',
    json: 'json',
    markdown: 'md',
    md: 'md',
    sql: 'sql',
    yaml: 'yaml',
    yml: 'yml',
  };
  return `${title.replace(/[^a-z0-9._-]/gi, '-').slice(0, 100) || 'generated'}.${extensions[language.toLowerCase()] ?? 'txt'}`;
}
export function canPreview(language: string, content: string) {
  return (
    ['html', 'xml', 'svg'].includes(language.toLowerCase()) ||
    /^\s*(<!doctype html|<html\b)/i.test(content)
  );
}
export function showPreview(doc: PreviewDocument) {
  window.dispatchEvent(new CustomEvent('bot-bots:preview', { detail: doc }));
}
export function pasteTerminal(command: string) {
  window.dispatchEvent(new CustomEvent('bot-bots:terminal-paste', { detail: command }));
}
