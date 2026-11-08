// generationTarget: where a site operations generation (MCP generate_page) goes, and the
// closed element it would stand under, which the validator keeps presets out of.
import { describe, expect, it } from 'vitest';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { generationTarget } from '../generated';

function makeProject(): ProjectModelType {
  const host = (id: string, type: string, parentId: string, children: unknown[] = [], props: Record<string, unknown> = {}) =>
    ({ id, type, componentType: 'host', parentId, props, children });
  return ProjectModel.create({
    id: 'site-1',
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 1 },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home', description: '' },
        appComponentTree: {
          id: 'root',
          type: 'div',
          componentType: 'host',
          props: {},
          children: [
            host('hero', 'section', 'root', [host('lead', 'p', 'hero', [host('mark', 'span', 'lead')])]),
            host('cta', 'button', 'root', [host('inner', 'span', 'cta')], { type: 'button' }),
          ],
        },
        canvasNodes: defaultViewportSnapshots(),
      },
    },
  });
}

const wireOf = (target: Parameters<typeof generationTarget>[1]) => {
  const resolved = generationTarget(makeProject(), target);
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.value.wire;
};

describe('generationTarget: the closed element a generation stands under', () => {
  it('names a p or a button the result goes into', () => {
    expect(wireOf({ kind: 'insert', pageId: 'home', parentId: 'lead' })).toMatchObject({ closedAncestor: 'p' });
    expect(wireOf({ kind: 'insert', pageId: 'home', parentId: 'mark' })).toMatchObject({ closedAncestor: 'p' });
    expect(wireOf({ kind: 'insert', pageId: 'home', parentId: 'inner' })).toMatchObject({ closedAncestor: 'button' });
    expect(wireOf({ kind: 'replace', pageId: 'home', nodeId: 'inner' })).toMatchObject({ closedAncestor: 'button' });
  });

  it('names none for a section, the page root, or a closed element the result replaces', () => {
    expect(wireOf({ kind: 'insert', pageId: 'home', parentId: 'hero' })).not.toHaveProperty('closedAncestor');
    expect(wireOf({ kind: 'insert', pageId: 'home' })).not.toHaveProperty('closedAncestor');
    expect(wireOf({ kind: 'replace', pageId: 'home', nodeId: 'cta' })).not.toHaveProperty('closedAncestor');
  });
});
