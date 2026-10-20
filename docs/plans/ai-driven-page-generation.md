---
title: AI-Driven Page Generation via MST Snapshots
description: Plan for enabling AI agents to generate complete web pages by writing Framer Clone's MST snapshot syntax directly, making the data format the API contract.
order: 0
summary: AI agents generate pages by producing ComponentSnapshotIn JSON — no API layer needed. Pages are instantly editable in the visual editor and deployable. Outperforms tools like Sleek Design because output is not static mockups but fully editable, responsive, deployable pages.
type: plan
status: in-progress
date: 2026-03-22
tags: [framer-clone, ai, plan, mst, page-generation, snapshot]
projects: [framer-clone]
---

# AI-Driven Page Generation via MST Snapshots

## Vision

AI agents (Claude Code skills, MCP tools, or any LLM) generate complete web pages by outputting the Framer Clone's native MobX-State-Tree snapshot format. No REST API layer is needed — the JSON data format IS the contract.

This creates a workflow that outperforms dedicated AI design tools like Sleek Design because:

1. **Editable** — AI-generated output loads directly into the visual editor with full properties panel access. Users can fine-tune spacing, colors, typography, and layout visually after generation.
2. **Responsive** — The breakpoint system is built into the snapshot format. AI generates per-breakpoint styles in a single pass (desktop, tablet, mobile).
3. **Deployable** — The `appComponentTree` in each page is the production-ready component tree. What the AI generates is what ships.
4. **Iterative** — Users can prompt the AI for changes, manually edit in the canvas, then prompt again. The snapshot format round-trips perfectly between AI and editor.
5. **Composable** — AI can generate partial trees (a hero section, a pricing table) and users can compose them on the canvas alongside hand-built components.

In short: AI generates it, the editor refines it, the export deploys it. One format throughout.

## How It Works

### The Snapshot Format as API

The `ComponentSnapshotIn` type from `ComponentModel.ts` is already a complete, serializable description of any component tree:

```json
{
  "id": "hero-section",
  "type": "section",
  "componentType": "host",
  "label": "Hero Section",
  "props": {
    "style": {
      "display": "flex",
      "flexDirection": "column",
      "alignItems": "center",
      "padding": {
        "base": "24px",
        "bp-desktop": "64px",
        "bp-tablet": "48px",
        "bp-mobile": "24px"
      },
      "background": "linear-gradient(135deg, #667eea 0%, #764ba2 100%)"
    }
  },
  "children": [
    {
      "id": "hero-heading",
      "type": "h1",
      "componentType": "host",
      "label": "Heading",
      "props": {
        "children": "Build something amazing",
        "style": {
          "fontSize": { "base": "48px", "bp-mobile": "32px" },
          "fontWeight": "700",
          "color": "white"
        }
      },
      "children": []
    },
    {
      "id": "hero-cta",
      "type": "button",
      "componentType": "host",
      "label": "CTA Button",
      "props": {
        "children": "Get Started",
        "style": {
          "padding": "16px 32px",
          "fontSize": "18px",
          "backgroundColor": "white",
          "color": "#667eea",
          "borderRadius": "8px",
          "border": "none",
          "cursor": "pointer"
        }
      },
      "children": []
    }
  ]
}
```

Key properties:
- `type` — Any valid HTML intrinsic element (`div`, `section`, `h1`, `img`, `button`, etc.)
- `componentType` — `"host"` for HTML elements, `"function"` for custom components
- `canvasNodeType` — `"component"` (app tree), `"viewport"` (breakpoint frame), `"floating"` (canvas element)
- `props.style` — CSS properties, optionally responsive via `{ "base": "...", "bp-id": "..." }` maps
- `children` — Nested component array (recursive tree)
- `label` — Human-readable name shown in layers panel

### Full Page Snapshot

A complete page snapshot includes the app component tree and canvas nodes:

```json
{
  "id": "page-landing",
  "slug": "landing",
  "metadata": {
    "title": "Landing Page",
    "description": "AI-generated landing page",
    "keywords": ["landing", "saas", "startup"]
  },
  "appComponentTree": { "...component tree..." },
  "canvasNodes": {
    "viewport-desktop": { "...viewport node with breakpointId, position..." },
    "viewport-tablet": { "...viewport node..." },
    "viewport-mobile": { "...viewport node..." }
  }
}
```

### What the AI Needs to Know

1. **Valid HTML element types** and their semantic usage
2. **The CSS property set** supported by the editor (defined in `CSS_PROP_SET` in `ComponentModel.ts`)
3. **Responsive value syntax** — `{ "base": "value", "breakpointId": "override" }` for any style property
4. **Component nesting rules** — which elements can contain children, layout patterns (flex, grid)
5. **Canvas node types** — when to use viewport vs floating vs app tree components

### Import Path

The user loads AI-generated JSON into the editor. Implementation options (simplest first):

1. **Paste JSON** — A simple import dialog that accepts snapshot JSON and calls `applySnapshot()` or `page.setAppComponentTree()`
2. **File import** — Load `.json` files from disk
3. **Claude Code skill** — A skill that generates the snapshot and writes it to a file the editor watches
4. **Clipboard bridge** — AI copies snapshot to clipboard, user pastes into editor

## Implementation Phases

### Phase 1: Schema Documentation + Import

- Document the full `ComponentSnapshotIn` schema as a reference (valid types, props, style keys, responsive syntax)
- Build a minimal import mechanism (paste JSON dialog or file drop)
- Create a component catalog — a machine-readable manifest of available element types and common patterns
- Test round-trip: export snapshot from editor, re-import it, verify fidelity

### Phase 2: AI Skill / Prompt Template

- Create a Claude Code skill or prompt template that knows the snapshot schema
- The skill accepts a natural language description and outputs valid snapshot JSON
- Include design system awareness: spacing scales, typography, color palettes
- Test with common page types: landing page, pricing page, blog post, dashboard

### Phase 3: Partial Generation + Composition

- Support generating partial trees (just a section, just a navbar) rather than full pages
- Allow inserting AI-generated subtrees into specific positions in existing pages
- Enable "describe what you want changed" prompts that read current state and output diffs

### Phase 4: Design Intelligence

- Teach the AI common layout patterns (hero + features + testimonials + CTA + footer)
- Add design system presets (spacing scales, type scales, color palettes) as context
- Support style references ("make it look like Stripe's landing page", "use a dark theme")
- Visual feedback loop: screenshot the canvas and feed it back to the AI for iteration

## Competitive Advantage Over Sleek Design and Similar Tools

| Capability | Sleek Design | Framer Clone + AI |
|---|---|---|
| AI generates design | Yes | Yes |
| Editable after generation | Limited | Full visual editor with properties panel |
| Responsive breakpoints | Unknown | Built-in, AI generates per-breakpoint |
| Deployable output | Export only | Direct deployment from editor |
| Iterative AI + manual editing | Regenerate | Round-trip between AI and editor |
| Component reuse | No | Composable partial trees |
| Open format | Proprietary | JSON snapshots, version-controllable |

The key differentiator: other tools treat AI generation as the end product. Here, AI generation is the starting point — the output lives in a full visual editor where it can be refined, extended, and deployed.

## Reality update (2026-09-10)

Status word "planned" was not one of the six shared values; reconciled to draft (no code evidence of full AI page generation via MST snapshots on main; the related wave-2 `ai-pattern-a-canvas-mutation-tools` spec was archived as an unbuilt draft in the same reconciliation). Kept live and linked from the root ROADMAP.md during work-down session 9b.

## Reality update (2026-10-19)

Marlin decided on 2026-10-19 to build this plan (draft, then decided, then in-progress the same
day). Phases 1 to 3 are being built on branch `feat/ai-page-generation` as an in-editor feature
rather than a separate Claude Code skill, because the editor already holds the project in MST and
already talks to Anthropic through `/api/ai/*`:

- **Phase 1 (schema documentation + validation)**: `src/lib/ai/pageGen/schemaDocs.ts` generates
  the model-facing schema reference from the real component registry (`COMPONENT_REGISTRY`), the
  editor's property-panel tag sets (`sectionConfig.ts`) and `CSS_PROP_SET`, never by hand; a golden
  test fails when the registry and the docs drift apart. `src/lib/ai/pageGen/validate.ts` checks
  every model output with zod, repairs what is unambiguous (unknown style keys, unsafe links, ids,
  `parentId`), rejects what is not (limits, void tags with children, empty output), and runs the
  result through `ComponentModel.is()` before anything reaches the editor. An invalid snapshot is
  never applied. The paste-JSON import dialog of the original phase 1 is replaced by this path.
- **Phase 2 (generation)**: `POST /api/ai/generate-page`, guarded exactly like the CMS agent
  (session, active company with the Sites grant, `editSite`, 401/403/503), streams progress over
  Server-Sent Events, with a size budget and a per-user rate limit per request, and one repair
  round with the model before rejecting.
- **Phase 3 (partial generation + composition)**: the same route generates a section that
  replaces the selected component or is inserted into the selected container.
- **Undo**: generation is applied on the client as one MST action, so Cmd+Z reverts it in one
  step; the dialog's "Undo generation" button replays the recorded inverse (remove the page, or put
  the replaced subtree back) and reports a conflict instead of guessing. This mirrors the CMS
  agent's one-click run undo; no server-side run record is written, because nothing is persisted
  until the user saves.
- **Phase 4 (design intelligence)**: only the cheap part, page-pattern and spacing guidance in the
  system prompt. Style references from URLs and the screenshot feedback loop stay open.

### Models and cost (re-baselined 2026-10-20)

The AI layer runs on the current models: Claude Sonnet 5.5 (`claude-sonnet-5-5`, $2 input / $10
output per million tokens) is the page generator's default, Claude Haiku 5.5 (`claude-haiku-5-5`,
$0.10 / $0.50) is its "Fast" step, and Claude Opus 5.5 (`claude-opus-5-5`, $4 / $20) stays the
CMS content agent's default. The content agent runs at effort `medium` on Opus and Sonnet
(multi-step tool work over real data, where a wrong write costs an undo) and `low` on Haiku, with a
16,000-token cap per turn that thinking shares; its cost per run therefore depends mostly on how
many tool turns a request takes. Since 2026-10-20 Opus is offered for page generation too, as the
"Best" step of the model slider (see the build notes below), but it is not the default. Page generation runs at effort `medium` with adaptive thinking,
so thinking shares the 32,000-token output cap per attempt. A typical page (about 8,000 output
tokens plus a cached system prompt) costs roughly $0.08 to $0.10 on Sonnet 5.5 and well under one
cent on Haiku 5.5; the worst case, two full attempts on Sonnet 5.5, is about $0.64. Sonnet and Opus
requests carry the server-side fallback opt-in (`fallbacks: "default"`), so a classifier false
positive is retried on another model instead of failing; Haiku 5.5 has no server-side fallback, so
a refusal there is shown to the user.

## Build notes (2026-10-20): stock images and model choice

Two owner decisions of 2026-10-20, built on branch `feat/ai-stock-images`.

### Real stock photos from Unsplash

Before this, every generated image was the placeholder `/images/sample-image.jpg`.

- **What the model gives**: for every image it places without a URL from the brief, an
  `imageQuery` prop (a short English search query, 2 to 6 words) and an `alt` text in the page's
  language. The schema docs (`schemaDocs.ts`, golden-tested) and the system prompt say so. The
  validator stays authoritative: it checks the query (plain words, at most 80 characters, no URLs
  or markup), takes it OUT of the props (it never reaches the editor), and collects it with the
  image box's shape (`orientation` from px width and height) and width into a server-side list.
  A src the brief provided wins over a query.
- **Resolving** (`src/lib/ai/pageGen/stockImages.ts`, server-only): after a valid generation and
  before the result is sent, the route searches Unsplash (`GET /search/photos` with
  `Authorization: Client-ID <key>`, `content_filter=high`, the orientation when the box says),
  once per distinct query and orientation, at most 4 searches in flight. Photos are distinct per
  page (a photo is never placed twice). At most 12 images are resolved per generation; the rest
  keep the placeholder. Results are cached in memory per query for 30 minutes (successful
  searches only). Every request has a 5 second timeout.
- **Failure handling**: the first 401/403 (`auth`), 429 (`rate_limited`), 5xx or network error
  (`unavailable`) or timeout stops further searches for that generation; every unresolved image
  keeps the placeholder and the result carries a count per reason. The dialog shows one line per
  reason ("3 images use the placeholder: the hourly stock photo limit is used up") as a note,
  never an error: the page itself was generated. Without `UNSPLASH_ACCESS_KEY` the feature is off
  and the note says stock photos are not set up on this server.
- **Unsplash API guidelines**: photos are hotlinked from images.unsplash.com (`raw` sized to twice
  the box width with `w`, `q`, `fit`, `auto` when the width is known, else `regular`), never
  re-hosted. Each placed photo's `links.download_location` is called once, server-side,
  fire-and-forget with error logging, when the result carrying it is sent to the editor (not when
  the client already went away). Attribution with `utm_source=<app name>&utm_medium=referral`
  (app name from `UNSPLASH_APP_NAME`, default `lumitra`).
- **Where the attribution lives** (decided): the editor's image is a plain `<img>`, and both the
  canvas and the published-site renderer pass string props through as HTML attributes, so the
  credit is stored as attributes on the image with no renderer change: `title` ("Photo by
  <name> on Unsplash", the visible hover credit), `data-credit-name`, `data-credit-url` (the
  photographer's profile) and `data-credit-source-url` (unsplash.com). The Generate dialog also
  lists every placed photo's credit with real links. When the user replaces an image's URL in the
  properties panel, the credit is removed with the same edit (`stockCredit.ts`), so a user's own
  photo never ships with a stranger's credit. A visible caption on the published page was not
  chosen: it would change the layout of every generated design.
- **Image domains and CSP**: nothing to change. `next.config.ts` already allows every https host
  for `next/image`, generated images render as plain `<img>` (not `next/image`) in the canvas,
  preview and published site, and the app sets no Content-Security-Policy.
- **Key handling**: `UNSPLASH_ACCESS_KEY` is read server-side only (framer-clone's Infisical
  project, dev and prod), never sent to the browser and never logged.

### Model choice as a slider

- A three-step slider, Fast = Claude Haiku 5.5, Balanced = Claude Sonnet 5.5, Best = Claude Opus
  5.5, with a one-line hint on speed and relative cost (Haiku about 1/20 of Sonnet's price, Opus
  about 2x), in the Generate dialog (replacing the old "Fast" / "Best quality" toggle) and in the
  CMS agent's input bar (replacing its dropdown). Defaults unchanged: Balanced for page generation,
  Best for the content agent. Shared component `src/components/ai/ModelSlider.tsx`: a native range
  input (keyboard and screen-reader semantics from the platform) whose `aria-valuetext` reads out
  the step and model name.
- **Allowlist** (decided): the wire format stays the model KEY (`HAIKU`, `SONNET`, `OPUS`,
  `src/lib/ai/modelChoice.ts`), validated by a zod enum on both routes; a raw model id or an
  unknown step answers 400 before any model call, and the generate-page body refuses unknown
  fields. The server maps the key to the configured id (`AI_MODELS` in `anthropicClient.ts`;
  `AI_DEFAULT_MODEL` stays the only env override, untouched).
- **Effort per model** (decided): page generation runs every step at `medium`, as before (one
  design pass behind a validation gate). The content agent keeps `low` on Haiku and `medium` on
  Sonnet and Opus. Worst case per page generation request (two full attempts of 32,000 output
  tokens): about $0.03 on Haiku, $0.64 on Sonnet, $1.28 on Opus.
- **Remembered per browser** (decided): the editor has no user id on the client, so the last
  choice per surface is kept in `localStorage` (inside try/catch, a nicety only) and is therefore
  per browser profile. For page generation the remembered choice wins over a project's saved
  draft, so it carries across projects.

