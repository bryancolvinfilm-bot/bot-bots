import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..'),
  output = join(root, 'dist/speech');
mkdirSync(output, { recursive: true });
const run = (file, args) =>
  execFileSync(file, args, { cwd: root, stdio: 'inherit', windowsHide: true });
if (process.platform === 'win32') {
  const windows = process.env.WINDIR ?? 'C:\\Windows';
  const compiler = ['Framework64', 'Framework']
    .map((framework) => join(windows, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'))
    .find(existsSync);
  const gac = join(windows, 'Microsoft.NET/assembly/GAC_MSIL/System.Speech');
  const referenceRoot = join(
    process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles ?? '',
    'Reference Assemblies/Microsoft/Framework/.NETFramework',
  );
  const speech = [
    ...(existsSync(gac)
      ? readdirSync(gac).map((version) => join(gac, version, 'System.Speech.dll'))
      : []),
    ...(existsSync(referenceRoot)
      ? readdirSync(referenceRoot)
          .sort()
          .reverse()
          .map((version) => join(referenceRoot, version, 'System.Speech.dll'))
      : []),
  ].find(existsSync);
  if (!compiler || !speech)
    throw Error('Windows .NET Framework speech components are required to build dictation.');
  run(compiler, [
    '/nologo',
    '/target:exe',
    '/platform:anycpu',
    '/optimize+',
    `/reference:${speech}`,
    '/reference:System.Web.Extensions.dll',
    `/out:${join(output, 'BotBotsSpeech.exe')}`,
    join(root, 'apps', 'speech', 'WindowsSpeech.cs'),
  ]);
} else if (process.platform === 'darwin') {
  const contents = join(output, 'BotBotsSpeech.app/Contents'),
    binaries = join(contents, 'MacOS');
  mkdirSync(binaries, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.botbots.dictation</string><key>CFBundleName</key><string>Bot-Bots Dictation</string><key>CFBundleDisplayName</key><string>Bot-Bots Dictation</string><key>CFBundleExecutable</key><string>BotBotsSpeech</string><key>CFBundleVersion</key><string>1</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>NSSpeechRecognitionUsageDescription</key><string>Turn your spoken prompt into editable text in Bot-Bots. Apple speech services may process audio when on-device recognition is unavailable.</string></dict></plist>`;
  writeFileSync(join(contents, 'Info.plist'), plist);
  const parts = ['arm64', 'x86_64'].map((arch) => {
    const file = join(root, 'dist', `speech-${arch}`);
    run('xcrun', [
      'swiftc',
      '-swift-version',
      '5',
      '-O',
      '-target',
      `${arch}-apple-macosx12.0`,
      '-framework',
      'Speech',
      '-framework',
      'AVFoundation',
      'apps/speech/MacSpeech.swift',
      '-o',
      file,
    ]);
    return file;
  });
  run('lipo', ['-create', ...parts, '-output', join(binaries, 'BotBotsSpeech')]);
  run('codesign', ['--force', '--sign', '-', join(output, 'BotBotsSpeech.app')]);
} else
  writeFileSync(
    join(output, 'platform.txt'),
    'Native dictation requires the Windows or macOS desktop app.\n',
  );
console.log('Built native system-speech helper.');
