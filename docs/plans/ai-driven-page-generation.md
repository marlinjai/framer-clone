---
title: AI-Driven Page Generation via MST Snapshots
description: Plan for enabling AI agents to generate complete web pages by writing Framer Clone's MST snapshot syntax directly, making the data format the API contract.
order: 0
summary: AI agents generate pages by producing ComponentSnapshotIn JSON — no API layer needed. Pages are instantly editable in the visual editor and deployable. Outperforms tools like Sleek Design because output is not static mockups but fully editable, responsive, deployable pages.
type: plan
status: planned
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
