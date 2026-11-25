import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  providerTokenUsage,
  workTokenUsage,
  applyUsageUpdate,
} from '../packages/shared/token-usage';
import { readChatStream } from '../apps/server/chat-stream';
import { readAnthropicStream } from '../apps/server/anthropic-stream';
import { readResponsesStream } from '../apps/server/models';
import { TokenMeter } from '../apps/server/token-meter';
import type { WorkRecord, Run } from '../packages/shared/types';
import type { CompletionProgress } from '../apps/server/chat-stream';

const sse = (frames: unknown[]) =>
  new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
test('provider usage includes Claude cache input once and does not double-count OpenAI cached or reasoning tokens', () => {
  assert.deepEqual(
    providerTokenUsage(
      {
        input_tokens: 10,
        output_tokens: 12,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
      true,
    ),
    { total: 92, input: 80, output: 12, estimated: false },
  );
  assert.deepEqual(
    providerTokenUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 90 },
      completion_tokens_details: { reasoning_tokens: 18 },
    }),
    { total: 120, input: 100, output: 20, estimated: false },
  );
  assert.equal(providerTokenUsage({}), undefined);
  assert.deepEqual(
    workTokenUsage({ attempts: [{ calls: 1, tokens: 50, usageKnown: true }] } as WorkRecord),
    { total: 50, estimated: false },
  );
});

test('local stream counts output and tool arguments while never exposing reasoning text', async () => {
  const progress: CompletionProgress[] = [];
  const data = await readChatStream(
    sse([
      { choices: [{ delta: { reasoning_content: 'PRIVATE_THINKING'.repeat(20) } }] },
      { choices: [{ delta: { content: 'Hello' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'c1', function: { name: 'save', arguments: '{"a":1}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { usage: { prompt_tokens: 99, completion_tokens: 42, total_tokens: 141 }, choices: [] },
    ]),
    (snapshot) => progress.push(snapshot),
  );
  assert.ok(progress[0].outputTokens! > 0);
  assert.equal(data.usage.total_tokens, 141);
  assert.equal(progress.at(-1)?.usage?.output, 42);
  assert.ok(!JSON.stringify(progress).includes('PRIVATE_THINKING'));
  assert.ok(!JSON.stringify(data).includes('PRIVATE_THINKING'));
});

test('Anthropic streaming preserves tools and cumulative usage, counts hidden reasoning numerically and rejects interruptions', async () => {
  const progress: CompletionProgress[] = [];
  const frames = [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 30 } },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'PRIVATE_THOUGHT'.repeat(20) },
    },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello.' } },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'call', name: 'save' },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"note":"ok"}' },
    },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 88 } },
    { type: 'message_stop' },
  ];
  const result = await readAnthropicStream(sse(frames), (snapshot) => progress.push(snapshot));
  assert.deepEqual(progress.at(-1)?.usage, { input: 40, output: 88, total: 128, estimated: false });
  assert.deepEqual(result.content[1], {
    type: 'tool_use',
    id: 'call',
    name: 'save',
    input: { note: 'ok' },
  });
  assert.ok(progress[1].outputTokens! > 1);
  assert.ok(!JSON.stringify(progress).includes('PRIVATE_THOUGHT'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_THOUGHT'));
  await assert.rejects(readAnthropicStream(sse(frames.slice(0, -1))), /before completion/);
});

test('Responses streaming counts function arguments and switches to provider totals', async () => {
  const progress: CompletionProgress[] = [];
  await readResponsesStream(
    sse([
      { type: 'response.function_call_arguments.delta', delta: 'Some function argument text' },
      { type: 'response.output_text.delta', delta: 'Visible text' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [],
          usage: { input_tokens: 90, output_tokens: 20, total_tokens: 110 },
        },
      },
    ]),
    (snapshot) => progress.push(snapshot),
  );
  assert.ok(progress[0].outputTokens! > 0);
  assert.deepEqual(progress.at(-1)?.usage, { input: 90, output: 20, total: 110, estimated: false });
});

test('token meters reconcile live estimates, sum tool rounds once, and preserve interrupted usage', () => {
  const work = { id: 'w' } as WorkRecord;
  let updates = 0;
  const first = new TokenMeter(work, 100, () => updates++);
  first.observe({ text: 'hello', toolCalls: [], outputTokens: 9 });
  assert.equal(workTokenUsage(work)?.total, 109);
  first.finish({
    message: { role: 'assistant', content: 'Hello' },
    truncated: false,
    tokens: 113,
    usage: { input: 101, output: 12, total: 113, estimated: false },
  });
  first.finish();
  assert.equal(work.usage?.total, 113);
  assert.equal(work.liveUsage, undefined);
  const second = new TokenMeter(work, 150, () => updates++);
  second.observe({ text: '', toolCalls: [], outputTokens: 8 });
  second.finish();
  assert.equal(work.usage?.total, 271);
  assert.equal(work.usage?.estimated, true);
  assert.ok(updates >= 4);
  const run = { id: 'run', status: 'running', revision: 4, work: [work] } as Run;
  const patch = {
    type: 'usage' as const,
    runId: 'run',
    workId: 'w',
    revision: 5,
    usage: { total: 999, estimated: false },
  };
  const current = applyUsageUpdate(run, patch)!;
  assert.equal(current.work?.[0].usage?.total, 999);
  assert.equal(applyUsageUpdate(current, { ...patch, revision: 3 }), current);
  const parallel = applyUsageUpdate(
    { ...current, work: [...current.work!, { id: 'other' } as WorkRecord] },
    { ...patch, workId: 'other', revision: 4 },
  );
  assert.equal(
    parallel?.work?.find((work) => work.id === 'other')?.usage?.total,
    999,
    'Separate work counters cannot drop each other’s updates.',
  );
  assert.equal(applyUsageUpdate({ ...current, status: 'completed' }, patch)?.status, 'completed');
});
