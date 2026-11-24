import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Computer, type BrowserDriver } from '../apps/server/computer';
import { browserUrl, checkBrowserUrl, publicAddress } from '../apps/server/browser-policy';
import type { BrowserSnapshot, BrowserTab } from '../packages/shared/computer';

function driver(): BrowserDriver & { actions: string[] } {
  const tabs: BrowserTab[] = [],
    actions: string[] = [];
  return {
    actions,
    tabs: () => tabs,
    create: (t) => {
      tabs.push(t);
    },
    select: () => {},
    close: (id) => {
      tabs.splice(
        tabs.findIndex((t) => t.id === id),
        1,
      );
    },
    dispose: () => {
      tabs.length = 0;
    },
    capture: async () => ({ image: 'data:image/png;base64,', width: 100, height: 100 }),
    act: async (id, action) => {
      actions.push(`${id}:${action.kind}`);
      return {
        tabId: id,
        title: 'Observed page',
        url: 'https://example.com/',
        text: 'Actual fixture content',
        elements: [],
      };
    },
  };
}
test('browser policy blocks local APIs, metadata, credentials and non-web schemes', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.1.1',
    '::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('1.1.1.1'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const url of [
    'file:///C:/secrets',
    'javascript:alert(1)',
    'data:text/html,hello',
    'https://user:secret@example.com',
  ])
    assert.throws(() => browserUrl(url));
  for (const url of [
    'http://127.1:1234/v1/models',
    'http://169.254.169.254/',
    'http://localhost:3211/api/export',
    'http://host.local/',
  ])
    await assert.rejects(checkBrowserUrl(url));
  assert.equal(
    await checkBrowserUrl('http://127.0.0.1:4567/test', 'http://127.0.0.1:4567'),
    'http://127.0.0.1:4567/test',
  );
  await assert.rejects(checkBrowserUrl('http://127.0.0.1:4568/test', 'http://127.0.0.1:4567'));
});
test('concurrent bots and handoffs get separate tabs, then reuse idle tabs after a run', () => {
  const browser = driver(),
    computer = new Computer(browser);
  const a = computer.botTab('research', 'run-a'),
    b = computer.botTab('research', 'run-b');
  const child = computer.botTab('research', 'run-a', 'handoff');
  assert.notEqual(a, b);
  assert.notEqual(a, child);
  assert.equal(computer.botTab('research', 'run-a'), a);
  computer.releaseRun('run-a');
  assert.equal(computer.botTab('research', 'run-c'), a);
  assert.equal(computer.state().tabs.length, 3);
  computer.closeTab(child);
  assert.equal(computer.state().tabs.length, 2);
  computer.dispose();
  assert.equal(browser.tabs().length, 0);
});
test('taking control pauses bots without blocking human actions, and cancellation releases waiters', async () => {
  const browser = driver(),
    computer = new Computer(browser),
    tab = computer.create();
  computer.setPaused(true);
  const controller = new AbortController();
  const waiting = computer.act(tab.id, { kind: 'read' }, 'bot', controller.signal);
  await computer.act(tab.id, { kind: 'open', url: 'https://example.com/' }, 'human');
  assert.deepEqual(browser.actions, [`${tab.id}:open`]);
  computer.setPaused(false);
  await waiting;
  assert.deepEqual(browser.actions, [`${tab.id}:open`, `${tab.id}:read`]);
  computer.setPaused(true);
  const next = computer.act(tab.id, { kind: 'read' }, 'bot', controller.signal);
  controller.abort(new Error('Cancelled test job'));
  await assert.rejects(next, /Cancelled/);
  assert.equal(computer.events.listenerCount('control'), 0);
  computer.dispose();
});
test('search returns observed source links and tries another engine when no results can be read', async () => {
  const browser = driver();
  let calls = 0;
  browser.act = async (id, action): Promise<BrowserSnapshot> => ({
    tabId: id,
    title: 'Results',
    url: 'https://search.example/',
    text: 'Search page',
    elements:
      (action.kind === 'open' ? ++calls : calls) === 1
        ? []
        : [
            {
              ref: 'observed-e1',
              tag: 'a',
              label: 'Observed source title',
              href: 'https://example.com/source',
            },
          ],
  });
  const computer = new Computer(browser),
    tab = computer.create();
  const found = await computer.search(tab.id, 'search query');
  assert.equal(calls, 2);
  assert.equal(found.results[0].url, 'https://example.com/source');
  browser.act = async (id) => ({
    tabId: id,
    title: 'Challenge',
    url: 'https://search.example/',
    text: 'Please verify',
    elements: [],
  });
  await assert.rejects(computer.search(tab.id, 'blocked query'), /needs help/);
  computer.dispose();
});
test('a headless host reports browser capability honestly until a driver is attached', () => {
  const computer = new Computer();
  assert.equal(computer.state().available, false);
  assert.equal(computer.state().engine, 'unavailable');
  assert.throws(() => computer.create(), /no browser adapter/);
  computer.dispose();
});
