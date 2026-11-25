import type { WorkRecord } from '../../packages/shared/types';
import { addTokenUsage } from '../../packages/shared/token-usage';
import type { Completion } from './models';
import type { CompletionProgress } from './chat-stream';

/** One meter per inference, so retries, model switches and tool rounds never double-count. */
export class TokenMeter {
  private last = 0;
  private done = false;
  private observed = false;
  constructor(
    private work: WorkRecord,
    private input: number,
    private changed: () => void,
  ) {
    work.liveUsage = { input, output: 0, total: input, estimated: true };
    this.emit(true);
  }
  private emit(force = false) {
    if (force || Date.now() - this.last >= 150) {
      this.last = Date.now();
      this.changed();
    }
  }
  observe(snapshot: CompletionProgress) {
    if (this.done) return;
    this.observed = true;
    const output =
      snapshot.outputTokens ??
      Math.ceil(
        (snapshot.text.length +
          snapshot.toolCalls.reduce((n, c) => n + c.function.arguments.length, 0)) /
          4,
      );
    this.work.liveUsage = snapshot.usage ?? {
      input: this.input,
      output,
      total: this.input + output,
      estimated: true,
    };
    this.emit();
  }
  finish(response?: Completion) {
    if (this.done) return;
    this.done = true;
    const usage =
      response?.usage ??
      (response?.tokens !== undefined
        ? { total: response.tokens, estimated: false }
        : response
          ? (() => {
              const output = Math.ceil(
                ((response.message.content?.length ?? 0) +
                  (response.message.tool_calls ?? []).reduce(
                    (n, call) => n + call.function.arguments.length,
                    0,
                  )) /
                  4,
              );
              return { input: this.input, output, total: this.input + output, estimated: true };
            })()
          : this.observed
            ? this.work.liveUsage
            : undefined);
    this.work.usage = addTokenUsage(this.work.usage, usage);
    this.work.liveUsage = undefined;
    this.emit(true);
  }
}
