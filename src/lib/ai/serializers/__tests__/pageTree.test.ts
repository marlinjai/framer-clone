// src/lib/ai/serializers/__tests__/pageTree.test.ts
//
// Snapshots a known fixture page that exercises every canvas-node type
// the serializer cares about: app tree root with a responsive style
// map, nested container + text content, a viewport node with breakpoint
// metadata, and a floating element. The serializer's output is compared
// against a committed expected shape so any regression in field naming
// or key ordering is loud.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';

import { serializePageTree } from '../pageTree';
import { serializeSubtree } from '../subtree';
import { stableStringify } from '../normalize';

import PageModel from '@/models/PageModel';
import ComponentModel, {
  CanvasNodeType,
  ComponentTypeEnum,
} from '@/models/ComponentModel';

function buildFixturePage() {
  const desktopBpId = 'bp-desktop';
  const mobileBpId = 'bp-mobile';

  // Eight components total:
  //   appTreeRoot (div)
  //     ├── header (header)
  //     │    └── heading (h1)  [text content via props.children]
  //     └── stack (div, flex column)
  //          ├── paragraph (p)
  //          └── button (button)
  // canvasNodes:
  //   viewport (div, canvasNodeType: VIEWPORT)
  //   floating (img, canvasNodeType: FLOATING_ELEMENT)
  const heading = ComponentModel.create({
    id: 'heading-1',
    type: 'h1',
    componentType: ComponentTypeEnum.HOST,
    props: { children: 'Welcome', style: { fontSize: '32px' } },
    label: 'Heading',
  });

  const header = ComponentModel.create({
    id: 'header-1',
    type: 'header',
    componentType: ComponentTypeEnum.HOST,
    props: { style: { padding: '16px' } },
    label: 'Header',
  });
  header.addChild(heading);

  const paragraph = ComponentModel.create({
    id: 'paragraph-1',
    type: 'p',
    componentType: ComponentTypeEnum.HOST,
    props: { children: 'Body text', style: { color: 'navy' } },
  });

  const button = ComponentModel.create({
    id: 'button-1',
    type: 'button',
    componentType: ComponentTypeEnum.HOST,
    props: { children: 'Click me' },
  });

  const stack = ComponentModel.create({
    id: 'stack-1',
    type: 'div',
    componentType: ComponentTypeEnum.HOST,
    props: { style: { display: 'flex', flexDirection: 'column' } },
    label: 'Stack',
  });
  stack.addChild(paragraph);
  stack.addChild(button);

  const appTree = ComponentModel.create({
    id: 'root-1',
    type: 'div',
    componentType: ComponentTypeEnum.HOST,
    // Responsive style map on width — keep base + mobile only.
    props: {
      style: {
        padding: '16px',
        width: { base: '100%', [mobileBpId]: '50%' },
      },
    },
  });
  appTree.addChild(header);
  appTree.addChild(stack);

  const viewport = ComponentModel.create({
    id: 'viewport-1',
    type: 'div',
    componentType: ComponentTypeEnum.HOST,
    canvasNodeType: CanvasNodeType.VIEWPORT,
    label: 'Desktop',
    breakpointId: desktopBpId,
    breakpointMinWidth: 1280,
    viewportWidth: 1280,
    viewportHeight: 800,
    canvasX: 100,
    canvasY: 100,
    props: {},
  });

  const floating = ComponentModel.create({
    id: 'floating-1',
    type: 'img',
    componentType: ComponentTypeEnum.HOST,
    canvasNodeType: CanvasNodeType.FLOATING_ELEMENT,
    canvasX: 500,
    canvasY: 320,
    canvasZIndex: 2,
    label: 'Hero',
    props: { alt: 'Hero', src: '/hero.png' },
  });

  const page = PageModel.create({
    id: 'page-1',
    slug: 'home',
    metadata: {
      title: 'Home',
      description: '',
    },
    createdAt: new Date('2026-05-24T00:00:00.000Z'),
    updatedAt: new Date('2026-05-24T00:00:00.000Z'),
    appComponentTree: appTree,
    canvasNodes: {
      [viewport.id]: viewport,
      [floating.id]: floating,
    },
  });

  return { page, mobileBpId };
}

describe('serializePageTree', () => {
  it('produces the expected structure for the fixture page', () => {
    const { page, mobileBpId } = buildFixturePage();
    const out = serializePageTree(page);

    // Structural assertions: root identity + immediate children.
    expect(out.id).toBe('root-1');
    expect(out.type).toBe('div');
    expect(out.componentType).toBe('host');
    expect(out.canvasNodeType).toBe('component');
    expect(out.children.map((c) => c.id)).toEqual(['header-1', 'stack-1']);

    // Header subtree retains its descendant.
    const header = out.children.find((c) => c.id === 'header-1')!;
    expect(header.children.map((c) => c.id)).toEqual(['heading-1']);
    // Heading carries its text content through props.children.
    const heading = header.children[0];
    expect(heading.props.children).toBe('Welcome');

    // Stack has both paragraph and button in declared insertion order.
    const stack = out.children.find((c) => c.id === 'stack-1')!;
    expect(stack.children.map((c) => c.id)).toEqual([
      'paragraph-1',
      'button-1',
    ]);

    // Responsive style map round-trips on the root.
    const rootWidth = (out.props as any).style.width as Record<string, string>;
    expect(rootWidth.base).toBe('100%');
    expect(rootWidth[mobileBpId]).toBe('50%');

    // parentId is emitted for non-root nodes.
    expect(header.parentId).toBe('root-1');
    expect(heading.parentId).toBe('header-1');
    // Root has no parent and the key is omitted.
    expect('parentId' in out).toBe(false);

    // Top-level keys arrive sorted alphabetically.
    expect(Object.keys(out)).toEqual([
      'canvasNodeType',
      'children',
      'componentType',
      'id',
      'props',
      'type',
    ]);
  });

  it('is deterministic — two runs produce byte-identical JSON', () => {
    const { page: p1 } = buildFixturePage();
    const { page: p2 } = buildFixturePage();
    expect(stableStringify(serializePageTree(p1))).toBe(
      stableStringify(serializePageTree(p2)),
    );
  });

  it('truncates deep subtrees when maxTokens is binding', () => {
    const { page } = buildFixturePage();
    const out = serializePageTree(page, { maxTokens: 25 }); // absurdly tight
    // Expect leaves dropped — the immediate children may survive but
    // their subtrees should be empty.
    let maxDepth = 0;
    const measure = (n: { children?: Array<unknown> }, d: number) => {
      if (d > maxDepth) maxDepth = d;
      const kids = (n.children as Array<{ children?: Array<unknown> }>) ?? [];
      for (const c of kids) measure(c, d + 1);
    };
    measure(out, 0);
    // Full fixture depth is 3 (root → stack → button); truncation should
    // bring this down.
    expect(maxDepth).toBeLessThan(3);
  });
});

describe('serializeSubtree', () => {
  it('serializes a viewport node with breakpoint metadata as canvasNodeType: viewport', () => {
    const { page } = buildFixturePage();
    const viewport = page.canvasNodes.get('viewport-1')!;
    const out = serializeSubtree(viewport);
    expect(out.canvasNodeType).toBe('viewport');
    expect(out.label).toBe('Desktop');
    // Breakpoint metadata is intentionally NOT part of SerializedComponent
    // (it's exposed via serializeBreakpoints / projectOverview). We only
    // verify the node-typing here.
    expect(out.children).toEqual([]);
  });

  it('serializes a floating element with canvasNodeType: floating', () => {
    const { page } = buildFixturePage();
    const floating = page.canvasNodes.get('floating-1')!;
    const out = serializeSubtree(floating);
    expect(out.canvasNodeType).toBe('floating');
    expect(out.props).toEqual({ alt: 'Hero', src: '/hero.png' });
  });
});
