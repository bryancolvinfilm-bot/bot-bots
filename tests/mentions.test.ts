import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import { BotMessage } from '../apps/web/src/BotMentions';
import {
  mentionMarkdown,
  mentionQuery,
  plainMentionText,
  splitBotMentions,
} from '../packages/shared/mentions';
import type { Bot } from '../packages/shared/types';

const makeBot = (id: string, name: string): Bot => ({
  id,
  name,
  title: 'A teammate',
  description: '',
  instructions: '',
  avatar: { shape: 'cat', color: '#da7bdf', accent: '#30342e' },
  modelId: null,
  enabled: true,
});
const bots = [
  makeBot('research', 'Research'),
  makeBot('boss-man', 'Boss Man'),
  makeBot('worker1', 'Worker1'),
  makeBot('worker10', 'Worker10'),
  makeBot('special', 'R&D (2)+'),
];

test('mentions resolve names, compact names, slugs, and punctuation without matching emails or partial names', () => {
  const parts = splitBotMentions(
    'Ask @RESEARCH, @bossman and @Boss-Man; @Worker10 + @R&D (2)+. Email me@Research.test; leave @Worker100 and @unknown alone.',
    bots,
  );
  assert.deepEqual(
    parts.filter((p) => p.type === 'mention').map((p) => p.bot.id),
    ['research', 'boss-man', 'boss-man', 'worker10', 'special'],
  );
  assert.equal(
    parts.map((p) => p.text).join(''),
    'Ask @RESEARCH, @bossman and @Boss-Man; @Worker10 + @R&D (2)+. Email me@Research.test; leave @Worker100 and @unknown alone.',
  );
});
test('mention completion follows the caret, accepts spaced names, and ignores email addresses', () => {
  assert.equal(
    plainMentionText('Ask [@Research](#bot/research) for help'),
    'Ask @Research for help',
  );
  assert.equal(mentionQuery('Please ask @Boss M', 18, bots)?.bots[0].id, 'boss-man');
  assert.equal(mentionQuery('x@rese', 6, bots), undefined);
  assert.equal(mentionQuery('Hello @rese and more', 11, bots)?.bots[0].id, 'research');
  assert.equal(mentionQuery('Hello @unknown', 14, bots), undefined);
});
test('sent mentions render avatar/color buttons, preserve stable IDs through renames, and leave code and existing links alone', () => {
  const content = `Ask @Research. ${mentionMarkdown('boss-man', '@Boss Man')}\n\n\`@Worker1\` and [@Worker10](https://example.invalid).\n\n\`\`\`text\n@Research\n\`\`\``;
  const markup = renderToStaticMarkup(
    createElement(BotMessage, {
      content,
      bots: bots.map((b) => (b.id === 'boss-man' ? { ...b, name: 'New Boss' } : b)),
      openBot: () => {},
    }),
  );
  assert.equal((markup.match(/class="bot-mention"/g) ?? []).length, 2);
  assert.match(markup, /Open New Boss&#x27;s space/);
  assert.match(markup, /--mention-color:#da7bdf/);
  assert.match(markup, /<svg/);
  assert.match(markup, /<code>@Worker1<\/code>/);
  assert.match(markup, /<a href="https:\/\/example.invalid">@Worker10<\/a>/);
});
