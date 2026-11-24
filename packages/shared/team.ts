import type { Avatar, Bot, TaskType, WorkRecord } from './types';
import type { Run } from './types';
import { collaborationHandoffs } from './collaboration';
export type PhraseContext = TaskType | 'waiting' | 'responding';
export type ProcessingPhrases = Partial<Record<PhraseContext, string[]>>;
export interface BotCategory {
  id: string;
  name: string;
  color: string;
}
export interface Milestone {
  label: string;
  percent: number;
}
export interface WorkProgress {
  percent: number;
  label: string;
  milestones: Milestone[];
  updatedAt: string;
}
export interface TaskRecord {
  id: string;
  runId: string;
  conversationId: string;
  botId: string;
  botName: string;
  avatar: Avatar;
  prototypeId?: string;
  task: TaskType;
  prompt: string;
  result?: string;
  error?: string;
  status: WorkRecord['status'];
  startedAt: string;
  finishedAt?: string;
  tokens: number;
  memoryIds: string[];
  milestones: Milestone[];
  compacted?: boolean;
  pinned?: boolean;
}
export interface CompactionRecord {
  id: string;
  botId: string;
  createdAt: string;
  amount: number;
  archive: string;
  afterHash: string;
  recordIds: { collection: 'tasks' | 'memory'; id: string }[];
  restoredAt?: string;
}
export const visibleBots = (bots: Bot[]) =>
  bots.filter((b) => b.cloneStatus !== 'retired' && !b.archivedAt && !b.deletedAt);
export function waitingForDelegates(run: Run, work: WorkRecord) {
  if (run.status !== 'running' || work.status !== 'running') return [];
  return collaborationHandoffs(run)
    .filter(
      (h) => h.status === 'working' && h.fromBotId === work.botId && h.parentId === work.handoffId,
    )
    .map((h) => h.toBotId);
}
export function progressPosition(
  work: WorkRecord,
  now: number,
  expectedMs = 60000,
  waitingFor: string[] = [],
) {
  if (work.status === 'completed') return { percent: 100, label: 'Finished', estimated: false };
  if (work.status !== 'running')
    return {
      percent: work.progress?.percent ?? 0,
      label: work.status === 'failed' ? 'Needs attention' : 'Stopped',
      estimated: false,
    };
  if (waitingFor.length || work.queued)
    return {
      percent: 0,
      label: work.queued ? 'Waiting for a model slot' : `Waiting for ${waitingFor.join(', ')}`,
      estimated: false,
    };
  if (work.progress)
    return {
      percent: Math.min(95, work.progress.percent),
      label: work.progress.label,
      estimated: true,
    };
  const elapsed = Math.max(0, now - Date.parse(work.startedAt));
  return {
    percent: Math.min(88, 8 + 80 * (1 - Math.exp(-elapsed / Math.max(5000, expectedMs)))),
    label: 'Working · activity estimate',
    estimated: true,
  };
}
