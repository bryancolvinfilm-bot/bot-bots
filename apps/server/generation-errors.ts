export class ModelToolFormatError extends Error {}
export class ModelEmptyAnswerError extends Error {}
export class TaskLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskLimitError';
  }
}
