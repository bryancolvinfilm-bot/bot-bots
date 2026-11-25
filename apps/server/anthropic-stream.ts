import type { CompletionProgress } from './chat-stream';
import type { ToolCall } from './models';
import { providerTokenUsage } from '../../packages/shared/token-usage';
import { providerContextError, TaskLimitError } from './generation-errors';

/** Count thinking deltas without retaining or forwarding their text. */
export class AnthropicStream {
  private text = '';
  private characters = 0;
  private usage: Record<string, number> = {};
  private calls = new Map<number, ToolCall>();
  private stopped = false;
  private stopReason?: string;
  constructor(private progress?: (snapshot: CompletionProgress) => void) {}
  accept(event: any) {
    if (event.type === 'error')
      throw (
        providerContextError(JSON.stringify(event.error)) ??
        Error('The Claude stream reported an error.')
      );
    if (event.type === 'message_start') this.usage = { ...event.message?.usage };
    if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block?.type === 'text') {
        this.text += block.text ?? '';
        this.characters += block.text?.length ?? 0;
      }
      if (block?.type === 'tool_use')
        this.calls.set(event.index, {
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: '' },
        });
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta ?? {};
      if (delta.type === 'text_delta') this.text += delta.text ?? '';
      if (delta.type === 'input_json_delta') {
        const call = this.calls.get(event.index);
        if (call) call.function.arguments += delta.partial_json ?? '';
      }
      for (const value of [delta.text, delta.partial_json, delta.thinking])
        if (typeof value === 'string') this.characters += value.length;
    }
    if (event.type === 'message_delta') {
      this.usage = { ...this.usage, ...event.usage };
      this.stopReason = event.delta?.stop_reason ?? this.stopReason;
    }
    if (event.type === 'message_stop') this.stopped = true;
    this.progress?.(this.snapshot());
  }
  snapshot(): CompletionProgress {
    const reported = providerTokenUsage(this.usage, true);
    const output =
      this.stopped && reported?.output !== undefined
        ? reported.output
        : Math.max(reported?.output ?? 0, Math.ceil(this.characters / 4));
    return {
      text: this.text,
      toolCalls: [...this.calls.values()].map((call) => ({
        ...call,
        function: { ...call.function },
      })),
      outputTokens: output,
      usage: reported && {
        ...reported,
        output,
        total: (reported.input ?? 0) + output,
        estimated: !this.stopped || reported.output === undefined,
      },
    };
  }
  result() {
    if (!this.stopped) throw Error('The Claude stream ended before completion.');
    return {
      stop_reason: this.stopReason,
      content: [
        ...(this.text ? [{ type: 'text', text: this.text }] : []),
        ...[...this.calls.values()].map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments || '{}'),
        })),
      ],
      usage: this.usage,
    };
  }
}

export async function readAnthropicStream(
  response: Response,
  progress?: (snapshot: CompletionProgress) => void,
) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Claude returned no response stream.');
  const decoder = new TextDecoder(),
    stream = new AnthropicStream(progress);
  let buffer = '',
    bytes = 0;
  const line = (text: string) => {
    if (text.startsWith('data:')) {
      const data = text.slice(5).trim();
      if (data && data !== '[DONE]') stream.accept(JSON.parse(data));
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 24 * 1024 * 1024)
        throw new TaskLimitError('Claude output exceeded the response limit.');
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, end).replace(/\r$/, ''));
        buffer = buffer.slice(end + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) line(buffer);
    return stream.result();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
