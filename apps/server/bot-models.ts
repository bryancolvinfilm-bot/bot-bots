import { z } from 'zod';
import { EFFORTS, effortOptions } from '../../packages/shared/model-effort';
import { Store } from './store';
import { canBeMainBot } from '../../packages/shared/main-bot';
import { runningChatModels } from '../../packages/shared/chat-models';

export const modelSelectionSchema = z
  .object({
    providerId: z.string().min(1).max(200).nullable().optional(),
    modelId: z.string().min(1).max(300).nullable().optional(),
    reasoningEffort: z.enum(EFFORTS).nullable().optional(),
  })
  .strict();

export function selectConversationModel(
  store: Store,
  conversationId: string,
  input: unknown,
  owner: boolean,
) {
  const conversation = store.get('conversations', conversationId);
  if (!conversation) throw Error('Conversation not found.');
  const patch = modelSelectionSchema.omit({ providerId: true }).parse(input);
  const modelId = patch.modelId === undefined ? conversation.modelId : patch.modelId;
  const model = modelId ? store.get('models', modelId) : undefined;
  if (modelId && !model) throw Error('Model not found.');
  const provider = model && store.get('providers', model.providerId);
  if (model && !runningChatModels([model], store.all('providers')).length)
    throw Error('That model is not currently running or connected. Refresh the model list.');
  if (!owner && model && (!model.enabled || (store.settings().localOnly && !provider?.local)))
    throw Error('The owner must enable this model connection first.');
  const effort =
    patch.reasoningEffort === undefined
      ? modelId === conversation.modelId
        ? conversation.reasoningEffort
        : null
      : patch.reasoningEffort;
  if (effort && (!model || !effortOptions(model, provider).includes(effort)))
    throw Error('Choose an effort level supported by this model.');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (owner && model && provider) {
      store.put('models', { ...model, enabled: true, enablement: 'manual' });
      if (!provider.local) store.setConfig('settings', { ...store.settings(), localOnly: false });
    }
    const saved = store.put('conversations', { ...conversation, modelId, reasoningEffort: effort });
    store.db.exec('COMMIT');
    return saved;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}

export function selectBotModel(
  store: Store,
  botId: string,
  input: unknown,
  profile?: import('../../packages/shared/types').Bot,
) {
  const bot = profile ?? store.get('bots', botId);
  if (!bot || bot.deletedAt || bot.archivedAt || bot.prototypeId)
    throw Error('Choose an available permanent bot.');
  const patch = modelSelectionSchema.parse(input);
  const serviceChanged = patch.providerId !== undefined && patch.providerId !== bot.providerId;
  const modelId =
    patch.modelId === undefined ? (serviceChanged ? null : bot.modelId) : patch.modelId;
  const model = modelId ? store.get('models', modelId) : undefined;
  if (modelId && !model) throw Error('Model not found.');
  const providerId =
    patch.providerId === undefined ? (model?.providerId ?? bot.providerId) : patch.providerId;
  const provider = providerId ? store.get('providers', providerId) : undefined;
  if (providerId && !provider) throw Error('Connect the service before choosing it.');
  if (model && providerId && model.providerId !== providerId)
    throw Error('Choose a model from the selected service.');
  const effort =
    patch.reasoningEffort === undefined
      ? serviceChanged || modelId !== bot.modelId
        ? null
        : bot.reasoningEffort
      : patch.reasoningEffort;
  if (effort && !model) throw Error('Choose a specific model before setting effort.');
  if (effort && model && !effortOptions(model, provider).includes(effort))
    throw Error('This model does not support that effort level.');
  const catalog = provider
    ? store
        .all('models')
        .filter((m) => m.providerId === provider.id && (!m.modelType || m.modelType === 'llm'))
    : [];
  if (provider && !catalog.length)
    throw Error('Connect this service and refresh its model list first.');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (provider) {
      store.put('providers', { ...provider, enabled: true });
      if (!provider.local) store.setConfig('settings', { ...store.settings(), localOnly: false });
      const chosen = model ?? catalog.find((m) => m.enabled) ?? catalog[0];
      if (chosen) store.put('models', { ...chosen, enabled: true, enablement: 'manual' });
    }
    const saved = store.put('bots', { ...bot, providerId, modelId, reasoningEffort: effort });
    if (store.settings().mainBotId === bot.id && !canBeMainBot(saved))
      store.setConfig('settings', { ...store.settings(), mainBotId: null });
    store.db.exec('COMMIT');
    return saved;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
