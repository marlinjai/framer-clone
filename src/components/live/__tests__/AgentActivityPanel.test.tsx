// The activity feed (../AgentActivityPanel.tsx) and the camera following the
// agent (AgentCameraFollow in ../AgentPresenceLayer.tsx). jsdom has no layout:
// element boxes are stubbed.

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { TransformProvider } from '@/contexts/TransformContext';
import { useCameraControls } from '@/lib/canvas/cameraControls';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import type { AgentActivity, LiveFeedLine } from '@/lib/projects/liveEvents';
import type { LivePresenceStore } from '@/lib/live/presenceStore';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import AgentActivityPanel from '../AgentActivityPanel';
import { AgentCameraFollow } from '../AgentPresenceLayer';

let home: PageModelType;
let about: PageModelType;
let camera: ReturnType<typeof useCameraControls>;
const presence = () => store.editorUI.livePresence as LivePresenceStore;

function CameraHandle() {
  camera = useCameraControls();
  return null;
}

function rect(left: number, top: number, width = 400, height = 200): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

const boxes: Record<string, DOMRect> = {};
function drawCanvas() {
  document.querySelector('[data-camera-transform]')?.remove();
  const cam = document.createElement('div');
  cam.setAttribute('data-camera-transform', '0,0,1');
  for (const id of Object.keys(boxes)) {
    const el = document.createElement('section');
    el.setAttribute('data-inner-component-id', id);
    el.getBoundingClientRect = () => {
      const { panX, panY } = camera.read();
      const b = boxes[id];
      return rect(b.left + panX, b.top + panY, b.width, b.height);
    };
    cam.appendChild(el);
  }
  document.body.appendChild(cam);
}

function line(over: Partial<LiveFeedLine>): LiveFeedLine {
  return { id: 'l1', agentId: 'a1', label: 'Claude', actorKind: 'key', tool: 'apply_batch', outcome: 'ok', at: '2026-11-08T12:00:00Z', ...over };
}

function activity(over: Partial<AgentActivity> = {}): AgentActivity {
  return { callId: 'c1', agentId: 'a1', label: 'Claude', tool: 'apply_batch', phase: 'start', pageId: home.id, nodeIds: ['hero'], at: new Date().toISOString(), ...over };
}

async function frame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

beforeEach(() => {
  store = createRootStore();
  store.projectStore.createProject('Crumb');
  const project = store.projectStore.findProjectByTitle('Crumb')!;
  home = project.createPage('Home');
  about = project.createPage('About');
  for (const p of [home, about]) p.ensureDefaultViewports();
  (home.appComponentTree as ComponentInstance).addChild(createIntrinsicComponent('hero', 'section', {}));
  (home.appComponentTree as ComponentInstance).addChild(createIntrinsicComponent('pricing', 'section', {}));
  (about.appComponentTree as ComponentInstance).addChild(createIntrinsicComponent('team', 'section', {}));
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(home);
  const ground = document.createElement('div');
  ground.setAttribute('data-ground', 'true');
  ground.getBoundingClientRect = () => rect(0, 0, 1200, 800);
  document.body.appendChild(ground);
  boxes.hero = rect(100, 50);
  boxes.pricing = rect(100, 2000);
  render(
    <TransformProvider>
      <CameraHandle />
      <AgentCameraFollow />
      <AgentActivityPanel />
    </TransformProvider>,
  );
  drawCanvas();
});

afterEach(() => {
  presence().reset();
  cleanup();
  document.body.innerHTML = '';
});

describe('the activity feed', () => {
  it('stays out of the way until there is something to show', () => {
    expect(screen.queryByRole('region', { name: 'Agent activity' })).toBeNull();
  });

  it('shows the backfill of a reload, newest first, with page titles from the open copy, closed until an agent is active', () => {
    act(() =>
      presence().applyState({
        agents: [],
        feed: [
          line({ id: 'l2', tool: 'apply_batch', changes: 4, pageId: home.id, nodeIds: ['pricing'] }),
          line({ id: 'l1', tool: 'get_page', pageId: about.id }),
          line({ id: 'l0', tool: 'apply_batch', outcome: 'site_changed' }),
        ],
      }),
    );
    const panel = screen.getByRole('region', { name: 'Agent activity' });
    const toggle = within(panel).getByRole('button', { name: /Agent activity/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const items = within(panel).getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('Wrote 4 changes on Home');
    expect(items[1]).toContain('Read the About page');
    expect(items[2]).toContain('Changes refused: site changed, re-reading');
    expect(items.every((t) => t?.includes('Claude'))).toBe(true);
  });

  it('opens by itself when an agent becomes active and adds each ended call', () => {
    act(() => presence().applyActivity(activity()));
    const panel = screen.getByRole('region', { name: 'Agent activity' });
    expect(within(panel).getByRole('button', { name: /Agent activity/ })).toHaveAttribute('aria-expanded', 'true');
    act(() => presence().applyActivity(activity({ phase: 'end', outcome: 'ok', changes: 2 })));
    expect(within(panel).getByText('Wrote 2 changes on Home')).toBeInTheDocument();
  });

  it('a click on a line selects its nodes that still exist, on their page; a line whose nodes are gone is plain', () => {
    store.editorUI.setCurrentPage(about);
    act(() =>
      presence().applyState({
        agents: [],
        feed: [line({ id: 'l2', pageId: home.id, nodeIds: ['gone', 'pricing'] }), line({ id: 'l1', nodeIds: ['gone'] })],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Agent activity/ }));
    const [first, second] = screen.getAllByRole('listitem');
    expect(within(second).queryByRole('button')).toBeNull();
    fireEvent.click(within(first).getByRole('button'));
    expect(store.editorUI.currentPage?.id).toBe(home.id);
    expect(store.editorUI.selectedComponent?.id).toBe('pricing');
    // The tree node comes with its frame, so the canvas can outline it and show its handles.
    expect(store.editorUI.currentViewportNode?.breakpointId).toBe(home.viewportNodes[0].breakpointId);
  });

  it('a line that names only a page opens that page', () => {
    act(() => presence().applyState({ agents: [], feed: [line({ id: 'l3', tool: 'get_page', pageId: about.id })] }));
    fireEvent.click(screen.getByRole('button', { name: /Agent activity/ }));
    fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('button'));
    expect(store.editorUI.currentPage?.id).toBe(about.id);
  });

  it('Follow is a toggle on the presence store', () => {
    act(() => presence().applyActivity(activity()));
    const follow = screen.getByRole('button', { name: 'Follow' });
    expect(follow).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(follow);
    expect(presence().follow).toBe(false);
    expect(follow).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('the camera follows the agent', () => {
  it('brings the section into view, until the person moves the camera; Follow turns it back on', async () => {
    act(() => presence().applyActivity(activity({ nodeIds: ['pricing'] })));
    await frame();
    // Pricing sits at 2000, below the 800px ground: the camera panned up to it.
    expect(camera.read().panY).toBeLessThan(-1000);

    // The person pans; the next move of the agent leaves the camera alone.
    act(() => camera.panBy(0, 500));
    const where = camera.read();
    act(() => presence().applyActivity(activity({ callId: 'c2', nodeIds: ['hero'] })));
    await frame();
    expect(camera.read()).toEqual(where);
    expect(presence().follow).toBe(false);

    // Follow on again: the next move is followed.
    act(() => presence().setFollow(true));
    act(() => presence().applyActivity(activity({ callId: 'c3', nodeIds: ['pricing'] })));
    await frame();
    expect(camera.read().panY).not.toBe(where.panY);
  });

  it('notices the person panning before the agent has a target on this page', async () => {
    // The agent starts on the About page: nothing to frame on Home yet.
    act(() => presence().applyActivity(activity({ pageId: about.id, nodeIds: ['team'] })));
    await frame();
    expect(presence().follow).toBe(true);
    act(() => camera.panBy(0, 400));
    await frame();
    expect(presence().follow).toBe(false);
    const where = camera.read();
    // Its next call lands on Home: the camera stays where the person put it.
    act(() => presence().applyActivity(activity({ callId: 'c2', nodeIds: ['pricing'] })));
    await frame();
    expect(camera.read()).toEqual(where);
  });

  it("a new run follows again even after the person moved the camera between runs", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      act(() => presence().applyActivity(activity({ nodeIds: ['hero'] })));
      await frame();
      act(() => presence().applyActivity(activity({ phase: 'end', outcome: 'ok', nodeIds: ['hero'] })));
      act(() => vi.advanceTimersByTime(60_000));
      expect(presence().anyActive).toBe(false);
      act(() => camera.panBy(0, 300));
      act(() => presence().applyActivity(activity({ callId: 'c2', nodeIds: ['pricing'] })));
      await frame();
      expect(presence().follow).toBe(true);
      expect(camera.read().panY).toBeLessThan(-1000);
    } finally {
      vi.useRealTimers();
    }
  });
});
