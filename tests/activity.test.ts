import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeBotWork, workLabel } from '../packages/shared/activity';
import type { Run, RunEvent } from '../packages/shared/types';

const startedAt = '2026-11-21T20:00:00.000Z';
function run(events: RunEvent[], extra: Partial<Run> = {}): Run {
  return {
    id: 'job',
    botId: 'boss-man',
    conversationId: 'thread',
    prompt: 'A task',
    task: 'coding',
    status: 'running',
    startedAt,
    tokens: 0,
    events,
    ...extra,
  };
}
function event(botId: string, kind: RunEvent['kind'], extra: Partial<RunEvent> = {}): RunEvent {
  return { botId, kind, text: 'A real runtime event', at: startedAt, ...extra };
}

test('delegated and nested bots appear busy while coordinators wait, then clear as each handoff returns', () => {
  const events = [
    event('boss-man', 'route'),
    event('boss-man', 'handoff', { phase: 'delegating', targetBotId: 'research' }),
    event('research', 'route', { task: 'research' }),
    event('research', 'handoff', { phase: 'delegating', targetBotId: 'worker1' }),
    event('worker1', 'tool', { tool: 'memory_search' }),
  ];
  const active = activeBotWork([run(events)]);
  assert.equal(active.get('boss-man')?.phase, 'waiting');
  assert.equal(active.get('research')?.phase, 'waiting');
  assert.equal(active.get('research')?.task, 'research');
  assert.equal(active.get('worker1')?.phase, 'tool');
  assert.equal(active.get('worker1')?.tool, 'memory_search');
  assert.equal(active.get('boss-man')?.conversationId, 'thread');
  assert.equal(active.get('worker1')?.conversationId, undefined);
  events.push(event('worker1', 'handoff', { phase: 'returned', targetBotId: 'research' }));
  const next = activeBotWork([run(events)]);
  assert.equal(next.has('worker1'), false);
  assert.equal(next.get('research')?.phase, 'responding');
  assert.equal(next.get('boss-man')?.phase, 'waiting');
  events.push(event('research', 'handoff', { phase: 'returned', targetBotId: 'boss-man' }));
  const last = activeBotWork([run(events)]);
  assert.equal(last.size, 1);
  assert.equal(last.get('boss-man')?.phase, 'responding');
});
test('completed, failed, and cancelled runs stop every spinner while concurrent work stays visible', () => {
  const events = [event('boss-man', 'handoff', { phase: 'delegating', targetBotId: 'worker1' })];
  for (const status of ['completed', 'failed', 'cancelled'] as const)
    assert.equal(activeBotWork([run(events, { status })]).size, 0);
  const returned = [
    ...events,
    event('worker1', 'handoff', { phase: 'returned', targetBotId: 'boss-man' }),
  ];
  const active = activeBotWork([
    run(returned),
    run([event('worker1', 'route')], {
      id: 'another-job',
      botId: 'worker1',
      conversationId: 'worker-thread',
    }),
  ]);
  assert.equal(active.has('worker1'), true);
  assert.equal(active.get('worker1')?.runId, 'another-job');
});
test('wording rotates within the real activity category without inventing a web search', () => {
  const work = activeBotWork([run([event('boss-man', 'tool', { tool: 'memory_save' })])]).get(
    'boss-man',
  )!;
  const first = workLabel(work, 'boss-man', Date.parse(startedAt));
  const next = workLabel(work, 'boss-man', Date.parse(startedAt) + 6000);
  assert.notEqual(first, next);
  assert.match(first, /mental note|Tucking/);
  assert.match(next, /mental note|Tucking/);
  const coding = { ...work, phase: 'thinking' as const, task: 'coding' as const };
  assert.match(
    workLabel(coding, 'worker1', Date.parse(startedAt)),
    /Tinkering|Configuring|Fitting|Chipping/,
  );
  const research = { ...coding, task: 'research' as const };
  assert.doesNotMatch(
    workLabel(research, 'worker1', Date.parse(startedAt)),
    /browsing|searching|found|verified/i,
  );
});
