'use client';

// src/components/cms/CollectionSettingsDialog.tsx
//
// Collection settings: rename, pick an icon, and view the (auto-generated) slug.
// Opened from a collection's overflow menu. The chosen icon is persisted on the
// collection (its table `icon` field); the slug follows the name (read-only for
// now: an editable override would need a dedicated storage column).

import React from 'react';
import type { Collection } from '@/lib/bindings/dataSource/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  COLLECTION_ICON_MAP,
  COLLECTION_ICON_KEYS,
  type CollectionIconName,
} from './collectionIcon';

export interface CollectionSettingsDialogProps {
  /** The collection being edited, or null when the dialog is closed. */
  collection: Collection | null;
  busy: boolean;
  onClose: () => void;
  onSave: (id: string, updates: { name?: string; icon?: string }) => void;
}

const CollectionSettingsDialog: React.FC<CollectionSettingsDialogProps> = ({
  collection,
  busy,
  onClose,
  onSave,
}) => {
  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState<CollectionIconName | null>(null);

  React.useEffect(() => {
    if (collection) {
      setName(collection.name);
      setIcon(
        collection.icon && collection.icon in COLLECTION_ICON_MAP
          ? (collection.icon as CollectionIconName)
          : null,
      );
    }
  }, [collection]);

  const submit = () => {
    if (!collection) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    onSave(collection.id, { name: trimmed, ...(icon ? { icon } : {}) });
    onClose();
  };

  return (
    <Dialog open={collection !== null} onOpenChange={(o) => !o && onClose()}>
      {collection && (
        <DialogContent data-testid="cms-settings-dialog">
          <DialogHeader>
            <DialogTitle>Collection settings</DialogTitle>
            <DialogDescription>Name, icon, and slug for this collection.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="cms-settings-name"
                className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Name
              </label>
              <input
                id="cms-settings-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none transition-shadow focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Icon
              </span>
              <div className="grid grid-cols-8 gap-1.5">
                {COLLECTION_ICON_KEYS.map((key) => {
                  const Ico = COLLECTION_ICON_MAP[key];
                  const selected = icon === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-label={`Icon ${key}`}
                      aria-pressed={selected}
                      onClick={() => setIcon(key)}
                      className={[
                        'flex h-9 items-center justify-center rounded-md border transition-colors',
                        selected
                          ? 'border-brand bg-brand/10 text-brand'
                          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                      ].join(' ')}
                    >
                      <Ico className="size-4" />
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Slug
              </span>
              <div className="flex h-9 items-center rounded-md border border-input bg-muted px-3 font-mono text-[13px] text-muted-foreground">
                {collection.slug}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Generated from the name. Used by bindings and storefront URLs.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="brand"
              size="sm"
              disabled={busy || name.trim().length === 0}
              onClick={submit}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
};

export default CollectionSettingsDialog;
