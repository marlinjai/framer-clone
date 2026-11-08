// DraftCameraFollow (../PageGenDraftLayer.tsx): the camera brings each new
// draft section into view, until the user moves the camera themselves; from
// then on the run leaves it alone. jsdom has no layout, so the boxes are stubbed.

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { TransformProvider } from '@/contexts/TransformContext';
import { useCameraControls } from '@/lib/canvas/cameraControls';
import { captureTarget } from '@/lib/ai/pageGen/editorBridge';
import { draftTargetFor } from '@/lib/ai/pageGen/draft';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import type { PageGenSection } from '@/lib/ai/pageGen/protocol';
import type { PageModelType } from '@/models/PageModel';
import type { ComponentInstance } from '@/models/ComponentModel';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import { DRAFT_SECTION_ATTR, DraftCameraFollow } from '../PageGenDraftLayer';

let page: PageModelType;
let camera: ReturnType<typeof useCameraControls>;

function CameraHandle() {
  camera = useCameraControls();
  return null;
}

function rect(top: number, height = 200): DOMRect {
  return { top, bottom: top + height, left: 100, right: 500, width: 400, height, x: 100, y: top, toJSON: () => ({}) } as DOMRect;
}

/** A drawn section whose element sits at `top` on screen. */
function placeSection(index: number, top: number) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute(DRAFT_SECTION_ATTR, String(index));
  const el = document.createElement('section');
  el.getBoundingClientRect = () => rect(top);
  wrapper.appendChild(el);
  document.body.appendChild(wrapper);
}

function section(index: number): PageGenSection {
  const target = captureTarget('insert', page, page.appComponentTree as ComponentInstance);
  const out = validateGeneration({ nodes: [{ type: 'section', label: `S${index}` }] }, { breakpoints: deriveBreakpointKeys(target.breakpoints) });
  if (!out.ok) throw new Error(out.errors.join('; '));
  return { generationId: 'g', index, attempt: 1, node: out.result.nodes[0] };
}

beforeEach(() => {
  store = createRootStore();
  store.projectStore.createProject('Crumb');
  const project = store.projectStore.findProjectByTitle('Crumb')!;
  page = project.createPage('Home');
  page.ensureDefaultViewports();
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  const ground = document.createElement('div');
  ground.setAttribute('data-ground', 'true');
  ground.getBoundingClientRect = () => ({ ...rect(0, 800), left: 0, right: 1200, width: 1200, x: 0 }) as DOMRect;
  document.body.appendChild(ground);
  const target = captureTarget('insert', page, page.appComponentTree as ComponentInstance);
  store.editorUI.pageGenDraft.begin(draftTargetFor({ requestKey: 'k1', target, rootId: page.appComponentTree.id }));
  render(
    <TransformProvider>
      <CameraHandle />
      <DraftCameraFollow />
    </TransformProvider>,
  );
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('DraftCameraFollow', () => {
  it('pans a new section below the fold into view', () => {
    placeSection(0, 1200);
    act(() => void store.editorUI.pageGenDraft.add('k1', section(0)));
    // Its bottom (1400) brought above the ground's bottom (800) less the margin.
    expect(camera.read().panY).toBe(800 - 48 - 1400);
  });

  it('leaves a section already in view alone', () => {
    placeSection(0, 100);
    act(() => void store.editorUI.pageGenDraft.add('k1', section(0)));
    expect(camera.read()).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it('stops following once the user moved the camera', () => {
    placeSection(0, 100);
    act(() => void store.editorUI.pageGenDraft.add('k1', section(0)));
    act(() => camera.panBy(0, -300)); // the user scrolls away
    placeSection(1, 1600);
    act(() => void store.editorUI.pageGenDraft.add('k1', section(1)));
    expect(camera.read().panY).toBe(-300);
  });

  it('a new run follows again', () => {
    placeSection(0, 100);
    act(() => void store.editorUI.pageGenDraft.add('k1', section(0)));
    act(() => camera.panBy(0, -300));
    act(() => store.editorUI.pageGenDraft.clear());
    const target = captureTarget('insert', page, page.appComponentTree as ComponentInstance);
    act(() => store.editorUI.pageGenDraft.begin(draftTargetFor({ requestKey: 'k2', target, rootId: page.appComponentTree.id })));
    document.body.querySelectorAll(`[${DRAFT_SECTION_ATTR}]`).forEach((n) => n.remove());
    placeSection(0, 1200);
    act(() => void store.editorUI.pageGenDraft.add('k2', section(0)));
    expect(camera.read().panY).toBe(-300 + 800 - 48 - 1400);
  });
});
