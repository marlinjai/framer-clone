---
type: plan
status: draft
date: 2026-11-02
title: "Theme tokens and head items: the contract for a site's shared colours and fonts and a page's safe head tags"
summary: "Where a site's colour and font tokens live, how a value refers to one so a rename touches nothing, light and dark without script, how tokens reach the canvas, preview, published page, rules and component definitions, and what the AI and the React importer may do with them. Then which head items a page may hold: meta from a closed list, link from the rels that contact no other host in three browser engines, JSON-LD as inert data, nothing that runs. Tokens sit in Site settings, so they freeze with the published copy. Nine slices, each verified on forward, backtrack, resume and re-entry."
tags: [framer-clone, primitives, theme, tokens, head, seo, renderer, fleet]
projects: [framer-clone]
---

# Theme tokens and head items

This is gap 5 of the [complete primitives plan](2026-11-01-complete-primitives.md), "Page-level items", and part of step 5 of the
[fleet plan](2026-11-01-agent-fleet.md). It specifies, and builds nothing. It covers two of the three things gap 5 names: shared design
tokens and head tags beyond the search metadata. The third, page-wide scripts, belongs to the sandboxed custom code of the
[behaviour contract](2026-11-02-behaviour-model.md): nothing here runs.

Read against commit `50bc4d6`. At that commit the rule format, text nodes, components slices 1 to 5, behaviour B1 to B4 and the render gate
are merged. Open, and named as dependencies below: the immutable published copy (#226), the React importer's slices (none built), and
`checkBeforePublish` growth from components.

**Evidence marks:** **[code]** read here, **[proven]** run for this contract in a real browser or against the real module, **[unproven]**
designed but not run. The probes are outside the repo, at `~/software-dev/decision-pages/2026-11-02-theme-and-head-probes/`:
`next-app` (a real Next 15.5.28 and React 19.1.9 build shaped like the `(site)` route), `head-raw.mjs` and `browser-next.mjs` against it,
`link-rels.mjs` (Chromium 156, Firefox 157, WebKit 27.2), `preconnect.mjs`, `theme.mjs`, `csp.mjs`, and `repo-readers.mts` and
`repo-readers-2.mts`, which call the real modules of this repo.

Short forms: CSS (Cascading Style Sheets), JSON (JavaScript Object Notation), JSON-LD (JSON for Linked Data, the structured data search
engines read), AI (artificial intelligence), CSP (Content Security Policy, the browser's list of what a page may load), HTML (HyperText
Markup Language), SEO (search engine optimisation). A "token" is a named colour or font a site defines once. A "reference" is a style value
that points at one. A "definition" and a "placement" are the components contract's words.

## The decisions

1. **Tokens live in Site settings, as `siteSettings.theme`.** Column, parser, Yjs (the multiplayer sync library) blob and publish path
   already exist, and the published copy freezes `siteSettings`, so a theme can never go live ahead of the pages that use it.
2. **A reference is `var(--fc-t-<id>)`. The id is stable and the name is a label.** A rename touches one field and no node.
3. **No fallback inside a reference, and a deleted token stays behind as a tombstone.** Deleting changes nothing on any page.
4. **Modes are a site setting: `system`, `light` or `dark`.** Dark values come from a media query, so they work with no script. A forced mode
   also decides what a node's own `prefers-color-scheme` rule means. There is no visitor switch.
5. **Published: one sheet on `:root`, in the `(site)` layout.** Everything on the page reaches it, including the consent banner and the default
   404, which sit outside the page tree. Editor surfaces: the same values on a frame wrapper, never on `:root`, because the canvas shares the
   editor's document.
6. **Token values have a closed grammar, and font tokens hold a library id, never text.** So a token cannot hold an address, and no value reaches
   the sheet that this contract did not list.
7. **`--fc-t-*` is reserved.** No node, rule or import may set one.
8. **A small `document` block closes "styles on html":** page colours and font, and a closed list of two properties on `html`.
9. **The AI reads tokens, uses them, and may add new ones. It never edits or deletes one, and it writes no head item.**
10. **The importer keeps its output. Only what its root's custom properties hold changes:** each becomes an alias of a site token.
11. **A head item is data parsed at render.** Three kinds, each emitted from constants plus checked values, in the page's real `<head>`.
12. **No head item contacts another host in a browser, navigates, or changes a security or privacy setting.** Refused by default, listed by
    measurement in three engines. A crawler is not a browser: it may follow an address an item names.

## How Framer does it

The earlier analysis in the complete primitives plan covers states and interactions and says nothing about tokens, so this was read off
`framer.com` today [proven, one page]. Framer stores a colour style by id, emits `body{--token-c534b380-...:#ffffff1a;...}`, 443 of them on that
page, and each use is `var(--token-958e2cd1-...,#000)`, with a literal fallback. So the id and the page-wide custom property are the same
design as here. Three differences: Framer places tokens on `body` and this contract on `:root`, because a `color-scheme` on the root also
drives the browser's own surfaces; Framer repeats a literal in every use and this contract does not, see decision 3; and how Framer switches a
token for dark was not seen, because that page has no dark values. Its head settings were not read.

## The stored shape

```ts
/** siteSettings.theme. Absent or empty emits nothing, so every existing page stays byte for byte the same. */
interface SiteTheme {
  mode: 'system' | 'light' | 'dark';      // default 'light'
  tokens: ThemeToken[];                   // panel order; ids unique
  document: DocumentStyles;
}

type ThemeToken = ColorToken | FontToken;

interface ColorToken {
  id: string;        // ^[a-z0-9]{8}$, minted once, never reused, never shown
  name: string;      // the label: 1 to 40 characters, unique among live tokens of its kind, ignoring case
  kind: 'color';
  light: string;     // the closed colour grammar below
  dark?: string;     // absent: the light value in both modes
  deleted?: true;    // a tombstone, see "Deleting"
}

interface FontToken {
  id: string;
  name: string;
  kind: 'font';
  family: string;    // a FONT_LIBRARY id, or 'system'
  deleted?: true;
}

interface DocumentStyles {
  backgroundColor?: string; // a colour reference
  color?: string;           // a colour reference
  fontFamily?: string;      // a font reference
  scrollBehavior?: 'smooth';
  overflowX?: 'hidden' | 'clip';
}
```

Caps: 200 live tokens. The name is plain text, emitted nowhere in CSS. `normalizeTheme` drops what does not parse, on the way in and on the way
out, as `normalizeSiteSettings` does for every field. It runs on load and on publish, so a forged save reaches no renderer.

**Why Site settings [code].** One JSONB (binary JSON) column, so a new field needs no migration; one Yjs blob; always normalized when read; and
#226's table freezes `siteSettings` in every revision. Its price is one blob, so two people editing tokens in the same second lose one edit to
the last writer. That is accepted: it is the behaviour of every other site setting.

Three traps, each a test in slice T1:

- **`normalizeSiteSettings` drops an unknown key [proven].** So the field is listed there first, or nothing survives a load.
- **The dialog would erase it [code].** `SiteSettingsDialog` edits a draft of the whole object and `updateSiteSettings` replaces the whole
  object, so a dialog opened before a token edit and saved after it would undo that edit. `updateSiteSettings` therefore always keeps the current
  `theme` and `head`, and only `updateTheme` and `updateSiteHead` write them.
- **A tab from before the deploy would erase it [code].** Its `normalizeSiteSettings` has no `theme`, so its save sends none. The rule is the one
  `components` already follows: `saveProject` keeps the stored `theme` and `head` when the incoming object lacks the key. A new build always sends
  the key, so a real clear still works.

**Publishing.** Until #226 lands, save and publish write the same row, so a saved theme would reach visitors at the next cache miss, as a saved
definition would. Same answer as the components contract: slices up to T3 proceed, because no person can create a token yet, and **T4, the first
button that makes a token, waits for #226.** No join work is needed: `siteSettings` is already in its document.

## Referring to a token

```json
{ "color": { "base": "var(--fc-t-ab12cd34)", "tablet": "#222" } }
```

- **Grammar.** `var(--fc-t-<id>)`, exactly, with no spaces and no second argument.
- **A colour reference** may stand wherever a value holds a colour, alone or inside one: a gradient, a shadow, a border shorthand, `color-mix`.
- **A font reference** is the whole value of `fontFamily` and nothing else. Not `font`, because that hides which family loads.
- **Kind mismatch.** A font reference in `color` is invalid CSS and dropped by the browser. The panel never offers it and the AI validator refuses it.

Every existing path carries a reference unchanged [proven]: `parseRule` accepts one in a Hover rule, in a gradient and in a keyframe block,
`parseInputValue` accepts one for a colour input, and `applyResponsiveStyles` moves one into the sheet with its breakpoint map. So rules, definitions
and inputs need no new code to carry a reference.

### Renaming

`name` changes, and nothing else. One undo step, no walk, no node touched, no republish needed for a page to keep working. This is why the id exists.

### Deleting

A colour in use must not change the page, and a walk rewriting every reference is the wrong tool: it costs one edit per use across every page and
definition, and it races a person placing the same colour on another tab.

So **a delete sets `deleted: true`.** The token leaves the pickers and stays in the sheet, with both values, so nothing moves on any surface. A node
that references one shows "Deleted colour: Accent" and offers Detach, which writes the current literal into that one value. Undo restores it.

Each delete also removes every tombstone no value references any more, in the same undo step, so the list stays bounded by what pages use. "Used
in N places" and Replace with another token share that scan, which is a deep search of the project snapshot for the reference text: pages, floating
nodes, rules, keyframe blocks, definitions, placement overrides and inputs, all by construction, because a reference is a string wherever it sits.

### Why no fallback

A reference to nothing fails silently: `color` inherits, `background-color` goes transparent, and a `border` shorthand collapses to `0px` [proven].
Framer's literal fallback is one answer. It is not taken here, for three reasons: the fallback goes stale at the first value edit, so a missing token
shows an old colour rather than the current one; it holds no dark value, where a tombstone holds both; and it doubles the grammar every reader must
parse. A tombstone covers deletion exactly.

What remains is a reference with no token and no tombstone, from a forged save or a peer's concurrent sweep. It is not a safety problem, because it is
a harmless `var()`. It is a correctness one, so **it surfaces:** `checkBeforePublish` lists each with its page, as a warning like a missing component,
and the panel shows "Missing colour" with Detach unavailable and Replace offered. This is the one decision here a reviewer should press on.

### Reserved names

Today a rule can set a token and the AI validator accepts one as a style key [proven], so a node could silently repaint a subtree. `--fc-t-*` joins the
reserved names: `parseRule`, `styleValueProblem` and both renderers refuse it as a style key, by prefix, and the raw field in the panel says why.
A value may still read one, including `--primary: var(--fc-t-ab12cd34)`, which the importer needs.

`@property` on a token name is already refused, because `@property` needs a name starting `--u-` [proven]. That refusal matters: with `inherits: false`
one definition would repaint every use on a page [proven]. It gets a test, so loosening that rule fails loudly.

## The value grammar

The sheet is written raw, and a token applies to the whole document. A hostile value broke out of it three ways in Chromium [proven]: `}` hid the body, `;`
loaded an external `url()` on `:root`, and `</style>` ended the element and ran script.

`cssValueText` is not the guard here: it returned all of those unchanged for a custom property name, along with `url(...)`, `initial` and `var(...)`
[proven]. So the theme does not reuse it alone. `parseColorValue` is a small allowlist that runs first, in `normalizeTheme`, in the panel and in the
AI validator:

| Kind | Allowed | Refused |
|---|---|---|
| Colour | `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; `rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, `color()` holding only numbers, percentages, angles, `none`, `/` and a colour space name; named colours from a list; `transparent`. At most 64 characters | Everything else: `url`, `var`, `calc`, `color-mix`, `light-dark`, `currentcolor`, `initial` and the other wide keywords, any `{ } ; < > \ " '`, comments |
| Font | A `FONT_LIBRARY` id or `system`. The emitted text is `fontStack(family)` or `SYSTEM_FONT_STACK`, from the registry, never stored text | Any other string |

- **No alias between tokens.** `var` is refused, because an alias cycle reads as a missing token [proven]. `--sidebar: var(--background)` in an import resolves to a value first.
- **`oklch(0.205 0 0)` and `oklch(1 0 0 / 10%)` pass,** so shadcn's themes fit unchanged [unproven until T1 has the parser].
- **A wide keyword** in a token silently removes the value [proven for `initial`], so it is refused too.

Because a token holds no address, it cannot make a request conditional on a mode, and the selector contract's decision 6 keeps holding.

## Light and dark

`.dark` is dead on a published page, because the root layout writes `class="light"` [code]. The media query needs nothing: the same sheet showed both
values with no script in Chromium, under `light`, `dark` and `no-preference`, and the last reads as light [proven].

| `mode` | Sheet | `color-scheme` | Root layout |
|---|---|---|---|
| `light` | Light values | `light` | `class="light"`, as today |
| `dark` | `dark ?? light` | `dark` | `class="dark"` |
| `system` | Light, then dark in `@media (prefers-color-scheme:dark)` | `light dark` | `class="light"` |

A site with no tokens and no document block emits nothing, whatever its mode, so every existing page is unchanged.

**A forced mode decides node rules too.** A site set to `light` with a node rule under `@media (prefers-color-scheme: dark)`, on a dark system, shows
the rule while the tokens stay light: a half dark page [proven]. So with `light` or `dark`, emission answers that one media feature as a constant.
The evaluator exists: `surfaces.ts` already reads each media condition to a verdict for the canvas [code]. A constant yes removes the operand, a
constant no drops the rule, and everything else is untouched. `system` emits the rule as stored. `applyResponsiveStyles` gets one option,
`colorMode`, and its callers pass the site's `mode`.

**`&:is(.dark *)` rules.** Forced `dark` writes the class, so a shadcn `dark:` rule works there, and the editor's `.dark` variable block in the published
base sheet comes along, which is right for that site. In `system` no class is written, because the server cannot know, so these rules stay dead,
and the importer's existing `use-system-dark` line stays true.

**No visitor switch.** It would need a stored choice, read before first paint by a script in the head, and every server render would disagree with
it. It is left out, not parked: a site that wants one has `system`. A later behaviour action could add it, and nothing here blocks that.

**The browser's own surfaces.** `generateViewport` in the `(site)` layout emits `color-scheme`, and `theme-color` when the document has a background,
with a `media` pair in `system`. Both reach the real `<head>` for every user agent tested [proven]. The aim is that a dark page is not white before
its first paint; that effect itself was not measured [unproven].

## Where tokens reach

### Published page

`themeCss(theme)`, pure, in `src/lib/site/theme.ts`, is the only emitter:

```css
:root{--fc-t-ab12cd34:#112233;--fc-t-cd34ef56:Fraunces,Georgia,'Times New Roman',serif;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--fc-t-ab12cd34:#eeddcc}}
html{overflow-x:hidden}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
body{background-color:var(--fc-t-11aa22bb);color:var(--fc-t-33cc44dd);font-family:var(--fc-t-cd34ef56)}
```

It renders as `<style data-fc-theme="">` in the `(site)` layout, right after `data-fc-site-base`, not in `renderPublishedPage`, because the default
404 has no page tree and a consent banner sits before it [code]. Both can hold a raw reference: `siteLookFromPages` hands `var(--fc-t-...)` straight
through to inline styles [proven], and with the sheet on `:root` those inline styles resolve. A sheet in a body `<style>` applied to `html` and `body`
in the real Next build, under both modes [proven]. The layout's site comes from the same cached resolution its `generateMetadata` already awaits, so it adds no new failure; if resolving fails, no sheet is written and it logs, as `not-found.tsx` does.

- **`@font-face`.** `collectPageFonts` finds nothing in a reference [proven], so a font token would never load. The theme sheet therefore also holds the
  faces of every font token. A declared face costs nothing until text needs it [code, the registry's own note]. This also covers the default 404, which
  no scan reaches. `collectPageFonts` gets the theme as an optional argument, only so a referenced heading family can still be preloaded.
- **Size.** At most about 16 kilobytes, at the 200 token cap with both values at their longest, on every page. All tokens are emitted rather than those a tree
  uses, because a value bound from the content system can hold a reference no walk sees.
- **Document styles.** Unlayered, so they beat `@layer base` in the published base. With tokens alone a dark site keeps the editor's white body and dark
  text; with the `body` rule both change, and an `input` follows [proven against the real `published-base.css`]. So the panel warns when `mode` is not
  `light` and the document block has no background.
- **Smooth scrolling.** Wrapped in a reduced motion query, unlike the original BusBasis rule, because a visitor who asked for less motion should get it.
  With `siteSettings.smoothScroll` on, Lenis owns scrolling and the line is left out.

### Canvas and preview

The canvas and preview render into the editor's own document, so a rule on `:root` would reach the editor. `themeCss(theme, { scope })` writes the same values
on an attribute instead:

```css
[data-fc-theme]{--fc-t-ab12cd34:#112233;color-scheme:light}
[data-fc-theme][data-fc-theme-mode=dark]{--fc-t-ab12cd34:#eeddcc;color-scheme:dark}
[data-fc-theme=frame]{background-color:var(--fc-t-11aa22bb);color:var(--fc-t-33cc44dd);font-family:var(--fc-t-cd34ef56)}
```

`GroundWrapper` writes `data-fc-theme="frame"` on a viewport frame and `data-fc-theme="floating"` on a floating element, because only a frame stands
for a page, and a floating element must not gain a page background. `PreviewFrame` writes it on its root. In Chromium, on a page standing in for the editor,
nothing outside the attribute saw a value, an editor button kept its look, two frames showed two modes side by side, and the attribute's values
reached a modal `dialog`, its `::backdrop` and a popover [proven]. The `html` line is never emitted here. Whether editor overlays drawn inside a frame
look right under a dark `color-scheme` was not checked [unproven], so T3 checks it in the mounted editor.

**The mode on the canvas.** `editorUI.previewColorMode` is `light` or `dark`. Forced sites show their mode. A `system` site gets a Light and Dark switch on
the top bar, and a change writes nothing to the project. It feeds `surfaceSheet`, so that a `prefers-color-scheme` condition, which the selector contract keeps
dead until previewed, reads the frame's mode as the answer. The node-level preview of one rule stays as it is.

`PageFontFaces` adds the theme's families, for the same reason as the published sheet. Editor surfaces are the same path for every reader, so the panel's
swatches read the token, and a frame in dark mode needs no second tree.

### Rules and definitions

Both hold references as plain strings, so they need nothing [proven]. A definition is site scoped, so its references resolve on any page of that site, and an
override can hold one. Component states compile at expansion and keep the string. A `@keyframes` block can hold one.

Export writes `themeCss` to a `theme.css` beside the component, so that an exported reference still resolves. The export slices of the React contract take that one line.

## Every reader that has to learn it

| Reader | Today [proven unless marked] | Change | Slice |
|---|---|---|---|
| `normalizeSiteSettings` | Drops `theme` | Lists `theme` and `head` | T1 |
| `updateSiteSettings`, `saveProject` | Would erase, see the traps [code] | Keep the stored value | T1 |
| `(site)/layout.tsx`, `app/layout.tsx` | Constant base; `class="light"` [code] | The sheet, `generateViewport`, the `dark` class | T2 |
| `collectPageFonts`, `publishedFontAssets`, `PageFontFaces` | No ids from a reference | Theme faces in the sheet; preload resolves through the theme | T2, T3 |
| `applyResponsiveStyles`, `surfaceSheet` | Emit `prefers-color-scheme` as stored | The `colorMode` option; the canvas reads the frame's mode | T2, T3 |
| `parseRule`, `styleValueProblem`, both renderers | Accept `--fc-t-*` as a style key | Refuse it | T2 |
| `GroundWrapper`, `PreviewFrame`, `EditorUIStore` | Nothing | The attribute, `previewColorMode` | T3 |
| `ColorInput`, `FontFamilySelect`, raw style field | `toPickerHex` reads a reference as no colour [code] | Show the token's chip; a deleted or missing state; pick a token | T4 |
| `checkBeforePublish` | Components and legal only [code] | Missing tokens; refused head items | T4, H3 |
| `styleValueProblem` | Refuses `var()` in a font, so a font token cannot be written | Accepts a reference to a live font token, and only that | T5 |
| `parseColors`, `essentials.ts` and the tells | Read no colour from a reference, so a contrast check goes blind | `resolveTokenRefs(value, theme, mode)` first, once per mode with dark values | T5 |
| `siteContextText` | No theme | Live tokens as delimited data | T5 |
| `reactImport/tailwind/tokens.ts` | Not built | Aliases, see below | T6 |
| `siteLookFromPages`, `ConsentBanner`, `DefaultNotFound` | Pass a reference through to inline styles | None: the sheet reaches them. The legal page look does the same [code] | none |
| `parseInputValue`, `hydrateBindings` | Carry the string | None | none |
| `PageMetadataModel`, `PageSeoMetadata`, `snapshotToComponentNode` | No `head` or `ogType` [code] | `head` as a frozen list, read through `parseHeadItem`; `ogType` | H1 |
| `pageMetadata` | Writes `og:type: website` [code] | Reads `ogType` | H1 |
| `renderSitePage`, `not-found.tsx` | Business JSON-LD only [code] | Items, above any `Suspense` | H2 |

## What the AI may read and write

**Reads.** `SiteContext` gains `theme`: the live tokens with id, name, kind and values, the mode and the document block, as delimited JSON with `<` escaped
like every other owner text. Tombstones are not sent. Head items are not sent.

**Writes, on a generated page.**

- **Uses a token by reference,** and the prompt prefers one to a literal for anything in the palette. The validator accepts a reference to a live token of
  the right kind and refuses any other, with a repair message listing the real ones.
- **May add tokens,** up to 12 in a generation, through a new optional `theme.tokens` field in its output, with `name`, `kind` and values through
  `parseColorValue`. It writes a local name, and the validator mints the id and rewrites the references, so a model never chooses an id. A name that already
  exists with the same values reuses that token; with different ones it is refused, because adding "Accent 2" silently is how palettes rot.
- **Tokens and page land in one undo step.** Rejecting the generation adds nothing.
- **Never** edits a token, deletes one, changes `mode` or the document block, or sets `--fc-t-*`. An existing value applies to every page, and a brief is about one.

**Head items are out of its reach, read and write.** A verification code cannot be guessed, and JSON-LD states facts to search engines: a generated rating or
price is a false claim made in the owner's name. The score records those rows as refused on purpose, the way it does event handlers.

## The React importer's theme lines

These are the importer contract's "Tokens" section and finding R1: a foreign theme must not silently take the editor's colours. That contract says tokens land
on the import's root "until theme tokens exist", and that then "these move there, and nothing else changes". Taking that literally breaks R1, and here is why.

`--border` and `--ring` reach an element through the published base sheet's `* { border-color: var(--border) }`, not through any stored value. Move `--border`
off the root into `--fc-t-<id>` and the base rule reads the editor's `--border` again, which is R1 back [code]. So the import keeps its names, and **each
custom property on the import's root becomes an alias:**

```json
{ "--primary": "var(--fc-t-ab12cd34)", "--border": "var(--fc-t-cd34ef56)", "--radius": "0.625rem" }
```

| Importer line | Becomes |
|---|---|
| A `:root` colour token the root would hold (`--primary: oklch(...)`) | A site colour token named `primary`, and the root holds the alias |
| Its `.dark` value | That token's `dark` slot. The `&:is(.dark *)` rule on the root is no longer written for it |
| Base-reached `--border`, `--ring` | The same, always, which keeps R1's rule |
| Non-colour values (`--radius`) and values outside the grammar (`color-mix`, `var`) | Stay on the root as they are today, with no line, because they lose nothing |
| A `--font-*` naming a `FONT_LIBRARY` family | A font token, with the alias. Any other family keeps its existing line |
| `var(--primary)` in compiled rules and styles | Unchanged. This is what keeps "nothing else changes" true for everything below the root |
| `dark:` utilities on nodes | Unchanged, and `use-system-dark` stays |

**Match or create, by name, ignoring case.** Same name and same values: reuse. Same name and different values: create `primary 2` and write an `adapted` line, because
an import must never change what a site's other pages show. At the token cap the value stays literal on the root, with an `adapted` line.

- `readBundle` proposes the tokens as data. They pass `normalizeTheme` like any other, and the placing action adds them in the same undo step as the definition.
- Under a site's `light` mode an imported dark value is stored and not shown, which matches today, where it never fires.
- Under `dark` or `system` the token's dark value appears, which is a change: imported components finally follow the site.
- **What the panel sees.** A value `var(--primary)` below the root stays a raw value, not a chip. Accepted: the root's alias is what is counted and replaced.

Every fixture still runs under the importer's foreign theme, and that is the measure of this section.

## Head items

### What a page may hold

```ts
type HeadItem =
  | { kind: 'meta'; name: string; content: string }      // <meta name content>
  | { kind: 'property'; property: string; content: string } // <meta property content>
  | { kind: 'link'; rel: LinkRel; href: string; hreflang?: string; type?: string; title?: string }
  | { kind: 'jsonld'; data: Record<string, unknown> };
```

Two homes: `page.metadata.head`, and `siteSettings.head` for what every page carries. A page item replaces a site item with the same key: `name`, `property`, or
`rel` with `hreflang`. JSON-LD has no key, so both emit. Caps: 30 items per page, 20 on a site, 3 JSON-LD per page, content 500 characters, href 2,048, JSON-LD
16 kilobytes after serialising and 12 levels deep.

The refused tags stay refused in nodes: `meta` and `link` remain in `BLOCKED_TAGS`. These items are a separate door with separate rules.

### Safety, per kind

**`meta`, a closed list of exact names, lower case.** `author`, `application-name`, `apple-mobile-web-app-title`, `format-detection`, `rating`, `twitter:site`,
`twitter:creator`, `geo.region`, `geo.placename`, `geo.position`, `google-site-verification`, `msvalidate.01`, `yandex-verification`, `baidu-site-verification`,
`facebook-domain-verification`, `p:domain_verify`, `ahrefs-site-verification`. A new name is a one-line change plus its reason.

**`property`, a closed list:** `article:*`, `product:*`, `profile:*`, `book:*`, `fb:app_id`, `og:locale:alternate`, `og:video`, `og:audio`, each matching
`^[a-z]+(:[a-z_]+)+$`. No `name` and `property` on one tag, no other attribute, ever. `og:video` and `og:audio` hold addresses that sharing crawlers fetch and no
browser does, so they do not touch the claim about browsers.

**What the kind has no way to say, and why.**

| Refused | Why |
|---|---|
| `http-equiv`, any value | Written from a server component, `refresh` navigated the page after under 800 milliseconds [proven]. It also carries `content-security-policy`, which would change a page's policy, and `default-style`. There is no field for it |
| `name="referrer"` | Changed what the page sent to other hosts [proven], and it is a privacy setting, not a label |
| `name="color-scheme"`, `theme-color` | Theme owns both. A hoisted one sat beside the viewport's and the page had two [proven] |
| `viewport` | The route owns it, and it changes layout |
| `charset`, `itemprop` | `charset` is not owner data. `itemprop` is not hoisted, so it stays in the body [proven] |
| `description`, `keywords`, `robots`, `og:title`, `og:description`, `og:image`, `og:url`, `og:site_name`, `og:locale`, `og:type`, `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image` | **Owned.** `pageMetadata` writes them, so a second copy would disagree with the SEO panel. The refusal names the field to use |

`article:*` means little without `og:type: article`, so slice H1 adds `ogType`, `website` by default, to the page metadata, and `pageMetadata` writes it. It is a field, not an item,
so the owned rule stands.

**`link`, a closed list of `rel`, emitted from a table, never from stored text.** `alternate`, `me`, `author`, `license`, `help`, `privacy-policy`, `terms-of-service`.

Measured against another host with nothing else on the page, in Chromium, Firefox and WebKit, counting connections and requests [proven]:

| `rel` | Result | Verdict |
|---|---|---|
| `alternate`, `me`, `author`, `license`, `help`, `privacy-policy`, `terms-of-service` | 0 in all three | Allowed |
| `next` | **Firefox fetched it,** 0 in the others | Refused. Without this run it would have been on the list |
| `prev` | 0 in all three | Refused: nothing reads it, since it only pairs with `next` |
| `search`, `webmention`, `pingback`, `bookmark`, `tag` | 0 in all three | Refused: no use here, and a browser may fetch `search` later |
| `canonical` | 0 in all three | Owned by `pageMetadata` |
| `manifest` | **WebKit fetched it** | Owned, same origin only |
| `icon`, `shortcut icon` | Chromium and Firefox fetched it | Owned by Site settings |
| `apple-touch-icon` | Firefox fetched it; Chromium reported to the policy | Owned |
| `stylesheet` in every spelling tried (`STYLESHEET`, `alternate stylesheet`, ` stylesheet\t`) | Fetched in all three | Refused. Each spelling worked, which is why stored text never reaches the attribute |
| `preload`, `prefetch`, `modulepreload`, `compression-dictionary` | Fetched; WebKit did not fetch the last or `prefetch` | Refused |
| `preconnect` | **WebKit connected** | Refused |
| `dns-prefetch` | 0, but a name lookup cannot be seen by this probe, and Chromium connected for neither this nor `preconnect` even on a local network address, so it may be off under automation | Refused, unproven as harmless |
| Any other value, `mask-icon`, `dictionary` and `expect` among them | Not listed | Refused by default |

- **`href`** is `https:` or a site path, judged as `isSafeAddress` reads it. Another host is allowed, because these rels never request it.
- **`alternate`** needs exactly one of `hreflang`, a language tag or `x-default`, or `type`, from `application/rss+xml`, `application/atom+xml`, `application/feed+json`. `text/css` is refused.
- **`title`** is plain text, `content` the same. React escapes both, so markup in them is only text.

**`jsonld`, data, never text.** The stored form is a parsed object. Emission is `jsonLdScriptText`, the existing function, so `<` becomes `<`, with the type a constant
`application/ld+json`. The owner's text is never written into the element.

Unescaped, `</script><script>...` in a value ran [proven]. Escaped, the same object ran nothing, under `<!--<script>` too, `JSON.parse` of the element gave back every
string including U+2028, and hydration left it in place, with no console error [proven]. The panel parses as the person types and stores nothing that does not parse. It must be
an object with a string `@context` on `schema.org`, and `@type`. A top-level array is split into items.

JSON-LD stays in the body, as the business JSON-LD does today, because only `meta` and `link` are hoisted [proven]. That search engines read it there is Google's documented
behaviour, and not something run here [unproven]. On the home page it emits beside the business block, and both are valid. Values do not bind: a product page's own
structured data belongs to the shop stream, generated from real product data.

### Where they render

Into the real `<head>`. `meta` and `link` written by a server component in `renderSitePage` are hoisted by React. In the real Next build each stood in `<head>` in the raw HTML for all
eight user agents tried, which included a browser, Google's verifier and the Facebook and LinkedIn fetchers, next to Next's own metadata [proven].

That depends on one thing: **the items render above any `Suspense`.** The route has no `loading.tsx` and no boundary around the page today [code], and a suspended subtree would flush
them into the body. Slice H2 asserts on raw HTML from a real build, so a boundary added later fails a test rather than silently losing a site's verification. Next's `other`
field also reaches the head, but it has no `property` form, so one path serves both.

The designed 404 gets its items, through `renderSitePage`. The default 404 gets the site's items. A refused item renders nothing, logs, and appears in `checkBeforePublish`.

`parseHeadItem` is the single entry, pure, in `src/lib/site/headItems.ts`, run at emission because a page is opaque JSON to the save route, and again in the panel. The site settings
copy also passes through `normalizeSiteSettings`.

## Consent and Content Security Policy

**Consent.** The banner gates storage and the tracker (`src/lib/consent/consent.ts`). This contract adds nothing it needs to gate, and that is the reason for the lists above:

- No head item contacts another host in a browser, so none discloses a visitor's address before consent.
- Fonts come only from the registry, which is self-hosted, so a font token cannot reintroduce the Google Fonts problem.
- A token holds no address.
- Nothing stores anything. The mode comes from the system, and the absence of a switch means no stored choice.

**The report-only policy and any later enforced one.**

| Policy, sent by a real server | Theme sheet and inline use | JSON-LD | Note |
|---|---|---|---|
| Report-only, as live | Applied | Readable | No reports [proven] |
| The same three directives enforced | Applied | Readable | Enforcing Marlin's open decision costs this contract nothing [proven] |
| `script-src 'none'` enforced | Applied | Readable, no violation | A data block is not a script [proven]. The boot scripts would still need their own answer |
| `style-src 'self'` enforced | **Gone, as is every inline style** | Readable | [proven] |

So a future `style-src` needs a nonce or hash for every inline `<style>` the page writes, and inline style attributes need `'unsafe-inline'` regardless. The theme sheet is one more
of those and changes nothing about that answer. A `<meta>` policy cannot arrive through a head item. The allowed items make no request, so they add no host to the reported counts.

## Score changes

Every change lands with the slice that earns it, and each slice ratchets the baseline.

**Rows that move.** `pageLevelRows` holds 14 rows. `:root` closes in Format, Published and Canvas with T3, in AI with T5 and in Panel with T4, with a note that it is theme and document
styles, not any declaration on `:root`. The other 13 stay red under `page-level-css`: `@page`, `:first`, `:left`, `:right`, `@view-transition`, `@layer` and the view transition
pseudo-elements. The selector contract cut them too, none is in BusBasis, and owning a page-wide stylesheet is a different question from tokens. T2 edits the gap's text to say so.

**Exclusions.** `head` and `title` stay excluded, as the route's. `meta` and `link` stay excluded as node tags, with their reason changed to point at head items.

**New rows,** kind `page-item`, each with the same columns:

| Rows | Count | Closes with |
|---|---|---|
| Colour token, font token, dark value, each of the three modes, document background, colour and font, `scrollBehavior`, `overflowX` | 11 | T2, T3, T4 |
| `meta` names | 17 | H2, H3 |
| `property` entries | 8 | H2, H3 |
| `link` rels | 7 | H2, H3 |
| JSON-LD | 1 | H2, H3 |

That is 44 rows, of which the 33 head rows are refused on purpose in the AI column, with a named reason. So AI tops out 1.8 percent lower on the widened list, and the arithmetic in the fleet
plan should count it. Each head row's Published cell tests a raw HTML position, not merely that the tag exists.

**BusBasis.** The need `styles on html`, in `test/score/busbasis/pages.ts`, stands on all 14 pages. Its note says the computed styles of `html` are not compared. T2 adds that
comparison for `overflow-x` and `scroll-behavior` and the lift writes `document`, and only then may the need go. That file is held-out, so **the operator makes that one edit,** after
reading the comparison. Style differences on `html` beyond those two would show as they appear.

**Corpus.** New fixtures: `theme-tokens` (a page by reference next to its literal copy), `theme-dark` (the same under each mode and each system setting, where a screenshot is the
check), and `theme-font` (a font token that must load). The harness's `publishedDocument` gains the sheet in the position the layout writes it.

**Render gate.** `pnpm test:render-gate` gains every refused kind, as stored data, through the real emission, in Chromium and WebKit: each `http-equiv`, every `stylesheet` spelling,
hostile JSON-LD, and hostile token values. A detector canary runs with them, as it does today.

## Slices

Each slice verifies the four paths: **F** forward, **B** backtrack and revise (a change invalidates what derives from it, and an unchanged input keeps it), **R** resume from
persistence, **E** re-entry after completion or failure. Types, lint, unit tests and `pnpm score:primitives` run on every one, and `pnpm test:integration` on any that touches a route.
`shared_state` is the fleet's tag.

| Slice | Name | Files | `shared_state` | Depends on |
|---|---|---|---|---|
| T1 | `theme-model` | `src/lib/site/theme.ts`, `siteSettings.ts`, `ProjectModel.ts`, `repository.ts` | | |
| T2 | `theme-published` | `(site)/layout.tsx`, `app/layout.tsx`, `applyResponsiveStyles.ts`, `rules.ts`, `validate.ts`, both renderers, score | `renderer` | T1 |
| T3 | `theme-canvas` | `GroundWrapper.tsx`, `PreviewFrame.tsx`, `surfaceSheet.ts`, `surfaces.ts`, `PageFontFaces.tsx`, `EditorUIStore.ts` | `renderer` | T2 |
| T4 | `theme-panel` | A Theme panel, `ColorInput.tsx`, `FontFamilySelect.tsx`, `publishCheck.ts` | | T3, #226 |
| T5 | `theme-ai` | `validate.ts`, `tells.ts`, `essentials.ts`, `siteContext.ts`, `prompt.ts`, `apply.ts`, `schema.ts` | | T4 |
| T6 | `theme-import` | `reactImport/tailwind/tokens.ts`, `reactImport/bundle.ts` | | T1, import slice 3 |
| H1 | `head-model` | `src/lib/site/headItems.ts`, `PageModel.ts`, `siteSettings.ts`, `publishedHead.ts` | | T1, for the kept keys |
| H2 | `head-published` | `renderSitePage.tsx`, `(site)/not-found.tsx`, `test/renderGate`, score | `renderer` | H1 |
| H3 | `head-panel` | Page settings, `SiteSettingsDialog.tsx`, `publishCheck.ts` | | H2, #226 |

**T1, the model.** `SiteTheme`, `normalizeTheme`, `parseColorValue`, `themeCss`, `resolveTokenRefs`, the reference scan, `updateTheme`, and the two keeps.

- F: add, rename, set dark, delete, and the emitted text, as unit tests. Every grammar row, both ways, including each hostile value of the probe.
- B: a rename changes one field and no page byte. Undo restores a tombstone with its values. Going `system`, `light`, `system` keeps every `dark` value, and the sheet is what `mode` says.
- R: a blob through save, load and Yjs is identical. A malformed token is dropped alone. A bare theme key from an older build is read without throwing.
- E: delete sweeps only what no value references. A dialog opened before an edit and saved after it keeps the edit. A save lacking the key keeps the column, and an explicit empty theme clears it.

**T2, the published page.** The sheet, viewport, class, font faces, forced mode evaluation, reserved prefix, new rows and the `html` comparison.

- F: in a real build and Chromium, computed values per mode and system setting, `html` and `body` included, the consent banner and default 404 reading a reference, and a font loading.
- B: a forced `light` site drops a dark node rule, and `system` keeps it. Changing `mode` changes the sheet on the next read, with no stale cached sheet.
- R: after a cache miss, a site with no theme key emits nothing, byte for byte, by a before and after test on the corpus. An unparseable stored theme emits nothing and logs.
- E: a site that empties its theme returns to no sheet, and `generateViewport` to nothing. Rendering an error page keeps the sheet.

**T3, the canvas.** The scoped sheet, wrappers, mode switch, and the surface's reading of the frame's mode, in the mounted editor.

- F: two frames, or a switch, show both modes with nothing outside changing, including editor overlays under `color-scheme: dark` and a font token loading.
- B: a token edit repaints each frame with no reload. Switching mode changes no project byte, so nothing shows as unsaved.
- R: reload returns the project's state. A peer's edit arrives through Yjs and repaints. `previewColorMode` is not persisted.
- E: leaving preview and returning keeps the choice for the session. A theme emptied live removes the sheet, and floating elements never take a page background.

**T4, the panel.** A Theme panel: list, name, values, mode, document block. Pick a token in `ColorInput` and `FontFamilySelect`, "Used in N places", Replace, Detach, the deleted and missing
states, the warning when a dark mode has no background, and the publish warning. Waits for #226. A colour gesture is one undo step. Proven in the browser, per the fleet's rule.

- F: create, use, rename, edit, publish, and the live page shows it, only after publishing.
- B: a token edit after a reference repaints, with the node unchanged. Undo through each. Replace followed by undo restores each reference.
- R: reload mid-edit keeps the last commit, and an unsaved edit warns the way a page edit does. A published copy keeps the old theme while the draft moves on.
- E: delete, then re-create the name: a new id, and the tombstone untouched. Delete the last token. Publish, then republish, is the same sheet. A forged dangling reference shows Missing, and `checkBeforePublish` names it.

**T5, the AI.** As specified above.

- F: a generation on a site with tokens uses them; one on an empty site adds a few, in one undo step.
- B: rejecting removes both. Regenerating under an edited brief starts from the current theme, not the rejected run's tokens.
- R: a run collected after a lost stream, through the existing GET, applies its tokens with its page. Tokens changed meanwhile are read again at apply, so a name that now differs is refused rather than overwritten.
- E: a repair round after a refused reference converges or fails loudly. A contrast tell fires on a token pair that fails, in both modes. Rerun after failure adds no duplicates.

**T6, the importer.** As specified above, ledger included.

- F: a shadcn theme produces tokens and aliases, and every fixture stays at parity under both themes.
- B: changing the token file discards the proposal, keyed to its inputs like every conversion result. Same inputs keep it.
- R: a bundle read later against a site whose tokens changed re-decides match or create at placing.
- E: re-importing reuses tokens and adds none. A forged bundle with a hostile value is refused by `normalizeTheme`.

**H1, the model.** `HeadItem`, `parseHeadItem`, both homes, the merge, `ogType`, `updateSiteHead`.

- F: every row of every list, both ways. Every refusal above, as a stored item.
- B: a page item replacing a site item, then removed, falls back to the site's. Changing `kind` drops the fields that kind cannot hold.
- R: a save and load round trip. An old page with no `head` reads as empty. A forged item drops alone and its neighbours stay.
- E: over a cap, the later items drop, and the check says so. A cleared list stays cleared after a tab from before the deploy saves.

**H2, the published page.** Emission, new rows, render gate entries.

- F: raw HTML from a real build under the same eight user agents: each tag in `<head>`, JSON-LD parsing back. Chromium, Firefox and WebKit make no request to another host, on a page holding every allowed item.
- B: removing an item removes the tag on the next read, and two pages do not share items.
- R: the published copy serves its own frozen items after a later save.
- E: a designed and a default 404 carry the right items. A test fails when a `Suspense` boundary moves a tag into the body.

**H3, the panel.** A Head section in Page settings and in Site settings: a kind picker, a list of allowed names with what each is for, a JSON-LD editor with live parse errors, the refusal text for an owned name naming the field to use.

- F: add one of each, publish, and the head holds them. A verification item can be added in under a minute.
- B: editing a JSON-LD to invalid keeps the last valid one, and shows why. Undo through each.
- R: reload keeps the list. A half-typed JSON-LD is a local draft, and is not saved.
- E: an item refused after a later code change shows as refused, not silently gone, and can be deleted.

## What this does not cover

- **Page-wide scripts,** by the behaviour contract, sandboxed.
- **Spacing, radius and shadow tokens.** Colour and font are what a site changes as a whole. An import's `--radius` stays on its root. The shape takes a new `kind` without a migration.
- **A visitor's light and dark switch,** see above.
- **Per-page themes and theme variants.** One site, one theme.
- **Tokens shared between sites.** No clipboard path between projects was found [code]. Whichever change adds one meets the dangling reference check.
- **A page-wide stylesheet, `@page`, `@layer` and view transitions,** which stay red.
- **Head items that take bindings,** and product structured data, which the shop stream generates.
- **Enforcing a Content Security Policy,** which stays Marlin's open decision. Nothing here depends on it.

## Decided here, say so if you disagree

The fleet plan gives contracts to a fresh review agent, so these do not wait for Marlin.

1. `siteSettings.theme`, not a new column, accepting last writer wins on the blob.
2. No fallback in a reference, with tombstones, unlike Framer. This is the one to press on: the failure left is a publish warning, not a look that survives.
3. Default `mode` is `light`, and emptiness emits nothing.
4. A forced mode evaluates `prefers-color-scheme` in node rules.
5. Forced `dark` writes `class="dark"`, which wakes the editor's `.dark` variables on that site.
6. No visitor switch.
7. Document styles are in scope, closed at two colours and a font on `body` plus two `html` properties, because every BusBasis page fails on them and the stop condition needs them. The fleet goal named tokens and head items, so this is scope added on purpose.
8. `:root` closes with a note; the other 13 page-level rows stay red.
9. Importer output keeps its names, and its root aliases site tokens. This departs from the importer contract's "these move there", because of `--border`.
10. A token name collision on import makes `primary 2`, and on an AI generation is refused. An import is a person's deliberate act with a report, and a generation is not.
11. The AI may add tokens and writes no head items.
12. `next` and `prev` are out, because Firefox fetches `next` and search engines do not need them.
13. JSON-LD emits in the body.
14. A `style-src` policy stays out of scope, with the cost stated.

## Open questions

None needs an answer before slice T1. Whether a future policy adds `style-src` is the existing open decision on enforcing a Content Security Policy, and this contract only states its price.

**What a fresh review should test, because it is unproven:** whether `dns-prefetch` and Chromium's `preconnect` truly stay silent outside automation (both are refused either way); whether the editor's overlays survive a dark `color-scheme` on a frame; whether a dark page avoids a white first paint; and the row counts, which are this contract's arithmetic, not a score run.
