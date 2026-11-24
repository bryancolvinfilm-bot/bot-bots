import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitingForDelegates, progressPosition } from '../packages/shared/team';
import type { Run, WorkRecord } from '../packages/shared/types';

const work = (id: string, botId: string, handoffId?: string): WorkRecord => ({
  id,
  botId,
  handoffId,
  task: 'general',
  urgency: 'relaxed',
  importance: 'normal',
  status: 'running',
  startedAt: '2026-11-22T00:00:00Z',
  attempts: [],
});
test('coordinators hold at the left for every outstanding child, including nested and parallel delegation', () => {
  const root = work('root', 'boss'),
    child = work('child', 'research', 'a'),
    leaf = work('leaf', 'worker', 'b');
  const run: Run = {
    id: 'r',
    botId: 'boss',
    conversationId: 'c',
    prompt: '',
    task: 'general',
    status: 'running',
    startedAt: root.startedAt,
    tokens: 0,
    work: [root, child, leaf],
    events: [
      {
        at: root.startedAt,
        kind: 'handoff',
        botId: 'boss',
        text: '',
        handoff: { id: 'a', fromBotId: 'boss', toBotId: 'research', brief: '', status: 'working' },
      },
      {
        at: root.startedAt,
        kind: 'handoff',
        botId: 'boss',
        text: '',
        handoff: {
          id: 'parallel',
          fromBotId: 'boss',
          toBotId: 'writer',
          brief: '',
          status: 'working',
        },
      },
      {
        at: root.startedAt,
        kind: 'handoff',
        botId: 'research',
        text: '',
        handoff: {
          id: 'b',
          parentId: 'a',
          fromBotId: 'research',
          toBotId: 'worker',
          brief: '',
          status: 'working',
        },
      },
    ],
  };
  assert.deepEqual(waitingForDelegates(run, root), ['research', 'writer']);
  assert.deepEqual(waitingForDelegates(run, child), ['worker']);
  assert.equal(
    progressPosition(root, Date.now(), 60000, waitingForDelegates(run, root)).percent,
    0,
  );
  assert.equal(
    progressPosition(child, Date.now(), 60000, waitingForDelegates(run, child)).percent,
    0,
  );
  assert.ok(progressPosition(leaf, Date.now()).percent > 0);
  run.events.push({
    ...run.events[0],
    handoff: { ...run.events[0].handoff!, status: 'completed', answer: 'Done' },
  });
  assert.deepEqual(waitingForDelegates(run, root), ['writer']);
  run.events.push({
    ...run.events[1],
    handoff: { ...run.events[1].handoff!, status: 'completed', answer: 'Done' },
  });
  assert.deepEqual(waitingForDelegates(run, root), []);
  assert.ok(progressPosition(root, Date.now(), 60000, waitingForDelegates(run, root)).percent > 0);
});
test('waiting beats old progress estimates and time, while true completion alone reaches the finish', () => {
  const w = {
    ...work('r', 'boss'),
    progress: {
      percent: 85,
      label: 'Old estimate',
      milestones: [],
      updatedAt: '2026-11-22T00:00:00Z',
    },
  };
  assert.deepEqual(progressPosition(w, Date.now(), 60000, ['Research']), {
    percent: 0,
    label: 'Waiting for Research',
    estimated: false,
  });
  assert.equal(progressPosition({ ...w, queued: true }, Date.now()).percent, 0);
  assert.equal(
    progressPosition({ ...w, status: 'completed' }, Date.now(), 60000, ['Research']).percent,
    100,
  );
});
