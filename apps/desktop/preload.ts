import { contextBridge, ipcRenderer } from 'electron';
import type { BrowserLayout } from '../../packages/shared/computer';
import type { SpeechEvent } from '../../packages/shared/speech';
const mode = process.argv.includes('--bot-bots-mode=client') ? 'client' : 'server';
contextBridge.exposeInMainWorld('botBotsSpeech', {
  capabilities: (locale: string) => ipcRenderer.invoke('speech:capabilities', locale),
  start: (id: string, locale: string) => ipcRenderer.invoke('speech:start', id, locale),
  audio: (id: string, pcm: ArrayBuffer) => ipcRenderer.send('speech:audio', id, pcm),
  stop: (id: string, cancel = false) => ipcRenderer.invoke('speech:stop', id, cancel),
  onEvent: (listener: (event: SpeechEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: SpeechEvent) => listener(value);
    ipcRenderer.on('speech:event', handler);
    return () => ipcRenderer.removeListener('speech:event', handler);
  },
});
if (mode === 'server')
  contextBridge.exposeInMainWorld('botBotsComputer', {
    layout: (bounds: BrowserLayout) => ipcRenderer.invoke('computer:layout', bounds),
  });
contextBridge.exposeInMainWorld('botBotsDesktop', {
  mode,
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  setMode: (config: { mode: 'server' | 'client'; serverUrl?: string }) =>
    ipcRenderer.invoke('app:set-mode', config),
  copyText: (text: string) => ipcRenderer.invoke('app:copy-text', text),
});
