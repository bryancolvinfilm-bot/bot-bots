import type { Bot } from './types';

export type MentionPart =
  { type: 'text'; text: string } | { type: 'mention'; text: string; bot: Bot };

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalize = (text: string) => text.toLocaleLowerCase().replace(/[\s_-]+/g, '');

export function botAliases(bot: Pick<Bot, 'name' | 'id'>) {
  return [
    ...new Set([
      bot.name.trim(),
      bot.name.replace(/\s+/g, ''),
      bot.name.trim().replace(/\s+/g, '-'),
      bot.id,
    ]),
  ].filter(Boolean);
}

/** Longest full name wins; emails, unknown names, and partial names stay plain text. */
export function splitBotMentions(text: string, bots: Bot[]): MentionPart[] {
  if (!text.includes('@')) return [{ type: 'text', text }];
  const aliases = bots.flatMap((bot) => botAliases(bot).map((alias) => ({ bot, alias })));
  aliases.sort((a, b) => b.alias.length - a.alias.length);
  if (!aliases.length) return [{ type: 'text', text }];
  const pattern = aliases
    .map(({ alias }) => alias.split(/\s+/).map(escapeRegex).join('[ \\t]+'))
    .join('|');
  const expression = new RegExp(`(?<![\\p{L}\\p{N}_@])@(${pattern})(?![\\p{L}\\p{N}_-])`, 'giu');
  const parts: MentionPart[] = [];
  let offset = 0;
  for (const match of text.matchAll(expression)) {
    const bot = aliases.find(({ alias }) => normalize(alias) === normalize(match[1]))?.bot;
    if (!bot) continue;
    if (match.index > offset) parts.push({ type: 'text', text: text.slice(offset, match.index) });
    parts.push({ type: 'mention', text: match[0], bot });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push({ type: 'text', text: text.slice(offset) });
  return parts.length ? parts : [{ type: 'text', text }];
}

export interface MentionQuery {
  start: number;
  end: number;
  query: string;
  bots: Bot[];
}
export function mentionQuery(text: string, caret: number, bots: Bot[]): MentionQuery | undefined {
  // An unfinished mention is at most 80 characters. Search only the caret's
  // immediate neighborhood, even when the draft contains an entire document.
  const offset = Math.max(0, caret - 82);
  const before = text.slice(offset, caret);
  const localStart = before.lastIndexOf('@');
  const start = offset + localStart;
  if (localStart < 0 || (start > 0 && /[\p{L}\p{N}_@]/u.test(text[start - 1]))) return;
  const query = text.slice(start + 1, caret);
  if (query.length > 80 || /[\n\r@]/.test(query)) return;
  const matches = bots.filter((bot) =>
    botAliases(bot).some((alias) => normalize(alias).startsWith(normalize(query))),
  );
  if (!matches.length) return;
  return { start, end: caret, query, bots: matches.slice(0, 8) };
}

export function mentionMarkdown(botId: string, label: string) {
  return `[${label.replace(/[\\[\]]/g, '\\$&')}](#bot/${encodeURIComponent(botId)})`;
}

/** Keep titles and activity summaries readable without exposing saved link markup. */
export function plainMentionText(text: string) {
  return text.replace(/\[((?:\\.|[^\[\]\\])*)\]\(#bot\/[^)]*(?:\)|$)/g, (_match, label: string) =>
    label.replace(/\\([\\[\]])/g, '$1'),
  );
}

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}
export function remarkBotMentions(bots: Bot[]) {
  return () => (tree: MarkdownNode) => {
    function visit(node: MarkdownNode) {
      if (
        ['link', 'linkReference', 'code', 'inlineCode', 'html', 'image', 'imageReference'].includes(
          node.type,
        )
      )
        return;
      if (!node.children) return;
      node.children = node.children.flatMap((child): MarkdownNode[] => {
        if (child.type !== 'text' || !child.value) {
          visit(child);
          return [child];
        }
        return splitBotMentions(child.value, bots).map((part) =>
          part.type === 'text'
            ? { type: 'text', value: part.text }
            : {
                type: 'link',
                url: `#bot/${encodeURIComponent(part.bot.id)}`,
                children: [{ type: 'text', value: part.text }],
              },
        );
      });
    }
    visit(tree);
  };
}
