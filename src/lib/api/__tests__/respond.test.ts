import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { jsonError, parseBody } from '../respond';

describe('jsonError', () => {
  it('produces the { error: { code, message } } envelope with the status', async () => {
    const res = jsonError('bad_thing', 'nope', 422);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: 'bad_thing', message: 'nope' },
    });
  });

  it('spreads extra fields into the error object', async () => {
    const res = jsonError('bad_body', 'invalid', 400, { issues: ['x'] });
    expect(await res.json()).toEqual({
      error: { code: 'bad_body', message: 'invalid', issues: ['x'] },
    });
  });
});

describe('parseBody', () => {
  const Schema = z.object({ name: z.string() });

  it('returns { ok: true, data } on a valid body', async () => {
    const req = new Request('http://test/x', {
      method: 'POST',
      body: JSON.stringify({ name: 'alice' }),
      headers: { 'content-type': 'application/json' },
    });
    const result = await parseBody(req, Schema);
    expect(result).toEqual({ ok: true, data: { name: 'alice' } });
  });

  it('returns a 400 bad_body envelope on a schema failure', async () => {
    const req = new Request('http://test/x', {
      method: 'POST',
      body: JSON.stringify({ name: 123 }),
      headers: { 'content-type': 'application/json' },
    });
    const result = await parseBody(req, Schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error.code).toBe('bad_body');
      expect(Array.isArray(body.error.issues)).toBe(true);
    }
  });

  it('returns a 400 bad_json envelope on an unparseable body', async () => {
    const req = new Request('http://test/x', {
      method: 'POST',
      body: 'this is not json {',
      headers: { 'content-type': 'application/json' },
    });
    const result = await parseBody(req, Schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error.code).toBe('bad_json');
    }
  });
});
