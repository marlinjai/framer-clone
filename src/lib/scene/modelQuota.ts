// src/lib/scene/modelQuota.ts
//
// The model quotas of docs/plans/2026-11-02-3d-scene-primitive.md ("Upload, validation and
// re-encoding", last paragraph) and decision D1 (answered by Marlin on 2026-11-02: keep the
// defaults, 3D included in every plan until pricing is decided). Pure.
//
// These are limits, and nothing here may be raised or bypassed by a caller: the functions take
// measured sizes and answer, they have no override. Each refusal is a 413 that names the
// measured figure and which step would help, as the plan asks.

const MB = 1024 * 1024;

export const MODEL_QUOTAS = {
  /** A stored model, after re-encoding. */
  perModel: 8 * MB,
  /** A scene's first variant, as transferred. */
  firstVariant: 4 * MB,
  /** All of one scene's models. */
  perScene: 12 * MB,
  /** All models of one site. */
  perSite: 200 * MB,
} as const;

export type QuotaCheck = { ok: true } | { ok: false; status: 413; code: 'model-too-large' | 'scene-too-large' | 'site-quota'; message: string };

const mb = (bytes: number) => `${(bytes / MB).toFixed(2)} MB`;

/** One re-encoded model about to be stored, against the per-model and the per-site quota. */
export function checkModelQuota(modelBytes: number, siteBytesBefore: number): QuotaCheck {
  if (!Number.isFinite(modelBytes) || modelBytes < 0 || !Number.isFinite(siteBytesBefore) || siteBytesBefore < 0) {
    return { ok: false, status: 413, code: 'model-too-large', message: 'The model size could not be measured.' };
  }
  if (modelBytes > MODEL_QUOTAS.perModel) {
    return {
      ok: false, status: 413, code: 'model-too-large',
      message: `This model is ${mb(modelBytes)} after optimising, and a model may be at most ${mb(MODEL_QUOTAS.perModel)}. Fewer triangles or smaller textures would bring it under.`,
    };
  }
  if (siteBytesBefore + modelBytes > MODEL_QUOTAS.perSite) {
    return {
      ok: false, status: 413, code: 'site-quota',
      message: `Your site's models would use ${mb(siteBytesBefore + modelBytes)}, and the limit is ${mb(MODEL_QUOTAS.perSite)}. Delete a model you no longer use to make room.`,
    };
  }
  return { ok: true };
}

/** The models one scene uses, in order: the first is the one a visitor downloads first. */
export function checkSceneQuota(modelBytes: readonly number[]): QuotaCheck {
  if (modelBytes.some((n) => !Number.isFinite(n) || n < 0)) {
    return { ok: false, status: 413, code: 'scene-too-large', message: 'A model size in this scene could not be measured.' };
  }
  if (modelBytes.length > 0 && modelBytes[0] > MODEL_QUOTAS.firstVariant) {
    return {
      ok: false, status: 413, code: 'scene-too-large',
      message: `The first model of this scene is ${mb(modelBytes[0])}, and it may be at most ${mb(MODEL_QUOTAS.firstVariant)} because it is what a visitor loads first. Use a lighter model first, or reduce this one.`,
    };
  }
  const total = modelBytes.reduce((a, b) => a + b, 0);
  if (total > MODEL_QUOTAS.perScene) {
    return {
      ok: false, status: 413, code: 'scene-too-large',
      message: `The models of this scene add up to ${mb(total)}, and a scene may use at most ${mb(MODEL_QUOTAS.perScene)}. Remove a variant or use lighter models.`,
    };
  }
  return { ok: true };
}
