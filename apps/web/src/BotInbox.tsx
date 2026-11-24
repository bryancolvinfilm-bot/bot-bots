import { useEffect, useState } from 'react';
import type { BotDelivery } from '../../../packages/shared/delivery';
import type { Bot } from '../../../packages/shared/types';
import { Avatar, emptyAvatar } from './Avatar';
import { api } from './api';
import { BotMessage } from './BotMentions';

export function BotInbox({
  bot,
  bots,
  openBot,
}: {
  bot: Bot;
  bots: Bot[];
  openBot: (id: string, conversationId?: string) => void;
}) {
  const [deliveries, setDeliveries] = useState<BotDelivery[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setDeliveries([]);
    const load = () =>
      void api<BotDelivery[]>(`/bots/${encodeURIComponent(bot.id)}/inbox`).then(
        (d) => {
          if (current) {
            setDeliveries(d);
            setError('');
          }
        },
        (e) => {
          if (current) setError(e.message);
        },
      );
    load();
    const timer = setInterval(load, 3000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [bot.id]);
  return (
    <section aria-label={`${bot.name} inbox`} className="bot-inbox">
      <h3>Received handoffs</h3>
      <p className="subtle">
        A receipt confirms the request arrived. Completed means a reply returned; it does not
        independently verify every requested action.
      </p>
      {error && <p className="error-text">{error}</p>}
      {!deliveries.length && !error && (
        <p className="subtle">
          No recorded handoffs yet. An @mention or a written draft is not a delivered request.
        </p>
      )}
      {deliveries.map((d) => {
        const sender = bots.find((b) => b.id === d.fromBotId);
        return (
          <article className={`bot-inbox-item ${d.status}`} key={d.id} data-delivery-id={d.id}>
            <header>
              <Avatar avatar={sender?.avatar ?? emptyAvatar} size={27} />
              <strong>From {sender?.name ?? d.fromBotId}</strong>
              <span className="status-pill">
                {d.status === 'completed' ? 'Reply returned' : d.status}
              </span>
            </header>
            <small>Received {new Date(d.receivedAt).toLocaleString()}</small>
            <details>
              <summary>Request and receipt</summary>
              <p>{d.brief}</p>
              <code>{d.id}</code>
            </details>
            {d.error && <p className="error-text">{d.error}</p>}
            {d.answer && (
              <details>
                <summary>Returned reply</summary>
                <BotMessage content={d.answer} bots={bots} openBot={openBot} />
              </details>
            )}
            <button
              className="secondary small"
              onClick={() => openBot(d.toBotId, d.conversationId)}
            >
              Open handoff conversation
            </button>
          </article>
        );
      })}
    </section>
  );
}
