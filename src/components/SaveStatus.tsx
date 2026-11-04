// src/components/SaveStatus.tsx
//
// The editor top bar's save status (plan docs/plans/2026-11-04-editor-autosave.md).
// Decided by the owner on 2026-11-04: "Everything should autosave all the time.
// There shouldn't even be the need for a save button. Framer also doesn't have
// it." So there is no Save button: the editor saves by itself
// (src/lib/projects/autosave.ts), Cmd/Ctrl+S saves at once
// (src/lib/projects/saveShortcut.ts), and this says what is going on:
//   - Saved; Unsaved changes (while the debounce runs); Saving... only when a
//     save takes longer than 300 ms (useSaveStatusLabel), so typing never
//     flashes; Publishing... while Publish writes the same copy;
//   - Not saved, with the reason and Retry (and "Sign in again" in a new tab
//     when signed out: navigating this tab would lose the very work at stake);
//   - Changed elsewhere (the version lock refused, 409 `site_changed`): a
//     button that reopens SiteChangedDialog.
// The words sit in one polite live region that is always present, so each
// change is announced. The text itself is never focusable; only an action is.
// A word changes with a fade under 300 ms, ease-out, and none with reduced motion.
//
// The demo editor at `/` (isUnsavedDemo) has no server copy and never
// autosaves: the status says it is not saved, and "Keep as project" makes it
// a project of its own (SaveAsNewProjectDialog).
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { getSnapshot } from 'mobx-state-tree';
import { CircleDot, CloudAlert, CloudCheck, CloudOff, CloudUpload, FolderPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/hooks/useStore';
import { isSaving, saveFailureReason, useAutosave, useSaveStatusLabel } from '@/hooks/useAutosave';
import { reloadDiscarding, type AutosaveState } from '@/lib/projects/autosave';
import SaveAsNewProjectDialog from './SaveAsNewProjectDialog';
import SiteChangedDialog from './SiteChangedDialog';

/** Where "Sign in again" goes: the overview bounces a signed-out visit to the sign-in. */
export const SIGN_IN_AGAIN_HREF = '/projects';

const FADE = 'animate-in fade-in duration-200 ease-out motion-reduce:animate-none';

function StatusIcon({ state, saving }: { state: AutosaveState; saving: boolean }) {
  const props = { size: 14, 'aria-hidden': true, className: 'shrink-0' } as const;
  if (saving || state.phase === 'publishing') return <CloudUpload {...props} />;
  switch (state.phase) {
    case 'unsaved':
      return <CircleDot {...props} />;
    case 'retrying':
    case 'failed':
    case 'conflict':
      return <CloudAlert {...props} />;
    default:
      return <CloudCheck {...props} />;
  }
}

const SaveStatus = observer(() => {
  const rootStore = useStore();
  const project = rootStore.editorUI.currentProject;
  const isUnsavedDemo = rootStore.editorUI.isUnsavedDemo === true;
  const { controller, state } = useAutosave(project, !isUnsavedDemo);
  const label = useSaveStatusLabel(state);
  const [saveAsOpen, setSaveAsOpen] = React.useState(false);

  if (!project) return null;
  const projectTitle = project.metadata.title || 'Untitled Project';
  const saveAsDialog = (isUnsavedDemo || saveAsOpen) && (
    <SaveAsNewProjectDialog
      open={saveAsOpen}
      onOpenChange={setSaveAsOpen}
      title={isUnsavedDemo ? 'Keep as project' : undefined}
      defaultName={isUnsavedDemo ? projectTitle : `${projectTitle} (copy)`}
      getSnapshot={() => getSnapshot(project) as unknown as { pages: Record<string, unknown>; components: Record<string, unknown> }}
      currentPageId={rootStore.editorUI.currentPage?.id}
      onSaved={isUnsavedDemo ? () => rootStore.editorUI.consumeDemo() : undefined}
      description={
        isUnsavedDemo
          ? undefined
          : "Keeps both versions: this tab's pages and components become a new project in your company, and it opens in the editor. The project changed elsewhere stays as it is."
      }
    />
  );

  if (isUnsavedDemo) {
    return (
      <div className="mr-1 flex min-w-0 items-center gap-2 lg:mr-2">
        <span role="status" aria-live="polite" data-testid="save-status" className="flex items-center gap-1.5 text-xs text-muted-foreground" title="This demo exists only in this browser tab. Keep it as a project to save it.">
          <CloudOff size={14} aria-hidden className="shrink-0" />
          <span className="max-md:sr-only">Demo, not saved</span>
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => setSaveAsOpen(true)} title="Keep this demo as a project in your company (does not publish)">
          <FolderPlus size={16} aria-hidden />
          <span className="max-sm:sr-only">Keep as project</span>
        </Button>
        {saveAsDialog}
      </div>
    );
  }

  const saving = isSaving(state);
  const reason = saveFailureReason(state);
  const failed = state.phase === 'failed' || state.phase === 'retrying';
  const conflict = state.phase === 'conflict';
  const tone = failed ? 'text-destructive' : conflict ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground';
  const reasonHidden = failed && state.hidden === true;

  return (
    <div className="mr-1 flex min-w-0 items-center gap-1.5 lg:mr-2" data-autosave-phase={state.phase}>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="save-status"
        title={reason ?? (conflict ? 'This project was saved somewhere else. Choose what to keep.' : 'Changes are saved automatically. Cmd+S (Ctrl+S) saves at once.')}
        className={`flex min-w-0 items-center gap-1.5 text-xs ${tone}`}
      >
        <StatusIcon state={state} saving={saving} />
        {conflict && !state.retrying ? (
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => controller?.openConflict()}
            className={`whitespace-nowrap rounded px-1 font-medium underline underline-offset-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${FADE}`}
          >
            Changed elsewhere
          </button>
        ) : (
          <span key={label} className={`whitespace-nowrap ${failed ? '' : 'max-sm:sr-only'} ${FADE}`}>
            {label}
          </span>
        )}
        {reason && (
          // Inline on the wide bar; a notice under the compact bar, which can be put away.
          <span
            data-testid="save-status-reason"
            className={`lg:min-w-0 lg:max-w-[260px] lg:truncate max-lg:fixed max-lg:inset-x-4 max-lg:top-[4.5rem] max-lg:z-[95] max-lg:flex max-lg:items-start max-lg:justify-between max-lg:gap-2 max-lg:rounded-md max-lg:border max-lg:border-border max-lg:bg-background max-lg:py-1.5 max-lg:pl-3 max-lg:pr-1 max-lg:shadow-lg phone:top-14 ${reasonHidden ? 'max-lg:sr-only' : ''}`}
          >
            <span className="lg:truncate">{reason}</span>
            <button
              type="button"
              onClick={() => controller?.dismissMessage()}
              aria-label="Put the reason away"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
            >
              <X size={14} aria-hidden />
            </button>
          </span>
        )}
      </span>
      {failed && state.status === 401 && (
        <a
          href={SIGN_IN_AGAIN_HREF}
          target="_blank"
          rel="noopener noreferrer"
          className="whitespace-nowrap rounded px-1 text-xs font-medium text-brand underline underline-offset-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          Sign in again<span className="sr-only"> (opens a new tab)</span>
        </a>
      )}
      {failed && (
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void controller?.retry()}>
          Retry
        </Button>
      )}
      {saveAsDialog}
      <SiteChangedDialog
        open={conflict && state.dialogOpen}
        action="save"
        busy={conflict && state.retrying}
        onKeepEditing={() => controller?.dismissConflict()}
        onLoadNewer={() => reloadDiscarding(project.id)}
        onKeepMine={() => {
          if (state.phase === 'conflict') void controller?.saveOver(state.currentVersion);
        }}
        onSaveAsNew={() => {
          controller?.dismissConflict();
          setSaveAsOpen(true);
        }}
      />
    </div>
  );
});

SaveStatus.displayName = 'SaveStatus';
export default SaveStatus;
