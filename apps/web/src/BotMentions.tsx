import {
  forwardRef,
  memo,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
} from 'react';
import ReactMarkdown from 'react-markdown';
import { openCredentials } from './credential-events';
import { openExternal } from './external-link';
import remarkGfm from 'remark-gfm';
import {
  mentionMarkdown,
  mentionQuery,
  remarkBotMentions,
  splitBotMentions,
  type MentionQuery,
} from '../../../packages/shared/mentions';
import type { Bot, Page } from '../../../packages/shared/types';
import { Avatar } from './Avatar';
import { CodeBlock, downloadCode } from './CodeBlock';
import { filenameFor, showPreview } from '../../../packages/shared/artifacts';
import { api } from './api';

function mentionStyle(bot: Bot): CSSProperties {
  return {
    '--mention-color': bot.avatar.color,
    '--mention-ink': bot.avatar.accent,
  } as CSSProperties;
}

export const BotMessage = memo(function BotMessage({
  content,
  bots,
  openBot,
}: {
  content: string;
  bots: Bot[];
  openBot: (id: string) => void;
}) {
  const [linkError, setLinkError] = useState('');
  const [expanded, setExpanded] = useState(false);
  if (content.length > 32000) {
    return (
      <div className="long-message">
        <pre className="long-message-text">{expanded ? content : content.slice(0, 8000)}</pre>
        <button type="button" className="secondary small" onClick={() => setExpanded(!expanded)}>
          {expanded
            ? 'Show less'
            : `Read complete message (${content.length.toLocaleString()} characters)`}
        </button>
      </div>
    );
  }
  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBotMentions(bots)]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const value = String(children);
            if (!className && !value.includes('\n')) return <code>{children}</code>;
            return (
              <CodeBlock
                code={value.replace(/\n$/, '')}
                language={className?.replace(/^language-/, '') ?? 'text'}
              />
            );
          },
          a: ({ href, children }) => {
            if (/^#credential\/[a-f0-9-]{36}$/i.test(href ?? ''))
              return (
                <button
                  type="button"
                  className="generated-file-link"
                  onClick={() => openCredentials({ requestId: href!.slice(12) })}
                >
                  {children}
                </button>
              );
            const file = href?.match(/^\/api\/pages\/([^/]+)\/view$/);
            if (file)
              return (
                <button
                  type="button"
                  className="generated-file-link"
                  onClick={() => {
                    void api<Page>(`/pages/${encodeURIComponent(file[1])}`)
                      .then((page) => {
                        const filename =
                          page.filename ?? filenameFor(page.language ?? page.format, page.title);
                        if (page.format === 'html')
                          showPreview({
                            title: page.title,
                            content: page.content,
                            filename,
                            language: 'html',
                            pageId: page.id,
                          });
                        else downloadCode(page.content, filename);
                      })
                      .catch((e) => setLinkError(e.message));
                  }}
                >
                  {children}
                </button>
              );
            let bot: Bot | undefined;
            if (href?.startsWith('#bot/')) {
              try {
                bot = bots.find((b) => b.id === decodeURIComponent(href.slice(5)));
              } catch {
                /* A malformed link stays a normal link. */
              }
            }
            if (!bot)
              return (
                <a
                  href={href}
                  onClick={
                    href?.startsWith('https:')
                      ? (event) => {
                          event.preventDefault();
                          void openExternal(href).catch((error) => setLinkError(error.message));
                        }
                      : undefined
                  }
                >
                  {children}
                </a>
              );
            return (
              <button
                type="button"
                className="bot-mention"
                style={mentionStyle(bot)}
                aria-label={`Open ${bot.name}'s space`}
                title={`Open ${bot.name}'s space`}
                onClick={() => openBot(bot.id)}
              >
                <Avatar avatar={bot.avatar} size={23} />
                <span>@{bot.name}</span>
              </button>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
      {linkError && (
        <small role="alert" className="error-text">
          {linkError}
        </small>
      )}
    </>
  );
});

/** Read only text and our atomic chips; pasted HTML never enters the editor. */
function editorText(root: Node, markdown = false): string {
  if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? '';
  if (root instanceof HTMLElement && root.dataset.botId) {
    const label = root.dataset.mentionLabel ?? '';
    return markdown ? mentionMarkdown(root.dataset.botId, label) : label;
  }
  if (root.nodeName === 'BR') return '\n';
  let text = '';
  for (const child of root.childNodes) {
    const block = child.nodeName === 'DIV' || child.nodeName === 'P';
    if (block && text && !text.endsWith('\n')) text += '\n';
    text += editorText(child, markdown);
    if (block && child.nextSibling && !text.endsWith('\n')) text += '\n';
  }
  return text;
}

function caretOffset(editor: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode))
    return;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(editor);
  range.setEnd(selection.anchorNode!, selection.anchorOffset);
  return editorText(range.cloneContents()).length;
}

function isChipOffset(root: Node, offset: number): boolean {
  if (root instanceof HTMLElement && root.dataset.botId)
    return offset >= 0 && offset < (root.dataset.mentionLabel?.length ?? 0);
  let consumed = 0;
  let newline = false;
  for (const child of root.childNodes) {
    const block = child.nodeName === 'DIV' || child.nodeName === 'P';
    if (block && consumed && !newline) consumed++;
    const text = editorText(child);
    if (offset >= consumed && offset < consumed + text.length)
      return isChipOffset(child, offset - consumed);
    consumed += text.length;
    if (text) newline = text.endsWith('\n');
    if (block && child.nextSibling && !newline) {
      consumed++;
      newline = true;
    }
  }
  return false;
}

function placeCaret(editor: HTMLElement, offset: number) {
  const range = document.createRange();
  let remaining = offset;
  for (const child of editor.childNodes) {
    const length = editorText(child).length;
    if (remaining <= length) {
      if (child.nodeType === Node.TEXT_NODE) range.setStart(child, remaining);
      else if (remaining === 0) range.setStartBefore(child);
      else range.setStartAfter(child);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    remaining -= length;
  }
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export interface MentionComposerHandle {
  getMarkdown: () => string;
}
export const MentionComposer = forwardRef<
  MentionComposerHandle,
  {
    bots: Bot[];
    value: string;
    onChange: (value: string) => void;
    onSend: (value: string) => void;
    label: string;
    busy: boolean;
  }
>(function MentionComposer({ bots, value, onChange, onSend, label, busy }, ref) {
  const editor = useRef<HTMLDivElement>(null);
  // React owns the draft value, but native editing owns this DOM. Avoid rereading or
  // replacing an unchanged editor after every keystroke (especially a large paste).
  const currentText = useRef('');
  const inputRevision = useRef(0);
  const palette = useRef<HTMLSpanElement>(null);
  const composing = useRef(false);
  const [query, setQuery] = useState<MentionQuery>();
  const [selected, setSelected] = useState(0);
  const listId = useId();
  useImperativeHandle(
    ref,
    () => ({ getMarkdown: () => (editor.current ? editorText(editor.current, true) : '') }),
    [],
  );
  useEffect(() => {
    if (editor.current && currentText.current !== value) {
      if (value) renderText(value, value.length);
      else {
        editor.current.replaceChildren();
        currentText.current = '';
      }
      setQuery(undefined);
    }
  }, [value]);
  useEffect(() => {
    setSelected(0);
  }, [query?.query, query?.start]);
  useEffect(() => {
    document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, listId]);

  function createChip(bot: Bot) {
    const chip = document.createElement('span');
    chip.className = 'bot-mention composer-mention';
    chip.contentEditable = 'false';
    chip.dataset.botId = bot.id;
    chip.dataset.mentionLabel = `@${bot.name}`;
    chip.style.setProperty('--mention-color', bot.avatar.color);
    chip.style.setProperty('--mention-ink', bot.avatar.accent);
    const icon = Array.from(palette.current?.children ?? []).find(
      (node) => (node as HTMLElement).dataset.botId === bot.id,
    )?.firstElementChild;
    if (icon) chip.append(icon.cloneNode(true));
    const name = document.createElement('span');
    name.textContent = `@${bot.name}`;
    chip.append(name);
    return chip;
  }
  function renderText(text: string, caret: number) {
    const root = editor.current!;
    if (text.length > 16000) {
      root.replaceChildren(document.createTextNode(text));
      root.focus();
      placeCaret(root, caret);
      currentText.current = text;
      onChange(text);
      return;
    }
    const nodes = splitBotMentions(text, bots).map((part) => {
      if (part.type === 'text') return document.createTextNode(part.text);
      return createChip(part.bot);
    });
    // Canonical spelling can change the caret offset (e.g. @bossman → @Boss Man).
    const before = splitBotMentions(text.slice(0, caret), bots)
      .map((part) => (part.type === 'mention' ? `@${part.bot.name}` : part.text))
      .join('');
    root.replaceChildren(...nodes);
    root.focus();
    placeCaret(root, before.length);
    currentText.current = editorText(root);
    onChange(currentText.current);
  }
  function updateQuery() {
    if (!editor.current || composing.current) return;
    const caret = caretOffset(editor.current);
    const candidate = caret == null ? undefined : mentionQuery(currentText.current, caret, bots);
    if (candidate && isChipOffset(editor.current, candidate.start)) {
      setQuery(undefined);
      return;
    }
    setQuery(candidate);
  }
  function sync() {
    inputRevision.current++;
    const root = editor.current!;
    const text = editorText(root);
    currentText.current = text;
    onChange(text);
    if (composing.current) return;
    const caret = caretOffset(root);
    // A long pasted document stays plain text. Existing selected chips are retained;
    // new mentions still work through the palette and are resolved when sent.
    if (text.length <= 16000 && text.includes('@')) {
      const mentions = splitBotMentions(text, bots).filter((part) => part.type === 'mention');
      if (caret != null && mentions.length !== root.querySelectorAll('[data-bot-id]').length)
        renderText(text, caret);
    }
    updateQuery();
  }
  function choose(bot: Bot) {
    if (!query || !editor.current) return;
    const text = editorText(editor.current);
    if (text.length > 16000) {
      // Replace only the short completion range. Rebuilding an entire document
      // would discard existing chips and do unnecessary work for one mention.
      const selection = window.getSelection();
      placeCaret(editor.current, query.start);
      const range = selection?.getRangeAt(0).cloneRange();
      placeCaret(editor.current, query.end);
      const end = selection?.getRangeAt(0);
      if (range && end) {
        range.setEnd(end.startContainer, end.startOffset);
        range.deleteContents();
        const space = document.createTextNode(' ');
        const fragment = document.createDocumentFragment();
        fragment.append(createChip(bot), space);
        range.insertNode(fragment);
        range.setStart(space, 1);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
        currentText.current = editorText(editor.current);
        onChange(currentText.current);
        setQuery(undefined);
        return;
      }
    }
    const replacement = `@${bot.name} `;
    renderText(
      text.slice(0, query.start) + replacement + text.slice(query.end),
      query.start + replacement.length,
    );
    setQuery(undefined);
  }
  function insertText(text: string) {
    // Chromium's editing command retains native selection and undo behavior for plain text.
    const revision = inputRevision.current;
    document.execCommand('insertText', false, text);
    if (inputRevision.current === revision) sync();
  }
  function paste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (text.length < 4000) {
      insertText(text);
      return;
    }
    // insertText creates an editing block for every line. Escaped HTML inserts one
    // literal text node and preserves native undo even for a large document.
    const literal = text.replace(/\r\n?/g, '\n');
    const escaped = literal.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const revision = inputRevision.current;
    if (document.execCommand('insertHTML', false, escaped)) {
      if (inputRevision.current === revision) sync();
      return;
    }
    // Retain a plain-text fallback for engines without the native editing command.
    const root = editor.current!;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : document.createRange();
    if (!root.contains(range.commonAncestorContainer)) {
      range.selectNodeContents(root);
      range.collapse(false);
    }
    range.deleteContents();
    const node = document.createTextNode(literal);
    range.insertNode(node);
    range.setStart(node, node.length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    root.normalize();
    sync();
  }
  return (
    <div className="mention-editor-wrap">
      <span hidden ref={palette}>
        {bots.map((bot) => (
          <span key={bot.id} data-bot-id={bot.id}>
            <Avatar avatar={bot.avatar} size={23} />
          </span>
        ))}
      </span>
      {query && (
        <div className="mention-menu" id={listId} role="listbox" aria-label="Mention a bot">
          <div className="mention-menu-heading">BRING A TEAMMATE INTO THE CONVERSATION</div>
          {query.bots.map((bot, index) => (
            <button
              type="button"
              role="option"
              id={`${listId}-${index}`}
              key={bot.id}
              aria-selected={index === selected}
              className={index === selected ? 'selected' : ''}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(bot)}
            >
              <Avatar avatar={bot.avatar} size={35} />
              <span>
                <strong>@{bot.name}</strong>
                <small>{bot.title}</small>
              </span>
              <span className="mention-swatch" style={{ background: bot.avatar.color }} />
            </button>
          ))}
          <small className="mention-menu-help">
            ↑ ↓ to choose · Enter or Tab to insert · Esc to close
          </small>
        </div>
      )}
      <div
        ref={editor}
        role="textbox"
        aria-label={label}
        aria-multiline="true"
        aria-autocomplete="list"
        aria-controls={query ? listId : undefined}
        aria-expanded={!!query}
        aria-activedescendant={query ? `${listId}-${selected}` : undefined}
        contentEditable
        className="mention-editor"
        data-placeholder={`${label}… Type @ to mention a bot`}
        suppressContentEditableWarning
        onInput={sync}
        onPaste={paste}
        onDrop={(event) => event.preventDefault()}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          sync();
        }}
        onClick={updateQuery}
        onKeyUp={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Escape', 'Enter', 'Tab'].includes(event.key))
            updateQuery();
        }}
        onBlur={() => setQuery(undefined)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || composing.current) return;
          if (query && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
            if (event.key === 'Escape') {
              event.preventDefault();
              setQuery(undefined);
              return;
            }
            event.preventDefault();
            if (event.key === 'ArrowDown') setSelected((index) => (index + 1) % query.bots.length);
            else if (event.key === 'ArrowUp')
              setSelected((index) => (index - 1 + query.bots.length) % query.bots.length);
            else choose(query.bots[selected] ?? query.bots[0]);
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) insertText('\n');
            else if (!busy) onSend(editorText(editor.current!, true));
          }
        }}
      />
    </div>
  );
});
