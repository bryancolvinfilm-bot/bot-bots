export const googleOperations = [
  {
    id: 'gmail.search',
    service: 'Gmail',
    label: 'Search messages',
    write: false,
    scope: 'gmail.readonly',
  },
  {
    id: 'gmail.read',
    service: 'Gmail',
    label: 'Read messages',
    write: false,
    scope: 'gmail.readonly',
  },
  { id: 'gmail.send', service: 'Gmail', label: 'Send email', write: true, scope: 'gmail.send' },
  {
    id: 'drive.search',
    service: 'Drive',
    label: 'Search files',
    write: false,
    scope: 'drive.readonly',
  },
  {
    id: 'drive.read',
    service: 'Drive',
    label: 'Read text / export documents',
    write: false,
    scope: 'drive.readonly',
  },
  {
    id: 'drive.create',
    service: 'Drive',
    label: 'Create a text file',
    write: true,
    scope: 'drive.file',
  },
  {
    id: 'sheets.read',
    service: 'Sheets',
    label: 'Read cell ranges',
    write: false,
    scope: 'spreadsheets.readonly',
  },
  {
    id: 'sheets.update',
    service: 'Sheets',
    label: 'Update cell ranges',
    write: true,
    scope: 'spreadsheets',
  },
  {
    id: 'docs.read',
    service: 'Docs',
    label: 'Read documents',
    write: false,
    scope: 'documents.readonly',
  },
  {
    id: 'docs.append',
    service: 'Docs',
    label: 'Append to documents',
    write: true,
    scope: 'documents',
  },
  {
    id: 'calendar.list',
    service: 'Calendar',
    label: 'Read upcoming events',
    write: false,
    scope: 'calendar.events.readonly',
  },
  {
    id: 'calendar.create',
    service: 'Calendar',
    label: 'Create an event',
    write: true,
    scope: 'calendar.events',
  },
  {
    id: 'contacts.list',
    service: 'Contacts',
    label: 'Read contacts',
    write: false,
    scope: 'contacts.readonly',
  },
] as const;
export type GoogleOperation = (typeof googleOperations)[number]['id'];
export interface GooglePermission {
  enabled: boolean;
  botIds: string[];
}
export interface GoogleConfig {
  clientSource?: 'app' | 'custom';
  installed: boolean;
  clientType: 'desktop' | 'web';
  clientId: string;
  redirectUri: string;
  permissions: Partial<Record<GoogleOperation, GooglePermission>>;
}
export interface PluginAction {
  id: string;
  pluginId: 'google';
  operation: GoogleOperation;
  botId: string;
  runId: string;
  params: Record<string, unknown>;
  status: 'awaiting-approval' | 'running' | 'completed' | 'denied' | 'cancelled' | 'failed';
  createdAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
}
export interface GoogleState {
  signIn: {
    ready: boolean;
    source: 'app' | 'custom' | 'missing';
    status: 'idle' | 'waiting' | 'exchanging' | 'failed';
    expiresAt?: string;
    message?: string;
  };
  accountEmail?: string;
  config: GoogleConfig;
  connected: boolean;
  hasClientSecret: boolean;
  grantedScopes: string[];
  needsAuthorization: GoogleOperation[];
  error?: string;
  actions: PluginAction[];
}
