export interface TerminalJob {
  id: string;
  command: string;
  cwd: string;
  reason: string;
  source: 'bot' | 'human';
  botId?: string;
  runId?: string;
  status: 'awaiting-approval' | 'running' | 'completed' | 'failed' | 'denied' | 'cancelled';
  createdAt: string;
  approvedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  output: string;
  truncated?: boolean;
  exitCode?: number;
  error?: string;
  timeoutMs: number;
}
export interface TerminalState {
  jobs: TerminalJob[];
  shell: 'PowerShell' | 'sh';
  workspace: string;
}
