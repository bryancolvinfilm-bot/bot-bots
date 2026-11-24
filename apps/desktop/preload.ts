import { contextBridge, ipcRenderer } from 'electron';
import type { BrowserLayout } from '../../packages/shared/computer';
const mode = process.argv.includes('--bot-bots-mode=client') ? 'client' : 'server';
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
