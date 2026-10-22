'use client';
// src/components/SaveAsNewProjectDialog.tsx
//
// "Save as a new project" for the browser-only demo editor (`/`): the demo
// project belongs to no company, so Save offers to create a dashboard project
// in the active company from its pages (name prefilled from the project
// title), then opens it at /projects/<newId> on the same page. When that is
// not possible (no company with Lumitra Sites, none chosen, session ended)
// the dialog says why and what to do next; before any step that leaves the
// page, the work is stashed for the demo editor to restore.

import React, { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { PROJECT_NAME_MAX_LENGTH, validateProjectName } from '@/lib/projectName';
import { saveDemoAsProject, type NextStep } from '@/lib/projects/saveDemoAsProject';
import { clearStashedDemoProject, stashDemoProject } from '@/lib/projects/demoStash';

export interface SaveAsNewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  /** The demo project's snapshot: its pages become the new project's. */
  getSnapshot: () => { pages: Record<string, unknown> } & Record<string, unknown>;
  /** The page open now, to land on it in the new project. */
  currentPageId?: string;
  /** Called once the project exists: the demo must not be offered again. */
  onSaved?: () => void;
}

export default function SaveAsNewProjectDialog({
  open,
  onOpenChange,
  defaultName,
  getSnapshot,
  currentPageId,
  onSaved,
}: SaveAsNewProjectDialogProps) {
  const router = useRouter();
  const [name, setName] = useState(defaultName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState<NextStep | null>(null);
  const inputId = useId();
  const errorId = useId();
  const inputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setError(null);
      setNext(null);
    }
  }, [open, defaultName]);

  const submit = async () => {
    if (saving) return;
    const valid = validateProjectName(name);
    if (!valid.ok) {
      setError(valid.message);
      return;
    }
    setSaving(true);
    setError(null);
    setNext(null);
    const snapshot = getSnapshot();
    const result = await saveDemoAsProject(valid.name, snapshot.pages);
    if (result.ok) {
      clearStashedDemoProject();
      onSaved?.();
      const page = currentPageId ? `?page=${encodeURIComponent(currentPageId)}` : '';
      // replace, not push: Back must not lead to the demo again (it was saved).
      router.replace(`/projects/${encodeURIComponent(result.siteId)}${page}`);
      return;
    }
    setSaving(false);
    setError(result.message);
    if (result.next) setNext(result.next);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!saving) onOpenChange(o);
      }}
    >
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>Save as a new project</DialogTitle>
          <DialogDescription>
            This demo project exists only in this browser tab. Saving creates a project in your
            company with all of its pages, and opens it in the editor.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-3 px-5 pb-1"
        >
          <label htmlFor={inputId} className="text-[13px]">
            Project name
          </label>
          <input
            id={inputId}
            ref={inputRef}
            type="text"
            value={name}
            maxLength={PROJECT_NAME_MAX_LENGTH * 4}
            // readOnly, not disabled, while saving: keyboard focus stays put.
            readOnly={saving}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-brand"
          />
          {error ? (
            <p id={errorId} role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
          {next ? (
            <a
              href={next.href}
              onClick={() => {
                // Leaving the page: keep the work for the demo editor to
                // restore when the person comes back (and only then).
                if (next.leavesPage) stashDemoProject(getSnapshot(), currentPageId);
              }}
              className="text-[13px] font-medium text-brand underline underline-offset-4"
            >
              {next.label}
            </a>
          ) : null}
          <p role="status" aria-live="polite" className="sr-only">
            {saving ? 'Saving the project…' : ''}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-disabled={saving || undefined}
              onClick={() => {
                if (!saving) onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" aria-disabled={saving || undefined} aria-busy={saving || undefined}>
              {saving ? 'Saving…' : 'Save project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
