/**
 * The particle ring's render-free parts: the seeded generator, the particle data and the two shaders.
 *
 * The ring is Lumitra's brand light (knowledge-base docs/plans/2026-11-22-lumitra-rebrand-mint-light.md),
 * first written as the `<lumitra-light>` web component of `@marlinjai/suite-theme-core`
 * (`light/lumitra-light.js` at commit 2105604). The shaders here compute exactly what that component's
 * shaders compute; only the attribute is called `position` (three.js counts a geometry's points by it).
 * The pixel oracle (test/behaviour/fxRingOracle.spec.ts) holds the two pictures equal, so a change here
 * that changes a pixel fails there.
 *
 * What differs from the component, on purpose:
 *  - the particles come from a seeded generator (mulberry32) instead of `Math.random`, drawn in the
 *    component's order (per strand one phase, per point one random), so a stored scene is the same ring
 *    on every load;
 *  - the glow between whole numbers: the component draws a whole pass for every started whole number, so its
 *    glow only has the steps 0, 1 and 2. Here a part of a number is a pass that draws that share of its points
 *    (`ringGlowWeights`), so the glow can be tuned between them. At a whole number the passes are the component's,
 *    pixel for pixel.
 *
 * RENDER-FREE: no React, no three.js.
 */

/** Strands across the band, as in the component. */
export const RING_STRANDS = 120;
/** Points along one strand at density 1. */
export const RING_POINTS_PER_STRAND = 760;
/** The component's clock starts at 7 seconds; the still frame is drawn there. */
export const RING_START_TIME = 7;

/** mulberry32: a small, fast, well-spread 32-bit generator. Returns numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points per strand for a density, as the component rounds it (density clamped to 0.25..1). */
export function ringPointsPerStrand(density: number): number {
  const d = Math.max(0.25, Math.min(1, Number.isFinite(density) ? density : 1));
  return Math.round(RING_POINTS_PER_STRAND * d);
}

/**
 * The particles: per point its angle, its place across the band (0 to 1) and a random, three floats each,
 * generated in the component's order from `random`.
 */
export function buildRingParticles(density: number, random: () => number): Float32Array {
  const n = ringPointsPerStrand(density);
  const data = new Float32Array(RING_STRANDS * n * 3);
  let i = 0;
  for (let k = 0; k < RING_STRANDS; k++) {
    const ph = random() * 0.01;
    for (let p = 0; p < n; p++) {
      data[i++] = (p / n) * 6.2831853 + ph;
      data[i++] = k / (RING_STRANDS - 1);
      data[i++] = random();
    }
  }
  return data;
}

/** The ring's radius in CSS pixels for a box, as in the component. */
export function ringRadius(width: number, height: number): number {
  return Math.min(width * 0.37, height * 0.47);
}

/**
 * The strength of each glow pass for a stored glow (0 to 2): one pass per started whole number, as the component's
 * loop `for (g = 0; g < glow; g += 1)` counts them, every whole pass at full strength and the last at the part of a
 * number that is left. So 1 is one pass at 1, 1.3 is passes at 1 and 0.3, 0.02 one pass at 0.02, and 2 two whole
 * passes. A pass at a strength draws that share of its points, each at full light (`gain` in the vertex shader),
 * so the light rises evenly with the value; at strength 1 every point is drawn, so whole numbers draw the
 * component's ring. Dimming every point instead does not work: a glow point adds so little that most of a
 * dimmed one rounds to nothing in the 8-bit buffer (measured 2026-11-25: 0.01 drew exactly 0, 1.25 barely more
 * than 1).
 */
export function ringGlowWeights(glow: number): number[] {
  const value = Math.max(0, Math.min(2, Number.isFinite(glow) ? glow : 1));
  const weights: number[] = [];
  for (let left = value; left > 0; left -= 1) weights.push(Math.min(1, left));
  return weights;
}

/** How many glow passes a stored glow draws (`ringGlowWeights`): 0, 1 or 2. */
export function ringGlowPasses(glow: number): number {
  return ringGlowWeights(glow).length;
}

/** The decided 60/30/10 mix along the ring: mint leads, light blue rims, indigo only inside the glow. */
const STOPS: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0.0, [82, 255, 165]],
  [0.3, [82, 255, 165]],
  [0.5, [59, 132, 255]],
  [0.62, [88, 46, 255]],
  [0.72, [59, 132, 255]],
  [0.88, [82, 255, 165]],
  [1.0, [82, 255, 165]],
];

const f3 = (v: number): string => (v / 255).toFixed(3);

/** The palette function, written exactly as the component writes it. */
const PAL = (() => {
  let s = "vec3 pal(float x){";
  for (let i = 1; i < STOPS.length; i++) {
    const [a, ca] = STOPS[i - 1];
    const [b, cb] = STOPS[i];
    s += `if(x<=${b.toFixed(3)}){return mix(vec3(${f3(ca[0])},${f3(ca[1])},${f3(ca[2])}),vec3(${f3(cb[0])},${f3(cb[1])},${f3(cb[2])}),(x-${a.toFixed(3)})/${Math.max(0.001, b - a).toFixed(3)});}`;
  }
  return s + "return vec3(0.32,1.0,0.65);}";
})();

/** Vertex shader (GLSL ES 3.00 body; three.js adds the version line). */
export const RING_VERTEX = `
in vec3 position;
uniform float t; uniform vec2 res; uniform vec2 ptr; uniform float R; uniform float W; uniform float dpr; uniform float glow; uniform float gain;
out float vT; out float vA;
void main(){
 float th=position.x, u=position.y, rnd=position.z;
 float band=W*(0.65+0.35*sin(3.0*th+t*0.35)+0.15*sin(7.0*th-t*0.5));
 float w1=sin(6.0*th+u*2.2+t*0.55)*0.55+sin(13.0*th-u*3.1-t*0.8)*0.28+sin(23.0*th+u*5.0+t*1.1)*0.12;
 float w2=sin(4.0*th-u*1.7-t*0.4+sin(2.0*th+t*0.2))*0.6;
 float r=R+(u-0.5)*band+W*0.55*w1*(0.4+u)+W*0.25*w2;
 float z=sin(th*2.0+t*0.3+u)*0.18+(u-0.5)*0.3;
 vec2 p=vec2(cos(th),sin(th))*r;
 p.x+=ptr.x*W*0.6*(1.0-z); p.y+=ptr.y*W*0.6*(1.0-z);
 gl_Position=vec4(p.x/res.x*2.0, p.y/res.y*2.0, 0.0, 1.0);
 float base=(1.0+0.9*rnd*rnd)*(1.0+z*0.6);
 gl_PointSize=glow>0.5 ? base*dpr*16.0 : base*dpr;
 vT=fract(th/6.2831853+0.125);
 float edge=1.0-abs(u-0.5)*1.6;
 float al=(0.30+0.45*rnd)*(0.45+0.55*edge)*(0.75+0.25*sin(t*2.0+rnd*40.0));
 vA=glow>0.5 ? al*0.028 : al;
 // A glow pass below full strength draws that share of its points, each as bright as ever, chosen by a scramble of
 // the point's random so the share is spread evenly round the ring. At strength 1 every point is drawn and nothing
 // above changed. (Dimming every point instead loses the faint glow light to the 8-bit buffer's rounding.)
 if(glow>0.5 && fract(rnd*997.0)>=gain){ gl_Position=vec4(0.0,0.0,2.0,1.0); vA=0.0; }
}`;

/** Fragment shader (GLSL ES 3.00 body). Writes the component's colours as they are: no output conversion. */
export const RING_FRAGMENT = `
precision highp float; in float vT; in float vA; uniform float glow; out vec4 o;
${PAL}
void main(){
 vec2 c=gl_PointCoord-0.5; float d=dot(c,c); if(d>0.25) discard;
 if(glow>0.5){
  float f=smoothstep(0.25,0.0,d); f*=f;
  vec3 col=mix(pal(vT), vec3(0.345,0.18,1.0), 0.55);
  o=vec4(col*vA*f,1.0); return;
 }
 float f=smoothstep(0.25,0.0,d);
 o=vec4(pal(vT)*vA*f+vec3(0.08)*vA*f*f,1.0);
}`;
