---
type: plan
status: draft
date: 2026-11-02
title: "React import and export: the contract for turning a component into primitives, once, without running it"
summary: "How a developer brings a real React component into framer-clone by upload, paste or a command line tool, and takes one out again. The conversion is layered: static JSX through the TypeScript parser, Tailwind through its own compiler fed a constant preamble, props to inputs, known hook patterns to behaviour, loops to bindings, AI only on a person's press for what is left. Source is never evaluated and never reaches the server: it is parsed in a Web Worker or on the developer's machine, and only data leaves, through the existing gates. A total ledger accounts for every construct, so nothing is lost silently, and a verdict may not claim more than the corpus proves. Export writes real function components, with a constant runtime for behaviour. One real shadcn button already reached zero computed style differences in Chromium through the real parser and renderer. Eighteen slices."
tags: [framer-clone, primitives, react-import, export, tailwind, shadcn, radix, untrusted-input, fleet]
projects: [framer-clone]
---

# React import and export

This is step 7 of the [complete primitives plan](2026-11-01-complete-primitives.md), its sections "React import and
export" and "The round trip". It is the last piece of the primitive stream's builder work, and it pays out what the
three earlier contracts promised it: the [selector contract](2026-11-02-selector-styling.md) (Tailwind lands in
`props.rules`, and `parseCssText` is the single entry), the [components contract](2026-11-02-reusable-components.md)
(props become inputs, and `slot` moved here), and the [behaviour contract](2026-11-02-behaviour-model.md) (its import
table, with `parseBehaviour` as the single entry). It specifies, and builds nothing.

It stays inside the decision of 2026-11-01 that framer-clone only edits sites it hosts. Importing converts a component
into primitives once. Nothing foreign runs on a site, and an export is a snapshot leaving the platform, never a link
back to it.

Read against commit `523fe93`. At that commit the rule format and its published emission, text nodes, components slices
1 to 5, behaviour B1 and B2, and the render gate are merged. Open or unbuilt, and named as dependencies below: the canvas
rules (#245), the behaviour runtime B3 (#247), the immutable published copy (#226), everything from components slice 6
on, `parseCssText` (selector slice 8), and `src/lib/behaviour/presets`, which does not exist yet (B6 to B8).

**Evidence marks:** **[code]** read here, **[proven]** run for this contract with the real package, parser or renderer,
**[unproven]** designed but not run. The probes are kept at `~/software-dev/decision-pages/2026-11-02-react-import-probes/`:
`tw.mjs` (Tailwind output), `parse.mts` (that output through `rules.ts`), `hostile.mjs` (parser limits), `e2e.mts` (one
button end to end).

Short forms: JSX (React's markup syntax), CSS (Cascading Style Sheets), CLI (command line interface), AST (abstract
syntax tree, a parser's output), AI (artificial intelligence), JSON (JavaScript Object Notation), API (application programming interface), ARIA
(Accessible Rich Internet Applications). A "candidate" is one class name handed to Tailwind. A "definition" and a
"placement" are the components contract's words.

## The decisions

1. **Source is data. Nothing evaluates it, anywhere in the product.** No `eval`, no `new Function`, no `import()` of it,
   no transpile-and-run, on no machine, with one exception a developer has to ask for by name on their own machine
   (`--measure`). `roundtrip.score.ts` uses `new Function` on fixtures it owns, and that stays in the test harness.
2. **The conversion never runs on the server.** It runs in a Web Worker in the editor tab, or in the CLI on the
   developer's machine. The server never parses source, so a hostile file cannot cost the shared Node process anything,
   and source is never stored.
3. **There is one door into a project: the import bundle.** Worker and CLI both produce a bundle of data. `readBundle`
   checks all of it through the existing parsers, because a bundle can be forged. No layer is trusted for having run.
4. **Tailwind gets a constant preamble, never the developer's CSS.** Only token values are read from a stylesheet, as
   data. The compiler's two loaders refuse everything outside constants we ship. `@plugin`, `@config` and
   `tailwind.config.js` are programs and are never run.
5. **The ledger is total, and unclaimed means left.** Every construct of the source is listed before conversion starts,
   as `left`, and a layer has to claim it. So silent loss needs a layer to lie, not merely to forget.
6. **A half-understood component does not look imported.** A `left` line in the rendered tree blocks placing by default,
   and accepting it is one visible press. A left region shows as a `#missing` node on the canvas and in
   `checkBeforePublish`, and renders nothing for visitors.
7. **AI is the last layer, and it is opt in per region.** Nothing is sent without a press, a preview of what goes, and a
   check for secret-shaped text. Its output is a proposal through the generator's own validator. It never writes custom
   code.
8. **The match is measured where the original can run.** The score, and a developer's own `--measure`. The editor says
   "not measured", because it cannot run the original until a sandbox could. A number is never shown that was not taken.
9. **Export is total over the stored format, and generated code is treated as an injection surface.** Behaviour exports
   as its data plus the constant runtime, not as hand-written hooks, because only the runtime is exact.
10. **`slot` arrives here,** with its scope rules and the nesting guard the components contract requires of it.

## What was measured

Tailwind 4.2.1, TypeScript 5.9.3, Node 22, Chromium 1248, `rules.ts` at `523fe93`.

**One real button, end to end [proven].** The three variants `default`, `outline` and `destructive` of
`src/components/ui/button.tsx`, with the repo's real tokens, were compiled by real Tailwind, flattened, stored as
`style` and `rules`, rendered by `renderPublished`, and compared in Chromium with the same button under real Tailwind
CSS, across every computed property.

| Published page base | Initial | Hover (default) | Keyboard focus (default) |
|---|---|---|---|
| None, as `publishedDocument` builds it today | 71 differences | 71 | 63 |
| None, 18 reset keys written onto each node | 0 | 0 | 0 |
| Tailwind's real base sheet, nothing written onto nodes | 0 | 0 | 0 |

Each variant took 8 to 10 rules, 15 to 16 `@property` definitions, 10 to 13 tokens and 33 to 37 style keys, and `parseRule`
refused none. Not covered: one width (1280), no disabled state, no dark, no screenshot or accessibility tree, and the
class list was written out by hand rather than read from the `cva` table. So this proves the Tailwind layer can be exact on
real output. It does not prove the importer.

**All of `src/components/ui` [proven].** Every string literal in 13 files read as candidates: 384. With a partial theme,
124 produced no CSS and no error. The other 260 flattened to 277 rules, and `parseRule` accepted 277 of 277, including
`&:is(:where(.group)[data-disabled="true"] *)`, `&:is(:where(.peer):disabled ~ *)` and `&>span`. The 124 mix real
misses with words that are not classes, which is the point: the compiler cannot tell them apart for you.

**Findings that became rules below:**

| Finding [proven] | Rule |
|---|---|
| Tailwind drops an unknown class with no error. `animate-in`, `fade-in-0` and `data-[state=open]:animate-in` all compile to nothing without `tw-animate-css` | A candidate with no output is a ledger line, never skipped |
| `@import "https://evil.test/x.css"` passed `compile()` with both loaders refusing. Whether anything fetched was not observed. `@plugin`, `@config` and a relative `@import` were stopped by the loaders | The developer's CSS is never compile input |
| `bg-[url(https://evil.test/x)]` compiles to a real `background-image` | Every imported value takes the address check, see "Values" |
| `@property --tw-shadow` is refused and `--u-tw-shadow` accepted, with `syntax: "*"` | `--tw-` is renamed `--u-tw-` everywhere, or the ring and shadow utilities break |
| `:where(& > :not(:last-child))`, from `space-y-*`, is refused: a part must start with `&` | A named rewrite, with its specificity change |
| Tailwind's `hover:` emits `@media (hover: hover)`; the Hover state's gate is `@media (hover:hover) and (pointer:fine)` | A named rewrite, or the rule does not read as Hover |
| A declaration and its `@supports` twin are nested in one rule, in order. The first prototype walked children first, and every `/90` colour silently became the opaque fallback | The flattener flushes declarations before it recurses, with a test |
| `ts.createSourceFile` overflows the stack: `RangeError` at 1,000 nested parentheses, at 5,000 nested elements, and on an unterminated `<div>` run. 5.8 megabytes of wide JSX took 2 seconds. Parsing ran no source | Limits before the parse, a worker with a deadline, and the error turned into a refusal |

**One finding is about the score, not the import [code].** `publishedDocument` holds only the page's own sheet. A real
published page also carries `src/app/globals.css` from the root layout, so Tailwind's reset and the editor's base layer
apply to every site (the comment in `src/app/(site)/layout.tsx` says as much). So today's corpus compares against a page no
visitor sees: a fixture can pass there and differ in production, and a `button` written for browser defaults loses its
border on a real page. Slice 1 fixes the harness.

## How a developer uses it

**Paste.** Import dialog, one text area. A fragment of JSX or one file. Good for "this section from my old site".

**Upload.** Drop files or a folder: the component, the files it imports by relative path, and `globals.css` for tokens. No
zip in the first version, because a zip needs its own expansion limits and a folder pick gives the same result.

**Command line.**

```text
fc-import components/ui/button.tsx --css app/globals.css --entry examples/button-demo.tsx --out button.import.json
```

It reads files inside the project root only (no symbolic link out, no `node_modules`), reads `paths` from `tsconfig.json` as
JSON, and prints the report with `file:line` so an editor can jump to it. The exit code is 0 when imported, 1 with
differences to accept, 2 when not imported, so it fits a pipeline. It holds no login and makes no network call: its output
is a bundle a person uploads. A key for writing into a site would be a new credential for a one-way convenience.

In all three the result is the same screen: the report beside a live preview on the canvas, then Place on this page or
Add to components. Import is one undo step.

### What gets imported: entries

`src/components/ui` shows the shape of real input: 12 real shadcn files and one local one, and of those 12, 11 wrap a
Radix package and only `input.tsx` does not. Nearly every function takes `className` and spreads `{...props}`, and `dialog.tsx`
exports nine functions that mean little alone. So the unit of import is not always a file.

| Input | Result |
|---|---|
| A file with one component | A definition. Its props become inputs |
| A JSX fragment, or a component with no props | Nodes, placed directly |
| A compound family (`Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`) | Needs an **entry**: a usage, pasted or named with `--entry`. Local components are inlined into it with their props evaluated, the Radix parts become one preset, and the result is nodes, from which a person can Create component |
| A family with no usage | Not imported, with the one line that says what to paste |

A local component used twice in the entry becomes a definition rather than two copies.

**Re-importing.** A name already taken becomes `Card 2`. There is no merge into an existing definition in this version:
replacing one that has placements would need the input-removal rules of the components contract per changed input, and it can
be added on top.

**Stateful paths** (the stateful flow standard):

- Forward: drop files, read the report, accept or fix, place, publish.
- Backtrack: changing the source, the entry or the token file discards every conversion result and any AI proposal, keyed
  to a hash of all inputs. Reselecting identical input keeps them.
- Resume: nothing persists. Source is held in the tab only, on purpose, so a reload returns to an empty dialog. The placed
  result lives in the project like any node.
- Re-entry: after a failure, the worker is terminated and the same dialog offers a retry with the reason. After
  completion, a second import of the same file is a new import, and undo removes all of it.

## The pipeline

```text
files -> limits -> parse -> atoms (all left) -> layers 1 to 5 claim atoms -> bundle -> readBundle -> canvas
                                                                       \-> layer 6, per region, on a press
```

Everything lives in `src/lib/reactImport/`: pure, no React, no MobX-State-Tree, no `server-only`, no file system. The worker and
the CLI are thin shells around `importSource(files, options)`.

### The ledger

```ts
type Disposition = 'converted' | 'adapted' | 'rebuilt' | 'left';
// converted: same meaning. adapted: kept, with a stated difference. rebuilt: AI, accepted by a person. left: not in the result.

interface ImportLine {
  file: string; line: number; column: number; endLine: number;
  excerpt: string;          // at most 120 characters, whitespace collapsed
  kind: LineKind;           // closed list, below
  disposition: Disposition;
  detail: string;           // what happened, in plain words, without jargon
  next: NextAction[];       // 'rewrite' | 'accept' | 'add-tokens' | 'add-entry' | 'rebuild-with-ai' | 'custom-code' | 'use-system-dark'
  nodeKey?: string;         // the node it landed on or would have, so the report can select it
}

type LineKind =
  | 'element' | 'attribute' | 'spread' | 'expression' | 'statement' | 'import'
  | 'class' | 'class-unknown' | 'css-rule' | 'token'
  | 'hook' | 'handler' | 'loop' | 'condition'
  | 'refused-rule' | 'refused-tag' | 'refused-attribute' | 'external-address' | 'taint'
  | 'cap' | 'unknown-component' | 'unknown-package';

interface ImportReport {
  lines: ImportLine[];
  counts: Record<Disposition, number>;
  verdict: 'imported' | 'imported-with-differences' | 'not-imported';
  match: MatchResult | { notMeasured: string };
}
```

**An atom** is anything that can mean something: each JSX element, attribute, spread and expression, each class token, each
top-level statement and import, each statement in a component body, each CSS declaration in a supplied sheet. `atoms.ts`
walks the AST and lists them, and `ledger.open(atoms)` records each as `left`. A layer claims an atom to change that. Nothing
converts without claiming, so the loss path needs an affirmative false claim.

**Conservation test.** An independent walker in the score, sharing no code with `atoms.ts`, counts source tokens and checks
each lands in the nodes or in the report. Its mutation run inserts one construct of each syntax kind into a fixture and fails if
the output and the report are both unchanged. This is what "never silent loss" means in numbers.

**The verdict.** `not-imported` with a `left` line in the rendered tree or nothing to place. `imported-with-differences` with an
`adapted` line that changes what a visitor sees. `imported` only with neither. Report grouping: most lines are `converted` and
collapsed to a count, so a person reads the few that need them.

### Layer 1: static JSX

`ts.createSourceFile` builds the AST, as `test/score/roundtrip/jsx.ts` already does, and that code moves here. The parser reads
one file and resolves nothing. No `ts.createProgram`, because a program reads `lib` files and follows imports. Types are read by
syntax only.

**The closed evaluator,** `staticEval.ts`, answers "what is this expression" with a value or `Unknown`, and it calls nothing:
literals, template strings, local `const`, object and array literals, spreads of those, member access, `? :`, `&&`, `||`, `??`,
at depth 32. It holds an environment of known props when inlining an entry. Calls are unknown, except those named under "Known
libraries".

**Mapping,** beyond what `jsx.ts` does today:

| Source | Becomes |
|---|---|
| `className` | Layer 2, never a stored class, except marker classes (below) |
| `style={{ ... }}` | `props.style`, numbers given React's `px` rule |
| `htmlFor`, `tabIndex`, `aria-*`, `data-*` | As stored, through the render gate's check |
| Fragments | Their children |
| `key` | Dropped, `converted`: it has no meaning in a tree |
| `ref` on a `forwardRef` passing through | Dropped, `adapted` |
| `onClick` and other handlers | Layer 4 |
| `dangerouslySetInnerHTML`, `<script>`, `<style>`, `<iframe>`, any tag or attribute the gate refuses | `left`, kind `refused-tag` or `refused-attribute`. The importer asks the render gate's own functions, because otherwise the gate would drop it silently at render time |
| A `form` with a handler or `action` | `left`, pointing at the form presets: a form on a site works through the island |

**Marker classes.** `group` and `peer` compile to nothing and still mean something: `&:is(:where(.group):hover *)` needs an ancestor
with that class. A candidate named by a compiled selector stays in `className`. `applyResponsiveStyles` keeps a stored class that
has no `fc-` prefix [code]. Named groups (`group/item`) work the same way.

**Known libraries.** A closed table keyed on the import's module name, never on what a function looks like alone:

| Module | Treated as |
|---|---|
| `react` | `forwardRef`, `memo`, `Fragment`, `useId` unwrap; hooks go to layer 4 |
| `class-variance-authority` | `cva` tables, layer 3 |
| `clsx`, `classnames`, `tailwind-merge` | Class strings, layer 2 |
| `@/lib/utils`, or a provided file whose `cn` body is exactly `twMerge(clsx(inputs))` | `cn`. Not provided: assumed, `adapted`, with that stated |
| `next/link`, `next/image` | `a`, `img`, `adapted` |
| `lucide-react` | Inline `svg` from a generated table, in a lazy chunk. A name missing from our version is `left` |
| `@radix-ui/react-*` | Presets, layer 4 |
| Anything else | `left`, kind `unknown-package` |

Only relative files inside the provided set are followed. A barrel file re-exporting is followed. A dynamic `import()` or a
`require` is `left`.

### Layer 2: Tailwind

**The preamble is a constant with holes for data.** Shape: Tailwind's `index.css`, then `tw-animate-css`, then
`@custom-variant dark (&:is(.dark *))` when the source's stylesheet says exactly that, then an `@theme inline` block. The compiler's
`loadStylesheet` serves those files from constants generated at build time, `loadModule` refuses everything, and `@source` is
never written, because candidates come from us.

**Reading the developer's stylesheet, as data.** `postcss` parses it. Only custom property declarations are read, from `:root`,
`.dark` and `@theme`, and each value passes the value check before it reaches the block. The rest of the file gets ledger
lines: `@utility`, `@plugin`, `@layer` and unknown at-rules are `left`, plain rules go to the stylesheet layer below. A
`tailwind.config.js` is reported as `left`: it is a program, and a theme has to come from CSS. With no tokens, `bg-primary` is
a candidate with no output, so the report says `add-tokens`.

**Extraction.** Candidates come from `className` values through the evaluator, `cn` and `clsx` arguments, and `cva` tables. An
`Unknown` piece (`bg-${color}-500`) is `left`, kind `class-unknown`. No scan of arbitrary strings, because the probe shows that
reads words that are not classes.

**Compile once, map per node.** One `compile` and one `build` over every candidate of the import: compiling per class took 4.6
seconds for 384 in the probe, and a single build is one call. Selectors are unescaped back to candidates, so each entry is
known by its class and its index in the output. Tailwind's output order is the cascade, so a node's entries are taken in that
order, never in the order of the class string. **A candidate with no entry and no marker use is a line.**

**`tailwind-merge`.** Where the source calls `cn` or `twMerge`, the real function runs over the literal strings first: it is our
dependency, on data, not the developer's code. Compiling everything and letting the later rule win would be wrong, because
Tailwind sorts `px-2` and `px-4` by its own order, not the string's. `extendTailwindMerge` is `Unknown`.

**Flattening,** in `flatten.ts`. For each top-level rule of `@layer utilities`, walk with a selector starting at `&` and an empty
`at`:

1. Declarations gathered so far are flushed as an entry **before** any recursion. That is the bug the prototype hit.
2. A nested rule substitutes `&`. A nested at-rule pushes onto `at`.
3. Adjacent entries with one selector and one `at` merge, with a repeated key deleted and re-added so that it stays last.
4. An entry with selector `&` and no `at` goes to Normal, the rest to `props.rules`, in order.

**Rewrites,** each one a table entry with a test:

| Tailwind output | Stored | Disposition |
|---|---|---|
| `@supports (color: color-mix(in lab, red, red))` | Wrapper removed, the inner value replaces the fallback | `converted`. Every browser Tailwind 4 supports has `color-mix`, and it halves the rules |
| `&:hover` under `@media (hover: hover)` | `HOVER_GATE`, so it reads as the Hover state | `adapted`, one difference: a device with hover and a coarse primary pointer shows no hover. Proven equal on desktop Chromium |
| `&:focus-visible`, `&:active` | The Focused and Pressed states | `converted` |
| `&:focus` | A custom rule, not Focused | `converted` |
| `:where(& > :not(:last-child))` | `& > :where(:not(:last-child))` | `adapted`: Tailwind's has no specificity, this one ties with a child's own Normal and wins by order, so a child's own margin loses |
| `--tw-*` in keys, values and `@property` | `--u-tw-*` | `converted`. `@property` is global, and on the canvas the document is the editor's, so this also keeps our names off the editor's `--tw-*` |
| `@keyframes spin`, `enter`, `exit` | `u-spin`, `u-tw-enter`, with `--animate-*` and `animation-name` rewritten | `converted`, the selector contract's rule. Only names this compile produced are rewritten |
| `@media (width < 48rem)` | Stored as is. The parser swaps it | `converted` [proven] |
| `@layer` around anything but `utilities` | Not read. Base styles are the page's | |
| Any selector `parseRule` still refuses | `left`, kind `refused-rule`, with the parser's reason | |

**Tokens.** `bg-primary` compiles to `var(--primary)`, and theme tokens are a separate gap with no home yet (`:root` stays red
under `page-level-css`). Worse, a real published page has the editor's own `--primary` in scope, so an unresolved token shows
the wrong colour with no error. So every token a used value reaches, transitively, is written as a custom property on the root
of the import. The `.dark` values become one rule `&:is(.dark *)` on that root. When theme tokens land, these move there, and
nothing else changes. The base layer's `* { border-color: var(--border) }` reaches them too, so `border` on its own works.

**`@property` definitions** go on the root as `DefinitionRule`s. Identical ones dedupe across a page [code].

**`dark:` is dead on a published page today.** `src/app/layout.tsx` writes `className="light"` on `html` [code], so with shadcn's
`&:is(.dark *)` the rule lands, as the selector contract says, and never matches. One line says so, with `use-system-dark`,
which rewrites to `@media (prefers-color-scheme: dark)`. A project without that `@custom-variant` gets the media form anyway, and
that works.

**Breakpoints.** The defaults are Desktop 1280, Tablet 768, Mobile 320 [code], with overrides under `max-width` queries.

| Tailwind | Width | Page breakpoint | Stored |
|---|---|---|---|
| `sm:` | 640 | none | `at`, literal |
| `md:` | 768 | Tablet's floor | Map: `{ base: <md value>, mobile: <unprefixed> }` |
| `lg:` | 1024 | none | `at`, literal |
| `xl:` | 1280 | Desktop's floor | Map: `{ base: <xl value>, tablet: <unprefixed> }` |
| `2xl:` | 1536 | none | `at`, literal |
| `max-md:` | below 768 | Mobile | Map key `mobile` |
| `max-xl:` | below 1280 | Tablet | Map key `tablet` |

A map keeps the panel useful, and a literal `at` stays exact, and the canvas evaluates it per frame (selector contract). `rem` in a
media query follows the browser's default size, not the page's, so the map changes the result for someone with a non-default
browser font size: `adapted`, once per import. A custom `--breakpoint-*` token is simply a literal `at` unless it equals a floor.

**Caps.** The importer counts rules against `MAX_RULES_PER_NODE` (64) itself, because the emitter would drop later rules with
only a console warning. Over the cap is `left`, kind `cap`, not truncation.

### The stylesheet layer: plain CSS

`radix.css` in the corpus is hand-written CSS, a real case, and an export is plain CSS, so re-import needs it too. A supplied
sheet goes through `parseCssText` (selector slice 8) per rule. A rule whose first compound is a class on an element in the source
becomes `&...` on those nodes: `.tabs-trigger[data-state="active"]` lands on each node with that class. A class matched by no
element, a selector with ancestors outside the component, and `body` or `html` rules are `left`.

**A source without Tailwind assumed browser defaults, and a real page has Tailwind's reset.** So for each tag in such a source, the
importer writes the defaults the reset removes (a heading's size and margin, a list's marker, a button's border). The table is
generated by measuring a browser, and this is **[unproven]**. A Tailwind source writes nothing: the third row of the measured table
shows the base is enough.

### Layer 3: props to inputs

The component's first parameter is read by syntax: destructured names, defaults, and the type annotation.

| Source | Input |
|---|---|
| `string` | `text` |
| `number` | `number` |
| `boolean` | `toggle` |
| A union of string literals | `choice` |
| `VariantProps<typeof x>` | One `choice` per `cva` key, with `defaultVariants` as defaults |
| `ReactNode`, `children` | `slot` |
| A callback (`onChange`) | `event`, when a trigger can `emit` it; otherwise `left` |
| An imported or generic type | `text`, `adapted` |
| A default in the destructure | The input's `default` |
| `className` | Not an input. Its place in `cn` is dropped, `adapted`: a placement has its own style |

An input's `name` is the prop in words (`showBadge` becomes "Show badge"). Reading a prop becomes a `{{input.<id>}}` binding on
that slot, which `mayBindToSlot` and `parseInputValue` then check [code]. A prop read inside a class string, a style value or a rule
is refused by the selector contract ("bindings do not reach rules"), so it is `left` unless it maps to `cva`. A value in a style is
the exception the components contract already allows: `style={{ color: accent }}` binds to `style.color`.

**`cva`.** A variant chosen by a prop is not state, as the components contract says. The element gets a bound `data-u-v-<key>`
attribute, and each variant's classes become rules:

```json
{ "id": "v1", "selector": "&:where([data-u-v-variant=\"outline\"])", "style": { "backgroundColor": "var(--background)" } }
```

`:where`, so a variant adds no specificity. Tailwind gives a variant's class and a base class the same weight, and this keeps that,
with the output order deciding [unproven beyond the button]. A variant's `hover:` becomes `&:where([data-u-v-variant="outline"]):hover`.
`compoundVariants` are chained `:where` conditions. Base classes stay Normal. All of a `cva` table's rules count against the cap.

**Conditions on a prop.** `{badge && <Badge />}` is the existing `visible` slot. Two forms have no home yet, because `parseExpression`
takes exactly one `{{path}}` [code]: `{!open && ...}`, the else branch of `? :`, and `{variant === 'x' && ...}`. So a read binding
gains an optional `test`:

```ts
interface ReadBinding { mode: 'read'; expression: string; test?: { eq?: string | number | boolean; not?: boolean } }
```

Read only on the `visible` slot, and nowhere else. `a ? <X/> : <Y/>` becomes two nodes with opposite tests, which is what it means.

**`{...props}`.** Rest props hold `children`, which `slot` takes, and any attribute at all, which a placement cannot carry. So an
attribute the entry's usage passes through a rest spread (`<Button disabled>`) becomes an input of the matching type, and the
spread itself is one `adapted` line: "other attributes are not kept". Spreading a known object literal is plain attributes.

**`asChild`.** `const Comp = asChild ? Slot : 'button'` is recognised as a pattern. Without `asChild` the tag is the literal. With
`asChild` in an entry, the props and classes go onto the one element child, which is what Radix's `Slot` does. In a definition, `asChild`
is not an input: a stored tag cannot change per placement. `adapted`, with the tag stated.

### The `slot` input

The components contract cut it and sent it here. shadcn's `Card` and every wrapper taking `children` need it.

**In a definition,** a new reserved type, on the pattern of `#text` and `#component`, with default content as its children:

```json
{ "id": "c-body", "type": "#slot", "props": { "input": "children" }, "children": [{ "id": "d1", "type": "p", "props": { "children": "Card content" } }] }
```

`src/lib/components/slot.ts` holds `SLOT_TYPE` and `isSlotType`. `inputs.ts` gains type `slot`, with no value of its own: content
lives in the placement. An input of type `slot` has one `#slot` node, because content has one set of ids.

**In a placement,** this reverses "the model refuses children on a placement": a placement holds children, each with `props.slot:
'<input id>'`. They are real nodes of the page, so selecting, Layers, undo and the panel need no second path. Only a slot child is
allowed: `addChild` on a placement takes a slot id, and a definition with no slot still refuses children.

**Expansion.** `expandPlacements` replaces `#slot` with the matching children, or with the default content when there are none.
The rest follows from whose content it is:

- **Scope.** Content is the page's, so it resolves in the placement's outer scope, as the components contract says. `hydrateNode`
  sees a mark on the first slot node and pops the input frame for that subtree, so `{{input.x}}` there reads the outer placement's.
- **Identity.** Content keeps its own ids, not the placement path. In a row, the row's cloning handles them, as for any node.
- **Breakpoints.** Keyed on the holder's frames, so slot content skips the definition's map rewrite.
- **Cost.** It draws on the same `RenderBudget`, once per node.
- **Detach** puts the children where the `#slot` was. **Literal mode** walks them.
- **Canvas.** The placement stays one selectable thing with slot content as an exception: a click inside the slot selects that
  node, which is what `resolveDropTarget` needs to drop into a slot. Dashed outline on an empty slot. In the definition, `#slot`
  shows its default content.
- **A placement of the same definition may now sit inside itself,** through a slot. It is finite, since the content is the page's,
  and the depth limit of 8 still applies.

**That ends a v1 guarantee, and both contracts named the price.** `X` and `S` can now repeat on a path, so a descendant form would
reach into an inner placement. State compilation changes, for a definition with a `#slot` only, so nothing already stored changes:

| Kind | Compiled form |
|---|---|
| Pointer state, on the root | `&:is(X:hover)` |
| Pointer state, on a descendant | `&:is(X:hover *):not(X:not(:hover) *)` (134 and 204 characters, proven in the components contract) |
| Custom state | The `when` rule inside `@scope ([data-fcs-S="open"]) to ([data-fcs-S])`, proven in all three engines in the behaviour contract |

Fixture: two nested placements of one definition in different states, asserting that the inner descendants follow the inner state.
`applyBehaviour`'s path-uniqueness check for state ids treats a slot boundary as a new path.

### Layer 4: hooks to behaviour

The behaviour contract's import table is the target, and this contract does not restate it. What it adds is how the read is bounded.

**Recognising state.** A `useState` call with a literal initial value, destructured to two names, used only in the shapes below. If a
setter or value escapes (passed to an unknown function, to a child through a prop, into `useEffect`), the state is `left` as a whole,
because a partial state machine looks right and is wrong.

| Handler body | Action |
|---|---|
| `setOpen(!open)`, `setOpen((o) => !o)` | `{ toggle }` |
| `setOpen(true)`, `setTab('x')` | `{ set, value }` |
| `setN(n + 1)` | `{ step }` |
| `e.preventDefault()` | `prevent: true` |
| `if (e.key === 'Escape') ...` | `keys: ['Escape']` |
| Several of these in sequence | `do: [...]`, in order |
| Anything else | `left`, with the handler's line |

React event names map through a closed table, including the one that surprises: `onChange` on a text field is DOM `input`, and
`onDoubleClick` is `dblclick`.

**The render side.** `{open && <X/>}` and `open ? a : b` become `showWhen`. `aria-*={open}` a `bind`. `cn(..., open && 'x')` a rule with
`when`. `data-state={open ? 'open' : 'closed'}` together with `data-[state=open]:x`: the attribute is dropped and the selector becomes
`when`, because behaviour may write only `data-u-*`. `useMemo` over literals and `useCallback` unwrap. `useId` becomes a stored id.
`useRef`, `useEffect`, `useContext`, `useReducer`, custom hooks and fetching are `left`.

Everything goes through `parseBehaviour`. A refusal is a line with its reason, the taint rule above all: a typed value driving anything
but text is reported, never reworked.

**Radix to presets.** A `@radix-ui/react-*` import maps to a preset, whose props are options. shadcn needs one more thing: classes on
each part. So each preset in `src/lib/behaviour/presets/` also exports `importParts`:

```ts
interface PresetImportParts {
  parts: Record<string, { node: string; state?: Record<string, Condition> }>;
  // 'Trigger' -> { node: 'tab', state: { 'data-state=active': { state: 's1', eq: ... } } }
}
```

A part's classes land on that node, and `data-[state=active]:` turns into a `when` through the `state` table, so a class keyed on Radix's
own attribute keeps working although no Radix code runs. A Portal unwraps, since native top-layer elements need none. Overlay classes land
on the dialog as `&::backdrop`, `adapted`.

| Package | Preset or element | State |
|---|---|---|
| `tabs`, `dialog`, `alert-dialog`, `dropdown-menu`, `tooltip`, `accordion`, `collapsible` | The presets, native where the behaviour contract keeps them native | Needs B6 to B8 |
| `slider` | `input type="range"`, `slider-multithumb` for two thumbs | Needs B7 |
| `switch`, `checkbox`, `radio-group` | Native input with `role` | No preset exists: a new one in the slice |
| `toggle`, `toggle-group` | `button` with `aria-pressed`, `toolbar` | Needs B6 |
| `separator`, `label`, `slot`, `visually-hidden` | Static elements | Layer 1 |
| `select`, `popover`, `navigation-menu`, `menubar`, `hover-card`, `context-menu` | `combobox`, native `popover`, `menubar` where a preset exists | Otherwise `left` |
| Anything else | | `left` |

Radix's compiled code is never parsed. Its props and parts are this table, by package name and version range. An unknown major version is
`left`, so a renamed part cannot quietly mean something else.

### Layer 5: loops to bindings

| Source | Becomes |
|---|---|
| `.map` over a literal array or local `const` | Unrolled, one node per item, `converted`. A local list of tabs is content |
| `.map` over a prop | A `list` or `gallery` input with `data-repeat`, `{{item.x}}` bindings, needing components slice 10 |
| `.map` over data the file fetches | `left`. The dialog offers a Collection, which a person connects, because only they know the table |
| `.map` with `index` used in the output | `{ row: 'index' }`, the behaviour contract's expression |
| `.filter`, `.sort`, `.slice`, `.reduce`, nested `.map` on a prop | `left` |
| `key={...}` | Dropped, `converted` |

### Layer 6: AI, on a press

For a `left` region, the report offers `rebuild-with-ai`. Reuses the job route, `resumableRun`, the rate limit and the usage count of the
generator, under a new route `POST /api/ai/import-region`, with the existing permission.

- **One region at a time,** with its evaluated surroundings: the nodes around it, the tokens, the inputs. Never the whole project.
- **Before sending:** a preview of exactly what goes, and a scan for secret-shaped text, which blocks the region until it is cut. A
  person pressed this; nobody's code leaves by default. The CLI has no AI: `left` lines stay in the bundle, and the editor offers them.
- **In the prompt,** source is in the untrusted data section. Comments and strings are content that can carry instructions, which is the
  threat the behaviour contract names ("an AI generator or a page import, steered by content"). Comments are stripped first.
- **Output** passes `validateGeneration`, `parseRule` and `parseBehaviour`. `customCode` is dropped, `navigate` takes site paths only,
  and `MAX_GENERATED_RULES` is lifted to the region's cap, since fidelity is the point, with the motion rule left off for the same reason
  the selector contract gives for imports.
- **It is a proposal.** Shown on the canvas beside the report, marked `rebuilt`, accepted or discarded per region. A `rebuilt` line stays
  in the report for good. If the region's source had a state the proposal cannot prove, the line says so. "The AI tried" is not a match.

Custom code is the remaining route for a `left` region, per the plan: `custom-code` in `next` appears only once C4 exists and the site has
it on. A generator never takes it. Until then a `left` region is a rewrite.

## Untrusted input

Import reads text from strangers: a component off the web, a paste from a chat. The threat is the file, not the person.

| Threat | Answer |
|---|---|
| Code execution while importing | Nothing evaluates source. `ts.createSourceFile` parses only [proven: a module-scope assignment and `throw` did not run]. Layer 2 runs no code from the source: no plugin, config or `loadModule`. The real `tailwind-merge` runs on literal strings. An `eval`-shaped call in `src/lib/reactImport` fails a static test |
| A file that hangs or crashes the parser | Before parsing: at most 64 files, 512 kilobytes per file, 2 megabytes in all, and a cheap bracket-depth scan with a limit of 256, because a stack overflow arrives at 1,000 parentheses. Parse in a worker, `RangeError` caught and turned into a refusal, and a 20 second deadline ending in `worker.terminate()`, which a tab can do and a server thread cannot do as cleanly. So a pathological file costs one worker |
| Our server | It sees no source |
| Candidates as an attack on the compiler | Arbitrary-value classes are data to Tailwind, and each output is parsed. The candidate count is capped at 4,000 |
| `@import`, `@plugin`, `@config` in supplied CSS | Never compile input, see layer 2 |
| A planted external address | See "Values". Rules refuse it, Normal reports it |
| Reading the visitor | Whatever `:is()` and `:has()` an import brings is what the selector contract allows, with its residual route and its open question. Import adds no new capability |
| Script through markup | `readBundle` and the render gate. A `javascript:` link, an `on*` string, `srcdoc` and blocked tags refuse the same way as a stored page does |
| A forged bundle | `readBundle` trusts nothing, see below |
| A hostile definition name or description | Definition names enter AI prompts in the untrusted section already. Length and character limits apply through `parseComponents` |
| Prompt injection | Layer 6 |
| Secrets in pasted source | Not stored, not sent without the press and the scan. The report's excerpt lives in the tab |
| `--measure` | The one execution, on the developer's machine, of their code, with their `node_modules`. Off by default, named in the flag and in its help text, and never run by an automated pipeline we ship |

**Values.** Every imported value goes through the same check a stored value would meet: in rules through `parseRule`, in Normal through
the check `hydrateNode` applies to bound styles. An external `url()` in a rule is refused (`left`). In Normal it is allowed by the format, so it is
kept and marked `external-address`, which needs the person's accept, because a third-party image reaches a visitor's address.

## The import bundle

```ts
interface ImportBundle {
  format: 1;
  sourceHash: string;                    // keys derived state, see backtrack
  nodes?: ComponentSnapshot;             // to place
  definitions?: ComponentDefinition[];   // to add
  report: ImportReport;
}
```

`readBundle(raw, project)` runs for a worker's output and for an uploaded file alike. It applies `parseComponents` (ids, shape, limits,
cycles), `readRules`, `readBehaviourTree`, `parseInputValue` and the render gate over every node, and rewrites ids, so a bundle cannot
collide with or point into the project. What fails becomes a `left` line. A bundle's report is a claim, so `readBundle` also recomputes
the verdict: a forged "imported" with a refused rule reads as what it is.

`ProjectModel.importBundle` is one action and one undo step. Definitions are added under the components contract's limits. Importing needs
the first component button, so it is behind the immutable published copy like slice 8 of that contract: a saved half-finished import must
not reach every page at the next deploy.

## Export

Export is a download from the editor, per definition, page or site. It is a snapshot, so nothing syncs back. `src/lib/reactExport/` is pure and
runs in the tab.

| Stored | Exported |
|---|---|
| A definition | `components/<Name>.tsx`, a function component whose props are its inputs, typed from the input table |
| A placement | `<Card title="..." />`. A slot child is `children` or a named prop |
| A node | Its element. A `#text` is a string among its siblings |
| `style`, `rules`, definitions | `site.css`, one sheet from `buildResponsiveCss` with `surface: 'export'`, and `className` on the element. So the visual result is the published result by construction |
| `{{input.x}}` | `{x}` |
| `visible`, with `test` | `{cond && ...}` |
| `{{row.x}}`, a Collection | A typed `rows` prop and `rows.map`. Content does not leave: a sample may be passed |
| `behaviour` | The stored program as a constant, and `useBehaviour(ref, program)`, which starts the same `startBehaviour`, from a generated `behaviour-runtime.js` |
| Effects | The same constant runtime |
| Islands (forms, commerce, sticky bar) | `islands.tsx` with named components that render their markup and do nothing else. A report line per island: "needs the hosted platform" |
| Custom code | A named stub and a report line, because its host is the platform |
| `slot` | `{children}` |

**Why behaviour is not hand-written hooks.** A closed action list could be compiled to `useState` for simple cases. But "total" needs every
verb, `rove` and focus groups included, and two implementations of one meaning drift. The runtime is the meaning. Simple hooks could
later be a nicer form of the same thing, and it would have to pass the same parity check.

**Generated code is an injection surface.** A stored string written into a `.tsx` file runs on the developer's machine, and a workspace can
hold other people's writes. So every string is written with `JSON.stringify`, text as `{"..."}` expressions, tag and attribute names only after
the vocabulary check, identifiers derived through one function (PascalCase for definitions, camelCase for inputs, reserved words suffixed,
unique per file), and no stored text ever goes into a comment. A test parses each export of a hostile fixture with the TypeScript parser and
fails on any node kind outside an allow list.

The export has a report of its own, in the same ledger shape, so what cannot work off the platform is said, not discovered.

## The round trip

Three properties, in the plan's sense:

1. **Normal form,** as today: nodes to JSX to nodes, over the normalised form. `rules`, `behaviour` and placements are added by selector slice
   10, B13 and components slice 16, which stay as they are. This form exists for the test. A developer never sees it.
2. **Export and back:** export a tree, import the result, and the browser render matches. Not node equality: `rules` become CSS and return
   through the stylesheet layer, so ids and rule shape differ on purpose.
3. **Import and out:** import a fixture, export it, and the browser render matches the original.

Properties 2 and 3 run in `import.score.ts`, and a failure is a named gap.

## The corpus: how success is measured

A real browser, real components, numbers in continuous integration. `corpus.score.ts` compares an original with a hand-written tree. The new
`test/score/import.score.ts` keeps its four checks (screenshot, computed styles, accessibility tree, scripted interaction), at each breakpoint and
state, and takes the replica from the importer. So the tree can no longer be helped by the person writing it.

**Fixtures.** Real source, on two lists:

| Source | Components | Expected route |
|---|---|---|
| `src/components/ui` (real shadcn, already in the repo and pinned by it) | `button`, `input`, `label`, `separator` | Layers 1 to 3 |
| Same | `switch`, `slider`, `collapsible`, `toggle-group` | Layer 4, presets. `slider` has `useMemo`, `toggle-group` has `useContext` for its size and variant, a known `left` to judge |
| Same | `dialog`, `alert-dialog`, `dropdown-menu`, `select` | Layer 4, presets. `alert-dialog` has `useEffect` and `useState`, which is the `left` path |
| `test/score/corpus/fixtures/radix-*.tsx` | Tabs, Dialog, Accordion | Real Radix usage. Already the entries |
| Pinned from `shadcn-ui/ui`, with its license, under `test/score/import/vendor/` | `card`, `badge`, `tabs`, `accordion`, `tooltip`, `checkbox`, `radio-group`, `table`, `sheet` | Those missing from the repo |
| Hand-written for gaps | Plain CSS, `cva` with `compoundVariants`, a `.map` over props, `tailwind.config.js` present | The refusal paths too |

`bottom-sheet.tsx` is local and depends on keyboard insets, so it is excluded with that reason. A compound family's fixture includes a usage
from the shadcn documentation as its entry.

**Held out.** A later batch of upstream shadcn components, added by the operator after slice 12 and scored once before anything is tuned against
it, because a corpus a converter was tuned on measures the tuning. A held-out failure becomes a named gap, and the fixture then joins the
ordinary list, so the next batch has to be new.

**The measures,** per fixture, in `baseline.json` under `import`, ratcheted:

| Measure | Definition | Target |
|---|---|---|
| Conservation | Every source token in the nodes or the report. Mutation run | **100 percent, always.** A failure is a broken build |
| Honesty | Fixtures with verdict `imported` or `imported-with-differences` whose parity fails on a difference no line names | **0, always.** This is what lets a developer believe the report |
| Coverage | Atoms `converted` or `adapted`, over all atoms, without AI | Rises per slice. `adapted` counted apart |
| Parity | Fixtures passing all four checks at every breakpoint and state | All of the first row by slice 6; 80 percent of the rest once B6 to B8 are in. Judgement figures, replaced by the first real score |
| Held out | The same, on the held-out batch, first run | Reported, never ratcheted |
| Round trip | Properties 2 and 3 pass | Every passing fixture |

Honesty matters more than coverage. An importer at 60 percent with an honest report is useful. At 90 percent with one silent difference it is
not, since the developer then has to check everything.

**Harness details.** Parity needs a replica rendered through `renderThroughPublishedPage`, on the base sheet slice 1 adds. The original side
builds with esbuild as `originalDocument` does, with the fixture's real Tailwind output. An original is code we pinned, so running it there
is the same as running any test. A state that changes nothing on the original stays a harness error, as today. `report.ts` gains `import`.

**In the editor there is no match number.** The report says "not measured here: run `fc-import --measure` to compare in a browser". When custom
code's frame exists, an original could run there, and that is a later decision.

## Every reader that has to learn it

| Reader | Change |
|---|---|
| `test/score/roundtrip/jsx.ts` | Its parser moves to `src/lib/reactImport/jsx.ts`. The test imports it. Node-to-JSX stays, as the normal form |
| `src/lib/components/inputs.ts`, `definition.ts`, `placement.ts` | `slot`, one `#slot` per input |
| `ComponentModel.ts` | A placement takes children with a slot id, and refuses them otherwise. `setTag` and text stay refused |
| `src/lib/components/expand.ts`, `detach.ts`, `breakpoints.ts` | `#slot`, its frame pop, its identity, its map rule. New state forms for a definition with a slot |
| `hydrateBindings.ts`, `scope.ts` | The frame pop. `test` on the `visible` slot |
| `bindings/types.ts`, `applyBindings.ts` | `test` |
| `renderComponentNode`, `createComponentElement`, `HeadlessComponentRenderer` | A leftover `#slot` renders its children. `#missing` keeps what it does |
| `ComponentRenderer`, `resolveDropTarget` | Slot content selects and takes drops; the rest of a placement stays one thing |
| `src/lib/behaviour/presets/*` | `importParts` |
| `ProjectModel.ts` | `importBundle` |
| `PublishButton.tsx` (`checkBeforePublish`) | Lists an accepted `left` node |
| `ai/pageGen`, `validate.ts` | The import region prompt, the lifted cap, as options on the existing path |
| `test/score/lib/published.ts`, `run.ts`, `report.ts`, `baseline.json` | The real base sheet, the new score, its section |
| `package.json` | `postcss` becomes a direct dependency, since only `@tailwindcss/postcss` brings it today. `typescript`, `tailwindcss` and `tw-animate-css` stay where they are: the worker chunk is built, and the build stage has them. A new `packages/` workspace for the CLI needs `pnpm-workspace.yaml` |
| `next.config.ts` | The worker chunk, if the bundler needs it. Size checked in the slice |
| `yjsDocShape.ts`, `_schema.ts`, the render gate | No change |

The worker chunk is about the size of TypeScript plus Tailwind, in the order of megabytes, loaded only when the dialog opens. Whether
TypeScript bundles cleanly for a worker with no `ts.sys` is **[unproven]**, and slice 2 proves it first, in a real browser, before anything
builds on it.

## Slices

Each is one file-scoped pull request, green alone, raising `baseline.json` where a number rises. The fleet plan estimated five. The slot, the
presets' parts, the CLI, the AI route and the score were not in that estimate. Goal files carry these numbers as `import-1` and so on.

| # | Slice | Files | Tag | Depends on | Closes |
|---|---|---|---|---|---|
| 1 | `score-real-base` | `test/score/lib/published.ts`, `corpus.score.ts`, `baseline.json`, `report.ts`, a generated base sheet | | none | `publishedDocument` carries the base a real page has. **The goal must allow the baseline to move,** because a fixture that only passed without the reset is a real gap. States the new figures |
| 2 | `import-core` | `src/lib/reactImport/{source,atoms,ledger,report,staticEval,jsx}.ts` and tests, `test/score/roundtrip/jsx.ts` | | none | Limits, depth scan, deadline, `RangeError` as refusal, the static eval test. A real browser Worker parsing a real file, with chunk size stated |
| 3 | `import-tailwind` | `src/lib/reactImport/tailwind/{preamble,compile,flatten,rewrites,breakpoints}.ts`, a generate script, `package.json` (`postcss`) | `lockfile` | 2 | Every row of the rewrite and breakpoint tables, the flush order, silent candidates, marker classes, tokens, `@property`, `dark:`, the cap. The button probe as a unit test |
| 4 | `import-score` | `test/score/import.score.ts`, `test/score/import/*`, `run.ts`, `report.ts`, `baseline.json`, fixtures | | 1, 3 | The harness and all measures. Conservation with its mutation run. Honesty. `button` (no variants yet), `input`, `label`, `separator` as far as they go. Every later slice ratchets here |
| 5 | `import-props` | `src/lib/reactImport/{props,cva,conditions}.ts`, `bindings/types.ts`, `applyBindings.ts`, `hydrateBindings.ts`, `corpus` entries | `renderer` | 4 | Inputs from types, `cva` to `:where` rules, `compoundVariants`, `test`, rest spread, `asChild`. `button` at all variants |
| 6 | `import-stylesheet` | `src/lib/reactImport/stylesheet.ts`, `uaRestore.ts` and its generator | | 4, selector 8 | Plain CSS. The default restore table measured. The `radix.css` classes land |
| 7 | `slot-format` | `src/lib/components/{slot,inputs,definition,placement,expand,detach,breakpoints}.ts`, `hydrateBindings.ts`, `scope.ts`, `ComponentModel.ts`, `renderComponentNode.tsx`, `createComponentElement.tsx`, `corpus/fixtures.ts` | `renderer` | 2 | Format and published. Frame pop, identity, budget, new state forms. The nested fixture |
| 8 | `slot-canvas` | `ComponentRenderer.tsx`, `resolveDropTarget.ts`, `HeadlessComponentRenderer.tsx`, `ComponentSection.tsx` | `renderer` | 7, components 7 | Selecting and dropping into a slot, in a browser. All four stateful paths at model level |
| 9 | `import-entries` | `src/lib/reactImport/{entries,inline,libraries}.ts`, `lucide` table generator | | 5, 7 | Inlining, compound families, the one-definition rule for repeats, `next/*`, `lucide-react`, the file graph. `card` |
| 10 | `import-loops` | `src/lib/reactImport/loops.ts` | | 9, components 10 | Unrolled, `list`, index, every `left` row |
| 11 | `import-hooks` | `src/lib/reactImport/{hooks,events}.ts` | | 9, B3 | `useState` shapes, the escape check, the event table, `when` from classes and `data-state`. A taint refusal reported |
| 12 | `import-radix` | `src/lib/reactImport/radix.ts`, `src/lib/behaviour/presets/*` (`importParts`), the native switch, checkbox and radio presets | | 11, B6, B7, B8 | The package table, version ranges, parts. All three Radix fixtures. Held-out batch scored after this |
| 13 | `import-dialog` | `src/lib/reactImport/{bundle,worker}.ts`, `ImportDialog.tsx`, `ProjectModel.ts`, `PublishButton.tsx` | | 9, components 8 (so the published copy) | `readBundle` with forged input, `importBundle` in one undo step, all four stateful paths, upload and paste in a browser, terminate on a hostile file |
| 14 | `import-cli` | `packages/import-cli/`, `pnpm-workspace.yaml`, `--measure` | `lockfile` | 13 | Root containment, exit codes, a bundle uploaded in a browser. Private until the name is decided |
| 15 | `import-ai` | `src/app/api/ai/import-region/route.ts`, `src/lib/reactImport/aiRegions.ts`, `promptSections`, goldens, `ImportDialog.tsx` | | 13 | Preview, secret scan, comments stripped, `customCode` dropped, proposal per region, `pnpm test:integration`. An injection fixture |
| 16 | `export-core` | `src/lib/reactExport/{identifiers,jsx,inputs,bindings,report}.ts`, `surface: 'export'` in `responsiveCss.ts` | | 5 | Definitions, placements, styles, bindings. The hostile name test. Round trip properties 2 and 3 |
| 17 | `export-behaviour` | `src/lib/reactExport/{behaviour,islands}.ts`, the runtime bundling | | 16, B8 | Behaviour, effects, islands, custom code stub. Radix fixtures through import and out |
| 18 | `export-download` | `ExportDialog.tsx`, a zip step | `lockfile` | 16 | A real download in a browser, opened, built with esbuild, rendered |

Slices 5, 7 and 8 share the `renderer` tag, so the operator runs them in order. Slices 2 to 5 can start now, 7 alongside. Slice 13 is the first
one a person can use, and it waits for the immutable published copy, as components slice 8 does.

**A corpus pass proves less than it reads,** as the sibling contracts say of the matrix. It says these components, pinned, match in Chromium. A
developer's own component is a new fixture, which is why the report, not the score, is what a person relies on.

## What this does not cover

- **Live sync with a code base,** by the decision of 2026-11-01. An import is a copy, and an export is a copy.
- **Whole applications and pages with routing.** A component is the unit. `next/*` beyond `link` and `image`, server components, and
  data fetching are `left`.
- **Other CSS systems:** CSS-in-JS, Sass, and CSS modules. A CSS module's `styles.x` could reach the stylesheet layer later. Today it is `left`.
- **Vue and Svelte.** No.
- **Tailwind version 3 semantics.** The compiler is version 4, so class names mostly work and a changed default is a difference the corpus
  would not see. The report says which compiler ran.
- **A site-wide theme.** Tokens land on the import's root until theme tokens exist.
- **Replacing an existing definition from a re-import.**
- **Page-level CSS from an import:** `html` and `body` rules stay `left`, under the existing gap `page-level-css`.

## Decided here, say so if you disagree

The fleet plan gives contracts to a fresh review agent before fan-out, so these do not wait for Marlin.

1. The conversion runs in the tab or the CLI, never on the server.
2. The CLI holds no login: its output is a file a person uploads.
3. Constant Tailwind preamble, with tokens read as data. A `tailwind.config.js` is not read. Custom utilities are reported.
4. `hover:` takes the Hover state's stricter gate.
5. `color-mix` fallbacks are dropped, because every browser Tailwind 4 supports has it.
6. Tokens land on the import's root. Breakpoints map only at exact floors.
7. `cn` runs the real `tailwind-merge` on literals, where it is called.
8. A `left` line blocks placing until a person accepts it.
9. AI runs only on a press, per region, with a scan. The CLI has none.
10. Behaviour exports as data plus the runtime. Islands export as inert stubs.
11. The editor shows no match number.
12. `slot` is real page children on a placement, which reverses that one model rule.
13. Any state escaping the recognised shapes is `left` as a whole.
14. Slice 1 may lower the baseline, because it corrects what the score compares against. **This is the one line the operator should read twice:**
    the rule is not to lower `baseline.json` unless the goal says so, and this goal has to say so.
15. A Tailwind source writes no reset keys, relying on the page's base. Should a site ever lose that base, every imported node changes. Baking
    the 18 keys also reached zero, so the alternative is known, and costs 18 keys per node.

16. `--measure` is the one exception to "import code must never run". It compiles and runs the developer's own component on their own
    machine, only when they name the flag, and nothing we ship calls it. The goal has no exception, so a reviewer should weigh this: without
    it, a developer can never get a match number for their own component. Removing the flag touches only slice 14.
17. `slot` reverses a rule already on `main`: `ComponentModel` refuses children on a placement. It stays refused for a definition with no slot.

## Open questions

1. **For Marlin: the CLI's public name.** The standard gives `@marlinjai/<product>-cli`, and the product slug today is `framer-clone`. A public npm
   package carrying a competitor's name is an outward commitment, and possibly a trademark problem. Slice 14 builds it private, so nothing waits.
2. **For Marlin: license notice.** An imported shadcn component is derived from MIT code, whose license asks that its notice stay with copies.
   Whether the dialog should say the importing person carries that, or a definition should keep a source note, is a legal call. Nothing depends
   on it to build.
3. **`select`.** Radix `Select` is a custom listbox, and the native `select` looks different. `combobox` is the closest preset. The corpus will
   say whether it passes.
4. **`toggle-group`'s `useContext`,** a shared size and variant from the parent. It could be inlined as a known pattern, or stay `left`.
   Decided by slice 12 from what the fixture shows.
