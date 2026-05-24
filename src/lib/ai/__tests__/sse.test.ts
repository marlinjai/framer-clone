// src/lib/ai/__tests__/sse.test.ts
//
// Pins down SSE framing: event name, JSON-encoded data, double-newline
// terminator, heartbeats as comment lines. Also verifies the cadence
// for the heartbeat helper (10s) by running it under fake timers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createSseStream, SSE_HEARTBEAT_MS } from '../sse';

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
