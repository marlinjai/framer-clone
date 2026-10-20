// src/components/domains/DomainsButton.tsx
//
// The editor top-bar entry to the project's Domains panel: a button that
// opens a dialog with DomainsPanel for the current project. The panel mounts
// only while the dialog is open, so every open loads the server's current
// state (no stale list from an earlier open).
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { Globe } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useStore } from '@/hooks/useStore';
import DomainsPanel from './DomainsPanel';

const DomainsButton = observer(() => {
  const project = useStore().editorUI.currentProject;
  const [open, setOpen] = React.useState(false);
  if (!project) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Domains"
        aria-label="Domains"
        className="mr-2 flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-accent"
      >
        <Globe size={16} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-[560px] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Domains</DialogTitle>
            <DialogDescription>
              Connect your own domain to this site. Add the DNS records shown, then verify.
            </DialogDescription>
          </DialogHeader>
          {open && <DomainsPanel projectId={project.id} />}
        </DialogContent>
      </Dialog>
    </>
  );
});

DomainsButton.displayName = 'DomainsButton';
export default DomainsButton;
