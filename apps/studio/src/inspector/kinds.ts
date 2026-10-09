import type { CapturedEvent } from '@tokenfault/shared';

export type EventStyle = { readonly label: string; readonly color: string; readonly text: string };

/** Visual category of an event, used consistently in the timeline and lists. */
export function eventStyle(e: CapturedEvent): EventStyle {
  const i = e.interpretation;
  switch (i.kind) {
    case 'done':
      return { label: 'done', color: '#4ade80', text: 'text-ok' };
    case 'error':
      return { label: 'error', color: '#f87171', text: 'text-err' };
    case 'invalid-json':
      return { label: 'invalid', color: '#fb923c', text: 'text-orange' };
    case 'unrecognized':
      return { label: 'unknown', color: '#fbbf24', text: 'text-warn' };
    case 'chunk':
      if (i.toolCalls.length > 0) return { label: 'tool', color: '#c084fc', text: 'text-tool' };
      if (i.contentLength > 0) return { label: 'content', color: '#7c9cff', text: 'text-accent' };
      if (i.finishReasons.length > 0) return { label: 'finish', color: '#4ade80', text: 'text-ok' };
      return { label: 'meta', color: '#5d6573', text: 'text-faint' };
  }
}

export function eventSummary(e: CapturedEvent): string {
  const i = e.interpretation;
  switch (i.kind) {
    case 'done':
      return '[DONE]';
    case 'error':
      return `error: ${i.error?.message ?? ''}`;
    case 'invalid-json':
      return e.data ?? '(invalid JSON, payload not captured)';
    case 'unrecognized':
      return `unrecognized payload (${i.unknownKeys.join(', ') || 'no keys'})`;
    case 'chunk': {
      const parts: string[] = [];
      if (i.roles.length > 0) parts.push(`role=${i.roles.join(',')}`);
      if (i.content !== null && i.contentLength > 0) parts.push(JSON.stringify(i.content));
      else if (i.contentLength > 0) parts.push(`content (${i.contentLength} chars, not captured)`);
      for (const t of i.toolCalls) {
        parts.push(
          `tool[${t.index}]${t.name ? ` ${t.name}` : ''}${t.argumentsFragment !== null ? ` ${t.argumentsFragment}` : ` +${t.argumentsFragmentLength} chars`}`,
        );
      }
      for (const f of i.finishReasons) parts.push(`finish=${f.reason}`);
      if (i.usage)
        parts.push(
          `usage ${i.usage.promptTokens ?? '?'}/${i.usage.completionTokens ?? '?'}/${i.usage.totalTokens ?? '?'}`,
        );
      return parts.join('  ') || '(empty delta)';
    }
  }
}
