import { Check, Clipboard, Download, Play, TerminalSquare } from 'lucide-react';
import { useMemo, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import {
  canPreview,
  filenameFor,
  pasteTerminal,
  showPreview,
} from '../../../packages/shared/artifacts';

for (const [name, grammar] of Object.entries({
  javascript,
  typescript,
  xml,
  css,
  json,
  python,
  bash,
  powershell,
  sql,
  yaml,
}))
  hljs.registerLanguage(name, grammar);
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState('');
  return (
    <button
      type="button"
      title={error || label}
      aria-label={label}
      onClick={() => {
        void (
          window.botBotsDesktop
            ? window.botBotsDesktop.copyText(text)
            : (navigator.clipboard?.writeText(text) ??
              Promise.reject(new Error('Clipboard access requires a secure browser context.')))
        ).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          },
          () => setError('Copy unavailable. Select the text and copy it manually.'),
        );
      }}
    >
      {copied ? <Check size={13} /> : <Clipboard size={13} />}
      {copied ? 'Copied' : error ? 'Select & copy' : label}
    </button>
  );
}
export function downloadCode(content: string, filename: string) {
  const blob = new Blob([filename.endsWith('.ps1') ? '\ufeff' : '', content], {
    type: 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function CodeBlock({
  code,
  language = 'text',
  filename,
  allowPreview = true,
}: {
  code: string;
  language?: string;
  filename?: string;
  allowPreview?: boolean;
}) {
  const lang = language.toLowerCase(),
    name = filename ?? filenameFor(lang);
  const [downloadName, setDownloadName] = useState(name);
  const grammar =
    (
      {
        html: 'xml',
        svg: 'xml',
        js: 'javascript',
        ts: 'typescript',
        py: 'python',
        sh: 'bash',
        shell: 'bash',
        ps1: 'powershell',
      } as Record<string, string>
    )[lang] ?? lang;
  const highlighted = useMemo(
    () =>
      code.length < 60000 && hljs.getLanguage(grammar)
        ? hljs.highlight(code, { language: grammar, ignoreIllegals: true }).value
        : undefined,
    [code, grammar],
  );
  const shell = [
    'bash',
    'sh',
    'shell',
    'powershell',
    'ps1',
    'cmd',
    'batch',
    'bat',
    'console',
    'terminal',
  ].includes(lang);
  return (
    <div className="code-block" data-language={lang}>
      <div className="code-toolbar">
        <span className="code-language">{lang}</span>
        <CopyButton text={code} label="Copy code" />
        {allowPreview && canPreview(lang, code) && (
          <button
            type="button"
            onClick={() =>
              showPreview({
                title: downloadName,
                content: code,
                filename: downloadName,
                language: lang,
              })
            }
          >
            <Play size={13} />
            Preview
          </button>
        )}
        {shell && (
          <button type="button" onClick={() => pasteTerminal(code)}>
            <TerminalSquare size={13} />
            Paste into terminal
          </button>
        )}
        <button type="button" onClick={() => downloadCode(code, downloadName || name)}>
          <Download size={13} />
          Download
        </button>
      </div>
      <pre tabIndex={0}>
        {highlighted !== undefined ? (
          <code
            className={`hljs language-${grammar}`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <code>{code}</code>
        )}
      </pre>
      <div className="code-filename">
        <label>
          File name{' '}
          <input
            aria-label="Code download filename"
            value={downloadName}
            onChange={(e) =>
              setDownloadName(e.target.value.replace(/[\\/:*?"<>|]/g, '-').slice(0, 150))
            }
          />
        </label>
        {shell && <small>Pasting prepares the command. You choose when to run it.</small>}
      </div>
    </div>
  );
}
