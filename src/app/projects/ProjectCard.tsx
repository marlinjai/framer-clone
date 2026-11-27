'use client';
// src/app/projects/ProjectCard.tsx
//
// One project on the dashboard (/projects): the name links into the editor,
// and the card's menu ("More actions") offers Unpublish for a published site,
// and Rename, which swaps the name for
// an inline field (Enter or leaving the field saves, Escape cancels). The new
// name shows at once; when the save fails the old one comes back with the
// reason. On success the server-rendered list is refreshed so every place
// showing the name agrees with the database.

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import ProjectNameInput from '@/components/ProjectNameInput';
import DeleteProjectDialog from './DeleteProjectDialog';
import UnpublishProjectDialog from './UnpublishProjectDialog';
import { renameProject } from '@/lib/projects/renameProject';
import type { SiteCardColors } from '@/lib/site/cardColors';
import ProjectPicture from './ProjectPicture';

const FALLBACK_NAME = 'Untitled Project';

export interface ProjectCardProps {
  siteId: string;
  name: string;
  status: string;
  updatedLabel: string;
  /** `<label>.sites.lumitra.co` once the project has a published address. */
  liveHost?: string | null;
  customDomains?: string[];
  /** Open site branches, shown when site branches are on for the company (null: not shown). */
  openBranches?: number | null;
  /** The site's own colours for the card's picture (src/lib/site/cardColors.ts); null draws a neutral one. */
  cardColors?: SiteCardColors | null;
}

export default function ProjectCard({
  siteId,
  name: serverName,
  status,
  updatedLabel,
  liveHost = null,
  customDomains = [],
  openBranches = null,
  cardColors = null,
}: ProjectCardProps) {
  const router = useRouter();
  const [name, setName] = useState(serverName);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [unpublishOpen, setUnpublishOpen] = useState(false);
  // Rename, Unpublish and Delete act only once the menu has CLOSED: while the menu is
  // open it traps focus, so a field or dialog focused earlier would lose it
  // straight away. Set on select, consumed when the menu has closed.
  const chosen = useRef<'rename' | 'unpublish' | 'delete' | null>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Set when the field closes by save or cancel: focus returns to the card's
  // name instead of dropping to <body> with the unmounted input.
  const returnFocus = useRef(false);

  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      linkRef.current?.focus();
    }
  }, [editing]);

  const close = () => {
    returnFocus.current = true;
    setEditing(false);
  };

  // A refreshed server list (after this or another rename) wins over the
  // local copy, unless a save of ours is still in flight.
  useEffect(() => {
    if (!saving) setName(serverName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverName]);

  const shown = name || FALLBACK_NAME;

  // Once deleted the card is gone: focus moves to the page heading (nothing
  // else would take it). The announcement goes to the page's persistent live
  // region (see page.tsx), which outlives this card and the list refresh.
  useEffect(() => {
    if (deleted) document.getElementById('projects-heading')?.focus();
  }, [deleted]);

  if (deleted) return null;

  const save = async (next: string) => {
    close();
    const previous = name;
    if (next === previous) return;
    setError(null);
    setName(next);
    setSaving(true);
    const result = await renameProject(siteId, next, previous);
    setSaving(false);
    if (result.ok) {
      setName(result.name);
      router.refresh();
      return;
    }
    setName(result.currentName ?? previous);
    setError(result.message);
  };

  const published = status === 'published';
  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);

  return (
    // A card of the projects home (Direction A, docs/plans/2026-11-23-sites-home-and-light-mode.md): the
    // site's own colours as a picture, then the name, state and date. Keyboard focus on the name rings the
    // whole card (a complete ring on the card itself, never a one-sided edge; the card clips its picture, so
    // the ring cannot sit on the link's overlay).
    <div className="relative flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-home transition-colors hover:border-input has-[a:focus-visible]:border-transparent has-[a:focus-visible]:shadow-selection">
      <ProjectPicture colors={cardColors} name={shown} />
      <div className="flex items-start gap-2 p-3.5">
      <div className="min-w-0 flex-1">
        {editing ? (
          <ProjectNameInput
            initialName={name}
            onSubmit={(next) => void save(next)}
            onCancel={close}
            className="relative z-10 w-full font-medium"
          />
        ) : (
          // The link covers the whole card (after:inset-0) so the card stays
          // one big click target, while the menu button sits above it.
          <Link
            ref={linkRef}
            href={`/projects/${siteId}`}
            aria-busy={saving || undefined}
            className="block truncate font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {shown}
          </Link>
        )}
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden="true"
            className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${published ? 'bg-status-published' : 'bg-status-draft'}`}
          />
          <span className="truncate">
            {statusLabel}
            {/* The address only while it is live: a draft keeps its reserved subdomain, but nobody reaches it. */}
            {published && liveHost ? ` · ${liveHost}` : null}
          </span>
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          Updated {updatedLabel}
          {openBranches ? ` · ${openBranches} ${openBranches === 1 ? 'open branch' : 'open branches'}` : null}
        </span>
        {error ? (
          <p role="alert" className="relative z-10 mt-1 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={triggerRef}
          aria-label={`More actions for ${shown}`}
          className="relative z-10 -mr-1.5 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:shadow-selection"
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          // Instead of returning focus to the trigger, hand it to the rename
          // field, which focuses itself when it mounts.
          onCloseAutoFocus={(e) => {
            const action = chosen.current;
            chosen.current = null;
            if (action === 'rename') {
              e.preventDefault();
              setError(null);
              setEditing(true);
            } else if (action === 'unpublish') {
              e.preventDefault();
              setError(null);
              setUnpublishOpen(true);
            } else if (action === 'delete') {
              e.preventDefault();
              setError(null);
              setDeleteOpen(true);
            }
          }}
        >
          <DropdownMenuItem
            // One rename at a time: a second one started while the first is
            // in flight would report a false conflict.
            disabled={saving}
            onSelect={() => {
              chosen.current = 'rename';
            }}
          >
            Rename
          </DropdownMenuItem>
          {published ? (
            <DropdownMenuItem
              disabled={saving}
              onSelect={() => {
                chosen.current = 'unpublish';
              }}
            >
              Unpublish
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            disabled={saving}
            className="text-destructive focus:text-destructive"
            onSelect={() => {
              chosen.current = 'delete';
            }}
          >
            Delete project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
      <UnpublishProjectDialog
        open={unpublishOpen}
        onOpenChange={setUnpublishOpen}
        siteId={siteId}
        name={shown}
        liveHost={liveHost}
        customDomains={customDomains}
        onSettled={(announcement) => {
          if (announcement) {
            const status = document.getElementById('projects-status');
            if (status) status.textContent = announcement;
          }
          router.refresh();
        }}
        returnFocusTo={() => triggerRef.current}
      />
      <DeleteProjectDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        siteId={siteId}
        name={name}
        published={status === 'published'}
        liveHost={liveHost}
        customDomains={customDomains}
        onDeleted={(announcement) => {
          const status = document.getElementById('projects-status');
          if (status) status.textContent = announcement;
          setDeleteOpen(false);
          setDeleted(true);
          router.refresh();
        }}
        // Cancelled: back to this card's menu button. (Deleted: the card
        // unmounts and the effect above moves focus to the page heading.)
        returnFocusTo={() => triggerRef.current}
      />
    </div>
  );
}
