import type { Bot } from './types';

/** A permanent, available teammate can coordinate; prototypes and task clones cannot own this role. */
export function canBeMainBot(bot: Bot | undefined): bot is Bot {
  return (
    !!bot?.enabled && !bot.isPrototype && !bot.prototypeId && !bot.archivedAt && !bot.deletedAt
  );
}

export function mainBot(bots: Bot[], id?: string | null) {
  const selected = bots.find((b) => b.id === id);
  return canBeMainBot(selected) ? selected : undefined;
}
