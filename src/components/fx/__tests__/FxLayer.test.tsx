// The editor's FX layer (../FxLayer) on the canvas and in the preview, with the lazy
// mount stood in for (its own tests: src/lib/fxScene/__tests__/mount.test.tsx; the real
// engine: test/behaviour/fxCanvas.spec.ts). What is asked here: which element draws,
// when it starts, what it tells the panel, and that nothing is left behind.

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { FxClaim } from '@/lib/fxScene/claim';
import { fxFromPreset, setFxBackground, setFxCalm, setFxStart, type FxEdit } from '@/lib/fxScene/edit';
import { FX_PROP } from '@/lib/fxScene/marker';
import { FX_SETTLE_DELAY_MS } from '@/lib/fxScene/start';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

interface Drawn {
  layer: HTMLElement;
  stored: unknown;
  options: { onLive: () => void; onOff: (reason: string) => void; resolveImage?: (src: string) => string | null; layoutSize?: boolean };
  updates: unknown[];
  tornDown: boolean;
}
const drawn: Drawn[] = [];
const active = () => drawn.filter((d) => !d.tornDown);
let failImport = false;

vi.mock('@/lib/fxScene/mount', () => ({
  get renderFxScene() {
    if (failImport) throw new Error('chunk failed');
    return (layer: HTMLElement, stored: unknown, options: Drawn['options']) => {
      const entry: Drawn = { layer, stored, options, updates: [], tornDown: false };
      drawn.push(entry);
      return { update: (next: unknown) => entry.updates.push(next), teardown: () => void (entry.tornDown = true) };
    };
  },
}));

import ComponentRenderer from '@/components/ComponentRenderer';
import { FxCanvasLayer, FxPreviewContext, FxPreviewLayer } from '../FxLayer';

const ok = (edit: FxEdit) => {
  if (!edit.ok) throw new Error(edit.message);
  return edit.stored;
};
const PRESET = ok(fxFromPreset());
const IMMEDIATE = ok(setFxStart(PRESET, 'immediate'));

let reducedMotion = false;
let webgl = true;
const flush = () => act(async () => {});
const states = () => [...document.querySelectorAll('[data-fc-fx-layer]')].map((layer) => layer.getAttribute('data-fc-fx-state'));

beforeEach(() => {
  drawn.length = 0;
  failImport = false;
  reducedMotion = false;
  webgl = true;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('FX layer');
  const project = store.projectStore.findProjectByTitle('FX layer')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(project.findPageBySlug('')!);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reducedMotion && query.includes('reduce'), addEventListener: () => {}, removeEventListener: () => {} }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => (webgl ? { getExtension: () => null } : null)) as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('in the preview', () => {
  const Frame = ({ claim, children }: { claim: FxClaim; children: React.ReactNode }) => <FxPreviewContext.Provider value={claim}>{children}</FxPreviewContext.Provider>;
  const Box = ({ stored }: { stored: unknown }) => (
    <div data-box="">
      <FxPreviewLayer stored={stored} />
      <p>content</p>
    </div>
  );

  it('renders nothing outside a preview frame, and for a scene the reader refuses', async () => {
    render(<Box stored={IMMEDIATE} />);
    render(
      <Frame claim={new FxClaim()}>
        <Box stored={{ version: 99 }} />
      </Frame>,
    );
    await flush();
    expect(document.querySelectorAll('[data-fc-fx-layer]')).toHaveLength(0);
    expect(drawn).toHaveLength(0);
  });

  it('draws the first scene of the frame and keeps the second calm; when the first goes, the second draws', async () => {
    const claim = new FxClaim();
    const view = render(
      <Frame claim={claim}>
        <Box key="a" stored={IMMEDIATE} />
        <Box key="b" stored={IMMEDIATE} />
      </Frame>,
    );
    await flush();
    expect(active()).toHaveLength(1);
    expect(active()[0].layer).toBe(document.querySelectorAll('[data-fc-fx-layer]')[0]);
    act(() => active()[0].options.onLive());
    expect(states()).toEqual(['live', 'calm']);
    // The box holds the layer while it draws.
    expect((document.querySelectorAll('[data-box]')[0] as HTMLElement).style.isolation).toBe('isolate');
    expect((document.querySelectorAll('[data-box]')[1] as HTMLElement).style.isolation).toBe('');

    view.rerender(
      <Frame claim={claim}>
        <Box key="b" stored={IMMEDIATE} />
      </Frame>,
    );
    await flush();
    expect(drawn[0].tornDown).toBe(true);
    expect(active()).toHaveLength(1);
    expect(active()[0].layer).toBe(document.querySelector('[data-fc-fx-layer]'));
  });

  it('start settled: waits 1.5 seconds before the engine is fetched, and a frame that closes first fetches nothing', async () => {
    vi.useFakeTimers();
    const view = render(
      <Frame claim={new FxClaim()}>
        <Box stored={PRESET} />
      </Frame>,
    );
    await flush();
    expect(states()).toEqual(['waiting']);
    await act(async () => void vi.advanceTimersByTime(FX_SETTLE_DELAY_MS - 10));
    expect(drawn).toHaveLength(0);
    await act(async () => void vi.advanceTimersByTime(20));
    await flush();
    expect(drawn).toHaveLength(1);

    view.unmount();
    drawn.length = 0;
    const second = render(
      <Frame claim={new FxClaim()}>
        <Box stored={PRESET} />
      </Frame>,
    );
    await flush();
    second.unmount();
    await act(async () => void vi.advanceTimersByTime(FX_SETTLE_DELAY_MS * 2));
    expect(drawn).toHaveLength(0);
  });

  it('with reduced motion asked for: the background as calm state draws nothing, one still frame draws', async () => {
    reducedMotion = true;
    render(
      <Frame claim={new FxClaim()}>
        <Box stored={IMMEDIATE} />
      </Frame>,
    );
    await flush();
    expect(states()).toEqual(['calm']);
    expect(drawn).toHaveLength(0);
    cleanup();

    render(
      <Frame claim={new FxClaim()}>
        <Box stored={ok(setFxCalm(IMMEDIATE, 'frame'))} />
      </Frame>,
    );
    await flush();
    expect(drawn).toHaveLength(1);
  });

  it('without WebGL: nothing is fetched, the first scene is off with one warning, a second is calm', async () => {
    webgl = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <Frame claim={new FxClaim()}>
        <Box key="a" stored={IMMEDIATE} />
        <Box key="b" stored={IMMEDIATE} />
      </Frame>,
    );
    await flush();
    expect(states()).toEqual(['off', 'calm']);
    expect(drawn).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('the first scene holds the frame\'s one slot even when it stays calm: a second scene is not drawn in its place, as published', async () => {
    reducedMotion = true;
    render(
      <Frame claim={new FxClaim()}>
        <Box key="a" stored={IMMEDIATE} />
        <Box key="b" stored={ok(setFxCalm(IMMEDIATE, 'frame'))} />
      </Frame>,
    );
    await flush();
    expect(states()).toEqual(['calm', 'calm']);
    expect(drawn).toHaveLength(0);
  });

  it('when the engine does not arrive: off, with a warning, and nothing thrown', async () => {
    failImport = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <Frame claim={new FxClaim()}>
        <Box stored={IMMEDIATE} />
      </Frame>,
    );
    await flush();
    await flush();
    expect(states()).toEqual(['off']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('fetches pictures from the editor\'s own address for the open project', async () => {
    render(
      <Frame claim={new FxClaim()}>
        <Box stored={IMMEDIATE} />
      </Frame>,
    );
    await flush();
    const sha = 'c'.repeat(64);
    expect(drawn[0].options.resolveImage?.(`/site-images/${sha}.png`)).toBe(`/api/projects/${store.editorUI.currentProject!.id}/images/${sha}`);
    expect(drawn[0].options.resolveImage?.('https://elsewhere.test/a.png')).toBeNull();
    // The preview is not under a transform: the canvas is measured as on the published page.
    expect(drawn[0].options.layoutSize).toBeFalsy();
  });
});

describe('on the canvas', () => {
  const Box = ({ stored }: { stored: unknown }) => (
    <div data-box="">
      <FxCanvasLayer stored={stored} />
    </div>
  );

  it('one element draws however often the box is on the canvas, sized from the layout, and tells the panel', async () => {
    store.editorUI.startFxLive('box', null);
    const view = render(
      <>
        <Box key="a" stored={PRESET} />
        <Box key="b" stored={PRESET} />
      </>,
    );
    await flush();
    expect(active()).toHaveLength(1);
    expect(active()[0].options.layoutSize).toBe(true);
    expect(store.editorUI.fxLiveStatus).toEqual({ state: 'loading' });
    act(() => active()[0].options.onLive());
    expect(store.editorUI.fxLiveStatus).toEqual({ state: 'live' });
    expect(active()[0].layer.style.opacity).toBe('1');

    // The copy that drew goes away (a repeated row less): the other one takes over.
    view.rerender(
      <>
        <Box key="b" stored={PRESET} />
      </>,
    );
    await flush();
    expect(drawn[0].tornDown).toBe(true);
    expect(active()).toHaveLength(1);
  });

  it('a changed scene goes to the same drawing, never to a new one', async () => {
    store.editorUI.startFxLive('box', null);
    const view = render(<Box stored={PRESET} />);
    await flush();
    const next = ok(setFxBackground(PRESET, '#abcdef'));
    view.rerender(<Box stored={next} />);
    await flush();
    expect(drawn).toHaveLength(1);
    expect(drawn[0].updates.at(-1)).toBe(next);
    expect(drawn[0].tornDown).toBe(false);
  });

  it('a failure reaches the panel with its reason, and unmounting releases the claim', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.editorUI.startFxLive('box', null);
    const view = render(<Box stored={PRESET} />);
    await flush();
    act(() => active()[0].options.onOff('context-lost'));
    expect(store.editorUI.fxLiveStatus).toEqual({ state: 'off', reason: 'context-lost' });
    view.unmount();
    expect(drawn[0].tornDown).toBe(true);
    expect(store.editorUI.fxLiveClaim.taken).toBe(false);
  });
});

describe('the canvas renderer decides where Live draws', () => {
  function setup() {
    const page = store.editorUI.currentPage!;
    const box = page.insertRegistryComponent('fxScene', { kind: 'appTree' })! as ComponentInstance;
    const breakpoints = page.sortedViewportNodes.map((v) => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth ?? 0 }));
    const frames = (
      <>
        {breakpoints.map((b) => (
          <ComponentRenderer key={b.id} component={page.appComponentTree as ComponentInstance} breakpointId={b.id} allBreakpoints={breakpoints} />
        ))}
      </>
    );
    return { page, box, breakpoints, frames };
  }
  const layers = () => document.querySelectorAll('[data-fc-fx-layer]');

  it('nothing by default; with Live on, in the one frame it is on for; and the stored scene never becomes an attribute', async () => {
    const { box, breakpoints, frames } = setup();
    render(frames);
    await flush();
    expect(breakpoints.length).toBeGreaterThan(1);
    expect(layers()).toHaveLength(0);

    act(() => store.editorUI.startFxLive(box.id, breakpoints[1].id));
    await flush();
    expect(layers()).toHaveLength(1);
    expect(layers()[0].parentElement?.getAttribute('data-component-id')).toBe(`${breakpoints[1].id}-${box.id}`);
    expect(active()).toHaveLength(1);
    expect(layers()[0].parentElement?.hasAttribute(FX_PROP)).toBe(false);

    // Picked in another frame: the old drawing is released, the new frame draws.
    act(() => store.editorUI.selectComponent(box, breakpoints[0].id));
    await flush();
    expect(layers()).toHaveLength(1);
    expect(layers()[0].parentElement?.getAttribute('data-component-id')).toBe(`${breakpoints[0].id}-${box.id}`);
    expect(drawn[0].tornDown).toBe(true);
    expect(active()).toHaveLength(1);

    act(() => store.editorUI.stopFxLive());
    await flush();
    expect(layers()).toHaveLength(0);
    expect(active()).toHaveLength(0);
  });

  it('gives the context up under the preview over the editor, and takes it back', async () => {
    const { box, breakpoints, frames } = setup();
    render(frames);
    act(() => store.editorUI.startFxLive(box.id, breakpoints[0].id));
    await flush();
    act(() => store.editorUI.setPreviewOpen(true));
    await flush();
    expect(layers()).toHaveLength(0);
    expect(active()).toHaveLength(0);
    act(() => store.editorUI.setPreviewOpen(false));
    await flush();
    expect(active()).toHaveLength(1);
  });

  it('stands down while the box\'s own text is typed, so the text box cannot wipe a drawing', async () => {
    const { box, breakpoints, frames } = setup();
    act(() => box.setProps({ children: 'Typed here' }));
    render(frames);
    act(() => store.editorUI.startFxLive(box.id, breakpoints[0].id));
    await flush();
    expect(active()).toHaveLength(1);
    act(() => {
      store.editorUI.selectComponent(box, breakpoints[0].id);
      store.editorUI.beginTextEdit(box);
    });
    await flush();
    expect(layers()).toHaveLength(0);
    expect(active()).toHaveLength(0);
    act(() => store.editorUI.endTextEdit());
    await flush();
    expect(active()).toHaveLength(1);
  });

  it('another project starts with Live off', () => {
    const { box } = setup();
    store.editorUI.startFxLive(box.id, null);
    store.projectStore.createProject('Another');
    store.editorUI.setCurrentProject(store.projectStore.findProjectByTitle('Another')!);
    expect(store.editorUI.fxLive).toBeUndefined();
    expect(store.editorUI.fxLiveStatus).toEqual({ state: 'idle' });
  });
});
