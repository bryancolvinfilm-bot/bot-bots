import { z } from 'zod';
import { secretAlias } from './host-secrets';
import { serviceApiSchema } from './service-api-schema';

const alias = z.string().regex(secretAlias);
const secureUrl = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search;
  }, 'Credential destinations must be HTTPS without URL credentials or fragments.');
export const credentialPolicySchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  storage: z.enum(['os', 'file']).default('os'),
  allowBotTerminal: z.boolean().default(false),
  bindings: z
    .array(
      z.object({
        id: alias,
        secret: alias,
        purpose: z.enum(['model', 'alert']),
        url: secureUrl,
        enabled: z.boolean().optional(),
      }),
    )
    .default([]),
  services: z
    .array(
      z.object({
        id: alias,
        secret: alias,
        api: serviceApiSchema,
        enabled: z.boolean(),
        botIds: z.array(z.string().min(1)).min(1).max(100),
        approval: z.literal('connected').default('connected'),
      }),
    )
    .max(100)
    .default([]),
  operations: z
    .array(
      z.object({
        id: alias,
        label: z.string().min(1).max(120),
        enabled: z.boolean(),
        botIds: z.array(z.string().min(1)).max(100),
        url: secureUrl,
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        auth: z.discriminatedUnion('type', [
          z.object({ type: z.literal('bearer'), secret: alias }),
          z.object({
            type: z.literal('header'),
            secret: alias,
            header: z
              .string()
              .regex(/^[A-Za-z][A-Za-z0-9-]{0,60}$/)
              .refine(
                (h) =>
                  !/^(host|cookie|content-length|transfer-encoding|connection|proxy-authorization)$/i.test(
                    h,
                  ),
              ),
          }),
          z.object({ type: z.literal('basic'), secret: alias, username: z.string().max(200) }),
        ]),
        inputFields: z
          .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/))
          .max(20)
          .default([]),
        responseFields: z
          .array(
            z
              .string()
              .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
              .refine(
                (name) =>
                  !/token|secret|password|authorization|cookie|credential|session|private.?key|api.?key/i.test(
                    name,
                  ),
                'Credential-bearing response fields cannot be returned to bots.',
              ),
          )
          .min(1)
          .max(30),
      }),
    )
    .max(100)
    .default([]),
});
export type Policy = z.infer<typeof credentialPolicySchema>;
