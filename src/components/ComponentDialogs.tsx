'use client';

// src/components/ComponentDialogs.tsx
//
// The component dialogs, one host for every way in (the Layers menu, the right
// panel, the Components panel, the shortcut), opened through
// editorUI.componentRequest:
//
//   - create: names a new component made from the selection. A form inside gets a
//     new id with it, so past submissions stay with the old one: said first.
//   - rename: a definition's name, unique within the site.
//   - delete: names how many placements become plain copies, which look the same.
//   - detach: only opened when the copy takes a form to a new id.
//
// Each confirm runs one ProjectModel action, one undo step, and shows its refusal
// in the dialog rather than closing on it. A node or definition that went away
// while the dialog was open (another tab's save, an undo) shows as gone.
//
// Contract: docs/plans/2026-11-02-reusable-components.md, "Editing on the canvas".

import React from 'react';
import { observer } from 'mobx-react-lite';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useStore } from '@/hooks/useStore';
import { detachLosesFormHistory } from '@/lib/components/detach';
import { holdsForm, runDetach } from '@/lib/components/editorCommands';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { ComponentRequest } from '@/stores/EditorUIStore';
import { FIELD_CONTROL } from './sidebars/right/primitives';

const NOTE = 'text-[13px] leading-snug text-foreground';
const FORM_NOTE = 'A form inside gets a new id, so past submissions stay under the old one and new ones start fresh.';

const ErrorLine = ({ message }: { message: string }) =>
  message ? <p role="alert" className="text-[12px] text-destructive">{message}</p> : null;

/** A name a definition does not have yet: Component, Component 2, and so on. */
function freeName(taken: ReadonlySet<string>, base = 'Component'): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

const NameField = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
  <label className="flex flex-col gap-1.5 text-[12px] text-muted-foreground">
    Name
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Component name"
      className={`${FIELD_CONTROL} text-[13px] text-foreground`}
      maxLength={80}
    />
  </label>
);

const Footer = ({ onClose, confirm, destructive, disabled }: { onClose: () => void; confirm: string; destructive?: boolean; disabled?: boolean }) => (
  <DialogFooter>
    <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
    <Button type="submit" variant={destructive ? 'destructive' : 'brand'} size="sm" disabled={disabled}>{confirm}</Button>
  </DialogFooter>
);

const CreateForm = observer(({ request, onClose }: { request: Extract<ComponentRequest, { kind: 'create' }>; onClose: () => void }) => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const page = project?.findPageById(request.pageId);
  const nodes = request.nodeIds.map((id) => page?.findComponent(id)).filter(Boolean) as ComponentInstance[];
  const taken = new Set(Array.from(project?.components.values() ?? [], (definition) => definition.name));
  const [name, setName] = React.useState(() => freeName(taken, nodes.length === 1 ? nodes[0].displayName : 'Component'));
  const [error, setError] = React.useState('');
  const gone = !project || !page || nodes.length !== request.nodeIds.length;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (gone) return;
    const result = project.createComponentFromSelection(request.pageId, request.nodeIds, name);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    editorUI.selectComponent(result.placement, editorUI.selectedViewportNode?.breakpointId);
    onClose();
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="flex flex-col gap-3">
        {gone ? (
          <p className={NOTE}>The selection changed while this was open. Select the elements again.</p>
        ) : (
          <>
            <NameField value={name} onChange={(next) => { setName(next); setError(''); }} />
            <p className={NOTE}>
              {nodes.length === 1 ? 'It' : `These ${nodes.length} elements`} become one component, placed here. Place it on
              other pages from This site in the Components panel, and an edit to it reaches every placement.
            </p>
            {nodes.some(holdsForm) && <p className={NOTE}>{FORM_NOTE}</p>}
          </>
        )}
        <ErrorLine message={error} />
      </DialogBody>
      <Footer onClose={onClose} confirm="Create component" disabled={gone || name.trim() === ''} />
    </form>
  );
});
CreateForm.displayName = 'CreateForm';

const RenameForm = observer(({ request, onClose }: { request: Extract<ComponentRequest, { kind: 'rename' }>; onClose: () => void }) => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const definition = project?.components.get(request.definitionId);
  const [name, setName] = React.useState(definition?.name ?? '');
  const [error, setError] = React.useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!project || !definition) return;
    if (name.trim() === definition.name) {
      onClose();
      return;
    }
    const result = project.renameDefinition(definition.id, name);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onClose();
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="flex flex-col gap-3">
        {definition ? <NameField value={name} onChange={(next) => { setName(next); setError(''); }} /> : <p className={NOTE}>That component no longer exists.</p>}
        <ErrorLine message={error} />
      </DialogBody>
      <Footer onClose={onClose} confirm="Rename" disabled={!definition || name.trim() === ''} />
    </form>
  );
});
RenameForm.displayName = 'RenameForm';

const DeleteForm = observer(({ request, onClose }: { request: Extract<ComponentRequest, { kind: 'delete' }>; onClose: () => void }) => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const definition = project?.components.get(request.definitionId);
  const stored = definition ? project?.definitions[definition.id] : undefined;
  const count = definition ? project?.placementCount(definition.id) ?? 0 : 0;
  const [error, setError] = React.useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!project || !definition) return;
    const result = project.deleteDefinition(definition.id);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onClose();
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="flex flex-col gap-3">
        {definition ? (
          <>
            <p className={NOTE}>
              {count === 0
                ? 'It is not placed anywhere.'
                : `Its ${count === 1 ? 'placement becomes a plain copy' : `${count} placements become plain copies`}: pages look the same, and the copies no longer follow each other.`}
            </p>
            {count > 0 && stored && detachLosesFormHistory(stored) && <p className={NOTE}>{FORM_NOTE}</p>}
            <p className="text-[12px] text-muted-foreground">Undo brings it back with every placement.</p>
          </>
        ) : (
          <p className={NOTE}>That component no longer exists.</p>
        )}
        <ErrorLine message={error} />
      </DialogBody>
      <Footer onClose={onClose} confirm="Delete component" destructive disabled={!definition} />
    </form>
  );
});
DeleteForm.displayName = 'DeleteForm';

const DetachForm = observer(({ request, onClose }: { request: Extract<ComponentRequest, { kind: 'detach' }>; onClose: () => void }) => {
  const { editorUI } = useStore();
  const placement = editorUI.currentProject?.findPageById(request.pageId)?.findComponent(request.placementId);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!placement) return;
    if (runDetach(editorUI, request.pageId, request.placementId, editorUI.selectedViewportNode?.breakpointId)) onClose();
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="flex flex-col gap-3">
        <p className={NOTE}>
          {placement ? `This placement becomes a plain copy that no longer follows the component. ${FORM_NOTE}` : 'That component is no longer here.'}
        </p>
      </DialogBody>
      <Footer onClose={onClose} confirm="Detach" disabled={!placement} />
    </form>
  );
});
DetachForm.displayName = 'DetachForm';

const TITLES: Record<ComponentRequest['kind'], string> = {
  create: 'Create component',
  rename: 'Rename component',
  delete: 'Delete component',
  detach: 'Detach from component',
};

const ComponentDialogs = observer(() => {
  const { editorUI } = useStore();
  const request = editorUI.componentRequest;
  const onClose = () => editorUI.setComponentRequest(null);
  const definitionName = request && 'definitionId' in request ? editorUI.currentProject?.components.get(request.definitionId)?.name : undefined;

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      {request && (
        <DialogContent
          data-testid="component-dialog"
          data-editor-ui="true"
          // Editor shortcuts (Delete removes the selected element) stay out;
          // Escape still reaches Radix, which closes the dialog.
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation();
          }}
        >
          <DialogHeader>
            <DialogTitle>{definitionName && request.kind === 'delete' ? `Delete ${definitionName}` : TITLES[request.kind]}</DialogTitle>
            <DialogDescription className="sr-only">{TITLES[request.kind]}</DialogDescription>
          </DialogHeader>
          {request.kind === 'create' && <CreateForm key={request.nodeIds.join()} request={request} onClose={onClose} />}
          {request.kind === 'rename' && <RenameForm key={request.definitionId} request={request} onClose={onClose} />}
          {request.kind === 'delete' && <DeleteForm key={request.definitionId} request={request} onClose={onClose} />}
          {request.kind === 'detach' && <DetachForm key={request.placementId} request={request} onClose={onClose} />}
        </DialogContent>
      )}
    </Dialog>
  );
});
ComponentDialogs.displayName = 'ComponentDialogs';

export default ComponentDialogs;
