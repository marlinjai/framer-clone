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
//   7  write the blobs (always: content-addressed, so a repeat is harmless and a half-written one is
//      repaired), then insert the row atomically within the quotas. A failed insert deletes NOTHING:
//      the blobs are shared by content across sites and a concurrent upload may rely on them, so
//      orphans are left to the collection sweep. The unique key losing a race is "already stored".

import { MAX_FILE_BYTES, checkGlb } from '@/lib/scene/glb';
import { MODEL_QUOTAS, checkModelQuota } from '@/lib/scene/modelQuota';
import { ModelRefusalError, type DecodedStats, type InsertOutcome, type ModelBlobStore, type ModelReencoder, type ModelValidator, type SiteModelRecord, type SiteModelRepository } from './ports';

/** Step 5's decoded caps (plan). */
export const DECODED_LIMITS = {
  triangles: 500_000,
  textureSide: 4096,
  boundingBox: 1000,
  nodes: 1000,
  clips: 32,
  /** What the re-encoder promises to write. */
  outputTextureSide: 2048,
  /** Not in the plan: bounds the decoder's own work (total decoded accessor bytes, total texture pixels) so a small file cannot declare a huge one. */
  decodedBytes: 64 * 1024 * 1024,
  meshes: 256,
  materials: 64,
  textures: 16,
  images: 16,
  nodeDepth: 32,
  bones: 128,
  totalTexturePixels: 40_000_000,
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

/** The first decoded cap a measured model breaks, as a message, or null. A missing or malformed measurement is a break. */
export function decodedProblem(s: DecodedStats | undefined | null): string | null {
  if (!s || typeof s !== 'object' || !Array.isArray(s.boundingBox) || s.boundingBox.length !== 3) return 'the model could not be measured';
  const nums = [s.triangles, s.maxTextureSide, s.nodes, s.clips, s.materials, s.textures ?? 0, ...s.boundingBox];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) return 'the model has a size that is not a finite number';
  if (s.triangles > DECODED_LIMITS.triangles) return `the model has ${s.triangles} triangles, at most ${DECODED_LIMITS.triangles} are allowed`;
  if (s.maxTextureSide > DECODED_LIMITS.textureSide) return `a texture is ${s.maxTextureSide} pixels on a side, at most ${DECODED_LIMITS.textureSide} are allowed`;
  if (s.boundingBox.some((n) => n > DECODED_LIMITS.boundingBox)) return `the model is larger than ${DECODED_LIMITS.boundingBox} units on a side`;
  if (s.nodes > DECODED_LIMITS.nodes) return `the model has ${s.nodes} nodes, at most ${DECODED_LIMITS.nodes} are allowed`;
  if (s.materials > DECODED_LIMITS.materials) return `the model has ${s.materials} materials, at most ${DECODED_LIMITS.materials} are allowed`;
  if ((s.textures ?? 0) > DECODED_LIMITS.textures) return `the model has ${s.textures} textures, at most ${DECODED_LIMITS.textures} are allowed`;
  if (s.clips > DECODED_LIMITS.clips) return `the model has ${s.clips} animation clips, at most ${DECODED_LIMITS.clips} are allowed`;
  return null;
}

/** A refusal of the file reads as the file's fault; a 500 is ours, and says to try again. */
const refusalMessage = (e: ModelRefusalError) => (e.status >= 500 ? `The model could not be processed (${e.message}). Try again.` : `This model cannot be used: ${e.message}.`);

/** Names from the re-encoder, kept to what the role panel can list: strings, at most 80 characters, at most 1,000. */
const boundedNames = (names: unknown): string[] => (Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string').slice(0, 1000).map((n) => n.slice(0, 80)) : []);

const logFailure = (step: string, siteId: string, err: unknown) => console.error(`models: ${step} failed for site ${siteId}.`, err);

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

  // A site already at its quota is refused before the expensive steps run, not after.
  if ((await deps.models.totalBytes(siteId)) >= MODEL_QUOTAS.perSite) {
    return fail(413, 'site-quota', `Your site's models already use the whole ${MODEL_QUOTAS.perSite / 1048576} MB. Delete a model you no longer use to make room.`);
  }

  let validated: { ok: true } | { ok: false; message: string };
  try { validated = await deps.validator.validate(input); } catch (err) {
    if (err instanceof ModelRefusalError) return fail(err.status, err.code, refusalMessage(err));
    logFailure('validator', siteId, err);
    return fail(500, 'validator-failed', 'The model could not be checked. Try again.');
  }
  if (!validated.ok) return fail(422, 'invalid-model', `This model is not a valid glTF file: ${validated.message}`);

  let encoded: Awaited<ReturnType<ModelReencoder['reencode']>>;
  try { encoded = await deps.reencoder.reencode(input); } catch (err) {
    if (err instanceof ModelRefusalError) return fail(err.status, err.code, refusalMessage(err));
    logFailure('re-encoder', siteId, err); return fail(500, 'reencode-failed', 'The model could not be optimised. Try again, or export it differently.'); }

  if (!encoded || !(encoded.bytes instanceof Uint8Array || ArrayBuffer.isView(encoded.bytes))) return fail(500, 'reencode-failed', 'The optimised model is missing.');
  const inputProblem = decodedProblem(encoded.input);
  if (inputProblem) return fail(413, 'model-too-complex', `This model is too complex: ${inputProblem}. Fewer triangles or smaller textures would help.`);
  const outputProblem = decodedProblem(encoded.output);
  if (outputProblem) return fail(500, 'reencode-failed', `The optimised model broke a limit (${outputProblem}).`);
  if (encoded.output.maxTextureSide > DECODED_LIMITS.outputTextureSide) return fail(500, 'reencode-failed', `The optimised model still has a texture of ${encoded.output.maxTextureSide} pixels.`);

  const served = checkGlb(encoded.bytes);
  if (!served.ok) return fail(500, 'reencode-failed', `The optimised model did not pass the structure check (${served.message}).`);

  const sha = await sha256Hex(encoded.bytes);
  const now = (deps.now ?? (() => new Date()))();
  const existing = await deps.models.find(siteId, sha);
  if (existing) {
    await deps.models.touch(siteId, sha, now);
    return { ok: true, model: { ...existing, lastUsedAt: now }, alreadyStored: true };
  }

  const quota = checkModelQuota(encoded.bytes.byteLength, await deps.models.totalBytes(siteId));
  if (!quota.ok) return fail(quota.status, quota.code, quota.message);

  const originalSha = await sha256Hex(input);
  const record: SiteModelRecord = {
    siteId, sha256: sha, bytes: encoded.bytes.byteLength,
    triangles: encoded.output.triangles, materials: encoded.output.materials, nodes: encoded.output.nodes, clips: encoded.output.clips,
    textures: encoded.output.textures ?? 0,
    materialNames: boundedNames(encoded.names?.materials), nodeNames: boundedNames(encoded.names?.nodes),
    extensions: served.summary.extensionsUsed, uploaderId, createdAt: now, lastUsedAt: now,
    originalSha256: originalSha, originalBytes: input.byteLength,
  };
  try {
    // Always written: the keys are content-addressed, so rewriting is harmless and repairs a partial blob.
    await deps.blobs.put(`served/${sha}`, encoded.bytes);
    await deps.blobs.put(`original/${originalSha}`, input);
  } catch (err) {
    logFailure('storing the blobs', siteId, err);
    return fail(500, 'store-failed', 'The model could not be saved. Try again.');
  }
  let outcome: InsertOutcome;
  try {
    outcome = await deps.models.insertWithinQuota(record, { servedBytes: MODEL_QUOTAS.perSite, originalBytes: MODEL_QUOTAS.originalsPerSite });
  } catch (err) {
    logFailure('saving the row', siteId, err);
    return fail(500, 'store-failed', 'The model could not be saved. Try again.');
  }
  if (!outcome.ok) {
    if (outcome.reason === 'exists') {
      // A concurrent upload of the same content won the unique key: the model is stored.
      const row = await deps.models.find(siteId, sha);
      if (row) return { ok: true, model: row, alreadyStored: true };
      return fail(500, 'store-failed', 'The model could not be saved. Try again.');
    }
    if (outcome.reason === 'originals-quota') return fail(413, 'site-quota', `The originals kept for your site's models would pass ${MODEL_QUOTAS.originalsPerSite / 1048576} MB. Delete a model you no longer use to make room.`);
    const q = checkModelQuota(record.bytes, MODEL_QUOTAS.perSite);
    return fail(413, 'site-quota', q.ok ? 'Your site has no room for another model. Delete one you no longer use.' : q.message);
  }
  return { ok: true, model: record, alreadyStored: false };
}
