/** Correct an unsafe setup instruction before it becomes a saved bot reply. Values never belong in chat. */
export function safeCredentialAdvice(answer: string, pageId?: string) {
  const unsafe = (block: string) =>
    block
      .replace(/```[\s\S]*?```/g, '')
      .split('\n')
      .some((line) => {
        if (/\b(?:never|do not|don't)\b/i.test(line)) return false;
        if (
          /masked|private (?:window|form)|credential window|Keys\s*&\s*passwords/i.test(line) &&
          !/into (?:this )?chat/i.test(line)
        )
          return false;
        return (
          /\b(?:provide|paste|send|share|give me)\b.{0,65}\b(?:api[_ ]?(?:key|token)|token value|password)\b/i.test(
            line,
          ) ||
          /\b(?:approve|permission)\b.{0,80}\b(?:read|print|extract|expose)\b.{0,50}\b(?:secret|token|credential|environment|env|api.?key)\b/i.test(
            line,
          )
        );
      });
  const blocks = answer.split(/\n\s*\n/);
  if (!blocks.some(unsafe)) return answer;
  return `${blocks.filter((block) => !unsafe(block)).join('\n\n')}\n\nEnter service credentials only in Settings & connections → Add key or password, then choose the allowed service and bots. Keep secret values out of chat and terminal commands.${pageId ? ` Your saved local page is available now: [View page](/api/pages/${pageId}/view). Public hosting is a separate authenticated step.` : ''}`.trim();
}
