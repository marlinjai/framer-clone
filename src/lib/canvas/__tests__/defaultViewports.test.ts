import { describe, it, expect } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel from '@/models/ProjectModel';
import { CanvasNodeType } from '@/models/ComponentModel';
import { DEFAULT_VIEWPORTS, defaultViewportSnapshots, hasViewport, withDefaultViewports } from '../defaultViewports';

describe('default viewports', () => {
  it('are Desktop 1280x800, Tablet 768x1024, Mobile 375x667, side by side', () => {
    const frames = Object.values(defaultViewportSnapshots()) as Array<Record<string, unknown>>;
    expect(frames.map((f) => [f.label, f.breakpointMinWidth, f.viewportWidth, f.viewportHeight, f.canvasX])).toEqual([
      ['Desktop', 1280, 1280, 800, 100],
      ['Tablet', 768, 768, 1024, 1430],
      ['Mobile', 320, 375, 667, 2248],
    ]);
    expect(frames.every((f) => f.canvasNodeType === CanvasNodeType.VIEWPORT)).toBe(true);
    expect(new Set(frames.map((f) => f.breakpointId)).size).toBe(3);
  });

  it('use given breakpoint ids in order', () => {
    const frames = Object.values(defaultViewportSnapshots(['a', 'b', 'c'])) as Array<{ breakpointId: string }>;
    expect(frames.map((f) => f.breakpointId)).toEqual(['a', 'b', 'c']);
  });

  it('withDefaultViewports repairs a page without frames and keeps its other canvas nodes', () => {
    const floating = { id: 'img-1', canvasNodeType: CanvasNodeType.FLOATING_ELEMENT };
    const page = { id: 'p', canvasNodes: { 'img-1': floating } };
    const repaired = withDefaultViewports(page);
    expect(repaired).not.toBe(page);
    expect(page.canvasNodes).toEqual({ 'img-1': floating }); // input untouched
    const nodes = Object.values(repaired.canvasNodes);
    expect(nodes).toHaveLength(4);
    expect(nodes.filter((n) => n.canvasNodeType === CanvasNodeType.VIEWPORT)).toHaveLength(3);
  });

  it('withDefaultViewports treats a missing canvasNodes map as empty', () => {
    const page: { id: string; canvasNodes?: unknown } = { id: 'p' };
    expect(hasViewport(Object.values(withDefaultViewports(page).canvasNodes as object))).toBe(true);
  });

  it('withDefaultViewports leaves a page with any frame alone (idempotent)', () => {
    const once = withDefaultViewports({ id: 'p', canvasNodes: {} });
    expect(withDefaultViewports(once)).toBe(once);
  });

  it('a page created in the editor gets exactly these frames', () => {
    const project = ProjectModel.create({ id: 's', metadata: { title: 'x', description: '' }, pages: {} });
    const page = project.createPage('About');
    const labels = page.sortedViewportNodes.map((v) => `${v.label}:${v.breakpointMinWidth}`);
    expect(labels).toEqual(DEFAULT_VIEWPORTS.map((v) => `${v.label}:${v.minWidth}`));
    expect(Object.keys(getSnapshot(page.canvasNodes))).toHaveLength(3);
  });

  it('PageModel.ensureDefaultViewports repairs once, then is a no-op', () => {
    const project = ProjectModel.create({
      id: 's',
      metadata: { title: 'x', description: '' },
      pages: {
        home: {
          id: 'home',
          slug: '',
          metadata: { title: 'test page', description: '' },
          appComponentTree: { id: 'root', type: 'div', componentType: 'host', props: {} },
          canvasNodes: {},
        },
      },
    });
    const page = project.getPage('home')!;
    expect(page.viewportNodes).toHaveLength(0);
    expect(page.ensureDefaultViewports()).toBe(true);
    expect(page.viewportNodes).toHaveLength(3);
    expect(page.ensureDefaultViewports()).toBe(false);
    expect(page.viewportNodes).toHaveLength(3);
  });
});
