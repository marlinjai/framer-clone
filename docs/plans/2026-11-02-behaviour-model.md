---
type: plan
status: draft
date: 2026-11-02
title: "The behaviour model: page state, events and actions as data, and sandboxed custom code"
summary: "How a node stores behaviour without ever storing code: typed state values, triggers for real browser events, a closed action list frozen after prototyping the hardest presets in three engines, compiled to a runtime a page without behaviour never loads. Thirteen failing interaction patterns become presets. Of the 100 event handler rows, 92 are expected to close on a real cause and one more on published pages, 2 are labelled as reachable only by custom code, and 5 stay red with a reason. Custom code runs in a separate small service on a separate registrable domain, off by default, never in the editor. Revised after an independent review that found seven stated guarantees false. The sandbox slices stay blocked until Marlin decides M1 to M10."
tags: [framer-clone, primitives, behaviour, state, wai-aria, custom-code, sandbox, security, fleet]
projects: [framer-clone]
---

# The behaviour model

This is step 6 of the [complete primitives plan](2026-11-01-complete-primitives.md), layer 3 of its
"Visual state management", and the sandbox design its decision 1 calls for: custom code on customer
sites is allowed, sandboxed, off by default and clearly marked. It builds on the
[selector contract](2026-11-02-selector-styling.md). Layer 2, the
[reusable components contract](2026-11-02-reusable-components.md), compiles to it, as "How a component
state compiles" defines.

Read against commit `fc32fc1`. Revised after the independent review of 2026-11-02
(`~/software-dev/decision-pages/2026-11-02-behaviour-model-review.md`, findings 1 to 22, probes beside it),
which found seven stated guarantees false as written. Every finding is applied here except the ones under
"Review findings not adopted", each with the code or test that decides it.

It covers the 13 failing rows of the 30 interaction patterns from the Accessible Rich Internet Applications
Authoring Practices (WAI-ARIA, the web standard's catalogue of accordions, tabs, dialogs and so on), the 4
cells the mounted editor loses, the 100 event handler rows that fail in all five columns, and fixtures
`radix-tabs`, `radix-dialog` and `radix-accordion`.

## The decisions

1. **One new prop, `props.behaviour`, beside `style`, `rules` and `effects`.** It declares state, triggers,
   bindings, focus groups and visibility, and it never reaches the Document Object Model (DOM).
2. **State lives on a node, and the node is its scope. Every clone root and placement root is a scope too,
   with or without state.** A value declared on the page root is page state. Target resolution walks scopes,
   so a trigger in row 5 finds row 5's target.
3. **Events and actions are data, and the action list is closed.** No expression is ever a string of code.
   Nothing calls `eval` or `new Function`. A stored `on*` handler stays dropped by `blockedNodes.ts`. The list
   below was frozen after the seven hardest presets were built from it and run.
4. **State renders through two paths.** Visual differences are CSS, a `when` condition on `SelectorRule`.
   Semantics (`aria-*`) are attributes the server writes for the initial value and the runtime keeps current.
   What only makes sense with the runtime, such as a roving `tabindex`, only the runtime writes.
5. **The runtime is one constant module, fetched by a small island with a dynamic import.** A page with no
   trigger and no custom code block fetches no byte of it, proven by counting bytes over the network. The
   stored program is a data table passed as props.
6. **Without JavaScript the content stays reachable, and the page does not lie.** A rule that hides by state
   applies only behind a gate an inline script sets. A control that needs the script is hidden without it.
7. **No action carries what a visitor types off the page, and a taint rule enforces it.** Typed values can
   flow only into `text` state, a `text` binding and `filter`. This is a limit on behaviour, not a guarantee
   about the page: an author who also controls CSS keeps the residual route below, and only a Content Security
   Policy on published pages closes that (M5).
8. **The canvas has two modes.** In Select nothing runs and a volatile preview shows a chosen state, so hidden
   content can be edited. A new Interact tool runs the page and gives it the keyboard, with one chord that
   never yields.
9. **An event row passes only on a real cause.** A stored action must run in Chromium with no `dispatchEvent`
   anywhere. Five rows stay red, each with its reason.
10. **Custom code runs in a frame with an opaque origin, from a separate small service on a separate
    registrable domain, never in the editor document.** It has no storage and no fetch. It is not free of
    network: see the preconnect residual. Code and what it may touch enter only through one guarded route.
    Slices C1 to C5 stay blocked until Marlin decides M1 to M10.

## What the browsers do, measured

Every claim this contract rests on was run. Environment: Playwright 1.64.1 with Chromium build 1248, WebKit
build 2370 and Firefox 157 (build 1555), React 19.1.9 and Next 15.5.28 production builds, plain HTTP on
loopback, 2026-11-02. Not tested: HTTPS, real Safari, phones, the real published route, the real save route.
The review's scripts are in its probes folder, and slice C5 makes the sandbox ones permanent. The preset prototype is kept at
`~/software-dev/decision-pages/2026-11-02-behaviour-presets-prototype/`.

**Hydration.** A runtime can touch the page before React attaches to it. The published page hydrates a real
streamed route, which these did not exercise.

| Change made before hydration | Result, after hydration and after a re-render |
|---|---|
| Attribute changed or added | Kept both times, no error |
| Text in a `suppressHydrationWarning` element with one text child | Kept both times, no error |
| Text in a plain element | React error 418: the **whole root was rebuilt**, every other mark lost |
| Text in a `suppressHydrationWarning` element with two adjacent text children | Error 418: the sibling was replaced, an attribute lost |

**The sandboxed frame,** with the headers under "The frame". Parent on `localhost`, frame on `127.0.0.1`.

| Channel | Chromium | WebKit | Firefox | Control |
|---|---|---|---|---|
| `fetch`, beacon, WebSocket, EventSource, WebTransport, `prefetch`, `preload`, CSS `@import`, images, fonts, media, `object`, `embed`, `ping`, speculation rules | No request | No request | No request | The frame's Content Security Policy (CSP, the browser's own list of what a document may load) |
| Worker, `SharedWorker` | Refused | Refused | Refused | `worker-src 'none'` |
| `document.cookie`, `localStorage`, IndexedDB | Throw | Throw | Throw | Opaque origin |
| `top.location`, sibling navigation, `window.open`, `alert`, fullscreen | Blocked | Blocked | Blocked | Sandbox flags |
| Two blocks over `BroadcastChannel` | Silent | Silent | Silent | Opaque origin |
| **Frame navigates itself** | **Reached the sink** | **Reached the sink** | **Reached the sink** | Needs `frame-src` on the **parent** |
| The same with parent `frame-src` | Blocked | Blocked | Blocked | Parent policy, and `securitypolicyviolation` fires there |
| **WebRTC to a STUN server** (a helper for real-time connections, reached with raw packets) | **4 packets, despite `webrtc 'block'`** | **2 packets** | Control sent 0, unproven | None in CSP |
| The same, constructors deleted before author code runs | 0 | 0 | Unproven | Shell script |
| **`preconnect`, `dns-prefetch` to a host name carrying data** | Could not be observed | **A real connection under `default-src 'none'`** | **The host name was resolved** | None. `X-DNS-Prefetch-Control: off` cut Firefox's `dns-prefetch` from 14 log lines to 0 and preconnect from 15 to 2 |
| **Direct visit to the frame's address** | **Navigation out reached the sink** | Same | Same | Refuse unless `Sec-Fetch-Dest: iframe` and `Sec-Fetch-Site: cross-site`, which all three sent in a frame and not on a visit |
| **Parent `frame-src <host>`, frame reloading itself** | 238 requests in 2 seconds | 217, history grew to 100 entries | | Path limit, no query, rate limit, one port per mount |
| **`<meta>` policy inside `Suspense`** | **Ignored, frame still rendered** | | | A response header |
| Frame blocking its thread for 3 seconds | Parent gap 18 to 53 ms with site isolation on, 3,004 ms with Playwright's default off | **Parent gap 3,004 ms** | **Frozen in Playwright's build** | None |
| A frame calling `input.focus()` on a timer | **Took the keyboard from a parent input** | Refused | **Took it** | A broker watch |

**Cookie transport.** Chromium only, hosts mapped to `.test`, an `HttpOnly` probe cookie on the apex standing in
for `lumitra_session` on `.lumitra.co`. A sandboxed iframe on `acme.sites.lumitra.test` loading
`run.lumitra.test` **sent the cookie**. The same frame on `run.sandbox-other.test` sent none.

**Client chunks.** A production Next build: a client component imported statically by a shared render module
reached a route that never rendered it, because all client components of a route land in its page chunk.

**Events, Chromium only.** One capture listener per event name, real input, no `dispatchEvent`, heard 92 of
100 rows, among them `load`, `error`, `scroll` and the media events, which do not bubble. Heard is not run: a
stored action on a stored node is what slice B5 proves, so those 92 are **expected**.

**The presets, all three engines.** See "Prototyped before freezing".

## The stored shape

```ts
/** props.behaviour: absent when empty, so a saved page stays unchanged. */
interface StoredBehaviour {
  state?: StateValue[];       // this node is a scope for these values
  on?: Trigger[];             // what happens here
  bind?: Binding[];           // attributes, custom properties and text following state
  group?: FocusGroup;         // this node is a focus group
  showWhen?: Condition;       // hidden when false, only behind the gate
  noScript?: 'show' | 'hide'; // without JavaScript, see "The gate"
}

type StateValue = { id: string; name: string } & (
  | { type: 'boolean'; initial: boolean }
  | { type: 'number'; initial: number; min?: number; max?: number; step?: number }
  | { type: 'choice'; initial: string; options: string[] }
  | { type: 'text'; initial: string; maxLength?: number }
);

interface Trigger {
  id: string;
  on: string;                 // a DOM event name, or a pseudo event below
  scope?: 'document';         // hears the whole page, for Escape on a hover-only tooltip
  keys?: string[];            // 'ArrowRight', 'InlineEnd', 'Ctrl+End', 'Printable'
  if?: Condition | Expression;
  prevent?: boolean;          // preventDefault
  ms?: number;                // for 'every'
  do: Action[];
}

interface FocusGroup {
  role: string;               // which descendants are items
  axis: 'line' | 'grid' | 'tree';
  wrap?: boolean;
  virtual?: { owner: string }; // aria-activedescendant on that node, focus stays there
}

type Condition =
  | { state: string; eq: string | number | boolean }
  | { not: Condition } | { all: Condition[] } | { any: Condition[] };

/** The selector contract's SelectorRule gains two fields. */
interface SelectorRule {
  /* ... */
  when?: Condition;
  gate?: 'off';               // applies only where the gate is down, see the one page on components
}
```

An accordion item inside a content list, whose state exists once per row:

```json
{
  "behaviour": { "state": [{ "id": "s1", "name": "open", "type": "boolean", "initial": false }] },
  "children": [
    { "type": "button", "props": { "behaviour": {
      "noScript": "hide",
      "on": [{ "id": "t1", "on": "click", "do": [{ "toggle": "s1" }] }],
      "bind": [{ "attr": "aria-expanded", "from": { "get": "s1" } }]
    } } },
    { "type": "div", "props": { "behaviour": { "showWhen": { "state": "s1", "eq": true } } } }
  ]
}
```

**Names and ids.** `name` is what a person sees; references use `id`, so a rename touches one row. A state's
`id` must be unique on its path to the root, checked at `applyBehaviour`, and a repeat is dropped with the
warning. `#220` holds this for components by refusing a definition inside itself.

**Why not on the page snapshot.** Page state on `PageModel` would need a model field and a publish adapter, and
still a second mechanism for rows and placements. The page root is already a node that passes through save,
publish and `snapshotToComponentNode` as JSON. No database or model migration is needed.

**Memory only.** Values reset on reload. Keeping them on the visitor's device opens the consent question, which
this version has no need for.

**Initial values are literals when `applyBehaviour` reads them.** A `{{binding}}` inside `behaviour` is refused.
The one route is the components contract's `state` binding, which `hydrateNode` resolves into `initial` before
this pass runs, so it arrives as a literal.

### Pseudo events

| `on` | Fires | Notes |
|---|---|---|
| `view-enter`, `view-leave` | The element enters or leaves the viewport | One shared `IntersectionObserver` |
| `page-ready` | The runtime started | Never used to set what the server could have rendered |
| `every` | At `ms`, at least 1,000 | Not under `prefers-reduced-motion`, paused while the page is hidden. An `if` is how a carousel pauses on focus and hover |
| `custom:<name>` | An `emit` action, or a custom code frame | The only way into page state from a frame |

### Expressions

A closed JSON form, at most 6 levels deep, and total: it cannot throw or loop.

| Form | Meaning |
|---|---|
| literal, `{ get: stateId }` | A value |
| `{ eq: [a, b] }`, `{ gt }`, `{ lt }`, `{ not }`, `{ and }`, `{ or }` | Logic |
| `{ add: [a, b] }`, `{ clamp: [v, min, max] }`, `{ map: stateId, cases, default }` | Arithmetic and lookup |
| `{ event: 'value' }` | The value of **the node holding the trigger**, never of `event.target`, so a wrapper cannot read a field inside it |
| `{ event: 'key' }`, `{ event: 'newState' }` | The key pressed; `newState` of a `toggle` or `beforetoggle` |
| `{ pointer: 'x' \| 'y', of: node, as: 'px' \| 'percent' }` | The pointer's position relative to a node |
| `{ active: groupNode }` | The text of a group's active item. A source of the taint rule |
| `{ row: 'index' }` | The clone's position in its Collection |

**The taint rule,** enforced by `parseBehaviour` over the whole expression, so a derived value is caught.

- **Sources:** `{ event: 'value' }`, `{ event: 'key' }`, `{ active }`, and `{ get }` or `{ map }` of `text` state. The value
  of a `range`, `select`, `checkbox` or `radio` is a choice among fixed values and is not a source.
- **Allowed sinks:** `set` on `text` state, a `text` binding, and `filter`'s text. A bare `{ active }` may also go into
  `setProp` of `value` on a text entry control, which is how Enter copies an option in a `combobox`.
- **Everything else is refused:** `if`, `set` on other types, `setProp`, `cssVar`, `attr`, `when`, `showWhen`,
  `reads`.
- **Keys:** a printable key never matches while the event's target is a text entry control, checked at run time
  as well as at parse, because a wrapper hears its descendants. `keys` on a document-scope trigger may name only
  non-printable keys.
- **Per keystroke:** a trigger on `selectionchange`, or on `input` or `beforeinput` unless it sits on a fixed-value control
  and does not hear the whole page, holds no `if` and runs only what repeating leaves unchanged: `set` of a literal, any
  `set` on `text` state, `filter`, and `rove` with `clear`.
- **Islands:** no trigger may sit on a field that `formKindOf` or a commerce kind claims, except `change` on
  non-text types.

### Actions

The whole list, with its JSON keys, fixed here for the components contract and slice B1. A stored action is one
of these or it is refused.

| Group | JSON | What it does |
|---|---|---|
| State | `{ set: id, value: Expression }` | Writes a value |
| State | `{ toggle: id }` | Flips a boolean |
| State | `{ step: id, by?: number, wrap?: boolean }` | Moves a number by `by` times its `step`, or cycles a `choice` through its options |
| Focus | `{ focus: target }` | Moves focus to a target |
| Focus | `{ rove: groupNode, move }` | `next`, `prev`, `first`, `last`, `up`, `down`, `page-up`, `page-down`, `type` (typeahead), `clear` (drops a virtual group's active item), `exit-after`, `exit-before` (the first focusable beyond the group) |
| Native | `{ dialog: target, op }`, `{ popover: target, op }`, `{ details: target, op }` | `showModal`, `show`, `hide`, `close`, `toggle`, `open`. Native elements bring focus handling along |
| Native | `{ media: target, op, value? }` | `play`, `pause`, `load`, `seek`, `rate`, `volume` |
| Native | `{ fullscreen: target, op }`, `{ pictureInPicture: target, op }` | Enter and leave |
| Native | `{ capturePointer: true }` | `setPointerCapture`, for a drag |
| Native | `{ scroll: target, block? }` | `scrollIntoView` |
| Native | `{ form: target, op: 'reset' }` | On a plain `form` only. There is no submit: see Safety |
| Values | `{ setProp: target, prop, value }` | Writes `min`, `max`, `value`, `checked` or `disabled`, through the taint rule |
| Values | `{ filter: list, role, text }` | Hides items whose text does not match |
| Flow | `{ delay: ms, key?, do: Action[] }` | Runs later, 16 ms to 10 seconds. A new `delay` with the same `key` replaces a pending one |
| Flow | `{ cancel: key }` | Cancels a pending `delay` |
| Flow | `{ emit: name }` | Fires `custom:<name>` up the scopes |
| Flow | `{ navigate: href }` | Literal address, the sticky bar's safe link check, and only as below |
| Flow | `{ effect: target }` | Plays a node's appear reveal from `src/lib/effects/runtime.ts` |

There is deliberately no `fetch`, no storage, no submit, no `click`, no `innerHTML` and no `setAttribute` by free
name.

**`navigate`** runs only from `click`, `submit`, or `keydown` with Enter or Space, checked at parse, and for an
address that leaves the site also against `navigator.userActivation.isActive` at run time, failing closed where it
is missing. It is refused inside `delay`. An external address is a person's panel choice; the AI generator never
gets one (decision M6).

**User-input verbs.** `focus`, `rove`, `dialog` with `showModal`, `show` or `toggle`, and `popover` with `show` or `toggle`
run only from `click`, `keydown` or `keyup`, except that `showModal` may run from `page-ready` or `view-enter` on a
published page, and `rove` with `clear`, which moves no focus. So nothing steals focus from a timer, a `blur` or a frame,
and all of these in `blur` or `focusout` triggers are refused, directly or under `delay`.

**Family refusal.** A native verb is refused inside a trigger on the events it causes: `popover`, `details` and
`dialog` in `toggle`, `beforetoggle`, `close` or `cancel`; `media` in media events; `fullscreen` in `fullscreenchange`;
`scroll` in `scroll` or `scrollend`.

**`prevent`** is refused on `cancel`, on `Tab`, and on any `keydown` without `keys`.

### Bindings

```ts
type Binding =
  | { attr: string; from: Expression }      // allow list below
  | { cssVar: `--u-${string}`; from: Expression; unit?: 'px' | '%' | 'rem' } // numbers only
  | { text: Expression };                   // textContent, never markup
```

**Attribute allow list:** `aria-*`, `data-u-*`, `inert`, `open`, `disabled`, `min`, `max`, `value`. Everything else is
refused, `on*`, `href`, `src`, `srcdoc`, `action`, `formaction`, `style`, `class`, `id`, `tabindex` and `hidden` above
all. This is decision 6 of the selector contract applied to behaviour: no address is ever computed. Hiding goes through
`showWhen`, and a roving `tabindex` belongs to `group`.

**Refused at parse, because the server would emit them:** an initial `inert`, an initial `aria-hidden="true"`, or
anything that removes content without JavaScript.

**A `text` binding needs exactly one text child,** a string or one `#text` node, and no element child. Two adjacent
text nodes rebuilt the page in the hydration probe.

**On islands,** which own their markup, a binding may write only `aria-*` and `data-u-*`, and `text`, `setProp` and
`form` are refused. That covers `formKindOf`, the commerce kinds and `isStickyCta`.

## From stored data to a page

A new pure pass, `applyBehaviour(root)`, runs in `renderPublishedPage` on the hydrated tree, after `hoistStickyCta`
and before `applyEffects`, so cloned rows and hoisted nodes are in their final place and the rules it adds reach
`applyResponsiveStyles`. Save and publish keep the page as opaque JSON, so one parser, `parseBehaviour` in
`src/lib/behaviour/format.ts`, is the trust boundary, as the selector parser is. It also runs in the panel, the AI
validator and the import.

The pass:

1. Marks scopes: a node declaring state, each clone root (`hydrateCollection` records its index on the node, as
   `islandFrames` is recorded) and each placement root get `data-fc-scope`, and a clone gets `data-fc-i="<index>"`,
   only when the program needs them.
2. Writes each scope's initial values as `data-fcs-<id>="false"`. `text` values are not written.
3. Evaluates bindings at the initial value and writes them, so `aria-expanded="false"` is in the first HTML. A row's
   binding reads its own index.
4. Renders `text` bindings at their initial value and sets `suppressHydrationWarning` on those elements.
5. Turns `showWhen` into a constant rule, `display:none !important` when the condition is false, last in the node's
   list. `!important` because a `&:focus-within { display: flex }` on the same node would otherwise outrank it.
   A `showWhen` reading `{ row: 'index' }` cannot be a selector, since the rule class is shared across rows, so it
   compiles to a binding `data-u-on` and a rule on `:not([data-u-on="true"])`.
6. Rewrites `id`s per clone. A row after the first gets a stable suffix, and its `for`, `aria-controls`,
   `aria-labelledby`, `aria-describedby`, `aria-owns`, `aria-activedescendant`, `popovertarget`, `commandfor` and `#`
   links follow, through the helper the components contract defines for placements, moved to
   `src/lib/renderer/idRefs.ts`. A test walks the published HTML for duplicate ids and dangling references.
7. Adds `data-fc-n="<classKey ?? id>"` only to nodes a trigger, a binding that can change, a declared state, a group or a
   target needs.
8. Removes `behaviour`, and returns the program: a table keyed on `classKey ?? id`, so 500 rows or twelve placements
   share one entry. Rows that repeat an entry are charged to the page's caps once.

**A page with none ships nothing.** With no `behaviour` on any node and no custom code block the pass returns the same
tree object: no attribute, no gate, no script, no island. The proof is a browser counting bytes over the network on
such a page, because the HTML comparison passes regardless. To be exact: published pages already load Next's own client
code and the commerce providers, and this adds nothing to that. Step 6 is the one exception to identical HTML: a page
with a repeated `id` inside a Collection, a bug today, gets it fixed.

**A page with state and no trigger** can never change, so it has no gate and no runtime. Its `when` rules are emitted
without the gate prefix and read the server's attributes, which needs no script. Rules with `gate: 'off'` and
`noScript: 'hide'` are dropped there, since nothing is waiting for a script.

**Nodes sharing a key can differ.** A placement with its own trigger, or a row whose bound `type` changes what parses, shares
its key with a node that runs something else. So the program holds a list per key, and an element after the first entry
carries `data-fc-v="<index>"`. References stay on the key, and what a reference may rely on is what holds for every node
sharing it, so a key one island shares reads as an island.

**Tabs and carousels from data.** `{ row: 'index' }` lets a Collection produce "tab 3 selects panel 3": `set` from the
index on click, and a panel's `showWhen` comparing the two. Proven in the prototype.

### The `when` condition

```css
:where(html[data-fc-b]) .fc_r-a1.fc_r-a1:where([data-fcs-s1="true"] *, [data-fcs-s1="true"]) { color: #0a0 }
```

- **`:where`, so a condition adds no specificity.** The rule keeps exactly what the selector contract gave it, and a
  later rule wins a tie, so Open and Hover combine by list order as any two rules do.
- **Only `eq` compiles to CSS, and only on reflected types.** Value literals pass the selector contract's string
  checks. `all`, `any` and `not` map to chained, listed and `:not()` forms.
- The rule goes through `rules.ts` and `buildResponsiveCss` like any other, so breakpoints, `at` wrappers and the rule
  class apply unchanged. A row's rule class is shared across clones, and the condition reads the clone's own ancestor.

### The gate and no-JavaScript

An inline constant script, on pages with a trigger, sets `data-fc-b` on `html` before the content paints, and removes it
after `START_STATE_TIMEOUT_MS` (3 seconds) unless the runtime reported ready. Unlike the effects boot script it does not
exit early under reduced motion: this gate is about state, not motion.

The same script holds a small buffer of the first `click` and `keydown` on `[data-fc-n]`. The runtime replays them for
state verbs only, so a press during loading is not lost and no native action can double.

| Situation | What the visitor gets |
|---|---|
| JavaScript off | No gate. `when` rules are dead, so every panel shows. A control with `noScript: 'hide'` is hidden. `applyBehaviour` defaults it to `'hide'` on a node whose triggers all need the script and which binds `aria-*`, so a button that does nothing and a stale `aria-expanded="false"` are both gone |
| Script blocked or failed | The gate falls after 3 seconds and the page becomes the no-JavaScript page, with a console error |
| A late start | Once the gate fell and the visitor has scrolled or typed, it is not set again: panels never collapse under a reader, and the page stays in its no-JavaScript form for that visit |
| A later failure | Dispatch is wrapped: an uncaught error removes the gate, so nothing stays hidden behind a dead runtime |
| Normal | Gate before first paint, so the initial state shows with no flash |

### The runtime

`src/lib/behaviour/runtime.ts`, vanilla like `src/lib/effects/runtime.ts`, with one entry:
`startBehaviour({ container, program, nodeAttr, surface })`, returning a cleanup. `BehaviourIsland` stays a few lines
and runs `import('@/lib/behaviour/runtime')` inside its effect, so the runtime is a real separate chunk. `rove` is a
second lazy chunk, loaded only when the program has a group, and the custom code broker a third. The preview and the
canvas pass their frame as `container`.

- **One capture listener per event name in the program,** on `container`. Events that target `document`, such as
  `selectionchange`, and `scope: 'document'` triggers listen on its `ownerDocument`, the second filtered by selection
  inside the container on the canvas.
- **Target resolution:** from the event's element, walk up the scopes, and in each look for `[data-fc-n="<id>"]`. The
  first hit wins, so a row finds its own panel. The page root is the last scope.
- **High-frequency events** (`pointermove`, `mousemove`, `scroll`, `wheel`, `drag`, `dragover`, `selectionchange`,
  `timeupdate`) are batched to one animation frame and listen passively unless the trigger sets `prevent`.
- **Hydration:** writes attributes at any time, and text only on elements the pass marked.
- **Islands re-render:** a `MutationObserver` re-applies bindings to added nodes and restores a remounted scope's
  state. Values are kept in a map keyed by the scope's path (`data-fc-n` and `data-fc-i` up the tree), not by element.
- **A run-time budget,** because the caps below do not bound work on their own: at most 256 actions per task and 2,000
  per second per trigger, after which that trigger is disabled with a warning. Depth carries across `delay`. Proven:
  the prototype stopped a `toggle` loop and a 16-way `delay` fan-out in all three engines, and the page stayed responsive.
- **It never throws.** An unresolved target or unknown verb warns once with the node id and continues.
- **Size:** a test bundles each chunk with esbuild: core 5 kilobytes gzipped, `rove` 3, broker 2. The prototype, with no
  parser and not minified, is 3.9 kilobytes for 229 lines. The review's estimate was 900 to 1,300 lines for the whole.

**Whether the island is early enough is measured, not assumed.** Slice B3 records the time from first paint to runtime
ready on a throttled profile on a real page. If the 3 second gate falls on an ordinary page, the runtime moves to its own
early script before B6, reversing "decided 6" below. That change touches only how `startBehaviour` is reached.

**Coexisting with the islands.** Forms, commerce and the sticky bar stay React islands with their own state. A trigger may
observe a plain event on a node around them, and cannot change them, as the binding and taint rules state. The sticky bar
is moved to the page root before the pass, so only page state reaches it. Appear and parallax stay in `props.effects`:
they are not subsumed, and a `view-enter` trigger is available beside them.

## How a component state compiles

One page, agreed against `2026-11-02-reusable-components.md` as merged in #220. Where the two differ, this page wins.

**A component state is `choice` state with an extra compile step.** Nothing else exists at render.

| Topic | The one answer |
|---|---|
| State attribute | `data-fcs-<S>` on the placement root, where `S` is the definition's `cs-<first 8 of its id>` |
| Stored form | A `StateRule` with `componentState`, refused by `parseRule` until compiled, so a missed compile reaches no sheet |
| Custom state compiles to | `{ selector: '&', when: { state: S, eq: '<state id>' } }` |
| Pointer state compiles to | The `&:where(X:hover, X:hover *)` forms, needing no runtime |
| Specificity | Nothing added, all kinds at (0,2,0). A later state in `states` wins a tie, whichever kind. **An element's own `&:hover` at (0,3,0) beats a component state** |
| Scope | **A placement root is always a scope,** with or without state. A row is too |
| Program keys | **`applyBehaviour` keys `data-fc-n` and the program on `classKey ?? id`,** so a reference inside a definition holds and placements share one entry |
| Delivery | The program table in island props. There is no per-trigger JSON attribute |
| Listeners | Capture on `container` |
| Triggers | There is no `Interaction` type. A connector writes a `Trigger`. Mouse enter is two triggers, `mouseenter` and `focusin`. Escape is `on: 'keydown', keys: ['Escape']`. Click start is `pointerdown`. Appear is `view-enter` |
| Delay | `{ delay: ms, do }`. Connector drags add `key: <S>`, so a newer one replaces a pending one |
| Once, Cycle | `{ set: S, value: 'T' }` and `{ step: S, wrap: true }`, the keys in the action table |
| Initial state | `props.state` or a `state` binding, written into `initial` by `hydrateNode`, a literal before `applyBehaviour` |
| No JavaScript | One gate, `data-fc-b`. `noScriptState` compiles to rules carrying `gate: 'off'`, emitted as `&:where(html:not([data-fc-b]) *)`. A page with no gate drops them, otherwise that page would wear the no-JavaScript look forever. **This one field changes slice 12 of the components contract,** which writes the selector directly |
| `aria-*` | A `bind` from `S`, written by the server at the initial value. A button that needs the script is hidden without it |
| Canvas | `previewState`, the same `data-fcs-*`, `!important` and no gate on the canvas. Pointer tiles use the selector contract's `:is(*, :hover)` rewrite |
| Interact | Lifts `lockedByAncestor` and Layers locks, so a click inside a placement reaches its trigger |

**Nested scopes.** A definition never sits inside a placement of itself in v1, so `S` never repeats on a path. When `slot`
arrives, `@scope ([data-fcs-S="open"]) to ([data-fcs-S])` limits a rule to its nearest scope. Proven in all three engines
with an outer open and an inner closed scope, and `@scope` is already on the selector contract's wrapper list.

## Every reader that has to learn it

| Reader | What it does with `behaviour` |
|---|---|
| `ComponentModel.getResolvedProps` | Skips it, like `effects` |
| New model actions | `setBehaviour`, one action and one undo step, frozen props replaced whole, emptied keys deleted so a saved page stays unchanged |
| `PageModel` duplicate, paste, and detach | `remapBehaviourRefs`: references inside the copied subtree follow the new ids, references outside stay |
| `renderComponentNode` (`NON_DOM_PROPS`) | Denies it defensively |
| `createComponentElement` | No change |
| `HeadlessComponentRenderer` | Writes the same attributes, through one pure function shared with `applyBehaviour`, `behaviourDom` |
| `snapshotToComponentNode` | Passes it through |
| `hydrateBindings` | Passes it through, so a clone carries it, and records a clone's index |
| `applyResponsiveStyles`, `buildResponsiveCss` | Emit `when`, the gate prefix and `gate: 'off'` |
| `rules.ts` | Parses `when`, and refuses a reference to `text` state |
| `yjsDocShape.ts` | No change, as for `rules` |
| `validate.ts`, `ai/review/ops.ts` | Accept through `parseBehaviour`, see AI |
| `roundtrip/jsx.ts` | A named prop, see import and export |
| Text nodes, blocked tags | Refused: there is no element |

**Refused means dropped whole, and visible,** the selector contract's rule. An entry that does not parse is not emitted,
`applyBehaviour` warns once per page, the panel shows it with its reason, and it never blocks a publish. A `showWhen` that
fails leaves the node visible, the safe direction. A reference to a deleted state is a failure of that entry alone.

## Safety

| Threat | Answer |
|---|---|
| Script on a published site | No expression is code, the runtime holds no `eval`, stored `on*` strings stay dropped |
| An attribute that runs or loads something | Allow list |
| Markup injection | Text bindings use `textContent` |
| A foreign form posted without a press | No submit action, so `form` keeps `reset` only. The hole a stored `form` opened, one click from any `*.sites.lumitra.co` page to the editor API, was closed separately in `middleware.ts` by #225 (M1). Removing submit keeps a stored page from reaching any other foreign form without a press |
| What a visitor types | The taint rule, and no reflected `text`. **Not a page guarantee.** `filter` makes item visibility depend on typed text, and a rule with `:has()` can read that through the selector contract's residual route. Only a policy on published pages closes this (M5) |
| What is selected or ticked | A boolean or `choice` is readable through the same route, as `:checked` already is. No new kind of exposure |
| A free redirector | `navigate` needs a press, see above |
| Holding the keyboard | `prevent` is refused on `Tab`, `cancel` and any unfiltered `keydown`, and focus verbs run only from input. **A stored rule cannot hold focus. A frame can try,** which the broker answers |
| Pressing the consent banner | No `click` action, and the banner has no `data-fc-n` |
| Device storage | The runtime reads and writes none |
| A looping program | There are cycles through real events: a `toggle` trigger toggling, `transitionend` setting what caused it, `view-enter` hiding its own element. The family refusal catches the direct ones and the run-time budget stops the rest |
| A huge program | 64 triggers per node, 2,000 per page, 16 actions per trigger, expression depth 6, 64 kilobytes per program, `every` at 1,000 ms or more, `delay` from 16 ms to 10 seconds, `emit` depth 4 across `delay`. Beyond a cap, later entries are dropped with the warning |
| Tenant reach | The program is in that site's HTML, per request. Reach through the browser is the forged post above, not the program |
| AI or import | Both pass `parseBehaviour`, so nothing above depends on who wrote the data |

## Presets

A preset is a pure function in `src/lib/behaviour/presets/` that returns ordinary nodes with `behaviour` and roles. There is
no preset type at render time: the palette, the AI generator and the score's `patterns.ts` call the same functions, and what
lands on the page can be edited like anything else.

A preset root stores `behaviour.preset: { kind, version }` and each generated entry a `preset: true` mark. Adding a tab clones
an item and re-derives only the marked entries, so a person's own triggers survive.

**Native first.** 17 patterns already pass on plain HTML and stay as they are. Accordion stays `details` with `name`, dialog
stays `dialog` with `command`, both working without JavaScript. Behaviour is added only where the Authoring Practices ask for
more than the element gives.

The 13 that fail today:

| Pattern | Built from | Keys (Authoring Practices) | Without JavaScript |
|---|---|---|---|
| `tabs` | `choice` state, `group` line, bound `aria-selected`, `showWhen` per panel | Left, Right (Up, Down when vertical), Home, End, automatic activation | All panels show in order, the tab list is hidden |
| `toolbar` | `group` line | Left, Right, Home, End, one Tab stop | All controls reachable by Tab: the server writes no `tabindex` |
| `menubar` | `group` line, a `boolean` per menu, `group` inside | Left, Right, Down, Up, Enter, Space, Escape, Home, End, typeahead | Top items are links |
| `menu-button` | Native `popover`, `group` inside, `aria-expanded` from `{ event: 'newState' }` on `toggle` | Enter, Space and Down open on the first item, Up on the last; Down, Up wrap, Home, End, typeahead, Escape returns focus | The popover still opens, items reached by Tab |
| `tooltip` | `boolean`, keyed `delay` and `cancel`, a `document` trigger for Escape, `showWhen` | Shows on focus and hover, stays while the pointer is on it, Escape dismisses, also on hover alone | Text stays as `aria-describedby` target, shown |
| `carousel` | `number` with `step` and `wrap`, bound `aria-live`, `every` with `if` | Previous, Next as buttons. Rotation stops on focus or hover, a pause control exists, none under reduced motion | All slides show in order, buttons hidden |
| `combobox` | `boolean`, virtual `group`, `filter`, `{ active }`, bound `aria-expanded` | Down, Up over visible options, Enter copies the option, Escape closes, typing filters and clears the active option | A plain text input. A native `datalist` where suggestions matter |
| `feed` | `group` line, `exit-after`, `exit-before` | Page Down, Page Up, Ctrl+End, Ctrl+Home | Articles in order |
| `grid` | `group` grid | Arrows, Home, End, Ctrl+Home, Ctrl+End, Page Up, Page Down | A plain table |
| `treeview` | `boolean` per branch in its own scope, `group` tree | Up, Down, Right opens or enters, Left closes or leaves, Home, End, typeahead, Enter | All branches open |
| `treegrid` | The same on rows, `group` grid in cells | As tree plus cell arrows | All rows show |
| `slider-multithumb` | Two `input type="range"`, `setProp` clamps each thumb's `value` to the other. The native `max` stays, so the track does not remap | Arrows, Home, End, and thumbs cannot cross | Two sliders that may cross. The server clamps if the value is sent |
| `windowsplitter` | `number`, bound `aria-valuenow`, bound `--u-split`, `capturePointer`, `{ pointer }` | Arrows, Home, End, Enter collapses, and dragging | A fixed split at the initial value |

**Native state follows into stored state,** so `aria-expanded` cannot go stale: `menu-button`, `details` and `dialog` use a
`toggle` trigger reading `newState`, which light dismiss and Escape also fire.

**Keys are logical where it matters.** `InlineEnd` and `InlineStart` resolve to the arrows against the element's computed
`direction`, so tabs work in a right-to-left language.

Also presets, all native and passing today, offered in the palette: accordion, dialog, alert dialog, disclosure, switch, and a
navigation menu (`menu-button` plus links).

**A contract in the score is the primary path, not the whole Guide page.** Each preset slice extends its contract in `patterns.ts`
to the full key list above and sets `built: 'behaviour'`. A pattern's tree comes from its preset. No contract is weakened.

**Corpus.** `radix-tabs` and `radix-dialog` are blocked by behaviour alone and should pass once their trees use the presets.
`radix-accordion` also carries `selector-styles`, which is what remains after #221. Expected, not proven.

### Prototyped before freezing

The review named seven presets the first closed list could not build. Each was stored as data and run on a minimal interpreter
with real keyboard and pointer input, in Chromium, WebKit and Firefox: 12 cases, 36 runs, all passing, in
`~/software-dev/decision-pages/2026-11-02-behaviour-presets-prototype/` (`run.mjs`, `runtime.js`). B4 starts from it.

| Preset | What the review found missing | What froze the list |
|---|---|---|
| `windowsplitter` | No expression reads the pointer | `{ pointer, of, as }`. A real drag landed at 30 percent, and motion after release did nothing |
| `combobox` | `step` does not skip what `filter` hid, and Enter cannot copy text | Virtual `group`, skipping hidden items by what is rendered, and `{ active }`. **The prototype found one more:** an active option survives a filter, so `rove` gained `clear` |
| `menu-button`, `dialog`, `details` | `aria-expanded` goes stale, no `newState` | `{ event: 'newState' }`. Stayed correct on Escape and on light dismiss |
| `tooltip` | Escape on hover alone, `delay` cannot cancel | `scope: 'document'`, `{ delay, key }`, `{ cancel }`. Leave then enter stayed open, the pointer on the tooltip kept it open. **A document trigger must sit inside the scope holding its state:** on the root it found nothing, which is correct scope behaviour and is now a parser check |
| `feed` | No way out of the group | `exit-after`, `exit-before` |
| `slider-multithumb` | Rewriting `max` remaps the track | Clamp `value` with `setProp`. The taint rule's exception for `range` is what allows it |
| `toolbar` | One `tabindex="0"` contradicts its no-JavaScript promise | The runtime writes `tabindex`. Without it, Tab reached all three controls; with it, one stop |

The same run proved data-driven tabs with a row-scoped target, the loop budget, `navigator.userActivation` in all three
engines, and the `@scope` guard. **Not prototyped:** the `grid` and `tree` axes of `group`, `menubar` and `carousel`. The review
did not name them, and they use the same verbs, so B8 may still add an axis detail. A new verb after this freeze needs a contract
change, not a slice decision.

## The editor canvas

The canvas shares a document with the editor, and the selector contract decided it never reacts to the real pointer. That stays
true in Select. The score's `canvas-editor-context` rows show why a second mode is needed: Space pans, a link never navigates.

### Select: nothing runs, a state can be previewed

`EditorUIStore` gets a volatile `previewState: Record<stateId, value>`, the twin of `previewRule`. `ComponentRenderer` writes
`data-fcs-*` on scope nodes from the preview, or else from `initial`, and the canvas sheet keeps the `when` selector as it is, with
`!important` as for any canvas rule and without the gate. So one selector serves every surface, and a state change is a React prop
change rather than a sheet rebuild.

- A row in the Page state panel has a value control that sets the preview. "Menu open" stays visible while its contents are styled.
- **Selecting a node hidden by `showWhen`,** from Layers, sets the preview that shows it when the condition is a plain `eq` chain, with
  a badge naming the state. Otherwise the panel says what hides it. Without this, content in a closed tab could not be edited.
- The preview is volatile: it never enters undo, and a reload returns to the initial values.

### Interact: the page runs, in the frame

A new tool in `EditorUIStore`, beside Select and Grab, in the toolbar. It is the only mode that closes `canvas-editor-context`.

| Editor behaviour | In Interact |
|---|---|
| Runtime | `startBehaviour` per frame, `nodeAttr: 'data-inner-component-id'`, each frame with its own state |
| Click selection, drag, double-click to edit, selection outlines, spacing handles | Off. `ComponentRenderer` attaches none of its handlers |
| `lockedByAncestor` and Layers locks | Lifted, so `pointer-events: none` does not swallow a button inside a placement or a locked layer |
| Handlers in `Canvas.tsx` | Each gets an Interact branch: `handleWheel` and the marquee yield over a frame so wheel can scroll it, `preventNativeDrag` lets a drag start inside a frame, `handleClickCapture` does nothing, and the `window` capture touch listeners for double-tap, pinch and long press stand down inside a frame |
| Space to pan, shortcuts in `EditorApp` | Yield when `e.target` is inside `[data-viewport-content-id]`. Outside a frame they work as usual |
| Escape | Goes to the page when focus is in a frame, so a dialog closes. With focus outside a frame it returns to Select |
| **Shift+Escape** | **Never yields.** Handled at `window` in capture, it always returns to Select, also with a modal open or focus held in a frame |
| A `showModal` not from a person's input | Does not run on this surface, so a stored `page-ready` dialog cannot make the editor inert |
| Same-document link (`#x`) | Keeps its default. The editor never reads the hash |
| Site path link, or `navigate` to one | `sitePathOfClick` switches the editor to that page, as the preview does |
| Outside link, or `navigate` to one | Opens a new tab, so the editor is never navigated away |
| A plain form's `submit` | Prevented, with a notice |
| Form and commerce islands | Stay in their `mode: 'editor'` form, showing what they do but not sending anything |
| `view-enter`, `view-leave` | A frame has no scroller of its own, so they follow the editor's camera. Stated. The preview runs them for real |
| Custom code | The tile, see below |
| Leaving the tool | Cleanup, then the frame's content remounts, so a `details` opened natively is closed again |

**Ids across frames.** Each frame renders the same ids, so `commandfor`, `popovertarget` and `label for` resolve to the first frame. A
small capture shim in Interact handles those three and acts on the element inside the same frame. The test uses two frames.

**Top-layer elements leave the frame.** A native modal renders above the whole editor at full size and makes the panels inert until
closed. Stated rather than rewritten, with Shift+Escape as the way out.

**`landmarks` is closed by a markup change.** A `header` inside `main` is not a banner, and `Canvas.tsx` wraps the canvas in `<main>`.
That element becomes `<div role={interact ? 'region' : 'main'}>`: same element, no remount, and the editor keeps its landmark outside
Interact. Chromium confirmed `role="region"` does not scope `header`, and `role="main"` does. The row is proven in Interact, which is
where it is claimed. The empty-state `<main>` above it is unaffected.

**The preview surface** runs the runtime on `PreviewFrame`'s frame, keeps real pointer and focus, and does not need the tool. It renders
through `HeadlessComponentRenderer`, so it needs the same attributes, through `behaviourDom`.

**Effects on editing:** runtime writes never touch MobX-State-Tree, so Interact cannot dirty a page or add an undo step. A panel edit
during Interact restarts the runtime with the new program.

**Stateful paths** (the stateful flow standard):

- Forward: declare `menuOpen`, add a trigger and `showWhen`, press Interact, click, see it open, publish, see the same.
- Backtrack: deleting a state marks each referring entry refused, visibly; undo restores all of it in one step. Renaming changes nothing
  else, since references use the id. Changing a `choice`'s options keeps a preview only if the value is still an option.
- Resume: state and preview are volatile, so a reload is the initial page, with the tool back on Select.
- Re-entry: the selected node vanishing or the page changing during Interact restarts the runtime on what exists; leaving and entering
  again starts from initial values.

## The panel

**Page state.** A panel listing the root's values, and the values of the selected node's scopes under their names: name, type, initial
value, a preview control. Adding a value to a selected row or component is one menu item, "Keep per row".

**Interactions.** A section for the selected node. A row reads "On click, toggle menuOpen". On lists Click, Mouse enter, Mouse leave,
Focus, Keys and Appears first, then "All events" with every name. Actions are pickers rather than text, and a refused entry shows its
reason, editable and deletable. "Show when" lives in the same section, with a "Without JavaScript" switch. An address that leaves the
site is typed here by a person, nowhere else.

The Delay, Once or Cycle controls of the popover in the components contract map to `delay`, `set` and `step`. Drag-to-connect writes the
same data.

**Touch and keyboard:** both sections work in the phone sheet, controls are native, and motion in the panel follows the design rules.

Credit is labelled as in the selector contract. A panel cell closed by the "All events" list carries the note `raw field`.

## The 100 event handler rows

Today a row asks whether a stored string reaches the opening tag, which is the wrong question: the answer must stay no. The row changes
to: **does a stored action bound to this event run in Chromium, from a real cause, with no `dispatchEvent`?**
`test/score/lib/eventProofs.ts` lists, per event, a tree, the cause (a Playwright gesture, a real media file, a real navigation) and the
effect to observe, and a new `events.score.ts` runs them. The cell cannot pass by wiring alone.

| Group | Rows | Count | Expected |
|---|---|---|---|
| Pointer and mouse | `auxclick`, `click`, `contextmenu`, `dblclick`, `mousedown`, `mouseenter`, `mouseleave`, `mousemove`, `mouseout`, `mouseover`, `mouseup`, `pointerdown`, `pointerenter`, `pointerleave`, `pointermove`, `pointerout`, `pointerover`, `pointerup`, `pointercancel`, `gotpointercapture`, `lostpointercapture`, `wheel` | 22 | Close |
| Keyboard, focus, editing | `keydown`, `keyup`, `focus`, `blur`, `input`, `beforeinput`, `change`, `select`, `selectionchange`, `copy`, `cut`, `paste` | 12 | Close |
| Forms | `submit`, `reset`, `formdata`, `invalid` | 4 | Close, a person pressing a real button |
| Open and close | `toggle`, `beforetoggle`, `cancel`, `close`, `command`, `beforematch` | 6 | Close |
| Drag | `drag`, `dragstart`, `dragend`, `dragenter`, `dragleave`, `dragover`, `drop` | 7 | Close |
| Motion | `animationstart`, `animationend`, `animationiteration`, `animationcancel`, `transitionrun`, `transitionstart`, `transitionend`, `transitioncancel` | 8 | Close, caused by state rules |
| Scrolling and layout | `scroll`, `scrollend`, `scrollsnapchange`, `scrollsnapchanging`, `contentvisibilityautostatechange` | 5 | Close. `scrollsnapchange` is Chromium only |
| Loading | `load`, `error` | 2 | Close |
| Media | `abort`, `canplay`, `canplaythrough`, `durationchange`, `emptied`, `ended`, `loadeddata`, `loadedmetadata`, `loadstart`, `pause`, `play`, `playing`, `progress`, `ratechange`, `resize`, `seeked`, `seeking`, `stalled`, `suspend`, `timeupdate`, `volumechange`, `cuechange` | 22 | Close, a generated sound or video as fixture, `cuechange` with a stored `track` |
| Display | `fullscreenchange`, `fullscreenerror`, `enterpictureinpicture`, `leavepictureinpicture` | 4 | Close |
| **Subtotal** | | **92** | **Expected until B5 runs.** Heard by a listener in the probe, which is not a stored action |
| Published only, with custom code | `securitypolicyviolation` | 1 | The only cause is a block trying to leave, on a site with custom code enabled. A fair proof of the event, a weak claim of support. **Never on the canvas,** since no frame mounts there |
| Labelled `custom code` | `contextlost`, `contextrestored` | 2 | They need a drawing context, which only script can make, so only a frame can reach them. Proof inside a frame, counted apart in `report.ts` |
| **Stay red** | `beforexrselect`, `encrypted`, `waitingforkey`, `slotchange`, `waiting` | 5 | See below |

**Why the five stay failing,** with the note carried in the cell:

- `beforexrselect` needs an immersive session and a device.
- `encrypted` and `waitingforkey` need encrypted media and a key system. The format has neither, and a page that plays such media needs a
  provider's licence server.
- `slotchange` is not composed: the probe heard it on the shadow root and not on `document`. Reaching it means walking open shadow roots in
  the runtime, not worth its bytes for one row, and a frame cannot see the page's shadow roots.
- `waiting` did not fire in the probe. The slice tries cutting a stream mid-file. If that gives a real cause, the row closes and this list is
  corrected; a row is never closed by a synthetic event.

So no row passes by a false route, and `blocked-event-handlers` stays the gap name for what remains. `report.ts` rewrites the meaning of the
row, and its "What this does not measure yet" line about handlers that would run goes away.

**Interact counts too.** The canvas cell runs the same proof on the mounted editor in the Interact tool. The `Canvas.tsx` branches above are
what the 7 drag rows and the scroll rows depend on. A row that fails there stays `canvas-editor-context` with a note. The ceiling below assumes
none does, which is unproven.

## Sandboxed custom code

Decided by Marlin on 2026-11-01: allowed, sandboxed, off by default and clearly marked. **Everything in this section is blocked on M1 to M10,
below.** What it is for: what the behaviour model cannot do, such as a canvas drawing, a calculator with real logic, or a small simulation. A
block is a node whose element is a frame holding the author's document.

### Threat model

| Actor | Wants | Against |
|---|---|---|
| A workspace admin, malicious or with a stolen session | Reach beyond their own site | The session cookie, the editor, other tenants, the platform's domain reputation |
| The same admin | Abuse their own visitors | Tracking, phishing, freezing the page, sending people to the box directly |
| A workspace member | Reach a stronger colleague | Whoever opens the page in the preview |
| An AI generator or a page import, steered by content | Plant code | Everything above, with nobody having chosen it |
| A visitor | Attack through input the code handles | Stays inside the frame |
| Whoever compromises the sandbox host | Serve any document | Stays in the opaque frame: see below |

**Assets:** `lumitra_session`, an apex `.lumitra.co` cookie sent to every `*.sites.lumitra.co` by decision D2 in `middleware.ts`. The editor at
`app.lumitra.co`. Site-origin routes and what a site stores in its origin: the cart, form drafts, the consent choice. All sites share one
registrable domain, so they are same-site to each other and to the editor.

**Not defended:** what an author can already do without code. Plain styles can already cover the consent banner, as the selector contract states.

**If the host is compromised,** the attacker serves any document there. The parent's `sandbox` attribute still gives an opaque origin, so no
cookies, no site origin and no top navigation. They do gain network, tracking and phishing content in every block on every site until the kill
switch, since the parent never verifies the hash. That is visitors' privacy and reputation, not accounts, **provided nothing on that host holds a
secret.** This is why it is a separate service (M3).

### Isolation

| Layer | What it is | Why |
|---|---|---|
| **Separate registrable domain** | `run.<sandbox-domain>`, never under `lumitra.co`, DNS only: a Cloudflare challenge cannot pass in this frame, and its cookies would break "no cookies ever" | The apex cookie reached a sandbox host under the same domain. Also keeps a phishing report from blocklisting `lumitra.co` |
| **Separate small service** | One read path, a database role that reads one view, no application secrets. Not the Next process | A compromise of the host costs nothing beyond it. `middleware.ts` treats any non-editor host as a published site, so one proxy mistake on the Next app would expose `/api/commerce` and `/api/cms` there, and a block could load-test the process serving paying sites |
| **`sandbox` in the response header** | `Content-Security-Policy: sandbox allow-scripts`, and the same on the iframe. `allow-same-origin` never appears | Holds if either is lost |
| **Frame requests only** | 403 unless `Sec-Fetch-Dest: iframe` and `Sec-Fetch-Site: cross-site` | A direct visit has no parent, so no `frame-src` and no `frame-ancestors`, and it left in all three engines. A missing header fails closed, so a browser without them (Safari before 16.4) gets the fallback on every block. That is the intended default, not a bug |
| **Parent `frame-src`** | One constant response header on every published host and on the editor's preview route: `frame-src https://run.<domain>/box/`. A per-site `<meta>` tightens it to `/box/<siteId>/` when it reaches `head` | The only control that stopped self-navigation, in all three engines. A `<meta>` alone fails open inside `Suspense`, and then a `blob:` self-navigation also gets a fresh `RTCPeerConnection`. Published pages hold no other frame (`iframe` is blocked, Stripe is a redirect), so this breaks nothing and leaves the HTML identical |
| **`frame-ancestors`** | The site's own hosts plus the editor host | Tenant A's code cannot be framed by tenant B. The editor host is for the session-gated preview route |
| **Opaque origin, one host** | A subdomain per site adds no isolation to an opaque origin | Saves a wildcard certificate |

**A build-time detail of the header.** `next.config.ts` `headers()` is resolved at build, and the Dockerfile sets no `EDITOR_HOST` then, so a host
test there would read nothing. Slice C2 adds `EDITOR_HOST` and `SANDBOX_ORIGIN` as build arguments and fails the build without them. A test reads
the policy from a real document in the browser, not the tag in the HTML.

**`srcdoc` was considered.** Measured in all three engines with the policy as a first `<meta>`: origin `null`, no self-navigation, no domain to buy,
no host to compromise, no direct visit. Its cost is one control: a renderer bug dropping the `sandbox` attribute runs the code on the tenant's real
origin, same-site to the editor. The address design survives that bug. Recommended against; M3 records the choice.

### The frame

`GET https://run.<sandbox-domain>/box/<siteId>/<sha256>` returns one document: a constant shell, then the author's code. Any query string is refused,
and requests are rate limited per address and path. The catalog images route is the precedent for content-hash serving.

```text
Content-Type: text/html; charset=utf-8
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none';
  form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'; object-src 'none';
  webrtc 'block'; frame-ancestors <the site's hosts> <the editor host>
Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=()
X-Content-Type-Options: nosniff
X-DNS-Prefetch-Control: off
Referrer-Policy: no-referrer
Cross-Origin-Resource-Policy: cross-origin
Cache-Control: public, max-age=300
```

The short cache is what lets a kill switch or a changed domain list arrive within five minutes.

`script-src 'unsafe-inline'` looks wrong and is deliberate: the document holds nothing but the author's own code, so the policy limits what the
document reaches, not what it runs. No `unsafe-eval` in this version, because it was not probed.

**The shell** runs first and deletes `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel`, `RTCIceTransport`, `RTCSessionDescription` and
`RTCIceCandidate`. STUN packets went to zero in Chromium and WebKit, and Firefox's control sent none, so it is unproven there. It is a mitigation, not
a boundary, and it holds only with the parent policy.

**Network is not zero.** Direct requests are closed in all three engines. A `preconnect` or `dns-prefetch` to a host name carrying data is not: WebKit
opened a real connection and Firefox resolved the name, on plain HTTP. The header reduces it and no directive closes it. So **anything the frame holds
can leave by host name.** That is why `text` state never reaches a frame (M4), and this is a stated residual, not a bug.

### What it can reach

Nothing by default. A block declares what it may touch, and a broker in the parent page's runtime enforces that. **The declaration is part of the blob
row,** and the hash covers code plus declaration, so a page save cannot widen what approved code may do.

```ts
/** props.customCode: on an ordinary `div`. The renderers dispatch on it, and it never reaches the DOM. */
interface StoredCustomCode {
  sha256: string;             // of code plus declaration, never the code
  title: string;              // required: the frame's accessible name
}

/** In the row, set only through the guarded route. */
interface CustomCodeDeclaration {
  reads?: string[];           // state ids sent to the frame on change; never `text` state
  writes?: string[];          // state ids it may set, checked against their type
  emits?: string[];           // custom:<name> events it may fire
}
```

A declared id that does not exist at render gives the fallback.

- **The bridge:** the parent trusts nothing about origin, which is `null`. It checks `e.source === iframe.contentWindow`, then transfers a
  `MessageChannel` port. Everything after runs on that port. **One port per mounted frame: a second `load` removes the frame,** because a block reloading
  itself would otherwise reset the rate limit.
- **Messages:** `state`, `setState`, `emit`, `resize`, `ping`. An undeclared id, a wrong type or an unknown kind is dropped with a console warning. At most
  64 kilobytes each and 30 per second.
- **No navigation, no DOM, no direct action.** A frame can only fire a declared event. What happens next is a trigger the author stored as data, with a literal
  address, and a frame's event is not a person's input, so it cannot drive `navigate` or the focus verbs.
- **Writes are not harmless.** A frame writing a boolean drives the selector contract's residual route like any state. Stated under M5.
- **Focus.** A frame can call `focus()` and take a parent input's keyboard, which no stored rule stops. The broker watches for `document.activeElement` becoming
  the frame while the pointer is not over it (`iframe.matches(':hover')`) and no Tab was pressed in the parent, and removes the block after 3 such moves. This
  detection is designed, not probed: slice C3 proves it.

### Size limits

256 kilobytes per block, 4 blocks per page, 1 megabyte of live blobs per site, 10,000 pixels of height from `resize`. Refused at the guarded route with a reason,
and a page with too many blocks renders the first four and warns. Assets go inline as `data:` addresses, inside the same limit.

### What stops it

| Stop | How |
|---|---|
| **Off by default** | `Site.customCodeEnabled`, a new column, default false. Not in `siteSettings`, which travels through the opaque save. Only a new route guarded by `manageCustomCode` sets it. When false the service answers 410 too, and the page shows the fallback |
| **Code and capabilities cannot enter through a save** | Both go through a guarded `POST`, into `CustomCodeBlob(siteId, sha256, text, declaration, createdBy, createdAt)`. A hash in a node with no blob for that site gives the fallback |
| **Tenant crossing** | The frame's address is built from the rendering site's id and the hash, never from stored text. Site B naming site A's hash finds no blob |
| **Render** | `iframe` stays in `BLOCKED_TAGS`. The server renders the wrapper and the fallback; the broker alone creates the frame on the client, with a constant `sandbox` value. A stored `src` is never read. A test holds each |
| **Platform kill switch** | `CUSTOM_CODE_DISABLED`. Every block shows its fallback, the service answers 410 |
| **A frame that fails** | No `hello` on the port within 5 seconds gives the fallback: a 403, a 410, a browser without the headers |
| **A frame that freezes** | `ping` every 5 seconds, three missed: the broker removes it. In WebKit, and without isolation, a frozen frame froze the parent too (3,004 ms measured) and no watchdog can run |

A page with a block and no trigger still loads the broker chunk. That is the exception to "no trigger, no runtime".

### On the editor

**Custom code never runs in the editor document, in any mode.** `createCustomCodeElement('editor')` gives a tile of the block's declared size, like the sticky bar's
editor surface: striped, labelled "Custom code, not run here", with the title and a button that opens the standalone preview. It mounts no frame on the canvas, in
Interact, or in the in-editor preview. A test asserts no `iframe` in the mounted editor with a block on the page.

**The standalone preview tab** (`/projects/<id>/preview`) runs blocks with the same frame and policy. A blob is served by hash whether or not it is published, which
lets a draft preview work without a token: the hash is not guessable. An opaque, cross-site frame gains nothing from the viewer being an admin, which answers the
"stronger colleague" row, except for the freeze, which a colleague's tab also feels (M7).

### Clearly marked

- The Layers row and the canvas tile carry a badge, in both tools.
- A site with blocks shows it in Site settings, with who enabled it and when.
- The publish dialog lists each block on the pages going out, with its title and who last changed it.
- A block's panel states in words what the code can read, write and fire.
- Published markup carries `data-fc-custom-code` so a report can be traced to a site.
- Audit: enabling, disabling and each new blob write a line.

### Consent

**No reading is claimed here. A legal reading is required before C4, the slice that switches it on (M9).** The facts for that reading: the frame has no storage, but it
can read device details (the probe read screen, cores, language, time zone and a canvas fingerprint), and section 25 of the German TDDDG (the telecommunications and digital
services privacy law) also covers access to information on the device, not only storage. By the preconnect residual, what a frame holds can reach a third party in WebKit and
Firefox. The frame's own request goes to Lumitra's infrastructure on a different domain, so the privacy page template needs a line.

**Fetching in the frame is out of this version.** A declared host list would add `connect-src` and needs a new consent category, a `CONSENT_VERSION` bump, and a banner on sites
that have none today. That is its own plan.

**Embedded content stays out too.** `iframe`, `object` and `embed` from another host are not custom code. The `blocked-embedded-content` rows stay red until a consent-gated embed
primitive is decided.

### No JavaScript, and fallback

A block's children are ordinary nodes, in the wrapper, shown until the broker's frame says `hello`. Since the frame is mounted on the client, scripts off, kill switch, site setting
off, refused hash, watchdog and old browser all land on the same fallback, and an author is told to fill it.

## For Marlin to decide: M1 to M10

The fleet plan stops for "the sandbox's security design, and any change to auth or tenant isolation". This is the review's list, which replaces this contract's own, each with its
default. **Slices C1 to C5 stay blocked until these are answered.** Nothing in B1 to B13 waits for them.

| # | Decision | Default |
|---|---|---|
| M1 | Same-site write protection on the editor plane. A change to auth and live on `main`, so it goes first and independently | Yes, now, as its own pull request. **Done by the operator in #225, `middleware.ts`** |
| M2 | Separate domain. Spends real money, and its name is his | Yes |
| M3 | Where the code is served: same Next app, separate small service, or `srcdoc` with no domain | **Separate small service** |
| M4 | Accept the preconnect and DNS residual in WebKit and Firefox | Accept, **with `text` removed from `reads` in version 1,** and the consent reading rewritten |
| M5 | A Content Security Policy on published pages. Two contracts now wait on it, and only it closes the residual route completely | Bring it forward, starting with `img-src` report-only |
| M6 | External `navigate` and auto-submit on published sites | **User activation only, `requestSubmit` removed in version 1.** Applied here |
| M7 | Accept the freeze in WebKit and without isolation. It harms the author's page, and a colleague's preview tab | Accept, with the preview in the wording |
| M8 | Who may enable (`manageCustomCode` would be `workspace.admin`, the same people as `editSite`, adding a deliberate step and an audit line, not a higher bar), the standalone preview on the editor host, retention, the migration | As this contract recommends. The migration is a one-line yes |
| M9 | Consent wording, see Consent | **A lawyer's reading before C4** |
| M10 | Terms of use, takedown and an abuse contact for a domain that hosts customer code | His call |

## AI output

The validator gains `behaviour` through `parseBehaviour`, and everything parseable is accepted, which is what closes the column.

- **The generator is taught presets, not primitives.** A generated node may be `{ preset: 'tabs', items: [...] }`, which the validator expands through the same function as the palette.
- `schemaDocs` also teaches one simple form: toggle a value, show when. Nothing else.
- `MAX_GENERATED_TRIGGERS` of 24 per generation, as appear effects are capped.
- Motion rules hold for generated output: `every` is refused, so nothing rotates by itself unasked.
- `navigate` from a generator takes site paths and anchors only.
- **`customCode` is dropped with a warning, always,** by the validator and `ai/review/ops.ts`. A generator reads content, and content can carry instructions, so it never writes code.
  Only a person, through the guarded route.

## React import and export

Step 7 builds this; the contract says what it targets. `parseBehaviour` is the single entry, as `parseCssText` is for CSS.

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
| A value typed into an input driving anything but text | **Refused by the taint rule, and reported** |
| `useEffect`, fetching, refs, arbitrary handlers | **Reported line by line,** never dropped, per the plan: rewrite it, or accept a custom code block by a person's explicit choice |

Measured match, not a promise: the browser render of the original stays the reference.

**Export:** `behaviour` is a named prop in the normalised round-trip form, like bindings. Real React output is step 7's.

## Score changes

These belong to the slices, and they make the probes stricter. None removes a test.

- **`probeEventHandler`** stops reading the opening tag, and its cells come from `events.score.ts`. A string handler reaching the page remains a failure: a new test in
  `blockedNodes.test.tsx` holds this.
- **`patterns.ts`** gains `built: 'behaviour'`, trees from presets, longer contracts.
- **`patterns.score.ts`** enters the Interact tool before the canvas contract, and a `behaviour` key counts for the panel only when the palette inserts that preset, so swapping a
  tree cannot drop a panel cell.
- **`lib/types.ts`:** `canvas-editor-context` keeps its name, its text updated.
- **`report.ts`** counts `raw field` and `custom code` notes apart.
- **`matrix.canvas.score.tsx`:** the event row reads `events.score.ts` too.
- **`corpus/fixtures.ts`:** the three Radix trees use presets.
- **`samples.json`** keeps `eventHandlersWithoutSpecLink`, unchanged.

## Slices

Each is one file-scoped pull request, green alone, raising `baseline.json` where a number rises. Row counts are cells gained; a pull request states the real figure. The fleet plan
estimated 8 slices here and 3 for the sandbox. These are 13 and 5: the canvas, the panel and the event proofs were not in that estimate. Numbers match what the components contract
references.

B2 waits for selector slice 3 and B9 for selector slice 6. **C1 to C5 are blocked for Marlin,** and nothing in B1 to B13 depends on them.

| # | Slice | Files | Tag | Depends on | Closes |
|---|---|---|---|---|---|
| B1 | `behaviour-format` | `src/lib/behaviour/format.ts` and tests, `ComponentModel.ts`, `PageModel.ts`, `renderComponentNode.tsx` | `renderer` | none | No row. Unit tests over every refusal here: taint, `navigate`, focus verbs, family, `prevent`, one text child, allow list, islands |
| B2 | `behaviour-compile` | `applyBehaviour.ts`, `behaviourDom.ts`, `src/lib/renderer/idRefs.ts`, `src/lib/rules/rules.ts`, `responsiveCss.ts`, `hydrateBindings.ts`, `renderPublishedPage.tsx`, boot script with the buffer | | B1, selector 3 | No row. A page with state and no trigger, the gate and every row of its table, no-JavaScript in Chromium, `classKey` keys, implicit scopes, duplicate ids and dangling references walked in published HTML |
| B3 | `behaviour-runtime` | `src/lib/behaviour/runtime.ts`, `BehaviourIsland.tsx`, `EffectsIsland.tsx` (the same dynamic import), budget and size tests | | B2 | No row. Bytes over the network on a page without behaviour, writes before hydration on a real streamed route, run-time budget, replay, time to ready on a throttled profile |
| B4 | `behaviour-dom-verbs` | `runtime.ts`, `src/lib/behaviour/rove.ts`, tests | | B3 | No row. Starts from the prototype. `group` on all three axes, the native, media and value actions, right to left |
| B5 | `behaviour-event-proofs` | `test/score/lib/eventProofs.ts`, `test/score/events.score.ts`, `matrix.published.score.ts`, `report.ts`, fixtures | | B4 | Format and published for up to 92 event rows (184 cells). `waiting` tried |
| B6 | `presets-tabs-family` | `presets/tabs.ts`, `toolbar.ts`, `tooltip.ts`, `carousel.ts`, `ComponentsPanel.tsx`, `patterns.ts`, `corpus/fixtures.ts` | | B4 | Published for `tabs`, `toolbar`, `tooltip`, `carousel`. Tabs from a Collection. Fixture `radix-tabs` |
| B7 | `presets-menu-family` | `presets/menu.ts`, `menubar.ts`, `combobox.ts`, `slider.ts`, `splitter.ts`, `patterns.ts`, `corpus/fixtures.ts` | | B6 | Published for `menu-button`, `menubar`, `combobox`, `slider-multithumb`, `windowsplitter`. Fixture `radix-dialog` |
| B8 | `presets-structure-family` | `presets/feed.ts`, `grid.ts`, `tree.ts`, `patterns.ts`, `corpus/fixtures.ts` | | B6 | Published for `feed`, `grid`, `treeview`, `treegrid`. With B6 and B7, all 30 on the page. Fixture `radix-accordion` if its selector gap has closed |
| B9 | `canvas-preview-state` | `EditorUIStore.ts`, `ComponentRenderer.tsx`, `HeadlessComponentRenderer.tsx`, `CanvasRuleStyles.tsx`, `src/lib/rules/surfaces.ts`, `PreviewFrame.tsx`, `ResponsivePageRenderer.tsx` | | B3, selector 6 | No row. Preview in two frames, reveal from Layers, preview surface runs |
| B10 | `canvas-interact` | `EditorUIStore.ts`, `EditorApp.tsx`, `ComponentRenderer.tsx`, `Canvas.tsx` (`handleWheel`, `preventNativeDrag`, `handleClickCapture`, touch listeners, the `role`), `Toolbar.tsx`, `HudSurface.tsx`, `src/lib/canvas/interactShim.ts`, `patterns.score.ts`, `matrix.canvas.score.tsx` | | B5, B8, B9 | Canvas for the 13 patterns, the 4 `canvas-editor-context` rows, and up to 92 event rows. Shift+Escape from a held focus and a modal. Stateful paths, two frames, leaving resets, no save marked dirty |
| B11 | `panel-interactions` | `PageStatePanel.tsx`, `InteractionsSection.tsx`, `RightSidebar.tsx`, `matrix.panel.jsdom.score.tsx`, `report.ts` | | B10 | Panel for up to 92 event rows, labelled `raw field`. All four stateful paths |
| B12 | `ai-behaviour` | `validate.ts`, `ai/review/ops.ts`, `promptSections`, goldens, `report.ts` | | B8 | AI for up to 92 event rows, labelled `accepted, not taught`, and the pattern rows. `customCode` refused, external `navigate` refused |
| B13 | `behaviour-round-trip` | `test/score/roundtrip/jsx.ts`, `roundtrip.score.ts` | | B2 | New cases: state, a trigger, a refused entry. Import of hooks stays with step 7 |
| C1 | `sandbox-service` | `services/box/`, `prisma` migration (`CustomCodeBlob`, `Site.customCodeEnabled`, a read-only role and view), `deploy/README.md` | | **M2, M3, M8** | No row. Headers exact, `Sec-Fetch` refusal, query refused, rate limit, wrong host, unknown hash, 410s. `pnpm test:integration` |
| C2 | `sandbox-element` | `src/lib/customCode/element.tsx`, `createComponentElement.tsx`, `renderComponentNode.tsx`, `next.config.ts`, `Dockerfile` (build arguments), tile | `renderer` | C1 | No row. Policy read from a real document, `<meta>` tightening, fallback in every failure, no iframe in the mounted editor |
| C3 | `sandbox-bridge` | `src/lib/customCode/broker.ts`, `runtime.ts`, tests | | C2, B4 | No row. Source check, one port per mount, typed writes, declared ids, rate cap, watchdog, focus watch proven |
| C4 | `sandbox-panel` | Guarded routes, `permissions.ts`, `CustomCodeSection.tsx`, `SiteSettingsDialog.tsx`, publish dialog, audit, `validate.ts` | | C3, B11, **M4, M7, M9, M10** | No row. Hash covers the declaration, all marks, all four stateful paths. `pnpm test:integration` |
| C5 | `sandbox-escape-suite` | `test/sandbox/escape.spec.ts` from the review's probes, a path-filtered workflow, `events.score.ts`, `report.ts`, `exclusions.json`, `samples.json` | | C4 | Every probe in this document permanent, preconnect and direct visit included, in Chromium, WebKit and Firefox. Event row `securitypolicyviolation`, published only. Labelled `custom code`: `contextlost`, `contextrestored`, and the 6 selector rows the selector contract promised back |

**Why more browsers here,** when the selector contract kept seven rows out of continuous integration rather than add one: this is a security boundary and the probes differ by engine. The job runs
only when `src/lib/customCode`, `services/box` or the suite changes, so the five-minute rule holds elsewhere.

Only B1 and C2 touch the two renderer files. B2 to B5 share `runtime.ts` or the pipeline, so the operator runs them in order. B6 is the first slice a person can see working.

**What the slices add,** as ceilings out of today's 1,816 rows, on `fc32fc1`. "After selectors" is today plus what the selector contract still closes: 7 format and published cells, and 140 canvas cells.

| Column | Today | After selectors | Added here | After this | Percent | What is left |
|---|---|---|---|---|---|---|
| Format | 1,695 | 1,702 | 92 + 1 | 1,795 | 98.9 | 5 red events, 2 custom code rows, 14 `page-level-css` |
| Published page | 1,655 | 1,662 | 92 + 1 + 13 | 1,768 | 97.4 | Those, 26 blocked embeds, 1 dropped value |
| Canvas | 1,510 | 1,650 | 92 + 13 + 4 | 1,759 | 96.9 | Those, 8 `attribute-read-as-style`, `securitypolicyviolation`. Assumes every event proof holds in Interact |
| Panel | 1,083 | | 92 | | | The rest is the general editor's and the selector contract's panel slices. Labelled `raw field` |
| AI | 1,336 | | 92 + up to 11 | | | 11 pattern rows fail today. Labelled `accepted, not taught` |
| Corpus | 7 of 13 | | 2, perhaps 3 | | | `radix-tabs`, `radix-dialog`, and `radix-accordion` with its selector gap. Expected, not proven |

Every event figure above is **expected until B5 runs.** Labelled `custom code` cells are outside these numbers: 2 event rows, and 6 selector rows that grow the list when they return. The earlier revision's
figures (1,811, 1,784, 1,774 of 1,832) are superseded: the list shrank, and the canvas never gets `securitypolicyviolation`. So format, page and canvas clear the fleet's 95 percent. **A matrix pass proves
less than it reads:** a row says one event ran one action once. The patterns and the corpus are what count.

## What this does not cover

- **Component states and drag-to-connect:** the components contract, under "How a component state compiles" here.
- **Fetching in custom code, consent-gated embeds, persisted state,** each its own plan.
- **Commerce and form values as named state,** such as a cart count. Islands own those.
- **Scroll-driven pages,** the separate opt-in roadmap line.
- **Page-level script:** `head` items stay gap 5 of the primitives plan, and a block is always a node.

## Decided here, say so if you disagree

The fleet plan gives contracts to a fresh review agent before fan-out, and the review of 2026-11-02 has happened. These do not wait for Marlin; M1 to M10 do.

1. `props.behaviour` as one object rather than separate props.
2. State on nodes, with the root as page state, rather than a page field.
3. A closed action list with no `click`, `fetch`, submit or free attribute writes, frozen after the prototype.
4. Visual state through CSS `when` with zero added specificity, semantics through bindings.
5. `hidden` and `tabindex` are not bindable.
6. A small island with a dynamic import delivers the runtime, not a separate static script, subject to B3's measurement.
7. Values are memory only.
8. `text` state is never reflected, and the taint rule covers derived values.
9. An Interact tool, a volatile preview in Select, state per frame, Shift+Escape as the chord.
10. Canvas `<main>` keeps its role outside Interact.
11. Event rows need a real cause, five stay red, and there is no synthetic pass.
12. Presets expand to ordinary nodes, native elements first.
13. The AI generator is taught presets, gets no external `navigate`, and never writes custom code.
14. Effects are not subsumed.

## Decided in slice B2

B1 left three leaks open and B2 closes them in the parser, because a refusal in one place holds on every path that parses. Each
is the same shape: a value that started as typing, or a move nobody asked for, passed through something the first rule did not
treat as a source.

1. **`popover` with `show` or `toggle` is a focus move, always, as `dialog` with `show` already was.** Showing a popover runs the
   popover focusing steps, so from `every` it takes the keyboard to an `autofocus` child. Refusing only when the target holds one was
   considered and rejected: a client island renders content the parser cannot see, a key shared across rows can differ per row, and
   the check would fail open on exactly what it exists to stop. Nothing in the prototype needs a popover opened by anything but a
   press: `tooltip` is `showWhen`, `menu-button` opens from a press. `hide` stays free, as `dialog` `close` does, since focus returns
   only from inside the element. `dialog` with `toggle` was a gap of the same kind and is closed with it.
2. **What fires per keystroke may not build up.** `step` on `input` counts what was typed into a reflected number, and the taint rule
   cannot see it, because no typed value moves. Refusing `step` alone is not enough: `toggle` gives parity, a `set` reading state
   counts, `emit` and `delay` hand the count to a trigger that may, a native `toggle` comes back through `newState`, any `rove` but
   `clear` moves an index, and two `if`s on each other's flags count in unary. So these triggers hold no `if` and run a closed list
   of what repeating leaves unchanged, and the rule covers `selectionchange` and any wrapper, since a wrapper hears what is typed in
   an island's field. A fixed-value control is exempt because it hears only itself, so `slider-multithumb` keeps its `input`. The
   prototype's `combobox` needs nothing outside the list. A `keydown` is already held by the printable key rule.
3. **`{ active }` is a source.** `filter` decides which items can become active, so the active item's text answers what was typed,
   and `set` of a `choice` from it reached reflected state. Tainting it only where a `filter` reaches the group needs a page-wide scan
   that a role or a nested list can get wrong, for no preset's benefit, so it is always a source. Enter in a `combobox` still works:
   a bare `{ active }` may go into `setProp` of `value` on a text entry control, a property no selector reads, on a control that
   already holds typed text.

**What is still open, stated.** Visibility from `filter` can reach a reflected value by another door: a `view-enter` on an item, or a
transition caused by what is left. The same goes for an `aria-activedescendant` a selector reads. These are the residual route of
decision 7, which needs an author who also controls CSS, and only a policy on published pages closes it (M5).

**Also decided while building it, say so if you disagree:**

- A `when` needs the state on the node's path, so `readRules` takes it as a context, and without one refuses `when` and `gate`. The
  pass reads a node's list and leaves the result in `compiledRules` on the node, which the snapshot adapter cannot carry from a save.
- A `when` goes straight after the rule's class, not at the end of the selector, since nothing may follow a pseudo-element.
- Stored `data-fc-n`, `data-fc-i`, `data-fc-v`, `data-fc-scope` and `data-fcs-*` are dropped again on any page the pass works on, though
  `expand.ts` strips stored `data-fc-*` first. One on a checkout field would make it a target past every island refusal, so this
  guarantee does not rest on what called the pass. The list stays exact, since `hoistStickyCta` has written a `data-fc-` of its own by then.
- A node with no stable key holds no behaviour: nothing could find it.
- Expansion marks a placement root with `placementRoot: true` on the node, beside `classKey`, which `expand.ts` now writes. Like
  `cloneIndex`, it ends at `applyResponsiveStyles`, so it never crosses to an island.
- A binding slot named `behaviour` is skipped by `applyBindings`, so a row cannot write into a behaviour past the `{{binding}}` refusal.
- Step 6 changes an `id` only where it repeats. An `id` bound per row is already unique, and rewriting it would break its anchors. A
  bound id reference that can change in a clone is refused, because one program entry cannot write a different id per row.
- `value` on a form control is written as `defaultValue`. As a prop, React would own the field and a person could not change it.
- Without a trigger on a press, `noScript` does not default to `hide`: a `toggle` trigger mirrors what the element does natively. A
  control with a native job (a link, a field, `popovertarget`) keeps working without the script and is not hidden.
- Until B3, nothing starts the runtime, so a page with a trigger drops its gate after 3 seconds with the console error. Only hand-written
  JSON can reach that today.

## Review findings not adopted

Everything in findings 1 to 22 is applied except the following, each decided by code or a test. M1 to M10 are recorded above with the review's defaults.

1. **Finding 13, "add a named-state specificity bump so #220's ordering survives". Not adopted.** The ordering it protected is gone: #220 as merged (lines 615 to 620) has a compiled state add no specificity, a later state
   win a tie, and an element rule beat a component state, proven there in Chromium and WebKit on real pointer input. A bump would reintroduce the contradiction. The review read an earlier revision, whose `(0,3,0)`
   selector no longer exists. So were `data-fc-state`, `data-fc-on` JSON, delegated listeners, `<noscript><style>`, and `Interaction` semantics: all gone from the merged text. One real conflict remained, a page with no gate
   wearing `noScriptState` rules forever, and "How a component state compiles" fixes it with `gate: 'off'`.
2. **Finding 13, "nested scopes get per-instance scope ids". Not adopted.** Rule classes key on `classKey`, so an id per instance would put an instance id in each selector and give one rule block per card, undoing decision 4 of
   #220 and `classFor`'s sharing. No path repeats `S` in v1 (`#220` lines 632 to 636). When `slot` arrives, `@scope (...) to (...)` keeps the shared block, proven in all three engines.
3. **Finding 2, "a `keys` trigger whose target is a text-entry control may not `set`, `step` or `navigate`". Narrowed.** As written it breaks `combobox`, whose ArrowDown and Escape on the input must `set` the open state: the
   prototype needs both. The leak is per character, so **printable keys** never match on a text entry, at parse and at run time, which also covers a wrapper hearing its descendants. Named keys carry no typed text.
4. **Finding 14, "a `next visible` option on `step`". Not adopted.** A virtual `group` does it, and `rove` already had to exist. The prototype's Down skipped the hidden option in all three engines with no option on `step`.
5. **Finding 14, `{ event: 'clientX' | 'clientY' }`. Replaced** by `{ pointer, of, as }`, the element-relative form the same finding also asks for. A raw coordinate has no use in a closed language with no layout reads, and the
   prototype's drag used only the relative one.
6. **Finding 16, "a panel's `aria-expanded` is omitted until the gate is up". Replaced.** It would contradict #220 (lines 649 to 656), where the server writes the initial value so the first paint is correct for assistive
   technology. The stale claim is avoided differently: a control that needs the script is `noScript: 'hide'` by default, so `display:none` removes it from the accessibility tree and no false `aria-expanded` is exposed. The rest of
   the finding is adopted.
7. **Finding 11, the header "from `next.config.ts` on every non-editor host". Adopted with a change.** `headers()` is resolved at build and the Dockerfile sets no `EDITOR_HOST` at build, so the host test as described would read
   nothing. C2 adds build arguments and fails without them.
8. **Finding 15, "serve the runtime as its own early script". Not decided, by its own terms.** The review says it needs a measurement first. B3 takes that measurement, on a real page, and states what flips the decision.
9. **Finding 8, "refuse a `focus` action on the same node from a `blur` trigger". Widened.** Two nodes can trap focus between them, and `every` can steal it, so all focus verbs are refused in `blur` and `focusout`, and they run only
   from input events. The prototype's seven presets needed nothing wider.
10. **Finding 22, "a client-mounted frame would give this for free". Taken.** Listed so the change is visible: the server no longer emits an `iframe`.

## Open questions

1. **For the review agent:** whether core 5 kilobytes and `rove` 3 hold once all three axes exist. The budget is a judgement, and raising it needs a reason in the pull request.
2. **For B8:** the `grid` and `tree` axes were not prototyped.
3. **For the components contract:** slice 12 writes `gate: 'off'` rather than the selector form, and its open questions 1 and 2 are answered by the action table and the one page above.
4. **Unproven and listed so nobody assumes otherwise:** HTTPS, real Safari, phones, a frame on a real custom domain, the real published and save routes, Firefox's site isolation in a real build, and the broker's focus watch.
