// src/lib/ai/jobRegistry.ts
//
// Keeps an AI run (a page generation, a layout review) alive and collectable
// after the browser that started it went away. A phone that switches to
// another app suspends the tab and drops the SSE connection; the run must
// carry on regardless, and the editor must be able to collect the outcome
// when it comes back (GET /api/ai/<route>/<id>), even after iOS discarded and
// reloaded the tab. So a run is stopped only by an explicit cancel (DELETE),
// never by a disconnect; cost stays bounded by the routes' attempt caps and
// per-user rate limits.
//
// Process-local (a Map in memory), like the rate limiters: framer-clone runs as
// one Coolify container, and a run that outlives a restart is lost anyway (the
// client then gets a 404 and says the run is gone). Finished runs are kept
// FINISHED_TTL_MS for collection, then swept.

export const JOB_LIMITS = {
  /** How long a finished run's outcome stays collectable. */
  finishedTtlMs: 15 * 60 * 1000,
  /** A run that never finished (a hung provider call) is dropped after this. */
  maxAgeMs: 30 * 60 * 1000,
  /** Runs kept per user (oldest finished ones are dropped first). */
  maxPerUser: 5,
} as const;

export type JobSnapshot<P, R, E> =
  | { status: 'running'; progress?: P }
  | { status: 'done'; result: R }
  | { status: 'failed'; error: E }
  | { status: 'cancelled' };

interface Job<P, R, E> {
  id: string;
  userId: string;
  workspaceId: string;
  createdAt: number;
  finishedAt?: number;
  state: JobSnapshot<P, R, E>;
  controller: AbortController;
}

export interface JobHandle<P, R, E> {
  id: string;
  /** Aborts when the run was cancelled explicitly (never on a disconnect). */
  signal: AbortSignal;
  progress(p: P): void;
  succeed(result: R): void;
  fail(error: E): void;
}

export interface JobRegistry<P, R, E> {
  create(owner: { id: string; userId: string; workspaceId: string }, now?: number): JobHandle<P, R, E>;
  /** The run's state, or undefined when it is unknown, expired or someone else's. */
  get(id: string, owner: { userId: string; workspaceId: string }, now?: number): JobSnapshot<P, R, E> | undefined;
  /** Stops a running run. False when it is unknown, expired or someone else's. */
  cancel(id: string, owner: { userId: string; workspaceId: string }, now?: number): boolean;
}

export function createJobRegistry<P, R, E>(limits: typeof JOB_LIMITS = JOB_LIMITS): JobRegistry<P, R, E> {
  const jobs = new Map<string, Job<P, R, E>>();

  const sweep = (now: number) => {
    for (const [id, job] of jobs) {
      const expired =
        job.finishedAt !== undefined ? now - job.finishedAt > limits.finishedTtlMs : now - job.createdAt > limits.maxAgeMs;
      if (expired) {
        if (job.state.status === 'running') job.controller.abort();
        jobs.delete(id);
      }
    }
  };

  const owned = (id: string, owner: { userId: string; workspaceId: string }) => {
    const job = jobs.get(id);
    return job && job.userId === owner.userId && job.workspaceId === owner.workspaceId ? job : undefined;
  };

  const finish = (job: Job<P, R, E>, state: JobSnapshot<P, R, E>) => {
    // The first outcome wins: a result after a cancel is not collectable.
    if (job.state.status !== 'running') return;
    job.state = state;
    job.finishedAt = Date.now();
  };

  return {
    create({ id, userId, workspaceId }, now = Date.now()) {
      sweep(now);
      const mine = [...jobs.values()]
        .filter((j) => j.userId === userId && j.finishedAt !== undefined)
        .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
      const total = [...jobs.values()].filter((j) => j.userId === userId).length;
      for (let i = 0; i < total + 1 - limits.maxPerUser && i < mine.length; i += 1) jobs.delete(mine[i].id);
      const job: Job<P, R, E> = {
        id,
        userId,
        workspaceId,
        createdAt: now,
        state: { status: 'running' },
        controller: new AbortController(),
      };
      jobs.set(id, job);
      return {
        id,
        signal: job.controller.signal,
        progress: (p) => {
          if (job.state.status === 'running') job.state = { status: 'running', progress: p };
        },
        succeed: (result) => finish(job, { status: 'done', result }),
        fail: (error) => finish(job, { status: 'failed', error }),
      };
    },
    get(id, owner, now = Date.now()) {
      sweep(now);
      return owned(id, owner)?.state;
    },
    cancel(id, owner, now = Date.now()) {
      sweep(now);
      const job = owned(id, owner);
      if (!job) return false;
      if (job.state.status === 'running') {
        finish(job, { status: 'cancelled' });
        job.controller.abort();
      }
      return true;
    },
  };
}
