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
//   editable. Any other page offers "Set as home page" under its URL, confirmed
//   in place with what will happen (HomeChangeSummary), then run as
//   ProjectModel.setHomePage (its own undo step); the form then shows the page
//   as the home page.
// - On a site that has been published, a changed slug keeps the old address
//   working: the server records a redirect and it goes live with the next
//   publish (src/lib/pages/redirects.ts). The panel says so.
// - Save runs ProjectModel.updatePageSettings, one MST action, so the change is
//   one undo step and travels the same way as every other page edit.
//
// The page name doubles as the browser tab and search result title
// (pageMetadata in src/lib/site/publishedHead.ts uses metadata.title, through
// the site's title template), so there is no separate SEO title.
//
// Search and sharing: the page's own sharing image (Open Graph, an https URL;
// empty uses the site's default from Site settings), "Hide from search
// engines" (robots noindex, left out of sitemap.xml), and "Use as 404 page"
// (the page shown with status 404 for unknown addresses; one per site, never
// the home page).

import React from 'react';
import { observer } from 'mobx-react-lite';
import { Home, Wand2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { PageModelType } from '@/models/PageModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import { useSiteAddress } from '@/contexts/SiteAddressContext';
import { suggestSlug, tidySlugInput, validateSlug, SLUG_MAX_LENGTH } from '@/lib/pages/slug';
import { isHttpsUrl } from '@/lib/site/siteSettings';
import { HomeChangeSummary } from './SetHomePageDialog';

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
  // Announced by the always-mounted live region below after a failed save,
  // and cleared as soon as any field changes, so it never outlives the problem.
  const [announcement, setAnnouncement] = React.useState('');
  const [description, setDescription] = React.useState(page.metadata.description ?? '');
  // Errors show once a field was left or a save was attempted, never while the
  // person is still typing their first characters.
  const [showErrors, setShowErrors] = React.useState({ name: false, slug: false, ogImage: false });
  const [saveErrors, setSaveErrors] = React.useState<{ title?: string; slug?: string; ogImage?: string; notFoundPage?: string }>({});
  const [ogImage, setOgImage] = React.useState(page.metadata.ogImage ?? '');
  const [noIndex, setNoIndex] = React.useState(page.metadata.noIndex);
  const [notFoundPage, setNotFoundPage] = React.useState(project.site.notFoundPageId === page.id);
  const ogImageRef = React.useRef<HTMLInputElement>(null);
  // "Set as home page" asks first, in place, with what will happen.
  const [confirmHome, setConfirmHome] = React.useState(false);
  const setHomeButtonRef = React.useRef<HTMLButtonElement>(null);
  const confirmHomeRef = React.useRef<HTMLButtonElement>(null);
  // Cancelling the question hands focus back to the button that asked it
  // (once it is rendered again).
  const focusSetHomeButton = React.useRef(false);
  const cancelConfirmHome = () => {
    focusSetHomeButton.current = true;
    setConfirmHome(false);
  };
  React.useEffect(() => {
    if (confirmHome) confirmHomeRef.current?.focus();
    else if (focusSetHomeButton.current) {
      focusSetHomeButton.current = false;
      setHomeButtonRef.current?.focus();
    }
  }, [confirmHome]);

  const otherPages = project.pagesArray.map((p) => ({ id: p.id, slug: p.slug }));
  const cleanSlug = isHome ? '' : slugTouched ? tidySlugInput(slug) : page.slug;
  const slugChanged = !isHome && cleanSlug !== page.slug;

  const nameError = name.trim() ? undefined : 'Enter a page name.';
  const slugResult = isHome || !slugChanged
    ? ({ ok: true } as const)
    : validateSlug(cleanSlug, { pageId: page.id, pages: otherPages });
  const slugError = saveErrors.slug ?? (slugResult.ok ? undefined : slugResult.message);
  const titleError = saveErrors.title ?? nameError;
  const cleanOgImage = ogImage.trim();
  const ogImageError =
    saveErrors.ogImage ?? (cleanOgImage && !isHttpsUrl(cleanOgImage) ? 'Enter a full https:// address of an image.' : undefined);
  const visibleOgImageError = showErrors.ogImage || saveErrors.ogImage ? ogImageError : undefined;
  // A 404 page is never indexed, whatever its own switch says.
  const effectiveNoIndex = noIndex || notFoundPage;

  const visibleNameError = showErrors.name ? titleError : undefined;
  const visibleSlugError = showErrors.slug || saveErrors.slug ? slugError : undefined;

  const hostLabel = address.host ?? 'your-site-address';
  const previewPath = isHome ? '/' : `/${cleanSlug}`;

  // A failed save puts focus on the first field to fix and announces what is
  // wrong, so keyboard and screen reader users are not left guessing.
  const reportProblems = (problems: { title?: string; slug?: string; ogImage?: string; notFoundPage?: string }) => {
    setAnnouncement(
      ['Not saved.', problems.title, problems.slug, problems.ogImage, problems.notFoundPage].filter(Boolean).join(' '),
    );
    (problems.title ? nameRef : problems.slug ? slugRef : ogImageRef).current?.focus();
  };

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    setShowErrors({ name: true, slug: true, ogImage: true });
    if (titleError || slugError || ogImageError) {
      reportProblems({ title: titleError, slug: slugError, ogImage: ogImageError });
      return;
    }
    const result = project.updatePageSettings(page.id, {
      title: name,
      slug: isHome ? page.slug : cleanSlug,
      description,
      ogImage: cleanOgImage,
      noIndex,
      notFoundPage: isHome ? false : notFoundPage,
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
    setAnnouncement('');
    setSaveErrors((e) => ({ ...e, slug: undefined }));
    setShowErrors((s) => ({ ...s, slug: true }));
  };

  return (
    // The form fills the dialog: its fields scroll in DialogBody while the
    // Save / Cancel footer stays on screen, however short the window.
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="sr-only" role="status" aria-live="polite" data-testid="page-settings-announcement">
        {announcement}
      </div>
      <DialogBody className="flex flex-col gap-4" data-testid="page-settings-body">
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
              setAnnouncement('');
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
                just your address land here. To show another page here, open that page&rsquo;s settings
                or menu and choose &ldquo;Set as home page&rdquo;.
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
                    setAnnouncement('');
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
          {!isHome && project.canBecomeHomePage(page.id) &&
            (confirmHome ? (
              <div
                className="flex flex-col gap-2 rounded-md border border-border px-3 py-2"
                data-testid="page-settings-home-confirm"
                data-escape-local=""
                onKeyDown={(e) => {
                  // Escape cancels this question, not the whole dialog.
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelConfirmHome();
                  }
                }}
              >
                <HomeChangeSummary project={project} pageId={page.id} />
                <div className="flex flex-wrap gap-2">
                  <Button
                    ref={confirmHomeRef}
                    type="button"
                    variant="brand"
                    size="sm"
                    onClick={() => {
                      const result = project.setHomePage(page.id);
                      setConfirmHome(false);
                      setAnnouncement(result.ok ? `${page.metadata.title} is now the home page.` : result.message);
                      // The confirmation is gone; keep focus in the form, on
                      // the address that now reads "/".
                      if (result.ok) {
                        // setHomePage cleared the 404 pointer; drop the local flag too.
                        setNotFoundPage(false);
                        setTimeout(() => document.getElementById('page-settings-slug')?.focus(), 0);
                      }
                    }}
                  >
                    Set as home page
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={cancelConfirmHome}
                  >
                    Keep current home page
                  </Button>
                </div>
              </div>
            ) : (
              <button
                ref={setHomeButtonRef}
                type="button"
                onClick={() => setConfirmHome(true)}
                className="inline-flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring phone:py-1.5"
              >
                <Home size={12} aria-hidden="true" /> Set as home page
              </button>
            ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="page-settings-description" className={fieldLabel}>
            Meta description
          </label>
          <textarea
            id="page-settings-description"
            value={description}
            rows={3}
            onChange={(e) => {
              setDescription(e.target.value);
              setAnnouncement('');
            }}
            aria-describedby="page-settings-description-hint"
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-shadow focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
          />
          <p id="page-settings-description-hint" className="text-[11px] text-muted-foreground">
            Shown by search engines under the title. About {DESCRIPTION_HINT_LENGTH} characters fit
            ({description.trim().length} now).
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="page-settings-og-image" className={fieldLabel}>
            Sharing image
          </label>
          <input
            id="page-settings-og-image"
            ref={ogImageRef}
            value={ogImage}
            placeholder="https://"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setOgImage(e.target.value);
              setAnnouncement('');
              setSaveErrors((s) => ({ ...s, ogImage: undefined }));
            }}
            onBlur={() => setShowErrors((s) => ({ ...s, ogImage: true }))}
            aria-invalid={visibleOgImageError ? true : undefined}
            aria-describedby={visibleOgImageError ? 'page-settings-og-image-error' : 'page-settings-og-image-hint'}
            className={`${inputBase} ${visibleOgImageError ? inputBad : inputOk}`}
          />
          {visibleOgImageError ? (
            <p id="page-settings-og-image-error" className="text-[11px] text-destructive" aria-live="polite">
              {visibleOgImageError}
            </p>
          ) : (
            <p id="page-settings-og-image-hint" className="text-[11px] text-muted-foreground">
              Shown when this page is shared. Leave empty to use the sharing image from Site settings.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={effectiveNoIndex}
              disabled={notFoundPage}
              onChange={(e) => setNoIndex(e.target.checked)}
              aria-describedby="page-settings-noindex-hint"
              className="mt-0.5"
              data-testid="page-settings-noindex"
            />
            <span>
              Hide from search engines
              <span id="page-settings-noindex-hint" className="block text-[11px] text-muted-foreground">
                {notFoundPage
                  ? 'A 404 page is always hidden from search engines.'
                  : 'The page stays reachable by its address but is left out of search results and the sitemap.'}
              </span>
            </span>
          </label>
          {!isHome && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={notFoundPage}
                onChange={(e) => {
                  setNotFoundPage(e.target.checked);
                  setSaveErrors((s) => ({ ...s, notFoundPage: undefined }));
                }}
                aria-describedby="page-settings-404-hint"
                className="mt-0.5"
                data-testid="page-settings-404"
              />
              <span>
                Use as 404 page
                <span id="page-settings-404-hint" className="block text-[11px] text-muted-foreground">
                  Shown, with the status 404, when a visitor opens an address that does not exist on your site.
                  {project.site.notFoundPageId && project.site.notFoundPageId !== page.id && notFoundPage
                    ? ` It replaces "${project.getPage(project.site.notFoundPageId)?.metadata.title ?? 'the current 404 page'}".`
                    : ''}
                </span>
              </span>
            </label>
          )}
          {saveErrors.notFoundPage && (
            <p className="text-[11px] text-destructive" aria-live="polite">{saveErrors.notFoundPage}</p>
          )}
        </div>
      </DialogBody>

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
        // Escape inside a local question (the "Set as home page"
        // confirmation) answers that question; it does not close the dialog.
        onEscapeKeyDown={(e) => {
          const target = e.target instanceof Element ? e.target : null;
          if (target?.closest('[data-escape-local]')) e.preventDefault();
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
