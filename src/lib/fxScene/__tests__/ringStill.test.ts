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

  it('after the live scene it stays until the live layer is fully opaque, then gives the box back', () => {
    const box = boxOf(1440, 800);
    const still = showFxRingStill(box, SPEC)!;
    still.remove({ afterLive: true });
    vi.advanceTimersByTime(FX_FADE_MS - 1);
    expect(box.querySelector('[data-fc-fx-ring-still]')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(box.querySelector('[data-fc-fx-ring-still]')).toBeNull();
    expect(box.style.isolation).toBe('');
  });

  it('a page put away during that fade removes it at once', () => {
    const box = boxOf(1440, 800);
    const still = showFxRingStill(box, SPEC)!;
    still.remove({ afterLive: true });
    still.remove();
    expect(box.querySelector('[data-fc-fx-ring-still]')).toBeNull();
    expect(box.style.isolation).toBe('');
    vi.advanceTimersByTime(FX_FADE_MS * 2);
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
});
