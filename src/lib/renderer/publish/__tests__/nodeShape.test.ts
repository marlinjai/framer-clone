// A stored tree is opaque JSON to the save route, so a bad child costs that child.
import { describe, expect, it, vi } from 'vitest';
import { wellFormedTree } from '@/lib/renderer/publish/nodeShape';
import { hydrateBindings } from '@/lib/renderer/publish/hydrateBindings';
import { componentSnapshotToNode } from '@/lib/renderer/server/componentSnapshot';

const hydrate = (node: unknown) => hydrateBindings(node as never, {}, { cmsRepo: {} as never });

describe('wellFormedTree', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('leaves a healthy tree alone, the same object', () => {
    const tree = { type: 'div', props: { id: 'a' }, children: [{ type: 'p', props: {} }] };
    expect(wellFormedTree(tree)).toBe(tree);
  });

  it.each([[null], ['x'], [1], [[]]])('refuses %j as a node', (value) => {
    expect(wellFormedTree(value)).toBeNull();
  });

  it.each([
    ['x'],
    [1],
    [{ type: 'p' }],
  ])('drops children that are %j', (children) => {
    expect(wellFormedTree({ type: 'div', children })).toEqual({ type: 'div' });
  });

  it('keeps the good children beside a bad one, at any depth', () => {
    const tree = { type: 'div', children: [null, 'x', { type: 'p', children: [null, { type: 'b' }] }] };
    expect(wellFormedTree(tree)).toEqual({ type: 'div', children: [{ type: 'p', children: [{ type: 'b' }] }] });
  });

  it('drops props and bindings that are no objects', () => {
    expect(wellFormedTree({ type: 'div', props: 'x', bindings: ['x'] })).toEqual({ type: 'div' });
  });
});

describe('the published route', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  it.each([
    [{ type: 'div', props: {}, children: 'x' }],
    [{ type: 'div', props: {}, children: [null] }],
    [{ type: 'div', props: {}, children: [{ type: 'p', props: {}, children: 'x' }] }],
    [{ type: 'div', props: 'x' }],
  ])('hydrates %j without throwing', async (tree) => {
    await expect(hydrate(tree)).resolves.toBeTruthy();
  });

  it('adapts a snapshot with a null child', () => {
    const node = componentSnapshotToNode({ type: 'div', props: {}, children: [null, { type: 'p', props: {} }] } as never);
    expect(node.children).toHaveLength(1);
  });
});
