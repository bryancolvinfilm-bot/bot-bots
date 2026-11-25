import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  systemPreferences,
} from 'electron';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { startServer } from '../server/index';
import { Computer } from '../server/computer';
import { ChromiumComputer } from './browser';
import { ChromiumPreview } from './preview';
import { NativeSpeech, microphoneAllowed } from './speech';
let chromium: ChromiumComputer | undefined;
const profileDir = process.env.BOT_BOTS_DATA_DIR
  ? join(process.env.BOT_BOTS_DATA_DIR, 'desktop-profile')
  : join(app.getPath('appData'), 'Bot-Bots');
mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
nativeTheme.themeSource = 'dark';
const rolePath = join(profileDir, 'desktop-role.json');
let role: { mode: 'server' | 'client'; serverUrl?: string } = { mode: 'server' };
if (existsSync(rolePath))
  try {
    role = JSON.parse(readFileSync(rolePath, 'utf8'));
  } catch {
    /* An invalid preference falls back to the local host. */
  }
if (process.env.BOT_BOTS_MODE === 'client')
  role = { mode: 'client', serverUrl: process.env.BOT_BOTS_SERVER_URL ?? role.serverUrl };
else if (process.env.BOT_BOTS_MODE === 'server') role = { mode: 'server' };
const validServerUrl = (value: string) => {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw Error('Use a server HTTP(S) origin without credentials or a path.');
  const parts = url.hostname.split('.').map(Number);
  const privateHost =
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    (isIP(url.hostname) === 4 &&
      (parts[0] === 127 ||
        parts[0] === 10 ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)));
  if (url.protocol === 'http:' && !privateHost)
    throw Error('Use HTTPS for a server outside your private network.');
  return url.origin;
};
let host: Awaited<ReturnType<typeof startServer>> | undefined;
let closing = false;
let mainWindow: BrowserWindow | undefined;
function window(url: string) {
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    title: 'Bot-Bots',
    icon: join(app.getAppPath(), 'dist', 'web', 'icon.png'),
    backgroundColor: '#202124',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      additionalArguments: [`--bot-bots-mode=${role.mode}`],
    },
  });
  mainWindow = win;
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  chromium?.attach(win);
  const trusted = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) =>
    event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame &&
    new URL(event.senderFrame.url).origin === new URL(url).origin &&
    new URL(event.senderFrame.url).pathname === new URL(url).pathname;
  const helperRoot = app.isPackaged
    ? join(process.resourcesPath, 'speech')
    : join(app.getAppPath(), 'dist', 'speech');
  const speech = new NativeSpeech(
    process.platform === 'win32'
      ? join(helperRoot, 'BotBotsSpeech.exe')
      : process.platform === 'darwin'
        ? join(helperRoot, 'BotBotsSpeech.app', 'Contents', 'MacOS', 'BotBotsSpeech')
        : undefined,
    (value) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed())
        win.webContents.send('speech:event', value);
    },
  );
  for (const name of ['speech:capabilities', 'speech:start', 'speech:stop'])
    ipcMain.removeHandler(name);
  ipcMain.removeAllListeners('speech:audio');
  let microphoneApproved = false;
  ipcMain.handle('speech:capabilities', (event, locale) => {
    if (!trusted(event) || typeof locale !== 'string') throw Error('Untrusted dictation request.');
    return speech.capabilities(locale);
  });
  ipcMain.handle('speech:start', async (event, id, locale) => {
    if (!trusted(event) || typeof id !== 'string' || typeof locale !== 'string')
      throw Error('Untrusted dictation request.');
    await speech.start(id, locale);
    if (process.platform === 'darwin') {
      const allowed = await systemPreferences.askForMediaAccess('microphone');
      if (!speech.owns(id)) throw Error('Dictation stopped.');
      if (!allowed) {
        const message =
          'Allow microphone access for Bot-Bots in macOS Privacy & Security settings.';
        if (!win.isDestroyed())
          win.webContents.send('speech:event', { id, type: 'error', message });
        await speech.stop(id, true);
        throw Error(message);
      }
    }
    microphoneApproved = true;
  });
  ipcMain.handle('speech:stop', (event, id, cancel) => {
    if (!trusted(event) || typeof id !== 'string' || typeof cancel !== 'boolean')
      throw Error('Untrusted dictation request.');
    return speech.stop(id, cancel);
  });
  ipcMain.on('speech:audio', (event, id, pcm) => {
    if (trusted(event) && typeof id === 'string') speech.audio(id, pcm);
  });
  win.on('closed', () => speech.cancel());
  win.webContents.on('render-process-gone', () => speech.cancel());
  win.webContents.on('did-start-navigation', () => speech.cancel());
  ipcMain.removeHandler('app:open-external');
  ipcMain.removeHandler('app:set-mode');
  ipcMain.handle('app:open-external', async (event, value) => {
    if (!trusted(event) || typeof value !== 'string')
      throw Error('Untrusted external URL request.');
    const target = new URL(value);
    if (target.protocol !== 'https:' || target.username || target.password)
      throw Error('Only HTTPS links can open externally.');
    await shell.openExternal(target.toString());
  });
  ipcMain.handle('app:set-mode', (event, value) => {
    if (!trusted(event) || !value || !['server', 'client'].includes(value.mode))
      throw Error('Invalid desktop role.');
    const next = {
      mode: value.mode,
      ...(value.mode === 'client'
        ? { serverUrl: validServerUrl(String(value.serverUrl ?? '')) }
        : {}),
    };
    writeFileSync(rolePath, JSON.stringify(next), { mode: 0o600 });
    app.relaunch();
    app.quit();
  });
  ipcMain.removeHandler('computer:layout');
  ipcMain.removeHandler('app:copy-text');
  ipcMain.handle('app:copy-text', (event, text) => {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== new URL(url).origin ||
      new URL(event.senderFrame.url).pathname !== new URL(url).pathname ||
      typeof text !== 'string' ||
      text.length > 300000
    )
      throw new Error('Invalid copy request');
    clipboard.writeText(text);
  });
  ipcMain.handle('computer:layout', (event, bounds) => {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== new URL(url).origin ||
      new URL(event.senderFrame.url).pathname !== new URL(url).pathname
    )
      throw new Error('Untrusted browser layout request');
    if (
      !bounds ||
      typeof bounds.visible !== 'boolean' ||
      !['x', 'y', 'width', 'height'].every(
        (key) => Number.isFinite(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 20000,
      )
    )
      throw new Error('Invalid browser panel bounds');
    chromium?.layout(bounds);
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) event.preventDefault();
  });
  win.webContents.session.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      permission === 'media' &&
      microphoneAllowed(url, {
        sameContents: contents === win.webContents,
        isMainFrame: details.isMainFrame,
        url: details.requestingUrl ?? '',
        media: details.mediaType ? [details.mediaType] : [],
        active: speech.active || microphoneApproved,
      }),
  );
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const media = details as Electron.MediaAccessPermissionRequest;
    if (
      permission !== 'media' ||
      !microphoneAllowed(url, {
        sameContents: contents === win.webContents,
        isMainFrame: media.isMainFrame,
        url: media.requestingUrl,
        media: media.mediaTypes ?? [],
        active: speech.active,
      })
    ) {
      callback(false);
      return;
    }
    if (process.platform === 'darwin')
      void systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
    else callback(true);
  });
  void win.loadURL(url).catch(async () => {
    if (win.isDestroyed() || closing) return;
    if (role.mode !== 'client') {
      dialog.showErrorBox(
        'Bot-Bots could not load',
        'The local interface could not load. Check the application build and reopen it.',
      );
      return;
    }
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Your server is unavailable',
      message: 'Bot-Bots could not reach its server.',
      detail:
        'Check that the host is awake and connected. You can retry, or switch this computer back to hosting its own team.',
      buttons: ['Try again', 'Switch to Server mode', 'Quit'],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice.response === 0) window(url);
    else if (choice.response === 1) {
      writeFileSync(rolePath, JSON.stringify({ mode: 'server' }));
      app.relaunch();
      app.quit();
    } else app.quit();
    if (!win.isDestroyed()) win.destroy();
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    try {
      if (role.mode === 'client') {
        const url = validServerUrl(role.serverUrl ?? '');
        window(url);
        app.on('activate', () => {
          if (!BrowserWindow.getAllWindows().length) window(url);
        });
        return;
      }
      chromium = new ChromiumComputer();
      host = await startServer({
        computer: new Computer(chromium),
        preview: new ChromiumPreview(),
        rootDir: app.getAppPath(),
        dataDir: process.env.BOT_BOTS_DATA_DIR ?? join(app.getPath('userData'), 'team'),
        port: Number(process.env.BOT_BOTS_DESKTOP_PORT ?? 3211),
      });
      window(host.url);
      host.runtime.events.on('google-connected', () => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible());
        if (win) {
          if (win.isMinimized()) win.restore();
          win.focus();
        }
      });
      app.on('activate', () => {
        if (!BrowserWindow.getAllWindows().length) window(host!.url);
      });
    } catch (error) {
      dialog.showErrorBox(
        'Bot-Bots could not start',
        error instanceof Error ? error.message : String(error),
      );
      app.quit();
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (host && !closing) {
      event.preventDefault();
      closing = true;
      void host.close().then(() => app.quit());
    }
  });
}
