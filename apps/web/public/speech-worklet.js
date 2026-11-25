/* Convert the selected microphone's 16 kHz mono stream into bounded PCM packets. */
class BotBotsDictationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(1600);
    this.offset = 0;
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return;
      if (this.offset) {
        const tail = this.samples.slice(0, this.offset);
        this.port.postMessage(tail.buffer, [tail.buffer]);
        this.offset = 0;
      }
      this.port.postMessage('flushed');
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] ?? 0;
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.samples[this.offset++] = sample < 0 ? sample * 32768 : sample * 32767;
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
        this.samples = new Int16Array(1600);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('bot-bots-dictation', BotBotsDictationProcessor);
