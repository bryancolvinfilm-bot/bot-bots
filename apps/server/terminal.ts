import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { TerminalJob, TerminalState } from '../../packages/shared/terminal';
import { Store } from './store';

export class Terminal {
  events = new EventEmitter();
  private active = new Map<string, { child: ChildProcess; job: TerminalJob }>();
  private waiters = new Map<string, (job: TerminalJob) => void>();
  private approvals = new Map<string, TerminalJob>();
  constructor(
    public store: Store,
    public workspace: string,
    private botCommandsAllowed = () => true,
  ) {
    mkdirSync(workspace, { recursive: true });
    for (const job of store.all('terminal'))
      if (job.status === 'running' || job.status === 'awaiting-approval')
        store.put('terminal', {
          ...job,
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          error: 'Host restarted. This command will not be resumed or approved automatically.',
        });
  }
  state(): TerminalState {
    const all = this.store.all('terminal');
    return {
      jobs: all
        .filter(
          (j, index) =>
            index >= all.length - 30 || ['running', 'awaiting-approval'].includes(j.status),
        )
        .reverse(),
      shell: process.platform === 'win32' ? 'PowerShell' : 'sh',
      workspace: this.workspace,
    };
  }
  private save(job: TerminalJob) {
    this.store.put('terminal', job);
    this.events.emit('change', this.state());
  }
  private folder(cwd: string) {
    if (isAbsolute(cwd) || cwd.includes(':'))
      throw new Error('Choose a relative folder inside the shared workspace.');
    const base = realpathSync(this.workspace),
      target = realpathSync(resolve(base, cwd || '.')),
      rel = relative(base, target);
    if (rel.startsWith('..') || isAbsolute(rel) || !statSync(target).isDirectory())
      throw new Error('The starting folder must be inside the shared workspace.');
    return target;
  }
  private create(
    command: string,
    cwd: string,
    reason: string,
    timeoutMs: number,
    source: TerminalJob['source'],
    botId?: string,
    runId?: string,
  ) {
    if (!command.trim() || command.length > 12000 || command.includes('\0'))
      throw new Error('Use a command between 1 and 12000 characters.');
    if (!reason.trim() || reason.length > 2000)
      throw new Error('Explain why this command is needed.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
      throw new Error('Use a timeout from 1 to 300 seconds.');
    if (this.approvals.size >= 20)
      throw new Error('There are already 20 terminal requests waiting.');
    if (
      source === 'bot' &&
      this.store
        .all('terminal')
        .some((j) => j.runId === runId && j.command === command && j.status === 'denied')
    )
      throw new Error('The human denied this command. Do not request it again in this run.');
    const job: TerminalJob = {
      id: randomUUID(),
      command,
      cwd: this.folder(cwd),
      reason,
      timeoutMs,
      source,
      botId,
      runId,
      status: 'awaiting-approval',
      createdAt: new Date().toISOString(),
      output: '',
    };
    return job;
  }
  async request(
    command: string,
    cwd: string,
    reason: string,
    timeoutMs: number,
    botId: string,
    runId: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (!this.botCommandsAllowed())
      throw Error(
        'Bot terminal commands are disabled by the external credential policy. Use an approved credential operation.',
      );
    const job = this.create(command, cwd, reason, timeoutMs, 'bot', botId, runId);
    const result = new Promise<TerminalJob>((resolve) => this.waiters.set(job.id, resolve));
    this.approvals.set(job.id, job);
    this.save(job);
    const abort = () => this.cancel(job.id, 'Bot run was stopped.');
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await result;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  manual(command: string, cwd = '.') {
    // Clicking Run is the human's explicit permission for that exact command.
    const job = this.create(command, cwd, 'Run manually by you in the terminal.', 300000, 'human');
    this.approvals.set(job.id, job);
    this.save(job);
    return this.decide(job.id, true);
  }
  decide(id: string, approve: boolean) {
    const job = this.approvals.get(id);
    if (!job || job.status !== 'awaiting-approval')
      throw new Error('This request is no longer awaiting approval. Approval is one-time only.');
    if (approve && job.source === 'bot' && !this.botCommandsAllowed()) {
      this.approvals.delete(id);
      job.status = 'cancelled';
      job.error = 'Credential protection now blocks bot terminal commands. Nothing was executed.';
      this.finish(job);
      return job;
    }
    if (approve && this.active.size >= 4)
      throw new Error('Four commands are already running. Wait or stop one first.');
    this.approvals.delete(id);
    if (!approve) {
      job.status = 'denied';
      job.error = 'Denied by the human.';
      this.finish(job);
      return job;
    }
    // The execution uses this immutable request, never replacement command/cwd fields from the approval body.
    job.approvedAt = new Date().toISOString();
    job.startedAt = job.approvedAt;
    job.status = 'running';
    this.save(job);
    this.execute(job);
    return job;
  }
  private finish(job: TerminalJob) {
    job.finishedAt = new Date().toISOString();
    this.save(job);
    this.waiters.get(job.id)?.(job);
    this.waiters.delete(job.id);
  }
  private kill(child: ChildProcess) {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') {
      const killer = spawn(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      killer.on('error', () => child.kill());
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  }
  private execute(job: TerminalJob) {
    const windows = process.platform === 'win32';
    const shell = windows
      ? join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        )
      : '/bin/sh';
    const args = windows
      ? [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(job.command, 'utf16le').toString('base64'),
        ]
      : ['-c', job.command];
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|USER|USERNAME|LANG|LC_[A-Z_]+|TERM)$/i.test(
          key,
        ),
      ),
    );
    let child: ChildProcess;
    try {
      child = spawn(shell, args, {
        cwd: job.cwd,
        env,
        windowsHide: true,
        detached: !windows,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      job.status = 'failed';
      job.error = String(error);
      this.finish(job);
      return;
    }
    this.active.set(job.id, { child, job });
    child.stdin?.end();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const append = (chunk: string) => {
      job.output += chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      if (job.output.length > 120000) {
        job.output =
          job.output.slice(0, 4000) + '\n[Output truncated]\n' + job.output.slice(-110000);
        job.truncated = true;
      }
      this.save(job);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      job.error = `Stopped after ${job.timeoutMs / 1000} seconds.`;
      job.status = 'cancelled';
      this.kill(child);
    }, job.timeoutMs);
    child.once('error', (error) => {
      job.error = error.message;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      this.active.delete(job.id);
      job.exitCode = code ?? undefined;
      if (job.status !== 'cancelled')
        job.status = code === 0 && !job.error ? 'completed' : 'failed';
      this.finish(job);
    });
  }
  cancel(id: string, reason = 'Stopped by the human.') {
    const waiting = this.approvals.get(id);
    if (waiting) {
      this.approvals.delete(id);
      waiting.status = 'cancelled';
      waiting.error = reason;
      this.finish(waiting);
      return;
    }
    const active = this.active.get(id);
    if (active) {
      active.job.status = 'cancelled';
      active.job.error = reason;
      this.kill(active.child);
    }
  }
  withdrawPending(runId: string) {
    for (const job of this.approvals.values())
      if (job.runId === runId)
        this.cancel(
          job.id,
          'The human updated the task. This old command request was withdrawn; any new command still needs approval.',
        );
  }
  async dispose() {
    const done = [...this.approvals.keys(), ...this.active.keys()].map(
      (id) =>
        new Promise<void>((resolve) => {
          const listener = (state: TerminalState) => {
            const j = state.jobs.find((j) => j.id === id);
            if (!j || !['running', 'awaiting-approval'].includes(j.status)) {
              this.events.off('change', listener);
              resolve();
            }
          };
          this.events.on('change', listener);
          this.cancel(id, 'Host is shutting down.');
        }),
    );
    await Promise.all(done);
    this.events.emit('shutdown');
    this.events.removeAllListeners();
  }
}
