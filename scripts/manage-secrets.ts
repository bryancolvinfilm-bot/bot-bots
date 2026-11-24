import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { Credentials, credentialPolicySchema } from '../apps/server/credentials';
import {
  credentialsDirectory,
  FileSecrets,
  OsSecrets,
  secretAlias,
} from '../apps/server/host-secrets';

async function hiddenInput() {
  if (!stdin.isTTY || !stdin.setRawMode)
    throw Error(
      'Enter secrets in a local interactive terminal; secret values are never command-line arguments.',
    );
  stdout.write('Secret (hidden; Enter to save): ');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('data', data);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      error ? reject(error) : resolve(value);
    };
    const data = (text: string | Buffer) => {
      for (const char of String(text)) {
        if (char === '\u0003') return finish(Error('Cancelled.'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ' && char !== '\u001b') value += char;
        if (value.length > 10000) return finish(Error('Secret is too long.'));
      }
    };
    stdin.on('data', data);
  });
}
const dir = credentialsDirectory();
const [command = 'help', alias] = process.argv.slice(2);
try {
  if (command === 'init') {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const policy = join(dir, 'permissions.json');
    if (!existsSync(policy))
      writeFileSync(
        policy,
        JSON.stringify(
          {
            version: 1,
            enabled: false,
            storage: 'os',
            allowBotTerminal: false,
            bindings: [],
            operations: [],
          },
          null,
          2,
        ),
        { mode: 0o600, flag: 'wx' },
      );
    const example = join(dir, 'permissions.example.json');
    if (!existsSync(example))
      writeFileSync(
        example,
        JSON.stringify(
          {
            version: 1,
            enabled: false,
            storage: 'os',
            allowBotTerminal: false,
            bindings: [
              {
                id: 'openai-main',
                secret: 'openai-key',
                purpose: 'model',
                url: 'https://api.openai.com/v1',
              },
            ],
            operations: [
              {
                id: 'netlify-sites',
                label: 'List my Netlify sites',
                enabled: true,
                botIds: ['info-page-generate'],
                url: 'https://api.netlify.com/api/v1/sites',
                method: 'GET',
                auth: { type: 'bearer', secret: 'netlify-token' },
                inputFields: [],
                responseFields: ['id', 'name', 'ssl_url'],
              },
            ],
          },
          null,
          2,
        ),
        { mode: 0o600, flag: 'wx' },
      );
    console.log(
      `External credential controls prepared at ${dir}\nNo operations are enabled. Edit permissions.json yourself; permissions.example.json contains examples without any key values.`,
    );
  } else if (['set', 'remove', 'status', 'test'].includes(command)) {
    if (!existsSync(join(dir, 'permissions.json'))) throw Error('Run init first.');
    const policy = credentialPolicySchema.parse(
      JSON.parse(readFileSync(join(dir, 'permissions.json'), 'utf8')),
    );
    const backend =
      policy.storage === 'file' ? new FileSecrets(join(dir, 'secrets')) : new OsSecrets();
    if (command === 'set') {
      if (!alias || !secretAlias.test(alias))
        throw Error(
          'Choose a simple alias such as netlify-token; do not put a key value on the command line.',
        );
      const value = await hiddenInput();
      if (!value) throw Error('An empty secret was not saved.');
      backend.set(alias, value);
      console.log(`Saved ${alias} in ${backend.kind}. No secret value was displayed.`);
    } else if (command === 'remove') {
      if (!alias || !secretAlias.test(alias)) throw Error('Supply the alias to revoke.');
      console.log(
        backend.delete(alias)
          ? `Removed ${alias}. Future operations cannot use it.`
          : `${alias} is already absent.`,
      );
    } else if (command === 'test') {
      const name = `qa-${randomUUID()}`,
        value = randomBytes(32).toString('base64');
      try {
        backend.set(name, value);
        if (backend.get(name) !== value) throw Error('Credential round trip failed.');
        console.log(`${backend.kind}: write/read verified with a temporary test credential.`);
      } finally {
        backend.delete(name);
      }
      console.log('Temporary test credential removed.');
    } else {
      const state = new Credentials(dir).state();
      console.log(
        JSON.stringify(
          {
            directory: dir,
            backend: backend.kind,
            enabled: state.enabled,
            botTerminalBlocked: state.botTerminalBlocked,
            connections: policy.bindings.map((b) => ({
              id: b.id,
              purpose: b.purpose,
              destination: b.url,
            })),
            operations: state.capabilities,
            error: state.error,
          },
          null,
          2,
        ),
      );
    }
  } else {
    console.log(
      'Bot-Bots external secret manager\nCommands: init | set ALIAS | remove ALIAS | status | test\nset asks for the secret with hidden input. No command prints secret values.\nEnable/revoke bot operations by editing the external permissions.json or deleting credentials in your OS store.',
    );
  }
} catch (error) {
  console.error(
    error instanceof Error && !(error as Error).message.includes('{')
      ? (error as Error).message
      : 'Credential setup failed; check the external policy and OS credential store.',
  );
  process.exitCode = 1;
}
