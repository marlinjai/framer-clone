/**
 * Picking a layer on the live canvas: the EDITOR-ONLY entry (`@/lib/fx/pick`).
 *
 * Everything the editor needs to answer "which content layer is under this point" and "where is
 * the picked layer on the canvas" lives here and nowhere in the engine proper. The engine hands
 * out a `SceneProbe` (the camera, the canvas and the drawn layers with their identity groups, see
 * `onProbe` in ./LumitraScene), and this file does the rest. It is not re-exported by `./index`
 * or `./format`, and its only importer is the editor's canvas layer, which loads it by a dynamic
 * import of its own, so a published page's island (which reaches the engine through the lazy
 * mount chunk) never carries it. `src/lib/fx/__tests__/importGraph.test.ts` pins that.
 *
 * Which layers can be picked. Only layers with a bounded extent on the canvas:
 *  - `text` and `textBox`: the lines as drawn. The layer draws its text into a canvas texture, so
 *    the drawn pixels are read back once per texture (rows with ink make a line, each line is its
 *    ink's extent) and a click must land on a line (a little wider than its ink, so a click between
 *    two letters still counts). Without a readable canvas (nothing drawn yet) the plane (`text`) or
 *    the text rectangle (`textBox`) stands in.
 *  - `shape`: the extent of its shape (the quad it is drawn on is 26 by 16 and is no target),
 *    including the pointer's pull on it.
 *  - `image`: under `contain`, the fitted picture. `cover` fills the frame.
 * A layer whose content covers the visible frame on both axes is unbounded and never
 * picked, as `noiseFill` and `gradient` (they fill the frame by nature) are never picked. A click
 * on any of these falls through to the box.
 *
 * Known limits, stated rather than hidden: the box is read as an unrotated, uniformly scaled
 * rectangle (the editor's zoom is a CSS scale; a CSS rotation of the box itself would shift the
 * mapping), and a blob is hit as the circle of its mean radius (its edge wobbles with noise
 * over time) while its outline uses the largest radius. `SceneProbe` has no `invalidate`: nothing
 * here asks for a frame, the outline is HTML and moves on its own animation-frame loop.
 *
 * Which layer wins: the nearest to the camera along the ray (the scene draws see-through layers
 * back to front by depth, so a text at z 0 is over a shape at z -2.5 whatever their stored
 * order), the later one in the stored order on a tie.
 */

import { Raycaster, Vector2, Vector3, type Camera, type Mesh, type Object3D, type PerspectiveCamera } from "three";

import type { SceneProbe } from "./LumitraScene";
import type { Layer } from "./types";

export type { SceneProbe };

/** The layer kinds that can be picked on the canvas (when their content is bounded). */
export const PICKABLE_KINDS: readonly string[] = ["text", "textBox", "image", "shape"];

/** Only a text box can be dragged on the canvas. */
export const DRAGGABLE_KIND = "textBox";

/** A content that spans this much of the visible frame on an axis counts as covering it. */
const FRAME_COVER = 0.98;

/** The quad shape and image layers are drawn on (world units), see layers/shape.tsx and layers/image.tsx. */
const FALLBACK_PLANE_ASPECT = 26 / 16;

/** A rectangle in a plane's uv space: u0, v0 (bottom left) to u1, v1. */
type UvRect = readonly [number, number, number, number];

interface Region {
  /** The plane the region is on. */
  mesh: Mesh;
  /** Its bounding rectangle in the plane's uv space. */
  rect: UvRect;
  contains: (u: number, v: number) => boolean;
}

const inRect = (rect: UvRect) => (u: number, v: number) => u >= rect[0] && u <= rect[2] && v >= rect[1] && v <= rect[3];

function num(layer: Layer, key: string, fallback: number): number {
  const value = layer.params[key]?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(layer: Layer, key: string, fallback: string): string {
  const value = layer.params[key]?.value;
  return typeof value === "string" ? value : fallback;
}

function firstMesh(root: Object3D): Mesh | null {
  let found: Mesh | null = null;
  root.traverse((o) => {
    if (!found && (o as Mesh).isMesh) found = o as Mesh;
  });
  return found;
}

function planeSize(mesh: Mesh): { width: number; height: number } | null {
  const p = (mesh.geometry as { parameters?: { width?: number; height?: number } }).parameters;
  return p && typeof p.width === "number" && typeof p.height === "number" ? { width: p.width, height: p.height } : null;
}

/** A uniform's current value, or undefined (the material is not the shader this expects). */
function uniform(mesh: Mesh, name: string): unknown {
  const material = mesh.material as { uniforms?: Record<string, { value: unknown }> };
  return material.uniforms?.[name]?.value;
}

/** The visible width of the frame at distance `distance` in front of the camera, in world units. */
function visibleWidth(camera: Camera, distance: number): number {
  const c = camera as PerspectiveCamera;
  if (!c.isPerspectiveCamera) return 0;
  return 2 * Math.tan((c.fov * Math.PI) / 360) * distance * c.aspect;
}

/**
 * Where a contained image sits in the plane's uv space: the whole width or height, and the part of
 * the other axis the picture fills (the shader's `fitUv`, run backwards). `cover` has no such rect.
 */
export function containedImageRect(planeAspect: number, imageAspect: number): UvRect {
  const ratio = imageAspect / planeAspect;
  if (!(ratio > 0) || !Number.isFinite(ratio)) return [0, 0, 1, 1];
  // ratio > 1: the picture is wider than the plane, it fills the width and part of the height.
  if (ratio > 1) {
    const fill = 1 / ratio;
    return [0, (1 - fill) / 2, 1, (1 + fill) / 2];
  }
  return [(1 - ratio) / 2, 0, (1 + ratio) / 2, 1];
}

/** An alpha above this is ink. */
const INK_ALPHA = 16;

interface Readable {
  width: number;
  height: number;
  getContext: (kind: string) => { getImageData: (x: number, y: number, w: number, h: number) => { data: ArrayLike<number> } } | null;
}

const drawnCache = new WeakMap<object, { version: number; rects: UvRect[] | undefined }>();

/**
 * The lines a text layer drew, as rectangles in its plane's uv space, read from the canvas its texture
 * holds: `undefined` when there is nothing to read (no canvas, no 2D context), an empty list when it
 * drew no ink at all. Cached per texture and version, because a text texture is rebuilt, not edited.
 */
function drawnLines(mesh: Mesh): UvRect[] | undefined {
  const map = (mesh.material as { map?: { image?: unknown; version?: number } }).map;
  const image = map?.image as Readable | undefined;
  if (!image || typeof image.getContext !== "function" || !(image.width > 0) || !(image.height > 0)) return undefined;
  const version = map?.version ?? 0;
  const cached = drawnCache.get(image);
  if (cached && cached.version === version) return cached.rects;
  let rects: UvRect[] | undefined;
  try {
    const context = image.getContext("2d");
    if (context) {
      const { width: w, height: h } = image;
      const data = context.getImageData(0, 0, w, h).data;
      const bands: { y0: number; y1: number; x0: number; x1: number }[] = [];
      let open: { y0: number; y1: number; x0: number; x1: number } | null = null;
      for (let y = 0; y < h; y++) {
        let x0 = -1;
        let x1 = -1;
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > INK_ALPHA) {
            if (x0 < 0) x0 = x;
            x1 = x;
          }
        }
        if (x0 < 0) {
          open = null;
          continue;
        }
        if (open) {
          open.y1 = y + 1;
          open.x0 = Math.min(open.x0, x0);
          open.x1 = Math.max(open.x1, x1 + 1);
        } else {
          open = { y0: y, y1: y + 1, x0, x1: x1 + 1 };
          bands.push(open);
        }
      }
      rects = bands.map((b) => {
        // A click between two letters, or just beside a line, still counts.
        const pad = Math.max(4, Math.round((b.y1 - b.y0) * 0.15));
        const x0 = Math.max(0, b.x0 - pad);
        const x1 = Math.min(w, b.x1 + pad);
        const y0 = Math.max(0, b.y0 - pad);
        const y1 = Math.min(h, b.y1 + pad);
        // A canvas texture is flipped: the top row of the canvas is the top of the plane (v = 1).
        return [x0 / w, 1 - y1 / h, x1 / w, 1 - y0 / h] as const;
      });
    }
  } catch {
    // A canvas that cannot be read (lost, tainted): the plane stands in.
    rects = undefined;
  }
  drawnCache.set(image, { version, rects });
  return rects;
}

/** The region of the lines a layer drew, or null when it drew none, or undefined when there is nothing to read. */
function linesRegion(mesh: Mesh): Region | null | undefined {
  const rects = drawnLines(mesh);
  if (rects === undefined) return undefined;
  if (rects.length === 0) return null;
  const rect: UvRect = [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];
  return { mesh, rect, contains: (u, v) => rects.some((r) => inRect(r)(u, v)) };
}

/** The rounded-box distance the shape shader uses (negative inside). */
function roundedBoxDistance(px: number, py: number, bx: number, by: number, r: number): number {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

/**
 * The shape's extent on its plane: the SDF the fragment shader draws, read from the live uniforms
 * (the pointer pulls the centre by up to 0.4 of the plane, so it is read when a click asks).
 */
function shapeRegion(layer: Layer, mesh: Mesh): Region | null {
  const kind = Number(uniform(mesh, "uShape") ?? 0);
  const size = Number(uniform(mesh, "uSize") ?? num(layer, "size", 0.6));
  const aspect = Number(uniform(mesh, "uAspect") ?? num(layer, "aspect", 1));
  const radius = Number(uniform(mesh, "uRadius") ?? num(layer, "radius", 0));
  const softness = Math.max(Number(uniform(mesh, "uSoftness") ?? num(layer, "softness", 0)), 0.001);
  const wobble = Number(uniform(mesh, "uWobble") ?? num(layer, "wobble", 0));
  const position = uniform(mesh, "uPosition") as { x: number; y: number } | undefined;
  const mouse = uniform(mesh, "uMouse") as { x: number; y: number } | undefined;
  const planeAspect = Number(uniform(mesh, "uPlaneAspect") ?? FALLBACK_PLANE_ASPECT);
  if (![size, aspect, radius, softness, wobble, planeAspect].every(Number.isFinite) || planeAspect <= 0) return null;
  // The shader's plane space: -aspect..aspect across, -1..1 up; the centre as it computes it.
  const cx = ((position?.x ?? 0) + (mouse?.x ?? 0) * 0.4) * planeAspect;
  const cy = (position?.y ?? 0) + (mouse?.y ?? 0) * 0.4;
  const half =
    kind === 1 ? [size * aspect + softness, size + softness] : kind === 2 ? [size * (1 + Math.max(0, wobble)) + softness, size * (1 + Math.max(0, wobble)) + softness] : [size + softness, size + softness];
  const toU = (x: number) => x / (2 * planeAspect) + 0.5;
  const toV = (y: number) => y / 2 + 0.5;
  const rect: UvRect = [toU(cx - half[0]), toV(cy - half[1]), toU(cx + half[0]), toV(cy + half[1])];
  return {
    mesh,
    rect,
    contains: (u, v) => {
      const px = (u - 0.5) * 2 * planeAspect - cx;
      const py = (v - 0.5) * 2 - cy;
      const d = kind === 1 ? roundedBoxDistance(px, py, size * aspect, size, Math.min(radius, size * aspect, size)) : Math.hypot(px, py) - size;
      return d <= softness / 2;
    },
  };
}

/** The part of a layer's plane a click can hit, or null when the layer cannot be picked now. */
function regionOf(layer: Layer, root: Object3D, camera: Camera): Region | null {
  if (!PICKABLE_KINDS.includes(layer.type)) return null;
  // A layer drawn at no opacity is not there to be picked.
  if (layer.params.opacity?.value === 0) return null;
  const mesh = firstMesh(root);
  if (!mesh) return null;
  switch (layer.type) {
    case "text": {
      const lines = linesRegion(mesh);
      return lines !== undefined ? lines : { mesh, rect: [0, 0, 1, 1], contains: () => true };
    }
    case "textBox": {
      const lines = linesRegion(mesh);
      if (lines !== undefined) return lines;
      const plane = planeSize(mesh);
      if (!plane || plane.width <= 0 || plane.height <= 0) return null;
      // The text rectangle is the box's width, the padding hangs outside it by the same world
      // amount on every side (square pixels): the box's width is `width` of the visible frame.
      const boxWidth = num(layer, "width", 1) * visibleWidth(camera, Math.abs(camera.position.z - root.getWorldPosition(new Vector3()).z));
      const pad = Math.max(0, (plane.width - boxWidth) / 2);
      const contentW = Math.max(0, plane.width - 2 * pad);
      const contentH = Math.max(0, plane.height - 2 * pad);
      if (contentW <= 0 || contentH <= 0) return null;
      const rect: UvRect = [pad / plane.width, pad / plane.height, 1 - pad / plane.width, 1 - pad / plane.height];
      return { mesh, rect, contains: inRect(rect) };
    }
    case "shape":
      return shapeRegion(layer, mesh);
    case "image": {
      if (Number(uniform(mesh, "uFit") ?? (str(layer, "fit", "cover") === "contain" ? 1 : 0)) < 0.5) return null;
      const planeAspect = Number(uniform(mesh, "uPlaneAspect") ?? FALLBACK_PLANE_ASPECT);
      const imageAspect = Number(uniform(mesh, "uImageAspect") ?? planeAspect);
      const rect = containedImageRect(planeAspect, imageAspect);
      return { mesh, rect, contains: inRect(rect) };
    }
    default:
      return null;
  }
}

const corner = new Vector3();

/** The four corners of a region on screen, in normalised device coordinates. */
function ndcCorners(region: Region, camera: Camera): Vector3[] {
  const plane = planeSize(region.mesh);
  if (!plane) return [];
  region.mesh.updateWorldMatrix(true, false);
  camera.updateMatrixWorld();
  const [u0, v0, u1, v1] = region.rect;
  return ([[u0, v0], [u1, v0], [u1, v1], [u0, v1]] as const).map(([u, v]) =>
    region.mesh.localToWorld(corner.set((u - 0.5) * plane.width, (v - 0.5) * plane.height, 0)).clone().project(camera),
  );
}

/** Whether a region fills the visible frame on both axes: a layer that does is no target, the click is the box's. */
function coversFrame(region: Region, camera: Camera): boolean {
  const points = ndcCorners(region, camera);
  if (points.length === 0) return false;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const spanX = Math.min(1, Math.max(...xs)) - Math.max(-1, Math.min(...xs));
  const spanY = Math.min(1, Math.max(...ys)) - Math.max(-1, Math.min(...ys));
  return spanX >= 2 * FRAME_COVER && spanY >= 2 * FRAME_COVER;
}

/** A rectangle on the canvas in layout pixels. */
export interface CanvasRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FxPicker {
  /** The id of the layer under this point of the frame (normalised device coordinates: -1..1, y up), or null. */
  pickAt: (ndcX: number, ndcY: number) => string | null;
  /** Where a layer is on the canvas, in layout pixels of a canvas `width` by `height` (an axis-aligned box around it), or null. */
  boundsOf: (layerId: string, width: number, height: number) => CanvasRect | null;
}

/** A picker over what the live scene handed out. It keeps nothing: the layers are read when asked. */
export function createPicker(probe: SceneProbe): FxPicker {
  const raycaster = new Raycaster();
  // A layer with a targeted effect is moved to a render channel of its own (L4): the ray sees every one.
  raycaster.layers.enableAll();
  const at = new Vector2();

  /** The region of a drawn layer that can be hit, or null (not pickable, or unbounded). */
  const bounded = (layer: Layer, root: Object3D): Region | null => {
    const region = regionOf(layer, root, probe.camera);
    if (!region) return null;
    // Whatever its kind: a layer whose content covers the visible frame on both axes is no target.
    if (coversFrame(region, probe.camera)) return null;
    return region;
  };

  return {
    pickAt(ndcX, ndcY) {
      probe.camera.updateMatrixWorld();
      at.set(ndcX, ndcY);
      raycaster.setFromCamera(at, probe.camera);
      let best: { id: string; distance: number; index: number } | null = null;
      probe.layers().forEach(({ layer, root }, index) => {
        const region = bounded(layer, root);
        if (!region) return;
        root.updateWorldMatrix(true, true);
        const hit = raycaster.intersectObject(root, true).find((h) => h.uv);
        if (!hit?.uv || !region.contains(hit.uv.x, hit.uv.y)) return;
        // Nearest along the ray; the later layer when two sit at the same depth.
        if (!best || hit.distance < best.distance - 1e-6 || (Math.abs(hit.distance - best.distance) <= 1e-6 && index > best.index)) {
          best = { id: layer.id, distance: hit.distance, index };
        }
      });
      return (best as { id: string } | null)?.id ?? null;
    },
    boundsOf(layerId, width, height) {
      const entry = probe.layers().find((l) => l.layer.id === layerId);
      if (!entry) return null;
      entry.root.updateWorldMatrix(true, true);
      const region = bounded(entry.layer, entry.root);
      if (!region) return null;
      const points = ndcCorners(region, probe.camera);
      if (points.length === 0 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
      const xs = points.map((p) => ((p.x + 1) / 2) * width);
      const ys = points.map((p) => ((1 - p.y) / 2) * height);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
    },
  };
}

/**
 * A pointer position as the normalised device coordinates of the scene. The canvas is scaled by a
 * CSS transform in the editor (its zoom), so its rectangle on screen is the scaled size: the
 * position is brought into the canvas's own (layout) pixels first, by the scale the rectangle
 * and the layout size give, and only then divided by the layout size.
 */
export function pointerToNdc(client: { x: number; y: number }, rect: { left: number; top: number; width: number }, layout: { width: number; height: number }): { x: number; y: number } | null {
  if (!(layout.width > 0) || !(layout.height > 0) || !(rect.width > 0)) return null;
  const scale = rect.width / layout.width;
  const x = (client.x - rect.left) / scale;
  const y = (client.y - rect.top) / scale;
  return { x: (x / layout.width) * 2 - 1, y: 1 - (y / layout.height) * 2 };
}

/**
 * The `position` of a dragged text box: where it started plus the pointer's travel, in the canvas's
 * layout pixels (the screen travel divided by the zoom scale), as a share of the layout size, kept
 * inside the box (the reader would clamp it too, with a note each time).
 */
export function positionAfterDrag(start: readonly [number, number], travel: { dx: number; dy: number }, scale: number, layout: { width: number; height: number }): [number, number] {
  const s = scale > 0 ? scale : 1;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return [clamp(start[0] + travel.dx / s / layout.width), clamp(start[1] + travel.dy / s / layout.height)];
}
