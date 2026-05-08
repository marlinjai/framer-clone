---
title: Framework-Agnostic Renderer Research
type: plan
status: draft
date: 2026-05-01
tags: [research, mitosis, multi-framework, lumitra-integration, mst]
projects: [framer-clone, analytics-platform]
summary: Research session evaluating Mitosis and four alternative paths for emitting non-React output from the framer-clone canvas. Recommendation: stay React-only at publish, ship a static-HTML-with-islands target next, defer Mitosis (or any IR-based multi-framework strategy) by 12 months.
---

# Framework-Agnostic Renderer Research

> Strategic research doc. Not a build plan. Captures whether Framer-clone should decouple its renderer from React (likely via Mitosis from Builder.io) so the canvas can publish to React, Vue, Svelte, Solid, Angular, and plain HTML. Conclusion at the bottom.

## Why we are even asking this

Three forces created the question:

1. **Lumitra Studio integration** is being designed to live inside Framer-clone (heatmaps overlaid on the design canvas, A/B variants as design alternatives, live experiment results in the sidebar). It depends on `data-component-id` and `data-inner-component-id` attributes surviving to the published DOM in any target framework. Today they only survive to React output, because React is the only target.
2. **Aspirational positioning**. "Design once, publish to your team's stack" is a marketing line that no current visual builder owns cleanly. Framer publishes static HTML, Webflow publishes static HTML, Builder.io is a CMS layer dropped into an existing app. None of them advertise multi-framework page output.
3. **Dependency reality.** The canvas tree (`src/models/ComponentModel.ts`) is already framework-neutral data: an MST tree of nodes with `type`, `props`, `children`, and a per-breakpoint props resolver. Only the renderer (`src/components/ComponentRenderer.tsx` and `src/lib/renderer/HeadlessComponentRenderer.tsx`) is bound to React.

The question is whether to invest in framework-agnostic output now, while the renderer is small, or stay React-only and revisit when a customer actually asks.

## Current renderer architecture

Useful before evaluating alternatives. The renderer has already been split into two halves:

- **Editor renderer** (`src/components/ComponentRenderer.tsx`): adds editor chrome on top of the headless path. Selection click, double-click to enter contenteditable, drag pointerdown via `useDragSource`, edit-mode style overrides, autofocus and select-all on edit entry.
- **Headless renderer** (`src/lib/renderer/HeadlessComponentRenderer.tsx`): pure render path. Resolves responsive props via `getResolvedProps`, walks children, emits React elements. Zero editor coupling: no store reads, no event handlers, no `data-component-id` attributes, no contenteditable. This is what publish would call.
- **Shared dispatch** (`src/lib/renderer/createComponentElement.tsx`): handles HOST tag emission (with void-tag check) versus FUNCTION component lookup against `window.__componentRegistry`.

`ComponentRenderer.tsx:69-70` is currently where `data-component-id` and `data-inner-component-id` are attached. They are NOT attached in the headless path today. That is a bug for Lumitra Studio: a published site has no IDs to identify clicks against.

The existing two-renderer split is the most architecturally important fact for this discussion. The editor never has to be framework-agnostic. Only the publish path does.

## Research question 1: Mitosis viability

### What Mitosis is

Open-source compiler from Builder.io that transforms a static subset of JSX into framework-specific code: React, Vue, Svelte, Solid, Angular, Qwik, Lit, Stencil, raw web components, plus React Native and Alpine targets. JSX gets parsed to a JSON IR, then per-framework serializers emit native code. Last release was 2026-01-13 (`@builder.io/mitosis-cli@0.13.0`), 13.8k stars, 1898 commits, 155 open issues. Actively maintained. Builder.io itself uses Mitosis to ship its own SDKs in each framework.

### 1a. data-* attribute pass-through

Mixed signal. Mitosis docs explicitly note that "Mitosis internally prefers class attributes over data-*", which is a smell for a system that needs `data-component-id` on every emitted element. However, JSX spread attributes ARE supported via the `<span {...props.attributes}>` pattern (passing an `attributes` object as a single prop, then spreading it). So the workable shape is:

```jsx
// Mitosis-friendly (works across targets):
<div {...props.htmlAttributes} class={props.className}>
```

NOT:

```jsx
// Mitosis-hostile (rest params not supported):
function Foo({ children, ...rest }) {
  return <div {...rest}>{children}</div>;
}
```

For Framer-clone this means: if we generate Mitosis components, every component must take an explicit `htmlAttributes` prop (containing `data-component-id`, `data-inner-component-id`, and any other framework-neutral DOM attributes), and the spread must be on the root element. Survivable but rigid. Every custom function component the user defines also has to follow this contract.

### 1b. JSX-with-restrictions DSL

The compiler's input is "a static subset of JSX, inspired by Solid". The exhaustive list of restrictions I confirmed from the docs:

1. State must come from `useStore({...})` and the variable must be named `state`.
2. Cannot reference `props` when initializing state. Use `onMount()` to copy props into state.
3. Cannot initialize state with computed values or function calls. Define getter methods on the store instead.
4. Destructuring assignment from `state` is silently ignored by the compiler. Use dot notation.
5. Async methods cannot be defined on state. Use IIFE async or promise chains.
6. Default values in destructured function parameters are ignored.
7. `...rest` parameter on functions is not supported.
8. `console.log` is stripped from the compiled output. No way to keep it.
9. One component per file. Single default export.
10. Variable shadowing of state property names breaks bindings.
11. Conditional rendering via `<Show when={...}>` only. No ternaries that produce JSX in the template.
12. Loops via `<For each={...}>` only. No `.map()` in JSX templates.
13. CSS-in-JS via the `css` prop with camelCase keys, OR external CSS files (the Mitosis CLI does NOT auto-move imported CSS to the output; user has to wire that themselves).
14. No external styling libraries (twin.macro, styled-components, etc.) without TypeScript module augmentation hacks.

For a builder's library of 8 components (Text, Button, Image, Container, Stack, Grid, Flex, Card per `src/lib/componentRegistry.ts`), these restrictions are survivable. The components are mostly stateless wrappers around HTML tags with default props. The pain shows up when (a) users define custom function components and have to learn the DSL, or (b) Framer-clone adds anything stateful to a primitive component (e.g., a Carousel, an Accordion).

### 1c. State, events, side effects across frameworks

Mitosis maps:

- `useStore` → React `useState`/`useReducer`, Vue `ref`/`reactive`, Svelte stores, Solid signals, Angular signals.
- Event handlers as inline functions on JSX → native event binding per framework.
- `onMount`, `onUpdate`, `onUnMount` → framework lifecycle equivalents.

For Framer-clone's specific needs, the mapping is mostly fine because most needs are editor-only (drag handlers, edit-mode click capture, contenteditable). Editor-only logic stays in React and never goes through Mitosis.

What needs Mitosis support:

- **Breakpoint resolution at render time.** Today this is `getResolvedProps` walking the tree at render time, picking the right value per breakpoint. In Mitosis output for non-CSS-clamp targets, this resolution would have to happen via media-query CSS or container queries baked at compile time, not at runtime. That is a meaningful design shift (covered in 2c).
- **Inline text editing.** Doesn't need Mitosis support: it's editor-only, never published.
- **Drag handlers.** Editor-only.
- **Hydration-safe event handlers on published sites.** A published site needs onClick navigation, form submit, etc. Mitosis handles inline event handlers fine.

### 1d. Fidelity gap

Things `ComponentRenderer.tsx` (and `createComponentElement.tsx`) currently express that Mitosis cannot, or cannot cleanly:

1. **Dynamic tag name from a string variable.** `React.createElement(component.type, props, children)` where `component.type` is a runtime string like `"div"` or `"button"`. Mitosis JSX needs the tag at compile time. Vue has `<component :is="...">`, Svelte has `<svelte:element this={...}>`, Angular has `*ngComponentOutlet` (for components, not elements). These are NOT all equivalent and Mitosis would have to abstract them. Last I checked Mitosis does not have a clean primitive for this. This is a hard blocker for the current architecture, where `component.type` is data-driven.
2. **Runtime registry lookup.** `(window as any).__componentRegistry?.[component.type]` for FUNCTION components. Mitosis components are statically resolved at compile time. A runtime registry that maps strings to compiled components has to be assembled per framework target, separately, by the user.
3. **Spread of arbitrary `attributes` object computed at runtime.** Works only if Mitosis emits a clean spread; some targets (older Angular versions) translate spread into per-property bindings, losing data-* attributes that aren't statically declared on the type. Survivable with discipline, fragile in practice.
4. **`contentEditable="true"` plus `suppressContentEditableWarning`** with autofocus selection range manipulation. React-specific code, lives in editor, not a publish concern. Listed for completeness.
5. **Per-breakpoint prop resolution at render time.** Today's `getResolvedProps` runs per render, per breakpoint, against the live MST tree. Mitosis-compiled components don't have access to a live MST tree at runtime in the published site. The breakpoint logic would have to be flattened to CSS media queries or container queries at compile time.
6. **MobX observer reactivity.** `mobx-react-lite`'s `observer` HOC wraps the renderer to re-render on MST mutations. In an editor that stays React, this stays. In a published Vue/Svelte/Angular site, there is no MST tree to observe; the publish output is static and doesn't need it.
7. **Floating elements vs tree elements.** `CanvasNodeType.FLOATING_ELEMENT` is positioned absolutely on the canvas with `canvasX`/`canvasY`. In published output, floating elements typically become absolutely-positioned divs at fixed coordinates, but on responsive sites this often breaks. Mitosis is neutral on this; it's a renderer design question regardless.
8. **`pointerEvents: 'auto'` injection in editor mode.** Editor-only.
9. **Hidden-via-`canvasVisible` filter.** Editor-only flag, but if Layers panel hides a node, that should presumably persist to published output as `display: none`. Trivial in any target.
10. **Void-tag handling.** `isVoidTag(component.type)` skips children for `<img>`, `<br>`, etc. Handled per-framework by Mitosis serializers natively, no special action needed.

The fidelity gaps that actually matter are #1, #2, and #5. Those are not survivable without significant architectural changes to how Framer-clone represents its tree and resolves props.

## Research question 2: MST → Mitosis mapping

### 2a. Build-time vs runtime transformation

Mitosis is a compile-time tool. Its input is JSX source files, its output is framework-specific source files. It is NOT a runtime library that reads JSON and emits DOM. So an MST tree cannot be "fed to Mitosis at publish time" the way Marlin's question implicitly suggests.

The realistic mappings:

- **(A) MST → JSX source generation → Mitosis compile.** At publish time, walk the user's canvas tree, generate a Mitosis-flavored `.lite.tsx` file per page, run `mitosis compile --to=react,vue,svelte,...` on each, ship the outputs. This is a build-time pipeline. The published site is a static build per framework.
- **(B) MST → JSON → ship runtime SDK in each framework.** Skip Mitosis entirely. Each framework target gets a tiny runtime renderer (`@framer-clone/runtime-react`, `@framer-clone/runtime-vue`, etc.) that takes the JSON tree and renders. This is what Builder.io does for its SDKs.

Path A keeps Mitosis as the central abstraction but requires a code-generation step (MST tree → Mitosis JSX) on every publish. Path B is simpler operationally but requires owning N runtime renderers in N frameworks (1 to 6 packages depending on target list).

If we go Mitosis-route, it's path A: generate Mitosis JSX from the MST tree at publish time, compile per framework.

### 2b. Intrinsic vs function components

`ComponentTypeEnum` has two values: HOST (intrinsic HTML tag) and FUNCTION (lookup in `__componentRegistry`).

- HOST nodes generate `<div {...attrs}>{children}</div>` style Mitosis JSX. Static at compile time per page.
- FUNCTION nodes generate `<UserComponentName {...attrs}>{children}</UserComponentName>` and require the user component to also be a Mitosis component, i.e., users who want to ship custom components have to write them in Mitosis JSX subject to all 14 restrictions above. This is a meaningful product constraint.

For Framer-clone today, the FUNCTION path is mostly internal (the registry of 8 layout primitives in `componentRegistry.ts`). Marlin could theoretically maintain those 8 in Mitosis JSX himself. The question is whether users will eventually want to define custom function components in their canvas. If yes, they have to learn the Mitosis DSL or Framer-clone has to forbid custom function components and offer only intrinsic compositions.

### 2c. Responsive props per breakpoint, per framework

Today, `getResolvedProps(breakpointId, allBreakpoints, primaryId)` runs at render time, picks the right value for each prop based on a smaller-first-then-larger fallback search across breakpoints. In a multi-framework publish output, this resolver cannot live in JS at runtime (we don't ship MST to the published site). It has to be flattened.

Two real options for compile-time flattening:

- **CSS-driven per-breakpoint output.** Emit one CSS file per page with `@media (min-width: 768px)` style rules generated from the MST's breakpoint values. The HTML structure is identical across breakpoints, only styles change. This works for any framework target because it's framework-neutral CSS. Limitation: structural differences between breakpoints (e.g., a node visible only on mobile) require `display: none` toggles, not actual structural changes.
- **Per-breakpoint structural variants.** If a node's structure differs across breakpoints (e.g., different children at mobile vs desktop), generate separate sub-trees with `display` toggles. Fundamentally still CSS-driven, but with more DOM duplication.

For 90% of the user's design intent, CSS media queries cover it. The pain shows up if Framer-clone ever wants to support genuinely conditional rendering across breakpoints (which it doesn't today: the same MST tree is rendered at all breakpoints, only props vary). For now, CSS flattening is sufficient.

This works regardless of Mitosis vs JSON-runtime path.

### 2d. Floating vs tree-based components

`CanvasNodeType.FLOATING_ELEMENT` carries `canvasX`/`canvasY` and renders as absolutely-positioned. The `GroundWrapper` component handles the canvas-specific wrapper logic.

In published output, floating elements need to render as `position: absolute; left: Xpx; top: Ypx;` inside a positioned ancestor. Same approach in any framework target. Not a Mitosis-specific issue.

The harder problem (orthogonal to multi-framework): floating elements at a fixed pixel position break responsive design at non-design viewport sizes. Framer the actual product solves this with explicit "stick to" constraints per breakpoint. Framer-clone doesn't yet. Worth raising but not a multi-framework question.

## Research question 3: Alternatives to Mitosis

Four alternatives, each with viability and effort assessment.

### 3a. Custom AST emitters per framework

Build framework-specific emitters that walk the MST tree and produce React/Vue/Svelte/etc. code directly. We own the entire pipeline.

- **Viability:** High for the 3 frameworks we care about most (React, Vue, Svelte). Each emitter is roughly 800 to 1500 lines of TS. Each new framework is roughly 1 week to bootstrap, then a long tail of edge cases.
- **Effort:** 4 to 6 weeks for React + Vue + Svelte at acceptable quality. Add 1 to 2 weeks per additional target.
- **Trade-offs:** Maximum control, no third-party DSL constraint, no surprises from Mitosis compiler bugs. Cost: we maintain N emitters forever, every new feature has to be implemented in N places. Long-term tax we pay every sprint.
- **Verdict:** Viable but expensive. Worth pursuing only if we genuinely commit to multi-framework as a product pillar.

### 3b. Web Components via Lit or Stencil

Compile the canvas to Web Components. All frameworks consume Web Components natively (with minor caveats around React 18 vs 19 attribute binding semantics).

- **Viability:** Single output target solves the multi-framework problem in one shot. Web Components have universal support. Lumitra Studio's `data-*` attributes work natively because they're DOM attributes, no framework abstraction.
- **Effort:** Higher than expected because Web Components are not idiomatic in React, Vue, or Svelte. SSR support is weak (still a hard problem in 2026). Custom element styling boundaries (shadow DOM) cause issues with global CSS, fonts, theming. Form participation requires `ElementInternals` which is fiddly.
- **Trade-offs:** One implementation, but the DX in any target framework is mediocre. Users get Web Components in their React app, which feels foreign. SEO/SSR for the published sites becomes a research project of its own.
- **Verdict:** Architecturally elegant in theory, painful in practice. Skip unless we're willing to make Framer-clone-published sites Web-Component-shaped permanently.

### 3c. Static HTML + minimal hydration islands

No framework on the published site. Generate static HTML at publish time, ship a tiny vanilla-JS islands runtime for interactive bits (forms, A/B variant application, navigation).

- **Viability:** Extremely high. This is what Framer the actual product does. What Webflow does. What Squarespace does. The customer doesn't care about React/Vue/Svelte in their published site; they care that the site loads fast and works.
- **Effort:** 2 to 3 weeks to build a static HTML emitter from the MST tree (largely overlapping with what `HeadlessComponentRenderer.tsx` already does, just emitting strings instead of React elements). Plus 1 week for a minimal hydration runtime for Lumitra-driven runtime variant application and basic interactivity.
- **Trade-offs:** Solves the "publish to anywhere" problem differently than the question framed. Customers don't get a React component to drop into their app. They get a hosted URL or a downloadable HTML/CSS/JS bundle. For 95% of visual-builder customers, that's the expected shape.
- **Verdict:** Strong. Cleanest architecture. Lumitra Studio integration drops in trivially because everything is plain DOM. Worth pursuing AS the next renderer target after React, before any multi-framework consideration.

### 3d. JSON-driven runtime renderer in N frameworks

Same canvas tree (as JSON), N runtime SDKs (one per framework). Each SDK takes the JSON and renders it natively. No build-time per-framework code generation. This is what Builder.io does for its SDKs.

- **Viability:** Builder.io has demonstrated this works in production for a similar problem shape. Ironically, the Builder.io SDKs are themselves authored in Mitosis, but the Mitosis compile-time output is a runtime renderer per framework, not per-page generated code.
- **Effort:** 1 to 1.5 weeks per framework runtime, plus 1 week for the shared JSON schema. So roughly 4 to 5 weeks for React + Vue + Svelte.
- **Trade-offs:** Customer's published site ships their framework PLUS the framer-clone runtime SDK (a few KB gzipped). The runtime renders the design tree as native framework components. Lumitra `data-*` attributes flow through trivially, runtime variant hooks (`window.__framerRuntime.applyExperimentVariant`) are framework-neutral and live outside the SDK. This is structurally how Builder.io built it and the path that survives feature growth without N parallel implementations.
- **Verdict:** Best multi-framework option IF multi-framework is genuinely required. Doesn't require Mitosis as a dependency (Mitosis is one way to build the SDKs but not the only way).

## Research question 4: Lumitra Studio compatibility

Across the viable options:

| Option | data-* survives | Runtime variant hook | Heatmap-overlay-during-edit |
|--------|-----------------|----------------------|----------------------------|
| Mitosis (path A: generate per-page code) | Yes, with discipline (always pass `htmlAttributes` and spread on root) | Per-framework wrapper around `window.__framerRuntime`, but framework-neutral DOM mutations work universally | Yes: editor stays React, heatmap logic queries `data-component-id` against the rendered DOM regardless of source |
| Static HTML + islands | Yes natively | Pure JS, framework-neutral | Yes |
| JSON-driven runtime per framework | Yes if SDK passes attributes through | Lives outside the SDK, framework-neutral | Yes |
| Custom AST emitters | Yes if we write the emitters that way | Per-framework wrapper, framework-neutral mutations | Yes |
| Web Components | Yes natively (DOM attributes) | Pure DOM | Yes |

**Critical observation:** the `data-component-id` attribute survives in EVERY option because it's a DOM attribute and all frameworks respect arbitrary DOM attributes (with the noted Mitosis caveat that you have to pass them as a spread of an `attributes` object, not as type-checked individual props).

The runtime variant hook (`window.__framerRuntime.applyExperimentVariant(experimentKey, variantKey)`) is framework-neutral by design (it's a window-global). It mutates the DOM directly via `findByFingerprint` and the mutation primitives from Pillar 2 of the analytics-platform plan. Framework matters not at all here.

The asymmetry of "edit-mode is React, published site might not be" is fine. Lumitra Studio in edit mode reads the React-rendered DOM directly (heatmap data attached to `data-component-id`-tagged elements). The published site uses the same `data-component-id` attribute, so cross-domain matching works regardless. The asymmetry is invisible at the data layer.

## Research question 5: Migration path

If we adopt any non-React publishing path, three migration shapes:

- **(a) Big-bang renderer rewrite.** Tear out `ComponentRenderer.tsx` and rewrite. High risk, high reward, ships nothing for 6 weeks.
- **(b) Parallel publish target.** Keep React publish, add Mitosis (or alternative) as opt-in. Customers select which. Doubles maintenance surface.
- **(c) Editor stays React, publish target swaps.** Editor renderer is React forever (operational simplicity, MobX reactivity, contenteditable works natively). Publish renderer is whatever we choose. The split already exists in the codebase (`ComponentRenderer.tsx` vs `HeadlessComponentRenderer.tsx`); we are extending the publish side.

**Recommendation: (c).** It is the lowest-risk path and matches the existing architecture. The editor never has to be framework-agnostic. Marlin can change publish targets independently without rewriting the editing surface, and the editor stays in the language and tooling we already use. This is true regardless of which publish target we eventually pick (Mitosis, static HTML, JSON-runtime).

## Research question 6: Strategic reflection

### 6a. Is multi-framework publishing a customer ask?

No evidence yet. The user (Marlin) has zero customer requests for non-React published output. The closest thing is "Lumitra needs to work on non-React sites", which is being solved at the Lumitra layer (Pillar 1: DOM-fingerprint identification, framework-neutral by design) and does NOT require Framer-clone to publish to non-React.

The relevant comp is Framer the product. Framer publishes static HTML + a minimal JS bundle. They don't publish "to React" or "to Vue". Customers don't ask them to. The customer mental model for visual builders is "host my site at a URL", not "give me a Vue component I can drop into my app".

The exception is Builder.io, which is explicitly a content/CMS layer dropped INTO an existing app. Framer-clone is positioned as a Framer competitor (full visual builder, hosted publish), not a Builder.io competitor. Different customer, different requirement.

### 6b. What does framework-agnosticism cost in product velocity?

If every feature has to work in 5 frameworks, Framer-clone ships at roughly 1/3 to 1/5 the velocity of the React-only version. Concrete costs:

- Every new layout primitive (today there are 8) needs Mitosis-DSL compliance or per-framework emitter logic.
- Every drag/drop edge case has to be debugged in N frameworks (or at least the publish output verified in N).
- Every responsive-prop edge case (e.g., the `getResolvedProps` smaller-first-then-larger fallback) has to be flattened to CSS in a way that survives 5 framework targets.
- The Lumitra Studio integration (Phases A through D in the analytics-platform plan) gets a 5x compatibility matrix.

For a single-developer (or 2-person) team, this is a 12-month tax on every feature. The business case has to be very clear.

### 6c. Who is the customer for non-React output?

Hypothetical:

- Enterprise customers whose internal teams use Vue or Angular and want designs to drop into their stack. Real, but not Marlin's customer base today.
- Agencies that produce designs in Framer-clone for clients on different stacks. Plausible. Still hypothetical.
- Lola Stories, Marlin's own product, controls its stack (React/Next.js). Not a customer for non-React.

The closest real customer is "future enterprise tier" which doesn't exist yet.

### 6d. Strategic vs aspirational?

Aspirational. The "design once, publish anywhere" pitch sounds great in marketing but has no product-market fit signal yet. The features that DO have signal:

- Static HTML publish (table-stakes for any visual builder).
- Lumitra Studio integration (the moat: heatmaps + variants + experiments inside the design tool).
- Better responsive design tooling.
- Better drag/drop ergonomics.
- More layout primitives.

None of these need a multi-framework renderer. All of them need the React renderer to keep evolving.

## Recommendation

**I recommend staying React-only at publish for the next 12 months.** Specifically:

1. **Ship a static-HTML publish target as the next renderer evolution.** Reuse the existing `HeadlessComponentRenderer` plumbing, swap the React-element emission for HTML string emission, generate per-breakpoint CSS from `getResolvedProps`. This matches what Framer the product does, solves the actual customer ask ("host my site at a URL"), and produces output that is naturally framework-agnostic at the DOM layer (so Lumitra Studio works in any embedding context). Effort: 2 to 3 weeks.
2. **Ensure `data-component-id` and `data-inner-component-id` are emitted by the headless path, not just the editor path.** Today they only attach in `ComponentRenderer.tsx` (the editor). Move them to `createComponentElement.tsx` so all renderers (editor, headless, future static HTML) emit them by default. One-line fix. Required for Lumitra Studio at all.
3. **Define `window.__framerRuntime.applyExperimentVariant` as a tiny vanilla-JS module** independent of React. Lives in the published-site bundle regardless of framework. It does DOM mutations against `data-component-id`-tagged elements. No framework coupling required.
4. **Defer Mitosis (and any IR-based multi-framework strategy) by 12 months.** Revisit when there is concrete customer demand for non-React output. Even then, prefer the JSON-runtime-per-framework pattern (option 3d) over Mitosis (option 1), because Builder.io has demonstrated that pattern works in production and it doesn't require pushing Mitosis DSL constraints onto Framer-clone's component library.
5. **Keep the `HeadlessComponentRenderer` / `ComponentRenderer` split.** It is already the right architecture. Editor stays React forever, publish targets evolve independently.

The reasoning, condensed: the Lumitra Studio moat does NOT require multi-framework output (it requires `data-component-id` to survive, which works in any DOM target including static HTML). The customer doesn't ask for multi-framework output. The cost of framework-agnosticism is a permanent 3x to 5x velocity tax. The strategic value is aspirational, not measured. Better to invest 2 to 3 weeks in static HTML publish and the rest of the saved time in the Lumitra Studio integration phases (A through D), which IS the moat.

**Caveats:**

- If a serious enterprise customer surfaces in the next 12 months and explicitly asks for Vue or Svelte publish output, revisit. The JSON-runtime-per-framework path (option 3d) is a 4 to 5 week sprint at that point, not a multi-quarter rewrite. The decision is reversible.
- The `data-component-id` injection in the headless path is a real bug for Lumitra Studio today. Fix that immediately, don't wait for any of the larger architecture decisions.
- Static HTML output should ship before any new function-component primitives are added to the canvas, otherwise the static HTML target has to handle a moving registry.

## References

- Mitosis docs: https://mitosis.builder.io/docs/overview/
- Mitosis components rules: https://mitosis.builder.io/docs/components/
- Mitosis gotchas: https://mitosis.builder.io/docs/gotchas/
- Mitosis GitHub: https://github.com/BuilderIO/mitosis (last release 2026-01-13, actively maintained)
- Voorhoede field report on production Mitosis use: https://www.voorhoede.nl/en/blog/write-components-once-run-everywhere-with-mitosis-a-beautiful-dream-or-reality/
- Cross-product context: `projects/analytics-platform/docs/superpowers/plans/2026-04-28-framework-agnostic-analytics-architecture.md`
- Obsidian companion: `Computer Science & Software Development/Framer-Clone Framework-Agnostic Renderer Research.md`
- Framer-clone source touched during research: `src/components/ComponentRenderer.tsx`, `src/lib/renderer/HeadlessComponentRenderer.tsx`, `src/lib/renderer/createComponentElement.tsx`, `src/models/ComponentModel.ts`, `src/lib/componentRegistry.ts`
