// What one import may cost, in input and in output. The input limits bound source,
// not what it expands to: 512 kilobytes of `const a=[...b,...b]` reaches billions of
// nodes, and a worker allocating without limit takes the whole tab down before any
// deadline. So one budget runs across all layers, in the worker and the command line
// tool alike, and every layer pays it before it allocates.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Untrusted input".

export const IMPORT_LIMITS = {
  files: 64,
  bytesPerFile: 512 * 1024,
  bytesInAll: 2 * 1024 * 1024,
  /** Deep enough for any real component. A bracket scan misses `!`, `a=>` and `a+a+...`, so the AST is what is measured. */
  astDepth: 256,
  evalDepth: 32,
  /** The render limit: an import a page could not render is not worth building. */
  outputNodes: 5_000,
  /** Nodes nested in the output, which inlining multiplies, so the source's own depth does not bound it. */
  outputDepth: 256,
  /** Markup visited, and statements read. A tree of fragments makes no node, and has to cost something. */
  conversionSteps: 100_000,
  evaluatedBytes: 4 * 1024 * 1024,
  unrolledItems: 5_000,
  inliningDepth: 16,
  /**
   * Beyond this, lines no node needs are folded into one, so the report stays total. A line that names a
   * node is never folded, since it can block placing: those are bounded by the evaluated budget instead,
   * at some 64,000 attributes, so a report can pass this figure.
   */
  reportLines: 5_000,
  /**
   * What a host gives one conversion, ending it from outside: `worker.terminate()` in the tab, a
   * `worker_threads` worker in the command line tool. Allocation can outrun it, which is why the budget
   * comes first, and a parser that hangs can only be ended this way.
   */
  deadlineMs: 20_000,
} as const;

export type BudgetLimit = 'nodes' | 'output-depth' | 'steps' | 'evaluated' | 'unrolled' | 'inlining-depth' | 'recursive-component';

/** Thrown by a charge. The one catch in `importSource` turns it into a `cap` line, and conversion stops. */
export class BudgetExceeded extends Error {
  constructor(readonly limit: BudgetLimit) {
    super(`over the import budget: ${limit}`);
    this.name = 'BudgetExceeded';
  }
}

export interface ImportBudget {
  /** Pays for output nodes, before they are built. */
  chargeNodes(count: number): void;
  /** Refuses a node nested deeper than the output may go. */
  checkOutputDepth(depth: number): void;
  /** Pays for work that makes no node. */
  chargeSteps(count: number): void;
  /** Pays for evaluated text and values, each time one is written. Sharing is no discount: `[b,b]` writes `b` out twice. */
  chargeEvaluated(bytes: number): void;
  /** Pays for items a loop unrolls to. */
  chargeUnrolled(count: number): void;
  /** Enters a component being inlined. Its own name on the stack is a cycle. Pair with `leaveComponent`. */
  enterComponent(name: string): void;
  leaveComponent(): void;
}

export function createImportBudget(): ImportBudget {
  let nodes = 0;
  let steps = 0;
  let evaluated = 0;
  let unrolled = 0;
  const inlining: string[] = [];
  return {
    chargeNodes(count) {
      nodes += count;
      if (nodes > IMPORT_LIMITS.outputNodes) throw new BudgetExceeded('nodes');
    },
    checkOutputDepth(depth) {
      if (depth >= IMPORT_LIMITS.outputDepth) throw new BudgetExceeded('output-depth');
    },
    chargeSteps(count) {
      steps += count;
      if (steps > IMPORT_LIMITS.conversionSteps) throw new BudgetExceeded('steps');
    },
    chargeEvaluated(bytes) {
      evaluated += bytes;
      if (evaluated > IMPORT_LIMITS.evaluatedBytes) throw new BudgetExceeded('evaluated');
    },
    chargeUnrolled(count) {
      unrolled += count;
      if (unrolled > IMPORT_LIMITS.unrolledItems) throw new BudgetExceeded('unrolled');
    },
    enterComponent(name) {
      if (inlining.includes(name)) throw new BudgetExceeded('recursive-component');
      if (inlining.length >= IMPORT_LIMITS.inliningDepth) throw new BudgetExceeded('inlining-depth');
      inlining.push(name);
    },
    leaveComponent() {
      inlining.pop();
    },
  };
}
