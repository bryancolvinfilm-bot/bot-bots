import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'win32') throw Error('Build the Windows launcher on Windows.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.env.WINDIR ?? 'C:\\Windows';
const compiler = ['Framework64', 'Framework']
  .map((framework) => join(windows, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'))
  .find(existsSync);
if (!compiler) throw Error('The Windows .NET Framework C# compiler was not found.');

execFileSync(
  compiler,
  [
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/reference:System.Windows.Forms.dll',
    `/win32icon:${join(root, 'resources', 'bot-bots.ico')}`,
    `/out:${join(root, 'Bot-Bots.exe')}`,
    join(root, 'apps', 'launcher', 'Program.cs'),
  ],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
console.log('Created Bot-Bots.exe in the project folder.');
