import {
  joinDictation,
  type DictationTarget,
  type SpeechEvent,
} from '../../../packages/shared/speech';
type Bridge = NonNullable<Window['botBotsSpeech']>;
export type DictationState = 'idle' | 'starting' | 'listening' | 'stopping';

/** Owns one microphone session on the viewing computer, never on the bot host. */
export class DictationCapture {
  private id = crypto.randomUUID();
  private finished = false;
  private listening = false;
  private stream?: MediaStream;
  private audio?: AudioContext;
  private processor?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private unsubscribe?: () => void;
  private committed = '';
  private partial = '';
  private flushed?: () => void;
  constructor(
    private bridge: Bridge,
    private target: DictationTarget,
    private changed: (state: DictationState, error?: string) => void,
  ) {}
  async start(deviceId: string, locale: string) {
    this.changed('starting');
    this.unsubscribe = this.bridge.onEvent((event) => this.event(event));
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw Error('Microphone access needs HTTPS or a local Bot-Bots host.');
      await this.bridge.start(this.id, locale);
      if (this.finished) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (this.finished) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const audio = new AudioContext({ sampleRate: 16000 });
      this.audio = audio;
      if (audio.sampleRate !== 16000)
        throw Error(
          'This microphone could not provide audio for system dictation. Choose another input.',
        );
      await audio.audioWorklet.addModule(new URL('/speech-worklet.js', location.origin));
      if (this.finished) return;
      const processor = new AudioWorkletNode(audio, 'bot-bots-dictation');
      this.processor = processor;
      processor.port.onmessage = (event) => {
        if (event.data === 'flushed') this.flushed?.();
        else if (this.listening && !this.finished && event.data instanceof ArrayBuffer)
          this.bridge.audio(this.id, event.data);
      };
      this.source = audio.createMediaStreamSource(stream);
      const mute = audio.createGain();
      mute.gain.value = 0;
      this.source.connect(processor);
      processor.connect(mute);
      mute.connect(audio.destination);
      for (const track of stream.getAudioTracks())
        track.onended = () =>
          this.fail('The microphone disconnected. Choose an input and start the mic again.');
      await audio.resume();
      if (this.finished) return;
      this.listening = true;
      this.changed('listening');
    } catch (error) {
      if (this.finished) return;
      const name = error instanceof DOMException ? error.name : '';
      this.fail(
        name === 'NotAllowedError'
          ? 'Allow microphone access for Bot-Bots in your system privacy settings.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'The selected microphone is unavailable. Choose another input.'
            : error instanceof Error
              ? error.message
              : 'Dictation could not start. Your draft is preserved.',
      );
    }
  }
  private event(event: SpeechEvent) {
    if (this.finished || event.id !== this.id) return;
    if (event.type === 'transcript') {
      if (event.final) {
        this.committed = joinDictation(this.committed, event.text ?? '');
        this.partial = '';
      } else this.partial = event.text ?? '';
      if (!this.target.update(joinDictation(this.committed, this.partial)))
        this.fail(
          'Dictation stopped because its insertion point was removed. Your draft is preserved.',
        );
    }
    if (event.type === 'error')
      this.fail(event.message ?? 'System speech stopped. Your draft is preserved.');
    if (event.type === 'ended') this.finish(true);
  }
  private releaseAudio() {
    this.listening = false;
    if (this.processor) {
      this.processor.port.onmessage = null;
      this.processor.disconnect();
    }
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    if (this.audio && this.audio.state !== 'closed') void this.audio.close().catch(() => {});
  }
  private finish(notify: boolean, error?: string) {
    if (this.finished) return;
    this.finished = true;
    this.unsubscribe?.();
    this.releaseAudio();
    this.target.finish(notify);
    this.changed('idle', error);
  }
  private fail(error: string) {
    this.finish(true, error);
    void this.bridge.stop(this.id, true).catch(() => {});
  }
  async stop() {
    if (this.finished) return;
    if (!this.listening) {
      this.cancel(true);
      return;
    }
    this.changed('stopping');
    if (this.processor)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 150);
        this.flushed = () => {
          clearTimeout(timer);
          resolve();
        };
        this.processor!.port.postMessage('flush');
      });
    if (this.finished) return;
    this.releaseAudio();
    try {
      await this.bridge.stop(this.id);
    } finally {
      this.finish(true);
    }
  }
  cancel(notify = false) {
    this.finish(notify);
    void this.bridge.stop(this.id, true).catch(() => {});
  }
}
