// services/box/src/socketGate.ts
//
// The sockets the box opens to its database, and the rules about when it
// opens one. Kept apart from the driver and the store so that each rule can be
// tested by itself, against a plain listener.
//
// The rules:
//   1. A socket is always handed out, never a failure: whatever goes wrong
//      reaches the caller as the socket's own error and close.
//   2. A connection that ends within a second of being tried is followed by a
//      pause, twice as long each time up to a longest. During a pause no
//      connection is opened.
//   3. A socket handed out during a pause, or after the gate was shut, is not
//      opened. It is closed a moment later, with an error, and it never starts
//      or lengthens a pause: only a connection that was really tried says
//      something about the database.
//   4. The pause is in place by the time the socket reports its error, not
//      only at its close.
//   5. A connection that does not open in time is closed with an error.
//   6. Shutting the gate closes every socket it handed out, for real, and it
//      opens no more.

import { Socket } from 'node:net';

/** The pause after a connection that did not last: the first, and the longest it grows to. */
export interface OpenPauses {
  firstMs: number;
  maxMs: number;
}

export const DEFAULT_PAUSES: OpenPauses = { firstMs: 100, maxMs: 2000 };

export interface SocketGate {
  /** A socket for one connection (rules 1 to 5). */
  open(): Socket;
  /** How much of a pause is left, in milliseconds. 0 when a connection may be opened. */
  pauseLeftMs(): number;
  /** Shuts the gate (rule 6). */
  shut(): void;
}

/**
 * What the gate takes from outside: the time, and a new unconnected socket. The defaults are the real
 * ones. Tests give their own, so that every rule about time is checked with a clock the test moves
 * and a socket the test drives, and nothing waits on the machine.
 */
export interface SocketGateDeps {
  now: () => number;
  newSocket: () => Socket;
}

const REAL_DEPS: SocketGateDeps = { now: () => performance.now(), newSocket: () => new Socket() };

/** A connection that ends sooner than this after it was tried "did not last". */
export const DID_NOT_LAST_MS = 1000;

/** An error as the store classifies it: by its code. */
function failure(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export function createSocketGate(
  target: { host: string; port: number },
  connectTimeoutMs: number,
  pauses: OpenPauses = DEFAULT_PAUSES,
  deps: SocketGateDeps = REAL_DEPS,
): SocketGate {
  const { now, newSocket } = deps;
  const sockets = new Set<Socket>();
  let isShut = false;
  let pauseMs = 0;
  let nextOpenAt = 0;

  return {
    open() {
      const socket = newSocket();
      sockets.add(socket);
      // When this socket began to connect, or null when it never did.
      let openedAt: number | null = null;
      let timer: NodeJS.Timeout | undefined = undefined;
      let over = false;
      // The end of this socket, heard once, at its error or its close, whichever comes first (rule 4).
      const ended = () => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        // Rule 3: a socket that was never opened says nothing about the database.
        if (isShut || openedAt === null) return;
        const at = now();
        pauseMs = at - openedAt < DID_NOT_LAST_MS ? Math.min(pauses.maxMs, Math.max(pauses.firstMs, pauseMs * 2)) : 0;
        nextOpenAt = at + pauseMs;
      };
      // An error always has a listener, whatever else listens or stops listening: an 'error' nobody
      // hears would end the process.
      socket.on('error', ended);
      socket.once('connect', () => clearTimeout(timer));
      socket.once('close', () => {
        sockets.delete(socket);
        ended();
      });

      if (isShut || now() < nextOpenAt) {
        // Rule 3. Closed a moment later, not now, so that whoever takes the socket can attach its
        // listeners first and hears the end; and with an error, because a close without one reads as
        // "try again at once".
        const reason = isShut ? failure('the connections were shut', 'CONNECTION_DESTROYED') : failure('the last connection did not last; not opening another yet', 'CONNECTION_PAUSED');
        setTimeout(() => socket.destroy(reason), 0);
        return socket;
      }

      openedAt = now();
      // Rule 5.
      timer = setTimeout(() => socket.destroy(failure('the connection did not open in time', 'CONNECT_TIMEOUT')), connectTimeoutMs);
      // What is written before the connection is open waits for it.
      socket.connect({ host: target.host, port: target.port });
      return socket;
    },

    pauseLeftMs() {
      return Math.max(0, nextOpenAt - now());
    },

    shut() {
      isShut = true;
      for (const socket of sockets) socket.destroy();
    },
  };
}
