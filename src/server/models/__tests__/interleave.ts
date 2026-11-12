// A small deterministic scheduler that explores EVERY interleaving of the gated operations of several async actors
// (stateless model checking by replay). Each actor runs real code; every call to a shared port goes through `gate`, which
// parks the actor until the scheduler picks it. Runs are replayed with a recorded path and backtracked depth-first, so the
// whole tree of orderings is visited once. A crash can be injected at the n-th gated operation of one actor, before or
// after the operation takes effect.

export class Crash extends Error {
  constructor() { super('injected crash'); this.name = 'Crash'; }
}

export interface CrashPoint { actor: string; at: number; phase: 'before' | 'after' }

export interface Actor { name: string; run: (gate: Gate) => Promise<void> }
/** Performs `op` as one atomic step of the named actor, after the scheduler has chosen it. */
export type Gate = <T>(label: string, op: () => T | Promise<T>) => Promise<T>;

export interface RunTrace { order: string[]; crashed: string[]; errors: { actor: string; error: unknown }[] }

interface Parked { resume: () => void }

/** Runs the actors once along `path` (choice index at each step, default 0). Returns the trace and the branching seen. */
async function runOnce(actors: Actor[], path: number[], crash?: CrashPoint): Promise<{ trace: RunTrace; choices: number[] }> {
  const parked = new Map<string, Parked>();
  const finished = new Set<string>();
  const counts = new Map<string, number>();
  // A crashed actor is a dead process: its code may catch the injected error, but every later step it tries is refused too.
  const dead = new Set<string>();
  const trace: RunTrace = { order: [], crashed: [], errors: [] };
  let wake: (() => void) | null = null;
  const poke = () => { const w = wake; wake = null; w?.(); };

  const make = (a: Actor): Promise<void> => {
    const gate: Gate = async (label, op) => {
      if (dead.has(a.name)) throw new Crash();
      await new Promise<void>((resolve) => { parked.set(a.name, { resume: resolve }); poke(); });
      const n = (counts.get(a.name) ?? 0) + 1;
      counts.set(a.name, n);
      trace.order.push(`${a.name}:${label}`);
      if (crash && crash.actor === a.name && crash.at === n && crash.phase === 'before') { dead.add(a.name); throw new Crash(); }
      const out = await op();
      if (crash && crash.actor === a.name && crash.at === n && crash.phase === 'after') { dead.add(a.name); throw new Crash(); }
      return out;
    };
    return a.run(gate).catch((error) => {
      if (error instanceof Crash || dead.has(a.name)) trace.crashed.push(a.name);
      else trace.errors.push({ actor: a.name, error });
    }).finally(() => { finished.add(a.name); poke(); });
  };

  const all = actors.map(make);
  const choices: number[] = [];
  let step = 0;
  for (;;) {
    // Wait until every live actor is parked at a gate or finished.
    while (parked.size + finished.size < actors.length) await new Promise<void>((r) => { wake = r; });
    if (finished.size === actors.length) break;
    const ready = [...parked.keys()].sort();
    const pick = Math.min(path[step] ?? 0, ready.length - 1);
    choices.push(ready.length);
    step++;
    const name = ready[pick];
    const p = parked.get(name)!;
    parked.delete(name);
    p.resume();
    // The resumed actor now runs to its next gate or its end; the wait at the top of the loop sees it.
  }
  await Promise.all(all);
  return { trace, choices };
}

export interface ExploreResult { runs: number; violations: { trace: RunTrace; problem: string }[]; }

/**
 * Visits every interleaving. `build` creates a fresh world and its actors for each run; `check` inspects the world after
 * the run (and after any recovery it performs itself) and returns a problem description, or null.
 */
export async function explore<W>(
  build: () => { world: W; actors: Actor[] },
  check: (world: W, trace: RunTrace) => Promise<string | null> | string | null,
  opts: { crash?: CrashPoint; maxRuns?: number; stopAtFirstViolation?: boolean } = {},
): Promise<ExploreResult> {
  const result: ExploreResult = { runs: 0, violations: [] };
  let path: number[] = [];
  for (;;) {
    const { world, actors } = build();
    const { trace, choices } = await runOnce(actors, path, opts.crash);
    result.runs++;
    if (trace.errors.length) result.violations.push({ trace, problem: `actor error: ${String((trace.errors[0].error as Error)?.message ?? trace.errors[0].error)}` });
    else {
      const problem = await check(world, trace);
      if (problem) result.violations.push({ trace, problem });
    }
    if (opts.stopAtFirstViolation && result.violations.length) break;
    if (opts.maxRuns && result.runs >= opts.maxRuns) throw new Error(`exploration exceeded ${opts.maxRuns} runs`);
    // Backtrack: the deepest step that still has an unexplored choice.
    let i = choices.length - 1;
    const taken = [...path];
    while (taken.length < choices.length) taken.push(0);
    while (i >= 0 && (taken[i] ?? 0) + 1 >= choices[i]) i--;
    if (i < 0) break;
    path = taken.slice(0, i);
    path.push((taken[i] ?? 0) + 1);
  }
  return result;
}
