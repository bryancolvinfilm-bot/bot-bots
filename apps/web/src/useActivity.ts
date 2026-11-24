import { useEffect, useState } from 'react';
import type { ActivityUpdate } from '../../../packages/shared/types';
import { connection, watchActivity } from './api';

export function useLiveActivity(enabled: boolean, onUpdate: (update: ActivityUpdate) => void) {
  const [connected, setConnected] = useState(false);
  const { base, token } = connection();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await watchActivity((update) => {
            setConnected(true);
            onUpdate(update);
          }, controller.signal);
        } catch {
          /* Bootstrap polling remains available during a disconnected stream. */
        }
        if (controller.signal.aborted) return;
        setConnected(false);
        await new Promise<void>((resolve) => {
          retry = setTimeout(resolve, 2000);
        });
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [enabled, onUpdate, base, token]);
  return connected;
}
