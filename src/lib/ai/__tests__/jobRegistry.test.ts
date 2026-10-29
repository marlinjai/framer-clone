// The run registry behind resumable AI runs: ownership, the first outcome
// wins, explicit cancel is the only stop, and finished runs expire.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJobRegistry, JOB_LIMITS } from '../jobRegistry';

const A = { userId: 'user-a', workspaceId: 'ws-a' };

afterEach(() => vi.useRealTimers());

describe('createJobRegistry', () => {
  it('tracks progress, then keeps the result for its owner only', () => {
    const jobs = createJobRegistry<{ n: number }, string, { code: string; message: string }>();
    const job = jobs.create({ id: 'r1', ...A });
    expect(jobs.get('r1', A)).toEqual({ status: 'running' });
    job.progress({ n: 1 });
    expect(jobs.get('r1', A)).toEqual({ status: 'running', progress: { n: 1 } });
    job.succeed('page');
    expect(jobs.get('r1', A)).toEqual({ status: 'done', result: 'page' });
    expect(jobs.get('r1', { ...A, userId: 'user-b' })).toBeUndefined();
    expect(jobs.get('r1', { ...A, workspaceId: 'ws-b' })).toBeUndefined();
    expect(jobs.get('nope', A)).toBeUndefined();
  });

  it('the first outcome wins: a late result after a cancel or a failure is not collectable', () => {
    const jobs = createJobRegistry<never, string, { code: string; message: string }>();
    const job = jobs.create({ id: 'r1', ...A });
    expect(jobs.cancel('r1', A)).toBe(true);
    expect(job.signal.aborted).toBe(true);
    job.succeed('late');
    job.fail({ code: 'aborted', message: 'x' });
    expect(jobs.get('r1', A)).toEqual({ status: 'cancelled' });

    const other = jobs.create({ id: 'r2', ...A });
    other.fail({ code: 'invalid_output', message: 'bad' });
    other.succeed('late');
    expect(jobs.get('r2', A)).toEqual({ status: 'failed', error: { code: 'invalid_output', message: 'bad' } });
    // Cancelling a finished run changes nothing and does not abort.
    expect(jobs.cancel('r2', A)).toBe(true);
    expect(jobs.get('r2', A)?.status).toBe('failed');
  });

  it('only its owner can cancel a run', () => {
    const jobs = createJobRegistry();
    const job = jobs.create({ id: 'r1', ...A });
    expect(jobs.cancel('r1', { ...A, userId: 'user-b' })).toBe(false);
    expect(job.signal.aborted).toBe(false);
  });

  it('finished runs expire; a run that never finishes is aborted and dropped', () => {
    vi.useFakeTimers();
    const jobs = createJobRegistry<never, string, never>();
    const done = jobs.create({ id: 'done', ...A });
    done.succeed('page');
    const hung = jobs.create({ id: 'hung', ...A });
    vi.advanceTimersByTime(JOB_LIMITS.finishedTtlMs + 1);
    expect(jobs.get('done', A)).toBeUndefined();
    expect(jobs.get('hung', A)).toEqual({ status: 'running' });
    vi.advanceTimersByTime(JOB_LIMITS.maxAgeMs);
    expect(jobs.get('hung', A)).toBeUndefined();
    expect(hung.signal.aborted).toBe(true);
  });

  it('keeps a bounded number of runs per user, dropping the oldest finished ones', () => {
    const jobs = createJobRegistry<never, string, never>();
    for (let i = 0; i < JOB_LIMITS.maxPerUser + 2; i += 1) jobs.create({ id: `r${i}`, ...A }).succeed(`p${i}`);
    expect(jobs.get('r0', A)).toBeUndefined();
    expect(jobs.get('r1', A)).toBeUndefined();
    expect(jobs.get(`r${JOB_LIMITS.maxPerUser + 1}`, A)?.status).toBe('done');
  });
});
