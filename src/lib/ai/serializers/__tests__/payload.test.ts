// src/lib/ai/serializers/__tests__/payload.test.ts
//
// Integration: assemble a full AI-edit request payload from a realistic
// 50-component fixture page and assert it fits comfortably under the
// 12K-token budget the spec calls out. This is the load-bearing test for
// the "we can put one real customer page in a prompt" claim.

import { describe, it, expect } from 'vitest';

import { ProjectModel } from '@/models/ProjectModel';
import PageModel from '@/models/PageModel';
import ComponentModel, {
  CanvasNodeType,
  ComponentTypeEnum,
} from '@/models/ComponentModel';
import EditorUIStore from '@/stores/EditorUIStore';

import {
  estimateTokens,
  serializeBreakpoints,
  serializePageTree,
  serializeProjectOverview,
  serializeRegistry,
  serializeSelection,
  stableStringify,
  toPromptString,
} from '..';

function buildLargePage() {
  // A wide-and-shallow page: 1 root + ~50 children grouped under cards.
  // Mirrors a realistic landing page with hero + grid of feature cards.
  const root = ComponentModel.create({
    id: 'root',
    type: 'div',
    componentType: ComponentTypeEnum.HOST,
    props: { style: { padding: '24px' } },
  });

  // 10 cards × 4 children each + 10 card roots + 1 root = 51 components.
  for (let i = 0; i < 10; i++) {
    const card = ComponentModel.create({
      id: `card-${i}`,
      type: 'div',
      componentType: ComponentTypeEnum.HOST,
      props: { style: { padding: '16px', backgroundColor: '#fff' } },
      label: `Card ${i}`,
    });
    for (let j = 0; j < 4; j++) {
      const child = ComponentModel.create({
        id: `card-${i}-text-${j}`,
        type: 'p',
        componentType: ComponentTypeEnum.HOST,
        props: { children: `Card ${i} row ${j}` },
      });
      card.addChild(child);
    }
    root.addChild(card);
  }

  const desktop = ComponentModel.create({
    id: 'viewport-desktop',
    type: 'div',
    componentType: ComponentTypeEnum.HOST,
    canvasNodeType: CanvasNodeType.VIEWPORT,
    canvasX: 0,
    canvasY: 0,
    breakpointId: 'bp-desktop',
    breakpointMinWidth: 1280,
    viewportWidth: 1280,
    viewportHeight: 800,
    label: 'Desktop',
    props: {},
  });

  const page = PageModel.create({
    id: 'page-1',
    slug: 'home',
    metadata: { title: 'Home', description: '' },
    createdAt: new Date('2026-05-24T00:00:00.000Z'),
    updatedAt: new Date('2026-05-24T00:00:00.000Z'),
    appComponentTree: root,
    canvasNodes: { [desktop.id]: desktop },
  });

  const project = ProjectModel.create({
    id: 'project-1',
    metadata: {
      title: 'Demo',
      description: '',
      createdAt: new Date('2026-05-24T00:00:00.000Z'),
      updatedAt: new Date('2026-05-24T00:00:00.000Z'),
    },
    pages: { [page.id]: page },
  });

  return { project, page };
}

describe('full AI-edit payload assembly', () => {
  it('fits under 12K tokens for a 50-component page', () => {
    const { project, page } = buildLargePage();
    const editorUI = EditorUIStore.create({});

    const stableSection = [
      toPromptString('project_overview', serializeProjectOverview(project)),
      toPromptString('component_registry', serializeRegistry()),
      toPromptString('breakpoints', serializeBreakpoints(project)),
    ].join('\n\n');

    const volatileSection = [
      toPromptString(
        'page_snapshot',
        serializePageTree(page, { maxTokens: 8000 }),
      ),
      toPromptString(
        'selection',
        serializeSelection(editorUI, project),
      ),
    ].join('\n\n');

    const full = `${stableSection}\n\n${volatileSection}`;
    const total = estimateTokens(full);
    expect(total).toBeLessThan(12_000);
  });

  it('produces byte-identical stable section across runs', () => {
    const { project: p1 } = buildLargePage();
    const { project: p2 } = buildLargePage();

    const left = [
      stableStringify(serializeProjectOverview(p1)),
      stableStringify(serializeRegistry()),
      stableStringify(serializeBreakpoints(p1)),
    ].join('|');

    const right = [
      stableStringify(serializeProjectOverview(p2)),
      stableStringify(serializeRegistry()),
      stableStringify(serializeBreakpoints(p2)),
    ].join('|');

    expect(left).toBe(right);
  });
});
