---
type: plan
status: draft
date: 2026-11-01
title: "Complete primitives: measuring what framer-clone can express, and rebuilding React components in it"
summary: "How to prove framer-clone's primitives can express what HTML, CSS and JavaScript can, what a first check of the code found, and how developers could bring React components in by converting them into primitives. Markup and styling can reach 100 percent and be measured; behaviour cannot be a closed list, so it needs behaviour primitives plus one explicit custom code primitive. Nothing here is decided or scheduled yet."
tags: [framer-clone, primitives, expressiveness, react-import, reusable-components, parity]
projects: [framer-clone]
---

# Complete primitives

## The question

Marlin (2026-11-01): how can we evaluate whether our primitives can fully express everything HTML,
CSS and JavaScript can? It needs to be complete in that sense, and good enough for developers, so
that existing React components can be imported and rebuilt in primitives, with an easy translation
between the JSON (JavaScript Object Notation) format of our nodes and real React components.

This stays inside the decision of 2026-11-01 that framer-clone only edits sites it hosts. Importing
here means converting a component into primitives once. Nothing foreign runs on a site, and the
hosted iframe canvas and the delivery API stay rejected.

## The short answer

- **Markup and styling are finite, so 100 percent is a real, measurable target.** The node format
  is already close, because it stores any tag, any attribute and any style key. The gaps are a few
  missing concepts, not a long list of missing fields.
- **Behaviour cannot be a closed list.** JavaScript is a general programming language, so no fixed
  set of primitives can express all of it, and no translator can turn every React component into
  declarative nodes. Complete therefore has to mean: declarative behaviour primitives for what real
  interfaces commonly do, plus one explicit custom code primitive for the rest.
- **The measure is a test suite, not a judgement.** Real components are rebuilt in primitives and
  compared with the originals in a real browser. Every mismatch becomes a named gap.

## The principle: primitives are presets over the web

The way to be complete is not to keep adding primitives until nothing is missing, because that list
never ends. The base has to be the web itself: any element, any attribute, any CSS, and a small
general model for state and events. The palette (text, button, hero, navbar) is then only a set of
convenient presets over that base. A gap in the palette makes something slower to build, but never
impossible.

## What the code does today (read and probed on 2026-11-01, commit `ff4db62`)

"Probed" means sample nodes were rendered through `renderComponentNode`, the published renderer.
This was a quick check of the renderer alone, not a full evaluation.

| Layer | What it accepts | Limit |
|---|---|---|
| Node format (`ComponentModel`) | Any tag string, any props, any bindings | One text string per node (see below); no state or events |
| Published renderer | SVG, custom elements, `aria-*`, `data-*`, `details`, `dialog`, `video`, tables, any inline style key including `clipPath` and `--custom-properties` | Inline styles only, plus breakpoints; handlers given as strings are dropped |
| Editor canvas | `createComponentElement`, a separate renderer that also passes tags and props through (read, not probed) | Same text limit; not yet measured otherwise |
| Properties panel | 12 hand-written sections | Only what those sections expose; no general style or attribute editor |
| AI generator (`validate.ts`) | Tags from the registry and the panel's tag sets, 103 style keys in `CSS_PROP_SET` | `svg`, `form` and others forbidden; no attributes beyond a short list |

`CSS_PROP_SET` holds 103 of the roughly 560 standard CSS property names listed by `csstype`. It
limits the AI generator and the folding of top-level props, not what a stored `style` object can
render.

### The five real gaps, most common first

1. **Text mixed with elements.** A node holds either a text string or child nodes, and the renderers
   drop the string when children exist. In the probe, `<p>` with the text "Hello " and a bold child
   rendered as `<p><b>bold</b></p>`: the text was lost silently. A paragraph with a bold word or a
   link inside is the most ordinary thing on the web. The fix is a real text node. **Built 2026-11-01:**
   a child with `type: '#text'` and its text in `props.children` emits no element, so the DOM is exact
   (`src/lib/renderer/textNode.ts`). A row holding a string and child nodes is not migrated: every
   renderer shows the string first. On the canvas a click lands on the element, and selecting a text
   node selects that element, whose Text section has one field per text node. Inline editing of a
   text node inside a mixed element is not built, and neither is splitting a text node at the caret,
   so in the editor an element lands after the text. The AI generator can write mixed text directly.
2. **CSS that needs a selector.** An inline style cannot say `:hover`, `:focus`, `:nth-child`,
   `::before`, `@keyframes`, `@container` or `@supports`. Today there are three hover presets
   (`lift`, `dim`, `underline`), five appear presets and one scroll preset. Media queries exist only
   as width breakpoints, so `prefers-color-scheme` and print styles have no home either.
3. **Behaviour and state.** The only logic lives in fixed islands (forms, commerce, sticky bar).
   There is no way to say "this button toggles that panel", which is what an accordion, a tab set, a
   modal, a carousel or a mobile menu all need.
4. **Reuse.** No reusable component was found in the data models, the registry or the left panel.
   A navbar on ten pages is ten copies.
5. **Page-level items.** Head tags beyond the SEO metadata, shared design tokens (theme colours and
   fonts as variables), and page-wide scripts have no model.

## The evaluation

Three instruments, each producing a number that can be tracked in continuous integration.

### 1. The coverage matrix

Take the authoritative lists rather than our own memory: every HTML element and global attribute,
every CSS property, selector type and at-rule (from `mdn-data` or `@mdn/browser-compat-data`), and
the interaction patterns of the WAI-ARIA Authoring Practices (the web standard's catalogue of
accordions, tabs, dialogs, menus and so on). For each entry, an automated test answers five
questions: can the format store it, does the published renderer emit it, does the editor canvas show
it, can the panel edit it, can the AI generator produce it?

A cell is either proven by a test or empty. The score per column is the measure of progress, and an
excluded entry (deprecated elements, for example) must carry a written reason.

### 2. The parity corpus

Lists show that a feature exists, not that it composes. The corpus takes real components:

- the BusBasis storefront's pages (read only, and it is the migration target anyway);
- shadcn/ui and Radix components (open source, and they stress behaviour and accessibility);
- a few hand-written edge pages for what those miss: mixed text, print styles, container queries.

Each fixture is rebuilt as a node tree and rendered through the published renderer next to the
original, in a real browser, at each breakpoint. It compares:

- screenshots (pixel difference under a small threshold);
- computed styles of matched elements;
- the accessibility tree;
- a scripted interaction run: hover, focus, keyboard, click, and the same screenshots in each state.

Every failure is sorted into a named gap. Playwright is not installed in this repo (jsdom and
esbuild are), so this adds it as a development dependency.

### 3. The round trip

Nodes to JSX (React's markup syntax) and back must give the same nodes, and JSX to nodes and back
must render the same. This keeps the translation honest and doubles as an expressiveness test: if a
construct cannot survive the trip, the format cannot express it.

"The same nodes" is defined over a normalised form, not raw `ComponentModel` snapshots:

- **Compared as is:** component type, props and attributes, style maps (including breakpoint and
  state variants), text content and child order. Compare text and structure, never raw `childNodes`
  counts: two adjacent text nodes are separated by a `<!-- -->` comment in server-rendered HTML.
- **Normalised away:** node ids and parent or canvas bookkeeping (positions on the editing canvas,
  selection, expansion state). They are regenerated on import and are not part of the page's
  meaning.
- **Bindings** (a node's data bindings) are serialised as an explicit, named prop on the JSX element
  and parsed back from it, so they survive the trip rather than being lost.
- **Runtime islands** (forms, commerce, sticky bar) are serialised as named components with their
  configuration as props, and import maps them back to the same island. An island the importer does
  not recognise is reported under "whatever is left" below, never flattened to plain markup.

Export is total over this normalised form: every node type the format stores has a defined JSX
representation, and a node without one fails the round-trip test rather than being skipped.

### What counts as complete

- Matrix: 100 percent of the included HTML and CSS entries in the format, renderer and canvas
  columns; the panel column reached through a general editor (see below).
- Corpus: every in-scope fixture passes. A fixture is excluded only up front, with a written reason
  (for example, it depends on a server the renderer deliberately does not run), and an excluded
  fixture leaves the denominator. A known gap is never recorded as a pass.
- Behaviour: every included WAI-ARIA pattern built from behaviour primitives alone, keyboard support
  included. Whatever cannot be is the defined scope of custom code.

## Visual state management

Marlin (2026-11-01): how do we give people a visual way to manage state, such as a hover state or
other small things? Framer was tested in its real editor and on a page published to `framer.app` on
2026-11-01, because it is the closest comparison.

### What Framer does

Each placed component holds one current variant, and events travel upward from child to parent. In
React terms that is roughly one `useState` per instance plus callback props (our reading, not
Framer's description). Shared values beyond that need code (`createStore` in a code override).

- States are real frames on the canvas: a "Hover / Pressed" tile below a variant, a "Variant" tile
  beside it. Each stores only what differs from the primary variant, marked on the panel row.
- Interactions are drawn: dragging a handle from one variant to another makes a connector and opens
  a popover with On, Delay, Transition (Once or Cycle) and Variant. The triggers are Click, Click
  start, Appear, Mouse enter and Mouse leave.
- A placed instance gets a Variant control and an automatic Trigger field.
- Component variables come in 17 types and are inputs set per placement, not runtime state.
- Event variables carry a child's interaction to its parent (from Framer's docs, not built in the
  test). For two unrelated components no native route was found: they need a shared parent or a
  community component.

Measured on the published page: no CSS `:hover` rule existed for the component. Script added a
`hover` class and wrote the colour inline, and with scripts blocked hover did nothing.

### What we build

Three layers, each usable without the next:

1. **Element states.** A state switch in the panel (Normal, Hover, Pressed, Focused) over the
   ordinary style controls. Output is plain CSS, added to the sheet `responsiveCss` already emits, so
   hover works without JavaScript. Focused is included because keyboard users need it and Framer's
   menu offers only Hover and Pressed.
2. **Component states.** Named states on a reusable component, shown as frames on the canvas, storing
   only their differences, with drag-to-connect interactions and Framer's small popover.
3. **Page state.** A small panel of named values (`menuOpen`, `activeTab`). "On click, toggle
   `menuOpen`" on one element and "when `menuOpen` is true, show" on another, with no shared parent
   required. Accordion, tabs, dialog, carousel and menu are presets over this.

Interactions must run on the editing canvas as well as in preview, and every state must be reachable
by keyboard. Layer 1 belongs to step 4 of the work below; layers 2 and 3 to steps 5 and 6.

## The work this implies

These are rough judgement estimates in agent time, not measurements. The evaluation may change them.

| Step | What | Rough size |
|---|---|---|
| 1 | The matrix, corpus harness and round-trip test, reporting the honest first score | 1 week |
| 2 | Text nodes, so mixed text stops losing content (built, see gap 1) | days |
| 3 | A general "any property, any attribute" editor in the panel. This closes the long tail of CSS cheaply; proper controls stay for common properties only, and `CSS_PROP_SET` is not extended by hand | days |
| 4 | Selector-level styling: element states, keyframe animations and further at-rules, built on how `responsiveCss` already moves style maps into a stylesheet | 1 to 2 weeks |
| 5 | Reusable components | 2 to 3 weeks |
| 6 | Behaviour model (see [visual state management](#visual-state-management)): page state, events and actions, then accordion, tabs, dialog, carousel and menu on top | 3 to 4 weeks |
| 7 | React import and export | 2 to 3 weeks |

### Reusable components and their inputs

A reusable component is built from primitives, saved, and placed many times; changing it changes
every placement. Its author chooses which fields each placement can set (title, image, link). Those
choices are the only place a generated form is needed: one per reusable component's inputs, not one
per primitive. This replaces the "typed property controls" item from the external frontend research,
which was justified mainly by outside React components that will no longer exist.

## React import and export

**Export (nodes to React) is straightforward and total over the normalised form defined under the round trip,** because nodes already are element trees.

**Import (React to nodes) is deliberately layered,** because a component is a program and only part
of it is markup:

1. **Static JSX** is parsed with the TypeScript compiler, already a dependency, and maps directly to
   nodes.
2. **Tailwind classes** go through Tailwind's own compiler to real CSS, then into styles; `hover:`
   and `md:` variants map onto element states and breakpoints.
3. **Props** become the reusable component's inputs.
4. **Dynamic logic** (hooks, loops, conditions) cannot be compiled in general. Known patterns such
   as a boolean toggle map to behaviour primitives; loops map to data bindings; the AI generator
   rebuilds what is left in primitives, its output checked by the existing validator and the corpus
   comparison.
5. **Whatever is left** is reported line by line. It is never silently dropped: the developer either
   accepts the custom code primitive or rewrites that part. A component the converter half
   understood must fail loudly, not look imported.

A real browser's render of the original is the reference throughout, so the import reports a
measured match rather than a promise.

## Security finding: stored script reaches published sites

`POST /api/projects/save` and `/publish` keep the page body as opaque JSON (`.passthrough()`), and
the published renderer passes props through. The probe rendered `dangerouslySetInnerHTML`, a
`<script>` node and a `<style>` node verbatim. So anyone with the `editSite` permission (a workspace
admin) can put script on that workspace's published sites through the API, although no editor path
produces such nodes, and no Content-Security-Policy is set app-wide. It was not tried end to end on
production.

These props and nodes get dropped by both renderers in a separate change, so existing rows and every
write path are covered. The custom code
primitive below is the designed replacement, so nothing intended is taken away.

## Open decisions (Marlin's)

1. **Custom code on customer sites.** Is the custom code primitive allowed, for whom, and sandboxed
   how? This is what lets the word "complete" stand behind behaviour; without it, complete means
   "everything the primitives cover". Recommendation: allow it, sandboxed in an isolated frame or
   a separate origin, off by default, visibly marked in the editor.
2. **Order against BusBasis.** Steps 2 to 6 overlap the "site and design" area of the
   [BusBasis plan](2026-11-01-busbasis-native-storefront.md); that estimate has not been redone.
3. **Whether to run step 1 now.** Recommendation: yes, because it is cheap, needs no other decision
   and turns this plan's estimates into measurements.
