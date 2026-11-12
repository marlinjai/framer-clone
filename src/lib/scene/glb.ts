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
//   - read accessor contents, component types or sparse payloads (only that every index points at
//     something that exists).
// Duplicate JSON keys are REFUSED (see duplicateKey): parsers disagree on them (JSON.parse keeps the
// last, a streaming or first-wins reader keeps the first), so a file could show this guard an empty
// `buffers` list and a downstream reader another with an external address. Until the upload flow is
// proven to hand the downstream stages exactly the object this guard read, refusing them closes that gap.
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
  primitivesPerMesh: 64,
  primitives: 1024,
  morphTargets: 64,
  samplers: 256,
  channelsPerAnimation: 1024,
  extensionNames: 64,
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
const DATA_URI = /^data:([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+)(?:;[A-Za-z0-9=._-]+)*;base64,([A-Za-z0-9+/]*={0,2})$/;
const BUFFER_TYPES: readonly string[] = ['application/octet-stream', 'application/gltf-buffer'];
const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];

function base64Bytes(b64: string): number {
  // A strict decoder (atob) refuses a length that is not a multiple of 4; so does this.
  if (b64.length === 0 || b64.length % 4 !== 0) return refuse('external-reference', 'an embedded data address is not valid base64');
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
  // Parallel stacks, and only objects and arrays are pushed: a primitive is checked where it is found.
  const values: unknown[] = [root];
  const depths: number[] = [0];
  const inExtras: boolean[] = [false];
  while (values.length) {
    const v = values.pop();
    const d = depths.pop()!;
    const extras = inExtras.pop()!;
    if (d > GLB_LIMITS.jsonDepth) refuse('too-deep', `the JSON nests deeper than ${GLB_LIMITS.jsonDepth} levels`);
    const push = (x: unknown, ex: boolean) => {
      if (typeof x === 'number') { if (!Number.isFinite(x)) refuse('bad-structure', 'a number in the file is not finite'); return; }
      if (x && typeof x === 'object') { values.push(x); depths.push(d + 1); inExtras.push(ex); }
    };
    if (Array.isArray(v)) { for (const x of v) push(x, extras); continue; }
    for (const k in v as Rec) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      const x = (v as Rec)[k];
      // `extras` is application data: an `extensions` key inside it is not an extension block.
      if (k === 'extensions' && !extras && isRec(x)) {
        for (const name of Object.keys(x)) {
          if (!ALLOWED_EXTENSIONS.includes(name)) refuse('extension', `the extension ${JSON.stringify(name.slice(0, 80))} is not allowed`);
          used.add(name);
        }
      }
      push(x, extras || k === 'extras');
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
  if (declared.size > GLB_LIMITS.extensionNames) refuse('bad-structure', 'too many extension names');
  for (const name of [...declared, ...found]) {
    if (!ALLOWED_EXTENSIONS.includes(name)) refuse('extension', `the extension ${JSON.stringify(name.slice(0, 80))} is not allowed`);
  }
  return [...new Set([...declared, ...found])].sort();
}

/** An external address is anything but absent or a base64 `data:` address inside the file. Returns the embedded byte count. */
function embedded(uri: unknown, what: string, types: readonly string[]): number | null {
  if (uri === undefined) return null;
  if (typeof uri !== 'string') return refuse('bad-structure', `${what}.uri must be text`);
  const m = DATA_URI.exec(uri);
  if (!m) return refuse('external-reference', `${what}.uri reaches outside the file; only an absent uri or a base64 data address inside the file is allowed`);
  if (!types.includes(m[1].toLowerCase())) return refuse('external-reference', `${what}.uri carries ${m[1].slice(0, 60)}, which is not an allowed type (${types.join(', ')})`);
  return base64Bytes(m[2]);
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


interface Lists {
  nodes: unknown[]; meshes: unknown[]; materials: unknown[]; textures: unknown[]; images: unknown[]; skins: unknown[];
  views: unknown[]; scenes: unknown[]; accessors: unknown[]; samplers: unknown[]; animations: unknown[];
}

/**
 * Every index a later consumer would trust, checked against the list it names, and the
 * counts inside lists (primitives, morph targets, animation channels). It does not read
 * accessor contents or check component types: that is the validator's job (S2 step 2).
 */
function checkReferences(json: Rec, l: Lists): void {
  const idx = (v: unknown, max: number, what: string): void => {
    if (whole(v, what) >= max) refuse('bad-structure', `${what} names something that does not exist`);
  };
  const optIdx = (o: Rec, key: string, max: number, what: string): void => { if (own(o, key) !== undefined) idx(own(o, key), max, `${what}.${key}`); };
  const rec = (v: unknown, what: string): Rec => (isRec(v) ? v : refuse('bad-structure', `${what} must be an object`));

  const sceneIndex = own(json, 'scene');
  if (sceneIndex !== undefined) idx(sceneIndex, l.scenes.length, 'scene');
  l.scenes.forEach((s, i) => {
    const nodes = own(rec(s, `scenes[${i}]`), 'nodes');
    if (nodes === undefined) return;
    if (!Array.isArray(nodes) || nodes.length > l.nodes.length) return refuse('bad-structure', `scenes[${i}].nodes must be a list of node indexes`);
    nodes.forEach((n) => idx(n, l.nodes.length, `scenes[${i}].nodes`));
  });
  l.nodes.forEach((n, i) => {
    const o = n as Rec;
    optIdx(o, 'mesh', l.meshes.length, `nodes[${i}]`);
    optIdx(o, 'skin', l.skins.length, `nodes[${i}]`);
    optIdx(o, 'camera', listOf(json, 'cameras', GLB_LIMITS.nodes).length, `nodes[${i}]`);
  });
  l.skins.forEach((s, i) => {
    const o = s as Rec;
    (own(o, 'joints') as unknown[]).forEach((j) => idx(j, l.nodes.length, `skins[${i}].joints`));
    optIdx(o, 'skeleton', l.nodes.length, `skins[${i}]`);
    optIdx(o, 'inverseBindMatrices', l.accessors.length, `skins[${i}]`);
  });
  l.textures.forEach((t, i) => {
    const o = rec(t, `textures[${i}]`);
    optIdx(o, 'source', l.images.length, `textures[${i}]`);
    optIdx(o, 'sampler', l.samplers.length, `textures[${i}]`);
  });
  l.accessors.forEach((a, i) => {
    const o = rec(a, `accessors[${i}]`);
    optIdx(o, 'bufferView', l.views.length, `accessors[${i}]`);
    whole(own(o, 'count'), `accessors[${i}].count`);
    const sparse = own(o, 'sparse');
    if (isRec(sparse)) for (const part of ['indices', 'values']) {
      const p = own(sparse, part);
      if (!isRec(p)) refuse('bad-structure', `accessors[${i}].sparse.${part} must be an object`);
      else idx(own(p, 'bufferView'), l.views.length, `accessors[${i}].sparse.${part}.bufferView`);
    }
  });

  let primitives = 0;
  l.meshes.forEach((m, i) => {
    const list = own(rec(m, `meshes[${i}]`), 'primitives');
    if (!Array.isArray(list)) return refuse('bad-structure', `meshes[${i}].primitives must be a list`);
    if (list.length > GLB_LIMITS.primitivesPerMesh) refuse('too-many', `meshes[${i}] has ${list.length} primitives, at most ${GLB_LIMITS.primitivesPerMesh} are allowed`);
    primitives += list.length;
    if (primitives > GLB_LIMITS.primitives) refuse('too-many', `the model has more than ${GLB_LIMITS.primitives} primitives`);
    list.forEach((pr, j) => {
      const p = rec(pr, `meshes[${i}].primitives[${j}]`);
      const what = `meshes[${i}].primitives[${j}]`;
      const attrs = own(p, 'attributes');
      if (isRec(attrs)) for (const k of Object.keys(attrs)) idx(attrs[k], l.accessors.length, `${what}.attributes.${k}`);
      optIdx(p, 'indices', l.accessors.length, what);
      optIdx(p, 'material', l.materials.length, what);
      const targets = own(p, 'targets');
      if (targets !== undefined) {
        if (!Array.isArray(targets)) return refuse('bad-structure', `${what}.targets must be a list`);
        if (targets.length > GLB_LIMITS.morphTargets) refuse('too-many', `${what} has ${targets.length} morph targets, at most ${GLB_LIMITS.morphTargets} are allowed`);
        targets.forEach((t, k) => { if (isRec(t)) for (const key of Object.keys(t)) idx(t[key], l.accessors.length, `${what}.targets[${k}].${key}`); });
      }
      const ext = isRec(own(p, 'extensions')) ? (own(p, 'extensions') as Rec) : {};
      const draco = own(ext, 'KHR_draco_mesh_compression');
      if (isRec(draco)) {
        idx(own(draco, 'bufferView'), l.views.length, `${what}.KHR_draco_mesh_compression.bufferView`);
        const da = own(draco, 'attributes');
        if (isRec(da)) for (const k of Object.keys(da)) whole(da[k], `${what}.KHR_draco_mesh_compression.attributes.${k}`);
      }
      const variants = own(ext, 'KHR_materials_variants');
      if (isRec(variants) && Array.isArray(own(variants, 'mappings'))) {
        (own(variants, 'mappings') as unknown[]).forEach((mp) => { if (isRec(mp)) optIdx(mp, 'material', l.materials.length, `${what}.KHR_materials_variants.mappings`); });
      }
    });
  });

  // A texture index anywhere under a material (`baseColorTexture`, `clearcoatTexture` in an extension, ...).
  const texKey = /Texture$/;
  l.materials.forEach((m, i) => {
    const stack: unknown[] = [rec(m, `materials[${i}]`)];
    let budget = 10000;
    while (stack.length && budget-- > 0) {
      const v = stack.pop();
      if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') stack.push(x); continue; }
      for (const k of Object.keys(v as Rec)) {
        const x = (v as Rec)[k];
        if (k === 'extras') continue;
        if (texKey.test(k) && isRec(x)) idx(own(x, 'index'), l.textures.length, `materials[${i}].${k}.index`);
        else if (x && typeof x === 'object') stack.push(x);
      }
    }
  });

  l.animations.forEach((an, i) => {
    const o = rec(an, `animations[${i}]`);
    const chans = own(o, 'channels');
    const samps = own(o, 'samplers');
    if (!Array.isArray(chans) || !Array.isArray(samps)) return refuse('bad-structure', `animations[${i}] needs channels and samplers lists`);
    if (chans.length > GLB_LIMITS.channelsPerAnimation || samps.length > GLB_LIMITS.channelsPerAnimation) refuse('too-many', `animations[${i}] has more than ${GLB_LIMITS.channelsPerAnimation} channels or samplers`);
    chans.forEach((c) => {
      const ch = rec(c, `animations[${i}].channels[]`);
      idx(own(ch, 'sampler'), samps.length, `animations[${i}].channels[].sampler`);
      const target = own(ch, 'target');
      if (isRec(target)) optIdx(target, 'node', l.nodes.length, `animations[${i}].channels[].target`);
    });
    samps.forEach((sm) => {
      const sp = rec(sm, `animations[${i}].samplers[]`);
      idx(own(sp, 'input'), l.accessors.length, `animations[${i}].samplers[].input`);
      idx(own(sp, 'output'), l.accessors.length, `animations[${i}].samplers[].output`);
    });
  });
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
  const scenes = listOf(json, 'scenes', GLB_LIMITS.scenes);
  const accessors = listOf(json, 'accessors', GLB_LIMITS.accessors);
  const samplers = listOf(json, 'samplers', GLB_LIMITS.samplers);
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

  // Buffers: the first may be the GLB's BIN chunk (no uri); every other one must be embedded,
  // except a meshopt fallback buffer, which is declared and never stored.
  const sizes: number[] = [];
  let stored = 0;
  buffers.forEach((b, i) => {
    if (!isRec(b)) return refuse('bad-structure', `buffers[${i}] must be an object`);
    const declared = whole(own(b, 'byteLength'), `buffers[${i}].byteLength`);
    if (declared < 1) return refuse('bad-buffer', `buffers[${i}].byteLength must be at least 1`);
    const data = embedded(own(b, 'uri'), `buffers[${i}]`, BUFFER_TYPES);
    const ext = isRec(own(b, 'extensions')) ? own(own(b, 'extensions') as Rec, 'EXT_meshopt_compression') : undefined;
    const fallback = isRec(ext) && own(ext, 'fallback') === true;
    if (data === null && fallback) {
      sizes.push(declared);
      return;
    }
    if (data === null) {
      if (container !== 'glb' || i !== 0) return refuse('bad-buffer', `buffers[${i}] has no uri: only the first buffer of a GLB can be the binary chunk`);
      if (bin === null) return refuse('bad-buffer', 'buffers[0] needs the GLB binary chunk, which is missing');
      if (declared > bin || bin - declared > 3) return refuse('bad-buffer', `buffers[0].byteLength (${declared}) does not match the binary chunk (${bin})`);
    } else if (data < declared) {
      return refuse('bad-buffer', `buffers[${i}] embeds ${data} bytes but declares ${declared}`);
    }
    stored += declared;
    sizes.push(declared);
  });
  if (bin !== null && (buffers.length === 0 || own(buffers[0] as Rec, 'uri') !== undefined)) refuse('bad-buffer', 'the GLB has a binary chunk that no buffer uses');

  const inBuffer = (buffer: unknown, offset: unknown, length: unknown, what: string): void => {
    const bi = whole(buffer, `${what}.buffer`);
    if (bi >= sizes.length) return refuse('bad-structure', `${what} names a buffer that does not exist`);
    const o = offset === undefined ? 0 : whole(offset, `${what}.byteOffset`);
    const l = whole(length, `${what}.byteLength`);
    if (l < 1) return refuse('bad-buffer', `${what}.byteLength must be at least 1`);
    if (o + l > sizes[bi]) return refuse('bad-buffer', `${what} runs past the end of its buffer`);
  };
  views.forEach((v, i) => {
    if (!isRec(v)) return refuse('bad-structure', `bufferViews[${i}] must be an object`);
    inBuffer(own(v, 'buffer'), own(v, 'byteOffset'), own(v, 'byteLength'), `bufferViews[${i}]`);
    const ext = isRec(own(v, 'extensions')) ? own(own(v, 'extensions') as Rec, 'EXT_meshopt_compression') : undefined;
    if (isRec(ext)) inBuffer(own(ext, 'buffer'), own(ext, 'byteOffset'), own(ext, 'byteLength'), `bufferViews[${i}].EXT_meshopt_compression`);
  });

  images.forEach((img, i) => {
    if (!isRec(img)) return refuse('bad-structure', `images[${i}] must be an object`);
    const data = embedded(own(img, 'uri'), `images[${i}]`, IMAGE_TYPES);
    const view = own(img, 'bufferView');
    if (data === null && view === undefined) refuse('bad-structure', `images[${i}] has neither a bufferView nor an embedded uri`);
    if (data !== null && view !== undefined) refuse('bad-structure', `images[${i}] has both a uri and a bufferView`);
    if (view !== undefined && whole(view, `images[${i}].bufferView`) >= views.length) refuse('bad-structure', `images[${i}] names a bufferView that does not exist`);
    const mime = own(img, 'mimeType');
    if (mime !== undefined && (typeof mime !== 'string' || !IMAGE_TYPES.includes(mime.toLowerCase()))) refuse('bad-structure', `images[${i}].mimeType must be one of ${IMAGE_TYPES.join(', ')}`);
  });

  checkReferences(json, { nodes, meshes, materials, textures, images, skins, views, scenes, accessors, samplers, animations });

  return {
    container, fileBytes, jsonBytes,
    bufferBytes: stored,
    counts: { nodes: nodes.length, meshes: meshes.length, materials: materials.length, textures: textures.length, images: images.length, animations: animations.length, bones },
    extensionsUsed,
  };
}

/**
 * The first object key that appears twice in the same object, after unescaping (so "a" and
 * "\u0061" are the same key), or null. Reads the text of JSON that already parsed, so it
 * only has to follow strings, braces, brackets and commas. Iterative.
 */
export function duplicateKey(text: string): string | null {
  const kinds: boolean[] = []; // true: object, false: array
  const keys: (Set<string> | null)[] = [];
  let expectKey = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      let j = i + 1;
      let escaped = false;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 0x5c) { escaped = true; j += 2; continue; }
        if (d === 0x22) break;
        j++;
      }
      if (expectKey && kinds[kinds.length - 1]) {
        const raw = text.slice(i + 1, j);
        const key = escaped ? (JSON.parse(`"${raw}"`) as string) : raw;
        const seen = keys[keys.length - 1]!;
        if (seen.has(key)) return key;
        seen.add(key);
        expectKey = false;
      }
      i = j;
    } else if (c === 0x7b) { kinds.push(true); keys.push(new Set()); expectKey = true; }
    else if (c === 0x5b) { kinds.push(false); keys.push(null); expectKey = false; }
    else if (c === 0x7d || c === 0x5d) { kinds.pop(); keys.pop(); expectKey = false; }
    else if (c === 0x2c && kinds[kinds.length - 1]) expectKey = true;
  }
  return null;
}

function parseJson(bytes: Uint8Array): Rec {
  if (bytes.length > MAX_JSON_BYTES) return refuse('too-large', `the JSON part is ${bytes.length} bytes, at most ${MAX_JSON_BYTES} are allowed`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return refuse('bad-json', 'the JSON part is not valid UTF-8'); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return refuse('bad-json', 'the JSON part does not parse'); }
  if (!isRec(value)) return refuse('bad-json', 'the JSON part must be an object');
  const duplicate = duplicateKey(text);
  if (duplicate !== null) return refuse('bad-json', `the JSON part repeats the key ${JSON.stringify(duplicate.slice(0, 60))}: parsers disagree on which one counts`);
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
