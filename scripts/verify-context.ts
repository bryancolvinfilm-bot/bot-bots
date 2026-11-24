import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../apps/server/store';
import { seedTestTeam as seed } from '../tests/fixtures/team';
import { candidates, complete, refreshLocalModels } from '../apps/server/models';
import { effectiveContext } from '../packages/shared/model-routing';

mkdirSync('test-results/discovery', { recursive: true });
const dir = mkdtempSync(resolve('test-results/discovery/context-'));
const store = new Store(join(dir, 'team.sqlite'));
try {
  seed(store, resolve('reference/grok-backup'));
  await refreshLocalModels(store);
  const model = candidates(store, 'general').find(
    (m) => m.status === 'online' && m.loadState === 'loaded',
  );
  assert.ok(model, 'Load a local model before running this check.');
  assert.ok(
    effectiveContext(model) >= 98304,
    'This large-context check requires at least 96K loaded context.',
  );
  const provider = store.get('providers', model.providerId)!;
  const content =
    'Ignore the repetitive test data below. After it, reply only CONTEXT_READY.\n<test-data>\n' +
    'a b c d e f g h i j '.repeat(5500) +
    '\n</test-data>\nReply only CONTEXT_READY. Use no tools.';
  console.log(
    JSON.stringify({
      model: model.name,
      context: effectiveContext(model),
      promptCharacters: content.length,
      estimatedTokens: Math.ceil(content.length / 3),
    }),
  );
  const start = Date.now();
  const result = await complete(
    { ...provider, timeoutMs: 300000 },
    model,
    [
      {
        role: 'system',
        content:
          'You are helping verify a local context configuration. Follow the final instruction.',
      },
      { role: 'user', content },
    ],
    [],
    32,
    AbortSignal.timeout(300000),
  );
  assert.ok(
    (result.tokens ?? 0) > 32768,
    'Provider usage must demonstrate a real request above the old 32K cap.',
  );
  assert.match(result.message.content ?? '', /CONTEXT_READY/);
  const evidence = {
    model: model.name,
    loadedContextTokens: model.loadedContextTokens,
    totalTokens: result.tokens,
    elapsedMs: Date.now() - start,
    reply: result.message.content,
  };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  store.close();
}
