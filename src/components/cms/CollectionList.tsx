'use client';

// src/components/cms/CollectionList.tsx
//
// The collection list in the editor's Content panel ("Studio" design). Each
// collection is a real row: a tinted type-icon tile, its name, and actions that
// live in a hover overflow menu (Open / Rename / Delete) rather than always-on
// inline buttons. Opening a collection (clicking the row) launches the full
// editing grid. Rename is inline; delete is confirmed. Presentational: every
// mutation is delegated to the panel via callbacks; only transient UI state
// (which row is being renamed / created / confirmed for delete) lives here.

import React from 'react';
import { Plus, MoreHorizontal, Pencil, Trash2, ArrowUpRight, Database } from 'lucide-react';
import type { Collection } from '@/lib/bindings/dataSource/types';
import { collectionIcon } from './collectionIcon';
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

export interface CollectionListProps {
  collections: Collection[];
  /** The collection whose grid is currently open (highlighted), if any. */
  openId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

const CollectionList: React.FC<CollectionListProps> = ({
  collections,
  openId,
  busy,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}) => {
  const [creating, setCreating] = React.useState(false);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<Collection | null>(null);
  const empty = collections.length === 0;

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
    <section
      aria-label="Collections"
      data-testid="cms-collection-list"
      className="flex flex-col"
    >
      <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Collections
        </span>
        <button
          type="button"
          aria-label="New collection"
          disabled={busy}
          onClick={startCreate}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Plus className="size-4" />
        </button>
      </div>

      {empty && !creating ? (
        <div
          data-testid="cms-empty-state"
          className="flex flex-col items-center px-4 py-7 text-center"
        >
          <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brand/12 text-brand">
            <Database className="size-5" />
          </span>
          <p className="text-[13.5px] font-semibold text-foreground">No collections yet</p>
          <p className="mx-auto mt-1.5 max-w-[210px] text-xs leading-relaxed text-muted-foreground">
            Collections hold the content your gallery, list, and detail pages bind to.
          </p>
          <button
            type="button"
            onClick={startCreate}
            className="mt-3.5 inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-3 text-[13px] font-semibold text-brand-foreground shadow-xs transition-colors hover:bg-brand/90"
          >
            <Plus className="size-4" />
            Create collection
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {collections.map((c) => {
            const Icon = collectionIcon(c.id);
            const active = c.id === openId;
            if (renamingId === c.id) {
              return (
                <div
                  key={c.id}
                  data-testid={`cms-collection-${c.id}`}
                  className="flex h-9 items-center gap-2.5 rounded-md px-2"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-muted text-muted-foreground">
                    <Icon className="size-3.5" />
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
                data-testid={`cms-collection-${c.id}`}
                className={[
                  'group relative flex h-9 items-center gap-2.5 rounded-md px-2 transition-colors',
                  active ? 'bg-brand/10' : 'hover:bg-accent',
                ].join(' ')}
              >
                {active && (
                  <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand" />
                )}
                <button
                  type="button"
                  aria-label={`Open ${c.name}`}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onOpen(c.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <span
                    className={[
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] transition-colors',
                      active ? 'bg-brand/15 text-brand' : 'bg-muted text-muted-foreground',
                    ].join(' ')}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <span
                    className={[
                      'truncate text-[13px] font-medium',
                      active ? 'text-brand' : 'text-foreground',
                    ].join(' ')}
                  >
                    {c.name}
                  </span>
                </button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Options for ${c.name}`}
                      disabled={busy}
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:bg-background data-[state=open]:text-foreground data-[state=open]:opacity-100"
                    >
                      <MoreHorizontal className="size-4" />
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
            <div className="flex h-9 items-center gap-2.5 rounded-md px-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-muted text-muted-foreground">
                <Database className="size-3.5" />
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
                className="min-w-0 flex-1 rounded-[5px] border border-brand bg-background px-2 py-1 text-[13px] font-medium text-foreground outline-none ring-[3px] ring-brand/20 placeholder:text-muted-foreground placeholder:font-normal"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={startCreate}
              disabled={busy}
              className="mt-0.5 flex h-9 items-center gap-2.5 rounded-md border border-dashed border-border px-2 text-[13px] text-muted-foreground transition-colors hover:border-transparent hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <Plus className="size-4" />
              New collection
            </button>
          )}
        </div>
      )}

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
              }}
            >
              Delete collection
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
};

export default CollectionList;
