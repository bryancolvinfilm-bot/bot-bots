export class ModelToolFormatError extends Error {}
export class ModelEmptyAnswerError extends Error {}
export class ProviderContextError extends Error {
  constructor(public windowTokens?: number) {
    super('The provider reported a full context window.');
    this.name = 'ProviderContextError';
  }
}
export function providerContextError(text: string) {
  if (
    !/context.{0,60}(?:length|window|limit|exceed|overflow)|(?:prompt|input).{0,30}(?:too long|too large)|too many tokens|exceed.{0,40}(?:context|token)/i.test(
      text,
    )
  )
    return;
  const match = text.match(
    /(?:context (?:length|window)|maximum(?: context)?(?: length)?|limit)[^\d]{0,35}([\d,]{3,})/i,
  );
  const value = match ? Number(match[1].replaceAll(',', '')) : undefined;
  return new ProviderContextError(value && value >= 512 && value <= 2000000 ? value : undefined);
}
export class TaskLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskLimitError';
  }
}
export class ContextBudgetError extends TaskLimitError {
  constructor(
    message: string,
    public windowTokens: number,
  ) {
    super(message);
  }
}
