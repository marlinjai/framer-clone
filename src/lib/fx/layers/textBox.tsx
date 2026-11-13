"use client";

/**
 * Text box content layer: free-positioned text.
 *
 * Draws a block of plain text (line breaks allowed, wrapped inside a share of
 * the scene's width) into a CanvasTexture and puts it on a plane at a point of
 * the scene that is set with `position` and `anchor`. Like the lockup it is
 * pixels, not HTML: the box's own HTML children are what search engines and
 * screen readers read, so a page's real headline never lives only here.
 *
 * The mesh is registered under the layer id, so a god rays pass can read it as
 * its source. Under reduced motion it draws its final state at once: full
 * opacity, no scale settle, no pointer parallax.
 *
 * Everything that reaches the canvas is plain text (`fillText`/`strokeText`),
 * and fonts come only from the lockup's fixed system stacks: a canvas can only
 * draw a font the page has already loaded.
 */

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { useWindowPointer } from "../interactivity";
import { textBoxSchema, TEXT_BOX_ANCHORS } from "../schemas";
import type { LayerComponentProps, LayerDefinition } from "../types";
import { fontStack } from "./text";

interface TextBoxValues {
  text: string;
  font: string;
  weight: string;
  size: number;
  lineHeight: number;
  letterSpacing: number;
  align: string;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  position: [number, number];
  anchor: string;
  width: number;
  rotation: number;
  opacity: number;
  reveal: number;
  parallax: number;
}

/** The text rectangle is this wide in pixels at most; a larger font than `MAX_FONT_PX` shrinks the texture, not the text. */
const TEXTURE_WIDTH = 2048;
const MAX_FONT_PX = 512;
const MAX_TEXTURE_HEIGHT = 4096;

/** Where each of the nine anchors sits on the text's own rectangle: x from the left, y from the top, each 0 to 1. */
export function anchorFractions(anchor: string): [number, number] {
  const i = TEXT_BOX_ANCHORS.indexOf(anchor);
  const index = i < 0 ? TEXT_BOX_ANCHORS.indexOf("center") : i;
  return [(index % 3) / 2, Math.floor(index / 3) / 2];
}

/** What a measuring function answers: the drawn width of a piece of text in pixels. */
export type Measure = (text: string) => number;

/**
 * Break `text` into lines no wider than `maxWidth`. A line break in the text is
 * kept, words wrap at spaces, and a word wider than a whole line is cut by
 * characters so nothing is ever drawn outside the box. Blank lines are kept, so
 * the writer's paragraph spacing survives; trailing blank lines are dropped.
 */
export function wrapText(text: string, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    let line = "";
    // Words break at spaces and tabs only (a non-breaking space stays inside its word).
    for (const word of paragraph.split(/[ \t]+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      // A word wider than a line is cut into pieces that fit, by whole characters (never inside a surrogate pair).
      let rest = Array.from(word);
      while (rest.length > 0 && measure(rest.join("")) > maxWidth) {
        let cut = 1;
        while (cut < rest.length && measure(rest.slice(0, cut + 1).join("")) <= maxWidth) cut++;
        lines.push(rest.slice(0, cut).join(""));
        rest = rest.slice(cut);
      }
      line = rest.join("");
    }
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The pixel size of the texture's text and padding for a box, and the world size each pixel stands for. */
export interface TextBoxLayout {
  /** Canvas size in pixels. */
  canvasWidth: number;
  canvasHeight: number;
  /** Padding around the text rectangle, so strokes and slanted glyph edges are not cut. */
  pad: number;
  /** Width of the text rectangle in pixels: the canvas without its padding. It stands for the box's whole width. */
  textWidth: number;
  fontPx: number;
  lines: string[];
}

export interface TextBoxSpec {
  text: string;
  font: string;
  weight: string;
  size: number;
  lineHeight: number;
  letterSpacing: number;
  align: string;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  width: number;
  /** The scene's size in world units at the plane the text sits on. */
  viewportWidth: number;
  viewportHeight: number;
}

/** Whether this canvas draws letter spacing itself (Chromium, current Safari); otherwise the glyphs are placed one by one. */
function hasNativeLetterSpacing(ctx: CanvasRenderingContext2D): boolean {
  return "letterSpacing" in ctx;
}

function fontOf(spec: TextBoxSpec, fontPx: number): string {
  return `${spec.weight} ${fontPx}px ${fontStack(spec.font)}`;
}

/** Measure a line with letter spacing, or draw it (filled or as an outline) and return its width. */
function spacedLine(
  ctx: CanvasRenderingContext2D,
  line: string,
  x: number,
  y: number,
  spacing: number,
  mode: "measure" | "fill" | "stroke",
): number {
  if (spacing === 0 || hasNativeLetterSpacing(ctx)) {
    if (hasNativeLetterSpacing(ctx)) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${spacing}px`;
    if (mode === "fill") ctx.fillText(line, x, y);
    if (mode === "stroke") ctx.strokeText(line, x, y);
    // Native letter spacing adds the gap after every glyph, the last one included.
    return ctx.measureText(line).width - (hasNativeLetterSpacing(ctx) ? spacing : 0);
  }
  // Fallback: one glyph at a time. Kerning is lost, which is the price of an engine without letterSpacing.
  let cursor = x;
  const chars = Array.from(line);
  for (const ch of chars) {
    if (mode === "fill") ctx.fillText(ch, cursor, y);
    if (mode === "stroke") ctx.strokeText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + spacing;
  }
  return Math.max(0, cursor - x - (chars.length > 0 ? spacing : 0));
}

/**
 * Lay the text out and draw it. Returns the canvas and its layout.
 *
 * The text rectangle (the canvas without its padding) stands for exactly the box's width, so the
 * glyphs are `size` of the scene's height whatever the padding, stroke or letter spacing is. How many
 * pixels that is may be lowered, never the world size: a font above `MAX_FONT_PX`, or text that would
 * need a canvas taller than `MAX_TEXTURE_HEIGHT`, is drawn with fewer pixels per world unit (a softer
 * texture) instead of being cut or drawn too big. The canvas is never zero-sized.
 */
export function drawTextBox(spec: TextBoxSpec): { canvas: HTMLCanvasElement; layout: TextBoxLayout } {
  const boxWidth = Math.max(1e-6, spec.width * spec.viewportWidth);
  const unitsPerFont = spec.size * spec.viewportHeight;
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");

  /** Everything that depends on the pixel width of the text rectangle. */
  const layoutAt = (textWidth: number) => {
    const fontPx = Math.max(1, (unitsPerFont * textWidth) / boxWidth);
    const spacing = spec.letterSpacing * fontPx;
    const strokePx = spec.strokeWidth * fontPx;
    const pad = Math.ceil(fontPx * 0.25 + strokePx + Math.abs(spacing));
    ctx.font = fontOf(spec, fontPx);
    const measure: Measure = (t) => spacedLine(ctx, t, 0, 0, spacing, "measure");
    const lines = wrapText(spec.text, textWidth, measure);
    const lineHeightPx = fontPx * spec.lineHeight;
    return { textWidth, fontPx, spacing, strokePx, pad, lines, lineHeightPx, height: Math.max(4, Math.ceil(lines.length * lineHeightPx + 2 * pad)) };
  };

  let textWidth = TEXTURE_WIDTH;
  let laid = layoutAt(textWidth);
  if (laid.fontPx > MAX_FONT_PX) {
    textWidth = Math.max(8, Math.round((TEXTURE_WIDTH * MAX_FONT_PX) / laid.fontPx));
    laid = layoutAt(textWidth);
  }
  // Too tall for a texture: fewer pixels per world unit, the text itself unchanged (it wraps the same way).
  for (let attempt = 0; attempt < 12 && laid.height > MAX_TEXTURE_HEIGHT && textWidth > 8; attempt++) {
    textWidth = Math.max(8, Math.floor(textWidth * (MAX_TEXTURE_HEIGHT / laid.height) * 0.95));
    laid = layoutAt(textWidth);
  }
  // Only a text that cannot fit at any size is cut, at the last line that does.
  const maxLines = Math.max(1, Math.floor((MAX_TEXTURE_HEIGHT - 2 * laid.pad) / laid.lineHeightPx));
  const lines = laid.lines.slice(0, maxLines);

  const canvasWidth = textWidth + 2 * laid.pad;
  const canvasHeight = Math.max(4, Math.min(MAX_TEXTURE_HEIGHT, Math.ceil(lines.length * laid.lineHeightPx + 2 * laid.pad)));
  // Resizing a canvas resets its state, so everything is set again after it.
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.font = fontOf(spec, laid.fontPx);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = laid.strokePx * 2;
  ctx.fillStyle = spec.color;
  ctx.strokeStyle = spec.strokeColor;

  const place = (line: string, i: number) => {
    const width = spacedLine(ctx, line, 0, 0, laid.spacing, "measure");
    const x = spec.align === "left" ? laid.pad : spec.align === "right" ? canvasWidth - laid.pad - width : laid.pad + (textWidth - width) / 2;
    return { x, y: laid.pad + laid.lineHeightPx * (i + 0.5) };
  };
  // Every outline goes under every fill, so a tight line height never paints one line's outline over the last one's letters.
  if (laid.strokePx > 0) {
    lines.forEach((line, i) => {
      if (line === "") return;
      const { x, y } = place(line, i);
      spacedLine(ctx, line, x, y, laid.spacing, "stroke");
    });
  }
  lines.forEach((line, i) => {
    if (line === "") return;
    const { x, y } = place(line, i);
    spacedLine(ctx, line, x, y, laid.spacing, "fill");
  });

  return { canvas, layout: { canvasWidth, canvasHeight, pad: laid.pad, textWidth, fontPx: laid.fontPx, lines } };
}

/**
 * The mesh's offset from the anchor point, in world units, so the anchor of the text rectangle (the
 * canvas without its padding) sits on the anchor point.
 */
export function anchorOffset(
  anchor: string,
  plane: { width: number; height: number },
  layout: Pick<TextBoxLayout, "canvasWidth" | "canvasHeight" | "pad">,
): [number, number] {
  const [fx, fy] = anchorFractions(anchor);
  const contentW = (plane.width * Math.max(1, layout.canvasWidth - 2 * layout.pad)) / layout.canvasWidth;
  const contentH = (plane.height * Math.max(1, layout.canvasHeight - 2 * layout.pad)) / layout.canvasHeight;
  return [(0.5 - fx) * contentW, (fy - 0.5) * contentH];
}

function TextBoxLayerComponent({ layer, values, ctx }: LayerComponentProps) {
  const v = values as unknown as TextBoxValues;
  const viewport = useThree((s) => s.viewport);
  // A resize of a few pixels does not redraw the texture.
  const vw = Math.round(viewport.width * 100) / 100;
  const vh = Math.round(viewport.height * 100) / 100;

  const meshRef = useRef<THREE.Mesh | null>(null);
  const driftRef = useRef<THREE.Group | null>(null);
  const pullRef = useRef({ x: 0, y: 0 });
  const matRef = useRef<THREE.MeshBasicMaterial | null>(null);

  const built = useMemo(() => {
    const { canvas, layout } = drawTextBox({
      text: v.text,
      font: v.font,
      weight: v.weight,
      size: v.size,
      lineHeight: v.lineHeight,
      letterSpacing: v.letterSpacing,
      align: v.align,
      color: v.color,
      strokeColor: v.strokeColor,
      strokeWidth: v.strokeWidth,
      width: v.width,
      viewportWidth: vw,
      viewportHeight: vh,
    });
    const tex = new THREE.CanvasTexture(canvas);
    // The colours are drawn into the canvas, so the texture is read as sRGB.
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    // The text rectangle is the box's width; the padding hangs outside it.
    const planeWidth = v.width * vw * (layout.canvasWidth / layout.textWidth);
    // Pixels are square: the plane keeps the canvas's proportions.
    const planeHeight = (planeWidth * layout.canvasHeight) / layout.canvasWidth;
    return { tex, layout, planeWidth, planeHeight };
  }, [
    v.text,
    v.font,
    v.weight,
    v.size,
    v.lineHeight,
    v.letterSpacing,
    v.align,
    v.color,
    v.strokeColor,
    v.strokeWidth,
    v.width,
    vw,
    vh,
  ]);

  // Free the texture when it is replaced or on unmount (Safari caps WebGL contexts).
  useEffect(() => () => built.tex.dispose(), [built.tex]);

  const offset = anchorOffset(v.anchor, { width: built.planeWidth, height: built.planeHeight }, built.layout);
  const baseX = (v.position[0] - 0.5) * vw;
  const baseY = (0.5 - v.position[1]) * vh;

  const pointer = useWindowPointer();
  const startedAt = useRef<number | null>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (startedAt.current === null) startedAt.current = t;
    const dur = Math.max(0.001, v.reveal);
    // Reduced motion draws the final state: no fade, no settle, no pointer drift.
    const raw = ctx.reduce ? 1 : Math.min(1, (t - startedAt.current) / dur);
    const e = 1 - Math.pow(1 - raw, 3);
    if (matRef.current) matRef.current.opacity = e * v.opacity;
    const drift = driftRef.current;
    if (drift) {
      const s = ctx.reduce ? 1 : THREE.MathUtils.lerp(1.05, 1.0, e);
      drift.scale.set(s, s, 1);
      // The pointer's pull eases in; the box's own position is always where the settings put it.
      const pull = pullRef.current;
      if (ctx.reduce) {
        // Reduced motion (also when it is switched on while the page is open) holds the final state at once.
        pull.x = 0;
        pull.y = 0;
      } else {
        pull.x += (pointer.x * v.parallax - pull.x) * 0.05;
        pull.y += (pointer.y * v.parallax * 0.62 - pull.y) * 0.05;
      }
      drift.position.set(baseX + pull.x, baseY + pull.y, 0);
    }
  });

  // The drift group (position by the pointer, scale) is outside the rotated one, so the pointer moves
  // the text on the screen whatever the rotation is, and the scale settles about the anchor point.
  return (
    <group ref={driftRef}>
      <group rotation={[0, 0, THREE.MathUtils.degToRad(v.rotation)]}>
        <mesh
          position={[offset[0], offset[1], 0]}
          ref={(m) => {
            meshRef.current = m;
            // A god rays pass reads this mesh as its source.
            ctx.registerObject(layer.id, m);
          }}
        >
          <planeGeometry args={[built.planeWidth, built.planeHeight]} />
          <meshBasicMaterial
            ref={matRef}
            map={built.tex}
            transparent
            opacity={ctx.reduce ? v.opacity : 0}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      </group>
    </group>
  );
}

export const TextBoxLayer: LayerDefinition = {
  ...textBoxSchema,
  Component: TextBoxLayerComponent,
};
