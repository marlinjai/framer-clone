// src/lib/projects/saveShortcut.ts
//
// Cmd/Ctrl+S in the editor (plan docs/plans/2026-11-04-editor-autosave.md).
// The editor saves by itself and has no Save button; the shortcut saves at
// once instead of after the debounce (AutosaveController.flush: after a
// failure it tries again, while the version lock's refusal stands it reopens
// the dialog). It always keeps the browser's "save page" dialog from opening,
// also while typing in a field, and shows nothing of its own: the top bar's
// save status says what happens. The demo at `/` has no server copy, so
// there it only swallows the key (its status offers "Keep as project").
//
// EditorApp's single keydown dispatcher calls this first, before its drag and
// preview guards.

import { resolveAction } from '@/lib/keyBindings';
import { existingAutosave } from './autosave';

export interface SaveShortcutUI {
  readonly isUnsavedDemo?: boolean;
  readonly currentProject?: { readonly id: string } | undefined;
}

/** Handle Cmd/Ctrl+S; answers true when the event was the shortcut. */
export function handleSaveShortcut(event: KeyboardEvent, ui: SaveShortcutUI): boolean {
  if (resolveAction(event)?.action !== 'save') return false;
  event.preventDefault();
  if (!ui.isUnsavedDemo) void existingAutosave(ui.currentProject?.id)?.flush();
  return true;
}
