'use client';

// src/components/sidebars/left/PageSettingsDialog.tsx
//
// Page settings: the page's name, its URL slug and its meta description, with a
// live preview of the resulting address. Opened from a page row in the PAGES
// list (its settings button, a double-click, or the "Page settings" item of the
// row's context menu).
//
// - The slug follows the shared rules (src/lib/pages/slug.ts), the same ones
//   the server save path enforces, and every problem is explained inline.
// - The home page always lives at the site root, so its slug is shown but not
//   editable.
// - On a site that has been published, a changed slug keeps the old address
//   working: the server records a redirect and it goes live with the next
//   publish (src/lib/pages/redirects.ts). The panel says so.
// - Save runs ProjectModel.updatePageSettings, one MST action, so the change is
//   one undo step and travels the same way as every other page edit.
//
// The page name doubles as the browser tab and search result title
// (pageSeoToMetadata uses metadata.title), so there is no separate SEO title.

import React from 'react';
import { observer } from 'mobx-react-lite';
import { Wand2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { PageModelType } from '@/models/PageModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import { useSiteAddress } from '@/contexts/SiteAddressContext';
import { suggestSlug, tidySlugInput, validateSlug, SLUG_MAX_LENGTH } from '@/lib/pages/slug';

/** Search engines show roughly this many characters of a description. */
const DESCRIPTION_HINT_LENGTH = 155;

export interface PageSettingsDialogProps {
  /** The page being edited, or null when the dialog is closed. */
  page: PageModelType | null;
  project: ProjectModelType;
  onClose: () => void;
  /** Where focus goes when the dialog closes (the row control that opened it). */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}

const fieldLabel = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';
const inputBase =
  'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none transition-shadow focus-visible:ring-[3px]';
const inputOk = 'border-input focus-visible:border-ring focus-visible:ring-ring/40';
const inputBad = 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30';

/** While typing: lowercase and spaces to hyphens, nothing that moves the caret. */
function typingTidy(raw: string): string {
  return raw.toLowerCase().replace(/\s/g, '-');
}

const PageSettingsForm = observer(({
  page,
  project,
  onClose,
}: {
  page: PageModelType;
  project: ProjectModelType;
  onClose: () => void;
}) => {
  const { address } = useSiteAddress();
  // Locked: THE home page, served at the site root (an extra empty-slug page
  // of an older project is not locked and can move).
  const isHome = project.isSlugLocked(page.id);
  const [name, setName] = React.useState(page.metadata.title);
  const [slug, setSlug] = React.useState(page.slug);
  // Only a slug the person edited is tidied and saved: an untouched legacy
  // slug (from before the slug rules) is kept exactly as stored, so renaming
  // such a page never rewrites or blocks on its address.
  const [slugTouched, setSlugTouched] = React.useState(false);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const slugRef = React.useRef<HTMLInputElement>(null);
  // Announced by the always-mounted live region below after a failed save.
  const [announcement, setAnnouncement] = React.useState('');
  const [description, setDescription] = React.useState(page.metadata.description ?? '');
  // Errors show once a field was left or a save was attempted, never while the
  // person is still typing their first characters.
  const [showErrors, setShowErrors] = React.useState({ name: false, slug: false });
  const [saveErrors, setSaveErrors] = React.useState<{ title?: string; slug?: string }>({});

  const otherPages = project.pagesArray.map((p) => ({ id: p.id, slug: p.slug }));
  const cleanSlug = isHome ? '' : slugTouched ? tidySlugInput(slug) : page.slug;
  const slugChanged = !isHome && cleanSlug !== page.slug;

  const nameError = name.trim() ? undefined : 'Enter a page name.';
  const slugResult = isHome || !slugChanged
    ? ({ ok: true } as const)
    : validateSlug(cleanSlug, { pageId: page.id, pages: otherPages });
  const slugError = saveErrors.slug ?? (slugResult.ok ? undefined : slugResult.message);
  const titleError = saveErrors.title ?? nameError;

  const visibleNameError = showErrors.name ? titleError : undefined;
  const visibleSlugError = showErrors.slug || saveErrors.slug ? slugError : undefined;

  const hostLabel = address.host ?? 'your-site-address';
  const previewPath = isHome ? '/' : `/${cleanSlug}`;

  // A failed save puts focus on the first field to fix and announces what is
  // wrong, so keyboard and screen reader users are not left guessing.
  const reportProblems = (problems: { title?: string; slug?: string }) => {
    setAnnouncement(
      ['Not saved.', problems.title, problems.slug].filter(Boolean).join(' '),
    );
    (problems.title ? nameRef : slugRef).current?.focus();
  };

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    setShowErrors({ name: true, slug: true });
    if (titleError || slugError) {
      reportProblems({ title: titleError, slug: slugError });
      return;
    }
    const result = project.updatePageSettings(page.id, {
      title: name,
      slug: isHome ? page.slug : cleanSlug,
      description,
    });
    if (!result.ok) {
      setSaveErrors(result.errors);
      reportProblems(result.errors);
      return;
    }
    onClose();
  };

  const fillSlugFromName = () => {
    const taken = otherPages.filter((p) => p.id !== page.id).map((p) => p.slug);
    setSlug(suggestSlug(name || page.metadata.title, taken));
    setSlugTouched(true);
    setSaveErrors((e) => ({ ...e, slug: undefined }));
    setShowErrors((s) => ({ ...s, slug: true }));
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div className="sr-only" role="status" aria-live="polite" data-testid="page-settings-announcement">
        {announcement}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="page-settings-name" className={fieldLabel}>
          Page name
        </label>
        <input
          id="page-settings-name"
          ref={nameRef}
          value={name}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
            setSaveErrors((s) => ({ ...s, title: undefined }));
          }}
          onBlur={() => setShowErrors((s) => ({ ...s, name: true }))}
          aria-invalid={visibleNameError ? true : undefined}
          aria-describedby={visibleNameError ? 'page-settings-name-error' : 'page-settings-name-hint'}
          className={`${inputBase} ${visibleNameError ? inputBad : inputOk}`}
        />
        {visibleNameError ? (
          <p id="page-settings-name-error" className="text-[11px] text-destructive" aria-live="polite">
            {visibleNameError}
          </p>
        ) : (
          <p id="page-settings-name-hint" className="text-[11px] text-muted-foreground">
            Also the title in the browser tab and in search results.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="page-settings-slug" className={fieldLabel}>
            URL slug
          </label>
          {!isHome && (
            <button
              type="button"
              onClick={fillSlugFromName}
              className="inline-flex items-center gap-1 rounded px-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Wand2 size={12} aria-hidden="true" /> Use page name
            </button>
          )}
        </div>
        {isHome ? (
          <>
            <input
              id="page-settings-slug"
              value="/"
              readOnly
              aria-readonly="true"
              aria-describedby="page-settings-slug-home"
              className={`${inputBase} ${inputOk} bg-muted font-mono text-muted-foreground`}
            />
            <p id="page-settings-slug-home" className="text-[11px] text-muted-foreground">
              This is the home page. It always lives at the root of your site, so visitors who type
              just your address land here. Its URL cannot change.
            </p>
          </>
        ) : (
          <>
            <div className="relative">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-muted-foreground"
              >
                /
              </span>
              <input
                id="page-settings-slug"
                ref={slugRef}
                value={slug}
                autoComplete="off"
                spellCheck={false}
                maxLength={SLUG_MAX_LENGTH + 20}
                onChange={(e) => {
                  setSlug(typingTidy(e.target.value));
                  setSlugTouched(true);
                  setSaveErrors((s) => ({ ...s, slug: undefined }));
                }}
                onBlur={() => setShowErrors((s) => ({ ...s, slug: true }))}
                aria-invalid={visibleSlugError ? true : undefined}
                aria-describedby={`page-settings-slug-preview ${visibleSlugError ? 'page-settings-slug-error' : 'page-settings-slug-hint'}`}
                className={`${inputBase} ${visibleSlugError ? inputBad : inputOk} pl-6 font-mono`}
              />
            </div>
            {visibleSlugError ? (
              <p id="page-settings-slug-error" className="text-[11px] text-destructive" aria-live="polite">
                {visibleSlugError}
              </p>
            ) : (
              <p id="page-settings-slug-hint" className="text-[11px] text-muted-foreground">
                Lowercase letters, digits and hyphens. Use a slash for a nested path, like
                blog/first-post.
              </p>
            )}
          </>
        )}
        <div className="rounded-md bg-muted px-3 py-2">
          <div className={fieldLabel}>Page URL</div>
          <div
            id="page-settings-slug-preview"
            data-testid="page-settings-url-preview"
            className="mt-0.5 break-all font-mono text-[12px] text-foreground"
          >
            {hostLabel}
            {previewPath}
          </div>
          {!address.host && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {address.everPublished
                ? 'Your site is published, but no public address is configured for this environment yet.'
                : 'Your site gets its address when you publish it for the first time.'}
            </p>
          )}
          {slugChanged && slugResult.ok && page.slug && address.everPublished && (
            <p className="mt-1 text-[11px] text-foreground" data-testid="page-settings-redirect-note">
              Old links will redirect: /{page.slug} will lead to {previewPath} after your next
              publish.
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="page-settings-description" className={fieldLabel}>
          Meta description
        </label>
        <textarea
          id="page-settings-description"
          value={description}
          rows={3}
          onChange={(e) => setDescription(e.target.value)}
          aria-describedby="page-settings-description-hint"
          className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-shadow focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
        <p id="page-settings-description-hint" className="text-[11px] text-muted-foreground">
          Shown by search engines under the title. About {DESCRIPTION_HINT_LENGTH} characters fit
          ({description.trim().length} now).
        </p>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="brand" size="sm">
          Save
        </Button>
      </DialogFooter>
    </form>
  );
});
PageSettingsForm.displayName = 'PageSettingsForm';

const PageSettingsDialog: React.FC<PageSettingsDialogProps> = ({
  page,
  project,
  onClose,
  returnFocusTo,
}) => (
  <Dialog open={page !== null} onOpenChange={(open) => !open && onClose()}>
    {page && (
      <DialogContent
        data-testid="page-settings-dialog"
        data-editor-ui="true"
        // Back to the row control that opened the dialog (the menu item it may
        // have come from is gone by now).
        onCloseAutoFocus={(e) => {
          const target = returnFocusTo?.current;
          if (target && target.isConnected) {
            e.preventDefault();
            target.focus();
          }
        }}
        // Keep editor shortcuts (Delete removes the selected element, and so
        // on) from firing while the dialog has focus. Escape still reaches
        // Radix, which closes the dialog.
        onKeyDown={(e) => {
          if (e.key !== 'Escape') e.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>Page settings</DialogTitle>
          <DialogDescription>Name, address and search description of this page.</DialogDescription>
        </DialogHeader>
        {/* Keyed by page so reopening for another page starts from its values. */}
        <PageSettingsForm key={page.id} page={page} project={project} onClose={onClose} />
      </DialogContent>
    )}
  </Dialog>
);

export default PageSettingsDialog;
