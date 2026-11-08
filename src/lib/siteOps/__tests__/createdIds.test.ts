import { describe, expect, it } from 'vitest';
import { splitCreated } from '../createdIds';

describe('splitCreated', () => {
  it('tells the pages a batch created from the nodes by the createPage refs', () => {
    const ops = [
      { op: 'createPage', title: 'Pricing', ref: 'pricing' },
      { op: 'insertNodes', pageId: 'ref:pricing', parentId: 'root', nodes: [{ type: 'section', ref: 'hero' }] },
    ];
    expect(splitCreated(ops, { pricing: 'page-1', hero: 'node-1' })).toEqual({ nodeIds: ['node-1'], pageIds: ['page-1'] });
  });

  it('is empty for anything malformed', () => {
    expect(splitCreated(undefined, undefined)).toEqual({ nodeIds: [], pageIds: [] });
    expect(splitCreated([null, 3], [1, 2])).toEqual({ nodeIds: [], pageIds: [] });
    expect(splitCreated([], { a: 1, b: 'x' })).toEqual({ nodeIds: ['x'], pageIds: [] });
  });
});
