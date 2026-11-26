'use client';

// src/components/customCode/CustomCodeAuthoring.tsx
//
// What the editor knows about writing custom code for the open site (plan
// docs/plans/2026-11-02-sandboxed-custom-code.md, slice C4, D99 to D110):
//
//   - `available`: the server's CUSTOM_CODE_AVAILABLE, handed down by the editor page as
//     a boolean (never read from process.env in the client bundle);
//   - the site's status from the route (switched on, a branch, may this person write,
//     does this server serve blocks, the limits), read once the switch is on;
//   - which blocks show their fallback on the canvas instead of the tile (D110), editor
//     state only, never stored;
//   - each block's unsaved draft in the Custom code section, kept while another element is
//     selected (review 1 of #459, L3), for this editor session only;
//   - each block's running save and how it ended (review 2 of #459, M1): the section is rebuilt
//     when another element is selected, and a save outlives it, so a section that comes back
//     mid-save stays locked and then says how the save ended, with the code the save wrote;
//   - the polite live region the section speaks through, which exists before any section does,
//     so a sentence set when a section opens is a change a screen reader announces (R2-L1).
//
// Without the provider (the browser-only demo at `/`, the tests' harness) the context
// says unavailable, and nothing reads the route.

import React from 'react';
import type { CustomCodeDeclaration } from '@/lib/customCode/contract';
import { fetchCustomCodeStatus, type CustomCodeStatus } from './customCodeClient';

export type CustomCodeStatusState =
  | { phase: 'off' }
  | { phase: 'loading' }
  | { phase: 'ready'; status: CustomCodeStatus }
  | { phase: 'failed'; message: string };

/** A block's save as the provider keeps it, beyond the life of the section that started it. */
export interface CustomCodeSaveRecord {
  running: boolean;
  /** The stored value the save itself wrote, so the section does not report it as someone else's change. */
  ownWrite: string | null;
  /**
   * The code the save wrote, under the stored value that names it, until a section holds it: the
   * copy on screen when the value arrives may not be the one that saved, and it shows this at once
   * instead of reading it back behind an empty field.
   */
  written: { key: string; value: { phase: 'ready'; document: string; declaration: CustomCodeDeclaration; blocked?: boolean } } | null;
  /** How the save ended, shown once by the section, then cleared. */
  outcome: { kind: 'done' | 'refused'; message: string } | null;
}

export interface CustomCodeAuthoringValue {
  available: boolean;
  projectId: string | null;
  state: CustomCodeStatusState;
  /** Reads the status again (after a save, or the person's Retry). */
  reload: () => void;
  fallbackShown: ReadonlySet<string>;
  setFallbackShown: (nodeId: string, shown: boolean) => void;
  /** A block's unsaved draft, as the section left it when another element was selected. */
  draftOf: (nodeId: string) => unknown;
  /** Keeps (or, with null, forgets) a block's draft. Not state: nothing renders from it. */
  keepDraft: (nodeId: string, draft: unknown) => void;
  /** A block's save record, for rendering. */
  saveOf: (nodeId: string) => CustomCodeSaveRecord | undefined;
  /** The record as it is this instant, outside rendering (a keystroke right after Save). */
  saveNow: (nodeId: string) => CustomCodeSaveRecord | undefined;
  updateSave: (nodeId: string, patch: Partial<CustomCodeSaveRecord>) => void;
  /** Says a sentence in the polite live region. */
  announce: (text: string) => void;
}

const NOTHING: ReadonlySet<string> = new Set();

export const CustomCodeAuthoringContext = React.createContext<CustomCodeAuthoringValue>({
  available: false,
  projectId: null,
  state: { phase: 'off' },
  reload: () => {},
  fallbackShown: NOTHING,
  setFallbackShown: () => {},
  draftOf: () => null,
  keepDraft: () => {},
  saveOf: () => undefined,
  saveNow: () => undefined,
  updateSave: () => {},
  announce: () => {},
});

const NO_SAVE: CustomCodeSaveRecord = { running: false, ownWrite: null, written: null, outcome: null };

export function useCustomCodeAuthoring(): CustomCodeAuthoringValue {
  return React.useContext(CustomCodeAuthoringContext);
}

/** True when the insert item may show: switched on, the site enabled, this person may write, and not a branch (D101). */
export function canInsertCustomCode(value: CustomCodeAuthoringValue): boolean {
  return value.available && value.state.phase === 'ready' && value.state.status.enabled && value.state.status.canManage && !value.state.status.branch;
}

export function CustomCodeAuthoringProvider({ available, projectId, children }: { available: boolean; projectId: string | null; children: React.ReactNode }) {
  const [state, setState] = React.useState<CustomCodeStatusState>(available && projectId ? { phase: 'loading' } : { phase: 'off' });
  const [fallbackShown, setShown] = React.useState<ReadonlySet<string>>(NOTHING);
  const [generation, setGeneration] = React.useState(0);
  const drafts = React.useRef(new Map<string, unknown>());
  const savesNow = React.useRef(new Map<string, CustomCodeSaveRecord>());
  const [saves, setSaves] = React.useState<ReadonlyMap<string, CustomCodeSaveRecord>>(new Map());
  const [spoken, setSpoken] = React.useState('');
  const saveOf = React.useCallback((nodeId: string) => saves.get(nodeId), [saves]);
  const saveNow = React.useCallback((nodeId: string) => savesNow.current.get(nodeId), []);
  const updateSave = React.useCallback((nodeId: string, patch: Partial<CustomCodeSaveRecord>) => {
    const next = { ...(savesNow.current.get(nodeId) ?? NO_SAVE), ...patch };
    savesNow.current.set(nodeId, next);
    setSaves(new Map(savesNow.current));
  }, []);
  // The same sentence twice is still a change for the region: a no-break space tells them apart.
  const announce = React.useCallback((text: string) => setSpoken((previous) => (previous === text ? `${text}\u00a0` : text)), []);
  const draftOf = React.useCallback((nodeId: string) => drafts.current.get(nodeId) ?? null, []);
  const keepDraft = React.useCallback((nodeId: string, draft: unknown) => {
    if (draft === null || draft === undefined) drafts.current.delete(nodeId);
    else drafts.current.set(nodeId, draft);
  }, []);

  React.useEffect(() => {
    if (!available || !projectId) {
      setState({ phase: 'off' });
      return;
    }
    let live = true;
    // Keeps what it had while it reads again, so a reload after a save does not flash "loading".
    setState((previous) => (previous.phase === 'ready' ? previous : { phase: 'loading' }));
    void fetchCustomCodeStatus(projectId).then((result) => {
      if (!live) return;
      setState(result.ok ? { phase: 'ready', status: result.value } : { phase: 'failed', message: result.message });
    });
    return () => {
      live = false;
    };
  }, [available, projectId, generation]);

  const reload = React.useCallback(() => setGeneration((n) => n + 1), []);
  const setFallbackShown = React.useCallback((nodeId: string, shown: boolean) => {
    setShown((previous) => {
      if (previous.has(nodeId) === shown) return previous;
      const next = new Set(previous);
      if (shown) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });
  }, []);

  const value = React.useMemo<CustomCodeAuthoringValue>(
    () => ({ available, projectId, state, reload, fallbackShown, setFallbackShown, draftOf, keepDraft, saveOf, saveNow, updateSave, announce }),
    [available, projectId, state, reload, fallbackShown, setFallbackShown, draftOf, keepDraft, saveOf, saveNow, updateSave, announce],
  );
  return (
    <CustomCodeAuthoringContext.Provider value={value}>
      {children}
      <p className="sr-only" role="status" aria-live="polite" data-custom-code-announcement="">{spoken}</p>
    </CustomCodeAuthoringContext.Provider>
  );
}
