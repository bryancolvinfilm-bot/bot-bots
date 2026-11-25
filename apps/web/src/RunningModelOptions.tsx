import type { Model, Provider } from '../../../packages/shared/types';

/** The same available-model menu in chat, bot settings and team controls. */
export function RunningModelOptions({
  models,
  providers,
}: {
  models: Model[];
  providers: Provider[];
}) {
  const online = models.filter((model) => !providers.find((p) => p.id === model.providerId)?.local);
  const local = models.filter((model) => providers.find((p) => p.id === model.providerId)?.local);
  const option = (model: Model) => {
    const provider = providers.find((p) => p.id === model.providerId)!;
    const name =
      provider.kind === 'claude-code'
        ? 'Claude'
        : provider.kind === 'chatgpt'
          ? 'ChatGPT'
          : provider.name;
    return (
      <option key={model.id} value={model.id}>
        {name} · {model.name}
      </option>
    );
  };
  return (
    <>
      {!!online.length && (
        <optgroup label="Online · frontier models">{online.map(option)}</optgroup>
      )}
      {!!online.length && !!local.length && (
        <option disabled value="__separator__">
          ────────────────
        </option>
      )}
      {!!local.length && <optgroup label="Local · running models">{local.map(option)}</optgroup>}
    </>
  );
}
