---
type: plan
status: draft
date: 2026-11-02
title: "Reusable components and component states: the contract for definitions, placements, inputs, states and interactions"
summary: "How a component is built once per site and placed many times. A definition is a small page stored under ProjectModel, so the canvas, Layers, rules and undo work on it unchanged. A placement is a `#component` node holding the definition id, input values and its own layout. One pure step expands placements before hydration, so forms, stylesheets, fonts and every later pass see ordinary nodes. Inputs are a new `{{input.x}}` binding frame. Breakpoint ids differ per page, so definitions are mapped by width. States store only style differences, as selector rules, so hover works without JavaScript and only clicks and timers need a runtime. No existing page changes. Fifteen slices, 32 new score rows and four new fixtures."
tags: [framer-clone, primitives, reusable-components, component-states, renderer, fleet]
projects: [framer-clone]
---

# Reusable components

This is step 5 of the [complete primitives plan](2026-11-01-complete-primitives.md), and layer 2 of its "Visual
state management": named states on a reusable component, shown as frames on the canvas, storing only their
differences, with drag-to-connect interactions. It answers gap 4 of that plan, "a navbar on ten pages is ten
copies". It builds on the [selector contract](2026-11-02-selector-styling.md). It specifies, and builds nothing.

Read against commit `3590278`. At that commit `props.rules`, its parser and the model's rule actions are merged
(#217, the first selector slice). The stylesheet emission, the canvas sheet and the state switch (selector slices 2
to 7) are not, so slices here name them as dependencies. Two open pull requests touch the same ground: #213 (the AI
allowlists) and #218 (text nodes finished). The behaviour contract (`docs/plans/2026-11-02-behaviour-model.md`) is
being written at the same time and owns events and actions as data, see "Interactions".

**Evidence marks:** **[code]** read here, **[Framer docs]** read from Framer's site on 2026-11-02, **[tested]**
from the editor test of 2026-11-01 recorded in the primitives plan, **[unproven]** designed but not run. Nothing
here was run in a browser: this worker's tree has no `node_modules`, so grammar claims come from reading
`src/lib/rules/rules.ts`, not from running it.

Short forms: CSS (Cascading Style Sheets), JSON (JavaScript Object Notation), JSX (React's markup syntax), MST
(MobX State Tree, the editor's data model), CMS (content management system), API (application programming
interface), ARIA (Accessible Rich Internet Applications). "Definition" is the one stored component. "Placement"
is one use of it on a page. Framer calls these a component and an instance.

## The decisions

1. **A definition is a page, stored under `ProjectModel.components`.** It wraps a real `PageModel`. Everything that
   edits a page then edits a component with no new code path, and undo works because `HistoryStore` records
   `projectStore`, which holds it.
2. **A placement is a `#component` node,** on the precedent of `#text`: a reserved type with no element of its own,
   holding only props. No MST schema change for a node.
3. **Placements are expanded by one pure function before `hydrateBindings`,** inside `snapshotToComponentNode`. Past
   that point a published page holds no placements, only ordinary nodes, so stylesheets, effects, images, fonts, the
   sticky bar and the form lookup all work without learning anything.
4. **An expanded node has a unique `id` and a shared `classKey`.** The `id` is prefixed with its placement path, so
   a form placed twice is two forms. The stylesheet keys on `classKey`, so twelve cards share their CSS wherever a class is issued.
5. **Inputs are read bindings on a new frame, `{{input.<id>}}`.** No new resolver. One input may drive several
   nodes. A placement's value is a literal or a binding resolved in the placement's outer scope, so a card inside a
   collection takes `{{row.title}}`.
6. **A definition's breakpoints are its own, mapped to a page's by width.** Breakpoint ids are random per page
   ([code] `createPage` calls `defaultViewportSnapshots()`, which mints fresh ids), so a map keyed on one page's ids
   means nothing on another.
7. **The only things a placement can change are its input values, its state and how it sits on the page** (size,
   position, effects). There are no overrides of inner nodes. To go further, a person edits the definition, adds an
   input, or detaches.
8. **A state stores style differences only, as selector rules on the definition's nodes.** Hover, Pressed and
   Focused are plain CSS and work without JavaScript. Text and structure do not vary by state: two layers shown and
   hidden do that.
9. **Interactions are data on the definition.** Only a page holding one ships a runtime. The record is built so
   layer 3 can adopt it, and there is one runtime, not two.
10. **No data migration, and no page changes at deploy.** A page without a placement goes through expansion
    untouched. One additive column holds the definitions.

## The stored shape

### The definition

```ts
/** ProjectModel.components: id -> definition. The new `components` column of `sites`. */
interface ComponentDefinition {
  id: string;                 // uuid, stable, referenced by placements
  name: string;               // "Card", unique within the site, shown in the panel
  description?: string;       // for the AI generator and the panel, one sentence
  page: PageSnapshot;         // a full PageModel: appComponentTree is the component, canvasNodes its frames
  inputs: InputDefinition[];  // order is the panel's order
  states: StateDefinition[];  // order is the cascade: a later state wins a tie. `primary` is implied, never listed
  interactions: Interaction[];
  noScriptState?: string;     // a state id, see "Server rendering and no JavaScript"
}
```

`ProjectModel.components` is `types.map(ComponentDefinitionModel)`, with `page: PageModel`. Old snapshots have no
`components`, so `types.optional` gives an empty map. The definition's page is never in `ProjectModel.pages`, so it
has no address, is in no sitemap, cannot become the home page, and is invisible to slug rules and to anything
iterating `pages`.

Why a page and not a bare component tree: `findComponentInPage`, `insertRegistryComponent`, `moveTreeComponent`,
`deleteComponent`, `duplicateComponent` and `findPageBreakpoints` (which duck-types `canvasNodes` and `viewportNodes`)
all need a page. `editorUI.currentPage` is a `safeReference(PageModel)`, so opening a definition is setting that
reference. Writing the same operations twice for a second kind of owner would be the larger change, and the two
would drift.

The cost is about 1.5 kilobytes of viewport frames per definition, which is accepted.

**Limits, checked at the model and again at the render step:**

| What | Limit | Beyond it |
|---|---|---|
| Definitions per site | 200 | The model refuses with a reason; the renderer ignores the rest with a warning |
| Inputs per definition | 40 | As above |
| States per definition | 16 | As above |
| Interactions per definition | 64 | As above |
| Nesting depth | 8 | The nested placement renders nothing, with a warning |
| Expanded nodes per page | 5,000 | Later placements render nothing, with a warning |

The last two are protection, not taste. Stored JSON is opaque to the save route ([code] `.passthrough()`), and ten
placements inside ten placements inside ten is a thousand expansions from a few bytes. The request cap of 10
megabytes ([code] `PROJECT_BODY_MAX_BYTES`) covers definitions too, because they travel in the same body.

### The placement

```ts
/** A ComponentModel node: type '#component', componentType 'host', children empty until slots. */
interface PlacementProps {
  component: string;                   // the definition id
  inputs?: Record<string, unknown>;    // input id -> value; absent means the default
  state?: string;                      // the initial state id; absent means primary
  style?: Record<string, unknown>;     // an ordinary style object, how it sits on the page
  effects?: unknown;                   // an ordinary effects object
}
// A value from data sits in node.bindings under `input.<id>`, and a state under `state`.
```

`src/lib/components/placement.ts` holds `PLACEMENT_TYPE = '#component'` and `isPlacementType`, the same shape as
`src/lib/renderer/textNode.ts`. Considered and refused: a `data-component-kind` marker on a `div`, like the data
components. A marker renders as a real element if anything misses it, which hides a bug as an empty box, and
placements need no host element, because the definition's root is the element. A `#` type cannot be a tag. Every
renderer checks it before the tag path, since `React.createElement('#component')` throws rather than degrades.

The model refuses on a placement: children (`addChild`, as a text node does), rules, a tag change and text. That
keeps the definition as the one place content lives.

### The canonical example, a card

```json
{
  "id": "2f6c...", "name": "Card",
  "inputs": [
    { "id": "title", "name": "Title", "type": "text", "default": "Card title" },
    { "id": "image", "name": "Image", "type": "image",
      "default": { "src": "/placeholder.jpg", "alt": "" } },
    { "id": "href", "name": "Link", "type": "link", "default": "/" },
    { "id": "badge", "name": "Show badge", "type": "toggle", "default": false }
  ],
  "states": [{ "id": "hover", "name": "Hover", "kind": "hover" }],
  "interactions": [],
  "page": { "appComponentTree": {
    "id": "c-root", "type": "a",
    "bindings": { "href": { "mode": "read", "expression": "{{input.href}}" } },
    "props": { "style": { "display": "block", "borderRadius": "12px", "transition": "translate 160ms" },
               "rules": [{ "id": "state-hover", "componentState": "hover", "selector": "&",
                           "style": { "translate": "0 -2px" } }] },
    "children": [
      { "id": "c-img", "type": "img", "props": {}, "bindings": {
          "src": { "mode": "read", "expression": "{{input.image.src}}" },
          "alt": { "mode": "read", "expression": "{{input.image.alt}}" } } },
      { "id": "c-badge", "type": "span", "props": { "children": "New" }, "bindings": {
          "visible": { "mode": "read", "expression": "{{input.badge}}" } } },
      { "id": "c-title", "type": "h3", "props": { "children": "Card title" }, "bindings": {
          "children": { "mode": "read", "expression": "{{input.title}}" } } }
    ] } }
}
```

A placement of it, inside a collection's row template, with its width set on Tablet:

```json
{
  "id": "p1", "type": "#component", "componentType": "host",
  "props": {
    "component": "2f6c...",
    "inputs": { "badge": true },
    "style": { "width": { "base": "33%", "<this page's tablet id>": "50%" } }
  },
  "bindings": { "input.title": { "mode": "read", "expression": "{{row.title}}" } }
}
```

## Inputs

### Binding an input to nodes

The existing `bindings` record is the connection. Its slots already name what a node exposes (`children`, `src`,
`href`, `style.color`), and `applyBindings` already writes dotted paths into nested props ([code]). The one addition
to the resolver is a frame:

```ts
interface InputFrame { kind: 'input'; values: Record<string, unknown>; }
// lookup(): head === 'input' resolves against the innermost input frame.
// `{{input.image.src}}` reads into the value through the existing getNested.
```

- **One input, many nodes:** bind any number of slots to the same expression, as Framer does ([Framer docs]: a
  single variable may control several layers).
- **The frame is always complete.** Before pushing it, values are `default` overlaid with the placement's, so
  a definition drawn on its own canvas shows its defaults through the same path.
- **An input with no default** resolves to `undefined`, which `applyBindings` leaves as the node's stored value. So
  "make this an input" can copy the current value as the default or leave it out, with one outcome.
- **The placement's values are resolved in the outer scope,** then pushed. That is what makes
  `input.title: {{row.title}}` work, and a nested placement's `input.heading: {{input.title}}` read the outer frame.
- **Mixed text** (`Hello {{input.name}}`) does not exist: `parseExpression` accepts exactly one `{{path}}` ([code]).
  A mixed sentence is an element with `#text` children, where one text node is bound.

The panel's binding picker in a definition offers inputs and hides `row`, `product` and the rest, because a
definition that reads `{{row.title}}` directly works in one collection and silently nowhere else. The renderer does
not refuse one, since `scopeIntrospection` cannot know where it will be placed.

### The input types

Framer's count needs care. The primitives plan records "17 types" from its editor test [tested]. Framer's developer
documentation lists 22 current `ControlType` values for code components [Framer docs]. Its public material on
no-code component variables names only text, colours, links, images, visibility and numbers, and no complete list
was found. So this contract designs from the 22, because they are written down, and does not claim to match the 17.

| Ours | Framer control | Value | Binds to | Safety check | Slice |
|---|---|---|---|---|---|
| `text` | String, TrackingId | string, optional `multiline`, `maxLength` | `children`, any string attribute | React escapes it | 1 |
| `number` | Number | number, `min`, `max`, `step`, `unit` | `style.*`, attribute | Finite, in range | 1 |
| `toggle` | Boolean | boolean | `visible`, attribute | Strict boolean | 1 |
| `color` | Color | CSS colour string or a responsive map | `style.*` | `declaration()` | 1 |
| `image` | ResponsiveImage | `{ src, alt, focalPoint? }` | `src`, `alt`, `style.backgroundImage` | `isSafeSrc`, at the render step too | 1 |
| `link` | Link | string, site path or address | `href` | `safeHrefFromData` | 1 |
| `choice` | Enum | one of `options[].value` | attribute, `style.*` | In the list | 1 |
| `file` | File | stored file address | `href`, `src` | `safeHrefFromData` | 9 |
| `date` | Date | ISO 8601 string | `children`, `dateTime` | `Date.parse` | 9 |
| `font` | Font | a family from the font registry | `style.fontFamily` | Registry lookup | 9 |
| `border` | Border | CSS border string | `style.border` | `declaration()` | 9 |
| `shadow` | BoxShadow | CSS shadow string | `style.boxShadow` | `declaration()` | 9 |
| `radius` | BorderRadius | length, or four | `style.borderRadius` | `declaration()` | 9 |
| `padding` | Padding | length, or four | `style.padding` | `declaration()` | 9 |
| `gap` | Gap | one or two lengths | `style.gap` | `declaration()` | 9 |
| `cursor` | Cursor | CSS cursor keyword | `style.cursor` | Keyword list | 9 |
| `transition` | Transition | CSS `transition` string | `style.transition` | `declaration()` | 9 |
| `list` | Array | array of values of one item shape | a repeated node, see below | Each item checked | 10 |
| `slot` | ComponentInstance | nodes, stored as children | a marked container, see below | Nodes pass the renderers | 10 |
| `event` | EventHandler | reserved | an interaction trigger | The behaviour contract | none here |

Framer's Object is not a type here: an input has an optional `group`, which is only a heading in the panel. Framer's
Transition edits Framer Motion's options, which this project does not ship, so ours is the CSS property.

```ts
interface InputDefinition {
  id: string;        // short, stable, unique in the definition; a rename keeps it
  name: string;      // the panel's label
  type: InputType;
  default?: unknown;
  group?: string;
  description?: string;
  options?: { label: string; value: string }[]; // choice
  // ... the per-type fields in the table
}
```

`src/lib/components/inputs.ts` holds `parseInputValue(definition, value)`, pure and client-safe, called at the render
step and again in the panel, the AI validator and the import, as `parseRule` is. **The render step is the trust
boundary, and it comes after substitution:** `isBlockedProp`, `isBlockedTag`, the `declaration()` gate and the `href`
check all run on the expanded, resolved tree, so no input value can reach the page by a shorter route. A value that
does not parse is treated as absent, with one warning per page. `applyBindings` checks `href` today and nothing
checks `src`, so the expansion's input parse carries that, and a bound `{{row.image}}` keeps today's behaviour.

**Inputs do not reach rules.** The selector contract refuses a `{{` in a rule value, and this keeps that. A state
colour set per placement goes through a custom property: an input bound to `style.--u-accent` on the root, and the
rule says `var(--u-accent)`.

### A new binding slot, `visible`

`bindings/types.ts` mentions `visible` in a comment and nothing reads it ([code] no reader in `src/lib/bindings`, the
hydrator or `createComponentElement`). This adds it: a bound `visible` that resolves to exactly `false` removes the
node. `hydrateNode` returns nothing for it, in place of an element; `ComponentRenderer` and
`HeadlessComponentRenderer` return null. Anything else keeps the node, so a binding that fails shows content rather
than hiding it. It is not the Layers eye, which is canvas only, and not `display:none`, because a hidden optional
badge should not be in the markup at all.

### List and slot

Both are slice 10, because a navbar, a hero and a card do not need them.

**`list`.** A node in the definition holds `props['data-repeat']: '<input id>'`. Expansion clones it once per item,
with an `item` frame (`{{item.label}}`), as `hydrateCollection` does per row. It holds at most 100 items. Item shapes
are one level of the scalar types above.

**`slot`.** A container in the definition holds `props['data-slot']: '<input id>'`, and the placement holds a child
`{ type: '#slot', props: { input: '<input id>' }, children: [...] }`. On expansion those children replace the
container's. Slot content belongs to the page: on the canvas it is selectable, and it resolves in the placement's
outer scope, as React's `children` do, so the wrapper pops the innermost input frame. Cycle checks walk it.

## Overrides, and what happens when a definition changes

A placement stores only what it was given, and a definition change rewrites no placement, except the three actions
at the end of the table, each in one undo step.

| Change to the definition | Stored placements | What a visitor or editor sees |
|---|---|---|
| Any edit to its nodes | Nothing | Every placement follows, on the next save or publish |
| A default changes | Nothing | Placements with no value of their own follow; placements with one keep it |
| An input is renamed | Nothing, because values are keyed on `id` | The panel's label changes |
| Inputs are reordered or grouped | Nothing | The panel's order changes |
| A node holding a binding is deleted | Nothing | The input stays and the panel marks it "not connected" in the definition |
| A state is deleted | Nothing stored by name matters: an unknown `state` reads as primary | Placements on it show primary, and the panel says so |
| **An input is removed** | The value is deleted from every placement and every binding to it is cleared, across all pages and definitions, in one action | The node shows its stored value |
| **An input's type changes** | Values that pass the new type are kept; the rest are deleted, in one action | The dialog first says how many values go |
| **A definition is deleted** | Every placement becomes a plain copy (detach), across all pages, in one action | Pages look the same |

Why deletion rather than keeping orphans: a kept value that means nothing is invisible state, and it would come back
wrong if an input with that id ever returned. One action means Cmd+Z restores both the input and every value.
Renderers still tolerate an unknown key, because an old tab or a stale save can produce one.

**Why no inner overrides.** Figma-style overrides store paths into a tree the author can restructure at any time, so
each definition edit needs a rule for each orphaned path. The primitives plan already chose against them: "its author
chooses which fields each placement can set". With inputs as the only route, every placement stays correct through
any edit, and the panel needs one generated form.

**The placement's own style** is merged onto the definition root per property and per breakpoint: the definition's
`width: { base: '100%', <mobile>: '50%' }` under a placement's `width: { base: '300px' }` gives 300px on Desktop and
50% on Mobile. Replacing the map whole would lose the definition's Mobile value without anyone asking. Placement keys
come after the definition's, so a placement's `paddingTop` beats a definition's `padding`. The panel offers Size,
Position and Effects here. The renderer merges any key, because stored data is opaque, and that is harmless: such a
key could as well be written into a node on the page today.

**Effects** merge per group, so a placement can add Appear to a card with no change to the definition.

**Detach** replaces a placement with a copy of the expanded tree, with fresh ids, inputs resolved to literals and maps
keyed on the page's breakpoints, in one action. State rules are dropped and the panel says so, because they mean
nothing without the definition.

## Breakpoints

A definition has its own frames, so its maps are keyed on its own breakpoint ids. Frames can differ across pages too,
since `SizeSection` calls `setViewportProperties` ([code]). So the mapping is by width, and it is one pure function in
`src/lib/components/breakpoints.ts`:

```text
D(P) = the definition breakpoint with the largest minWidth <= P.minWidth,
       or the definition's smallest when none is.
```

- **Published:** expansion rewrites every responsive map in the definition (top-level props, `style`, each
  `rules[].style`, each `effects` group) to the page's ids. For each page breakpoint P, largest first, the value is
  `resolveCascade(map, D(P), definitionBreakpoints)`. The largest gets `base`, and any other gets its own key only
  where it differs from the next larger one's. With the default frames on both sides, this is an exact rename.
- **Canvas and preview:** nothing is rewritten. `ComponentRenderer` gets `breakpointId = D(P)` and the definition's
  breakpoints for the inner tree, and the frame's id only for identity attributes. `getResolvedProps` needs no change.
  The placement's own maps hold page ids, which the definition's breakpoint list would not recognise, so they are
  resolved first against the page's breakpoints for frame P, to plain values, and then laid over the root's result.
- **Nested placements** map straight to the page, not through the outer definition, so nothing is lost in two hops.
- **A placement's own `style` and `inputs`** are keyed on the breakpoints of whatever holds it. On a page that is the
  page's; inside a definition, that definition's, and they are mapped with it.
- **Create from selection** runs the same function the other way, from the page's ids to the new definition's.

`apply.ts` is the precedent ([code] `breakpointKeyMap`, which rekeys generated maps). A site-wide breakpoint list would
remove this function, but it would change every saved page, so it is not done here.

## Expansion

`expandPlacements(root, definitions, pageBreakpoints)` in `src/lib/components/expand.ts`. Pure: no React, no MST, no
`server-only`. `snapshotToComponentNode(snapshot, definitions = {})` calls it after `componentSnapshotToNode`.

For each `#component` node, depth first:

1. **Find the definition.** Unknown: the node is removed, with one warning per page. The page still serves. The
   canvas shows a dashed "Missing component" box, as it does for "Unknown component".
2. **Refuse a cycle.** The stack of definition ids on the way down must not hold this id, and the depth must be within
   8. Refused: removed with the warning. The model refuses first, but stored JSON can say anything.
3. **Clone the definition's tree,** with its maps mapped to the page's breakpoints.
4. **Identity.** Each clone's `id` becomes `<placement id>__<definition node id>`, and nested placements extend the
   path. `classKey` is the definition node's id. The root's id is the placement's own.
5. **Merge the placement** onto the root: style per property and breakpoint, effects per group.
6. **Mark the root:** `data-fc-c="<definition id>"` when the definition has states, and record
   `node.instance = { inputs, bindings, state }` for hydration.
7. **Compile the state rules,** see below.
8. **Suffix `id` attributes,** see below.

`hydrateNode` then sees `node.instance`, resolves its values in the current scope, pushes an `InputFrame` for the
subtree, and writes `data-fc-state` from the resolved state. Nothing else in the hydrator changes.

**Two ids, and why.** `applyResponsiveStyles` issues one class per stem and signature, so a template cloned per row
shares a class ([code] `classFor`). With prefixed ids alone, twelve cards would be twelve blocks of CSS. With shared
ids alone, two placements would be one form, and sibling placements would collide as React keys
(`renderNodeChildren` keys on `child.id`). So `classStem(node.classKey ?? node.id)`, and rule classes likewise. This
shares CSS only where a class is issued, which means a node with a responsive map or an authored rule. A node with
only plain styles stays inline once per placement, as a collection row does today. A
placement with different values gets a numbered class from the existing signature check, unchanged. `hydrateNode`
keeps both by spreading the node, which a test pins.

`__` is the separator because the canvas's rule sheet skips ids outside `[A-Za-z0-9_-]`, as the selector contract
states, and because uuids never hold it.

**HTML `id` attributes, and what points at them.** A definition with `id="pricing"`, or a tab holding
`aria-controls="panel-1"`, placed twice, emits duplicate ids. So expansion rewrites a stored `id` on the second and
later placements of a definition on a page, in walk order, to `<id>-<n>`, and rewrites the references inside that
expansion (`for`, `aria-controls`, `aria-labelledby`, `aria-describedby`, `aria-owns`, `aria-activedescendant`,
`popovertarget`, `commandfor`, and an `href` starting `#`). The first placement keeps its `id` unchanged, so an anchor
keeps working when a component is used once. An `id` bound to an input is the author's and is left alone.

### Every reader that has to learn it

Walkers split in two: those that run after expansion need nothing, and those reading a raw snapshot must expand first.

| Reader | Change |
|---|---|
| `hydrateBindings`, `applyImageLoading`, `applyEffects`, `applyResponsiveStyles`, `collectPageFonts` on the published path, `hoistStickyCta`, `renderComponentNode` | Run after expansion. Only `classKey` above, and `node.instance` in `hydrateNode` |
| `renderComponentNode`, `createComponentElement` | A leftover `#component` or `#slot` type renders nothing, defensively |
| `(site)/[...slug]/page.tsx`, `renderSitePage.tsx`, `(site)/not-found.tsx` | Pass `site.components` to `snapshotToComponentNode` |
| `locateForm` (`src/server/forms/submit.ts`) | Passes `site.components`. A form in a definition is found by its expanded id, and `FormIsland` already uses `node.id`, so each placement has its own draft and its own submissions |
| Creating a component from a selection holding a form | The form's id changes, so past submissions stay under the old id. The panel says this before it happens |
| `hydrateBindings` islands | `commerceFramesOf` also keeps `input` frames, or an add-to-cart button inside a component loses `{{input.x}}` once it crosses to the client |
| `treeNeedsCommerceRepo` | Runs on the expanded tree. Passes through |
| `dynamicPagePlan` (`siteFiles.ts`) | Reads a raw snapshot, so a `record-view` inside a component would drop the page from the sitemap. Expand first |
| `siteLookFromPages` (`notFoundDefault.ts`) | Reads a raw snapshot. Expand first, or the 404 look loses a component's colours |
| `factsFromTrees` (`legal/templates.ts`) | **Legally relevant.** It decides whether a privacy page mentions forms and Unsplash images. Reads raw trees, so a form inside a component would be missed. Expand first |
| `checkBeforePublish` (`PublishButton.tsx`) | Takes raw trees. Expand first |
| `addLegalLinksToFooters`, `findByType` | A footer inside a definition is not on the page tree. Search definitions too, and add the links once, to the definition |
| `findStickyCta`, `insertRegistryComponent` | The sticky bar is one per page and page-level, so a definition refuses it |
| `PageFontFaces` on the canvas | Its roots include each definition placed on the page, or a family used only inside a component is not declared |
| `CanvasRuleStyles` (selector slice 6, not merged) | Lists definition nodes once per placement per frame, under the composite ids |
| `serializeSubtree`, `editorReview`, `ai/review/ops.ts` | See "AI generation" |
| `roundtrip/jsx.ts` | See "React import and export" |
| `yjsDocShape.ts` | No change. Multiplayer has not shipped; as with `rules`, the real shape is chosen when it lands |
| `_schema.ts` | No change. `.passthrough()` keeps the key |
| `projectToPersisted`, `persistedToProject`, `repository.saveProject`, `publicResolver` | Read and write `components`, see persistence |

## Persistence

`projectSnapshotSchema` keeps a new key, but `projectToPersisted` reads named fields, so it would be dropped silently
([code]). So:

- **`sites.components`**, `Json @default("{}")`, in the migration `<date>_site_components`. It is one transaction with
  the pages in `saveProject`, so a definition and the pages placing it cannot be saved apart. `publicResolver` adds it
  to its `select`, and `PublishedSite.components` carries it through the cross-request cache as pages are carried.
- `parseComponents(raw)` in `definition.ts` normalises on read, as `normalizeSiteSettings` does, and a bad definition
  is skipped with a warning rather than failing the site.
- **Not inside `site_settings`.** That column is whitelisted field by field and read widely. Definitions are large and
  have a different life.
- **Not a table per definition.** A row per definition would allow partial loads, but every published render needs
  all of them that the page uses, and the editor loads the whole project. Saves already write everything.

This is an additive column on the `public` schema. It rewrites no row. It still needs Marlin's one-line yes when it
deploys, and it carries the `prisma` and `migrations` collision tags.

### Publishing and the immutable published copy

Today save and publish write the same rows, so after a cache miss visitors see the last save (`ROADMAP.md`, "An
immutable published copy of each page", not built). Components follow the same path and add no new kind of
exposure, but they widen it: one saved edit to a navbar reaches every page after a cache miss, where a page edit
reached one page.

So the contract for that work: a published revision holds **`components` beside `pages`**, frozen together. Expansion
runs at read time against the revision's own definitions, with one code path for drafts and published pages. Storing
flattened pages instead was refused: it would duplicate each definition per page, and `locateForm` would need a second
path. This contract does not build the revision and does not wait for it.

Publishing itself changes nothing: `POST /api/projects/publish` sends the whole project, and `revalidateSiteCache`
already covers the site.

## Component states

### Stored as rules

The selector contract says layers 2 and 3 "should reuse `SelectorRule`", and it holds. A state is defined once and
its differences sit on the nodes that differ:

```ts
interface StateDefinition {
  id: string;     // short, generated: `s1`, or `hover`, `pressed`, `focused`. Never starting `fc-` or `fc_`
  name: string;   // "Open"
  kind: 'hover' | 'pressed' | 'focused' | 'custom';
  implies?: string[]; // pressed implies hover, as the named states do
  x?: number; y?: number; // the frame's place on the definition's canvas, if moved
}

// On a node: an ordinary SelectorRule with one more field.
interface StateRule extends SelectorRule {
  id: `state-${string}`;
  componentState: string;   // the state id
  selector: '&';            // always; expansion replaces it
}
```

So one frame's edit is one rule on each node it touches, written by `setRuleStyle`, with `writeCascade`, one undo
step, emptied rules removed. A state with no differences stores nothing but its definition. The node's panel dot and
`useStyleTarget` work unchanged, with `activeRule` pointing at the state rule.

**Only style.** CSS can show this without a script and without a second render path. An icon swap is two layers,
one hidden in each state. Attributes that must change with a state, such as `aria-expanded`, belong to the
interaction, see below. Text varying by state is refused in the panel (those sections dim, as they do for Hover).

### Compiled at expansion

`X` is `[data-fc-c="<definition id>"]`, on the placement root.

| Kind | Stored rule becomes | `at` |
|---|---|---|
| hover | `&:is(X:hover, X:hover *)` | `HOVER_GATE`, the existing `@media (hover:hover) and (pointer:fine)` |
| pressed | `&:is(X:active, X:active *)` | none |
| focused | `&:is(X:is(:focus-visible, :has(:focus-visible)), X:is(:focus-visible, :has(:focus-visible)) *)` | none |
| custom | `&:is(X[data-fc-state="open"], X[data-fc-state="open"] *)` | none |

This passes the stored grammar as read in `rules.ts`: the list is split at top-level commas only, `:is()` may read
ancestors (the contract names `&:is(.group:hover *)`), an attribute *name* starting `data-fc` is allowed (the refusal
is on a *value* starting `fc-`), and the longest form stays under the 256 character limit with a uuid [unproven until
slice 11 runs it]. Expanded rules go through the normal parser at emission, so nothing here is exempt from it.

The rule class is keyed on `rules`, and these selectors hold the definition id and not a placement id, so a hundred
cards share one rule block.

**How it composes:**

- **With breakpoints.** A state rule's `style` holds the same `{ base, <breakpoint>: value }` maps, mapped with the
  rest. So Open on Tablet needs nothing new, and the selector contract's value order applies: state first, then
  breakpoint, then implied states, then Normal.
- **With element rules.** All four forms have the same specificity, (0,4,0) on the two rule classes plus the `:is`,
  above an element's own `&:hover` at (0,3,0). So a component state beats an element state on the same property. That
  is stated rather than detected, and it is the order a person expects: the larger thing wins.
- **Between states.** Equal specificity, so the later in `states` wins. `orderRules` keeps state rules after named
  states and authored rules, in `states` order, and Pressed sits after Hover by default.
- **With Normal.** Decision 5 of the selector contract applies: a node with an authored rule moves its styles into
  the sheet. A state rule counts as authored. A node reached only by a state rule on an ancestor needs nothing, since
  every state's differences sit on the node they change.
- **With a placement's style.** A placement's size lands on the root's Normal, so a state with `width` beats it.
  Stated.
- **Nesting.** The definition id scopes the selectors, so an outer component's state never reaches an inner one of
  another definition. A definition cannot contain itself, but through a slot a card may hold a card, and then a state
  on the outer reaches the inner. Slice 10 adds `:not(X X *)`, because it would otherwise be a surprise.
- **An inner placement's state does not vary with the outer's.** Framer offers this; v1 here does not. A nested
  placement has one initial state, and the outer state can show or hide it.

**A placement picks its initial state** in the panel, stored as `props.state`, or from data with a `state` binding,
such as `{{row.tier}}` matched against state ids. Anything unknown is primary.

### On the canvas

Inside the definition, under the breakpoint frames, each state is a tile, as in Framer [tested]: a row of frames per
state at the largest breakpoint, and the other breakpoints on demand from the frame's menu. A tile stores nothing but
`x` and `y`, and only when moved. It is drawn by the existing `ViewportFrame` over the same tree, with its frame id
extended, such as `<bp>__s1`, which stays inside the characters the canvas sheet accepts.

Selecting a node in a tile sets `activeRule` to that state's rule, so every panel row writes the difference, and a
marked row shows it ("set in Open"), with a reset. Selecting a node in the primary frame edits Normal. Resize and
spacing handles write Normal in the selector contract, so inside a tile they route to `useStyleTarget`. That is a
named change to `QuickToolbar` and `quickbar/actions.ts`: a tile has no other way to change a size.

The canvas sheet lists a tile as one more frame, with its states active, using the `:is(*, :hover)` rewrite the
selector contract defines for previews. Decision 8 of that contract stands: a real pointer over a placement or a tile
does nothing, and a tile shows its state all the time.

A placement on a page shows its initial state. The right panel has a state selector for it, and that is stored.
Trying a state without storing it uses the existing `previewRule`.

## Interactions

### The stored record

```ts
interface Interaction {
  id: string;
  on: 'click' | 'pressStart' | 'appear' | 'mouseEnter' | 'mouseLeave' | 'escape';
  trigger: string;        // a definition node id; the root by default
  from?: string;          // only while in this state, `primary` included; absent means from any
  to: string;             // the target state, or the reserved id `primary`
  mode: 'once' | 'cycle'; // cycle: `to` first, then on through `primary` and the custom states in order
  delayMs?: number;       // 0 to 10000
  aria?: 'expanded' | 'pressed' | 'selected'; // written on the trigger, see keyboard
}
```

The first five triggers and Delay, Once or Cycle, and the target are Framer's popover [tested]. `escape` is added,
since a menu has to close by keyboard.

**This contract and the behaviour contract.** Layer 3 owns events and actions as data, and owns the runtime. Two
event formats, or two runtimes, would be a defect. So:

- An interaction is read as an event plus one action, "set this placement's state". It is shaped to convert with
  no data change: `on` is the event, `to`, `mode` and `delayMs` are the action's arguments.
- There is one file, `src/lib/behaviour/runtime.ts`, and whichever slice lands first creates it. If the behaviour
  contract's record differs, it wins, because it is the general one, and this section is revised before slice 13.
  This is open question 1.

### Running it

- **Output.** The runtime reads `data-fc-on` on triggers: compact JSON of that placement's interactions, placed by
  expansion. Stored strings of code never appear, and no `on*` attribute is written.
- **What a page ships.** A page with no interaction ships nothing: Hover, Pressed and Focused are CSS. A page with one
  ships the runtime as a client island, as `EffectsIsland` does.
- **Semantics.** One delegated listener per event type on the document. Each placement root holds its current state
  in `data-fc-state`. On a trigger: skip when `from` is set and differs; with `delayMs`, start a timer, which a newer
  trigger on that placement cancels; set `to`, or the next state for a cycle.
- **Appear** uses one `IntersectionObserver` and fires once per placement.
- **Reduced motion.** A state change is not motion. An authored `transition` is plain CSS and stays authored; a
  generated one follows the AI rules of the selector contract.

### Server rendering and no JavaScript

The server emits `data-fc-state="<initial>"`, or none for primary, so the first paint is correct and there is no flash
or hydration difference. Interactions do nothing without JavaScript. That matters when the primary state hides
content: a closed mobile menu would be a dead end. So a definition may name `noScriptState`, and the page then carries
`<noscript><style>` with that state's rules unconditional. The panel asks for it when a click-driven state changes
`display` or `visibility`. The published effects stylesheet makes the same promise ("nothing is hidden without
JavaScript").

### Keyboard

The primitives plan requires every state to be reachable by keyboard.

- **Hover** is pointer-only, as the selector contract gates it. So a definition with a hover state and no focused
  state gets a panel warning, with one click to copy Hover's differences to a new Focused state.
- **`click`** needs a trigger that takes focus. On a node that is not `button`, `a[href]`, `summary` or a form control,
  the popover says so and offers "Make it a button", using `setTag`. Publishing is not refused: the warning sits with
  `checkBeforePublish`. Adding `role` and `tabindex` plus key handlers quietly would hide the problem.
- **`mouseEnter` and `mouseLeave`** also fire on `focusin` and `focusout`, in the runtime, so they cannot be mouse-only.
- **`aria`** writes `aria-expanded`, `aria-pressed` or `aria-selected` on the trigger: `true` when the state is `to`,
  else `false`. The server emits the initial value. This is one attribute, not a behaviour language: full patterns
  such as tabs with arrow keys are layer 3.

### Connecting on the canvas

In the definition, a selected tile shows a handle. Dragging it to another tile draws a connector and opens the popover
beside it. Connectors are an SVG layer in canvas space, reading `interactions`; the drag uses a new `DragSource` kind
`connectState`, resolved against tiles only. Dropping nowhere cancels. Dropping on the tile it started from is refused.

The popover has four rows: **On** (a select), **Delay** (milliseconds), **Transition** (Once or Cycle), **Target** (a
state), plus **Trigger**, defaulting to the whole component, with a picker for a layer. One save is one undo step.
Selecting a connector opens it; Delete removes it. Connectors are drawn for pointers, so the same list sits in the
right panel when the root is selected, as plain rows, which is how a keyboard or a phone edits them.

**Trying it.** Preview runs interactions, since it mounts the same runtime. The primitives plan also wants them on the
editing canvas. The score already names that as the mounted editor's gap (`canvas-editor-context`, "closing it takes
an interact mode on the canvas"), and an interact mode is one thing for the whole canvas, so it belongs to the
behaviour contract. Until then tiles show each state without running.

## Editing on the canvas

**Selecting.** On a page, a placement is one selectable, draggable unit. Inner nodes render with the existing
`lockedByAncestor` path: pointer events pass through to the nearest unlocked ancestor ([code]), which is the placement
root, so hit testing needs no new rule. The root's DOM carries the placement's `data-component-id`, so selection
outlines, resize and spacing handles work. `resolveDropTarget` treats a placement as a leaf, like a void tag, so no
drop lands inside. Inline text editing is off there; the panel holds the text.

**Entering.** Double-click, Enter on a selected placement, or "Edit component" in the panel or the context menu. This
sets `editorUI.currentPage` to `definition.page` and keeps a volatile return record: `{ pageId, placementId, transform }`.
The canvas shows the definition's frames, tiles and connectors, and a bar reads "Home > Card" with the placement count.

**Leaving.** Esc outside text editing, the bar, or a page in the Pages panel. The return record restores the page, the
canvas position and the selection.

**The stateful paths** (the stateful flow standard):

- **Forward:** select nodes, Create component, name it. The selection becomes one placement, and a definition exists.
- **Backtrack:** undo restores the original nodes and removes the definition, as one step. Undo of an edit made inside
  a definition, from a page, updates every placement on screen, and the history label names the definition.
- **Resume:** the return record is volatile. A reload opens on a real page, with everything intact.
- **Re-entry:** a definition deleted or undone away while open, by this tab or by another's save, clears the
  `safeReference`, and the editor returns to the return page with a message rather than an empty canvas. A placement
  whose definition vanished stays as the "Missing component" box, deletable, and is not removed from the page by the
  editor, so restoring the definition restores it.

**Layers.** On a page, a placement is one row with a component icon and its definition's name, or its own label. It
does not expand. It has Duplicate, Delete, Detach and Edit component. Inside a definition, the panel shows that tree
normally. Nested placements read the same way.

**The Components panel.** A new section at the top of `ComponentsPanel`, "This site", lists definitions with a small
placement count. Each is a drag source of a new `DragSource` kind `place`, and a tap in the phone layout, with Rename,
Edit, Duplicate and Delete in its menu. With none, it shows one line on how to make one. Delete names the placement
count, and says they become plain copies.

**The right panel.** A selected placement shows a new `ComponentSection`: the generated form, one row per input with
the type's existing control, a state selector, Edit component, Detach and Reset all. Below it are Size, Position and
Effects, and `sectionConfig` hides everything else. Each row has the binding control, and a reset where a value is
set. The binding control is what puts a placement in a collection on `{{row.title}}`.

**Making an input.** In a definition, each row with a binding control gets "Make input": it creates the input with the
right type, copies the current value as the default, and writes the binding, in one action. "Inputs" in the root's
panel lists, renames, reorders, retypes and removes them.

**Undo across placements.** `HistoryStore` records patches under `projectStore`, and `ProjectModel` is inside that
([code] `RootStore.ts`). So:

| Action | History entries | What is restored |
|---|---|---|
| An edit inside a definition | One, as on any page | All placements follow, since they read it live |
| `createComponentFromSelection` | One `ProjectModel` action | The original nodes |
| `removeInput`, `changeInputType` | One, patching every page | The input, its bindings and every value |
| `deleteComponent` | One, patching every page | The definition and every placement |
| `detachPlacement` | One | The placement |

These are actions on `ProjectModel`, not on `PageModel`, because they cross pages. A page action cannot record patches
on another page's subtree as one user step, because each would be its own top-level call.

## Nesting and cycles

A definition may place another. `wouldCycle(definitions, targetId, placedId)` walks placements (and slot children)
from `placedId` through each definition's trees. A placement is refused, with a reason naming the path ("Card contains
Grid, which contains Card"), in `placeComponent`, in `moveTreeComponent` when the target is inside a definition, in
create from selection, and in the panel's list, where the entry is greyed. Expansion checks again with a stack and the
depth cap, because the model's check protects honest paths and the render step protects against stored data.

Inputs pass down through a nested placement's bindings: `input.heading` on an inner placement bound to `{{input.title}}`
of the outer. The picker offers that.

## Worked examples

### A navbar

Links live in the definition, so changing them once changes every page. That is the point of it, and why this needs
no `list` input.

- **Definition:** root `header`; a logo image; a `nav` with Link nodes; a `button` for the menu, shown on Mobile only;
  a `nav` panel for Mobile.
- **Inputs:** one, `tone`, a `choice` of Light or Dark on the root's `data-tone` attribute, read by rules such as
  `&[data-tone="dark"]`.
- **States:** primary (Closed), `s1` Open.
- **Mobile, Open:** the panel node's rule holds `{ display: { base: 'none', <mobile>: 'flex' } }`.
- **Interaction:** `{ on: 'click', trigger: <menu button>, mode: 'cycle', to: 's1', aria: 'expanded' }`, plus
  `{ on: 'escape', from: 's1', to: 'primary', mode: 'once' }`.
- **No JavaScript:** `noScriptState: 's1'`, so the links stay reachable.
- **On ten pages:** ten placements of a few bytes each, and one edit reaches all ten.

**Not covered:** marking the current page's link (`aria-current`) needs a renderer pass that knows the path. That
belongs to the navbar slice of the primitive stream, not to this format.

### A hero

- **Definition:** a `section` with an `h1`, a `p`, a Link and a background.
- **Inputs:** `title` (text, on `h1` children and on the image's alt), `subtitle` (text), `cta` (text), `ctaHref` (link),
  `background` (image, on `style.backgroundImage`), and `showSubtitle` (toggle on `visible`).
- **States:** hover on the Link only, as an ordinary element rule. A hero needs no component state, and most sections
  will not.
- **Per placement:** `style: { paddingTop: {...} }` where one page wants it taller.
- **Worth noting:** `applyImageLoading` runs after expansion, so a hero image in a component keeps its priority
  loading, which is what `HeroPreload` needs, if it is bound to `src`. A background image stays as it is today.

### A card

The example above, in a collection: placing it in a Collection's row template with `input.title: {{row.title}}` gives
one card per row. `hydrateCollection` clones the template, `hydrateNode` pushes the row frame, then the input frame on
top. A hundred rows share one CSS block for each node that has a class, through `classKey`, and each has its own `id`. The hover state is `translate`
in CSS. There is no script on the page.

## AI generation

**Reading.** `serializeSubtree` writes a placement as `{ type: '#component', name, inputs }`, without its inner tree,
which is also far fewer tokens. `promptSections/siteContext.ts` lists definitions: name, description, inputs with
types, states. A new section teaches placing them. So "add a pricing card" uses the site's card.

**Writing a placement.** `validateGeneration` accepts `#component` nodes: the definition must exist, each input through
`parseInputValue`, cycles refused, unknown inputs dropped and reported. `applyGeneratedNodes` needs no change, since
it creates nodes, and `revertGeneration` works by id.

**Writing a definition.** The generator may return `definitions` beside `nodes`, for structure repeated at least
twice, capped at 6 per generation, with each definition's nodes passing the full validator. `toEditorSnapshot` rekeys
its maps with `breakpointKeyMap` onto the definition's own frames. `addGeneratedComponents` adds definitions and
nodes in one action. A definition placed once is refused, because a single-use component is noise.

**Review.** `ai/review/ops.ts`: `update_style` on a placement goes to its own style. A review may not edit a definition,
because a change there has a reach the review cannot see. It may propose it as a message.

**Nothing is converted automatically.** A generator does not turn a site's repeated sections into components unasked.

## React import and export

Step 7 builds this. The contract says what it targets.

- **Export.** A definition becomes a function component whose props are its inputs, a placement becomes
  `<Card title="..." />`. In the round-trip's normalised form, a placement has `component`, `inputs`, `state`, `style`
  and `bindings` as named props, the same way bindings are handled. State rules stay `rules`.
- **Import.** A file's default component becomes a definition, its destructured props become inputs (string to `text`,
  boolean to `toggle`, union of literals to `choice`, ReactNode to `slot`), and JSX reading a prop becomes a binding.
  `{cond && <X/>}` on a boolean prop becomes `visible`. `.map` over a prop becomes `list`.
- **`cva` variants** (the shadcn pattern) map to `choice` inputs on `data-*` attributes plus rules, not to states,
  because a variant chosen by a prop is not state.
- **`useState` toggling a class** maps to a custom state plus a `cycle` interaction, when it is that simple.
- **Anything else** is reported line by line under the plan's rule. A half-understood component fails loudly.

## Migration

None of existing data. No stored page changes, no snapshot is rewritten, and `expandPlacements` on a tree without a
`#component` node returns it unchanged, by reference, so the output is byte for byte what it was. A test pins that
against the `responsive-layout` fixture. Existing navbars stay ordinary nodes until someone chooses Create component,
and that is a person's choice for each.

The only schema change is the additive `sites.components` column.

## Score changes

Nothing in the score measures reuse today, so the matrix cannot show this work. There is no row kind for it, and no gap
id. **This contract closes no existing row and no existing WAI-ARIA pattern:** those need keyboard behaviour, which is
layer 3. `radix-accordion`, `radix-tabs` and `radix-dialog` stay blocked on `behaviour-state`.

So slice 1 adds:

- **A row kind `component`**, from a new `test/score/data/component-capabilities.json`, the one list of what the
  format promises. 32 rows: the 20 input types and these 12 capabilities: `definition`, `placement`,
  `placement-style`, `nested`, `cycle-refused`, `collection-template`, `state-hover`, `state-pressed`, `state-focused`,
  `state-custom`, `interaction-click`, `interaction-appear`.
- **A gap id `reusable-components`.** All 32 rows start failing under it, and `event` moves to `behaviour-state`.
- **Cells mean:** format survives the snapshot round trip with a reader; published emits it through
  `renderPublishedPage`; canvas renders it through the real `ComponentRenderer`; panel changes it through the real
  section; AI keeps it through `validateGeneration`.

`baseline.json` holds counts, so failing rows lower no floor. Percentages dip by up to about 1.5 points (Format from
86.1 to 84.7 percent), because 1,832 rows become 1,864.

**Corpus,** four fixtures. Each compares a page built from a definition with plain HTML.

| Fixture | Proves |
|---|---|
| `component-cards` | Three placements with different inputs equal three handwritten cards. Also that each node with a class has one block, not one per placement |
| `component-navbar` | One definition on two pages, at each breakpoint, closed and open, by click and by Escape, with the runtime and without it |
| `component-collection` | A card as a row template. Needs the harness's CMS fake in `test/score/lib/published.ts` |
| `component-states` | Hover, Pressed, Focused and one custom state, at each breakpoint, compared in real Chromium with scripts blocked for the first three |

Per the fleet plan, held-out component fixtures sit where workers cannot write. The operator places these four, so
workers do not write their own pass. Round-trip cases are in slice 15.

## Slices

Each is one file-scoped pull request, green alone, raising `baseline.json` where a number rises. The fleet plan
estimated five; breakpoints, the raw-snapshot readers, persistence and the runtime were not in it. Cells are maximums,
and a pull request states the real figure.

| # | Slice | Files | Tag | Depends on | Closes |
|---|---|---|---|---|---|
| 1 | `components-format` | `src/lib/components/{definition,inputs,placement,breakpoints}.ts` and tests, `test/score/lib/types.ts`, `component-capabilities.json`, `universe.ts`, `report.ts` | | none | Nothing yet: adds the 32 rows and the gap. Tests: every input type's refusals, `D(P)` with mismatched frames |
| 2 | `components-expand` | `src/lib/components/expand.ts`, `snapshotToComponentNode.ts`, `hydrateBindings.ts`, `scope.ts`, `applyBindings.ts`, `applyResponsiveStyles.ts`, `renderComponentNode.tsx`, `createComponentElement.tsx` | `renderer` | 1 | Format and published for `definition`, `placement`, `placement-style`, `nested`, `cycle-refused`, `collection-template` and the 7 slice-1 types (13 rows, 26 cells). Identity on the unchanged fixture. Fixture `component-cards` |
| 3 | `components-persistence` | `prisma/schema.prisma`, the migration, `snapshot.ts`, `repository.ts`, `publicResolver.ts`, `ProjectModel.ts`, `page.tsx`, `not-found.tsx`, `renderSitePage.tsx`, `submit.ts` | `prisma`, `migrations` | 2 | No rows. A definition survives save, load, publish and render, and a form placed twice takes two submissions, in `test:integration`. **The migration needs Marlin's one-line yes when it deploys** |
| 4 | `components-site-walkers` | `siteFiles.ts`, `notFoundDefault.ts`, `legal/templates.ts`, `PublishButton.tsx`, `ProjectModel.addLegalLinksToFooters` | | 3 | No rows. For each reader, a test with the fact only inside a component |
| 5 | `components-model` | `ProjectModel.ts`, `ComponentModel.ts`, `PageModel.ts`, `wouldCycle` in `definition.ts` | | 3 | No rows. Every action in the undo table as one history entry; all four stateful paths at model level |
| 6 | `components-canvas` | `ComponentRenderer.tsx`, `HeadlessComponentRenderer.tsx`, `ResponsivePageRenderer.tsx`, `createComponentElement.tsx`, `resolveDropTarget.ts`, `PageFontFaces` | `renderer` | 5 | Canvas for the 13 rows. Browser proof: a placement selects as one, a drop cannot land inside it, Tablet frame reads the definition's Tablet value on a page with different ids |
| 7 | `components-editing-mode` | `EditorUIStore.ts`, `Canvas.tsx`, a breadcrumb bar, `LayersPanel.tsx`, `PagesPanel.tsx` | | 6 | No rows. Browser proof of enter, edit, leave, undo from the page, and a definition deleted while open |
| 8 | `components-panel` | `ComponentsPanel.tsx`, `drag/types.ts`, `DragManager.ts`, `ComponentSection.tsx`, `sectionConfig.ts`, `BindingControl.tsx`, `BindingPicker.tsx`, `scopeIntrospection.ts`, `matrix.panel.jsdom.score.tsx` | | 7 | Panel for the 13 rows. A browser proof from Create component to a published page |
| 9 | `components-inputs-styled` | `inputs.ts`, per-type controls, `ComponentSection.tsx`, the score's samples | | 8 | The 10 styled types in four columns (40 cells) |
| 10 | `components-list-slot` | `expand.ts`, `hydrateBindings.ts`, `ComponentRenderer.tsx`, `ComponentSection.tsx`, `resolveDropTarget.ts`, the nesting `:not()` | `renderer` | 8 | `list` and `slot` in four columns (8 cells) |
| 11 | `component-states-format` | `expand.ts`, `rules/states.ts`, `ComponentModel.ts`, `definition.ts`, `corpus/fixtures.ts` | | 2, selector slice 3 | Format and published for the four state rows (8 cells). Part of fixture `component-states`: the first three work with scripts blocked |
| 12 | `component-states-canvas` | `ResponsivePageRenderer.tsx`, a `StateTile`, `rules/surfaces.ts`, `QuickToolbar`, `quickbar/actions.ts`, `RightSidebar`, `ComponentSection.tsx` | | 7, 11, selector slices 6 and 7 | Canvas and panel for the four state rows (8 cells). Browser proof: editing Open on Tablet in a tile reaches a published page |
| 13 | `component-interactions` | `src/lib/behaviour/runtime.ts`, `applyEffects`-style island, `expand.ts`, `renderPublishedPage.tsx` | `renderer` | 11, open question 1 | Format and published for the interaction rows (4 cells). Fixture `component-navbar`, including no JavaScript and keyboard. A size budget test on the runtime |
| 14 | `component-connectors` | A connector layer, `drag/types.ts`, the popover, the right panel list | | 12, 13 | Canvas and panel for the interaction rows (4 cells) |
| 15 | `components-ai-round-trip` | `validate.ts`, `serializers/subtree.ts`, `promptSections`, `apply.ts`, `PageModel.ts`, `ai/review/ops.ts`, goldens, `roundtrip/jsx.ts`, `roundtrip.score.ts` | | 8, 11, `fleet-ai-allowlists` | AI for 31 rows (all but `event`), labelled `accepted, not taught` where the prompt does not teach them. Round-trip cases: placement, nested, state, input binding |

Slices 2, 6, 10 and 13 share the `renderer` tag, so the operator runs them in order. Slice 3 is what turns the fleet's
parallel work into a shared base: nothing after it can reach a saved page without it.

**What the slices add up to:** every cell of the 32 rows but the `event` row: 155 of 160, and 4 of 4 fixtures, as
ceilings. The event row closes with the behaviour model.

**A matrix pass here proves less than it reads,** as the selector contract says of its own rows. The corpus is the test.

## What this does not cover

- **Overrides of inner nodes,** by decision 7.
- **Theme tokens.** Colours and fonts as site variables are their own gap in the primitives plan. An input does not
  replace them.
- **Sharing definitions between sites.** A definition belongs to one site, and copying one needs its assets and fonts.
- **Marking the current page in a navbar,** see the example.
- **An inner placement's state following the outer's.**
- **Rich text inputs.** Mixed text inside an input value is a `slot`.
- **Multiplayer.** Two tabs on one definition are last-write-wins, as pages are.
- **Editing in context,** with the page dimmed around a component. Isolation comes first. In-context editing can be
  added on top.
- **The interact mode on the canvas,** see "Trying it".

## Decided here, say so if you disagree

The fleet plan gives contracts to a fresh review agent before fan-out. These do not wait for Marlin.

1. A definition wraps a real `PageModel`, rather than a new tree owner.
2. A placement is a `#component` node, not a marked `div`.
3. Expansion happens before hydration, with input values resolved by a frame during hydration.
4. A unique `id` plus a shared `classKey`, rather than one of the two.
5. No inner overrides. Inputs, state and own layout are the whole surface.
6. Removing an input deletes its values across the site in one undoable action, rather than keeping orphans.
7. Breakpoints are mapped by width, rather than moved to site level.
8. A state holds style differences only.
9. A component state beats an element state on the same property.
10. Deleting a definition leaves plain copies, rather than refusing or deleting placements.
11. `visible: false` removes the node from the markup.
12. A published revision will hold `components` beside `pages`, not flattened pages.
13. `escape` is added to Framer's five triggers, and `mouseEnter` and `mouseLeave` also fire on focus.
14. `click` on a non-interactive node warns rather than being fixed silently.
15. 20 input types, designed from Framer's 22 documented controls, not its unverified 17.
16. Sticky bars are refused inside a definition.

## Open questions

1. **For the review, against the behaviour contract:** does its event and action record absorb `Interaction` as
   written, and do both name one runtime file? It is being written at the same time, so neither could read the other.
   Slice 13 waits on this. Slices 1 to 12 do not.
2. **For the review:** is (0,4,0) right for a state over an element's own Hover, and does the `:is()` form in the
   compile table hold in Chromium and WebKit? It has been read against the parser, not run.
3. **For Marlin, at deploy, as one line:** the additive `sites.components` migration, with `DEFAULT '{}'` and no row
   rewritten.
4. **For the operator:** whether the immutable published copy should land before the first customer uses a component,
   given that one saved navbar edit reaches every page after a cache miss. This contract does not depend on it. The
   exposure is the existing one, wider.

Sources for Framer's types: [property controls](https://www.framer.com/developers/property-controls) and [component
variables](https://www.framer.com/academy/lessons/component-variables-in-framer).
