import { z } from 'zod';
import { AVATAR_SHAPES } from '../../packages/shared/types';
import { googleOperations } from '../../packages/shared/plugins';
const id = z.string().min(1).max(200),
  time = z.string().datetime();
export const phrasesSchema = z.object(
  Object.fromEntries(
    ['general', 'research', 'coding', 'writing', 'planning', 'waiting', 'responding'].map((k) => [
      k,
      z.array(z.string().trim().min(1).max(70)).max(20).optional(),
    ]),
  ),
);
export const categorySchema = z.object({
  id,
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export const milestonesSchema = z
  .array(z.object({ label: z.string().min(1).max(80), percent: z.number().min(0).max(100) }))
  .max(8);
export const progressSchema = z.object({
  percent: z.number().min(0).max(95),
  label: z.string().max(100),
  milestones: milestonesSchema,
  updatedAt: time,
});
const avatar = z.object({
  shape: z.enum(AVATAR_SHAPES),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export const taskRecordSchema = z.object({
  id,
  runId: id,
  conversationId: id,
  botId: id,
  botName: z.string().max(100),
  avatar,
  prototypeId: id.optional(),
  task: z.enum(['general', 'research', 'coding', 'writing', 'planning']),
  prompt: z.string().max(100000),
  result: z.string().max(300000).optional(),
  error: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  startedAt: time,
  finishedAt: time.optional(),
  tokens: z.number().nonnegative(),
  memoryIds: z.array(id),
  milestones: milestonesSchema,
  compacted: z.boolean().optional(),
  pinned: z.boolean().optional(),
});
export const compactionSchema = z.object({
  id,
  botId: id,
  createdAt: time,
  amount: z.number().int().min(0).max(100),
  archive: z.string().max(30000000),
  afterHash: z.string().regex(/^[a-f0-9]{64}$/),
  recordIds: z.array(z.object({ collection: z.enum(['tasks', 'memory']), id })),
  restoredAt: time.optional(),
});
export const pluginActionSchema = z.object({
  id,
  pluginId: z.literal('google'),
  operation: z.enum(googleOperations.map((o) => o.id)),
  botId: id,
  runId: id,
  params: z.record(z.string(), z.unknown()),
  status: z.enum(['awaiting-approval', 'running', 'completed', 'denied', 'cancelled', 'failed']),
  createdAt: time,
  finishedAt: time.optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
