// src/lib/ai/parseSse.ts
//
// Minimal Server-Sent Events frame parser for the repo's first fetch-based SSE
// client (the CMS content agent panel). The browser's native `EventSource` is
// GET-only and cannot send a request body, so the agent streams over
// `fetch()` + `response.body.getReader()` and parses the frames here.
//
// SSE framing (per WHATWG): records are separated by a blank line; within a
// record, `event:` names the event and `data:` carries the (JSON) payload.
// Lines beginning with `:` are comments (our heartbeats) and are ignored. A
// record with no explicit `event:` defaults to the `message` type.
//
// `parseSseFrames` is buffer-aware: it consumes only complete records and
// returns the unparsed tail (`rest`) so the caller can prepend it to the next
// network chunk. This keeps a frame split across two reads from being dropped.

export interface SseFrame {
  /** The event name (`agent:thinking`, `agent:done`, ...); `message` if absent. */
  event: string;
  /** The raw `data:` payload (JSON text for our routes; may be empty). */
  data: string;
}

/**
 * Parse all COMPLETE SSE records from `buffer`, returning the parsed frames and
 * the leftover `rest` (an incomplete trailing record, or the empty string).
 *
 * Frames are split on the blank-line terminator (`\n\n`). `\r\n` line endings
 * are tolerated. Comment lines (`:`-prefixed, including heartbeats) are skipped.
 */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames: SseFrame[] = [];
  let rest = normalized;

  let sep = rest.indexOf('\n\n');
  while (sep !== -1) {
    const record = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const frame = parseRecord(record);
    if (frame) frames.push(frame);
    sep = rest.indexOf('\n\n');
  }

  return { frames, rest };
}

function parseRecord(record: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];
  let sawField = false;

  for (const line of record.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue; // blank or comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Per spec a single leading space after the colon is stripped.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      event = value;
      sawField = true;
    } else if (field === 'data') {
      dataLines.push(value);
      sawField = true;
    }
    // `id` / `retry` are not used by our routes; ignore.
  }

  if (!sawField) return null;
  return { event, data: dataLines.join('\n') };
}
