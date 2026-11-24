import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { seed } from '../apps/server/importer';
import { Store } from '../apps/server/store';
function fixture() {
  mkdirSync('test-results/unit', { recursive: true });
  return new Store(join(mkdtempSync(resolve('test-results/unit/starter-')), 'team.sqlite'));
}
test('a new installation starts with exactly one generic bot and no personal data or schedules', () => {
  const store = fixture();
  try {
    seed(store);
    assert.equal(store.all('bots').length, 1);
    assert.equal(store.all('bots')[0].name, 'First Bot');
    for (const collection of ['messages', 'memory', 'routines', 'pages', 'skills'] as const)
      assert.equal(store.all(collection).length, 0, collection);
    assert.equal(store.settings().localOnly, true);
    assert.ok(!JSON.stringify(store.export()).includes('Bryan'));
  } finally {
    store.close();
  }
});
test('starter initialization preserves an existing team and never resets edits', () => {
  const store = fixture();
  try {
    seed(store);
    const bot = store.all('bots')[0];
    store.put('bots', { ...bot, name: 'My custom bot', instructions: 'Keep this owner edit.' });
    store.put('bots', { ...bot, id: 'second', name: 'Second bot' });
    const before = store.export();
    seed(store, resolve('missing-private-reference'));
    assert.deepEqual(store.all('bots'), before.bots);
    assert.deepEqual(store.settings(), before.settings);
  } finally {
    store.close();
  }
});
