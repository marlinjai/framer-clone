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

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import AgentPresenceLayer, { PRESENCE_FRAME_ATTR, PRESENCE_LABEL_ATTR, PRESENCE_MOVE_MS, frameBox } from '../AgentPresenceLayer';
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
