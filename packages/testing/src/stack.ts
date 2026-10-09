/**
 * In-process TokenFault stacks for test suites.
 *
 * `startStack()` starts the mock LLM and a TokenFault proxy in front of it on
 * ephemeral loopback ports. Nothing leaves the machine.
 */
import { startMockLlm } from '@tokenfault/mock-llm';
import type { MockLlmOptions, RunningMockLlm } from '@tokenfault/mock-llm';
import { createTokenFaultServer } from '@tokenfault/proxy';
import type { TokenFaultServer, TokenFaultServerOptions } from '@tokenfault/proxy';
import type { SessionSummary } from '@tokenfault/shared';
import { ControlClient } from './control.js';

export interface RunningProxy {
  readonly url: string;
  readonly server: TokenFaultServer;
  readonly control: ControlClient;
  close(): Promise<void>;
}

export async function startProxy(
  options: Omit<TokenFaultServerOptions, 'host'>,
): Promise<RunningProxy> {
  const server = createTokenFaultServer({ port: 0, ...options, host: '127.0.0.1' });
  const url = await server.listen();
  return {
    url,
    server,
    control: new ControlClient(url, server.controlToken),
    close: () => server.close(),
  };
}

export interface Stack {
  readonly mock: RunningMockLlm;
  readonly proxy: RunningProxy;
  close(): Promise<void>;
}

export async function startStack(
  options: {
    readonly mock?: MockLlmOptions;
    readonly proxy?: Omit<TokenFaultServerOptions, 'host' | 'target'>;
  } = {},
): Promise<Stack> {
  const mock = await startMockLlm({ eventIntervalMs: 5, ...options.mock });
  try {
    const proxy = await startProxy({ ...options.proxy, target: mock.url });
    return {
      mock,
      proxy,
      async close() {
        await proxy.close();
        await mock.close();
      },
    };
  } catch (error) {
    await mock.close();
    throw error;
  }
}

/** Polls until a session matches `predicate` (e.g. has ended). */
export async function waitForSession(
  control: ControlClient,
  id: string,
  predicate: (s: SessionSummary) => boolean = (s) => s.termination !== null,
  timeoutMs = 10_000,
): Promise<SessionSummary> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sessions = await control.sessions();
    const match = sessions.find((s) => s.id === id);
    if (match && predicate(match)) return match;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for session ${id}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
