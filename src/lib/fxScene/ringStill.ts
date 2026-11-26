// src/lib/fxScene/ringStill.ts
//
// The first picture of a particle ring on the published page, before the engine is
// there (plan docs/plans/2026-11-08-lumitra-fx-in-sites.md, addendum "the ring's own
// still while the engine loads", 2026-11-24). The engine (three.js, a chunk of its own)
// takes a few hundred milliseconds to arrive and set up; the ring's first frame does not
// need it. The ring is plain WebGL math (src/lib/fx/particleRingCore: the particles, the
// two shaders), so the island draws that one frame itself, in a few milliseconds, at the
// box's exact size and pixel ratio, and shows it until the live scene has faded in over
// it. It is the frame the engine starts on (time RING_START_TIME, no pointer lean), so
// the hand-over shows no jump.
//
// Why drawn and not a stored image: a ring's points are sized in device pixels while
// its radius follows the box, so a smaller ring is denser and brighter. A picture taken
// at one size and scaled to another misses the live ring by more than the eye forgives
// once the radius is about 5 percent off (measured 2026-11-24, under
// ~/software-dev/orchestration/fx-ring-scratch/poster). Drawing costs no download and is
// exact at every size.
//
// Only on a graphics card: where WebGL draws on the processor, the still would hold
// the page's main thread for most of a second (isSoftwareRenderer), so it is left out.
//
// Only for a scene that is one particle ring on its background (ringStillSpecOf): any
// other layer, a post pass, a ring with param animation or a scoped target changes the
// first frame in ways this short path does not draw, and those scenes keep the loading
// placeholder (./placeholder.ts).
//
// How it sits in the box:
//  - a canvas over the whole box, BEHIND the box's content and behind the live layer
//    (z-index -2 against the layer's -1, inside the stacking context the box hold
//    gives, ./box.ts), taking no pointer and hidden from assistive technology;
//  - drawn into a short-lived WebGL context, copied into the visible canvas and the
//    context released at once, so the page holds no second context while the engine
//    starts (one WebGL context per page);
//  - redrawn, in a fresh short-lived context, when the box changes size or the
//    device's pixel ratio changes (the window moves to another display, a zoom)
//    before the live scene is there;
//  - removed once the live layer is fully opaque over it, as read from that layer on
//    each frame (no two-sided cross-fade, which would dip in brightness, and no clock,
//    which the engine's set-up can outlast), at once when the page is put away.
//
// No engine code: imports only the render-free ring core and the pixel ratio rule.

import type { StoredFx } from '@/lib/fx/format';
import {
  RING_FRAGMENT,
  RING_START_TIME,
  RING_VERTEX,
  buildRingParticles,
  canvasPixelRatio,
  isTouchLikely,
  liveDprRange,
  mulberry32,
  ringGlowWeights,
  ringRadius,
} from '@/lib/fx/ring';
import { holdFxBox } from './box';
import { FX_RING_STILL_ATTR } from './marker';

/** The still's own fade in: short, so the ring reads as there, and no pop. */
export const FX_RING_STILL_FADE_MS = 150;

/** What the still needs of a scene: its background, its pixel ratio range and the ring's values. */
export interface RingStillSpec {
  background: string;
  dpr: [number, number];
  glow: number;
  density: number;
  seed: number;
}

const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/**
 * The still of a stored scene, or null when the scene is not one particle ring on its background: exactly
 * one visible layer, a particle ring, without param animation and without a scoped target.
 */
export function ringStillSpecOf(fx: Pick<StoredFx, 'scene'>): RingStillSpec | null {
  const visible = fx.scene.layers.filter((layer) => layer.visible !== false);
  if (visible.length !== 1) return null;
  const [ring] = visible;
  if (ring.type !== 'particleRing') return null;
  if (ring.animate && Object.keys(ring.animate).length > 0) return null;
  if (ring.target) return null;
  return {
    background: fx.scene.background,
    dpr: [fx.scene.dpr[0], fx.scene.dpr[1]],
    glow: finite(ring.params.glow, 1),
    density: finite(ring.params.density, 1),
    seed: finite(ring.params.seed, 1),
  };
}

export interface FxRingStill {
  /**
   * The live scene is fading in over the still (`under`, its layer): the still goes once that layer is fully
   * opaque, read from the layer itself on each frame, never from a clock (the engine's set-up can hold the main
   * thread for longer than the fade, and a timer started at the first frame then ran out before the fade had
   * begun: the still left at the start of the fade and the ring dipped, seen in Chromium on a graphics card,
   * 2026-11-26). Should that layer leave before it is opaque (the engine stopped), the still stays as the picture.
   * In a hidden tab no frame runs, so the still waits, unseen and costing nothing, until the tab is shown.
   * Otherwise (by default): gone at once, the box given back.
   */
  remove: (options?: { under?: HTMLElement }) => void;
}

/** The colour as the display-space bytes the canvas shows (0 to 1), opaque; black when the browser cannot read it. */
function colourBytes(colour: string): [number, number, number] {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return [0, 0, 0];
  probe.fillStyle = '#000000';
  probe.fillStyle = colour;
  const value = String(probe.fillStyle);
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex) return [1, 2, 3].map((i) => parseInt(hex[i], 16) / 255) as [number, number, number];
  // A colour with an alpha below 1 comes back as rgba(); the scene's background ignores the alpha, as three.js does.
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(value);
  if (rgba) return [1, 2, 3].map((i) => Number(rgba[i]) / 255) as [number, number, number];
  return [0, 0, 0];
}

/** Renderer names of WebGL drawn on the processor, not a graphics card. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|lavapipe/i;

/**
 * True when the context draws on the processor. There the ring's frame (about 91,000 points, the glow pass as
 * large ones) takes most of a second, and copying it out waits for all of it on the page's main thread: measured
 * 2026-11-24 in Chromium on a machine without a graphics card, the page's largest paint moved from 0.64 s to about
 * 1.5 s and the ring was seen later than without the still. On a graphics card the same frame takes milliseconds.
 */
export function isSoftwareRenderer(gl: WebGL2RenderingContext): boolean {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  return SOFTWARE_RENDERER.test(name);
}

function compile(gl: WebGL2RenderingContext, type: number, body: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('no shader');
  gl.shaderSource(shader, `#version 300 es\n${body}`);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader failed');
  return shader;
}

/**
 * Draw the ring's first frame at `width` x `height` CSS pixels and `ratio`, into `into` (a 2D canvas), through a
 * WebGL context that is released before this returns. False when this browser cannot draw it.
 */
export function drawRingStill(into: HTMLCanvasElement, spec: RingStillSpec, width: number, height: number, ratio: number): boolean {
  // The canvas rounds its size down, as three.js does for the live one.
  const w = Math.max(1, Math.floor(width * ratio));
  const h = Math.max(1, Math.floor(height * ratio));
  const scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  // The component's canvas, and the ring's own buffer in the engine: four samples per pixel, no premultiplying.
  // A browser that would draw it slowly (software) may refuse the context outright; where it does not say so, the
  // renderer's name does (the still is then left out, and the placeholder shows, as before).
  const gl = scratch.getContext('webgl2', {
    antialias: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: true,
  });
  if (!gl) return false;
  try {
    if (isSoftwareRenderer(gl)) return false;
    const program = gl.createProgram();
    if (!program) return false;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, RING_VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, RING_FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
    const particles = buildRingParticles(spec.density, mulberry32(Math.round(spec.seed)));
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, particles, gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
    gl.useProgram(program);
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const R = ringRadius(width, height);
    gl.uniform1f(uniform('t'), RING_START_TIME);
    gl.uniform2f(uniform('res'), width, height);
    gl.uniform2f(uniform('ptr'), 0, 0);
    gl.uniform1f(uniform('R'), R);
    gl.uniform1f(uniform('W'), R * 0.2);
    gl.uniform1f(uniform('dpr'), ratio);
    const [r, g, b] = colourBytes(spec.background);
    gl.viewport(0, 0, w, h);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const count = particles.length / 3;
    const glow = uniform('glow');
    const gain = uniform('gain');
    gl.uniform1f(glow, 1);
    // One pass per weight, each drawing that share of its points (`gain`), as the live layer's `applyGlowPasses`.
    for (const weight of ringGlowWeights(spec.glow)) {
      gl.uniform1f(gain, weight);
      gl.drawArrays(gl.POINTS, 0, count);
    }
    gl.uniform1f(glow, 0);
    gl.uniform1f(gain, 1);
    gl.drawArrays(gl.POINTS, 0, count);
    // Copied in the same task, before the browser may clear the drawing buffer.
    const target = into.getContext('2d');
    if (!target) return false;
    into.width = w;
    into.height = h;
    target.drawImage(scratch, 0, 0);
    return true;
  } catch {
    return false;
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/**
 * Call `changed` each time the device's pixel ratio changes, until the returned function is called. A ratio
 * alone does not resize the box, so a ResizeObserver says nothing of it; a resolution query for the current
 * ratio stops matching when it changes, and is then asked again for the new one.
 */
function watchDeviceRatio(changed: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  let query: MediaQueryList | null = null;
  const stop = () => {
    query?.removeEventListener?.('change', onChange);
    query = null;
  };
  const arm = () => {
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query.addEventListener?.('change', onChange);
  };
  const onChange = () => {
    stop();
    arm();
    changed();
  };
  arm();
  return stop;
}

/**
 * Show the ring's first frame in `box` now. Null when it cannot be drawn here (the caller shows the
 * placeholder instead). The box is held (./box.ts) while the still is there.
 */
export function showFxRingStill(box: HTMLElement, spec: RingStillSpec): FxRingStill | null {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.setAttribute(FX_RING_STILL_ATTR, '');
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    zIndex: '-2',
    pointerEvents: 'none',
    borderRadius: 'inherit',
    opacity: '0',
    transition: `opacity ${FX_RING_STILL_FADE_MS}ms ease-out`,
  });
  const release = holdFxBox(box);
  box.insertBefore(canvas, box.firstChild);

  // The live layer is the same box (inset 0 in the box), measured as the engine measures it.
  let drawn = '';
  const draw = (): boolean => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    // Read on each draw: the ratio can change while the engine loads, and the live canvas takes the current one.
    const ratio = canvasPixelRatio(liveDprRange(spec.dpr, isTouchLikely()), window.devicePixelRatio || 1);
    const key = `${rect.width}x${rect.height}@${ratio}`;
    if (key === drawn) return true;
    if (!drawRingStill(canvas, spec, rect.width, rect.height, ratio)) return false;
    drawn = key;
    return true;
  };
  if (!draw()) {
    canvas.remove();
    release();
    return null;
  }
  // Laid out once at opacity 0, so the change to 1 is a transition and not a jump.
  void canvas.offsetWidth;
  canvas.style.opacity = '1';

  let frame = 0;
  const redraw = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      // A redraw that fails keeps the last picture, stretched to the box, until the live scene is there.
      draw();
    });
  };
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(redraw) : null;
  resized?.observe(canvas);
  const unwatchRatio = watchDeviceRatio(redraw);
  /** No further redraw is asked for. */
  const unwatch = () => {
    resized?.disconnect();
    unwatchRatio();
  };

  /** The live scene is up: no redraw from here on. */
  let settled = false;
  let gone = false;
  let watch = 0;
  const finish = () => {
    if (gone) return;
    gone = true;
    unwatch();
    if (frame) window.cancelAnimationFrame(frame);
    if (watch) window.cancelAnimationFrame(watch);
    frame = 0;
    watch = 0;
    canvas.remove();
    release();
  };
  return {
    remove: ({ under } = {}) => {
      if (gone) return;
      // At once: the page is put away, the scene refused, or a removal pending under the live layer made immediate.
      if (!under) {
        finish();
        return;
      }
      if (settled) return;
      settled = true;
      // No redraw from here on, not even one already asked for: the live scene's context is up, and a redraw
      // during its fade would open a second one.
      unwatch();
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      // Gone on the second frame in a row that reads the layer fully opaque: the first may still be on its way
      // to the screen when the fade runs on the compositor.
      let opaque = 0;
      const check = () => {
        watch = 0;
        if (!under.isConnected) return;
        opaque = Number.parseFloat(getComputedStyle(under).opacity) >= 1 ? opaque + 1 : 0;
        if (opaque >= 2) finish();
        else watch = window.requestAnimationFrame(check);
      };
      watch = window.requestAnimationFrame(check);
    },
  };
}
