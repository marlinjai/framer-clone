// The three breakpoints every page starts with, apart from the published document,
// so a script that only needs the widths (test/score/busbasis/rebuild.ts, run by tsx)
// does not load the site layout, which may only be imported on the server.

import type { BreakpointRef } from '@/lib/responsive/cascade';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';

/** The three breakpoints every page starts with (DEFAULT_VIEWPORTS), plus the frame width each is shown at. */
export const BREAKPOINTS: readonly (BreakpointRef & { label: string; width: number; height: number })[] =
  DEFAULT_VIEWPORTS.map((v) => ({
    id: v.label.toLowerCase(),
    minWidth: v.minWidth,
    label: v.label,
    width: v.width,
    height: v.height,
  }));
