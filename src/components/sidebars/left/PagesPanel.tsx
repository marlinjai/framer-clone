// src/components/sidebars/left/PagesPanel.tsx
// Project page navigation. Lives in the top half of LeftSidebar's split pane.
// Each row is click-to-switch; hover reveals a delete X (disabled when the
// project has a single page so the editor never ends up with no current page).
//
// Right-click any row for a context menu with Rename title, Edit slug, and
// Delete. Rename / Edit slug become inline text inputs — commit on Enter or
// blur, revert on Escape. Slug edits are rejected (row flashes red, revert)
// if the slug is already taken within the project.
//
// Improvements over Framer's equivalent list:
//   - Slug shown inline under the title in muted text, always visible.
//   - Layers remains visible in the bottom pane while navigating pages.
//   - Rename/slug edit are inline and immediate, no modal.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Plus, X, FileText, Search, Pencil, Link2, Trash2 } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import type { PageModelType } from '@/models/PageModel';
import type { ProjectModelType } from '@/models/ProjectModel';

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

  return (
    <div
      ref={rootRef}
      data-editor-ui="true"
      style={{ left: x, top: y }}
      className="fixed z-[200] min-w-[160px] bg-white border border-gray-200 rounded-md shadow-lg py-1"
    >
      {items.map(item => (
        <button
          key={item.label}
          type="button"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onClick();
            onClose();
          }}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
            item.disabled
              ? 'text-gray-300 cursor-not-allowed'
              : item.destructive
                ? 'text-red-600 hover:bg-red-50'
                : 'text-gray-700 hover:bg-gray-50'
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
type EditField = null | 'title' | 'slug';

interface PageRowProps {
  page: PageModelType;
  project: ProjectModelType;
  isActive: boolean;
  canDelete: boolean;
  editingField: EditField;
  onSelect: () => void;
  onDelete: () => void;
  onBeginEdit: (field: Exclude<EditField, null>) => void;
  onEndEdit: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

const PageRow = observer(({
  page,
  project,
  isActive,
  canDelete,
  editingField,
  onSelect,
  onDelete,
  onBeginEdit,
  onEndEdit,
  onContextMenu,
}: PageRowProps) => {
  const [draft, setDraft] = React.useState('');
  const [invalid, setInvalid] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Reset draft when editing mode toggles on.
  React.useEffect(() => {
    if (editingField === 'title') setDraft(page.metadata.title);
    else if (editingField === 'slug') setDraft(page.slug);
    setInvalid(false);
    // Focus + select-all on the next frame so the input is actually mounted.
    if (editingField !== null) {
      const t = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => clearTimeout(t);
    }
  }, [editingField, page.metadata.title, page.slug]);

  const commit = () => {
    if (!editingField) return;
    const value = draft.trim();
    if (editingField === 'title') {
      if (!value || value === page.metadata.title) {
        onEndEdit();
        return;
      }
      project.renamePage(page.id, value);
      onEndEdit();
    } else if (editingField === 'slug') {
      if (!value || value === page.slug) {
        onEndEdit();
        return;
      }
      const ok = project.setPageSlug(page.id, value);
      if (!ok) {
        // Flash red and keep the field open so the user can try again.
        setInvalid(true);
        return;
      }
      onEndEdit();
    }
  };

  const cancel = () => {
    setInvalid(false);
    onEndEdit();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
    // Stop global editor shortcuts (Delete = remove component etc.) from
    // firing while the input has focus.
    e.stopPropagation();
  };

  return (
    <div
      className={`group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
        isActive ? 'bg-blue-50 border-l-2 border-blue-500' : 'hover:bg-gray-50 border-l-2 border-transparent'
      }`}
      onClick={() => {
        if (editingField) return;
        onSelect();
      }}
      onContextMenu={onContextMenu}
    >
      <FileText size={12} className={`shrink-0 ${isActive ? 'text-blue-600' : 'text-gray-400'}`} />
      <div className="flex-1 min-w-0">
        {editingField === 'title' ? (
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={onKeyDown}
            onClick={e => e.stopPropagation()}
            className="w-full bg-white border border-blue-400 rounded px-1 py-[1px] text-sm text-gray-900 outline-none"
          />
        ) : (
          <div
            className={`text-sm truncate ${isActive ? 'font-medium text-gray-900' : 'text-gray-700'}`}
            onDoubleClick={e => {
              e.stopPropagation();
              onBeginEdit('title');
            }}
          >
            {page.metadata.title}
          </div>
        )}
        {editingField === 'slug' ? (
          <div className="flex items-center gap-0.5">
            <span className="text-[10px] text-gray-400">/</span>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={onKeyDown}
              onClick={e => e.stopPropagation()}
              className={`flex-1 min-w-0 bg-white border rounded px-1 py-[1px] text-[10px] text-gray-700 outline-none ${
                invalid ? 'border-red-400' : 'border-blue-400'
              }`}
              title={invalid ? 'Slug already in use' : undefined}
            />
          </div>
        ) : (
          page.slug && (
            <div
              className="text-[10px] text-gray-400 truncate leading-tight"
              onDoubleClick={e => {
                e.stopPropagation();
                onBeginEdit('slug');
              }}
            >
              /{page.slug}
            </div>
          )
        )}
      </div>
      {canDelete && editingField === null && (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete page"
          className="p-0.5 rounded text-gray-400 opacity-0 group-hover:opacity-100 hover:text-gray-700 hover:bg-gray-200 transition-opacity"
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
  const [editingPageId, setEditingPageId] = React.useState<string | null>(null);
  const [editingField, setEditingField] = React.useState<EditField>(null);
  const [menu, setMenu] = React.useState<{ x: number; y: number; pageId: string } | null>(null);

  if (!project) {
    return (
      <div className="p-4 text-center text-xs text-gray-400">
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

  const handleDelete = (pageId: string) => {
    if (project.pages.size <= 1) return;
    if (editorUI.currentPage?.id === pageId) {
      const next = pages.find(p => p.id !== pageId);
      if (next) editorUI.setCurrentPage(next);
    }
    project.removePage(pageId);
  };

  const openMenu = (pageId: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, pageId });
  };

  const beginEdit = (pageId: string, field: Exclude<EditField, null>) => {
    setEditingPageId(pageId);
    setEditingField(field);
  };
  const endEdit = () => {
    setEditingPageId(null);
    setEditingField(null);
  };

  const menuPage = menu ? project.getPage(menu.pageId) : undefined;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-8 shrink-0">
        <span className="text-[11px] uppercase tracking-wide font-medium text-gray-500">
          Pages
        </span>
        <button
          type="button"
          onClick={handleCreate}
          title="New page"
          className="p-0.5 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-100"
        >
          <Plus size={14} />
        </button>
      </div>

      {pages.length > 3 && (
        <div className="px-2 pb-2 shrink-0">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search pages..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full pl-6 pr-2 py-1 text-xs bg-gray-50 rounded border border-transparent focus:border-gray-200 focus:bg-white focus:outline-none"
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-1 pb-1">
        {filtered.length === 0 ? (
          <div className="text-center text-xs text-gray-400 py-6 px-2">
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
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
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
              project={project}
              isActive={editorUI.currentPage?.id === page.id}
              canDelete={pages.length > 1}
              editingField={editingPageId === page.id ? editingField : null}
              onSelect={() => editorUI.setCurrentPage(page)}
              onDelete={() => handleDelete(page.id)}
              onBeginEdit={field => beginEdit(page.id, field)}
              onEndEdit={endEdit}
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
              label: 'Rename',
              icon: <Pencil size={14} />,
              onClick: () => beginEdit(menu.pageId, 'title'),
            },
            {
              label: 'Edit slug',
              icon: <Link2 size={14} />,
              onClick: () => beginEdit(menu.pageId, 'slug'),
            },
            {
              label: 'Delete',
              icon: <Trash2 size={14} />,
              onClick: () => handleDelete(menu.pageId),
              destructive: true,
              disabled: pages.length <= 1,
            },
          ]}
        />
      )}
    </div>
  );
});

PagesPanel.displayName = 'PagesPanel';
export default PagesPanel;
