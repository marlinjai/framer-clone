// src/lib/renderer/publish/projectPublisher.ts
//
// The project-level publish runner (publish spec entrypoint + plan P2). Walks
// every page in a persisted `ProjectModel`, emits a static HTML document + a
// flattened `style.css` + a `manifest.json`, and (when the site runs
// experiments) one keyed artifact set per variant arm. The output is a virtual
// file map; with a `disk` target it is also written to a LOCAL directory. There
// is NO live host here — R2/edge upload is P3 and plugs in behind the same file
// map (see `diskSink.ts`).
//
// PURITY: the publisher touches MST READ-ONLY (idempotent against project state)
// and takes ALL non-MST inputs through `options`:
//   - `experiments`: loaded from `site_experiments` by the server caller (no MST
//     experiment model exists).
//   - `analytics`: the PUBLIC ingestion key already resolved SERVER-SIDE from
//     `lumitra.apiKeyRef`. The secret reference is never read here; the literal
//     key never lives in MST. Injection is gated on `project.lumitra.enabled`.
//   - `assetResolver`: optional byte source for referenced relative assets. When
//     absent (dry run) assets are detected + listed in the manifest but not
//     bundled, and their URLs are left as authored.
//
// This keeps the whole runner unit-testable in-memory with no DB, no network, no
// secrets.

import type { ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import {
  renderPageMarkup,
  flattenInlineStyles,
  wrapDocument,
  primaryBreakpointId,
} from '@/lib/renderer/staticHtmlEmitter';
import {
  collectPageAssets,
  collectProjectAssets,
  buildAssetBundleMap,
} from './assetCollector';
import {
  enumerateVariantArms,
  type ExperimentConfig,
  type VariantArm,
} from './experiments';
import { buildTrackerSnippet } from './trackerSnippet';
import {
  buildManifest,
  serializeManifest,
  type ManifestPage,
  type ProjectManifest,
} from './manifest';

export interface PublishAnalytics {
  /** PUBLIC ingestion key (`ap_live_...`) resolved server-side by the caller. */
  ingestionKey: string;
  /** Analytics ingestion endpoint. */
  ingestionEndpoint: string;
  /** Analytics project id (falls back to `project.lumitra.projectId`). */
  projectId?: string;
  /** Optional tracker loader `<script src>`. */
  trackerScriptSrc?: string;
}

export interface PublishOptions {
  /** Output target. 'memory' returns the file map only; 'disk' also writes it. */
  target: { kind: 'memory' } | { kind: 'disk'; outDir: string };
  /** Optional runtime-island script injected into every page `<head>`. */
  runtimeBundle?: { src: string; integrity?: string };
  /** Running-experiment config (from `site_experiments`); drives per-variant emit. */
  experiments?: ExperimentConfig[];
  /** Resolved PUBLIC analytics config; injected when `project.lumitra.enabled`. */
  analytics?: PublishAnalytics;
  /** Override the emitted breakpoint. Defaults to each page's primary breakpoint. */
  breakpointId?: string;
  /** Cap on emitted variant arms (see experiments.DEFAULT_MAX_VARIANT_ARMS). */
  maxVariantArms?: number;
  /** Optional byte source for referenced relative assets. */
  assetResolver?: (
    url: string,
  ) => string | Uint8Array | undefined | Promise<string | Uint8Array | undefined>;
  /** ISO timestamp stamped into the manifest. Defaults to now. */
  publishedAt?: string;
  /** Progress/decision logger (cap hits, skipped injection, asset summary). */
  logger?: (message: string) => void;
}

export interface PublishedBundle {
  /** Relative bundle path -> file contents. Always returned (both targets). */
  files: Record<string, string | Uint8Array>;
  manifest: ProjectManifest;
}

// Slugs that publish at the bundle root (`/index.html`) rather than nested.
const ROOT_SLUGS = new Set(['', 'home', 'index']);

export async function publishProject(
  project: ProjectModelType,
  options: PublishOptions,
): Promise<PublishedBundle> {
  const log = options.logger ?? (() => {});
  const publishedAt = options.publishedAt ?? new Date().toISOString();
  const files: Record<string, string | Uint8Array> = {};

  // ---- analytics gate (secret stays server-side; key already resolved) -------
  const lumitraEnabled = !!project.lumitra?.enabled;
  let analyticsEnabled = false;
  if (lumitraEnabled) {
    if (options.analytics?.ingestionKey) {
      analyticsEnabled = true;
    } else {
      log(
        '[publish] lumitra binding enabled but no resolved analytics key supplied; ' +
          'skipping tracker injection',
      );
    }
  }
  const analyticsProjectId =
    options.analytics?.projectId ?? project.lumitra?.projectId ?? undefined;

  // ---- experiment arm enumeration (bounded + logged) -------------------------
  const armResult = enumerateVariantArms(options.experiments, {
    cap: options.maxVariantArms,
  });
  if (armResult.capped) {
    log(
      `[publish] variant arms capped: ${armResult.requested} requested, ` +
        `emitting ${armResult.arms.length} (cap ${armResult.cap}). ` +
        'Excess arms were NOT emitted.',
    );
  }

  // ---- asset resolution (optional; dry run lists but does not bundle) ---------
  const projectAssets = collectProjectAssets(project);
  const bundleMap = buildAssetBundleMap(projectAssets);
  const rewriteMap = new Map<string, string>();
  if (options.assetResolver && projectAssets.length > 0) {
    for (const url of projectAssets) {
      const bytes = await options.assetResolver(url);
      if (bytes == null) continue;
      const bundlePath = bundleMap.get(url)!;
      files[bundlePath] = bytes;
      rewriteMap.set(url, `/${bundlePath}`);
    }
    log(
      `[publish] bundled ${rewriteMap.size}/${projectAssets.length} referenced assets`,
    );
  } else if (projectAssets.length > 0) {
    log(
      `[publish] ${projectAssets.length} relative asset(s) referenced but NOT bundled ` +
        '(no assetResolver); they must be served from their authored URLs',
    );
  }

  // ---- per-page emit ---------------------------------------------------------
  const manifestPages: ManifestPage[] = [];

  for (const page of project.pagesArray) {
    const breakpointId = options.breakpointId ?? primaryBreakpointId(page);
    const dir = controlDir(page.slug);

    // Render the body ONCE, then flatten ONCE: the markup is identical across
    // arms (the variant builder is P5), so arms differ ONLY by the injected
    // tracker head. Asset URLs are rewritten before flattening so style-borne
    // `url(...)` refs are rewritten too.
    const raw = renderPageMarkup(page, breakpointId);
    const rewritten = rewriteAssetUrls(raw, rewriteMap);
    const { html: bodyHtml, css } = flattenInlineStyles(rewritten);

    // Control baseline at the page's canonical path.
    writeArtifact(files, dir, {
      bodyHtml,
      css,
      page,
      assignment: {},
      analyticsEnabled,
      analyticsProjectId,
      options,
    });

    // One keyed artifact set per variant arm.
    for (const arm of armResult.arms) {
      writeArtifact(files, variantDir(arm, page.slug), {
        bodyHtml,
        css,
        page,
        assignment: arm.assignment,
        analyticsEnabled,
        analyticsProjectId,
        options,
      });
    }

    manifestPages.push({
      slug: page.slug,
      path: `/${dir}index.html`,
      breakpoints: pageBreakpoints(page),
      assets: collectPageAssets(page),
    });
  }

  // ---- manifest --------------------------------------------------------------
  const manifest = buildManifest({
    projectId: project.id,
    publishedAt,
    pages: manifestPages,
    experiments:
      armResult.requested > 0
        ? {
            arms: armResult.arms.map((a) => ({
              experimentKey: a.experimentKey,
              variant: a.variant,
            })),
            requested: armResult.requested,
            capped: armResult.capped,
            cap: armResult.cap,
          }
        : undefined,
    analytics: { enabled: analyticsEnabled, projectId: analyticsProjectId },
  });
  files['manifest.json'] = serializeManifest(manifest);

  // ---- local output target (R2 plugs in behind this same map in P3) ----------
  if (options.target.kind === 'disk') {
    const { writeBundleToDisk } = await import('./diskSink');
    await writeBundleToDisk(options.target.outDir, files);
    log(`[publish] wrote ${Object.keys(files).length} files to ${options.target.outDir}`);
  }

  return { files, manifest };
}

// =============================================================================
// internals
// =============================================================================

interface ArtifactInput {
  bodyHtml: string;
  css: string;
  page: PageModelType;
  assignment: Record<string, string>;
  analyticsEnabled: boolean;
  analyticsProjectId: string | undefined;
  options: PublishOptions;
}

/** Assemble + write one `index.html` + co-located `style.css` under `dir`. */
function writeArtifact(
  files: Record<string, string | Uint8Array>,
  dir: string,
  input: ArtifactInput,
): void {
  const headTags: string[] = ['<link rel="stylesheet" href="style.css" />'];

  if (input.analyticsEnabled && input.options.analytics) {
    headTags.push(
      buildTrackerSnippet({
        ingestionKey: input.options.analytics.ingestionKey,
        ingestionEndpoint: input.options.analytics.ingestionEndpoint ?? '',
        projectId: input.analyticsProjectId,
        variants: input.assignment,
        trackerScriptSrc: input.options.analytics.trackerScriptSrc,
      }),
    );
  }

  if (input.options.runtimeBundle) {
    headTags.push(runtimeScriptTag(input.options.runtimeBundle));
  }

  const doc = wrapDocument({
    bodyHtml: input.bodyHtml,
    title: input.page.metadata.title,
    headTags,
  });

  files[`${dir}index.html`] = doc;
  files[`${dir}style.css`] = input.css;
}

function controlDir(slug: string): string {
  return ROOT_SLUGS.has(slug) ? '' : `${slug}/`;
}

function variantDir(arm: VariantArm, slug: string): string {
  const pageDir = ROOT_SLUGS.has(slug) ? '' : `${slug}/`;
  return `_exp/${arm.experimentKey}/${arm.variant}/${pageDir}`;
}

function pageBreakpoints(page: PageModelType): { id: string; minWidth: number }[] {
  return page.viewportNodes
    .map((v) => v.breakpointInfo)
    .filter((b): b is { id: string; minWidth: number; label?: string } => !!b)
    .map((b) => ({ id: b.id, minWidth: b.minWidth }))
    .sort((a, b) => a.minWidth - b.minWidth);
}

function runtimeScriptTag(bundle: { src: string; integrity?: string }): string {
  const integrity = bundle.integrity
    ? ` integrity="${escapeAttr(bundle.integrity)}" crossorigin="anonymous"`
    : '';
  return `<script type="module" src="${escapeAttr(bundle.src)}"${integrity} defer></script>`;
}

/**
 * Rewrite resolved asset URLs to their `/assets/...` bundle path. Only URLs in
 * `rewriteMap` (the ones the resolver actually bundled) are rewritten; authored
 * URLs are otherwise left intact. Longer URLs are replaced first and matches are
 * bounded by quote/paren/comma/space so one URL is never a substring of another.
 */
function rewriteAssetUrls(html: string, rewriteMap: Map<string, string>): string {
  if (rewriteMap.size === 0) return html;
  let out = html;
  const entries = [...rewriteMap.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [orig, target] of entries) {
    const re = new RegExp(
      `(?<=["'(,\\s])${escapeRegex(orig)}(?=["')\\s,])`,
      'g',
    );
    out = out.replace(re, target);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
