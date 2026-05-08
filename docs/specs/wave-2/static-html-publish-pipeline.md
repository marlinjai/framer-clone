---
name: static-html-publish-pipeline
track: static-html
wave: 2
priority: P0
status: draft
depends_on: [static-html-spike, static-html-css-flattener]
estimated_value: 9
estimated_cost: 7
owner: unassigned
---

# Multi-page publish pipeline: project tree to a deployable bundle

## Goal

Wrap the per-page emitter from previous specs into a project-level publish runner. Walks every page in `ProjectModel`, emits HTML+CSS per page, resolves the page slug to a path, copies referenced assets (images, fonts) into the bundle, and produces a directory layout deployable to any static host (Cloudflare Pages, Vercel, S3+CloudFront, the user's own server). This is the actual publish target Phase 1 ships to investors and early customers.

## Scope

**In:**
- New module `src/lib/renderer/publish/projectPublisher.ts` exporting `publishProject(project, options)`.
- For each page in `project.pages`: call `emitStaticHtmlForPage`, write `<slug>/index.html` and `<slug>/style.css` (or `index.html` for the home page).
- Asset collection: walk MST tree, identify referenced image / font URLs (current shape: `<img src="...">` props, `style.backgroundImage`, font-family references), copy or rewrite paths so the bundle is self-contained.
- Index `manifest.json` listing every page with its slug, breakpoints, and asset list.
- Output directory shape: `dist/` with `index.html`, `style.css`, `assets/`, nested page folders.
- Hook for the runtime island bundle (Wave 2: `static-html-runtime-island`) to be linked from each page's `<head>`.

**Out (explicitly deferred):**
- Actual hosting / deployment to a server. The pipeline produces a directory; deployment integration is a later concern (likely Cloudflare Pages once auth-brain is in place).
- Image optimization (responsive `srcset`, AVIF/WebP transcoding). Reserve the seam; do not build.
- Per-page metadata (`<title>`, `<meta description>`). Pull from `PageModel` if fields exist; otherwise punt.
- Sitemap, robots.txt. Out of scope for the spike-to-pipeline path; trivial to add later.
- CMS data fetch at publish time vs request time. See Open Questions and `static-html-data-binding-hydration`.
- End-user authentication on published pages (Phase 2).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/publish/projectPublisher.ts` | new | Main entrypoint. Orchestrates per-page emission and asset collection. |
| `src/lib/renderer/publish/assetCollector.ts` | new | Walks the MST tree, returns the list of referenced asset URLs. |
| `src/lib/renderer/publish/manifest.ts` | new | Builds the `manifest.json` shape. |
| `src/lib/renderer/publish/__tests__/projectPublisher.test.ts` | new | Snapshot the directory layout from a fixture project. |
| `src/lib/renderer/publish/__tests__/assetCollector.test.ts` | new | Unit-test asset detection across host elements and inline styles. |
| `src/app/api/publish/route.ts` | new (optional) | Thin Next route wrapper that calls `publishProject` and returns the bundle as a zip. Stub-level; not load-bearing. |

## API surface

```ts
// src/lib/renderer/publish/projectPublisher.ts
import type { ProjectModelType } from '@/models/ProjectModel';

export interface PublishOptions {
  // Output target. 'memory' returns a virtual file map; 'disk' writes to a path.
  target: { kind: 'memory' } | { kind: 'disk'; outDir: string };
  // Optional runtime island URL injected into <head>. When omitted, no script tag is added.
  runtimeBundle?: { src: string; integrity?: string };
}

export interface PublishedBundle {
  // Map of relative path -> file contents. 'memory' target returns this.
  files: Record<string, string | Uint8Array>;
  manifest: ProjectManifest;
}

export interface ProjectManifest {
  projectId: string;
  publishedAt: string;
  pages: Array<{
    slug: string;
    path: string; // e.g. '/about/index.html'
    breakpoints: { id: string; minWidth: number }[];
    assets: string[];
  }>;
}

export function publishProject(
  project: ProjectModelType,
  options: PublishOptions,
): Promise<PublishedBundle>;
```

## Data shapes

```jsonc
// manifest.json
{
  "projectId": "proj_abc",
  "publishedAt": "2026-05-06T18:30:00Z",
  "pages": [
    {
      "slug": "home",
      "path": "/index.html",
      "breakpoints": [{ "id": "mobile", "minWidth": 0 }, { "id": "desktop", "minWidth": 1024 }],
      "assets": ["assets/hero.jpg"]
    }
  ]
}

// Directory layout
// dist/
//   index.html
//   style.css
//   assets/hero.jpg
//   about/
//     index.html
//     style.css
//   manifest.json
```

The renderer touches MST in read-only mode (no MST writes from the publish pipeline). Critical: a publish run must be idempotent against the project state.

## Test plan

- [ ] Unit: `assetCollector.test.ts` covers `<img src>`, `<source srcset>`, `style.backgroundImage`, font-family `url(...)` references; ignores absolute external URLs (CDN); collects relative ones for bundling.
- [ ] Unit: `projectPublisher.test.ts` runs a fixture project with three pages, asserts the file map contains expected paths, manifest is valid, no inline styles in any HTML, CSS file exists per page.
- [ ] Unit: per-page paths respect slug rules (root page is `/index.html`, others nested under their slug).
- [ ] Integration: zip the output, unzip into a tmp dir, serve with a static server, hit each page in a headless browser, assert no 404s and computed styles change at breakpoints.
- [ ] Manual: Marlin runs publish on his current project, opens the output in a browser, eyeballs all pages.

## Definition of done

- [ ] `publishProject` works end-to-end against a fixture project
- [ ] Output directory layout matches spec
- [ ] `manifest.json` validates against its declared shape
- [ ] All unit + integration tests pass
- [ ] No regressions in editor preview (`PreviewFrame`) or headless renderer
- [ ] Spec status moved to `done` in STATUS.md

## Open questions

- **Where does publish run?** Browser (in-app, MST already in memory) vs server (worker job triggered by editor)? Browser is simpler for v1 and matches Framer's "Publish" button UX; server is needed once we want scheduled publishes or large bundles. Spec defaults to browser for v1; flag to Marlin.
- **Page slug source of truth.** Does `PageModel` already carry a slug field? If not, this spec needs a small MST extension. Worker should check and surface.
- **Asset upload destination.** For the bundle to be deployable, assets need stable URLs. Are images today stored in storage-brain? If yes, the manifest references those URLs directly and the bundle is HTML+CSS only. If assets are local blobs in MST, they need uploading first. Cross-track dependency on storage-brain stubs (Wave 1, multiplayer or cms tracks).
- **CMS data fetch: publish-time vs request-time.** Phase 1 read-only data hydration could go two ways. (a) Fetch CMS data at publish time, bake into the HTML, ship a fully static bundle. Pros: zero runtime, perfect caching. Cons: every CMS edit forces a republish. (b) Ship empty placeholders, fetch CMS data client-side at request time via the runtime island. Pros: live data without republishing. Cons: layout shift, runtime cost. Cross-track decision with `data-bindings` and `cms` tracks. Spec recommends (a) for Phase 1 (Framer-shape sites are publish-on-edit); revisit when push real-time lands in Phase 2.
- **Cache busting.** CSS / JS assets need content-hashed filenames (`style.abc123.css`) for cache invalidation. Trivial; flag for the worker.
- **Per-page `<title>` and metadata.** Where do they live in the model today? If nowhere, this spec adds a stub or punts.

## References

- Plan: `docs/plans/2026-05-01-framework-agnostic-renderer-research.md` (recommendation 1, section 3c)
- Memory: `memory/project_strategic_thesis_bubble_killer.md` (Phase 1 = static HTML publish)
- Code touchpoints: `src/models/ProjectModel.ts`, `src/models/PageModel.ts`, `src/lib/renderer/staticHtmlEmitter.ts`
