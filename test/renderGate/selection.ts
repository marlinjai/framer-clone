// Which probes and which engines one run of the render gate asks, so the same gate runs as a short
// deterministic form on a pull request, in parallel slices on main, and shuffled with a fresh seed at night
// (.github/workflows/ci.yml, ci-main.yml, ci-nightly.yml; scripts/ci/select-tests.mjs builds the matrix).
// With none of these set, a run asks every probe in every engine, in the order they are built, as before.
//
//   RENDER_GATE_ENGINES=chromium,webkit  only these engines (the files' own lists, narrowed)
//   RENDER_GATE_SEED=<integer>           shuffle the probes with this seed, so batches meet other neighbours
//   RENDER_GATE_SAMPLE=<0..1>            keep this share of the probes (after the shuffle; needs a seed)
//   RENDER_GATE_SLICE=<k>/<n>            keep every n-th probe from the k-th (1-based), for parallel runners
//
// A run prints what it asked (seed, sample, slice, counts), so a failure found with a fresh seed can be
// asked again exactly: the same four variables give the same probes in the same order.

export type Engine = 'chromium' | 'webkit' | 'firefox';

export interface Selection {
  engines?: Engine[];
  seed?: number;
  sample?: number;
  slice?: { index: number; count: number };
}

const ENGINES: readonly Engine[] = ['chromium', 'webkit', 'firefox'];

/** Reads the four variables; a malformed value is an error, never a silent "ask everything". */
export function readSelection(env: Record<string, string | undefined> = process.env): Selection {
  const out: Selection = {};
  if (env.RENDER_GATE_ENGINES) {
    const list = env.RENDER_GATE_ENGINES.split(',').map((name) => name.trim()).filter(Boolean);
    const unknown = list.filter((name) => !ENGINES.includes(name as Engine));
    if (unknown.length > 0 || list.length === 0) throw new Error(`RENDER_GATE_ENGINES names no engine it knows: ${env.RENDER_GATE_ENGINES}`);
    out.engines = list as Engine[];
  }
  if (env.RENDER_GATE_SEED) {
    const seed = Number(env.RENDER_GATE_SEED);
    if (!Number.isSafeInteger(seed)) throw new Error(`RENDER_GATE_SEED is not an integer: ${env.RENDER_GATE_SEED}`);
    out.seed = seed;
  }
  if (env.RENDER_GATE_SAMPLE) {
    const sample = Number(env.RENDER_GATE_SAMPLE);
    if (!(sample > 0 && sample <= 1)) throw new Error(`RENDER_GATE_SAMPLE is not a share above 0 and at most 1: ${env.RENDER_GATE_SAMPLE}`);
    if (out.seed === undefined) throw new Error('RENDER_GATE_SAMPLE needs RENDER_GATE_SEED, so the sample can be asked again');
    out.sample = sample;
  }
  if (env.RENDER_GATE_SLICE) {
    const match = /^(\d+)\/(\d+)$/.exec(env.RENDER_GATE_SLICE);
    const index = Number(match?.[1]);
    const count = Number(match?.[2]);
    if (!match || count < 1 || index < 1 || index > count) throw new Error(`RENDER_GATE_SLICE is not k/n with 1 <= k <= n: ${env.RENDER_GATE_SLICE}`);
    out.slice = { index, count };
  }
  return out;
}

/** mulberry32: small, fast and the same in every engine and Node version, which is all a shuffle needs. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The probes this run asks, in the order it asks them. */
export function selectProbes<T>(probes: readonly T[], selection: Selection): T[] {
  let list = [...probes];
  if (selection.seed !== undefined) {
    const next = random(selection.seed);
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  if (selection.sample !== undefined) list = list.slice(0, Math.max(1, Math.round(list.length * selection.sample)));
  if (selection.slice) {
    const { index, count } = selection.slice;
    list = list.filter((_, position) => position % count === index - 1);
  }
  return list;
}

/** The file's own engines, narrowed to RENDER_GATE_ENGINES; a file left with none skips its engine tests. */
export function selectEngines<T extends readonly [string, unknown]>(engines: readonly T[], selection: Selection): T[] {
  if (!selection.engines) return [...engines];
  return engines.filter(([name]) => selection.engines!.includes(name as Engine));
}

/** One line for the log: what was asked, so a fresh-seed finding can be asked again. */
export function describeSelection(selection: Selection, asked: number, of: number): string {
  const parts = [
    `${asked} of ${of} probes`,
    selection.seed !== undefined ? `RENDER_GATE_SEED=${selection.seed}` : 'built order',
    selection.sample !== undefined ? `RENDER_GATE_SAMPLE=${selection.sample}` : undefined,
    selection.slice ? `RENDER_GATE_SLICE=${selection.slice.index}/${selection.slice.count}` : undefined,
    selection.engines ? `RENDER_GATE_ENGINES=${selection.engines.join(',')}` : undefined,
  ];
  return parts.filter(Boolean).join(', ');
}

export const selection = readSelection();
