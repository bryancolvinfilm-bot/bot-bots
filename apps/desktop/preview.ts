import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { previewHtml } from '../../packages/shared/artifacts';
import {
  previewActions,
  type PreviewAction,
  type PreviewDriver,
  type PreviewResult,
} from '../server/preview';

export class ChromiumPreview implements PreviewDriver {
  async render(content: string, requested: PreviewAction[] = []): Promise<PreviewResult> {
    const actions = previewActions.parse(requested);
    const partition = session.fromPartition(`preview-${randomUUID()}`);
    partition.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    partition.on('will-download', (event) => event.preventDefault());
    partition.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !/^(data:|blob:|about:blank$)/.test(details.url) }),
    );
    const window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 740,
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    const wc = window.webContents,
      errors: string[] = [];
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event) => event.preventDefault());
    wc.on('console-message', (_event, level, message) => {
      if (level === 3 && errors.length < 20) errors.push(message.slice(0, 1000));
    });
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        (async () => {
          await wc.loadURL(
            `data:text/html;charset=utf-8,${encodeURIComponent(previewHtml(content))}`,
          );
          await new Promise((r) => setTimeout(r, 600));
          const checks: NonNullable<PreviewResult['checks']> = [];
          for (const action of actions) {
            const result = await wc.executeJavaScript(`(() => {
              try {
                const action = ${JSON.stringify(action)};
                const element = document.querySelector(action.selector);
                if (!element) return {passed:false,error:'No element matched the selector.'};
                if (action.type === 'click') { element.click(); return {passed:true}; }
                const observed = (element.textContent ?? '').trim().slice(0,2000);
                return {passed:observed === action.text,observed};
              } catch(error) { return {passed:false,error:String(error).slice(0,500)}; }
            })()`);
            checks.push({ action, ...result });
            await new Promise((r) => setTimeout(r, 75));
          }
          const snapshot = await wc.executeJavaScript(
            '({title:document.title,text:(document.body?.innerText??" ").slice(0,10000)})',
          );
          const screenshot = (await wc.capturePage(undefined, { stayHidden: true })).toDataURL();
          return { ...snapshot, errors, checks, screenshot } as PreviewResult;
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Preview exceeded its 10 second limit and was stopped.')),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
      window.destroy();
    }
  }
}
