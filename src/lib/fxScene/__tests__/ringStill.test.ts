// The published page's first still of a particle ring (../ringStill): which scenes get one, what it asks of
// WebGL (one short-lived context, released before the call returns, at the live canvas's pixel ratio), where
// it sits in the box, and how it leaves (under the live layer until its fade is over, at once on teardown).
// The pixels themselves are proven against the live ring in a real browser (test/behaviour/fxRingStill.spec.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESETS, serializeScene, type StoredFx } from '@/lib/fx/format';
import { RING_START_TIME } from '@/lib/fx/ring';
import { FX_FADE_MS } from '../box';
import { drawRingStill, ringStillSpecOf, showFxRingStill, type RingStillSpec } from '../ringStill';

const ringScene = () => serializeScene(PRESETS.find((p) => p.id === 'lumitra-light')!.load());
const stored = (scene = ringScene()): StoredFx => ({ version: 1, scene, start: 'settled', calm: 'frame' }) as StoredFx;
const SPEC: RingStillSpec = { background: '#04090b', dpr: [1, 1.75], glow: 1, density: 1, seed: 1 };

describe('ringStillSpecOf', () => {
  it('reads the brand ring: its background, its pixel ratio range and its values', () => {
    expect(ringStillSpecOf(stored())).toEqual({ background: '#04090b', dpr: [1, 1.75], glow: 1, density: 1, seed: 1 });
  });

  it('a hidden second layer does not count; a visible one, a post pass, animation or a target does', () => {
    const extra = { id: 'v', type: 'vignette', name: 'Vignette', visible: true, blend: 'normal' as const, params: { offset: 0.3, darkness: 0.6 } };
    const withHidden = ringScene();
    withHidden.layers.push({ ...extra, visible: false });
    expect(ringStillSpecOf(stored(withHidden))).not.toBeNull();

    const withPost = ringScene();
    withPost.layers.push(extra);
    expect(ringStillSpecOf(stored(withPost))).toBeNull();

    const animated = ringScene();
    animated.layers[0].animate = { glow: { mode: 'sine', from: 0, to: 2, period: 4 } } as never;
    expect(ringStillSpecOf(stored(animated))).toBeNull();

    const targeted = ringScene();
    targeted.layers[0].target = 'x';
    expect(ringStillSpecOf(stored(targeted))).toBeNull();
  });

  it('a scene without a ring, or with its ring hidden, gets none', () => {
    const hidden = ringScene();
    hidden.layers[0].visible = false;
    expect(ringStillSpecOf(stored(hidden))).toBeNull();
    const other = serializeScene(PRESETS.find((p) => p.id === 'noise-gradient')!.load());
    expect(ringStillSpecOf(stored(other))).toBeNull();
  });
});

/** A WebGL2 context that records what is asked of it. */
function fakeGl() {
  const calls: string[] = [];
  const uniforms: Record<string, unknown[]> = {};
  const lose = vi.fn();
  const gl = new Proxy(
    {
      VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, COLOR_BUFFER_BIT: 8, BLEND: 9, ONE: 10, POINTS: 11,
      getShaderParameter: () => true,
      getProgramParameter: () => true,
      getUniformLocation: (_p: unknown, name: string) => name,
      getAttribLocation: () => 0,
      getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: lose } : null),
      uniform1f: (name: string, v: number) => { uniforms[name] = [v]; },
      uniform2f: (name: string, a: number, b: number) => { uniforms[name] = [a, b]; },
      viewport: (...args: number[]) => calls.push(`viewport ${args.join(' ')}`),
      drawArrays: (_mode: number, _first: number, count: number) => calls.push(`draw ${count} glow=${uniforms.glow?.[0]}`),
      shaderSource: (_s: unknown, source: string) => calls.push(`source ${source.split('\n')[0]}`),
    } as Record<string, unknown>,
    { get: (target, key: string) => (key in target ? target[key] : () => ({})) },
  );
  return { gl, calls, uniforms, lose };
}

describe('drawing the still', () => {
  let fake: ReturnType<typeof fakeGl>;
  let drawImage: ReturnType<typeof vi.fn>;
  let ratio: number;
  beforeEach(() => {
    vi.useFakeTimers();
    fake = fakeGl();
    drawImage = vi.fn();
    ratio = 2;
    vi.spyOn(window, 'devicePixelRatio', 'get').mockImplementation(() => ratio);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string) {
      if (kind === 'webgl2') return fake.gl as unknown as WebGL2RenderingContext;
      if (kind === '2d') return { drawImage, fillStyle: '#04090b' } as unknown as CanvasRenderingContext2D;
      return null;
    } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('draws the frame the engine starts on, with the glow pass first, and releases its context', () => {
    const into = document.createElement('canvas');
    expect(drawRingStill(into, SPEC, 960, 540, 1.75)).toBe(true);
    // The canvas rounds down: 960 x 1.75 = 1680, 540 x 1.75 = 945.
    expect([into.width, into.height]).toEqual([1680, 945]);
    expect(fake.calls).toContain('viewport 0 0 1680 945');
    expect(fake.calls.filter((c) => c.startsWith('source')).every((c) => c === 'source #version 300 es')).toBe(true);
    expect(fake.calls.filter((c) => c.startsWith('draw'))).toEqual(['draw 91200 glow=1', 'draw 91200 glow=0']);
    expect(fake.uniforms.t).toEqual([RING_START_TIME]);
    expect(fake.uniforms.ptr).toEqual([0, 0]);
    expect(fake.uniforms.R).toEqual([Math.min(960 * 0.37, 540 * 0.47)]);
    expect(fake.uniforms.dpr).toEqual([1.75]);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(fake.lose).toHaveBeenCalledTimes(1);
  });

  it('asks for a context the browser may refuse when it would draw slowly', () => {
    drawRingStill(document.createElement('canvas'), SPEC, 960, 540, 1);
    const options = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls.find(([kind]) => kind === 'webgl2')![1] as WebGLContextAttributes;
    expect(options.failIfMajorPerformanceCaveat).toBe(true);
  });

  it.each(['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Microsoft Basic Render Driver'])(
    'a software renderer (%s) draws nothing, and the context is released',
    (renderer) => {
      (fake.gl as unknown as { getParameter: () => string }).getParameter = () => renderer;
      expect(drawRingStill(document.createElement('canvas'), SPEC, 960, 540, 1)).toBe(false);
      expect(fake.calls.some((c) => c.startsWith('draw'))).toBe(false);
      expect(drawImage).not.toHaveBeenCalled();
      expect(fake.lose).toHaveBeenCalledTimes(1);
    },
  );

  it('a graphics card draws it', () => {
    (fake.gl as unknown as { getParameter: () => string }).getParameter = () => 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)';
    expect(drawRingStill(document.createElement('canvas'), SPEC, 960, 540, 1)).toBe(true);
  });

  it('no WebGL 2 draws nothing and says so', () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => null);
    expect(drawRingStill(document.createElement('canvas'), SPEC, 960, 540, 1)).toBe(false);
  });

  it('a shader that does not compile draws nothing, and the context is still released', () => {
    (fake.gl as unknown as { getShaderParameter: () => boolean }).getShaderParameter = () => false;
    expect(drawRingStill(document.createElement('canvas'), SPEC, 960, 540, 1)).toBe(false);
    expect(drawImage).not.toHaveBeenCalled();
    expect(fake.lose).toHaveBeenCalledTimes(1);
  });

  const boxOf = (width: number, height: number) => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
    return box;
  };

  it('shows it behind the content and behind the live layer, hidden from assistive technology, at the live ratio', () => {
    const box = boxOf(1440, 800);
    const still = showFxRingStill(box, SPEC);
    expect(still).not.toBeNull();
    const canvas = box.querySelector<HTMLCanvasElement>('[data-fc-fx-ring-still]')!;
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    expect(canvas.style.zIndex).toBe('-2');
    expect(canvas.style.pointerEvents).toBe('none');
    expect(canvas.style.opacity).toBe('1');
    // Held: a stacking context and a position for the box.
    expect(box.style.isolation).toBe('isolate');
    // The device's ratio 2 kept inside the scene's range: 1.75.
    expect([canvas.width, canvas.height]).toEqual([2520, 1400]);
  });

  it('on a touch device it draws at a ratio of 1, as the live scene starts there', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes('pointer: coarse'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      const box = boxOf(390, 700);
      showFxRingStill(box, SPEC);
      const canvas = box.querySelector<HTMLCanvasElement>('[data-fc-fx-ring-still]')!;
      expect([canvas.width, canvas.height]).toEqual([390, 700]);
    } finally {
      window.matchMedia = original;
    }
  });

  /** The live layer, in the box like the engine's, at `opacity`. */
  const layerIn = (box: HTMLElement, opacity: string) => {
    const layer = document.createElement('div');
    layer.style.opacity = opacity;
    box.appendChild(layer);
    return layer;
  };
  const stillIn = (box: HTMLElement) => box.querySelector('[data-fc-fx-ring-still]');
  /** One animation frame (the fake clock runs requestAnimationFrame at 16 ms). */
  const frames = (count: number) => vi.advanceTimersByTime(16 * count);

  it('after the live scene it stays until the live layer reads fully opaque on two frames, then gives the box back', () => {
    const box = boxOf(1440, 800);
    const still = showFxRingStill(box, SPEC)!;
    const layer = layerIn(box, '0');
    still.remove({ under: layer });
    frames(3);
    layer.style.opacity = '0.6';
    frames(3);
    expect(stillIn(box)).not.toBeNull();
    layer.style.opacity = '1';
    frames(1);
    expect(stillIn(box)).not.toBeNull();
    frames(1);
    expect(stillIn(box)).toBeNull();
    expect(box.style.isolation).toBe('');
  });

  it('two frames in a row: one opaque frame between translucent ones does not take it away', () => {
    const box = boxOf(1440, 800);
    const still = showFxRingStill(box, SPEC)!;
    const layer = layerIn(box, '1');
    still.remove({ under: layer });
    frames(1);
    layer.style.opacity = '0.9';
    frames(1);
    layer.style.opacity = '1';
    frames(1);
    expect(stillIn(box)).not.toBeNull();
    frames(1);
    expect(stillIn(box)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a set-up that holds the main thread longer than the fade does not take it away before the fade has run', () => {
    // The engine's first frame came, and its set-up then held the page for longer than the fade: on the first
    // frame after that, the layer's fade has only just begun. A clock started at the first frame had run out.
    const box = boxOf(1440, 800);
    const still = showFxRingStill(box, SPEC)!;
    const layer = layerIn(box, '0');
    still.remove({ under: layer });
    vi.advanceTimersByTime(FX_FADE_MS * 3);
    layer.style.opacity = '0.09';
    frames(1);
    expect(stillIn(box)).not.toBeNull();
    layer.style.opacity = '1';
    frames(2);
    expect(stillIn(box)).toBeNull();
  });

  it('stays as the picture when the live layer leaves before it is opaque (the engine stopped), until removed', () => {
    const box = boxOf(1440, 800);
    const still = showFxRingStill(box, SPEC)!;
    const layer = layerIn(box, '0.3');
    still.remove({ under: layer });
    frames(1);
    layer.remove();
    frames(10);
    expect(stillIn(box)).not.toBeNull();
    // And it stops watching: no frame callback left running for a layer that is gone.
    expect(vi.getTimerCount()).toBe(0);
    expect(box.style.isolation).toBe('isolate');
    still.remove();
    expect(stillIn(box)).toBeNull();
    expect(box.style.isolation).toBe('');
  });

  it('a page put away during that fade removes it at once', () => {
    const box = boxOf(1440, 800);
    const still = showFxRingStill(box, SPEC)!;
    const layer = layerIn(box, '0.5');
    still.remove({ under: layer });
    still.remove();
    expect(stillIn(box)).toBeNull();
    expect(box.style.isolation).toBe('');
    layer.style.opacity = '1';
    frames(5);
    expect(box.style.isolation).toBe('');
  });

  it('a box with no size, or no WebGL 2, shows nothing and leaves the box as it was', () => {
    const empty = boxOf(0, 0);
    expect(showFxRingStill(empty, SPEC)).toBeNull();
    expect(empty.children).toHaveLength(0);
    expect(empty.style.cssText).toBe('');
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => null);
    const box = boxOf(1440, 800);
    expect(showFxRingStill(box, SPEC)).toBeNull();
    expect(box.children).toHaveLength(0);
  });

  it('a resize already asked for is dropped once the live scene is up: no second context during the fade', () => {
    let observed: (() => void) | undefined;
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        observed = callback;
      }
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const box = boxOf(1440, 800);
      const still = showFxRingStill(box, SPEC)!;
      const contexts = () => vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls.filter(([kind]) => kind === 'webgl2').length;
      const before = contexts();
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(() => ({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
      observed!();
      still.remove({ under: layerIn(box, '0') });
      vi.advanceTimersByTime(100);
      expect(contexts()).toBe(before);
      // Without the live scene the same resize draws again.
      const other = showFxRingStill(boxOf(1440, 800), SPEC)!;
      const ready = contexts();
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(() => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
      observed!();
      vi.advanceTimersByTime(100);
      expect(contexts()).toBe(ready + 1);
      other.remove();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  /** The resolution queries asked for, each with the listeners still on it. */
  const withResolutionQueries = (run: (queries: { media: string; listeners: Set<() => void> }[]) => void) => {
    const original = window.matchMedia;
    const queries: { media: string; listeners: Set<() => void> }[] = [];
    window.matchMedia = ((media: string) => {
      const listeners = new Set<() => void>();
      if (media.includes('resolution')) queries.push({ media, listeners });
      return { matches: false, media, addEventListener: (_: string, l: () => void) => listeners.add(l), removeEventListener: (_: string, l: () => void) => listeners.delete(l) };
    }) as unknown as typeof window.matchMedia;
    try {
      run(queries);
    } finally {
      window.matchMedia = original;
    }
  };
  const listening = (queries: { listeners: Set<() => void> }[]) => queries.reduce((sum, q) => sum + q.listeners.size, 0);
  const change = (query: { listeners: Set<() => void> }) => [...query.listeners].forEach((l) => l());

  it('a change of the device pixel ratio alone draws it again at the new ratio, each time', () => {
    withResolutionQueries((queries) => {
      ratio = 1;
      const box = boxOf(1440, 800);
      const still = showFxRingStill(box, SPEC)!;
      const canvas = box.querySelector<HTMLCanvasElement>('[data-fc-fx-ring-still]')!;
      expect([canvas.width, canvas.height]).toEqual([1440, 800]);
      ratio = 1.75;
      change(queries[0]);
      frames(1);
      expect([canvas.width, canvas.height]).toEqual([2520, 1400]);
      expect(fake.uniforms.dpr).toEqual([1.75]);
      // Asked again for the new ratio, so the way back is heard too.
      expect(queries.map((q) => q.media)).toEqual(['(resolution: 1dppx)', '(resolution: 1.75dppx)']);
      expect(listening(queries)).toBe(1);
      ratio = 1.25;
      change(queries[1]);
      frames(1);
      expect([canvas.width, canvas.height]).toEqual([1800, 1000]);
      still.remove();
      expect(listening(queries)).toBe(0);
    });
  });

  it('a ratio change redraws at the new ratio and the current size; once the live scene is up, no ratio is watched', () => {
    withResolutionQueries((queries) => {
      ratio = 1;
      const box = boxOf(1440, 800);
      const still = showFxRingStill(box, SPEC)!;
      ratio = 1.5;
      change(queries[0]);
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(() => ({ width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
      frames(1);
      const canvas = box.querySelector<HTMLCanvasElement>('[data-fc-fx-ring-still]')!;
      expect([canvas.width, canvas.height]).toEqual([1500, 900]);
      still.remove({ under: layerIn(box, '0') });
      expect(listening(queries)).toBe(0);
      still.remove();
    });
  });
});
// ci-replay touch
