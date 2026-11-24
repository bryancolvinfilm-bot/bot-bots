import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { loadGoogleRegistration } from './google-registration';
import type { Bootstrap, Model } from '../../packages/shared/types';
import { Alerts } from './alerts';
import {
  discover,
  normalizeBaseUrl,
  attachModelCredentials,
  attachChatGPT,
  attachClaudeCode,
} from './models';
import { ChatGPTAuth } from './chatgpt-auth';
import { TeamConversations } from './team-conversations';
import { ClaudeCode } from './claude-code';
import { botInput, routineInput, saveRoutine } from './bot-controls';
import { selectBotModel } from './bot-models';
import { EFFORTS } from '../../packages/shared/model-effort';
import { migrateClaudeContexts, withClaudeContext } from './frontier-context';
import type { Credentials } from './credentials';
import { Runtime } from './runtime';
import { Store } from './store';
import { Computer } from './computer';
import { Terminal } from './terminal';
import type { PreviewDriver } from './preview';
import { PREVIEW_POLICY, previewHtml } from '../../packages/shared/artifacts';
import { Drafts } from './drafts';
import {
  migrateTeam,
  tasksFor,
  phraseSuggestions,
  compactionPlan,
  applyCompaction,
  undoCompaction,
} from './team';
import {
  categorySchema,
  progressSchema,
  taskRecordSchema,
  compactionSchema,
  pluginActionSchema,
} from './team-schemas';
import { GooglePlugin, googleConfigSchema } from './google';
import { SecretVault } from './secret-vault';
import { AccessControl, trustedLocal } from './access';
import { canBeMainBot, mainBot } from '../../packages/shared/main-bot';
import { AppHelp } from './app-help';
import { version } from '../../package.json';
import { CredentialManagerError, saveSecretSchema } from './credential-manager';
import { setupInput, setupRecordSchema } from './credential-setup';
import { BotLifecycleError, changeBotLifecycle } from './bot-lifecycle';
import { wantsPrivateEntry } from '../../packages/shared/credential-setup';
import { serviceApiSchema } from './service-api-schema';
import { publishIntent } from './services';
import { CredentialConversation } from './credential-conversation';
import { saveSkill, skillInput, skillRecord } from './skills';

const id = z.string().min(1).max(200);
const taskType = z.enum(['general', 'research', 'coding', 'writing', 'planning']);
const urgency = z.enum(['relaxed', 'soon', 'urgent']);
const importance = z.enum(['normal', 'high']);
const feedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  timing: z.enum(['unspecified', 'worth-the-wait', 'too-slow']),
  note: z.string().max(2000),
  updatedAt: z.string().datetime(),
});
const workSchema = z.object({
  prototypeId: id.optional(),
  progress: progressSchema.optional(),
  queued: z.boolean().optional(),
  id,
  botId: id,
  handoffId: id.optional(),
  task: taskType,
  urgency,
  importance,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  modelId: id.optional(),
  attempts: z.array(
    z.object({
      modelId: id,
      startedAt: z.string().datetime(),
      finishedAt: z.string().datetime().optional(),
      status: z.enum(['running', 'completed', 'failed', 'cancelled', 'switched']),
      modelTimeMs: z.number().nonnegative(),
      tokens: z.number().nonnegative(),
      usageKnown: z.boolean(),
      calls: z.number().int().nonnegative(),
    }),
  ),
  feedback: feedbackSchema.optional(),
});
const botSchema = botInput;
const modelSchema = z.object({
  toolCalling: z.enum(['auto', 'enabled', 'disabled']).optional(),
  toolFormatUnsupported: z.boolean().optional(),
  enablement: z.enum(['auto', 'manual']).optional(),
  contextSource: z.enum(['server', 'manual']).optional(),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(1000),
  costPerMillion: z.number().min(0).max(10000),
  tasks: z.array(z.enum(['general', 'research', 'coding', 'writing', 'planning'])).min(1),
  contextTokens: z.number().int().min(512).max(2000000),
  reasoningEffort: z.enum(EFFORTS).optional(),
});
const providerSchema = z
  .object({
    credentialId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/)
      .optional(),
    autoDiscover: z.boolean().optional(),
    autoEnableModels: z.boolean().optional(),
    followLoadedModels: z.boolean().optional(),
    name: z.string().min(1).max(120),
    kind: z.enum(['openai-compatible', 'openai-responses', 'anthropic', 'chatgpt', 'claude-code']),
    baseUrl: z.string().max(500).transform(normalizeBaseUrl),
    apiKeyEnv: z.string().regex(/^$|^[A-Z][A-Z0-9_]{0,100}$/),
    enabled: z.boolean(),
    local: z.boolean(),
    timeoutMs: z.number().int().min(1000).max(600000),
  })
  .refine(
    (p) =>
      p.kind !== 'chatgpt' ||
      (!p.local && p.baseUrl === 'https://api.openai.com/v1' && !p.apiKeyEnv && !p.credentialId),
    'ChatGPT uses its protected account connection and fixed public API endpoint.',
  );
const alertChannel = z.object({
  credentialId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/)
    .optional(),
  enabled: z.boolean(),
  url: z
    .string()
    .max(1000)
    .refine((v) => !v || /^https?:\/\//.test(v), 'Use an HTTP(S) endpoint'),
  tokenEnv: z.string().regex(/^$|^[A-Z][A-Z0-9_]{0,100}$/),
  destination: z.string().max(300),
});
const settingsSchema = z.object({
  mainBotId: id.nullable().optional(),
  modelSelection: z.enum(['auto', 'manual']).optional(),
  maxParallelModels: z.number().int().min(1).max(4).optional(),
  maxBrowserSessions: z.number().int().min(1).max(12).optional(),
  maxWorkerClones: z.number().int().min(1).max(30).optional(),
  webSearchProvider: z.enum(['google', 'bing', 'duckduckgo', 'brave']).optional(),
  localOnly: z.boolean(),
  defaultModelId: z.string(),
  maxOutputTokens: z.number().int().min(512).max(32768),
  maxToolSteps: z.number().int().min(1).max(20),
  maxDelegationDepth: z.number().int().min(0).max(3),
  alertEmail: alertChannel,
  alertSms: alertChannel,
  alertCooldownMinutes: z.number().int().min(1).max(1440),
});
const routineSchema = routineInput;
export const connections = [
  {
    id: 'workspace',
    name: 'Shared workspace',
    status: 'connected',
    detail: 'Local files shared by every bot. Paths are restricted to the workspace.',
  },
  {
    id: 'memory',
    name: 'Team memory',
    status: 'connected',
    detail: 'SQLite on this host. Shared profile plus separate bot memories.',
  },
  {
    id: 'google',
    name: 'Google Drive, Calendar & Contacts',
    status: 'not configured',
    detail: 'OAuth integration is planned. Imported accounts are historical references.',
  },
  {
    id: 'web',
    name: 'Web research & browser',
    status: 'not configured',
    detail: 'A search/browser adapter is planned. Bots cannot look up live facts yet.',
  },
  {
    id: 'texting',
    name: 'Texting & iMessage',
    status: 'not configured',
    detail: 'Original playbooks are preserved. A Mac bridge or SMS provider must be connected.',
  },
  {
    id: 'publishing',
    name: 'Public page hosting',
    status: 'not configured',
    detail: 'Bots can save and preview pages locally. Public hosting is planned.',
  },
];
export function createApp(
  store: Store,
  dataDir: string,
  webDir: string,
  token = process.env.BOT_BOTS_TOKEN ?? '',
  computer = new Computer(),
  preview?: PreviewDriver,
  credentials?: Credentials,
) {
  credentials?.manager().shareApiConnections();
  const app = express();
  const help = new AppHelp(resolve(webDir, '../../resources/app-help'));
  migrateTeam(store);
  const teamConversations = new TeamConversations(store);
  teamConversations.migrate();
  if (store.settings().mainBotId && !mainBot(store.all('bots'), store.settings().mainBotId))
    store.setConfig('settings', { ...store.settings(), mainBotId: null });
  const mainBotSelection = id
    .nullable()
    .refine(
      (selected) => selected === null || canBeMainBot(store.get('bots', selected)),
      'Choose an available permanent bot. Worker prototypes and temporary workers cannot be the main bot.',
    );
  const access = new AccessControl(store, token);
  const google = new GooglePlugin(
    store,
    new SecretVault(join(dataDir, 'secrets'), credentials?.vaultKey(join(dataDir, 'secrets'))),
    undefined,
    loadGoogleRegistration(resolve(webDir, '../..')),
  );
  app.disable('x-powered-by');
  if (credentials) attachModelCredentials(store, credentials);
  const chatgpt = credentials
    ? new ChatGPTAuth(
        join(dataDir, 'chatgpt'),
        new SecretVault(join(dataDir, 'chatgpt'), credentials.vaultKey(join(dataDir, 'chatgpt'))),
      )
    : undefined;
  if (credentials && chatgpt) attachChatGPT(store, credentials, chatgpt);
  const claude = new ClaudeCode(join(dataDir, 'claude-code'));
  if (credentials) attachClaudeCode(store, credentials, claude);
  migrateClaudeContexts(store);
  const alerts = new Alerts(store, credentials);
  const terminal = new Terminal(
    store,
    join(dataDir, 'workspace'),
    () => !credentials?.botTerminalBlocked(),
  );
  const drafts = new Drafts(store);
  const previewTickets = new Map<string, { html: string; expires: number }>();
  const runtime = new Runtime(
    store,
    join(dataDir, 'workspace'),
    alerts,
    computer,
    terminal,
    preview,
    drafts,
    google,
    credentials,
    help,
  );
  const credentialConversation = credentials
    ? new CredentialConversation(store, credentials, runtime.services, runtime.setups)
    : undefined;
  computer.searchProvider = store.settings().webSearchProvider ?? 'google';
  computer.configureSessions(store.settings().maxBrowserSessions ?? 6);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const host = req.hostname;
    const publicUrl = access.info().publicUrl;
    if (
      !token &&
      !['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) &&
      (!publicUrl || new URL(publicUrl).hostname !== host)
    ) {
      res.status(403).json({ error: 'Untrusted host. Set BOT_BOTS_TOKEN before network hosting.' });
      return;
    }
    const origin = req.get('origin');
    const expectedOrigin =
      publicUrl && new URL(publicUrl).host.toLowerCase() === req.get('host')?.toLowerCase()
        ? publicUrl
        : `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== expectedOrigin) {
      const allowed = (process.env.BOT_BOTS_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      if (!allowed.includes(origin)) {
        res.status(403).json({
          error:
            'Cross-origin requests are blocked. Open the host’s web UI, or configure its exact allowed client origin.',
        });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    if (req.path.startsWith('/api')) {
      const role = access.role(req);
      if (!role) {
        res
          .status(401)
          .json({ error: 'Sign in, pair this device, or enter an API key to connect.' });
        return;
      }
      if (!access.allowed(role, req)) {
        res.status(403).json({ error: 'This action requires owner access.' });
        return;
      }
      res.locals.accessRole = role;
    }
    next();
  });
  app.use('/api/credentials/manager', express.json({ limit: '32kb' }));
  app.use(express.json({ limit: '40mb' }));
  const wrap =
    (fn: express.RequestHandler): express.RequestHandler =>
    (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  app.get('/auth/status', (req, res) =>
    res.json({
      ownerConfigured: access.info().ownerConfigured,
      role: access.role(req),
      publicUrl: access.info().publicUrl,
    }),
  );
  app.post(
    '/auth/login',
    wrap((req, res) => {
      const a = z
        .object({ username: z.string().max(80), password: z.string().max(300) })
        .parse(req.body);
      const session = access.login(req, a.username, a.password);
      access.setCookie(res, req, session.token);
      res.json({ role: session.role, expiresAt: session.expiresAt });
    }),
  );
  app.post(
    '/auth/pair',
    wrap((req, res) => {
      const a = z
        .object({ code: z.string().regex(/^\d{6}$/), name: z.string().min(1).max(80) })
        .parse(req.body);
      const session = access.pair(req, a.code, a.name);
      access.setCookie(res, req, session.token);
      res.json({ role: session.role, expiresAt: session.expiresAt });
    }),
  );
  app.post('/auth/logout', (req, res) => {
    access.logout(req, res);
    res.json({ ok: true });
  });
  app.get('/api/access', (_req, res) => res.json(access.info()));
  app.post(
    '/api/access/setup',
    wrap((req, res) => {
      if (!trustedLocal(req) && !access.info().ownerConfigured)
        throw Error('Set up the owner account on the hosting machine first.');
      const a = z.object({ username: z.string(), password: z.string() }).parse(req.body);
      res.json(access.setup(a.username, a.password));
    }),
  );
  app.post(
    '/api/access/keys',
    wrap((req, res) => {
      const a = z
        .object({ name: z.string().min(1).max(100), role: z.enum(['viewer', 'operator']) })
        .parse(req.body);
      res.json(access.issue(a.name, a.role));
    }),
  );
  app.delete('/api/access/keys/:id', (req, res) => {
    access.revoke(String(req.params.id));
    res.json({ ok: true });
  });
  app.post(
    '/api/access/pairing',
    wrap((req, res) => {
      res.json(access.pairing(z.enum(['operator', 'viewer']).parse(req.body.role)));
    }),
  );
  app.put(
    '/api/access/public-url',
    wrap((req, res) => {
      const a = z.object({ url: z.string().max(500) }).parse(req.body);
      if (a.url) {
        const url = new URL(a.url);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw Error('Use an HTTPS hostname without a path, credentials, or query.');
      }
      store.setConfig('public-url', a.url ? new URL(a.url).origin : '');
      if (a.url && trustedLocal(req)) {
        const session = access.issue('Hosting computer', 'owner', 'session');
        access.setCookie(res, req, session.token);
      }
      res.json(access.info());
    }),
  );
  app.get('/api/plugins/google', (_req, res) => res.json(google.state()));
  app.post(
    '/api/plugins/google/client/import',
    wrap((req, res) => res.json(google.importClient(req.body))),
  );
  app.put(
    '/api/plugins/google',
    wrap((req, res) => {
      const a = z
        .object({ config: googleConfigSchema, clientSecret: z.string().max(2000).optional() })
        .parse(req.body);
      res.json(google.configure(a.config, a.clientSecret));
    }),
  );
  app.post(
    '/api/plugins/google/authorize',
    wrap((req, res) => {
      const options = z.object({ identityOnly: z.boolean().optional() }).parse(req.body ?? {});
      if (google.config().clientType === 'desktop' && !trustedLocal(req))
        throw Error(
          'Sign in on the computer hosting Bot-Bots, or ask the host owner to enable web-based Google sign-in for remote devices.',
        );
      const callbackOrigin =
        google.config().clientType === 'desktop'
          ? trustedLocal(req)
            ? `http://127.0.0.1:${req.socket.localPort}`
            : undefined
          : store.config<string>('public-url');
      res.json(google.authorize({ ...options, callbackOrigin }));
    }),
  );
  app.post(
    '/api/plugins/google/authorize/cancel',
    wrap((_req, res) => res.json(google.cancelAuthorization())),
  );
  app.post(
    '/api/plugins/google/disconnect',
    wrap(async (_req, res) => res.json(await google.disconnect())),
  );
  app.post(
    '/api/plugins/google/actions/:id/decision',
    wrap(async (req, res) =>
      res.json(await google.decide(String(req.params.id), z.boolean().parse(req.body.approve))),
    ),
  );
  app.get('/oauth/google/callback', async (req, res) => {
    try {
      await google.callback(
        String(req.query.state ?? ''),
        String(req.query.code ?? ''),
        req.query.error ? String(req.query.error) : undefined,
      );
      runtime.events.emit('google-connected');
      res
        .type('html')
        .send(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google connected · Bot-Bots</title><body style="background:#141a16;color:#e1e9dc;font:18px system-ui;padding:48px;max-width:640px;margin:auto"><img src="/logo.svg" width="80" height="80" alt="Three smiling bots"><h1>You’re connected.</h1><p>Return to Bot-Bots to choose which Google apps and bots can work together. You can close this browser tab.</p><p><a href="/" style="color:#a9cd8e">Open Bot-Bots in this browser</a></p>',
        );
    } catch {
      res
        .status(400)
        .type('html')
        .send(
          '<!doctype html><title>Authorization needs attention</title><p>Google authorization expired, was declined, or failed. Return to Plugins and try again.</p>',
        );
    }
  });
  app.get('/api/categories', (_req, res) => res.json(store.all('categories')));
  app.post(
    '/api/categories',
    wrap((req, res) => {
      const category = categorySchema.parse({ ...req.body, id: randomUUID() });
      store.put('categories', category);
      res.json(category);
    }),
  );
  app.put(
    '/api/categories/:id',
    wrap((req, res) => {
      const category = categorySchema.parse({ ...req.body, id: req.params.id });
      store.put('categories', category);
      res.json(category);
    }),
  );
  app.delete(
    '/api/categories/:id',
    wrap((req, res) => {
      store.remove('categories', String(req.params.id));
      for (const b of store.all('bots'))
        if (b.categoryId === req.params.id) store.put('bots', { ...b, categoryId: undefined });
      res.json({ ok: true });
    }),
  );
  app.get('/api/bots/:id/history', (req, res) => res.json(tasksFor(store, String(req.params.id))));
  app.get(
    '/api/bots/:id/phrase-suggestions',
    wrap((req, res) => {
      const bot = store.get('bots', String(req.params.id));
      if (!bot) throw Error('Bot not found.');
      res.json(phraseSuggestions(store, bot));
    }),
  );
  app.post(
    '/api/bots/phrase-suggestions',
    wrap((req, res) =>
      res.json(
        phraseSuggestions(store, {
          ...botSchema.parse(req.body),
          id: typeof req.body.id === 'string' ? req.body.id : '',
        }),
      ),
    ),
  );
  app.post(
    '/api/bots/:id/compaction/preview',
    wrap((req, res) => {
      const plan = compactionPlan(
        store,
        String(req.params.id),
        z.number().int().min(0).max(100).parse(req.body.amount),
      );
      const { before, after, archive, ...publicPlan } = plan;
      res.json(publicPlan);
    }),
  );
  app.post(
    '/api/bots/:id/compaction',
    wrap((req, res) => {
      if (runtime.controllers.size) throw Error('Wait for running tasks before compacting memory.');
      res.json(
        applyCompaction(
          store,
          String(req.params.id),
          z.number().int().min(0).max(100).parse(req.body.amount),
          z.string().parse(req.body.hash),
        ),
      );
    }),
  );
  app.get('/api/bots/:id/compactions', (req, res) =>
    res.json(
      store
        .all('compactions')
        .filter((c) => c.botId === req.params.id)
        .map(({ archive, ...c }) => c),
    ),
  );
  app.post(
    '/api/compactions/:id/undo',
    wrap((req, res) => {
      if (runtime.controllers.size) throw Error('Wait for running tasks before restoring memory.');
      undoCompaction(store, String(req.params.id));
      res.json({ ok: true });
    }),
  );
  app.get('/api/credentials', (_req, res) => {
    if (res.locals.accessRole !== 'owner') {
      res.status(403).json({ error: 'Only the owner can review host credential operations.' });
      return;
    }
    res.json(
      credentials?.state() ?? {
        configured: false,
        enabled: false,
        backend: 'Credential broker not attached to this test host',
        botTerminalBlocked: false,
        capabilities: [],
        actions: [],
      },
    );
  });
  app.post(
    '/api/credentials/:id/decision',
    wrap(async (req, res) => {
      if (!credentials) throw Error('The credential broker is not attached.');
      const { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
      res.json(await credentials.decide(String(req.params.id), approve));
    }),
  );
  // Only the signed-in owner UI can manage secrets; models have no corresponding tool.
  app.use('/api/credentials/manager', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (res.locals.accessRole !== 'owner') {
      res.status(403).json({ error: 'Only the owner can manage keys and passwords.' });
      return;
    }
    const publicUrl = access.info().publicUrl;
    if (
      !trustedLocal(req) &&
      !req.secure &&
      !(publicUrl?.startsWith('https:') && req.get('origin') === publicUrl)
    ) {
      res.status(426).json({ error: 'Use HTTPS when entering secrets from another computer.' });
      return;
    }
    if (req.method !== 'GET') {
      const expected =
        publicUrl && new URL(publicUrl).host === req.get('host')
          ? publicUrl
          : `${req.protocol}://${req.get('host')}`;
      if (req.get('origin') && req.get('origin') !== expected) {
        res.status(403).json({ error: 'Open this server’s own app window to manage secrets.' });
        return;
      }
      if (!req.is('application/json')) {
        res.status(415).json({ error: 'Use the credential window to submit this request.' });
        return;
      }
    }
    next();
  });
  const managerRoute =
    (fn: express.RequestHandler): express.RequestHandler =>
    (req, res, next) => {
      try {
        if (!credentials) {
          res.status(503).json({ error: 'Credential storage is not attached to this host.' });
          return;
        }
        fn(req, res, next);
      } catch (error) {
        res
          .status(
            error instanceof CredentialManagerError
              ? error.status
              : error instanceof z.ZodError
                ? 400
                : 503,
          )
          .json({
            error:
              error instanceof CredentialManagerError
                ? error.message
                : error instanceof z.ZodError
                  ? 'Check the form fields. Authenticated destinations require HTTPS and response fields must not expose credentials.'
                  : 'The credential store could not complete this request. No secret values were returned.',
          });
      }
    };
  const chatgptRoute = (fn: express.RequestHandler): express.RequestHandler =>
    wrap(async (req, res, next) => {
      if (!chatgpt) {
        res
          .status(503)
          .json({ error: 'ChatGPT sign-in needs protected credential storage on this host.' });
        return;
      }
      try {
        await fn(req, res, next);
      } catch (e) {
        res.status(400).json({
          error:
            e instanceof Error &&
            /^(ChatGPT|Claude|Could not reach ChatGPT|Finish|Sign in|Enable ChatGPT)/.test(
              e.message,
            )
              ? e.message
              : 'The account connection could not complete this action. Try again.',
        });
      }
    });
  const chatgptProvider = () => {
    if (!store.get('providers', 'chatgpt'))
      store.put('providers', {
        id: 'chatgpt',
        name: 'ChatGPT',
        kind: 'chatgpt',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: '',
        local: false,
        enabled: true,
        autoDiscover: false,
        timeoutMs: 180000,
      });
  };
  app.get(
    '/api/credentials/manager/chatgpt',
    chatgptRoute(async (_req, res) => {
      res.json(await chatgpt!.state());
    }),
  );
  app.get(
    '/api/credentials/manager/claude-code',
    chatgptRoute(async (_req, res) => {
      res.json(await claude.state());
    }),
  );
  app.post(
    '/api/credentials/manager/claude-code/signin',
    chatgptRoute(async (_req, res) => {
      await claude.signIn();
      res.json(await claude.state());
    }),
  );
  app.post(
    '/api/credentials/manager/claude-code/cancel',
    chatgptRoute(async (_req, res) => {
      claude.cancel();
      res.json(await claude.state());
    }),
  );
  app.post(
    '/api/credentials/manager/claude-code/models',
    chatgptRoute(async (_req, res) => {
      if (!store.get('providers', 'claude-code'))
        store.put('providers', {
          id: 'claude-code',
          name: 'Claude Code',
          kind: 'claude-code',
          baseUrl: 'https://claude.ai',
          apiKeyEnv: '',
          local: false,
          enabled: true,
          autoDiscover: false,
          timeoutMs: 180000,
        });
      res.json(await discover(store, 'claude-code'));
    }),
  );
  app.post(
    '/api/credentials/manager/claude-code/disconnect',
    chatgptRoute(async (_req, res) => {
      await claude.disconnect();
      for (const m of store.all('models').filter((m) => m.providerId === 'claude-code'))
        store.put('models', { ...m, enabled: false, status: 'offline' });
      res.json(await claude.state());
    }),
  );
  app.post(
    '/api/credentials/manager/chatgpt/signin',
    chatgptRoute(async (req, res) => {
      const input = z.object({ profileId: z.string().max(100).optional() }).parse(req.body ?? {});
      res.json(await chatgpt!.signIn(input.profileId));
    }),
  );
  app.post(
    '/api/credentials/manager/chatgpt/cancel',
    chatgptRoute(async (_req, res) => {
      chatgpt!.cancel();
      res.json(await chatgpt!.state());
    }),
  );
  app.post(
    '/api/credentials/manager/chatgpt/select',
    chatgptRoute(async (req, res) => {
      await chatgpt!.select(z.object({ profileId: z.string().max(100) }).parse(req.body).profileId);
      for (const m of store.all('models').filter((m) => m.providerId === 'chatgpt'))
        store.put('models', { ...m, enabled: false, status: 'unknown' });
      res.json(await chatgpt!.state());
    }),
  );
  app.post(
    '/api/credentials/manager/chatgpt/models',
    chatgptRoute(async (_req, res) => {
      chatgptProvider();
      res.json(await discover(store, 'chatgpt'));
    }),
  );
  app.post(
    '/api/credentials/manager/chatgpt/disconnect',
    chatgptRoute(async (_req, res) => {
      await chatgpt!.disconnect();
      for (const m of store.all('models').filter((m) => m.providerId === 'chatgpt'))
        store.put('models', { ...m, enabled: false, status: 'offline' });
      res.json(await chatgpt!.state());
    }),
  );
  app.post(
    '/api/credentials/manager/claude',
    managerRoute((_req, res) => {
      if (!store.get('providers', 'anthropic'))
        store.put('providers', {
          id: 'anthropic',
          name: 'Claude',
          kind: 'anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
          apiKeyEnv: '',
          enabled: true,
          local: false,
          timeoutMs: 180000,
          autoDiscover: false,
        });
      res.json({ providerId: 'anthropic' });
    }),
  );
  app.get(
    '/api/credentials/manager',
    managerRoute((_req, res) => res.json(credentials!.manager().state())),
  );
  app.get(
    '/api/credentials/manager/requests',
    managerRoute((req, res) => {
      res.json(
        runtime.setups
          .list()
          .filter(
            (request) =>
              (!req.query.botId || request.botId === req.query.botId) &&
              (!req.query.conversationId || request.conversationId === req.query.conversationId),
          )
          .slice(-200)
          .map((request) => {
            const bot = store.get('bots', request.botId),
              api =
                request.api ??
                runtime.services.apiFor(request.service, request.botId, request.conversationId);
            const connection = bot
              ? runtime.services.capabilities(bot).find((service) => service.api.id === api?.id)
              : undefined;
            return {
              ...request,
              api,
              ...(api && request.status === 'saved'
                ? { connected: !!connection, grantId: connection?.id }
                : {}),
            };
          }),
      );
    }),
  );
  app.post(
    '/api/credentials/manager/conversation',
    managerRoute((req, res) => {
      const input = z
        .object({
          botId: id,
          conversationId: id.optional(),
          runId: id.optional(),
          text: z.string().min(1).max(16000),
        })
        .strict()
        .parse(req.body);
      res.json(credentialConversation!.handle(input));
    }),
  );
  app.post(
    '/api/credentials/manager/requests',
    managerRoute((req, res) => {
      const input = setupInput.parse(req.body);
      const request = runtime.setups.create(
        {
          ...input,
          api:
            input.api ?? runtime.services.apiFor(input.service, input.botId, input.conversationId),
        },
        'human',
      );
      if (!store.all('messages').some((message) => message.id === `private-${request.id}`))
        store.put('messages', {
          id: `private-${request.id}`,
          botId: request.botId,
          conversationId: request.conversationId,
          role: 'user',
          content: `I’d like to add ${request.service || 'a key or password'} using the private window.`,
          createdAt: request.createdAt,
        });
      res.status(201).json(request);
    }),
  );
  app.post(
    '/api/credentials/manager/requests/:id/cancel',
    managerRoute((req, res) => {
      res.json(runtime.setups.finish(String(req.params.id), 'cancelled'));
    }),
  );
  app.post(
    '/api/credentials/manager/connect-service',
    managerRoute((req, res) => {
      const input = z
        .object({
          version: z.string().length(64),
          secretId: z.string(),
          api: serviceApiSchema,
          botIds: z.array(z.string()).min(1).default(['*']),
          approval: z.literal('connected').default('connected'),
        })
        .strict()
        .parse(req.body);
      const secret = credentials!
        .manager()
        .state()
        .secrets.find((secret) => secret.id === input.secretId && secret.present);
      if (!secret) throw new CredentialManagerError('Choose an existing saved token.');
      const result = credentials!.manager().save({
        version: input.version,
        id: secret.id,
        name: secret.name,
        kind: secret.kind,
        target: {
          type: 'service',
          api: input.api,
          botIds: input.botIds,
          approval: input.approval,
        },
      });
      for (const request of runtime.setups.list())
        if (request.secretId === secret.id && request.status === 'saved')
          store.put('credentialSetups', {
            ...request,
            api: input.api,
            connected: true,
            grantId: result.grantId,
          });
      res.json({ ...result, state: credentials!.manager().state() });
    }),
  );
  app.post(
    '/api/credentials/manager/requests/:id/connect',
    managerRoute((req, res) => {
      const request = store.get('credentialSetups', String(req.params.id));
      if (!request || request.status !== 'saved')
        throw new CredentialManagerError(
          'Save the key privately before asking for connection help.',
        );
      const api =
        request.api ??
        runtime.services.apiFor(request.service, request.botId, request.conversationId);
      if (api) {
        const bot = store.get('bots', request.botId);
        const ready =
          bot && runtime.services.capabilities(bot).find((service) => service.api.id === api.id);
        if (ready) {
          res.json({ connected: true, service: ready });
          return;
        }
        res.status(202).json({
          credentialRequest: runtime.setups.create(
            {
              botId: request.botId,
              conversationId: request.conversationId,
              service: api.name,
              api,
              kind: request.kind,
              purpose:
                'Connect the complete API using your already-saved token; no value needs to be re-entered',
            },
            'human',
          ),
        });
        return;
      }
      res
        .status(202)
        .json(
          runtime.create(
            request.botId,
            `Bot-Bots help: assist with the service connection for the key named ${request.service}. The value was saved privately and is unavailable to you. Find the documented HTTPS operation for the previously requested service, then use credential_setup_request from this bot so the human can review the destination and access. The form can reuse the same-named stored secret without revealing it. Merely storing a key grants no operation; do not invent an endpoint or claim access exists. Only prepare the connection. Do not publish, send messages, or execute commands.`,
            request.conversationId,
          ),
        );
    }),
  );
  app.post(
    '/api/credentials/manager/check-service',
    wrap(async (req, res) => {
      const input = z.object({ serviceId: z.string(), botId: z.string() }).strict().parse(req.body),
        bot = store.get('bots', input.botId);
      if (!credentials || !bot) {
        res.status(404).json({ error: 'Choose an available API connection.' });
        return;
      }
      const connection = runtime.services
        .capabilities(bot)
        .find((service) => service.id === input.serviceId);
      if (!connection) {
        res.status(409).json({ error: 'This API is not connected to this bot.' });
        return;
      }
      try {
        if (connection.api.id === 'bottools-pages')
          await credentials.serviceRequest(
            connection.id,
            'info',
            {},
            {},
            bot,
            new AbortController().signal,
          );
        res.json({
          connected: true,
          verified: connection.api.id === 'bottools-pages',
          api: connection.api.name,
          actions: connection.api.operations.length,
        });
      } catch (error) {
        res.status(502).json({
          error:
            error instanceof Error ? error.message : 'The connected service could not be verified.',
        });
      }
    }),
  );
  app.post(
    '/api/credentials/manager/secrets',
    managerRoute((req, res) => {
      if (terminal.state().jobs.some((job) => job.source === 'bot' && job.status === 'running'))
        throw new CredentialManagerError(
          'Wait for running bot terminal commands to finish before saving a secret.',
          409,
        );
      const input = saveSecretSchema.parse(req.body);
      const setup = input.requestId ? runtime.setups.pending(input.requestId) : undefined;
      let provider =
        input.target.type === 'model' && input.target.providerId
          ? store.get('providers', input.target.providerId)
          : undefined;
      if (input.target.type === 'model') {
        if (!provider && !input.target.provider)
          throw new CredentialManagerError('Choose an existing model server or create a new one.');
        if (!provider) {
          const target = input.target.provider!;
          provider = {
            id: `provider-${randomUUID()}`,
            ...target,
            baseUrl: normalizeBaseUrl(target.baseUrl),
            apiKeyEnv: '',
            enabled: true,
            local: false,
            timeoutMs: 180000,
            autoDiscover: false,
          };
        }
      }
      if (
        (input.target.type === 'operation' || input.target.type === 'service') &&
        input.target.botIds.some((id) => id !== '*' && !store.get('bots', id))
      )
        throw new CredentialManagerError('Choose current teammates for this service.');
      const binding = provider
        ? { purpose: 'model' as const, url: provider.baseUrl }
        : input.target.type === 'alert'
          ? { purpose: 'alert' as const, url: input.target.url }
          : undefined;
      const saved = credentials!.manager().save(input, binding);
      if (provider) store.put('providers', { ...provider, credentialId: saved.grantId });
      if (input.target.type === 'alert') {
        const settings = store.settings(),
          field = input.target.channel === 'email' ? 'alertEmail' : 'alertSms';
        store.setConfig('settings', {
          ...settings,
          [field]: { ...settings[field], url: input.target.url, credentialId: saved.grantId },
        });
      }
      credentials!.cancelRun();
      const request = setup
        ? runtime.setups.finish(setup.id, 'saved', {
            secretId: saved.id,
            grantId: saved.grantId,
            connected: !!saved.grantId,
            service: input.name,
            kind: input.kind,
            api: input.target.type === 'service' ? input.target.api : undefined,
          })
        : undefined;
      let continuation;
      if (request?.source === 'human') {
        const previous = store
          .all('runs')
          .findLast((run) => run.conversationId === request.conversationId);
        const publication = previous ? publishIntent(previous) : { wanted: false, short: false };
        const status = request.connected
          ? 'connected to the reviewed service'
          : 'stored privately, with no service operation granted yet';
        const note = `The human saved a ${request.kind === 'password' ? 'password' : 'key'} for ${input.name} in the private credential window. It is ${status}. You cannot read its value. ${saved.grantId ? `Saved credential connection ID: ${saved.grantId}.` : ''} ${request.api && request.connected ? 'The complete API catalog is connected with this one token. Use service_list, service_call or page_publish now; do not ask for another endpoint grant or key.' : 'If no service is connected, help review its documented API using credential_setup_request.'} Continue the previously requested task if appropriate, or acknowledge the connection. ${request.connected && publication.wanted ? `The human's previous task requested a ${publication.short ? 'short link' : 'published page'}; finish that publication now.` : ''} Never ask for the secret again in chat or expose it through shell/environment.`;
        try {
          continuation = runtime.create(
            request.botId,
            note,
            request.conversationId,
            {},
            `Saved ${input.name} privately. The bot cannot read its value.`,
          );
        } catch {
          /* Storage succeeded even if the bot is unavailable or the run cap is reached. */
        }
      }
      res
        .status(201)
        .json({ ...saved, request, run: continuation, state: credentials!.manager().state() });
    }),
  );
  app.delete(
    '/api/credentials/manager/secrets/:id',
    managerRoute((req, res) => {
      const { version } = z
        .object({ version: z.string().length(64) })
        .strict()
        .parse(req.body);
      const result = credentials!.manager().remove(String(req.params.id), version);
      credentials!.cancelRun();
      res.json({ ...result, state: credentials!.manager().state() });
    }),
  );
  app.delete(
    '/api/credentials/manager/connections/:id',
    managerRoute((req, res) => {
      const { version } = z
        .object({ version: z.string().length(64) })
        .strict()
        .parse(req.body);
      const result = credentials!.manager().revoke(String(req.params.id), version);
      credentials!.cancelRun();
      res.json({ ...result, state: credentials!.manager().state() });
    }),
  );
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', version, mode: 'local-first' }));
  app.get('/api/bootstrap', (_req, res) => {
    const bootstrap: Bootstrap = {
      accessRole: res.locals.accessRole,
      categories: store.all('categories'),
      bots: store.all('bots'),
      providers: store.all('providers'),
      models: store.all('models'),
      routines: store.all('routines'),
      skills: help.merge(store.all('skills')),
      runs: store
        .all('runs')
        .filter((run, index, all) => run.status === 'running' || index >= all.length - 100)
        .reverse(),
      pages: store.all('pages').reverse(),
      memory: store.all('memory'),
      incidents: store.all('incidents'),
      settings: store.settings(),
      assessments: store.assessments(),
      connections: connections.map((c) =>
        c.id === 'google'
          ? {
              ...c,
              name: 'Google Workspace',
              status: google.state().connected ? 'connected' : 'not configured',
              detail:
                'One Google connection with per-app, per-action and per-bot permissions. Manage it in Plugins.',
            }
          : c.id === 'web'
            ? {
                ...c,
                status: computer.state().available ? 'connected' : 'desktop required',
                detail: computer.state().available
                  ? 'Live web search with separate Chromium sessions for bots and a queue when full. Open Browser to watch or assist.'
                  : computer.state().error!,
              }
            : c,
      ),
    };
    res.json(bootstrap);
  });
  app.get('/api/conversations', (req, res) =>
    res.json(
      store
        .all('conversations')
        .filter((c) => !req.query.botId || c.botId === req.query.botId)
        .reverse(),
    ),
  );
  app.get('/api/team-conversations', (_req, res) => res.json(teamConversations.list()));
  app.get('/api/conversations/:id', (req, res) => {
    const aliases = store.config<Record<string, string>>('legacy-conversation-aliases');
    const channel = store.get(
      'conversations',
      aliases?.[String(req.params.id)] ?? String(req.params.id),
    );
    if (!channel) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    res.json(channel);
  });
  app.post(
    '/api/team-conversations',
    wrap((req, res) => {
      const input = z
        .object({ title: z.string().trim().min(1).max(100).optional() })
        .parse(req.body ?? {});
      res.status(201).json(teamConversations.create(input.title));
    }),
  );
  app.put(
    '/api/team-conversations/:id',
    wrap((req, res) => {
      const space = store.get('teamConversations', String(req.params.id));
      if (!space) {
        res.status(404).json({ error: 'Team conversation not found.' });
        return;
      }
      const { title } = z.object({ title: z.string().trim().min(1).max(100) }).parse(req.body);
      res.json(store.put('teamConversations', { ...space, title }));
    }),
  );
  app.post(
    '/api/team-conversations/:id/bots/:botId',
    wrap((req, res) => {
      res.json(teamConversations.channel(String(req.params.id), String(req.params.botId)));
    }),
  );
  app.get('/api/team-conversations/:id/bots/:botId', (req, res) =>
    res.json(
      store
        .all('conversations')
        .find((c) => c.spaceId === req.params.id && c.botId === req.params.botId) ?? null,
    ),
  );
  app.get('/api/bots/:id/inbox', (req, res) =>
    res.json(runtime.mailbox.inbox(String(req.params.id)).slice(0, 100)),
  );
  app.get('/api/deliveries/:id', (req, res) => {
    const delivery = runtime.mailbox.get(String(req.params.id));
    if (!delivery) res.status(404).json({ error: 'Delivery not found' });
    else res.json(delivery);
  });
  app.get('/api/computer', (_req, res) => res.json(computer.state()));
  app.get('/api/terminal', (_req, res) => res.json(terminal.state()));
  app.post(
    '/api/previews',
    wrap((req, res) => {
      const { content } = z.object({ content: z.string().max(250000) }).parse(req.body);
      for (const [key, value] of previewTickets)
        if (value.expires < Date.now()) previewTickets.delete(key);
      while (previewTickets.size >= 20) previewTickets.delete(previewTickets.keys().next().value!);
      const ticket = randomBytes(24).toString('hex');
      previewTickets.set(ticket, { html: previewHtml(content), expires: Date.now() + 30 * 60000 });
      res.json({ url: `/preview/${ticket}` });
    }),
  );
  app.get('/preview/:ticket', (req, res) => {
    const ticket = previewTickets.get(String(req.params.ticket));
    if (!ticket || ticket.expires < Date.now()) {
      res.status(410).send('This preview expired. Restart it from Bot-Bots.');
      return;
    }
    res.setHeader('Content-Security-Policy', `sandbox allow-scripts; ${PREVIEW_POLICY}`);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(ticket.html);
  });
  app.get('/api/terminal/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(terminal.state())}\n\n`);
    const change = (state: unknown) => res.write(`data: ${JSON.stringify(state)}\n\n`),
      shutdown = () => res.end();
    terminal.events.on('change', change);
    terminal.events.once('shutdown', shutdown);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      terminal.events.off('change', change);
      terminal.events.off('shutdown', shutdown);
    });
  });
  app.post(
    '/api/terminal/:id/decision',
    wrap((req, res) => {
      const { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
      res.json(terminal.decide(String(req.params.id), approve));
    }),
  );
  app.post(
    '/api/terminal/manual',
    wrap((req, res) => {
      const a = z
        .object({ command: z.string().min(1).max(12000), cwd: z.string().max(300).default('.') })
        .strict()
        .parse(req.body);
      res.status(202).json(terminal.manual(a.command, a.cwd));
    }),
  );
  app.post(
    '/api/terminal/:id/cancel',
    wrap((req, res) => {
      terminal.cancel(String(req.params.id));
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/computer/search-provider',
    wrap((req, res) => {
      const { provider } = z
        .object({ provider: z.enum(['google', 'bing', 'duckduckgo', 'brave']) })
        .parse(req.body);
      computer.searchProvider = provider;
      store.setConfig('settings', { ...store.settings(), webSearchProvider: provider });
      computer.changed();
      res.json(computer.state());
    }),
  );
  app.get('/api/computer/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(computer.state())}\n\n`);
    const change = (state: unknown) => res.write(`data: ${JSON.stringify(state)}\n\n`);
    const shutdown = () => res.end();
    computer.events.on('change', change);
    computer.events.once('shutdown', shutdown);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      computer.events.off('change', change);
      computer.events.off('shutdown', shutdown);
    });
  });
  app.post(
    '/api/computer/tabs',
    wrap((_req, res) => res.status(201).json(computer.create())),
  );
  app.post(
    '/api/computer/select',
    wrap((req, res) => {
      computer.select(z.object({ tabId: id }).parse(req.body).tabId);
      res.json(computer.state());
    }),
  );
  app.delete(
    '/api/computer/tabs/:id',
    wrap((req, res) => {
      computer.closeTab(String(req.params.id));
      res.json(computer.state());
    }),
  );
  app.post(
    '/api/computer/control',
    wrap((req, res) => {
      computer.setPaused(z.object({ paused: z.boolean() }).parse(req.body).paused);
      res.json(computer.state());
    }),
  );
  const browserAction = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('open'), url: z.string().url().max(4000) }),
    z.object({ kind: z.literal('read') }),
    z.object({ kind: z.literal('click'), ref: id }),
    z.object({ kind: z.literal('type'), ref: id, text: z.string().max(6000) }),
    z.object({ kind: z.literal('scroll'), direction: z.enum(['up', 'down']) }),
    z.object({ kind: z.literal('back') }),
    z.object({ kind: z.literal('forward') }),
    z.object({ kind: z.literal('reload') }),
    z.object({
      kind: z.literal('pointer'),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    }),
    z.object({
      kind: z.literal('keyboard'),
      text: z.string().max(6000),
      enter: z.boolean().optional(),
    }),
  ]);
  app.post(
    '/api/computer/action',
    wrap(async (req, res) => {
      const a = z.object({ tabId: id, action: browserAction }).parse(req.body);
      res.json(await computer.act(a.tabId, a.action, 'human'));
    }),
  );
  app.get(
    '/api/computer/tabs/:id/capture',
    wrap(async (req, res) => {
      if (!computer.driver) {
        res.status(503).json({ error: computer.state().error });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json(await computer.driver.capture(String(req.params.id)));
    }),
  );
  app.get('/api/conversations/:id/messages', (req, res) =>
    res.json(store.all('messages').filter((m) => m.conversationId === req.params.id)),
  );
  app.get('/api/conversations/:id/runs', (req, res) => {
    const linked = new Set(
      store
        .all('messages')
        .filter((m) => m.conversationId === req.params.id)
        .map((m) => m.runId),
    );
    res.json(
      store.all('runs').filter((run) => run.conversationId === req.params.id || linked.has(run.id)),
    );
  });
  app.get('/api/conversations/:id/drafts', (req, res) => {
    const conversation = store.get('conversations', String(req.params.id));
    const linked = new Set(
      store
        .all('messages')
        .filter((m) => m.conversationId === req.params.id)
        .map((m) => m.runId),
    );
    res.json(
      drafts
        .list()
        .filter(
          (d) =>
            d.conversationId === req.params.id ||
            (d.botId === conversation?.botId && linked.has(d.activeRunId)),
        ),
    );
  });
  app.get(
    '/api/drafts/:id',
    wrap((req, res) => res.json(drafts.get(String(req.params.id)))),
  );
  app.get('/api/runs/:id/builds', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(runtime.builds.list(String(req.params.id)));
  });
  app.get('/api/live-builds/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const build = runtime.builds.get(String(req.params.id));
    if (!build) {
      res
        .status(404)
        .json({ error: 'This live build is no longer active. Its saved files remain available.' });
      return;
    }
    res.json(
      String(req.query.since) === String(build.version)
        ? { unchanged: true, status: build.status }
        : build,
    );
  });
  app.get(
    '/api/drafts/:id/build',
    wrap((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const draft = drafts.get(String(req.params.id)),
        live = runtime.builds.get(`build-${draft.workId}`);
      const build =
        live?.draftId === draft.id
          ? live
          : {
              content: draft.content,
              status: draft.status,
              version: draft.revision,
              filename: draft.filename,
            };
      res.json(
        String(req.query.since) === String(build.version)
          ? { unchanged: true, status: build.status }
          : build,
      );
    }),
  );
  app.get(
    '/api/drafts/:id/download',
    wrap((req, res) => {
      const draft = drafts.get(String(req.params.id));
      const filename = draft.filename
        .split(/[\\/]/)
        .at(-1)!
        .replace(/[^a-z0-9._-]/gi, '-');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.type('application/octet-stream').send(draft.content);
    }),
  );
  app.post(
    '/api/drafts/:id/continue',
    wrap((req, res) => {
      const draft = drafts.get(String(req.params.id));
      if (draft.kind === 'tool-payload' || draft.status !== 'partial') {
        res.status(400).json({
          error:
            'Choose an interrupted code/text draft. Use chat to steer a task that is still writing.',
        });
        return;
      }
      const original = store.get('runs', draft.activeRunId) ?? store.get('runs', draft.runId);
      if (!original) {
        res.status(404).json({ error: 'The original conversation could not be found.' });
        return;
      }
      const run = runtime.create(
        original.botId,
        `Continue the saved ${draft.filename} draft ${draft.id}. Read it with draft_read; the existing ${draft.content.length} characters are already saved. Treat an interrupted file as unfinished. Compare its source with ORIGINAL TASK and implement every missing requirement, including event handlers and behavior even if closing HTML tags already exist. Use draft_append for new sections or draft_patch to insert/fix code in an earlier section with the current revision. Do not restart or repeat saved code. Finish with draft_finish only when complete; for interactive HTML use page_preview click/expect-text checks to verify requested behavior and fix failures. Keep the final reply concise.\nORIGINAL TASK: ${draft.objective ?? store.get('runs', draft.runId)?.prompt.slice(0, 10000) ?? original.prompt.slice(0, 10000)}\nLATEST HUMAN DIRECTION: ${original.steering?.at(-1)?.content.slice(0, 6000) ?? 'Continue the original task.'}`,
        original.conversationId,
        {},
        `Continue ${draft.filename} from the saved draft.`,
      );
      res.status(202).json(run);
    }),
  );
  app.post(
    '/api/runs',
    wrap((req, res) => {
      const a = z
        .object({
          botId: id,
          prompt: z.string().trim().min(1).max(2000000),
          clientMessageId: z.string().uuid().optional(),
          timezone: z
            .string()
            .max(100)
            .refine((value) => {
              try {
                new Intl.DateTimeFormat('en', { timeZone: value });
                return true;
              } catch {
                return false;
              }
            }, 'Choose a valid timezone.')
            .optional(),
          conversationId: id.optional(),
          urgency: urgency.optional(),
          importance: importance.optional(),
          task: taskType.optional(),
        })
        .parse(req.body);
      if (store.get('bots', a.botId)?.isPrototype) {
        res.status(409).json({
          error:
            'Ask another bot to delegate to this prototype so it can return the clones’ combined answers.',
        });
        return;
      }
      if (
        credentialConversation?.accepts(a.prompt, a.conversationId) ||
        wantsPrivateEntry(a.prompt)
      ) {
        if (res.locals.accessRole !== 'owner' || !credentials) {
          res
            .status(403)
            .json({ error: 'The owner must enter credentials through the private window.' });
          return;
        }
        res.status(202).json(
          credentialConversation!.handle({
            botId: a.botId,
            conversationId: a.conversationId,
            text: a.prompt,
          }),
        );
        return;
      }
      if (a.clientMessageId) {
        const previous = store.get('messages', a.clientMessageId);
        if (previous) {
          if (previous.botId !== a.botId || previous.content !== a.prompt)
            throw Error('Message identity conflicts with a different message.');
          const run = previous.runId ? store.get('runs', previous.runId) : undefined;
          if (run) {
            res.status(202).json(run);
            return;
          }
        }
      }
      res
        .status(202)
        .json(
          runtime.create(
            a.botId,
            a.prompt,
            a.conversationId,
            { ...a, panelAccess: res.locals.accessRole === 'owner' },
            undefined,
            'chat',
            a.clientMessageId,
          ),
        );
    }),
  );
  app.get('/api/runs/:id', (req, res) => {
    const run = store.get('runs', String(req.params.id));
    if (!run) res.status(404).json({ error: 'Run not found' });
    else res.json(run);
  });
  app.post(
    '/api/runs/:id/messages',
    wrap((req, res) => {
      const { content } = z
        .object({ content: z.string().trim().min(1).max(24000) })
        .parse(req.body);
      const active = store.get('runs', String(req.params.id));
      if (
        credentialConversation?.accepts(content, active?.conversationId) ||
        wantsPrivateEntry(content)
      ) {
        if (
          res.locals.accessRole !== 'owner' ||
          !credentials ||
          !active ||
          active.status !== 'running'
        ) {
          res
            .status(403)
            .json({ error: 'Open the owner’s private credential window for the active task.' });
          return;
        }
        res.status(202).json(
          credentialConversation!.handle({
            botId: active.botId,
            conversationId: active.conversationId,
            runId: active.id,
            text: content,
          }),
        );
        return;
      }
      res
        .status(202)
        .json(
          runtime.steer(
            String(req.params.id),
            content,
            undefined,
            undefined,
            res.locals.accessRole === 'owner',
          ),
        );
    }),
  );
  app.get('/api/activity/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write(
      `data: ${JSON.stringify({ type: 'snapshot', runs: store.all('runs').filter((run) => run.status === 'running') })}\n\n`,
    );
    const listener = (run: import('../../packages/shared/types').Run) =>
      res.write(
        `data: ${JSON.stringify({ type: 'run', run, bots: store.all('bots').filter((b) => b.prototypeId && run.work?.some((w) => w.botId === b.id)) })}\n\n`,
      );
    runtime.events.on('activity', listener);
    const catalog = (value: {
      models: import('../../packages/shared/types').Model[];
      providers: import('../../packages/shared/types').Provider[];
    }) => res.write(`data: ${JSON.stringify({ type: 'models', ...value })}\n\n`);
    runtime.events.on('models', catalog);
    if (store.all('providers').some((p) => p.local && p.autoDiscover !== false))
      catalog({ models: store.all('models'), providers: store.all('providers') });
    const shutdown = () => res.end();
    runtime.events.once('shutdown', shutdown);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      runtime.events.off('activity', listener);
      runtime.events.off('models', catalog);
      runtime.events.off('shutdown', shutdown);
    });
  });
  app.get('/api/runs/:id/events', (req, res) => {
    const run = store.get('runs', String(req.params.id));
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'snapshot', run })}\n\n`);
    if (run.status !== 'running') {
      res.write(`data: ${JSON.stringify({ type: 'done', run })}\n\n`);
      res.end();
      return;
    }
    const listener = (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if ((event as { type: string }).type === 'done') res.end();
    };
    runtime.events.on(run.id, listener);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      runtime.events.off(run.id, listener);
    });
  });
  app.post('/api/runs/:id/cancel', (req, res) => {
    runtime.cancel(String(req.params.id));
    res.json({ ok: true });
  });
  app.patch(
    '/api/runs/:id/rating',
    wrap((req, res) => {
      const run = store.get('runs', String(req.params.id));
      if (!run || run.status === 'running') {
        res.status(400).json({ error: 'Wait for this run to finish before rating it' });
        return;
      }
      const a = z
        .object({
          rating: z.number().int().min(1).max(5).nullable(),
          workId: id.optional(),
          timing: feedbackSchema.shape.timing.optional(),
          note: z.string().max(2000).optional(),
          task: taskType.optional(),
        })
        .parse(req.body);
      const work = a.workId
        ? run.work?.find((w) => w.id === a.workId)
        : run.work?.find((w) => !w.handoffId);
      if (
        (a.workId && !work) ||
        (work ? work.status !== 'completed' : run.status !== 'completed')
      ) {
        res.status(400).json({ error: 'Only completed bot work can be rated' });
        return;
      }
      const previous = work?.feedback ?? (!work ? run.feedback : undefined);
      const feedback =
        a.rating === null
          ? undefined
          : {
              rating: a.rating,
              timing: a.timing ?? previous?.timing ?? 'unspecified',
              note: a.note ?? previous?.note ?? '',
              updatedAt: new Date().toISOString(),
            };
      if (work) {
        work.feedback = feedback;
        if (a.task) work.task = a.task;
      }
      if (!work?.handoffId) {
        run.rating = a.rating ?? undefined;
        run.feedback = feedback;
        if (a.task) {
          run.task = a.task;
          run.taskSource = 'human';
        }
      }
      run.feedbackRevision = (run.feedbackRevision ?? 0) + 1;
      store.put('runs', run);
      store.writeExperienceReport();
      runtime.events.emit('activity', run);
      res.json(run);
    }),
  );
  app.post(
    '/api/bots',
    wrap((req, res) => {
      const bot = { ...botSchema.parse(req.body), id: randomUUID() };
      res.status(201).json(
        selectBotModel(
          store,
          bot.id,
          {
            providerId: bot.providerId,
            modelId: bot.modelId,
            reasoningEffort: bot.reasoningEffort,
          },
          bot,
        ),
      );
    }),
  );
  const botLifecycle =
    (action: 'archive' | 'restore' | 'delete'): express.RequestHandler =>
    (req, res, next) => {
      try {
        res.json(changeBotLifecycle(store, String(req.params.id), action));
      } catch (error) {
        if (error instanceof BotLifecycleError)
          res.status(error.status).json({ error: error.message });
        else next(error);
      }
    };
  app.post('/api/bots/:id/archive', botLifecycle('archive'));
  app.post('/api/bots/:id/restore', botLifecycle('restore'));
  app.delete('/api/bots/:id', botLifecycle('delete'));
  app.put(
    '/api/bots/:id',
    wrap((req, res) => {
      const old = store.get('bots', String(req.params.id));
      if (!old) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      if (old.archivedAt || old.deletedAt) {
        res.status(409).json({
          error: 'Restore an archived bot before editing it. Deleted bots cannot be edited.',
        });
        return;
      }
      if (old.prototypeId)
        throw Error(
          'Temporary workers keep their task identity. Edit the prototype for future workers.',
        );
      const updated = { ...old, ...botSchema.parse(req.body) };
      if (
        updated.modelId !== old.modelId ||
        updated.providerId !== old.providerId ||
        updated.reasoningEffort !== old.reasoningEffort
      ) {
        res.json(
          selectBotModel(
            store,
            updated.id,
            {
              providerId: updated.providerId,
              modelId: updated.modelId,
              reasoningEffort: updated.reasoningEffort,
            },
            updated,
          ),
        );
        return;
      }
      store.db.exec('BEGIN IMMEDIATE');
      try {
        store.put('bots', updated);
        if (store.settings().mainBotId === updated.id && !canBeMainBot(updated))
          store.setConfig('settings', { ...store.settings(), mainBotId: null });
        store.db.exec('COMMIT');
      } catch (error) {
        store.db.exec('ROLLBACK');
        throw error;
      }
      res.json(updated);
    }),
  );
  app.put(
    '/api/bots/:id/model',
    wrap((req, res) => {
      res.json(selectBotModel(store, String(req.params.id), req.body));
    }),
  );
  app.patch(
    '/api/bots/:id/category',
    wrap((req, res) => {
      const bot = store.get('bots', String(req.params.id));
      if (!bot || bot.prototypeId) {
        res
          .status(400)
          .json({ error: 'Move a permanent bot or its prototype, not a temporary clone.' });
        return;
      }
      const { categoryId } = z
        .object({ categoryId: z.string().nullable() })
        .strict()
        .parse(req.body);
      if (categoryId && !store.get('categories', categoryId)) {
        res.status(400).json({ error: 'Choose an existing category.' });
        return;
      }
      const updated = store.put('bots', { ...bot, categoryId: categoryId || undefined });
      for (const clone of store
        .all('bots')
        .filter((clone) => clone.prototypeId === bot.id && clone.cloneStatus === 'active'))
        store.put('bots', { ...clone, categoryId: updated.categoryId });
      res.json(updated);
    }),
  );
  app.post(
    '/api/providers',
    wrap((req, res) =>
      res
        .status(201)
        .json(store.put('providers', { ...providerSchema.parse(req.body), id: randomUUID() })),
    ),
  );
  app.put(
    '/api/providers/:id',
    wrap((req, res) => {
      const old = store.get('providers', String(req.params.id));
      if (!old) {
        res.status(404).json({ error: 'Provider not found' });
        return;
      }
      res.json(store.put('providers', { ...old, ...providerSchema.parse(req.body) }));
    }),
  );
  app.post(
    '/api/providers/:id/discover',
    wrap(async (req, res) => {
      const result = await discover(store, String(req.params.id));
      runtime.events.emit('models', {
        models: store.all('models'),
        providers: store.all('providers'),
      });
      res.json(result);
    }),
  );
  app.put(
    '/api/models/:id',
    wrap((req, res) => {
      const old = store.get('models', String(req.params.id));
      if (!old) {
        res.status(404).json({ error: 'Model not found' });
        return;
      }
      const changes = modelSchema.parse(req.body);
      const provider = store.get('providers', old.providerId);
      const enabled =
        old.modelType && old.modelType !== 'llm'
          ? false
          : changes.enablement === 'auto' && provider?.local && provider.autoEnableModels !== false
            ? true
            : changes.enabled;
      res.json(
        store.put(
          'models',
          provider?.kind === 'claude-code'
            ? withClaudeContext({
                ...old,
                ...changes,
                enabled,
                enablement:
                  changes.enablement ?? (enabled !== old.enabled ? 'manual' : old.enablement),
                contextSource:
                  changes.contextSource ??
                  (changes.contextTokens !== old.contextTokens ? 'manual' : old.contextSource),
              })
            : {
                ...old,
                ...changes,
                enabled,
                contextTokens:
                  changes.contextSource === 'server' && old.loadedContextTokens
                    ? old.loadedContextTokens
                    : changes.contextTokens,
                enablement:
                  changes.enablement ?? (enabled !== old.enabled ? 'manual' : old.enablement),
                contextSource:
                  changes.contextSource ??
                  (changes.contextTokens !== old.contextTokens ? 'manual' : old.contextSource),
              },
        ),
      );
    }),
  );
  app.post(
    '/api/models',
    wrap((req, res) => {
      const a = z.object({ providerId: id, name: id }).parse(req.body);
      const provider = store.get('providers', a.providerId);
      if (!provider) {
        res.status(404).json({ error: 'Provider not found' });
        return;
      }
      const model: Model = {
        id: `${a.providerId}::${a.name}`,
        providerId: a.providerId,
        name: a.name,
        enabled: false,
        enablement: 'manual',
        priority: 50,
        costPerMillion: 0,
        tasks: ['general'],
        contextTokens: 32768,
        status: 'unknown',
      };
      res
        .status(201)
        .json(
          store.put('models', provider.kind === 'claude-code' ? withClaudeContext(model) : model),
        );
    }),
  );
  app.put(
    '/api/settings/main-bot',
    wrap((req, res) => {
      const { botId } = z.object({ botId: mainBotSelection }).parse(req.body);
      const settings = { ...store.settings(), mainBotId: botId };
      store.setConfig('settings', settings);
      res.json(settings);
    }),
  );
  app.put(
    '/api/settings',
    wrap((req, res) => {
      const settings = settingsSchema.parse(req.body);
      settings.mainBotId = mainBotSelection.parse(
        settings.mainBotId === undefined
          ? (store.settings().mainBotId ?? null)
          : settings.mainBotId,
      );
      store.setConfig('settings', settings);
      computer.searchProvider = settings.webSearchProvider ?? 'google';
      computer.configureSessions(settings.maxBrowserSessions ?? 6);
      computer.changed();
      res.json(settings);
    }),
  );
  app.post(
    '/api/memory',
    wrap((req, res) =>
      res.status(201).json(
        store.put('memory', {
          ...z
            .object({
              botId: z.string().nullable(),
              category: z.enum(['profile', 'behavior', 'world', 'workstream']),
              content: z.string().min(1).max(30000),
            })
            .parse(req.body),
          id: randomUUID(),
          createdAt: new Date().toISOString(),
        }),
      ),
    ),
  );
  app.put(
    '/api/memory/:id',
    wrap((req, res) => {
      const m = store.get('memory', String(req.params.id));
      if (!m) {
        res.status(404).json({ error: 'Memory not found' });
        return;
      }
      res.json(
        store.put('memory', {
          ...m,
          ...z
            .object({ content: z.string().min(1).max(30000), pinned: z.boolean().optional() })
            .parse(req.body),
        }),
      );
    }),
  );
  app.delete('/api/memory/:id', (req, res) => {
    store.remove('memory', String(req.params.id));
    res.json({ ok: true });
  });
  app.post(
    '/api/skills',
    wrap((req, res) => {
      const input = skillInput.extend({ originBotId: id.optional() }).parse(req.body);
      const bot = input.originBotId ? store.get('bots', input.originBotId) : undefined;
      if (input.originBotId && (!bot || bot.deletedAt)) {
        res.status(400).json({ error: 'Choose an existing bot for the original association.' });
        return;
      }
      res.status(201).json(saveSkill(store, input, bot));
    }),
  );
  app.put(
    '/api/skills/:id',
    wrap((req, res) => {
      if (help.get(String(req.params.id))) {
        res.status(403).json({
          error: 'Built-in app help is maintained with Bot-Bots and cannot be edited here.',
        });
        return;
      }
      const old = store.get('skills', String(req.params.id));
      if (!old) {
        res.status(404).json({ error: 'Skill not found' });
        return;
      }
      const input = skillInput.partial().parse(req.body);
      res.json(
        saveSkill(
          store,
          { name: input.name ?? old.name, content: input.content ?? old.content },
          undefined,
          { id: old.id },
        ),
      );
    }),
  );
  app.delete(
    '/api/skills/:id',
    wrap((req, res) => {
      const skillId = String(req.params.id);
      if (help.get(skillId)) {
        res.status(403).json({
          error: 'Built-in app help is maintained with Bot-Bots and cannot be deleted here.',
        });
        return;
      }
      if (!store.get('skills', skillId)) {
        res.status(404).json({ error: 'Skill not found' });
        return;
      }
      z.object({ confirm: z.literal(true) }).parse(req.body);
      store.remove('skills', skillId);
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/routines',
    wrap((req, res) => {
      res.status(201).json(saveRoutine(store, req.body));
    }),
  );
  app.put(
    '/api/routines/:id',
    wrap((req, res) => {
      const old = store.get('routines', String(req.params.id));
      if (!old) {
        res.status(404).json({ error: 'Routine not found' });
        return;
      }
      res.json(saveRoutine(store, req.body, old.id));
    }),
  );
  app.post(
    '/api/routines/:id/run',
    wrap((req, res) => {
      const r = store.get('routines', String(req.params.id));
      if (!r) {
        res.status(404).json({ error: 'Routine not found' });
        return;
      }
      res
        .status(202)
        .json(
          runtime.create(
            r.botId,
            `Run routine: ${r.name}\n\n${r.prompt}`,
            undefined,
            {},
            undefined,
            'routine',
          ),
        );
    }),
  );
  app.delete('/api/routines/:id', (req, res) => {
    store.remove('routines', String(req.params.id));
    res.json({ ok: true });
  });
  app.get('/api/pages/:id/view', (req, res) => {
    const page = store.get('pages', String(req.params.id));
    if (!page) {
      res.status(404).send('Page not found');
      return;
    }
    res.setHeader(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'",
    );
    if (page.format === 'html') res.type('html').send(page.content);
    else res.type('text/plain').send(page.content);
  });
  app.get('/api/pages/:id', (req, res) => {
    const page = store.get('pages', String(req.params.id));
    if (!page) res.status(404).json({ error: 'File not found' });
    else res.json(page);
  });
  app.get('/api/pages/:id/download', (req, res) => {
    const page = store.get('pages', String(req.params.id));
    if (!page) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const filename = (page.filename ?? `${page.title}.${page.format === 'html' ? 'html' : 'txt'}`)
      .replace(/[^a-z0-9._-]/gi, '-')
      .slice(0, 150);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.type('application/octet-stream').send(page.content);
  });
  app.post(
    '/api/pages/:id/check',
    wrap(async (req, res) => {
      const page = store.get('pages', String(req.params.id));
      if (!page || page.format !== 'html') {
        res.status(400).json({ error: 'Select an HTML file.' });
        return;
      }
      if (!preview) {
        res.status(503).json({
          error:
            'Automated preview checks require the desktop host. You can still run the page in the Preview panel.',
        });
        return;
      }
      res.json(await preview.render(page.content));
    }),
  );
  app.get('/api/export', (_req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="bot-bots-backup.json"');
    res.json(store.export());
  });
  app.get('/api/experience/report', (_req, res) => {
    store.writeExperienceReport();
    res.setHeader('Content-Disposition', 'attachment; filename="model-experience.md"');
    res.type('text/markdown').sendFile(resolve(dirname(store.path), 'model-experience.md'));
  });
  app.get('/api/export/previous', (_req, res) => {
    const previous = store.config('preImportBackup');
    if (!previous) {
      res.status(404).json({ error: 'No previous import snapshot' });
      return;
    }
    res.setHeader('Content-Disposition', 'attachment; filename="bot-bots-before-import.json"');
    res.json(previous);
  });
  app.post(
    '/api/import',
    wrap((req, res) => {
      const timestamp = z.string().datetime();
      const raw = z
        .object({
          version: z.literal(1),
          settings: settingsSchema,
          bots: z.array(
            botSchema.extend({
              id,
              sourceFile: z.string().optional(),
              prototypeId: id.optional(),
              cloneTaskId: id.optional(),
              cloneStatus: z.enum(['active', 'retired']).optional(),
              archivedAt: timestamp.optional(),
              deletedAt: timestamp.optional(),
              archiveState: z.object({ enabled: z.boolean(), routineIds: z.array(id) }).optional(),
            }),
          ),
          categories: z.array(categorySchema).default([]),
          tasks: z.array(taskRecordSchema).default([]),
          compactions: z.array(compactionSchema).default([]),
          pluginActions: z.array(pluginActionSchema).default([]),
          apiDefinitions: z
            .array(
              serviceApiSchema.extend({
                botId: id,
                conversationId: id,
                skillRegistered: z.boolean().optional(),
              }),
            )
            .default([]),
          serviceActions: z
            .array(
              z.object({
                id,
                signature: z.string(),
                runId: id,
                botId: id,
                serviceId: id,
                operationId: z.string(),
                status: z.enum(['running', 'completed', 'failed']),
                startedAt: timestamp,
                result: z.unknown().optional(),
                error: z.string().optional(),
              }),
            )
            .default([]),
          credentialSetups: z.array(setupRecordSchema).max(10000).default([]),
          providers: z.array(providerSchema.safeExtend({ id })),
          models: z.array(
            modelSchema.extend({
              id,
              providerId: id,
              name: id,
              status: z.enum(['unknown', 'online', 'offline']),
              lastError: z.string().optional(),
              lastSeen: timestamp.optional(),
              loadState: z.enum(['loaded', 'unloaded', 'unknown']).optional(),
              loadedContextTokens: z.number().int().min(512).max(2000000).optional(),
              maxContextTokens: z.number().int().min(512).max(2000000).optional(),
              modelType: z.enum(['llm', 'embedding', 'other']).optional(),
              supportsTools: z.boolean().optional(),
              instanceId: id.optional(),
            }),
          ),
          conversations: z.array(
            z.object({
              id,
              spaceId: id.optional(),
              botId: id,
              title: z.string(),
              createdAt: timestamp,
              contextResetAt: timestamp.optional(),
            }),
          ),
          teamConversations: z
            .array(
              z.object({
                id,
                title: z.string().max(100),
                createdAt: timestamp,
                updatedAt: timestamp,
                legacy: z.boolean().optional(),
              }),
            )
            .default([]),
          messages: z.array(
            z.object({
              id,
              botId: id,
              conversationId: id,
              role: z.enum(['user', 'assistant', 'system']),
              deliveryId: id.optional(),
              senderBotId: id.optional(),
              content: z.string(),
              displayContent: z.string().max(1000).optional(),
              createdAt: timestamp,
              runId: id.optional(),
              modelId: id.optional(),
              workId: id.optional(),
              steeringId: id.optional(),
            }),
          ),
          deliveries: z
            .array(
              z.object({
                id,
                key: z.string().max(500),
                runId: id,
                parentId: id.optional(),
                fromBotId: id,
                toBotId: id,
                senderConversationId: id,
                conversationId: id,
                brief: z.string().max(18000),
                source: z.enum(['human', 'tool', 'legacy']),
                status: z.enum(['received', 'working', 'completed', 'failed', 'cancelled']),
                receivedAt: timestamp,
                startedAt: timestamp.optional(),
                finishedAt: timestamp.optional(),
                answer: z.string().optional(),
                error: z.string().optional(),
              }),
            )
            .default([]),
          memory: z.array(
            z.object({
              id,
              botId: id.nullable(),
              category: z.enum(['profile', 'behavior', 'world', 'workstream']),
              content: z.string(),
              createdAt: timestamp,
              pinned: z.boolean().optional(),
              runId: id.optional(),
              taskId: id.optional(),
              compacted: z.boolean().optional(),
            }),
          ),
          skills: z.array(skillRecord),
          routines: z.array(
            routineSchema.extend({
              id,
              source: z.string().optional(),
              lastRun: timestamp.optional(),
            }),
          ),
          runs: z.array(
            z.object({
              id,
              origin: z.enum(['chat', 'routine']).optional(),
              botId: id,
              conversationId: id,
              prompt: z.string(),
              task: z.enum(['general', 'research', 'coding', 'writing', 'planning']),
              status: z.enum(['running', 'completed', 'failed', 'cancelled']),
              startedAt: timestamp,
              finishedAt: timestamp.optional(),
              modelId: id.optional(),
              tokens: z.number().nonnegative(),
              events: z.array(
                z.object({
                  at: timestamp,
                  kind: z.enum([
                    'start',
                    'route',
                    'fallback',
                    'tool',
                    'handoff',
                    'complete',
                    'error',
                    'steer',
                    'draft',
                    'progress',
                  ]),
                  botId: id,
                  text: z.string(),
                  tool: z.string().optional(),
                  targetBotId: id.optional(),
                  phase: z
                    .enum(['preparing', 'thinking', 'responding', 'delegating', 'returned'])
                    .optional(),
                  task: z.enum(['general', 'research', 'coding', 'writing', 'planning']).optional(),
                  handoffId: id.optional(),
                  steeringId: id.optional(),
                  draftId: id.optional(),
                  handoff: z
                    .object({
                      conversationId: id.optional(),
                      receivedAt: timestamp.optional(),
                      id,
                      parentId: id.optional(),
                      fromBotId: id,
                      toBotId: id,
                      brief: z.string(),
                      status: z.enum(['working', 'completed', 'failed', 'cancelled']),
                      answer: z.string().optional(),
                      error: z.string().optional(),
                    })
                    .optional(),
                }),
              ),
              error: z.string().optional(),
              rating: z.number().min(1).max(5).optional(),
              feedback: feedbackSchema.optional(),
              feedbackRevision: z.number().int().nonnegative().optional(),
              urgency: urgency.optional(),
              importance: importance.optional(),
              taskSource: z.enum(['human', 'automatic']).optional(),
              work: z.array(workSchema).optional(),
              revision: z.number().int().nonnegative().optional(),
              steering: z
                .array(
                  z.object({
                    id,
                    messageId: id,
                    content: z.string().max(24000),
                    createdAt: timestamp,
                    appliedWorkIds: z.array(id),
                  }),
                )
                .optional(),
            }),
          ),
          pages: z.array(
            z.object({
              id,
              botId: id,
              title: z.string(),
              content: z.string(),
              format: z.enum(['markdown', 'html', 'code']),
              filename: z.string().max(200).optional(),
              language: z.string().max(50).optional(),
              runId: id.optional(),
              workspacePath: z.string().max(200).optional(),
              publication: z
                .object({
                  serviceId: id,
                  site: z.string(),
                  publicUrl: z.string().url(),
                  shortUrl: z.string().url().optional(),
                  contentHash: z.string(),
                  publishedAt: timestamp,
                })
                .optional(),
              createdAt: timestamp,
            }),
          ),
          drafts: z
            .array(
              z.object({
                id,
                runId: id,
                activeRunId: id,
                workId: id,
                botId: id,
                rootBotId: id,
                conversationId: id,
                filename: z.string().max(160),
                objective: z.string().max(10000).optional(),
                language: z.string().max(50),
                kind: z.enum(['file', 'reply', 'tool-payload']),
                status: z.enum(['writing', 'complete', 'partial', 'superseded']),
                content: z.string().max(250000),
                revision: z.number().int().nonnegative(),
                chunks: z.number().int().nonnegative(),
                createdAt: timestamp,
                updatedAt: timestamp,
                reason: z.string().optional(),
                pageId: id.optional(),
              }),
            )
            .default([]),
          terminal: z
            .array(
              z.object({
                id,
                command: z.string().max(12000),
                cwd: z.string(),
                reason: z.string(),
                source: z.enum(['bot', 'human']),
                botId: id.optional(),
                runId: id.optional(),
                status: z.enum([
                  'awaiting-approval',
                  'running',
                  'completed',
                  'failed',
                  'denied',
                  'cancelled',
                ]),
                createdAt: timestamp,
                approvedAt: timestamp.optional(),
                startedAt: timestamp.optional(),
                finishedAt: timestamp.optional(),
                output: z.string().max(150000),
                truncated: z.boolean().optional(),
                exitCode: z.number().int().optional(),
                error: z.string().optional(),
                timeoutMs: z.number().int().min(1000).max(300000),
              }),
            )
            .default([]),
          incidents: z.array(
            z.object({
              id,
              kind: z.literal('models-unavailable'),
              openedAt: timestamp,
              resolvedAt: timestamp.optional(),
              message: z.string(),
              deliveries: z.array(
                z.object({ channel: z.string(), status: z.string(), at: timestamp }),
              ),
            }),
          ),
        })
        .parse(req.body);
      if (
        runtime.controllers.size ||
        terminal.state().jobs.some((j) => ['running', 'awaiting-approval'].includes(j.status))
      )
        throw new Error('Wait for running bots before importing a backup');
      // Merge by stable ID, keep imported routines paused, and retain an automatic rollback snapshot.
      store.setConfig('preImportBackup', store.export());
      store.db.exec('BEGIN');
      try {
        for (const collection of [
          'bots',
          'providers',
          'models',
          'conversations',
          'teamConversations',
          'messages',
          'memory',
          'skills',
          'routines',
          'runs',
          'pages',
          'incidents',
          'terminal',
          'drafts',
          'categories',
          'tasks',
          'compactions',
          'pluginActions',
          'deliveries',
          'credentialSetups',
          'apiDefinitions',
          'serviceActions',
        ] as const) {
          for (const value of raw[collection]) {
            const v =
              collection === 'routines'
                ? { ...value, enabled: false, nextRun: undefined }
                : collection === 'runs' && (value as { status?: string }).status === 'running'
                  ? { ...value, status: 'failed', error: 'Interrupted before backup restore' }
                  : value;
            if (
              collection === 'credentialSetups' &&
              (v as import('../../packages/shared/credential-setup').CredentialSetup).status ===
                'awaiting-entry'
            ) {
              const request = v as import('../../packages/shared/credential-setup').CredentialSetup;
              request.status = 'cancelled';
              request.finishedAt = new Date().toISOString();
            }
            if (collection === 'serviceActions' && (v as { status: string }).status === 'running') {
              (v as { status: string; error?: string }).status = 'failed';
              (v as { error?: string }).error =
                'Restored history with an uncertain API result. Check the service before retrying; no action resumed automatically.';
            }
            if (collection === 'runs') {
              const restored = v as import('../../packages/shared/types').Run;
              if (restored.status !== 'running')
                for (const work of restored.work ?? []) {
                  if (work.status !== 'running') continue;
                  work.status = 'failed';
                  work.finishedAt = restored.finishedAt ?? new Date().toISOString();
                  for (const attempt of work.attempts)
                    if (attempt.status === 'running') {
                      attempt.status = 'failed';
                      attempt.finishedAt = work.finishedAt;
                      attempt.usageKnown = false;
                    }
                }
            }
            if (
              collection === 'deliveries' &&
              ['received', 'working'].includes(
                (v as import('../../packages/shared/delivery').BotDelivery).status,
              )
            ) {
              const delivery = v as import('../../packages/shared/delivery').BotDelivery;
              delivery.status = 'failed';
              delivery.finishedAt = new Date().toISOString();
              delivery.error =
                'Interrupted before backup restore. The request is retained; no action resumed automatically.';
            }
            if (
              collection === 'terminal' &&
              ['running', 'awaiting-approval'].includes(
                (v as import('../../packages/shared/terminal').TerminalJob).status,
              )
            ) {
              const job = v as import('../../packages/shared/terminal').TerminalJob;
              job.status = 'cancelled';
              job.finishedAt = new Date().toISOString();
              job.error = 'Restoring a backup never authorizes or resumes a command.';
            }
            if (
              collection === 'drafts' &&
              (v as import('../../packages/shared/drafts').Draft).status === 'writing'
            ) {
              const draft = v as import('../../packages/shared/drafts').Draft;
              draft.status = 'partial';
              draft.reason =
                'Restored draft. Use Continue to resume; no work restarted automatically.';
            }
            if (
              collection === 'bots' &&
              (v as import('../../packages/shared/types').Bot).prototypeId
            ) {
              const clone = v as import('../../packages/shared/types').Bot;
              clone.cloneStatus = 'retired';
              clone.enabled = false;
            }
            if (
              collection === 'tasks' &&
              (v as import('../../packages/shared/team').TaskRecord).status === 'running'
            )
              (v as import('../../packages/shared/team').TaskRecord).status = 'failed';
            if (
              collection === 'pluginActions' &&
              ['running', 'awaiting-approval'].includes(
                (v as import('../../packages/shared/plugins').PluginAction).status,
              )
            ) {
              const action = v as import('../../packages/shared/plugins').PluginAction;
              action.status = 'cancelled';
              action.error = 'Restored history. No approval was restored.';
            }
            store.put(collection, v as never);
          }
        }
        migrateClaudeContexts(store);
        for (const request of runtime.setups.list())
          if (request.status === 'awaiting-entry') runtime.setups.finish(request.id, 'cancelled');
        raw.settings.mainBotId = mainBot(store.all('bots'), raw.settings.mainBotId)?.id ?? null;
        store.setConfig('settings', raw.settings);
        computer.searchProvider = raw.settings.webSearchProvider ?? 'google';
        store.db.exec('COMMIT');
        computer.changed();
        teamConversations.migrate();
        try {
          store.writeExperienceReport();
        } catch (error) {
          console.error('Experience report could not be updated:', error);
        }
        res.json({ ok: true });
      } catch (error) {
        store.db.exec('ROLLBACK');
        throw error;
      }
    }),
  );
  app.use(
    express.static(webDir, {
      setHeaders(res) {
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http: https:; frame-src 'self' http: https:; object-src 'none'; base-uri 'self'",
        );
      },
    }),
  );
  app.use((req, res) => {
    if (req.path.startsWith('/api')) res.status(404).json({ error: 'API route not found' });
    else res.sendFile(join(webDir, 'index.html'));
  });
  app.use(
    (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (_req.path.startsWith('/api/credentials/manager')) {
        res.status(400).json({
          error: 'The credential request could not be read. Use the Keys & passwords window.',
        });
        return;
      }
      res.status(error instanceof z.ZodError ? 400 : 500).json({ error: error.message });
    },
  );
  return { app, runtime, alerts, computer, terminal, drafts, google, access, chatgpt, claude };
}
