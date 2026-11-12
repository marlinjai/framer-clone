import { connect, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { BOX_REFUSAL_POLICY } from '../../../src/lib/customCode/contract';
import type { BoxRequest, BoxResponse } from '../src/handler';
import { createBoxServer, type BoxLogLine, type BoxServerOptions } from '../src/server';

// The socket side, against a real server on 127.0.0.1 and raw sockets, so a
// request no client library would send can be sent.

let server: Server | null = null;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server!.close(resolve));
    server = null;
  }
});

async function start(handle: (request: BoxRequest) => Promise<BoxResponse>, options: Partial<BoxServerOptions> = {}) {
  const lines: BoxLogLine[] = [];
  server = createBoxServer({ handle, log: (line) => lines.push(line), ...options });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, lines };
}

const plain = async (request: BoxRequest): Promise<BoxResponse> => ({
  status: 200,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': BOX_REFUSAL_POLICY, 'Content-Length': '2' },
  body: Buffer.from('ok'),
  route: 'health',
  siteId: null,
  logPrefix: `seen:${request.method}`,
});

/** Writes raw bytes and collects what comes back until the server closes the socket or `ms` pass. */
function raw(port: number, chunks: string[], ms = 3000): Promise<{ data: string; closedByServer: boolean; after: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect(port, '127.0.0.1');
    let data = '';
    let done = false;
    const finish = (closedByServer: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ data, closedByServer, after: Date.now() - started });
    };
    const timer = setTimeout(() => finish(false), ms);
    socket.on('data', (chunk) => (data += chunk.toString('latin1')));
    socket.on('close', () => finish(true));
    socket.on('error', () => finish(true));
    socket.on('connect', () => {
      for (const chunk of chunks) socket.write(chunk);
    });
  });
}

describe('the server', () => {
  it('answers a request and writes one log line without a path, an address or a user agent', async () => {
    const { port, lines } = await start(plain);
    const response = await fetch(`http://127.0.0.1:${port}/box/secret-in-the-path?token=secret`, { headers: { 'user-agent': 'secret-agent', referer: 'https://secret.example/' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('server')).toBeNull();
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]!).sort()).toEqual(['ms', 'net', 'route', 'status', 't']);
    expect(JSON.stringify(lines)).not.toContain('secret');
    expect(JSON.stringify(lines)).not.toContain('127.0.0.1');
  });

  it('sends no body for HEAD', async () => {
    const { port } = await start(plain);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { method: 'HEAD' });
    expect(response.headers.get('content-length')).toBe('2');
    expect(await response.text()).toBe('');
  });

  it('answers 500 with the refusal policy and nothing of the fault when the handler throws', async () => {
    const { port, lines } = await start(async () => {
      throw new Error('password hunter2 at 10.0.0.5');
    });
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(500);
    expect(response.headers.get('content-security-policy')).toBe(BOX_REFUSAL_POLICY);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toBe('');
    expect(JSON.stringify(lines)).not.toContain('hunter2');
  });

  it('never reads a request body: answers, then closes the connection', async () => {
    let calls = 0;
    const { port } = await start(async (request) => {
      calls += 1;
      return plain(request);
    });
    const result = await raw(port, ['POST /health HTTP/1.1\r\nHost: x\r\nContent-Length: 100000000\r\n\r\n', 'x'.repeat(1000)]);
    expect(result.data).toMatch(/^HTTP\/1\.1 200 /);
    expect(result.data.toLowerCase()).toContain('connection: close');
    expect(result.closedByServer).toBe(true);
    expect(calls).toBe(1);
    const chunked = await raw(port, ['GET /health HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n', '5\r\nhello\r\n']);
    expect(chunked.closedByServer).toBe(true);
  });

  it('closes a connection whose headers do not arrive in time, without an answer', async () => {
    const { port } = await start(plain, { headersTimeoutMs: 300, requestTimeoutMs: 600 });
    const result = await raw(port, ['GET /health HTTP/1.1\r\nHost: x\r\nX-Slow: '], 5000);
    expect(result.closedByServer).toBe(true);
    expect(result.data).toBe('');
    expect(result.after).toBeLessThan(4000);
  });

  it('closes a connection whose headers are too large, without an answer', async () => {
    let calls = 0;
    const { port } = await start(async (request) => {
      calls += 1;
      return plain(request);
    });
    const result = await raw(port, [`GET /health HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(20_000)}\r\n\r\n`]);
    expect(result.closedByServer).toBe(true);
    expect(result.data).toBe('');
    const longTarget = await raw(port, [`GET /${'a'.repeat(20_000)} HTTP/1.1\r\nHost: x\r\n\r\n`]);
    expect(longTarget.closedByServer).toBe(true);
    expect(longTarget.data).toBe('');
    expect(calls).toBe(0);
  });

  it('closes a connection whose client asks for a large answer and never reads it', async () => {
    const big = Buffer.alloc(64 * 1024 * 1024, 0x61);
    const { port } = await start(
      async () => ({ status: 200, headers: { 'Content-Length': String(big.length) }, body: big, route: 'box', siteId: null, logPrefix: 'x' }),
      { socketTimeoutMs: 500 },
    );
    const received = await new Promise<number>((resolve) => {
      let bytes = 0;
      const socket = connect(port, '127.0.0.1');
      socket.on('data', (chunk) => (bytes += chunk.length));
      socket.on('connect', () => {
        // Ask, then stop reading: 64 megabytes fit in no buffer, so the answer cannot be delivered.
        socket.pause();
        socket.write('GET /x HTTP/1.1\r\nHost: x\r\n\r\n');
        // Reading again later shows what the server did meanwhile.
        setTimeout(() => socket.resume(), 3000);
      });
      const done = () => resolve(bytes);
      socket.on('close', done);
      socket.on('error', done);
      setTimeout(() => {
        socket.destroy();
        resolve(Number.POSITIVE_INFINITY);
      }, 15_000);
    });
    // The server gave up on it: only what was already in the buffers arrived. Without the timeout the
    // whole answer would arrive once the client reads again.
    expect(received).toBeLessThan(big.length);
    expect(server!.listening).toBe(true);
  }, 20_000);

  it('closes an idle connection after the socket timeout', async () => {
    const { port } = await start(plain, { socketTimeoutMs: 300 });
    const result = await raw(port, [], 5000);
    expect(result.closedByServer).toBe(true);
    expect(result.after).toBeLessThan(4000);
  });

  it('lets one peer hold a bounded number of connections, and frees a place when one closes', async () => {
    const { port } = await start(plain, { connectionKeyOf: () => 'one-peer', maxConnectionsPerKey: 2 });
    const open = (): Promise<{ socket: ReturnType<typeof connect>; closed: Promise<void> }> =>
      new Promise((resolve) => {
        const socket = connect(port, '127.0.0.1');
        const closed = new Promise<void>((done) => socket.on('close', () => done()));
        socket.on('error', () => {});
        socket.on('connect', () => resolve({ socket, closed }));
      });
    type Open = Awaited<ReturnType<typeof open>>;
    // Answered, or closed without an answer. The close may already have happened: the promise remembers it.
    const answered = (connection: Open) =>
      Promise.race([
        new Promise<boolean>((resolve) => {
          connection.socket.once('data', () => resolve(true));
          if (!connection.socket.destroyed) connection.socket.write('GET /health HTTP/1.1\r\nHost: x\r\n\r\n');
        }),
        connection.closed.then(() => false),
      ]);
    const first = await open();
    const second = await open();
    const third = await open();
    expect(await answered(first)).toBe(true);
    expect(await answered(second)).toBe(true);
    // The third is closed without an answer.
    expect(await answered(third)).toBe(false);
    first.socket.destroy();
    await first.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fourth = await open();
    expect(await answered(fourth)).toBe(true);
    second.socket.destroy();
    fourth.socket.destroy();
  });

  it('does not count a peer the key function exempts', async () => {
    const { port } = await start(plain, { connectionKeyOf: () => null, maxConnectionsPerKey: 1 });
    const results = await Promise.all([1, 2, 3].map(() => raw(port, ['GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'])));
    expect(results.every((result) => result.data.startsWith('HTTP/1.1 200 '))).toBe(true);
  });

  it('gives no answer of Node\'s own to an Expect header: the connection is closed and the handler not called', async () => {
    let calls = 0;
    const { port } = await start(async (request) => {
      calls += 1;
      return plain(request);
    });
    for (const expectation of ['something-else', '100-continue']) {
      const result = await raw(port, [`GET /health HTTP/1.1\r\nHost: x\r\nExpect: ${expectation}\r\n\r\n`]);
      expect(result.closedByServer).toBe(true);
      expect(result.data).toBe('');
    }
    expect(calls).toBe(0);
  });

  it('survives an answer that cannot be written', async () => {
    const { port } = await start(async (request) => ({ ...(await plain(request)), headers: { 'Bad Header\n': 'x' } }));
    const result = await raw(port, ['GET /health HTTP/1.1\r\nHost: x\r\n\r\n']);
    expect(result.closedByServer).toBe(true);
    expect(server!.listening).toBe(true);
  });

  it('closes a connection that does not speak HTTP, and one that asks for an upgrade', async () => {
    const { port } = await start(plain);
    const garbage = await raw(port, ['\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03 not http\r\n\r\n']);
    expect(garbage.closedByServer).toBe(true);
    expect(garbage.data).toBe('');
    const upgrade = await raw(port, ['GET /health HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n']);
    expect(upgrade.closedByServer).toBe(true);
    expect(upgrade.data).not.toContain('101');
    const tunnel = await raw(port, ['CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n']);
    expect(tunnel.closedByServer).toBe(true);
    expect(tunnel.data).toBe('');
  });
});
