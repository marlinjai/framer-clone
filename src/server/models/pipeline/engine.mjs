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

/** Step 3: what the file says it will decode to, summed from the JSON alone. */
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
    catch { throw new ModelRefusal('model-too-complex', `texture ${i} is too large or cannot be read`); }
    if (!meta.width || !meta.height) throw new ModelRefusal('model-too-complex', `texture ${i} has no readable size`, 422);
    side = Math.max(side, meta.width, meta.height);
    if (meta.width > limits.textureSide || meta.height > limits.textureSide) throw new ModelRefusal('model-too-complex', `a texture is ${Math.max(meta.width, meta.height)} pixels on a side, at most ${limits.textureSide} are allowed`);
    pixels += meta.width * meta.height;
    if (pixels > limits.totalTexturePixels) throw new ModelRefusal('model-too-complex', `the textures add up to more than ${limits.totalTexturePixels} pixels`);
  }
  return side;
}

function trianglesOf(doc) {
  let triangles = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      const position = prim.getAttribute('POSITION');
      const n = indices ? indices.getCount() : position ? position.getCount() : 0;
      const mode = prim.getMode();
      triangles += mode === 4 ? Math.floor(n / 3) : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0;
    }
  }
  return triangles;
}

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
      maxIssues: 50,
      externalResourceFunction: () => Promise.reject(new Error('external resources are refused')),
    });
  } catch (err) {
    return { ok: false, message: `the file could not be read (${String(err?.message ?? err).slice(0, 120)})` };
  }
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

  let json;
  try { ({ json } = await gltf.binaryToJSON(bytes)); }
  catch { throw new ModelRefusal('invalid-model', 'the file could not be read', 422); }
  const used = [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])];
  if (used.includes('KHR_draco_mesh_compression')) {
    throw new ModelRefusal('model-too-complex', 'Draco-compressed models are not supported yet: export the model without compression, or with meshopt', 422);
  }
  declaredDecodedBytes(json, limits);

  let doc;
  try { doc = await gltf.readBinary(bytes); }
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
