import { SseDecoder } from '../sse/decoder.js';
import { interpretChatEventData } from '../openai/chat-stream.js';
import type { FrameInfo } from './planner.js';

/**
 * Classifies consecutive SSE frames (as produced by `SseFramer`) for the fault
 * planner. Uses one long-lived decoder, so decoder state carries across frames
 * exactly as it would in a client.
 */
export class FrameClassifier {
  private readonly decoder: SseDecoder;

  constructor(maxEventBytes?: number) {
    this.decoder = new SseDecoder(
      maxEventBytes === undefined
        ? { emitComments: false }
        : { maxEventBytes, emitComments: false },
    );
  }

  classify(bytes: Uint8Array): FrameInfo {
    let isEvent = false;
    let hasContent = false;
    for (const item of this.decoder.push(bytes)) {
      if (item.kind !== 'event') continue;
      isEvent = true;
      const interpreted = interpretChatEventData(item.event.data);
      if (interpreted.kind === 'chunk') {
        for (const choice of interpreted.chunk.choices) {
          if ((choice.content !== null && choice.content.length > 0) || choice.toolCalls.length > 0)
            hasContent = true;
        }
      }
    }
    return { bytes, isEvent, hasContent };
  }
}
