/**
 * Default resource limits.
 *
 * Every buffer TokenFault keeps has an explicit upper bound. These defaults are
 * sized for local debugging on a developer machine. All of them can be
 * overridden through package options and most through CLI flags.
 */
export const KiB = 1024;
export const MiB = 1024 * KiB;

export interface Limits {
  /** Maximum bytes buffered for a single SSE event before it is discarded as oversized. */
  readonly maxEventBytes: number;
  /** Maximum size of an incoming request body accepted by the proxy or mock server. */
  readonly maxRequestBodyBytes: number;
  /** Maximum number of sessions retained in memory (oldest evicted first). */
  readonly maxSessions: number;
  /** Maximum number of SSE events captured per session (later events are counted but not stored). */
  readonly maxEventsPerSession: number;
  /** Maximum number of raw network chunks captured per session. */
  readonly maxChunksPerSession: number;
  /** Maximum payload bytes retained per session (event data + chunk bytes). */
  readonly maxCapturedBytesPerSession: number;
  /** Maximum size of a recording file accepted for replay. */
  readonly maxRecordingBytes: number;
  /** Maximum bytes queued for a slow live-feed subscriber before it is disconnected. */
  readonly maxSubscriberBufferBytes: number;
  /** Maximum size of fault-selection request headers. */
  readonly maxFaultHeaderBytes: number;
}

export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxEventBytes: 1 * MiB,
  maxRequestBodyBytes: 20 * MiB,
  maxSessions: 200,
  maxEventsPerSession: 20_000,
  maxChunksPerSession: 50_000,
  maxCapturedBytesPerSession: 8 * MiB,
  maxRecordingBytes: 32 * MiB,
  maxSubscriberBufferBytes: 4 * MiB,
  maxFaultHeaderBytes: 4 * KiB,
});

/** Path prefix reserved for the TokenFault control plane and Studio. Never forwarded upstream. */
export const CONTROL_PREFIX = '/__tokenfault';
export const API_PREFIX = `${CONTROL_PREFIX}/api`;
export const STUDIO_PREFIX = `${CONTROL_PREFIX}/studio`;

/** Request header selecting a named fault scenario for a single request. Stripped before forwarding. */
export const SCENARIO_HEADER = 'x-tokenfault-scenario';
/** Request header carrying a JSON fault profile (`{"faults":[...],"seed":1}`) for a single request. Stripped before forwarding. */
export const FAULTS_HEADER = 'x-tokenfault-faults';
/** Prefix of all TokenFault-specific request headers; every such header is stripped before forwarding. */
export const HEADER_PREFIX = 'x-tokenfault-';
/** Response header carrying the TokenFault session id, so clients can correlate requests with Studio. */
export const SESSION_HEADER = 'x-tokenfault-session';

export const DEFAULT_PROXY_PORT = 8787;
export const DEFAULT_MOCK_PORT = 4010;
export const DEFAULT_REPLAY_PORT = 4020;
