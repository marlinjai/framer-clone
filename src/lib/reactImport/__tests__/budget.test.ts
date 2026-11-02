// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { BudgetExceeded, IMPORT_LIMITS, createImportBudget } from '../budget';

const limitOf = (run: () => void) => {
  try {
    run();
  } catch (error) {
    return error instanceof BudgetExceeded ? error.limit : 'other';
  }
  return undefined;
};

describe('the conversion budget', () => {
  it('holds the contract figures', () => {
    expect(IMPORT_LIMITS).toMatchObject({
      files: 64, bytesPerFile: 524_288, bytesInAll: 2_097_152, astDepth: 256, evalDepth: 32,
      outputNodes: 5_000, evaluatedBytes: 4_194_304, unrolledItems: 5_000, inliningDepth: 16, deadlineMs: 20_000,
    });
  });

  it('counts across charges, and lets the last one that fits through', () => {
    const budget = createImportBudget();
    budget.chargeNodes(IMPORT_LIMITS.outputNodes);
    expect(limitOf(() => budget.chargeNodes(1))).toBe('nodes');
  });

  it('keeps each measure apart', () => {
    const budget = createImportBudget();
    budget.chargeEvaluated(IMPORT_LIMITS.evaluatedBytes);
    budget.chargeUnrolled(IMPORT_LIMITS.unrolledItems);
    budget.chargeNodes(IMPORT_LIMITS.outputNodes);
    expect(limitOf(() => budget.chargeEvaluated(1))).toBe('evaluated');
    expect(limitOf(() => budget.chargeUnrolled(1))).toBe('unrolled');
  });

  it('sees a component on its own stack, and only there', () => {
    const budget = createImportBudget();
    budget.enterComponent('A');
    budget.enterComponent('B');
    expect(limitOf(() => budget.enterComponent('A'))).toBe('recursive-component');
    budget.leaveComponent();
    budget.enterComponent('B');
  });

  it('stops at 16 levels of different components', () => {
    const budget = createImportBudget();
    for (let i = 0; i < IMPORT_LIMITS.inliningDepth; i += 1) budget.enterComponent(`C${i}`);
    expect(limitOf(() => budget.enterComponent('Next'))).toBe('inlining-depth');
  });
});
