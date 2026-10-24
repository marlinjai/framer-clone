// src/components/forms/FormSubmissionsButton.tsx
//
// The editor top-bar entry to the project's form submissions: an inbox button
// that opens a dialog with FormSubmissionsPanel. The panel mounts only while
// the dialog is open, so every open loads the server's current list.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { Inbox } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useStore } from '@/hooks/useStore';
import FormSubmissionsPanel from './FormSubmissionsPanel';
import { useControllableOpen, type ControllableOpenProps } from '@/hooks/useControllableOpen';

export interface FormSubmissionsButtonProps extends ControllableOpenProps {
  /** Extra classes for the trigger (the compact top bar hides it and opens the dialog from its More menu). */
  triggerClassName?: string;
}

const FormSubmissionsButton = observer(({ open: openProp, onOpenChange, triggerClassName = '' }: FormSubmissionsButtonProps) => {
  const project = useStore().editorUI.currentProject;
  const [open, setOpen] = useControllableOpen({ open: openProp, onOpenChange });
  if (!project) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Form submissions"
        aria-label="Form submissions"
        className={`mr-2 flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-accent ${triggerClassName}`}
      >
        <Inbox size={16} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-editor-ui="true" className="max-w-[640px]">
          <DialogHeader>
            <DialogTitle>Form submissions</DialogTitle>
            <DialogDescription>
              What visitors sent through the forms on your published site, newest first. Deleting a submission removes it for good.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>{open && <FormSubmissionsPanel projectId={project.id} />}</DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
});

FormSubmissionsButton.displayName = 'FormSubmissionsButton';
export default FormSubmissionsButton;
