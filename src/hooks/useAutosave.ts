// src/hooks/useAutosave.ts
//
// React access to the editor's autosave (src/lib/projects/autosave.ts):
//   - useAutosave: the Save button's hook. Watches the current project (never
//     the demo at `/`), warns before the page unloads while work is unsaved or
//     a save is in flight, and returns the controller and its state.
//   - useAutosaveState: the state only, for anything that shows it (the
//     generator's "Saved" line). Never watches the project itself.
'use client';

import React from 'react';
import {
  autosaveFor,
  existingAutosave,
  type AutosaveController,
  type AutosaveProject,
  type AutosaveState,
} from '@/lib/projects/autosave';

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
  const controller = enabled && project ? autosaveFor(project.id) : undefined;

  React.useEffect(() => {
    if (!controller || !project) return;
    controller.attach(project);
    return () => controller.detach(project);
  }, [controller, project]);

  React.useEffect(() => {
    if (!controller) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!controller.hasUnsavedWork()) return;
      // Both, for every browser: the wording is the browser's own.
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [controller]);

  return { controller, state: useControllerState(controller) };
}

/** The autosave state of a project the editor watches; "saved" when it watches none. */
export function useAutosaveState(projectId: string | undefined): AutosaveState {
  return useControllerState(existingAutosave(projectId));
}
