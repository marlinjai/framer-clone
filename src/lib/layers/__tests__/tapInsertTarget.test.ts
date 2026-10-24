import { describe, expect, it } from 'vitest';
import { canHoldChildren, tapInsertTarget } from '../tapInsertTarget';

describe('tapInsertTarget', () => {
  it('nothing selected, or a breakpoint frame: end of the page', () => {
    expect(tapInsertTarget(undefined)).toEqual({ kind: 'appTree' });
    expect(tapInsertTarget({ id: 'v', type: 'div', isViewportNode: true, hasParent: false })).toEqual({ kind: 'appTree' });
  });

  it('a container: inside it', () => {
    expect(tapInsertTarget({ id: 'c', type: 'section', hasParent: true, props: {} })).toEqual({ kind: 'parent', parentId: 'c' });
    // Any element that already holds elements counts as a container.
    expect(tapInsertTarget({ id: 'l', type: 'li', hasParent: true, props: {}, children: [{}] })).toEqual({ kind: 'parent', parentId: 'l' });
  });

  it('a text holder, a void tag or a self-rendering component: right after it', () => {
    expect(tapInsertTarget({ id: 'h', type: 'h1', hasParent: true, props: { children: 'Hi' } })).toEqual({ kind: 'sibling', siblingId: 'h', position: 'after' });
    expect(tapInsertTarget({ id: 'd', type: 'div', hasParent: true, props: { children: 'text' } })).toEqual({ kind: 'sibling', siblingId: 'd', position: 'after' });
    expect(tapInsertTarget({ id: 'i', type: 'img', hasParent: true })).toEqual({ kind: 'sibling', siblingId: 'i', position: 'after' });
    expect(tapInsertTarget({ id: 'k', type: 'div', hasParent: true, props: { 'data-component-kind': 'product-grid' } })).toEqual({
      kind: 'sibling',
      siblingId: 'k',
      position: 'after',
    });
  });

  it('a non-container without a parent (a floating element): end of the page', () => {
    expect(tapInsertTarget({ id: 'f', type: 'img', hasParent: false })).toEqual({ kind: 'appTree' });
  });

  it('canHoldChildren follows the drop rules', () => {
    expect(canHoldChildren({ id: 'a', type: 'DIV' })).toBe(true);
    expect(canHoldChildren({ id: 'b', type: 'p' })).toBe(false);
    expect(canHoldChildren({ id: 'c', type: 'input' })).toBe(false);
  });
});
