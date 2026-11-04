// src/components/SaveButton.tsx
//
// The editor top-bar Save action (MT-10, the per-project editor route) and the
// face of autosave (src/lib/projects/autosave.ts, plan
// docs/plans/2026-11-04-editor-autosave.md). The editor saves by itself about
// 1.5 s after the last change; this button is "save now" and shows the state:
// Saved, Saving..., Unsaved changes, or Not saved with the reason beside it.
//
// It writes the SAME live ProjectModel (`editorUI.currentProject`, which after
// MT-10 hydration IS the server-loaded project) to /api/projects/save (MT-04),
// which persists the working copy WITHOUT flipping the site's status. Saving a
// draft keeps it a draft; it never publishes.
//
// Outcomes surface LOUDLY and never silently no-op:
//   - in flight: "Saving..." and the button is disabled,
//   - a click that succeeded: a brief confirmation (how many pages were saved);
//     an autosave only changes the label, so no notice pops up at every pause,
//   - conflict: the project was saved somewhere else since this tab loaded it
//     (409 `site_changed`, the version lock): autosave stops and
//     SiteChangedDialog asks whether to load the newer version, save this one
//     over it, or keep both. "Keep editing" leaves autosave stopped; the next
//     click on Save asks again, so a refusal never loops,
//   - failure: the reason, retried with backoff when it may pass (network,
//     server errors), else kept until the next click.
// The demo editor at `/` (isUnsavedDemo) has no server copy: no autosave, and
// Save offers to make it a project of its own.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { getSnapshot } from 'mobx-state-tree';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/hooks/useStore';
import { useAutosave } from '@/hooks/useAutosave';
import type { AutosaveState } from '@/lib/projects/autosave';
import SaveAsNewProjectDialog from './SaveAsNewProjectDialog';
import SiteChangedDialog from './SiteChangedDialog';
import { TopBarStatus } from './TopBarStatus';

/** The button's label for an autosave state. */
export function saveLabel(state: AutosaveState): string {
  switch (state.phase) {
    case 'saving':
      return 'Saving...';
    case 'unsaved':
      return 'Unsaved changes';
    case 'retrying':
    case 'failed':
    case 'conflict':
      return 'Not saved';
    default:
      return 'Saved';
  }
}

const CONFLICT_MESSAGE = 'Not saved: this project was changed somewhere else. Click Save to choose what to keep.';

const SaveButton = observer(() => {
  const rootStore = useStore();
  const project = rootStore.editorUI.currentProject;
  const isUnsavedDemo = rootStore.editorUI.isUnsavedDemo === true;
  const { controller, state } = useAutosave(project, !isUnsavedDemo);
  const [saveAsOpen, setSaveAsOpen] = React.useState(false);
  const [demoError, setDemoError] = React.useState<string | null>(null);

  const save = () => {
    if (!project) {
      setDemoError('No project to save.');
      return;
    }
    // The demo editor at `/` builds its project in the browser; no company
    // holds it yet: Save offers to make it a project of its own.
    if (isUnsavedDemo || !controller) {
      setSaveAsOpen(true);
      return;
    }
    void controller.saveManually();
  };

  const saving = state.phase === 'saving' || (state.phase === 'conflict' && state.retrying);
  const label = isUnsavedDemo || !project ? 'Save' : saveLabel(state);
  const notice: { kind: 'success' | 'error'; message: string } | null = demoError
    ? { kind: 'error', message: demoError }
    : state.phase === 'savedNow'
      ? { kind: 'success', message: state.message }
      : (state.phase === 'retrying' || state.phase === 'failed') && !state.hidden
        ? { kind: 'error', message: state.message }
        : state.phase === 'conflict' && !state.dialogOpen
          ? { kind: 'error', message: CONFLICT_MESSAGE }
          : null;

  return (
    <div className="flex items-center gap-2 mr-1 lg:mr-2">
      {notice && (
        <TopBarStatus
          kind={notice.kind}
          title={notice.message}
          onDismiss={() => {
            setDemoError(null);
            controller?.dismissMessage();
          }}
        >
          <span className="lg:truncate">{notice.message}</span>
        </TopBarStatus>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={save}
        disabled={saving}
        title={
          isUnsavedDemo
            ? 'Save this demo as a project (does not publish)'
            : 'Changes are saved automatically. Click to save now (does not publish).'
        }
        data-autosave-phase={isUnsavedDemo ? undefined : state.phase}
      >
        <Save size={16} />
        {/* Icon only on a phone; the label stays the button's name. */}
        <span className="max-sm:sr-only">{label}</span>
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
        open={state.phase === 'conflict' && state.dialogOpen}
        action="save"
        busy={state.phase === 'conflict' && state.retrying}
        onKeepEditing={() => controller?.dismissConflict()}
        onLoadNewer={() => {
          controller?.discardForReload();
          window.location.reload();
        }}
        onKeepMine={() => {
          if (state.phase === 'conflict') void controller?.saveManually(state.currentVersion);
        }}
        onSaveAsNew={() => {
          controller?.dismissConflict();
          setSaveAsOpen(true);
        }}
      />
    </div>
  );
});

SaveButton.displayName = 'SaveButton';
export default SaveButton;
