import { createHash } from 'node:crypto';
import type { Memory } from '../../packages/shared/types';
import { Store } from './store';
const memorySection =
  /^## ((?:\d+\.\s*)?Memory[^\n]*|Shared user facts[^\n]*)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gim;
export function stripImportedMemory(instructions: string) {
  return instructions.replace(memorySection, '');
}
export function extractMemories(
  instructions: string,
): { category: Memory['category']; content: string }[] {
  const result: { category: Memory['category']; content: string }[] = [];
  const category = (heading: string): Memory['category'] =>
    /user[_ ]profile|shared user/i.test(heading)
      ? 'profile'
      : /behavior|standing rules/i.test(heading)
        ? 'behavior'
        : /workstream/i.test(heading)
          ? 'workstream'
          : 'world';
  for (const section of instructions.matchAll(new RegExp(memorySection))) {
    const content = section[2].replace(/^\*\*([^\n*]+)\*\*\s*$/gm, '### $1');
    const sub = [...content.matchAll(/^### ([^\n]*)\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)];
    if (sub.length)
      for (const match of sub)
        result.push({ category: category(match[1]), content: `${match[1]}\n\n${match[2].trim()}` });
    else if (content.trim())
      result.push({ category: category(section[1]), content: content.trim() });
  }
  return result;
}
export function migrateMemory(store: Store) {
  if (store.config('memoryImportV2')) return;
  const initialized = store.config<{ at: string }>('initialized');
  const originalSeedContents = new Set(
    store
      .all('bots')
      .flatMap((bot) =>
        [...bot.instructions.matchAll(/^## (Memory[^\n]*)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map(
          (m) => m[2].trim(),
        ),
      ),
  );
  store.db.exec('BEGIN');
  try {
    // Replace only untouched seed entries; preserve every memory created or edited after import.
    for (const m of store.all('memory'))
      if (m.createdAt === initialized?.at && originalSeedContents.has(m.content))
        store.remove('memory', m.id);
    const shared = new Set<string>();
    for (const bot of store.all('bots')) {
      for (const fact of extractMemories(bot.instructions)) {
        if (fact.category === 'profile') {
          for (const line of fact.content.split('\n').filter((l) => /^\s*[-\d]/.test(l)))
            shared.add(line.trim());
        } else {
          const id = `import-${createHash('sha256').update(`${bot.id}:${fact.content}`).digest('hex').slice(0, 24)}`;
          store.put('memory', { id, botId: bot.id, ...fact, createdAt: new Date().toISOString() });
        }
      }
    }
    if (shared.size)
      store.put('memory', {
        id: 'import-shared-profile',
        botId: null,
        category: 'profile',
        content: [...shared].join('\n'),
        createdAt: new Date().toISOString(),
      });
    store.setConfig('memoryImportV2', true);
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
}
