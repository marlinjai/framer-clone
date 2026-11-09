// src/lib/ai/__tests__/sse.test.ts
//
// Pins down SSE framing: event name, JSON-encoded data, double-newline
// terminator, heartbeats as comment lines. Also verifies the cadence
// for the heartbeat helper (10s) by running it under fake timers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createSseStream, SSE_HEARTBEAT_MS, SSE_MAX_QUEUED_BYTES } from '../sse';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  // Read everything the producer has enqueued so far. We rely on the
  // producer calling close(); otherwise this would hang. Each test
  // that uses readAll() must end with sse.close().
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe('createSseStream', () => {
  it('emits `event: <name>\\ndata: <json>\\n\\n` for send()', async () => {
    const sse = createSseStream();
    sse.send('token', { delta: 'hi' });
    sse.close();

    const text = await readAll(sse.stream);
    expect(text).toBe('event: token\ndata: {"delta":"hi"}\n\n');
  });

  it('frames multiple events back-to-back without losing the terminator', async () => {
    const sse = createSseStream();
    sse.send('token', { delta: 'a' });
    sse.send('token', { delta: 'b' });
    sse.send('done', { turnId: 'x' });
    sse.close();

    const text = await readAll(sse.stream);
    expect(text).toBe(
      'event: token\ndata: {"delta":"a"}\n\n' +
        'event: token\ndata: {"delta":"b"}\n\n' +
        'event: done\ndata: {"turnId":"x"}\n\n',
    );
  });

  it('emits comment-line heartbeats', async () => {
    const sse = createSseStream();
    sse.heartbeat();
    sse.heartbeat();
    sse.close();

    const text = await readAll(sse.stream);
    expect(text).toBe(': heartbeat\n\n: heartbeat\n\n');
  });

  it('emits a structured error envelope on close(err)', async () => {
    const sse = createSseStream();
    sse.close({ message: 'boom', code: 'upstream_error' });

    const text = await readAll(sse.stream);
    expect(text).toBe(
      'event: error\ndata: {"message":"boom","code":"upstream_error"}\n\n',
    );
  });

  it('is idempotent on close()', async () => {
    const sse = createSseStream();
    sse.send('token', { delta: 'x' });
    sse.close();
    sse.close(); // no-op
    sse.send('token', { delta: 'y' }); // dropped (closed)

    const text = await readAll(sse.stream);
    expect(text).toBe('event: token\ndata: {"delta":"x"}\n\n');
  });
});

describe('SSE heartbeat cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires every SSE_HEARTBEAT_MS when scheduled via setInterval', async () => {
    const sse = createSseStream();
    const id = setInterval(() => sse.heartbeat(), SSE_HEARTBEAT_MS);

    // Advance past three intervals.
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 3);
    clearInterval(id);
    sse.close();

    const text = await readAll(sse.stream);
    const matches = text.match(/: heartbeat\n\n/g) ?? [];
    expect(matches.length).toBe(3);
    expect(SSE_HEARTBEAT_MS).toBe(10_000);
  });
});

describe('createSseStream disconnect signal', () => {
  it('aborts when the reader cancels the stream, not on a server-side close', async () => {
    const closedByServer = createSseStream();
    closedByServer.close();
    expect(closedByServer.signal.aborted).toBe(false);

    const sse = createSseStream();
    expect(sse.signal.aborted).toBe(false);
    await sse.stream.cancel();
    expect(sse.signal.aborted).toBe(true);
    // Writes after a disconnect are dropped silently.
    expect(() => sse.send('x', {})).not.toThrow();
  });
});

describe('createSseStream named heartbeat', () => {
  it('sends the heartbeat as a named event with an empty object when asked to', async () => {
    const sse = createSseStream({ heartbeatEvent: 'ping' });
    sse.heartbeat();
    sse.close();

    expect(await readAll(sse.stream)).toBe('event: ping\ndata: {}\n\n');
  });
});

describe('createSseStream backpressure', () => {
  it('ends the stream and aborts the signal once a reader that does not read falls behind the bound', async () => {
    const sse = createSseStream({ maxQueuedBytes: 1024 });
    const chunk = 'x'.repeat(400);
    // 3 x ~430 bytes: the third write overshoots the bound, the fourth finds it full.
    sse.send('token', { delta: chunk });
    sse.send('token', { delta: chunk });
    sse.send('token', { delta: chunk });
    expect(sse.signal.aborted).toBe(false);
    sse.send('token', { delta: chunk });
    expect(sse.signal.aborted).toBe(true);
    // Later writes are dropped without throwing.
    expect(() => sse.send('token', { delta: 'late' })).not.toThrow();
    expect(() => sse.heartbeat()).not.toThrow();
    expect(() => sse.close()).not.toThrow();
    // The queue was dropped: the reader sees an error, not the backlog.
    await expect(sse.stream.getReader().read()).rejects.toThrow(/fell behind/);
  });

  it('lets one event larger than the bound through to a stream that is read', async () => {
    const sse = createSseStream({ maxQueuedBytes: 64 });
    sse.send('state', { blob: 'y'.repeat(500) });
    expect(sse.signal.aborted).toBe(false);
    sse.close();
    expect(await readAll(sse.stream)).toContain('"blob"');
  });

  it('keeps a stream alive while its reader keeps up', async () => {
    const sse = createSseStream({ maxQueuedBytes: 1024 });
    const reader = sse.stream.getReader();
    for (let i = 0; i < 50; i++) {
      sse.send('token', { delta: 'z'.repeat(400) });
      const { value } = await reader.read();
      expect(value?.byteLength).toBeGreaterThan(400);
    }
    expect(sse.signal.aborted).toBe(false);
    sse.close();
    expect((await reader.read()).done).toBe(true);
  });

  it('defaults to SSE_MAX_QUEUED_BYTES and refuses a bound that is not positive', () => {
    expect(SSE_MAX_QUEUED_BYTES).toBe(4 * 1024 * 1024);
    expect(() => createSseStream({ maxQueuedBytes: 0 })).toThrow(RangeError);
  });
});
