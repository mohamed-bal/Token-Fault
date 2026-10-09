export { SseDecoder, firstInvalidUtf8Index, utf8ByteLength } from './sse/decoder.js';
export type { SseDecoderOptions, SseDiagnostic, SseEvent, SseItem } from './sse/decoder.js';
export { SseFramer } from './sse/framer.js';
export type { SseFrame } from './sse/framer.js';
export { serializeSseComment, serializeSseEvent } from './sse/encoder.js';
export type { SseOutgoingEvent } from './sse/encoder.js';

export {
  ChatStreamAccumulator,
  DONE_MARKER,
  interpretChatEventData,
} from './openai/chat-stream.js';
export type {
  ChatAccumulatorOptions,
  ChatDiagnostic,
  ChatStreamItem,
  ChatStreamVerdict,
  ChoiceDelta,
  ParsedChatChunk,
  ToolCallDelta,
} from './openai/chat-stream.js';

export { computeGapStats } from './metrics/gaps.js';
export { StreamInspector } from './inspector/stream-inspector.js';
export type {
  InspectorLimits,
  InspectorSnapshot,
  InspectorUpdate,
  StreamInspectorOptions,
} from './inspector/stream-inspector.js';

export { sessionDetail, sessionSummary } from './inspector/session.js';
export type { SessionMeta } from './inspector/session.js';

export { base64ToBytes, bytesToBase64 } from './util/base64.js';

export {
  DISCONNECT_MODES,
  FaultProfileSchema,
  FaultSpecSchema,
  MALFORMED_KINDS,
  MOCK_ONLY_FAULTS,
  parseFaultProfile,
} from './faults/schema.js';
export type {
  DisconnectMode,
  FaultProfile,
  FaultProfileInput,
  FaultSpec,
  FaultSpecInput,
  FaultTargetKind,
  FaultType,
  MalformedKind,
  ParseResult,
} from './faults/schema.js';
export { FAULT_TYPES, SCENARIOS, findScenario } from './faults/catalog.js';
export type { Scenario } from './faults/catalog.js';
export { FaultPlanner, malformedFrame } from './faults/planner.js';
export type { FaultAction, FrameInfo, PreResponsePlan } from './faults/planner.js';
export { FrameClassifier } from './faults/classify.js';
export { executeFaultActions, sleep } from './faults/executor.js';
export type { ExecutionResult, FaultSink } from './faults/executor.js';
export { deriveSeed, mulberry32, randomInt } from './faults/rng.js';
export type { Rng } from './faults/rng.js';

export {
  MAX_RECORDED_ANNOTATIONS,
  MAX_RECORDED_CHUNKS,
  MAX_RECORDED_EVENTS,
  RECORDING_FORMAT,
  RECORDING_SCHEMA_VERSION,
  RecordingSchema,
} from './recording/schema.js';
export type { RecordedChunk, RecordedEvent, Recording } from './recording/schema.js';
export {
  createRecording,
  parseRecording,
  redactEventData,
  serializeRecording,
  validateRecording,
} from './recording/recording.js';
export type { CreateRecordingOptions, RecordingParseResult } from './recording/recording.js';
export { createReplayPlan, validateTiming } from './replay/plan.js';
export type { ReplayPlan, ReplayStep } from './replay/plan.js';
export { runReplay } from './replay/run.js';
export type { ReplaySink } from './replay/run.js';
