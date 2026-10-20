'use client';
// src/app/projects/ProjectCard.tsx
//
// One project on the dashboard (/projects): the name links into the editor,
// and the card's menu ("More actions") offers Rename, which swaps the name for
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
import { renameProject } from '@/lib/projects/renameProject';

const FALLBACK_NAME = 'Untitled Project';

export interface ProjectCardProps {
  siteId: string;
  name: string;
  status: string;
  updatedLabel: string;
}

export default function ProjectCard({ siteId, name: serverName, status, updatedLabel }: ProjectCardProps) {
  const router = useRouter();
  const [name, setName] = useState(serverName);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rename opens the field only once the menu has CLOSED: while the menu is
  // open it traps focus, so a field focused earlier would be blurred straight
  // away (and blur saves). Set on select, consumed when the menu has closed.
  const renameChosen = useRef(false);

  // A refreshed server list (after this or another rename) wins over the
  // local copy, unless a save of ours is still in flight.
  useEffect(() => {
    if (!saving) setName(serverName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverName]);

  const shown = name || FALLBACK_NAME;

  const save = async (next: string) => {
    setEditing(false);
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

  return (
    <div className="relative flex items-center justify-between gap-4 rounded-lg border p-4 transition-colors hover:bg-accent">
      <div className="min-w-0 flex-1">
        {editing ? (
          <ProjectNameInput
            initialName={name}
            onSubmit={(next) => void save(next)}
            onCancel={() => setEditing(false)}
            className="w-full max-w-sm font-medium"
          />
        ) : (
          // The link covers the whole card (after:inset-0) so the card stays
          // one big click target, while the menu button sits above it.
          <Link
            href={`/projects/${siteId}`}
            aria-busy={saving || undefined}
            className="block truncate font-medium after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-brand"
          >
            {shown}
          </Link>
        )}
        <span className="mt-0.5 block text-xs text-muted-foreground">Updated {updatedLabel}</span>
        {error ? (
          <p role="alert" className="relative z-10 mt-1 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
        {status}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`More actions for ${shown}`}
          className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          // Instead of returning focus to the trigger, hand it to the rename
          // field, which focuses itself when it mounts.
          onCloseAutoFocus={(e) => {
            if (renameChosen.current) {
              renameChosen.current = false;
              e.preventDefault();
              setError(null);
              setEditing(true);
            }
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              renameChosen.current = true;
            }}
          >
            Rename
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
