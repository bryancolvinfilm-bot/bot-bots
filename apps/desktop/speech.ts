import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { SpeechCapabilities, SpeechEvent } from '../../packages/shared/speech';

export function sameAppPage(value: string, expected: string) {
  try {
    const actual = new URL(value),
      app = new URL(expected);
    return actual.origin === app.origin && actual.pathname === app.pathname;
  } catch {
    return false;
  }
}
export function microphoneAllowed(
  expected: string,
  request: {
    sameContents: boolean;
    isMainFrame: boolean;
    url: string;
    media: string[];
    active: boolean;
  },
) {
  return (
    request.active &&
    request.sameContents &&
    request.isMainFrame &&
    sameAppPage(request.url, expected) &&
    request.media.length === 1 &&
    request.media[0] === 'audio'
  );
}
const localeCode = (locale: string) =>
  /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(locale) && locale.length <= 40
    ? locale.replaceAll('_', '-')
    : 'en-US';
export class NativeSpeech {
  private current?: {
    id: string;
    child: ChildProcessWithoutNullStreams;
    timer?: ReturnType<typeof setTimeout>;
    reject: (error: Error) => void;
  };
  constructor(
    private helper: string | undefined,
    private emit: (event: SpeechEvent) => void,
  ) {}
  get active() {
    return !!this.current;
  }
  capabilities(locale: string): Promise<SpeechCapabilities> {
    if (!this.helper || !existsSync(this.helper))
      return Promise.resolve({
        available: false,
        engine: 'System speech',
        local: true,
        error: 'Voice input is available in the Windows and macOS desktop builds.',
      });
    return new Promise((resolve) => {
      const child = spawn(this.helper!, ['--probe', localeCode(locale)], { windowsHide: true });
      let output = '',
        finished = false;
      const done = (value: SpeechCapabilities) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(value);
      };
      const unavailable = {
        available: false,
        engine: 'System speech',
        local: true,
        error:
          'System speech is unavailable. Check the installed speech language and reopen Bot-Bots.',
      };
      const timer = setTimeout(() => {
        child.kill();
        done(unavailable);
      }, 10000);
      child.stdout.on('data', (data) => {
        output += data.toString();
        if (output.length > 16000) {
          child.kill();
          done(unavailable);
        }
      });
      child.stderr.resume();
      child.on('error', () => done(unavailable));
      child.on('close', () => {
        try {
          const value = JSON.parse(output.trim());
          if (
            typeof value.available !== 'boolean' ||
            typeof value.engine !== 'string' ||
            typeof value.local !== 'boolean'
          )
            throw Error();
          done({
            available: value.available,
            engine: value.engine.slice(0, 80),
            local: value.local,
            locale: typeof value.locale === 'string' ? value.locale.slice(0, 40) : undefined,
            error: typeof value.error === 'string' ? value.error.slice(0, 500) : undefined,
          });
        } catch {
          done(unavailable);
        }
      });
    });
  }
  async start(id: string, locale: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('Invalid dictation session.');
    if (!this.helper || !existsSync(this.helper))
      throw Error('The system speech helper is unavailable.');
    this.cancel();
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.helper!, ['--listen', localeCode(locale)], { windowsHide: true });
      const session = {
        id,
        child,
        reject,
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
      };
      this.current = session;
      let ready = false,
        pending = '',
        bytes = 0;
      const decoder = new StringDecoder('utf8');
      const fail = (message: string) => {
        if (this.current !== session) return;
        this.emit({ id, type: 'error', message });
        this.cancel(message);
      };
      const line = (text: string) => {
        if (!text.trim() || this.current !== session) return;
        const event = JSON.parse(text);
        if (event.type === 'ready') {
          ready = true;
          clearTimeout(session.timer);
          this.emit({ id, type: 'ready' });
          resolve();
        }
        if (
          event.type === 'transcript' &&
          typeof event.text === 'string' &&
          typeof event.final === 'boolean'
        ) {
          if (event.text.length > 16000) throw Error();
          this.emit({ id, type: 'transcript', text: event.text, final: event.final });
        }
        if (event.type === 'error')
          fail(
            typeof event.message === 'string'
              ? event.message.slice(0, 500)
              : 'System speech stopped. Your draft is preserved.',
          );
      };
      session.timer = setTimeout(
        () => fail('System speech did not start. Check the speech permission and try again.'),
        90000,
      );
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          fail(
            'Dictation reached its session limit. Your draft is preserved; start the mic again to continue.',
          );
          return;
        }
        try {
          pending += decoder.write(chunk);
          let end: number;
          while ((end = pending.indexOf('\n')) >= 0) {
            line(pending.slice(0, end));
            pending = pending.slice(end + 1);
          }
          if (pending.length > 64000) throw Error();
        } catch {
          fail('System speech returned an invalid response. Your draft is preserved.');
        }
      });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () =>
        fail('System speech could not start. Check the installed speech language.'),
      );
      child.on('close', () => {
        if (this.current !== session) return;
        try {
          pending += decoder.end();
          if (pending.trim()) line(pending);
        } catch {
          /* Keep the last valid transcript. */
        }
        clearTimeout(session.timer);
        this.current = undefined;
        if (!ready) reject(Error('System speech stopped before it was ready.'));
        this.emit({ id, type: 'ended' });
      });
    });
  }
  audio(id: string, input: unknown) {
    const session = this.current;
    if (!session || session.id !== id) return;
    const pcm =
      input instanceof ArrayBuffer
        ? Buffer.from(input)
        : ArrayBuffer.isView(input)
          ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
          : undefined;
    if (!pcm || !pcm.length || pcm.length > 6400 || pcm.length % 2) return;
    if (session.child.stdin.writableLength > 128000) {
      this.emit({
        id,
        type: 'error',
        message: 'System speech cannot keep up with this input. Your draft is preserved.',
      });
      this.cancel();
      return;
    }
    if (session.child.stdin.writable) session.child.stdin.write(pcm);
  }
  async stop(id: string, cancel = false) {
    const session = this.current;
    if (!session || session.id !== id) return;
    if (cancel) {
      this.cancel();
      return;
    }
    session.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.current === session) this.cancel();
        resolve();
      }, 2500);
      session.child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  cancel(message = 'Dictation stopped.') {
    const session = this.current;
    if (!session) return;
    this.current = undefined;
    clearTimeout(session.timer);
    session.reject(Error(message));
    session.child.kill();
    this.emit({ id: session.id, type: 'ended' });
  }
}
