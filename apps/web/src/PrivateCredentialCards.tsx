import { KeyRound, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CredentialSetup } from '../../../packages/shared/credential-setup';
import { api } from './api';
import { openCredentials } from './CredentialManager';

export function PrivateCredentialCards({
  botId,
  conversationId,
  owner,
}: {
  botId: string;
  conversationId?: string;
  owner: boolean;
}) {
  const [requests, setRequests] = useState<CredentialSetup[]>([]);
  const [connecting, setConnecting] = useState<string>(),
    [error, setError] = useState('');
  async function connect(request: CredentialSetup) {
    setConnecting(request.id);
    setError('');
    try {
      const run = await api<{ credentialRequest?: CredentialSetup; connected?: boolean }>(
        `/credentials/manager/requests/${request.id}/connect`,
        'POST',
        {},
      );
      if (run.credentialRequest) {
        openCredentials({ request: run.credentialRequest });
        return;
      }
      if (run.connected) return;
      window.dispatchEvent(new CustomEvent('bot-bots:open-run', { detail: run }));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setConnecting(undefined);
    }
  }
  useEffect(() => {
    setRequests([]);
    if (!conversationId || !owner) return;
    let active = true;
    const load = () =>
      void api<CredentialSetup[]>(
        `/credentials/manager/requests?botId=${encodeURIComponent(botId)}&conversationId=${encodeURIComponent(conversationId)}`,
      ).then(
        (items) => {
          if (active) {
            const grouped = new Map<string, CredentialSetup>();
            for (const item of items.filter((item) => item.status !== 'cancelled')) {
              const key = item.api?.id ?? item.service.toLowerCase();
              const prior = grouped.get(key);
              if (!prior || item.status === 'awaiting-entry' || item.connected || !prior.connected)
                grouped.set(key, item);
            }
            setRequests([...grouped.values()]);
          }
        },
        () => {},
      );
    load();
    const timer = setInterval(load, 1200);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [botId, conversationId, owner]);
  return (
    <>
      {requests.map((request) => (
        <div className="private-credential-card" key={request.id}>
          {request.status === 'saved' ? <ShieldCheck size={24} /> : <KeyRound size={24} />}
          <div>
            <strong>{request.api?.name ?? (request.service || 'Private key or password')}</strong>
            <p>
              {request.status === 'saved'
                ? request.connected
                  ? `Connected${request.api ? ` · ${request.api.operations.length} API actions ready` : ''}. The bot cannot read the token.`
                  : 'Saved privately. Your bot can help connect it next.'
                : request.status === 'cancelled'
                  ? 'Private entry cancelled. No value was shared with the bot.'
                  : 'Enter the value in the private window. The bot cannot read that field.'}
            </p>
          </div>
          {request.status === 'awaiting-entry' && (
            <button className="primary small" onClick={() => openCredentials({ request })}>
              Enter key privately
            </button>
          )}
          {request.status === 'saved' && !request.connected && (
            <button
              className="secondary small"
              disabled={!!connecting}
              onClick={() => void connect(request)}
            >
              Help me connect it
            </button>
          )}
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
