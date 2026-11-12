// src/lib/scene/glb.ts
//
// A structure guard for an uploaded 3D model file (GLB, or glTF with embedded buffers),
// slice S2a of docs/plans/2026-11-02-3d-scene-primitive.md ("Upload, validation and
// re-encoding", steps 1, 3 and 4 and the structural part of step 5).
//
// IT IS NOT UPLOAD SECURITY. It reads only the container and the JSON, with no
// dependency and no decoder, and answers one question: is this file shaped like a
// model that reaches nowhere and stays inside the plan's counts? It does NOT:
//   - run the Khronos glTF validator (step 2);
//   - decode Draco or meshopt data, or count triangles, or bound the decoded size of
//     geometry and textures, or check texture pixel sizes, or check the bounding box
//     (step 5, which needs a decoder);
//   - re-encode anything (step 6), store anything (step 7), or enforce the byte
//     quotas per model, scene and site;
//   - run in a worker with a time and memory limit (it is synchronous and its own cost
//     is bounded by MAX_FILE_BYTES and MAX_JSON_BYTES, not by a deadline).
// Those stay with the complete upload flow (slice S2). A file this guard accepts must
// still go through all of them before it is stored or served.
//
// PURE: no React, no DOM, no network, no Node-only API (TextDecoder is global in both).

/** Step 1: at most 50 megabytes are read. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** The JSON chunk is parsed, so it is capped (guard's own bound, not in the plan). */
export const MAX_JSON_BYTES = 4 * 1024 * 1024;

/** Step 4: the extensions a model may use. Anything else refuses, used or required. */
export const ALLOWED_EXTENSIONS: readonly string[] = [
  'KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_mesh_quantization',
  'KHR_materials_clearcoat', 'KHR_materials_transmission', 'KHR_materials_ior', 'KHR_materials_specular',
  'KHR_materials_emissive_strength', 'KHR_materials_variants', 'KHR_texture_transform', 'EXT_texture_webp',
];

/** Step 5's structural caps (counts, not decoded sizes), plus the guard's own bounds marked below. */
export const GLB_LIMITS = {
  meshes: 256,
  materials: 64,
  textures: 16,
  images: 16,
  nodes: 1000,
  nodeDepth: 32,
  animations: 32,
  bones: 128,
  /** Guard's own bounds, so a hostile file cannot make the checks themselves expensive. */
  scenes: 16,
  accessors: 8192,
  bufferViews: 8192,
  buffers: 16,
  jsonDepth: 64,
} as const;

export interface GlbSummary {
  container: 'glb' | 'gltf';
  fileBytes: number;
  jsonBytes: number;
  /** Declared bytes of the buffers (the BIN chunk or the embedded ones). */
  bufferBytes: number;
  counts: { nodes: number; meshes: number; materials: number; textures: number; images: number; animations: number; bones: number };
  extensionsUsed: string[];
}

export type GlbCheck = { ok: true; summary: GlbSummary } | { ok: false; code: GlbRefusalCode; message: string };

export type GlbRefusalCode =
  | 'too-large' | 'not-a-model' | 'bad-header' | 'bad-chunk' | 'bad-json' | 'bad-structure'
  | 'external-reference' | 'extension' | 'too-many' | 'too-deep' | 'bad-buffer';

class Refusal extends Error {
  constructor(readonly code: GlbRefusalCode, message: string) { super(message); }
}
const refuse = (code: GlbRefusalCode, message: string): never => { throw new Refusal(code, message); };

const MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o: Rec, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/** A `data:` address carrying base64 inside the file; anything else reaches out. */
const DATA_URI = /^data:[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[A-Za-z0-9=._-]+)*;base64,([A-Za-z0-9+/]*={0,2})$/;

function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** Whole non-negative number within the safe range, or a refusal. */
function whole(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return refuse('bad-structure', `${what} must be a whole number, 0 or more`);
  return v;
}

function listOf(json: Rec, key: string, max: number): unknown[] {
  const v = own(json, key);
  if (v === undefined) return [];
  if (!Array.isArray(v)) return refuse('bad-structure', `${key} must be a list`);
  if (v.length > max) return refuse('too-many', `${key} has ${v.length} entries, at most ${max} are allowed`);
  return v;
}

/**
 * Walk the whole JSON once: every number finite (JSON can still say 1e999), nesting
 * bounded, and every `extensions` key on any object checked against the allow-list.
 * Iterative, so depth costs no stack.
 */
function walk(root: unknown, used: Set<string>): void {
  const stack: { v: unknown; d: number }[] = [{ v: root, d: 0 }];
  while (stack.length) {
    const { v, d } = stack.pop()!;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) refuse('bad-structure', 'a number in the file is not finite');
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    if (d > GLB_LIMITS.jsonDepth) refuse('too-deep', `the JSON nests deeper than ${GLB_LIMITS.jsonDepth} levels`);
    if (Array.isArray(v)) { for (const x of v) stack.push({ v: x, d: d + 1 }); continue; }
    for (const [k, x] of Object.entries(v)) {
      if (k === 'extensions' && isRec(x)) for (const name of Object.keys(x)) used.add(name);
      stack.push({ v: x, d: d + 1 });
    }
  }
}

function checkExtensions(json: Rec, found: Set<string>): string[] {
  const declared = new Set<string>();
  for (const key of ['extensionsUsed', 'extensionsRequired'] as const) {
    const list = own(json, key);
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 64 || !list.every((x) => typeof x === 'string')) refuse('bad-structure', `${key} must be a short list of names`);
    for (const name of list as string[]) declared.add(name);
  }
  for (const name of [...declared, ...found]) {
    if (!ALLOWED_EXTENSIONS.includes(name)) refuse('extension', `the extension ${JSON.stringify(name.slice(0, 80))} is not allowed`);
  }
  return [...new Set([...declared, ...found])].sort();
}

/** An external address is anything but absent or a base64 `data:` address inside the file. Returns the embedded byte count. */
function embedded(uri: unknown, what: string): number | null {
  if (uri === undefined) return null;
  if (typeof uri !== 'string') return refuse('bad-structure', `${what}.uri must be text`);
  const m = DATA_URI.exec(uri);
  if (!m) return refuse('external-reference', `${what}.uri reaches outside the file; only an absent uri or a base64 data address inside the file is allowed`);
  return base64Bytes(m[1]);
}

/** Node graph: valid indexes, a forest (one parent each), no cycle, depth within the cap. */
function checkNodes(nodes: unknown[]): void {
  const parent = new Array<number>(nodes.length).fill(-1);
  nodes.forEach((n, i) => {
    if (!isRec(n)) return refuse('bad-structure', `nodes[${i}] must be an object`);
    const children = own(n, 'children');
    if (children === undefined) return;
    if (!Array.isArray(children) || children.length > nodes.length) return refuse('bad-structure', `nodes[${i}].children must be a list of node indexes`);
    for (const c of children) {
      const idx = whole(c, `nodes[${i}].children`);
      if (idx >= nodes.length) refuse('bad-structure', `nodes[${i}] names a child that does not exist`);
      if (idx === i || parent[idx] !== -1) refuse('bad-structure', `nodes[${idx}] has more than one parent or is its own parent`);
      parent[idx] = i;
    }
  });
  const depth = new Array<number>(nodes.length).fill(0);
  for (let i = 0; i < nodes.length; i++) {
    let d = 0;
    let cur = i;
    while (parent[cur] !== -1) {
      cur = parent[cur];
      d++;
      if (d > nodes.length) refuse('bad-structure', 'the node tree contains a cycle');
    }
    depth[i] = d;
    if (d + 1 > GLB_LIMITS.nodeDepth) refuse('too-deep', `the node tree is deeper than ${GLB_LIMITS.nodeDepth} levels`);
  }
}

function checkJson(json: Rec, bin: number | null, container: 'glb' | 'gltf', fileBytes: number, jsonBytes: number): GlbSummary {
  const asset = own(json, 'asset');
  const version = isRec(asset) ? own(asset, 'version') : undefined;
  if (typeof version !== 'string' || !/^2\.\d+$/.test(version)) refuse('bad-structure', 'asset.version must be 2.x');

  const found = new Set<string>();
  walk(json, found);
  const extensionsUsed = checkExtensions(json, found);

  const nodes = listOf(json, 'nodes', GLB_LIMITS.nodes);
  const meshes = listOf(json, 'meshes', GLB_LIMITS.meshes);
  const materials = listOf(json, 'materials', GLB_LIMITS.materials);
  const textures = listOf(json, 'textures', GLB_LIMITS.textures);
  const images = listOf(json, 'images', GLB_LIMITS.images);
  const animations = listOf(json, 'animations', GLB_LIMITS.animations);
  const skins = listOf(json, 'skins', GLB_LIMITS.nodes);
  listOf(json, 'scenes', GLB_LIMITS.scenes);
  listOf(json, 'accessors', GLB_LIMITS.accessors);
  const views = listOf(json, 'bufferViews', GLB_LIMITS.bufferViews);
  const buffers = listOf(json, 'buffers', GLB_LIMITS.buffers);

  let bones = 0;
  skins.forEach((s, i) => {
    const joints = isRec(s) ? own(s, 'joints') : undefined;
    if (!Array.isArray(joints)) return refuse('bad-structure', `skins[${i}].joints must be a list`);
    if (joints.length > GLB_LIMITS.bones) refuse('too-many', `skins[${i}] has ${joints.length} bones, at most ${GLB_LIMITS.bones} are allowed`);
    bones = Math.max(bones, joints.length);
  });
  checkNodes(nodes);

  // Buffers: the first may be the GLB's BIN chunk (no uri); every other one must be embedded.
  const sizes: number[] = [];
  buffers.forEach((b, i) => {
    if (!isRec(b)) return refuse('bad-structure', `buffers[${i}] must be an object`);
    const declared = whole(own(b, 'byteLength'), `buffers[${i}].byteLength`);
    const data = embedded(own(b, 'uri'), `buffers[${i}]`);
    if (data === null) {
      if (container !== 'glb' || i !== 0) return refuse('bad-buffer', `buffers[${i}] has no uri: only the first buffer of a GLB can be the binary chunk`);
      if (bin === null) return refuse('bad-buffer', 'buffers[0] needs the GLB binary chunk, which is missing');
      if (declared > bin || bin - declared > 3) return refuse('bad-buffer', `buffers[0].byteLength (${declared}) does not match the binary chunk (${bin})`);
    } else if (data < declared) {
      return refuse('bad-buffer', `buffers[${i}] embeds ${data} bytes but declares ${declared}`);
    }
    sizes.push(declared);
  });
  if (bin !== null && (buffers.length === 0 || own(buffers[0] as Rec, 'uri') !== undefined)) refuse('bad-buffer', 'the GLB has a binary chunk that no buffer uses');

  views.forEach((v, i) => {
    if (!isRec(v)) return refuse('bad-structure', `bufferViews[${i}] must be an object`);
    const buffer = whole(own(v, 'buffer'), `bufferViews[${i}].buffer`);
    if (buffer >= sizes.length) return refuse('bad-structure', `bufferViews[${i}] names a buffer that does not exist`);
    const offset = own(v, 'byteOffset') === undefined ? 0 : whole(own(v, 'byteOffset'), `bufferViews[${i}].byteOffset`);
    const length = whole(own(v, 'byteLength'), `bufferViews[${i}].byteLength`);
    if (offset + length > sizes[buffer]) refuse('bad-buffer', `bufferViews[${i}] runs past the end of its buffer`);
  });

  images.forEach((img, i) => {
    if (!isRec(img)) return refuse('bad-structure', `images[${i}] must be an object`);
    const data = embedded(own(img, 'uri'), `images[${i}]`);
    const view = own(img, 'bufferView');
    if (data === null && view === undefined) refuse('bad-structure', `images[${i}] has neither a bufferView nor an embedded uri`);
    if (view !== undefined && whole(view, `images[${i}].bufferView`) >= views.length) refuse('bad-structure', `images[${i}] names a bufferView that does not exist`);
  });

  return {
    container, fileBytes, jsonBytes,
    bufferBytes: sizes.reduce((a, b) => a + b, 0),
    counts: { nodes: nodes.length, meshes: meshes.length, materials: materials.length, textures: textures.length, images: images.length, animations: animations.length, bones },
    extensionsUsed,
  };
}

function parseJson(bytes: Uint8Array): Rec {
  if (bytes.length > MAX_JSON_BYTES) return refuse('too-large', `the JSON part is ${bytes.length} bytes, at most ${MAX_JSON_BYTES} are allowed`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return refuse('bad-json', 'the JSON part is not valid UTF-8'); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return refuse('bad-json', 'the JSON part does not parse'); }
  if (!isRec(value)) return refuse('bad-json', 'the JSON part must be an object');
  return value;
}

/** Check the container and structure of an uploaded model. Never throws; see the header for what it does not do. */
export function checkGlb(bytes: Uint8Array): GlbCheck {
  try {
    // isView, not instanceof: a typed array from another realm (a worker, a test DOM) is still bytes.
    if (!ArrayBuffer.isView(bytes) || bytes.byteLength !== (bytes as Uint8Array).length) return refuse('not-a-model', 'the input must be bytes');
    if (bytes.length > MAX_FILE_BYTES) return refuse('too-large', `the file is ${bytes.length} bytes, at most ${MAX_FILE_BYTES} are read`);
    if (bytes.length < 12) return refuse('not-a-model', 'the file is too short to be a model');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (view.getUint32(0, true) !== MAGIC) {
      // glTF with embedded buffers: JSON text from the first byte.
      if (bytes[0] !== 0x7b) return refuse('not-a-model', 'neither a GLB header nor JSON');
      const json = parseJson(bytes);
      return { ok: true, summary: checkJson(json, null, 'gltf', bytes.length, bytes.length) };
    }

    if (view.getUint32(4, true) !== 2) return refuse('bad-header', 'only GLB version 2 is read');
    if (view.getUint32(8, true) !== bytes.length) return refuse('bad-header', 'the length in the header does not match the file');

    let offset = 12;
    let json: Rec | null = null;
    let jsonBytes = 0;
    let bin: number | null = null;
    let index = 0;
    while (offset < bytes.length) {
      if (bytes.length - offset < 8) return refuse('bad-chunk', 'a chunk header is cut off');
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (length % 4 !== 0) return refuse('bad-chunk', `chunk ${index} is not padded to 4 bytes`);
      if (length > bytes.length - start) return refuse('bad-chunk', `chunk ${index} runs past the end of the file`);
      if (index === 0) {
        if (type !== CHUNK_JSON) return refuse('bad-chunk', 'the first chunk must be JSON');
        json = parseJson(bytes.subarray(start, start + length));
        jsonBytes = length;
      } else if (index === 1 && type === CHUNK_BIN) {
        bin = length;
      } else {
        return refuse('bad-chunk', `chunk ${index} is not allowed: a GLB here is one JSON chunk and at most one binary chunk`);
      }
      offset = start + length;
      index++;
    }
    if (!json) return refuse('bad-chunk', 'the file has no JSON chunk');
    return { ok: true, summary: checkJson(json, bin, 'glb', bytes.length, jsonBytes) };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: 'bad-structure', message: 'the file could not be read' };
  }
}
