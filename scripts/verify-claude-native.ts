import { ClaudeCode } from '../apps/server/claude-code';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const claude = new ClaudeCode(resolve('data/claude-code'));
await claude.install();
const version = await promisify(execFile)(claude.binary, ['--version'], {
  windowsHide: true,
  timeout: 30000,
});
const state = await claude.state();
console.log(
  JSON.stringify({
    officialBinaryDownloaded: true,
    checksumVerified: true,
    version: version.stdout.trim(),
    installed: state.installed,
    signedIn: state.status === 'connected',
    loginAttempted: false,
    inferencePerformed: false,
  }),
);
