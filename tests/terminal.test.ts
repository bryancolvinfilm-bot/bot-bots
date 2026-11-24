import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Terminal } from '../apps/server/terminal';
import { Store } from '../apps/server/store';
import type { TerminalJob } from '../packages/shared/terminal';
import { createApp } from '../apps/server/app';
import { seedTestTeam as seed } from './fixtures/team';
import type { AddressInfo } from 'node:net';
mkdirSync('test-results/unit', { recursive: true });
function fixture() {
  const dir = mkdtempSync(resolve('test-results/unit/terminal-')),
    store = new Store(join(dir, 'test.sqlite')),
    terminal = new Terminal(store, join(dir, 'workspace'));
  return { dir, store, terminal };
}
const command =
  process.platform === 'win32'
    ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'marker.txt'), 'approved'); Write-Output 'Terminal check passed'"
    : "printf approved > marker.txt; printf 'Terminal check passed'";
const shellTestTimeout = process.platform === 'win32' ? 120000 : 10000;
async function waitJob(terminal: Terminal, id: string) {
  // Hosted Windows runners can take tens of seconds to cold-start Windows PowerShell.
  const deadline = Date.now() + shellTestTimeout;
  while (Date.now() < deadline) {
    const j = terminal.store.get('terminal', id)!;
    if (!['running', 'awaiting-approval'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Command timed out in the test');
}
test('bot commands cannot execute before approval; denial and cancellation never create the file', async () => {
  const { store, terminal, dir } = fixture();
  try {
    const controller = new AbortController(),
      pending = terminal.request(
        command,
        '.',
        'Create a test marker',
        10000,
        'worker1',
        'run1',
        controller.signal,
      );
    const id = terminal.state().jobs[0].id;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(existsSync(join(dir, 'workspace', 'marker.txt')), false);
    terminal.decide(id, false);
    assert.equal((await pending).status, 'denied');
    assert.equal(existsSync(join(dir, 'workspace', 'marker.txt')), false);
    assert.throws(() => terminal.decide(id, true), /no longer/);
    await assert.rejects(
      terminal.request(command, '.', 'Try again', 10000, 'worker1', 'run1', controller.signal),
      /denied/,
    );
    const next = terminal.request(
      command,
      '.',
      'Second test job',
      10000,
      'worker1',
      'run2',
      controller.signal,
    );
    controller.abort();
    assert.equal((await next).status, 'cancelled');
    assert.equal(existsSync(join(dir, 'workspace', 'marker.txt')), false);
  } finally {
    await terminal.dispose();
    store.close();
  }
});
test('approval executes the immutable command once, records output, and each new command needs a new approval', async () => {
  const { store, terminal, dir } = fixture();
  try {
    const pending = terminal.request(
      command,
      '.',
      'Test an approved command',
      shellTestTimeout,
      'worker1',
      'run1',
      new AbortController().signal,
    );
    const id = terminal.state().jobs[0].id;
    // Changing a retrieved SQLite copy does not change the in-memory approval request.
    const tampered = { ...store.get('terminal', id)!, command: 'this must not run' };
    store.put('terminal', tampered);
    terminal.decide(id, true);
    assert.throws(() => terminal.decide(id, true), /one-time/);
    const result = await pending;
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Terminal check passed/);
    assert.equal(readFileSync(join(dir, 'workspace', 'marker.txt'), 'utf8'), 'approved');
    assert.equal(result.command, command);
    assert.ok(result.approvedAt);
    const second = terminal.request(
      process.platform === 'win32' ? "Write-Output 'Second command'" : "printf 'Second command'",
      '.',
      'New approval needed',
      10000,
      'worker1',
      'run1',
      new AbortController().signal,
    );
    assert.equal(terminal.state().jobs[0].status, 'awaiting-approval');
    terminal.decide(terminal.state().jobs[0].id, false);
    await second;
  } finally {
    await terminal.dispose();
    store.close();
  }
});
test('restarting the terminal cancels old requests and never restores permission', async () => {
  const { store, terminal } = fixture();
  try {
    const job: TerminalJob = {
      id: 'old',
      command,
      cwd: terminal.workspace,
      reason: 'Old request',
      timeoutMs: 10000,
      source: 'bot',
      status: 'awaiting-approval',
      createdAt: new Date().toISOString(),
      output: '',
    };
    store.put('terminal', job);
    const reopened = new Terminal(store, terminal.workspace);
    assert.equal(store.get('terminal', 'old')?.status, 'cancelled');
    assert.throws(() => reopened.decide('old', true), /no longer/);
    await reopened.dispose();
  } finally {
    await terminal.dispose();
    store.close();
  }
});
test('manual commands run only on explicit Run, and running processes can be stopped', async () => {
  const { store, terminal } = fixture();
  try {
    const manual = terminal.manual(
      process.platform === 'win32' ? "Write-Output 'Manual works'" : "printf 'Manual works'",
    );
    const done = await waitJob(terminal, manual.id);
    assert.match(done.output, /Manual works/);
    assert.equal(done.source, 'human');
    const running = terminal.manual(
      process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60',
    );
    terminal.cancel(running.id);
    const stopped = await waitJob(terminal, running.id);
    assert.equal(stopped.status, 'cancelled');
    assert.throws(() => terminal.manual('echo invalid', '..'), /workspace/);
  } finally {
    await terminal.dispose();
    store.close();
  }
});
test('HTTP approvals stay authenticated, preview tickets expose only sandboxed content, and restore never grants terminal permission', async () => {
  const { store, terminal, dir } = fixture();
  seed(store, resolve('reference/grok-backup'));
  for (const provider of store.all('providers'))
    store.put('providers', { ...provider, autoDiscover: false, autoEnableModels: false });
  const host = createApp(store, dir, resolve('dist/web'), 'test-human-token');
  const server = host.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(path: string, method = 'GET', body?: unknown) {
    return fetch(`${base}${path}`, {
      method,
      headers: { Authorization: 'Bearer test-human-token', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  try {
    assert.equal((await fetch(`${base}/api/terminal`)).status, 401);
    const preview = (await (
      await request('/api/previews', 'POST', {
        content: '<script>document.body.textContent="Running"</script>',
      })
    ).json()) as { url: string };
    const html = await fetch(`${base}${preview.url}`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('Content-Security-Policy')!, /sandbox allow-scripts/);
    assert.match(html.headers.get('Content-Security-Policy')!, /connect-src 'none'/);
    assert.match(await html.text(), /Running/);
    assert.equal((await fetch(`${base}/preview/not-a-ticket`)).status, 410);
    const pending = host.terminal.request(
      command,
      '.',
      'Test HTTP denial',
      10000,
      'worker1',
      'test-run',
      new AbortController().signal,
    );
    const id = host.terminal.state().jobs[0].id;
    assert.equal(
      (
        await fetch(`${base}/api/terminal/${id}/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approve: true }),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(`/api/terminal/${id}/decision`, 'POST', {
          approve: true,
          command: 'replace command',
        })
      ).status,
      400,
    );
    await request(`/api/terminal/${id}/decision`, 'POST', { approve: false });
    assert.equal((await pending).status, 'denied');
    const backup = store.export();
    (backup as unknown as { terminal: TerminalJob[] }).terminal[0].status = 'awaiting-approval';
    assert.equal((await request('/api/import', 'POST', backup)).status, 200);
    assert.equal(store.get('terminal', id)?.status, 'cancelled');
    assert.notEqual(
      (await request(`/api/terminal/${id}/decision`, 'POST', { approve: true })).status,
      200,
    );
    assert.equal(existsSync(join(dir, 'workspace', 'marker.txt')), false);
  } finally {
    await host.terminal.dispose();
    await terminal.dispose();
    host.runtime.events.emit('shutdown');
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
