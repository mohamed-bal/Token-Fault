/**
 * SSE event serialisation, used by the mock server and event-level replay.
 */

export interface SseOutgoingEvent {
  readonly data: string;
  readonly event?: string;
  readonly id?: string;
  readonly retry?: number;
}

const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Serialises one event block terminated by a blank line. Multi-line data is
 * emitted as multiple `data:` lines, so a decoder reproduces `data` exactly
 * (except that CRLF/CR normalise to LF, which is inherent to SSE).
 *
 * @throws {TypeError} if `event` or `id` would break framing.
 */
export function serializeSseEvent(evt: SseOutgoingEvent): string {
  let out = '';
  if (evt.event !== undefined) {
    assertSingleLine('event', evt.event);
    out += `event: ${evt.event}\n`;
  }
  if (evt.id !== undefined) {
    assertSingleLine('id', evt.id);
    if (evt.id.includes('\u0000')) throw new TypeError('SSE id must not contain U+0000');
    out += `id: ${evt.id}\n`;
  }
  if (evt.retry !== undefined) {
    if (!Number.isSafeInteger(evt.retry) || evt.retry < 0) {
      throw new TypeError('SSE retry must be a non-negative integer');
    }
    out += `retry: ${evt.retry}\n`;
  }
  for (const line of evt.data.split(LINE_BREAK)) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** Serialises a comment line block (commonly used as keep-alive). */
export function serializeSseComment(text: string): string {
  return text
    .split(LINE_BREAK)
    .map((line) => `: ${line}\n`)
    .join('')
    .concat('\n');
}

function assertSingleLine(field: string, value: string): void {
  if (LINE_BREAK.test(value)) throw new TypeError(`SSE ${field} must not contain line breaks`);
}
