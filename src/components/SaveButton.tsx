// src/components/SaveButton.tsx
//
// The editor top-bar Save action (MT-10). The NON-DESTRUCTIVE sibling of
// PublishButton: it serializes the SAME live ProjectModel
// (`editorUI.currentProject`, which after MT-10 hydration IS the server-loaded
// project) and POSTs it to /api/projects/save (MT-04), which persists the
// working copy WITHOUT flipping the site's status. Saving a draft keeps it a
// draft; it never publishes.
//
// Outcomes surface LOUDLY and never silently no-op, mirroring PublishButton:
//   - in-flight: the button shows "Saving..." and is disabled,
//   - success: a brief confirmation (how many pages were saved),
//   - failure: the structured server error message (or a network-error
//     message), shown until the next attempt.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { getSnapshot } from 'mobx-state-tree';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/hooks/useStore';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

const SaveButton = observer(() => {
  const rootStore = useStore();
  const project = rootStore.editorUI.currentProject;
  const [state, setState] = React.useState<SaveState>({ kind: 'idle' });

  const save = React.useCallback(async () => {
    if (!project) {
      setState({ kind: 'error', message: 'No project to save.' });
      return;
    }
    setState({ kind: 'saving' });
    try {
      // The loaded project's own id rides inside the snapshot, so the save
      // targets exactly the project the editor is editing.
      const snapshot = getSnapshot(project);
      const res = await fetch('/api/projects/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: snapshot }),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          (payload as { error?: { message?: string } } | null)?.error?.message ??
          `Save failed (${res.status}).`;
        setState({ kind: 'error', message });
        return;
      }
      const saved = (payload as { savedPages?: unknown } | null)?.savedPages;
      const count = Array.isArray(saved) ? saved.length : 0;
      setState({
        kind: 'success',
        message: `Saved ${count} ${count === 1 ? 'page' : 'pages'}.`,
      });
    } catch (err) {
      setState({
        kind: 'error',
        message:
          err instanceof Error ? err.message : 'Network error while saving.',
      });
    }
  }, [project]);

  const saving = state.kind === 'saving';

  return (
    <div className="flex items-center gap-2 mr-2">
      {state.kind === 'success' && (
        <span
          role="status"
          aria-live="polite"
          className="text-xs text-muted-foreground max-w-[200px] truncate"
          title={state.message}
        >
          {state.message}
        </span>
      )}
      {state.kind === 'error' && (
        <span
          role="alert"
          className="text-xs text-destructive max-w-[200px] truncate"
          title={state.message}
        >
          {state.message}
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={save}
        disabled={saving}
        title="Save this project (does not publish)"
      >
        <Save size={16} />
        {saving ? 'Saving...' : 'Save'}
      </Button>
    </div>
  );
});

SaveButton.displayName = 'SaveButton';
export default SaveButton;
