import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createSocketGate, type SocketGate } from '../src/socketGate';

// The rules of socketGate.ts, each by itself, against plain listeners on 127.0.0.1. No database
// driver is involved, so nothing here depends on its timing.

const servers: Server[] = [];
const gates: SocketGate[] = [];
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.shut();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A listener; `onConnection` decides what becomes of each connection. Counts what it accepted. */
async function listener(onConnection: (socket: Socket, n: number) => void) {
  const state = { accepted: 0, port: 0 };
  const server = createServer((socket) => {
    state.accepted += 1;
    socket.on('error', () => {});
    onConnection(socket, state.accepted);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as { port: number }).port;
  return state;
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function gateTo(port: number, connectTimeoutMs = 500, pauses = { firstMs: 200, maxMs: 2000 }, host = '127.0.0.1'): SocketGate {
  const gate = createSocketGate({ host, port }, connectTimeoutMs, pauses);
  gates.push(gate);
  return gate;
}

interface Ending {
  connected: boolean;
  errorCode: string | null;
  closed: boolean;
  afterMs: number;
  /** How much pause was left at the moment the socket reported its error. */
  pauseLeftAtError: number | null;
}

/** Waits for a socket's end, or gives up after `ms` (then `closed` is false). */
function endingOf(socket: Socket, gate: SocketGate, ms = 1500): Promise<Ending> {
  const started = performance.now();
  const ending: Ending = { connected: false, errorCode: null, closed: false, afterMs: 0, pauseLeftAtError: null };
  return new Promise((resolve) => {
    const done = () => {
      ending.afterMs = performance.now() - started;
      resolve(ending);
    };
    const giveUp = setTimeout(done, ms);
    socket.once('connect', () => (ending.connected = true));
    // Attached after the gate's own listener, as the driver's is.
    socket.on('error', (error: { code?: string }) => {
      if (ending.errorCode === null) {
        ending.errorCode = error.code ?? 'no code';
        ending.pauseLeftAtError = gate.pauseLeftMs();
      }
    });
    socket.once('close', () => {
      ending.closed = true;
      clearTimeout(giveUp);
      done();
    });
  });
}

describe('rule 1 and 2: a connection that did not last is followed by a pause', () => {
  it('opens a connection to a listener that is well, and starts no pause when it closes after a second', async () => {
    const server = await listener((socket) => socket.resume());
    const gate = gateTo(server.port);
    const socket = gate.open();
    const ending = endingOf(socket, gate, 3000);
    await sleep(1100);
    expect(server.accepted).toBe(1);
    expect(gate.pauseLeftMs()).toBe(0);
    // Still open, long after the time it was given to connect: that timer ended when it connected.
    expect(socket.destroyed).toBe(false);
    socket.destroy();
    expect((await ending).connected).toBe(true);
    expect((await ending).errorCode).toBeNull();
    expect(gate.pauseLeftMs()).toBe(0);
  });

  it('starts a pause when the listener hangs up, and opens nothing during it', async () => {
    const server = await listener((socket) => socket.destroy());
    const gate = gateTo(server.port);
    await endingOf(gate.open(), gate);
    expect(gate.pauseLeftMs()).toBeGreaterThan(100);
    expect(gate.pauseLeftMs()).toBeLessThanOrEqual(200);
    // Five sockets asked for during the pause: none reaches the listener.
    const during = await Promise.all(Array.from({ length: 5 }, () => endingOf(gate.open(), gate)));
    expect(server.accepted).toBe(1);
    expect(during.every((ending) => !ending.connected)).toBe(true);
    // After the pause a connection is opened again.
    await sleep(250);
    expect(gate.pauseLeftMs()).toBe(0);
    await endingOf(gate.open(), gate);
    expect(server.accepted).toBe(2);
  });

  it('doubles the pause each time and stops at the longest', async () => {
    const port = await closedPort();
    const gate = gateTo(port, 500, { firstMs: 40, maxMs: 160 });
    const lengths: number[] = [];
    for (let i = 0; i < 5; i++) {
      await endingOf(gate.open(), gate);
      lengths.push(gate.pauseLeftMs());
      await sleep(gate.pauseLeftMs() + 5);
    }
    // 40, 80, 160, 160, 160 (a few milliseconds are gone by the time each is read).
    const expected = [40, 80, 160, 160, 160];
    lengths.forEach((length, i) => {
      expect(length, `pause ${i + 1}`).toBeGreaterThan(expected[i]! - 15);
      expect(length, `pause ${i + 1}`).toBeLessThanOrEqual(expected[i]!);
    });
  });
});

describe('rule 3: a socket that was not opened', () => {
  it('is closed a moment later, with an error that says why, and is never connected', async () => {
    const server = await listener((socket) => socket.destroy());
    const gate = gateTo(server.port);
    await endingOf(gate.open(), gate);
    const unopened = await endingOf(gate.open(), gate, 1000);
    expect(unopened.closed).toBe(true);
    expect(unopened.afterMs).toBeLessThan(100);
    expect(unopened.errorCode).toBe('CONNECTION_PAUSED');
    expect(unopened.connected).toBe(false);
    expect(server.accepted).toBe(1);
    // It did not end the pause either: the next one asked for is not opened as well.
    expect(gate.pauseLeftMs()).toBeGreaterThan(50);
    expect((await endingOf(gate.open(), gate, 1000)).errorCode).toBe('CONNECTION_PAUSED');
    expect(server.accepted).toBe(1);
  });

  it('is still open when the function returns, so whoever takes it can attach listeners first', async () => {
    const server = await listener((socket) => socket.destroy());
    const gate = gateTo(server.port);
    await endingOf(gate.open(), gate);
    const socket = gate.open();
    expect(socket.destroyed).toBe(false);
    expect((await endingOf(socket, gate)).closed).toBe(true);
  });

  it('neither starts nor lengthens the pause, however many are asked for', async () => {
    const server = await listener((socket) => socket.destroy());
    const gate = gateTo(server.port);
    await endingOf(gate.open(), gate);
    const started = performance.now();
    const left = gate.pauseLeftMs();
    // Sockets asked for all through the pause.
    while (gate.pauseLeftMs() > 0 && performance.now() - started < 1000) {
      await endingOf(gate.open(), gate);
    }
    // The pause ended when it was due: within its 200 ms, not pushed out by the sockets asked for.
    expect(performance.now() - started).toBeLessThan(left + 60);
    expect(gate.pauseLeftMs()).toBe(0);
    await endingOf(gate.open(), gate);
    expect(server.accepted).toBe(2);
  });
});

describe('rule 4: the pause is in place when the socket reports its error', () => {
  it('for a refused connection', async () => {
    const gate = gateTo(await closedPort());
    const ending = await endingOf(gate.open(), gate);
    expect(ending.errorCode).toBe('ECONNREFUSED');
    expect(ending.pauseLeftAtError).toBeGreaterThan(100);
  });
});

describe('rule 5: a connection that does not open in time', () => {
  it('is closed with a timeout error after the time it was given, and starts a pause', async () => {
    // 192.0.2.1 is a documentation address: nothing answers, so the connection never opens.
    const gate = gateTo(5432, 150, { firstMs: 200, maxMs: 2000 }, '192.0.2.1');
    const ending = await endingOf(gate.open(), gate, 3000);
    expect(ending.closed).toBe(true);
    expect(ending.errorCode).toBe('CONNECT_TIMEOUT');
    expect(ending.afterMs).toBeGreaterThanOrEqual(140);
    expect(ending.afterMs).toBeLessThan(600);
    expect(gate.pauseLeftMs()).toBeGreaterThan(0);
  });
});

describe('an error always has a listener', () => {
  it('a socket whose error nobody else listens to ends no process', async () => {
    // Port 0 cannot be connected to. Nothing but the gate listens to this socket's error.
    const gate = gateTo(0);
    const socket = gate.open();
    await new Promise((resolve) => socket.once('close', resolve));
    expect(socket.destroyed).toBe(true);
  });

  it('still has one after every other listener was removed, as the driver does at a close', async () => {
    const server = await listener((socket) => socket.resume());
    const gate = gateTo(server.port);
    const socket = gate.open();
    await new Promise((resolve) => socket.once('connect', resolve));
    expect(socket.listenerCount('error')).toBe(1);
  });
});

describe('rule 6: shutting the gate', () => {
  it('closes every open socket for real and opens no more, with an error that says so', async () => {
    const server = await listener((socket) => socket.resume());
    const gate = gateTo(server.port);
    const open = [gate.open(), gate.open()];
    await Promise.all(open.map((socket) => new Promise((resolve) => socket.once('connect', resolve))));
    await sleep(30);
    expect(server.accepted).toBe(2);
    gate.shut();
    await sleep(50);
    expect(open.every((socket) => socket.destroyed)).toBe(true);
    // Asked again after it was shut: a socket that is never connected.
    const after = await endingOf(gate.open(), gate, 1000);
    expect(after.closed).toBe(true);
    expect(after.errorCode).toBe('CONNECTION_DESTROYED');
    expect(after.connected).toBe(false);
    await sleep(100);
    expect(server.accepted).toBe(2);
    // And shutting starts no pause.
    expect(gate.pauseLeftMs()).toBe(0);
  });

  it('closes a socket that was still connecting', async () => {
    const gate = gateTo(5432, 5000, { firstMs: 200, maxMs: 2000 }, '192.0.2.1');
    const socket = gate.open();
    const ending = endingOf(socket, gate, 2000);
    await sleep(50);
    gate.shut();
    expect((await ending).closed).toBe(true);
    expect((await ending).afterMs).toBeLessThan(500);
    expect(gate.pauseLeftMs()).toBe(0);
  });
});
