'use client';

// src/components/cms/CollectionRail.tsx
//
// The collections rail in the CMS workspace. It lists every collection with an
// icon tile, name, item count, active state, and hover overflow menu
// (Open / Rename / Settings / Delete). Clicking a row calls onOpen(id) to swap
// the center grid without closing the workspace.
//
// Phase 1 ships only the Collections tab (functional). Fields and Bindings are
// rendered as disabled "coming soon" tabs. The toolbar renders + (new collection,
// wired) plus sort / filter / search / more as visibly disabled placeholders so
// the layout matches the mockup without shipping half-built controls.
//
// This is a NEW presentational component that calls the same ContentManagerPanel
// handlers as CollectionList. No CRUD logic is forked here.

import React from 'react';
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  ArrowUpRight,
  Database,
  Settings2,
  ArrowUpDown,
  ListFilter,
  Search,
} from 'lucide-react';
import type { Collection } from '@/lib/bindings/dataSource/types';
import { resolveCollectionIcon } from './collectionIcon';
import CollectionSettingsDialog from './CollectionSettingsDialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';

export interface CollectionRailProps {
  collections: Collection[];
  activeId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onUpdate: (id: string, updates: { name?: string; icon?: string }) => void;
  onDelete: (id: string) => void;
}

// Local tab type for the rail segment (Collections is active; Fields/Bindings are
// disabled placeholders).
type RailTab = 'collections' | 'fields' | 'bindings';

const CollectionRail: React.FC<CollectionRailProps> = ({
  collections,
  activeId,
  busy,
  onOpen,
  onCreate,
  onRename,
  onUpdate,
  onDelete,
}) => {
  const [activeTab] = React.useState<RailTab>('collections');
  const [creating, setCreating] = React.useState(false);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<Collection | null>(null);
  const [settingsFor, setSettingsFor] = React.useState<Collection | null>(null);

  const startCreate = () => {
    setRenamingId(null);
    setCreating(true);
  };

  const commitCreate = (raw: string) => {
    const name = raw.trim();
    setCreating(false);
    if (name.length > 0) onCreate(name);
  };

  const commitRename = (id: string, raw: string, original: string) => {
    const name = raw.trim();
    setRenamingId(null);
    if (name.length > 0 && name !== original) onRename(id, name);
  };

  return (
    <aside
      aria-label="Collections rail"
      data-testid="cms-collection-rail"
      className="flex w-[248px] shrink-0 flex-col border-r border-border bg-muted/40"
    >
      {/* Tab row: Collections active, Fields + Bindings disabled */}
      <div
        role="tablist"
        aria-label="Rail tabs"
        className="flex gap-0.5 border-b border-border p-2"
      >
        <button
          role="tab"
          aria-selected={activeTab === 'collections'}
          data-testid="rail-tab-collections"
          type="button"
          className="flex-1 rounded-[6px] bg-background py-1.5 text-center text-[12px] font-medium text-foreground shadow-xs"
        >
          Collections
        </button>
        <button
          role="tab"
          aria-selected={false}
          aria-disabled="true"
          disabled
          data-testid="rail-tab-fields"
          type="button"
          title="Coming soon"
          className="flex-1 cursor-not-allowed rounded-[6px] py-1.5 text-center text-[12px] font-medium text-muted-foreground opacity-50"
        >
          Fields
        </button>
        <button
          role="tab"
          aria-selected={false}
          aria-disabled="true"
          disabled
          data-testid="rail-tab-bindings"
          type="button"
          title="Coming soon"
          className="flex-1 cursor-not-allowed rounded-[6px] py-1.5 text-center text-[12px] font-medium text-muted-foreground opacity-50"
        >
          Bindings
        </button>
      </div>

      {/* Toolbar: + is wired, sort/filter/search/more are disabled placeholders */}
      <div className="flex items-center gap-0.5 px-2 py-1.5">
        <button
          type="button"
          aria-label="New collection"
          data-testid="rail-toolbar-new"
          disabled={busy}
          onClick={startCreate}
          className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Plus className="size-[15px]" />
        </button>
        <button
          type="button"
          aria-label="Sort (coming soon)"
          data-testid="rail-toolbar-sort"
          disabled
          title="Coming soon"
          className="inline-flex h-[26px] w-[26px] cursor-not-allowed items-center justify-center rounded-[6px] text-muted-foreground opacity-40"
        >
          <ArrowUpDown className="size-[15px]" />
        </button>
        <button
          type="button"
          aria-label="Filter (coming soon)"
          data-testid="rail-toolbar-filter"
          disabled
          title="Coming soon"
          className="inline-flex h-[26px] w-[26px] cursor-not-allowed items-center justify-center rounded-[6px] text-muted-foreground opacity-40"
        >
          <ListFilter className="size-[15px]" />
        </button>
        <button
          type="button"
          aria-label="Search (coming soon)"
          data-testid="rail-toolbar-search"
          disabled
          title="Coming soon"
          className="inline-flex h-[26px] w-[26px] cursor-not-allowed items-center justify-center rounded-[6px] text-muted-foreground opacity-40"
        >
          <Search className="size-[15px]" />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          aria-label="More options (coming soon)"
          data-testid="rail-toolbar-more"
          disabled
          title="Coming soon"
          className="inline-flex h-[26px] w-[26px] cursor-not-allowed items-center justify-center rounded-[6px] text-muted-foreground opacity-40"
        >
          <MoreHorizontal className="size-[15px]" />
        </button>
      </div>

      {/* Collection rows */}
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {collections.length === 0 && !creating ? (
          <div
            data-testid="cms-rail-empty-state"
            className="flex flex-col items-center px-4 py-6 text-center"
          >
            <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-brand/12 text-brand">
              <Database className="size-5" />
            </span>
            <p className="text-[12.5px] font-semibold text-foreground">No collections yet</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Create your first collection
            </p>
            <button
              type="button"
              onClick={startCreate}
              disabled={busy}
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-3 text-[13px] font-semibold text-brand-foreground shadow-xs transition-colors hover:bg-brand/90 disabled:opacity-50"
            >
              <Plus className="size-4" />
              New collection
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 pt-1">
            {collections.map((c) => {
              const Icon = resolveCollectionIcon(c.icon, c.id);
              const active = c.id === activeId;

              if (renamingId === c.id) {
                return (
                  <div
                    key={c.id}
                    data-testid={`cms-rail-collection-${c.id}`}
                    className="flex h-8 items-center gap-2.5 rounded-[6px] px-2"
                  >
                    <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] bg-muted text-muted-foreground">
                      <Icon className="size-[13px]" />
                    </span>
                    <input
                      autoFocus
                      defaultValue={c.name}
                      aria-label={`Rename ${c.name}`}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(c.id, e.currentTarget.value, c.name);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onBlur={(e) => commitRename(c.id, e.currentTarget.value, c.name)}
                      className="min-w-0 flex-1 rounded-[5px] border border-brand bg-background px-2 py-1 text-[13px] font-medium text-foreground outline-none ring-[3px] ring-brand/20"
                    />
                  </div>
                );
              }

              return (
                <div
                  key={c.id}
                  data-testid={`cms-rail-collection-${c.id}`}
                  className={[
                    'group relative flex h-8 cursor-pointer items-center gap-2.5 rounded-[6px] px-2 transition-colors',
                    active ? 'bg-brand/10' : 'hover:bg-accent',
                  ].join(' ')}
                  onClick={() => !active && onOpen(c.id)}
                >
                  {active && (
                    <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand" />
                  )}
                  <span
                    className={[
                      'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] border transition-colors',
                      active
                        ? 'border-transparent bg-brand/12 text-brand'
                        : 'border-border bg-background text-muted-foreground',
                    ].join(' ')}
                  >
                    <Icon className="size-[13px]" />
                  </span>
                  <span
                    className={[
                      'min-w-0 flex-1 truncate text-[13px] font-medium',
                      active ? 'text-brand' : 'text-foreground',
                    ].join(' ')}
                  >
                    {c.name}
                  </span>
                  {typeof c.itemCount === 'number' && (
                    <span
                      data-testid={`cms-rail-count-${c.id}`}
                      className="shrink-0 font-mono text-[11px] text-muted-foreground"
                    >
                      {c.itemCount}
                    </span>
                  )}

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Options for ${c.name}`}
                        disabled={busy}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:bg-background data-[state=open]:text-foreground data-[state=open]:opacity-100"
                      >
                        <MoreHorizontal className="size-[13px]" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onSelect={() => onOpen(c.id)}>
                        <ArrowUpRight />
                        Open
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setRenamingId(c.id)}>
                        <Pencil />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setSettingsFor(c)}>
                        <Settings2 />
                        Settings
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setPendingDelete(c)}
                      >
                        <Trash2 />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}

            {creating ? (
              <div className="flex h-8 items-center gap-2.5 rounded-[6px] px-2">
                <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] bg-muted text-muted-foreground">
                  <Database className="size-[13px]" />
                </span>
                <input
                  autoFocus
                  aria-label="New collection name"
                  placeholder="Collection name"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitCreate(e.currentTarget.value);
                    if (e.key === 'Escape') setCreating(false);
                  }}
                  onBlur={(e) => commitCreate(e.currentTarget.value)}
                  className="min-w-0 flex-1 rounded-[5px] border border-brand bg-background px-2 py-1 text-[13px] font-medium text-foreground outline-none ring-[3px] ring-brand/20 placeholder:font-normal placeholder:text-muted-foreground"
                />
              </div>
            ) : (
              <button
                type="button"
                data-testid="cms-rail-new-collection"
                onClick={startCreate}
                disabled={busy}
                className="mt-0.5 flex h-8 items-center gap-2.5 rounded-[6px] border border-dashed border-border px-2 text-[13px] text-muted-foreground transition-colors hover:border-transparent hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <Plus className="size-[15px]" />
                New collection
              </button>
            )}
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/12 text-destructive">
                <Trash2 className="size-[18px]" />
              </span>
              <div className="flex flex-col gap-1">
                <AlertDialogTitle>Delete &ldquo;{pendingDelete?.name}&rdquo;?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes the collection and all of its items. This can&rsquo;t be
                  undone.
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) onDelete(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete collection
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CollectionSettingsDialog
        collection={settingsFor}
        busy={busy}
        onClose={() => setSettingsFor(null)}
        onSave={onUpdate}
      />
    </aside>
  );
};

export default CollectionRail;
