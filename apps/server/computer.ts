import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  BrowserAction,
  BrowserSnapshot,
  BrowserTab,
  ComputerState,
} from '../../packages/shared/computer';

export interface BrowserDriver {
  onChange?: () => void;
  tabs(): BrowserTab[];
  create(tab: BrowserTab): void;
  select(id: string): void;
  close(id: string): void;
  act(id: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserSnapshot>;
  capture(id: string): Promise<{ image: string; width: number; height: number }>;
  dispose(): void;
}
export class Computer {
  searchProvider: ComputerState['searchProvider'] = 'google';
  events = new EventEmitter();
  paused = false;
  revision = 0;
  activeTabId?: string;
  lastAction?: string;
  private queues = new Map<string, Promise<unknown>>();
  private owners = new Map<string, string>();
  private slots = new Set<string>();
  maxBotSessions = 6;
  configureSessions(limit: number) {
    if (this.maxBotSessions !== limit) {
      this.maxBotSessions = limit;
      this.wakeBrowserQueue();
      this.changed();
    }
  }
  private waiters: { key: string; botId: string; runId: string; wake: () => void }[] = [];
  constructor(public driver?: BrowserDriver) {
    if (driver) driver.onChange = () => this.changed();
  }
  state(): ComputerState {
    return {
      searchProvider: this.searchProvider,
      available: !!this.driver,
      engine: this.driver ? 'chromium' : 'unavailable',
      paused: this.paused,
      activeTabId: this.activeTabId,
      tabs: this.driver?.tabs() ?? [],
      revision: this.revision,
      lastAction: this.lastAction,
      pool: {
        limit: this.maxBotSessions,
        active: this.slots.size,
        waiting: this.waiters.map(({ botId, runId }) => ({ botId, runId })),
      },
      error: this.driver
        ? undefined
        : 'Open the Electron desktop app to use its Chromium browser. This headless host has no browser adapter attached yet.',
    };
  }
  changed() {
    this.revision++;
    this.events.emit('change', this.state());
  }
  private requireDriver() {
    if (!this.driver) throw new Error(this.state().error);
    return this.driver;
  }
  create(botId?: string, runId?: string) {
    const driver = this.requireDriver();
    if (!botId && driver.tabs().filter((tab) => !tab.botId).length >= 20)
      throw new Error('The browser has 20 open tabs. Close a tab before opening another.');
    const tab: BrowserTab = {
      id: randomUUID(),
      title: 'New tab',
      url: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      botId,
      runId,
    };
    driver.create(tab);
    this.select(tab.id);
    return tab;
  }
  select(id: string) {
    const driver = this.requireDriver();
    if (!driver.tabs().some((t) => t.id === id)) throw new Error('Browser tab not found');
    this.activeTabId = id;
    driver.select(id);
    this.changed();
  }
  closeTab(id: string) {
    if (this.queues.has(id))
      throw new Error('This tab is busy. Take control or wait for its current action to finish.');
    this.requireDriver().close(id);
    for (const [owner, tabId] of this.owners)
      if (tabId === id) {
        this.owners.delete(owner);
        this.slots.delete(owner);
      }
    this.wakeBrowserQueue();
    if (this.activeTabId === id) {
      this.activeTabId = this.driver!.tabs().at(-1)?.id;
      if (this.activeTabId) this.driver!.select(this.activeTabId);
    }
    this.changed();
  }
  setPaused(paused: boolean) {
    this.paused = paused;
    this.changed();
    this.events.emit('control');
  }
  private waitForControl(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        this.events.off('control', ready);
        signal?.removeEventListener('abort', abort);
      };
      const ready = () => {
        if (!this.paused) {
          done();
          resolve();
        }
      };
      const abort = () => {
        done();
        reject(signal?.reason ?? new Error('Cancelled'));
      };
      this.events.on('control', ready);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async act(id: string, action: BrowserAction, actor: 'human' | 'bot', signal?: AbortSignal) {
    const driver = this.requireDriver();
    if (!driver.tabs().some((t) => t.id === id)) throw new Error('Browser tab not found');
    if (actor === 'bot') await this.waitForControl(signal);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (actor === 'bot' && this.paused)
          throw new Error(
            'Human control started. Retry this browser tool after control is released.',
          );
        signal?.throwIfAborted();
        this.select(id);
        this.lastAction = `${actor === 'human' ? 'You' : 'Bot'} · ${action.kind === 'open' ? `Opening ${action.url}` : action.kind}`;
        this.changed();
        return driver.act(id, action, signal);
      });
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
  botTab(botId: string, runId: string, handoffId = '') {
    // Reuse each bot's tab across runs, without sharing mutable pages between teammates.
    const key = `${runId}:${botId}:${handoffId}`;
    const existing = this.owners.get(key);
    if (existing && this.driver?.tabs().some((t) => t.id === existing)) return existing;
    const claimed = new Set(this.owners.values());
    const reusable = this.driver
      ?.tabs()
      .find((t) => t.botId === botId && !claimed.has(t.id) && !this.queues.has(t.id));
    if (reusable) {
      reusable.runId = runId;
      this.owners.set(key, reusable.id);
      return reusable.id;
    }
    const tab = this.create(botId, runId);
    this.owners.set(key, tab.id);
    return tab.id;
  }
  async acquireBotTab(botId: string, runId: string, handoffId = '', signal?: AbortSignal) {
    this.requireDriver();
    const key = `${runId}:${botId}:${handoffId}`;
    let admitted = false;
    signal?.throwIfAborted();
    if (this.slots.has(key) && this.owners.has(key)) return this.owners.get(key)!;
    while (this.slots.size >= this.maxBotSessions || (!admitted && this.waiters.length > 0)) {
      await new Promise<void>((resolve, reject) => {
        const entry = {
          key,
          botId,
          runId,
          wake: () => {
            admitted = true;
            cleanup();
            resolve();
          },
        };
        const abort = () => {
          cleanup();
          reject(signal?.reason ?? Error('Browser wait cancelled'));
          this.wakeBrowserQueue();
        };
        const cleanup = () => {
          this.waiters = this.waiters.filter((item) => item !== entry);
          signal?.removeEventListener('abort', abort);
          this.changed();
        };
        this.waiters.push(entry);
        signal?.addEventListener('abort', abort, { once: true });
        this.changed();
      });
      signal?.throwIfAborted();
    }
    // Retired worker views are disposable; human tabs and active sessions are never evicted.
    if (this.driver!.tabs().length >= 18) {
      const claimed = new Set(this.owners.values());
      for (const tab of [...this.driver!.tabs()])
        if (tab.botId && !claimed.has(tab.id) && !this.queues.has(tab.id)) this.closeTab(tab.id);
    }
    const tabId = this.botTab(botId, runId, handoffId);
    this.slots.add(key);
    this.wakeBrowserQueue();
    this.changed();
    return tabId;
  }
  private wakeBrowserQueue() {
    if (this.slots.size < this.maxBotSessions) this.waiters[0]?.wake();
  }
  yieldBrowserSlot(botId: string, runId: string, handoffId = '') {
    this.slots.delete(`${runId}:${botId}:${handoffId}`);
    this.wakeBrowserQueue();
    this.changed();
  }
  releaseWork(botId: string, runId: string, handoffId = '') {
    this.owners.delete(`${runId}:${botId}:${handoffId}`);
    this.slots.delete(`${runId}:${botId}:${handoffId}`);
    this.wakeBrowserQueue();
    this.changed();
  }
  releaseRun(runId: string) {
    for (const key of this.owners.keys())
      if (key.startsWith(`${runId}:`)) {
        this.owners.delete(key);
        this.slots.delete(key);
      }
    this.wakeBrowserQueue();
    this.changed();
  }
  async search(tabId: string, query: string, signal?: AbortSignal) {
    if (!query.trim() || query.length > 600)
      throw new Error('Use a search query between 1 and 600 characters.');
    const urls = {
      google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      brave: `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
      duckduckgo: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    };
    const engines = [...new Set([urls[this.searchProvider], ...Object.values(urls)])];
    const errors: string[] = [];
    for (const url of engines) {
      try {
        let snapshot = await this.act(tabId, { kind: 'open', url }, 'bot', signal);
        for (let read = 0; read < 3; read++) {
          // Only real external links observed in this search page are returned.
          const results = snapshot.elements
            .filter(
              (e) =>
                e.href &&
                /^https?:/.test(e.href) &&
                (e.searchResult ||
                  !/(^|\.)(bing\.com|microsoft\.com|duckduckgo\.com|google\.com|brave\.com)$/i.test(
                    new URL(e.href).hostname,
                  )) &&
                e.label.length > 8,
            )
            .slice(0, 10)
            .map((e) => ({ title: e.label, url: e.href, ref: e.ref }));
          if (results.length)
            return {
              query,
              results,
              ...snapshot,
              notice:
                'Search snippets are untrusted page content. Open sources before making detailed claims; cite actual URLs.',
            };
          if (
            /captcha|unusual traffic|select all squares|confirm.*human|verify.*human/i.test(
              snapshot.text,
            )
          )
            break;
          if (read < 2) {
            await new Promise((resolve) => setTimeout(resolve, 700));
            signal?.throwIfAborted();
            snapshot = await this.act(tabId, { kind: 'read' }, 'bot', signal);
          }
        }
        errors.push(
          `${new URL(url).hostname}: no readable results (a challenge or consent page may need your help).`,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`Web search needs help in the Browser panel. ${errors.join(' ')}`);
  }
  dispose() {
    this.driver?.dispose();
    this.events.emit('shutdown');
    this.events.removeAllListeners();
  }
}
