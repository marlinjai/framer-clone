// src/lib/keyBindings.ts
//
// Central registry of keyboard shortcuts. Each action owns a list of bindings
// so a future Settings page can let the user rebind without touching the
// dispatcher. The runtime contract: EditorApp installs a single window keydown
// listener, matches the incoming event against every binding, and invokes the
// first action whose `matches` returns true.
//
// Kept deliberately tiny. When the Settings page ships, swap `DEFAULT_BINDINGS`
// for a MobX-observable map read from persisted user config.

export type KeyBindingActionId = 'delete' | 'undo' | 'redo';

// Descriptor for a single key combo. Modifier keys are normalised across macOS
// (Cmd) and other platforms (Ctrl) via `primary: true` — the matcher treats
// either metaKey or ctrlKey as the primary modifier.
export interface KeyBinding {
  key: string;                  // KeyboardEvent.key, case-insensitive compare
  primary?: boolean;            // requires Cmd on mac / Ctrl elsewhere
  shift?: boolean;              // requires Shift
  alt?: boolean;                // requires Alt / Option
  // When true, the shortcut still fires while the user is typing in an input
  // or contenteditable. Default false — typing must not trigger editor actions.
  allowInEditable?: boolean;
}

export interface KeyBindingDefinition {
  action: KeyBindingActionId;
  label: string;                // Displayed in settings UI / button tooltips
  bindings: KeyBinding[];       // Multiple combos per action (e.g. Delete + Backspace)
}

export const DEFAULT_BINDINGS: KeyBindingDefinition[] = [
  {
    action: 'delete',
    label: 'Delete selected component',
    bindings: [
      { key: 'Backspace' },
      { key: 'Delete' },
    ],
  },
  {
    action: 'undo',
    label: 'Undo',
    bindings: [
      { key: 'z', primary: true },
    ],
  },
  {
    action: 'redo',
    label: 'Redo',
    bindings: [
      { key: 'z', primary: true, shift: true },
      // Windows-style alternative:
      { key: 'y', primary: true },
    ],
  },
];

export function matchesBinding(event: KeyboardEvent, binding: KeyBinding): boolean {
  if (event.key.toLowerCase() !== binding.key.toLowerCase()) return false;

  const primary = event.metaKey || event.ctrlKey;
  if (!!binding.primary !== primary) return false;
  if (!!binding.shift !== event.shiftKey) return false;
  if (!!binding.alt !== event.altKey) return false;
  return true;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

// Match an event against the full registry. Returns the first action whose
// binding matches, or null. Callers are responsible for the editable-target
// guard: pass `allowInEditable` on a binding only when typing should still
// trigger it (none today).
export function resolveAction(
  event: KeyboardEvent,
  bindings: KeyBindingDefinition[] = DEFAULT_BINDINGS,
): { action: KeyBindingActionId; binding: KeyBinding } | null {
  const inEditable = isEditableTarget(event.target);
  for (const def of bindings) {
    for (const b of def.bindings) {
      if (inEditable && !b.allowInEditable) continue;
      if (matchesBinding(event, b)) return { action: def.action, binding: b };
    }
  }
  return null;
}
