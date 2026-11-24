import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Completion, WireMessage } from './models';

const downloads = 'https://downloads.claude.ai/claude-code-releases';
export interface ClaudeCodeState {
  installed: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'installing';
  email?: string;
  error?: string;
  loginUrl?: string;
}
/** Runs Anthropic's unmodified binary. OAuth credentials remain exclusively with Claude Code. */
export class ClaudeCode {
  private pending?: ChildProcess;
  private installing?: Promise<void>;
  private error?: string;
  private loginUrl?: string;
  private controllers = new Set<AbortController>();
  readonly binary: string;
  private sessionDir: string;
  constructor(private dir: string) {
    this.binary = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    this.sessionDir = join(dir, 'session');
    mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
  }
  async install() {
    if (existsSync(this.binary)) return;
    this.installing ??= (async () => {
      if (
        !['win32', 'darwin', 'linux'].includes(process.platform) ||
        !['x64', 'arm64'].includes(process.arch)
      )
        throw Error('Claude Code is not available for this platform.');
      const get = async (url: string) => {
        const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
        if (!r.ok) throw Error('Claude Code download failed. Try again.');
        return r;
      };
      const version = (await (await get(`${downloads}/latest`)).text()).trim();
      if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
        throw Error('Claude Code returned an invalid version.');
      const manifest = (await (await get(`${downloads}/${version}/manifest.json`)).json()) as {
        platforms: Record<string, { checksum: string }>;
      };
      const platform = `${process.platform}-${process.arch}`;
      const checksum = manifest.platforms?.[platform]?.checksum;
      if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum))
        throw Error('Claude Code download could not be verified.');
      const r = await get(
        `${downloads}/${version}/${platform}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`,
      );
      const bytes = Buffer.from(await r.arrayBuffer());
      if (
        bytes.length > 600 * 1024 * 1024 ||
        createHash('sha256').update(bytes).digest('hex') !== checksum.toLowerCase()
      )
        throw Error('Claude Code download checksum did not match.');
      writeFileSync(`${this.binary}.tmp`, bytes, { mode: 0o700 });
      renameSync(`${this.binary}.tmp`, this.binary);
      chmodSync(this.binary, 0o700);
      writeFileSync(
        join(this.dir, 'version.json'),
        JSON.stringify({ version, checksum, source: downloads }),
      );
    })().finally(() => {
      this.installing = undefined;
    });
    return this.installing;
  }
  private env() {
    return Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value !== undefined &&
          !/^BOT_BOTS_|^ELECTRON_|^NODE_OPTIONS$|^NODE_PATH$|^GOOGLE_/i.test(key),
      ),
    );
  }
  private run(
    args: string[],
    input = '',
    signal = AbortSignal.timeout(15000),
    extraEnv: Record<string, string> = {},
  ) {
    return new Promise<{ code: number; output: string }>((resolve, reject) => {
      const child = spawn(this.binary, args, {
        cwd: this.sessionDir,
        shell: false,
        windowsHide: true,
        env: { ...this.env(), ...extraEnv },
        signal,
      });
      let output = '',
        size = 0;
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > 24 * 1024 * 1024) child.kill();
        else output += chunk.toString();
      });
      child.stderr.on('data', () => {});
      child.once('error', () =>
        reject(
          Error(
            signal.aborted
              ? 'Claude Code request was cancelled.'
              : 'Claude Code could not start. Check its installation.',
          ),
        ),
      );
      child.once('close', (code) => resolve({ code: code ?? 1, output }));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  async state(signal = AbortSignal.timeout(15000)): Promise<ClaudeCodeState> {
    if (this.installing) return { installed: false, status: 'installing' };
    if (!existsSync(this.binary))
      return { installed: false, status: 'disconnected', error: this.error };
    if (this.pending)
      return { installed: true, status: 'connecting', error: this.error, loginUrl: this.loginUrl };
    try {
      const result = await this.run(['auth', 'status'], '', signal);
      const data = JSON.parse(result.output);
      return {
        installed: true,
        status:
          result.code === 0 &&
          (data.loggedIn === true ||
            (typeof data.authMethod === 'string' && data.authMethod !== 'none'))
            ? 'connected'
            : 'disconnected',
        ...(typeof data.email === 'string' ? { email: data.email } : {}),
        error: this.error,
      };
    } catch {
      return {
        installed: true,
        status: 'disconnected',
        error: this.error ?? 'Claude Code status is unavailable. Try connecting again.',
      };
    }
  }
  async signIn() {
    if (this.pending) return;
    this.error = undefined;
    await this.install();
    const child = spawn(this.binary, ['auth', 'login'], {
      cwd: this.sessionDir,
      shell: false,
      windowsHide: true,
      env: this.env(),
    });
    this.pending = child;
    this.loginUrl = undefined;
    const timer = setTimeout(() => this.cancel(), 10 * 60000);
    timer.unref();
    let buffer = '';
    const observe = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-16000);
      for (const match of buffer.matchAll(/https:\/\/[^\s\x1b<>"']+/g)) {
        try {
          const url = new URL(match[0]);
          if (
            ['claude.ai', 'platform.claude.com', 'console.anthropic.com'].includes(url.hostname) &&
            /oauth|authorize/.test(url.pathname)
          )
            this.loginUrl = url.toString();
        } catch {}
      }
    };
    child.stdout.on('data', observe);
    child.stderr.on('data', observe);
    child.stdin.on('error', () => {});
    child.once('error', () => {
      this.error = 'Claude Code could not open its sign-in. Try again.';
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (this.pending === child) {
        this.pending = undefined;
        this.loginUrl = undefined;
        if (code)
          this.error =
            'Claude sign-in did not finish. Try again in the browser. On Windows, Git for Windows must be installed.';
      }
    });
  }
  cancel() {
    const child = this.pending;
    this.pending = undefined;
    this.loginUrl = undefined;
    child?.kill();
  }
  async disconnect() {
    this.cancel();
    for (const c of this.controllers) c.abort();
    await this.run(['auth', 'logout']);
  }
  async complete(
    model: string,
    messages: WireMessage[],
    tools: any[],
    maxTokens: number,
    caller: AbortSignal,
    effort?: import('../../packages/shared/model-effort').ReasoningEffort,
  ): Promise<Completion> {
    if (!/^[a-z0-9][a-z0-9_.:/\[\]-]{0,159}$/i.test(model))
      throw Error('Choose a valid Claude model.');
    caller.throwIfAborted();
    if ((await this.state(caller)).status !== 'connected')
      throw Error('Connect Claude in Model workshop first.');
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const names = tools.map((t) => t.function.name);
      const schema = {
        type: 'object',
        properties: {
          text: { type: 'string' },
          calls: {
            type: 'array',
            maxItems: 8,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', enum: names.length ? names : ['none'] },
                arguments: { type: 'string' },
              },
              required: ['name', 'arguments'],
              additionalProperties: false,
            },
          },
        },
        required: ['text', 'calls'],
        additionalProperties: false,
      };
      const args = [
        '-p',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(schema),
        '--tools',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--setting-sources',
        '',
        '--settings',
        '{"disableAllHooks":true}',
        '--no-session-persistence',
        '--max-turns',
        '3',
        '--model',
        model,
        ...(effort ? ['--effort', effort] : []),
      ];
      const prompt = `Act as the bot described by the supplied system instructions. Return text and/or requests to the listed Bot-Bots functions using the JSON schema. Function arguments must be a JSON string. Calls are executed by Bot-Bots, which returns results in the next request. Your native tools are disabled for this invocation. Do not claim a requested function succeeded until its recorded result is present.\n${JSON.stringify({ messages, functions: tools })}`;
      const result = await this.run(args, prompt, AbortSignal.any([caller, controller.signal]), {
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
      });
      let data: any;
      try {
        data = JSON.parse(result.output);
      } catch {
        throw Error('Claude Code returned an incomplete response.');
      }
      if (result.code || data.is_error)
        throw Error(
          'Claude Code could not complete this request. Check the account connection and plan usage limits.',
        );
      const answer =
        data.structured_output ??
        (() => {
          try {
            return JSON.parse(data.result);
          } catch {
            return undefined;
          }
        })();
      if (
        !answer ||
        typeof answer.text !== 'string' ||
        !Array.isArray(answer.calls) ||
        answer.calls.length > 8
      )
        throw Error('Claude Code did not return a valid bot response.');
      const calls = answer.calls.map((call: any) => {
        if (!names.includes(call.name) || typeof call.arguments !== 'string')
          throw Error('Claude Code requested an unavailable bot function.');
        JSON.parse(call.arguments);
        return {
          id: randomUUID(),
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        };
      });
      if (!answer.text.trim() && !calls.length) throw Error('Claude Code returned an empty reply.');
      const usage = data.usage;
      return {
        message: { role: 'assistant', content: answer.text || null, tool_calls: calls },
        truncated: false,
        tokens: usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : undefined,
        stopReason: 'stop',
      };
    } finally {
      this.controllers.delete(controller);
    }
  }
}
