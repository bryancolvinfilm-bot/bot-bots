import { BrowserWindow, WebContentsView, session } from 'electron';
import type {
  BrowserAction,
  BrowserLayout,
  BrowserSnapshot,
  BrowserTab,
} from '../../packages/shared/computer';
import type { BrowserDriver } from '../server/computer';
import { browserUrl, checkBrowserUrl } from '../server/browser-policy';
import { readBrowserPage, useBrowserElement } from './browser-dom';

export class ChromiumComputer implements BrowserDriver {
  onChange?: () => void;
  private records = new Map<string, { tab: BrowserTab; view: WebContentsView }>();
  private window?: BrowserWindow;
  private active?: string;
  private bounds: BrowserLayout = { visible: false, x: 0, y: 0, width: 1024, height: 768 };
  private browserSession = session.fromPartition('persist:bot-bots-computer');
  private allowed = new Map<string, number>();
  constructor() {
    this.secureSession(this.browserSession);
  }
  private secureSession(browserSession: Electron.Session) {
    browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.on('will-download', (event) => event.preventDefault());
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      if (/^(data:|blob:|about:blank$)/.test(details.url) && details.resourceType !== 'mainFrame') {
        callback({ cancel: false });
        return;
      }
      if (details.url === 'about:blank') {
        callback({ cancel: false });
        return;
      }
      void this.allowedUrl(details.url).then(
        () => callback({ cancel: false }),
        () => callback({ cancel: true }),
      );
    });
  }
  private async allowedUrl(url: string) {
    const parsed = browserUrl(url);
    if ((this.allowed.get(parsed.origin) ?? 0) > Date.now()) return;
    await checkBrowserUrl(url, process.env.BOT_BOTS_BROWSER_TEST_ORIGIN);
    this.allowed.set(parsed.origin, Date.now() + 15000);
  }
  attach(window: BrowserWindow) {
    this.window = window;
    for (const { view } of this.records.values()) window.contentView.addChildView(view);
    window.on('resize', () => this.layout(this.bounds));
    this.layout(this.bounds);
  }
  tabs() {
    return [...this.records.values()].map((r) => r.tab);
  }
  create(tab: BrowserTab) {
    const browserSession = tab.botId
      ? session.fromPartition(`bot-bots-worker-${tab.id}`)
      : this.browserSession;
    if (tab.botId) this.secureSession(browserSession);
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
    view.setVisible(false);
    this.records.set(tab.id, { tab, view });
    this.window?.contentView.addChildView(view);
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      void this.act(tab.id, { kind: 'open', url }).catch((e) => {
        tab.error = String(e.message);
        this.onChange?.();
      });
      return { action: 'deny' };
    });
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault();
      callback('');
    });
    wc.on('login', (event) => event.preventDefault());
    wc.on('will-navigate', (event, url) => {
      if (!/^https?:/.test(url)) event.preventDefault();
    });
    const update = () => {
      if (wc.isDestroyed()) return;
      Object.assign(tab, {
        url: wc.getURL(),
        title: wc.getTitle() || 'Web page',
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
      this.onChange?.();
    };
    wc.on('did-start-loading', update);
    wc.on('did-stop-loading', update);
    wc.on('did-navigate', update);
    wc.on('did-navigate-in-page', update);
    wc.on('page-title-updated', update);
    wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        tab.error = description;
        update();
      }
    });
    wc.on('render-process-gone', (_event, details) => {
      tab.error = `Browser renderer stopped: ${details.reason}. Reload this tab.`;
      this.onChange?.();
    });
  }
  select(id: string) {
    this.active = id;
    this.layout(this.bounds);
  }
  layout(bounds: BrowserLayout) {
    this.bounds = bounds;
    const scale = this.window?.webContents.getZoomFactor() ?? 1;
    const size = this.window?.getContentBounds();
    for (const [id, { view }] of this.records) {
      const show =
        bounds.visible && id === this.active && !!this.window && !this.window.isDestroyed();
      if (show)
        view.setBounds({
          x: Math.max(0, Math.round(bounds.x * scale)),
          y: Math.max(0, Math.round(bounds.y * scale)),
          width: Math.max(1, Math.min(size!.width, Math.round(bounds.width * scale))),
          height: Math.max(1, Math.min(size!.height, Math.round(bounds.height * scale))),
        });
      view.setVisible(show);
    }
  }
  private get(id: string) {
    const record = this.records.get(id);
    if (!record) throw new Error('Browser tab not found');
    return record;
  }
  async act(id: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserSnapshot> {
    signal?.throwIfAborted();
    const { tab, view } = this.get(id),
      wc = view.webContents;
    const abort = () => wc.stop();
    signal?.addEventListener('abort', abort, { once: true });
    tab.error = undefined;
    try {
      if (action.kind === 'open') {
        await this.allowedUrl(action.url);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            wc.loadURL(action.url),
            new Promise<never>((_r, reject) => {
              timer = setTimeout(() => {
                wc.stop();
                reject(new Error('This page took too long to load. Try reading it or reload.'));
              }, 30000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      } else if (action.kind === 'back') {
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      } else if (action.kind === 'forward') {
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      } else if (action.kind === 'reload') wc.reload();
      else if (action.kind === 'click' || action.kind === 'type')
        await wc.executeJavaScriptInIsolatedWorld(999, [
          {
            code: `(${useBrowserElement.toString()})(${JSON.stringify(action.ref)},${JSON.stringify(action.kind)},${JSON.stringify(action.kind === 'type' ? action.text : '')})`,
          },
        ]);
      else if (action.kind === 'scroll')
        await wc.executeJavaScriptInIsolatedWorld(999, [
          { code: `window.scrollBy(0, ${action.direction === 'up' ? -600 : 600})` },
        ]);
      else if (action.kind === 'pointer') {
        const { width, height } = view.getBounds();
        const x = Math.round(Math.max(0, Math.min(1, action.x)) * (width - 1)),
          y = Math.round(Math.max(0, Math.min(1, action.y)) * (height - 1));
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      } else if (action.kind === 'keyboard') {
        await wc.insertText(action.text);
        if (action.enter) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        }
      }
      if (action.kind !== 'read' && action.kind !== 'open')
        await new Promise((r) => setTimeout(r, 350));
      signal?.throwIfAborted();
      return {
        tabId: id,
        ...(await wc.executeJavaScriptInIsolatedWorld(999, [
          { code: `(${readBrowserPage.toString()})()` },
        ])),
      };
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  async capture(id: string) {
    const { view } = this.get(id);
    const shot = await view.webContents.capturePage(undefined, {
      stayHidden: !view.getVisible(),
      stayAwake: true,
    });
    return { image: shot.toDataURL(), ...shot.getSize() };
  }
  close(id: string) {
    const record = this.get(id);
    if (this.window && !this.window.isDestroyed())
      this.window.contentView.removeChildView(record.view);
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
    this.records.delete(id);
  }
  dispose() {
    for (const id of this.records.keys()) this.close(id);
  }
}
