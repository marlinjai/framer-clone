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
// It listens in the CAPTURE phase on the window (installSaveShortcut): the
// canvas's inline text editor, the panel's text field and the component
// dialogs stop every keydown from bubbling, and the browser's dialog would
// open there. Text still being typed in those fields is committed first
// (openDrafts.ts), so the save carries it. When an agent's newer copy was held
// for that typing (src/lib/projects/liveSync.ts), the live sync looks at it
// before the save goes out (settleHeldEdit): the edit is replayed on top of the
// agent's copy and saved on its version, instead of a save on the old version
// that would be refused.

import { resolveAction } from '@/lib/keyBindings';
import { existingAutosave } from './autosave';
import { commitOpenDrafts } from './openDrafts';
import { liveSyncFor } from './liveSync';

export interface SaveShortcutUI {
  readonly isUnsavedDemo?: boolean;
  readonly currentProject?: { readonly id: string } | undefined;
}

/** Handle Cmd/Ctrl+S; answers true when the event was the shortcut. */
export function handleSaveShortcut(event: KeyboardEvent, ui: SaveShortcutUI): boolean {
  if (resolveAction(event)?.action !== 'save') return false;
  event.preventDefault();
  commitOpenDrafts();
  if (ui.isUnsavedDemo) return true;
  liveSyncFor(ui.currentProject?.id)?.settleHeldEdit();
  void existingAutosave(ui.currentProject?.id)?.flush();
  return true;
}

/** Listen for Cmd/Ctrl+S before any field can stop the key; answers the removal. */
export function installSaveShortcut(target: Window, ui: SaveShortcutUI): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    handleSaveShortcut(event, ui);
  };
  target.addEventListener('keydown', onKeyDown, true);
  return () => target.removeEventListener('keydown', onKeyDown, true);
}
