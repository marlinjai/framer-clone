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

/** The texture is this wide in pixels at most; a larger font than `MAX_FONT_PX` shrinks the texture, not the text. */
const TEXTURE_WIDTH = 2048;
const MAX_FONT_PX = 512;
const MAX_TEXTURE_HEIGHT = 4096;
const MIN_TEXTURE_WIDTH = 64;

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
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      // A word wider than a line is cut into pieces that fit.
      let rest = word;
      while (rest && measure(rest) > maxWidth) {
        let cut = 1;
        while (cut < rest.length && measure(rest.slice(0, cut + 1)) <= maxWidth) cut++;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
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
 * Lay the text out and draw it. Returns the canvas and its layout. The canvas is
 * never zero-sized, and never larger than the texture limits, whatever the text.
 */
export function drawTextBox(spec: TextBoxSpec): { canvas: HTMLCanvasElement; layout: TextBoxLayout } {
  const boxWidth = Math.max(1e-6, spec.width * spec.viewportWidth);
  // World height of one line of text (before the line spacing), and how many pixels that is.
  const unitsPerFont = spec.size * spec.viewportHeight;
  let canvasWidth = TEXTURE_WIDTH;
  let fontPx = (unitsPerFont * canvasWidth) / boxWidth;
  if (fontPx > MAX_FONT_PX) {
    canvasWidth = Math.max(MIN_TEXTURE_WIDTH, Math.round((TEXTURE_WIDTH * MAX_FONT_PX) / fontPx));
    fontPx = (unitsPerFont * canvasWidth) / boxWidth;
  }
  fontPx = Math.max(1, fontPx);

  const spacing = spec.letterSpacing * fontPx;
  const strokePx = spec.strokeWidth * fontPx;
  const pad = Math.ceil(fontPx * 0.25 + strokePx + Math.abs(spacing));
  const textWidth = Math.max(1, canvasWidth - 2 * pad);

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = 4;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");

  ctx.font = fontOf(spec, fontPx);
  const measure: Measure = (t) => spacedLine(ctx, t, 0, 0, spacing, "measure");
  let lines = wrapText(spec.text, textWidth, measure);
  const lineHeightPx = fontPx * spec.lineHeight;
  const maxLines = Math.max(1, Math.floor((MAX_TEXTURE_HEIGHT - 2 * pad) / lineHeightPx));
  if (lines.length > maxLines) lines = lines.slice(0, maxLines);

  const canvasHeight = Math.max(4, Math.ceil(lines.length * lineHeightPx + 2 * pad));
  // Resizing a canvas resets its state, so the font is set again after it.
  canvas.height = canvasHeight;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.font = fontOf(spec, fontPx);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = strokePx * 2;
  ctx.fillStyle = spec.color;
  ctx.strokeStyle = spec.strokeColor;

  lines.forEach((line, i) => {
    if (line === "") return;
    const y = pad + lineHeightPx * (i + 0.5);
    const width = spacedLine(ctx, line, 0, 0, spacing, "measure");
    const x = spec.align === "left" ? pad : spec.align === "right" ? canvasWidth - pad - width : pad + (textWidth - width) / 2;
    // The outline goes under the fill, so it reads as an outside stroke.
    if (strokePx > 0) spacedLine(ctx, line, x, y, spacing, "stroke");
    spacedLine(ctx, line, x, y, spacing, "fill");
  });

  return { canvas, layout: { canvasWidth, canvasHeight, pad, fontPx, lines } };
}

/** The mesh's offset from the anchor point, in world units, so the anchor of the text rectangle sits on the anchor point. */
export function anchorOffset(
  anchor: string,
  plane: { width: number; height: number },
  layout: Pick<TextBoxLayout, "canvasWidth" | "canvasHeight" | "pad">,
): [number, number] {
  const [fx, fy] = anchorFractions(anchor);
  const contentW = (plane.width * (layout.canvasWidth - 2 * layout.pad)) / layout.canvasWidth;
  const contentH = (plane.height * (layout.canvasHeight - 2 * layout.pad)) / layout.canvasHeight;
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
    const planeWidth = v.width * vw * (layout.canvasWidth / (layout.canvasWidth - 2 * layout.pad));
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
      const tx = ctx.reduce ? 0 : pointer.x * v.parallax;
      const ty = ctx.reduce ? 0 : pointer.y * v.parallax * 0.62;
      drift.position.x += (tx - drift.position.x) * 0.05;
      drift.position.y += (ty - drift.position.y) * 0.05;
    }
  });

  return (
    <group position={[baseX, baseY, 0]} rotation={[0, 0, THREE.MathUtils.degToRad(v.rotation)]}>
      <group ref={driftRef}>
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
