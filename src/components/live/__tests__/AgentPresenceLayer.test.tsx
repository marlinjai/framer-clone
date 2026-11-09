// AgentPresenceLayer (../AgentPresenceLayer.tsx): the agent's frame and label
// at the section containing the call's nodes, the 200ms move only when the
// section changes, the fade 4 s after the last call, the instant path under
// reduced motion, and frames keyed to deleted nodes dropped. Plus the Pages
// panel dot and the top bar's note. jsdom has no layout: element boxes are stubbed.

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { TransformProvider, useTransformNotifier } from '@/contexts/TransformContext';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import { AGENT_FRAME_LINGER_MS, type AgentActivity } from '@/lib/projects/liveEvents';
import type { LivePresenceStore } from '@/lib/live/presenceStore';
import { REVEAL_KEYFRAMES } from '@/lib/live/reveal';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import AgentPresenceLayer, {
  EDITOR_CHROME_ATTR,
  PRESENCE_FRAME_ATTR,
  PRESENCE_LABEL_ATTR,
  PRESENCE_MOVE_MS,
  frameBox,
  pillPlacement,
  visibleCanvasRect,
} from '../AgentPresenceLayer';
import AgentPageDot from '../AgentPageDot';
import AgentEditingNote from '../AgentEditingNote';

let page: PageModelType;
let notify: () => void;
let reduced = false;

function NotifyHandle() {
  notify = useTransformNotifier();
  return null;
}

const presence = () => store.editorUI.livePresence as LivePresenceStore;

function rect(left: number, top: number, width = 400, height = 200): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

/** The canvas: one breakpoint frame drawing the page's sections at fixed boxes. */
function drawCanvas(boxes: Record<string, DOMRect>) {
  document.querySelector('[data-camera-transform]')?.remove();
  const camera = document.createElement('div');
  camera.setAttribute('data-camera-transform', '0,0,1');
  const frame = document.createElement('div');
  frame.setAttribute('data-viewport-id', 'desktop');
  frame.getBoundingClientRect = () => rect(0, 0, 1200, 1000);
  camera.appendChild(frame);
  for (const [id, box] of Object.entries(boxes)) {
    const el = document.createElement('section');
    el.setAttribute('data-inner-component-id', id);
    el.getBoundingClientRect = () => box;
    frame.appendChild(el);
  }
  document.body.appendChild(camera);
}

function activity(over: Partial<AgentActivity> = {}): AgentActivity {
  return { callId: 'c1', agentId: 'a1', label: 'Claude', tool: 'apply_batch', phase: 'start', pageId: page.id, nodeIds: ['hero-title'], at: new Date().toISOString(), ...over };
}

const frames = () => Array.from(document.querySelectorAll<HTMLElement>(`[${PRESENCE_FRAME_ATTR}]`));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(Date.parse('2026-11-08T12:00:00Z'));
  reduced = false;
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
  store = createRootStore();
  store.projectStore.createProject('Crumb');
  const project = store.projectStore.findProjectByTitle('Crumb')!;
  page = project.createPage('Home');
  page.ensureDefaultViewports();
  const root = page.appComponentTree as ComponentInstance;
  root.addChild(createIntrinsicComponent('hero', 'section', {}));
  (root.children.find((c: ComponentInstance) => c.id === 'hero') as ComponentInstance).addChild(createIntrinsicComponent('hero-title', 'h1', { children: 'Hi' }));
  root.addChild(createIntrinsicComponent('pricing', 'section', {}));
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  drawCanvas({ hero: rect(100, 50), pricing: rect(100, 300) });
  render(
    <TransformProvider>
      <NotifyHandle />
      <AgentPresenceLayer />
      <AgentPageDot pageId={page.id} />
      <AgentEditingNote />
    </TransformProvider>,
  );
});

afterEach(() => {
  presence().reset();
  store.editorUI.livePlans.reset();
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the frame', () => {
  it('frames the containing section 2px outside it, with the label pill, the page dot and the top bar note', () => {
    act(() => presence().applyActivity(activity()));
    const [frame] = frames();
    expect(frames()).toHaveLength(1);
    const box = frameBox(rect(100, 50));
    expect(box).toEqual({ x: 96, y: 46, width: 408, height: 208 });
    expect(frame.style.transform).toBe('translate(96px, 46px)');
    expect(frame.style.width).toBe('408px');
    expect(frame.style.height).toBe('208px');
    expect(frame.style.opacity).toBe('1');
    expect(frame.className).toContain('border-agent-presence');
    expect(frame.querySelector(`[${PRESENCE_LABEL_ATTR}]`)!.textContent).toBe('Claude · Editing');
    expect(document.querySelector('[data-agent-page-dot]')).not.toBeNull();
    expect(screen.getByText('Claude is editing this site')).toBeInTheDocument();
  });

  it('frames the skeleton of the announced section the agent is writing, labelled with its title, then the real section', () => {
    act(() =>
      store.editorUI.livePlans.applyState(
        [{ planId: 'p1', agentId: 'a1', label: 'Claude', pageId: page.id, sections: [{ ref: 'faq', title: 'Questions', kind: 'faq' }], expiresAt: '' }],
        1,
      ),
    );
    const skeleton = document.createElement('div');
    skeleton.setAttribute('data-live-skeleton', 'a1:faq');
    skeleton.getBoundingClientRect = () => rect(100, 600);
    document.querySelector('[data-viewport-id]')!.appendChild(skeleton);
    act(() => presence().applyActivity(activity({ nodeIds: [], sectionRef: 'faq' })));
    expect(frames()[0].style.transform).toBe('translate(96px, 596px)');
    expect(frames()[0].querySelector(`[${PRESENCE_LABEL_ATTR}]`)!.textContent).toBe('Claude · Writing Questions');
    // The batch committed and the copy holding the section was adopted: the frame moves to the real section.
    act(() => {
      store.editorUI.livePlans.applyUpdate({
        plan: { planId: 'p1', agentId: 'a1', label: 'Claude', pageId: page.id, sections: [{ ref: 'faq', title: 'Questions', kind: 'faq', fulfilledAt: 2, nodeId: 'pricing' }], expiresAt: '' },
        ended: 'fulfilled',
      });
      store.editorUI.livePlans.noteVersion(2);
      presence().applyActivity(activity({ phase: 'end', outcome: 'ok', nodeIds: ['pricing'], sectionRef: 'faq' }));
    });
    expect(frames()[0].style.transform).toBe('translate(96px, 296px)');
    expect(frames()[0].querySelector(`[${PRESENCE_LABEL_ATTR}]`)!.textContent).toBe('Claude · Editing');
  });

  it('moves to a new section with a 200ms ease-out, and follows pan and zoom without it', () => {
    act(() => presence().applyActivity(activity()));
    expect(frames()[0].style.transition).not.toContain('transform');
    act(() => presence().applyActivity(activity({ callId: 'c2', nodeIds: ['pricing'] })));
    const [frame] = frames();
    expect(frame.style.transform).toBe('translate(96px, 296px)');
    expect(frame.style.transition).toContain(`transform ${PRESENCE_MOVE_MS}ms ease-out`);
    vi.advanceTimersByTime(PRESENCE_MOVE_MS + 1);
    drawCanvas({ hero: rect(140, 90), pricing: rect(140, 340) });
    act(() => notify());
    expect(frames()[0].style.transform).toBe('translate(136px, 336px)');
    expect(frames()[0].style.transition).not.toContain('transform');
  });

  it('fades 4 s after the last call ended, at once after a refusal', () => {
    act(() => presence().applyActivity(activity()));
    act(() => presence().applyActivity(activity({ phase: 'end', outcome: 'ok' })));
    act(() => vi.advanceTimersByTime(AGENT_FRAME_LINGER_MS - 1));
    expect(frames()[0].style.opacity).toBe('1');
    act(() => vi.advanceTimersByTime(1));
    expect(frames()[0].style.opacity).toBe('0');
    expect(frames()[0].style.transition).toContain('opacity 200ms ease-out');
    expect(document.querySelector('[data-agent-page-dot]')).toBeNull();
    // Still editing between calls.
    expect(screen.getByText('Claude is editing this site')).toBeInTheDocument();

    act(() => presence().applyActivity(activity({ callId: 'c2' })));
    expect(frames()[0].style.opacity).toBe('1');
    act(() => presence().applyActivity(activity({ callId: 'c2', phase: 'end', outcome: 'site_changed' })));
    expect(frames()[0].style.opacity).toBe('0');
  });

  it('under reduced motion jumps and disappears without a transition', () => {
    reduced = true;
    act(() => presence().applyActivity(activity()));
    act(() => presence().applyActivity(activity({ phase: 'end', outcome: 'ok' })));
    act(() => presence().applyActivity(activity({ callId: 'c2', nodeIds: ['pricing'] })));
    expect(frames()[0].style.transform).toBe('translate(96px, 296px)');
    expect(frames()[0].style.transition).toBe('');
    act(() => presence().applyActivity(activity({ callId: 'c2', phase: 'end', outcome: 'failed' })));
    expect(frames()[0].style.opacity).toBe('0');
    expect(frames()[0].style.transition).toBe('');
  });

  it('drops the frame when the section it is keyed to is deleted', () => {
    act(() => presence().applyActivity(activity({ nodeIds: ['pricing'] })));
    expect(frames()).toHaveLength(1);
    act(() => (page.appComponentTree as ComponentInstance).removeChild('pricing'));
    expect(frames()).toHaveLength(0);
    expect(document.querySelector('[data-agent-page-dot]')).toBeNull();
  });

  it('a frame keyed to a deleted node comes back when a redo restores it', () => {
    act(() => presence().applyActivity(activity({ nodeIds: ['pricing'] })));
    const root = page.appComponentTree as ComponentInstance;
    act(() => root.removeChild('pricing'));
    expect(frames()).toHaveLength(0);
    act(() => root.addChild(createIntrinsicComponent('pricing', 'section', {})));
    expect(frames()).toHaveLength(1);
  });

  it('watches the size of the elements drawn now, also after the canvas replaced them', () => {
    const watched = new Set<Element>();
    class FakeResizeObserver {
      constructor(readonly callback: () => void) {}
      observe(el: Element) { watched.add(el); }
      unobserve(el: Element) { watched.delete(el); }
      disconnect() { watched.clear(); }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    cleanup();
    render(<TransformProvider><NotifyHandle /><AgentPresenceLayer /></TransformProvider>);
    act(() => presence().applyActivity(activity()));
    const first = document.querySelector('[data-inner-component-id="hero"]')!;
    expect(watched.has(first)).toBe(true);
    drawCanvas({ hero: rect(100, 60), pricing: rect(100, 300) });
    act(() => notify());
    const second = document.querySelector('[data-inner-component-id="hero"]')!;
    expect(watched.has(second)).toBe(true);
    expect(watched.has(first)).toBe(false);
  });

  it('redraws once for many reveals that end in the same frame, after reading every rect', async () => {
    act(() => presence().applyActivity(activity()));
    // Let the draw the new picture scheduled for its next frame run first.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    const hero = document.querySelector<HTMLElement>('[data-inner-component-id="hero"]')!;
    const read = vi.spyOn(hero, 'getBoundingClientRect');
    const reveal = () => {
      const e = new Event('animationend', { bubbles: true });
      Object.defineProperty(e, 'animationName', { value: REVEAL_KEYFRAMES });
      document.body.dispatchEvent(e);
    };
    for (let i = 0; i < 5; i += 1) reveal();
    expect(read).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    // One draw reads the element once.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('frames the page frames for a call that names the page and no node', () => {
    act(() => presence().applyActivity(activity({ tool: 'get_page', nodeIds: [] })));
    const [frame] = frames();
    expect(frame.style.transform).toBe('translate(-4px, -4px)');
    expect(frame.querySelector(`[${PRESENCE_LABEL_ATTR}]`)!.textContent).toBe('Claude · Reading');
  });

  it('draws nothing on this page for an agent working on another page, and no note once the agent left', () => {
    act(() => presence().applyActivity(activity({ pageId: 'elsewhere', nodeIds: [] })));
    expect(frames()).toHaveLength(0);
    act(() => presence().applyActivity(activity({ pageId: 'elsewhere', nodeIds: [], phase: 'end', outcome: 'ok' })));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText(/is editing this site/)).toBeNull();
  });
});

describe('the compact bar\'s editing note', () => {
  it('is a dot that carries the sentence for a tooltip and a screen reader, only while an agent is active', () => {
    cleanup();
    render(<AgentEditingNote compact />);
    expect(document.querySelector('[data-agent-editing-note]')).toBeNull();
    act(() => presence().applyActivity({ callId: 'c1', agentId: 'a1', label: 'Claude', tool: 'apply_batch', phase: 'start', at: new Date().toISOString() }));
    const note = document.querySelector('[data-agent-editing-note]')!;
    expect(note).toHaveAttribute('title', 'Claude is editing this site');
    expect(note).toHaveTextContent('Claude is editing this site');
  });
});

describe('the label pill stays in the visible canvas', () => {
  /** Editor chrome over the canvas: the top bar and the docked sidebars (EditorApp). */
  function chrome(parts: { topbar?: DOMRect; left?: DOMRect; right?: DOMRect; bottom?: DOMRect }) {
    if (parts.topbar) {
      const bar = document.createElement('header');
      bar.setAttribute('data-editor-topbar', 'true');
      bar.getBoundingClientRect = () => parts.topbar!;
      document.body.appendChild(bar);
    }
    for (const side of ['left', 'right', 'bottom'] as const) {
      const box = parts[side];
      if (!box) continue;
      const el = document.createElement('div');
      el.setAttribute(EDITOR_CHROME_ATTR, side);
      el.getBoundingClientRect = () => box;
      document.body.appendChild(el);
    }
  }
  const pill = () => frames()[0].querySelector<HTMLElement>(`[${PRESENCE_LABEL_ATTR}]`)!;

  it('sits above the frame\'s top left corner when that corner is in view', () => {
    act(() => presence().applyActivity(activity()));
    expect(pill().style.transform).toBe('translate(-2px, -22px)');
    expect(pill().style.visibility).toBe('');
  });

  it('a full-width section at 100% zoom: moves past the left sidebar and under the top bar', () => {
    chrome({ topbar: rect(0, 0, 1024, 64), left: rect(0, 64, 260, 704), right: rect(764, 64, 260, 704) });
    drawCanvas({ hero: rect(0, 80, 1024, 300), pricing: rect(0, 380, 1024, 300) });
    act(() => presence().applyActivity(activity()));
    const box = frameBox(rect(0, 80, 1024, 300));
    // x: just past the sidebar (260 + 8); y: no room above the frame under the top bar, so just inside its top edge.
    expect(pill().style.transform).toBe(`translate(${268 - box.x}px, ${box.y + 2 + 4 - box.y}px)`);
    // Pan so the frame's top goes under the top bar: the pill stays at the top of the visible canvas.
    drawCanvas({ hero: rect(0, -100, 1024, 400), pricing: rect(0, 300, 1024, 300) });
    act(() => notify());
    const panned = frameBox(rect(0, -100, 1024, 400));
    expect(pill().style.transform).toBe(`translate(${268 - panned.x}px, ${64 + 8 - panned.y}px)`);
  });

  it('is hidden with the frame when no part of the frame is in view, and comes back', () => {
    chrome({ left: rect(0, 64, 260, 704) });
    drawCanvas({ hero: rect(20, 100, 200, 100), pricing: rect(100, 300) });
    act(() => presence().applyActivity(activity()));
    expect(pill().style.visibility).toBe('hidden');
    drawCanvas({ hero: rect(300, 100, 200, 100), pricing: rect(100, 300) });
    act(() => notify());
    expect(pill().style.visibility).toBe('');
    expect(pill().style.transform).toBe('translate(-2px, -22px)');
  });

  it('pillPlacement: clamps into the visible rect, right edge included, and answers nothing off screen', () => {
    const visible = { left: 260, top: 64, right: 764, bottom: 768 };
    const size = { width: 120, height: 20 };
    // In view: the default spot.
    expect(pillPlacement({ x: 400, y: 200, width: 200, height: 100 }, visible, size)).toEqual({ left: -2, top: -22 });
    // Its left under the sidebar: past it.
    expect(pillPlacement({ x: 100, y: 200, width: 400, height: 100 }, visible, size)).toEqual({ left: 268 - 100, top: -22 });
    // Its left beyond the right sidebar's edge is impossible while visible; a frame ending near it keeps the pill inside.
    expect(pillPlacement({ x: 700, y: 200, width: 200, height: 100 }, visible, size)).toEqual({ left: 764 - 8 - 120 - 700, top: -22 });
    // Wholly under a sidebar, above the top bar, or below the screen: nothing.
    expect(pillPlacement({ x: 0, y: 200, width: 250, height: 100 }, visible, size)).toBeUndefined();
    expect(pillPlacement({ x: 400, y: 0, width: 100, height: 60 }, visible, size)).toBeUndefined();
    expect(pillPlacement({ x: 400, y: 800, width: 100, height: 60 }, visible, size)).toBeUndefined();
  });

  it('visibleCanvasRect: the window less the top bar, the docked sidebars and the bottom toolbar', () => {
    chrome({ topbar: rect(0, 0, 1024, 64), left: rect(0, 64, 260, 704), right: rect(764, 64, 260, 704) });
    expect(visibleCanvasRect()).toEqual({ left: 260, top: 64, right: 764, bottom: window.innerHeight });
    chrome({ bottom: rect(0, window.innerHeight - 56, 1024, 56) });
    expect(visibleCanvasRect().bottom).toBe(window.innerHeight - 56);
  });

  it('a thin sliver of a frame past the sidebar keeps its pill at the frame, not beyond it', () => {
    const visible = { left: 260, top: 64, right: 764, bottom: 768 };
    // The frame ends 40px past the sidebar: the pill cannot sit wholly inside it, so it stays at the visible edge.
    expect(pillPlacement({ x: 0, y: 200, width: 300, height: 100 }, visible, { width: 120, height: 20 })).toEqual({ left: 268, top: -22 });
    // A wider sliver: the pill ends at the frame's right edge at most.
    expect(pillPlacement({ x: 0, y: 200, width: 420, height: 100 }, visible, { width: 120, height: 20 })).toEqual({ left: 268, top: -22 });
    expect(pillPlacement({ x: 600, y: 200, width: 150, height: 100 }, visible, { width: 120, height: 20 })).toEqual({ left: -2, top: -22 });
  });

  it('a frame whose top is under the bottom toolbar keeps its pill above the toolbar', () => {
    const visible = { left: 0, top: 64, right: 1024, bottom: 712 };
    expect(pillPlacement({ x: 100, y: 710, width: 400, height: 300 }, visible, { width: 120, height: 20 })).toEqual({ left: -2, top: 712 - 8 - 20 - 710 });
  });
});
