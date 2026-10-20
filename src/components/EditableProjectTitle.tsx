'use client';
// src/components/EditableProjectTitle.tsx
//
// The project name in the editor's top-bar breadcrumb ("Project / page"),
// renamable in place: click it (or focus it and press Enter or Space) to edit;
// Enter or leaving the field saves, Escape cancels. The new name shows at once
// (optimistic) and is saved through PATCH /api/projects/<id>; when the save
// fails the old name comes back and the reason is shown. Also keeps the
// browser tab title in step with the name.
//
// The title lives in two places: the database row (Site.name, what the
// dashboard lists and what a fresh editor load starts from) and this working
// copy (ProjectModel.metadata.title). The rename route is the only writer of
// the row after creation, and the working copy is updated outside undo
// history, so Cmd+Z can never show a name the database does not have.

import React, { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import type { ProjectModelType } from '@/models/ProjectModel';
import { getHistoryStore } from '@/stores/RootStore';
import { renameProject } from '@/lib/projects/renameProject';
import ProjectNameInput from './ProjectNameInput';

const FALLBACK_NAME = 'Untitled Project';

/** Set the working copy's title without creating an undo step. */
function applyTitle(project: ProjectModelType, title: string) {
  const history = getHistoryStore();
  const write = () => project.updateMetadata({ title });
  if (history) history.runUntracked(write);
  else write();
}

const EditableProjectTitle = observer(({ project }: { project: ProjectModelType | undefined }) => {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = project?.metadata.title || FALLBACK_NAME;
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Set when the field closes by save or cancel, so focus returns to the name
  // (otherwise the unmounted input drops keyboard focus to <body>).
  const returnFocus = useRef(false);

  useEffect(() => {
    if (!project) return;
    const before = document.title;
    document.title = `${title} | Lumitra Sites`;
    // Leaving the editor (client-side navigation) puts the old title back.
    return () => {
      document.title = before;
    };
  }, [project, title]);

  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [editing]);

  if (!project) {
    return (
      <div className="text-sm font-semibold text-foreground truncate max-w-[180px]">{FALLBACK_NAME}</div>
    );
  }

  const close = () => {
    returnFocus.current = true;
    setEditing(false);
  };

  const save = async (next: string) => {
    close();
    const previous = project.metadata.title;
    if (next === previous) return;
    setError(null);
    applyTitle(project, next);
    setSaving(true);
    const result = await renameProject(project.id, next, previous);
    setSaving(false);
    if (result.ok) {
      if (result.name !== project.metadata.title) applyTitle(project, result.name);
      return;
    }
    // Roll back to what the database holds: the previous name, or the name
    // someone else saved in the meantime.
    applyTitle(project, result.currentName ?? previous);
    setError(result.message);
  };

  return (
    <div className="relative flex min-w-0 max-w-[220px] flex-col">
      {editing ? (
        <ProjectNameInput
          initialName={project.metadata.title}
          onSubmit={(next) => void save(next)}
          onCancel={close}
          className="w-[200px] font-semibold"
        />
      ) : (
        <button
          ref={buttonRef}
          type="button"
          onClick={() => {
            // One rename at a time: a second one started while the first is
            // in flight would carry a precondition the server has not caught
            // up with and report a false conflict. aria-disabled (not
            // disabled) keeps the button focusable for the returning focus.
            if (saving) return;
            setError(null);
            setEditing(true);
          }}
          title={saving ? `${title} (saving)` : `${title} (click to rename)`}
          aria-label={`Project name: ${title}. Rename project`}
          aria-busy={saving || undefined}
          aria-disabled={saving || undefined}
          className="truncate rounded px-1 -mx-1 text-left text-sm font-semibold text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {title}
        </button>
      )}
      {error ? (
        <div className="absolute left-0 top-full z-10 mt-1 flex w-max max-w-[340px] items-start gap-2 rounded bg-background px-2 py-1 text-xs shadow">
          <p role="alert" className="text-destructive">
            {error}
          </p>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss rename error"
            className="shrink-0 rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
});

EditableProjectTitle.displayName = 'EditableProjectTitle';
export default EditableProjectTitle;
