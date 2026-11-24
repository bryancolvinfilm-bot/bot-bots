import { z } from 'zod';
export const serviceApiSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,70}$/),
    name: z.string().min(1).max(100),
    baseUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        );
      }),
    authType: z.enum(['bearer', 'header']),
    header: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9-]{0,60}$/)
      .refine(
        (value) =>
          !/^(host|cookie|connection|content-length|transfer-encoding|proxy-authorization)$/i.test(
            value,
          ),
      )
      .optional(),
    operations: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,70}$/),
            label: z.string().min(1).max(120),
            method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
            path: z
              .string()
              .max(300)
              .refine(
                (path) =>
                  path.startsWith('/') &&
                  !path.includes('..') &&
                  !/[?#\\\s]/.test(path) &&
                  !path.startsWith('//'),
              ),
            body: z.enum(['none', 'json', 'page-zip']),
            inputFields: z
              .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/))
              .max(100)
              .optional(),
            queryFields: z
              .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/))
              .max(50)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (api) =>
      new Set(api.operations.map((operation) => operation.id)).size === api.operations.length,
    'Operation IDs must be unique.',
  );
