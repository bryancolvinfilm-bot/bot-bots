import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('test-results/browser', { recursive: true });
const fixture = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    `<!doctype html><html><head><title>${req.url === '/article' ? 'Research fixture' : 'Browser fixture'}</title><style>body{font:20px system-ui;padding:35px;background:#eff4ef;color:#183321}input,button{font:inherit;padding:10px;margin:8px 0}a{color:#20642d}</style></head><body>${req.url === '/article' ? '<h1>Verified source</h1><p>The launch code is Cobalt Meadow 73. This is the actual page text, not model memory.</p><a href="/">Back to browser fixture</a>' : '<h1>A browser your bots can use</h1><p id="answer">Ready for human help.</p><label>Name <input aria-label="Your name" id="name"></label><br><button onclick="document.getElementById(\'answer\').textContent=\'Hello, \'+document.getElementById(\'name\').value">Show greeting</button><p><a href="/article">Open research source</a></p>'}</body></html>`,
  );
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const app = await electron.launch({
  args: process.env.BOT_BOTS_TEST_EXECUTABLE ? [] : ['.'],
  executablePath: process.env.BOT_BOTS_TEST_EXECUTABLE,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    BOT_BOTS_DATA_DIR: resolve(`test-results/browser/team-${Date.now()}`),
    BOT_BOTS_DESKTOP_PORT: '0',
    BOT_BOTS_BROWSER_TEST_ORIGIN: origin,
  },
  timeout: 30000,
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('heading', { name: 'Good things happen together.' }).waitFor();
  assert.equal(await page.evaluate(() => !!window.botBotsComputer), true);
  async function api(path, method = 'GET', body) {
    return page.evaluate(
      async ({ path, method, body }) => {
        const response = await fetch(`/api${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: response.status, body: await response.json() };
      },
      { path, method, body },
    );
  }
  async function waitRun(id, ready, timeout = 180000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const current = (await api(`/runs/${id}`)).body;
      if (ready(current)) return current;
      await page.waitForTimeout(250);
    }
    throw new Error(`Run timed out: ${id}`);
  }
  await page.getByRole('button', { name: 'Toggle computer panel' }).click();
  await page.getByRole('complementary', { name: 'Computer workspace' }).waitFor();
  await page.getByLabel('Browser address or search').fill(origin);
  await page.getByRole('button', { name: 'Go to browser address' }).click();
  await page.getByRole('tab', { name: /You Browser fixture/ }).waitFor();
  const state = (await api('/computer')).body;
  const tabId = state.activeTabId;
  const read = async () =>
    (await api('/computer/action', 'POST', { tabId, action: { kind: 'read' } })).body;
  let snapshot = await read();
  assert.match(snapshot.text, /Ready for human help/);
  const input = snapshot.elements.find((e) => e.label === 'Your name');
  await api('/computer/action', 'POST', {
    tabId,
    action: { kind: 'type', ref: input.ref, text: 'Teammate' },
  });
  snapshot = await read();
  const stale = input.ref;
  const button = snapshot.elements.find((e) => e.label === 'Show greeting');
  const clicked = await api('/computer/action', 'POST', {
    tabId,
    action: { kind: 'click', ref: button.ref },
  });
  assert.match(clicked.body.text, /Hello, Teammate/);
  const viewState = await app.evaluate(({ BrowserWindow }, origin) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find((v) =>
      v.webContents?.getURL().startsWith(origin),
    );
    return view ? { visible: view.getVisible(), bounds: view.getBounds() } : undefined;
  }, origin);
  assert.equal(viewState?.visible, true, JSON.stringify(viewState));
  assert.ok(viewState.bounds.width > 250);
  assert.notEqual(
    (await api('/computer/action', 'POST', { tabId, action: { kind: 'click', ref: stale } }))
      .status,
    200,
  );
  const security = await app.evaluate(async ({ webContents }, origin) => {
    const wc = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(origin));
    return wc.executeJavaScript('({node:typeof process,bridge:typeof window.botBotsComputer})');
  }, origin);
  assert.deepEqual(security, { node: 'undefined', bridge: 'undefined' });
  const blocked = await api('/computer/action', 'POST', {
    tabId,
    action: { kind: 'open', url: 'http://127.0.0.1:1234/v1/models' },
  });
  assert.notEqual(blocked.status, 200);
  const captured = await api(`/computer/tabs/${tabId}/capture`);
  assert.match(captured.body.image, /^data:image\/png;base64,/);
  writeFileSync(
    'test-results/browser/browser-page.png',
    Buffer.from(captured.body.image.split(',')[1], 'base64'),
  );
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.getByRole('button', { name: 'Resume bots', exact: true }).waitFor();
  const run = (
    await api('/runs', 'POST', {
      botId: 'research',
      prompt: `Use browser_open to read ${origin}/article and tell me the exact launch code from the page. Cite that URL. This is an explicitly allowed local browser test page. Do not use web_search and do not delegate.`,
    })
  ).body;
  await waitRun(
    run.id,
    (current) =>
      current.events.some((e) => e.tool === 'browser_open') || current.status !== 'running',
  );
  assert.equal((await api(`/runs/${run.id}`)).body.status, 'running');
  // Human actions must not deadlock behind a paused bot command.
  const researchTab = (await api('/computer')).body.tabs.find((t) => t.botId === 'research');
  assert.ok(researchTab, 'Research owns a separate tab');
  const assisted = await api('/computer/action', 'POST', {
    tabId: researchTab.id,
    action: { kind: 'open', url: origin },
  });
  assert.equal(assisted.status, 200, JSON.stringify(assisted.body));
  assert.match(assisted.body.text, /Ready for human help/);
  await page.getByRole('button', { name: 'Resume bots', exact: true }).click();
  await waitRun(run.id, (current) => current.status !== 'running');
  const completed = (await api(`/runs/${run.id}`)).body;
  assert.equal(completed.status, 'completed', completed.error);
  assert.ok(completed.events.some((e) => e.tool === 'browser_open' && e.text.includes('/article')));
  const messages = (await api(`/conversations/${completed.conversationId}/messages`)).body;
  assert.match(messages.at(-1).content, /Cobalt Meadow 73/);
  assert.match(messages.at(-1).content, /\/article/);
  const image = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL(),
  );
  writeFileSync(
    'test-results/browser/computer-native.png',
    Buffer.from(image.split(',')[1], 'base64'),
  );
  await page.getByRole('button', { name: 'Close computer', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: 'Toggle computer panel' }).getAttribute('aria-expanded'),
    'false',
  );
  // A real public search smoke test, entirely on the local Qwen model.
  const searched = (
    await api('/runs', 'POST', {
      botId: 'research',
      prompt:
        'Use web_search for Electron WebContentsView official documentation. Return one actual official documentation URL from the search results. Do not delegate. If a search challenge blocks you, state that honestly.',
    })
  ).body;
  await waitRun(searched.id, (current) => current.status !== 'running', 240000);
  const searchDone = (await api(`/runs/${searched.id}`)).body;
  const searchMessages = (await api(`/conversations/${searched.conversationId}/messages`)).body;
  const searchState = (await api('/computer')).body;
  const observedSearch = await api('/computer/action', 'POST', {
    tabId: searchState.activeTabId,
    action: { kind: 'read' },
  });
  writeFileSync(
    'test-results/browser/search-debug.json',
    JSON.stringify({ state: searchState, snapshot: observedSearch.body }, null, 2),
  );
  if (!searchDone.events.some((e) => e.tool === 'web_search' && e.text.includes('result links'))) {
    console.log(
      JSON.stringify({ state: searchState, text: observedSearch.body.text?.slice(0, 500) }),
    );
    for (const url of [
      'https://www.google.com/search?q=Electron+WebContentsView',
      'https://www.bing.com/search?q=Electron+WebContentsView',
      'https://search.brave.com/search?q=Electron+WebContentsView',
    ]) {
      const probe = await api('/computer/action', 'POST', {
        tabId: searchState.activeTabId,
        action: { kind: 'open', url },
      });
      console.log(
        JSON.stringify({
          url,
          status: probe.status,
          title: probe.body.title,
          text: probe.body.text?.slice(0, 1200),
          error: probe.body.error,
          elements: probe.body.elements?.slice(0, 5),
        }),
      );
    }
  }
  assert.equal(searchDone.status, 'completed', searchDone.error);
  assert.ok(
    searchDone.events.some((e) => e.tool === 'web_search' && e.text.includes('result links')),
    JSON.stringify(searchDone.events),
  );
  assert.match(searchMessages.at(-1).content, /electronjs\.org/);
  await page.getByRole('button', { name: 'Toggle computer panel' }).click();
  const liveImage = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL(),
  );
  writeFileSync(
    'test-results/browser/web-search-native.png',
    Buffer.from(liveImage.split(',')[1], 'base64'),
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    'test-results/browser/results.json',
    JSON.stringify(
      {
        passed: true,
        model: 'qwen/qwen3.5-9b',
        browserRun: completed.id,
        searchRun: searchDone.id,
        checks: [
          'native Chromium panel',
          'human type and click',
          'fresh DOM refs',
          'isolated web content',
          'local endpoint protection',
          'capture for remote clients',
          'human takeover without deadlock',
          'real Qwen reads and cites a browser page',
          'real public web search',
          'toggle panel',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'Chromium computer verification passed, including real Qwen browsing and public web search.',
  );
} finally {
  await app.close();
  await new Promise((r) => fixture.close(r));
}
