"use client";

/**
 * Text content layer.
 *
 * Renders the hero lockup (eyebrow / headline / tagline) into a CanvasTexture
 * and maps it onto a plane. The plane is bright + emissive (toneMapped:false,
 * color override) so it can act as the GodRays source and trigger threshold
 * Bloom.
 *
 * The three lines, their fonts, sizes and the headline weight are all editable
 * params (so the lockup is tunable / serializable like any other layer). Per
 * spec section 10 decision 3 we stay on CanvasTexture; troika SDF text comes in
 * a later phase when we need per-glyph motion.
 */

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import type {
  LayerComponentProps,
  LayerDefinition,
  ParamsSchema,
} from "../types";

interface TextValues {
  eyebrowText: string;
  headlineText: string;
  taglineText: string;
  eyebrowFont: string;
  bodyFont: string;
  eyebrowSize: number;
  headlineSize: number;
  taglineSize: number;
  headlineWeight: string;
  color: string;
  width: number;
  height: number;
  reveal: number;
  parallax: number;
}

const FONT_OPTIONS = [
  "Helvetica Neue",
  "Arial",
  "Inter",
  "system-ui",
  "Georgia",
  "Times New Roman",
  "Courier New",
];

/** Map a friendly font name to a CSS stack with sensible canvas fallbacks. */
const FONT_STACKS: Record<string, string> = {
  "Helvetica Neue": '"Helvetica Neue", Arial, sans-serif',
  Arial: "Arial, sans-serif",
  Inter: 'Inter, "Helvetica Neue", Arial, sans-serif',
  "system-ui": "system-ui, -apple-system, sans-serif",
  Georgia: 'Georgia, "Times New Roman", serif',
  "Times New Roman": '"Times New Roman", Georgia, serif',
  "Courier New": '"Courier New", monospace',
};

function fontStack(name: string): string {
  return FONT_STACKS[name] ?? `"${name}", sans-serif`;
}

interface LockupSpec {
  eyebrowText: string;
  headlineText: string;
  taglineText: string;
  eyebrowFont: string;
  bodyFont: string;
  eyebrowSize: number;
  headlineSize: number;
  taglineSize: number;
  headlineWeight: string;
}

function buildLockupTexture(s: LockupSpec): THREE.CanvasTexture {
  const w = 2048;
  const h = 1024;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const eyebrow = fontStack(s.eyebrowFont);
  const body = fontStack(s.bodyFont);
  ctx.font = `italic ${s.eyebrowSize}px ${eyebrow}`;
  ctx.fillText(s.eyebrowText, w / 2, h * 0.31);
  ctx.font = `${s.headlineWeight} ${s.headlineSize}px ${body}`;
  ctx.fillText(s.headlineText, w / 2, h * 0.52);
  ctx.font = `600 ${s.taglineSize}px ${body}`;
  ctx.fillText(s.taglineText, w / 2, h * 0.73);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  return tex;
}

function TextLayerComponent({ layer, values, ctx }: LayerComponentProps) {
  const v = values as unknown as TextValues;
  const meshRef = useRef<THREE.Mesh | null>(null);
  const matRef = useRef<THREE.MeshBasicMaterial | null>(null);

  // Rebuild the lockup whenever the text / font / size params change so editing
  // the copy or typeface updates the rendered texture live.
  const tex = useMemo(
    () =>
      buildLockupTexture({
        eyebrowText: v.eyebrowText,
        headlineText: v.headlineText,
        taglineText: v.taglineText,
        eyebrowFont: v.eyebrowFont,
        bodyFont: v.bodyFont,
        eyebrowSize: v.eyebrowSize,
        headlineSize: v.headlineSize,
        taglineSize: v.taglineSize,
        headlineWeight: v.headlineWeight,
      }),
    [
      v.eyebrowText,
      v.headlineText,
      v.taglineText,
      v.eyebrowFont,
      v.bodyFont,
      v.eyebrowSize,
      v.headlineSize,
      v.taglineSize,
      v.headlineWeight,
    ],
  );

  // Free GPU resources when the texture is replaced (param edit) or on unmount.
  // Spec section 8: Safari caps WebGL contexts; never leak textures.
  useEffect(() => () => tex.dispose(), [tex]);

  const startedAt = useRef<number | null>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (startedAt.current === null) startedAt.current = t;
    const dur = Math.max(0.001, v.reveal);
    const raw = ctx.reduce ? 1 : Math.min(1, (t - startedAt.current) / dur);
    const e = 1 - Math.pow(1 - raw, 3);
    if (matRef.current) matRef.current.opacity = e;
    if (meshRef.current) {
      const s = THREE.MathUtils.lerp(1.1, 1.0, e);
      meshRef.current.scale.set(s, s, 1);
      const tx = ctx.reduce ? 0 : state.pointer.x * v.parallax;
      const ty = ctx.reduce ? 0 : state.pointer.y * v.parallax * 0.62;
      meshRef.current.position.x += (tx - meshRef.current.position.x) * 0.05;
      meshRef.current.position.y += (ty - meshRef.current.position.y) * 0.05;
    }
  });

  return (
    <mesh
      ref={(m) => {
        meshRef.current = m;
        ctx.registerObject(layer.id, m);
      }}
    >
      <planeGeometry args={[v.width, v.height]} />
      <meshBasicMaterial
        ref={matRef}
        map={tex}
        transparent
        opacity={0}
        depthWrite={false}
        toneMapped={false}
        color={v.color}
      />
    </mesh>
  );
}

const TEXT_DEFAULT_PARAMS: ParamsSchema = {
  eyebrowText: { type: "string", value: "Introducing", label: "eyebrow" },
  headlineText: { type: "string", value: "Lumitra", label: "headline" },
  taglineText: {
    type: "string",
    value: "we bring your project to life",
    label: "tagline",
  },
  eyebrowFont: { type: "select", value: "Georgia", options: FONT_OPTIONS, label: "eyebrow font" },
  bodyFont: { type: "select", value: "Helvetica Neue", options: FONT_OPTIONS, label: "body font" },
  headlineWeight: {
    type: "select",
    value: "500",
    options: ["300", "400", "500", "600", "700", "800"],
    label: "headline weight",
  },
  eyebrowSize: { type: "number", value: 88, min: 30, max: 200, step: 2, label: "eyebrow size" },
  headlineSize: { type: "number", value: 300, min: 80, max: 480, step: 10, label: "headline size" },
  taglineSize: { type: "number", value: 60, min: 24, max: 160, step: 2, label: "tagline size" },
  color: { type: "color", value: "#dfe6ff" },
  width: { type: "number", value: 5, min: 2, max: 9, step: 0.1 },
  height: { type: "number", value: 2.5, min: 1, max: 5, step: 0.1 },
  reveal: { type: "number", value: 2, min: 0, max: 5, step: 0.1 },
  parallax: { type: "number", value: 0.16, min: 0, max: 0.6, step: 0.01 },
};

export const TextLayer: LayerDefinition = {
  type: "text",
  kind: "content",
  label: "Text Lockup",
  defaultParams: TEXT_DEFAULT_PARAMS,
  Component: TextLayerComponent,
};
