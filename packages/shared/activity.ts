import type { Run, TaskType } from './types';

export type WorkPhase = 'preparing' | 'thinking' | 'responding' | 'waiting' | 'tool' | 'fallback';
export interface BotWork {
  runId: string;
  conversationId?: string;
  phase: WorkPhase;
  task: TaskType;
  tool?: string;
  since: string;
  detail: string;
}

/** Follow the real handoff stack so delegated bots light up alongside their coordinator. */
export function activeBotWork(runs: Run[]): Map<string, BotWork> {
  const all = new Map<string, BotWork>();
  for (const run of runs.filter((run) => run.status === 'running')) {
    const work = new Map<string, BotWork>();
    const stack = [run.botId];
    const update = (
      botId: string,
      phase: WorkPhase,
      at = run.startedAt,
      detail = '',
      tool?: string,
      task?: TaskType,
    ) =>
      work.set(botId, {
        runId: run.id,
        conversationId: botId === run.botId ? run.conversationId : undefined,
        phase,
        task: task ?? work.get(botId)?.task ?? run.task,
        since: at,
        detail,
        tool,
      });
    update(run.botId, 'preparing');
    for (const event of run.events) {
      if (event.phase === 'returned') {
        const index = stack.indexOf(event.botId);
        if (index >= 0) {
          for (const id of stack.splice(index)) work.delete(id);
        }
        if (event.targetBotId) update(event.targetBotId, 'responding', event.at, event.text);
        continue;
      }
      if (event.phase === 'delegating' && event.targetBotId) {
        update(event.botId, 'waiting', event.at, event.text);
        if (!stack.includes(event.targetBotId)) stack.push(event.targetBotId);
        update(event.targetBotId, 'preparing', event.at, event.text);
        continue;
      }
      if (event.kind === 'route') {
        if (!stack.includes(event.botId)) {
          const previous = stack.at(-1);
          if (previous) update(previous, 'waiting', event.at, event.text);
          stack.push(event.botId);
        }
        update(
          event.botId,
          event.phase === 'responding' ? 'responding' : 'thinking',
          event.at,
          event.text,
          undefined,
          event.task,
        );
      } else if (event.kind === 'tool')
        update(
          event.botId,
          event.tool === 'delegate' ? 'waiting' : 'tool',
          event.at,
          event.text,
          event.tool,
        );
      else if (event.kind === 'fallback') update(event.botId, 'fallback', event.at, event.text);
      else if (event.kind === 'start') update(event.botId, 'preparing', event.at, event.text);
    }
    for (const [id, status] of work) {
      if (!all.has(id) || Date.parse(status.since) >= Date.parse(all.get(id)!.since))
        all.set(id, status);
    }
  }
  return all;
}

const phrases = {
  preparing: ['Rolling up the sleeves', 'Warming up the gears', 'Getting the ideas ready'],
  general: ['Pondering', 'Chipping away', 'Pontificating a little', 'Turning tiny gears'],
  coding: ['Tinkering', 'Configuring the bits', 'Fitting the pieces together', 'Chipping away'],
  writing: [
    'Finding the right words',
    'Putting pen to pixels',
    'Shaping a little story',
    'Polishing a thought',
  ],
  planning: ['Lining up the ducks', 'Plotting the next steps', 'Pondering the options'],
  research: [
    'Sifting through the brief',
    'Connecting the dots',
    'Pondering the clues',
    'Mulling it over',
  ],
  responding: ['Polishing the reply', 'Tying up loose ends', 'Adding the finishing touches'],
  waiting: ['Passing the baton', 'Letting a teammate cook', 'Keeping the crew in sync'],
  fallback: ['Trying another brain', 'Finding a fresh gear', 'Taking the scenic route'],
} as const;
const toolPhrases: Record<string, readonly string[]> = {
  credential_use: ['Waiting for your go-ahead', 'Keeping the key safely tucked away'],
  draft_start: ['Opening the notebook', 'Making room for ideas'],
  draft_append: ['Chipping away', 'Saving another little piece'],
  draft_read: ['Checking the notebook', 'Picking up the thread'],
  draft_patch: ['Polishing a little detail', 'Stitching things together'],
  draft_finish: ['Tying the bow', 'Putting the pieces together'],
  terminal_request: ['Waiting for your go-ahead', 'Keeping the command on hold'],
  page_preview: ['Taking it for a spin', 'Checking the little details'],
  web_search: ['Scouting the web', 'Following the breadcrumbs'],
  browser_open: ['Opening a little window', 'Following a source'],
  browser_read: ['Reading the fine print', 'Peeking at the page'],
  browser_click: ['Following the trail', 'Taking a closer look'],
  browser_type: ['Typing a little query', 'Filling in the details'],
  browser_scroll: ['Scrolling for clues', 'Looking a little further'],
  memory_save: ['Tucking that away', 'Making a mental note'],
  memory_search: ['Jogging the memory', 'Peeking in the memory box'],
  skill_read: ['Peeking at the playbook', 'Brushing up on the steps'],
  page_create: ['Putting the page together', 'Giving the page some sparkle'],
  workspace_read: ['Peeking at the notes', 'Reading the little details'],
  workspace_write: ['Putting things in place', 'Jotting it all down'],
  workspace_list: ['Rummaging in the files', 'Seeing what’s in the drawer'],
  list_bots: ['Rounding up the crew', 'Checking in with the team'],
};
export function workLabel(
  work: BotWork,
  botId: string,
  now = Date.now(),
  bot?: import('./types').Bot,
) {
  const custom = bot?.processingPhrases;
  const personalized =
    work.phase === 'thinking'
      ? custom?.[work.task]?.length
        ? custom[work.task]
        : custom?.general
      : work.phase === 'waiting' || work.phase === 'responding'
        ? custom?.[work.phase]
        : undefined;
  const options = personalized?.length
    ? personalized
    : work.phase === 'thinking'
      ? phrases[work.task]
      : work.phase === 'tool'
        ? (toolPhrases[work.tool ?? ''] ?? ['Chipping away', 'Taking care of the details'])
        : phrases[work.phase];
  const seed = [...botId].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  const tick = Math.max(0, Math.floor((now - Date.parse(work.since)) / 6000));
  return options[(seed + tick) % options.length];
}
