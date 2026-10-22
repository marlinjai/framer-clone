// src/lib/ai/pageGen/apply.ts
//
// Client-side half of page generation: turn a validated result (responsive maps
// keyed by breakpoint KEYS such as "desktop") into snapshots keyed by the
// page's real breakpoint ids, and describe how to undo an applied generation.
//
// The MST mutations themselves are actions on PageModel / ProjectModel
// (applyGeneratedNodes, revertGeneration, addGeneratedPage,
// removeGeneratedPage), so each apply and each revert is ONE action and
// therefore ONE HistoryStore entry: Cmd+Z reverts a whole generation in one step.

import type { ComponentSnapshotIn } from '@/models/ComponentModel';
import { BASE_KEY, deriveBreakpointKeys, type BreakpointInput } from './schema';
import type { GeneratedNodeSnapshot } from './validate';

/** A breakpoint as the editor has it: the input the route saw, plus its real id. */
export interface PageBreakpoint extends BreakpointInput {
  id: string;
}

/**
 * Map each breakpoint key the route derived back to the real breakpoint id.
 * Uses the same pure derivation (deriveBreakpointKeys) on the same input, so
 * the keys match exactly what the model was told.
 */
export function breakpointKeyMap(breakpoints: PageBreakpoint[]): Map<string, string> {
  const sorted = [...breakpoints].sort((a, b) => b.minWidth - a.minWidth);
  const keys = deriveBreakpointKeys(sorted.map(({ label, minWidth }) => ({ label, minWidth })));
  const map = new Map<string, string>();
  keys.forEach((k, i) => map.set(k.key, sorted[i].id));
  return map;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function remapStyle(style: Record<string, unknown>, keyMap: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(style)) {
    if (!isPlainObject(value)) {
      out[prop] = value;
      continue;
    }
    const map: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === BASE_KEY) map[BASE_KEY] = v;
      else {
        const id = keyMap.get(k);
        if (id) map[id] = v;
      }
    }
    out[prop] = map;
  }
  return out;
}

/** Re-key every responsive map in a generated subtree to real breakpoint ids. */
export function toEditorSnapshot(
  node: GeneratedNodeSnapshot,
  keyMap: Map<string, string>,
): ComponentSnapshotIn {
  const props = { ...node.props };
  if (isPlainObject(props.style)) props.style = remapStyle(props.style, keyMap);
  return {
    ...node,
    props,
    children: node.children.map((c) => toEditorSnapshot(c, keyMap)),
  } as ComponentSnapshotIn;
}

/** Everything needed to reverse one applied generation (kept by the dialog). */
export type GenerationUndoRecord =
  | { kind: 'newPage'; generationId: string; pageId: string; previousPageId?: string }
  | {
      kind: 'insert';
      generationId: string;
      pageId: string;
      parentId: string;
      insertedIds: string[];
    }
  | {
      kind: 'replace';
      generationId: string;
      pageId: string;
      parentId: string;
      index: number;
      previous: ComponentSnapshotIn;
      insertedIds: string[];
    }
  | {
      kind: 'replaceRootChildren';
      generationId: string;
      pageId: string;
      rootId: string;
      previousChildren: ComponentSnapshotIn[];
      insertedIds: string[];
    };

export type ApplyOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };
