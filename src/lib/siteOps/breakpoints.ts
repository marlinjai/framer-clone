// src/lib/siteOps/breakpoints.ts
//
// A page's breakpoints as the AI and the site operations name them: the real
// breakpoint id that responsive maps are keyed by, the viewport node that renders
// it, and the stable key the model and an agent write ("desktop", "phone"),
// largest first. One pure derivation (deriveBreakpointKeys) on the same input, so
// a key always maps back to the same id. Shared by the review pass
// (src/lib/ai/review/editorReview.ts) and the site operations; it imports no
// store, so it runs on the server as well.

import type { PageModelType } from '@/models/PageModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { BASE_KEY, deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';

export interface KeyedBreakpoint {
  /** The breakpoint id responsive maps are keyed by. */
  id: string;
  /** The viewport node that renders it (its frame's data-viewport-content-id). */
  viewportId: string;
  label: string;
  minWidth: number;
  /** The key the model and an agent use ("desktop", "phone"). */
  key: string;
}

/** The page's breakpoints, largest first, with their keys. */
export function keyedBreakpoints(page: PageModelType): KeyedBreakpoint[] {
  const frames = (page.viewportNodes as ComponentInstance[])
    .filter((v) => v.breakpointId)
    .map((v) => ({
      id: v.breakpointId as string,
      viewportId: v.id as string,
      label: (v.label as string | undefined) ?? '',
      minWidth: (v.breakpointMinWidth as number | undefined) ?? 0,
    }))
    .sort((a, b) => b.minWidth - a.minWidth);
  const keys = deriveBreakpointKeys(frames.map(({ label, minWidth }) => ({ label, minWidth })));
  return frames.map((f, i) => ({ ...f, key: keys[i].key }));
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * One responsive map re-keyed from breakpoint ids to keys; ids the page does not
 * know are left out. A value that is no responsive map comes back as it was.
 */
export function rekeyResponsive(value: unknown, idToKey: ReadonlyMap<string, string>): unknown {
  if (!isObj(value)) return value;
  const keys = Object.keys(value);
  if (!keys.some((k) => k === BASE_KEY || idToKey.has(k))) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === BASE_KEY) out[BASE_KEY] = v;
    else if (idToKey.has(k)) out[idToKey.get(k)!] = v;
  }
  return out;
}
