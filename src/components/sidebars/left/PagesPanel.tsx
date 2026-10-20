// src/components/sidebars/left/PagesPanel.tsx
// Project page navigation. Lives in the top half of LeftSidebar's split pane.
// Each row is click-to-switch; hover reveals a settings button and a delete X
// (delete is unavailable for the home page, which the published site serves at
// its root, and when the project has a single page so the editor never ends up
// with no current page).
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
import { Plus, X, FileText, Search, Settings2, Trash2 } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import type { PageModelType } from '@/models/PageModel';
import PageSettingsDialog from './PageSettingsDialog';

// --- Context menu ----------------------------------------------------------
// Lightweight self-contained floating menu. Positions at (x, y) in viewport
// coords. Closes on outside click, Escape, or after any item fires.
interface MenuItem {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Keyboard users land on the first item.
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    // Register on the next tick so the click that opened the menu doesn't
    // immediately close it.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Up and Down move between the enabled items, wrapping around.
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length].focus();
  };

  return (
    <div
      ref={rootRef}
      role="menu"
      onKeyDown={onMenuKeyDown}
      data-editor-ui="true"
      style={{ left: x, top: y }}
      className="fixed z-[200] min-w-[160px] bg-background border border-border rounded-md shadow-lg py-1"
    >
      {items.map(item => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onClick();
            onClose();
          }}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
            item.disabled
              ? 'text-muted-foreground cursor-not-allowed'
              : item.destructive
                ? 'text-destructive hover:bg-destructive/10'
                : 'text-foreground hover:bg-accent'
          }`}
        >
          <span className="shrink-0 opacity-70">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
};

// --- PageRow ---------------------------------------------------------------
interface PageRowProps {
  page: PageModelType;
  isActive: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onOpenSettings: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

const PageRow = observer(({
  page,
  isActive,
  canDelete,
  onSelect,
  onDelete,
  onOpenSettings,
  onContextMenu,
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
        onOpenSettings();
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={isActive ? 'page' : undefined}
        className="flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FileText size={12} className={`shrink-0 ${isActive ? 'text-brand' : 'text-muted-foreground'}`} />
        <span className="flex-1 min-w-0">
          <span className={`block text-sm truncate text-foreground ${isActive ? 'font-medium' : ''}`}>
            {title}
          </span>
          <span className="block text-[10px] text-muted-foreground truncate leading-tight">
            /{page.slug}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          onOpenSettings();
        }}
        aria-label={`Page settings for ${title}`}
        title="Page settings"
        className="p-0.5 rounded text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground hover:bg-accent transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Settings2 size={12} />
      </button>
      {canDelete && (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Delete page ${title}`}
          title="Delete page"
          className="p-0.5 rounded text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground hover:bg-accent transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={12} />
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
  const [menu, setMenu] = React.useState<{ x: number; y: number; pageId: string } | null>(null);

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

  // The home page (empty slug) is what the published site serves at its root;
  // there is no other way to choose a home page, so deleting it would leave
  // the site's address answering 404. It cannot be deleted.
  const handleDelete = (pageId: string) => {
    if (project.pages.size <= 1) return;
    if (project.getPage(pageId)?.isHome) return;
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
    setMenu({ x, y, pageId });
  };

  const menuPage = menu ? project.getPage(menu.pageId) : undefined;
  const settingsPage = settingsPageId ? project.getPage(settingsPageId) ?? null : null;

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
              canDelete={pages.length > 1 && !page.isHome}
              onSelect={() => editorUI.setCurrentPage(page)}
              onDelete={() => handleDelete(page.id)}
              onOpenSettings={() => setSettingsPageId(page.id)}
              onContextMenu={openMenu(page.id)}
            />
          ))
        )}
      </div>

      {menu && menuPage && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Page settings',
              icon: <Settings2 size={14} />,
              onClick: () => setSettingsPageId(menu.pageId),
            },
            {
              label: 'Delete',
              icon: <Trash2 size={14} />,
              onClick: () => handleDelete(menu.pageId),
              destructive: true,
              disabled: pages.length <= 1 || menuPage.isHome,
            },
          ]}
        />
      )}

      <PageSettingsDialog
        page={settingsPage}
        project={project}
        onClose={() => setSettingsPageId(null)}
      />
    </div>
  );
});

PagesPanel.displayName = 'PagesPanel';
export default PagesPanel;
