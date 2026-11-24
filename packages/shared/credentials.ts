export interface CredentialCapability {
  id: string;
  label: string;
  method: string;
  destination: string;
  inputFields: string[];
}
export interface CredentialAction {
  id: string;
  operationId: string;
  label: string;
  botId: string;
  runId: string;
  input: Record<string, unknown>;
  method: string;
  destination: string;
  status: 'awaiting-approval' | 'running' | 'completed' | 'failed' | 'denied' | 'cancelled';
  createdAt: string;
  finishedAt?: string;
  error?: string;
  result?: unknown;
}
export interface CredentialsState {
  configured: boolean;
  enabled: boolean;
  backend: string;
  directory?: string;
  error?: string;
  botTerminalBlocked: boolean;
  capabilities: CredentialCapability[];
  actions: CredentialAction[];
}
export interface SavedSecret {
  id: string;
  name: string;
  kind: 'api-key' | 'password';
  updatedAt: string;
  present: boolean;
}
export interface CredentialManagerState {
  version: string;
  backend: string;
  enabled: boolean;
  secrets: SavedSecret[];
  connections: {
    id: string;
    secretId: string;
    label: string;
    purpose: 'model' | 'alert' | 'operation' | 'service';
    url: string;
    enabled: boolean;
    botIds?: string[];
    api?: import('./service-api').ServiceApi;
  }[];
}
