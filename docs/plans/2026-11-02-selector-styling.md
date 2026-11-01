---
type: plan
status: draft
date: 2026-11-02
title: "Selector-level styling: the contract for states, pseudo-elements, keyframes and at-rules"
summary: "How a node stores CSS that needs a selector or an at-rule, so it composes with breakpoints, stays scoped to its node, shows on the canvas and works without JavaScript. A new `props.rules` list whose declarations are ordinary style maps, one strict selector grammar, one reserved name prefix, a canvas that never reacts to the real pointer, and hover presets that expand into rules with no data migration. Ten slices closing 151 rows of the score."
tags: [framer-clone, primitives, css, selectors, responsive, renderer, fleet]
projects: [framer-clone]
---

# Selector-level styling

This is step 4 of the [complete primitives plan](2026-11-01-complete-primitives.md) and layer 1 of its
"Visual state management": Normal, Hover, Pressed and Focused compiled to plain CSS, so hover works
without JavaScript. It covers the score rows that need a selector, an at-rule or a media feature:
118, 15 and 34 rows of [the score](../primitives-score/latest.md), the largest gap in its format,
published page and canvas columns. Component states and page state (layers 2 and 3) are not here; they
will build on this format.

Read against commit `59a64d6`, after the widened matrix (1,844 rows).

## The decisions

1. **A new prop, `props.rules`, an ordered list beside `props.style`.** The same pattern as
   `props.effects` (motion plan, decision 1). Not nested in `style`, because every reader of `style`
   assumes "scalar or responsive map".
2. **Declarations inside a rule are an ordinary style object,** with the same
   `{ base, <breakpointId>: value }` maps. So Hover at Tablet needs no second cascade:
   `resolveCascade`, `writeCascade` and `declarationsAt` apply unchanged.
3. **A stored selector always starts with `&`, the node itself,** and nothing may step sideways out of
   the node. Text that does not parse is dropped whole, never partly applied.
4. **The render step is the trust boundary.** Save and publish keep the page as opaque JSON, so one pure
   parser runs at emission in every renderer, and again in the panel, the AI validator and the import.
5. **A node with a rule moves all its styles into the sheet,** as a responsive node already does.
   Inline style beats any selector, so `.fc-a.fc-a:hover` would otherwise lose to a plain inline colour.
6. **Global names carry a reserved prefix, `u-`.** Keyframes and the like are global to a document, and
   on the canvas that document is the editor itself. Names are not rewritten at render time.
7. **The canvas never reacts to the real pointer.** A state shows there only when the panel previews
   it. Structural rules and pseudo-elements always show.
8. **Hover presets stay stored as `effects.hover` and expand into rules at render.** No data migration.
   Appear and scroll stay what they are, because their trigger is a runtime.

## The stored shape

```ts
/** props.rules: order matters, a later rule wins a tie. Absent when empty. */
type StoredRule = SelectorRule | DefinitionRule;

interface SelectorRule {
  id: string;               // short, unique within the node, never emitted
  selector: string;         // starts with `&`: `&:hover`, `&::before`, `& > li`
  at?: string[];            // wrappers, outermost first: `@media (prefers-color-scheme: dark)`
  style: Record<string, unknown>; // exactly the shape of props.style
}

interface DefinitionRule {
  id: string;
  define: string;           // the whole prelude: `@keyframes u-spin`, `@font-face`, `@page :first`
  style?: Record<string, unknown>; // descriptors, plain values only, no responsive maps
  blocks?: { selector: string; style: Record<string, unknown> }[]; // `from`, `50%`, `@styleset`
}
```

A hover that differs on Tablet, on a node `a1` with the default breakpoints:

```json
{
  "style": { "color": { "base": "#111", "tablet": "#222" } },
  "rules": [{
    "id": "r1",
    "selector": "&:hover",
    "at": ["@media (hover:hover) and (pointer:fine)"],
    "style": { "color": { "base": "#00f", "tablet": "#0a0" } }
  }]
}
```

```css
.fc-a1.fc-a1{color:#111}
@media (max-width:1279.98px){
.fc-a1.fc-a1{color:#222}
}
@media (hover:hover) and (pointer:fine){
.fc-a1.fc-a1:hover{color:#00f}
}
@media (max-width:1279.98px){
@media (hover:hover) and (pointer:fine){
.fc-a1.fc-a1:hover{color:#0a0}
}
}
```

The value of a property in a state on a breakpoint is:
`resolveCascade(rule.style[key], breakpoint) ?? resolveCascade(style[key], breakpoint)`. State first,
then breakpoint: a Hover set on Desktop reaches Tablet even where Normal has a Tablet override, and a
Hover with no value for a property shows Normal's. The sheet produces the same answer by itself,
because the rule outranks Normal at every width.

This retires the score's two trial encodings in `test/score/lib/encodings.ts`, the nested key
(`{ [rule]: {...} }`) and the state key inside a value map. The second would have fought the cascade:
`isResponsiveMap` is false for a map holding only a state key.

### The named states

Constants in `src/lib/rules/states.ts`. A state is nothing but a rule the panel knows how to name.

| Panel | selector | at | Why |
|---|---|---|---|
| Hover | `&:hover` | `@media (hover:hover) and (pointer:fine)` | A tap would otherwise leave hover stuck on a phone. The motion plan's gate |
| Focused | `&:focus-visible` | none | Keyboard focus, without an outline after a mouse click on a button |
| Pressed | `&:active` | none | Last, because pressing also hovers and focuses |

The model keeps named states in that order at the start of the list; authored rules follow. Pressed
must win across widths too, which is why the sheet is grouped by rule below.

## Every reader that has to learn it

| Reader | What it does with `rules` |
|---|---|
| `ComponentModel.getResolvedProps` | Skips the key, like `effects`. Otherwise it would become a DOM attribute |
| New model actions | `setRuleStyle`, `addRule`, `removeRule`, `moveRule`: one action, one undo step, frozen `props` replaced whole, `writeCascade` for values, an emptied rule removed, an empty list deleted so saved pages stay unchanged |
| `applyResponsiveStyles` | A node with rules gets a class and loses its inline style; the dedupe signature in `classFor` becomes `style` plus `rules`, or two cloned rows differing in a rule would share a class; `props.rules` is removed from the tree |
| `buildResponsiveCss` | Takes `rules` on `ResponsiveRuleInput` and appends after today's output, see emission |
| `renderComponentNode` (`NON_DOM_PROPS`) | Denies `rules` defensively, as it does `effects` |
| `createComponentElement` | No change: it only sees `finalProps` built from `getResolvedProps` |
| `snapshotToComponentNode`, `hydrateBindings` | Pass it through. A cloned row carries its rules. A `{{binding}}` in a rule value contains `{` and is refused: bindings do not reach rules |
| `applyEffects` | Prepends the hover preset's rules, see migration |
| `collectPageFonts` (`fonts/registry.ts`) | Also scans `rules[].style`, or a family used only on Hover is never loaded |
| `yjsDocShape.ts` | `YJS_PROPS_KEYS.rules`: a `Y.Array` of `Y.Map`, each `style` a nested `Y.Map` as `props.style` is, so two people editing different states do not overwrite each other |
| `validate.ts`, `ai/review/ops.ts` | Accept through the parser and `style()`, see AI |
| `roundtrip/jsx.ts` | A named prop, like bindings, see export |
| Text nodes, blocked tags | A text node has no element: the model refuses rules there and the emitter skips them |

## Selector grammar

One pure, client-safe module, `src/lib/rules/rules.ts`, with a small tokenizer in the manner of
`isContainedValue`. No new dependency: the check is a short list of refusals, and it must run in the
browser.

A stored selector is a comma-separated list. Every part:

- starts with `&` as its first character, and has no other `&`;
- is at most 256 characters, with brackets, parentheses and quotes balanced and nesting at most 8;
- holds none of `{ } < ; @ \`, no control character, no `/*`, no `url(`;
- has no top-level `+`, `~` or `||` directly after the first compound, so `& + p` and `&:hover ~ p` are
  refused. `& h2 + p` is fine: it stays inside the node;
- has no class beginning `fc-`, and no `data-component-id` or `data-fx-` attribute. Those are platform
  names, unstable across a duplicate;
- has no attribute selector on `value` with an operator (`[value^="a"]`), see below.

Pseudo-classes and pseudo-elements are checked by shape, not against a list, so new CSS works without a
code change. Normalising is the job of what writes a rule, never of the emitter: the panel and the
import turn `:hover` into `&:hover` and `h2` into `& h2`.

`>` is allowed although the value check refuses it: only `</style` can close the element, and that
needs a `<`.

**Why this is enough for the node's scope.** The first compound is always the node, and only child and
descendant steps can leave it, so every emitted selector's subject is the node or something inside it.
`:is()`, `:not()` and `:has()` only narrow what the compound already matches, whatever they contain.

## What "safe in a multi-tenant stylesheet" means here

The sheet is per page and rendered per request into that site's own HTML, so tenant A's text never
reaches tenant B's visitors. That stays true only while nothing authored goes into a shared file. If
the sheet ever moves to a cached asset, its key must hold the site and the publish version.

| Threat | Answer |
|---|---|
| Closing the `<style>` element (`</style><script>`), which is script on a published site | `<` is refused in selectors, preludes and values. `dangerouslySetInnerHTML` writes the text raw, so this check is the one that matters |
| Escaping the rule or the declaration | `{ } ; \` refused, comments refused. Declarations go through the existing `declaration()`, so `isContainedValue` and `UNSAFE_VALUE` apply unchanged |
| Hiding what the platform owns on the page (consent banner, cookie links) | They are outside every node, and no selector can leave its node |
| Reaching the editor, because the canvas shares a document with it | The same scope, plus the `u-` prefix for global names. Tailwind's `animate-spin` is an editor keyframe called `spin`; a stored `@keyframes spin` would have replaced it |
| Reading form input through conditional requests: `input[value^="a"]{background:url(...)}` | Refused. React mirrors a controlled input's value into the attribute, and a site editor is not entitled to what visitors type before they submit |
| Loading from a third party through `@font-face` (a visitor's address reaching a foreign host, the German font rulings) | `src` takes only `local()`, a site path starting with one `/`, or `data:`. The hosted fonts already work this way |
| Registering a type for a platform variable | `@property` takes `--u-` names only, and `syntax` comes from a fixed list, because the sheet refuses `<` |
| A huge page | At most 64 rules per node and 2,000 per page; beyond that they are dropped with the warning below |

`url()` in a declaration value stays as open as it is in `props.style` today. This plan adds nothing to
that exposure and does not close it.

**Refused means dropped whole, and visible.** A rule that does not parse is not emitted. The page still
serves, `applyResponsiveStyles` warns once per page as it does for a dropped declaration, and the panel
shows the rule with its reason. A bad rule never blocks a publish.

## At-rules

Two kinds, decided row by row. A name below is the prefix rule: it must match `u-[a-z0-9-]+`, with `--`
in front where CSS requires a dashed name.

| At-rule | Kind | Stored as | Limits |
|---|---|---|---|
| `@media` | Wrapper | `at` | Prelude text checked like a selector, `url(` refused |
| `@supports` | Wrapper | `at` | Same |
| `@container` | Wrapper | `at` | Same |
| `@layer` | Wrapper | `at` | `u-` name, block form only. The statement form that orders layers belongs to page-level items |
| `@scope` | Wrapper | `at` | Prelude selectors are read-only conditions, checked by the same rules without the `&` |
| `@starting-style` | Wrapper | `at` | No prelude |
| `@keyframes` | Definition | `define`, `blocks` | `u-` name; block selectors `from`, `to` or percentages |
| `@font-face` | Definition | `define`, `style` | `fontFamily` must be `u-`; `src` as above |
| `@font-feature-values` | Definition | `define`, `blocks` | `u-` family; blocks are the feature keywords |
| `@font-palette-values` | Definition | `define`, `style` | `--u-` name |
| `@counter-style` | Definition | `define`, `style` | `u-` name |
| `@property` | Definition | `define`, `style` | `--u-` name; `syntax` from a fixed list (`"<color>"`, `"<length>"`, `"<number>"`, and so on) |
| `@position-try` | Definition | `define`, `style` | `--u-` name |
| `@page` | Definition | `define`, `style` | Optional `:first`, `:left`, `:right`, `:blank`. One document-wide box, not scoped to a node |
| `@view-transition` | Definition | `define`, `style` | Only `navigation` and `types`. Never on the canvas |

A definition lives on a node so it travels with that node on copy, on duplicate and later inside a
reusable component. Its effect is the document: any node may reference the name.

**Why a prefix rather than rewriting names per node.** Rewriting would need a value parser per property
(`animation`, `listStyle`, `fontFamily`, and more), would break a reference from another node's inline
style, and would make `@keyframes u-spin` two different things on one page, where a shared keyframe is
the whole point. A prefix gives the same safety against the editor and the platform with no render-time
rewriting. Two definitions of one name on a page are then an author conflict: identical ones dedupe,
the first in walk order wins otherwise, the rest are dropped with the warning, and the panel refuses
the clash when it is typed.

## Row decisions

Every row is either encoded or excluded with a reason; `test/score/data/exclusions.json` gets these 15,
each failing today, so no passing cell is lost.

| Rows | Decision | Reason to write |
|---|---|---|
| `:host`, `:host()`, `:host-context()`, `:has-slotted`, `::slotted()`, `::part()`, `:state()` (7) | Excluded | They read a shadow tree, and a node cannot author one. Custom code is the route that could bring one, and these rows return with it |
| `::view-transition`, `::view-transition-group()`, `::view-transition-image-pair()`, `::view-transition-new()`, `::view-transition-old()`, `:active-view-transition`, `:active-view-transition-type()` (7) | Excluded | They style the `html` element during a transition. That element belongs to the route: page-level items, gap 5 of the primitives plan |
| `:root` (1) | Excluded | Same: the route owns `html`, and shared variables on it are the theme tokens item |
| `:first`, `:left`, `:right` (3) | Encoded | They mean something only in `@page`, so the sample becomes `@page :first`, and they close with definitions |
| `::cue`, `::cue()`, `::cue-region`, `::cue-region()` | Encoded | Live on a `video` node with a track |
| `:scope` | Encoded | Live inside `@scope` |
| All others | Encoded | Normal rows |

Nothing here assumes a browser implements a row. Slice 1 extends `matrix.browser.score.ts`, so Chromium
must keep each sample in its parsed stylesheet, as it already proves value samples valid. A row Chromium
does not implement (`:blank`, `:local-link` and `:current` are likely) gets a written exclusion of the
same kind as `image()` and `element()`, so the row counts below are ceilings.

## Emission on the published page

`buildResponsiveCss` keeps its output byte for byte for a node without rules. The sheet becomes:

1. **Definitions,** first, deduped, in walk order. They have no breakpoint axis and no `at`.
2. **Today's blocks,** Normal per breakpoint, unchanged.
3. **Rules, grouped by rule rather than by breakpoint:** for each node in walk order, for each selector
   rule in stored order, its base block, then each breakpoint's own values. This is `declarationsAt`
   again, with the rule standing in for the node.

Grouping by rule keeps Pressed above Hover. In today's grouping, a Tablet Hover would land after a
Desktop Pressed and, having equal specificity, beat it while pressing.

**Nesting.** The breakpoint query is outermost, then `at` in stored order, each on its own line, then
the selector. Nested rather than merged into one `@media ... and ...`, because `at` also holds
`@supports` and `@container`, which cannot merge.

**A list becomes one rule per part.** A browser throws away a whole list for one selector it does not
know, so `&::picker(select), &:hover` must not lose its hover in Firefox. The declarations repeat, and
that is cheap.

**A rule beats Normal on whatever it reaches, in every renderer.** Which takes two things on this page:

- A node with rules moves everything into its class (decision 5).
- A selector reaching a descendant, such as a card's `&:hover h2`, is worthless against the title's
  inline colour. So `visit` gets a flag: under a node holding such a rule, every node with a style moves
  to a class too. Specificity then behaves as in plain CSS: `.fc-p.fc-p:hover h2` outranks
  `.fc-c.fc-c`, and the child's own `.fc-c.fc-c:hover` outranks `.fc-p.fc-p h2`.

## The canvas

The canvas shares a document with the editor, and its frames are not viewports, so the published sheet
cannot simply be reused. `buildRulesCss` takes options for each surface.

**One sheet at the canvas root,** `CanvasRuleStyles` beside `PageFontFaces` in
`ResponsivePageRenderer`, not per node. A `<style>` next to an element would count as a sibling and
shift `:nth-child` and `:first-child`, the rows it is meant to show. It lists each node once per frame,
and floating elements, whose identity has an empty breakpoint.

| Published page | Canvas |
|---|---|
| `.fc-a1.fc-a1` | `[data-component-id="tablet-a1"]`, the copy in one frame |
| One block per breakpoint in a media query | Values resolved for that frame by `resolveCascade`, with no query |
| Real `:hover` | Dead unless previewed (below) |
| Moves Normal into the class | Normal stays inline, every rule declaration gets `!important` |
| `@keyframes` run | Defined, but `[data-viewport-content-id] *{animation:none!important}` keeps the final state, as the Effects section has always promised |

`!important` is the small price for leaving the canvas's inline path alone: drag, selection, inline text
editing and `pointerEvents` all depend on it. It gives the same result as the published page, because
there too a rule beats Normal. Ids that are not `[A-Za-z0-9_-]` are skipped with the warning, so an id
cannot break the attribute string.

**The real pointer does nothing.** `:hover`, `:active`, `:focus`, `:focus-visible` and `:focus-within`
become `:not(*)` in the canvas sheet, wherever they stand, by the tokenizer rather than a text replace.
Otherwise a card would jump while someone tries to select it, and pressing to drag would show Pressed.
State reflected in the document (`:checked`, `:disabled`, `:empty`) stays real and shows.

**Previewing is per rule, and it is general.** `EditorUIStore` gets a volatile
`previewRule: { componentId, ruleId } | null`. For that one rule the sheet writes the five pseudo-classes
as `:is(*)`, so `&:hover h2` and `&:not(:hover)` both come out right, and removes its `at` wrappers. So
Hover, a dark-mode rule and a print rule are all shown the same way. It applies to every copy of the
node, so each frame shows its own breakpoint's value and Hover at Tablet can be compared with Hover at
Desktop side by side. A selection outline stays around the node and a small badge beside it names the
state.

**A condition about the window** (`width`, `height`, `orientation`, `aspect-ratio`) reads the editor's
window on the canvas, not the frame's. The panel never offers these, because breakpoints do that job;
they arrive only through import or the custom rule field. The rule's row says "the canvas reads your
window here, preview it to see it". Rewriting to a container query would fix this and would add
containment to every frame, so no.

**`@view-transition` stays off the canvas:** it would change how the editor itself navigates. That one
cell stays red, on purpose, with a note in the probe.

### The preview surface

`PreviewFrame` shows one breakpoint inside a `div`, so media queries on width cannot work there either.
It uses the same options as the canvas with real pseudo-classes and no `animation:none`, scoped to
`[data-preview-frame]`, and takes over the hover preset from `EffectsStyles`. The start-state rules stay
where they are.

## The panel

**State switch.** A row at the top of the right sidebar, under the selection's name: Normal, Hover,
Pressed, Focused, and `+`. A dot marks a state that holds values. It writes a volatile `activeRule` on
`EditorUIStore`, beside `selectedViewportNode`, and sets `previewRule`. It resets to Normal on another
selection, and it is hidden for several selected nodes, a text node and viewport nodes.

**One hook, not sixty call sites.** Size, Position, Layout, Typography, Styles and Image each define
`getStyleValue`, `setStyleValue` and `src` in three local lines. These become
`useStyleTarget(component, breakpointId)`, which reads `activeRule` and routes to `updateResponsiveStyle`
or `setRuleStyle`. The general Custom section of `fleet-general-editor` uses the same hook, so any
property works in any state.

**What a row shows in a state.** A value set in this state is normal text with a dot reading "set in
Hover", whose reset removes it. An unset row shows Normal's value greyed, reading "from Normal", and
typing there creates the rule on the first edit, not on the switch, so clicking through states leaves
nothing behind. The existing breakpoint source applies inside a state as well.

**What does not follow the state.** Text, Link, Form, Sticky bar and Data sections hold props rather
than styles, so they are dimmed with "Editing Hover. Back to Normal". Effects stays available: its Hover
preset row is a shortcut. The canvas resize handles, spacing handles, `quickbar/actions.ts` and
`QuickToolbar` all write Normal, so they hide while a state other than Normal is active. A drag cannot
silently edit the wrong state.

**Custom rules.** `+` opens one text field that takes a selector (`:nth-child(2n)`), or a whole CSS rule
pasted in, at-rule included, through `parseCssText` in `rules.ts`. On failure it says why and stores
nothing. Each custom rule then appears in the switch as a row of its own and is edited with the normal
sections. Definitions open as text, since a keyframe list has no meaning in a size field: a keyframes
timeline is a later product question, not part of this contract.

**Unhappy and re-entry paths** (the stateful flow standard):

- Forward: pick Hover, set a colour, see it on the canvas and on the published page.
- Backtrack: clearing the last value removes the rule, and the dot goes; a change of breakpoint keeps
  the state; deleting the active rule returns to Normal.
- Resume: `activeRule` is volatile, so a reload opens on Normal, with every rule intact.
- Re-entry: undo past the rule's creation returns to Normal rather than pointing at nothing, the same
  for the selected node vanishing, for a collaborator deleting the rule, and for a rule that was refused
  (shown with its reason, editable, and deletable).

Touch and keyboard: the switch is a `radiogroup` with arrow keys, and the phone editor shows it at the
top of its sheet. Motion in the panel follows the design skills' rules.

## AI output

The validator gains `props.rules`, through the same parser, with each rule's body through the existing
`style()` and `url()` checks. Everything parseable is accepted, which is what closes the column, and the
prompt teaches little, following the split `fleet-ai-allowlists` introduces.

- `schemaDocs` teaches Hover, Pressed and Focused on links and buttons, `::before` and `::after` for
  decoration, `:nth-child` for rhythm, and `prefers-color-scheme` when asked. Nothing else.
- `MAX_GENERATED_RULES` of 24 per generation, as appear effects are capped: "hover on everything" is a
  known tell. `effects.hover` remains not generated.
- Motion rules hold for generated output only: `infinite` is refused, and an `animation` is wrapped in
  `@media (prefers-reduced-motion: no-preference)`. Authored and imported rules are left as they are,
  because fidelity is the point of an import.

## React import and export

Step 7 builds this; the contract says what it targets, and `parseCssText` is the single entry.

- **Import** compiles Tailwind to real CSS, as the plan says, and hands the CSS to `parseCssText`. Tailwind
  is mobile first and our cascade is desktop first, so `md:p-4` maps to a breakpoint map only when its
  width is exactly a page breakpoint. Otherwise it stays literal as
  `at: ['@media (min-width: 768px)']`, which is exact. `hover:` arrives as the same selector and gate as
  the Hover state, so it reads as Hover in the panel.
- Global names are given the `u-` prefix at import, where every reference is in view.
- **What the parser refuses is reported line by line,** never dropped, per the plan's rule that a
  half-understood component must fail loudly.
- **Export:** `rules` is a named prop in the normalised round-trip form, like bindings. Real React output
  emits one CSS block with a scoped class, from the same `buildRulesCss`.

## Migration of the presets

Saved pages and published rows hold `props.effects`, and nothing about them is rewritten.

**Hover.** `effects.hover` stays stored forever, as the name of a preset. `hoverPresetRules(kind)` in
`effects.ts` returns real rules with the same numbers, and `applyEffects` prepends them, so the only path
to the page is the rule path, and a preset is literally a preset over the web. One function,
`effectiveRules(props)`, serves the published page, preview and canvas.

| Kind | Rules |
|---|---|
| dim | `&:hover{opacity:0.8}` under the pointer gate; `&{transition:...}` under the pointer and reduced-motion gates |
| lift | `&:hover{translate:0 -2px}` and its transition, under both gates |
| underline | `&:hover{text-decoration-line:underline;text-underline-offset:0.2em}` under the pointer gate |

This depends on the media wrappers, which is why it comes after slice 3. The published page moves first;
once the preview takes the same path in slice 6, `EFFECTS_BASE_CSS`, `FX_ATTR.hover` and the `data-fx-h`
attribute are removed. The panel, `compactEffects` and the yjs shape keep
working on the stored field throughout. A person's own Hover rule comes later in the list, so it wins, and the two
need no detach step.

Two visible changes, both in the owner's favour and both called out in the pull request: a hover preset
node now has a class instead of an inline style, and `dim` starts working on a node with its own inline
`opacity`, where today inline wins and dim does nothing.

**Appear and scroll stay.** Keyframes could hold a reveal, but what triggers it is
`IntersectionObserver` in `runtime.ts`, plus a promise that nothing is hidden without JavaScript, and a
stagger across children. Parallax is scroll-linked and has no rule form that is safe across browsers.
They keep `props.effects`, `startStateCss` and `--fx-*`, unchanged. They are the kind of thing step 6
(the behaviour model) may subsume, not this step. They coexist with rules: `--fx-*` values reach an
element the same way from a class as inline, the start state is gated by `data-fx-in`, and parallax's
inline `translate` beats an authored one, as lift already avoids in the panel.

## Score changes

These belong to the slices, and they make the probes stricter or more correct. None removes a test.

- **`encodings.ts` is rewritten to the real format,** as its header anticipates. `ruleNode` writes
  `props.rules`, and the AI probe reads rules back rather than `style` keys.
- **`samples.json`** gets `&` forms, and at-rules get real bodies with a marker. `color` is not a valid
  descriptor in `@font-face` or a `@keyframes` selector, so the current probe could never pass honestly
  against a validator.
- **`stylesheetHasRule`** checks each part for the selector list row, and `.fc-probe.fc-probe` for the
  nesting row, where `&` itself is resolved rather than emitted.
- **A probe bug, closed in slice 1.** `probeWidthMediaFeature` expects `@media (max-width:767.98px)` for a
  Tablet value. A Tablet override's query sits below Desktop's min width, so the sheet says
  `1279.98px`: the header of `responsiveCss.ts` and `maxWidthBelow` agree, and the row's cell
  (`pass media-queries pass pass pass`) has been a false failure since the first score. The regular
  expression takes the width from `maxWidthBelow(BREAKPOINTS[0].minWidth)`.
- **`matrix.canvas.score.tsx`** renders `CanvasRuleStyles` next to `ComponentRenderer`, because that is
  what the canvas mounts. The five pointer rows are probed with `previewRule` set, against a table of
  expected rewrites written in the test, not imported from the code under test.
- **`matrix.panel.jsdom.score.tsx`** hard-codes every selector row as a failure. It drives the switch and
  types each row's sample into the custom field, and a row counts when the rule is in the node.
- **`corpus/fixtures.ts`:** trees gain the rules their originals have. Its header's "a tree never carries
  a state's value" was right while the format had no place for one, and it is reworded.

## Slices

Each is one file-scoped pull request, green alone, raising `baseline.json` with
`pnpm score:primitives --update-baseline` where a number rises. Row counts are cells gained, assuming
Chromium's check removes nothing; a pull request states the real figure. The fleet plan estimated six
slices here; the canvas, the presets and the round trip were not in it.

Selector rows fall into families, and all are named by their `latest.json` ids (`css-selector:<id>`):

| Family | Rows | Ids |
|---|---|---|
| Basics | 12 | `Type selectors`, `Class selectors`, `ID selectors`, `Universal selectors`, `Attribute selectors`, `Nesting selector`, `Selector list`, the four sibling, child and descendant combinators, `Column combinator` |
| Pointer | 5 | `:hover`, `:active`, `:focus`, `:focus-visible`, `:focus-within` |
| Location | 7 | `:any-link`, `:link`, `:visited`, `:local-link`, `:target`, `:target-current`, `:target-within` |
| Form | 18 | `:autofill`, `:blank`, `:checked`, `:default`, `:disabled`, `:enabled`, `:in-range`, `:indeterminate`, `:invalid`, `:optional`, `:out-of-range`, `:placeholder-shown`, `:read-only`, `:read-write`, `:required`, `:user-invalid`, `:user-valid`, `:valid` |
| Structure | 11 | `:empty`, `:first-child`, `:first-of-type`, `:last-child`, `:last-of-type`, `:nth-child()`, `:nth-last-child()`, `:nth-last-of-type()`, `:nth-of-type()`, `:only-child`, `:only-of-type` |
| Logic | 8 | `:defined`, `:dir()`, `:has()`, `:is()`, `:lang()`, `:not()`, `:scope`, `:where()` |
| Media and display | 16 | `:buffering`, `:current`, `:fullscreen`, `:future`, `:modal`, `:muted`, `:open`, `:past`, `:paused`, `:picture-in-picture`, `:playing`, `:popover-open`, `:seeking`, `:stalled`, `:volume-locked`, `:xr-overlay` |
| Pseudo-elements | 23 | `::after`, `::backdrop`, `::before`, `::checkmark`, `::cue`, `::cue()`, `::cue-region`, `::cue-region()`, `::details-content`, `::file-selector-button`, `::first-letter`, `::first-line`, `::grammar-error`, `::highlight()`, `::marker`, `::picker-icon`, `::picker()`, `::placeholder`, `::scroll-marker`, `::scroll-marker-group`, `::selection`, `::spelling-error`, `::target-text` |

That is 100 rows, plus `:first`, `:left`, `:right` with `@page` and the 15 excluded: all 118.

| # | Slice | Files | Tag | Depends on | Closes |
|---|---|---|---|---|---|
| 1 | `rules-format` | `src/lib/rules/rules.ts` and tests, `ComponentModel.ts`, `renderComponentNode.tsx`, `yjsDocShape.ts`, `test/score/lib/encodings.ts`, `samples.json`, `exclusions.json`, `matrix.published.score.ts`, `matrix.browser.score.ts` | `renderer` | none | Renderer cell of `css-media-feature:width` (+1). The 15 exclusions. Parser unit tests over every sample and every refusal in this document |
| 2 | `rules-selectors` | `responsiveCss.ts`, `applyResponsiveStyles.ts`, `fonts/registry.ts`, `corpus/fixtures.ts` | | 1 | Format and renderer for the 100 family rows. Fixtures `hover-focus`, `pseudo-elements`, `shadcn-button` |
| 3 | `rules-conditions` | `src/lib/rules/rules.ts`, `responsiveCss.ts`, `corpus/fixtures.ts` | | 2 | Format and renderer for `css-at-rule:@media`, `@supports`, `@container`, `@layer`, `@scope`, `@starting-style` and the 33 media features other than `width`. Fixtures `container-query`, `print-styles` |
| 4 | `rules-definitions` | `src/lib/rules/rules.ts`, `responsiveCss.ts`, `applyResponsiveStyles.ts`, `corpus/fixtures.ts`, `samples.json` | | 2 | Format and renderer for `@keyframes`, `@font-face`, `@font-feature-values`, `@font-palette-values`, `@counter-style`, `@property`, `@position-try`, `@page`, `@view-transition`, plus `:first`, `:left`, `:right`. Fixture `keyframes` |
| 5 | `rules-hover-presets` | `effects.ts`, `applyEffects.ts`, `renderPublishedPage.tsx`, `publishedEffects.test.tsx` | | 3 | No row, on purpose: a preset never counts. The preview keeps its old path until slice 6, so it stays working. Proof: in Chromium, computed styles for lift, dim and underline are unchanged on hover, on a touch profile and under reduced motion, against the output of the commit before |
| 6 | `rules-canvas` | `src/lib/rules/surfaces.ts`, `CanvasRuleStyles.tsx`, `ResponsivePageRenderer.tsx`, `PreviewFrame.tsx`, `HeadlessComponentRenderer.tsx`, `effects.ts`, `EffectsStyles.tsx`, `EditorUIStore.ts`, `matrix.canvas.score.tsx` | | 3, 4, 5 | Canvas for the 150 rows, all but `@view-transition`. Browser proof on the mounted editor: no reaction to the pointer, previewed Hover in two frames, an inline-styled node beaten by its rule |
| 7 | `rules-state-switch` | `StateSwitch.tsx`, `useStyleTarget.ts`, the six style sections, `breakpointSource.ts`, `HudSurface.tsx`, `RightSidebar.tsx`, `matrix.panel.jsdom.score.tsx` | | 6, `fleet-general-editor` | Panel for `:hover`, `:active`, `:focus-visible`. All four stateful paths in tests, and a browser proof of Hover at Tablet from the panel to a published page |
| 8 | `rules-custom` | `parseCssText` in `rules.ts`, a custom rule field and list, `matrix.panel.jsdom.score.tsx` | | 7 | Panel for the other 148 rows |
| 9 | `rules-ai` | `validate.ts`, `ai/review/ops.ts`, `promptSections`, goldens | | 3, 4, `fleet-ai-allowlists` | AI for all 151 rows |
| 10 | `rules-round-trip` | `test/score/roundtrip/jsx.ts`, `roundtrip.score.ts` | | 4 | New round-trip cases for rules: a state with a breakpoint map, a definition, a refused rule. Tailwind import stays with step 7 |

Only slice 1 touches one of the two renderer files (`renderComponentNode.tsx`,
`createComponentElement.tsx`), because the emission lives in `responsiveCss.ts` and
`applyResponsiveStyles.ts`. Slices 2 to 4 can run in parallel only by luck, since they share
`responsiveCss.ts`, so the operator runs them in order. Slices 5, 9 and 10 are independent of each other.

**What the slices add up to,** out of 1,829 rows after the 15 exclusions, as ceilings:

| Column | Today | After | Percent | What is left |
|---|---|---|---|---|
| Format | 1,578 | 1,729 | 94.5 | The 100 event handler rows, closed by step 6 |
| Published page | 1,537 | 1,689 | 92.3 | Those, the interaction patterns, blocked embeds, element attributes |
| Canvas | 1,524 | 1,674 | 91.5 | Those, plus `@view-transition` |
| Panel | 67 | 218 | 11.9 | Mostly the general editor, a separate slice |
| AI | 273 | 424 | 23.2 | Mostly the allowlists, a separate slice |
| Corpus | 3 of 13 | 9 of 13 | | Expected, not proven: the score says these six are blocked by this gap alone. `radix-accordion` also needs behaviour |

**A matrix pass here proves less than it reads.** A selector row says the rule reached the sheet and
Chromium parsed it, not that any real page needs it. The corpus is the test that counts.

## What this does not cover

- **Page-level rules:** selectors on `html` and `body`, theme tokens, `@layer` ordering statements. Gap 5
  of the primitives plan.
- **Component states and page state.** Layers 2 and 3. They should reuse `SelectorRule`.
- **A keyframes timeline editor,** and proper controls for container queries. Text works; good controls
  are a product question once this format exists.
- **A value holding `<`,** such as `attr()` with a type, still works inline only.
- **A CSS escape in a value.** A backslash stays refused, so `content: "\201C"` must be typed as the
  literal character. This is not new, but pseudo-elements are where people will meet it first.
- **Bindings in rules.** A `{{row.colour}}` can be Normal, never Hover. A row's dynamic hover colour would
  go through a custom property set in Normal.
- **`url()` in values,** which stays as open as it is today.

## Decided here, say so if you disagree

The fleet plan gives contracts to a fresh review agent before fan-out, so these do not wait for Marlin.

1. `props.rules` beside `style`, rather than nested in it.
2. Selectors must start with `&`, which rules out `.dark &`. Dark mode works through
   `prefers-color-scheme`; a site-wide theme class belongs to theme tokens.
3. The `u-` prefix instead of rewriting names per node.
4. 15 rows excluded with reasons rather than emitted and counted as passes while the browser ignores them.
   The denominator drops, and no passing cell is lost.
5. The canvas does not react to the real pointer, unlike a browser and like Framer's canvas.
6. Focused means `:focus-visible`, not `:focus`.
7. `effects.hover` stays stored, and only its expansion changes.
8. Attribute selectors on `value` with an operator are refused, at the cost of some exotic form styling.
9. Generated rules are capped at 24, while everything parseable is accepted.

## Open questions

1. **`@font-face` from an uploaded font.** `src` takes site paths today, and an uploaded file would live
   on the storage host. Allowing it needs that host named, which is a decision for whichever slice adds
   font upload. Not needed by any slice here.
2. **Do the 15 exclusions stand with the review agent?** If it prefers honest failures, they stay in the
   denominator, the format column loses 0.8 points against the 95 percent target, and nothing else in
   this contract changes.
