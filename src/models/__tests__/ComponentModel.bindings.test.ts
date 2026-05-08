// Unit tests for the data-binding shape on ComponentModel.
//
// Covers the spec checklist in
// `docs/specs/wave-1/data-bindings-binding-shape-on-component-model.md`:
//   - setBinding / getBinding round-trip
//   - clearBinding / clearAllBindings
//   - hasBindings toggling across set + clear cycles
//   - readBindings filters to mode === 'read'
//   - snapshot round-trip preserves bindings exactly
//   - existing snapshots without a `bindings` field load with `bindings: {}`
//   - a Phase 2 snapshot with `mode: 'write'` loads in a Phase 1 client
//     without throwing (forward-compat for the persisted store)

import { describe, it, expect } from 'vitest';
import { applySnapshot, getSnapshot } from 'mobx-state-tree';
import ComponentModel, {
  ComponentTypeEnum,
  type ComponentInstance,
} from '../ComponentModel';
import type {
  BindingEntry,
  ReadBinding,
  WriteBinding,
} from '@/lib/bindings/types';

function makeNode(
  overrides: Partial<{
    id: string;
    type: string;
    props: Record<string, unknown>;
  }> = {},
): ComponentInstance {
  return ComponentModel.create({
    id: overrides.id ?? 'cmp_test',
    type: overrides.type ?? 'p',
    componentType: ComponentTypeEnum.HOST,
    props: overrides.props ?? {},
  });
}

const readBinding: ReadBinding = {
  mode: 'read',
  expression: '{{row.title}}',
  scope: 'parent',
};

describe('ComponentModel bindings', () => {
  it('defaults bindings to an empty object when omitted from the snapshot', () => {
    const node = makeNode();
    expect(node.bindings).toEqual({});
    expect(node.hasBindings).toBe(false);
  });

  it('setBinding stores the entry and getBinding returns it', () => {
    const node = makeNode();
    node.setBinding('children', readBinding);

    expect(node.getBinding('children')).toEqual(readBinding);
    expect(node.hasBindings).toBe(true);
  });

  it('setBinding overwrites an existing slot without disturbing others', () => {
    const node = makeNode();
    node.setBinding('children', readBinding);
    node.setBinding('href', { mode: 'read', expression: '{{row.url}}' });

    const replacement: ReadBinding = {
      mode: 'read',
      expression: '{{row.headline}}',
    };
    node.setBinding('children', replacement);

    expect(node.getBinding('children')).toEqual(replacement);
    expect(node.getBinding('href')).toEqual({
      mode: 'read',
      expression: '{{row.url}}',
    });
  });

  it('clearBinding removes the slot and leaves the rest intact', () => {
    const node = makeNode();
    node.setBinding('children', readBinding);
    node.setBinding('href', { mode: 'read', expression: '{{row.url}}' });

    node.clearBinding('children');

    expect(node.getBinding('children')).toBeUndefined();
    expect(node.getBinding('href')).toEqual({
      mode: 'read',
      expression: '{{row.url}}',
    });
    expect(node.hasBindings).toBe(true);
  });

  it('clearBinding on a missing slot is a no-op', () => {
    const node = makeNode();
    node.setBinding('children', readBinding);

    node.clearBinding('does-not-exist');

    expect(node.getBinding('children')).toEqual(readBinding);
    expect(node.hasBindings).toBe(true);
  });

  it('clearAllBindings empties the record', () => {
    const node = makeNode();
    node.setBinding('children', readBinding);
    node.setBinding('href', { mode: 'read', expression: '{{row.url}}' });

    node.clearAllBindings();

    expect(node.bindings).toEqual({});
    expect(node.hasBindings).toBe(false);
  });

  it('hasBindings toggles correctly across set + clear cycles', () => {
    const node = makeNode();
    expect(node.hasBindings).toBe(false);

    node.setBinding('children', readBinding);
    expect(node.hasBindings).toBe(true);

    node.clearBinding('children');
    expect(node.hasBindings).toBe(false);

    node.setBinding('children', readBinding);
    node.setBinding('href', { mode: 'read', expression: '{{row.url}}' });
    expect(node.hasBindings).toBe(true);

    node.clearAllBindings();
    expect(node.hasBindings).toBe(false);
  });

  it('readBindings filters out non-read entries', () => {
    const node = makeNode();
    const writeBinding: WriteBinding = {
      mode: 'write',
      collectionId: 'app_users',
      field: 'email',
    };
    const twoWay: BindingEntry = {
      mode: 'two-way',
      collectionId: 'app_users',
      field: 'name',
    };

    node.setBinding('children', readBinding);
    node.setBinding('value', writeBinding);
    node.setBinding('checked', twoWay);

    expect(node.readBindings).toEqual({ children: readBinding });
  });

  it('preserves bindings through a getSnapshot / applySnapshot round-trip', () => {
    const original = makeNode({ id: 'cmp_round_trip' });
    original.setBinding('children', readBinding);
    original.setBinding('href', {
      mode: 'read',
      expression: '{{page.params.slug}}',
      scope: 'page',
    });

    const snapshot = getSnapshot(original);

    const rebuilt = ComponentModel.create({
      id: 'cmp_round_trip',
      type: 'p',
      componentType: ComponentTypeEnum.HOST,
    });
    applySnapshot(rebuilt, snapshot);

    expect(getSnapshot(rebuilt)).toEqual(snapshot);
    expect(rebuilt.getBinding('children')).toEqual(readBinding);
    expect(rebuilt.getBinding('href')).toEqual({
      mode: 'read',
      expression: '{{page.params.slug}}',
      scope: 'page',
    });
  });

  it('loads a legacy snapshot without a bindings field as bindings: {}', () => {
    // A pre-bindings persisted node — note the absence of a `bindings` key.
    const legacySnapshot = {
      id: 'cmp_legacy',
      type: 'p',
      componentType: ComponentTypeEnum.HOST,
      props: { style: { fontSize: '16px' } },
    };

    const node = ComponentModel.create(legacySnapshot);

    expect(node.bindings).toEqual({});
    expect(node.hasBindings).toBe(false);
  });

  it('loads a Phase 2 snapshot with mode: "write" without throwing', () => {
    // Phase 1 readers do not act on write/two-way bindings, but the schema
    // must accept them so a Phase 2 snapshot survives a round-trip through
    // a Phase 1 client.
    const phase2Snapshot = {
      id: 'cmp_phase2',
      type: 'input',
      componentType: ComponentTypeEnum.HOST,
      props: {},
      bindings: {
        value: {
          mode: 'write' as const,
          collectionId: 'app_users',
          field: 'email',
        },
        checked: {
          mode: 'two-way' as const,
          collectionId: 'app_users',
          field: 'subscribed',
        },
      },
    };

    const node = ComponentModel.create(phase2Snapshot);

    expect(node.getBinding('value')).toEqual({
      mode: 'write',
      collectionId: 'app_users',
      field: 'email',
    });
    expect(node.getBinding('checked')).toEqual({
      mode: 'two-way',
      collectionId: 'app_users',
      field: 'subscribed',
    });
    // Phase 1 render path uses readBindings; both entries must be filtered.
    expect(node.readBindings).toEqual({});
  });
});
