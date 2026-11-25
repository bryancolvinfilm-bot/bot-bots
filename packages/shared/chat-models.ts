import type { Model, Provider } from './types';

export function runningChatModels(models: Model[], providers: Provider[]) {
  return models
    .filter((model) => {
      const provider = providers.find((p) => p.id === model.providerId);
      return (
        !!provider?.enabled &&
        !provider.error &&
        model.status === 'online' &&
        (!model.modelType || model.modelType === 'llm') &&
        (!provider.local || model.loadState === 'loaded')
      );
    })
    .sort((a, b) => {
      const pa = providers.find((p) => p.id === a.providerId)!,
        pb = providers.find((p) => p.id === b.providerId)!;
      return (
        Number(pa.local) - Number(pb.local) ||
        pa.name.localeCompare(pb.name) ||
        a.name.localeCompare(b.name)
      );
    });
}

export function contextDescription(model: Model, provider?: Provider) {
  if (provider && !provider.local && model.contextSource !== 'manual')
    return 'Provider managed · no app context cap';
  const limit = Math.min(
    model.contextTokens,
    model.loadedContextTokens ?? Infinity,
    model.maxContextTokens ?? Infinity,
  );
  return `${limit.toLocaleString()} context tokens${model.contextSource === 'manual' ? ' · manual cap' : model.loadedContextTokens ? ' · loaded in server' : ''}`;
}
