import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BotMessage } from '../apps/web/src/BotMentions';
import { humanHandoffs } from '../packages/shared/delivery';
import { mentionQuery, plainMentionText } from '../packages/shared/mentions';
import { classifyTask } from '../packages/shared/model-routing';
import type { Bot } from '../packages/shared/types';

const bots: Bot[] = [
  {
    id: 'research',
    name: 'Research',
    title: 'Researcher',
    description: '',
    instructions: '',
    avatar: { shape: 'cat', color: '#da7bdf', accent: '#30342e' },
    enabled: true,
    modelId: null,
  },
];

test('large malformed pasted text cannot trigger quadratic mention or task matching', () => {
  const start = performance.now();
  const brackets = '['.repeat(100000);
  assert.deepEqual(
    humanHandoffs(`${brackets}\nTell @Research to find sources.`, bots).map((item) => item.botId),
    ['research'],
  );
  assert.equal(plainMentionText(brackets), brackets);
  assert.equal(classifyTask('build '.repeat(20000)), 'general');
  assert.equal(classifyTask('find '.repeat(20000)), 'general');
  assert.ok(performance.now() - start < 1500, 'Large text matching should finish promptly');
});

test('mention suggestions work at the end of a large document and respect email boundaries', () => {
  const prefix = 'some pasted text\n'.repeat(10000);
  const draft = `${prefix}@Rese`;
  assert.equal(mentionQuery(draft, draft.length, bots)?.bots[0].id, 'research');
  const email = `${prefix}x@Rese`;
  assert.equal(mentionQuery(email, email.length, bots), undefined);
});

test('very large chat messages show a bounded text preview with access to the complete message', () => {
  const content = '['.repeat(1000000);
  const start = performance.now();
  const markup = renderToStaticMarkup(
    createElement(BotMessage, { content, bots, openBot: () => {} }),
  );
  assert.match(markup, /Read complete message \(1,000,000 characters\)/);
  assert.ok(markup.includes('['.repeat(8000)));
  assert.ok(markup.length < 10000);
  assert.ok(
    performance.now() - start < 1000,
    'Large message preview should avoid parsing the full markdown document',
  );
});
