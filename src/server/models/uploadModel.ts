// src/server/models/uploadModel.ts
//
// The upload pipeline of plan S2 ("Upload, validation and re-encoding"), as a function of its
// ports so every step runs offline. FAILS CLOSED: the Khronos validator (step 2) and the
// re-encoder (steps 5 and 6) are injected, and without both nothing is stored. The real ones,
// the Storage Brain adapter, the Prisma repository, the route and the worker limit (20 seconds,
// 512 megabytes) are GATED and not part of this file; see ports.ts.
//
// Order, each step refusing before the next runs:
//   1  bound the input (50 MB, the guard's MAX_FILE_BYTES)
//   2  structure guard checkGlb (header, no external uri, extensions, counts, indexes)
//   3  the Khronos validator
//   4  decode and re-encode, then enforce the DECODED caps on what the decoder measured
//      (500,000 triangles, textures at most 4,096 pixels, bounding box at most 1,000 units,
//      nodes, clips, bones), and that the output is within what the pipeline promises
//   5  the guard again on the OUTPUT (what is served is checked, not trusted)
//   6  quotas: 8 MB per model, 200 MB per site; the original is kept, not served
//   7  store the blob, then the row; a failed row removes the blob this call added

import { MAX_FILE_BYTES, checkGlb } from '@/lib/scene/glb';
import { checkModelQuota } from '@/lib/scene/modelQuota';
import type { DecodedStats, ModelBlobStore, ModelReencoder, ModelValidator, SiteModelRecord, SiteModelRepository } from './ports';

/** Step 5's decoded caps (plan). */
export const DECODED_LIMITS = {
  triangles: 500_000,
  textureSide: 4096,
  boundingBox: 1000,
  nodes: 1000,
  clips: 32,
  /** What the re-encoder promises to write. */
  outputTextureSide: 2048,
} as const;

export interface UploadDeps {
  blobs: ModelBlobStore;
  models: SiteModelRepository;
  validator?: ModelValidator;
  reencoder?: ModelReencoder;
  now?: () => Date;
}

export type UploadResult =
  | { ok: true; model: SiteModelRecord; alreadyStored: boolean }
  | { ok: false; status: 400 | 413 | 422 | 500 | 503; code: string; message: string };

const fail = (status: 400 | 413 | 422 | 500 | 503, code: string, message: string): UploadResult => ({ ok: false, status, code, message });

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The first decoded cap a measured model breaks, as a message, or null. Not finite means broken. */
export function decodedProblem(s: DecodedStats): string | null {
  const nums = [s.triangles, s.maxTextureSide, s.nodes, s.clips, ...s.boundingBox];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) return 'the model has a size that is not a finite number';
  if (s.triangles > DECODED_LIMITS.triangles) return `the model has ${s.triangles} triangles, at most ${DECODED_LIMITS.triangles} are allowed`;
  if (s.maxTextureSide > DECODED_LIMITS.textureSide) return `a texture is ${s.maxTextureSide} pixels on a side, at most ${DECODED_LIMITS.textureSide} are allowed`;
  if (s.boundingBox.some((n) => n > DECODED_LIMITS.boundingBox)) return `the model is larger than ${DECODED_LIMITS.boundingBox} units on a side`;
  if (s.nodes > DECODED_LIMITS.nodes) return `the model has ${s.nodes} nodes, at most ${DECODED_LIMITS.nodes} are allowed`;
  if (s.clips > DECODED_LIMITS.clips) return `the model has ${s.clips} animation clips, at most ${DECODED_LIMITS.clips} are allowed`;
  return null;
}

export async function acceptModelUpload(input: Uint8Array, siteId: string, uploaderId: string, deps: UploadDeps): Promise<UploadResult> {
  if (!deps.validator || !deps.reencoder) {
    return fail(503, 'not-configured', 'Model upload is not available yet: the validation and optimising steps are not set up.');
  }
  if (!ArrayBuffer.isView(input)) return fail(400, 'not-a-model', 'The upload is not a file.');
  if (input.byteLength > MAX_FILE_BYTES) {
    return fail(413, 'too-large', `The file is ${(input.byteLength / 1048576).toFixed(1)} MB, and at most ${MAX_FILE_BYTES / 1048576} MB are read. Export a smaller model.`);
  }

  const guard = checkGlb(input);
  if (!guard.ok) return fail(422, guard.code, `This model cannot be used: ${guard.message}.`);

  let validated: { ok: true } | { ok: false; message: string };
  try { validated = await deps.validator.validate(input); } catch { return fail(500, 'validator-failed', 'The model could not be checked. Try again.'); }
  if (!validated.ok) return fail(422, 'invalid-model', `This model is not a valid glTF file: ${validated.message}`);

  let encoded: Awaited<ReturnType<ModelReencoder['reencode']>>;
  try { encoded = await deps.reencoder.reencode(input); } catch { return fail(500, 'reencode-failed', 'The model could not be optimised. Try again, or export it differently.'); }

  const inputProblem = decodedProblem(encoded.input);
  if (inputProblem) return fail(413, 'model-too-complex', `This model is too complex: ${inputProblem}. Fewer triangles or smaller textures would help.`);
  const outputProblem = decodedProblem(encoded.output);
  if (outputProblem) return fail(500, 'reencode-failed', `The optimised model broke a limit (${outputProblem}).`);
  if (encoded.output.maxTextureSide > DECODED_LIMITS.outputTextureSide) return fail(500, 'reencode-failed', `The optimised model still has a texture of ${encoded.output.maxTextureSide} pixels.`);

  const served = checkGlb(encoded.bytes);
  if (!served.ok) return fail(500, 'reencode-failed', `The optimised model did not pass the structure check (${served.message}).`);

  const sha = await sha256Hex(encoded.bytes);
  const existing = await deps.models.find(siteId, sha);
  if (existing) return { ok: true, model: existing, alreadyStored: true };

  const quota = checkModelQuota(encoded.bytes.byteLength, await deps.models.totalBytes(siteId));
  if (!quota.ok) return fail(quota.status, quota.code, quota.message);

  const servedKey = `served/${sha}`;
  const originalKey = `original/${await sha256Hex(input)}`;
  const hadServed = await deps.blobs.has(servedKey);
  const hadOriginal = await deps.blobs.has(originalKey);
  const record: SiteModelRecord = {
    siteId, sha256: sha, bytes: encoded.bytes.byteLength,
    triangles: encoded.output.triangles, materials: encoded.output.materials, nodes: encoded.output.nodes, clips: encoded.output.clips,
    extensions: served.summary.extensionsUsed, uploaderId, createdAt: (deps.now ?? (() => new Date()))(),
  };
  try {
    if (!hadServed) await deps.blobs.put(servedKey, encoded.bytes);
    if (!hadOriginal) await deps.blobs.put(originalKey, input);
    await deps.models.insert(record);
  } catch {
    // Only what this call added is removed: another site may hold the same content-addressed blob.
    if (!hadServed) await deps.blobs.delete(servedKey).catch(() => undefined);
    if (!hadOriginal) await deps.blobs.delete(originalKey).catch(() => undefined);
    return fail(500, 'store-failed', 'The model could not be saved. Try again.');
  }
  return { ok: true, model: record, alreadyStored: false };
}
