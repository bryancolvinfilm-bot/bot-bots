import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { microphoneAllowed, sameAppPage } from '../apps/desktop/speech';
import { DictationCapture } from '../apps/web/src/dictation';
import { joinDictation, type SpeechEvent } from '../packages/shared/speech';

test('microphone permission is restricted to approved audio-only dictation in the trusted app frame', () => {
  const url = 'http://127.0.0.1:3211/',
    request = { url, sameContents: true, isMainFrame: true, media: ['audio'], active: true };
  assert.equal(microphoneAllowed(url, request), true);
  for (const patch of [
    { active: false },
    { sameContents: false },
    { isMainFrame: false },
    { media: ['video'] },
    { media: ['audio', 'video'] },
    { media: [] },
    { url: 'http://127.0.0.1:3211/api/pages/x/view' },
    { url: 'https://example.test/' },
  ])
    assert.equal(microphoneAllowed(url, { ...request, ...patch }), false);
  assert.equal(sameAppPage('not-a-url', url), false);
});

test('audio worklet emits bounded mono PCM and flushes the last incomplete packet', () => {
  const sent: unknown[] = [];
  let Processor: any;
  vm.runInNewContext(readFileSync('apps/web/public/speech-worklet.js', 'utf8'), {
    AudioWorkletProcessor: class {
      port = { postMessage: (value: unknown) => sent.push(value), onmessage: undefined };
    },
    registerProcessor: (_name: string, constructor: any) => {
      Processor = constructor;
    },
    Int16Array,
    ArrayBuffer,
  });
  const processor = new Processor();
  processor.process([[new Float32Array(1601).fill(1), new Float32Array(1601).fill(0)]]);
  assert.equal((sent[0] as ArrayBuffer).byteLength, 3200);
  assert.equal(new Int16Array(sent[0] as ArrayBuffer)[0], 16383);
  processor.port.onmessage({ data: 'flush' });
  assert.equal((sent[1] as ArrayBuffer).byteLength, 2);
  assert.equal(sent[2], 'flushed');
});

test('dictation replaces partial hypotheses, appends final phrases once, and ignores late transcripts after cancellation', async () => {
  let receive: (event: SpeechEvent) => void = () => {},
    id = '';
  const stop: string[] = [],
    text: string[] = [],
    finished: boolean[] = [];
  const bridge: NonNullable<Window['botBotsSpeech']> = {
    capabilities: async () => ({ available: true, engine: 'Test', local: true }),
    start: async (value) => {
      id = value;
      return new Promise(() => {});
    },
    audio: () => {},
    stop: async (value) => {
      stop.push(value);
    },
    onEvent: (listener) => {
      receive = listener;
      return () => {};
    },
  };
  const capture = new DictationCapture(
    bridge,
    {
      update: (value) => {
        text.push(value);
        return true;
      },
      finish: (notify) => finished.push(!!notify),
    },
    () => {},
  );
  // Start is held before capture: this test never accesses a physical microphone.
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => {
          throw Error('Must not open a microphone');
        },
      },
    },
  });
  try {
    void capture.start('chosen-device', 'en-US');
    receive({ id, type: 'transcript', text: 'write a sh', final: false });
    receive({ id, type: 'transcript', text: 'write a shopping list', final: false });
    receive({ id, type: 'transcript', text: 'Write a shopping list.', final: true });
    receive({ id, type: 'transcript', text: 'For tom', final: false });
    assert.equal(text.at(-1), 'Write a shopping list. For tom');
    capture.cancel(true);
    const count = text.length;
    receive({ id, type: 'transcript', text: 'must not leak into another chat', final: true });
    assert.equal(text.length, count);
    assert.deepEqual(finished, [true]);
    assert.deepEqual(stop, [id]);
    assert.equal(
      joinDictation('Already final.', ' revised words '),
      'Already final. revised words',
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
  }
});
