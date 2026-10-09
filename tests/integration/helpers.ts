import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestUpstream {
  readonly url: string;
  readonly requests: {
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: string;
  }[];
  close(): Promise<void>;
}

/** Starts a scripted upstream HTTP server on an ephemeral loopback port. */
export async function startUpstream(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>,
): Promise<TestUpstream> {
  const requests: TestUpstream['requests'] = [];
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const body = Buffer.concat(parts).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      void Promise.resolve(handler(req, res, body)).catch(() => res.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const sseChunk = (content: string, finish: string | null = null): string =>
  `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;

/** Returns a free TCP port that nothing is listening on (best effort). */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
