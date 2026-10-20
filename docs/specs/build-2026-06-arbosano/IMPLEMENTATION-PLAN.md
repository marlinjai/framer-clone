---
type: plan
status: archived
title: "ArboSano on framer-clone: builder-UX maturation (Option A)"
date: 2026-06-26
summary: "Mature the framer-clone visual-builder UX so the live ArboSano marketing site runs as a fully editable site on the platform, ArboSano as the forcing spec. Self-contained: context, model map, the Track 0 foundation, the per-slice DAG (each tagged autonomous vs supervised), phasing, and DoD. One session/orchestrator can execute this end-to-end."
tags: [framer-clone, arbosano, builder-ux, property-controls, navbar, theme, islands, agent-team, plan]
projects: [framer-clone, arbosano]
---

# ArboSano on framer-clone: builder-UX maturation (Option A)

> **Archived 2026-10-20 (owner decision).** Not built. ArboSano stays a content-as-code site (chat, preview and git), which is the default for content sites; it will not move onto framer-clone. Kept as a reference because sections 1 to 3 describe real gaps of the visual editor that matter to every framer-clone user (typed property controls instead of raw prop editing, a navbar component with editable links, theme colours and fonts, marketing section components). Those gaps are tracked on the root ROADMAP.md line "Builder UX gaps", not here.

## 0. Mission and current status

**Mission:** mature the framer-clone visual-builder UX so the live ArboSano variant-C site runs as a **fully editable** site on the platform, with ArboSano as the forcing spec.

**Status (2026-06-26):** framer-clone is DEPLOYED and verified on `app.lumitra.co` (storefront SSRing live data off the prod DB; the two leaked secrets rotated). The plumbing is done: editor canvas + multiplayer, CMS, commerce, content agent, guarded publish-write, SSR-on-request render, host-aware routing, 744 tests. This plan builds the **builder UX** on top of that plumbing. (Deploy facts: memory `project_framer_prod_deploy_2026_06_26.md`; build history: `project_orchestrator_loop_state_2026_06_25.md`.)

**Whole-build DoD:** ArboSano renders pixel-faithful on a subdomain, AND a non-developer can, in the framer-clone canvas: edit copy/photos via typed controls, reorder/add/remove sections, edit nav links, change theme colors/fonts, then publish via SSR. The arbosano content-as-code site stays live in parallel until this is verified, then cut over.

**Why Option A (decided, do not relitigate):** the alternative (opaque custom-components, prop-pokes only) under-delivers the platform's whole promise and is barely better than the content-as-code site ArboSano already has. The plumbing was the easy 30%; this builder UX is the 70% that is the actual product. A navbar-with-links is the canonical example of what is not built yet.

## 1. What exists (do NOT rebuild) and the model map

**Today's registry:** 8 primitives (text, button, image, container, stack, grid, flex, card) + CMS/commerce data kinds. **No marketing components, no typed property-controls form, no navbar.** That gap IS the scope.

**Key framer-clone files (read these first):**
- `src/lib/componentRegistry.ts` : flat `Record<id, ComponentRegistryEntry>`. Entry = `{ id, label, category, icon, iconClassName, htmlType, defaultProps, defaultSize, bindableSlots?, dataComponentKind? }`. `bindableSlots` is a binding picker, NOT a property-controls form (the missing piece).
- `src/models/PageModel.ts` + `src/models/ComponentModel.ts` : the MST page + node models. A node the renderer cares about = `{ id, type, props, bindings, children[] }`; everything else is editor-only and dropped at publish. `appComponentTree` is the deployable root; `canvasNodes` are editor-only.
- `src/lib/renderer/server/snapshotToComponentNode.ts` : pure snapshot -> `ComponentNode` (`{ type, props?, bindings?, children?, id? }`).
- `src/lib/renderer/server/renderComponentNode.tsx` : the publish renderer. It renders ONLY (1) HTML primitives by `htmlType`/literal tag, and (2) a hard-coded island set dispatched by `props['data-component-kind']`. **There is no general server-side function-component path** (the `window.__componentRegistry` function path is editor-only). This is why Track 0 adds a custom-component render branch.
- `src/lib/renderer/server/CommerceIsland.tsx` : the client-island pattern to copy for bespoke interactive components.
- `src/lib/renderer/publish/hydrateBindings.ts` : static literal props pass straight through; no data source required for a static page.
- `src/lib/renderer/server/seedDemoSite.ts` + `scripts/seed-demo.ts` : Path A authoring. Build a `PageSnapshot` object in code, write `Site`/`SitePage`/`SiteDomain` rows directly. Proven end-to-end by the `#43` smoke test. This is how ArboSano pages import.
- `prisma/schema.prisma:209-318` : `Site` (status published|draft) -> `SitePage` (slug + snapshot JSON) -> `SiteDomain` (subdomain).

**ArboSano source (read-only reference, `/Users/marlinjai/software-dev/arbosano`):**
- `src/components/c/` : the ~22 live block components. `src/content/pages/*.ts` : the 11 pages as `BlockData[]`. `src/app/(site-c)/c-globals.css` : the design tokens + 3 Google Fonts + grain textures.
- `plans/2026-06-26-arbosano-to-framer-clone-translation.md` : the full model-map analysis (the source of the file facts above).

## 2. Architecture

**Rendering:** the server custom-component render path (one renderer extension, Track 0.3). ArboSano blocks render as real React components server-side, full fidelity.

**Editing (the new builder UX, the Option A work):** typed property controls + an inspector UI; structural section editing; a navbar component + link-management UX; theme controls; the bespoke interaction islands.

**The altitude (important so this stays tractable):** most marketing blocks want **content editing** (copy, photos, list items) + a few style knobs + page-level reorder, NOT free-form canvas restructuring of a hero's internals. So the default target per block is **a first-class component with rich typed controls**, plus page-level add/remove/reorder. Raw-primitive decomposition is reserved for the rare block that genuinely needs free internal-layout editing. The navbar is the exception that needs real structured-link UX.

## 3. Track 0: the foundation (serial; blocks everything; dispatch first)

### 3.1 Typed property-controls schema  [autonomous]
Define a control schema and let registry entries declare it. Additive to `ComponentRegistryEntry` (`controls?: ComponentControls`); `bindableSlots` stays for data binding.

```ts
type PropertyControl =
  | { kind: 'text';    label: string; placeholder?: string }
  | { kind: 'richtext';label: string }
  | { kind: 'number';  label: string; min?: number; max?: number; step?: number }
  | { kind: 'boolean'; label: string }
  | { kind: 'color';   label: string }
  | { kind: 'enum';    label: string; options: { value: string; label: string }[] }
  | { kind: 'image';   label: string }                      // media picker
  | { kind: 'link';    label: string }                      // { href, label, external? }
  | { kind: 'list';    label: string; itemLabel?: string;   // repeatable group (add/remove/reorder)
      itemControls: Record<string, PropertyControl> }
  | { kind: 'spacing'; label: string };
type ComponentControls = Record<string /* prop path */, PropertyControl>;
```
DoD: schema type + `controls` on registry entries + a unit test. Touch: `componentRegistry.ts`, a new `src/lib/controls/types.ts`.

### 3.2 The inspector UI  [supervised]
Right-rail inspector reads the selected node's component `controls` and renders the matching editors (text/number/color/enum/select/image-picker/link/list-with-add-remove-reorder), writing back to the MST node props. DoD: select a component -> its typed controls show -> editing a control updates canvas + persists through a snapshot round-trip. UX taste matters here: this is the editing experience, so it gets Marlin's eyeball.

### 3.3 Server custom-component render path  [autonomous, core-file review]
In `renderComponentNode.tsx`, add a dispatch branch alongside the commerce-island branch: when `node.props['data-component-kind'] === 'custom'`, look up `node.props.componentId` in a new `src/lib/renderer/server/customComponentRegistry.ts` (`Record<componentId, React.ComponentType>`) and `React.createElement(Component, domSafeProps, renderedChildren)` (server-rendered, not a client island). For interactive blocks, add a `CustomIsland.tsx` shell (mirror `CommerceIsland.tsx`) and new `data-component-kind` values to the interactive set. Update the `DataComponentKind` union. DoD: a registered custom component renders on a published page from a node; an island variant hydrates client-side. NOTE: touches the publish renderer (core) -> careful review, keep the commerce path untouched.

### 3.4 Per-site theme + fonts head injection  [autonomous]
A `Site`-scoped theme stylesheet (the arbosano `c-globals.css` tokens + 3 Google Font links + grain textures) injected into the published `<head>` (the same head-injection seam the analytics `trackerSnippet` uses). DoD: a published page carries the arbosano tokens + fonts; a blank page already renders in the arbosano palette/type.

## 4. The slices (Tracks A-E, dispatch after Track 0)

| Slice | What | Mode | Touch |
|---|---|---|---|
| **A1 navbar** | first-class nav: logo + editable link list + CTA + mobile menu; the link-management UX | **supervised** | new component + `list<link>` control |
| **A2 hero family** | service-hero, cinematic-hero, dark-portrait-hero as components + controls | autonomous + UX check | registry + controls |
| **A3 proof sections** | process, capacity-proof, testimonials | autonomous | registry + controls (list controls for steps/quotes) |
| **A4 narrative** | team-portraits, closer, dark-band-statement, methodology-prose | autonomous | registry + controls |
| **A5 utility** | text-section, legal-page, kontakt-grid, breadcrumb-strip, timeline-strip, directory-card, umbrella-toc/subsection, service-area | autonomous | registry + controls |
| **A6 faq** | component + accordion (client island) | autonomous | island + `list<q/a>` control |
| **B1 flipbook** | port `PdfFlipbookC` as a `'use client'` island (`arbosano-flipbook`); props = page images + PDF (asset picker) | autonomous + UX check | `CustomIsland` + asset wiring |
| **B2 Jahresringe** | port `JahresringeScrollC` as a `'use client'` island (`arbosano-jahresringe`); props = rings asset | autonomous + UX check | `CustomIsland` |
| **B3 contact-form** | island; keep arbosano's Resend + Storage Brain endpoint; fields + recipient control | autonomous | island |
| **C1 theme system** | per-site palette/font/token theme + editor theme controls | **supervised** | theme model + controls |
| **D1 structural editing** | add/remove/reorder sections over `appComponentTree.children` | **supervised** | editor canvas/section list |
| **D2 import generator** | read `arbosano/src/content/pages/*.ts`, map each `BlockData[]` -> `appComponentTree` (one custom-component node per block; islands get their kind), seed all 11 pages via the Path A seeder | autonomous | new script |
| **E1 QA** | screenshot-diff every page vs live arbosano + one full edit round-trip | **supervised** | tests + manual |

Each component slice's contract: register the block as a custom component, declare its typed controls (map `BlockData` fields -> controls), and verify by **screenshot-diff against the live ArboSano section**.

## 5. Phases (dispatch order)

| Phase | Slices | Gate |
|---|---|---|
| **P0** | Track 0 (3.1-3.4) | a trivial registered component edits via a typed control and renders on a published page; a blank page is in the arbosano theme |
| **P1** | A1 navbar + A2 hero + 2 sections (A3) + D2 for the **home page only** | **home page live + editable on a subdomain, pixel-faithful**; a non-dev edits nav + a headline + reorders a section + republishes. MARLIN EYEBALL GATE. |
| **P2** | rest of Track A + Track B islands | `/gewerbe` flipbook + `/sachverstaendiger` Jahresringe render; all sections screenshot-clean |
| **P3** | C1 theme + D2 all 11 pages + D1 structural | whole site on the platform, theme-editable, sections reorderable |
| **P4** | E1 QA + cutover decision | every page passes screenshot-diff; cutover `arbosano.lumitra.co` -> `arbosano.de` planned |

P0 + P1 is the proof; do not commit P2-P4 spend until P1's eyeball gate passes.

## 5.5 Dependencies and sequencing vs the multi-tenant platform (Phase 2)

What is deployed at `app.lumitra.co` is the **single-tenant engine**. The real product (multi-user editor at `/projects/<id>` + wildcard `*.sites.lumitra.co` publish + random-subdomain binding + host-config flip) is a separate **multi-tenant Phase 2** build, not a prerequisite for ArboSano.

ArboSano needs all of this plan (Build A: the builder UX) plus only a **thin slice** of the multi-tenant work:
1. **Edit ArboSano's project** in the editor (a single-project editor route is enough; the per-user dashboard listing projects is NOT required for ArboSano).
2. **Publish ArboSano to one subdomain**, `arbosano.sites.lumitra.co`, as a single DNS + TLS record (the same per-host HTTP-01 path `app.lumitra.co` used). The wildcard `*.sites.lumitra.co` DNS-01 + wildcard TLS is NOT required for ArboSano; ArboSano folds into the wildcard when Phase 2 builds it.

What ArboSano does NOT need from Phase 2: the multi-user dashboard, random-subdomain generation, wildcard DNS/TLS, the full host-config flip. ArboSano is forward-compatible regardless: it lands as one `Site`/`SitePage`/`SiteDomain`, the exact substrate Phase 2 generalizes. So this build proceeds without blocking on the multi-tenant platform; the two converge later when both are ready. The Phase 2 multi-tenant plan should tag this thin slice so it can be pulled forward into the ArboSano track.

## 6. Orchestrator discipline

framer-clone is `stakes_tier 2`: **never pass `--confirm-stakes`.** Each slice: rebase onto current main before PR; auto-review -> PR -> squash-merge -> prune worktree+branch; **never push main directly**; scan every diff for em/en dashes (`grep -nP '[\x{2014}\x{2013}]'`) and fix in place before PR. Dispatch the `[autonomous]` slices via the orchestrator; pause for Marlin on the `[supervised]` ones (inspector UI, navbar UX, theme controls, structural editing, QA) before merging them.

## 7. Open decisions for Marlin (resolve at dispatch)

1. **Where ArboSano's React components live** for the renderer to import: vendor a component set into framer-clone for v1, or a per-tenant component bundle (the generalizable end state ArboSano validates). v1 recommendation: a vendored registered set.
2. **Subdomain**: `arbosano.lumitra.co` for staging, then the `arbosano.de` custom-domain cutover (the framer custom-domains roadmap, `#42`).
3. **Contact form**: keep arbosano's Resend + Storage Brain endpoint (recommended) or a framer-native form.
4. **Run depth**: dispatch **P0 + P1 first** as the proof (recommended), then the rest after the eyeball gate.

## 8. References

- Model map + file facts: `arbosano/plans/2026-06-26-arbosano-to-framer-clone-translation.md`
- framer-clone: the files in section 1
- arbosano: `src/components/c/`, `src/content/pages/*.ts`, `src/app/(site-c)/c-globals.css`
- memory: `project_framer_prod_deploy_2026_06_26.md`, `project_orchestrator_loop_state_2026_06_25.md`
- strategy: `knowledge-base/research/2026-05-31-holistic-lumitra-platform-plan.md`
