import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** Host-only encrypted secrets, deliberately excluded from team JSON backups and model context. */
export class SecretVault {
  private key?: Buffer;
  private path: string;
  constructor(
    private dir: string,
    private protectedKey?: (create: boolean) => Buffer,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, 'google.vault');
  }
  private getKey(create: boolean) {
    if (this.protectedKey) return this.protectedKey(create);
    if (this.key) return this.key;
    // Legacy/test-host fallback. Production startServer always supplies an OS-backed key provider.
    const dir = this.dir;
    const keyPath = join(dir, 'master.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw Error('Invalid host secrets key.');
    return this.key;
  }
  read<T extends object>(): T {
    if (!existsSync(this.path)) return {} as T;
    const data = JSON.parse(readFileSync(this.path, 'utf8'));
    const cipher = createDecipheriv(
      'aes-256-gcm',
      this.getKey(false),
      Buffer.from(data.iv, 'base64'),
    );
    cipher.setAuthTag(Buffer.from(data.tag, 'base64'));
    return JSON.parse(
      Buffer.concat([cipher.update(Buffer.from(data.data, 'base64')), cipher.final()]).toString(),
    );
  }
  write(value: object) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.getKey(!existsSync(this.path)), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    writeFileSync(
      `${this.path}.tmp`,
      JSON.stringify({
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      }),
      { mode: 0o600 },
    );
    renameSync(`${this.path}.tmp`, this.path);
  }
}
