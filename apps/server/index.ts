import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { acquireHostLock } from './host-lock';
import { seed } from './importer';
import { discover, candidates } from './models';
import { scheduler } from './scheduler';
import { Store } from './store';
import { Computer } from './computer';
import type { PreviewDriver } from './preview';
import { Credentials } from './credentials';
export async function startServer(
  options: {
    dataDir?: string;
    rootDir?: string;
    port?: number;
    host?: string;
    token?: string;
    computer?: Computer;
    preview?: PreviewDriver;
    credentials?: Credentials;
  } = {},
) {
  const root = options.rootDir ?? process.cwd();
  const dataDir = options.dataDir ?? process.env.BOT_BOTS_DATA_DIR ?? join(root, 'data');
  const host = options.host ?? process.env.BOT_BOTS_HOST ?? '127.0.0.1';
  const token = options.token ?? process.env.BOT_BOTS_TOKEN ?? '';
  if (token && token.length < 24) throw new Error('Use a server token of at least 24 characters.');
  const unlock = acquireHostLock(dataDir);
  let store: Store;
  try {
    store = new Store(join(dataDir, 'bot-bots.sqlite'));
    const previous = store.config<{ source?: string }>('initialized');
    seed(store, previous?.source?.startsWith('grok-') ? join(root, 'reference', 'grok-backup') : undefined, { recoverInterruptedRuns: true });
  } catch (error) {
    unlock();
    throw error;
  }
  const credentials =
    options.credentials ?? new Credentials(undefined, undefined, join(dataDir, 'workspace'));
  const { app, runtime, alerts, computer, terminal, chatgpt, claude } = createApp(
    store,
    dataDir,
    join(root, 'dist', 'web'),
    token,
    options.computer,
    options.preview,
    credentials,
  );
  const stopSchedule = scheduler(store, runtime);
  const port = options.port ?? Number(process.env.PORT ?? 3210);
  let server: ReturnType<typeof app.listen>;
  try {
    server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
      const s = app.listen(port, host, () => resolve(s));
      s.on('error', reject);
    });
  } catch (error) {
    stopSchedule();
    store.close();
    unlock();
    throw error;
  }
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Bot-Bots is running at http://${host}:${actualPort}`);
  let probing = false;
  let unavailableSince: number | undefined;
  async function probe() {
    if (probing) return;
    probing = true;
    try {
      await Promise.allSettled(
        store
          .all('providers')
          .filter(
            (p) =>
              p.enabled &&
              (p.local || !store.settings().localOnly) &&
              (p.local ? p.autoDiscover !== false : p.autoDiscover === true),
          )
          .map((p) => discover(store, p.id)),
      );
      runtime.events.emit('models', {
        models: store.all('models'),
        providers: store.all('providers'),
      });
      const ready = candidates(store, 'general').some((m) => m.status === 'online');
      if (!ready) {
        unavailableSince ??= Date.now();
        if (Date.now() - unavailableSince >= 60000)
          await alerts.unavailable(
            'No enabled, loaded chat models have been available for one minute. Check the model servers.',
          );
      } else {
        unavailableSince = undefined;
        alerts.recovered();
      }
    } finally {
      probing = false;
    }
  }
  void probe();
  const monitor = setInterval(() => void probe(), 15000);
  monitor.unref();
  const close = async () => {
    chatgpt?.cancel();
    claude.cancel();
    credentials.cancelRun();
    clearInterval(monitor);
    stopSchedule();
    const finishing = [...runtime.controllers.keys()].map(
      (id) =>
        new Promise<void>((resolve) => {
          const listener = (event: { type: string }) => {
            if (event.type === 'done') {
              runtime.events.off(id, listener);
              resolve();
            }
          };
          runtime.events.on(id, listener);
          runtime.cancel(id);
        }),
    );
    await Promise.all(finishing);
    while (probing) await new Promise((resolve) => setTimeout(resolve, 25));
    runtime.events.emit('shutdown');
    computer.dispose();
    await terminal.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    unlock();
  };
  const browserHost =
    host === '0.0.0.0'
      ? '127.0.0.1'
      : host === '::'
        ? '[::1]'
        : host.includes(':')
          ? `[${host}]`
          : host;
  return { server, store, runtime, close, url: `http://${browserHost}:${actualPort}` };
}
const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked)
  startServer()
    .then((host) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => void host.close().then(() => process.exit(0)));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
