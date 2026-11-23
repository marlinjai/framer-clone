import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSocketGate, DID_NOT_LAST_MS, type SocketGate } from '../src/socketGate';

// The rules of socketGate.ts about time, with a clock the test moves and sockets the test drives.
// Nothing here waits on the machine: there is no network, no real timer and no real clock, so every
// length is asserted exactly and every boundary is stood on, not near.
//
// (The same rules against real sockets and real listeners, with no tight timing, are in
// socketGate.real.test.ts.)

/** A socket the test drives: it records what the gate does to it and emits what the test tells it to. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  connectCalls: unknown[] = [];
  destroyedWith: { code?: string } | undefined | null = null;

  connect(options: unknown): this {
    this.connectCalls.push(options);
    return this;
  }

  destroy(error?: { code?: string }): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.destroyedWith = error;
    if (error) this.emit('error', error);
    this.emit('close');
    return this;
  }

  /** The connection is open. */
  opens(): void {
    this.emit('connect');
  }

  /** The other side refuses or resets: an error, then the close. */
  failsWith(code: string): void {
    this.destroyed = true;
    this.emit('error', Object.assign(new Error(code), { code }));
    this.emit('close');
  }

  /** The other side hangs up without an error. */
  hangsUp(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

let clock = 0;
let made: FakeSocket[] = [];
let gate: SocketGate;

/** Moves the clock and the timers together. */
function pass(ms: number): void {
  clock += ms;
  vi.advanceTimersByTime(ms);
}

function newGate(connectTimeoutMs = 2000, pauses = { firstMs: 200, maxMs: 2000 }): SocketGate {
  gate = createSocketGate({ host: 'db.internal', port: 5432 }, connectTimeoutMs, pauses, {
    now: () => clock,
    newSocket: () => {
      const socket = new FakeSocket();
      made.push(socket);
      return socket as unknown as Socket;
    },
  });
  return gate;
}

/** Asks the gate for a socket and returns the fake behind it. */
function open(): FakeSocket {
  gate.open();
  return made[made.length - 1]!;
}

/** A connection that is tried, opens, and is hung up on `afterMs` later. */
function shortLived(afterMs = 10): FakeSocket {
  const socket = open();
  socket.opens();
  pass(afterMs);
  socket.hangsUp();
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  clock = 1_000_000;
  made = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('rule 1: a socket is always handed out, and opened to the one host', () => {
  it('connects the socket to the host and port it was given, once', () => {
    newGate();
    const socket = open();
    expect(socket.connectCalls).toEqual([{ host: 'db.internal', port: 5432 }]);
    expect(socket.destroyed).toBe(false);
    expect(gate.pauseLeftMs()).toBe(0);
  });
});

describe('rule 2: a connection that did not last is followed by a pause', () => {
  it('starts the first pause, of exactly its first length, when a connection is hung up on', () => {
    newGate();
    shortLived(10);
    expect(gate.pauseLeftMs()).toBe(200);
    pass(199);
    expect(gate.pauseLeftMs()).toBe(1);
    pass(1);
    expect(gate.pauseLeftMs()).toBe(0);
  });

  it('starts it for a refused connection too', () => {
    newGate();
    open().failsWith('ECONNREFUSED');
    expect(gate.pauseLeftMs()).toBe(200);
  });

  it('starts none when the connection lasted a second, and one when it lasted a millisecond less', () => {
    newGate();
    shortLived(DID_NOT_LAST_MS);
    expect(gate.pauseLeftMs()).toBe(0);
    shortLived(DID_NOT_LAST_MS - 1);
    expect(gate.pauseLeftMs()).toBe(200);
  });

  it('doubles the pause each time and stops at the longest', () => {
    newGate();
    const lengths: number[] = [];
    for (let i = 0; i < 7; i++) {
      shortLived(5);
      lengths.push(gate.pauseLeftMs());
      // To exactly the end of the pause, where the next connection may be tried.
      pass(gate.pauseLeftMs());
    }
    expect(lengths).toEqual([200, 400, 800, 1600, 2000, 2000, 2000]);
  });

  it('starts short again after a connection that lasted', () => {
    newGate();
    for (let i = 0; i < 4; i++) {
      shortLived(5);
      pass(gate.pauseLeftMs());
    }
    shortLived(DID_NOT_LAST_MS);
    expect(gate.pauseLeftMs()).toBe(0);
    shortLived(5);
    expect(gate.pauseLeftMs()).toBe(200);
  });

  it('opens nothing during a pause', () => {
    newGate();
    shortLived();
    for (let i = 0; i < 5; i++) {
      const socket = open();
      expect(socket.connectCalls).toEqual([]);
      pass(1);
    }
    expect(made.filter((socket) => socket.connectCalls.length > 0)).toHaveLength(1);
  });
});

describe('the end of a pause', () => {
  it('a socket asked for one millisecond before the end is not opened; at the end it is', () => {
    newGate();
    shortLived();
    pass(199);
    expect(open().connectCalls).toEqual([]);
    pass(1);
    expect(gate.pauseLeftMs()).toBe(0);
    expect(open().connectCalls).toHaveLength(1);
  });

  // The case an earlier test of real time stumbled into once in many runs: it asked whether a pause
  // was running, and by the time it asked for a socket the pause was over.
  it('a socket asked for at the end is a real attempt: if it does not last either, the pause that follows is the doubled one', () => {
    newGate();
    shortLived();
    pass(200);
    const second = open();
    expect(second.connectCalls).toHaveLength(1);
    second.opens();
    pass(3);
    second.hangsUp();
    expect(gate.pauseLeftMs()).toBe(400);
  });
});

describe('rule 3: a socket that was not opened', () => {
  it('is handed out open, and closed a moment later with an error that says why', () => {
    newGate();
    shortLived();
    const socket = open();
    // Still open when the gate returns it, so whoever takes it can attach its listeners first.
    expect(socket.destroyed).toBe(false);
    const heard: string[] = [];
    socket.on('error', (error: { code?: string }) => heard.push(`error ${error.code}`));
    socket.on('close', () => heard.push('close'));
    pass(0);
    expect(socket.destroyed).toBe(true);
    expect(heard).toEqual(['error CONNECTION_PAUSED', 'close']);
    expect(socket.connectCalls).toEqual([]);
  });

  it('neither starts, lengthens nor ends the pause, however many are asked for', () => {
    newGate();
    shortLived();
    expect(gate.pauseLeftMs()).toBe(200);
    for (let i = 0; i < 50; i++) {
      open();
      // Their closing, a timer tick later, changes nothing either.
      pass(0);
      expect(gate.pauseLeftMs()).toBe(200);
    }
    pass(150);
    for (let i = 0; i < 50; i++) {
      open();
      pass(0);
      expect(gate.pauseLeftMs()).toBe(50);
    }
    // The pause ends when it was due, and the pause after the next failure is the second, not a later one.
    pass(50);
    expect(gate.pauseLeftMs()).toBe(0);
    shortLived();
    expect(gate.pauseLeftMs()).toBe(400);
  });

  it('its own error, when it is closed, does not count as a failed connection', () => {
    newGate();
    shortLived();
    pass(120);
    open();
    pass(0);
    expect(gate.pauseLeftMs()).toBe(80);
  });
});

describe('rule 4: the pause is in place when the socket reports its error', () => {
  it('a listener attached after the gate\'s own sees the whole pause at the error, and the close after it changes nothing', () => {
    newGate();
    const socket = open();
    let leftAtError = -1;
    let leftAtClose = -1;
    socket.on('error', () => (leftAtError = gate.pauseLeftMs()));
    socket.on('close', () => (leftAtClose = gate.pauseLeftMs()));
    // The error, 30 ms of something else, then the close.
    socket.destroyed = true;
    socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    pass(30);
    socket.emit('close');
    expect(leftAtError).toBe(200);
    // Counted once: the close did not start the pause again.
    expect(leftAtClose).toBe(170);
  });
});

describe('rule 5: a connection that does not open in time', () => {
  it('is closed with a timeout error exactly when its time is up, and starts a pause', () => {
    newGate(2000);
    const socket = open();
    pass(1999);
    expect(socket.destroyed).toBe(false);
    pass(1);
    expect(socket.destroyed).toBe(true);
    expect(socket.destroyedWith).toMatchObject({ code: 'CONNECT_TIMEOUT' });
    // It took two seconds, which is not "did not last" (under one second): no pause follows. The next
    // test gives it less than a second.
    expect(gate.pauseLeftMs()).toBe(0);
  });

  it('with less than a second to connect, the timeout is followed by a pause', () => {
    newGate(300);
    const socket = open();
    pass(300);
    expect(socket.destroyedWith).toMatchObject({ code: 'CONNECT_TIMEOUT' });
    expect(gate.pauseLeftMs()).toBe(200);
  });

  it('leaves no timer behind when the attempt fails before its time is up', () => {
    newGate(2000);
    open().failsWith('ECONNREFUSED');
    expect(vi.getTimerCount()).toBe(0);
    // Nor when the other side hangs up while it is still connecting.
    pass(200);
    open().hangsUp();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is left alone once it has opened: the timer ended with the connect', () => {
    newGate(2000);
    const socket = open();
    pass(1500);
    socket.opens();
    pass(60_000);
    expect(socket.destroyed).toBe(false);
  });
});

describe('an error always has a listener', () => {
  it('a socket whose error nobody else listens to raises nothing', () => {
    newGate();
    const socket = open();
    // An emitter throws when an 'error' has no listener.
    expect(() => socket.failsWith('EADDRNOTAVAIL')).not.toThrow();
  });

  it('every error is heard, not only the first: a second one before the close raises nothing', () => {
    newGate();
    const socket = open();
    socket.emit('error', Object.assign(new Error('first'), { code: 'ECONNRESET' }));
    expect(() => socket.emit('error', Object.assign(new Error('second'), { code: 'EPIPE' }))).not.toThrow();
    socket.hangsUp();
    // And the two errors and the close counted as one end: one pause, of the first length.
    expect(gate.pauseLeftMs()).toBe(200);
  });

  it('also for a socket that was not opened, when it is closed with its error', () => {
    newGate();
    shortLived();
    open();
    expect(() => pass(0)).not.toThrow();
  });
});

describe('rule 6: shutting the gate', () => {
  it('closes every socket it handed out, connected or still connecting, without an error', () => {
    newGate();
    const connected = open();
    connected.opens();
    const connecting = open();
    gate.shut();
    expect(connected.destroyed).toBe(true);
    expect(connecting.destroyed).toBe(true);
    expect(connected.destroyedWith).toBeUndefined();
    expect(connecting.destroyedWith).toBeUndefined();
  });

  it('leaves no timer behind: not the connect timer of a socket that was still connecting, nor any other', () => {
    newGate(2000);
    const connected = open();
    connected.opens();
    open();
    expect(vi.getTimerCount()).toBe(1);
    gate.shut();
    expect(vi.getTimerCount()).toBe(0);
    // A socket asked for after shutting has one zero timer, and none once it has fired.
    open();
    pass(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('opens no more: a socket asked for afterwards is closed a moment later with an error that says so', () => {
    newGate();
    gate.shut();
    const socket = open();
    expect(socket.destroyed).toBe(false);
    pass(0);
    expect(socket.destroyedWith).toMatchObject({ code: 'CONNECTION_DESTROYED' });
    expect(socket.connectCalls).toEqual([]);
    // Not after any wait either.
    pass(60_000);
    expect(made.every((made) => made.connectCalls.length === 0)).toBe(true);
  });

  it('starts no pause, by its own closing or by a socket that ends afterwards', () => {
    newGate();
    const socket = open();
    socket.opens();
    pass(5);
    gate.shut();
    expect(gate.pauseLeftMs()).toBe(0);
    const late = open();
    pass(0);
    expect(late.destroyed).toBe(true);
    expect(gate.pauseLeftMs()).toBe(0);
  });

  it('no longer holds on to a socket that has closed', () => {
    newGate();
    const socket = open();
    socket.opens();
    pass(DID_NOT_LAST_MS);
    socket.hangsUp();
    // Shutting now has nothing to close: the closed socket is not destroyed a second time.
    socket.destroyed = false;
    gate.shut();
    expect(socket.destroyed).toBe(false);
  });
});
