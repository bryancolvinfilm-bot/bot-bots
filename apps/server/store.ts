import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assessRuns, durationLabel } from '../../packages/shared/experience';
import { DatabaseSync } from 'node:sqlite';
import type { TerminalJob } from '../../packages/shared/terminal';
import type { Draft } from '../../packages/shared/drafts';
import type { BotDelivery } from '../../packages/shared/delivery';
import type { BotCategory, TaskRecord, CompactionRecord } from '../../packages/shared/team';
import type { PluginAction } from '../../packages/shared/plugins';
import type {
  Assessment,
  Bot,
  Conversation,
  Incident,
  Memory,
  Message,
  Model,
  Page,
  Provider,
  Routine,
  Run,
  Settings,
  Skill,
} from '../../packages/shared/types';

interface Tables {
  contextCheckpoints: import('../../packages/shared/context').ContextCheckpoint;
  teamConversations: import('../../packages/shared/types').TeamConversation;
  apiDefinitions: import('../../packages/shared/service-api').ServiceApi & {
    botId: string;
    conversationId: string;
    skillRegistered?: boolean;
  };
  serviceActions: {
    id: string;
    signature: string;
    runId: string;
    botId: string;
    serviceId: string;
    operationId: string;
    status: 'running' | 'completed' | 'failed';
    startedAt: string;
    result?: unknown;
    error?: string;
  };
  credentialSetups: import('../../packages/shared/credential-setup').CredentialSetup;
  deliveries: BotDelivery;
  pluginActions: PluginAction;
  categories: BotCategory;
  tasks: TaskRecord;
  compactions: CompactionRecord;
  bots: Bot;
  providers: Provider;
  models: Model;
  conversations: Conversation;
  messages: Message;
  memory: Memory;
  skills: Skill;
  routines: Routine;
  runs: Run;
  pages: Page;
  incidents: Incident;
  terminal: TerminalJob;
  drafts: Draft;
}
export class Store {
  db: DatabaseSync;
  constructor(public path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(collection,id)); CREATE TABLE IF NOT EXISTS config (id TEXT PRIMARY KEY, data TEXT NOT NULL);',
    );
  }
  all<K extends keyof Tables>(collection: K): Tables[K][] {
    return this.db
      .prepare('SELECT data FROM documents WHERE collection=? ORDER BY rowid')
      .all(collection)
      .map((r) => JSON.parse(String(r.data)));
  }
  get<K extends keyof Tables>(collection: K, id: string): Tables[K] | undefined {
    const row = this.db
      .prepare('SELECT data FROM documents WHERE collection=? AND id=?')
      .get(collection, id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  put<K extends keyof Tables>(collection: K, value: Tables[K]): Tables[K] {
    this.db
      .prepare(
        'INSERT INTO documents(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data',
      )
      .run(collection, value.id, JSON.stringify(value));
    return value;
  }
  remove(collection: keyof Tables, id: string) {
    this.db.prepare('DELETE FROM documents WHERE collection=? AND id=?').run(collection, id);
  }
  config<T>(id: string): T | undefined {
    const r = this.db.prepare('SELECT data FROM config WHERE id=?').get(id);
    return r ? JSON.parse(String(r.data)) : undefined;
  }
  setConfig(id: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO config(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(id, JSON.stringify(value));
  }
  settings(): Settings {
    return this.config<Settings>('settings')!;
  }
  assessments(): Assessment[] {
    return assessRuns(this.all('runs'));
  }
  writeExperienceReport() {
    const cell = (v: unknown) =>
      String(v ?? '')
        .replace(/\|/g, '\\|')
        .replace(/[\r\n]+/g, ' ')
        .replace(/</g, '&lt;');
    const bots = this.all('bots'),
      models = this.all('models');
    const lines = [
      '# Bot and model experience',
      '',
      `Updated: ${new Date().toISOString()}`,
      '',
      'Generated from SQLite. Change ratings in the app; editing this report does not change routing.',
      '',
      'Human quality ratings take priority over speed and cost. Unrated means unknown, not bad. Bot-specific ratings take precedence over general model ratings. Explicit model pins and model availability are respected. Relaxed work has no speed penalty. Urgency is chosen by the human and is inherited by delegates. High importance asks bots to check their work carefully; it is independent of urgency.',
      '',
      'Elapsed time includes tools and delegation. Model time excludes teammates and tools. Token averages use provider-reported usage from the delivering model; unavailable usage is not treated as zero. Historical aggregate token counts are not attributed to individual models.',
      '',
      '| Bot / scope | Model | Task | Human stars | Votes | Completed | Failed attempts | Avg elapsed | Avg model time | Avg tokens | Too slow | Worth the wait |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const a of this.assessments())
      lines.push(
        `| ${[
          a.botId ? (bots.find((b) => b.id === a.botId)?.name ?? a.botId) : 'All bots',
          models.find((m) => m.id === a.modelId)?.name ?? a.modelId,
          a.task,
          a.samples ? a.average.toFixed(2) : 'Unrated',
          a.samples,
          a.successes,
          a.failures,
          durationLabel(a.averageDurationMs),
          durationLabel(a.averageModelTimeMs),
          a.averageTokens === undefined ? 'Not reported' : Math.round(a.averageTokens),
          a.slowReports ?? 0,
          a.worthTheWait ?? 0,
        ]
          .map(cell)
          .join(' | ')} |`,
      );
    lines.push(
      '',
      '## Human feedback',
      '',
      '| Date | Bot | Task | Model | Stars | Urgency | Importance | Timing | Note |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const run of this.all('runs'))
      for (const w of run.work ?? [])
        if (w.feedback)
          lines.push(
            `| ${[
              w.feedback.updatedAt,
              bots.find((b) => b.id === w.botId)?.name ?? w.botId,
              w.task,
              models.find((m) => m.id === w.modelId)?.name ?? w.modelId,
              w.feedback.rating,
              w.urgency,
              w.importance,
              w.feedback.timing,
              w.feedback.note,
            ]
              .map(cell)
              .join(' | ')} |`,
          );
    const target = join(dirname(this.path), 'model-experience.md');
    writeFileSync(`${target}.tmp`, lines.join('\n') + '\n', 'utf8');
    renameSync(`${target}.tmp`, target);
  }
  export() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: this.settings(),
      ...(Object.fromEntries(
        [
          'bots',
          'providers',
          'models',
          'contextCheckpoints',
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
        ].map((k) => [k, this.all(k as keyof Tables)]),
      ) as { [K in keyof Tables]: Tables[K][] }),
    };
  }
  close() {
    this.db.close();
  }
}
