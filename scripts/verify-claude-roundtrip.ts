import assert from 'node:assert/strict';
import { ClaudeCode } from '../apps/server/claude-code';
import { resolve } from 'node:path';
const claude = new ClaudeCode(resolve('data/claude-code'));
const result = await claude.complete(
  'haiku',
  [
    {
      role: 'system',
      content:
        'You are a verification bot. Follow the current task using only the supplied Bot-Bots functions.',
    },
    {
      role: 'user',
      content:
        'Request the record_probe function with value TEAM_SPACE_CHECK. Do not claim it ran.',
    },
  ],
  [
    {
      type: 'function',
      function: {
        name: 'record_probe',
        description: 'Record a test marker',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    },
  ],
  1500,
  AbortSignal.timeout(90000),
);
assert.equal(result.message.tool_calls?.[0]?.function.name, 'record_probe');
assert.equal(
  JSON.parse(result.message.tool_calls![0].function.arguments).value,
  'TEAM_SPACE_CHECK',
);
console.log(
  JSON.stringify({
    realClaudeRoundtrip: true,
    toolBridgeVerified: true,
    toolRequested: 'record_probe',
    nativeToolsDisabled: true,
    externalActionsExecuted: false,
    tokens: result.tokens,
  }),
);
