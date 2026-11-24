import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ClaudeCode } from '../apps/server/claude-code';
function fixture() {
  mkdirSync('test-results/unit', { recursive: true });
  return new ClaudeCode(mkdtempSync(resolve('test-results/unit/claude-code-')));
}
test('Claude Code installs only a checksum-matching official binary and does not sign in during installation', async () => {
  const previous = global.fetch,
    claude = fixture(),
    bytes = Buffer.from('unmodified-test-binary');
  let requests = 0;
  global.fetch = (async (input) => {
    const url = String(input);
    assert.ok(url.startsWith('https://downloads.claude.ai/claude-code-releases/'));
    requests++;
    return new Response(
      url.endsWith('/latest')
        ? '1.2.3'
        : url.endsWith('/manifest.json')
          ? JSON.stringify({
              platforms: {
                [`${process.platform}-${process.arch}`]: {
                  checksum: createHash('sha256').update(bytes).digest('hex'),
                },
              },
            })
          : bytes,
    );
  }) as typeof fetch;
  try {
    await claude.install();
    assert.equal(requests, 3);
    assert.deepEqual(readFileSync(claude.binary), bytes);
    await claude.install();
    assert.equal(requests, 3);
  } finally {
    global.fetch = previous;
  }
});
test('a damaged Claude Code download is rejected before it can become an executable', async () => {
  const previous = global.fetch,
    claude = fixture();
  global.fetch = (async (input) =>
    new Response(
      String(input).endsWith('/latest')
        ? '1.2.3'
        : String(input).endsWith('/manifest.json')
          ? JSON.stringify({
              platforms: { [`${process.platform}-${process.arch}`]: { checksum: '0'.repeat(64) } },
            })
          : 'damaged',
    )) as typeof fetch;
  try {
    await assert.rejects(claude.install(), /checksum/);
    assert.equal(existsSync(claude.binary), false);
  } finally {
    global.fetch = previous;
  }
});
test('Claude browser-login inference preserves bot tool requests, disables native host tools, and rejects invented actions', async () => {
  const claude = fixture();
  writeFileSync(claude.binary, 'test');
  let invented = false;
  const calls: { args: string[]; input: string }[] = [];
  (claude as any).run = async (args: string[], input: string) => {
    if (args[0] === 'auth')
      return { code: 0, output: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) };
    calls.push({ args, input });
    return {
      code: 0,
      output: JSON.stringify({
        structured_output: {
          text: '',
          calls: [{ name: invented ? 'Bash' : 'save_note', arguments: '{"text":"hello"}' }],
        },
        usage: {
          input_tokens: 10,
          output_tokens: 12,
          cache_creation_input_tokens: 40,
          cache_read_input_tokens: 30,
        },
      }),
    };
  };
  const tools = [
    {
      type: 'function',
      function: {
        name: 'save_note',
        description: 'Save a note',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
      },
    },
  ];
  const result = await claude.complete(
    'haiku',
    [
      { role: 'system', content: 'Only follow this bot’s duties.' },
      { role: 'user', content: 'Save hello.' },
    ],
    tools,
    1000,
    new AbortController().signal,
    'high',
  );
  assert.equal(result.message.tool_calls![0].function.name, 'save_note');
  assert.equal(result.tokens, 92);
  assert.ok(calls[0].input.includes('Only follow this bot'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--tools') + 1], '');
  assert.equal(calls[0].args[calls[0].args.indexOf('--effort') + 1], 'high');
  assert.equal(calls[0].args.includes('--dangerously-skip-permissions'), false);
  invented = true;
  await assert.rejects(
    claude.complete('haiku', [], tools, 1000, new AbortController().signal),
    /unavailable bot function/,
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(claude.complete('haiku', [], tools, 1000, cancelled.signal));
});
