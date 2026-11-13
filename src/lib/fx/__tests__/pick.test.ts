// @vitest-environment node
// src/lib/fx/__tests__/pick.test.ts
//
// Picking a layer on the live canvas (../pick): which layer a point of the frame hits, which layers
// can never be hit, where the outline goes, and how a pointer is mapped when the canvas is scaled by
// a CSS transform (the editor's zoom). The scene is stood in for by real three.js planes at the
// depths the layers really use, under the real camera of the engine (position z 5, fov 50).

import { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, ShaderMaterial, Vector2 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { containedImageRect, createPicker, pointerToNdc, positionAfterDrag, type SceneProbe } from '../pick';
import type { Layer } from '../types';


/**
 * Stands in for OffscreenCanvas, the scratch canvas the read-back draws a copy of a text canvas on. `drawImage` averages the
 * source's alpha over each block of source pixels (what a browser's downscale does), `getImageData` hands out the copy
 * through a Proxy that counts every pixel read, and the log says what was made and read. A source is a plain
 * object `{ width, height, __ink }` (alpha per pixel as RGBA bytes), or `{ __throw: true }` for a canvas that cannot be read.
 */
const scratch = { made: [] as [number, number][], drawn: 0, reads: 0, alphaReads: 0 };
class FakeScratch {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    scratch.made.push([width, height]);
  }
  getContext() {
    const { width: dw, height: dh } = this;
    const data = new Uint8ClampedArray(dw * dh * 4);
    return {
      drawImage: (src: { width: number; __ink?: Uint8ClampedArray; __throw?: boolean }, _sx: number, _sy: number, sw: number, sh: number) => {
        if (src.__throw) throw new Error('lost');
        scratch.drawn++;
        const ink = src.__ink!;
        const fx = Math.ceil(sw / dw);
        const fy = Math.ceil(sh / dh);
        for (let y = 0; y < dh; y++) {
          for (let x = 0; x < dw; x++) {
            let sum = 0;
            for (let by = 0; by < fy; by++) for (let bx = 0; bx < fx; bx++) sum += ink[((y * fy + by) * sw + x * fx + bx) * 4 + 3] ?? 0;
            data[(y * dw + x) * 4 + 3] = Math.round(sum / (fx * fy));
          }
        }
      },
      getImageData: () => {
        scratch.reads++;
        return {
          data: new Proxy(data, {
            get(target, prop, receiver) {
              if (typeof prop === 'string' && /^\d+$/.test(prop)) scratch.alphaReads++;
              return Reflect.get(target, prop, receiver);
            },
          }),
        };
      },
    };
  }
}
beforeEach(() => {
  scratch.made.length = 0;
  scratch.drawn = 0;
  scratch.reads = 0;
  scratch.alphaReads = 0;
  vi.stubGlobal('OffscreenCanvas', FakeScratch);
});
afterEach(() => vi.unstubAllGlobals());

const ASPECT = 1.6;
const camera = new PerspectiveCamera(50, ASPECT, 0.1, 100);
camera.position.set(0, 0, 5);
camera.updateMatrixWorld();
const worldHalfHeight = (z: number) => Math.tan((50 * Math.PI) / 360) * (5 - z);

type Params = Record<string, unknown>;
const layer = (id: string, type: string, params: Params = {}): Layer =>
  ({ id, type, name: id, visible: true, blend: 'normal', params: Object.fromEntries(Object.entries(params).map(([k, value]) => [k, { type: 'number', value }])) }) as unknown as Layer;

interface Entry {
  layer: Layer;
  root: Group;
}
const probeOf = (entries: Entry[]): SceneProbe => ({ camera, canvas: {} as HTMLCanvasElement, layers: () => entries });

/** A text plane (or any plain plane) at depth z. */
const plane = (l: Layer, width: number, height: number, z = 0): Entry => {
  const root = new Group();
  const mesh = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial());
  mesh.position.set(0, 0, z);
  root.add(mesh);
  return { layer: l, root };
};

// Not the schema's defaults on purpose: a soft edge (0.35 of the plane's half height) is part of what is drawn, and is tested on its own below.
const SHAPE_DEFAULTS = { shape: 0, size: 0.6, aspect: 1, radius: 0.18, softness: 0.02, wobble: 0 };
/** A shape layer drawn the way the engine draws it: a 26 by 16 quad at z -2.5 with the shape's uniforms. */
const shape = (id: string, values: Partial<typeof SHAPE_DEFAULTS> & { position?: [number, number]; mouse?: [number, number] } = {}): Entry => {
  const v = { ...SHAPE_DEFAULTS, ...values };
  const root = new Group();
  const mesh = new Mesh(
    new PlaneGeometry(26, 16),
    new ShaderMaterial({
      uniforms: {
        uShape: { value: v.shape },
        uPosition: { value: new Vector2(...(values.position ?? [0, 0])) },
        uSize: { value: v.size },
        uAspect: { value: v.aspect },
        uRadius: { value: v.radius },
        uSoftness: { value: v.softness },
        uWobble: { value: v.wobble },
        uMouse: { value: new Vector2(...(values.mouse ?? [0, 0])) },
        uPlaneAspect: { value: 26 / 16 },
      },
    }),
  );
  mesh.position.set(0, 0, -2.5);
  root.add(mesh);
  return { layer: layer(id, 'shape', v), root };
};

/** An image layer: a plane of 26 by 16 times its scale at z -2.6 with the fit and aspects the shader holds. */
const image = (id: string, fit: 0 | 1, imageAspect: number, scale = 1): Entry => {
  const root = new Group();
  const mesh = new Mesh(
    new PlaneGeometry(26 * scale, 16 * scale),
    new ShaderMaterial({ uniforms: { uFit: { value: fit }, uPlaneAspect: { value: 26 / 16 }, uImageAspect: { value: imageAspect } } }),
  );
  mesh.position.set(0, 0, -2.6);
  root.add(mesh);
  return { layer: layer(id, 'image', { scale }), root };
};

const pick = (entries: Entry[], x: number, y: number) => createPicker(probeOf(entries)).pickAt(x, y);

describe('which layer a point hits', () => {
  const frameWidthAt0 = 2 * worldHalfHeight(0) * ASPECT;

  it('a text under the point is picked, and a point beside it is a miss', () => {
    const text = plane(layer('text-1', 'text'), 4, 1);
    expect(pick([text], 0, 0)).toBe('text-1');
    expect(pick([text], 0.9, 0)).toBeNull();
    expect(pick([text], 0, 0.5)).toBeNull();
    // The plane's edge in the frame: 2 of 7.46 world units across, so ndc 0.54.
    expect(pick([text], (2 / frameWidthAt0) * 2 - 0.01, 0)).toBe('text-1');
  });

  it('the layer nearest to the camera wins, whatever the stored order: a text at z 0 is over a shape at z -2.5', () => {
    const text = plane(layer('text-1', 'text'), 4, 1);
    const orb = shape('orb', { size: 0.5 });
    expect(pick([text, orb], 0, 0)).toBe('text-1');
    expect(pick([orb, text], 0, 0)).toBe('text-1');
    // Beside the text the shape behind it is the hit.
    expect(pick([text, orb], 0.6, 0)).toBe('orb');
  });

  it('two layers at one depth: the later in the stored order wins', () => {
    const a = plane(layer('a', 'text'), 4, 1);
    const b = plane(layer('b', 'text'), 4, 1);
    expect(pick([a, b], 0, 0)).toBe('b');
    expect(pick([b, a], 0, 0)).toBe('a');
  });

  it('a layer behind a nearer one whose content the point misses is still picked', () => {
    const text = plane(layer('text-1', 'text'), 1, 0.3);
    const orb = shape('orb', { size: 0.4 });
    expect(pick([orb, text], 0.3, 0)).toBe('orb');
  });

  it('noiseFill and gradient fill the frame by nature and are never picked', () => {
    expect(pick([plane(layer('n', 'noiseFill'), 26, 16, -3)], 0, 0)).toBeNull();
    expect(pick([plane(layer('g', 'gradient'), 26, 16, -2.8)], 0.3, 0.3)).toBeNull();
  });

  it('a layer at no opacity is not there to be picked', () => {
    expect(pick([plane(layer('t', 'text', { opacity: 0 }), 4, 1)], 0, 0)).toBeNull();
    expect(pick([plane(layer('t', 'text', { opacity: 0.4 }), 4, 1)], 0, 0)).toBe('t');
  });

  it('a layer on a render channel of its own (a targeted effect) is picked like any other', () => {
    const text = plane(layer('text-1', 'text'), 4, 1);
    text.root.traverse((o) => o.layers.set(3));
    expect(pick([text], 0, 0)).toBe('text-1');
  });
});

describe('a text box', () => {
  it('is hit inside its text rectangle and not in the padding of its plane', () => {
    // A box of half the frame wide: the plane is wider than the text rectangle, by the padding on each side.
    const frameWidth = 2 * worldHalfHeight(0) * ASPECT;
    const box = plane(layer('box', 'textBox', { width: 0.5 }), frameWidth * 0.5 + 0.8, 1.4);
    expect(pick([box], 0, 0)).toBe('box');
    // Inside the plane (half of 0.5 frame + 0.4 padding) but outside the text rectangle (half of 0.5 frame).
    const insidePadding = ((frameWidth * 0.25 + 0.2) / frameWidth) * 2;
    expect(pick([box], insidePadding, 0)).toBeNull();
    expect(pick([box], 0.4, 0)).toBe('box');
  });
});

describe('a shape', () => {
  it('is hit inside its circle and not on the quad it is drawn on', () => {
    const orb = shape('orb', { size: 0.3 });
    expect(pick([orb], 0, 0)).toBe('orb');
    // The quad is 26 by 16: this point is on it, far outside the circle.
    expect(pick([orb], 0.5, 0.5)).toBeNull();
  });

  it('the schema\'s own defaults (size 0.6, soft edge 0.35) fill the frame with their feather: unbounded, never picked', () => {
    expect(pick([shape('orb', { size: 0.6, softness: 0.35 })], 0, 0)).toBeNull();
  });

  it('a hard-edged big circle is hit in the middle and not in the corners of the frame', () => {
    const orb = shape('orb', { size: 0.6 });
    expect(pick([orb], 0, 0)).toBe('orb');
    expect(pick([orb], 0.95, 0.9)).toBeNull();
  });

  it('the soft edge is part of what is there: it widens the area that is hit', () => {
    const hard = shape('orb', { size: 0.2, softness: 0.02 });
    const soft = shape('orb', { size: 0.2, softness: 0.3 });
    // 0.28 of the plane's half height (2.24 world) from the centre: outside the hard edge, inside the feather.
    const y = 2.24 / worldHalfHeight(-2.5);
    expect(pick([hard], 0, y)).toBeNull();
    expect(pick([soft], 0, y)).toBe('orb');
  });

  it('a shape whose content covers the frame on both axes is unbounded and never picked', () => {
    expect(pick([shape('orb', { size: 1 })], 0, 0)).toBeNull();
    expect(pick([shape('orb', { shape: 1, size: 1, aspect: 1.6 })], 0, 0)).toBeNull();
  });

  it('follows the pointer: the live pull moves where it can be hit', () => {
    const orb = shape('orb', { size: 0.2, mouse: [1, 0] });
    // The centre is pulled by 0.4 of the plane: 5.2 world units right, ndc 0.93.
    expect(pick([orb], 0.93, 0)).toBe('orb');
    expect(pick([orb], 0, 0)).toBeNull();
  });

  it('a rounded rectangle is hit in its corners where a circle of the same size is not', () => {
    const rect = shape('rect', { shape: 1, size: 0.3, aspect: 1, radius: 0 });
    const disc = shape('disc', { shape: 0, size: 0.3 });
    // Just inside the square's corner, outside the circle (world 0.28*8 = 2.2 on each axis at z -2.5).
    const x = (2.2 / (worldHalfHeight(-2.5) * ASPECT)) * 0.98;
    const y = (2.2 / worldHalfHeight(-2.5)) * 0.98;
    expect(pick([rect], x, y)).toBe('rect');
    expect(pick([disc], x, y)).toBeNull();
  });
});

/** A text layer's plane whose texture holds a canvas the lines were drawn on: ink rows at `rows`, from x0 to x1. */
const drawn = (l: Layer, width: number, height: number, canvas: { w: number; h: number; rows: [number, number][]; x0: number; x1: number }, z = 0): Entry => {
  const entry = plane(l, width, height, z);
  const data = new Uint8ClampedArray(canvas.w * canvas.h * 4);
  for (const [y0, y1] of canvas.rows) for (let y = y0; y < y1; y++) for (let x = canvas.x0; x < canvas.x1; x++) data[(y * canvas.w + x) * 4 + 3] = 255;
  const image = { width: canvas.w, height: canvas.h, __ink: data };
  const mesh = entry.root.children[0] as Mesh;
  (mesh.material as MeshBasicMaterial).map = { image, version: 1 } as never;
  return entry;
};

describe('text is hit where it was drawn', () => {
  // A 5 by 2.5 plane (the lockup's default) whose canvas is 1000 by 500 with one line of ink in the middle third, the middle fifth across.
  const lockup = () => drawn(layer('t', 'text'), 5, 2.5, { w: 1000, h: 500, rows: [[200, 300]], x0: 400, x1: 600 });
  const frameWidth0 = 2 * worldHalfHeight(0) * ASPECT;

  it('the ink is hit, and the transparent margins of the plane are the box\'s', () => {
    expect(pick([lockup()], 0, 0)).toBe('t');
    // Well inside the plane (2 of 2.5 world across, ndc about 0.5) and far from the ink: a miss.
    expect(pick([lockup()], (2 / frameWidth0) * 2, 0)).toBeNull();
    expect(pick([lockup()], 0, 0.45)).toBeNull();
  });

  it('a click just beside a line, or between letters, still counts', () => {
    // The ink is 1 world unit wide (200 of 1000 px over 5 units); a line is widened by 15 percent of its height (15 px, 0.075 units).
    expect(pick([lockup()], ((0.5 + 0.05) / frameWidth0) * 2, 0)).toBe('t');
    expect(pick([lockup()], ((0.5 + 0.2) / frameWidth0) * 2, 0)).toBeNull();
  });

  it('a plane that covers the whole frame (the largest lockup) is only hit on its ink', () => {
    const big = drawn(layer('t', 'text'), 12, 6.5, { w: 1000, h: 500, rows: [[225, 275]], x0: 450, x1: 550 });
    expect(pick([big], 0, 0)).toBe('t');
    expect(pick([big], 0.8, 0.7)).toBeNull();
    expect(pick([big], -0.8, -0.7)).toBeNull();
  });

  it('two lines are two targets: the gap between them is not', () => {
    const two = drawn(layer('t', 'text'), 5, 2.5, { w: 1000, h: 500, rows: [[100, 150], [350, 400]], x0: 300, x1: 700 });
    const worldPerPx = 2.5 / 500;
    const yAt = (px: number) => ((250 - px) * worldPerPx) / worldHalfHeight(0);
    expect(pick([two], 0, yAt(125))).toBe('t');
    expect(pick([two], 0, yAt(375))).toBe('t');
    expect(pick([two], 0, yAt(250))).toBeNull();
  });

  it('a text box is hit on its lines, not on its whole wrap width', () => {
    const box = drawn(layer('box', 'textBox', { width: 0.6 }), frameWidth0 * 0.6 + 0.8, 1.4, { w: 1000, h: 400, rows: [[150, 250]], x0: 450, x1: 550 });
    expect(pick([box], 0, 0)).toBe('box');
    // Inside the box's width (0.6 of the frame) but nowhere near the short line it holds.
    expect(pick([box], 0.4, 0)).toBeNull();
  });

  it('a canvas with no ink at all draws nothing to pick, and the outline has no bounds', () => {
    const blank = drawn(layer('t', 'text'), 5, 2.5, { w: 100, h: 50, rows: [], x0: 0, x1: 0 });
    expect(pick([blank], 0, 0)).toBeNull();
    expect(createPicker(probeOf([blank])).boundsOf('t', 800, 500)).toBeNull();
  });

  it('the outline follows the ink, not the plane', () => {
    const rect = createPicker(probeOf([lockup()])).boundsOf('t', 800, 500)!;
    // 200 px of ink plus 15 px of padding on each side, of a canvas 1000 px wide that is 5 world units across.
    expect(rect.width).toBeCloseTo(((5 * (200 + 30)) / 1000 / frameWidth0) * 800, 0);
  });

  it('a readable canvas is read once per texture and version', () => {
    const entry = lockup();
    const map = ((entry.root.children[0] as Mesh).material as MeshBasicMaterial).map as unknown as { version: number };
    const picker = createPicker(probeOf([entry]));
    picker.pickAt(0, 0);
    picker.pickAt(0.01, 0);
    picker.boundsOf('t', 800, 500);
    expect(scratch.drawn).toBe(1);
    // A redraw into the same canvas bumps the texture's version: it is read again, once.
    map.version = 2;
    picker.pickAt(0, 0);
    picker.boundsOf('t', 800, 500);
    expect(scratch.drawn).toBe(2);
  });

  it('a text plane that covers the frame and has no readable canvas is no target (the fallback is checked for cover too)', () => {
    // The largest lockup (9 by 5 at z 0 is more than the 7.5 by 4.7 the frame shows there) before its canvas exists.
    expect(pick([plane(layer('t', 'text'), 9, 5)], 0, 0)).toBeNull();
    expect(createPicker(probeOf([plane(layer('t', 'text'), 9, 5)])).boundsOf('t', 800, 500)).toBeNull();
    // The same plane smaller than the frame is a target on the whole plane.
    expect(pick([plane(layer('t', 'text'), 4, 1)], 0, 0)).toBe('t');
  });

  it('a canvas that cannot be read (the copy throws) falls back to the plane, with the cover check', () => {
    const throwing = (width: number, height: number) => {
      const entry = plane(layer('t', 'text'), width, height);
      ((entry.root.children[0] as Mesh).material as MeshBasicMaterial).map = { image: { width: 100, height: 50, __throw: true }, version: 1 } as never;
      return entry;
    };
    expect(pick([throwing(4, 1)], 0, 0)).toBe('t');
    expect(pick([throwing(9, 5)], 0, 0)).toBeNull();
  });

  it('reads a copy a quarter of the canvas on each axis, whole, and never the canvas itself: a sixteenth of the pixels', () => {
    createPicker(probeOf([lockup()])).pickAt(0, 0);
    // The canvas is 1000 by 500: its copy is 250 by 125, one read of it, one look at each pixel's alpha at most.
    expect(scratch.made).toEqual([[250, 125]]);
    expect(scratch.reads).toBe(1);
    expect(scratch.alphaReads).toBeGreaterThan(0);
    expect(scratch.alphaReads).toBeLessThanOrEqual(250 * 125);
    // Still the right bands: the lines of a known drawing are found, and the gap between two lines is not.
    const two = drawn(layer('t', 'text'), 5, 2.5, { w: 1000, h: 500, rows: [[100, 150], [350, 400]], x0: 300, x1: 700 });
    const picker = createPicker(probeOf([two]));
    const yAt = (px: number) => (((250 - px) * (2.5 / 500)) / worldHalfHeight(0));
    expect(picker.pickAt(0, yAt(125))).toBe('t');
    expect(picker.pickAt(0, yAt(375))).toBe('t');
    expect(picker.pickAt(0, yAt(250))).toBeNull();
  });

  it('a thin mark (a one pixel line of dots) survives the smaller copy and is a target', () => {
    // A single row of ink 1 px tall and 40 px wide, as a hyphen at the smallest size.
    const dash = drawn(layer('tb', 'textBox', { text: '--' }), 4, 1, { w: 1000, h: 500, rows: [[250, 251]], x0: 480, x1: 520 });
    expect(pick([dash], 0, 0)).toBe('tb');
  });

  it('text that left no ink at all (marks too thin to show) falls back to its rectangle, and a blank text is nothing to pick', () => {
    const blankInk = { w: 1000, h: 500, rows: [] as [number, number][], x0: 0, x1: 0 };
    const marks = drawn(layer('tb', 'textBox', { text: '...' }), 4, 1, blankInk);
    // The layer has text and the copy shows none: the text rectangle (no readable canvas path) is the target.
    expect(pick([marks], 0, 0)).toBe('tb');
    // The same for a lockup with a headline.
    const lockupLayer = { ...layer('t', 'text'), params: { headlineText: { type: 'string', value: 'Hi' } } } as unknown as Layer;
    expect(pick([drawn(lockupLayer, 4, 1, blankInk)], 0, 0)).toBe('t');
    // A text box with only blanks draws nothing and is not a target.
    expect(pick([drawn(layer('tb', 'textBox', { text: '  ' }), 4, 1, blankInk)], 0, 0)).toBeNull();
  });
});

describe('a blob', () => {
  it('is hit as the circle of its mean radius; its outline reaches the largest', () => {
    const calm = createPicker(probeOf([shape('b', { shape: 2, size: 0.2, wobble: 0 })])).boundsOf('b', 800, 500)!;
    const wobbly = createPicker(probeOf([shape('b', { shape: 2, size: 0.2, wobble: 0.5 })])).boundsOf('b', 800, 500)!;
    expect(wobbly.width).toBeGreaterThan(calm.width * 1.3);
    expect(pick([shape('b', { shape: 2, size: 0.2, wobble: 0.5 })], 0, 0)).toBe('b');
  });
});

describe('an image', () => {
  it('under cover it fills the frame and is never picked', () => {
    expect(pick([image('img', 0, 1.5, 0.3)], 0, 0)).toBeNull();
  });

  it('under contain it is hit inside the fitted picture, not on the rest of its plane', () => {
    // A small plane (scale 0.3) holding a square picture: the picture is narrower than the plane.
    const img = image('img', 1, 1, 0.3);
    expect(pick([img], 0, 0)).toBe('img');
    const half = (n: number, z: number) => n / (worldHalfHeight(z) * ASPECT);
    // The plane is +-3.9 world wide, the picture +-2.4: 3.4 is on the plane, outside the picture.
    expect(pick([img], half(3.4, -2.6), 0)).toBeNull();
    expect(pick([img], half(2.0, -2.6), 0)).toBe('img');
  });

  it('a contained picture bigger than the frame on both axes is unbounded', () => {
    expect(pick([image('img', 1, 26 / 16, 1)], 0, 0)).toBeNull();
  });

  it('the fitted rectangle of a contained picture', () => {
    expect(containedImageRect(26 / 16, 26 / 16)).toEqual([0, 0, 1, 1]);
    const wide = containedImageRect(1, 2);
    expect(wide[0]).toBe(0);
    expect(wide[2]).toBe(1);
    expect(wide[1]).toBeCloseTo(0.25);
    expect(wide[3]).toBeCloseTo(0.75);
    const tall = containedImageRect(2, 1);
    expect(tall[0]).toBeCloseTo(0.25);
    expect(tall[2]).toBeCloseTo(0.75);
  });
});

describe('the outline of a layer', () => {
  it('is the projected bounds of its content in the canvas\'s layout pixels', () => {
    const frameWidth = 2 * worldHalfHeight(0) * ASPECT;
    const text = plane(layer('t', 'text'), 4, 1);
    const rect = createPicker(probeOf([text])).boundsOf('t', 800, 500)!;
    expect(rect.width).toBeCloseTo((4 / frameWidth) * 800, 0);
    expect(rect.height).toBeCloseTo((1 / (2 * worldHalfHeight(0))) * 500, 0);
    expect(rect.left + rect.width / 2).toBeCloseTo(400, 0);
    expect(rect.top + rect.height / 2).toBeCloseTo(250, 0);
  });

  it('is null for a layer that is gone, not pickable, or unbounded', () => {
    const picker = createPicker(probeOf([plane(layer('g', 'gradient'), 26, 16, -3), shape('big', { size: 1 })]));
    expect(picker.boundsOf('missing', 800, 500)).toBeNull();
    expect(picker.boundsOf('g', 800, 500)).toBeNull();
    expect(picker.boundsOf('big', 800, 500)).toBeNull();
  });

  it('follows a shape as the pointer pulls it', () => {
    const still = createPicker(probeOf([shape('orb', { size: 0.2 })])).boundsOf('orb', 800, 500)!;
    const pulled = createPicker(probeOf([shape('orb', { size: 0.2, mouse: [1, 0] })])).boundsOf('orb', 800, 500)!;
    expect(pulled.left).toBeGreaterThan(still.left + 300);
  });
});

describe('the pointer on a canvas scaled by a CSS transform (60 percent zoom)', () => {
  const layout = { width: 800, height: 500 };

  it('maps through the layout size, not the rectangle on screen', () => {
    // The box is drawn at 60 percent: its rectangle on screen is 480 wide, its layout 800.
    const rect = { left: 100, top: 50, width: 480 };
    expect(pointerToNdc({ x: 100 + 240, y: 50 + 150 }, rect, layout)).toEqual({ x: 0, y: 0 });
    expect(pointerToNdc({ x: 100 + 480, y: 50 }, rect, layout)).toEqual({ x: 1, y: 1 });
    const quarter = pointerToNdc({ x: 100 + 120, y: 50 + 225 }, rect, layout)!;
    expect(quarter.x).toBeCloseTo(-0.5);
    expect(quarter.y).toBeCloseTo(-0.5);
  });

  it('a click at 60 percent picks what the same click picks at full size', () => {
    const text = plane(layer('t', 'text'), 4, 1);
    const picker = createPicker(probeOf([text]));
    const at = (scale: number, fx: number, fy: number) => {
      const rect = { left: 40, top: 20, width: layout.width * scale };
      const ndc = pointerToNdc({ x: rect.left + fx * layout.width * scale, y: rect.top + fy * layout.height * scale }, rect, layout)!;
      return picker.pickAt(ndc.x, ndc.y);
    };
    for (const scale of [1, 0.6, 0.25]) {
      expect(at(scale, 0.5, 0.5)).toBe('t');
      expect(at(scale, 0.95, 0.5)).toBeNull();
    }
  });

  it('refuses a canvas with no size', () => {
    expect(pointerToNdc({ x: 1, y: 1 }, { left: 0, top: 0, width: 0 }, layout)).toBeNull();
    expect(pointerToNdc({ x: 1, y: 1 }, { left: 0, top: 0, width: 10 }, { width: 0, height: 5 })).toBeNull();
  });
});

describe('the position of a dragged text box', () => {
  const layout = { width: 800, height: 500 };

  it('moves by the travel as a share of the layout size', () => {
    expect(positionAfterDrag([0.5, 0.5], { dx: 80, dy: -50 }, 1, layout)).toEqual([0.6, 0.4]);
  });

  it('at 60 percent zoom the screen travel is divided by the scale, so the text keeps up with the pointer', () => {
    const [x, y] = positionAfterDrag([0.5, 0.5], { dx: 48, dy: 30 }, 0.6, layout);
    expect(x).toBeCloseTo(0.6);
    expect(y).toBeCloseTo(0.6);
  });

  it('stays inside the box', () => {
    expect(positionAfterDrag([0.95, 0.05], { dx: 400, dy: -400 }, 1, layout)).toEqual([1, 0]);
  });
});
