---
type: plan
status: draft
date: 2026-11-02
title: "The behaviour model: page state, events and actions as data, and sandboxed custom code"
summary: "How a node stores behaviour without ever storing code: typed state values, triggers for real browser events, a closed list of actions, all compiled to a small runtime that a page without behaviour never loads. Thirteen failing interaction patterns become presets. Of the 100 event handler rows, 93 close on a real cause, 2 are labelled as reachable only by custom code, and 5 stay red with a reason. Custom code runs on a separate registrable domain in a sandboxed frame, off by default, never in the editor, with no network in its first version. Browser claims measured in Chromium and WebKit. The sandbox design waits for Marlin's security review."
tags: [framer-clone, primitives, behaviour, state, wai-aria, custom-code, sandbox, security, fleet]
projects: [framer-clone]
---

# The behaviour model

This is step 6 of the [complete primitives plan](2026-11-01-complete-primitives.md), layer 3 of its
"Visual state management", and the sandbox design its decision 1 calls for: custom code on customer
sites is allowed, sandboxed, off by default and clearly marked. It builds on the
[selector contract](2026-11-02-selector-styling.md), and layer 2 (component states) compiles to it: see
`2026-11-02-reusable-components.md`, written in parallel and not on `main` at this writing.

Read against commit `87fbe6d`. It covers the 13 failing rows of the 30 interaction patterns from the
Accessible Rich Internet Applications Authoring Practices (WAI-ARIA, the web standard's catalogue of
accordions, tabs, dialogs and so on), the 4 cells the mounted editor loses, the 100 event handler rows
that fail in all five columns, and fixtures `radix-tabs` and `radix-dialog`, which behaviour alone
blocks.

## The decisions

1. **One new prop, `props.behaviour`, beside `style`, `rules` and `effects`.** Declares state, triggers,
   bindings and visibility. It never reaches the Document Object Model (DOM).
2. **State lives on a node, and the node is its scope.** A value declared on the page root is page
   state. A value declared on a row template or a component root exists once per clone. This is one
   mechanism, because `hydrateBindings` clones a Collection template per row with the same node ids,
   so without scopes every accordion in a content list would open together.
3. **Events and actions are data, and the action list is closed.** No expression is ever a string of
   code. Nothing calls `eval` or `new Function`. A stored `on*` handler stays dropped by
   `blockedNodes.ts`.
4. **State renders through two paths.** Visual differences are CSS, a `when` condition added to
   `SelectorRule`. Semantics (`aria-*`, `tabindex`) are attributes the server writes for the initial
   value and the runtime keeps current. Nothing is rendered twice.
5. **The runtime is one constant module, loaded by an island only when a page needs it.** A page with no
   trigger gets no bytes of it. The stored program is a data table passed as props.
6. **Without JavaScript the content stays reachable.** A rule that hides by state applies only behind a
   gate an inline script sets, the promise the effects runtime already makes. Presets use native
   elements first.
7. **`text` state is never reflected into an attribute,** so a visitor's typing stays out of reach of
   attribute selectors, and there is no action that can reach the network. So typed text cannot leave
   the page through behaviour.
8. **The canvas has two modes.** In Select nothing runs and a volatile preview shows a chosen state, so
   hidden content can be edited. A new Interact tool runs the page and gives it the keyboard.
9. **An event row passes only on a real cause.** A stored action must run in Chromium with no
   `dispatchEvent` anywhere. Five rows stay red, each with its reason.
10. **Custom code runs on a separate registrable domain, in a frame with an opaque origin, with no
    network and no storage, never in the editor document.** Code enters only through one guarded route,
    never through the opaque page save. Everything about this is marked for Marlin's review below.

## What the browsers do, measured

Every claim this contract rests on was run, not assumed. Environment: Playwright's Chromium (build
1248) and WebKit (build 2370), React 19.1.9 in a production bundle, plain HTTP on `localhost` against
`127.0.0.1`, on 2026-11-02. Not tested: Firefox, real Safari, phones, HTTPS. The scripts were throwaway;
slice C5 turns the sandbox ones into a permanent suite.

**Hydration, Chromium only.** A runtime can touch the page before React attaches to it, so this decides
the runtime's design. The probe hydrated a client root, not a real streamed page.

| Change made before hydration | Result, after hydration and after a re-render |
|---|---|
| Attribute changed or added | Kept both times, no error |
| Text in an element with `suppressHydrationWarning` | Kept both times, no error |
| Text in a plain element | React error 418: the **whole root was rebuilt**, every other mark on the page lost |

**The sandboxed frame.** Served with `Content-Security-Policy: sandbox allow-scripts; default-src 'none'`
plus the directives under "The frame", embedded with `sandbox="allow-scripts" allow=""`.

| Channel | Chromium | WebKit | Control |
|---|---|---|---|
| `fetch`, image, CSS `url()`, beacon, WebSocket, EventSource | No request | No request | The frame's Content Security Policy (CSP, the browser's own list of what a document may load) |
| Worker | Refused | Refused | `worker-src 'none'` |
| Form post, `window.open`, `top.location` | Blocked | Blocked | Sandbox flags |
| `document.cookie`, `localStorage`, `sessionStorage`, IndexedDB | All throw | All throw | Opaque origin |
| Direct visit to the frame's address, no iframe at all | Origin still `null` | Origin still `null` | `sandbox` in the response header, not only the attribute |
| **Frame navigates itself** (`location`, `<meta refresh>`, link click) | **Reached the sink** | **Reached the sink** | Needs `frame-src` on the **parent** page |
| The same with parent `frame-src` (header or `<meta>`) | Blocked, all three | Blocked, all three | Parent policy |
| **WebRTC to a STUN server** (a real-time connection helper that sends raw network packets) | **3 packets, despite `webrtc 'block'`** | **3 packets** | None in CSP |
| The same, constructors deleted before author code runs | 0 packets | 0 packets | Shell script, see below |
| A child frame to fetch a fresh constructor | `SecurityError` | `SecurityError` | `frame-src 'none'` |
| `while(true)`-style 3 second block in the frame | Parent gap 53 ms, site isolation on; 3,004 ms with Playwright's default of isolation off | **Parent gap 3,004 ms** | None |

**Cookie transport.** Chromium only, hosts mapped to `.test` names, an `HttpOnly` probe cookie on the apex,
standing in for `lumitra_session` on `.lumitra.co`. A sandboxed iframe on `acme.sites.lumitra.test`
loading `run.lumitra.test` **sent the cookie**. The same frame on `run.sandbox-other.test` sent none. The
sandbox attribute does not change what the frame's own request carries.

**Events, Chromium only.** One capture listener per event name on `document`, real input from Playwright, no
`dispatchEvent`, heard 92 of the 100 rows, among them `load`, `error`, `scroll` and the media events,
which do not bubble. `securitypolicyviolation` also fires, on a page with a policy. See "The 100 event
handler rows".

## The stored shape

```ts
/** props.behaviour: absent when empty, so a saved page stays unchanged. */
interface StoredBehaviour {
  state?: StateValue[];       // this node is a scope for these values
  on?: Trigger[];             // what happens here
  bind?: Binding[];           // attributes, custom properties and text following state
  showWhen?: Condition;       // hidden when false, only behind the gate
  noScript?: 'show' | 'hide'; // without JavaScript; default 'show'
}

type StateValue = { id: string; name: string } & (
  | { type: 'boolean'; initial: boolean }
  | { type: 'number'; initial: number; min?: number; max?: number; step?: number; wrap?: boolean }
  | { type: 'choice'; initial: string; options: string[] }
  | { type: 'text'; initial: string; maxLength?: number }
);

interface Trigger {
  id: string;
  on: string;                 // a DOM event name, or a pseudo event below
  keys?: string[];            // 'ArrowRight', 'InlineEnd', 'Shift+Tab'
  if?: Condition;
  prevent?: boolean;          // preventDefault
  ms?: number;                // for 'every'
  do: Action[];
}

type Condition =
  | { state: string; eq: string | number | boolean }
  | { not: Condition } | { all: Condition[] } | { any: Condition[] };

/** The selector contract's SelectorRule gains one field. */
interface SelectorRule { /* ... */ when?: Condition }
```

An accordion item inside a content list, whose state exists once per row:

```json
{
  "behaviour": { "state": [{ "id": "s1", "name": "open", "type": "boolean", "initial": false }] },
  "children": [
    { "type": "button", "props": { "behaviour": {
      "on": [{ "id": "t1", "on": "click", "do": [{ "toggle": "s1" }] }],
      "bind": [{ "attr": "aria-expanded", "from": { "get": "s1" } }]
    } } },
    { "type": "div", "props": { "behaviour": { "showWhen": { "state": "s1", "eq": true } } } }
  ]
}
```

**Names and ids.** `name` is what a person sees; references use `id`, so a rename touches one row. A
state's `id` must be unique on its path to the root.

**Why not on the page snapshot.** Page state on `PageModel` would need a model field and a publish
adapter, and it would still need a second mechanism for rows and placements. The page root is already a
node that passes through save, publish and `snapshotToComponentNode` as JSON. No database or model
migration is needed.

**Memory only.** Values reset on reload. Keeping them on the visitor's device would open the consent
question, which this version has no need for. A new line and a review if that changes.

### Pseudo events

| `on` | Fires | Notes |
|---|---|---|
| `view-enter`, `view-leave` | The element enters or leaves the viewport | One shared `IntersectionObserver` |
| `page-ready` | The runtime started | Never used to set what the server could have rendered |
| `every` | At `ms`, at least 1,000 | Not under `prefers-reduced-motion`, paused while the page is hidden. An `if` is how a carousel pauses on focus and hover |
| `custom:<name>` | An `emit` action, or a custom code frame | The only way into page state from a frame |

### Expressions

A closed JSON form, at most 6 levels deep, and total: it cannot throw or loop.

`{ get: stateId }`, a literal, `{ eq: [a, b] }`, `{ gt: [a, b] }`, `{ lt: [a, b] }`, `{ not }`, `{ and }`,
`{ or }`, `{ add: [a, b] }`, `{ clamp: [v, min, max] }`, `{ map: stateId, cases, default }` and
`{ event: 'value' | 'checked' | 'key' }`.

### Actions

The whole list. A stored action is one of these or it is refused.

| Group | Action | What it does |
|---|---|---|
| State | `set`, `toggle`, `step` | Write a value. `step` honours `min`, `max` and `wrap`, and cycles a `choice` |
| Focus | `focus` | Move focus to a target |
| Focus | `rove` | Move focus in a group: `next`, `prev`, `first`, `last`, `up`, `down`, `page-up`, `page-down`, `type` (typeahead). Axis `line`, `grid` or `tree`, a role filter, `wrap`, and it keeps one `tabindex="0"` |
| Native | `dialog`, `popover`, `details` | `showModal`, `show`, `close`, `togglePopover`, `open`. Native elements bring focus handling along |
| Native | `media` | `play`, `pause`, `load`, `seek`, `rate`, `volume` |
| Native | `fullscreen`, `pictureInPicture`, `capturePointer` | Enter and leave, `setPointerCapture` for a splitter's drag |
| Native | `scroll`, `form` | `scrollIntoView`; `reset` and `requestSubmit`, on a plain `form` only |
| Values | `setProp` | Write `min`, `max`, `value`, `checked` or `disabled` from an expression. What keeps two slider thumbs apart |
| Values | `filter` | Hide items of a list whose text does not match. What a combobox needs |
| Flow | `delay` | Run nested actions later, at most 10 seconds |
| Flow | `emit` | Fire `custom:<name>` up the scopes |
| Flow | `navigate` | Literal address only, through the sticky bar's safe link check. Never built from state |
| Flow | `effect` | Plays a node's appear reveal from `src/lib/effects/runtime.ts` |

There is deliberately no `fetch`, no storage, no `click`, no `innerHTML` and no `setAttribute` by free
name. Without `click`, a page cannot press its own consent banner or a real button on a visitor's behalf.

### Bindings

```ts
type Binding =
  | { attr: string; from: Expression }      // allow list below
  | { cssVar: `--u-${string}`; from: Expression; unit?: 'px' | '%' | 'rem' } // numbers only
  | { text: Expression };                   // textContent, never markup
```

**Attribute allow list:** `aria-*`, `data-u-*`, `tabindex`, `inert`, `open`, `disabled`, `min`, `max`,
`value`. Everything else is refused, `on*`, `href`, `src`, `srcdoc`, `action`, `formaction`, `style`,
`class`, `id` and `hidden` above all. This is decision 6 of the selector contract applied to behaviour:
no address is ever computed. `hidden` is missing on purpose: hiding goes through `showWhen`, or the content
would vanish without JavaScript.

A binding from `text` state to an attribute is refused, see Safety. A `text` binding is refused on a node
with element children, because `textContent` would wipe them: it needs a string or text nodes only.

## From stored data to a page

A new pure pass, `applyBehaviour(root)`, runs in `renderPublishedPage` on the hydrated tree, after
`hoistStickyCta` and before `applyEffects`, so cloned rows and hoisted nodes are in their final place and
the rules it adds reach `applyResponsiveStyles`. Save and publish keep the page as opaque JSON, so one
parser, `parseBehaviour` in `src/lib/behaviour/format.ts`, is the trust boundary, as the selector parser
is. It also runs in the panel, the AI validator and the import.

The pass:

1. Writes each scope's initial values as attributes: `data-fcs-s1="false"`. `text` values are not written.
2. Evaluates every binding at its initial value and writes the attributes, so `aria-expanded="false"`
   is in the first HTML.
3. Renders text bindings at their initial value and sets `suppressHydrationWarning` on those elements,
   because the measured alternative is React rebuilding the page.
4. Turns `showWhen` into a rule, `{ selector: '&', when: { not: condition }, style: { display: 'none' } }`,
   last in the node's list. A node with such a rule moves its Normal styles into the sheet, under
   decision 5 of the selector contract.
5. Adds `data-fc-n="<node id>"` only to nodes a trigger or a target needs.
6. Removes `behaviour`, and returns the program: a table keyed by node id, so 500 rows of one template
   share one entry.

**A page with none ships nothing.** With no `behaviour` on any node the pass returns the same tree
object, and the output is byte-identical: no attribute, no gate, no script, no island, no client chunk in
the page's data. A test compares the HTML. To be exact about the word: published pages already load
Next's own client code and the commerce providers, and this adds nothing to that. A page with state but
no trigger needs no runtime either, since nothing can change a value: it stays static.

### The `when` condition

```css
:where(html[data-fc-b]) .fc_r-a1.fc_r-a1:where([data-fcs-s1="true"] *, [data-fcs-s1="true"]) { color: #0a0 }
```

- **`:where`, so a condition adds no specificity.** The rule keeps exactly what the selector contract
  gave it, and a later rule wins a tie, so Open and Hover combine by list order as any two rules do.
- **Only `eq` compiles to CSS, and only on reflected types.** Value literals pass the selector
  contract's string checks. `all`, `any` and `not` map to chained, listed and `:not()` forms.
- The rule goes through `rules.ts` and `buildResponsiveCss` like any other, so breakpoints, `at` wrappers
  and the rule class apply unchanged. A row's rule class is shared across clones and the condition reads
  the clone's own ancestor.

### The gate and no-JavaScript

An inline constant script, placed where the effects boot script is, sets `data-fc-b` on `html` before
the content paints, and removes it after `START_STATE_TIMEOUT_MS` (3 seconds) unless the runtime reported
ready, the same design as `publishedEffectsBootScript`. It re-sets it when the runtime does start late.

| Situation | What the visitor gets |
|---|---|
| JavaScript off | No gate. `when` rules are dead, so every panel shows. Controls that mean nothing (`noScript: 'hide'`, such as a Next button) are hidden by `html:not([data-fc-b]) .x{display:none}`. Attributes hold their initial values |
| Script blocked or failed | The gate falls after 3 seconds, the page becomes the no-JavaScript page, and the console says why |
| Normal | Gate before first paint, so the initial state shows with no flash |

### The runtime

`src/lib/behaviour/runtime.ts`, vanilla like `src/lib/effects/runtime.ts`, with one entry:
`startBehaviour({ container, program, nodeAttr, surface })`, returning a cleanup. The published page
mounts it through `BehaviourIsland`, a client island rendered only when the program has a trigger, the
`EffectsIsland` pattern. The preview and the canvas pass their frame as `container`.

- **One capture listener per event name in the program,** on `container`. Measured to hear non-bubbling
  events, so no element gets its own listener. A node inside an island needs no help from that island.
- **Target resolution:** from the event's element, walk up the scopes, and in each look for
  `[data-fc-n="<id>"]`. The first hit wins, so a row finds its own panel. The page root is the last scope.
- **High-frequency events** (`pointermove`, `mousemove`, `scroll`, `wheel`, `drag`, `dragover`,
  `selectionchange`, `timeupdate`) are batched to one animation frame and listen passively unless the
  trigger sets `prevent`.
- **Hydration:** writes attributes at any time, and text only on elements the pass marked. Attributes
  survive hydration and re-renders, which the probe showed.
- **Islands re-render:** a `MutationObserver` re-applies bindings to added nodes, for "Send another" and
  cart lines, as the effects runtime rescans.
- **Clicks before the island starts** are not replayed. A replay could double a native action. Presets
  built on native elements work from the first paint regardless.
- **It never throws.** An unresolved target or unknown verb warns once with the node id and continues.
- **Size:** a test bundles it with esbuild and fails above 8 kilobytes gzipped, so a new verb must pay for
  itself.

**Coexisting with the islands.** Forms, commerce and the sticky bar stay what they are: React islands
with their own state. A trigger may observe them, since a capture listener hears `submit` on a form
island's `form`. An action cannot change them: `form`, `setProp` and bound text are refused on a node
that `formKindOf`, the commerce kinds or `isStickyCta` claim, because the island owns that markup. The
sticky bar is moved to the page root before the pass, so only page state reaches it. Appear and parallax
stay in `props.effects`: they are not subsumed, and a `view-enter` trigger is available beside them.

## Every reader that has to learn it

| Reader | What it does with `behaviour` |
|---|---|
| `ComponentModel.getResolvedProps` | Skips it, like `effects` |
| New model actions | `setBehaviour`, one action and one undo step, frozen props replaced whole, emptied keys deleted so a saved page stays unchanged |
| `PageModel` duplicate, paste, and later detach | `remapBehaviourRefs`: references inside the copied subtree follow the new ids, references outside stay |
| `renderComponentNode` (`NON_DOM_PROPS`) | Denies it defensively |
| `createComponentElement` | No change |
| `snapshotToComponentNode`, `hydrateBindings` | Pass it through, so a cloned row carries it. A `{{binding}}` inside it is refused: initial values are literals |
| `applyResponsiveStyles`, `buildResponsiveCss` | Emit `when`, through the gate |
| `rules.ts` | Parses `when`, and refuses a reference to `text` state |
| `yjsDocShape.ts` | No change, as for `rules` |
| `validate.ts`, `ai/review/ops.ts` | Accept through `parseBehaviour`, see AI |
| `roundtrip/jsx.ts` | A named prop, see import and export |
| Text nodes, blocked tags | Refused: there is no element |

**Refused means dropped whole, and visible,** the selector contract's rule. A trigger or binding that does
not parse is not emitted, `applyBehaviour` warns once per page, the panel shows it with its reason, and it
never blocks a publish. A `showWhen` that fails leaves the node visible, which is the safe direction. A
reference to a deleted state counts as a failure of that entry alone.

## Safety

| Threat | Answer |
|---|---|
| Script on a published site | No expression is code, the runtime holds no `eval`, stored `on*` strings stay dropped |
| An attribute that runs or loads something | Allow list, with `on*`, `src`, `href`, `srcdoc`, `style` and `action` refused |
| Markup injection | Text bindings use `textContent` |
| Reading what a visitor types | `text` values are never reflected, and CSS cannot reach them. Refused at parse: a `when` on `text`, or a binding from it to an attribute or a custom property |
| Sending data out | No action reaches the network, and `navigate` takes a literal address |
| Reading state through CSS, the residual route of the selector contract | A boolean or choice is readable that way, exactly as `:checked` already is. No new kind of exposure, and open question 1 there covers it |
| Keyboard trap | `prevent` on `Tab` is refused, so a page cannot hold focus. Native dialogs trap by themselves and Escape closes them |
| Pressing the consent banner | No `click` action, and the banner has no `data-fc-n`, so nothing can target it |
| Device storage | The runtime reads and writes none, so it needs no consent |
| A huge or looping program | 64 triggers per node, 2,000 per page, 16 actions per trigger, expression depth 6, 64 kilobytes per program, `every` at 1,000 ms or more, `delay` at 10 seconds or less, `emit` chains at depth 4. No trigger fires on a state change, so there are no cycles. Beyond a cap, later entries are dropped with the warning |
| Tenant reach | The program is in that site's HTML, per request, the sheet's reasoning in the selector contract |

## Presets

A preset is a pure function in `src/lib/behaviour/presets/` that returns ordinary nodes with `behaviour`
and roles. There is no preset type at render time: the palette, the AI generator and the score's
`patterns.ts` call the same functions, and what lands on the page can be edited like anything else.

A preset root stores `behaviour.preset: { kind, version }` and each generated entry a `preset: true`
mark. Adding a tab clones an item and re-derives only the marked entries, so a person's own triggers
survive.

**Native first.** 17 patterns already pass on plain HTML and stay as they are. Accordion stays `details`
with `name`, dialog stays `dialog` with `command`, both of which work without JavaScript. Behaviour is
added only where the Authoring Practices ask for more than the element gives.

The 13 that fail today, by the primitive that closes them:

| Pattern | Built from | Keys (Authoring Practices) | Without JavaScript |
|---|---|---|---|
| `tabs` | `choice` state, `rove` line, bound `aria-selected`, `showWhen` per panel | Left, Right (Up, Down when vertical), Home, End, automatic activation | All panels show in order, the tab list is hidden |
| `toolbar` | `rove` line | Left, Right, Home, End, one Tab stop | All controls reachable by Tab |
| `menubar` | `rove` line, a `boolean` per menu, `rove` inside | Left, Right, Down, Up, Enter, Space, Escape, Home, End, typeahead | Top items are links |
| `menu-button` | `popover` for open and close, `rove` inside | Enter, Space and Down open on the first item, Up on the last; Down, Up wrap, Home, End, typeahead, Escape returns focus | The popover still opens, items reached by Tab |
| `tooltip` | `boolean`, `focus`, `blur`, hover triggers with `delay`, `showWhen` | Shows on focus, Escape dismisses | Text stays as `aria-describedby` target, shown |
| `carousel` | `number` with `wrap`, `step`, bound `aria-live`, `every` with `if` | Previous, Next as buttons. Rotation stops on focus or hover, a pause control exists, none under reduced motion | All slides show in order, buttons hidden |
| `combobox` | `boolean`, `number` for the active option, `filter`, bound `aria-expanded` and `aria-activedescendant` | Down, Up, Enter, Escape, typing filters | A plain text input. A native `datalist` where suggestions matter |
| `feed` | `rove` line with `page-up`, `page-down` | Page Down, Page Up, Ctrl+End, Ctrl+Home | Articles in order |
| `grid` | `rove` grid | Arrows, Home, End, Ctrl+Home, Ctrl+End, Page Up, Page Down | A plain table |
| `treeview` | `boolean` per branch in its own scope, `rove` tree | Up, Down, Right opens or enters, Left closes or leaves, Home, End, typeahead, Enter | All branches open |
| `treegrid` | The same on rows, `rove` grid in cells | As tree plus cell arrows | All rows show |
| `slider-multithumb` | Two `input type="range"`, `setProp` writes each thumb's bound from the other | Arrows, Home, End, and thumbs cannot cross | Two sliders that may cross. The server clamps if the value is sent |
| `windowsplitter` | `number`, bound `aria-valuenow`, bound `--u-split`, `capturePointer` | Arrows, Home, End, Enter collapses | A fixed split at the initial value |

**Keys are logical where it matters.** `InlineEnd` and `InlineStart` resolve to the arrows against the
element's computed `direction`, so tabs work in a right-to-left language.

Also presets, all native and passing today, offered in the palette so a person finds them: accordion,
dialog, alert dialog, disclosure, switch, navigation menu (`menu-button` plus links).

**A contract in the score is the primary path, not the whole Guide page.** Each preset slice extends its
contract in `patterns.ts` to the full key list above and sets `built: 'behaviour'`. A pattern's tree comes
from its preset, so the score proves the preset rather than a hand-made tree. No contract is weakened.

**Corpus.** `radix-tabs` and `radix-dialog` are blocked by behaviour alone and should pass once their trees
use the presets. `radix-accordion` also needs selector slice 2. Expected, not proven.

## The editor canvas

The canvas shares a document with the editor, and the selector contract decided it never reacts to the
real pointer. That stays true in Select. The score's `canvas-editor-context` rows show why a second mode is
needed: Space pans, a link never navigates. "Closing it takes an interact mode on the canvas."

### Select: nothing runs, a state can be previewed

`EditorUIStore` gets a volatile `previewState: Record<stateId, value>`, the twin of `previewRule`.
`ComponentRenderer` writes `data-fcs-*` on scope nodes from the preview, or else from `initial`, and the
canvas sheet keeps the `when` selector as it is, with `!important` as for any canvas rule and without the
gate. So one selector serves every surface, and a state change is a React prop change rather than a sheet
rebuild.

- A row in the Page state panel has a value control that sets the preview. "Menu open" stays visible
  while its contents are styled.
- **Selecting a node hidden by `showWhen`,** from Layers, sets the preview that shows it when the condition
  is a plain `eq` chain, with a badge naming the state. Otherwise the panel says what hides it. Without
  this, content in a closed tab could not be edited.
- The preview is volatile: it never enters undo, and a reload returns to the initial values.

### Interact: the page runs, in the frame

A new tool in `EditorUIStore`, beside Select and Grab, in the toolbar. It is the only mode that closes
`canvas-editor-context`.

| Editor behaviour | In Interact |
|---|---|
| Runtime | `startBehaviour` per frame, `nodeAttr: 'data-inner-component-id'`, each frame with its own state |
| Click selection, drag, double-click to edit, marquee, selection outlines, spacing handles | Off. `ComponentRenderer` attaches none of its handlers |
| Space to pan, shortcuts in `EditorApp` | Yield when `e.target` is inside `[data-viewport-content-id]`. Outside a frame they work as usual |
| Escape | Goes to the page when focus is in a frame, so a dialog closes. With focus outside a frame it returns to Select |
| Same-document link (`#x`) | Keeps its default. The editor never reads the hash |
| Site path link | `sitePathOfClick` switches the editor to that page, as the preview does |
| Outside link | Opens a new tab, so the editor is never navigated away |
| A plain form's `submit` | Prevented, with a notice |
| Form and commerce islands | Stay in their `mode: 'editor'` form, showing what they do but not sending anything |
| Custom code | The tile, see below |
| Leaving the tool | Cleanup, then the frame's content remounts, so a `details` opened natively is closed again and nothing lingers |

**Ids across frames.** Each frame renders the same ids, so `commandfor`, `popovertarget` and `label for`
resolve to the first frame. A small capture shim in Interact handles those three and acts on the element
inside the same frame. The test uses two frames.

**Top-layer elements leave the frame.** A native modal renders above the whole editor at full size and
makes the panels inert until Escape. Stated rather than rewritten: replacing the top layer would mean the
canvas no longer tests what the published page does.

**`landmarks` is closed by a markup change.** A `header` inside `main` is not a banner, and
`Canvas.tsx` wraps the canvas in `<main>`. No mode can fix this, so that shell becomes
`<div role="region" aria-label="Canvas">`. The slice proves it in Chromium; if a role on an ancestor still
scopes the header, the role goes too.

**The preview surface** runs the runtime on `PreviewFrame`'s frame, keeps real pointer and focus, and does
not need the tool.

**Effects on editing:** runtime writes never touch MobX-State-Tree, so Interact cannot dirty a page or add
an undo step. A panel edit during Interact restarts the runtime with the new program.

**Stateful paths** (the stateful flow standard):

- Forward: declare `menuOpen`, add a trigger and `showWhen`, press Interact, click, see it open, publish,
  see the same.
- Backtrack: deleting a state marks each referring entry refused, visibly; undo restores all of it in one
  step. Renaming changes nothing else, since references use the id. Changing a `choice`'s options keeps a
  preview only if the value is still an option.
- Resume: state and preview are volatile, so a reload is the initial page, with the tool back on Select.
- Re-entry: the selected node vanishing or the page changing during Interact restarts the runtime on what
  exists; leaving and entering again starts from initial values.

## The panel

**Page state.** A panel listing the root's values, and the values of the selected node's scopes under
their names: name, type, initial value, a preview control. Adding a value to a selected row or component
is one menu item, "Keep per row".

**Interactions.** A section for the selected node. A row reads "On click, toggle menuOpen". On lists Click,
Mouse enter, Mouse leave, Focus, Keys and Appears first, then "All events" with every name. Actions are
pickers rather than text, and a refused entry shows its reason, editable and deletable. "Show when" lives
in the same section, with a "Without JavaScript" switch.

The Delay, Once or Cycle controls of the popover in the components contract map to `delay`, `set` and
`step` with `wrap`. Drag-to-connect writes the same data.

**Touch and keyboard:** both sections work in the phone sheet, controls are native, and motion in the panel
follows the design rules.

Credit is labelled as in the selector contract. A panel cell closed by the "All events" list carries the
note `raw field`.

## The 100 event handler rows

Today a row asks whether a stored string reaches the opening tag, which is the wrong question: the answer
must stay no. The row changes to: **does a stored action bound to this event run in Chromium, from a real
cause, with no `dispatchEvent`?** `test/score/lib/eventProofs.ts` lists, per event, a tree, the cause (a
Playwright gesture, a real media file, a real navigation) and the effect to observe, and a new
`events.score.ts` runs them. The cell cannot pass by wiring alone.

| Group | Rows | Count | Result |
|---|---|---|---|
| Pointer and mouse | `auxclick`, `click`, `contextmenu`, `dblclick`, `mousedown`, `mouseenter`, `mouseleave`, `mousemove`, `mouseout`, `mouseover`, `mouseup`, `pointerdown`, `pointerenter`, `pointerleave`, `pointermove`, `pointerout`, `pointerover`, `pointerup`, `pointercancel`, `gotpointercapture`, `lostpointercapture`, `wheel` | 22 | Close |
| Keyboard, focus, editing | `keydown`, `keyup`, `focus`, `blur`, `input`, `beforeinput`, `change`, `select`, `selectionchange`, `copy`, `cut`, `paste` | 12 | Close |
| Forms | `submit`, `reset`, `formdata`, `invalid` | 4 | Close |
| Open and close | `toggle`, `beforetoggle`, `cancel`, `close`, `command`, `beforematch` | 6 | Close |
| Drag | `drag`, `dragstart`, `dragend`, `dragenter`, `dragleave`, `dragover`, `drop` | 7 | Close |
| Motion | `animationstart`, `animationend`, `animationiteration`, `animationcancel`, `transitionrun`, `transitionstart`, `transitionend`, `transitioncancel` | 8 | Close, caused by state rules |
| Scrolling and layout | `scroll`, `scrollend`, `scrollsnapchange`, `scrollsnapchanging`, `contentvisibilityautostatechange` | 5 | Close |
| Loading | `load`, `error` | 2 | Close |
| Media | `abort`, `canplay`, `canplaythrough`, `durationchange`, `emptied`, `ended`, `loadeddata`, `loadedmetadata`, `loadstart`, `pause`, `play`, `playing`, `progress`, `ratechange`, `resize`, `seeked`, `seeking`, `stalled`, `suspend`, `timeupdate`, `volumechange`, `cuechange` | 22 | Close, a generated sound or video as fixture |
| Display | `fullscreenchange`, `fullscreenerror`, `enterpictureinpicture`, `leavepictureinpicture` | 4 | Close |
| **Subtotal** | | **92** | Heard in the probe, by real cause |
| With the custom code slices | `securitypolicyviolation` | 1 | A real cause exists only on a page with a policy. A page with a custom block has one, and a frame trying to leave produces the event. Published and canvas count it from slice C5 |
| Labelled `custom code` | `contextlost`, `contextrestored` | 2 | They need a drawing context, which only script can make, so only a frame can reach them. Proof inside a frame, counted apart in `report.ts` |
| **Stay red** | `beforexrselect`, `encrypted`, `waitingforkey`, `slotchange`, `waiting` | 5 | See below |

**Why the five stay failing,** with the note carried in the cell:

- `beforexrselect` needs an immersive session and a device.
- `encrypted` and `waitingforkey` need encrypted media and a key system. The format has neither, and a page
  that plays such media needs a provider's licence server.
- `slotchange` is not composed: the probe heard it on the shadow root and not on `document`. Reaching it
  means walking open shadow roots in the runtime, which is not worth its bytes for one row. Exactly this
  sort of row is what custom code is for, except that a frame cannot see the page's shadow roots, so it
  stays red.
- `waiting` did not fire in the probe. The slice tries cutting a stream mid-file. If that gives a real
  cause, the row closes and this list is corrected; a row is never closed by a synthetic event.

So no row passes by a false route, and `blocked-event-handlers` stays the gap name for what remains.
`report.ts` rewrites the meaning of the row, and its "What this does not measure yet" line about handlers
that would run goes away.

**Interact counts too.** The canvas cell runs the same proof on the mounted editor in the Interact tool. A
row that fails there stays `canvas-editor-context` with a note, and the ceiling below assumes none does.
That is unproven.

## Sandboxed custom code

Decided by Marlin on 2026-11-01: allowed, sandboxed, off by default and clearly marked. **Everything in
this section waits for his security review, see the list after it.**

What it is for: what the behaviour model cannot do, such as a canvas drawing, a calculator with real logic,
or a small simulation. A block is a node whose element is a frame holding the author's document.

### Threat model

| Actor | Wants | Against |
|---|---|---|
| A workspace admin, malicious or with a stolen session | Reach beyond their own site | The session cookie, the editor, other tenants, the platform's domain reputation |
| The same admin | Abuse their own visitors | Tracking, phishing, freezing the page |
| A workspace member | Reach a stronger colleague | Whoever opens the page in the editor |
| An AI generator or a page import, steered by content | Plant code | Everything above, with nobody having chosen it |
| A visitor | Attack through input the code handles | Stays inside the frame |

**Assets:** `lumitra_session`, an apex `.lumitra.co` cookie sent to every `*.sites.lumitra.co` by decision
D2 in `middleware.ts`. The editor at `app.lumitra.co`. Site-origin routes (`/api/commerce`, `/api/forms`,
`/api/cms`) and what a site stores in its origin: the cart, form drafts, the consent choice. All sites
share one registrable domain, so they are same-site to each other and to the editor.

**Not defended:** what an author can already do without code. Plain styles can already cover the consent
banner, as the selector contract states. A site's author can show visitors anything inside their own
page, and the frame is no worse.

### Isolation

| Layer | What it is | Why |
|---|---|---|
| **Separate registrable domain** | `run.<sandbox-domain>`, never under `lumitra.co` | The apex cookie reached a sandbox host under the same domain, through a sandboxed frame, and did not reach a separate one. Also keeps a phishing report from blocklisting `lumitra.co` |
| **`sandbox` in the response header** | `Content-Security-Policy: sandbox allow-scripts` on the document itself, and the same on the iframe | A direct visit stayed opaque. The attribute alone would leave code running with a real origin there. `allow-same-origin` never appears |
| **Opaque origin** | Measured `null` | No storage, no same-origin access to anything |
| **One host, not one per site** | Origin is opaque, so a subdomain per site adds no isolation | Saves a wildcard certificate. Tenants never share a page |
| **Parent `frame-src`** | A policy with only this directive on any page with a block, so it blocks no images and breaks nothing else | The only control measured to stop self-navigation, in both engines. `<meta http-equiv>` and the header both worked. The slice proves it on the real published route, since React must place the tag in `head` |
| **`frame-ancestors`** | Lists the site's own hosts plus the editor host | Tenant A's code cannot be framed by tenant B. The editor host is there for the standalone preview, whose route is session-gated by `middleware.ts`, and it gains nothing from the frame, which is opaque and cross-site |

### The frame

`GET https://run.<sandbox-domain>/box/<siteId>/<sha256>` returns one document: a constant shell, then the
author's code. Every value in the headers is constant except the ancestors list. The catalog images route
is the precedent for content-hash serving.

```text
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none';
  form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'; object-src 'none';
  webrtc 'block'; frame-ancestors <the site's hosts> <the editor host>
Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=()
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Resource-Policy: cross-origin
Cache-Control: public, max-age=300
```

The short cache is what lets a kill switch or a changed domain list arrive within five minutes.

`script-src 'unsafe-inline'` looks wrong and is deliberate: the document holds nothing but the author's own
code, so the policy limits what the document reaches, not what it runs. No `unsafe-eval` in this version,
because it was not probed.

**The shell** runs first and deletes `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel`,
`RTCIceTransport`, `RTCSessionDescription` and `RTCIceCandidate`. This took STUN packets to zero in both
engines, while `webrtc 'block'` stopped nothing. It is a mitigation, not a boundary. It holds only while no
fresh JavaScript realm is reachable. `frame-src 'none'` and `worker-src 'none'` closed the realms tried,
which is not a proof that no other exists. `webrtc 'block'` stays in the policy for browsers that honour
it.

**Therefore no isolation claim in this contract depends on it.** What leaks if it fails is limited to what
a frame holds: the visitor's address, and what they typed into that frame.

### What it can reach

Nothing by default. A block declares what it may touch, and a broker in the parent page's behaviour runtime
enforces that. The declaration is `props.customCode` on an ordinary `div` node. That prop is what the
renderers dispatch on, ahead of the island checks, and it never reaches the DOM.

```ts
/** props.customCode */
interface StoredCustomCode {
  sha256: string;             // never the code itself
  title: string;              // required: the frame's accessible name
  reads?: string[];           // state ids sent to the frame on change
  writes?: string[];          // state ids it may set, checked against their type
  emits?: string[];           // custom:<name> events it may fire
}
```

- **The bridge:** on the frame's `load`, the parent checks nothing about origin, which is `null`. It checks
  `e.source === iframe.contentWindow`, then transfers a `MessageChannel` port. Everything after runs on that
  port.
- **Messages:** `state`, `setState`, `emit`, `resize`, `ping`. A message with an undeclared id, the wrong
  type or an unknown kind is dropped with a console warning. At most 64 kilobytes each and 30 per second.
- **No navigation, no DOM, no direct action.** A frame can only fire a declared event. What happens next is
  a trigger the author stored as data, in the open, with a literal address.
- `text` state is never sent to a frame unless declared in `reads`, and the panel names that as "this code
  can read what visitors type here".

### Size limits

256 kilobytes per block, 4 blocks per page, 1 megabyte of live blobs per site, 10,000 pixels of height
from `resize`. Refused at the guarded route with a reason, and a page with too many blocks renders
the first four and warns. Assets go inline as `data:` addresses, inside the same limit.

### What stops it

| Stop | How |
|---|---|
| **Off by default** | `Site.customCodeEnabled`, a new column, default false. Not in `siteSettings`, which travels through the opaque save and which `editSite` can write. Only a new route guarded by a new `manageCustomCode` action sets it |
| **Code cannot enter through a save** | The node stores a hash. Code enters only through a guarded `POST`, into a new table `CustomCodeBlob(siteId, sha256, text, createdBy, createdAt)`. A hash in a node with no blob for that site renders the tile. So the opaque save route, which is how stored script once reached published pages, cannot carry code at all |
| **Tenant crossing** | The frame's address is built from the rendering site's id and the hash, never from stored text. Site B naming site A's hash finds no blob |
| **Render** | `createCustomCodeElement(surface)` is the only emitter of an iframe, and `iframe` stays in `BLOCKED_TAGS` for stored nodes. A stored `src` is ignored, the `sandbox` value is a constant, a test holds each |
| **Platform kill switch** | `CUSTOM_CODE_DISABLED` in the deploy env. Every block renders its fallback and the route answers 410 |
| **A frame that freezes** | `ping` every 5 seconds. Three missed: the broker removes the frame and shows the fallback. In WebKit, and in any browser without isolation for this frame, a frozen frame froze the parent too (3,004 ms measured) and no watchdog can run. The damage is to the author's own page |

### On the editor

**Custom code never runs in the editor document, in any mode.** `createCustomCodeElement('editor')` gives a
tile of the block's declared size, like the sticky bar's editor surface: striped, labelled "Custom code, not
run here", with the title and a button that opens the standalone preview. It mounts no frame on the canvas,
in Interact, or in the in-editor preview. A test asserts no `iframe` in the mounted editor with a block on
the page.

**The standalone preview tab** (`/projects/<id>/preview`) runs blocks with the same frame and policy as a
published page. A blob is served by hash whether or not it is published, which is what lets a draft preview
work without a token: the hash is not guessable and is known only to those who read the page. Because the
tab is on the editor host, it carries the same `frame-src`. An opaque, cross-site frame gains nothing from
the viewer being an admin, which is the answer to the "stronger colleague" row.

### Clearly marked

- The Layers row and the canvas tile carry a badge, in both tools.
- A site with blocks shows it in Site settings, with who enabled it and when.
- The publish dialog lists each block on the pages going out, with its title and who last changed it.
- A block's panel states in words what the code can read, write and fire.
- Published markup carries `data-fc-custom-code` so a report can be traced to a site.
- Audit: enabling, disabling and each new blob write a line.

### Consent

With no network and no storage, the frame stores nothing on the device, so section 25 of the German TDDDG
(the telecommunications and digital services privacy law) has nothing to attach to, and nothing reaches a
third party. The frame's request goes to Lumitra's own infrastructure, on a different domain, so the privacy
page template should say so. This is a reading, not legal advice, and it depends on the WebRTC mitigation
above.

**Network is out of this version.** A declared host list would add `connect-src` and needs a new consent
category, a `CONSENT_VERSION` bump, a banner on sites that have none today, and a loaded-only-after-consent
frame. That is its own plan.

**Embedded content stays out too.** `iframe`, `object` and `embed` from another host (a map, a video) are
not custom code, and a frame with no network cannot hold them. The 78 cells of `blocked-embedded-content`
stay red until a consent-gated embed primitive is decided.

### No JavaScript, and fallback

A block's children are ordinary nodes, rendered inside the frame's wrapper and shown when the frame is not:
scripts off, kill switch, site setting off, refused hash, watchdog. So a block always has something to show,
and an author is told to fill it.

## Needs Marlin's security review

The fleet plan stops for "the sandbox's security design, and any change to auth or tenant isolation". Each
item has the recommended default. Slices C1 to C5 do not start until these are answered.

1. **Register a separate domain.** Spends real money, and its name is his. Recommended: a short neutral
   `.com`, no cookies ever. The apex cookie result makes this non-negotiable in substance.
2. **Serve it from the same Next app, or a separate service.** Recommended: same app, with the reverse proxy
   allowing only `/box/*` on that host and the route refusing any other host. A separate service is stronger
   and adds a deployment to run. No cookie reaches this host either way.
3. **Who may enable it.** Every mutation is `workspace.admin` today, so `manageCustomCode` would be the same
   people as `editSite`. It adds the deliberate step and the audit line, not a higher bar. Recommended for
   now, with a stricter role when the role model has one. This is a change to the permission model.
4. **Accept the WebRTC residual.** Recommended: accept, since it is privacy-grade, not isolation-grade.
5. **Accept the freeze in WebKit and without isolation.** Recommended: accept, since it harms only the
   author's page.
6. **A `frame-src` policy on published pages.** The first policy on those pages, on pages with a block only.
   It does not answer the selector contract's open question 1, and it does not rule it out.
7. **A `CustomCodeBlob` table and a `Site.customCodeEnabled` column.** A production migration, so a one-line
   yes.
8. **The standalone preview on the editor host.** Recommended as written. The strict alternative is preview
   only on the published site.
9. **Retention and takedown.** Who removes abusive code, and whether old blobs are kept for evidence.
   Recommended: keep while referenced by any revision, use the audit log for takedown.
10. **Terms and privacy wording.** The privacy template gains a line, and the terms of use probably should
    too. Legal, so his.

## AI output

The validator gains `behaviour` through `parseBehaviour`, and everything parseable is accepted, which is
what closes the column.

- **The generator is taught presets, not primitives.** A generated node may be
  `{ preset: 'tabs', items: [...] }`, which the validator expands through the same function as the palette.
  Hand-written roving focus from a model is how a keyboard contract goes subtly wrong.
- `schemaDocs` also teaches one simple form: toggle a value, show when. Nothing else.
- `MAX_GENERATED_TRIGGERS` of 24 per generation, as appear effects are capped.
- Motion rules hold for generated output: `every` is refused, so nothing rotates by itself unasked.
- **`customCode` is dropped with a warning, always,** by the validator and `ai/review/ops.ts`. A generator
  reads content, and content can carry instructions, so it never writes code. Only a person, through the
  guarded route.

## React import and export

Step 7 builds this; the contract says what it targets. `parseBehaviour` is the single entry, as
`parseCssText` is for CSS.

| Source | Becomes |
|---|---|
| `useState(false)` with `onClick={() => setOpen(!open)}` | `boolean` state, `toggle` |
| `useState` with a string union or a number | `choice` or `number` |
| `{open && <Panel />}`, `open ? a : b` | `showWhen` |
| `aria-expanded={open}` and friends | A binding |
| `className={cn(..., open && 'x')}` | A `when` rule, through Tailwind's compiler |
| `data-state={open ? 'open' : 'closed'}` with `data-[state=open]:` classes | A `when` rule |
| `useState` at a component root | Scoped state on the reusable component |
| `@radix-ui/react-tabs`, `-accordion`, `-dialog`, `-menu`, `-tooltip` imports | The matching preset, its props as options |
| `useEffect`, fetching, refs, arbitrary handlers | **Reported line by line,** never dropped, per the plan: rewrite it, or accept a custom code block by a person's explicit choice |

Measured match, not a promise: the browser render of the original stays the reference.

**Export:** `behaviour` is a named prop in the normalised round-trip form, like bindings. Real React output
is step 7's.

## Score changes

These belong to the slices, and they make the probes stricter. None removes a test.

- **`probeEventHandler`** stops reading the opening tag, and its cells come from `events.score.ts`. A string
  handler reaching the page remains a failure: a new test in `blockedNodes.test.tsx` holds this.
- **`patterns.ts`** gains `built: 'behaviour'`, trees from presets, longer contracts.
- **`patterns.score.ts`** enters the Interact tool before the canvas contract, and a `behaviour` key counts
  for the panel only when the palette inserts that preset, so swapping a tree cannot drop a panel cell.
- **`lib/types.ts`:** `canvas-editor-context` keeps its name, its text updated.
- **`report.ts`** counts `raw field` and `custom code` notes apart.
- **`matrix.canvas.score.tsx`:** the event row reads `events.score.ts` too.
- **`corpus/fixtures.ts`:** the three Radix trees use presets.
- **`samples.json`** keeps `eventHandlersWithoutSpecLink`, unchanged.

## Slices

Each is one file-scoped pull request, green alone, raising `baseline.json` where a number rises. Row counts
are cells gained; a pull request states the real figure. The fleet plan estimated 8 slices here and 3 for
the sandbox. These are 13 and 5: the canvas, the panel and the event proofs were not in that estimate.

B2 waits for selector slice 3 and B9 for selector slice 6, as the table says. C1 to C5 wait for the review
above, and nothing in B1 to B13 waits for it.

| # | Slice | Files | Tag | Depends on | Closes |
|---|---|---|---|---|---|
| B1 | `behaviour-format` | `src/lib/behaviour/format.ts` and tests, `ComponentModel.ts`, `PageModel.ts`, `renderComponentNode.tsx` | `renderer` | none | No row. Unit tests over every refusal in this document |
| B2 | `behaviour-compile` | `src/lib/behaviour/applyBehaviour.ts`, `src/lib/rules/rules.ts`, `responsiveCss.ts`, `renderPublishedPage.tsx`, boot script | | B1, selector 3 | No row. Byte-identical output with no behaviour, the gate and its timeout, no-JavaScript in Chromium |
| B3 | `behaviour-runtime` | `src/lib/behaviour/runtime.ts`, `src/lib/renderer/server/BehaviourIsland.tsx`, size test | | B2 | No row. State, focus, flow verbs. Attribute and text writes before hydration, in Chromium |
| B4 | `behaviour-dom-verbs` | `runtime.ts`, `src/lib/behaviour/rove.ts`, tests | | B3 | No row. `rove` on all three axes, the native, media and value actions, right to left |
| B5 | `behaviour-event-proofs` | `test/score/lib/eventProofs.ts`, `test/score/events.score.ts`, `matrix.published.score.ts`, `report.ts`, fixtures | | B4 | Format and published for 92 event rows (184 cells). `waiting` tried |
| B6 | `presets-tabs-family` | `presets/tabs.ts`, `toolbar.ts`, `tooltip.ts`, `carousel.ts`, `ComponentsPanel`, `patterns.ts`, `corpus/fixtures.ts` | | B4 | Published for `tabs`, `toolbar`, `tooltip`, `carousel`. Fixture `radix-tabs` |
| B7 | `presets-menu-family` | `presets/menu.ts`, `menubar.ts`, `combobox.ts`, `slider.ts`, `splitter.ts`, `patterns.ts`, `corpus/fixtures.ts` | | B6 | Published for `menu-button`, `menubar`, `combobox`, `slider-multithumb`, `windowsplitter`. Fixture `radix-dialog`, the native dialog preset |
| B8 | `presets-structure-family` | `presets/feed.ts`, `grid.ts`, `tree.ts`, `patterns.ts` | | B6 | Published for `feed`, `grid`, `treeview`, `treegrid`. With B6 and B7, all 30 on the page |
| B9 | `canvas-preview-state` | `EditorUIStore.ts`, `ComponentRenderer.tsx`, `CanvasRuleStyles.tsx`, `src/lib/rules/surfaces.ts`, `PreviewFrame.tsx`, `ResponsivePageRenderer.tsx` | | B3, selector 6 | No row. Preview in two frames, reveal from Layers, preview surface runs |
| B10 | `canvas-interact` | `EditorUIStore.ts`, `EditorApp.tsx`, `ComponentRenderer.tsx`, `Canvas.tsx`, `Toolbar.tsx`, `HudSurface.tsx`, `src/lib/canvas/interactShim.ts`, `patterns.score.ts`, `matrix.canvas.score.tsx` | | B5, B8, B9 | Canvas for the 13 patterns, the 4 `canvas-editor-context` rows, and up to 92 event rows. Stateful paths in tests. Two frames, leaving resets, no save marked dirty |
| B11 | `panel-interactions` | `PageStatePanel.tsx`, `InteractionsSection.tsx`, `RightSidebar.tsx`, `matrix.panel.jsdom.score.tsx`, `report.ts` | | B10 | Panel for 92 event rows, labelled `raw field`. All four stateful paths |
| B12 | `ai-behaviour` | `validate.ts`, `ai/review/ops.ts`, `promptSections`, goldens, `report.ts` | | B8, `fleet-ai-allowlists` | AI for 92 event rows, labelled `accepted, not taught`, and the pattern rows. `customCode` refused |
| B13 | `behaviour-round-trip` | `test/score/roundtrip/jsx.ts`, `roundtrip.score.ts` | | B2 | New cases: state, a trigger, a refused entry. Import of hooks stays with step 7 |
| C1 | `sandbox-host` | `prisma` migration, `src/app/box/[siteId]/[sha256]/route.ts`, `middleware.ts`, `deploy/README.md`, tests | | **Review, items 1, 2, 7** | No row. Headers exact, wrong host refused, unknown hash 404, kill switch 410. `pnpm test:integration` |
| C2 | `sandbox-element` | `src/lib/customCode/element.tsx`, `createComponentElement.tsx`, `renderComponentNode.tsx`, `renderPublishedPage.tsx`, tile | `renderer` | C1, **items 6, 8** | No row. Stored `src` ignored, fallback in every failure, parent `frame-src` on a real published route, no iframe in the mounted editor |
| C3 | `sandbox-bridge` | `src/lib/customCode/broker.ts`, `runtime.ts`, tests | | C2, B4 | No row. Source check, port, typed writes, rate cap, watchdog |
| C4 | `sandbox-panel` | Guarded routes, `permissions.ts`, `CustomCodeSection.tsx`, `SiteSettingsDialog.tsx`, publish dialog, audit, `validate.ts` | | C3, B11, **items 3, 9, 10** | No row. All marks. All four stateful paths. `pnpm test:integration` |
| C5 | `sandbox-escape-suite` | `test/sandbox/escape.spec.ts`, a path-filtered workflow, `events.score.ts`, `report.ts`, `exclusions.json`, `samples.json` | | C4 | Every probe in this document permanent, in Chromium and WebKit. Event row `securitypolicyviolation`. Labelled `custom code`: `contextlost`, `contextrestored`, and the 6 selector rows the selector contract promised back |

**Why a second browser here,** when the selector contract kept seven rows out of continuous integration
rather than add one: this is a security boundary and two probes differ by engine. The job runs only when
`src/lib/customCode`, the box route or the suite changes, so the five-minute rule holds elsewhere.

Only B1 and C2 touch the two renderer files. B2 to B5 share `runtime.ts`, so the operator runs them in order.
B6 is the first slice a person can see working.

**What the slices add,** as ceilings over the selector contract's "After" table, out of 1,832 rows:

| Column | After selectors | Added here | After this | Percent | What is left |
|---|---|---|---|---|---|
| Format | 1,718 | 93 | 1,811 | 98.9 | 5 red events, 2 custom code rows, 14 `page-level-css` |
| Published page | 1,678 | 93 + 13 | 1,784 | 97.4 | Those, blocked embeds, element attributes |
| Canvas | 1,664 | 93 + 13 + 4 | 1,774 | 96.8 | Those, the mounted editor's other differences. Assumes every event proof holds in Interact |
| Panel | | 92 | | | Own slices (`raw field`) |
| AI | | 92 + 29 | | | Depends on `fleet-ai-allowlists` |
| Corpus | | 2 | | | `radix-tabs`, `radix-dialog`. Expected, not proven |

Labelled `custom code` cells are outside these numbers. With them, Format reaches 1,813 of 1,832, before
the 6 returning rows grow the list. So format, page and canvas clear the fleet's 95 percent, which the
primitives plan said event rows alone would stop. **A matrix pass proves less than it reads:** a row says one
event ran one action once. The patterns and the corpus are what count.

## What this does not cover

- **Component states and drag-to-connect:** the components contract. It compiles to `choice` state, `when`
  rules and scopes as defined here.
- **Network in custom code, consent-gated embeds, persisted state,** each its own plan.
- **Commerce and form values as named state,** such as a cart count. Islands own those.
- **Bindings in state:** initial values are literals.
- **Scroll-driven pages,** the separate opt-in roadmap line.
- **Page-level script:** `head` items stay gap 5 of the primitives plan, and a block is always a node.

## Decided here, say so if you disagree

The fleet plan gives contracts to a fresh review agent before fan-out. These do not wait for Marlin; the
security list above does.

1. `props.behaviour` as one object rather than separate props.
2. State on nodes, with the root as page state, rather than a page field.
3. A closed action list with no `click`, `fetch` or free attribute writes.
4. Visual state through CSS `when` with zero added specificity, semantics through bindings.
5. `hidden` is not bindable, so hiding cannot break no-JavaScript.
6. A React island delivers the runtime, not a separate static script. Clicks before it starts are not
   replayed.
7. Values are memory only.
8. `text` state is never reflected.
9. An Interact tool, a volatile preview in Select, and state per frame.
10. `Canvas.tsx`'s `<main>` becomes a `div`, trading the editor's own landmark for the right answer about the
    page inside it.
11. Event rows need a real cause, five stay red, and there is no synthetic pass.
12. Presets expand to ordinary nodes, native elements first.
13. The AI generator is taught presets and never writes custom code.
14. Effects are not subsumed.

## Open questions

1. **For the review agent:** whether 8 kilobytes gzipped holds once `rove` covers all three axes. The budget
   is a judgement, and raising it needs a reason in the pull request.
2. **For Marlin, later:** whether custom code gets a network, once the first version has been used. Not needed
   by any slice here.
3. **Unproven and listed so nobody assumes otherwise:** Firefox, iOS and Android browsers, HTTPS, a frame on a
   real custom domain, and the selective hydration order of a real streamed page. Slice C5 covers WebKit and
   Chromium only.
