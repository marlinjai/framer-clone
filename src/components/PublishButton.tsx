// src/components/PublishButton.tsx
//
// The editor top-bar Publish action. Serializes the live ProjectModel to a
// snapshot and POSTs it to the admin-guarded /api/projects/publish endpoint,
// which persists it and flips the site to `published`.
//
// Outcomes surface LOUDLY and never silently no-op:
//   - in-flight: the button shows "Publishing..." and is disabled,
//   - success: a brief confirmation (how many pages went live),
//   - failure: the structured server error message (or a network-error
//     message), shown until the next attempt.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { getSnapshot } from 'mobx-state-tree';
import { UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/hooks/useStore';

type PublishState =
  | { kind: 'idle' }
  | { kind: 'publishing' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

const PublishButton = observer(() => {
  const rootStore = useStore();
  const project = rootStore.editorUI.currentProject;
  const [state, setState] = React.useState<PublishState>({ kind: 'idle' });

  const publish = React.useCallback(async () => {
    if (!project) {
      setState({ kind: 'error', message: 'No project to publish.' });
      return;
    }
    setState({ kind: 'publishing' });
    try {
      const snapshot = getSnapshot(project);
      const res = await fetch('/api/projects/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: snapshot }),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          (payload as { error?: { message?: string } } | null)?.error?.message ??
          `Publish failed (${res.status}).`;
        setState({ kind: 'error', message });
        return;
      }
      const published = (payload as { publishedPages?: unknown } | null)
        ?.publishedPages;
      const count = Array.isArray(published) ? published.length : 0;
      setState({
        kind: 'success',
        message: `Published ${count} ${count === 1 ? 'page' : 'pages'}.`,
      });
    } catch (err) {
      setState({
        kind: 'error',
        message:
          err instanceof Error ? err.message : 'Network error while publishing.',
      });
    }
  }, [project]);

  const publishing = state.kind === 'publishing';

  return (
    <div className="flex items-center gap-2 mr-2">
      {state.kind === 'success' && (
        <span
          role="status"
          aria-live="polite"
          className="text-xs text-brand max-w-[200px] truncate"
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
        variant="brand"
        size="sm"
        onClick={publish}
        disabled={publishing}
        title="Publish this site"
      >
        <UploadCloud size={16} />
        {publishing ? 'Publishing...' : 'Publish'}
      </Button>
    </div>
  );
});

PublishButton.displayName = 'PublishButton';
export default PublishButton;
