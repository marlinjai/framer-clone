import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { isDatabaseConflict } from '../dbConflict';

const known = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test', ...(meta ? { meta } : {}) });

describe('isDatabaseConflict', () => {
  it('reads a Prisma query\'s serialization failure and a raw query\'s 40001 and deadlock 40P01', () => {
    expect(isDatabaseConflict(known('P2034'))).toBe(true);
    expect(isDatabaseConflict(known('P2010', { code: '40001' }))).toBe(true);
    expect(isDatabaseConflict(known('P2010', { code: '40P01' }))).toBe(true);
  });

  it('is false for everything else: other codes, other raw codes, other errors', () => {
    expect(isDatabaseConflict(known('P2002'))).toBe(false);
    expect(isDatabaseConflict(known('P2010', { code: '23505' }))).toBe(false);
    expect(isDatabaseConflict(known('P2010'))).toBe(false);
    expect(isDatabaseConflict(new Error('db down'))).toBe(false);
    expect(isDatabaseConflict(null)).toBe(false);
  });
});
