import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Bot, Skill } from '../../packages/shared/types';
import type { ServiceApi } from '../../packages/shared/service-api';
import { Store } from './store';

export const skillInput = z.object({
  name: z.string().trim().min(1).max(160),
  content: z
    .string()
    .min(1)
    .max(60000)
    .refine((value) => !!value.trim(), 'Enter skill Markdown'),
});
export const skillRecord = skillInput.extend({
  id: z.string().min(1).max(200),
  description: z.string().max(300).optional(),
  sourceFile: z.string().max(1000).optional(),
  originBotId: z.string().min(1).max(200).optional(),
  originBotName: z.string().max(160).optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  runId: z.string().min(1).max(200).optional(),
  apiId: z.string().min(1).max(200).optional(),
});

export function saveSkill(
  store: Store,
  input: { name: string; content: string },
  origin?: Pick<Bot, 'id' | 'name'>,
  options: { id?: string; runId?: string; apiId?: string } = {},
): Skill {
  const value = skillInput.parse(input);
  const old = options.id ? store.get('skills', options.id) : undefined;
  if (options.id && !old) throw Error('Skill not found');
  const now = new Date().toISOString();
  return store.put('skills', {
    ...old,
    ...value,
    id: old?.id ?? randomUUID(),
    ...(old ? {} : { originBotId: origin?.id, originBotName: origin?.name, createdAt: now }),
    updatedAt: now,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.apiId ? { apiId: options.apiId } : {}),
  });
}

/** API metadata is already validated and excludes credential values/examples. */
export function saveApiSkill(store: Store, api: ServiceApi, botId: string) {
  if (store.all('skills').some((skill) => skill.apiId === api.id)) return;
  const bot = store.get('bots', botId);
  const content = [
    `# ${api.name}`,
    '',
    `Base URL: ${api.baseUrl}`,
    '',
    'Use service_list to find an available connection, then service_call with its connection ID and one of the documented operation IDs below. Pass named path parameters through paramsJson and body fields through inputJson. For a page ZIP use pageId.',
    '',
    'This playbook is shared with all bots. Service access still requires a separately granted connection for the bot using it. Store credentials only in Private key entry; this skill grants no permissions and contains no token values.',
    '',
    ...api.operations.flatMap((operation) => [
      `## ${operation.id}`,
      `${operation.method} ${operation.path} — ${operation.label}`,
      `Body: ${operation.body}`,
      ...(operation.inputFields?.length
        ? [`Input fields: ${operation.inputFields.join(', ')}`]
        : []),
      ...(operation.queryFields?.length
        ? [`Query fields: ${operation.queryFields.join(', ')}`]
        : []),
      '',
    ]),
  ].join('\n');
  // Keep the complete catalog in apiDefinitions; very large catalogs retain a concise pointer here.
  saveSkill(
    store,
    {
      name: `${api.name} API`,
      content:
        content.length <= 60000
          ? content
          : content.slice(0, 58000) + '\n\nFor the complete action catalog use service_list.\n',
    },
    bot,
    { apiId: api.id },
  );
}

export function skillRequested(text: string) {
  const request = text.replace(/```[\s\S]*?```/g, '').trim();
  if (
    /\b(?:do not|don't|never)\s+(?:make|create|save|store|update|edit|remember|keep)\b[^.!?\n]{0,120}\b(?:skill|api|endpoint|curl)\b/i.test(
      request,
    )
  )
    return false;
  return (
    /\b(?:make|create|save|store|write|build)\b[^.!?\n]{0,100}\b(?:a\s+)?(?:shared\s+)?skill\b/i.test(
      request,
    ) ||
    /\b(?:save|store|remember|keep)\b[^.!?\n]{0,120}\b(?:api\s+(?:call|request|documentation|usage)|endpoint|curl(?:\s+command)?)\b/i.test(
      request,
    )
  );
}

/** Text-only models can return an explicit Markdown skill artifact for the host to save. */
export function skillFromReply(text: string) {
  const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*(?:markdown|md|skill)[ \t]*\r?\n/im.exec(text);
  if (!opening) return;
  const body = text.slice(opening.index + opening[0].length);
  // Only the same fence character with at least the outer fence length closes the artifact.
  // A four-backtick Markdown block can therefore contain ordinary three-backtick examples.
  const closing = new RegExp(
    '^ {0,3}' + opening[1][0] + '{' + opening[1].length + ',}[ \\t]*\\r?$',
    'm',
  ).exec(body);
  if (!closing) return;
  const content = body.slice(0, closing.index).trim();
  if (!content || content.length > 60000) return;
  const name = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? 'Shared skill';
  return { name: name.slice(0, 160), content };
}
