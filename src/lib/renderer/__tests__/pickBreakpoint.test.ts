import { describe, it, expect } from 'vitest';
import { pickBreakpointForWidth } from '../pickBreakpoint';

const desktop = { breakpointId: 'bp-desktop', breakpointMinWidth: 1280 };
const tablet  = { breakpointId: 'bp-tablet',  breakpointMinWidth: 768 };
const mobile  = { breakpointId: 'bp-mobile',  breakpointMinWidth: 320 };
const all = [desktop, tablet, mobile];

describe('pickBreakpointForWidth', () => {
  it('returns undefined for an empty viewport list', () => {
    expect(pickBreakpointForWidth([], 1024)).toBeUndefined();
  });

  it('ignores viewports missing breakpointId or minWidth', () => {
    expect(
      pickBreakpointForWidth(
        [{ breakpointId: 'orphan' }, { breakpointMinWidth: 999 }],
        500,
      ),
    ).toBeUndefined();
  });

  it('returns the only breakpoint when there is just one', () => {
    expect(pickBreakpointForWidth([desktop], 9999)).toBe('bp-desktop');
    expect(pickBreakpointForWidth([desktop], 100)).toBe('bp-desktop');
  });

  it('picks the largest breakpoint whose minWidth <= width', () => {
    expect(pickBreakpointForWidth(all, 1500)).toBe('bp-desktop');
    expect(pickBreakpointForWidth(all, 1280)).toBe('bp-desktop'); // exact match
    expect(pickBreakpointForWidth(all, 1000)).toBe('bp-tablet');
    expect(pickBreakpointForWidth(all,  768)).toBe('bp-tablet');  // exact match
    expect(pickBreakpointForWidth(all,  500)).toBe('bp-mobile');
    expect(pickBreakpointForWidth(all,  320)).toBe('bp-mobile');  // exact match
  });

  it('falls back to the smallest breakpoint when width is below all minWidths', () => {
    expect(pickBreakpointForWidth(all, 200)).toBe('bp-mobile');
    expect(pickBreakpointForWidth(all, 0)).toBe('bp-mobile');
  });

  it('is order-independent', () => {
    const reversed = [mobile, tablet, desktop];
    expect(pickBreakpointForWidth(reversed, 1000)).toBe('bp-tablet');
    expect(pickBreakpointForWidth(reversed, 1500)).toBe('bp-desktop');
  });
});
