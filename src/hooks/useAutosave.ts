// src/hooks/useAutosave.ts
//
// React access to the editor's autosave (src/lib/projects/autosave.ts, plan
// docs/plans/2026-11-04-editor-autosave.md):
//   - useAutosave: the top bar's save status (SaveStatus). Watches the current
//     project (never the demo at `/`) and returns the controller and its state.
//     The controller is created in an effect, never during a render.
//   - useAutosaveState: the state only, for anything else that shows it (the
//     generator's "Saved" line). Never watches the project itself.
//   - useSaveStatusLabel: the one wording of a state, shared by the top bar and
//     the generator so the two always agree. It is calm: "Saving..." appears
//     only when a save takes longer than SAVING_LABEL_DELAY_MS; a quicker one
//     goes straight from the previous word to "Saved".
// The unload warning is not here: UnsavedWorkGuard asks every project of the
// tab (src/components/UnsavedWorkGuard.tsx).
'use client';

import React from 'react';
import {
  AUTOSAVE_RETRY_LIMIT_MS,
  autosaveFor,
  autosaveRegistryVersion,
  existingAutosave,
  subscribeAutosaveRegistry,
  type AutosaveController,
  type AutosaveProject,
  type AutosaveState,
} from '@/lib/projects/autosave';
import { PROJECT_BODY_MAX_BYTES } from '@/lib/api/respond';

/** A save quicker than this never shows "Saving...". */
export const SAVING_LABEL_DELAY_MS = 300;

const SAVED: AutosaveState = { phase: 'saved' };
const noSubscribe = () => () => {};
const savedState = () => SAVED;

function useControllerState(controller: AutosaveController | undefined): AutosaveState {
  return React.useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getState ?? savedState,
    controller?.getState ?? savedState,
  );
}

export function useAutosave(
  project: AutosaveProject | undefined,
  enabled: boolean,
): { controller: AutosaveController | undefined; state: AutosaveState } {
  const [controller, setController] = React.useState<AutosaveController | undefined>(undefined);
  const projectId = enabled && project ? project.id : undefined;

  React.useEffect(() => {
    if (!projectId || !project) {
      setController(undefined);
      return;
    }
    const next = autosaveFor(projectId);
    next.attach(project);
    setController(next);
    return () => next.detach(project);
  }, [projectId, project]);

  const current = controller && controller.projectId === projectId ? controller : undefined;
  return { controller: current, state: useControllerState(current) };
}

/** The autosave state of a project the editor watches; "saved" when it watches none. */
export function useAutosaveState(projectId: string | undefined): AutosaveState {
  // The controller may be created after this mounts (the top bar's effect).
  React.useSyncExternalStore(subscribeAutosaveRegistry, autosaveRegistryVersion, autosaveRegistryVersion);
  return useControllerState(existingAutosave(projectId));
}

/** True while a request of this state is out (a save, or "Save mine over it"). */
export function isSaving(state: AutosaveState): boolean {
  return state.phase === 'saving' || (state.phase === 'conflict' && state.retrying);
}

/** The word for a settled state (none while a request is out). */
function settledLabel(state: AutosaveState): string | undefined {
  switch (state.phase) {
    case 'saved':
      return 'Saved';
    case 'unsaved':
      return 'Unsaved changes';
    case 'publishing':
      return 'Publishing...';
    case 'retrying':
    case 'failed':
      return 'Not saved';
    case 'conflict':
      return state.retrying ? undefined : 'Changed elsewhere';
    default:
      return undefined;
  }
}

/** The status word, with "Saving..." held back for SAVING_LABEL_DELAY_MS. */
export function useSaveStatusLabel(state: AutosaveState): string {
  const saving = isSaving(state);
  const [late, setLate] = React.useState(false);
  React.useEffect(() => {
    if (!saving) return;
    const timer = window.setTimeout(() => setLate(true), SAVING_LABEL_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      setLate(false);
    };
  }, [saving]);

  const settled = settledLabel(state);
  // The word shown before the request went out, kept while it is quick.
  const [before, setBefore] = React.useState(settled ?? 'Unsaved changes');
  if (settled !== undefined && settled !== before) setBefore(settled);
  if (settled !== undefined) return settled;
  return late ? 'Saving...' : before;
}

const MEGABYTES = Math.round(PROJECT_BODY_MAX_BYTES / (1024 * 1024));

/**
 * Why a save failed, as something to act on: the server's reason, with what
 * to do for the refusals a person can fix. Undefined when nothing failed.
 */
export function saveFailureReason(state: AutosaveState): string | undefined {
  if (state.phase !== 'failed' && state.phase !== 'retrying') return undefined;
  const reason = /[.!?]$/.test(state.message.trim()) ? state.message.trim() : `${state.message.trim()}.`;
  if (state.status === 401) return 'You are signed out. Sign in again in a new tab, then Retry.';
  if (state.status === 403) return `${reason} You do not have permission to change this project. Ask an owner of the company for access.`;
  if (state.status === 413) {
    return `This project is larger than the ${MEGABYTES} MB a save can take. Remove large embedded content (pasted images, long embedded code or videos), then Retry.`;
  }
  if (state.phase === 'retrying') {
    const seconds = Math.max(1, Math.round((state.retryAt - Date.now()) / 1000));
    return `${reason} Trying again in ${seconds} s.`;
  }
  if (state.retriesStopped) return `${reason} Automatic retries stopped after ${Math.round(AUTOSAVE_RETRY_LIMIT_MS / 60_000)} minutes. Retry when the connection is back.`;
  return reason;
}
