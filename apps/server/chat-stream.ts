import type { ToolCall } from './models';
import { TaskLimitError } from './generation-errors';
export interface CompletionProgress {
  text: string;
  toolCalls: ToolCall[];
}
/** Observe visible output only. Reasoning deltas are deliberately never collected or forwarded. */
export async function readChatStream(
  response: Response,
  progress?: (snapshot: CompletionProgress) => void,
) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('The model stream had no response body.');
  const decoder = new TextDecoder();
  let pending = '',
    text = '',
    stopReason: string | undefined,
    tokens: number | undefined,
    bytes = 0;
  const calls = new Map<number, ToolCall>();
  const line = (input: string) => {
    if (!input.startsWith('data:')) return;
    const data = input.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const frame = JSON.parse(data);
    if (frame.error) throw Error('The model stream reported an error.');
    if (typeof frame.usage?.total_tokens === 'number') tokens = frame.usage.total_tokens;
    const choice = frame.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) stopReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string') text += delta.content;
    for (const part of delta.tool_calls ?? []) {
      const index = Number(part.index ?? 0);
      const call = calls.get(index) ?? {
        id: '',
        type: 'function' as const,
        function: { name: '', arguments: '' },
      };
      if (part.id) call.id += part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
      calls.set(index, call);
    }
    progress?.({
      text,
      toolCalls: [...calls.values()].map((call) => ({ ...call, function: { ...call.function } })),
    });
  };
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 4000000)
        throw new TaskLimitError('The model response exceeded the saved-output size limit.');
      pending += decoder.decode(result.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, newline).replace(/\r$/, ''));
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) line(pending);
  } finally {
    reader.releaseLock();
  }
  return {
    choices: [
      {
        message: {
          content: text || null,
          tool_calls: calls.size ? [...calls.values()] : undefined,
        },
        finish_reason: stopReason ?? 'length',
      },
    ],
    usage: { total_tokens: tokens },
  };
}
