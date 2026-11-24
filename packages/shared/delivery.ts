import type { Bot } from './types';
import { splitBotMentions } from './mentions';

export interface BotDelivery {
  id: string;
  key: string;
  runId: string;
  parentId?: string;
  fromBotId: string;
  toBotId: string;
  senderConversationId: string;
  conversationId: string;
  brief: string;
  source: 'human' | 'tool' | 'legacy';
  status: 'received' | 'working' | 'completed' | 'failed' | 'cancelled';
  receivedAt: string;
  startedAt?: string;
  finishedAt?: string;
  answer?: string;
  error?: string;
}
export interface HumanHandoff {
  botId: string;
  task: string;
  instruction: string;
}
/** Route only explicit, top-level human commands. A mention, quote or status question is not a trigger. */
export function humanHandoffs(text: string, bots: Bot[]): HumanHandoff[] {
  let masked = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, (s) =>
    ' '.repeat(s.length),
  );
  masked = masked.replace(
    /`[^`\n]*`|^\s*>.*$|"[^"\n]*"|“[^”\n]*”|(?<![\p{L}\p{N}])'[^'\n]*'/gmu,
    (s) => ' '.repeat(s.length),
  );
  const commandText = masked;
  const tokens: { start: number; end: number; botId: string }[] = [];
  for (const m of masked.matchAll(/\[(?:\\.|[^\[\]\\])+\]\(#bot\/([^)]*)\)/g)) {
    try {
      tokens.push({
        start: m.index!,
        end: m.index! + m[0].length,
        botId: decodeURIComponent(m[1]),
      });
    } catch {
      /* malformed links are not commands */
    }
    masked =
      masked.slice(0, m.index!) + ' '.repeat(m[0].length) + masked.slice(m.index! + m[0].length);
  }
  let offset = 0;
  for (const part of splitBotMentions(masked, bots)) {
    if (part.type === 'mention')
      tokens.push({ start: offset, end: offset + part.text.length, botId: part.bot.id });
    offset += part.text.length;
  }
  for (const m of masked.matchAll(/(?<![\p{L}\p{N}_@])@([\w-]+)\b/gu))
    if (!tokens.some((t) => t.start <= m.index! && t.end > m.index!))
      tokens.push({ start: m.index!, end: m.index! + m[0].length, botId: m[1] });
  tokens.sort((a, b) => a.start - b.start);
  // Use the quote/code mask for commands, but keep mention spans as original text for locating the payload.
  const commands = [
    ...commandText.matchAll(
      /(?:^|[\n;.!?,])\s*(?:(?:please|now|also|then|and|can you|could you|would you|i (?:want|need) you to)\s+)*(?:(?:tell|ask|have|instruct)\s+|(?:send|forward|pass|route|delegate|assign)\b[^@\n;.!?,]{0,100}?\bto\s+)/gi,
    ),
  ];
  const result: HumanHandoff[] = [];
  for (let n = 0; n < commands.length; n++) {
    const c = commands[n],
      begin = c.index! + c[0].length,
      end = commands[n + 1]?.index ?? text.length;
    const targets: typeof tokens = [];
    let cursor = begin;
    for (const token of tokens.filter((t) => t.start >= begin && t.start < end)) {
      const between = text.slice(cursor, token.start);
      if (!(targets.length ? /^\s*(?:(?:and|&|,)\s*)?$/i : /^\s*$/).test(between)) break;
      targets.push(token);
      cursor = token.end;
    }
    const task = text
      .slice(cursor, end)
      .replace(/^\s*(?:to\s+)?/i, '')
      .trim();
    for (const target of targets)
      if (
        !result.some(
          (r) => r.botId === target.botId && r.instruction === text.slice(c.index, end).trim(),
        )
      )
        result.push({ botId: target.botId, task, instruction: text.slice(c.index, end).trim() });
  }
  return result;
}

export function receiptQuestion(text: string, bots: Bot[]): string | undefined {
  if (
    text.length > 450 ||
    !/^\s*(?:did you (?:get|receive)|have you (?:got|received)|has (?:a|the|that) (?:task|request|message).*(?:arrived|reached))/i.test(
      text,
    ) ||
    /\b(?:also|then|please|afterwards)\b/i.test(text)
  )
    return;
  const linked = [...text.matchAll(/\[(?:\\.|[^\]])+\]\(#bot\/([^)]*)\)/g)].map((m) => {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return '';
    }
  });
  const mentioned = splitBotMentions(text, bots)
    .filter((p) => p.type === 'mention')
    .map((p) => p.bot.id);
  // Receipt questions commonly use plain names: "Did you receive the request from Research?"
  const plainFrom = /\bfrom\s+(?![@\[])([^?\n]+)/i.exec(text)?.[1];
  if (plainFrom) {
    const first = splitBotMentions(`@${plainFrom}`, bots)[0];
    if (first?.type === 'mention') mentioned.push(first.bot.id);
  }
  return [...new Set([...linked, ...mentioned])].length === 1
    ? [...linked, ...mentioned][0]
    : undefined;
}
