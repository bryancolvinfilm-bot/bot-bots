export function connection() {
  return {
    base: (localStorage.getItem('bot-bots-server') ?? '').replace(/\/$/, ''),
    token: sessionStorage.getItem('bot-bots-token') ?? '',
  };
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const { base, token } = connection();
  const res = await fetch(`${base}/api${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = (await res.json()).error ?? message;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}
async function watchEvents(path: string, onUpdate: (data: any) => void, signal: AbortSignal) {
  const { base, token } = connection();
  const response = await fetch(`${base}/api${path}`, {
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!response.ok || !response.body) throw new Error('Activity stream unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (chunk.startsWith('data: ')) onUpdate(JSON.parse(chunk.slice(6)));
      }
    }
  } finally {
    reader.releaseLock();
  }
}
export function watchRun(id: string, onUpdate: (data: any) => void, signal: AbortSignal) {
  return watchEvents(`/runs/${id}/events`, onUpdate, signal);
}
export function watchActivity(
  onUpdate: (data: import('../../../packages/shared/types').ActivityUpdate) => void,
  signal: AbortSignal,
) {
  return watchEvents('/activity/events', onUpdate, signal);
}
export function watchComputer(
  onUpdate: (data: import('../../../packages/shared/computer').ComputerState) => void,
  signal: AbortSignal,
) {
  return watchEvents('/computer/events', onUpdate, signal);
}
export function watchTerminal(
  onUpdate: (data: import('../../../packages/shared/terminal').TerminalState) => void,
  signal: AbortSignal,
) {
  return watchEvents('/terminal/events', onUpdate, signal);
}
