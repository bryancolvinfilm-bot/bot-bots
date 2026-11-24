import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collaborationHandoffs, mergeRunState } from '../packages/shared/collaboration';
import type { Handoff, Run, RunEvent } from '../packages/shared/types';

const at = '2026-11-21T20:00:00.000Z';
const makeRun = (events: RunEvent[], extra: Partial<Run> = {}): Run => ({
  id: 'run',
  botId: 'boss-man',
  conversationId: 'thread',
  prompt: 'Collaborate',
  task: 'writing',
  status: 'running',
  startedAt: at,
  tokens: 0,
  events,
  ...extra,
});
function handoff(info: Handoff): RunEvent {
  return {
    kind: 'handoff',
    at,
    botId: info.status === 'working' ? info.fromBotId : info.toBotId,
    text: 'Real handoff',
    handoffId: info.id,
    handoff: info,
    phase: info.status === 'working' ? 'delegating' : 'returned',
    targetBotId: info.status === 'working' ? info.toBotId : info.fromBotId,
  };
}

test('nested and repeated handoffs keep separate identities, full briefs, actual replies, and the correct logs', () => {
  const parent: Handoff = {
    id: 'parent',
    fromBotId: 'boss-man',
    toBotId: 'research',
    brief: 'A full brief '.repeat(80),
    status: 'working',
  };
  const child: Handoff = {
    id: 'child',
    parentId: 'parent',
    fromBotId: 'research',
    toBotId: 'worker1',
    brief: 'One specific angle',
    status: 'working',
  };
  const repeated: Handoff = { ...child, id: 'another', brief: 'A different angle' };
  const events = [
    handoff(parent),
    handoff(child),
    {
      kind: 'tool' as const,
      at,
      botId: 'worker1',
      text: 'Reading a file',
      tool: 'workspace_read',
      handoffId: 'child',
    },
    handoff({ ...child, status: 'completed', answer: 'First actual answer' }),
    handoff(repeated),
    { kind: 'route' as const, at, botId: 'worker1', text: 'Using the model', handoffId: 'another' },
    handoff({ ...repeated, status: 'completed', answer: 'Second actual answer' }),
    handoff({ ...parent, status: 'completed', answer: 'Combined actual answer' }),
  ];
  const nodes = collaborationHandoffs(makeRun(events, { status: 'completed' }));
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].brief, parent.brief);
  assert.equal(nodes[1].parentId, 'parent');
  assert.equal(nodes[1].answer, 'First actual answer');
  assert.equal(nodes[2].answer, 'Second actual answer');
  assert.equal(nodes[1].events.length, 1);
  assert.equal(nodes[1].events[0].tool, 'workspace_read');
  assert.equal(nodes[2].events[0].kind, 'route');
});
test('failed and interrupted handoffs never appear as working forever or invent returned content', () => {
  const info: Handoff = {
    id: 'child',
    fromBotId: 'boss-man',
    toBotId: 'worker1',
    brief: 'A task',
    status: 'working',
  };
  const failure = collaborationHandoffs(
    makeRun([handoff(info), handoff({ ...info, status: 'failed', error: 'Server offline' })], {
      status: 'completed',
    }),
  )[0];
  assert.equal(failure.status, 'failed');
  assert.equal(failure.error, 'Server offline');
  assert.equal(failure.answer, undefined);
  const cancelled = collaborationHandoffs(
    makeRun([handoff(info)], { status: 'cancelled', error: 'Stopped by user' }),
  )[0];
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.answer, undefined);
  const legacy = collaborationHandoffs(
    makeRun(
      [
        {
          kind: 'handoff',
          at,
          botId: 'boss-man',
          text: 'Asked Worker1 for help',
          phase: 'delegating',
          targetBotId: 'worker1',
        },
        {
          kind: 'handoff',
          at,
          botId: 'worker1',
          text: 'Returned',
          phase: 'returned',
          targetBotId: 'boss-man',
        },
      ],
      { status: 'completed' },
    ),
  )[0];
  assert.equal(legacy.status, 'completed');
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.answer, undefined);
});
test('older polls cannot rewind a finished or more detailed live collaboration transcript', () => {
  const before = makeRun([]);
  const detailed = makeRun([{ kind: 'route', at, botId: 'boss-man', text: 'Working' }]);
  assert.equal(mergeRunState(detailed, before), detailed);
  const completed = { ...detailed, status: 'completed' as const };
  assert.equal(mergeRunState(completed, before), completed);
  const rated = { ...completed, rating: 5 };
  assert.equal(mergeRunState(completed, rated).rating, 5);
  const reviewed = { ...rated, feedbackRevision: 1 };
  const cleared = { ...completed, rating: undefined, feedbackRevision: 2 };
  assert.equal(mergeRunState(reviewed, completed), reviewed);
  assert.equal(mergeRunState(reviewed, cleared), cleared);
  assert.equal(mergeRunState(cleared, reviewed), cleared);
});
