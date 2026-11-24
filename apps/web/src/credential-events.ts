import type { CredentialSetup } from '../../../packages/shared/credential-setup';
export function openCredentials(
  detail: {
    add?: boolean;
    providerId?: string;
    request?: CredentialSetup;
    requestId?: string;
  } = {},
) {
  window.dispatchEvent(new CustomEvent('bot-bots:credentials', { detail }));
}
