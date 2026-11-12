import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createSocketGate, type SocketGate } from '../src/socketGate';

// The rules of socketGate.ts, each by itself, against plain listeners on 127.0.0.1. No database
// driver is involved, so nothing here depends on its timing.
//
// On time in these tests. A test must never ask "is a pause running?" and then act on the answer a
// moment later with a pause that could run out in between: a socket asked for at the instant a pause
// ends is rightly opened, and if the listener hangs up again the pause doubles. An earlier test did
// that with a 200 ms pause and failed once in many runs with exactly 200 + 400 ms. So: where a test
// needs a pause to hold, the pause is seconds long; where it needs a pause to be over, it waits past
// its end; and lengths are read at the moment they are set, not after a wait. Bounds are chosen so
// that the right outcome and each wrong one are far apart, whatever the machine is doing.

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
    const gate = gateTo(server.port, 500, { firstMs: 3000, maxMs: 20_000 });
    await endingOf(gate.open(), gate);
    expect(gate.pauseLeftMs()).toBeGreaterThan(2000);
    expect(gate.pauseLeftMs()).toBeLessThanOrEqual(3000);
    // Five sockets asked for during the pause, one after the other: none reaches the listener.
    for (let i = 0; i < 5; i++) {
      const ending = await endingOf(gate.open(), gate);
      expect(ending.connected).toBe(false);
      expect(ending.errorCode).toBe('CONNECTION_PAUSED');
    }
    expect(server.accepted).toBe(1);
    expect(gate.pauseLeftMs()).toBeGreaterThan(1000);
  });

  it('opens a connection again once the pause is over, and a second failure doubles it', async () => {
    const server = await listener((socket) => socket.destroy());
    const gate = gateTo(server.port, 500, { firstMs: 150, maxMs: 20_000 });
    const first = await endingOf(gate.open(), gate);
    expect(first.connected).toBe(true);
    // Well past the end of the 150 ms pause.
    await sleep(400);
    expect(gate.pauseLeftMs()).toBe(0);
    const second = await endingOf(gate.open(), gate);
    expect(second.connected).toBe(true);
    expect(server.accepted).toBe(2);
    // Hung up on again within a second: the pause that follows is the doubled one.
    expect(gate.pauseLeftMs()).toBeGreaterThan(150);
    expect(gate.pauseLeftMs()).toBeLessThanOrEqual(300);
  });

  it('doubles the pause each time and stops at the longest', async () => {
    const port = await closedPort();
    const gate = gateTo(port, 500, { firstMs: 40, maxMs: 160 });
    const lengths: number[] = [];
    for (let i = 0; i < 5; i++) {
      // The length is read inside the socket's own error event, the moment the pause is set, so no
      // wait of the machine's lies between setting and reading.
      const ending = await endingOf(gate.open(), gate);
      expect(ending.errorCode).toBe('ECONNREFUSED');
      lengths.push(ending.pauseLeftAtError!);
      // Well past the end of this pause before the next attempt.
      await sleep(ending.pauseLeftAtError! + 100);
      expect(gate.pauseLeftMs()).toBe(0);
    }
    const expected = [40, 80, 160, 160, 160];
    lengths.forEach((length, i) => {
      expect(length, `pause ${i + 1}`).toBeGreaterThan(expected[i]! - 2);
      expect(length, `pause ${i + 1}`).toBeLessThanOrEqual(expected[i]!);
    });
  });
});

describe('rule 3: a socket that was not opened', () => {
  it('is closed a moment later, with an error that says why, and is never connected', async () => {
    const server = await listener((socket) => socket.destroy());
    // A pause of ten seconds: "a moment later" is then far from "when the pause ends".
    const gate = gateTo(server.port, 500, { firstMs: 10_000, maxMs: 20_000 });
    await endingOf(gate.open(), gate);
    const unopened = await endingOf(gate.open(), gate, 5000);
    expect(unopened.closed).toBe(true);
    expect(unopened.afterMs).toBeLessThan(2000);
    expect(unopened.errorCode).toBe('CONNECTION_PAUSED');
    expect(unopened.connected).toBe(false);
    expect(server.accepted).toBe(1);
    // It did not end the pause either: the next one asked for is not opened as well.
    expect(gate.pauseLeftMs()).toBeGreaterThan(5000);
    expect((await endingOf(gate.open(), gate, 1000)).errorCode).toBe('CONNECTION_PAUSED');
    expect(server.accepted).toBe(1);
  });

  it('is still open when the function returns, so whoever takes it can attach listeners first', async () => {
    const server = await listener((socket) => socket.destroy());
    const gate = gateTo(server.port, 500, { firstMs: 10_000, maxMs: 20_000 });
    await endingOf(gate.open(), gate);
    const socket = gate.open();
    expect(socket.destroyed).toBe(false);
    expect((await endingOf(socket, gate)).closed).toBe(true);
  });

  it('neither starts nor lengthens the pause, however many are asked for', async () => {
    const server = await listener((socket) => socket.destroy());
    // A long pause, so that the machine being slow cannot make it run out during the test.
    const gate = gateTo(server.port, 500, { firstMs: 5000, maxMs: 20_000 });
    await endingOf(gate.open(), gate);
    // What is left of the pause only ever goes down, whatever is asked for meanwhile: a socket that
    // lengthened it would make it go up (to 10,000 and more), one that ended it would make it 0.
    let left = gate.pauseLeftMs();
    expect(left).toBeGreaterThan(4000);
    for (let i = 0; i < 10; i++) {
      await endingOf(gate.open(), gate);
      const now = gate.pauseLeftMs();
      expect(now).toBeLessThanOrEqual(left);
      expect(now).toBeGreaterThan(3000);
      left = now;
    }
    expect(server.accepted).toBe(1);
  });

  it('a socket asked for where no pause is running starts none by being handed out', async () => {
    const server = await listener((socket) => socket.resume());
    const gate = gateTo(server.port);
    const socket = gate.open();
    await new Promise((resolve) => socket.once('connect', resolve));
    expect(gate.pauseLeftMs()).toBe(0);
  });
});

describe('rule 4: the pause is in place when the socket reports its error', () => {
  it('for a refused connection', async () => {
    const gate = gateTo(await closedPort());
    const ending = await endingOf(gate.open(), gate);
    expect(ending.errorCode).toBe('ECONNREFUSED');
    // Read inside the error event itself: the whole first pause of 200 ms, give or take a millisecond.
    expect(ending.pauseLeftAtError).toBeGreaterThan(198);
    expect(ending.pauseLeftAtError).toBeLessThanOrEqual(200);
  });
});

describe('rule 5: a connection that does not open in time', () => {
  it('is closed with a timeout error after the time it was given, and starts a pause', async () => {
    // 192.0.2.1 is a documentation address: nothing answers, so the connection never opens.
    const gate = gateTo(5432, 150, { firstMs: 10_000, maxMs: 20_000 }, '192.0.2.1');
    const ending = await endingOf(gate.open(), gate, 8000);
    expect(ending.closed).toBe(true);
    // The error names who closed it: the gate's own timer, not the operating system (which would
    // take a minute and more) and not anything else.
    expect(ending.errorCode).toBe('CONNECT_TIMEOUT');
    expect(ending.afterMs).toBeGreaterThanOrEqual(140);
    expect(ending.afterMs).toBeLessThan(5000);
    expect(ending.pauseLeftAtError).toBeGreaterThan(9990);
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

  // The second half of this test is about Node, not about the gate: it shows the fact the gate's
  // comment relies on (destroying a socket that has already closed emits nothing), so that a change
  // in that fact would be noticed here.
  it('has its listener while the socket is open; and destroying a closed socket, stripped of every listener as the driver leaves it, emits nothing', async () => {
    const server = await listener((socket) => socket.resume());
    const gate = gateTo(server.port);
    const socket = gate.open();
    await new Promise((resolve) => socket.once('connect', resolve));
    // While it is open the gate listens for its errors.
    expect(socket.listenerCount('error')).toBe(1);
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.destroy();
    await closed;
    // What the driver does at every close: it removes every listener, the gate's too.
    socket.removeAllListeners();
    expect(socket.listenerCount('error')).toBe(0);
    // Everything the socket would emit from now on is recorded and not passed on.
    const emitted: string[] = [];
    socket.emit = ((event: string | symbol) => {
      emitted.push(String(event));
      return false;
    }) as typeof socket.emit;
    // A late destroy with an error, as the gate's zero timer may do after a close. (Shutting the gate
    // afterwards does not touch this socket: it left the gate's set when it closed.)
    socket.destroy(Object.assign(new Error('late'), { code: 'CONNECTION_DESTROYED' }));
    gate.shut();
    await sleep(100);
    expect(emitted).toEqual([]);
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
    // Thirty seconds to connect: only shutting can close this socket within the test.
    const gate = gateTo(5432, 30_000, { firstMs: 200, maxMs: 2000 }, '192.0.2.1');
    const socket = gate.open();
    const ending = endingOf(socket, gate, 10_000);
    await sleep(50);
    gate.shut();
    expect((await ending).closed).toBe(true);
    expect((await ending).afterMs).toBeLessThan(8000);
    expect(gate.pauseLeftMs()).toBe(0);
  });
});
