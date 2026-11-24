import type { Bot } from './types';
import { plainMentionText } from './mentions';
export interface PlannedHandoff {
  botId: string;
  kind: 'research' | 'website' | 'workers';
  tasks?: string[];
}
export function workerAssignments(prompt: string) {
  const count = Math.min(
    30,
    Math.max(
      1,
      Number(
        /\b(?:spin|fire|launch|use|run|create)(?:\s+up)?\s+(\d+)\b/i.exec(prompt)?.[1] ??
          /\b(\d+)\s+(?:clones|workers|of you|of them)\b/i.exec(prompt)?.[1],
      ) || (/\b(?:a bunch|a few|several)\b/i.test(prompt) ? 4 : 1),
    ),
  );
  const angles = [
    'find strong candidates with current sources',
    'look for useful alternatives and overlooked options',
    'verify details, constraints and weak claims',
    'compare the evidence and identify the strongest fit',
  ];
  return Array.from(
    { length: count },
    (_, index) =>
      `Original human task: ${plainMentionText(prompt).slice(0, 5000)}\nYour independent scope (${index + 1}/${count}): ${count > 1 ? angles[index % angles.length] : 'complete the scoped assignment'}. Return actual findings, sources and limitations to the prototype coordinator. Do not send messages to the human or start more workers.`,
  );
}
/** Main-bot routing is a harness decision for clear specialist work, not a promise in model prose. */
export function delegationPlan(prompt: string, bots: Bot[]): PlannedHandoff[] {
  const text = plainMentionText(prompt).toLowerCase();
  if (
    /\b(?:do not|don t|don't|without|no)\s+delegat|\b(?:handle|do)\s+(?:it|this)\s+yourself/.test(
      text,
    )
  )
    return [];
  const available = bots.filter((bot) => bot.enabled && !bot.prototypeId);
  const prototype = available.find(
    (bot) =>
      bot.isPrototype &&
      (prompt.includes(`#bot/${bot.id}`) || text.includes(`@${bot.name.toLowerCase()}`)),
  );
  if (prototype && /\b(?:spin|fire|launch|use|run|clone|workers)\b/.test(text)) {
    return [
      {
        botId: prototype.id,
        kind: 'workers',
        tasks: workerAssignments(prompt),
      },
    ];
  }
  const site =
    /\b(?:make|build|create|design|generate|write)\b[\s\S]{0,140}\b(?:web\s*site|web\s*page|html|landing page|game|snake|frogger)\b/.test(
      text,
    ) && !/\b(?:don t|don't|do not)\s+(?:make|build|create)/.test(text);
  const research = /\b(?:find|research|look up|investigate|compare|gather|best|recommend)\b/.test(
    text,
  );
  const researcher = available.find(
    (bot) => !bot.isPrototype && (bot.id === 'research' || /^research(?: lead)?$/i.test(bot.name)),
  );
  const builder = available.find(
    (bot) =>
      !bot.isPrototype &&
      (bot.id === 'info-page-generate' ||
        /website|page.?build|web.?develop/i.test(
          `${bot.name} ${bot.title} ${bot.description.slice(0, 200)}`,
        )),
  );
  return [
    ...(research && researcher ? [{ botId: researcher.id, kind: 'research' as const }] : []),
    ...(site && builder ? [{ botId: builder.id, kind: 'website' as const }] : []),
  ];
}
