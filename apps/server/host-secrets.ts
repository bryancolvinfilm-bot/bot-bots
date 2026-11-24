import { Entry } from '@napi-rs/keyring';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const secretAlias = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/;
export function credentialsDirectory() {
  return resolve(
    process.env.BOT_BOTS_CREDENTIALS_DIR ||
      (process.platform === 'win32'
        ? join(
            process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
            'Bot-Bots',
            'credentials',
          )
        : process.platform === 'darwin'
          ? join(homedir(), 'Library', 'Application Support', 'Bot-Bots', 'credentials')
          : join(homedir(), '.config', 'bot-bots', 'credentials')),
  );
}
export interface SecretBackend {
  readonly kind: string;
  get(alias: string): string | null;
  set(alias: string, value: string): void;
  delete(alias: string): boolean;
}
export class OsSecrets implements SecretBackend {
  readonly kind =
    process.platform === 'win32'
      ? 'Windows Credential Manager'
      : process.platform === 'darwin'
        ? 'macOS Keychain'
        : 'Linux Secret Service';
  private entry(alias: string) {
    if (!secretAlias.test(alias)) throw Error('Invalid secret alias.');
    // Never silently downgrade Linux to an ephemeral kernel keyring or a plaintext password.
    return new Entry('Bot-Bots', alias, {
      linux: { store: 'secret-service' },
    });
  }
  get(alias: string) {
    try {
      return this.entry(alias).getPassword();
    } catch {
      throw Error('The OS credential store is locked or unavailable.');
    }
  }
  set(alias: string, value: string) {
    try {
      this.entry(alias).setPassword(value);
    } catch {
      throw Error('The OS credential store could not save this secret.');
    }
  }
  delete(alias: string) {
    try {
      return this.entry(alias).deleteCredential();
    } catch {
      throw Error('The OS credential store could not remove this secret.');
    }
  }
}
/** Explicit headless-Linux option only. This is permission-protected plaintext, not encryption. */
export class FileSecrets implements SecretBackend {
  readonly kind = 'Private Linux files (plaintext, 0600)';
  constructor(private dir: string) {
    if (process.platform === 'win32')
      throw Error(
        'Private-file secrets are a Linux/macOS headless option; use Credential Manager on Windows.',
      );
  }
  private path(alias: string) {
    if (!secretAlias.test(alias)) throw Error('Invalid secret alias.');
    const directory = lstatSync(this.dir);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.mode & 0o077 ||
      directory.uid !== process.getuid!()
    )
      throw Error('The secret directory must be owned by the host account and have mode 0700.');
    return join(this.dir, alias);
  }
  get(alias: string) {
    const file = this.path(alias);
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (!info) return null;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid!()
    )
      throw Error('Secret files must be owned by the host account and have mode 0600.');
    return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  }
  set(alias: string, value: string) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.path(alias);
    if (lstatSync(file, { throwIfNoEntry: false })) this.get(alias); // Check ownership/mode/symlinks before replacing.
    writeFileSync(file, value, { mode: 0o600 });
  }
  delete(alias: string) {
    const file = this.path(alias);
    if (!existsSync(file)) return false;
    this.get(alias);
    unlinkSync(file);
    return true;
  }
}
