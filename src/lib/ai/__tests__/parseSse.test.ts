import { describe, it, expect } from 'vitest';
import { parseSseFrames } from '../parseSse';

describe('parseSseFrames', () => {
  it('parses a complete event + data frame', () => {
    const { frames, rest } = parseSseFrames('event: agent:done\ndata: {"runId":"r1"}\n\n');
    expect(frames).toEqual([{ event: 'agent:done', data: '{"runId":"r1"}' }]);
    expect(rest).toBe('');
  });

  it('buffers an incomplete trailing frame as rest', () => {
    const { frames, rest } = parseSseFrames('event: a\ndata: 1\n\nevent: b\ndata: 2');
    expect(frames).toEqual([{ event: 'a', data: '1' }]);
    expect(rest).toBe('event: b\ndata: 2');
  });

  it('skips comment/heartbeat lines', () => {
    const { frames } = parseSseFrames(': heartbeat\n\nevent: x\ndata: {}\n\n');
    expect(frames).toEqual([{ event: 'x', data: '{}' }]);
  });

  it('defaults the event name to "message" when only data is present', () => {
    const { frames } = parseSseFrames('data: hello\n\n');
    expect(frames).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('tolerates CRLF line endings', () => {
    const { frames } = parseSseFrames('event: a\r\ndata: 1\r\n\r\n');
    expect(frames).toEqual([{ event: 'a', data: '1' }]);
  });
});
