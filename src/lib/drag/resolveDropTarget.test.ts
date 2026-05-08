// Unit tests for resolveDropTarget.
//
// The resolver is a pure function over (pointer, transform, source, sourceNode,
// DOM state). jsdom doesn't implement real layout, so each test wires up a
// small DOM fixture, stubs `document.elementsFromPoint` to return a
// deterministic hit stack, and stubs `getBoundingClientRect` on the target
// elements. Every scenario in plan section 6.1 is covered, plus the
// live-mode-source-over-viewport regression that the elementsFromPoint +
// source-skip fix unblocked.

import { describe, it, expect, beforeEach } from 'vitest';
import { resolveDropTarget } from './resolveDropTarget';
import type { DragSource } from './types';
import type { ComponentInstance } from '@/models/ComponentModel';

// Helpers -------------------------------------------------------------------

interface RectPartial {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

function stubRect(el: Element, rect: RectPartial) {
  const { left = 0, top = 0, width = 100, height = 100 } = rect;
  const full = {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (el as any).getBoundingClientRect = () => full;
}

function stubHitStack(stack: Element[]) {
  // elementsFromPoint in jsdom returns [] by default; override per test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (document as any).elementsFromPoint = () => stack;
}

function el(tag: string, attrs: Record<string, string> = {}, parent?: Element): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

// Minimal ComponentInstance shape for the resolver's isDescendant check.
// Only `.id` and `.children[]` are accessed. Cast avoids pulling the real MST
// model into the test.
function fakeNode(id: string, children: Array<{ id: string; children: [] }> = []): ComponentInstance {
  return { id, children } as unknown as ComponentInstance;
}

const NO_TRANSFORM = { panX: 0, panY: 0, zoom: 1 };

beforeEach(() => {
  document.body.innerHTML = '';
});

// Scenarios -----------------------------------------------------------------

describe('resolveDropTarget', () => {
  describe('empty canvas (ground)', () => {
    it('returns floating target at zoom 1.0 with no pan', () => {
      const ground = el('div', { 'data-ground': 'true' });
      document.body.appendChild(ground);
      stubRect(ground, { left: 0, top: 0, width: 1000, height: 1000 });
      stubHitStack([ground]);

      const out = resolveDropTarget({
        pointer: { clientX: 250, clientY: 300 },
        transform: NO_TRANSFORM,
        source: { kind: 'create', registryId: 'Button' } as DragSource,
      });

      expect(out.target).toEqual({ kind: 'floating', x: 250, y: 300 });
      expect(out.indicator).toBeNull();
    });

    it('inverts transform for floating coords at zoom 0.3 with pan (100, 50)', () => {
      const ground = el('div', { 'data-ground': 'true' });
      document.body.appendChild(ground);
      stubRect(ground, { left: 0, top: 0, width: 1000, height: 1000 });
      stubHitStack([ground]);

      const out = resolveDropTarget({
        pointer: { clientX: 250, clientY: 300 },
        transform: { panX: 100, panY: 50, zoom: 0.3 },
        source: { kind: 'create', registryId: 'Button' } as DragSource,
      });

      // (250 - 0 - 100) / 0.3 = 500
      // (300 - 0 - 50) / 0.3 = 833.333...
      expect(out.target).toEqual({ kind: 'floating', x: 500, y: (300 - 50) / 0.3 });
      expect(out.indicator).toBeNull();
    });
  });

  describe('viewport (no inner hit)', () => {
    it('appends to appTree', () => {
      const ground = el('div', { 'data-ground': 'true' });
      const viewport = el('div', { 'data-viewport-id': 'vp1' }, ground);
      document.body.appendChild(ground);
      stubRect(viewport, { left: 10, top: 20, width: 400, height: 300 });
      stubHitStack([viewport, ground]);

      const out = resolveDropTarget({
        pointer: { clientX: 100, clientY: 100 },
        transform: NO_TRANSFORM,
        source: { kind: 'create', registryId: 'Text' } as DragSource,
      });

      expect(out.target).toEqual({ kind: 'appTree' });
      expect(out.indicator).toEqual({
        kind: 'inside',
        rect: expect.objectContaining({ left: 10, top: 20, width: 400, height: 300 }),
        targetId: 'vp1',
      });
    });
  });

  describe('tree component zones', () => {
    function setupTreeFixture() {
      const root = el('div', { 'data-inner-component-id': 'root' });
      const target = el('div', { 'data-inner-component-id': 'target' }, root);
      // child so childElementCount > 0 → canAcceptInside = true
      el('span', { 'data-inner-component-id': 'child' }, target);
      document.body.appendChild(root);
      stubRect(target, { left: 0, top: 100, width: 200, height: 100 });
      return { root, target };
    }

    it('top sliver → before', () => {
      const { target } = setupTreeFixture();
      stubHitStack([target]);

      const out = resolveDropTarget({
        pointer: { clientX: 50, clientY: 102 }, // 2px from top
        transform: NO_TRANSFORM,
        source: { kind: 'create', registryId: 'Text' } as DragSource,
      });

      expect(out.target).toEqual({ kind: 'sibling', siblingId: 'target', position: 'before' });
      expect(out.indicator?.kind).toBe('before');
    });

    it('bottom sliver → after', () => {
      const { target } = setupTreeFixture();
      stubHitStack([target]);

      const out = resolveDropTarget({
        pointer: { clientX: 50, clientY: 198 }, // 2px from bottom
        transform: NO_TRANSFORM,
        source: { kind: 'create', registryId: 'Text' } as DragSource,
      });

      expect(out.target).toEqual({ kind: 'sibling', siblingId: 'target', position: 'after' });
      expect(out.indicator?.kind).toBe('after');
    });

    it('middle with child elements → inside (parent)', () => {
      const { target } = setupTreeFixture();
      stubHitStack([target]);

      const out = resolveDropTarget({
        pointer: { clientX: 50, clientY: 150 }, // middle
        transform: NO_TRANSFORM,
        source: { kind: 'create', registryId: 'Text' } as DragSource,
      });

      expect(out.target).toEqual({ kind: 'parent', parentId: 'target' });
      expect(out.indicator?.kind).toBe('inside');
    });

    it('middle of void tag (img) → collapses to nearest edge', () => {
      const img = el('img', { 'data-inner-component-id': 'img1' });
      document.body.appendChild(img);
      stubRect(img, { left: 0, top: 0, width: 100, height: 100 });
      stubHitStack([img]);

      // Upper half of the middle zone → before.
      const upper = resolveDropTarget({
        pointer: { clientX: 50, clientY: 40 },
        transform: NO_TRANSFORM,
        source: { kind: 'create', registryId: 'Text' } as DragSource,
      });
      expect(upper.target).toEqual({ kind: 'sibling', siblingId: 'img1', position: 'before' });

      // Lower half → after.
      const lower = resolveDropTarget({
        pointer: { clientX: 50, clientY: 60 },
        transform: NO_TRANSFORM,
        source: { kind: 'create', registryId: 'Text' } as DragSource,
      });
      expect(lower.target).toEqual({ kind: 'sibling', siblingId: 'img1', position: 'after' });
    });

    it('middle of text-leaf (p with string children, no element children) → collapses to edge', () => {
      const p = el('p', { 'data-inner-component-id': 'p1' });
      p.textContent = 'hello world';
      document.body.appendChild(p);
      stubRect(p, { left: 0, top: 0, width: 200, height: 50 });
      stubHitStack([p]);

      const out = resolveDropTarget({
        pointer: { clientX: 100, clientY: 25 }, // dead center
        transform: NO_TRANSFORM,
        source: { kind: 'create', registryId: 'Text' } as DragSource,
      });

      // childElementCount === 0 (text node doesn't count) → canAcceptInside
      // false → collapse. Exactly on midline: upper half boundary → before.
      expect(out.target?.kind).toBe('sibling');
    });

    it('middle of empty container div → inside (parent)', () => {
      // Regression: freshly-created Containers have childElementCount === 0
      // but should still accept 'inside' drops. The resolver's container-tag
      // allowlist kicks in for div / section / etc.
      const container = el('div', { 'data-inner-component-id': 'c1' });
      document.body.appendChild(container);
      stubRect(container, { left: 0, top: 0, width: 200, height: 100 });
      stubHitStack([container]);

      const out = resolveDropTarget({
        pointer: { clientX: 100, clientY: 50 }, // dead center
        transform: NO_TRANSFORM,
        source: { kind: 'create', registryId: 'Text' } as DragSource,
      });

      expect(out.target).toEqual({ kind: 'parent', parentId: 'c1' });
      expect(out.indicator?.kind).toBe('inside');
    });
  });

  describe('self and cycle guards', () => {
    it('pointer over source node itself → null', () => {
      const src = el('div', { 'data-inner-component-id': 'A' });
      document.body.appendChild(src);
      stubRect(src, { left: 0, top: 0, width: 100, height: 100 });
      stubHitStack([src]);

      const out = resolveDropTarget({
        pointer: { clientX: 50, clientY: 50 },
        transform: NO_TRANSFORM,
        source: { kind: 'moveNode', nodeId: 'A' } as DragSource,
        sourceNode: fakeNode('A'),
      });

      // Because source roots skip past A, the hit stack is empty after filter.
      expect(out.target).toBeNull();
      expect(out.indicator).toBeNull();
    });

    it('pointer over descendant of source → null (cycle)', () => {
      // A contains B in the MST. B is a separate DOM element (not a descendant
      // of A's rendered element in this fixture) so the source-skip filter
      // doesn't remove it, but the isDescendant check does.
      const src = el('div', { 'data-inner-component-id': 'A' });
      document.body.appendChild(src);
      stubRect(src, { left: 0, top: 0, width: 100, height: 100 });

      const candidate = el('div', { 'data-inner-component-id': 'B' });
      document.body.appendChild(candidate);
      stubRect(candidate, { left: 200, top: 0, width: 100, height: 100 });
      stubHitStack([candidate]);

      const sourceNode = fakeNode('A', [{ id: 'B', children: [] }]);

      const out = resolveDropTarget({
        pointer: { clientX: 250, clientY: 50 },
        transform: NO_TRANSFORM,
        source: { kind: 'moveNode', nodeId: 'A' } as DragSource,
        sourceNode,
      });

      expect(out.target).toBeNull();
      expect(out.indicator).toBeNull();
    });
  });

  describe('UI chrome', () => {
    it('pointer over editor chrome → null (cancel silently)', () => {
      const chrome = el('div', { 'data-editor-ui': 'true' });
      document.body.appendChild(chrome);
      stubRect(chrome, { left: 0, top: 0, width: 300, height: 50 });
      stubHitStack([chrome]);

      const out = resolveDropTarget({
        pointer: { clientX: 100, clientY: 20 },
        transform: NO_TRANSFORM,
        source: { kind: 'create', registryId: 'Text' } as DragSource,
      });

      expect(out.target).toBeNull();
      expect(out.indicator).toBeNull();
    });
  });

  describe('floating root', () => {
    it('over floating root wrapper (no nested inner) → parent (floating root)', () => {
      const wrapper = el('div', { 'data-floating-root-id': 'fl1' });
      document.body.appendChild(wrapper);
      stubRect(wrapper, { left: 0, top: 0, width: 200, height: 200 });
      stubHitStack([wrapper]);

      const out = resolveDropTarget({
        pointer: { clientX: 100, clientY: 100 },
        transform: NO_TRANSFORM,
        source: { kind: 'create', registryId: 'Text' } as DragSource,
      });

      expect(out.target).toEqual({ kind: 'parent', parentId: 'fl1' });
      expect(out.indicator?.kind).toBe('inside');
    });

    it('over nested component inside floating root → resolves to inner', () => {
      const wrapper = el('div', { 'data-floating-root-id': 'fl1' });
      const inner = el('div', { 'data-inner-component-id': 'c1' }, wrapper);
      el('span', { 'data-inner-component-id': 'c1c' }, inner);
      document.body.appendChild(wrapper);
      stubRect(inner, { left: 0, top: 100, width: 200, height: 100 });
      // Walk-up: inner hits data-inner-component-id first, so floating root
      // isn't reached.
      stubHitStack([inner, wrapper]);

      const out = resolveDropTarget({
        pointer: { clientX: 50, clientY: 150 }, // middle of inner
        transform: NO_TRANSFORM,
        source: { kind: 'create', registryId: 'Text' } as DragSource,
      });

      expect(out.target).toEqual({ kind: 'parent', parentId: 'c1' });
    });
  });

  describe('live-mode source over viewport (regression)', () => {
    it('skips past the live-moving source and resolves to viewport behind', () => {
      // Mimic the real DOM: a floating element's GroundWrapper (position: fixed
      // + transform) wraps the floating-root div, which wraps the
      // inner-component div. During a live drag the wrapper tracks the cursor,
      // so all three show up at the top of the hit stack. The filter must
      // strip the full GroundWrapper subtree (via data-ground-wrapper-id)
      // AND the inner markers so the walk-up finds the viewport behind.
      const ground = el('div', { 'data-ground': 'true' });
      const viewport = el('div', { 'data-viewport-id': 'vp1' });
      const viewportOuter = el('div', {}, ground);
      viewportOuter.appendChild(viewport);

      const groundWrapper = el('div', { 'data-ground-wrapper-id': 'A' });
      const floatingRoot = el('div', { 'data-floating-root-id': 'A' }, groundWrapper);
      const floatingInner = el('div', { 'data-inner-component-id': 'A' }, floatingRoot);
      document.body.appendChild(ground);
      document.body.appendChild(groundWrapper);

      stubRect(viewport, { left: 100, top: 100, width: 400, height: 300 });
      // Source is the topmost in the stack (tracks cursor): the whole
      // GroundWrapper subtree comes first, then the viewport, then the
      // ground. Without the data-ground-wrapper-id skip, 'first non-source'
      // was the GroundWrapper outer and walk-up never reached the viewport.
      stubHitStack([floatingInner, floatingRoot, groundWrapper, viewport, viewportOuter, ground]);

      const out = resolveDropTarget({
        pointer: { clientX: 300, clientY: 250 },
        transform: NO_TRANSFORM,
        source: { kind: 'moveNode', nodeId: 'A' } as DragSource,
        sourceNode: fakeNode('A'),
      });

      expect(out.target).toEqual({ kind: 'appTree' });
      expect(out.indicator?.kind).toBe('inside');
      expect(out.indicator?.targetId).toBe('vp1');
    });

    it('live-mode floating drag over a specific tree child resolves to that child', () => {
      // Same DOM shape as above, but the viewport contains a tree child that
      // is OVER where the cursor lands. Filter must not eat siblings; the
      // resolver should land on the tree child, not the viewport frame.
      const ground = el('div', { 'data-ground': 'true' });
      const viewport = el('div', { 'data-viewport-id': 'vp1' });
      viewport.appendChild(el('div', { 'data-inner-component-id': 'treekid' }));
      ground.appendChild(viewport);

      const groundWrapper = el('div', { 'data-ground-wrapper-id': 'A' });
      const floatingRoot = el('div', { 'data-floating-root-id': 'A' }, groundWrapper);
      const floatingInner = el('div', { 'data-inner-component-id': 'A' }, floatingRoot);
      document.body.appendChild(ground);
      document.body.appendChild(groundWrapper);

      const treeKid = viewport.querySelector('[data-inner-component-id="treekid"]')!;
      stubRect(treeKid, { left: 100, top: 200, width: 300, height: 200 });
      stubHitStack([floatingInner, floatingRoot, groundWrapper, treeKid, viewport, ground]);

      const out = resolveDropTarget({
        pointer: { clientX: 250, clientY: 300 }, // middle of treekid
        transform: NO_TRANSFORM,
        source: { kind: 'moveNode', nodeId: 'A' } as DragSource,
        sourceNode: fakeNode('A'),
      });

      // treekid is a <div>: a recognised container tag, so the middle zone
      // resolves to 'inside' (parent target) even though it has no element
      // children yet. The critical assertion is that the resolver landed on
      // the tree child and not on the viewport frame behind it.
      expect(out.target).toEqual({ kind: 'parent', parentId: 'treekid' });
      expect(out.indicator?.kind).toBe('inside');
    });

    it('pointer over empty chrome area → null', () => {
      const chrome = el('div', { 'data-editor-ui': 'true' });
      document.body.appendChild(chrome);
      stubHitStack([chrome]);

      const out = resolveDropTarget({
        pointer: { clientX: 10, clientY: 10 },
        transform: NO_TRANSFORM,
        source: { kind: 'moveNode', nodeId: 'A' } as DragSource,
        sourceNode: fakeNode('A'),
      });

      expect(out.target).toBeNull();
    });
  });

  describe('nothing under pointer', () => {
    it('empty hit stack → null', () => {
      stubHitStack([]);

      const out = resolveDropTarget({
        pointer: { clientX: 0, clientY: 0 },
        transform: NO_TRANSFORM,
        source: { kind: 'create', registryId: 'Text' } as DragSource,
      });

      expect(out.target).toBeNull();
      expect(out.indicator).toBeNull();
    });
  });
});
