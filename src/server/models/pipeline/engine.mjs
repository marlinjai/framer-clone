// src/server/models/pipeline/engine.mjs
//
// The validator and the safe re-encoder of the model upload (3D plan S2, steps 2, 5 and 6), as plain
// ES module functions of bytes. Plain JavaScript and no `@/` imports on purpose: worker.mjs runs this
// inside a worker thread that cannot load TypeScript or the app's path aliases. The limits arrive as
// an argument (from DECODED_LIMITS in uploadModel.ts), so there is one list of numbers, not two.
//
// Offline and credential free: the only inputs are the bytes and the installed libraries.
//
// ORDER matters for the decompression bombs this has to survive (all checked BEFORE anything is
// allocated from a declared size):
//   1  the container's JSON is read without decoding any accessor (NodeIO.binaryToJSON);
//   2  Draco is refused (no decoder is installed, so it cannot be measured, so it is not accepted);
//   3  the DECODED size every accessor and every meshopt buffer view declares is summed and capped;
//   4  every texture's pixel size is read from its header (sharp metadata, never a decode) and capped
//      per side, per image and in total;
//   5  only then is the model decoded into memory, measured, rewritten and written;
//   6  the written file is read back and measured again: the output is checked, not trusted.

import validator from 'gltf-validator';
import sharp from 'sharp';
import { Document, NodeIO } from '@gltf-transform/core';
import {
  EXTMeshoptCompression, EXTTextureWebP, KHRMaterialsClearcoat, KHRMaterialsEmissiveStrength, KHRMaterialsIOR,
  KHRMaterialsSpecular, KHRMaterialsTransmission, KHRMaterialsVariants, KHRMeshQuantization, KHRTextureTransform,
} from '@gltf-transform/extensions';
import { dedup, getBounds, meshopt, prune, quantize, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

/** A model the pipeline refuses on purpose (too big once decoded, not decodable). Carries the HTTP status the upload answers. */
export class ModelRefusal extends Error {
  constructor(code, message, status = 413) {
    super(message);
    this.name = 'ModelRefusal';
    this.code = code;
    this.status = status;
  }
}

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/** Libraries are configured once per process: no cache, one thread, so a worker's memory use stays predictable. */
let configured = false;
function configure() {
  if (configured) return;
  configured = true;
  sharp.cache(false);
  sharp.concurrency(1);
}

function io() {
  configure();
  return new NodeIO()
    .registerExtensions([
      EXTMeshoptCompression, EXTTextureWebP, KHRMaterialsClearcoat, KHRMaterialsEmissiveStrength, KHRMaterialsIOR,
      KHRMaterialsSpecular, KHRMaterialsTransmission, KHRMaterialsVariants, KHRMeshQuantization, KHRTextureTransform,
    ])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

const whole = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/**
 * Step 3a: counts and depth from the JSON alone, before anything is allocated for them. A file of a
 * few megabytes can name a million nodes or a chain a hundred thousand deep; both are refused here.
 */
export function checkDeclaredCounts(json, limits) {
  const list = (key) => (Array.isArray(json[key]) ? json[key] : []);
  const caps = [['nodes', limits.nodes], ['meshes', limits.meshes], ['materials', limits.materials], ['textures', limits.textures], ['images', limits.images], ['animations', limits.clips]];
  for (const [key, cap] of caps) {
    if (list(key).length > cap) throw new ModelRefusal('model-too-complex', `the model has ${list(key).length} ${key}, at most ${cap} are allowed`);
  }
  for (const [i, skin] of list('skins').entries()) {
    if (Array.isArray(skin?.joints) && skin.joints.length > limits.bones) throw new ModelRefusal('model-too-complex', `skins[${i}] has ${skin.joints.length} bones, at most ${limits.bones} are allowed`);
  }
  const nodes = list('nodes');
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => { for (const c of Array.isArray(n?.children) ? n.children : []) if (whole(c) && c < nodes.length) parent[c] = i; });
  for (let i = 0; i < nodes.length; i++) {
    let depth = 1;
    for (let cur = i; parent[cur] !== -1; cur = parent[cur]) {
      if (++depth > limits.nodeDepth) throw new ModelRefusal('model-too-complex', `the node tree is deeper than ${limits.nodeDepth} levels`);
    }
  }
}

/** Step 3b: what the file says it will decode to, summed from the JSON alone. */
export function declaredDecodedBytes(json, limits) {
  let total = 0;
  for (const [i, a] of (json.accessors ?? []).entries()) {
    const cb = COMPONENT_BYTES[a?.componentType];
    const n = COMPONENTS[a?.type];
    if (!cb || !n || !whole(a.count)) throw new ModelRefusal('model-too-complex', `accessor ${i} is not described properly`, 422);
    const bytes = a.count * n * cb;
    if (bytes > limits.decodedBytes) throw new ModelRefusal('model-too-complex', `accessor ${i} declares ${bytes} decoded bytes, at most ${limits.decodedBytes} are allowed`);
    total += bytes;
  }
  for (const [i, v] of (json.bufferViews ?? []).entries()) {
    const ext = v?.extensions?.EXT_meshopt_compression;
    if (!ext) continue;
    if (!whole(ext.count) || !whole(ext.byteStride)) throw new ModelRefusal('model-too-complex', `bufferView ${i} is not described properly`, 422);
    const bytes = ext.count * ext.byteStride;
    if (bytes > limits.decodedBytes) throw new ModelRefusal('model-too-complex', `bufferView ${i} declares ${bytes} decoded bytes, at most ${limits.decodedBytes} are allowed`);
    total += bytes;
  }
  if (total > limits.decodedBytes) throw new ModelRefusal('model-too-complex', `the model declares ${total} decoded bytes, at most ${limits.decodedBytes} are allowed`);
  return total;
}

/** Step 4: the pixel size of every image from its header, refusing a bomb before any pixel is decoded. */
async function textureSizes(images, limits) {
  let pixels = 0;
  let side = 0;
  for (const [i, bytes] of images.entries()) {
    let meta;
    try { meta = await sharp(bytes, { limitInputPixels: limits.textureSide * limits.textureSide }).metadata(); }
    catch { throw new ModelRefusal('invalid-model', `texture ${i} cannot be read as an image`, 422); }
    if (!['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages ?? 1) !== 1) throw new ModelRefusal('model-too-complex', `texture ${i} is a ${meta.format ?? 'unknown'} image: only single png, jpeg or webp images are accepted`, 422);
    if (!meta.width || !meta.height) throw new ModelRefusal('model-too-complex', `texture ${i} has no readable size`, 422);
    side = Math.max(side, meta.width, meta.height);
    if (meta.width > limits.textureSide || meta.height > limits.textureSide) throw new ModelRefusal('model-too-complex', `a texture is ${Math.max(meta.width, meta.height)} pixels on a side, at most ${limits.textureSide} are allowed`);
    pixels += meta.width * meta.height;
    if (pixels > limits.totalTexturePixels) throw new ModelRefusal('model-too-complex', `the textures add up to more than ${limits.totalTexturePixels} pixels`);
  }
  return side;
}

/** Triangles drawn, not stored: a mesh counts once for every node that places it, so 1,000 instances of one mesh are 1,000 meshes. */
function trianglesOf(doc) {
  const perMesh = new Map();
  for (const mesh of doc.getRoot().listMeshes()) {
    let triangles = 0;
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      const position = prim.getAttribute('POSITION');
      const n = indices ? indices.getCount() : position ? position.getCount() : 0;
      const mode = prim.getMode();
      // Points and lines are counted as triangles' worth of primitives, so a 5-million-point cloud is not free.
      triangles += mode === 4 ? Math.floor(n / 3) : mode === 5 || mode === 6 ? Math.max(0, n - 2) : mode === 0 ? n : mode === 1 ? Math.floor(n / 2) : mode === 2 ? n : mode === 3 ? Math.max(0, n - 1) : 0;
    }
    perMesh.set(mesh, triangles);
  }
  let drawn = 0;
  const stack = [];
  for (const scene of doc.getRoot().listScenes()) stack.push(...scene.listChildren());
  while (stack.length) {
    const node = stack.pop();
    const mesh = node.getMesh();
    if (mesh) drawn += perMesh.get(mesh) ?? 0;
    stack.push(...node.listChildren());
  }
  // A mesh no scene reaches is never drawn, but it is still decoded and stored: count it once.
  const placed = new Set();
  for (const scene of doc.getRoot().listScenes()) scene.traverse((n) => { if (n.getMesh()) placed.add(n.getMesh()); });
  for (const [mesh, t] of perMesh) if (!placed.has(mesh)) drawn += t;
  return drawn;
}

/** The rest-pose box of what each scene draws. Skinning, morph deltas and animation are not sampled: the box is the model's resting size. */
function boundingBox(doc) {
  const size = [0, 0, 0];
  for (const scene of doc.getRoot().listScenes()) {
    const { min, max } = getBounds(scene);
    for (let k = 0; k < 3; k++) size[k] = Math.max(size[k], max[k] - min[k]);
  }
  return size;
}

async function measure(doc, limits) {
  const images = doc.getRoot().listTextures().map((t) => t.getImage()).filter(Boolean);
  return {
    triangles: trianglesOf(doc),
    maxTextureSide: await textureSizes(images, limits),
    boundingBox: boundingBox(doc),
    materials: doc.getRoot().listMaterials().length,
    nodes: doc.getRoot().listNodes().length,
    clips: doc.getRoot().listAnimations().length,
  };
}

/** Step 2: the Khronos validator. External resources are never fetched. */
export async function validateModel(bytes) {
  let report;
  try {
    report = await validator.validateBytes(bytes, {
      // Unlimited: an issue limit also counts infos and hints, so a valid, noisy export would trip it. The input is
      // already bounded (JSON size, counts) and so is the run (the worker's time cap). A report that is somehow cut
      // off is still refused below.
      maxIssues: 0,
      externalResourceFunction: () => Promise.reject(new Error('external resources are refused')),
    });
  } catch (err) {
    return { ok: false, message: `the file could not be read (${String(err?.message ?? err).slice(0, 120)})` };
  }
  // A report that stopped at its issue limit has not been read to the end: later errors are unseen, so it is not a pass.
  if (report.issues.truncated) return { ok: false, message: 'the validator report was cut off, so the file was not checked to the end' };
  if (report.issues.numErrors > 0) {
    const first = report.issues.messages.find((m) => m.severity === 0);
    return { ok: false, message: `${first?.code ?? 'INVALID'}${first?.pointer ? ` at ${first.pointer}` : ''}: ${first?.message ?? 'invalid glTF'}`.slice(0, 300) };
  }
  return { ok: true };
}

/** Steps 3 to 6. Returns the re-encoded file and what was measured on the input and on the written output. */
export async function reencodeModel(bytes, limits) {
  const gltf = io();
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;

  // A GLB, or a glTF text file whose buffers and images are `data:` addresses (the structure guard has refused
  // anything that points outside the file). Both are read the same way from here on.
  let jsonDoc;
  try {
    jsonDoc = bytes[0] === 0x7b
      ? { json: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)), resources: {} }
      : await gltf.binaryToJSON(bytes);
  } catch { throw new ModelRefusal('invalid-model', 'the file could not be read', 422); }
  const json = jsonDoc.json;
  const used = [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])];
  if (used.includes('KHR_draco_mesh_compression')) {
    throw new ModelRefusal('model-too-complex', 'Draco-compressed models are not supported yet: export the model without compression, or with meshopt', 422);
  }
  checkDeclaredCounts(json, limits);
  declaredDecodedBytes(json, limits);

  let doc;
  try { doc = await gltf.readJSON(jsonDoc); }
  catch { throw new ModelRefusal('invalid-model', 'the file could not be decoded', 422); }
  const input = await measure(doc, limits);

  await doc.transform(
    dedup(), prune(), weld(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [limits.outputTextureSide, limits.outputTextureSide] }),
    quantize(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  const out = await gltf.writeBinary(doc);

  // The output is read back and measured as if it were an upload: what is served is checked.
  let readBack;
  try { readBack = await gltf.readBinary(out); }
  catch { throw new ModelRefusal('reencode-failed', 'the optimised model could not be read back', 500); }
  const output = await measure(readBack, { ...limits, textureSide: limits.outputTextureSide });
  return { bytes: out, input, output };
}

export { Document };
