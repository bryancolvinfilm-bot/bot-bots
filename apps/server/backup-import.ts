import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import type { Bot, Routine, Shape, Skill } from '../../packages/shared/types';
import { AVATAR_SHAPES } from '../../packages/shared/types';
import { extractMemories } from './memory-import';
import { Store } from './store';

interface SourceManifest {
  revision: string;
  date: string;
  archive: string;
  archiveSha256: string;
  files: Record<string, string>;
}
export interface TeamImport {
  revision: string;
  archiveSha256: string;
  at: string;
  bots: number;
  skills: number;
  routines: number;
  rollback?: string;
  workspaceSource: string;
  agentIds: Record<string, string>;
}
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const colors: Record<string, string> = {
  magenta: '#da7bdf',
  blue: '#78a5ef',
  green: '#90bc8b',
  yellow: '#f4c46d',
  orange: '#eda77c',
  red: '#ef8589',
  purple: '#aa94df',
  cyan: '#74c7c3',
  pink: '#eea1bd',
  violet: '#b59bea',
  black: '#4c505a',
};
const roles: Record<string, string> = {
  'Boss Man': 'Your team coordinator',
  Calendar: 'A little more organized',
  Contacts: 'Your people, connected',
  Comparison: 'Find your best fit',
  'Family Events': 'Little adventures, together',
  'Film Edit Jobs': 'Your next great edit',
  'Film Networking': 'Make the right connections',
  'Info Page Generate': 'Ideas into lovely pages',
  'Real Estate': 'Find a place to call home',
  Research: 'Curiosity, with sources',
  'Social Media': 'Your social sidekick',
  Texting: 'Keep you in the loop',
  Worker1: 'An extra pair of hands',
  Worker2: 'Ready to lend a hand',
  Worker3: 'Always up for a task',
};

function sourceManifest(source: string): SourceManifest | undefined {
  const path = join(source, 'bot-bots-import.json');
  if (!existsSync(path)) return undefined;
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as SourceManifest;
  if (
    !/^grok-bot-backup-\d{4}-\d{2}-\d{2}$/.test(manifest.revision) ||
    manifest.revision !== `grok-bot-backup-${manifest.date}` ||
    !/^[a-f0-9]{64}$/.test(manifest.archiveSha256) ||
    !manifest.files ||
    Object.keys(manifest.files).length === 0
  )
    throw Error('Invalid bot backup import manifest.');
  const root = resolve(source);
  function check(dir: string) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry),
        info = lstatSync(path);
      if (info.isSymbolicLink()) throw Error('Bot backup contains a symbolic link.');
      if (info.isDirectory()) check(path);
      else {
        const name = relative(root, path).replaceAll('\\', '/');
        if (name === 'bot-bots-import.json') continue;
        if (manifest.files[name] !== hash(readFileSync(path)))
          throw Error(`Bot backup integrity check failed: ${name}`);
      }
    }
  }
  for (const name of Object.keys(manifest.files)) {
    const path = resolve(root, name),
      rel = relative(root, path);
    if (
      name.includes('\\') ||
      isAbsolute(name) ||
      rel.startsWith('..') ||
      isAbsolute(rel) ||
      !existsSync(path)
    )
      throw Error('Invalid or missing bot backup file.');
  }
  check(root);
  return manifest;
}

/** Read actual saved schedules; no hand-maintained November 15 routine list. */
export function backupRoutines(bot: Bot): Routine[] {
  const section =
    /^## (?:\d+\.\s*)?Routines[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/im.exec(
      bot.instructions,
    )?.[1] ?? '';
  const result: Routine[] = [];
  const schedules = [...section.matchAll(/CRON_TZ=([^\s`]+)\s+([\d*,/\-]+(?:\s+[\d*,/\-]+){4})/g)];
  for (const match of schedules) {
    const before = section.slice(0, match.index);
    const headings = [...before.matchAll(/^(?:###\s+|\d+\.\s+)([^\n]+)/gm)];
    const heading = headings.at(-1)?.[1];
    if (!heading) throw Error(`Missing saved routine name for ${bot.name}.`);
    const name = heading
      .replace(/^\d+\.\s*/, '')
      .replace(/\s+\((?:id|folder)[:\s][^)]*\).*$/, '')
      .replace(/\s+[—–]\s+schedule\s+.*$/i, '')
      .trim();
    const cron = match[2].replace(/\s+/g, ' '),
      timezone = match[1];
    CronExpressionParser.parse(cron, { tz: timezone });
    result.push({
      id: `import-${bot.id}-${slug(name)}`,
      botId: bot.id,
      name,
      cron,
      timezone,
      prompt: `Run only the saved routine named "${name}" below. The bot's latest dated updates take precedence over older saved prompts. Use only connected tools and current Bot-Bots permissions; never claim an unconnected service worked.\n\n${section}`,
      enabled: false,
      source: bot.sourceFile,
    });
  }
  if (new Set(result.map((r) => r.id)).size !== result.length)
    throw Error(`Duplicate saved routine for ${bot.name}.`);
  return result;
}

export function loadBackup(source: string) {
  if (!existsSync(join(source, 'manifest.md')))
    throw Error(`Backup not found at ${source}. Restore reference/grok-backup first.`);
  const manifest = sourceManifest(source);
  const markdown = readFileSync(join(source, 'manifest.md'), 'utf8');
  const agentIds: Record<string, string> = {};
  const files = readdirSync(join(source, 'bots')).filter((n) => n.endsWith('.md'));
  const dirs = readdirSync(join(source, 'profiles')).sort((a, b) =>
    a === 'Boss Man' ? -1 : b === 'Boss Man' ? 1 : a.localeCompare(b),
  );
  const used = new Set<string>();
  const bots = dirs.map((name, index): Bot => {
    const profile = JSON.parse(
      readFileSync(join(source, 'profiles', name, 'profile.json'), 'utf8'),
    );
    if (profile.name !== name) throw Error(`Profile name mismatch for ${name}.`);
    const candidates = files.filter((file) => slug(file.slice(0, -3)) === slug(name));
    if (candidates.length !== 1) throw Error(`Missing or ambiguous bot instructions for ${name}.`);
    const filename = candidates[0];
    used.add(filename);
    const id = slug(name);
    const row = markdown.split('\n').find((line) => line.startsWith(`| ${name} |`));
    const legacyId = row?.match(/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/i)?.[0];
    if (legacyId) agentIds[legacyId] = id;
    const shapes: readonly Shape[] = AVATAR_SHAPES;
    return {
      id,
      name,
      title: profile.title?.trim() || roles[name] || 'Your helpful teammate',
      description: profile.description ?? '',
      instructions: readFileSync(join(source, 'bots', filename), 'utf8'),
      avatar: {
        shape: shapes.includes(profile.avatarShape)
          ? profile.avatarShape
          : shapes[index % shapes.length],
        color: /^#[a-f\d]{6}$/i.test(profile.avatarColor)
          ? profile.avatarColor
          : (colors[profile.avatarColor] ?? Object.values(colors)[index % 9]),
        accent: profile.avatarColor === 'black' ? '#f4eef8' : '#30342e',
      },
      modelId: null,
      enabled: true,
      sourceFile: `bots/${filename}`,
    };
  });
  if (
    !bots.length ||
    used.size !== files.length ||
    new Set(bots.map((b) => b.id)).size !== bots.length
  )
    throw Error('Bot backup has unmatched or duplicate profiles/instructions.');
  const skills: Skill[] = [];
  for (const dir of readdirSync(join(source, 'skills'))) {
    const path = join(source, 'skills', dir, 'SKILL.md');
    if (existsSync(path)) skills.push({ id: dir, name: dir, content: readFileSync(path, 'utf8') });
  }
  const routines = bots.flatMap(backupRoutines);
  return { manifest, bots, skills, routines, agentIds };
}
type Backup = ReturnType<typeof loadBackup>;

/** Called inside the seed transaction, with host ownership already acquired. */
export function writeBackupTeam(store: Store, backup: Backup, now: string) {
  const categories = new Map(store.all('bots').map((b) => [b.id, b.categoryId]));
  for (const collection of ['bots', 'memory', 'skills', 'routines'] as const)
    store.db.prepare('DELETE FROM documents WHERE collection=?').run(collection);
  const shared = new Set<string>();
  for (const bot of backup.bots) {
    // Category is presentation only; no previous instructions, clones, model pins or memory survive.
    const categoryId = categories.get(bot.id);
    store.put('bots', categoryId ? { ...bot, categoryId } : bot);
    for (const fact of extractMemories(bot.instructions)) {
      if (fact.category === 'profile') {
        for (const line of fact.content.split('\n').filter((l) => l.trim()))
          shared.add(line.trimEnd());
      } else
        store.put('memory', {
          id: `import-${hash(`${bot.id}:${fact.content}`).slice(0, 24)}`,
          botId: bot.id,
          ...fact,
          createdAt: now,
        });
    }
  }
  if (shared.size)
    store.put('memory', {
      id: 'import-shared-profile',
      botId: null,
      category: 'profile',
      content: [...shared].join('\n'),
      createdAt: now,
    });
  for (const skill of backup.skills) store.put('skills', skill);
  for (const routine of backup.routines) store.put('routines', routine);
  store.setConfig('memoryImportV2', true);
}

export function prepareImport(
  store: Store,
  source: string,
  backup: Backup,
  replacing: boolean,
  recoverInterruptedRuns = false,
) {
  const manifest = backup.manifest;
  if (!manifest) return undefined;
  if (!recoverInterruptedRuns && store.all('runs').some((r) => r.status === 'running'))
    throw Error('Finish or stop active bot tasks before replacing the team. Nothing was imported.');
  const now = new Date().toISOString();
  let rollback: string | undefined;
  if (replacing) {
    const directory = join(dirname(store.path), 'backups');
    mkdirSync(directory, { recursive: true });
    rollback = join(
      directory,
      `before-${manifest.revision}-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`,
    );
    store.db.prepare('VACUUM INTO ?').run(rollback);
  }
  const workspaceSource = `imports/${manifest.revision}`;
  const assets = join(dirname(store.path), 'workspace', workspaceSource);
  // Imported scripts remain files; the import never executes them.
  // Reserve a unique directory rather than overwriting any existing user files.
  const assetPath = existsSync(assets) ? `${assets}-${randomUUID().slice(0, 8)}` : assets;
  cpSync(source, assetPath, { recursive: true, errorOnExist: true, force: false });
  return {
    revision: manifest.revision,
    archiveSha256: manifest.archiveSha256,
    at: now,
    bots: backup.bots.length,
    skills: backup.skills.length,
    routines: backup.routines.length,
    rollback,
    workspaceSource: relative(join(dirname(store.path), 'workspace'), assetPath).replaceAll(
      '\\',
      '/',
    ),
    agentIds: backup.agentIds,
  } satisfies TeamImport;
}

export function replaceExistingTeam(
  store: Store,
  source: string,
  backup: Backup,
  recoverInterruptedRuns = false,
) {
  const previous = store.config<TeamImport>('teamImport');
  if (!backup.manifest || previous?.revision === backup.manifest.revision) return false;
  if (previous && previous.revision > backup.manifest.revision) return false;
  const imported = prepareImport(store, source, backup, true, recoverInterruptedRuns)!;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    writeBackupTeam(store, backup, imported.at);
    // With the host lock held, running records are interrupted work from a stopped host.
    for (const run of store.all('runs'))
      if (run.status === 'running')
        store.put('runs', {
          ...run,
          status: 'failed',
          finishedAt: imported.at,
          error:
            'The team was refreshed after the previous host stopped. Interrupted work was not resumed.',
          work: run.work?.map((work) =>
            work.status === 'running'
              ? {
                  ...work,
                  status: 'failed',
                  finishedAt: imported.at,
                  attempts: work.attempts.map((attempt) =>
                    attempt.status === 'running'
                      ? { ...attempt, status: 'failed', finishedAt: imported.at }
                      : attempt,
                  ),
                }
              : work,
          ),
        });
    for (const conversation of store.all('conversations'))
      store.put('conversations', { ...conversation, contextResetAt: imported.at });
    const settings = store.settings();
    if (settings.mainBotId && !store.get('bots', settings.mainBotId))
      store.setConfig('settings', { ...settings, mainBotId: null });
    store.setConfig('initialized', { at: imported.at, source: imported.revision });
    store.setConfig('teamImport', imported);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return true;
}
