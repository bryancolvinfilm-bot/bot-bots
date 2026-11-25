import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { Store } from '../apps/server/store';
import { createApp } from '../apps/server/app';
import { seedTestTeam } from '../tests/fixtures/team';

if (process.platform !== 'win32')
  throw Error(
    'This live native-speech verification runs on Windows. macOS speech is built and probed separately in CI.',
  );
const dir = resolve(`test-results/speech/ui-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const wav = join(dir, 'synthetic.wav');
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Add-Type -AssemblyName System.Speech; $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer; $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); $voice.SetOutputToWaveFile($env:BOT_BOTS_SPEECH_TEST_WAV, $format); $voice.Speak('Please write a short shopping list for tomorrow.'); $voice.Dispose()`,
  ],
  { windowsHide: true, env: { ...process.env, BOT_BOTS_SPEECH_TEST_WAV: wav } },
);
const store = new Store(join(dir, 'host/team.sqlite'));
seedTestTeam(store);
const model = createServer(async (req, res) => {
  for await (const _chunk of req) {
    /* Consume the synthetic request. */
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [{ message: { content: 'Received the dictated prompt.' }, finish_reason: 'stop' }],
      usage: { total_tokens: 10 },
    }),
  );
});
await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
const provider = store.all('providers')[0],
  selected = store.all('models')[0];
store.put('providers', {
  ...provider,
  autoDiscover: false,
  baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
});
for (const item of store.all('models'))
  store.put('models', { ...item, enabled: item.id === selected.id });
store.put('models', {
  ...selected,
  enabled: true,
  status: 'online',
  loadState: 'loaded',
  toolCalling: 'disabled',
});
store.setConfig('settings', { ...store.settings(), mainBotId: null });
const host = createApp(store, join(dir, 'host'), resolve('dist/web'));
const server = host.app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const executablePath = process.env.BOT_BOTS_TEST_EXECUTABLE;
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE',
  ),
) as Record<string, string>;
const app = await electron.launch({
  executablePath,
  args: [
    ...(executablePath ? [] : ['.']),
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
  ],
  env: {
    ...environment,
    BOT_BOTS_MODE: 'client',
    BOT_BOTS_DATA_DIR: join(dir, 'client'),
    BOT_BOTS_SERVER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  },
});
const page = await app.firstWindow(),
  errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
async function until(check: () => boolean | Promise<boolean>, label: string) {
  for (let index = 0; index < 1000; index++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error(`Speech verification timed out: ${label}`);
}
try {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('button', { name: 'Open Calendar', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Message Calendar', exact: true });
  await until(
    async () =>
      await page.getByRole('button', { name: 'Start dictation', exact: true }).isEnabled(),
    'native capabilities',
  );
  await page.evaluate(() => {
    const test = {
      streams: [] as MediaStream[],
      constraints: [] as MediaStreamConstraints[],
      events: [] as unknown[],
      deny: false,
    };
    (window as any).speechTest = test;
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      test.constraints.push(constraints ?? {});
      if (test.deny) throw new DOMException('Denied in synthetic verification', 'NotAllowedError');
      const stream = await capture(constraints);
      test.streams.push(stream);
      return stream;
    };
    window.botBotsSpeech!.onEvent((event) => test.events.push(event));
  });
  await editor.fill('@Cal');
  await page
    .getByRole('listbox', { name: 'Mention a bot', exact: true })
    .getByRole('option', { name: /Calendar/ })
    .click();
  await editor.pressSequentially('Existing typed text. ');
  await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
  await until(
    async () =>
      await page.evaluate(() =>
        (window as any).speechTest.events.some(
          (event: any) => event.type === 'transcript' && event.text,
        ),
      ),
    'first native partial',
  );
  await editor.press('End');
  await editor.pressSequentially(' manual addition');
  await page.screenshot({ path: join(dir, 'live-system-dictation.png') });
  await until(
    async () =>
      await page.evaluate(() =>
        (window as any).speechTest.events.some(
          (event: any) =>
            event.type === 'transcript' && event.final && /shopping list/i.test(event.text),
        ),
      ),
    'native final transcript',
  );
  await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
  await page.getByRole('button', { name: 'Start dictation', exact: true }).waitFor();
  const text = await editor.innerText();
  assert.match(text, /Existing typed text/);
  assert.match(text, /manual addition/);
  assert.match(text, /shopping list/i);
  assert.equal(await editor.locator('.composer-mention').count(), 1);
  assert.equal(
    store.all('messages').filter((message) => message.role === 'user').length,
    0,
    'Dictation must never submit itself.',
  );
  const input = page.getByLabel('Microphone input', { exact: true });
  await until(async () => (await input.locator('option').count()) > 1, 'named microphones');
  const physical = await input
    .locator('option')
    .evaluateAll((options) =>
      options
        .map((option) => (option as HTMLOptionElement).value)
        .find((value) => value !== 'default'),
    );
  assert.ok(physical);
  await input.selectOption(physical);
  await editor.fill('Second draft. ');
  await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
  await until(
    async () =>
      await page.evaluate(
        (id) =>
          (window as any).speechTest.constraints.some(
            (value: any) => value.audio?.deviceId?.exact === id,
          ),
        physical,
      ),
    'selected input constraint',
  );
  await page.getByRole('button', { name: 'Open Comparison', exact: true }).click();
  const other = page.getByRole('textbox', { name: 'Message Comparison', exact: true });
  await other.waitFor();
  await until(
    async () =>
      await page.evaluate(() =>
        (window as any).speechTest.streams.every((stream: MediaStream) =>
          stream.getTracks().every((track) => track.readyState === 'ended'),
        ),
      ),
    'tracks released on chat switch',
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await other.innerText()).trim(), '');
  await page.getByRole('button', { name: 'Open Calendar', exact: true }).click();
  await editor.waitFor();
  await editor.fill('Keep this typed draft.');
  await page.evaluate(() => {
    (window as any).speechTest.deny = true;
  });
  await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Allow microphone access' }).waitFor();
  assert.equal(await editor.innerText(), 'Keep this typed draft.');
  await page.evaluate(() => {
    (window as any).speechTest.deny = false;
    (window as any).speechTest.events = [];
  });
  await editor.fill('Final prompt. ');
  await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
  await until(
    async () => /shopping/i.test(await editor.innerText()),
    'dictated prompt before send',
  );
  const sent = await editor.textContent();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(
    () => store.all('messages').some((message) => message.role === 'user'),
    'explicit send',
  );
  assert.equal(
    store.all('messages').find((message) => message.role === 'user')!.content,
    sent?.trim(),
  );
  await until(() => store.all('runs').every((run) => run.status !== 'running'), 'model reply');
  await until(
    async () =>
      await page.evaluate(() =>
        (window as any).speechTest.streams.every((stream: MediaStream) =>
          stream.getTracks().every((track) => track.readyState === 'ended'),
        ),
      ),
    'tracks released after send',
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await editor.innerText()).trim(), '');
  assert.deepEqual(errors, []);
  const updates = await page.evaluate(
    () =>
      (window as any).speechTest.events.filter((event: any) => event.type === 'transcript').length,
  );
  const verified = {
    verified: true,
    realWindowsRecognition: true,
    partialUpdates: updates,
    typedTextAndMentionsPreserved: true,
    selectedMicrophoneUsed: true,
    chatSwitchStopsCapture: true,
    permissionDenialPreservesDraft: true,
    sendsOnlyOnHumanAction: true,
    sendStopsCapture: true,
    errors,
  };
  await page.screenshot({ path: join(dir, 'dictated-message-sent.png') });
  writeFileSync(join(dir, 'verified.json'), JSON.stringify(verified, null, 2));
  console.log(JSON.stringify({ ...verified, directory: dir }));
} catch (error) {
  await page.screenshot({ path: join(dir, 'failure.png') });
  writeFileSync(join(dir, 'failure.txt'), await page.locator('body').innerText());
  throw error;
} finally {
  await app.close();
  for (const id of host.runtime.controllers.keys()) host.runtime.cancel(id);
  host.runtime.events.emit('shutdown');
  host.computer.dispose();
  host.google.cancelRun();
  await host.terminal.dispose();
  server.closeAllConnections();
  model.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => model.close(() => resolve())),
  ]);
  store.close();
}
