// Unit tests for the bindable-slot metadata and Phase 1 data-component
// placeholder entries on the component registry.
//
// Covers the spec checklist in
// `docs/specs/wave-1/data-bindings-component-registry-bindable-slots.md`:
//   - getBindableSlotsFor returns the declared slot map for known entries.
//   - Data-component entries (`collection`, `recordView`, `tableView`) are
//     registered with the right `dataComponentKind` and grouped under the
//     `'data'` category.
//   - The registry shape ACCEPTS `allowedModes: ['write']` declarations so
//     Phase 2 can add Form-field components without a breaking change.

import { describe, it, expect } from 'vitest';
import {
  COMPONENT_REGISTRY,
  getBindableSlotsFor,
  listComponentsByCategory,
  type ComponentRegistryEntry,
} from '@/lib/componentRegistry';
import type { BindableSlotMeta } from '@/lib/bindings/types';

describe('component registry bindable slots', () => {
  it('getBindableSlotsFor("text") returns the children slot in the expected shape', () => {
    expect(getBindableSlotsFor('text')).toEqual({
      children: { label: 'Text', allowedModes: ['read'], scopeHint: 'any' },
    });
  });

  it('getBindableSlotsFor("image") returns the src + alt slots', () => {
    expect(getBindableSlotsFor('image')).toEqual({
      src: { label: 'Image source', allowedModes: ['read'], scopeHint: 'any' },
      alt: { label: 'Alt text', allowedModes: ['read'], scopeHint: 'any' },
    });
  });

  it('getBindableSlotsFor("collection") exposes the source collection slot in read mode', () => {
    const slots = getBindableSlotsFor('collection');
    expect(slots.collection).toEqual({
      label: 'Source collection',
      allowedModes: ['read'],
      scopeHint: 'collection',
    });
  });

  it('getBindableSlotsFor returns an empty object for entries with no declared slots', () => {
    // Container is a Phase 1 layout primitive with no bindable slots yet.
    expect(getBindableSlotsFor('container')).toEqual({});
  });

  it('getBindableSlotsFor returns an empty object for unknown ids', () => {
    expect(getBindableSlotsFor('does-not-exist')).toEqual({});
  });

  it('registers the three Phase 1 data components with their dataComponentKind', () => {
    expect(COMPONENT_REGISTRY.collection?.dataComponentKind).toBe('collection');
    expect(COMPONENT_REGISTRY.recordView?.dataComponentKind).toBe('record-view');
    expect(COMPONENT_REGISTRY.tableView?.dataComponentKind).toBe('table-view');
  });

  it('listComponentsByCategory("data") returns exactly the three new entries', () => {
    const dataEntries = listComponentsByCategory('data');
    const ids = dataEntries.map((e) => e.id).sort();
    expect(ids).toEqual(['collection', 'recordView', 'tableView']);
    // Every data entry must declare its kind so the renderer can dispatch.
    for (const entry of dataEntries) {
      expect(entry.dataComponentKind).toBeDefined();
    }
  });

  it('data-component defaultProps carry a `data-component-kind` dispatch marker', () => {
    // The renderer reads this marker to pick the placeholder branch (see
    // createComponentElement). It also persists into the DOM so static-HTML
    // hydration in Wave 2 can locate these nodes without a registry lookup.
    expect(COMPONENT_REGISTRY.collection?.defaultProps['data-component-kind']).toBe(
      'collection',
    );
    expect(COMPONENT_REGISTRY.recordView?.defaultProps['data-component-kind']).toBe(
      'record-view',
    );
    expect(COMPONENT_REGISTRY.tableView?.defaultProps['data-component-kind']).toBe(
      'table-view',
    );
  });

  it('accepts a registry entry whose slot declares allowedModes: ["write"]', () => {
    // Compile-time assertion: a Phase 2-style write-mode declaration must be
    // structurally valid so the schema accepts future Form-field entries
    // without a registry-format breaking change. The runtime check below is
    // belt-and-braces: if the type compiles, this object is well-formed.
    const phase2Slot: BindableSlotMeta = {
      label: 'Email',
      allowedModes: ['write'],
      columnTypeFilter: ['text', 'email'],
    };
    const phase2Entry: ComponentRegistryEntry = {
      id: 'emailInput',
      label: 'Email input',
      category: 'data',
      icon: COMPONENT_REGISTRY.text.icon,
      iconClassName: 'bg-emerald-100 text-emerald-600',
      htmlType: 'input',
      defaultProps: {},
      defaultSize: { width: 240, height: 36 },
      bindableSlots: { value: phase2Slot },
    };

    expect(phase2Entry.bindableSlots?.value.allowedModes).toEqual(['write']);
    expect(phase2Entry.bindableSlots?.value.columnTypeFilter).toEqual(['text', 'email']);
  });
});
