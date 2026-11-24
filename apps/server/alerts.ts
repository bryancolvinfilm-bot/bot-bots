import { randomUUID } from 'node:crypto';
import { Store } from './store';
import type { Credentials } from './credentials';
export class Alerts {
  private sending = false;
  constructor(
    private store: Store,
    private credentials?: Credentials,
  ) {}
  async unavailable(message: string) {
    let incident = this.store.all('incidents').find((i) => !i.resolvedAt);
    if (!incident)
      incident = this.store.put('incidents', {
        id: randomUUID(),
        kind: 'models-unavailable',
        openedAt: new Date().toISOString(),
        message,
        deliveries: [],
      });
    if (this.sending) return;
    this.sending = true;
    try {
      const settings = this.store.settings();
      for (const [name, channel] of [
        ['email', settings.alertEmail],
        ['sms', settings.alertSms],
      ] as const) {
        if (!channel.enabled || !channel.url) continue;
        const last = this.store
          .all('incidents')
          .flatMap((i) => i.deliveries)
          .filter((d) => d.channel === name)
          .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
          .at(-1);
        if (last && Date.now() - Date.parse(last.at) < settings.alertCooldownMinutes * 60000)
          continue;
        let status = 'sent';
        try {
          const token = channel.credentialId
            ? this.credentials?.binding(channel.credentialId, 'alert', channel.url)
            : channel.tokenEnv
              ? process.env[channel.tokenEnv]
              : '';
          if ((channel.credentialId || channel.tokenEnv) && !token)
            throw new Error('Missing alert credential');
          // This path uses no LLM. Your future email/SMS API receives a deterministic payload.
          const res = await fetch(channel.url, {
            redirect: 'error',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              event: 'bot-bots.models-unavailable',
              incidentId: incident.id,
              channel: name,
              to: channel.destination,
              message:
                'Bot-Bots could not reach any enabled model. Open the app to check model servers.',
              openedAt: incident.openedAt,
            }),
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch {
          status = 'failed';
        }
        incident.deliveries.push({ channel: name, status, at: new Date().toISOString() });
        this.store.put('incidents', incident);
      }
    } finally {
      this.sending = false;
    }
  }
  recovered() {
    for (const i of this.store.all('incidents').filter((i) => !i.resolvedAt))
      this.store.put('incidents', { ...i, resolvedAt: new Date().toISOString() });
  }
}
