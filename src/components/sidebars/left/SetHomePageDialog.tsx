'use client';

// src/components/sidebars/left/SetHomePageDialog.tsx
//
// "Set as home page", confirmed in an in-page dialog before it runs. Two ways
// in:
//   - for one page (the row menu, the right-click menu): the dialog names the
//     page and says what will happen;
//   - as a chooser (the notice shown when someone tries to delete the home
//     page): the other pages are listed as a radio group, the first one
//     preselected, and the same explanation follows the selection.
//
// What will happen comes from ProjectModel.previewHomeChange, the same plan
// setHomePage carries out, so the dialog never promises a slug the action does
// not use. On a published site it also says that links to the page's old
// address will lead to the home page after the next publish (the server keeps
// that path as a redirect, src/lib/pages/redirects.ts).
//
// Confirming runs ProjectModel.setHomePage: one MST action, one undo step.

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
import type { ProjectModelType } from '@/models/ProjectModel';
import { useSiteAddress } from '@/contexts/SiteAddressContext';

/** Which dialog is open: one page to confirm, or the chooser of every other page. */
export type SetHomePageRequest = { mode: 'confirm'; pageId: string } | { mode: 'choose' } | null;

/**
 * What making `pageId` the home page changes, in plain words: where the page
 * will be served, where the current home page moves, and (on a published site)
 * what happens to links to the page's old address.
 */
export const HomeChangeSummary = observer(({ project, pageId }: { project: ProjectModelType; pageId: string }) => {
  const { address } = useSiteAddress();
  const page = project.getPage(pageId);
  if (!page) return null;
  const moved = project.previewHomeChange(pageId);
  const host = address.host ?? 'your site address';
  return (
    <div className="flex flex-col gap-1.5 text-[13px] text-foreground" data-testid="home-change-summary">
      <p>
        &ldquo;{page.metadata.title}&rdquo; will open at the root of your site ({host}/), so visitors who type just
        your address land there.
      </p>
      {moved.map((m) => (
        <p key={m.pageId}>
          &ldquo;{m.title}&rdquo; stays as a normal page at /{m.slug}. You can rename, move or delete it afterwards.
        </p>
      ))}
      {page.slug && address.everPublished && (
        <p className="text-muted-foreground">
          Links to /{page.slug} will lead to the home page after your next publish.
        </p>
      )}
    </div>
  );
});
HomeChangeSummary.displayName = 'HomeChangeSummary';

export interface SetHomePageDialogProps {
  project: ProjectModelType;
  request: SetHomePageRequest;
  onClose: () => void;
  /** Called with the new home page after the change ran. */
  onDone?: (pageId: string) => void;
  /** Where focus goes when the dialog closes (the control that opened it). */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}

const SetHomePageForm = observer(({
  project,
  request,
  onClose,
  onDone,
}: {
  project: ProjectModelType;
  request: Exclude<SetHomePageRequest, null>;
  onClose: () => void;
  onDone?: (pageId: string) => void;
}) => {
  const candidates = project.pagesArray.filter((p) => project.canBecomeHomePage(p.id));
  const [chosen, setChosen] = React.useState<string>(candidates[0]?.id ?? '');
  const [error, setError] = React.useState('');
  // A page deleted (or made home) elsewhere while the dialog is open drops
  // out: the chooser falls back to the first remaining page, a confirmation
  // for one page offers nothing rather than silently switching pages.
  const isCandidate = (id: string) => candidates.some((p) => p.id === id);
  const selected =
    request.mode === 'confirm'
      ? isCandidate(request.pageId) ? request.pageId : ''
      : isCandidate(chosen) ? chosen : candidates[0]?.id ?? '';

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    const result = project.setHomePage(selected);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onDone?.(selected);
    onClose();
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="flex flex-col gap-3">
        {request.mode === 'confirm' && !selected && (
          <p className="text-[13px] text-muted-foreground">This page cannot be the home page: it already is, it no longer exists, or it shows a different item for each address.</p>
        )}
        {request.mode === 'choose' &&
          (candidates.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              There is no other page yet. Add a page first, then make it the home page.
            </p>
          ) : (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                New home page
              </legend>
              <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto" data-testid="home-page-choices">
                {candidates.map((p) => (
                  <label
                    key={p.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm phone:py-2.5 ${
                      selected === p.id ? 'bg-accent' : 'hover:bg-accent/60'
                    }`}
                  >
                    <input
                      type="radio"
                      name="new-home-page"
                      value={p.id}
                      checked={selected === p.id}
                      onChange={() => {
                        setChosen(p.id);
                        setError('');
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{p.metadata.title}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">/{p.slug}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        {selected && <HomeChangeSummary project={project} pageId={selected} />}
        {error && (
          <p className="text-[12px] text-destructive" role="alert">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="brand" size="sm" disabled={!selected}>
          Set as home page
        </Button>
      </DialogFooter>
    </form>
  );
});
SetHomePageForm.displayName = 'SetHomePageForm';

const SetHomePageDialog = observer(({ project, request, onClose, onDone, returnFocusTo }: SetHomePageDialogProps) => {
  const page = request?.mode === 'confirm' ? project.getPage(request.pageId) : undefined;
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      {request && (
        <DialogContent
          data-testid="set-home-page-dialog"
          data-editor-ui="true"
          onCloseAutoFocus={(e) => {
            const target = returnFocusTo?.current;
            if (target && target.isConnected) {
              e.preventDefault();
              target.focus();
            }
          }}
          // Editor shortcuts (Delete removes the selected element) stay out;
          // Escape still reaches Radix, which closes the dialog.
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {request.mode === 'choose' ? 'Choose a new home page' : `Set "${page?.metadata.title ?? 'this page'}" as home page?`}
            </DialogTitle>
            <DialogDescription>
              The home page is what your site shows at its main address.
            </DialogDescription>
          </DialogHeader>
          <SetHomePageForm
            key={request.mode === 'confirm' ? request.pageId : 'choose'}
            project={project}
            request={request}
            onClose={onClose}
            onDone={onDone}
          />
        </DialogContent>
      )}
    </Dialog>
  );
});
SetHomePageDialog.displayName = 'SetHomePageDialog';

export default SetHomePageDialog;
