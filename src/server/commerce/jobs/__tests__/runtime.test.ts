// @vitest-environment node
//
// The poller's life in one process, on a fake clock: it starts once, never overlaps itself, stops claiming when it is
// told to, is quiet through an outage, and keeps to its limits. The passes against real Postgres are in runtime.itest.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { commerceTenantDbChecked, ensureCommerceBackstop, listGroups, runNextJob } = vi.hoisted(() => ({
  commerceTenantDbChecked: vi.fn(),
  ensureCommerceBackstop: vi.fn(),
  listGroups: vi.fn(),
  runNextJob: vi.fn(),
}));

vi.mock('../../db', () => ({
  commerceTenantDbChecked,
  ensureCommerceBackstop,
  getCommerceBase: () => ({ selectFrom: () => ({ select: () => ({ execute: listGroups }) }) }),
  isCommerceTenantNotProvisioned: () => false,
}));
vi.mock('../run', () => ({ runNextJob }));
vi.mock('../backfills', () => ({ JOB_BACKFILLS: [], runJobBackfills: async () => undefined }));

import { runCommercePass, startCommerceWorker, stopCommerceWorker } from '../runtime';

const handle = { deleteFrom: () => ({ where: () => ({ execute: async () => [] }) }) };
const EVERY_MS = 30_000;

function group(id: string) {
  return { id };
}

/** A promise the test ends by hand. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('COMMERCE_APP_DATABASE_URL', 'postgresql://commerce_app@localhost:5432/unit');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ensureCommerceBackstop.mockResolvedValue(undefined);
  commerceTenantDbChecked.mockResolvedValue(handle);
  listGroups.mockResolvedValue([group('a')]);
  runNextJob.mockResolvedValue(null);
});

afterEach(async () => {
  const stopping = stopCommerceWorker();
  await vi.advanceTimersByTimeAsync(25_000);
  await stopping;
  (globalThis as unknown as { __commerceJobsStopping?: boolean }).__commerceJobsStopping = false;
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('startCommerceWorker', () => {
  it('starts one timer however often it is called, with one listener per signal', async () => {
    const before = process.listenerCount('SIGTERM');
    startCommerceWorker();
    startCommerceWorker();
    expect(vi.getTimerCount()).toBe(1);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);

    await stopCommerceWorker();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('does nothing at start: the first pass comes one interval later', async () => {
    startCommerceWorker();
    expect(listGroups).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(EVERY_MS);
    expect(listGroups).toHaveBeenCalledTimes(1);
  });

  it('does not keep the process alive', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    startCommerceWorker();
    const timer = setIntervalSpy.mock.results[0].value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
  });

  it('stays out of the way without a commerce database', () => {
    vi.stubEnv('COMMERCE_APP_DATABASE_URL', ' ');
    startCommerceWorker();
    expect(vi.getTimerCount()).toBe(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('never overlaps itself: a tick during a pass is dropped', async () => {
    const slow = gate();
    runNextJob.mockImplementationOnce(() => slow.opened.then(() => null));
    startCommerceWorker();

    await vi.advanceTimersByTimeAsync(EVERY_MS * 3);
    expect(listGroups).toHaveBeenCalledTimes(1);

    slow.open();
    await vi.advanceTimersByTimeAsync(EVERY_MS);
    expect(listGroups).toHaveBeenCalledTimes(2);
  });

  it('logs an outage once, not every tick, and again when a failure follows a good pass', async () => {
    listGroups.mockRejectedValue(new Error('connection refused'));
    startCommerceWorker();
    await vi.advanceTimersByTimeAsync(EVERY_MS * 3);
    expect(console.error).toHaveBeenCalledOnce();

    listGroups.mockResolvedValueOnce([]);
    await vi.advanceTimersByTimeAsync(EVERY_MS);
    await vi.advanceTimersByTimeAsync(EVERY_MS);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it('survives a failing pass: the next tick works', async () => {
    listGroups.mockRejectedValueOnce(new Error('connection refused'));
    startCommerceWorker();
    await vi.advanceTimersByTimeAsync(EVERY_MS * 2);
    expect(runNextJob).toHaveBeenCalledTimes(1);
  });
});

describe('stopCommerceWorker', () => {
  it('ends the timer, claims nothing more and waits for the job in hand', async () => {
    const inHand = gate();
    runNextJob.mockImplementationOnce(() => inHand.opened.then(() => ({ outcome: 'done' })));
    startCommerceWorker();
    await vi.advanceTimersByTimeAsync(EVERY_MS);
    expect(runNextJob).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = stopCommerceWorker().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(EVERY_MS / 3);
    expect(stopped).toBe(false);

    inHand.open();
    await stopping;
    expect(runNextJob).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up waiting on a handler that does not end', async () => {
    runNextJob.mockImplementationOnce(() => new Promise(() => undefined));
    startCommerceWorker();
    await vi.advanceTimersByTimeAsync(EVERY_MS);

    const stopping = stopCommerceWorker();
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(stopping).resolves.toBeUndefined();
  });

  it('a signal stops the claiming too, and leaves ending the process to the listener that does', async () => {
    const inHand = gate();
    runNextJob.mockImplementationOnce(() => inHand.opened.then(() => ({ outcome: 'done' })));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    // A listener like Next's.
    const next = () => undefined;
    process.on('SIGTERM', next);
    startCommerceWorker();
    await vi.advanceTimersByTimeAsync(EVERY_MS);

    process.emit('SIGTERM');
    inHand.open();
    await vi.advanceTimersByTimeAsync(EVERY_MS * 2);

    process.removeListener('SIGTERM', next);
    expect(runNextJob).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
  });

  it('alone with a signal, the worker re-raises it, so the process still ends', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const others = process.listeners('SIGINT');
    process.removeAllListeners('SIGINT');
    startCommerceWorker();

    process.emit('SIGINT');
    await vi.advanceTimersByTimeAsync(0);

    for (const listener of others) process.on('SIGINT', listener);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
  });
});

describe('runCommercePass', () => {
  it('works on at most 4 tenant groups at a time, and reaches all of them', async () => {
    listGroups.mockResolvedValue(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(group));
    let active = 0;
    let most = 0;
    runNextJob.mockImplementation(async () => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return null;
    });

    const pass = runCommercePass();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pass).toEqual({ tenantGroups: 7, skipped: 0, ran: 0, failed: 0 });
    expect(most).toBe(4);
  });

  it('runs at most 20 jobs of a group, stopping early when nothing is due', async () => {
    listGroups.mockResolvedValue([group('busy')]);
    runNextJob.mockResolvedValue({ outcome: 'done' });
    expect((await runCommercePass()).ran).toBe(20);
    expect(runNextJob).toHaveBeenCalledTimes(20);

    runNextJob.mockReset();
    runNextJob.mockResolvedValueOnce({ outcome: 'done' }).mockResolvedValue(null);
    expect((await runCommercePass()).ran).toBe(1);
    expect(runNextJob).toHaveBeenCalledTimes(2);
  });

  it('logs its duration, and warns when a pass takes over 20 seconds', async () => {
    await runCommercePass();
    expect(console.info).toHaveBeenCalledWith(expect.stringMatching(/pass: 1 groups, 0 skipped, 0 ran, 0 failed, \d+ ms/));

    runNextJob.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 20_001);
      return null;
    });
    await runCommercePass();
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/over the 20000 ms/));
  });

  it('rejects when the groups cannot be listed: the caller sees it', async () => {
    ensureCommerceBackstop.mockRejectedValue(new Error('the owner role'));
    await expect(runCommercePass()).rejects.toThrow('the owner role');
  });
});
