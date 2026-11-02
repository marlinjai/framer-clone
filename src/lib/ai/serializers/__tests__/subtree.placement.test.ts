// A placement as the generator reads it: its component's name and its own values,
// never the component's inner tree. docs/plans/2026-11-02-reusable-components.md,
// "AI generation".
import { describe, expect, it } from 'vitest';
import ProjectStore from '@/stores/ProjectStore';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { getSnapshot } from 'mobx-state-tree';
import { serializeSubtree } from '../subtree';

const host = (id: string, type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({ id, type, componentType: 'host', props, children });

function setup() {
  const store = ProjectStore.create({});
  store.ingestProjectSnapshot({
    id: 'site',
    metadata: { title: 'Site' },
    pages: {},
    components: {
      card: { id: 'card', name: 'Card', inputs: [{ id: 'title', name: 'Title', type: 'text' }], states: [], page: { id: 'card-page', metadata: { title: 'Card' }, appComponentTree: host('c-root', 'article', {}, [host('c-secret', 'h3', { children: 'Inner' })]), canvasNodes: {} } },
    } as never,
  });
  const project = store.getProject('site') as ProjectModelType;
  const page = project.createPage('Home');
  const root = getSnapshot(page.appComponentTree) as unknown as { id: string };
  page.setAppComponentTree({
    ...root,
    children: [
      { ...host('p1', '#component', { component: 'card', inputs: { title: 'Pro' }, state: 's1', style: { width: { base: '50%' } } }), parentId: root.id },
      { ...host('p2', '#component', { component: 'gone' }), parentId: root.id },
    ],
  } as never);
  return page.appComponentTree as ComponentInstance;
}

describe('serializeSubtree with placements', () => {
  it('writes a placement as its name and values, without the inner tree', () => {
    const out = serializeSubtree(setup());
    const [card, missing] = out.children;
    expect(card).toMatchObject({ type: '#component', name: 'Card', inputs: { title: 'Pro' }, state: 's1', props: { style: { width: { base: '50%' } } }, children: [] });
    expect(JSON.stringify(out)).not.toContain('c-secret');
    expect(JSON.stringify(out)).not.toContain('"component"');
    expect(missing).toMatchObject({ name: 'Missing component', inputs: {} });
  });
});
