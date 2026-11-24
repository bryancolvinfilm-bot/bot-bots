export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  botId?: string;
  runId?: string;
  error?: string;
}
export interface BrowserElement {
  ref: string;
  tag: string;
  label: string;
  href?: string;
  type?: string;
  searchResult?: boolean;
}
export interface BrowserSnapshot {
  tabId: string;
  url: string;
  title: string;
  text: string;
  elements: BrowserElement[];
}
export interface ComputerState {
  pool?: { limit: number; active: number; waiting: { botId: string; runId: string }[] };
  searchProvider: 'google' | 'bing' | 'duckduckgo' | 'brave';
  available: boolean;
  engine: 'chromium' | 'unavailable';
  paused: boolean;
  activeTabId?: string;
  tabs: BrowserTab[];
  revision: number;
  lastAction?: string;
  error?: string;
}
export type BrowserAction =
  | { kind: 'open'; url: string }
  | { kind: 'read' }
  | { kind: 'click'; ref: string }
  | { kind: 'type'; ref: string; text: string }
  | { kind: 'scroll'; direction: 'up' | 'down' }
  | { kind: 'back' | 'forward' | 'reload' }
  | { kind: 'pointer'; x: number; y: number }
  | { kind: 'keyboard'; text: string; enter?: boolean };
export interface BrowserLayout {
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ComputerBridge {
  layout(bounds: BrowserLayout): Promise<void>;
}
declare global {
  interface Window {
    botBotsComputer?: ComputerBridge;
  }
}
