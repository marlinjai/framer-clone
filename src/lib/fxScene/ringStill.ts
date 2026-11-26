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
//  - redrawn, in a fresh short-lived context, when the box changes size before the
//    live scene is there;
//  - removed once the live layer is fully opaque over it (no two-sided cross-fade,
//    which would dip in brightness), at once when the page is put away.
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
import { FX_FADE_MS, holdFxBox } from './box';
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
   * The live scene is fading in over the still (`afterLive`): the still goes once the layer's fade is over.
   * Otherwise (`now`, or by default): gone at once, the box given back.
   */
  remove: (options?: { afterLive?: boolean }) => void;
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
  const ratio = canvasPixelRatio(liveDprRange(spec.dpr, isTouchLikely()), window.devicePixelRatio || 1);

  // The live layer is the same box (inset 0 in the box), measured as the engine measures it.
  let drawn = '';
  const draw = (): boolean => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const key = `${rect.width}x${rect.height}`;
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
  const resized = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        if (frame) return;
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          // A redraw that fails keeps the last picture, stretched to the box, until the live scene is there.
          draw();
        });
      })
    : null;
  resized?.observe(canvas);

  let removed = false;
  let timer = 0;
  const finish = () => {
    resized?.disconnect();
    if (frame) window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    timer = 0;
    canvas.remove();
    release();
  };
  return {
    remove: ({ afterLive = false } = {}) => {
      if (removed) {
        // A pending removal made immediate (the page is put away during the live layer's fade).
        if (!afterLive && timer) finish();
        return;
      }
      removed = true;
      // No redraw from here on, not even one already asked for: the live scene's context is up, and a redraw
      // during its fade would open a second one.
      resized?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      if (afterLive) timer = window.setTimeout(finish, FX_FADE_MS);
      else finish();
    },
  };
}
