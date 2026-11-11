// src/components/branches/review/reviewText.ts
//
// The words and small derivations of the review screen (docs/plans/2026-11-10-site-branches.md, section 3 "A
// reviewer", slice S5): how a value reads, what a conflict is about, the screen's totals, and the outline sheet of
// one pane. Pure, so the screen's tests and the browser proof share them.

import type { DocumentReview, ElementChangeKind, UnitReview } from '@/lib/siteMerge/elementChanges';
import type { BranchReviewJson, ShownConflictJson } from '@/lib/sites/branchClient';

/** A value as one line: text as it is, a value too long to send as its size, anything else as short JSON. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return 'nothing';
  if (typeof value === 'string') return value === '' ? 'empty' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && (value as { omitted?: unknown }).omitted === true) {
    if ((value as { hidden?: unknown }).hidden === true) return 'not shown';
    const characters = (value as { characters?: unknown }).characters;
    return typeof characters === 'number' ? `${characters.toLocaleString('en')} characters, too long to show here` : 'too long to show here';
  }
  const json = JSON.stringify(value);
  return json.length > 160 ? `${json.slice(0, 157)}...` : json;
}

const FIELD_NAMES: Record<string, string> = {
  'props.children': 'text',
  name: 'name',
  description: 'description',
  slug: 'address',
  metadata: 'page settings',
  apiKeyRef: 'analytics key',
  analyticsProjectId: 'analytics project',
  ingestionEndpoint: 'analytics endpoint',
  lumitraEnabled: 'Lumitra analytics',
};

/** A field's name for people: `props.style.color` reads "style: color". */
export function fieldText(field: string): string {
  if (FIELD_NAMES[field]) return FIELD_NAMES[field];
  if (field.startsWith('props.style.')) return `style: ${field.slice('props.style.'.length)}`;
  if (field.startsWith('props.')) return field.slice('props.'.length);
  return field;
}

/** What a conflict is about, in a few words. */
export function conflictText(conflict: ShownConflictJson, review: DocumentReview | undefined): string {
  const container = conflict.unit.container?.replace(/^(page|component):/, '');
  const where =
    conflict.unit.kind === 'site' ? 'Site' : conflict.unit.kind === 'settings' ? 'Site settings' : unitTitle(review, container ?? conflict.unit.id) ?? container ?? conflict.unit.id;
  const element = conflict.unit.kind === 'node' ? elementLabel(review, container, conflict.unit.id) : null;
  const what = conflict.kind === 'value' ? fieldText(conflict.path.join('.')) : CONFLICT_KIND_TEXT[conflict.kind] ?? conflict.kind;
  return [where, element, what].filter(Boolean).join(': ');
}

const CONFLICT_KIND_TEXT: Record<string, string> = {
  moved: 'moved on both sides',
  order: 'order changed on both sides',
  removed: 'removed on one side, changed on the other',
  'added-twice': 'added on both sides',
  cycle: 'moved into each other',
  slug: 'address taken on both sides',
};

function elementLabel(review: DocumentReview | undefined, container: string | undefined, id: string): string | null {
  const unit = review?.units.find((u) => u.id === container);
  return unit?.elements.find((e) => e.id === id)?.label ?? null;
}

function unitTitle(review: DocumentReview | undefined, id: string): string | undefined {
  return review?.units.find((u) => u.id === id)?.title;
}

/** The screen's totals, counted from the change list itself so one screen never shows two numbers. */
export function reviewTotals(review: DocumentReview): { pages: number; components: number; elements: number; settings: number } {
  return {
    pages: review.units.filter((u) => u.unit === 'page').length,
    components: review.units.filter((u) => u.unit === 'component').length,
    elements: review.units.reduce((n, u) => n + u.elements.length, 0),
    settings: review.site.length + review.settings.length + (review.pageOrder ? 1 : 0),
  };
}

export function totalsText(review: DocumentReview): string {
  const t = reviewTotals(review);
  const parts: string[] = [];
  if (t.pages) parts.push(`${t.pages} ${t.pages === 1 ? 'page' : 'pages'}`);
  if (t.components) parts.push(`${t.components} ${t.components === 1 ? 'component' : 'components'}`);
  if (t.elements) parts.push(`${t.elements} ${t.elements === 1 ? 'element' : 'elements'}`);
  if (t.settings) parts.push(`${t.settings} ${t.settings === 1 ? 'site setting' : 'site settings'}`);
  return parts.length ? `${parts.join(', ')} changed` : 'No changes yet';
}

export const KIND_TEXT: Record<ElementChangeKind, string> = { added: 'Added', removed: 'Removed', moved: 'Moved', changed: 'Changed' };
export const KIND_COLOR: Record<ElementChangeKind, string> = { added: '#16a34a', removed: '#dc2626', moved: '#2563eb', changed: '#d97706' };

/**
 * One pane's outline sheet: each listed element of the page drawn there outlined in the colour of its change, the
 * selected one thicker. Ids are escaped; an id the pane does not draw (main moved since the fork) matches nothing.
 */
export function outlineSheet(unit: UnitReview | undefined, side: 'main' | 'branch', selected: string | null, escape: (id: string) => string): string {
  if (!unit || unit.unit !== 'page') return '';
  const rules: string[] = [];
  for (const e of unit.elements) {
    const shown = side === 'branch' ? e.kind !== 'removed' : e.kind !== 'added';
    if (!shown) continue;
    const width = e.id === selected ? 4 : 2;
    rules.push(`[data-inner-component-id="${escape(e.id)}"]{outline:${width}px solid ${KIND_COLOR[e.kind]}!important;outline-offset:-${width}px!important}`);
  }
  return rules.join('\n');
}

/** An id safe inside a quoted attribute selector: `CSS.escape` where the browser has it, else the same rule for quotes and backslashes. */
export function escapeId(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(id);
  return id.replace(/["\\\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
}

/** Why the merge button is off, or null when it may be pressed. */
export function mergeBlocker(review: BranchReviewJson, canMerge: boolean | undefined): string | null {
  if (canMerge === false) return 'Only an admin of this workspace may merge.';
  if (review.conflicts.length > 0) return `${review.conflicts.length === 1 ? 'One question needs' : `${review.conflicts.length} questions need`} an answer first.`;
  if (review.problems.length > 0) return review.problems[0].message;
  if (review.review && totalsText(review.review) === 'No changes yet' && review.upToDate) return 'The branch changes nothing yet.';
  return null;
}
