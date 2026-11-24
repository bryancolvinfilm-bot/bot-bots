import type { Handoff, Run, RunEvent } from './types';

export interface CollaborationHandoff extends Handoff {
  startedAt: string;
  finishedAt?: string;
  events: RunEvent[];
  legacy?: boolean;
}

/** Preserve separate handoffs even when the same teammate is asked more than once. */
export function collaborationHandoffs(run: Run): CollaborationHandoff[] {
  const nodes = new Map<string, CollaborationHandoff>();
  for (const [index, event] of run.events.entries()) {
    const info = event.handoff;
    if (info) {
      const previous = nodes.get(info.id);
      nodes.set(info.id, {
        ...previous,
        ...info,
        startedAt: previous?.startedAt ?? event.at,
        finishedAt: info.status === 'working' ? undefined : event.at,
        events: previous?.events ?? [],
      });
    } else if (event.phase === 'delegating' && event.targetBotId) {
      const parent = [...nodes.values()].findLast(
        (node) => node.status === 'working' && node.toBotId === event.botId,
      );
      const id = event.handoffId ?? `legacy-${run.id}-${index}`;
      nodes.set(id, {
        id,
        parentId: parent?.id,
        fromBotId: event.botId,
        toBotId: event.targetBotId,
        brief: event.text,
        status: 'working',
        startedAt: event.at,
        events: [],
        legacy: true,
      });
    } else if (event.phase === 'returned') {
      const node =
        (event.handoffId ? nodes.get(event.handoffId) : undefined) ??
        [...nodes.values()].findLast(
          (node) =>
            node.status === 'working' &&
            node.toBotId === event.botId &&
            (!event.targetBotId || node.fromBotId === event.targetBotId),
        );
      if (node) {
        node.status = 'completed';
        node.finishedAt = event.at;
      }
    }
    if (event.kind !== 'handoff') {
      const node =
        (event.handoffId ? nodes.get(event.handoffId) : undefined) ??
        [...nodes.values()].findLast(
          (node) => node.status === 'working' && node.toBotId === event.botId,
        );
      if (node) node.events.push(event);
    }
  }
  for (const node of nodes.values()) {
    if (node.status === 'working' && run.status !== 'running') {
      node.status = run.status === 'cancelled' ? 'cancelled' : 'failed';
      node.error = run.error ?? 'This handoff was interrupted before a reply was recorded.';
      node.finishedAt = run.finishedAt;
    }
  }
  return [...nodes.values()];
}

/** A slower poll or history fetch must not rewind a newer live transcript. */
export function mergeRunState(current: Run | undefined, incoming: Run): Run {
  if (current && current.id !== incoming.id) return incoming;
  if (current && (current.feedbackRevision ?? 0) > (incoming.feedbackRevision ?? 0)) return current;
  if (
    current &&
    current.status === incoming.status &&
    (current.revision ?? 0) > (incoming.revision ?? 0)
  )
    return current;
  if (
    current &&
    incoming.status === 'running' &&
    (current.status !== 'running' || current.events.length > incoming.events.length)
  )
    return current;
  return incoming;
}
