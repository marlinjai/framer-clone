---
type: plan
status: draft
date: 2026-11-02
title: "SVG controls: paste, upload and icons as real nodes, edited in the properties panel"
summary: "How a person gets an SVG (Scalable Vector Graphics) onto a page and edits it: paste or upload a file, sanitised by the generation validator and the render gate rather than a parallel sanitiser, parsed into real nodes; every path and group in the Layers panel and selectable on the canvas; fill, stroke, caps, joins, opacity, size and aspect as controls that follow breakpoints, states and theme tokens; a Lucide icon picker; the same insertion for the AI generator and the Lumitra Sites agent plugin. Closes 452 of the 610 misses in the properties panel column of the primitive score (SVG and MathML through one namespace-aware general editor) and puts paint behind real controls. Eleven slices, about 22 to 28 agent days."
tags: [framer-clone, primitives, svg, icons, panel, score, renderer, ai, fleet]
projects: [framer-clone]
---

# SVG controls

Read against `main` at `46d92528`. Open pull requests this plan depends on or touches, none merged when it was written: #306 (the Theme
panel and token chips in the colour input, theme slice T4), #308 (the Lumitra Sites agent plugin plan, an MCP (Model Context Protocol) endpoint
whose write tools share the editor's operations), #309 (a Framer comparison column for the score) and #310 (honest row icons in the Layers
panel and the page root folded into the breakpoint row). Nothing here is built yet; this plan specifies and decides.

## Why this, and why now

The primitive score (`docs/primitives-score/latest.md`, written by `pnpm score:primitives`) measures what framer-clone can express against the web
platform in five columns: the format stores it, the published renderer emits it, the editor canvas shows it, the properties panel can edit it,
the AI generator can produce it. For SVG the first, second, third and fifth columns are full: 61 of 61 elements and 327 of 327 attributes stored,
published and shown on the canvas, and 61 elements and 288 attributes accepted by the generator. The panel column has **0 of 388**.

That is 388 of the panel column's 610 misses (it stands at 1232 of 1842, 66.9 percent). The agent fleet's stop condition
(`docs/plans/2026-11-01-agent-fleet.md`, "Stop conditions") requires 95 percent in every column. MathML (the markup for mathematics) misses the
same two gaps for another 64 rows, so one namespace-aware editor closes 452.

The product reason is plainer: every real landing page has icons and a logo, and today a person can only get one onto a page through the AI
generator or a React import.

**The advantage to build on.** Framer stores an SVG as one opaque string on a node (the comparison in #309 says the same; it is cited from the
task, because `docs/primitives-score/framer.md` is not on `main` yet). framer-clone already stores an SVG as real nodes: a `path` is a node
with a `d` prop, a gradient stop is a node. So a path can be selected, recoloured per state, bound to a theme token and animated, and the
safety rules that already guard every other node guard it too. Everything below keeps that and adds the ways in and the controls.

## What already exists (and is reused, not rebuilt)

| Piece | Where | What it already does for SVG |
|---|---|---|
| Render gate | `src/lib/renderer/blockedNodes.ts`, `renderVocabulary.ts` | Refuses `script`, `style`, `iframe` and every unreviewed tag or attribute by default; addresses limited to http, https, mailto, tel, sms, in-page `#` and media `data:`; a paint or filter attribute's `url()` must point inside the page; `attributeName` of an animation limited to reviewed shape and paint attributes; tracks which tags break out of `svg` for the HTML parser (`BREAKS_OUT_OF_SVG`) |
| Generation validator | `src/lib/ai/pageGen/validate.ts` (`validateGeneration`), limits in `schema.ts` (`GENERATION_LIMITS`) | Reads tags inside `svg` in SVG's own case; unknown SVG tag becomes `g`; `scopeIds` gives every id inside an `svg` a suffix unique to the generation and rewrites `url(#id)`, `href="#id"` and `aria-labelledby` with it; `dropExpandingSvgs` refuses an `svg` whose `use` chains expand past `maxSvgExpansion` (1000) or reach outside the generation; `attributeProblem` refuses `javascript:`, backslash escapes, `url()` outside the page, external `href` on `image` and `feImage`; geometry (`d`, `points`, `values`) may run to `maxGeometryChars` (8000) |
| SVG attributes that must be styles | `src/lib/ai/pageGen/svgAttributes.ts` (`svgAttributeAsStyle`) | Moves `width`, `height`, `transform` on sized SVG tags into `style` in the form CSS needs |
| Into the editor | `src/lib/ai/pageGen/apply.ts` (`toEditorSnapshot`) | Re-keys responsive maps to real breakpoint ids; the plugin's `insert_nodes` (#308) uses the same two steps |
| General editor | `src/components/sidebars/right/sections/CustomSection.tsx`, rules in `src/lib/styles/customEditor.ts` | Tag picker, any CSS property, any attribute, refusals with a message; HTML only today |
| States | `src/components/sidebars/right/useStyleTarget.ts`, `StateSwitch.tsx` | Every style control writes Normal, Hover, Pressed, Focused or a custom state through one hook |
| Theme references | `docs/plans/2026-11-02-theme-and-head.md` | A colour token is referenced as `var(--fc-t-<id>)` wherever a value holds a colour; light and dark come from a media query with no script; T1 to T3 merged, T4 is #306 |
| Icons | `lucide-react` 0.540.0, already a dependency | Each icon module exports `__iconNode`, a list of `[tag, attributes]`, plus shared `defaultAttributes` (24 by 24 view box, `stroke: currentColor`, width 2, round caps and joins, `fill: none`) |

What does **not** exist: any clipboard paste in the editor (no paste handler anywhere in `src/components`), any way to add an SVG element in the
panel, SVG attribute suggestions (`webPlatformNames.generated.ts` holds HTML names only; the SVG names are in `src/lib/ai/pageGen/webVocabulary.ts`),
and a score driver that can record an SVG pass at all (see the next section).

## The score has to learn SVG first

`test/score/matrix.panel.jsdom.score.tsx` fails every `svg-element` row unconditionally (`fail('panel-no-tag-choice')`) and passes an
`svg-attribute` row only when its namespace is HTML. So no panel work moves a single cell until the driver changes. Three changes to what a
panel cell means, each mirroring a rule the score already has:

1. **A paint written as a style counts for its attribute row on an SVG node.** The canvas column already says "an SVG attribute that arrives as a
   style declaration passes, because SVG maps those to the same property". The panel gets the same rule, limited to presentation attributes that
   are CSS properties with the same meaning on that tag (`fill`, `stroke`, `stroke-width`, `opacity`, `transform`, font properties, and `width`
   and `height` on the sized tags `svg`, `rect`, `image`, `foreignObject`). This is what lets the paint controls write styles (decision 4).
2. **An element counts when a person can get that tag onto a page,** which the panel definition already says ("a palette entry produces it or a
   panel action sets it"). Added: the icon picker is a palette entry, and the SVG import is a way onto the page. An element produced only by the
   import is labelled `imported`.
3. **Writes through the general editor are labelled `free field`** and counted apart, exactly as `raw field` is today for rules typed behind the
   state switch's `+`. A person typing `stroke-dashoffset` into an attribute field is not a control. The report gains one line beside the raw
   field line: "Of the panel's passing cells, N are the free field". HTML attributes typed into the same field get the label too, so the
   column stops overstating everywhere, not only for SVG.

The driver mounts the real `RightSidebar` on an `svg` root holding a `g`, a `path`, a `circle`, a `linearGradient` with two `stop`s, a `text`
with a `tspan` and an `animate`, records `propsOnTag`, `types` and style writes in the SVG namespace, and walks the free field with every SVG
attribute name of the universe the way it already walks HTML names.

## The decisions

Each is decided here under the global rule that a question with one defensible answer is not Marlin's. Say so if you disagree with any.

1. **Paste and upload are a thin front end on `validateGeneration`.** SVG text is parsed into a tree in the generation format, run through
   `validateGeneration` with SVG import limits, then through `toEditorSnapshot`, and inserted as one undo step. No second sanitiser exists. The
   render gate stays the last word at render time, as for every node. Why: the validator already does id scoping, the `use` expansion budget and
   every address and `url()` rule, and "one semantic, one implementation" is a standing lesson (`stateful-flow-testing.md`, sibling lessons).
2. **One parser in every place: `saxes`.** A strict streaming XML parser (ISC licence, version 6.0.0, already in the tree as a dependency of jsdom),
   promoted to a direct dependency. It runs the same in the browser and on the server, so the editor's paste and the plugin's `insert_svg` cannot
   read one file two ways. It never fetches anything and never expands an external entity. Not `DOMParser`: it does not exist on the server, and two
   parsers are two bug sites. Before parsing: the text is capped in bytes, and any `<!DOCTYPE` is refused outright (it is the only way to declare
   an entity, so the "billion laughs" expansion cannot start; real exports put nothing there that matters).
3. **What happens to each awkward construct on import:**

   | Construct | On import | Why |
   |---|---|---|
   | `<style>` inside the SVG | Rules with a type, class or id selector, or a list of them, are applied as inline styles on the nodes they match, in cascade order; a `:hover` rule on a matched node becomes a Hover rule on that node; `@font-face`, `@import`, `@media`, other pseudo-classes and anything that does not parse are dropped with a warning; the `style` element and the now unused `class` attributes go. Parsed with the existing rules parser (`src/lib/rules`), each declaration through the same value checks as any style | Design tools write `.cls-1{fill:#1d1d1b}`; dropping the block would turn every logo black. `style` stays a blocked tag, so nothing stored can hold a stylesheet |
   | Gradients, masks, clip paths, patterns, markers, filters | Kept as nodes; references stay `url(#id)` inside the graphic | Already allowed by the gate; they are what makes a logo look right |
   | `use` and `symbol` | Kept; `href` must be `#id` inside the same import; the expansion budget applies | The validator already enforces both |
   | Ids | Every id inside the `svg` gets the import's own suffix through `scopeIds`, with every reference rewritten | Two pasted logos that both say `id="a"` would otherwise paint each other's gradients |
   | `foreignObject` | Dropped with its subtree and a warning | Its content is HTML; a file has no business smuggling HTML into a page. The tag picker inside `svg` still offers it, because a person choosing it in the editor is not a file carrying it in. The two differ on purpose |
   | `image` with an external or `data:` address | Dropped with a warning that says to place the picture as an image node | The validator allows only site paths; a raster inside a vector is better as an image the site's image handling owns |
   | `title` | Its text becomes the root's accessible name (see Accessibility); the element is dropped | One way to name a graphic |
   | `desc`, `metadata`, comments, processing instructions, `xml:space`, editor namespaces (`inkscape:`, `sodipodi:`, `sketch:`) | Dropped silently, counted in the report | Inert noise from design tools |
   | `xlink:href` | Read as `href` | The modern spelling; one spelling to check |
   | No `viewBox` but a width and height | `viewBox="0 0 w h"` is written | Without it the graphic cannot scale |
   | Root `width` and `height` | Become the root's size in `style` through `svgAttributeAsStyle`; height becomes `auto` when the person keeps the aspect (the default) | An inline `svg` with a `viewBox`, a width and `height: auto` keeps its aspect in current browsers |
   | Animation (`animate`, `animateTransform`, `set`) | Kept when its `attributeName` is on the reviewed list, dropped otherwise | The gate already refuses the classic `attributeName="href"` attack |

4. **Paint is stored as style, geometry as attributes.** `fill`, `stroke`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`,
   `stroke-dasharray`, `stroke-opacity`, `fill-opacity`, `fill-rule`, `opacity`, `stop-color` and `stop-opacity` are CSS properties, so the
   controls write them into `style`. That gives breakpoints, the state switch and theme references with no new code, because a presentation
   attribute cannot hold `var()` and a style can. `d`, `points`, `cx`, `viewBox`, `preserveAspectRatio` and the rest stay attributes. On import,
   presentation attributes are moved into `style` the same way, so a pasted logo is recolourable per state at once.
5. **Import limits are their own, passed to the validator.** `validateGeneration` gains an optional `limits` field in its context; the generator
   passes nothing and keeps `GENERATION_LIMITS`. The import passes `SVG_IMPORT_LIMITS`: at most 512 KiB of text, 1500 elements, depth 32,
   100,000 characters per geometry attribute, the same expansion budget of 1000. A real icon is 1 to 10 elements; an exported logo is 10 to 300;
   a 2000 path illustration is not a logo and would make the Layers panel and the editor slow. Over a limit the whole import is refused with the
   count and a next step: "This file has 2,340 elements, more than 1,500. Simplify it in your design tool (for example with SVGO, the common SVG
   optimiser) or export it as PNG or WebP and place it as an image." V3 measures the numbers against the corpus files and may move them, recorded
   in this plan.
6. **Editor and plugin differ only in what a refusal does.** In the editor a dropped element is listed in the import dialog before anything is
   inserted, and the person chooses Insert or Cancel. In the plugin (#308) the blocked content contract applies: any refusal rejects the whole
   call with a reason per item and writes nothing.
7. **An SVG is selected as one unit, entered on double-click.** A click on the canvas selects the `svg` root, like a group in Figma or a placement
   of a reusable component here; a double-click or Enter (the existing `enterComponent` binding) steps inside, after which a click selects the
   deepest element under the pointer. Moving and resizing act on the root only; a child's offset is its `transform`, set in the panel. Why: icons
   are drawn with 2 pixel strokes and no fill, so clicking a path directly is a frustrating hit test, and dragging a path out of its graphic is
   never what a person meant.
8. **Children never leave their namespace.** A drop or reparent may move an SVG element only inside an `svg`, and an HTML element never into one
   (except inside a `foreignObject` a person made). The HTML parser lifts the first out of the second on the published page, with everything after
   it, and React keeps it inside, so the editor would show a page that never ships.
9. **Icons come from Lucide, inline, as real nodes.** See the icon picker section for the licence and why no second set.
10. **Inline every time, no shared sprite.** Each icon is its own nodes; there is no page-level `symbol` sheet with `use` references. Why: a
    Lucide icon is 1 to 6 short paths, about 300 to 900 bytes of markup; 100 icons on one page add roughly 60 KiB before compression and about 8
    KiB after it, since the paths repeat. A sprite would need a page-level home for definitions the format does not have, would put `use` back
    under the expansion budget across nodes, and would stop a single icon from taking its own hover colour. V11 measures this on a 100 icon page
    and records the number here.
11. **Accessibility is a root control with a safe default per way in:** decorative for icons from the picker (an icon beside a word is noise
    to a screen reader), meaningful for an imported file, which must then carry a name before publish (see Accessibility).

## Paste and upload

### The flow

1. **Ways in.** Paste on the canvas (Command or Control V while the canvas, not a text field, has focus) of clipboard text that starts, after
   whitespace and an optional XML declaration, with `<svg`, or of an `image/svg+xml` clipboard item. A dropped `.svg` file on the canvas or a frame.
   An Insert SVG entry in the components palette that opens a dialog with a file chooser and a text area for pasted code.
2. **Read.** `importSvg(text)` in a new pure module `src/lib/svg/importSvg.ts`: the byte cap, the `DOCTYPE` refusal, `saxes`, the table of
   decision 3, then `validateGeneration` with `SVG_IMPORT_LIMITS`. It returns the generation-format tree, the list of what was dropped and why,
   and the counts. It runs in the browser for the editor and on the server for the plugin; same function, same result.
3. **Show.** A dialog with a preview (rendered through the real `ComponentRenderer`, so what it shows is what will be inserted), the size, the
   element count and every dropped item in plain words ("A script was removed. Pages run no code from a file."). Insert and Cancel. When nothing
   was dropped and the source was a paste, the dialog still opens, so a paste never inserts a surprise; it opens with Insert focused, so Enter is
   one keystroke.
4. **Insert.** `toEditorSnapshot`, then one model action that adds the subtree at the drop point, or as the last child of the selected container,
   or replacing the children of a selected `svg` root when the person chose Replace graphic (offered only then). One undo step either way.
   Replace keeps the root's own style, size, accessible name and states, so a person can swap a logo without redoing its hover colour.
5. **Never kept as a file.** The text becomes nodes and is discarded. No `.svg` file is stored or served by framer-clone, which removes the
   whole class of stored script in an SVG opened directly from a storage address.

**The image upload path refuses `.svg`.** The site images upload work running in parallel (agent `site-images-upload`) must not accept an SVG
as an image file, for the reason in step 5; it points the person at Insert SVG instead. That is an interaction with that work, written here so
whoever lands second wires the message; neither blocks the other.

### The four paths (from `stateful-flow-testing.md`)

The import is a short flow with derived state: the parsed tree and its warnings are derived from the text.

1. **Forward.** Paste, see the dialog, Insert: the nodes are on the page, one undo step removes them all, one redo restores them with the same
   ids and the same id suffix.
2. **Backtrack and revise.** In the dialog, replace the text or choose another file: the preview, the warnings and the counts are recomputed
   from the new text, and nothing from the first parse survives (the derived tree is keyed by a hash of the text it came from, and Insert checks
   the key). Choosing the same file again keeps the parse and does not re-run it.
3. **Resume.** A reload with the dialog open loses the dialog (it is never persisted) and inserts nothing; after an Insert and a reload the nodes
   are there from the saved snapshot, with their scoped ids intact, and the published page shows them identically.
4. **Re-entry.** A second paste of the same file is a fresh import: a new id suffix, so the two copies never share a gradient; after a refused
   import (over a limit), the next paste starts clean with no leftover warning. Duplicating an imported `svg` re-scopes its ids the same way
   (the duplicate action calls `scopeIds` on SVG subtrees), so a duplicate whose gradient is then edited does not repaint the original.

## Canvas and Layers

- **Layers panel** (`src/components/sidebars/left/LayersPanel.tsx`). PR #310 is changing its row icons and the root row now, so this describes
  behaviour, not code: an `svg` row is collapsed by default and expands to its children; each row's label is the element's `id` from the file
  when it has one (designers name layers, and Figma writes those names into ids), with the import suffix hidden, otherwise the tag name; an icon
  from the picker is labelled "Icon: house". Selecting a row selects that element on the canvas. Dragging a row obeys decision 8.
- **Canvas selection.** Decision 7. The canvas code assumes HTML elements in places: `selectedNodeUnder` in `Canvas.tsx` returns nothing unless
  the element is an `HTMLElement`, so an SVG child could be hit but never handled. V5 inventories every `instanceof HTMLElement`, `offsetWidth`
  and `offsetLeft` in `src/components/Canvas.tsx`, `src/lib/canvas` and `src/lib/drag` and gives each an SVG answer: outlines and handles of an
  SVG child come from `getBoundingClientRect`, which SVG elements have. Drag and drop are verified by Marlin by hand, as the project memory says
  for all drag work: synthetic pointer events do not mirror a real drag.
- **Duplicate and delete** work on any element, root or child, with the id rule of path 4.

## Properties panel

### Categories

`getComponentCategory` (`sectionConfig.ts`) gains a namespace check before every other rule, so an SVG `a` is no longer read as an HTML link and
an SVG `text` no longer as a text node:

| Category | Tags | Sections, in order |
|---|---|---|
| `svgRoot` | `svg` | Graphic, Size, Position, Paint, Effects, Custom |
| `svgShape` | `path`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `rect`, `text`, `tspan`, `textPath`, `use` | Paint, Custom |
| `svgGroup` | `g`, `a`, `switch`, `symbol`, `marker`, `pattern`, `mask`, `clipPath` | Paint, Custom |
| `svgStop` | `stop` | Stop, Custom |
| `svgOther` | every other SVG tag (filters, gradients, animation, `defs`, `view`, `desc`) | Custom |
| `mathRoot`, `mathChild` | `math` and its descendants | Typography (root only), Custom |

### The new sections

- **Graphic** (root only):
  - Size with Keep aspect on by default (height `auto`); off writes both lengths.
  - Fit, which is `preserveAspectRatio` as a select with plain names: Contain (`xMidYMid meet`, the default), Cover (`xMidYMid slice`),
    Stretch (`none`), and an alignment grid of nine for the other values.
  - View box as four number fields, collapsed under a disclosure, since most people never touch it.
  - Colour: the CSS `color` of the root, which is what `currentColor` inside it means. An icon's strokes follow it, so this one field recolours
    an icon, and it takes a theme token like any colour.
  - Graphic colours: every distinct paint used anywhere in the subtree, each with a picker; changing one rewrites every use of it at once (in
    every state and breakpoint where it appears). This is how a person maps a three colour logo onto three theme tokens without visiting 40
    paths.
  - Accessibility (below).
  - Replace icon, when the root came from the picker.
- **Paint** (root, groups, shapes): Fill and Stroke as colour inputs (each with None, Current colour and theme tokens), Stroke width, Caps
  (butt, round, square, as an icon toggle group), Joins (miter, round, bevel), Dash (a text field for `stroke-dasharray`), Opacity, Fill
  opacity, Stroke opacity, Fill rule (non-zero, even-odd). On the root and on groups these set what children inherit, which is how icons are
  built.
- **Stop**: Colour, Opacity, Offset.

All of it writes through `useStyleTarget`, so the state switch applies: a Hover fill on an icon path, a Pressed stroke on a logo, a Focused
colour on the root of an icon inside a button. Custom states of reusable components apply the same way. The usual case, an icon that changes
colour when its button is hovered, needs no SVG state at all: the icon follows `currentColor`, and the button's Hover colour changes it.

### The free field

The Custom section's general editor becomes namespace-aware (`customEditor.ts` gains a namespace argument through `tagRefusal`, `tagGroups`,
`attributeSuggestions`, `tagNestingHint`, `attributeProp` and `attributeNameError`):

- **Names keep their case.** `viewBox`, `preserveAspectRatio`, `gradientUnits` are stored as written, never lower-cased, matching the React
  importer's rule ("a stored name is never lower-cased, because SVG needs `viewBox`", `src/lib/reactImport/jsx.ts`). Hyphenated names are stored
  in React's spelling (`stroke-width` as `strokeWidth`), as the score's samples already assume.
- **Suggestions per element** come from `webVocabulary.ts` (`WEB_ELEMENT_ATTRIBUTES`, `WEB_SVG_TAGS`), filtered by the render gate.
- **The tag picker inside an `svg`** offers only SVG tags, grouped as Shapes, Text, Structure, Paint servers (gradients, patterns), Clipping and
  masking, Filters, Animation; outside an `svg` it offers `svg` (and `math`) beside the HTML tags. It refuses an HTML tag inside an `svg` with the
  reason (decision 8) and `BREAKS_OUT_OF_SVG` tags explicitly.
- **Add element inside**, on `svgRoot`, `svgGroup` and `svgOther` nodes that hold children (`defs`, gradients, filters, `text`): a tag select and
  Add, inserting an empty element of that tag as the last child. This is how a person builds a gradient by hand, and it is the panel action
  that makes the remaining 50 or so SVG element rows editable.

### The format exception for nine attributes

The format reads a prop named like a CSS property as a style (`src/lib/styles/cssPropSet.ts`). For `width` and `height` on `svg`, `rect`, `image`
and `foreignObject` that is harmless, since CSS sizes them the same way. On `filter`, `mask`, `pattern` and `use`, `width` and `height` are a
region, not a box, and on `feConvolveMatrix` `order` is a matrix size, not flex order. The score lists these nine rows under
`attribute-read-as-style`. V3 makes the format keep them as attributes on those tags, in `getResolvedProps` and both renderers, with tests in all
five columns. The HTML half of that gap (a canvas's bitmap size, an image's size hints) is not in scope; it has the same cause and its own fix.

## Theme tokens and currentColor

The colour inputs of Paint, Stop and Graphic are the same `ColorInput` the rest of the panel uses, which #306 (theme slice T4) teaches to show
and pick a token chip. Added here: **Current colour** as a first-class choice beside None, writing `currentColor`.

Two ways a logo follows light and dark, both with no script, because a token's value switches by the site's colour mode through a media query
(theme plan, "Light and dark"):

1. **Single colour logo:** paths use `currentColor`, the root's Colour is a token. The import dialog offers this when every paint in the file is
   one colour: "Follow the text colour" rewrites that colour to `currentColor`.
2. **Multi colour logo:** Graphic colours maps each distinct colour to a token.

A token reference inside a paint is `var(--fc-t-<id>)` in a style, which the renderers already carry unchanged (theme plan, "Referring to a
token"). A deleted token stays behind as a tombstone in that plan, so a logo never loses its colour when a token is removed.

## Icon picker

- **Licence, checked.** `lucide-react` 0.540.0 is under the ISC licence, with the portions derived from Feather under the MIT licence (both
  notices in `node_modules/lucide-react/LICENSE`). Both are permissive. The editor bundle already ships Lucide and carries its notice with the
  rest of the third-party notices. Inserted icons are path data on a customer's page; no notice is placed on published pages, which is how
  Lucide icons are used across the web. V8 re-reads Lucide's own licence page before it lands and adds a line to this plan if it says otherwise.
- **Data, not components.** A build script, `scripts/generate-icon-index.ts`, beside the existing `generate-web-names.ts`, reads every
  `__iconNode` and the aliases from `lucide-react` and writes a compact index (name, aliases, search words, node list), loaded lazily when the
  picker opens, so the editor's first load does not grow. Search words come from Lucide's tag data in `lucide-static` (same licence, same
  version, a development dependency read only at build time); if that package lacks the data at the pinned version, search covers names and
  aliases only, and V8 says so in this plan.
- **Picker.** A palette entry, Icon, opens a searchable grid (keyboard navigable, arrow keys and Enter, every cell labelled with the icon's name).
  Choosing one inserts an `svg` root with Lucide's defaults as root styles (`fill: none`, `stroke: currentColor`, `strokeWidth: 2`, round caps
  and joins, 24 by 24 pixels, `viewBox="0 0 24 24"`), its children as `path`, `circle`, `rect`, `line`, `polyline`, `polygon`, `ellipse` nodes, and
  `aria-hidden="true"`.
- **Provenance.** The root stores `iconRef: "lucide:house"`, a new editor prop that never renders: it joins the editor's own props in the render
  gate's list (so it is dropped silently, not warned about) and `RESERVED_PROPS` in `customEditor.ts`. Replace icon reads it and swaps the
  children, keeping the root's style, size, states and name.
- **Other sets.** Not planned. Heroicons, Tabler and Phosphor are MIT licensed, but each is a new dependency of several megabytes for icons
  Lucide's 1,600 or so mostly cover, and the index format takes a set name, so adding one later is a data change, not a design change.

## AI generator and the agent plugin

- **The generator writes an icon by name, never by path data.** A model that writes path data invents shapes. The prompt teaches one form,
  `{ "type": "icon", "icon": "lucide:house" }`, which the validator expands into the same nodes the picker inserts (one shared function,
  `iconNodes(name)` in `src/lib/svg/icons.ts`). An unknown name is dropped with a warning naming the three closest names. Size and colour come
  from the node's style like any other node.
- **The generator keeps writing SVG for what is not an icon** (a divider wave, a simple badge), through the path it already has. The prompt
  section on SVG is updated to say: paint as style, `currentColor` for single colour graphics, a theme token for brand colours.
- **Plugin operations** (#308), on the shared site operations in `src/lib/siteOps/`: `insert_svg` (SVG text, `importSvg` then the insert,
  rejected whole on any refusal per the blocked content contract), `insert_icon` (a name and a target), `search_icons` (read only, returns
  names). `describe_vocabulary` lists the icon form. Every write takes `expectedVersion` like the plugin's other writes.

## React importer and export

- **Importer** (`src/lib/reactImport`). Inline `<svg>` JSX already imports through `jsx.ts` and the render gate. What it reports as
  `import-dynamic-logic` today is `<House />` imported from `lucide-react`. V10 maps an import from `lucide-react` to `iconNodes`, with the
  component's `size`, `color`, `strokeWidth` and `absoluteStrokeWidth` props as root styles, and `className` through the existing class layer.
  Any other icon library stays an unknown component, reported as today.
- **Export and the JavaScript XML (JSX) round trip.** SVG nodes leave as inline JSX with React spellings, through the round trip the score
  already runs (`test/score/roundtrip/jsx.ts`); an icon exports as its inline `svg`, not as a `lucide-react` import, because the node is the
  source of truth once a person has edited it. The four new corpus fixtures join the round trip cases.

## Accessibility

- **Decorative** writes `aria-hidden="true"` on the root and nothing else.
- **Meaningful** writes `role="img"` and an accessible name. The name is a `title` child referenced by `aria-labelledby` (the most widely read
  form across screen readers for inline SVG); `scopeIds` already rewrites `aria-labelledby` with the id suffix. The Graphic section shows one
  field, Name; the `title` node is the editor's to manage and hidden in Layers.
- **Imports** start Meaningful, with the file's `title` as the name when it had one. A meaningful graphic with no name is listed by the publish
  check (`checkBeforePublish`) as "A graphic has no name for screen readers", with a button that selects it.
- **Icons** start Decorative. An icon that is the only content of a link or button needs the name on that link or button, which the existing
  page essentials screen already asks for.

## Performance

- Many icons: decision 10, measured in V11 on a page of 100 icons: published HTML size before and after compression, time to render on the
  server, and the editor's frame time while scrolling the canvas, recorded here.
- Large imports: decision 5 bounds the cost of one graphic. The Layers panel renders a collapsed `svg` row without mounting its children's rows.
- The icon index loads only when the picker opens.

## Tests

- **Unit, `importSvg`:** every row of decision 3; `<style>` cascade order, a class used by two rules, a selector list; the `viewBox` synthesis;
  ids scoped and every reference kind rewritten; limits at, below and above each bound.
- **Adversarial files**, in `test/fixtures/svg/adversarial/`, each asserted to insert nothing harmful, through `importSvg` and, rendered, through
  the render gate harness in `test/renderGate` in real browsers: `<script>` in every case and as `svg:script`; `onload` and every event handler;
  `href` and `xlink:href` with `javascript:`, with entity-encoded and whitespace-split spellings, and on `a`, `use`, `image`, `feImage`;
  `<animate attributeName="href" to="javascript:...">` and `<set attributeName="onclick">`; `foreignObject` holding an `iframe` and a `form`;
  `<style>` with `@import url(https://...)`, `url(javascript:...)`, `url(https://tracker)` and a `</style><script>` breakout; a `<!DOCTYPE>` with
  nested entities (billion laughs); `use` chains five and six levels deep; a `use` pointing at another file; a 600 KiB file; 1,501 elements; a
  path of 100,001 characters; depth 33; `<?xml-stylesheet href=...?>`; a CDATA section holding script; ids `__next_f`, `webpackChunk_N_E`,
  `fc-root` and `createElement`; `image href="data:text/html,..."`; a file that is HTML with an `.svg` name.
- **Editor:** the four paths above as component tests on the real store, plus paste with focus in a text field (no import), paste of
  non-SVG text (no import, no dialog).
- **Score:** each slice names the rows it moves, below, and `pnpm score:primitives` must show exactly that movement; the floor check
  (`test/score/checkFloor.ts`) then holds the new numbers.

### New corpus fixtures

Each is a page with an original and a replica, as in `test/score/corpus`:

1. **Icon set:** a feature row of six Lucide icons at two sizes, one coloured by `currentColor` from its parent.
2. **Multi colour logo:** a gradient, a clip path and three solid colours, with a `<style>` block of classes in the original file.
3. **Theme following logo:** paths on tokens, checked under light and dark colour modes.
4. **Stateful and animated icon:** an icon whose stroke changes on Hover and Focused, and a spinner with `animateTransform` behind the reduced
   motion rule.

## Slices

Sizes are judgement, in agent days. Each slice is one pull request, verified on the four paths where it has a flow, and ends with the score run
showing the named movement.

| Slice | What | Score movement | Size |
|---|---|---|---|
| **V1, measure first** | The panel driver learns SVG (the three definition changes above, the `free field` and `imported` labels and their report lines); the four corpus fixtures | Panel: none yet. Corpus: 24 to 28 fixtures, expected to pass on the published path since the renderer already handles SVG; any that does not names a gap this plan then owns | 2 |
| **V2, namespace-aware free field** | Categories, the free field with case-kept names and per-element suggestions, the tag picker by namespace, Add element inside, decision 8 in the tag picker. MathML through the same hooks | Panel: SVG elements 0 to 61, SVG attributes 0 to 318 (the nine of V3 excepted), MathML elements 0 to 31, attributes 0 to 33, all as `free field`. Panel column 1232 to 1675 (90.9 percent) | 3 |
| **V3, nine attributes stay attributes** | The format exception above, with tests in all five columns | Panel: SVG attributes 318 to 327. Generator: the same nine leave `attribute-read-as-style` if the validator agrees (checked, not claimed). Panel column to 1684 (91.4 percent) | 1 to 2 |
| **V4, import core** | `importSvg`, `saxes`, `SVG_IMPORT_LIMITS`, the `limits` field of the validator context, decision 3 entire, the adversarial suite | None by itself; makes the `imported` route possible | 3 |
| **V5, paste, drop and Insert SVG** | The ways in, the dialog, insert and Replace graphic, the four paths, duplicate re-scoping, the refusal message for the image upload path | None by itself (the elements already pass in V2); the import dialog is driven by the score as the `imported` route for the corpus files | 2 to 3 |
| **V6, canvas and Layers** | Decision 7, decision 8 for drag and reparent, the `HTMLElement` inventory, outlines from `getBoundingClientRect`, Layers behaviour. Marlin checks drag by hand | Canvas: none (already full). Panel: none | 2 to 3 |
| **V7, Graphic, Paint and Stop sections** | The controls, the accessibility control and its publish check, Graphic colours | Rows move from `free field` to control: fill, stroke and their opacities, stroke width, caps, joins, dash, fill rule, opacity, `preserveAspectRatio`, `viewBox`, `stop-color`, `stop-opacity`, `offset`, `color`, `role`, `aria-hidden`. The count stays; the free field line drops by about 40 | 3 |
| **V8, icon picker** | The index script, the picker, `iconRef`, Replace icon, the licence check | Panel: the shape elements get "placed from the palette" instead of `free field` | 2 to 3 |
| **V9, tokens and currentColor** | Current colour in `ColorInput`, tokens in Paint, Stop and Graphic colours, Follow the text colour on import, the theme following fixture under both modes. Needs #306 merged | None new; the theme following fixture proves it | 1 to 2 |
| **V10, generator, plugin, importer, export** | The icon form in the generator, the prompt section, `insert_svg`, `insert_icon`, `search_icons` (after #308's operations exist), `lucide-react` in the React importer, the round trip cases | Round trip: four cases. Import score: Lucide components move out of `import-dynamic-logic` | 2 to 3 |
| **V11, performance and the last numbers** | The 100 icon measurement, the import limits measured against the corpus, both recorded here | None | 1 |

Total about 22 to 28 agent days. V1 must land first. V2 and V4 can run in parallel after it; V5 needs V4; V6 can start after V2; V7 needs V2;
V8 needs V2 and V5's insert path; V9 needs V7 and #306; V10 needs V4 and V8 (and #308's site operations for its plugin half); V11 is last.

**What this does to the stop condition.** After V2 and V3 the panel column stands at about 1684 of 1842 (91.4 percent), using today's
numbers. The remaining 158 misses are outside this plan: 100 HTML event handler rows waiting for the behaviour model's slice B11 (the canvas
and panel half of stored actions), 9 theme rows waiting for T4 (#306), 23 attributes of single HTML elements, 12 CSS selectors, 8 reusable
component promises, 3 at-rules and 3 HTML elements. The fleet needs 1750 for 95 percent, so this plan is necessary and not sufficient, and it
says so rather than claiming the column.

## What this does not cover

- An SVG drawing tool (pen, node editing of a path's points). A path's `d` is edited as text in the free field. Drawing is a separate product
  decision.
- Raster images inside a vector (decision 3): placed as image nodes instead.
- The HTML half of `attribute-read-as-style`.
- A shared icon sprite (decision 10), unless V11's measurement says otherwise, in which case this plan is revised with the number.

## Decided here, say so if you disagree

All eleven decisions above, and in particular:

- One parser (`saxes`) for browser and server instead of `DOMParser` in the editor.
- `<style>` inside an SVG is turned into inline styles and Hover rules, not stored and not simply dropped.
- `foreignObject` is dropped from files but stays available in the tag picker.
- Import limits of 512 KiB, 1,500 elements and depth 32, revisable by V11's measurement.
- An SVG is selected as one unit and entered on double-click; children never move or resize on their own.
- No licence notice on published pages for Lucide icons, re-checked against Lucide's licence page in V8.
- Lucide only.
- MathML rides along in V2, because it shares the two gaps and the code path; leaving it would leave a known gap in the same function.

## Open questions for Marlin

None. Every choice above has one defensible answer given the code, the theme plan and the agreed scope of 2026-11-02, or is reversible. The
only outward-facing question, whether published icons need a licence notice, is answered from the licence text (its notice condition covers
copies of the software, which the editor bundle already carries) and re-checked against Lucide's own licence page in V8 before any icon ships.
