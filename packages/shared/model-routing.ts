import type { Assessment, Model, Provider, Settings, TaskType, Urgency } from './types';
export function classifyTask(text: string): TaskType {
  if (/\b(web_search|browser_open|web search|search the web|browse the web)\b/i.test(text))
    return 'research';
  if (
    /\b(code|typescript|javascript|html|css|build[^\r\n]{0,160}(app|page)|program|function|debug)\b/i.test(
      text,
    )
  )
    return 'coding';
  if (/\b(research|sources|investigate|find[^\r\n]{0,160}(events|jobs)|look up)\b/i.test(text))
    return 'research';
  if (/\b(write|draft|rewrite|summarize|summary)\b/i.test(text)) return 'writing';
  if (/\b(plan|schedule|compare|decide|organize)\b/i.test(text)) return 'planning';
  return 'general';
}
export function effectiveContext(model: Model) {
  return Math.min(model.contextTokens, model.loadedContextTokens ?? Infinity);
}
export function canUseTools(model: Model) {
  return (
    model.toolCalling === 'enabled' ||
    (model.toolCalling !== 'disabled' &&
      model.supportsTools !== false &&
      !model.toolFormatUnsupported)
  );
}
export function rankModels(
  models: Model[],
  providers: Provider[],
  settings: Settings,
  assessments: Assessment[],
  task: TaskType,
  preferred?: string | null,
  context: { botId?: string; urgency?: Urgency; providerId?: string | null } = {},
) {
  const eligible = models.filter(
    (m) =>
      m.enabled &&
      (!context.providerId || m.providerId === context.providerId) &&
      (!m.modelType || m.modelType === 'llm') &&
      providers.some(
        (p) =>
          p.id === m.providerId &&
          p.enabled &&
          (!settings.localOnly || (p.local && !['chatgpt', 'claude-code'].includes(p.kind))) &&
          (!(p.local && p.followLoadedModels !== false) || m.loadState !== 'unloaded'),
      ),
  );
  function experience(m: Model) {
    return (
      assessments.find(
        (a) => a.modelId === m.id && a.task === task && a.botId === context.botId && a.samples > 0,
      ) ?? assessments.find((a) => a.modelId === m.id && a.task === task && !a.botId)
    );
  }
  return eligible.sort((a, b) => {
    const x = experience(a),
      y = experience(b);
    const available = Number(a.status === 'offline') - Number(b.status === 'offline');
    const pinned = Number(b.id === preferred) - Number(a.id === preferred);
    const chosen =
      settings.modelSelection === 'manual'
        ? Number(b.id === settings.defaultModelId) - Number(a.id === settings.defaultModelId)
        : 0;
    const quality = (y?.samples ? y.average : 3) - (x?.samples ? x.average : 3);
    const fit = Number(!a.tasks.includes(task)) - Number(!b.tasks.includes(task));
    const speed =
      context.urgency && context.urgency !== 'relaxed'
        ? (x?.slowReports ?? 0) / Math.max(1, x?.samples ?? 0) -
            (y?.slowReports ?? 0) / Math.max(1, y?.samples ?? 0) ||
          (x &&
          y &&
          x.successes >= 3 &&
          y.successes >= 3 &&
          x.averageModelTimeMs !== undefined &&
          y.averageModelTimeMs !== undefined
            ? x.averageModelTimeMs - y.averageModelTimeMs
            : 0)
        : 0;
    return (
      available ||
      pinned ||
      chosen ||
      quality ||
      (context.urgency === 'urgent' ? speed || fit : fit || speed) ||
      a.costPerMillion - b.costPerMillion ||
      a.priority - b.priority ||
      Number(b.id === settings.defaultModelId) - Number(a.id === settings.defaultModelId)
    );
  });
}
