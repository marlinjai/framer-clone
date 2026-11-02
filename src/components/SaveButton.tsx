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
//   - conflict: the project was saved somewhere else since this tab loaded it
//     (409 `site_changed`, the version lock): SiteChangedDialog asks whether to
//     load the newer version, save this one over it, or keep both,
//   - failure: the structured server error message (or a network-error
//     message), shown until the next attempt.
// There is no autosave: every write is a click, so a refusal never loops.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { getSnapshot } from 'mobx-state-tree';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/hooks/useStore';
import { knownServerVersion, markServerVersion, type ProjectContent } from '@/stores/openProject';
import { postProjectWrite } from '@/lib/projects/projectWrite';
import SaveAsNewProjectDialog from './SaveAsNewProjectDialog';
import SiteChangedDialog from './SiteChangedDialog';
import { TopBarStatus } from './TopBarStatus';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }
  // Refused by the version lock: the server is at `currentVersion`.
  | { kind: 'conflict'; currentVersion: number; retrying: boolean };

const SaveButton = observer(() => {
  const rootStore = useStore();
  const project = rootStore.editorUI.currentProject;
  const isUnsavedDemo = rootStore.editorUI.isUnsavedDemo === true;
  const [state, setState] = React.useState<SaveState>({ kind: 'idle' });
  const [saveAsOpen, setSaveAsOpen] = React.useState(false);

  // `overVersion`: save over the server's copy on purpose ("Save mine over it"),
  // naming the version the refusal reported. Otherwise the version this tab's
  // copy is based on.
  const save = React.useCallback(async (overVersion?: number) => {
    if (!project) {
      setState({ kind: 'error', message: 'No project to save.' });
      return;
    }
    // The demo editor at `/` builds its project in the browser; no company
    // holds it yet: Save offers to make it a project of its own.
    if (isUnsavedDemo) {
      setState({ kind: 'idle' });
      setSaveAsOpen(true);
      return;
    }
    setState((prev) =>
      overVersion !== undefined && prev.kind === 'conflict' ? { ...prev, retrying: true } : { kind: 'saving' },
    );
    // The loaded project's own id rides inside the snapshot, so the save
    // targets exactly the project the editor is editing.
    const snapshot = getSnapshot(project);
    const result = await postProjectWrite(
      '/api/projects/save',
      snapshot,
      overVersion ?? knownServerVersion(project.id),
      'Save failed',
    );
    if (result.kind === 'conflict') {
      setState({ kind: 'conflict', currentVersion: result.currentVersion, retrying: false });
      return;
    }
    if (result.kind === 'error') {
      setState({ kind: 'error', message: result.message });
      return;
    }
    // The server now holds exactly this project, at this version (see openProject).
    markServerVersion(project.id, snapshot as ProjectContent, result.version);
    const saved = result.payload.savedPages;
    const count = Array.isArray(saved) ? saved.length : 0;
    setState({
      kind: 'success',
      message: `Saved ${count} ${count === 1 ? 'page' : 'pages'}.`,
    });
  }, [project, isUnsavedDemo]);

  const saving = state.kind === 'saving' || (state.kind === 'conflict' && state.retrying);

  return (
    <div className="flex items-center gap-2 mr-1 lg:mr-2">
      {(state.kind === 'success' || state.kind === 'error') && (
        <TopBarStatus kind={state.kind} title={state.message} onDismiss={() => setState({ kind: 'idle' })}>
          <span className="lg:truncate">{state.message}</span>
        </TopBarStatus>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void save()}
        disabled={saving}
        title="Save this project (does not publish)"
      >
        <Save size={16} />
        {/* Icon only on a phone; the label stays the button's name. */}
        <span className="max-sm:sr-only">{saving ? 'Saving...' : 'Save'}</span>
      </Button>
      {/* The demo's Save, or the conflict's "keep both" choice (mounted only while asked for). */}
      {project && (isUnsavedDemo || saveAsOpen) ? (
        <SaveAsNewProjectDialog
          open={saveAsOpen}
          onOpenChange={setSaveAsOpen}
          defaultName={isUnsavedDemo ? project.metadata.title || 'Untitled Project' : `${project.metadata.title || 'Untitled Project'} (copy)`}
          getSnapshot={() => getSnapshot(project) as unknown as { pages: Record<string, unknown>; components: Record<string, unknown> }}
          currentPageId={rootStore.editorUI.currentPage?.id}
          onSaved={isUnsavedDemo ? () => rootStore.editorUI.consumeDemo() : undefined}
          description={
            isUnsavedDemo
              ? undefined
              : "Keeps both versions: this tab's pages and components become a new project in your company, and it opens in the editor. The project changed elsewhere stays as it is."
          }
        />
      ) : null}
      <SiteChangedDialog
        open={state.kind === 'conflict'}
        action="save"
        busy={state.kind === 'conflict' && state.retrying}
        onKeepEditing={() => setState({ kind: 'idle' })}
        onLoadNewer={() => window.location.reload()}
        onKeepMine={() => {
          if (state.kind === 'conflict') void save(state.currentVersion);
        }}
        onSaveAsNew={() => {
          setState({ kind: 'idle' });
          setSaveAsOpen(true);
        }}
      />
    </div>
  );
});

SaveButton.displayName = 'SaveButton';
export default SaveButton;
