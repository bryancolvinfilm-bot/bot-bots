export interface CredentialSetup {
  id: string;
  botId: string;
  conversationId: string;
  runId?: string;
  service: string;
  purpose: string;
  kind: 'api-key' | 'password';
  source: 'human' | 'bot';
  status: 'awaiting-entry' | 'saved' | 'cancelled';
  createdAt: string;
  finishedAt?: string;
  secretId?: string;
  grantId?: string;
  connected?: boolean;
  connection?: {
    type: 'operation';
    url: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    authType: 'bearer' | 'header' | 'basic';
    header?: string;
    inputFields: string[];
    responseFields: string[];
  };
  providerId?: string;
  api?: import('./service-api').ServiceApi;
}

export function credentialService(text: string) {
  const matches: { service: string; providerId?: string }[] = [];
  if (/\b(?:openai|chatgpt|codex)\b/i.test(text))
    matches.push({ service: 'OpenAI', providerId: 'openai' });
  if (/\b(?:anthropic|claude)\b/i.test(text))
    matches.push({ service: 'Claude', providerId: 'anthropic' });
  if (/\bnetlify\b/i.test(text)) matches.push({ service: 'Netlify' });
  if (/\b(?:pages_api_token|bottools(?:\.online)?|pages api|nettools(?: webhost)?)\b/i.test(text))
    matches.push({ service: 'Pages publishing' });
  if (/\bgithub\b/i.test(text)) matches.push({ service: 'GitHub' });
  return matches.length === 1 ? matches[0] : { service: '' };
}
/** Recognize an entry request, never copy any part of the supplied value into metadata. */
export function wantsPrivateEntry(text: string) {
  const plain = text.replace(/```[\s\S]*?```/g, '').trim();
  if (
    /^(?:>|["'])|\b(?:do not|don't|never|no need to)\s+(?:give|enter|add|save|share|paste|provide)/i.test(
      plain,
    )
  )
    return false;
  if (apiKeyValue(plain)) return true;
  if (/^(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{15,})$/i.test(plain)) return true;
  if (
    plain.length > 500 ||
    /```|\b(?:api dump|endpoint summary|openapi|api documentation)\b/i.test(text)
  )
    return false;
  if (
    !/^(?:(?:please|okay|ok|so)\s+)*(?:let me\b|i\b|here(?:'s| is)\b|where\b|how\b|(?:can|may|could) i\b|(?:enter|add|save|paste|provide)\b)/i.test(
      plain,
    )
  )
    return false;
  if (
    /\b(?:build|implement|write|design|create)\b/i.test(plain) &&
    /\b(?:code|app|form|manager|ui|field|component)\b/i.test(plain)
  )
    return false;
  if (
    /\badd\b.*\b(?:handling|fields?|manager|component)\b/i.test(plain) &&
    !/\bgive you\b/i.test(plain)
  )
    return false;
  if (/\b(?:keyboard|shortcut|hotkey|keyframe|primary key|foreign key)\b/i.test(plain))
    return false;
  return (
    /\b(?:api[ _-]?(?:key|token)|key|token|access token|password|credentials?|[A-Z][A-Z0-9_]*_(?:TOKEN|KEY|PASSWORD))\b/i.test(
      plain,
    ) &&
    (/\b(?:I|me|my|where|how)\b/i.test(plain) ||
      /^(?:please\s+)?(?:enter|add|save|paste|provide|connect)\b/i.test(plain)) &&
    /\b(?:give|enter|add|save|share|paste|provide|input|connect|set up|here(?:'s| is))\b/i.test(
      plain,
    )
  );
}

/** A value deliberately supplied for storage; never include it in public metadata. */
export function apiKeyValue(text: string, allowBare = false) {
  const plain = text.trim();
  if (!plain || plain.length > 16000 || /```|^\s*>/.test(plain)) return;
  const assignment =
    /(?:\b(?:api[ _-]?(?:key|token)|access token|[A-Z][A-Z0-9_]*_(?:TOKEN|KEY))\b\s*(?::|=|\bis\b)\s*|\bBearer\s+)["']?([A-Za-z0-9_.\/+\-=]{8,4096})["']?/i.exec(
      plain,
    );
  const value =
    assignment?.[1] ??
    (/^(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{15,})$/i.test(plain) ||
    (allowBare && /^[A-Za-z0-9_.\/+\-=]{16,4096}$/.test(plain))
      ? plain
      : undefined);
  if (value && !/^(?:https?|your[_-]|example|placeholder)/i.test(value)) return value;
}
export function needsPrivateEntry(text: string) {
  const plain = text.replace(/```[\s\S]*?```/g, '');
  return plain
    .split(/\n/)
    .some(
      (line) =>
        !/\b(?:no|not|never|without|don't|do not)\b/i.test(line) &&
        /\b(?:need|requires?|missing|provide|enter)\b.{0,75}\b(?:api[ _-]?(?:key|token)|access token|password)\b/i.test(
          line,
        ),
    );
}
