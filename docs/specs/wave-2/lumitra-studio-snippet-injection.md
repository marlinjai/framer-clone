---
name: lumitra-studio-snippet-injection
track: lumitra-studio
wave: 2
priority: P0
status: draft
depends_on: [lumitra-studio-component-id-attribution, lumitra-studio-project-binding, static-html-publish-pipeline]
estimated_value: 9
estimated_cost: 5
owner: unassigned
---

# Lumitra tracker snippet injected into static HTML publish output

## Goal

When a project with `lumitra.enabled === true` publishes to static HTML, inject the `@marlinjai/analytics-tracker` initialization snippet into the published page's `<head>`. The snippet boots the Lumitra tracker against the customer's Lumitra project ID and the configured ingestion endpoint, instruments pageviews and clicks, and (because `data-component-id` already lives on every emitted element thanks to the Wave 1 attribution spec) gives Lumitra Studio Phase A and Phase B everything they need to render heatmaps and run experiments. This is the "instrumented for growth from day zero" promise from the strategic thesis: Bubble has no equivalent.

## Scope

**In:**
- A `buildLumitraSnippet(binding: LumitraBinding): string` helper that returns the `<script>` tag(s) to inject.
- Integration with the static HTML publish pipeline (`static-html-publish-pipeline` spec): the publish emitter calls `buildLumitraSnippet` and concatenates the result into the page's `<head>` when `binding.enabled` is true.
- Server-side `apiKeyRef` resolution: the publish pipeline calls a small `resolveLumitraApiKey(ref)` utility that pulls the literal key from Infisical / env at publish time. Literal keys never round-trip through MST or the browser.
- Snippet shape: ESM script that imports from a pinned `@marlinjai/analytics-tracker` version and calls `init({ projectId, endpoint, apiKey, heatmap: true, scrollDepth: true })`. CDN URL for the tracker bundle is configurable; default to a known-good Lumitra-hosted CDN.
- A "tracker version" field locked at publish time so a redeploy of the SDK does not silently break already-published sites.
- Unit tests: snippet generation, key resolution failure modes, opt-out short-circuit when `enabled` is false.
- Integration test: publish a fixture project with `lumitra.enabled = true`, parse the output, assert the `<script>` is present with the expected attributes.

**Out (explicitly deferred):**
- The static HTML publish pipeline itself (owned by `static-html` track, separate spec `static-html-publish-pipeline`).
- DOM fingerprint richness beyond `data-component-id` (analytics-platform Pillar 1, owned by analytics-platform).
- Runtime variant application / experiments wiring (Phase C, deferred to Phase 2 of strategic thesis).
- A UI to flip `lumitra.enabled` on/off (separate Wave 2 spec: `lumitra-studio-settings-panel`).
- Bundling the tracker SDK into the static publish output as a self-hosted asset (defer; load from a CDN initially, revisit if customers complain about the third-party dependency).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/publish/lumitra-snippet.ts` | new | `buildLumitraSnippet(binding)` and key resolution utility |
| `src/lib/publish/__tests__/lumitra-snippet.test.ts` | new | Unit tests |
| `src/lib/publish/<entrypoint owned by static-html spec>` | edit (cross-track seam) | Call `buildLumitraSnippet` and append to `<head>` |
| `src/app/api/publish/route.ts` (working name; finalized in `static-html-publish-pipeline`) | edit (cross-track seam) | Resolve `apiKeyRef` server-side before passing into `buildLumitraSnippet` |

## API surface

```ts
// src/lib/publish/lumitra-snippet.ts

import type { LumitraBindingSnapshot } from '@/models/ProjectModel';

export interface LumitraSnippetInput {
  projectId: string;             // Lumitra project UUID
  ingestionEndpoint: string;     // e.g. https://analytics.lumitra.co/api/collect
  apiKey: string;                // resolved literal, server-side only
  trackerCdnUrl?: string;        // default: pinned Lumitra CDN URL
  trackerVersion?: string;       // default: pinned by framer-clone, locked into the snippet
}

/**
 * Build the <script> tag(s) for Lumitra tracker initialization. Returns an
 * empty string if disabled or required fields are missing.
 */
export function buildLumitraSnippet(input: LumitraSnippetInput | null): string;

/**
 * Resolve a stored apiKeyRef to a literal API key. Server-side only.
 * Throws on resolution failure. Caller short-circuits before publishing.
 */
export async function resolveLumitraApiKey(ref: string): Promise<string>;
```

## Data shapes

```ts
// Emitted snippet (illustrative; exact form to be pinned by tests)
const snippet = `
<script type="module">
  import { init } from "https://cdn.lumitra.co/analytics-tracker@${version}/index.js";
  init({
    projectId: "${projectId}",
    endpoint: "${ingestionEndpoint}",
    apiKey: "${apiKey}",
    heatmap: true,
    scrollDepth: true,
  });
</script>
`;
```

## Test plan

- [ ] Unit: `buildLumitraSnippet(null)` returns `""`.
- [ ] Unit: `buildLumitraSnippet({...})` with all fields returns a `<script type="module">` containing the project id, endpoint, and api key (key escaping verified).
- [ ] Unit: HTML-escaping / quote-injection resistance: malicious project id like `"</script><script>` does not break out of the script tag.
- [ ] Unit: missing `apiKey` throws or returns `""` (decision: return `""` and log a warning).
- [ ] Unit: `resolveLumitraApiKey("infisical:/...")` calls Infisical SDK and returns the resolved literal; failures throw with a clear error.
- [ ] Integration: publish a fixture project with lumitra.enabled = true, parse the resulting HTML, find one `<script>` matching the snippet pattern, assert `data-component-id` attributes are present in the body (cross-spec verification with `lumitra-studio-component-id-attribution`).
- [ ] Manual: deploy a sample published project, open in browser, confirm Lumitra tracker initializes (network tab shows `/api/collect` POSTs after a click).

## Definition of done

- [ ] Snippet generator and key resolver land with full unit coverage.
- [ ] Static HTML publish pipeline integration produces snippets in the head when enabled.
- [ ] No literal API keys appear in MST snapshots, browser bundles, or git history.
- [ ] Cross-track integration test passes (published fixture has both snippet and `data-component-id` attributes).
- [ ] Status moved to `done` in STATUS.md.

## Open questions

- **Tracker SDK distribution.** Load from `cdn.lumitra.co`, or self-host inside the published bundle, or both? Recommended: CDN by default, self-host as an opt-in for customers concerned about third-party loading. Defer self-host to Phase 2.
- **API key shape and rotation.** The Lumitra tracker's `apiKey` is currently project-scoped (`ap_live_*`). On rotation in the Lumitra dashboard, every published framer-clone site needs a re-publish to pick up the new key, OR we ship a key that is itself a stable framer-clone-side reference that resolves at the edge. Phase 1 ships the simpler model (literal key baked at publish time); Phase 2 reconsiders if rotation pain materializes.
- **CSP friendliness.** A `<script type="module">` with a remote `import` requires `script-src` to allow the Lumitra CDN origin. Document this for users with strict CSP. Auto-emit a meta CSP allowance? Probably not (too opinionated). Document instead.
- **Version pinning policy.** Pin the tracker version per-publish, so a published site stays on whatever version was current at publish time. Re-publish to upgrade. Alternative (auto-upgrade via a floating CDN URL) is rejected: too much risk that an SDK regression takes every customer's site down at once.
- **Dependency on `static-html-publish-pipeline` shape.** The exact integration point depends on what the static-html spec exposes (e.g., a `transformHead(head: string, project: Project): string` hook, vs a more structured pipeline). The lumitra-snippet code stays self-contained; the seam is one call from the static-html emitter into `buildLumitraSnippet`. Coordinate with the static-html spec author.

## References

- Plan: `analytics-platform/docs/superpowers/plans/2026-04-28-framework-agnostic-analytics-architecture.md` (Phase A, lines 174 to 180)
- Plan: `docs/plans/2026-05-01-framework-agnostic-renderer-research.md` (option 3c, static HTML + islands recommendation)
- Memory: `memory/project_strategic_thesis_bubble_killer.md` ("instrumented for growth from day zero", Lumitra Phase 1 dependency)
- External: `analytics-platform/packages/tracker/src/index.ts` (TrackerConfig contract)
- Cross-track seam: `static-html-publish-pipeline` spec (owned by static-html track)
