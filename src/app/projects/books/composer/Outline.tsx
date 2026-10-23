'use client';

// src/app/projects/books/composer/Outline.tsx
//
// The composer's left panel (visual template composer plan, decision 11): the
// block palette and the outline of the regions and their blocks.
//
// The palette offers the block types the target region allows; one that may
// not be added says why ("Already in the template", "Not allowed in the
// footer") instead of disappearing. The outline is the accessible
// representation of the page: one list per document, the regions as groups
// and their blocks as rows, sortable by pointer and by keyboard through
// `SortableOutline` (@marlinjai/block-editor-react: Space or Enter on a drag
// handle picks a block up, the arrow keys move it, Space or Enter drops it,
// Escape cancels; every step is announced with the blocks' names). A drop
// into a region the block may not stand in is refused and announced. The
// arrow keys move between the blocks' names, Enter opens the selected block
// in the inspector. Required blocks carry a lock badge and no remove action.

import { SortableOutline, type OutlineEntry, type OutlineMove, type OutlineRow } from '@marlinjai/block-editor-react/outline';
import { GripVertical, Lock } from 'lucide-react';
import React, { useRef } from 'react';

import type { TemplateProblemView } from '@/lib/books/api';

import {
  BLOCK_INFO,
  PALETTE_ORDER,
  REGION_LABELS,
  REGIONS,
  blockAllowedIn,
  canAdd,
  isRequired,
  locate,
  regionList,
  requiredReason,
  type BlockType,
  type RegionName,
  type TemplateDocumentV2,
} from './doc';

const GROUP_PREFIX = 'region:';
const groupId = (r: RegionName) => `${GROUP_PREFIX}${r}`;
const regionOfGroup = (id: string): RegionName | null => {
  const r = id.startsWith(GROUP_PREFIX) ? id.slice(GROUP_PREFIX.length) : null;
  return r && (REGIONS as readonly string[]).includes(r) ? (r as RegionName) : null;
};

export interface OutlineProps {
  doc: TemplateDocumentV2;
  selectedId: string | null;
  problems: TemplateProblemView[];
  /** The region new blocks go to. */
  targetRegion: RegionName;
  onTargetRegion: (region: RegionName) => void;
  onSelect: (blockId: string | null) => void;
  onAdd: (type: BlockType, region: RegionName) => void;
  onMove: (blockId: string, region: RegionName, index: number) => void;
  /** A refused move, said through the composer's live region. */
  onRefused: (message: string) => void;
  /** Enter on a block: move focus to the inspector. */
  onOpenInspector: () => void;
}

export default function Outline(props: OutlineProps) {
  const { doc, selectedId, problems, targetRegion, onTargetRegion, onSelect, onAdd, onMove, onRefused, onOpenInspector } = props;
  const list = useRef<HTMLDivElement>(null);

  const entries: OutlineEntry[] = REGIONS.map((r) => ({ id: groupId(r), type: 'group', children: regionList(doc, r).map((b) => b.id) }));

  const labelOf = (row: OutlineRow): string => {
    if (row.kind === 'group') return REGION_LABELS[regionOfGroup(row.id)!];
    if (row.kind === 'end') return `the end of the ${REGION_LABELS[regionOfGroup(row.parent)!].toLowerCase()}`;
    const at = locate(doc, row.id);
    return at ? BLOCK_INFO[at.block.type].label : row.id;
  };

  function handleMove(move: OutlineMove) {
    if (move.kind !== 'move-leaf') return; // regions are fixed: they never move
    const at = locate(doc, move.leafId);
    if (!at) return;
    const region = move.groupId ? regionOfGroup(move.groupId) : null;
    if (!region) {
      onRefused(`${BLOCK_INFO[at.block.type].label} stays in a region. Drop it inside one.`);
      return;
    }
    if (!blockAllowedIn(at.block, region)) {
      onRefused(`${BLOCK_INFO[at.block.type].label} cannot stand in the ${REGION_LABELS[region].toLowerCase()}.`);
      return;
    }
    onMove(move.leafId, region, move.index);
  }

  /** Arrow keys move between the blocks' names; Enter opens the inspector. */
  function onRowKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.altKey) return; // Alt+Up and Alt+Down move the block (the composer handles them)
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End' && e.key !== 'Enter') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpenInspector();
      return;
    }
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-outline-select]') ?? []);
    const i = buttons.indexOf(e.currentTarget);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : i + (e.key === 'ArrowDown' ? 1 : -1);
    const target = buttons[Math.max(0, Math.min(next, buttons.length - 1))];
    if (target) {
      e.preventDefault();
      target.focus();
      onSelect(target.dataset.outlineSelect ?? null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="palette-title" className="flex flex-col gap-2">
        <h2 id="palette-title" className="text-sm font-semibold">
          Add a block
        </h2>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          To
          <select
            className="rounded-md border border-gray-300 px-2 py-1 text-sm"
            value={targetRegion}
            onChange={(e) => onTargetRegion(e.target.value as RegionName)}
          >
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {REGION_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <ul className="grid grid-cols-2 gap-1">
          {PALETTE_ORDER.map((type) => {
            const check = canAdd(doc, type, targetRegion);
            const reasonId = `palette-${type}-reason`;
            return (
              <li key={type}>
                <button
                  type="button"
                  className="flex w-full flex-col items-start rounded-md border px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-blue-600 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
                  aria-disabled={!check.ok || undefined}
                  aria-describedby={check.ok ? undefined : reasonId}
                  onClick={() => (check.ok ? onAdd(type, targetRegion) : onRefused(`${BLOCK_INFO[type].label}: ${check.reason}`))}
                >
                  <span className="flex items-center gap-1 font-medium">
                    {BLOCK_INFO[type].label}
                    {isRequired(type) ? <Lock aria-hidden className="size-3" /> : null}
                  </span>
                  {check.ok ? null : (
                    <span id={reasonId} className="text-xs text-muted-foreground">
                      {check.reason}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="outline-title" className="flex flex-col gap-2" ref={list}>
        <h2 id="outline-title" className="text-sm font-semibold">
          Document structure
        </h2>
        <p className="text-xs text-muted-foreground">
          Arrow keys move between blocks. To move a block: Alt with the up or down arrow, or pick it up with Space on its handle.
        </p>
        <SortableOutline
          entries={entries}
          label="Document structure"
          onMove={handleMove}
          rowLabel={labelOf}
          renderRow={({ row, setNodeRef, style, dragHandleProps, isDragging, isOver }) => {
            if (row.kind === 'group') {
              const region = regionOfGroup(row.id)!;
              return (
                <div ref={setNodeRef} style={style} className="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  {REGION_LABELS[region]}
                </div>
              );
            }
            if (row.kind === 'end') {
              const region = regionOfGroup(row.parent)!;
              return (
                <div ref={setNodeRef} style={style} className={`h-2 rounded ${isOver ? 'bg-blue-200' : ''}`}>
                  {regionList(doc, region).length === 0 ? <span className="text-xs text-muted-foreground">Empty</span> : null}
                </div>
              );
            }
            const at = locate(doc, row.id);
            if (!at) return <div ref={setNodeRef} style={style} />;
            const type = at.block.type;
            const required = isRequired(type, at.region);
            const selected = row.id === selectedId;
            const count = problems.filter((p) => p.blockId === row.id).length;
            const label = BLOCK_INFO[type].label;
            return (
              <div
                ref={setNodeRef}
                style={style}
                className={`flex items-center gap-1 rounded-md pl-2 ${selected ? 'bg-blue-50 ring-1 ring-blue-500' : ''} ${isDragging ? 'opacity-50' : ''}`}
              >
                <button
                  type="button"
                  {...dragHandleProps}
                  aria-label={`Move ${label}`}
                  className="cursor-grab rounded p-0.5 text-gray-400 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-blue-600"
                >
                  <GripVertical aria-hidden className="size-4" />
                </button>
                <button
                  type="button"
                  data-outline-select={row.id}
                  aria-current={selected || undefined}
                  className="flex flex-1 items-center gap-1 py-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-blue-600"
                  onClick={() => onSelect(row.id)}
                  onKeyDown={onRowKey}
                >
                  <span>{label}</span>
                  {type === 'freeText' && at.block.type === 'freeText' ? (
                    <span className="truncate text-xs text-muted-foreground">{at.block.heading ?? at.block.text.slice(0, 24)}</span>
                  ) : null}
                  {required ? (
                    <span title={requiredReason(type)} className="ml-auto flex items-center text-gray-500">
                      <Lock aria-hidden className="size-3" />
                      <span className="sr-only">(required)</span>
                    </span>
                  ) : null}
                  {count > 0 ? (
                    <span className={`${required ? '' : 'ml-auto'} rounded-full bg-amber-100 px-1.5 text-xs text-amber-900`}>
                      {count}
                      <span className="sr-only"> {count === 1 ? 'problem' : 'problems'}</span>
                    </span>
                  ) : null}
                </button>
              </div>
            );
          }}
        />
      </section>
    </div>
  );
}
