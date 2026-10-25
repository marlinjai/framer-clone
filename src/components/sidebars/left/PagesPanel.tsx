// src/components/sidebars/left/PagesPanel.tsx
// Project page navigation. Lives in the top half of LeftSidebar's split pane.
// Each row is click-to-switch; hover (and, on touch screens, always) shows a
// settings button, a "more actions" button that opens the row menu, and a
// delete X.
//
// The home page (the page with the empty slug, served at the site root) cannot
// be deleted while it is the home page: the site's address would answer 404.
// Its delete X is still shown, looking disabled but focusable and tappable, and
// choosing it (or the disabled Delete menu item) explains why in a notice with
// the way out: "Set another page as home", which opens a chooser
// (SetHomePageDialog). Every other page offers "Set as home page" in its row
// menu and right-click menu; after that the former home page deletes like any
// page. A project's only page cannot be deleted either ("A site needs at least
// one page"), so the editor never ends up with no current page.
//
// Page settings (name, URL slug, meta description) open in PageSettingsDialog,
// from the row's settings button, a double-click on the row, or the "Page
// settings" item of the row's context menu (right-click, or the context-menu
// key / Shift+F10 on a focused row). The dialog is the one place a slug is
// edited, so the slug rules and their explanations live in one spot.
//
// Improvements over Framer's equivalent list:
//   - Slug shown inline under the title in muted text, always visible.
//   - Layers remains visible in the bottom pane while navigating pages.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Plus, X, FileText, Search, Settings2, Trash2, Home, MoreHorizontal, Info } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import type { PageModelType } from '@/models/PageModel';
import PageSettingsDialog from './PageSettingsDialog';
import { ContextMenu, type MenuCloseReason } from './ContextMenu';
import SetHomePageDialog, { type SetHomePageRequest } from './SetHomePageDialog';

// Re-exported for the existing tests that import it from here.
export { clampMenuPosition } from './ContextMenu';

// --- PageRow ---------------------------------------------------------------
interface PageRowProps {
  page: PageModelType;
  isActive: boolean;
  /** THE home page, served at the site root. */
  isHome: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onDelete: () => void;
  /** The delete X of a page that cannot be deleted was chosen: explain why. */
  onDeleteBlocked: (control: HTMLElement) => void;
  /** `returnTo` gets the focus back when the dialog closes. */
  onOpenSettings: (returnTo: HTMLElement | null) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  /** The row's "more actions" button: the same menu, anchored to the button. */
  onOpenMenu: (anchor: HTMLElement) => void;
}

// Row controls: shown on hover and keyboard focus, always on touch screens
// (no hover there), with a finger-sized target.
const rowControl =
  'p-0.5 rounded text-muted-foreground opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [@media(hover:none)]:p-1.5 focus-visible:opacity-100 hover:text-foreground hover:bg-accent transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const PageRow = observer(({
  page,
  isActive,
  isHome,
  canDelete,
  onSelect,
  onDelete,
  onDeleteBlocked,
  onOpenSettings,
  onContextMenu,
  onOpenMenu,
}: PageRowProps) => {
  const title = page.metadata.title;
  return (
    <div
      data-testid={`page-row-${page.id}`}
      className={`group flex items-center gap-1 pr-1 rounded transition-colors ${
        isActive ? 'bg-brand/10 border-l-2 border-brand' : 'hover:bg-accent border-l-2 border-transparent'
      }`}
      onContextMenu={onContextMenu}
      onDoubleClick={e => {
        e.stopPropagation();
        onOpenSettings(
          e.currentTarget.querySelector<HTMLElement>('[data-page-settings-button]'),
        );
      }}
      // Delete and Backspace on a focused row control must not reach the
      // editor's "delete the selected element" shortcut.
      onKeyDown={e => {
        if (e.key === 'Delete' || e.key === 'Backspace') e.stopPropagation();
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={isActive ? 'page' : undefined}
        className="flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {isHome ? (
          <Home size={12} aria-hidden="true" className={`shrink-0 ${isActive ? 'text-brand' : 'text-muted-foreground'}`} />
        ) : (
          <FileText size={12} aria-hidden="true" className={`shrink-0 ${isActive ? 'text-brand' : 'text-muted-foreground'}`} />
        )}
        <span className="flex-1 min-w-0">
          <span className={`block text-sm truncate text-foreground ${isActive ? 'font-medium' : ''}`}>
            {title}
          </span>
          <span className="block text-[10px] text-muted-foreground truncate leading-tight">
            /{page.slug}
          </span>
          {isHome && <span className="sr-only">(home page)</span>}
        </span>
      </button>
      <button
        type="button"
        data-page-settings-button=""
        onClick={e => {
          e.stopPropagation();
          onOpenSettings(e.currentTarget);
        }}
        aria-label={`Page settings for ${title}`}
        title="Page settings"
        className={rowControl}
      >
        <Settings2 size={12} />
      </button>
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          onOpenMenu(e.currentTarget);
        }}
        aria-label={`More actions for ${title}`}
        aria-haspopup="menu"
        title="More actions"
        className={rowControl}
      >
        <MoreHorizontal size={12} />
      </button>
      {canDelete ? (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Delete page ${title}`}
          title="Delete page"
          className={rowControl}
        >
          <X size={12} />
        </button>
      ) : (
        // Not the disabled attribute: it would take the button out of the tab
        // order and swallow taps, leaving touch and keyboard users with no
        // explanation. It looks disabled and explains itself when chosen.
        <button
          type="button"
          aria-disabled="true"
          onClick={e => {
            e.stopPropagation();
            onDeleteBlocked(e.currentTarget);
          }}
          aria-label={`Delete page ${title}`}
          aria-describedby={`page-delete-blocked-${page.id}`}
          title={isHome ? 'The home page cannot be deleted' : 'A site needs at least one page'}
          className={`${rowControl} cursor-help [&>svg]:opacity-40`}
        >
          <X size={12} />
          <span id={`page-delete-blocked-${page.id}`} className="sr-only">
            {isHome ? 'Not available: this is the home page.' : 'Not available: a site needs at least one page.'}
          </span>
        </button>
      )}
    </div>
  );
});
PageRow.displayName = 'PageRow';

// --- PagesPanel ------------------------------------------------------------
const PagesPanel = observer(() => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const [query, setQuery] = React.useState('');
  const [settingsPageId, setSettingsPageId] = React.useState<string | null>(null);
  // The row control focus returns to when the menu or the dialog closes.
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const [menu, setMenu] = React.useState<{ x: number; y: number; pageId: string } | null>(null);
  // The notice explaining why a page cannot be deleted, and the page it is about.
  const [deleteNotice, setDeleteNotice] = React.useState<{ pageId: string } | null>(null);
  const noticeRef = React.useRef<HTMLDivElement>(null);
  const [homeRequest, setHomeRequest] = React.useState<SetHomePageRequest>(null);

  // A new notice takes the focus (its first action, else the notice itself),
  // so keyboard and screen reader users hear it and can act on it at once;
  // focusing also scrolls it into view in a long list.
  React.useEffect(() => {
    if (!deleteNotice) return;
    const el = noticeRef.current;
    if (!el) return;
    (el.querySelector<HTMLElement>('[data-notice-action]') ?? el).focus();
  }, [deleteNotice]);

  if (!project) {
    return (
      <div className="p-4 text-center text-xs text-muted-foreground">
        No project loaded.
      </div>
    );
  }

  const pages = project.pagesArray;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? pages.filter(
        p =>
          p.metadata.title.toLowerCase().includes(q) ||
          p.slug.toLowerCase().includes(q),
      )
    : pages;

  const handleCreate = () => {
    const page = project.createPage();
    editorUI.setCurrentPage(page);
  };

  // The home page (empty slug) is what the published site serves at its root,
  // so deleting it would leave the site's address answering 404. It cannot be
  // deleted (an extra empty-slug page in an older project can).
  const canDeletePage = (pageId: string) =>
    project.pages.size > 1 && !project.isSlugLocked(pageId);
  // Choosing to delete a page that cannot be deleted explains why, in place
  // (touch screens have no hover tooltip), with the way forward.
  const explainDeleteBlocked = (pageId: string, returnTo: HTMLElement | null) => {
    returnFocusRef.current = returnTo;
    setDeleteNotice({ pageId });
  };
  const closeNotice = () => {
    setDeleteNotice(null);
    const target = returnFocusRef.current;
    if (target && target.isConnected) target.focus();
  };
  const handleDelete = (pageId: string) => {
    if (!canDeletePage(pageId)) {
      explainDeleteBlocked(pageId, returnFocusRef.current);
      return;
    }
    if (deleteNotice?.pageId === pageId) setDeleteNotice(null);
    if (editorUI.currentPage?.id === pageId) {
      const next = pages.find(p => p.id !== pageId);
      if (next) editorUI.setCurrentPage(next);
    }
    project.removePage(pageId);
  };

  const openMenu = (pageId: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    // The context-menu key (or Shift+F10) on a focused row fires this with no
    // pointer position: anchor the menu to the row instead.
    let { clientX: x, clientY: y } = event;
    if (x === 0 && y === 0) {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      x = rect.left + 16;
      y = rect.bottom;
    }
    returnFocusRef.current =
      (event.currentTarget as HTMLElement).querySelector<HTMLElement>('button') ?? null;
    setMenu({ x, y, pageId });
  };

  // The row's "more actions" button opens the same menu, below the button.
  const openMenuAt = (pageId: string, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    returnFocusRef.current = anchor;
    setMenu({ x: rect.left, y: rect.bottom, pageId });
  };

  const openSettings = (pageId: string, returnTo: HTMLElement | null) => {
    returnFocusRef.current = returnTo;
    setSettingsPageId(pageId);
  };

  // Escape or choosing an item hands focus back to the row the menu came
  // from; a click elsewhere leaves focus where that click put it.
  const closeMenu = (reason: MenuCloseReason) => {
    setMenu(null);
    if (reason !== 'outside') returnFocusRef.current?.focus();
  };

  const menuPage = menu ? project.getPage(menu.pageId) : undefined;
  const settingsPage = settingsPageId ? project.getPage(settingsPageId) ?? null : null;
  // The notice disappears by itself once its reason is gone (the page was made
  // an ordinary page, deleted, or a second page was added).
  const noticePage = deleteNotice ? project.getPage(deleteNotice.pageId) : undefined;
  const showNotice = !!noticePage && !canDeletePage(noticePage.id);
  const onlyPage = project.pages.size <= 1;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-8 shrink-0">
        <span className="text-[11px] uppercase tracking-wide font-medium text-muted-foreground">
          Pages
        </span>
        <button
          type="button"
          onClick={handleCreate}
          title="New page"
          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
        >
          <Plus size={14} />
        </button>
      </div>

      {pages.length > 3 && (
        <div className="px-2 pb-2 shrink-0">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search pages..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full pl-6 pr-2 py-1 text-xs bg-muted rounded border border-transparent focus:border-ring focus:bg-background focus:outline-none"
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-1 pb-1">
        {showNotice && noticePage && (
          <div
            ref={noticeRef}
            role="alert"
            tabIndex={-1}
            data-testid="page-delete-notice"
            data-editor-ui="true"
            onKeyDown={e => {
              // Keys pressed here never reach the editor's canvas shortcuts.
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                closeNotice();
              }
            }}
            className="mx-1 mb-2 flex gap-2 rounded-md border border-border bg-muted px-2.5 py-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p>
                {onlyPage
                  ? 'A site needs at least one page.'
                  : 'The home page cannot be deleted. Make another page the home page first.'}
              </p>
              {!onlyPage && (
                <button
                  type="button"
                  data-notice-action=""
                  onClick={() => setHomeRequest({ mode: 'choose' })}
                  className="self-start rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:py-2"
                >
                  Set another page as home
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={closeNotice}
              aria-label="Dismiss"
              className="self-start rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:p-1.5"
            >
              <X size={12} />
            </button>
          </div>
        )}
        {filtered.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground py-6 px-2">
            {q ? (
              <>
                No pages match <span className="font-mono">&ldquo;{query}&rdquo;</span>.
              </>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <span>No pages yet.</span>
                <button
                  type="button"
                  onClick={handleCreate}
                  className="inline-flex items-center gap-1 text-xs text-brand hover:text-brand"
                >
                  <Plus size={12} /> Create your first page
                </button>
              </div>
            )}
          </div>
        ) : (
          filtered.map(page => (
            <PageRow
              key={page.id}
              page={page}
              isActive={editorUI.currentPage?.id === page.id}
              isHome={project.isSlugLocked(page.id)}
              canDelete={canDeletePage(page.id)}
              onSelect={() => editorUI.setCurrentPage(page)}
              onDelete={() => handleDelete(page.id)}
              onDeleteBlocked={control => explainDeleteBlocked(page.id, control)}
              onOpenSettings={returnTo => openSettings(page.id, returnTo)}
              onContextMenu={openMenu(page.id)}
              onOpenMenu={anchor => openMenuAt(page.id, anchor)}
            />
          ))
        )}
      </div>

      {menu && menuPage && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            {
              label: 'Page settings',
              icon: <Settings2 size={14} />,
              onClick: () => setSettingsPageId(menu.pageId),
            },
            // Any page but the home page can become the home page (also in
            // an older project that has none, whose root answers 404).
            ...(!project.canBecomeHomePage(menuPage.id)
              ? []
              : [{
                  label: 'Set as home page',
                  icon: <Home size={14} />,
                  onClick: () => setHomeRequest({ mode: 'confirm', pageId: menuPage.id }),
                }]),
            {
              label: 'Delete',
              icon: <Trash2 size={14} />,
              onClick: () => handleDelete(menu.pageId),
              destructive: true,
              disabled: !canDeletePage(menuPage.id),
              onDisabledClick: () => explainDeleteBlocked(menuPage.id, returnFocusRef.current),
            },
          ]}
        />
      )}

      <PageSettingsDialog
        page={settingsPage}
        project={project}
        onClose={() => setSettingsPageId(null)}
        returnFocusTo={returnFocusRef}
      />

      <SetHomePageDialog
        project={project}
        request={homeRequest}
        onClose={() => setHomeRequest(null)}
        // The notice has done its job: the former home page is now an
        // ordinary page and can be deleted. Focus goes to that page's row (its
        // delete X was replaced by a working one, so the old element is gone).
        onDone={() => {
          const formerHomeId = deleteNotice?.pageId;
          setDeleteNotice(null);
          if (formerHomeId) {
            returnFocusRef.current =
              document.querySelector<HTMLElement>(`[data-testid="page-row-${formerHomeId}"] button`) ??
              returnFocusRef.current;
          }
        }}
        returnFocusTo={returnFocusRef}
      />
    </div>
  );
});

PagesPanel.displayName = 'PagesPanel';
export default PagesPanel;
