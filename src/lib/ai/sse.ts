// src/lib/ai/sse.ts
//
// Tiny Server-Sent Events helper for the AI route. Wraps a
// `ReadableStream` with `send(event, data)` + `heartbeat()` + `close()`
// so callers don't repeat the framing rules.
//
// SSE framing (per WHATWG):
//   event: <name>\n
//   data: <JSON>\n
//   \n         <- terminator
//
// Heartbeats are sent as comment lines (`: heartbeat\n\n`) by default, so
// they don't fire client event listeners but still keep middleware /
// browsers from closing an idle connection. A stream created with
// `heartbeatEvent` sends them as a named event with an empty object instead
// (`event: ping\ndata: {}\n\n`), which a browser's EventSource can see, so the
// client can tell a silent stream from a quiet one (the live editor stream).
//
// Backpressure: the stream queues at most `maxQueuedBytes` (counted in bytes)
// that the reader has not taken yet. A write that finds the queue already at
// that bound ends the stream as if the client had gone away: the queue is
// dropped (the stream errors), `signal` aborts and every later write is a
// no-op. One event may overshoot the bound, so a single large event never
// ends a stream that is being read; a reader that stops reading costs at most
// the bound plus one event. The client reconnects (or polls) as it does after
// any dropped connection. The stream errors with an AbortError, which Next.js
// treats as a client disconnect rather than a failed response.
//
// A stream created with `armed: false` queues its opening burst (written
// before the Response is even handed back, so before anything can be read)
// without counting it: `arm()` starts the bound, which then allows the
// burst's bytes on top of `maxQueuedBytes`, an allowance that shrinks as the
// reader reads (to the unread bytes at each write, never below them).

const ENCODER = new TextEncoder();

/** Default heartbeat interval. The spec requires 10s. */
export const SSE_HEARTBEAT_MS = 10_000;

/** Bytes a stream queues for a reader that does not read before it is ended, unless the caller chooses another bound. */
export const SSE_MAX_QUEUED_BYTES = 4 * 1024 * 1024;

export interface SseStreamOptions {
  /** Unread bytes queued at most; past this the stream ends (default SSE_MAX_QUEUED_BYTES). */
  maxQueuedBytes?: number;
  /** Send heartbeats as this named event with `{}` as data, instead of as comment lines. */
  heartbeatEvent?: string;
  /** False: the bound starts only with arm(), so an opening burst written before the Response exists is not cut off (default true). */
  armed?: boolean;
}

export type SseStream = {
  /** The body to hand back to Next.js's `new Response(stream, ...)`. */
  stream: ReadableStream<Uint8Array>;
  /**
   * Send a typed SSE event. `data` is JSON-stringified. `id`, when given, becomes
   * the event's id: a browser's EventSource sends the last one back as
   * `Last-Event-ID` when it reconnects.
   */
  send: (event: string, data: unknown, id?: string | number) => void;
  /** Send a heartbeat: a comment line, or the `heartbeatEvent` the stream was created with. */
  heartbeat: () => void;
  /** Start the bound of a stream created with `armed: false` (idempotent); what is queued now is allowed on top of it. */
  arm: () => void;
  /**
   * Close the stream. If `err` is provided, emit an `error` event with
   * `{ message, code }` first so the client sees a structured envelope
   * instead of a bare disconnect.
   */
  close: (err?: { message: string; code: string }) => void;
  /**
   * Aborts when the client went away: the reader cancelled the stream (the
   * browser closed the connection) or a write failed on a closed stream.
   * Routes pass it to the Anthropic call so a dead connection stops spending.
   * Also aborted when the reader fell behind by more than `maxQueuedBytes`.
   * Not aborted by an ordinary close() from the server side.
   */
  signal: AbortSignal;
};

export function createSseStream(options: SseStreamOptions = {}): SseStream {
  const maxQueuedBytes = options.maxQueuedBytes ?? SSE_MAX_QUEUED_BYTES;
  if (!(maxQueuedBytes > 0)) throw new RangeError('maxQueuedBytes must be a positive number');
  const heartbeatFrame = options.heartbeatEvent
    ? `event: ${options.heartbeatEvent.replace(/[\r\n]/g, '')}\ndata: {}\n\n`
    : `: heartbeat\n\n`;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let armed = options.armed ?? true;
  /** Unread bytes of the opening burst at arm(): allowed on top of maxQueuedBytes. */
  let burst = 0;
  const disconnected = new AbortController();

  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      cancel() {
        closed = true;
        controller = null;
        disconnected.abort();
      },
    },
    // desiredSize = maxQueuedBytes minus the bytes queued and not yet read.
    new ByteLengthQueuingStrategy({ highWaterMark: maxQueuedBytes }),
  );

  /** The reader fell behind: drop what is queued and end the stream as a disconnect. */
  const overflow = () => {
    const c = controller;
    closed = true;
    controller = null;
    try {
      c?.error(new DOMException('the reader fell behind the stream', 'AbortError'));
    } catch {
      // already closed or errored; ignore
    }
    disconnected.abort();
  };

  const enqueue = (s: string) => {
    if (closed || !controller) return;
    const desired = controller.desiredSize;
    if (armed && desired !== null) {
      // desiredSize is maxQueuedBytes minus the unread bytes.
      const queued = maxQueuedBytes - desired;
      // The burst's allowance shrinks as the reader takes it, and never grows back.
      burst = Math.min(burst, queued);
      if (queued >= maxQueuedBytes + burst) {
        overflow();
        return;
      }
    }
    try {
      controller.enqueue(ENCODER.encode(s));
    } catch {
      // Stream cancelled mid-write: the client is gone.
      closed = true;
      disconnected.abort();
    }
  };

  const send: SseStream['send'] = (event, data, id) => {
    if (closed) return;
    // An id never spans lines (that would end the field early); only plain tokens are sent.
    const idLine = id !== undefined && /^[A-Za-z0-9_-]+$/.test(String(id)) ? `id: ${id}\n` : '';
    const payload = `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    enqueue(payload);
  };

  const arm: SseStream['arm'] = () => {
    if (armed) return;
    armed = true;
    const desired = controller?.desiredSize;
    burst = desired == null ? 0 : Math.max(0, maxQueuedBytes - desired);
  };

  const heartbeat: SseStream['heartbeat'] = () => {
    if (closed) return;
    enqueue(heartbeatFrame);
  };

  const close: SseStream['close'] = (err) => {
    if (closed) return;
    if (err) {
      try {
        const payload = `event: error\ndata: ${JSON.stringify(err)}\n\n`;
        enqueue(payload);
      } catch {
        // ignore
      }
    }
    closed = true;
    try {
      controller?.close();
    } catch {
      // already closed; ignore
    }
    controller = null;
  };

  return { stream, send, heartbeat, arm, close, signal: disconnected.signal };
}

/**
 * Standard headers for an SSE Response.
 */
export const SSE_HEADERS: HeadersInit = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Disable buffering in nginx-style proxies.
  'X-Accel-Buffering': 'no',
};
