// src/lib/behaviour/presetItems.ts
//
// The panel's item controls for a preset: a tab added or taken out, a slide added. The
// preset's own functions (addTab, removeTab, addSlide, slice B6) do the work and derive
// every generated entry again; this reads what a stored preset holds and hands back the
// whole subtree to write in one step. See "Decided in slice B11" in
// docs/plans/2026-11-02-behaviour-model.md.
//
// Works on a stored subtree as a snapshot, keeping every field it does not change (a
// layer's name, its lock), and setting each node's parent to the node it now sits in,
// since a copied item still names the parent of the item it was copied from.
//
// PURE and client-safe: no React, no MST.

import { addSlide } from './presets/carousel';
import { addTab, removeTab } from './presets/tabs';
import type { PresetNode } from './presets/nodes';
import { isRecord } from './authoring';

export type PresetEdit = { kind: 'addTab' } | { kind: 'removeTab'; index: number } | { kind: 'addSlide' };

/** What the panel can do to the items of a stored preset root. */
export interface PresetItems {
  kind: 'tabs' | 'carousel';
  /** The items as a person reads them: each tab's title, each slide's text. */
  items: string[];
  /** Taking one out is offered: tabs only, and never the last one. */
  canRemove: boolean;
}

const propsOf = (node: unknown): Record<string, unknown> => (isRecord(node) && isRecord(node.props) ? node.props : {});
const childrenOf = (node: unknown): Record<string, unknown>[] =>
  isRecord(node) && Array.isArray(node.children) ? node.children.filter(isRecord) : [];

/** The text a node shows: its own string, or its text nodes'. */
function textOf(node: unknown): string {
  const own = propsOf(node).children;
  if (typeof own === 'string' || typeof own === 'number') return String(own);
  return childrenOf(node).map(textOf).join('').trim();
}

const presetKindOf = (node: unknown): string | null => {
  const behaviour = propsOf(node).behaviour;
  const preset = isRecord(behaviour) ? behaviour.preset : undefined;
  return isRecord(preset) && typeof preset.kind === 'string' ? preset.kind : null;
};

/**
 * The items of a preset whose items the panel can add to, or null. Tabs from a Collection
 * have their tabs from the rows, so adding one there is adding a row, not a tab.
 */
export function presetItemsOf(root: unknown): PresetItems | null {
  const kind = presetKindOf(root);
  if (kind === 'tabs') {
    const list = childrenOf(root).find((child) => propsOf(child).role === 'tablist');
    if (!list || propsOf(list)['data-component-kind'] === 'collection') return null;
    const tabs = childrenOf(list).filter((child) => propsOf(child).role === 'tab');
    if (tabs.length === 0) return null;
    return { kind, items: tabs.map((tab, index) => textOf(tab) || `Tab ${index + 1}`), canRemove: tabs.length > 1 };
  }
  if (kind === 'carousel') {
    const holder = childrenOf(root).find((child) => childrenOf(child).some((slide) => propsOf(slide)['aria-roledescription'] === 'slide'));
    const slides = holder ? childrenOf(holder).filter((slide) => propsOf(slide)['aria-roledescription'] === 'slide') : [];
    if (slides.length === 0) return null;
    return { kind, items: slides.map((slide, index) => textOf(slide) || `Slide ${index + 1}`), canRemove: false };
  }
  return null;
}

/** Each node's parent set to the node holding it now. */
function withParents(node: Record<string, unknown>, parentId: string | undefined): Record<string, unknown> {
  const next: Record<string, unknown> = { ...node };
  if (parentId !== undefined) next.parentId = parentId;
  if (Array.isArray(node.children)) next.children = childrenOf(node).map((child) => withParents(child, node.id as string));
  return next;
}

/**
 * The stored subtree after one edit, or null when the edit changes nothing (the last tab,
 * an index that is not there, a preset of another kind).
 */
export function editPresetItems(snapshot: Record<string, unknown>, edit: PresetEdit): Record<string, unknown> | null {
  const items = presetItemsOf(snapshot);
  if (!items) return null;
  const root = snapshot as unknown as PresetNode;
  const n = items.items.length + 1;
  let next: PresetNode;
  if (edit.kind === 'addTab' && items.kind === 'tabs') next = addTab(root, { title: `Tab ${n}`, body: `What tab ${n} says.` });
  else if (edit.kind === 'removeTab' && items.kind === 'tabs' && items.canRemove) next = removeTab(root, edit.index);
  else if (edit.kind === 'addSlide' && items.kind === 'carousel') next = addSlide(root, `Slide ${n}`);
  else return null;
  if (next === root) return null;
  return withParents(next as unknown as Record<string, unknown>, snapshot.parentId as string | undefined);
}
