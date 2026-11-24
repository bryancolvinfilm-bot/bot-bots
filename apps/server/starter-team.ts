import { Store } from './store';

/** Fresh installations contain no imported profiles, conversations, or personal memory. */
export function seedStarterTeam(store: Store) {
  if (store.config('initialized')) return;
  const now = new Date().toISOString();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (!store.all('bots').length)
      store.put('bots', {
        id: 'boss-man',
        name: 'First Bot',
        title: 'Your first teammate',
        description: 'A general helper you can customize as you build your team.',
        instructions:
          'Help the user with their current task. Be clear about what you know and what you have actually done. Use available tools when needed. Ask for missing information when necessary. Follow the user’s instructions and the app’s permissions. When teammates exist, delegate appropriate work and report their actual results.',
        avatar: { shape: 'wedge', color: '#bfa5e5', accent: '#30342e' },
        modelId: null,
        enabled: true,
      });
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
    store.setConfig('initialized', { at: now, source: 'starter-v1' });
    store.setConfig('memoryImportV2', true);
    store.setConfig('qwenReasoningMigration', true);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
