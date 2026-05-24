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
// Heartbeats are sent as comment lines (`: heartbeat\n\n`) so they
// don't fire client event listeners but still keep middleware /
// browsers from closing an idle connection.

const ENCODER = new TextEncoder();

/** Default heartbeat interval. The spec requires 10s. */
export const SSE_HEARTBEAT_MS = 10_000;

export type SseStream = {
  /** The body to hand back to Next.js's `new Response(stream, ...)`. */
  stream: ReadableStream<Uint8Array>;
  /** Send a typed SSE event. `data` is JSON-stringified. */
  send: (event: string, data: unknown) => void;
  /** Send a comment-line heartbeat. */
  heartbeat: () => void;
  /**
   * Close the stream. If `err` is provided, emit an `error` event with
   * `{ message, code }` first so the client sees a structured envelope
   * instead of a bare disconnect.
   */
  close: (err?: { message: string; code: string }) => void;
};

export function createSseStream(): SseStream {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
      controller = null;
    },
  });

  const enqueue = (s: string) => {
    if (closed || !controller) return;
    try {
      controller.enqueue(ENCODER.encode(s));
    } catch {
      // Stream cancelled mid-write; mark closed and move on.
      closed = true;
    }
  };

  const send: SseStream['send'] = (event, data) => {
    if (closed) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    enqueue(payload);
  };

  const heartbeat: SseStream['heartbeat'] = () => {
    if (closed) return;
    enqueue(`: heartbeat\n\n`);
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

  return { stream, send, heartbeat, close };
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
