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
//
// A run may also keep a list of partial results while it is running (the page
// generator's preview sections), so a client that lost the stream rebuilds what
// it had already drawn: the running snapshot carries them, in the order sent.
// The list is dropped when the run finishes, the outcome replaces it.

export const JOB_LIMITS = {
  /** How long a finished run's outcome stays collectable. */
  finishedTtlMs: 15 * 60 * 1000,
  /** A run that never finished (a hung provider call) is dropped after this. */
  maxAgeMs: 30 * 60 * 1000,
  /** Runs kept per user (oldest finished ones are dropped first). */
  maxPerUser: 5,
} as const;

export type JobSnapshot<P, R, E, S = never> =
  | { status: 'running'; progress?: P; sections?: S[] }
  | { status: 'done'; result: R }
  | { status: 'failed'; error: E }
  | { status: 'cancelled' };

interface Job<P, R, E, S> {
  id: string;
  userId: string;
  workspaceId: string;
  createdAt: number;
  finishedAt?: number;
  state: JobSnapshot<P, R, E, S>;
  /** The partial results sent while running; emptied when the run finishes. */
  sections: S[];
  controller: AbortController;
}

export interface JobHandle<P, R, E, S = never> {
  id: string;
  /** Aborts when the run was cancelled explicitly (never on a disconnect). */
  signal: AbortSignal;
  progress(p: P): void;
  /** Keep one partial result for a client that collects the run (ignored once it finished). */
  section(s: S): void;
  succeed(result: R): void;
  fail(error: E): void;
}

export interface JobRegistry<P, R, E, S = never> {
  /** Whether any run (anyone's) holds this id: a client-chosen id must be new. */
  has(id: string, now?: number): boolean;
  create(owner: { id: string; userId: string; workspaceId: string }, now?: number): JobHandle<P, R, E, S>;
  /** The run's state, or undefined when it is unknown, expired or someone else's. */
  get(id: string, owner: { userId: string; workspaceId: string }, now?: number): JobSnapshot<P, R, E, S> | undefined;
  /** Stops a running run. False when it is unknown, expired or someone else's. */
  cancel(id: string, owner: { userId: string; workspaceId: string }, now?: number): boolean;
}

export function createJobRegistry<P, R, E, S = never>(limits: typeof JOB_LIMITS = JOB_LIMITS): JobRegistry<P, R, E, S> {
  const jobs = new Map<string, Job<P, R, E, S>>();

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

  const finish = (job: Job<P, R, E, S>, state: JobSnapshot<P, R, E, S>) => {
    // The first outcome wins: a result after a cancel is not collectable.
    if (job.state.status !== 'running') return;
    job.state = state;
    job.sections = [];
    job.finishedAt = Date.now();
  };

  /** What a client sees: a running run with the partial results kept so far. */
  const snapshotOf = (job: Job<P, R, E, S>): JobSnapshot<P, R, E, S> =>
    job.state.status === 'running' && job.sections.length > 0 ? { ...job.state, sections: [...job.sections] } : job.state;

  return {
    has(id, now = Date.now()) {
      sweep(now);
      return jobs.has(id);
    },
    create({ id, userId, workspaceId }, now = Date.now()) {
      sweep(now);
      const mine = [...jobs.values()]
        .filter((j) => j.userId === userId && j.finishedAt !== undefined)
        .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
      const total = [...jobs.values()].filter((j) => j.userId === userId).length;
      for (let i = 0; i < total + 1 - limits.maxPerUser && i < mine.length; i += 1) jobs.delete(mine[i].id);
      const job: Job<P, R, E, S> = {
        id,
        userId,
        workspaceId,
        createdAt: now,
        state: { status: 'running' },
        sections: [],
        controller: new AbortController(),
      };
      jobs.set(id, job);
      return {
        id,
        signal: job.controller.signal,
        progress: (p) => {
          if (job.state.status === 'running') job.state = { status: 'running', progress: p };
        },
        section: (s) => {
          if (job.state.status === 'running') job.sections.push(s);
        },
        succeed: (result) => finish(job, { status: 'done', result }),
        fail: (error) => finish(job, { status: 'failed', error }),
      };
    },
    get(id, owner, now = Date.now()) {
      sweep(now);
      const job = owned(id, owner);
      return job ? snapshotOf(job) : undefined;
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
