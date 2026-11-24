import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One host owns a team's scheduler and SQLite database at a time. */
export function acquireHostLock(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, '.host-lock.json');
  const nonce = randomUUID();
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    if (alive)
      throw new Error(
        `This team already has an active host (process ${owner.pid}). Close it before starting another desktop or server.`,
      );
    unlinkSync(path);
    fd = openSync(path, 'wx');
  }
  try {
    writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, nonce, startedAt: new Date().toISOString() }),
    );
  } finally {
    closeSync(fd);
  }
  return () => {
    try {
      const owner = JSON.parse(readFileSync(path, 'utf8'));
      if (owner.nonce === nonce) unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  };
}
