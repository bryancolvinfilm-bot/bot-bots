import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export interface GoogleAppRegistration {
  clientId?: string;
  clientType?: 'desktop' | 'web';
  redirectUri?: string;
}
export function loadGoogleRegistration(root: string): GoogleAppRegistration {
  try {
    return z
      .object({
        clientId: z.string().max(300),
        clientType: z.enum(['desktop', 'web']).default('desktop'),
        redirectUri: z.string().max(1000).optional(),
      })
      .parse(JSON.parse(readFileSync(join(root, 'resources', 'google-oauth.json'), 'utf8')));
  } catch {
    return {};
  }
}
