/* eslint-disable @typescript-eslint/no-explicit-any */
// snapshotToComponentNode: faithful PageModel SnapshotOut -> ComponentNode map.
import { describe, it, expect } from 'vitest';
import type { PageSnapshotOut } from '@/models/PageModel';
import {
  snapshotToComponentNode,
  componentSnapshotToNode,
} from '../snapshotToComponentNode';

/** Build a minimal ComponentModel-SnapshotOut-like node (only fields we map). */
function comp(node: Record<string, unknown>): any {
  return {
    componentType: 'host',
    canvasNodeType: 'component',
    canvasVisible: true,
    canvasScale: 1,
    canvasRotation: 0,
    canvasZIndex: 0,
    props: {},
    bindings: {},
    children: [],
    ...node,
  };
}

function page(snapshot: Record<string, unknown>): PageSnapshotOut {
  return {
    id: 'page-1',
    slug: 'about',
    metadata: {
      title: 'About',
      description: 'About us',
      keywords: ['a', 'b'],
      ogTitle: 'About OG',
      ogDescription: '',
      ogImage: 'https://x/og.png',
      canonicalUrl: '',
    },
    createdAt: 0,
    updatedAt: 0,
    appComponentTree: comp({ id: 'root', type: 'div' }),
    canvasNodes: {},
    ...snapshot,
  } as unknown as PageSnapshotOut;
}

describe('componentSnapshotToNode', () => {
  it('maps type / id / props / bindings / children faithfully and drops canvas fields', () => {
    const snap = comp({
      id: 'n1',
      type: 'p',
      props: { children: 'Hello', style: { color: 'red' } },
      bindings: { children: { mode: 'read', expression: '{{row.title}}' } },
      children: [comp({ id: 'n2', type: 'span', props: { children: 'inner' } })],
    });

    const node = componentSnapshotToNode(snap);

    expect(node).toEqual({
      type: 'p',
      id: 'n1',
      props: { children: 'Hello', style: { color: 'red' } },
      bindings: { children: { mode: 'read', expression: '{{row.title}}' } },
      children: [{ type: 'span', id: 'n2', props: { children: 'inner' } }],
    });
    // Editor-only canvas fields are not carried.
    expect((node as unknown as Record<string, unknown>).componentType).toBeUndefined();
    expect((node as unknown as Record<string, unknown>).canvasNodeType).toBeUndefined();
  });

  it('omits empty props / bindings / children', () => {
    const node = componentSnapshotToNode(comp({ id: 'n', type: 'div' }));
    expect(node).toEqual({ type: 'div', id: 'n' });
  });
});

describe('snapshotToComponentNode', () => {
  it('extracts appComponentTree as the root and lifts SEO metadata; ignores canvasNodes', () => {
    const adapted = snapshotToComponentNode(
      page({
        appComponentTree: comp({
          id: 'root',
          type: 'div',
          children: [comp({ id: 'h', type: 'h1', props: { children: 'Hi' } })],
        }),
        canvasNodes: {
          vp1: comp({ id: 'vp1', type: 'div', canvasNodeType: 'viewport' }),
        },
      }),
    );

    expect(adapted.slug).toBe('about');
    expect(adapted.root).toEqual({
      type: 'div',
      id: 'root',
      children: [{ type: 'h1', id: 'h', props: { children: 'Hi' } }],
    });
    expect(adapted.metadata).toEqual({
      title: 'About',
      description: 'About us',
      keywords: ['a', 'b'],
      ogTitle: 'About OG',
      ogDescription: '',
      ogImage: 'https://x/og.png',
      canonicalUrl: '',
    });
  });

  it('returns root null when the snapshot has no app component tree', () => {
    const adapted = snapshotToComponentNode(
      page({ appComponentTree: undefined }),
    );
    expect(adapted.root).toBeNull();
  });
});
