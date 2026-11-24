import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import { BotMessage } from '../apps/web/src/BotMentions';
import { previewHtml, PREVIEW_POLICY, filenameFor } from '../packages/shared/artifacts';
test('code displays escaped syntax highlighting, copy/download controls and a preview without executing in chat', () => {
  const markup = renderToStaticMarkup(
    createElement(BotMessage, {
      content: '```html\n<button onclick="alert(1)">Play</button>\n```',
      bots: [],
      openBot: () => {},
    }),
  );
  assert.match(markup, /hljs-name/);
  assert.match(markup, /Copy code/);
  assert.match(markup, /Download/);
  assert.match(markup, />Preview</);
  assert.ok(!markup.includes('<button onclick="alert(1)">Play</button>'));
  const shell = renderToStaticMarkup(
    createElement(BotMessage, {
      content: '```powershell\nWrite-Output "Safe command"\n```',
      bots: [],
      openBot: () => {},
    }),
  );
  assert.match(shell, /Paste into terminal/);
  assert.ok(!shell.includes('Approve once'));
});
test('preview restrictions precede generated HTML and filenames match actual script types', () => {
  const html = previewHtml('<script>document.body.dataset.ready="yes"</script>');
  assert.ok(html.indexOf(PREVIEW_POLICY) < html.indexOf('document.body'));
  assert.match(PREVIEW_POLICY, /connect-src 'none'/);
  assert.match(PREVIEW_POLICY, /form-action 'none'/);
  assert.equal(filenameFor('powershell', 'My command'), 'My-command.ps1');
  assert.equal(filenameFor('python'), 'generated.py');
});
