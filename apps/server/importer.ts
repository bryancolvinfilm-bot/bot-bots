import { loadBackup, prepareImport, replaceExistingTeam, writeBackupTeam } from './backup-import';
import { migrateMemory } from './memory-import';
import { Store } from './store';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { seedStarterTeam } from './starter-team';

export function seed(
  store: Store,
  source?: string,
  options: { recoverInterruptedRuns?: boolean } = {},
) {
  if (!source || !existsSync(join(source, 'bots'))) {
    seedStarterTeam(store);
    migrateMemory(store);
    return;
  }
  const backup = loadBackup(source);
  if (store.config('initialized')) {
    replaceExistingTeam(store, source, backup, options.recoverInterruptedRuns);
    if (!store.config('qwenReasoningMigration')) {
      const qwen = store.get('models', 'lm-studio::qwen/qwen3.5-9b');
      if (qwen) store.put('models', { ...qwen, reasoningEffort: 'none' });
      store.setConfig('qwenReasoningMigration', true);
    }
    migrateMemory(store);
    return;
  }
  const imported = prepareImport(store, source, backup, false);
  const now = imported?.at ?? new Date().toISOString();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    writeBackupTeam(store, backup, now);
    store.put('providers', {
      id: 'lm-studio',
      name: 'LM Studio · This machine',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKeyEnv: '',
      enabled: true,
      local: true,
      timeoutMs: 180000,
    });
    store.put('models', {
      id: 'lm-studio::qwen/qwen3.5-9b',
      providerId: 'lm-studio',
      name: 'qwen/qwen3.5-9b',
      enabled: true,
      priority: 1,
      costPerMillion: 0,
      tasks: ['general', 'research', 'coding', 'writing', 'planning'],
      status: 'unknown',
      contextTokens: 32768,
      reasoningEffort: 'none',
    });
    const channel = { enabled: false, url: '', tokenEnv: '', destination: '' };
    store.setConfig('settings', {
      mainBotId: null,
      localOnly: true,
      defaultModelId: 'lm-studio::qwen/qwen3.5-9b',
      maxOutputTokens: 4096,
      maxToolSteps: 8,
      maxDelegationDepth: 2,
      alertEmail: { ...channel },
      alertSms: { ...channel },
      alertCooldownMinutes: 30,
    });
    store.setConfig('initialized', {
      at: now,
      source: imported?.revision ?? 'grok-bot-backup-2026-11-15',
    });
    if (imported) store.setConfig('teamImport', imported);
    store.setConfig('qwenReasoningMigration', true);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
