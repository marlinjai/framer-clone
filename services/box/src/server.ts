// services/box/src/server.ts
//
// The socket side of the box: plain `node:http`, no framework. It reads no
// request body, ever, and gives a slow or oversized request no time and no
// room. Everything about what to answer is in handler.ts.

import { createServer, type Server } from 'node:http';
import { boxRefusalHeaders } from '../../../src/lib/customCode/contract';
import type { BoxRequest, BoxResponse } from './handler';

export interface BoxLogLine {
  t: string;
  status: number;
  route: string;
  /** Present only for a well-formed pair. An invalid path is never logged: a path can carry data. */
  site?: string;
  ms: number;
  /** A network prefix, never a whole address. No user agent, no referrer, no origin. */
  net: string;
}

export interface BoxServerOptions {
  handle: (request: BoxRequest) => Promise<BoxResponse>;
  log: (line: BoxLogLine) => void;
  /**
   * What a new connection is counted by, or null for a peer that is not counted (a configured proxy,
   * through which every visitor comes). Unset: connections are not counted per peer.
   */
  connectionKeyOf?: (remoteAddress: string | undefined) => string | null;
  /** Connections one counted peer may hold at once. */
  maxConnectionsPerKey?: number;
  /** Requests one connection may have sent and not yet been answered. */
  maxUnansweredPerSocket?: number;
  /** Overrides for tests. */
  maxRequestsPerSocket?: number;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  socketTimeoutMs?: number;
}

export function createBoxServer(options: BoxServerOptions): Server {
  const { handle, log } = options;
  const unanswered = new WeakMap<object, number>();
  const maxUnanswered = options.maxUnansweredPerSocket ?? 4;
  const server = createServer(
    {
      // Request line and headers together. A frame request is far below this.
      maxHeaderSize: 8 * 1024,
      headersTimeout: options.headersTimeoutMs ?? 5000,
      requestTimeout: options.requestTimeoutMs ?? 10_000,
      keepAliveTimeout: 5000,
      connectionsCheckingInterval: 1000,
      // Node would answer a request without `Host` by itself, with no policy and no log line. The box
      // does not use the header, so the handler answers it like any other request.
      requireHostHeader: false,
    },
    (req, res) => {
      const started = performance.now();
      // Requests one connection has sent and not yet been answered. A client that sends many at once
      // and does not read the answers would otherwise have them all worked on and held in memory.
      const socket = req.socket;
      const waiting = (unanswered.get(socket) ?? 0) + 1;
      if (waiting > maxUnanswered) {
        socket.destroy();
        return;
      }
      unanswered.set(socket, waiting);
      res.once('close', () => unanswered.set(socket, Math.max(0, (unanswered.get(socket) ?? 1) - 1)));
      // A request that brings a body is answered and then cut off, unread.
      const bringsBody =
        req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');

      const send = (response: BoxResponse) => {
        const headers: Record<string, string> = { ...response.headers };
        if (bringsBody) headers.Connection = 'close';
        try {
          res.writeHead(response.status, headers);
          res.end(req.method === 'HEAD' ? undefined : response.body);
        } catch {
          // An answer that cannot be written ends this connection, never the process.
          req.socket.destroy();
        }
        if (bringsBody) res.once('finish', () => req.socket.destroy());
        const line: BoxLogLine = {
          t: new Date().toISOString(),
          status: response.status,
          route: response.route,
          ms: Math.round(performance.now() - started),
          net: response.logPrefix,
        };
        if (response.siteId) line.site = response.siteId;
        log(line);
      };

      handle({ method: req.method, url: req.url, headers: req.headers, remoteAddress: req.socket.remoteAddress }).then(send, () => {
        // Nothing of the failure goes to the client, and nothing of the request to the log.
        send({
          status: 500,
          headers: { ...boxRefusalHeaders(), 'Content-Length': '0' },
          body: Buffer.alloc(0),
          route: 'other',
          siteId: null,
          logPrefix: 'unknown',
        });
      });
    },
  );

  server.maxConnections = 1024;
  server.maxRequestsPerSocket = options.maxRequestsPerSocket ?? 1000;
  // A connection on which nothing moves for this long is closed, in either direction: a client that asks
  // for a document and never reads it does not keep its place.
  server.setTimeout(options.socketTimeoutMs ?? 15_000);

  // One peer holds a bounded share of the connections.
  const keyOf = options.connectionKeyOf;
  if (keyOf) {
    const cap = options.maxConnectionsPerKey ?? 64;
    const held = new Map<string, number>();
    server.on('connection', (socket) => {
      const key = keyOf(socket.remoteAddress);
      if (key === null) return;
      const count = held.get(key) ?? 0;
      if (count >= cap) {
        socket.destroy();
        return;
      }
      held.set(key, count + 1);
      socket.once('close', () => {
        const left = (held.get(key) ?? 1) - 1;
        if (left <= 0) held.delete(key);
        else held.set(key, left);
      });
    });
  }

  // Node would answer these three by itself, with no policy and no log line. The box closes them instead:
  // an `Expect` header (a frame request never sends one) and a request past the limit of one connection.
  server.on('checkContinue', (req) => {
    req.socket.destroy();
  });
  server.on('checkExpectation', (req) => {
    req.socket.destroy();
  });
  server.on('dropRequest', (_req, socket) => {
    socket.destroy();
  });
  // A request that is not HTTP, is too large or too slow gets no answer at all: the socket is closed.
  server.on('clientError', (_error, socket) => {
    socket.destroy();
  });
  // No protocol upgrade: a WebSocket or any other `Upgrade` request is closed.
  server.on('upgrade', (_req, socket) => {
    socket.destroy();
  });
  server.on('connect', (_req, socket) => {
    socket.destroy();
  });
  return server;
}
