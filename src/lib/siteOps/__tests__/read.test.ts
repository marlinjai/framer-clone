// @vitest-environment node
//
// The read side and the pre-write render gate: a page outline keys styles by
// breakpoint key, pages a big page with a cursor that always moves on, refuses a
// cursor it does not know; the gate refuses what a renderer would drop and lets
// the node settings and the photo credit through.

import { describe, expect, it } from 'vitest';
import ProjectModel from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { pageOutline, siteOverview, vocabularyFor } from '../read';
import { keyedBreakpoints } from '../breakpoints';
import { renderGateProblem } from '../gate';

function projectWith(children: number) {
  const project = ProjectModel.create({
    id: 'site-1',
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 1 },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home', description: '' },
        appComponentTree: {
          id: 'root', type: 'div', componentType: 'host', props: {},
          children: Array.from({ length: children }, (_, i) => ({
            id: `p${i}`, type: 'p', componentType: 'host', parentId: 'root', props: { children: `Paragraph ${i} `.repeat(20) }, children: [],
          })),
        },
        canvasNodes: defaultViewportSnapshots(),
      },
    },
  });
  return { project, page: project.pages.get('home') as PageModelType };
}

describe('pageOutline', () => {
  it('shows styles keyed by breakpoint key and text as an excerpt', () => {
    const { page } = projectWith(1);
    const mobile = keyedBreakpoints(page)[2];
    (page.findComponent('p0') as { updateResponsiveStyle(p: string, v: string, b?: string): void }).updateResponsiveStyle('padding', '4px', mobile.id);
    const outline = pageOutline(page);
    const p0 = outline.nodes.find((n) => n.id === 'p0')!;
    expect(p0.style?.padding).toEqual({ mobile: '4px' });
    expect(p0.text!.length).toBeLessThanOrEqual(123);
    expect(outline.breakpoints).toEqual(['desktop', 'tablet', 'mobile']);
    expect(outline.nextCursor).toBeNull();
  });

  it('pages a big page and walks it to the end with the cursor', () => {
    const { page } = projectWith(200);
    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const part = pageOutline(page, { cursor, maxChars: 2000 });
      expect(part.total).toBe(201);
      seen.push(...part.nodes.map((n) => n.id));
      cursor = part.nextCursor ?? undefined;
    } while (cursor && guard++ < 500);
    expect(seen).toHaveLength(201);
    expect(new Set(seen).size).toBe(201);
  });

  it('refuses a cursor that names no node of the page', () => {
    const { page } = projectWith(1);
    expect(() => pageOutline(page, { cursor: 'ghost' })).toThrow(/names no node/);
  });
});

describe('siteOverview and vocabulary', () => {
  it('lists pages with their breakpoint keys and the version', () => {
    const { project } = projectWith(2);
    const overview = siteOverview(project, 9);
    expect(overview.version).toBe(9);
    expect(overview.pages[0]).toMatchObject({ id: 'home', isHome: true, nodeCount: 3 });
    expect(vocabularyFor(project, 9).site?.pages).toHaveLength(1);
  });
});

describe('renderGateProblem', () => {
  it('refuses a blocked tag or a handler, also deep inside', () => {
    expect(renderGateProblem({ id: 'a', type: 'script' })).toMatch(/script/);
    expect(renderGateProblem({ id: 'a', type: 'div', children: [{ id: 'b', type: 'a', props: { onclick: 'x' } }] })).toMatch(/onclick/);
  });

  it('judges svg children in svg', () => {
    expect(renderGateProblem({ id: 's', type: 'svg', children: [{ id: 'd', type: 'div' }] })).toMatch(/div/);
    expect(renderGateProblem({ id: 's', type: 'svg', children: [{ id: 'p', type: 'path', props: { d: 'M0 0' } }] })).toBeNull();
  });

  it('lets node settings, style and the photo credit through', () => {
    expect(
      renderGateProblem({
        id: 'i',
        type: 'img',
        props: {
          src: 'https://images.unsplash.com/photo-1',
          alt: 'Bread',
          'data-credit-name': 'Ana',
          style: { width: { base: '100%' } },
          rules: [],
          behaviour: {},
        },
      }),
    ).toBeNull();
  });
});
