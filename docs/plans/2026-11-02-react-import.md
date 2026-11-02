---
type: plan
status: draft
date: 2026-11-02
title: "React import and export: the contract for turning a component into primitives, once, without running it"
summary: "How a developer brings a real React component into framer-clone by upload, paste or a command line tool, and takes one out again. The conversion is layered: static JSX through the TypeScript parser, Tailwind through its own compiler fed a constant preamble, props to inputs, known hook patterns to behaviour, loops to bindings, AI only on a person's press for what is left. Source is never evaluated. It is parsed in a Web Worker or on the developer's machine, a shared budget bounds the output, and only data enters a project, through the existing gates. Source reaches the server only as a previewed region a person sends to AI, held in memory, and is never stored. A ledger accounts for every construct, so nothing vanishes unreported, and a verdict may not claim more than the corpus proves. Export writes real function components through the render gate, with a constant runtime for behaviour. Revised after an independent review. Nineteen slices."
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

Read against commit `2289e47`, rebased from `523fe93`. At that commit the rule format with its published and canvas emission,
text nodes, components slices 1 to 5, behaviour B1 and B2, selector slice 10 and the render gate are merged. Open or unbuilt, and
named as dependencies below: the behaviour runtime B3 (#247), the immutable published copy (#226), everything from components
slice 6 on, `parseCssText` (selector slice 8), and `src/lib/behaviour/presets`, which does not exist yet (B6 to B8).

Revised after the independent review of 2026-11-02 (`~/software-dev/decision-pages/2026-11-02-react-import-review.md`, verdict
sound with fixes), whose findings R1 to R15 are applied here. "Review findings not adopted" lists what was changed or declined, with
the evidence.

**Evidence marks:** **[code]** read here, **[proven]** run for this contract with the real package, parser or renderer,
**[unproven]** designed but not run. The probes are kept at `~/software-dev/decision-pages/2026-11-02-react-import-probes/`:
`tw.mjs` (Tailwind output), `parse.mts` (that output through `rules.ts`), `hostile.mjs` (parser limits), `e2e.mts` (one
button end to end), the review's `full.mts`, `desc.mts`, `tw2.mts` and `hostile2.mjs`, and `fix.mts` and `classes.mts`, which run this
revision's rules.

Short forms: JSX (React's markup syntax), CSS (Cascading Style Sheets), CLI (command line interface), AST (abstract
syntax tree, a parser's output), AI (artificial intelligence), JSON (JavaScript Object Notation), API (application programming interface), ARIA
(Accessible Rich Internet Applications). A "candidate" is one class name handed to Tailwind. A "definition" and a
"placement" are the components contract's words.

## The decisions

1. **Source is data. Nothing evaluates it, anywhere, with no exception.** No `eval`, no `new Function`, no `import()` of it, no
   transpile-and-run, on no machine. `roundtrip.score.ts` uses `new Function` on fixtures it owns, and that stays in the test harness.
2. **The conversion never runs on the server.** It runs in a Web Worker in the editor tab, or in the CLI on the developer's machine, under a
   shared budget. The server never parses source, so a hostile file cannot cost the shared Node process anything. Source reaches the
   server in exactly one case: a region a person sends to AI, only the text they previewed, held in memory, never logged or stored.
   Neither source nor excerpts of it are stored anywhere.
3. **There is one door into a project: the import bundle.** Worker and CLI both produce a bundle of data. `readBundle`
   checks all of it through the existing parsers, because a bundle can be forged. No layer is trusted for having run.
4. **Tailwind gets a constant preamble, never the developer's CSS.** Only token values are read from a stylesheet, as
   data. The compiler's two loaders refuse everything outside constants we ship. `@plugin`, `@config` and
   `tailwind.config.js` are programs and are never run.
5. **The ledger is total, and unclaimed means left.** Every construct of the source is listed before conversion starts,
   as `left`, and a layer has to claim it. So nothing vanishes unreported. That says nothing about whether a claim is right, which is
   what the Honesty measure is for.
6. **A half-understood component does not look imported.** A `left` line in the rendered tree blocks placing by default,
   and accepting it is one visible press. A left region shows as a `#missing` node on the canvas and in
   `checkBeforePublish`, and renders nothing for visitors.
7. **AI is the last layer, and it is opt in per region.** Nothing is sent without a press, a preview of what goes, and a
   check for secret-shaped text. Its output is a proposal through the generator's own validator. It never writes custom
   code.
8. **The match is measured only where the original is ours to run: the score.** A person's own component gets a report, not a
   number, and the report says so. A number is never shown that was not taken, and a bundle has no field that could carry one.
9. **Export is total over the stored format, and generated code is treated as an injection surface.** Behaviour exports
   as its data plus the constant runtime, not as hand-written hooks, because only the runtime is exact.
10. **`slot` arrives here,** with its scope rules and the nesting guard the components contract requires of it.

## What was measured

Tailwind 4.2.1, TypeScript 5.9.3, Node 22, Chromium 1248, `rules.ts` at this contract's commit.

**The real button, as far as this goes [proven].** `src/components/ui/button.tsx`, hand-built into the stated output, because no importer
exists: real Tailwind, `style` and `rules`, rendered by `renderPublished`, compared in Chromium with the same button under real Tailwind
across every computed property. Each combination was hovered and focused separately. The first row is three variants; the others are all
7 variants by 4 sizes in one compile, with real `tailwind-merge` on the original side and the real `globals.css` compiled as the page base.

| Setup | Initial | Hover | Keyboard focus |
|---|---|---|---|
| No page base, as `publishedDocument` builds it today | 71 differences | 71 | 63 |
| Rule order as this contract first stated it, editor's theme (review) | 0 | 0 | **4 in 4 combinations** |
| Layered order and order-safe merge (below), editor's theme | 0 | 0 | 0 |
| A theme of its own, tokens only as first stated (review) | **280 in 28** | **224 in 28** | **56 in 8** |
| A theme of its own, with base-reached tokens (below) | 56 in 8 | 0 | 56 in 8 |

The last row is all inherited text colour, on `outline` and `ghost`: 7 colour properties on 8 combinations. It stays, as an `adapted` line
("text colour comes from the page"), because writing a colour on the import's root would stop it inheriting from where it is placed.

The table cost 51 rules with adjacent merging and 40 with the order-safe merge, 33 `@property` definitions for the whole compile, 21 tokens
and 37 style keys, and `parseRule` refused none.

**This shows that real Tailwind output for this component can be represented in `style` and `rules`. It does not show that the importer
works.** The `cva` table was written out by hand, on one width, with no icon child in this run, no disabled state and no dark, in one engine.
The base was compiled from `globals.css`, not taken from a production build. The corpus decides the rest.

**All of `src/components/ui` [proven].** Every string literal in 13 files read as candidates: 384. With a partial theme,
124 produced no CSS and no error. The other 260 flattened to 277 rules, and `parseRule` accepted 277 of 277, including
`&:is(:where(.group)[data-disabled="true"] *)`, `&:is(:where(.peer):disabled ~ *)` and `&>span`. The 124 mix real
misses with words that are not classes, which is the point: the compiler cannot tell them apart for you. Of 96 further classes in the
review, 76 passed directly and 16 were refused or need a rewrite, all covered below.

**Findings that became rules below:**

| Finding [proven] | Rule |
|---|---|
| Tailwind drops an unknown class with no error. `animate-in`, `fade-in-0` and `data-[state=open]:animate-in` all compile to nothing without `tw-animate-css` | A candidate with no output is a ledger line, never skipped |
| `@import "https://evil.test/x.css"` passed `compile()` with both loaders refusing. Whether anything fetched was not observed. `@plugin`, `@config` and a relative `@import` were stopped by the loaders. Hostile candidates produced no output or a refused rule | The developer's CSS is never compile input |
| `bg-[url(https://evil.test/x)]` compiles to a real `background-image` | Every imported value takes the address check, see "Values" |
| `@property --tw-shadow` is refused and `--u-tw-shadow` accepted, with `syntax: "*"` | `--tw-` is renamed `--u-tw-` everywhere, or the ring and shadow utilities break |
| `:where(& > :not(:last-child))` from `space-y-*`, and `:is(& > *)` from `*:`, are refused: a part must start with `&`. `& > *` is accepted | Named rewrites |
| Tailwind's `hover:` emits `@media (hover: hover)`; the Hover state's gate is `@media (hover:hover) and (pointer:fine)` | A named rewrite, or the rule does not read as Hover |
| A declaration and its `@supports` twin are nested in one rule, in order. The first prototype walked children first, and every `/90` colour silently became the opaque fallback | The flattener flushes declarations before it recurses, with a test |
| `border` and `outline` colours come from the base layer, so no utility names `--border` or `--ring`, and a foreign theme took the editor's values with verdict "imported" | Base-reached tokens are always written, and every corpus fixture also runs under a foreign theme |
| In a `cva` table Tailwind sorts `ring-destructive` before `ring-ring`, so base beat the variant, which `tailwind-merge` would have removed | Layered order where `cn` wraps the table |
| The button took 51 rules plus definitions, over the cap of 64, and the emitter dropped the definitions with a console warning | Order-safe merge, and definitions counted apart |
| `[class*='size-']` reads a child's class: original 24px, replica 16px with the class gone, 24px with `u-c-size-6` kept. `.group\/item` is refused for its `\`, `.u-group-item` accepted | Kept classes under one prefix, and named groups rewritten |
| `ts.createSourceFile` overflows the stack: `RangeError` at 1,000 nested parentheses, at 5,000 nested elements, on an unterminated `<div>` run, and with `!`, `typeof`, `new`, `a=>`, ternaries and labels at bracket depth 0 or 2. `a+a+...` and `a()()...` parse and then overflow a recursive walker. 5.8 megabytes of wide JSX took 2 seconds. Parsing ran no source | The whole pipeline is wrapped, and depth is checked on the AST |
| A worker allocating without limit crashed the whole page at about 18 seconds, before any deadline, and save here is manual. 512 kilobytes of `const a=[...b,...b]` reaches billions of nodes | A shared conversion budget, and an offer to save first |

**One finding is about the score, not the import [code].** `publishedDocument` holds only the page's own sheet. A real published page sits under
the root layout, which imports `src/app/globals.css`, so it also has Tailwind's reset, all theme variables, `@layer base`
(`* { border-color; outline-color }`, `body { background; color }`), the editor's utilities, `class="light"` on `html`, `antialiased` and font
variables on `body`, and the `data-fc-site-base` font rule. So today's corpus compares against a page no visitor sees: a fixture can pass there
and differ in production, and a `button` written for browser defaults loses its border on a real page. Slice 1 fixes the harness.

## How a developer uses it

**Paste.** Import dialog, one text area. A fragment of JSX or one file. Good for "this section from my old site".

**Upload.** Drop files or a folder: the component, the files it imports by relative path, and `globals.css` for tokens. No
zip in the first version, because a zip needs its own expansion limits and a folder pick gives the same result.

**Command line.**

```text
fc-import components/ui/button.tsx --css app/globals.css --entry examples/button-demo.tsx --out button.import.json
```

It reads files inside the project root only (no symbolic link out, no `node_modules`), reads `paths` from `tsconfig.json` with
`ts.parseConfigFileTextToJson`, because real ones hold comments, follows `extends` only inside the root, and prints the report with
`file:line` so an editor can jump to it. It runs under the same budget as the worker, because Node's heap exhaustion cannot be caught. The exit code is 0 when imported, 1 with
differences to accept, 2 when not imported, so it fits a pipeline. It holds no login and makes no network call: its output
is a bundle a person uploads. A key for writing into a site would be a new credential for a one-way convenience. `--no-excerpts` leaves
source out of the bundle. There is no flag that runs the component.

In all three the result is the same screen: the report beside a live preview on the canvas, then Place on this page or
Add to components. Import is one undo step. Save here is manual, so opening the dialog with unsaved work offers to save first: a tab can
still die, see "Untrusted input".

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
  excerpt?: string;         // at most 120 characters, whitespace collapsed. Lives in the tab, never stored
  atoms: string[];          // the atom ids this line claims
  kind: LineKind;           // closed list, below
  disposition: Disposition;
  detail: string;           // from fixed templates, so it holds no source text
  next: NextAction[];       // 'rewrite' | 'accept' | 'add-tokens' | 'add-entry' | 'rebuild-with-ai' | 'custom-code' | 'use-system-dark'
  nodeKey?: string;         // the node it landed on or would have, so the report can select it
}

type LineKind =
  | 'element' | 'attribute' | 'spread' | 'expression' | 'statement' | 'import'
  | 'class' | 'class-unknown' | 'css-rule' | 'token'
  | 'hook' | 'handler' | 'loop' | 'condition'
  | 'refused-rule' | 'refused-tag' | 'refused-attribute' | 'external-address' | 'taint' | 'secret'
  | 'cap' | 'unknown-component' | 'unknown-package';

interface ImportReport {
  lines: ImportLine[];
  counts: Record<Disposition, number>;
  verdict: 'imported' | 'imported-with-differences' | 'not-imported';
}
```

**An atom** is derived from the AST by kind, not listed by hand: `atoms.ts` walks every node, and a syntax kind is either an atom or on an
explicit exempt list with a reason (punctuation, trivia). So parameter defaults, type annotations, statements nested in `if` or `try`, JSX
text, class members and every statement count. In a supplied sheet the atoms are selectors, at-rule conditions and declarations. `ledger.open(atoms)`
records each as `left`, by id with its exact source range, and a layer claims an atom to change that. Nothing converts without claiming.

**Conservation test.** An independent walker in the score, sharing no code with `atoms.ts`, compares ranges with the claims, so one broad line
cannot cover what sits inside it. Its mutation run inserts one construct of each syntax kind into a fixture, and passes only if a report line names
that construct's `file:line`.

**What that means.** Conservation shows that nothing vanished unreported. It says nothing about correctness: R1 to R4 of the review were each an atom
honestly claimed `converted`, and wrong. Correctness is Honesty's job, and Honesty sees only fixtures. Both stay.

**The verdict.** `not-imported` with a `left` line in the rendered tree or nothing to place. `imported-with-differences` with an
`adapted` line that changes what a visitor sees. `imported` only with neither. Report grouping: most lines are `converted` and
collapsed to a count, so a person reads the few that need them.

**What is stored.** Nothing of the report but this: a `left` region a person accepted is a `#missing` node holding `{ kind, detail }`, which
`checkBeforePublish` lists. No excerpt and no source. A `rebuilt` line lives for the dialog, and afterwards the result is ordinary nodes.

### Layer 1: static JSX

`ts.createSourceFile` builds the AST, as `test/score/roundtrip/jsx.ts` already does, and that code moves here. The parser reads
one file and resolves nothing. No `ts.createProgram`, because a program reads `lib` files and follows imports. Types are read by
syntax only.

**The closed evaluator,** `staticEval.ts`, answers "what is this expression" with a value or `Unknown`, and it calls nothing:
literals, template strings, local `const`, object and array literals, spreads of those, member access, `? :`, `&&`, `||`, `??`,
at depth 32, charged to the conversion budget, because `const a=[...b,...b]` doubles per level and a template string does too. Objects
are null-prototype, so member access cannot read `constructor` or `__proto__`, and table lookups such as `lucide` names use `Object.hasOwn`. It
holds an environment of known props when inlining an entry. Calls are unknown, except those named under "Known libraries".

**Mapping,** beyond what `jsx.ts` does today:

| Source | Becomes |
|---|---|
| `className` | Layer 2, never a stored class, except classes selectors read (below) |
| `style={{ ... }}` | `props.style`, numbers given React's `px` rule |
| `htmlFor`, `tabIndex`, `aria-*`, `data-*` | As stored, through the render gate's check |
| Fragments | Their children |
| `key` | Dropped, `converted`: it has no meaning in a tree |
| `ref` on a `forwardRef` passing through | Dropped, `adapted` |
| `onClick` and other handlers | Layer 4 |
| `dangerouslySetInnerHTML`, `<script>`, `<style>`, `<iframe>`, any tag or attribute the gate refuses | `left`, kind `refused-tag` or `refused-attribute`. The importer asks the render gate's own functions, because otherwise the gate would drop it silently at render time |
| A `form` with a handler or `action` | `left`, pointing at the form presets: a form on a site works through the island |

**Classes that selectors read.** A compiled selector can read `class` in two ways, and nothing else keeps a class, so each is handled once. All
kept classes carry the prefix `u-c-`, because a raw `size-6` or `fixed` would apply the editor's own utility on the real page and on the
canvas. `globals.css` defines no `u-` name [code].

- **Named markers.** `group` and `peer` compile to nothing and still mean something: `&:is(:where(.group):hover *)` needs an ancestor with that
  class. The class and the selector are rewritten together: `.group` becomes `.u-c-group`, and a named group, whose `.group\/item` the parser
  refuses, becomes `.u-c-group-item`.
- **Attribute selectors on `class`.** The compiled rules are scanned for them, and every source class one could read is kept on its element, with
  a line. shadcn's `[&_svg:not([class*='size-'])]:size-4` then reads `u-c-size-6` unchanged [proven: 24px]. For `^=`, `~=` and `|=` the operand is
  rewritten with the prefix.

`applyResponsiveStyles` keeps a stored class that has no `fc-` prefix [code]. A non-marker class is otherwise never stored.

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

**Reading the developer's stylesheet, as data.** `postcss` parses it. Only custom property declarations are read, from `:root`, `.dark` and `@theme`.
A name must match `^--[a-z0-9-]+$`, because `--*: initial` and `--color-*: initial` pass `postcss` and would reset the theme inside the hole [proven].
Each value passes the value check before it reaches the block. `@layer base` is read as data too, for `*`, `html` and `body`, see "Tokens". The rest of
the file gets ledger lines: `@utility`, `@plugin`, other `@layer` and unknown at-rules are `left`, plain rules go to the stylesheet layer below. A
`tailwind.config.js` is reported as `left`: it is a program, and a theme has to come from CSS. With no tokens, `bg-primary` is a candidate with no
output, so the report says `add-tokens`.

**Extraction.** Candidates come from `className` values through the evaluator, `cn` and `clsx` arguments, and `cva` tables. An
`Unknown` piece (`bg-${color}-500`) is `left`, kind `class-unknown`. No scan of arbitrary strings, because the probe shows that
reads words that are not classes.

**Compile once, map per node.** One `compile` and one `build` over every candidate of the import: compiling per class took 4.6
seconds for 384 in the probe, and a single build is one call. Selectors are unescaped back to candidates, so each entry is known by its class and its
index in the output. **A candidate with no entry and no marker use is a line.**

**Order has two modes,** because the source decides.

- **No `cn` or `twMerge` around the classes:** Tailwind's output order is the cascade, never the order of the class string, because that is what the
  original does.
- **`cn` or `twMerge` wraps a table:** there is no single literal string, since base, variant, size and `className` combine per placement. So rules go
  by source layer: base, then each `cva` key in call order, then compound variants, with Tailwind's order inside a layer. A later layer then beats
  what `tailwind-merge` would have removed, on any shared selector [proven: 0 of 28 on focus, 4 without it]. For each key value, the real `twMerge` runs
  over base plus that value to find what it displaces. A displaced entry under a different selector, which order cannot beat, gains
  `:where(:not([data-u-v-<key>="<value>"]))`. Two keys that conflict with each other follow call order, which a fixture tests.

**`tailwind-merge`.** Over a plain literal list, the real function runs first: it is our dependency, on data, not the developer's code. Compiling
everything and letting the later rule win would be wrong, because Tailwind sorts `px-2` and `px-4` by its own order, not the string's.
`extendTailwindMerge` is `Unknown`.

**Flattening,** in `flatten.ts`. For each top-level rule of `@layer utilities`, walk with a selector starting at `&` and an empty
`at`:

1. Declarations gathered so far are flushed as an entry **before** any recursion. That is the bug the prototype hit.
2. A nested rule substitutes `&`. A nested at-rule pushes onto `at`.
3. An entry with selector `&` and no `at` goes to Normal, the rest to `props.rules`, in order.
4. Entries with one selector and one `at` merge, also when not adjacent, as long as no rule between them sets a property the moved one sets. A
   repeated key is deleted and re-added so that it stays last. For the button this gives 40 rules from 51, where merging by selector alone gives 32 and
   passed only by luck of order.

**Rewrites,** each one a table entry with a test:

| Tailwind output | Stored | Disposition |
|---|---|---|
| `@supports (color: color-mix(in lab, red, red))` | Wrapper removed, the inner value replaces the fallback | `converted`. Every browser Tailwind 4 supports has `color-mix`, and it halves the rules |
| `&:hover` under `@media (hover: hover)` | `HOVER_GATE`, so it reads as the Hover state | `adapted`, one difference: a device with hover and a coarse primary pointer shows no hover. Proven equal on desktop Chromium |
| `&:focus-visible`, `&:active` | The Focused and Pressed states | `converted` |
| `&:focus` | A custom rule, not Focused | `converted` |
| `:where(& > :not(:last-child))` | `& > :where(:not(:last-child))` | `converted`, and `adapted` only when a child really sets that margin: Tailwind's has no specificity, this one wins over the child's own Normal, so `mb-8` under `space-y-4` is 16px, not 32. A line on every use would be noise that hides real lines |
| `:is(& > *)`, `:is(& *)`, from `*:` and `**:` | `& > *`, `& *` | `converted`. The first form is refused, the second accepted [proven] |
| `.group\/x`, `.peer\/x`, `.group`, `.peer` | `.u-c-group-x` and so on, in class and selector | `converted` |
| `--tw-*` in keys, values and `@property` | `--u-tw-*` | `converted`. `@property` is global, and on the canvas the document is the editor's, so this also keeps our names off the editor's `--tw-*` |
| `@keyframes spin`, `enter`, `exit` | `u-spin`, `u-tw-enter`, with `--animate-*` and `animation-name` rewritten | `converted`, the selector contract's rule. Only names this compile produced are rewritten |
| `@media (width < 48rem)` | Stored as is. The parser swaps it | `converted` [proven] |
| `@layer` around anything but `utilities`, in the compile output | Not read. Base styles are the page's, and the source's own base is read as data, see "Tokens" | |
| Any selector `parseRule` still refuses | `left`, kind `refused-rule`, with the parser's reason | |

**Tokens.** `bg-primary` compiles to `var(--primary)`, and theme tokens are a separate gap with no home yet (`:root` stays red
under `page-level-css`). Worse, a real published page has the editor's own `--primary` in scope, so an unresolved token shows
the wrong colour with no error. So on the root of the import go every token a used value reaches, transitively, and **always the base-reached
tokens the source defines**: `--border`, `--ring` and any token named in its `@layer base`, whose `@apply` classes are compiled as candidates to find
them. No utility names those, so "reached" alone left a foreign theme on the editor's colours [proven]. The `.dark` values become one rule
`&:is(.dark *)` on that root. When theme tokens land, these move there, and nothing else changes.

- A source with no such base rule has `currentcolor` borders, so a `border` class on it gets an explicit `borderColor: currentcolor`, or the page's rule
  would colour it **[unproven]**.
- `body` colours in the source's base stay on the page, as one `adapted` line: "text colour comes from the page".

**`@property` definitions** go on the root as `DefinitionRule`s, only those a kept value uses. Identical ones dedupe across a page [code]. They are
global, so they do not belong in a node's rule cap: `readRules` counts definitions under their own `MAX_DEFINITIONS_PER_NODE`, and the page budget still
applies.

**`dark:` is dead on a published page today.** `src/app/layout.tsx` writes `className="light"` on `html` [code], so with shadcn's
`&:is(.dark *)` the rule lands, as the selector contract says, and never matches. One line says so, with `use-system-dark`,
which rewrites to `@media (prefers-color-scheme: dark)`. A project without that `@custom-variant` gets the media form anyway, and
that works.

**Breakpoints.** The defaults are Desktop 1280, Tablet 768, Mobile 320 [code], with overrides under `max-width` queries. A map is written per
property, and only when it is exact:

| Classes on one property | Stored |
|---|---|
| `p-2 md:p-4` | `{ base: md, mobile: p-2 }` |
| `p-2 xl:p-4` | `{ base: xl, tablet: p-2 }` |
| `p-2 md:p-4 xl:p-8` | `{ base: xl, tablet: md, mobile: p-2 }` |
| `max-md:p-4` beside `p-2` | `{ base: p-2, mobile: p-4 }` |
| `max-xl:p-4` beside `p-2` | `{ base: p-2, tablet: p-4 }` |
| `md:` or `xl:` with **no** unprefixed value (`md:grid-cols-2` alone) | `at`, literal: a map's `base` would cascade down, giving two columns on a phone |
| Any `sm:`, `lg:`, `2xl:` (640, 1024, 1536, no page breakpoint), or a custom `--breakpoint-*` that equals no floor | Everything on that property as `at`, literal, so one property never mixes the two |

A map keeps the panel useful, a literal `at` stays exact, and the canvas evaluates it per frame (selector contract). Two differences get one `adapted` line
per import: `rem` in a media query follows the browser's default size, not the page's, so a map differs for someone with a non-default browser font
size; and only maps follow `D(P)`, so on a page whose frames are not the defaults, mapped and literal properties can move apart.

**Caps.** The importer counts rules against `MAX_RULES_PER_NODE` (64) itself, after the merge, because the emitter would drop later rules with
only a console warning. Over the cap is `left`, kind `cap`, not truncation.

### The stylesheet layer: plain CSS

`radix.css` in the corpus is hand-written CSS, a real case, and an export is plain CSS, so re-import needs it too. A supplied
sheet goes through `parseCssText` (selector slice 8) per rule. A rule whose first compound is a class on an element in the source
becomes `&...` on those nodes: `.tabs-trigger[data-state="active"]` lands on each node with that class. A class matched by no
element, a selector with ancestors outside the component, and `body` or `html` rules are `left`.

**A source without Tailwind assumed browser defaults, and a real page has Tailwind's reset.** So for each tag in such a source, the
importer writes the defaults the reset removes (a heading's size and margin, a list's marker, a button's border). The table is
generated by measuring a browser, and this is **[unproven]**. A Tailwind source writes nothing: the measured table shows the page's
base is enough.

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

`:where`, so a variant adds no specificity [proven on the 28 combinations]. Tailwind gives a variant's class and a base class the same weight, and this
keeps that, with order deciding, under "Order has two modes". A variant's `hover:` becomes `&:where([data-u-v-variant="outline"]):hover`.
`compoundVariants` are chained `:where` conditions. Base classes stay Normal. All of a `cva` table's rules count against the cap: 40 for `button.tsx`
with the order-safe merge, and slice 5's goal states the figures for `badge` and `tabs` too.

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

**In a placement,** this reverses "the model refuses children on a placement": a placement holds children, each with `props.slotInput:
'<input id>'`. Not `slot`: that is a real attribute, the gate keeps it, and it means something in a shadow tree [proven]. `slotInput` joins
`NON_DOM_PROPS` in every renderer. The children are real nodes of whatever holds the placement, so selecting, Layers, undo and the panel need no
second path. Only a slot child is allowed: `addChild` on a placement takes a slot id, and a definition with no slot still refuses children. A child whose
`slotInput` names no slot renders nothing, with the warning, and `checkBeforePublish` lists it.

**Expansion.** `expandPlacements` replaces `#slot` with the matching children, or with the default content when there are none.
The rest follows from whose content it is, which is the holder's:

- **Scope.** Content resolves in the placement's outer scope, as the components contract says. Every top-level slot child, not only the first,
  carries a node field `slotOuter`, set at expansion, like `classKey`. `hydrateNode` reads it at its very top, before the `#text` return and the island
  return, and pops the input frame for that subtree. An island's pass honours it the same way.
- **Identity.** Content skips only the prefix of the placement whose slot it fills, and it takes the path of every other enclosing placement. So a
  `Card` with a form in its slot, inside `PricingGrid`, placed twice, gives two forms, `<grid>__<form>` for each grid. On a page the path is empty. In a
  row, the row's cloning handles the rest, as for any node.
- **Breakpoints.** Keyed on the holder's frames. On a page nothing is rewritten. Inside a definition the content takes that definition's mapping, with
  everything else it holds.
- **Cost.** It draws on the same `RenderBudget`, once per node.
- **Detach** puts the children where the `#slot` was. **Literal mode** walks them.
- **Canvas.** The placement stays one selectable thing with slot content as an exception: a click inside the slot selects that
  node, which is what `resolveDropTarget` needs to drop into a slot. Dashed outline on an empty slot. In the definition, `#slot`
  shows its default content.
- **A placement of the same definition may now sit inside itself,** through a slot. It is finite, since the content is the holder's,
  and the depth limit of 8 still applies.

**Changing a definition can no longer lose content quietly.** These rows join the components contract's table, each in one undo step:

| Change to the definition | Stored placements | What a person sees |
|---|---|---|
| **A `#slot` node is deleted, or its input removed** | Each child moves to another slot of the definition if there is exactly one; otherwise it is deleted | The dialog first says how many children, on how many pages, go or move |
| **A slot input's type changes** | The same | The same |

Other definitions' input rules are unchanged. Deleting a `#slot` is not the row "a node holding a binding is deleted", because children have no
other home.

**That ends a v1 guarantee, and both contracts named the price.** `X` and `S` can now repeat on a path, so a descendant form would
reach into an inner placement. State compilation changes, for a definition with a `#slot` only, so nothing already stored changes. The compile itself is
components slices 11 and 12, not on `main` (`expand.ts` strips `componentState` rules today), so this is slice 9, not slice 7:

| Kind | Compiled form |
|---|---|
| Pointer state, on the root | `&:is(X:hover)` |
| Pointer state, on a descendant | `&:is(X:hover *):not(X:not(:hover) *)` (134 and 204 characters, proven in the components contract) |
| Custom state | The `when` rule inside `@scope ([data-fcs-S="open"]) to ([data-fcs-S])`, proven in all three engines in the behaviour contract, and accepted by `parseWrapper` |

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
| `.map` over a literal array or local `const` | Unrolled, one node per item, charged to the budget, `converted`. A local list of tabs is content |
| `.map` over a prop | A `list` or `gallery` input with `data-repeat`, `{{item.x}}` bindings, needing components slice 10 |
| `.map` over data the file fetches | `left`. The dialog offers a Collection, which a person connects, because only they know the table |
| `.map` with `index` used in the output | `{ row: 'index' }`, the behaviour contract's expression |
| `.filter`, `.sort`, `.slice`, `.reduce`, nested `.map` on a prop | `left` |
| `key={...}` | Dropped, `converted` |

### Layer 6: AI, on a press

For a `left` region, the report offers `rebuild-with-ai`. Reuses the job route, `resumableRun`, the rate limit and the usage count of the
generator, under a new route `POST /api/ai/import-region`, with the existing permission.

- **One region at a time,** with its evaluated surroundings: the nodes around it, the tokens, the inputs. Never the whole project.
- **Before sending:** a preview of exactly what goes, mandatory, and the secret scan over the entire payload, surroundings, inputs and tokens
  included, not only the region. A hit blocks until it is cut. The scan is a net, not a guarantee, so the preview is the real control. A person pressed
  this; nobody's code leaves by default. The CLI has no AI: `left` lines stay in the bundle, and the editor offers them.
- **On the server,** the text is held in memory for the job and never logged or stored: `aiLogger` records counts, and `jobRegistry` holds jobs in
  memory [code].
- **In the prompt,** source is in the untrusted data section. Comments and strings are content that can carry instructions, which is the
  threat the behaviour contract names ("an AI generator or a page import, steered by content"). Comments are stripped first.
- **Output** passes `validateGeneration`, `parseRule` and `parseBehaviour`. `customCode` is dropped, `navigate` takes site paths only,
  and `MAX_GENERATED_RULES` is lifted to the region's cap, since fidelity is the point, with the motion rule left off for the same reason
  the selector contract gives for imports.
- **It is a proposal.** Shown on the canvas beside the report, marked `rebuilt`, accepted or discarded per region. If the region's source had a
  state the proposal cannot prove, the line says so. "The AI tried" is not a match.

Custom code is the remaining route for a `left` region, per the plan: `custom-code` in `next` appears only once C4 exists and the site has
it on. A generator never takes it. Until then a `left` region is a rewrite.

## Untrusted input

Import reads text from strangers: a component off the web, a paste from a chat. The threat is the file, not the person.

| Threat | Answer |
|---|---|
| Code execution while importing | Nothing evaluates source. `ts.createSourceFile` parses only [proven: a module-scope assignment and `throw` did not run]. Layer 2 runs no code from the source: no plugin, config or `loadModule`. The real `tailwind-merge` runs on literal strings. An `eval`-shaped call in `src/lib/reactImport` fails a static test. No flag changes any of this |
| A file that overflows the parser or a walker | At most 64 files, 512 kilobytes per file, 2 megabytes in all. After the parse, AST depth is checked with an iterative walk, limit 256, because a bracket scan misses `!`, `a=>`, `if` and `a+a+...` [proven]. Every layer, not only the parse, runs inside one catch, so a `RangeError` anywhere is a refusal with its reason |
| A file whose output explodes | **The conversion budget,** one object across all layers, in worker and CLI alike: 5,000 output nodes, the render limit; 4 megabytes of evaluated text; 5,000 unrolled items; inlining depth 16 with a visited stack, so `function A(){return <A/>}` and two components using each other twice stop. Over budget is a `left` line, kind `cap`, and conversion stops. The input limits bound source, not output, so this is what keeps memory down |
| A file that hangs | A 20 second deadline ending in `worker.terminate()`. Allocation can outrun a deadline and crash the tab, which is why the budget comes first. The cost of a failure is the tab, not "one worker", so the dialog offers to save first |
| Our server | It parses no source. It sees a region only on a person's press |
| Candidates as an attack on the compiler | Arbitrary-value classes are data to Tailwind, and each output is parsed. The candidate count is capped at 4,000 |
| `@import`, `@plugin`, `@config` in supplied CSS | Never compile input, see layer 2 |
| A planted external address | See "Values". Rules refuse it, Normal reports it |
| Reading the visitor | Whatever `:is()` and `:has()` an import brings is what the selector contract allows, with its residual route and its open question. Import adds no new capability |
| Script through markup | `readBundle` and the render gate. A `javascript:` link, an `on*` string, `srcdoc` and blocked tags refuse the same way as a stored page does |
| A forged bundle | `readBundle` trusts nothing, see below |
| A hostile definition name or description | Definition names enter AI prompts in the untrusted section already. Length and character limits apply through `parseComponents` |
| Prompt injection | Layer 6 |
| **A secret in a constant** | `staticEval` resolves local `const`, so `const KEY = "sk_live_..."; <a href={`https://api.x/?key=${KEY}`}>` would be stored and published. So `readBundle` scans the whole bundle: a hit is a `left` line, kind `secret`, that blocks placing. One pattern list is shared with layer 6: vendor prefixes, private keys, signed tokens, connection strings with a password. It is a net, not a guarantee |
| Source left lying around | Held in the tab only. Excerpts are never stored, and `--no-excerpts` keeps them out of a bundle a developer passes on |

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

`readBundle(raw, project)` runs for a worker's output and for an uploaded file alike, inside the worker, so a deep or huge file costs that thread:
a byte cap of 8 megabytes and a depth cap first, then the node budget, before anything reaches MobX-State-Tree. It applies `parseComponents` (ids, shape,
limits, cycles), `readRules`, `readBehaviourTree`, `parseInputValue`, the render gate and the secret scan over every node. What fails becomes a `left` line.

**What it rewrites and refuses.**

- **Ids,** so a bundle cannot collide with the project or point into it. The rewrite reaches every place that holds one: `slotInput`, a `#slot`'s `input`,
  `behaviour` targets and triggers through `remapBehaviourRefs`, `aria-*` and other id references through `idRefs.ts`, and bindings.
- **A `#component`** naming anything but a definition in the same bundle is refused, so a bundle cannot reach into a project's definitions.
- **`className`:** only `u-c-` names survive. On the real page and the canvas the editor's utilities are in scope, so `fixed inset-0 z-50` from a forged
  bundle would draw over the editor, which #246 closed for other routes.

**What it claims.** There is no match field, because nothing can take one. The bundle's lines and verdict are claims: `readBundle` recomputes the verdict
from the tree, so a forged "imported" with a refused rule reads as what it is, and it lists what it found itself. An uploaded report is labelled "stated by
the file, not verified", and only `readBundle`'s own findings read as facts. The worker path in the dialog has no such label, since it ran here.

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
| `style`, `rules`, definitions | `site.css`, one sheet from `buildResponsiveCss` with `surface: 'export'`, and `className` on the element. So the visual result is the published result by construction. This surface names classes `x-<n>`, because `.fc-` names mean something to the renderers and the parser refuses them in a selector |
| `{{input.x}}` | `{props["x"]}`. Every binding path uses bracket access, because the grammar allows `-`, and `row.8f3a-1b` would be a subtraction |
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

**Generated code is an injection surface.** A project is opaque JSON, a stored string written into a `.tsx` file runs on the developer's machine, and a
workspace can hold other people's writes. So:

- **The render gate runs over every node at export,** on values as well as names, with a report line per drop: what a renderer drops at every render
  (`href: "javascript:..."`, a blocked prop) must not reach a file, where React's protection would be all that is left.
- **Strings** are written with `JSON.stringify`, text as `{"..."}` expressions. **Constants** such as a behaviour program are written as
  `JSON.parse("...")`, because as a JavaScript literal `{"__proto__":{...}}` sets the prototype [proven].
- **Tag and attribute names** only after the vocabulary check.
- **Identifiers** through one function: PascalCase for definitions, camelCase for inputs, with reserved words and `React`, `Fragment`, `useBehaviour`,
  `children`, `key`, `ref` and `className` suffixed.
- **File names** unique per download, case-insensitively: `card` and `Card` would overwrite each other on macOS.
- **No stored text** ever goes into a comment.

A test parses each export of a hostile fixture with the TypeScript parser and fails on any node kind outside an allow list. That cannot see `__proto__`, whose
node kinds are all legal, so a second test evaluates nothing and asserts that no object literal in the output has that key.

The export has a report of its own, in the same ledger shape, so what cannot work off the platform is said, not discovered.

## The round trip

Three properties, in the plan's sense:

1. **Normal form,** as today: nodes to JSX to nodes, over the normalised form. `rules`, `behaviour` and placements are added by selector slice
   10, B13 and components slice 16, which stay as they are. This form exists for the test. A developer never sees it.
2. **Export and back,** for fixtures with no behaviour and no island: export a tree, import the result, and the browser render matches. Not node equality:
   `rules` become CSS and return through the stylesheet layer, so ids and rule shape differ on purpose. Behaviour is out, because the export holds a compiled
   program and `useBehaviour`, a custom hook that layer 4 reports as `left`. There is no inverse from the compiled table to stored `behaviour`, and writing one
   would be a second format to keep true. Islands are stubs and cannot come back.
3. **Import and out,** for every fixture: import a fixture, export it, and the browser render matches the original. Behaviour runs here, through the runtime.

Properties 2 and 3 run in `import.score.ts`, and a failure is a named gap.

## The corpus: how success is measured

A real browser, real components, numbers in continuous integration. `corpus.score.ts` compares an original with a hand-written tree. The new
`test/score/import.score.ts` keeps its four checks (screenshot, computed styles, accessibility tree, scripted interaction), at each breakpoint and
state, and takes the replica from the importer, through `readBundle`, the door a person uses. So the tree can no longer be helped by the person writing it.

**Every fixture runs twice, from slice 4:** once under the repo's theme and once under a foreign theme, `test/score/import/foreign-theme.css`, where every token
differs from the editor's. The repo's own components share the editor's theme, so every token error is invisible there. A fixture with a component that has
children has a real one: an icon inside the button, or `[&_svg]` and `has-[>svg]` run on nothing.

**Fixtures.** Real source, on two lists:

| Source | Components | Expected route |
|---|---|---|
| `src/components/ui` (real shadcn, already in the repo and pinned by it) | `button`, `input`, `label`, `separator` | Layers 1 to 3 |
| Same | `switch`, `slider`, `collapsible`, `toggle-group` | Layer 4, presets. `slider` has `useMemo`, `toggle-group` has `useContext` for its size and variant, a known `left` to judge |
| Same | `dialog`, `alert-dialog`, `dropdown-menu`, `select` | Layer 4, presets. `alert-dialog` has `useEffect` and `useState`, which is the `left` path |
| `test/score/corpus/fixtures/radix-*.tsx` | Tabs, Dialog, Accordion | Real Radix usage. Already the entries |
| Pinned from `shadcn-ui/ui`, with its license, under `test/score/import/vendor/` | `card`, `badge`, `tabs`, `accordion`, `tooltip`, `checkbox`, `radio-group`, `table`, `sheet`, `sidebar` | Those missing from the repo. `sidebar` for named groups |
| Hand-written for gaps | Plain CSS, `cva` with `compoundVariants`, a `.map` over props, `tailwind.config.js` present | The refusal paths too |

`bottom-sheet.tsx` is local and depends on keyboard insets, so it is excluded with that reason. A compound family's fixture includes a usage
from the shadcn documentation as its entry.

**Held out.** A later batch of upstream shadcn components, added by the operator after slice 13 and scored once before anything is tuned against
it, because a corpus a converter was tuned on measures the tuning. A held-out failure becomes a named gap, and the fixture then joins the
ordinary list, so the next batch has to be new.

**The measures,** per fixture, in `baseline.json` under `import`, ratcheted:

| Measure | Definition | Target |
|---|---|---|
| Conservation | Every atom claimed, ranges compared. The mutation run names `file:line` | **100 percent, always.** A failure is a broken build. It shows nothing vanished unreported, not that a claim is right |
| Honesty | Fixtures with verdict `imported` or `imported-with-differences` whose parity fails on a difference no line names, under either theme | **0, always.** This is what lets a developer believe the report, as far as the corpus reaches |
| Coverage | Atoms `converted` or `adapted`, over all atoms, without AI | Rises per slice. `adapted` counted apart |
| Parity | Fixtures passing all four checks at every breakpoint and state | All of the first row by slice 6; 80 percent of the rest once B6 to B8 are in. Judgement figures, replaced by the first real score |
| Held out | The same, on the held-out batch, first run | Reported, never ratcheted |
| Round trip | Properties 2 and 3 pass | Every passing fixture in scope of each |

Honesty matters more than coverage. An importer at 60 percent with an honest report is useful. At 90 percent with one silent difference it is
not, since the developer then has to check everything.

**Harness details.** Parity needs a replica rendered through `renderThroughPublishedPage`, on the base sheet slice 1 adds. The original side
builds with esbuild as `originalDocument` does, with the fixture's real Tailwind output. An original is code we pinned, so running it there
is the same as running any test. A state that changes nothing on the original stays a harness error, as today. `report.ts` gains `import`.

**In the editor there is no match number.** The report says "not measured: this report lists what was converted, and only the score compares components in
a browser". It sends nobody off to run anything. When custom code's frame exists, an original could run there, and that is a later decision.

## Every reader that has to learn it

| Reader | Change |
|---|---|
| `test/score/roundtrip/jsx.ts` | Its parser moves to `src/lib/reactImport/jsx.ts`. The test imports it. Node-to-JSX stays, as the normal form |
| `src/lib/rules/rules.ts` | `MAX_DEFINITIONS_PER_NODE`, so definitions leave the rule cap |
| `src/lib/components/inputs.ts`, `definition.ts`, `placement.ts` | `slot`, one `#slot` per input, the two new rows of the change table |
| `ComponentModel.ts` | A placement takes children with a `slotInput`, and refuses them otherwise. `setTag` and text stay refused |
| `src/lib/components/expand.ts`, `detach.ts`, `breakpoints.ts` | `#slot`, its frame pop, its identity, its map rule. New state forms for a definition with a slot |
| `hydrateBindings.ts`, `scope.ts` | The frame pop from `slotOuter`, read before the `#text` and island returns. `test` on the `visible` slot |
| `bindings/types.ts`, `applyBindings.ts` | `test` |
| `renderComponentNode`, `createComponentElement`, `HeadlessComponentRenderer` | A leftover `#slot` renders its children. `slotInput` is stripped. `#missing` keeps what it does |
| `ComponentRenderer`, `resolveDropTarget` | Slot content selects and takes drops; the rest of a placement stays one thing |
| `src/lib/behaviour/presets/*` | `importParts` |
| `ProjectModel.ts` | `importBundle` |
| `PublishButton.tsx` (`checkBeforePublish`) | Lists an accepted `left` node from its `{ kind, detail }`, and a slot child with no slot |
| `ai/pageGen`, `validate.ts` | The import region prompt, the lifted cap, as options on the existing path |
| `test/score/lib/published.ts`, `run.ts`, `report.ts`, `baseline.json` | The base sheet from the production build, `html` and `body` classes, the site base style, the new score, its section |
| `package.json` | `postcss` becomes a direct dependency, since only `@tailwindcss/postcss` brings it today. `typescript`, `tailwindcss` and `tw-animate-css` stay where they are: the worker chunk is built, and the build stage has them. A new `packages/` workspace for the CLI needs `pnpm-workspace.yaml` |
| `next.config.ts` | The worker chunk, if the bundler needs it. Size checked in the slice |
| `yjsDocShape.ts`, `_schema.ts`, the render gate | No change |

The worker chunk is about the size of TypeScript plus Tailwind, in the order of megabytes, loaded only when the dialog opens. Whether
TypeScript bundles cleanly for a worker with no `ts.sys` is **[unproven]**, and slice 2 proves it first, in a real browser, before anything
builds on it.

## Slices

Each is one file-scoped pull request, green alone, raising `baseline.json` where a number rises. The fleet plan estimated five. The slot, the
presets' parts, the CLI, the AI route and the score were not in that estimate. Goal files carry these numbers as `import-1` and so on.

**What slice 1 will do to the numbers, plainly.** It may lower the score for real components, because it stops comparing against a page no visitor sees. That
is honest, and a fixture that falls was never passing in production. How far it falls is not measured yet. Its goal states the new figures.

| # | Slice | Files | Tag | Depends on | Closes |
|---|---|---|---|---|---|
| 1 | `score-real-base` | `test/score/lib/published.ts`, `corpus.score.ts`, `baseline.json`, `report.ts`, `test/score/data/published-base.*`, a script | | none | `publishedDocument` carries the sheet of a real page, **generated from the production build** rather than re-composed: the built CSS, `html` and `body` classes, the site base style. The generated file is committed, so a score run needs no build, and a test fails when `globals.css` changes without a refresh. **The goal must allow the baseline to move** |
| 2 | `import-core` | `src/lib/reactImport/{source,atoms,ledger,report,budget,staticEval,jsx}.ts` and tests, `test/score/roundtrip/jsx.ts` | | none | Limits, the AST depth check, the budget, the whole-pipeline catch, doubling constants and recursive components refused, null-prototype objects, the static eval test. A real browser Worker parsing a real file, with chunk size stated |
| 3 | `import-tailwind` | `src/lib/reactImport/tailwind/{preamble,compile,flatten,rewrites,order,breakpoints,tokens}.ts`, a generate script, `package.json` (`postcss`) | `lockfile` | 2 | Every row of the rewrite and breakpoint tables, the flush order, both order modes, the order-safe merge, silent candidates, classes selectors read, named groups, tokens with base-reached ones, token name refusal, `dark:`, the cap. The button probe as a unit test |
| 4 | `import-score` | `test/score/import.score.ts`, `test/score/import/*` (foreign theme, fixtures), `src/lib/reactImport/{bundle,secrets}.ts`, `run.ts`, `report.ts`, `baseline.json` | | 1, 3 | The harness and all measures, every fixture under both themes, through pure `readBundle`, with forged cases. Conservation with ranges and its mutation run. Honesty. `button` (no variants yet) with an icon child, `input`, `label`, `separator` as far as they go. Every later slice ratchets here |
| 5 | `import-props` | `src/lib/reactImport/{props,cva,conditions}.ts`, `src/lib/rules/rules.ts` (definition cap), `bindings/types.ts`, `applyBindings.ts`, `hydrateBindings.ts`, corpus entries | `renderer` | 4 | Inputs from types, `cva` to `:where` rules in layers, displaced entries, a conflict between two keys and one inside a selector, `compoundVariants`, `test`, rest spread, `asChild`. `button` at all variants. The goal states rule counts for `button`, `badge`, `tabs` |
| 6 | `import-stylesheet` | `src/lib/reactImport/stylesheet.ts`, `uaRestore.ts` and its generator | | 4, selector 8 | Plain CSS with selectors and conditions as atoms. The default restore table measured. The `radix.css` classes land |
| 7 | `slot-format` | `src/lib/components/{slot,inputs,definition,placement,expand,detach,breakpoints}.ts`, `hydrateBindings.ts`, `scope.ts`, `ComponentModel.ts`, `renderComponentNode.tsx`, `createComponentElement.tsx`, `corpus/fixtures.ts` | `renderer` | 2 | Format and published. `slotOuter` on two children, a `#text` child and an island. Identity with a form through a holding definition, placed twice. Budget. `slotInput` stripped. Both change table rows in one undo step |
| 8 | `slot-canvas` | `ComponentRenderer.tsx`, `resolveDropTarget.ts`, `HeadlessComponentRenderer.tsx`, `ComponentSection.tsx` | `renderer` | 7, components 7 | Selecting and dropping into a slot, in a browser. All four stateful paths at model level |
| 9 | `slot-states` | `src/lib/components/expand.ts`, `corpus/fixtures.ts` | `renderer` | 7, components 11 and 12 | The three compiled forms, for a definition with a `#slot` only. The nested fixture, in two states |
| 10 | `import-entries` | `src/lib/reactImport/{entries,inline,libraries}.ts`, `lucide` table generator | | 5, 7 | Inlining under the budget, compound families, the one-definition rule for repeats, `next/*`, `lucide-react`, the file graph. `card` |
| 11 | `import-loops` | `src/lib/reactImport/loops.ts` | | 10, components 10 | Unrolled under the budget, `list`, index, every `left` row |
| 12 | `import-hooks` | `src/lib/reactImport/{hooks,events}.ts` | | 10, B3 | `useState` shapes, the escape check, the event table, `when` from classes and `data-state`. A taint refusal reported |
| 13 | `import-radix` | `src/lib/reactImport/radix.ts`, `src/lib/behaviour/presets/*` (`importParts`), the native switch, checkbox and radio presets | | 12, B6, B7, B8 | The package table, version ranges, parts. All three Radix fixtures. Held-out batch scored after this |
| 14 | `import-dialog` | `src/lib/reactImport/worker.ts`, `ImportDialog.tsx`, `ProjectModel.ts`, `PublishButton.tsx` | | 10, components 8 (so the published copy) | `readBundle` in the worker, the unverified label, `importBundle` in one undo step, the offer to save, all four stateful paths, upload and paste in a browser, terminate on a hostile file |
| 15 | `import-cli` | `packages/import-cli/`, `pnpm-workspace.yaml` | `lockfile` | 14 | Root containment, `tsconfig.json` with comments and `extends`, the budget, `--no-excerpts`, exit codes, a bundle uploaded in a browser. Private until the name is decided |
| 16 | `import-ai` | `src/app/api/ai/import-region/route.ts`, `src/lib/reactImport/aiRegions.ts`, `promptSections`, goldens, `ImportDialog.tsx` | | 14 | Preview, the scan over the whole payload, comments stripped, nothing logged, `customCode` dropped, proposal per region, `pnpm test:integration`. An injection fixture |
| 17 | `export-core` | `src/lib/reactExport/{identifiers,jsx,inputs,bindings,gate,report}.ts`, `surface: 'export'` in `responsiveCss.ts` | | 5, 6, 7 | Definitions, placements, `{children}`, styles under `x-` names, bindings by bracket. The gate on values, `__proto__`, case-insensitive file names, the hostile name test. Round trip properties 2 and 3 without behaviour |
| 18 | `export-behaviour` | `src/lib/reactExport/{behaviour,islands}.ts`, the runtime bundling | | 17, B8 | Behaviour, effects, islands, custom code stub. Radix fixtures through property 3 |
| 19 | `export-download` | `ExportDialog.tsx`, a zip step | `lockfile` | 17, 18 | A real download in a browser, opened, built with esbuild, rendered |

Slices 5, 7, 8 and 9 share the `renderer` tag, so the operator runs them in order. Slices 1 to 5 can start now, 7 alongside. Slice 14 is the first
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
6. Tokens land on the import's root, base-reached ones always. `body` colours stay on the page. Breakpoints map only when exact.
7. `cn` runs the real `tailwind-merge` on literals, and a table wrapped by it orders rules by source layer.
8. A `left` line blocks placing until a person accepts it.
9. AI runs only on a press, per region, with a mandatory preview and a scan. The CLI has none.
10. Behaviour exports as data plus the runtime. Islands export as inert stubs.
11. The editor shows no match number, and a bundle cannot carry one.
12. `slot` is real children on a placement, which reverses a rule already on `main`: `ComponentModel` refuses them. It stays refused for a definition with no
    slot.
13. Any state escaping the recognised shapes is `left` as a whole.
14. Slice 1 may lower the baseline, because it corrects what the score compares against. **This is the one line the operator should read twice:**
    the rule is not to lower `baseline.json` unless the goal says so, and this goal has to say so. It may lower real-component numbers, and that is honest.
15. A Tailwind source writes no reset keys, relying on the page's base [proven on the 28 combinations, with `globals.css` compiled as the base]. Should a site ever
    lose that base, every imported node changes. Baking the 18 keys also reached zero on three variants, so the alternative is known, and costs 18 keys per node.
16. **`--measure` is removed from version 1,** on the review's R7, decided by the operator. The goal says import code never runs, and a file is the threat even on
    the developer's own machine. A developer gets a report, not a number, for their own component. Marlin can say stop: bringing it back touches only slice 15, and
    R7 lists the conditions it would need.
17. Kept classes carry `u-c-`, on import and in a bundle alike.

## Review findings not adopted

Everything in R1 to R15 is applied except the following, each checked rather than waved away. R7 was settled by the operator, see decision 16.

1. **R4 "keep every class on the source elements" and R8 "drop any class `globals.css` defines". Adapted, because the two collide.** `size-6` is the class a
   selector reads, and on a real page it can also be the editor's own utility, so keeping it raw applies foreign CSS and dropping it brings the 16px bug back. Kept
   classes take the prefix `u-c-` instead. `classes.mts`: 16px with no class, 24px with `u-c-size-6`, and `[class*='size-']` needs no rewrite. `globals.css` holds
   no `u-` name. `readBundle` keeps only that prefix, which is stricter than R8 asked for, and it also closes `fixed inset-0 z-50`.
2. **R3 "`@property` in one per-import place". Adapted to a cap of their own.** There is no such place: a one-node import has no other node, a `#text` holds no rules
   (`applyResponsiveStyles` skips it), and a definition has to sit on a node. `readRules` counts every entry under one cap, read at `rules.ts`, so splitting that count
   is the smaller change, and the page's budget still bounds the total.
3. **R8 "drop `match` or label it". Removed instead.** With `--measure` gone, nothing can produce a number, so the field left `ImportReport` altogether.
4. **R5 "check the AST's depth rather than relying on the scan". Applied, and the scan is deleted, not kept beside it.** `hostile2.mjs` shows it passing inputs at
   bracket depth 0, so keeping it would suggest a guarantee it does not give.
5. **R14's first option, the generated runtime in the known table. Not taken, the limit was.** `applyBehaviour` removes `behaviour` and returns a table keyed on
   `classKey ?? id`, and no inverse exists [code]. Recognising the hook would still leave nothing to store. Property 3 still exercises behaviour.
6. **R3's 32 distinct selectors. Not used as the target.** Merging purely by selector reaches 32, but the review itself calls its pass luck of order. The order-safe
   merge gives 40, passes on all 28 combinations in `fix.mts`, and stays under the cap.

## Open questions

1. **For Marlin: the CLI's public name.** The standard gives `@marlinjai/<product>-cli`, and the product slug today is `framer-clone`. A public npm
   package carrying a competitor's name is an outward commitment, and possibly a trademark problem. Slice 15 builds it private, so nothing waits.
2. **For Marlin: license notice.** An imported shadcn component is derived from MIT code, whose license asks that its notice stay with copies.
   Whether the dialog should say the importing person carries that, or a definition should keep a source note, is a legal call. Nothing depends
   on it to build.
3. **`select`.** Radix `Select` is a custom listbox, and the native `select` looks different. `combobox` is the closest preset. The corpus will
   say whether it passes.
4. **`toggle-group`'s `useContext`,** a shared size and variant from the parent. It could be inlined as a known pattern, or stay `left`.
   Decided by slice 13 from what the fixture shows.
