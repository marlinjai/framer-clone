---
type: plan
status: draft
date: 2026-11-02
title: "Reusable components and component states: the contract for definitions, placements, inputs, states and interactions"
summary: "How a component is built once per site and placed many times. A definition is a small page stored under ProjectModel, so the canvas, Layers, rules and undo work on it unchanged. A placement is a `#component` node holding the definition id, input values and its own layout. One pure step expands placements before hydration, so forms, stylesheets, fonts and every later pass see ordinary nodes. Inputs are a new `{{input.x}}` binding frame, parsed after they resolve, under a shared byte and node budget. Breakpoint ids differ per page, so definitions are mapped by width. States store only style differences. Hover, Pressed and Focused are plain CSS; custom states compile to the behaviour model's `choice` state, `when` rules and scopes, and interactions are its triggers, so there is one event format and one runtime. No existing page changes. Revised after an independent review. Seventeen slices, 30 new score rows and four new fixtures. The first Create component button waits for the immutable published copy."
tags: [framer-clone, primitives, reusable-components, component-states, renderer, fleet]
projects: [framer-clone]
---

# Reusable components

This is step 5 of the [complete primitives plan](2026-11-01-complete-primitives.md), and layer 2 of its "Visual
state management": named states on a reusable component, shown as frames on the canvas, storing only their
differences, with drag-to-connect interactions. It answers gap 4 of that plan, "a navbar on ten pages is ten
copies". It builds on the [selector contract](2026-11-02-selector-styling.md) and compiles to the behaviour contract
(`docs/plans/2026-11-02-behaviour-model.md`, pull request #222, read at `63b93dd`, not merged at this writing). It
specifies, and builds nothing.

Read against commit `87fbe6d`, rebased on `131850d`, which adds the AI allowlists (#213). At that commit `props.rules`, its parser and the model's rule actions are merged
(#217), and text nodes are finished (#218). The stylesheet emission, the canvas sheet and the state switch (selector
slices 2 to 7) and all of the behaviour model are not, so slices here name them as dependencies. Revised after the
independent review of 2026-11-02 (`~/software-dev/decision-pages/2026-11-02-reusable-components-review.md`), whose
findings F1 to F20 are applied here. "Review findings not adopted" lists what was changed or declined, with the
evidence.

**Evidence marks:** **[code]** read here, **[Framer docs]** read from Framer's site on 2026-11-02, **[tested]** from
the editor test of 2026-11-01 in the primitives plan, **[proven]** run with the real parser or in real Chromium and
WebKit, by the review or for this revision, **[unproven]** designed but not run.

Short forms: CSS (Cascading Style Sheets), JSON (JavaScript Object Notation), JSX (React's markup syntax), MST
(MobX State Tree, the editor's data model), CMS (content management system), API (application programming
interface), ARIA (Accessible Rich Internet Applications). "Definition" is the one stored component. "Placement" is
one use of it on a page. Framer calls these a component and an instance.

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
   a form placed twice is two forms. The stylesheet keys on `classKey`, so twelve cards share their CSS wherever a
   class is issued.
5. **Inputs are read bindings on a new frame, `{{input.<id>}}`.** No new resolver. One input may drive several
   nodes. A placement's value is a literal or a binding resolved in the placement's outer scope, so a card inside a
   collection takes `{{row.title}}`. Every value is parsed after it resolves.
6. **A definition's breakpoints are its own, mapped to a page's by width.** Breakpoint ids are random per page
   ([code] `createPage` calls `defaultViewportSnapshots()`, which mints fresh ids), so a map keyed on one page's ids
   means nothing on another.
7. **The only things a placement can change are its input values, its state, how it sits on the page** (size,
   position, effects) **and what it does when used** (`on` and `showWhen`). There are no overrides of inner nodes. To
   go further, a person edits the definition, adds an input, or detaches.
8. **A state stores style differences only, and it fails closed.** A stored state rule is refused by the parser until
   compilation replaces it, so a rule that missed compilation reaches no sheet. Text and structure do not vary by
   state: two layers shown and hidden do that.
9. **Pointer states are CSS; custom states are behaviour.** Hover, Pressed and Focused compile to selectors and need
   no JavaScript. A custom state is one value of a `choice` state on the placement root, and a rule with a `when`
   condition. Interactions are triggers in `props.behaviour`. There is one event format and one runtime, and they are
   the behaviour contract's.
10. **No data migration, and no page changes at deploy.** A page without a placement goes through expansion untouched.
    One additive column holds the definitions.

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
  noScriptState?: string;     // a state id, see "Without JavaScript"
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
would drift. The cost is about 1.5 kilobytes of viewport frames per definition, which is accepted.

**Structure rules,** in the model, the panel and `parseComponents` ([proven] for parsing):

- **A definition root** is an element. A `#component` root would put two `data-fc-c` values on one element, and a
  `#text` root has no element for a state or a style.
- **Create component from several selected nodes** wraps them in a `div`, which is the definition's root.
- **A page root** cannot be a placement. A failed expansion there would make `root` null and the page a 404.
- **Placing by content model.** The card below has root `a`, and inside a Link the HTML parser closes the outer `a`,
  so the `h3` lands outside. The same goes for a `div` root in a `p`. `resolveDropTarget` and the model read the
  definition's root tag, and whether it holds interactive content, and refuse such a drop, as they do for a void tag.
- **Ids.** `parseComponents` refuses a definition id not matching `[A-Za-z0-9-]+` or starting `fc-` (a compiled
  selector with one is refused whole, [proven]), and a `StateDefinition.id` not matching `[A-Za-z0-9_-]+`.
- **A definition refuses a sticky bar,** which is one per page and page-level, see the readers table.

**Limits,** checked at the model and again at the render step:

| What | Limit | Beyond it |
|---|---|---|
| Definitions per site | 200 | The model refuses with a reason; the renderer ignores the rest with a warning |
| Size of one definition, serialised | 256 kilobytes | As above |
| Inputs per definition | 40 | As above |
| States per definition | 16 | As above |
| Nesting depth | 8 | The nested placement renders nothing, with a warning |
| Expanded nodes per page | 5,000 | Later placements render nothing, with a warning |
| Expanded bytes per page | 4 megabytes | As above |

**The budget is one object,** because stored JSON is opaque to the save route ([code] `.passthrough()`), and all
tenants share one Node process. Nodes alone would miss the cost: one node holding 1 megabyte of text, in a few nested
placements, reaches 5,000 expansions from a few hundred bytes, which is 5 gigabytes of text on every request.
Nodes at expansion alone would miss rows: `hydrateCollection` clones after expansion, so a 5,000 node card at
`PUBLISHED_MAX_LIMIT` of 100 rows is 500,000 nodes. So `expandPlacements` and `hydrateNode` draw on one
`RenderBudget`. A definition's serialised size is computed once and charged per expansion, and rows and list items
charge it too. Past a limit, rendering of placements stops, with the one warning, and the page serves what it has.

### The placement

```ts
/** A ComponentModel node: type '#component', componentType 'host', no children. */
interface PlacementProps {
  component: string;                   // the definition id
  inputs?: Record<string, unknown>;    // input id -> value; absent means the default
  state?: string;                      // the initial state id; absent means primary
  style?: Record<string, unknown>;     // an ordinary style object, how it sits on the page
  effects?: unknown;                   // an ordinary effects object
  behaviour?: { on?: Trigger[]; showWhen?: Condition }; // the Trigger field; nothing else of behaviour
}
// A value from data sits in node.bindings under `input.<id>`, and a state under `state`.
```

`src/lib/components/placement.ts` holds `PLACEMENT_TYPE = '#component'` and `isPlacementType`, the same shape as
`src/lib/renderer/textNode.ts`. Considered and refused: a `data-component-kind` marker on a `div`, like the data
components. A marker renders as a real element if anything misses it, which hides a bug as an empty box, and
placements need no host element, because the definition's root is the element. A `#` type cannot be a tag. Every
renderer checks it before the tag path, since `createElement('#component')` throws [proven].

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
  A mixed sentence is an element with `#text` children, where one text node is bound, or a `richtext` input.

The panel's binding picker in a definition offers inputs and hides `row`, `product` and the rest, because a
definition that reads `{{row.title}}` directly works in one collection and silently nowhere else. The renderer does
not refuse one, since `scopeIntrospection` cannot know where it will be placed.

### The input types

Framer's editor offers 17 types, now known by name: Plain Text, Formatted Text, Date, Link, Image, Gallery, List,
Color, Toggle, Number, Option, Event, File, Transition, Border, Cursor, Shadow. This contract offers exactly those.
Framer's developer documentation also lists code controls, 22 in all [Framer docs]. `font`, `radius`, `padding`, `gap`
and `slot` were cut from the first version: the first four are not in Framer's editor, and a `text` or `number` input
bound to the style does their job. `slot` moves to step 7, see "What this does not cover".

| Ours | Framer | Value | Binds to | Checked by | Slice |
|---|---|---|---|---|---|
| `text` | Plain Text | string, optional `multiline`, `maxLength` | `children`, non-address attributes only | `parseInputValue`; only into text and non-address attributes | 2 |
| `number` | Number | number, `min`, `max`, `step`, `unit` | `style.*`, attribute | Finite, in range | 2 |
| `toggle` | Toggle | boolean | `visible`, attribute | Strict boolean | 2 |
| `color` | Color | CSS colour or a responsive map | `style.*` | The value check below | 2 |
| `image` | Image | `{ src, alt, focalPoint? }` | `src`, `alt`, `style.backgroundImage` | `isSafeSrc` | 2 |
| `link` | Link | site path or address | `href` | `safeHrefFromData` | 2 |
| `choice` | Option | one of `options[].value` | attribute, `style.*` | In the list | 2 |
| `richtext` | Formatted Text | `{ runs: [{ text, marks?, href? }] }` | `children` | The run check below | 9 |
| `file` | File | stored file address | `href`, `src` | `safeHrefFromData` | 9 |
| `date` | Date | ISO 8601 string | `children`, `dateTime` | `Date.parse` | 9 |
| `border` | Border | CSS border string | `style.border` | The value check below | 9 |
| `shadow` | Shadow | CSS shadow string | `style.boxShadow` | The value check below | 9 |
| `cursor` | Cursor | CSS cursor keyword | `style.cursor` | Keyword list | 9 |
| `transition` | Transition | CSS `transition` string | `style.transition` | The value check below | 9 |
| `list` | List | array of one item shape | a repeated node, see below | Each item checked | 10 |
| `gallery` | Gallery | array of `image` values | a repeated node | As `image`, per item | 10 |
| `event` | Event | none: wired on the placement | an `emit` action in the definition | The behaviour parser | 14 |

Framer's code-only Object is not a type here: an input has an optional `group`, which is only a heading in the panel.
Its Transition edits Framer Motion's options, which this project does not ship, so ours is the CSS property.

**`richtext`,** cheap because `#text` runs already exist: a validated array, never markup. `marks` is a closed list
(`strong`, `em`, `u`), `href` goes through `safeHrefFromData`, and one pure `renderRuns` in `textNode.ts` serves every
renderer, placed where `ownTextThenChildren` reads the text. The panel's control is a text area with `**bold**`,
`*italic*` and `[label](address)`. A plain string, from a CMS for instance, renders as text.

**`event`,** Framer's event variable, cheap because the behaviour model has `emit`: a trigger in the definition does
`{ emit: 'input-<id>' }`, and a placement stores `behaviour.on: [{ on: 'custom:input-<id>', do: [...] }]`.

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

`src/lib/components/inputs.ts` holds `parseInputValue(definition, value)`, pure and client-safe.

**Where the check runs, and what it does not prove.** A bound value is only known in hydration, so `node.props.instance`
carries the input definitions, and `hydrateNode` parses each value after it resolves, literal or bound. A value that
does not parse is treated as absent, with one warning per page. The panel, the AI validator and the import run the
same function.

The gates after that are named exactly, because the first version overclaimed them [proven]:

- **Address attributes.** React writes `HREF`, `FORMACTION` and `xlink:href` raw, and `<a HREF="javascript:...">`
  runs in both engines. `blockedNodes.ts` gates by destination at the render step, in any letter case. That fix is the
  operator's and lands apart from this work; slice 2 depends on it, and `text` binds only to non-address attributes.
- **Plain styles.** `declaration()` runs only for the stylesheet. A node with only plain styles goes inline through
  React, so `color: 'red;background:url(https://track.example/x)'` from a CMS cell reaches the page. So in
  `hydrateNode`, a `style.*` value that came from a binding goes through the same check as the sheet, and a refused
  value is left out with the warning.
- **Tags and handlers.** `isBlockedTag` and `isBlockedProp` run on the expanded tree in both renderers ([code]).

**Inputs do not reach rules.** The selector contract refuses a `{{` in a rule value, and this keeps that. A state
colour set per placement goes through a custom property: an input bound to `style.--u-accent` on the root, and the
rule says `var(--u-accent)`.

### A new binding slot, `visible`

`bindings/types.ts` mentions `visible` in a comment and nothing reads it ([code] no reader in `src/lib/bindings`, the
hydrator or `createComponentElement`). This adds it: a bound `visible` that resolves to exactly `false` removes the
node. Anything else keeps it, so a binding that fails shows content rather than hiding it. It is not the Layers eye,
which is canvas only, and not `display:none`, because a hidden optional badge should not be in the markup at all.

`hydrateNode` returns no node for it, so `hydrateChildren`, the `items` walk and the row loop filter it out of their
lists, and a Collection whose template is hidden renders its rows empty. `ComponentRenderer`, `HeadlessComponentRenderer` and `createComponentElement` return null. Inside an
interactive island it is applied by the pass in "Expansion".

### List and gallery

**`data-repeat` is handled in `hydrateNode`,** as `hydrateCollection` handles rows, after the input frame is pushed,
since `input.tags: {{row.tags}}` has no items at expansion time. A node in the definition holds
`props['data-repeat']: '<input id>'`, cloned once per item with an `item` frame (`{{item.label}}`, `{{item.src}}`). Each
clone's `id` takes the item index, or items would collide as React keys and a form in a list would be one form. At most
100 items. Items draw on the budget. Item shapes are one level of the scalar types, plus `image`.

## Overrides, and what happens when a definition changes

A placement stores only what it was given, and a definition change rewrites no placement, except the actions marked
in bold, each in one undo step.

| Change to the definition | Stored placements | What a visitor or editor sees |
|---|---|---|
| Any edit to its nodes | Nothing | Every placement follows, on the next save or publish |
| A default changes | Nothing | Placements with no value of their own follow; placements with one keep it |
| An input is renamed | Nothing, because values are keyed on `id` | The panel's label changes |
| Inputs are reordered or grouped | Nothing | The panel's order changes |
| A node holding a binding is deleted | Nothing | The input stays and the panel marks it "not connected" in the definition |
| **An input is removed** | The value and every binding to it are deleted, across all pages and all definitions, in one action | The node shows its stored value |
| **An input's type changes** | Values that pass the new type are kept; the rest are deleted, in one action | The dialog first says how many values go |
| **A state is removed** (`removeState`) | That state's rules are deleted from every node, its option leaves the `choice`, and any trigger, `when` or `noScriptState` naming it is deleted; placements on it go to primary; all in one action | The state is gone everywhere |
| **A definition is deleted** | Every placement is detached, across all pages and definitions, in one action | Pages look the same, see Detach |

Why deletion rather than keeping orphans: a kept value that means nothing is invisible state, and it would come back
wrong if an input with that id ever returned. One action means Cmd+Z restores everything. Renderers still tolerate an
unknown key, because an old tab or a stale save can produce one.

**Why no inner overrides.** Figma-style overrides store paths into a tree the author can restructure at any time, so
each definition edit needs a rule for each orphaned path. The primitives plan already chose against them: "its author
chooses which fields each placement can set". With inputs as the only route, every placement stays correct through
any edit, and the panel needs one generated form.

**The placement's own style** is merged onto the definition root per property and per breakpoint: the definition's
`width: { base: '100%', <mobile>: '50%' }` under a placement's `width: { base: '300px' }` gives 300px on Desktop and
50% on Mobile. Replacing the map whole would lose the definition's Mobile value without anyone asking. A placement key
is deleted and re-added on merge, so it always lands last: `{ ...definition, ...placement }` alone keeps a shared key's
old position, and a definition's `paddingTop` would beat a placement's `padding` [proven]. The panel offers Size,
Position and Effects here. The renderer merges any key, because stored data is opaque, and that is harmless: such a
key could as well be written into a node on the page today.

**Effects** merge per group, so a placement can add Appear to a card with no change to the definition.

**Behaviour.** `on` entries are appended to the root's, and `showWhen` is set on the root. Nothing else of `behaviour`
is allowed on a placement.

**Detach** replaces a placement with a copy of the expanded tree, in one action. Applied to any placement, on a page
or inside another definition, in the holder's breakpoints.

- **Ids** are fresh. A form's id therefore changes and past submissions stay under the old one: Detach and Delete say
  so first, as Create component does.
- **Inputs:** a literal value is written in. A value from data has no literal in the editor, so the binding is
  rewritten to the outer expression, joining paths: `{{input.image.src}}` over `input.image: {{row.cover}}` gives
  `{{row.cover.src}}`.
- **States stay.** A custom state's rules become stored `when` rules, its `choice` state stays on the root, and triggers
  remap through `remapBehaviourRefs`. A pointer state on the root becomes `&:hover` and its like. On a descendant, the
  root gains `data-u-c-<short id>` and the selector reads that. So after deleting a navbar definition, the menu still
  opens, and "pages look the same" holds.

## Breakpoints

A definition has its own frames, so its maps are keyed on its own breakpoint ids. Frames can differ across pages too,
since `SizeSection` calls `setViewportProperties` ([code]). So the mapping is by width, and it is one pure function in
`src/lib/components/breakpoints.ts`:

```text
D(P) = the definition breakpoint with the largest minWidth <= P.minWidth,
       or the definition's smallest when none is.
```

- **Published:** expansion rewrites every responsive map in the definition (top-level props, `style`, each
  `rules[].style`, each `effects` group, each `inputs[].default`) to the page's ids. For each page breakpoint P, largest
  first, the value is `resolveCascade(map, D(P), definitionBreakpoints)`. The largest gets `base`, and any other gets
  its own key only where it differs from the next larger one's. With the default frames on both sides, this is an exact
  rename. **A page with no frames** (`breakpoints: []`, which the published path allows) keeps each map's `base`.
- **Canvas:** nothing is rewritten. `ComponentRenderer` gets `breakpointId = D(P)` and the definition's breakpoints for
  the inner tree, and the frame's id only for identity attributes. `getResolvedProps` needs no change. The placement's
  own maps hold page ids, which the definition's breakpoint list would not recognise, so they are resolved first
  against the page's breakpoints for frame P, to plain values, and then laid over the root's result.
- **Two implementations of one mapping** are kept on purpose, published rewriting and canvas resolving live, both
  calling `D(P)`. One parity fixture on a page with mismatched frames compares them.
- **Nested placements** map straight to the page, not through the outer definition.
- **A placement's own `style` and `inputs`** are keyed on the breakpoints of whatever holds it. On a page that is the
  page's; inside a definition, that definition's, and they are mapped with it.
- **Create from selection** runs the same function the other way, from the page's ids to the new definition's.

**One real loss, stated.** A definition with a Tablet value, on a page with only Desktop and Mobile, has nowhere to
show it. That follows from mapping to the page's frames. The placement's panel names such a value.

`apply.ts` is the precedent ([code] `breakpointKeyMap`, which rekeys generated maps). A site-wide breakpoint list would
remove this function, but it would change every saved page, so it is not done here.

## Expansion

`expandPlacements(root, definitions, pageBreakpoints, options)` in `src/lib/components/expand.ts`. Pure: no React, no
MST, no `server-only`. `snapshotToComponentNode(snapshot, definitions)` calls it after `componentSnapshotToNode`.
**`definitions` is a required argument,** because a default of `{}` would let any caller not updated compile, pass its
tests on pages without placements, and delete every placement in production.

For each `#component` node, depth first:

1. **Find the definition.** Unknown: the node becomes a `#missing` node, with one warning per page and a note in
   `checkBeforePublish`. The page still serves. It stays a node so a Collection keeps its template, and a renderer
   draws nothing for it; otherwise `hydrateCollection` would print "add a child to use as the row template" to visitors.
   The canvas shows a dashed "Missing component" box, as it does for "Unknown component".
2. **Refuse a cycle.** The stack of definition ids on the way down must not hold this id, and the depth must be within
   8. Refused: `#missing`, with the warning. The model refuses first, but stored JSON can say anything.
3. **Charge the budget,** nodes and bytes.
4. **Clone the definition's tree,** with its maps mapped to the page's breakpoints.
5. **Identity.** Each clone's `id` becomes `<placement id>__<definition node id>`, and nested placements extend the
   path. A path over 120 characters is replaced by a stable hash of itself, because `formId` is capped at 200 in
   `submit.ts`, and six uuid segments are already 226. `classKey` is the definition node's id. The root's id is the
   placement's own.
6. **Merge the placement** onto the root: style, effects and behaviour, as above.
7. **Mark the root:** `data-fc-c="<definition id>"` when the definition has a pointer state, and record
   `props.instance = { inputs, bindings, state, inputDefinitions }` for hydration. `instance` is denied as a DOM prop
   and survives MST, which the preview needs.
8. **Compile the state rules,** see "Component states".
9. **Suffix colliding `id` attributes,** see below.

Everywhere, placement or not, stored `data-fc-*` and `data-fcs-*` attributes are stripped, because the selectors and the
runtime honour them. The panel already refuses `data-fc-` ([code] `customEditor.ts`).

`hydrateNode` then sees `props.instance`, resolves and parses its values in the current scope, pushes an `InputFrame`
for the subtree, writes the root state's `initial`, and removes `instance`. Nothing else in the hydrator changes, apart
from the two passes below.

**Islands.** `hydrateNode` returns interactive commerce nodes verbatim and `renderComponentNode` applies no bindings
inside them, so keeping the frame in `commerceFramesOf` alone would change nothing. Before leaving an island verbatim, a
pass walks its subtree, bakes input bindings only, applies `visible`, and hydrates nested placements, leaving commerce
bindings for the client. So an add-to-cart labelled `{{input.cta}}`, placed twice, shows two labels.

**Literal mode, for raw readers.** Expansion leaves `{{input.x}}` unresolved, and raw readers read literal props, so
"expand first" would not reach a value passed to a placement. `expandPlacements(..., { literalInputs: true })` writes
literal input values and defaults into their bound slots. A value bound to data stays unknown, and a reader treats it
as it treats any binding today.

**Two ids, and why.** `applyResponsiveStyles` issues one class per stem and signature, so a template cloned per row
shares a class ([code] `classFor`). With prefixed ids alone, twelve cards would be twelve blocks of CSS. With shared
ids alone, two placements would be one form, and sibling placements would collide as React keys (`renderNodeChildren`
keys on `child.id`). So `classStem(node.classKey ?? node.id)`, and rule classes likewise. This shares CSS only where a
class is issued, which means a node with a responsive map or an authored rule. A node with only plain styles stays
inline once per placement, as a collection row does today. A placement with different values gets a numbered class
from the existing signature check, unchanged. `hydrateNode` keeps both by spreading the node, which a test pins.

`__` is the separator because the canvas's rule sheet skips ids outside `[A-Za-z0-9_-]`, as the selector contract
states, and because uuids never hold it.

**HTML `id` attributes, and what points at them.** A definition with `id="pricing"`, placed twice, or colliding with a
page node, emits duplicate ids. Expansion keeps a set of the `id` values seen in walk order, page nodes included. On a
collision it adds a stable suffix from the placement's id (`pricing-a1b2c3`) and rewrites the references inside that
expansion (`for`, `aria-controls`, `aria-labelledby`, `aria-describedby`, `aria-owns`, `aria-activedescendant`,
`popovertarget`, `commandfor`, and an `href` starting `#`). The suffix does not depend on position, so removing a
placement renumbers nothing. A first use keeps its `id`, so an anchor keeps working. An `id` bound to an input is the
author's and is left alone. A rule naming `#panel` is not rewritten, so the panel warns on a `#` selector inside a
definition and suggests an attribute.

**Cost.** Clone cost is low: 5,000 realistic nodes took 6 to 15 milliseconds [proven]. But it adds up on paths that walk
every page, so the raw expanded tree is memoised on `siteId`, `projectUpdatedAt` and `pageId`, in a bounded map. And
`locateForm` resolves from a precomputed list of a site's form ids: today it walks all pages before the rate limit key
is computed, so an anonymous POST with a random `formId` would expand them all.

### Every reader that has to learn it

Walkers split in two: those that run after expansion need nothing, and those reading a raw snapshot must expand first,
with `literalInputs`.

| Reader | Change |
|---|---|
| `hydrateBindings`, `applyImageLoading`, `applyEffects`, `applyResponsiveStyles`, `collectPageFonts` on the published path, `hoistStickyCta`, `applyBehaviour` | Run after expansion. `classKey` above, `props.instance` in `hydrateNode` |
| `applyBehaviour` (behaviour B2) | Keys `data-fc-n` and its program table on `classKey ?? id`, so references inside a definition hold and placements share one entry. A placement root is always a scope, so a trigger finds its own placement's target |
| `renderComponentNode`, `createComponentElement` | A leftover `#component` or `#missing` type renders nothing |
| `(site)/[...slug]/page.tsx`, `renderSitePage.tsx`, `(site)/not-found.tsx` | Pass `site.components` to `snapshotToComponentNode` |
| `src/server/sites/sitemap.ts` | Passes `site.components`: a product detail inside a component would otherwise take the page's handles out of the sitemap |
| `locateForm` (`src/server/forms/submit.ts`) | Passes `site.components`, through the form id list. A form in a definition is found by its expanded id, and `FormIsland` already uses `node.id`, so each placement has its own draft and its own submissions |
| Create component, Detach, Delete, on a selection holding a form | The form's id changes, so past submissions stay under the old id. The panel says this first |
| `treeNeedsCommerceRepo` | Runs on the expanded tree. Passes through |
| `dynamicPagePlan` (`siteFiles.ts`) | Reads a raw snapshot. `literalInputs` |
| `siteLookFromPages` (`notFoundDefault.ts`) | Reads a raw snapshot. `literalInputs`, or a colour passed as an input is missed |
| `factsFromTrees` (`legal/templates.ts`) | **Legally relevant.** It decides whether a privacy page mentions forms and Unsplash images. `literalInputs`: a Hero placement passing an Unsplash address otherwise reports none. A value bound to data stays unknown, as today |
| `checkBeforePublish` (`PublishButton.tsx`) | `literalInputs`, for `[placeholder]` text in an input. Also lists: a placement with no definition, a definition that failed to parse, a cycle, a budget overrun. It is a warning, never a gate, and a missing footer takes the Impressum link with it, so it must be shown |
| `treePlaceholders` (`LegalTemplateNotice.tsx`) | Counts from the raw tree. `literalInputs` |
| `addLegalLinksToFooters`, `findByType` | A footer inside a definition is not on the page tree. Search definitions too, and add the links once, to the definition |
| `setHomePage` and any writer retargeting `href` across pages | Sweep definitions too, including stored input values of `link` type. Slice 4 sweeps for other writers |
| `findStickyCta`, `insertRegistryComponent` | The sticky bar is one per page and page-level, so a definition refuses it |
| `PageFontFaces` on the canvas | Its roots include each definition placed on the page, or a family used only inside a component is not declared |
| `CanvasRuleStyles` (selector slice 6, not merged) | One rule block per definition node per host frame, see "On the canvas" |
| `serializeSubtree`, `editorReview`, `ai/review/ops.ts` | See "AI generation" |
| `roundtrip/jsx.ts` | See "React import and export" |
| `POST /api/projects` | Takes `components` through `parseComponents`, or "Save as a new project" turns every placement into a Missing component |
| `openProject.ts`, `SaveButton.tsx`, `PublishButton.tsx` | See persistence |
| `yjsDocShape.ts` | No change. Multiplayer has not shipped; as with `rules`, the real shape is chosen when it lands |
| `_schema.ts` | No change. `.passthrough()` keeps the key |
| `projectToPersisted`, `persistedToProject`, `repository.saveProject`, `publicResolver` | Read and write `components`, see persistence |

## Persistence

`projectSnapshotSchema` keeps a new key, but `projectToPersisted` reads named fields, so it would be dropped silently
([code]). So:

- **`sites.components`**, `Json @default("{}")`, in the migration `<date>_site_components`. It is one transaction with
  the pages in `saveProject`, so a definition and the pages placing it cannot be saved apart. `publicResolver` adds it
  to its `select`, and `PublishedSite.components` carries it through the cross-request cache as pages are carried.
- **An absent key leaves the column alone.** Only a present key writes. A tab loaded before this deploy sends no
  `components`, and defaulting that to `{}`, as `snap.pages ?? {}` invites, would empty the column on one Save and take
  every placement off the live pages after the next cache miss. A test sends an old-shape body.
- **Conflicts see definitions.** `openProject.ts` compares only pages today, so tab B would keep old definitions, get no
  warning, and overwrite tab A's navbar edit on its next save. `components` joins the baseline and the comparison, and
  both `markServerVersion` callers (`SaveButton`, `PublishButton`).
- `parseComponents(raw)` in `definition.ts` normalises on read, as `normalizeSiteSettings` does, applying the id checks
  and `withDefaultViewports`, or `D(P)` has no frames to map from. A bad definition is skipped with a warning, and
  `checkBeforePublish` shows it.
- **Not inside `site_settings`.** That column is whitelisted field by field and read widely. Definitions are large and
  have a different life.
- **Not a table per definition.** A row per definition would allow partial loads, but every published render needs
  all of them that the page uses, and the editor loads the whole project. Saves already write everything.

This is an additive column on the `public` schema. It rewrites no row, and `boot.sh` runs `prisma migrate deploy` before
the server starts, so the `select` never meets a missing column. It still needs Marlin's one-line yes when it deploys,
and it carries the `prisma` and `migrations` collision tags.

### Publishing and the immutable published copy

Today save and publish write the same rows, so after a cache miss visitors see the last save (`ROADMAP.md`, "An
immutable published copy of each page", not built). `unstable_cache` here has no expiry, but a deploy starts a fresh
container, so a miss is routine. With components, one half-finished navbar, saved and not published, reaches every page
of a site at the next deploy.

**Decided by the operator: slices 1 to 7 proceed, because no person can create a placement yet. Slice 8, the first
Create component button, waits for the published revision.** It is a dependency of slice 8 in the table below.

The contract for that work: a published revision holds **`components` beside `pages`**, frozen together. Freezing only
one would mix versions. Expansion runs at read time against the revision's own definitions, with one code path for
drafts and published pages. Storing flattened pages instead was refused: it would duplicate each definition per page,
and `locateForm` would need a second path.

Publishing itself changes nothing here: `POST /api/projects/publish` sends the whole project, and `revalidateSiteCache`
already covers the site.

## Component states

### The two kinds

```ts
interface StateDefinition {
  id: string;     // `s1`, or `hover`, `pressed`, `focused`. Matches [A-Za-z0-9_-]+, never starts `fc-` or `fc_`
  name: string;   // "Open"
  kind: 'hover' | 'pressed' | 'focused' | 'custom';
  implies?: string[]; // pressed implies hover, as the named states do
  x?: number; y?: number; // the frame's place on the definition's canvas, if moved
}

// On a node: an ordinary SelectorRule with one more field, refused by parseRule until compiled.
interface StateRule extends SelectorRule {
  id: `state-${string}`;
  componentState: string;   // the state id
  selector: '&';            // always; compilation replaces it
}
```

One frame's edit is one rule on each node it touches, written by `setRuleStyle`, with `writeCascade`, one undo step,
emptied rules removed. A state with no differences stores nothing but its definition. The node's panel dot and
`useStyleTarget` work unchanged, with `activeRule` pointing at the state rule.

**Fail closed.** `parseRule` accepts `selector: '&'` today, so an uncompiled state rule would read as a rule that always
applies [proven]: a deleted state, a node copied to a page, or any emitter without the compile step would make a hover
difference the permanent look. So `parseRule` refuses a rule holding `componentState`, with the usual warning, and
compilation replaces it with an ordinary rule without that field. Copying a node out of a definition keeps the stored
rule, which does nothing and shows as refused, with the reason.

**Only style.** CSS can show this without a script and without a second render path. An icon swap is two layers,
one hidden in each state. Text varying by state is refused in the panel (those sections dim, as they do for Hover).
`aria-*` follows a custom state through a behaviour `bind`, see below.

### Compiled at expansion

`X` is `[data-fc-c="<definition id>"]` on the placement root, and `S` is the definition's `cs-<first 8 of its id>`.

| Kind | Stored rule becomes | `at` | Runtime |
|---|---|---|---|
| hover | `&:where(X:hover, X:hover *)` | `HOVER_GATE`, the existing `@media (hover:hover) and (pointer:fine)` | None |
| pressed | `&:where(X:active, X:active *)` | none | None |
| focused | `&:where(X:is(:focus-visible, :has(:focus-visible)), X:is(:focus-visible, :has(:focus-visible)) *)` | none | None |
| custom | `{ selector: '&', when: { state: S, eq: '<state id>' } }` | none | A trigger changes it |

All three selectors pass the real parser, at 125, 127 and 195 characters with a uuid [proven]. `when` is the behaviour
contract's, emitted as
`:where(html[data-fc-b]) .fc_r-a.fc_r-a:where([data-fcs-S="open"] *, [data-fcs-S="open"])`, through `rules.ts`.

**Custom states are one `choice` value,** because a placement has one current state, as in Framer: on the definition's
root, `behaviour.state: [{ id: S, name: 'State', type: 'choice', initial: 'primary', options: ['primary', 's1', ...] }]`.
The model keeps `options` in step with `states`. `S` is unique per definition, because a state id must be unique on its
path to the root, and nested definitions are different definitions. A row or a placement is its own scope, so a hundred
cards each hold their own state and share one rule block. `data-fc-c` appears only with a pointer state.

**A placement picks its initial state** in the panel, stored as `props.state`, or from data with a `state` binding, such
as `{{row.tier}}`, matched against state ids. `hydrateNode` writes it into `initial`, which `applyBehaviour` then
reads: behaviour refuses a binding inside `initial`, and this is a literal by the time it arrives. Anything unknown is
primary.

**How it composes** [proven in Chromium and WebKit for this revision, on real pointer input]:

- **A compiled state adds no specificity,** matching `when`, which is `:where` by design. All four kinds stay at (0,2,0).
- **Between states:** a later state in `states` wins a tie, whichever kind. Open listed after Hover stays Open under the
  pointer. Without this, a selector form would always beat a `when` form, and the order in `states` would mean nothing.
- **With Normal:** rules come after Normal, so a state beats it on a tie.
- **With element rules:** an element's own `&:hover` at (0,3,0) beats a component state on the same property, as does
  anything more specific. The rule is one line, which is what imports need: **an element rule beats a component state.**
- **Order.** `orderRules` puts state rules after named states and authored rules, in `states` order. Today it mixes
  them in [proven], so slice 11 changes it.
- **With breakpoints.** A state rule's `style` holds the same `{ base, <breakpoint>: value }` maps, mapped with the rest,
  so Open on Tablet needs nothing new. The selector contract's value order applies: state first, then breakpoint, then
  implied states, then Normal.
- **With a placement's style.** A placement's size lands on the root's Normal, so a state with `width` beats it. Stated.
- **Moving Normal.** Decision 5 of the selector contract applies: a node with an authored rule moves its styles into the
  sheet, and a compiled state rule is one.
- **Nesting.** `X` and `S` hold the definition, so an outer component's state never reaches an inner one of another
  definition. A definition cannot contain itself. **An inner placement's state does not vary with the outer's.** Framer
  offers this; v1 here does not. The outer state can show or hide it.
  **A definition never sits inside a placement of itself in v1,** so `X` and `S` never repeat on one path: the only
  ways to do it are a cycle, which is refused, and `slot`, which waits for step 7. That is why a descendant form such as
  `[data-fcs-S="open"] *` cannot reach a placement of the same definition. When `slot` arrives, the nearest-scope guard
  of review finding F8 is required, and its fixture is two nested placements of one definition in different states,
  asserting that the inner descendants follow the inner state.

### Without JavaScript

The server writes `data-fcs-S` for the initial state, so the first paint is correct with no flash. Without the gate,
`when` rules are dead, so a page shows primary. That is the contract's promise, but it is a dead end when primary hides
content: a closed mobile menu.

So a definition may name `noScriptState`. Its compiled rules are written twice, the second as
`&:where(html:not([data-fc-b]) *)`, the form the behaviour contract uses for its own no-JavaScript rules. That covers
scripts off and also a script that failed, since the gate falls after 3 seconds, which a `<noscript>` block could not.
The panel asks for it when a click-driven state changes `display` or `visibility`.

**ARIA with and without the script.** Every `aria-*` a `bind` writes is a function of the state `S` alone, so each
transition keeps it in step, Escape included: Escape's `set` to primary makes the same `bind` write
`aria-expanded="false"`, and a trigger needs no `aria` field of its own. The server writes the value for the initial
state. A `<noscript>` block cannot change an attribute, so the no-JavaScript form changes what is exposed instead: the
`noScriptState` rules also hide any node whose `bind` writes `aria-*` from `S` and whose only triggers need the script,
written as `&:where(html:not([data-fc-b]) *)` with `display: none`. The links show, the button that would do nothing is
gone, and no stale `aria-expanded="false"` is exposed beside open links. The popover lists this under the node, and the
navbar fixture asserts it with the gate down.

### On the canvas

Inside the definition, under the breakpoint frames, each state is a tile, as in Framer [tested]: a row of frames per
state at the largest breakpoint, and the other breakpoints on demand from the frame's menu. A tile stores nothing but
`x` and `y`, and only when moved. It is drawn by the existing `ViewportFrame` over the same tree, with its frame id
extended, such as `<bp>__s1`, which stays inside the characters the canvas sheet accepts.

Selecting a node in a tile sets `activeRule` to that state's rule, so every panel row writes the difference, and a
marked row shows it ("set in Open"), with a reset. Selecting a node in the primary frame edits Normal. Resize and
spacing handles write Normal in the selector contract, so inside a tile they route to `useStyleTarget`. That is a
named change to `QuickToolbar` and `quickbar/actions.ts`: a tile has no other way to change a size.

**How a state shows.** Behaviour's Select mode writes `data-fcs-*` on scope nodes from `previewState` or `initial`, and
keeps the `when` selector with `!important`, without the gate, as every canvas rule. A custom tile writes its own
state's value, and a placement its initial one. A pointer-state tile is one more frame with that state active, using
the `:is(*, :hover)` rewrite the selector contract defines for previews; the rewrite handles `:where` like `:is`.
Decision 8 of that contract stands: a real pointer over a placement or a tile does nothing.

**Ids.** Inner nodes keep `<frame>-<definition node id>` as identity, the same across placements in a frame. That is
what the sheet wants: one rule block per definition node per host frame, whatever the placement count, with the
placement root's `data-fcs-S` deciding which placements it matches. It is also what `startBehaviour` needs in Interact,
since it resolves targets on `data-inner-component-id` within a scope.

A placement on a page shows its initial state, chosen by a state selector in the right panel. Trying one without
storing it uses behaviour's `previewState`.

## Interactions

### Interactions are triggers

There is no `Interaction` type. A drawn connection writes an ordinary trigger into `props.behaviour.on` on the layer that
fires it, which is what the behaviour contract says of the popover. So there is one event format, and a trigger written
in its Interactions section and one drawn here are the same data.

| Popover | Trigger |
|---|---|
| On: Click | `on: 'click'` |
| On: Click start | `on: 'pointerdown'` |
| On: Appear | `on: 'view-enter'` |
| On: Mouse enter | `on: 'mouseenter'`, and a second trigger on `focusin`, so it cannot be mouse-only |
| On: Mouse leave | `on: 'mouseleave'`, and a second trigger on `focusout` |
| On: Escape (added) | `on: 'keydown', keys: ['Escape']` |
| From this tile | `if: { state: S, eq: '<from>' }` |
| Transition: Once, target T | `do: [{ set: S, value: 'T' }]` |
| Transition: Cycle | `do: [{ step: S, wrap: true }]`, which cycles a `choice` from its current option |
| Delay | The action wrapped in `{ delay: <ms>, do: [...] }`, at most 10 seconds |

The first five triggers and Delay, Once or Cycle, and the target are Framer's popover [tested]. The behaviour contract
names `set` and `step` but shows only `toggle` in JSON, so the exact keys above follow what its slice B1 fixes.

Nothing of this needs its own runtime: `src/lib/behaviour/runtime.ts`, `BehaviourIsland`, the 8 kilobyte budget, the gate,
target resolution by scope and "a page with no trigger gets no bytes of it" are all that contract's. A page with only
Hover, Pressed and Focused ships nothing.

**The Trigger field.** Framer gives a placed instance an automatic Trigger field. Ours is the placement's
`behaviour.on`: the panel's Interactions section, shown for a placement, adds entries that run on the root, such as
`navigate` on one card. Together with `event` inputs, a card can have its own click action per use.

### Keyboard

The primitives plan requires every state to be reachable by keyboard.

- **Hover** is pointer-only, as the selector contract gates it. So a definition with a hover state and no focused state
  gets a panel warning, with one click to copy Hover's differences to a new Focused state.
- **`click`** needs a trigger that takes focus. On a node that is not `button`, `a[href]`, `summary` or a form control,
  the popover says so and offers "Make it a button", using `setTag`. Publishing is not refused: the warning sits with
  `checkBeforePublish`. Adding `role` and `tabindex` plus key handlers quietly would hide the problem.
- **Semantics** come from a `bind` on the trigger: `{ attr: 'aria-expanded', from: { eq: [{ get: S }, 's1'] } }`. The
  popover's ARIA row writes it. The server writes the initial value. Full patterns, such as tabs with arrow keys, are
  layer 3's presets.

### Connecting on the canvas

In the definition, a selected tile shows a handle. Dragging it to another tile draws a connector and opens the popover
beside it. Connectors are an SVG layer in canvas space, derived from the triggers of the definition's nodes: a connector
is a trigger whose `do` is one `set` or `step` on `S`, possibly inside one `delay`. Anything else appears only in the
Interactions section. The drag uses a new `DragSource` kind `connectState`, resolved against tiles only. Dropping nowhere
cancels. Dropping on the tile it started from is refused.

The popover has **On, Delay, Transition, Target**, as Framer's, plus **Trigger**, defaulting to the whole component, with
a picker for a layer, and **ARIA**. One save is one undo step. Selecting a connector opens it; Delete removes it. The same
triggers are plain rows in the Interactions section, which is how a keyboard or a phone edits them.

**Trying it.** Preview runs interactions, and behaviour's Interact tool runs them on the canvas. That tool lifts
`lockedByAncestor` for inner nodes, so a click inside a placement reaches its trigger.

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

**Preview.** `data-fcs-*`, `data-fc-c` and the compiled rules are placed by expansion, so preview must run it too.
`HeadlessComponentRenderer`, at a placement, calls `expandPlacements` on that placement's snapshot, memoised on it and the
definition, creates a detached MST tree from the result, and renders that with the input frame pushed. So preview proves
the published compile path and no third way of drawing a component appears. The sheet takes `surface: 'preview'`, and
`applyBehaviour` plus `startBehaviour` run on the frame as behaviour B9 specifies.

**Layers.** On a page, a placement is one row with a component icon and its definition's name, or its own label. It
does not expand. It has Duplicate, Delete, Detach and Edit component. Inside a definition, the panel shows that tree
normally. Nested placements read the same way.

**The Components panel.** A new section at the top of `ComponentsPanel`, "This site", lists definitions with a small
placement count. Each is a drag source of a new `DragSource` kind `place`, and a tap in the phone layout, with Rename,
Edit, Duplicate and Delete in its menu. With none, it shows one line on how to make one. Delete names the placement
count, and says they become plain copies.

**The right panel.** A selected placement shows a new `ComponentSection`: the generated form, one row per input with
the type's existing control, a state selector, Edit component, Detach and Reset all. Below it are Size, Position, Effects
and Interactions, and `sectionConfig` hides everything else. Each row has the binding control, and a reset where a value
is set. The binding control is what puts a placement in a collection on `{{row.title}}`.

**Making an input.** In a definition, each row with a binding control gets "Make input": it creates the input with the
right type, copies the current value as the default, and writes the binding, in one action. "Inputs" in the root's
panel lists, renames, reorders, retypes and removes them.

**Undo across placements.** `HistoryStore` records patches under `projectStore`, and `ProjectModel` is inside that
([code] `RootStore.ts`). So:

| Action | History entries | What is restored |
|---|---|---|
| An edit inside a definition | One, as on any page | All placements follow, since they read it live |
| `createComponentFromSelection` | One `ProjectModel` action | The original nodes |
| `removeInput`, `changeInputType` | One, patching every page and definition | The input, its bindings and every value |
| `removeState` | One, patching every node holding its rules | The state, its rules, triggers and placements' choices |
| `deleteComponent` | One, patching every page and definition | The definition and every placement |
| `detachPlacement` | One | The placement |

These are actions on `ProjectModel`, not on `PageModel`, because they cross pages. A page action cannot record patches
on another page's subtree as one user step, because each would be its own top-level call.

## Nesting and cycles

A definition may place another. `wouldCycle(definitions, targetId, placedId)` walks placements from `placedId` through
each definition's trees. A placement is refused, with a reason naming the path ("Card contains Grid, which contains
Card"), in `placeComponent`, in `moveTreeComponent` when the target is inside a definition, in create from selection, and
in the panel's list, where the entry is greyed. Expansion checks again with a stack and the depth cap, because the model's
check protects honest paths and the render step protects against stored data.

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
- **States:** primary (Closed), `s1` Open, held in `S`.
- **Open:** the panel node's state rule holds `{ display: { base: 'none', <mobile>: 'flex' } }`.
- **Triggers on the button:**

  ```json
  { "on": [
      { "id": "t1", "on": "click", "do": [{ "step": "cs-2f6c1a9e", "wrap": true }] },
      { "id": "t2", "on": "keydown", "keys": ["Escape"],
        "if": { "state": "cs-2f6c1a9e", "eq": "s1" },
        "do": [{ "set": "cs-2f6c1a9e", "value": "primary" }] } ],
    "bind": [{ "attr": "aria-expanded",
               "from": { "eq": [{ "get": "cs-2f6c1a9e" }, "s1"] } }] }
  ```

- **No JavaScript:** `noScriptState: 's1'`, so the links stay reachable, also when the script fails. The menu button is
  hidden then, so no `aria-expanded` is exposed that the open links contradict.
- **On ten pages:** ten placements of a few bytes each, and one edit reaches all ten.

**Not covered:** marking the current page's link (`aria-current`) needs a renderer pass that knows the path. That
belongs to the navbar slice of the primitive stream, not to this format.

### A hero

- **Definition:** a `section` with an `h1`, a `p`, a Link and a background.
- **Inputs:** `title` (text, on `h1` children and on the image's alt), `subtitle` (richtext), `cta` (text), `ctaHref`
  (link), `background` (image, on `style.backgroundImage`), and `showSubtitle` (toggle on `visible`).
- **States:** hover on the Link only, as an ordinary element rule. A hero needs no component state, and most sections
  will not.
- **Per placement:** `style: { paddingTop: {...} }` where one page wants it taller.
- **Worth noting:** `applyImageLoading` runs after expansion, so a hero image in a component keeps its priority
  loading, which is what `HeroPreload` needs, if it is bound to `src`. A background image stays as it is today. A
  `factsFromTrees` test puts an Unsplash address in this input.

### A card

The example above, in a collection: placing it in a Collection's row template with `input.title: {{row.title}}` gives
one card per row. `hydrateCollection` clones the template, `hydrateNode` pushes the row frame, then the input frame on
top. A hundred rows share one CSS block for each node that has a class, through `classKey`, and each has its own `id`.
The hover state is `translate` in CSS. There is no script on the page.

## AI generation

**Reading.** `serializeSubtree` writes a placement as `{ type: '#component', name, inputs }`, without its inner tree,
which is also far fewer tokens. `promptSections/siteContext.ts` lists definitions: name, description, inputs with
types, states. Names and descriptions are written by people and enter a prompt, so they sit in the prompt's untrusted
data section. A new section teaches placing them. So "add a pricing card" uses the site's card.

**Writing a placement.** `validateGeneration` accepts `#component` nodes: the definition must exist, each input through
`parseInputValue`, cycles refused, unknown inputs dropped and reported. `applyGeneratedNodes` needs no change, since
it creates nodes, and `revertGeneration` works by id.

**Review.** `ai/review/ops.ts`: `update_style` on a placement goes to its own style. A review may not edit a definition,
because a change there has a reach the review cannot see. It may propose it as a message.

**Writing a definition is a later slice,** split out on the operator's decision, because placing is the valuable half.
The generator may then return `definitions` beside `nodes`, for structure repeated at least twice, capped at 6 per
generation, each passing the full validator. `toEditorSnapshot` rekeys its maps with `breakpointKeyMap` onto the
definition's own frames. `addGeneratedComponents` adds definitions and nodes in one action, and the `GenerationUndoRecord`
gains the definition ids, or `revertGeneration` would leave them behind. A definition placed once is refused.

**Nothing is converted automatically.** A generator does not turn a site's repeated sections into components unasked.

## React import and export

Step 7 builds this. The contract says what it targets.

- **Export.** A definition becomes a function component whose props are its inputs, a placement becomes
  `<Card title="..." />`. In the round-trip's normalised form, a placement has `component`, `inputs`, `state`, `style`,
  `behaviour` and `bindings` as named props, the same way bindings are handled. State rules stay `rules`.
- **Import.** A file's default component becomes a definition, its destructured props become inputs (string to `text`,
  boolean to `toggle`, union of literals to `choice`), and JSX reading a prop becomes a binding. `{cond && <X/>}` on a
  boolean prop becomes `visible`. `.map` over a prop becomes `list`. A `ReactNode` prop needs `slot`, which arrives with
  this step.
- **`cva` variants** (the shadcn pattern) map to `choice` inputs on `data-*` attributes plus rules, not to states,
  because a variant chosen by a prop is not state.
- **`useState` toggling a class** maps to a custom state plus a Cycle trigger, when it is that simple, and otherwise to
  scoped state, as the behaviour contract's import table says.
- **Anything else** is reported line by line under the plan's rule. A half-understood component fails loudly.

## Migration

None of existing data. No stored page changes, no snapshot is rewritten, and `expandPlacements` on a tree without a
`#component` node and without a stored renderer attribute returns it unchanged, by reference, so the output is byte for
byte what it was. A test pins that against the `responsive-layout` fixture. Existing navbars stay ordinary nodes until
someone chooses Create component, and that is a person's choice for each.

The only schema change is the additive `sites.components` column.

## Score changes

Nothing in the score measures reuse today, so the matrix cannot show this work. There is no row kind for it, and no gap
id. **This contract closes no existing row and no existing WAI-ARIA pattern:** those need keyboard behaviour, which is
layer 3.

So slice 1 adds:

- **A row kind `component`**, from a new `test/score/data/component-capabilities.json`, the one list of what the
  format promises. 30 rows: the 17 input types and these 13 capabilities: `definition`, `placement`,
  `placement-style`, `nested`, `cycle-refused`, `collection-template`, `state-hover`, `state-pressed`, `state-focused`,
  `state-custom`, `interaction-click`, `interaction-appear`, `placement-trigger`.
- **A gap id `reusable-components`.** All 30 rows start failing under it.
- **Cells mean:** format survives the snapshot round trip with a reader; published emits it through
  `renderPublishedPage`; canvas renders it through the real `ComponentRenderer`; panel changes it through the real
  section; AI keeps it through `validateGeneration`.

`baseline.json` holds counts, so failing rows lower no floor. Percentages dip by up to about 1.4 points (Format from
86.1 to 84.7 percent at the first score), because 1,832 rows become 1,862.

**Corpus,** four fixtures. Each compares a page built from a definition with plain HTML.

| Fixture | Proves |
|---|---|
| `component-cards` | Three placements with different inputs equal three handwritten cards. Also that each node with a class has one block, not one per placement |
| `component-navbar` | One definition on two pages, at each breakpoint, closed and open, by click and by Escape, with the runtime and without it |
| `component-collection` | A card as a row template. Needs a CMS fake in `test/score/lib/published.ts`, which slice 2 adds |
| `component-states` | Hover, Pressed, Focused and one custom state, at each breakpoint, compared in real Chromium, with scripts blocked for the first three |

One parity check on a page with frames of different widths compares canvas and published, in slice 6. Per the fleet
plan, held-out component fixtures sit where workers cannot write. The operator places these four, so workers do not
write their own pass. Round-trip cases are in slice 16.

## Slices

Each is one file-scoped pull request, green alone, raising `baseline.json` where a number rises. The fleet plan
estimated five; breakpoints, the raw-snapshot readers, persistence and the budget were not in it. Cells are maximums,
and a pull request states the real figure. "B" numbers are the behaviour contract's slices, "selector" the selector
contract's.

| # | Slice | Files | Tag | Depends on | Closes |
|---|---|---|---|---|---|
| 1 | `components-format` | `src/lib/components/{definition,inputs,placement,breakpoints}.ts` and tests, `test/score/lib/types.ts`, `component-capabilities.json`, `universe.ts`, `report.ts` | | none | Nothing yet: adds the 30 rows and the gap. Tests: every input type's refusals, `D(P)` with mismatched and empty frames, id checks, structure rules |
| 2 | `components-expand` | `src/lib/components/expand.ts` (budget, literal mode, id suffixes, attribute strip), `snapshotToComponentNode.ts` and its callers (required argument), `hydrateBindings.ts` (instance, input parse, bound style check, `visible`, island pass), `scope.ts`, `applyBindings.ts`, `applyResponsiveStyles.ts`, `renderComponentNode.tsx`, `createComponentElement.tsx`, `test/score/lib/published.ts` | `renderer` | 1, the operator's `blockedNodes.ts` fix | Format and published for `definition`, `placement`, `placement-style`, `nested`, `cycle-refused`, `collection-template` and the 7 first types (13 rows, 26 cells). Identity on the unchanged fixture. Tests: one huge node placed many times, a large card in a 100 row Collection, a labelled add-to-cart placed twice. Fixture `component-cards` |
| 3 | `components-persistence` | `prisma/schema.prisma`, the migration, `snapshot.ts`, `repository.ts`, `publicResolver.ts`, `ProjectModel.ts`, `page.tsx`, `not-found.tsx`, `renderSitePage.tsx`, `sitemap.ts`, `submit.ts`, `api/projects/route.ts`, `openProject.ts`, `SaveButton.tsx`, `PublishButton.tsx` | `prisma`, `migrations` | 2 | No rows. A definition survives save, load, publish and render, and a form placed twice takes two submissions, in `test:integration`. An old-shape body leaves the column alone. A conflict names a definition change. **The migration needs Marlin's one-line yes when it deploys** |
| 4 | `components-site-walkers` | `siteFiles.ts`, `notFoundDefault.ts`, `legal/templates.ts`, `LegalTemplateNotice.tsx`, `PublishButton.tsx`, `ProjectModel.ts` (footers, `setHomePage`), the expansion memo, the form id list | | 3 | No rows. For each reader, a test with the fact in an input value and one inside a definition. `checkBeforePublish` lists every failure of F12 |
| 5 | `components-model` | `ProjectModel.ts`, `ComponentModel.ts`, `PageModel.ts`, `wouldCycle` in `definition.ts` | | 4 | No rows. Every action in the undo table as one history entry, Detach included; all four stateful paths at model level |
| 6 | `components-canvas` | `ComponentRenderer.tsx`, `HeadlessComponentRenderer.tsx`, `ResponsivePageRenderer.tsx`, `createComponentElement.tsx`, `resolveDropTarget.ts`, `PageFontFaces` | `renderer` | 5 | Canvas for the 13 rows. Preview through expansion, `visible` in preview. Browser proof: a placement selects as one, a drop cannot land inside it, an `a` root refused inside a Link, the parity check on mismatched frames |
| 7 | `components-editing-mode` | `EditorUIStore.ts`, `Canvas.tsx`, a breadcrumb bar, `LayersPanel.tsx`, `PagesPanel.tsx` | | 6 | No rows. Browser proof of enter, edit, leave, undo from the page, and a definition deleted while open |
| 8 | `components-panel` | `ComponentsPanel.tsx`, `drag/types.ts`, `DragManager.ts`, `ComponentSection.tsx`, `sectionConfig.ts`, `BindingControl.tsx`, `BindingPicker.tsx`, `scopeIntrospection.ts`, `matrix.panel.jsdom.score.tsx` | | 7, **the immutable published copy** | Panel for the 13 rows (the first Create component button). A browser proof from Create component to a published page |
| 9 | `components-inputs-styled` | `inputs.ts`, `textNode.ts` (`renderRuns`), per-type controls, `ComponentSection.tsx`, the score's samples | | 8 | `richtext`, `file`, `date`, `border`, `shadow`, `cursor`, `transition` in four columns (28 cells) |
| 10 | `components-list` | `hydrateBindings.ts`, `ComponentRenderer.tsx`, `ComponentSection.tsx` | `renderer` | 8 | `list` and `gallery` in four columns (8 cells). Bound to data, item ids distinct, items on the budget |
| 11 | `component-states-pointer` | `expand.ts`, `parseRule` in `rules.ts`, `orderRules` in `states.ts`, `ComponentModel.ts`, `definition.ts`, `corpus/fixtures.ts` | `renderer` | 2, selector 3 | Format and published for the three pointer rows (6 cells). The fail-closed refusal. The first part of fixture `component-states`, scripts blocked |
| 12 | `component-states-custom` | `expand.ts`, `hydrateBindings.ts`, `definition.ts`, `ProjectModel.ts` (`removeState`), `corpus/fixtures.ts` | `renderer` | 5, 11, B2 | Format and published for `state-custom` (2 cells). `noScriptState`, the `classKey` line of `applyBehaviour`, a placement root as scope, a `state` binding |
| 13 | `component-states-canvas` | `ResponsivePageRenderer.tsx`, a `StateTile`, `rules/surfaces.ts`, `QuickToolbar`, `quickbar/actions.ts`, `RightSidebar`, `ComponentSection.tsx` | | 7, 12, selector 6 and 7, B9 | Canvas and panel for the four state rows (8 cells). Browser proof: editing Open on Tablet in a tile reaches a published page |
| 14 | `component-interactions` | `expand.ts` (merging `behaviour`), `inputs.ts` (`event`), `corpus/fixtures.ts` | `renderer` | 12, B3 | Format and published for `interaction-click`, `interaction-appear`, `placement-trigger`, `event` (8 cells). Fixture `component-navbar`, including no JavaScript, a failed script and keyboard |
| 15 | `component-connectors` | A connector layer, `drag/types.ts`, the popover, `ComponentSection.tsx` | | 13, 14, B11 | Canvas and panel for those four rows (8 cells) |
| 16 | `components-ai-place` | `validate.ts`, `serializers/subtree.ts`, `promptSections`, `ai/review/ops.ts`, goldens, `roundtrip/jsx.ts`, `roundtrip.score.ts` | | 9, 10, 12, 14 | AI for all 30 rows (30 cells), labelled `accepted, not taught` where the prompt does not teach them. Round-trip cases: placement, nested, state, input binding |
| 17 | `components-ai-write` | `schema.ts`, `validate.ts`, `apply.ts`, `PageModel.ts`, `ProjectModel.ts`, `promptSections`, goldens | | 16 | No rows. A generated definition, reverted whole |

Slices 2, 6, 10, 11, 12 and 14 share the `renderer` tag, and slices 3, 4, 5 and 12 all edit `ProjectModel.ts` in dependency
order, so the operator runs them in order. Slice 3 is what turns parallel work into a shared base. **Slices 1 to 7 proceed
now; 8 and everything needing it wait for the published copy.** Slices 11 and 12 can land before that, since they have no
button: nobody can reach them.

**What the slices add up to:** every cell of the 30 rows, 150 of 150, and 4 of 4 fixtures, as ceilings.

**A matrix pass here proves less than it reads,** as the selector contract says of its own rows. The corpus is the test.

## What this does not cover

- **Overrides of inner nodes,** by decision 7.
- **`slot`,** moved to step 7, whose `ReactNode` props are its real customer. It is not in Framer's editor, and it is the
  only way a definition could hold itself. When it comes, the state selectors need the root and descendant forms of
  review finding F8: `&:is(X:hover)`, and `&:is(X:hover *):not(X:not(:hover) *)`, at 134 and 204 characters [proven], and
  its content resolves in the placement's outer scope. Round trip of shadcn components waits for it.
- **Theme tokens.** Colours and fonts as site variables are their own gap in the primitives plan. An input does not
  replace them.
- **Sharing definitions between sites.** A definition belongs to one site, and copying one needs its assets and fonts.
  Nothing copies nodes between projects today ([code] no node clipboard and no project duplicate), so a placement
  cannot reach another site. A future copy path must detach on the way out.
- **Marking the current page in a navbar,** see the example.
- **An inner placement's state following the outer's.**
- **Multiplayer.** Two tabs on one definition are last-write-wins with the conflict warning, as pages are.
- **Editing in context,** with the page dimmed around a component. Isolation comes first. In-context editing can be
  added on top.

## Decided here, say so if you disagree

The fleet plan gives contracts to a fresh review agent before fan-out, and the review of 2026-11-02 has happened. These do
not wait for Marlin.

1. A definition wraps a real `PageModel`, rather than a new tree owner.
2. A placement is a `#component` node, not a marked `div`.
3. Expansion happens before hydration, with input values resolved and parsed by a frame during hydration.
4. A unique `id` plus a shared `classKey`, rather than one of the two.
5. No inner overrides. Inputs, state, own layout and the Trigger field are the whole surface.
6. Removing an input or a state deletes what depends on it across the site in one undoable action, rather than keeping
   orphans.
7. Breakpoints are mapped by width, rather than moved to site level.
8. A state holds style differences only, and a stored state rule fails closed.
9. An element rule beats a component state, and among component states the later one wins, because a compiled state adds
   no specificity.
10. Deleting a definition detaches its placements, with states kept, rather than refusing or deleting placements.
11. `visible: false` removes the node from the markup.
12. A published revision will hold `components` beside `pages`, not flattened pages.
13. Escape is added to Framer's five triggers, and mouse enter and leave also fire on focus.
14. `click` on a non-interactive node warns rather than being fixed silently.
15. The 17 input types of Framer's editor, no more and no fewer.
16. Sticky bars are refused inside a definition.
17. Custom states are one `choice` value per definition, and interactions are behaviour triggers.

Decided by the operator on 2026-11-02: slice 8 waits for the immutable published copy; `slot` moves to step 7; `font`,
`radius`, `padding` and `gap` are dropped; AI writing definitions is a later slice; `blockedNodes.ts` destination gating
is the operator's own fix.

## Review findings not adopted

Everything in F1 to F20 is applied except the following, each checked rather than waved away.

1. **F8, compile a root and a descendant form. Not applied now.** Its only reachable case is a card in a card through a
   `slot`, and `slot` moved to step 7 on the operator's decision. Without it a definition cannot contain itself, since
   `wouldCycle` refuses it, and list items are siblings. The form is written down under "What this does not cover" for
   that step.
2. **F14, narrow decision 9 or double the class. Neither.** Pull request #222 fixes `when` at no added specificity, so a
   custom state sits at (0,2,0). Keeping pointer states at (0,4,0) would make Hover always beat Open, and the order in
   `states` would mean nothing. So pointer states use `:where` too, and decision 9 reversed: an element rule beats a
   component state. Run for this revision in Chromium and WebKit with real pointer input: all kinds tie and the later
   wins, an element's `&:hover` beats a state, and the parser accepts all three forms. This also removes the import
   problem F14 describes, because a stronger imported rule now has the same outcome as a plain one.
3. **F3 step 1, destination gating.** Not in this contract: the operator is fixing it in `blockedNodes.ts`. Slice 2 depends
   on it.
4. **F20, prefer a small inline script over a client island.** Not taken. There is one runtime and it is behaviour's: its
   decision 5 and `BehaviourIsland` settle this, and a second inline runtime is what question 1 existed to avoid. Clicks
   before the island starts are not replayed, by that contract's reasoning that a replay could double a native action.
   The other half of the finding, a script that fails, is met: `noScriptState` now compiles behind the gate, which falls
   after 3 seconds.
5. **F20, detach on cross-site paste. No action.** The path does not exist: `clipboard` appears only in `DomainsPanel.tsx`,
   and `duplicateProject`, `cloneProject` and `duplicateSite` appear nowhere in `src`. `POST /api/projects` from the demo
   carries `components` under F1. A future copy path must detach; that is written under "What this does not cover".
6. **F17, the delete dialog names what is lost. Reduced.** State rules and triggers are no longer lost, because they
   become stored `when` rules and remapped triggers, so only the form id warning remains.
7. **F15, preview runs `expandPlacements` on a snapshot of the current project. Adapted.** The preview renders live MST
   nodes through `HeadlessComponentRenderer`, with data from its polling provider, and `hydrateBindings` needs server
   repositories. So it expands per placement and renders a detached tree, which gives the same compile path.
8. **F19, state Trigger as part of the behaviour contract's scope. Done here instead,** and `event` with it, since `emit`
   and `custom:` make both cheap, and pull request #222 leaves them to this contract.
9. **F20, "lower the depth for forms". The alternative of F20, hashing long paths, was taken,** so depth stays 8.

## Open questions

1. **For slice B1:** the JSON keys of `set` and `step`, which the behaviour contract names but does not show. Interactions
   above follow it.
2. **For the behaviour contract, two additions its text does not yet hold:** `applyBehaviour` keys on `classKey ?? id`, and
   a placement root is always a scope. Both are small, and slice 12 cannot land without them.
3. **For Marlin, at deploy, as one line:** the additive `sites.components` migration, with `DEFAULT '{}'` and no row
   rewritten.

Sources for Framer's types: [property controls](https://www.framer.com/developers/property-controls) and [component
variables](https://www.framer.com/academy/lessons/component-variables-in-framer). The list of 17 editor types is the
review's, from Framer's editor.
