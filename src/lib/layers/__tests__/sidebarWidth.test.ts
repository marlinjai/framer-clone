// Left sidebar width: clamped to [220, 480], remembered per browser, and
// never broken by unusable storage.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  clampLeftSidebarWidth,
  loadLeftSidebarWidth,
  saveLeftSidebarWidth,
} from '../sidebarWidth';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('clampLeftSidebarWidth', () => {
  it('keeps the width between the minimum and the maximum, in whole pixels', () => {
    expect(clampLeftSidebarWidth(100)).toBe(LEFT_SIDEBAR_MIN_WIDTH);
    expect(clampLeftSidebarWidth(9999)).toBe(LEFT_SIDEBAR_MAX_WIDTH);
    expect(clampLeftSidebarWidth(300.6)).toBe(301);
  });

  it('falls back to the default for a non-number', () => {
    expect(clampLeftSidebarWidth(Number.NaN)).toBe(LEFT_SIDEBAR_DEFAULT_WIDTH);
    expect(clampLeftSidebarWidth(Number.POSITIVE_INFINITY)).toBe(LEFT_SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('remembering the width', () => {
  it('gives the default when nothing was saved', () => {
    expect(loadLeftSidebarWidth()).toBe(LEFT_SIDEBAR_DEFAULT_WIDTH);
  });

  it('saves and loads a width, clamped both ways', () => {
    saveLeftSidebarWidth(333);
    expect(loadLeftSidebarWidth()).toBe(333);
    saveLeftSidebarWidth(5000);
    expect(loadLeftSidebarWidth()).toBe(LEFT_SIDEBAR_MAX_WIDTH);
  });

  it('ignores garbage and out-of-range values written by hand', () => {
    window.localStorage.setItem('framer-clone:left-sidebar-width', 'wide');
    expect(loadLeftSidebarWidth()).toBe(LEFT_SIDEBAR_DEFAULT_WIDTH);
    window.localStorage.setItem('framer-clone:left-sidebar-width', '   ');
    expect(loadLeftSidebarWidth()).toBe(LEFT_SIDEBAR_DEFAULT_WIDTH);
    window.localStorage.setItem('framer-clone:left-sidebar-width', '10');
    expect(loadLeftSidebarWidth()).toBe(LEFT_SIDEBAR_MIN_WIDTH);
  });

  it('survives storage that throws (private mode, sandboxed frames)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => saveLeftSidebarWidth(300)).not.toThrow();
    expect(loadLeftSidebarWidth()).toBe(LEFT_SIDEBAR_DEFAULT_WIDTH);
  });
});
