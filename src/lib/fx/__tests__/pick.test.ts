// @vitest-environment node
// src/lib/fx/__tests__/pick.test.ts
//
// Picking a layer on the live canvas (../pick): which layer a point of the frame hits, which layers
// can never be hit, where the outline goes, and how a pointer is mapped when the canvas is scaled by
// a CSS transform (the editor's zoom). The scene is stood in for by real three.js planes at the
// depths the layers really use, under the real camera of the engine (position z 5, fov 50).

import { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, ShaderMaterial, Vector2 } from 'three';
import { describe, expect, it } from 'vitest';

import { containedImageRect, createPicker, pointerToNdc, positionAfterDrag, type SceneProbe } from '../pick';
import type { Layer } from '../types';

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
const probeOf = (entries: Entry[]): SceneProbe => ({ camera, canvas: {} as HTMLCanvasElement, layers: () => entries, invalidate: () => {} });

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
