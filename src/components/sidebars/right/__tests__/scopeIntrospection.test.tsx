// Ancestry-walk coverage for getAvailableScopeFrames: a deeply-nested node
// must resolve the Collection ancestor's source collectionId.
import { describe, it, expect } from 'vitest';
import ComponentModel from '@/models/ComponentModel';
import { getAvailableScopeFrames } from '@/lib/bindings/scopeIntrospection';

function deepCollectionTree() {
  return ComponentModel.create({
    id: 'collection-root',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'collection' },
    bindings: { collection: { mode: 'read', expression: 'col_events' } },
    children: [
      {
        id: 'stack-1',
        type: 'div',
        componentType: 'host',
        props: {},
        children: [
          {
            id: 'card-1',
            type: 'div',
            componentType: 'host',
            props: {},
            children: [
              {
                id: 'text-1',
                type: 'p',
                componentType: 'host',
                props: { children: 'x' },
              },
            ],
          },
        ],
      },
    ],
  });
}

describe('getAvailableScopeFrames', () => {
  it('always returns a page frame', () => {
    const node = ComponentModel.create({
      id: 'text-orphan',
      type: 'p',
      componentType: 'host',
      props: { children: 'hi' },
    });
    const frames = getAvailableScopeFrames(node);
    expect(frames.some((f) => f.kind === 'page')).toBe(true);
    expect(frames.some((f) => f.kind === 'row')).toBe(false);
  });

  it("returns the Collection ancestor's collectionId for a deeply-nested node", () => {
    const tree = deepCollectionTree();
    const text = tree.children[0].children[0].children[0];
    const frames = getAvailableScopeFrames(text);
    const rowFrame = frames.find((f) => f.kind === 'row');
    expect(rowFrame).toBeDefined();
    expect(rowFrame?.collectionId).toBe('col_events');
    expect(rowFrame?.source).toBe('collection');
  });

  it('resolves a RecordView ancestor row frame from its record binding', () => {
    const tree = ComponentModel.create({
      id: 'recordView-root',
      type: 'div',
      componentType: 'host',
      props: { 'data-component-kind': 'record-view' },
      bindings: { record: { mode: 'read', expression: 'col_team' } },
      children: [
        {
          id: 'text-2',
          type: 'p',
          componentType: 'host',
          props: { children: 'y' },
        },
      ],
    });
    const text = tree.children[0];
    const frames = getAvailableScopeFrames(text);
    const rowFrame = frames.find((f) => f.kind === 'row');
    expect(rowFrame?.collectionId).toBe('col_team');
    expect(rowFrame?.source).toBe('record-view');
  });

  it('returns a row frame with null collectionId when the ancestor is unbound', () => {
    const tree = ComponentModel.create({
      id: 'collection-unbound',
      type: 'div',
      componentType: 'host',
      props: { 'data-component-kind': 'collection' },
      bindings: {},
      children: [
        { id: 'text-3', type: 'p', componentType: 'host', props: { children: 'z' } },
      ],
    });
    const frames = getAvailableScopeFrames(tree.children[0]);
    const rowFrame = frames.find((f) => f.kind === 'row');
    expect(rowFrame).toBeDefined();
    expect(rowFrame?.collectionId ?? null).toBeNull();
  });
});
