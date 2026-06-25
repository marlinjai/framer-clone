'use client';

// src/components/cms/agent/ChangesCard.tsx
//
// The change summary card shown at the end of a completed assistant turn. One
// row per AgentChangeSummary (icon + entity + label) and an "Undo all" action
// that POSTs to /api/ai/cms-agent/undo with the runId. While undo is in flight
// the action shows a spinner; a partial undo (non-empty `warnings`) renders a
// warning row instead of silently dropping the failures.

import React from 'react';
import {
  Plus,
  Pencil,
  Archive,
  CircleCheck,
  Columns3,
  Tag,
  FileUp,
  Sparkles,
  Languages,
  Loader2,
  RotateCcw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { AgentChangeSummary, UndoResult } from '@/lib/ai/cmsAgentProtocol';

const ICONS: Record<string, LucideIcon> = {
  plus: Plus,
  pencil: Pencil,
  archive: Archive,
  'circle-check': CircleCheck,
  'columns-3': Columns3,
  tag: Tag,
  'file-up': FileUp,
  sparkles: Sparkles,
  languages: Languages,
};

export interface ChangesCardProps {
  runId: string;
  changes: AgentChangeSummary[];
  /** Called after a successful (or partial) undo so the grid can re-fetch. */
  onUndone?: (result: UndoResult) => void;
}

export default function ChangesCard({ runId, changes, onUndone }: ChangesCardProps) {
  const [undoing, setUndoing] = React.useState(false);
  const [undone, setUndone] = React.useState(false);
  const [warnings, setWarnings] = React.useState<string[]>([]);

  const runUndo = async (): Promise<void> => {
    setUndoing(true);
    setWarnings([]);
    try {
      const res = await fetch('/api/ai/cms-agent/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      });
      const result = (await res.json()) as UndoResult;
      setWarnings(result.warnings ?? []);
      setUndone((result.warnings ?? []).length === 0);
      onUndone?.(result);
    } catch (err) {
      setWarnings([err instanceof Error ? err.message : 'Undo failed']);
    } finally {
      setUndoing(false);
    }
  };

  if (changes.length === 0) return null;

  return (
    <div
      className="mt-2 rounded-lg border border-border bg-background p-2.5"
      data-testid="agent-changes-card"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-foreground">Changes</span>
        {undone ? (
          <span className="text-[12px] font-medium text-muted-foreground" data-testid="agent-undone">
            Undone
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void runUndo()}
            disabled={undoing}
            data-testid="agent-undo-all"
            className="inline-flex items-center gap-1 text-[12px] font-medium text-brand transition-colors hover:text-brand/80 disabled:opacity-60"
          >
            {undoing ? (
              <>
                <Loader2 className="size-[12px] animate-spin" data-testid="agent-undo-spinner" />
                Undoing
              </>
            ) : (
              <>
                <RotateCcw className="size-[12px]" />
                Undo all
              </>
            )}
          </button>
        )}
      </div>

      <ul className="flex flex-col gap-1">
        {changes.map((change, index) => {
          const Icon = ICONS[change.icon] ?? Plus;
          return (
            <li
              key={`${change.tool}-${index}`}
              className="flex items-center gap-2 text-[12.5px] text-foreground"
              data-testid="agent-change-row"
            >
              <span className="flex size-[18px] items-center justify-center rounded-[5px] bg-brand/12 text-brand">
                <Icon className="size-[11px]" />
              </span>
              <span className="text-muted-foreground">{change.entityType}</span>
              <span className="flex-1" />
              <span className="font-medium">{change.label}</span>
            </li>
          );
        })}
      </ul>

      {warnings.length > 0 && (
        <div
          className="mt-2 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive"
          data-testid="agent-undo-warning"
        >
          <TriangleAlert className="mt-0.5 size-[13px] shrink-0" />
          <span>{warnings.join(' ')}</span>
        </div>
      )}
    </div>
  );
}
