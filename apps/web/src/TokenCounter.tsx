import type { Message, Run, WorkRecord } from '../../../packages/shared/types';
import {
  estimateTextTokens,
  workTokenUsage,
  type TokenUsage,
} from '../../../packages/shared/token-usage';

export function TokenCounter({
  usage,
  live = false,
  question = false,
}: {
  usage: TokenUsage;
  live?: boolean;
  question?: boolean;
}) {
  const title = question
    ? 'Estimated tokens in this message. Model requests also include instructions, history and tools.'
    : `${usage.estimated ? 'Estimated during streaming; updated with reported usage when available.' : 'Provider-reported usage.'} Includes this bot’s model calls, tool rounds and context compaction for this response. Input may include cached context; output includes reasoning when reported. This is not a cost estimate.`;
  return (
    <small
      className={`token-counter ${live ? 'live' : ''}`}
      title={title}
      data-token-total={usage.total}
      data-token-output={usage.output}
      aria-label={question ? 'Message tokens' : live ? 'Live response tokens' : 'Response tokens'}
    >
      {live && <span className="token-pulse" aria-hidden="true" />}
      <span>
        {usage.estimated ? '~' : ''}
        {usage.total.toLocaleString()} tokens
      </span>
      {!question && (usage.input !== undefined || usage.output !== undefined) && (
        <span className="token-breakdown">
          {usage.input !== undefined ? `${usage.input.toLocaleString()} in` : ''}
          {usage.input !== undefined && usage.output !== undefined ? ' · ' : ''}
          {usage.output !== undefined ? `${usage.output.toLocaleString()} out` : ''}
        </span>
      )}
    </small>
  );
}
export function MessageTokens({ message, run }: { message: Message; run?: Run }) {
  const work = run?.work?.find((w) =>
    message.workId ? w.id === message.workId : w.botId === message.botId && !w.handoffId,
  );
  const usage = message.role === 'assistant' ? workTokenUsage(work) : undefined;
  if (message.role === 'system') return null;
  return (
    <TokenCounter
      question={message.role === 'user'}
      usage={usage ?? { total: estimateTextTokens(message.content), estimated: true }}
    />
  );
}
export function WorkingTokens({
  work,
  name,
  model,
}: {
  work: WorkRecord;
  name: string;
  model?: string;
}) {
  return (
    <div className="working-token-message" data-work-id={work.id}>
      <strong>
        {name}{' '}
        <span>
          ·{' '}
          {work.context?.status === 'compacting'
            ? 'Making room in context'
            : work.queued
              ? 'Waiting for model'
              : 'Processing'}
          {model ? ` · ${model}` : ''}
        </span>
      </strong>
      <TokenCounter
        live
        usage={workTokenUsage(work) ?? { total: 0, input: 0, output: 0, estimated: true }}
      />
    </div>
  );
}
