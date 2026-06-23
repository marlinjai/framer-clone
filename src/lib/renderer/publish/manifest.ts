// src/lib/renderer/publish/manifest.ts
//
// Builds the `manifest.json` shape that indexes a published bundle (publish
// spec: "Index manifest.json listing every page with its slug, breakpoints, and
// asset list"). The base shape matches the spec's declared `ProjectManifest`
// verbatim; `experiments` and `analytics` are ADDITIVE blocks describing the
// per-variant emit + tracker injection (publish spec P2b/P2c), so a future edge
// rewrite can discover the precomputed arms without re-deriving them.

export interface ManifestBreakpoint {
  id: string;
  minWidth: number;
}

export interface ManifestPage {
  slug: string;
  /** Bundle-root-relative path of the control artifact, e.g. '/about/index.html'. */
  path: string;
  breakpoints: ManifestBreakpoint[];
  /** Relative asset URLs this page references (as authored). */
  assets: string[];
}

export interface ManifestArm {
  experimentKey: string;
  variant: string;
}

export interface ManifestExperiments {
  /** The emitted arms (excludes the control baseline, which is each page's `path`). */
  arms: ManifestArm[];
  /** Total arms requested before the cap. */
  requested: number;
  /** True when the arm set was truncated by the cap. */
  capped: boolean;
  /** The cap that was applied. */
  cap: number;
}

export interface ManifestAnalytics {
  /** True when the tracker snippet was injected (project.lumitra.enabled + key resolved). */
  enabled: boolean;
  projectId?: string;
}

export interface ProjectManifest {
  projectId: string;
  publishedAt: string;
  pages: ManifestPage[];
  experiments?: ManifestExperiments;
  analytics?: ManifestAnalytics;
}

export interface BuildManifestInput {
  projectId: string;
  publishedAt: string;
  pages: ManifestPage[];
  experiments?: ManifestExperiments;
  analytics?: ManifestAnalytics;
}

/**
 * Assemble the manifest object. Pure: the publisher computes the page entries
 * (paths, breakpoints, assets) and arm summary, this just shapes them.
 */
export function buildManifest(input: BuildManifestInput): ProjectManifest {
  const manifest: ProjectManifest = {
    projectId: input.projectId,
    publishedAt: input.publishedAt,
    pages: input.pages,
  };
  if (input.experiments) manifest.experiments = input.experiments;
  if (input.analytics) manifest.analytics = input.analytics;
  return manifest;
}

/** Serialize the manifest to the pretty JSON written as `manifest.json`. */
export function serializeManifest(manifest: ProjectManifest): string {
  return JSON.stringify(manifest, null, 2);
}
