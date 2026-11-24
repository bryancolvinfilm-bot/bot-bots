export class Semaphore {
  private active = 0;
  private waiters: {
    resolve: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }[] = [];
  constructor(private limit: () => number) {}
  private wake() {
    while (this.active < this.limit() && this.waiters.length) {
      const next = this.waiters.shift()!;
      next.signal.removeEventListener('abort', next.abort);
      if (next.signal.aborted) {
        next.reject(next.signal.reason);
        continue;
      }
      this.active++;
      next.resolve();
    }
  }
  async use<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const item = {
        resolve,
        reject,
        signal,
        abort: () => {
          const i = this.waiters.indexOf(item);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', item.abort, { once: true });
      this.waiters.push(item);
      this.wake();
    });
    try {
      signal.throwIfAborted();
      return await action();
    } finally {
      this.active--;
      this.wake();
    }
  }
}
