---
type: plan
status: decided
date: 2026-11-02
title: "Theme tokens and head items: the contract for a site's shared colours and fonts and a page's safe head tags"
summary: "Where a site's colour and font tokens live, how a value refers to one so a rename touches nothing, light and dark without script, how tokens reach the canvas, preview, published page, rules and component definitions, how they share the document with a page's `:root` rule, and what the AI and the React importer may do with them. Then which head items a page may hold: meta from a closed list, link from the rels that contact no other host in three browser engines, JSON-LD as inert data, nothing that runs. Tokens sit in Site settings, so they freeze with the published copy. Revised after an independent review. Nine slices, each verified on forward, backtrack, resume and re-entry."
tags: [framer-clone, primitives, theme, tokens, head, seo, renderer, fleet]
projects: [framer-clone]
---

# Theme tokens and head items

This is gap 5 of the [complete primitives plan](2026-11-01-complete-primitives.md), "Page-level items", and part of step 5 of the
[fleet plan](2026-11-01-agent-fleet.md). It specifies, and builds nothing. It covers two of the three things gap 5 names: shared design
tokens and head tags beyond the search metadata. The third, page-wide scripts, belongs to the sandboxed custom code of the
[behaviour contract](2026-11-02-behaviour-model.md): nothing here runs.

Read against commit `a8113ec` plus #261 at `1b7d4c0` (a rule on `:root`, open and on hold). Open, and named as dependencies below: #261, the
immutable published copy (#226), and the React importer's slices (none built). #258, the generator writing rules, has merged.

Revised after the independent review of 2026-11-02 (`~/software-dev/decision-pages/2026-11-02-theme-and-head-review.md`, verdict fix first), whose
findings 1 to 18 are applied here. "Review findings, and what changed" says where each went and what was adapted, with the reason.

**Evidence marks:** **[code]** read here, **[proven]** run for this contract in a real browser or against the real module, **[unproven]**
designed but not run. The probes are outside the repo, at `~/software-dev/decision-pages/2026-11-02-theme-and-head-probes/`:
`next-app` (a real Next 15.5.28 and React 19.1.9 build shaped like the `(site)` route), `head-raw.mjs` and `browser-next.mjs` against it,
`link-rels.mjs` (Chromium 156, Firefox 157, WebKit 27.2), `preconnect.mjs`, `theme.mjs`, `csp.mjs`, `repo-readers.mts` and
`repo-readers-2.mts`, which call the real modules of this repo, `banner-look.mts`, which runs #261's real `legibleLook`, and the review's own, prefixed `review-`.

Short forms: CSS (Cascading Style Sheets), JSON (JavaScript Object Notation), JSON-LD (JSON for Linked Data, the structured data search
engines read), AI (artificial intelligence), CSP (Content Security Policy, the browser's list of what a page may load), HTML (HyperText
Markup Language), SEO (search engine optimisation), MST (MobX State Tree, the editor's model library). A "token" is a named colour or font a
site defines once. A "reference" is a style value that points at one. A "tombstone" is a deleted token kept so references still resolve. A
"definition" and a "placement" are the components contract's words.

## The decisions

1. **Tokens live in Site settings, as `siteSettings.theme`.** Column, parser and publish path already exist, and the published copy freezes
   `siteSettings`, so a theme can never go live ahead of the pages that use it.
2. **A reference is `var(--fc-t-<id>)`. The id is stable and the name is a label.** A rename touches one field and no node.
3. **No fallback inside a reference, and a deleted token stays behind as a tombstone.** Deleting changes nothing on any page. Nothing removes a
   tombstone without a person pressing Clean up, and a value that stops parsing marks its token broken rather than deleting it.
4. **`mode` is optional, and absent means not chosen.** A site with no choice shows light values, keeps every stored rule as it is, and writes no
   `color-scheme`. `system`, `light` and `dark` are a person's choice, and only a forced choice decides what a node's `prefers-color-scheme` rule means.
   Dark values come from a media query, so they work with no script. There is no visitor switch.
5. **Published: one sheet on `:root`, in the `(site)` layout.** Everything on the page reaches it, including the consent banner and the default
   404, which sit outside the page tree. Editor surfaces: the same values on a frame wrapper, never on `:root`, because the canvas shares the
   editor's document.
6. **Token values have a closed grammar, and font tokens hold a library id, never text.** So a token cannot hold an address, and no value reaches
   the sheet that this contract did not list. The grammar only ever widens.
7. **All of `--fc-` is reserved, by one check.** `isPlatformVariable`, exported from `rootProperties.ts`, is the only test, in every reader.
8. **One rule for the document: a page's `:root` rule beats the theme.** The theme's `document` block is the site's default: two colours and a font. Scrolling
   and overflow belong to the `:root` rule alone.
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
/** siteSettings.theme. No mode, no tokens and no document emit nothing, so every existing page stays byte for byte the same. */
interface SiteTheme {
  mode?: 'system' | 'light' | 'dark';     // absent: not chosen
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
  broken?: true;     // a value that no longer parses, kept as stored, see "When a value stops parsing"
}

interface FontToken {
  id: string;
  name: string;
  kind: 'font';
  family: string;    // a FONT_LIBRARY id, or 'system'
  deleted?: true;
}

/** The site's default for what a page inherits. A page's `:root` rule beats each of these. */
interface DocumentStyles {
  backgroundColor?: string; // exactly a colour reference
  color?: string;           // exactly a colour reference
  fontFamily?: string;      // exactly a font reference
}
```

Caps: 200 live tokens and 500 tombstones, because `siteSettings.ts` promises a stored blob never grows without bound. **They are enforced at write:** `updateTheme`, the AI apply and the import
placing refuse what would pass one, and the server's `saveProject` refuses it again (`themeBoundsErrors`, `InvalidSiteThemeError`, 400) together with a new or renamed name over 40 characters, so a request built by hand cannot grow the blob either; a stored count over a cap may stay or shrink. At the tombstone cap Delete is refused with a pointer to Detach and Replace, which empty a tombstone of uses, and to Clean up, which then removes it. The name is plain text, emitted nowhere in CSS.
**`normalizeTheme` on read keeps what is stored,** so a frozen revision never loses a referenced token: it drops only a token whose id fails its pattern, since no reference can name it, and
a blob over a cap, forged or older, emits the first tokens up to the cap and logs a warning.

**Why Site settings [code].** One JSONB (binary JSON) column, so a new field needs no migration; always normalized when read; and #226's table freezes `siteSettings` in every revision.
Yjs (the multiplayer sync library) has a blob key for it, but nothing outside `src/lib/multiplayer` imports Yjs today, so there is no live sync to design for: this contract's
concurrency is two tabs and a Save, and the [#226 revision](#publishing).

Four traps, each a test in slice T1:

- **`normalizeSiteSettings` drops an unknown key [proven].** So the field is listed there first, or nothing survives a load.
- **The dialog would erase it [code].** `SiteSettingsDialog` edits a draft of the whole object and `updateSiteSettings` replaces the whole
  object, so a dialog opened before a token edit and saved after it would undo that edit. `updateSiteSettings` therefore always keeps the current
  `theme` and `head`, and only `updateTheme` and `updateSiteHead` write them.
- **A tab from before the deploy would erase it [code].** Its save sends no `theme`. `projectToPersisted` runs `normalizeSiteSettings` before `saveProject`, so once that function lists
  `theme` the missing key is invisible by the time the repository sees it. So `projectToPersisted` reads the raw key, as it does for `components`, and passes `theme` and `head` on
  only when present, and `saveProject` keeps the stored value otherwise. A new build always sends both keys, so a real clear still works.
- **A second tab puts an old theme back, with no warning [code].** Save posts the whole snapshot, and `versionContent` in `src/stores/openProject.ts` compares pages and definitions only. A
  tab loaded before a token edit would write its stale theme over every page. The components contract closed the same hole for definitions, for the same reason. So `ProjectContent` and
  `VersionContent` gain `theme` and the site's `head`, the three `markServerVersion` callers (`openProject.ts`, `PublishButton.tsx`, `SaveButton.tsx`) already pass the whole snapshot, so `versionContent` reads `siteSettings` from it with no caller change, and `changedElsewhereMessage` names them. With that warning, last
  writer wins on one blob is accepted: it is how every other site setting behaves.

<a id="publishing"></a>**Publishing.** Until #226 lands, save and publish write the same row, so a saved theme would reach visitors at the next cache miss, as a saved
definition would. Same answer as the components contract: T1 to T3 proceed, because no person can create a token yet, and **T4 and T6, the first two ways to make a token, wait for #226.** No join
work is needed: `siteSettings` is already in its document.

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
definition.

So **a delete sets `deleted: true`.** The token leaves the pickers and stays in the sheet, with both values, so nothing moves on any surface. A node
that references one shows "Deleted colour: Accent" and offers Detach, which writes the current literal into that one value. Undo restores it.

**Nothing removes a tombstone automatically.** A sweep would have to know every use, and it cannot: a value bound from a content collection can hold a reference no project scan sees. So the panel offers **Clean up
unused**, which lists the tombstones it found no use of and removes them on a press, in one undo step, saying that content collection values are not scanned.

"Used in N places", Clean up and Replace with another token share one scan: a deep search of the project snapshot for the reference text, across pages, floating nodes, rules, keyframe blocks,
definitions, placement overrides, inputs **and `theme.document`**, because a reference is a string wherever it sits. A token used only as the page background is a named test.

### When a value stops parsing

`normalizeTheme` runs on what a frozen revision holds, and a revision stays live for up to 30 versions. So if a later build read a stored value more strictly, or a family left `FONT_LIBRARY`, dropping the token
would kill every reference on a live page, with no publish to warn at, and the next save would make that permanent. So:

- **A colour token whose value stops parsing keeps its id and stored text and gains `broken: true`.** The stored text is never emitted, and is kept only up to 256 characters, beyond which it is replaced by nothing. When no value of the token reads, the sheet holds nothing for it, its references show as broken and behave as missing, the panel shows it with its text, and `checkBeforePublish` names it. When only one value fails, the sheet still emits the other (an unreadable dark value means the light one shows in both schemes, an unreadable light value means nothing in light and the dark value in dark), so its references stay live and the panel and `checkBeforePublish` say exactly that (`colorReadability`, `colorPartialProblem`, PR #306 review).
- **`broken` is recomputed on every read** from the stored text, and a stored flag is ignored. So a value an older container marked during a rollout reads as valid again under the build that accepts it.
- **A font token with an unknown family emits `SYSTEM_FONT_STACK`,** so text stays readable, and the panel shows it.
- **The grammar only widens.** A test holds a list of accepted values, and removing one fails it.

### Why no fallback

A reference to nothing fails silently: `color` inherits, `background-color` goes transparent, and a `border` shorthand collapses to `0px` [proven].
Framer's literal fallback is one answer. It is not taken here, for three reasons: the fallback goes stale at the first value edit, so a missing token
shows an old colour rather than the current one; it holds no dark value, where a tombstone holds both; and it doubles the grammar every reader must
parse. A tombstone covers deletion exactly, and Save writes pages and theme from one tab together, so a stale tab overwrites both and stays consistent.

What remains is a reference with no token, from a forged save or a broken value. It is not a safety problem, because it is a harmless `var()`. It is a correctness one, so **it surfaces:**
`checkBeforePublish` lists each with its page, as a warning like a missing component, and the panel shows "Missing colour" with Replace offered.

### Reserved names

Today a rule can set a token, the AI validator accepts one as a style key, and a keyframe block can too: `@keyframes u-a{to{--fc-t-a:red}}` passed `parseRule` and repainted a subtree in Chromium [proven]. #261 already
refuses `--fc-` on `:root`, through a private constant. So `rootProperties.ts` **exports one `isPlatformVariable(key)`**, case-sensitive on the raw key as custom properties are, and every reader uses it: `isRootStyleKey`,
`refusedBody` (not `parseSelectorRule`, so keyframe and definition bodies are covered), `styleValueProblem`, both renderers' style gate and the panel's raw field. All of `--fc-` is reserved everywhere, which also stops a node
writing `--fc-sticky-cta-h`. The renderers' own passes write `--fx-*` and sheet text, not stored `--fc-` keys [code]; T2 confirms that with a test. The behaviour runtime's `cssVar` is safe already, because it requires `--u-`.

A value may still read one, including `--primary: var(--fc-t-ab12cd34)`, which the importer needs. So only the key is refused, and a page can never redefine a token. That is also what lets the server judge the banner's colours: a token's value is exactly what the sheet says.

`@property` on a token name is already refused, because `@property` needs a name starting `--u-` [proven]. That refusal matters: with `inherits: false`
one definition would repaint every use on a page [proven]. It gets a test, so loosening that rule fails loudly.

## The value grammar

The sheet is written raw, and a token applies to the whole document. A hostile value broke out of it three ways in Chromium [proven]: `}` hid the body, `;`
loaded an external `url()` on `:root`, and `</style>` ended the element and ran script. An unclosed bracket does it without any of those characters: `rgb(0 0 0;` left every later token empty and swallowed the `body` rule [proven].

`cssValueText` is not the guard here: it returned the first three unchanged for a custom property name, along with `url(...)`, `initial` and `var(...)`
[proven]. So the theme does not reuse it alone. `parseColorValue` is a small allowlist that runs first, in `normalizeTheme`, in the panel and in the AI validator:

| Kind | Allowed | Refused |
|---|---|---|
| Colour | `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; a whole `name(...)` with no nested bracket, `name` one of `rgb`, `rgba`, `hsl`, `hsla`, `hwb`, `lab`, `lch`, `oklab`, `oklch`, `color`, holding only numbers, percentages, angles, `none`, `/` and commas; `color()` takes `srgb`, `srgb-linear` or `display-p3` first; CSS colour names from a list; `transparent`. At most 64 characters | Everything else: `url`, `var`, `calc`, `color-mix`, `light-dark`, `currentcolor`, `initial` and the other wide keywords, any `{ } ; < > \ " '`, comments, an unclosed or stray bracket |
| Font | A `FONT_LIBRARY` id or `system`. The emitted text is `fontStack(family)` or `SYSTEM_FONT_STACK`, from the registry, never stored text | Any other string |

- **Strict per function (T1 code review, finding 1).** The table's colour row is read through one shared parser, `src/lib/color/cssColor.ts`, which the banner's `parseColor` reads too once #261 is on main. The modern form takes exactly three components separated by ASCII spaces and an optional `/ alpha`, with `none` allowed; the comma form exists only for `rgb`, `rgba`, `hsl` and `hsla`, with three or four values and no `none`; an angle stands only in a hue slot and a percentage only where the function takes one; a number is the CSS number token, so `0.` is refused; white space is ASCII only. The render gate asserts that every value the parser accepts, from a fixed list, the review's probe and a generated sweep of thousands, passes `CSS.supports('color', v)` in Chromium and WebKit. The grammar was narrowed to this before any token could be stored, so "only widens" holds from here.
- **No alias between tokens.** `var` is refused, because an alias cycle reads as a missing token [proven]. `--sidebar: var(--background)` in an import resolves to a value first.
- **`oklch(0.205 0 0)` and `oklch(1 0 0 / 10%)` pass,** so shadcn's themes fit unchanged [unproven until T1 has the parser].
- **A wide keyword** in a token silently removes the value [proven for `initial`], so it is refused too.
- **The whole grammar is readable by `parseColor`** after T2, which is why `color()` stops at three spaces: a colour the banner cannot judge goes neutral, see below.

**`themeCss` trusts nothing it reads.** Stored `id`, `kind` and `document` values also reach the raw sheet, and a frozen revision predates any later tightening. So at emission it writes only ids matching the pattern, branches on `kind`,
writes `document` values only when they match the exact reference form, and runs `parseColorValue` again. A value that fails is left out.

Because a token holds no address, it cannot make a request conditional on a mode, and the selector contract's decision 6 keeps holding.

## Light and dark

`.dark` is dead on a published page, because the root layout writes `class="light"` [code]. The media query needs nothing: the same sheet showed both
values with no script in Chromium, under `light`, `dark` and `no-preference`, and the last reads as light [proven].

| `mode` | Sheet | `color-scheme` | Root layout | Node `prefers-color-scheme` rules |
|---|---|---|---|---|
| Absent | Light values | Not written | `class="light"`, as today | As stored, as today |
| `light` | Light values | `light` | `class="light"` | Dark rules dropped, light rules unconditional |
| `dark` | `dark ?? light` | `dark` | `class="dark"` | Dark rules unconditional, light rules dropped |
| `system` | Light, then dark in `@media (prefers-color-scheme:dark)` | `light dark` | `class="light"` | As stored |

**Why absent exists.** Today a node rule under `@media (prefers-color-scheme: dark)` fires on a site with no theme [proven], #258 teaches the generator exactly that form, and the importer's dark rewrite lands on it. A default of `light` would delete those rules
at T2, or at a site's first token. So nothing forces until a person picks. The price is a half dark page on a site that holds dark rules and has not chosen, which is what it has today: the panel warns on such a site, and the prompt learns the site's mode.

**A chosen mode always takes effect, tokens or not.** Absent mode with no tokens and no document emits nothing. `dark` with an empty theme still writes `class="dark"` and `color-scheme: dark`, so with no document background the page shows the editor's dark palette from the published base sheet,
which is readable and not the site's own. The panel warns when `mode` is `system` or `dark` and the document block has no background.

**A forced mode decides node rules [proven that it must].** A site set to `light` with a node rule under `@media (prefers-color-scheme: dark)`, on a dark system, shows
the rule while the tokens stay light: a half dark page. The existing evaluator does not answer this: `mediaVerdict` reads a frame and returns `environment` for every `prefers-color-scheme` form, `(prefers-color-scheme: dark) or (min-width: 600px)` is `unknown`, and `surfaceWrappers`
keeps the condition on the preview [proven by the review]. So T2 adds **`withColorMode(prelude, mode)`**, pure, in `src/lib/rules/colorMode.ts`:

- **It rewrites only queries in a grammar it recognises,** and leaves everything else as stored, invalid shapes included. That matters because `not (prefers-color-scheme: dark) and (min-width: 600px)` is not valid media query syntax: Chromium parses it to `not all`, which never matches under either setting [proven by the review]. Read literally, a rewrite would turn that dead query into a live one.
- The recognised forms: a query made of `and`-joined operands, each `(feature: value)` or `(not (feature: value))`, and a whole query `not (prefers-color-scheme: x)`.
- Per query in a comma list. A list with nothing left drops the rule.
- `(prefers-color-scheme: x)` matching the mode is removed from its query; not matching drops that query. `not` inverts the answer.
- The boolean `(prefers-color-scheme)` matches in both modes, so it is left as stored, which is already right.
- An `or` holding the feature is left as stored and reported as a warning, because it cannot be answered by one operand.
- It covers node rules and #261's `:root` rules. `applyResponsiveStyles` gets one option, `colorMode`, passed only when `mode` is `light` or `dark`.

**`&:is(.dark *)` rules.** Forced `dark` writes the class, so such a rule works there, and the editor's `.dark` variable block in the published base sheet comes along, which is right for that site. In `system` no class is written, because the server cannot know, so these rules stay dead. So the
importer stops writing this form: see "The React importer's theme lines".

**No visitor switch.** It would need a stored choice, read before first paint by a script in the head, and every server render would disagree with
it. It is left out, not parked: a site that wants one has `system`. A later behaviour action could add it, and nothing here blocks that.

**The browser's own surfaces.** With a chosen mode, `generateViewport` in the `(site)` layout emits `color-scheme`. It also emits `theme-color` when the document has a background, with a `media` pair in `system`. The document background is a reference and `theme-color` needs a literal, so `generateViewport`
resolves it per mode and leaves out a value `parseColor` cannot read. Both reach the real `<head>` for every user agent tested [proven]. The aim is that a dark page is not white before its first paint; neither this contract's probes nor the review's could measure that [unproven].

## One home per property: the theme and a page's `:root` rule

#261 lets the page root hold a rule on `:root`, allowing `overflowX`, `scrollBehavior`, `colorScheme`, `color`, `backgroundColor`, `fontFamily` and more. The theme writes some of those too, so one has to win.

**A page's `:root` rule beats the theme, for every property both can set.** The same reasoning as a page head item replacing a site one: the theme is the site's default, and a page saying something more specific meant it.

- **Published.** The theme sheet stands in the layout, before the page's `data-fc-responsive` sheet, at equal specificity, so the later one wins with no extra work. With both in that order, `color-scheme`, and through #261's constant `body{color:inherit}` the `body` colour and font, came from the page rule [proven by the review]. T2 keeps that order under test.
- **`color-scheme` included.** A page rule beats even a forced `dark` for this one property. No edit to #261, which is on hold, and the panel warns when a page's `colorScheme` disagrees with the site's mode. Tokens do not follow it: their dark values answer the system, and a page cannot redefine one.
- **Scrolling and overflow live only on the `:root` rule.** They were in this contract's `document` block to close the BusBasis need "styles on html". #261 reports `html` matching on 479 of 480 properties with the frozen rules as `:root` rules, so they need no second home.
- **On a surface.** #261 lands inherited values on the page root of each copy, inside the frame wrapper, so the root's values win there too and canvas and published agree [code].

## Where tokens reach

### Published page

`themeCss(theme)`, pure, in `src/lib/site/theme.ts`, is the only emitter:

```css
:root{--fc-t-ab12cd34:#112233;--fc-t-cd34ef56:Fraunces,Georgia,'Times New Roman',serif;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--fc-t-ab12cd34:#eeddcc}}
body{background-color:var(--fc-t-11aa22bb);color:var(--fc-t-33cc44dd);font-family:var(--fc-t-cd34ef56)}
```

It renders as `<style data-fc-theme-sheet="">` in the `(site)` layout, right after `data-fc-site-base`, not in `renderPublishedPage`, because the default
404 has no page tree and a consent banner sits before it [code]. A sheet in a body `<style>` applied to `html` and `body`
in the real Next build, under both modes [proven]. The layout's site comes from the same cached resolution its `generateMetadata` already awaits, so it adds no new failure; if resolving fails, no sheet is written and it logs, as `not-found.tsx` does.

- **`@font-face`.** `collectPageFonts` finds nothing in a reference [proven], so a font token would never load. The theme sheet therefore also holds the
  faces of every font token. A declared face costs nothing until text needs it [code, the registry's own note]. This also covers the default 404, which
  no scan reaches. `collectPageFonts` gets the theme as an optional argument, only so a referenced heading family can still be preloaded.
- **Size.** A typical site of 20 tokens adds about 2 kilobytes. The worst case is large, on every page before compression: 32.5 kilobytes at 200 colours with two 64 character values, 18.4 kilobytes of faces if every library family is a token, and up to 81 kilobytes
  more for 500 tombstones at the same length, so about 132 kilobytes [the first two proven with the real `fontFaceCss`]. All tokens are emitted rather than those a tree uses, because a value bound from a content collection can hold a reference no walk sees. The caps exist for this.
- **Document styles.** Unlayered, so they beat `@layer base` in the published base. With tokens alone a dark site keeps the editor's white body and dark
  text; with the `body` rule both change, and an `input` follows [proven against the real `published-base.css`].

### The consent banner and the default 404

These read `siteLookFromPages`, which hands a raw reference through to inline styles [proven], so the sheet on `:root` does reach them. Whether the result is readable is another matter, and it is decided here, in T2.

#261 fails closed, as decided: `legibleLook` gives the neutral pair to any pair it cannot show to read, judged apart for text and button, and a `var()` cannot be read. Alone, that means every site on tokens gets a neutral banner. That is readable, and it loses the site's look. So T2 feeds it real colours:

1. **`look` reads `theme.document` first,** then the home page as today. The background lives in the document block, which `siteLookFromPages` never reads, so without this a dark text token stays on the default white ground.
2. **`legibleLook(look, theme)` resolves references through the theme, once per mode in force:** the light values with no choice or `light`, the dark ones with `dark`, both with `system`.
3. **A pair stays only if it reads in every one of those modes.** It stays as references, so it flips with the page. Otherwise that pair becomes the neutral pair, **as literals on both sides.** That is why it cannot flip: nothing in it refers to a token.
4. **The font** resolves the same way before `isPlatformFontStack` reads it.
5. **`parseColor` learns the rest of the grammar:** `lab`, `lch`, `oklab`, `hwb`, `color()` and `none`. Today those go neutral [proven with #261's real function]. Missing, broken, `transparent` and see-through colours stay neutral, by #261's own rules.
6. **`DefaultNotFound` calls `legibleLook` too.** It takes the same look and has no guard at all.

**How a stock shadcn dark theme stays readable** [each row from #261's real `legibleLook` on shadcn's own values, `banner-look.mts`]:

| Site, `system` mode | Light | Dark | Banner |
|---|---|---|---|
| No document block: ink token on the default white ground | Text reads | Text fails, the ink flips to near white on white | Text pair goes neutral, `#111827` on `#ffffff`, in both modes. The button stays on its tokens, which read in both |
| Document block set to shadcn's background and foreground | Reads | Reads | Text and button keep their references and flip with the page |
| The same, with a literal `#ffffff` on the dark `--primary` | Reads | Button fails | Button pair goes neutral, text keeps its references |

Without that guard the first row read 1.04 to 1 in dark [proven by the review]. So the banner is never unreadable. A site that wants its own look on the banner sets the document block, and the panel says so.

The canvas never shows the banner. Render gate cases run at both system settings, in T2.

### Canvas and preview

The canvas and preview render into the editor's own document, so a rule on `:root` would reach the editor. `themeCss(theme, { scope: 'surface' })` writes the same values
on an attribute instead:

```css
[data-fc-theme]{--fc-t-ab12cd34:#112233;color-scheme:light}
[data-fc-theme][data-fc-theme-mode=dark]{--fc-t-ab12cd34:#eeddcc;color-scheme:dark}
[data-fc-theme=frame]{background-color:var(--fc-t-11aa22bb);color:var(--fc-t-33cc44dd);font-family:var(--fc-t-cd34ef56)}
```

`GroundWrapper` writes `data-fc-theme="frame"` on a viewport frame and `data-fc-theme="floating"` on a floating element, because only a frame stands
for a page, and a floating element must not gain a page background. `PreviewFrame` writes it on its root. In Chromium, on a page standing in for the editor,
nothing outside the attribute saw a value, an editor button kept its look, two frames showed two modes side by side, and the attribute's values
reached a modal `dialog`, its `::backdrop` and a popover [proven]. With no chosen mode, `color-scheme` is left out here too. Whether editor overlays drawn inside a frame
look right under a dark `color-scheme` was not checked [unproven], so T3 checks it in the mounted editor.

**The mode on the canvas.** `editorUI.previewColorMode` is `light` or `dark`. A forced site shows its mode. A `system` site gets a Light and Dark switch on the top bar, and a change writes nothing to the project. A site with no choice shows light, and its dark rules stay dead until previewed, as the selector contract says.

`surfaceWrappers` runs `withColorMode` with the frame's mode in the last two cases that have one, so a surface answers `prefers-color-scheme` from the site and never from the machine. On a forced site previewed on a dark machine the rule stays out, which is what T3's forward path tests. With no chosen mode the preview keeps the condition for the real system, as published does.

**A forced `dark` frame matches the published page.** `class="dark"` on `html` changes what a published page reads: `--border` is `oklch(100% 0 0/.1)` published and `oklch(92% .004 286.32)` on the canvas, and `--background` differs the same way [proven by the review]. And `constantConditions` writes `&:is(.dark *)` dead. So on a forced `dark` site the frame carries `class="dark"`, and `surfaces.ts` answers that exact selector from it. On a `system` site previewing dark it does not, because the published page writes no class there, and the frame must show what a visitor gets.

`PageFontFaces` adds the theme's families, for the same reason as the published sheet.

### Rules and definitions

Both hold references as plain strings, so they need nothing [proven]. A definition is site scoped, so its references resolve on any page of that site, and an
override can hold one. Component states compile at expansion and keep the string. A `@keyframes` block can hold one.

### Export

A site's reference means nothing off the platform, so export has its own form, and the React contract's export slices take it. `themeCss(theme, { scope: 'export' })` writes named variables from a slug of each token's name (`--accent-blue`, unique), with the same light and dark rules on `:root`. A name with no usable letters, or whose slug starts `fc-` or `u-`, takes `--token-<id>` instead: "FC Text" would otherwise be `--fc-text`, which `isPlatformVariable` refuses on re-import, and "U Spin" `--u-spin`, the namespace of stored `@property` and `cssVar` names in the same `site.css`. The slug comparison reads `--token-<id>` as that token.

- It leaves out `html`, `body` and `@font-face`, which would restyle whoever installs the export, and whose `/fonts/...` paths exist only on the platform. A font token exports its stack, with a report line saying the file is theirs to host.
- References in the exported styles are rewritten to those names.

That keeps the importer contract's property 2 ("export a tree, import the result, and the browser render matches"): `--fc-t-<id>` never leaves, so a re-import never meets a name this contract refuses.

## Every reader that has to learn it

| Reader | Today [proven unless marked] | Change | Slice |
|---|---|---|---|
| `normalizeSiteSettings`, `projectToPersisted` | Drops `theme`; normalizes before the save sees it [code] | Lists `theme` and `head`; reads the raw key | T1 |
| `updateSiteSettings`, `saveProject` | Would erase, see the traps [code] | Keep the stored value | T1 |
| `ProjectContent`, `versionContent`, `changedElsewhereMessage` | Pages and definitions only [code] | Theme and site head, named in the warning | T1 |
| `(site)/layout.tsx`, `app/layout.tsx` | Constant base; `class="light"` [code] | The sheet, `generateViewport`, the `dark` class | T2 |
| `collectPageFonts`, `publishedFontAssets`, `PageFontFaces` | No ids from a reference | Theme faces in the sheet; preload resolves through the theme | T2, T3 |
| `applyResponsiveStyles`, `surfaceWrappers` | Emit `prefers-color-scheme` as stored | `withColorMode`, the `colorMode` option; a surface reads the frame's mode | T2, T3 |
| `constantConditions` | `&:is(.dark *)` always dead on a surface [code] | Answers that exact selector on a forced `dark` frame | T3 |
| `refusedBody`, `isRootStyleKey`, `styleValueProblem`, both renderers | Accept `--fc-t-*` as a style key, keyframes included | `isPlatformVariable` | T2 |
| `siteLookFromPages`, `legibleLook`, `ConsentBanner`, `DefaultNotFound` | Read no document block; a reference goes neutral; the 404 has no guard | See "The consent banner and the default 404" | T2 |
| `parseColor` (`layoutAudit.ts`), so `layoutAudit` too | After #261 reads names, `hsl`, `oklch`; `lab`, `lch`, `oklab`, `hwb`, `color()` read as nothing, so the visual review goes quiet on those pairs | Reads the whole grammar | T2 |
| `GroundWrapper`, `PreviewFrame`, `EditorUIStore` | Nothing | The attribute, `previewColorMode`, the frame's class | T3 |
| `ColorInput`, `FontFamilySelect`, raw style field | `toPickerHex` reads a reference as no colour [code] | Show the token's chip; deleted, missing and broken states; pick a token | T4 |
| `checkBeforePublish` | Components and legal only [code] | Missing and broken tokens; refused head items | T4, H3 |
| `styleValueProblem` | Refuses `var()` in a font, so a font token cannot be written | Accepts a reference to a live font token, and only that | T5 |
| `parseColors`, `essentials.ts` and the tells | Read no colour from a reference, so a contrast check goes blind | `resolveTokenRefs(value, theme, mode)` first, once per mode with dark values | T5 |
| `siteContextText`, `promptSections/rules.ts` | No theme; teaches the dark media form unconditionally | Live tokens and the mode as delimited data; the dark line follows the mode | T5 |
| `reactImport/tailwind/tokens.ts`, its `dark:` rewrite | Not built | Aliases, the media form, see below | T6 |
| `reactExport` | Not built | `scope: 'export'`, see "Export" | Export slices |
| `PageMetadataModel`, `PageSeoMetadata`, `snapshotToComponentNode` | No `head` or `ogType` [code] | `head` as a frozen list, read through `parseHeadItem`; `ogType` | H1 |
| `pageMetadata` | Writes `og:type: website` [code] | Reads `ogType` | H1 |
| `renderSitePage`, `not-found.tsx` | Business JSON-LD only [code] | Items, above any `Suspense` | H2 |
| `parseInputValue`, `hydrateBindings` | Carry the string | None | none |

## What the AI may read and write

**Reads.** `SiteContext` gains `theme`: the live tokens with id, name, kind and values, the mode and the document block, as delimited JSON with `<` escaped
like every other owner text. Tombstones and broken tokens are not sent. Head items are not sent.

**Writes, on a generated page.**

- **Uses a token by reference,** and the prompt prefers one to a literal for anything in the palette. The validator accepts a reference to a live token of
  the right kind and refuses any other, with a repair message listing the real ones.
- **The mode shapes the dark line.** `promptSections/rules.ts` teaches the dark media form today. With `system` or no choice it stays. With `light` or `dark` the prompt says the site is fixed and does not teach it, because the rule would be dropped or always on.
- **May add tokens,** up to 12 in a generation, through a new optional `theme.tokens` field in its output, with `name`, `kind` and values through
  `parseColorValue`. It writes a local name, `new-1`, `new-2`, and refers to it as `var(--fc-t-new-1)`. The hyphen means it can never pass as an id, and an unresolved one is refused. The validator mints the id and rewrites the references, so a model never chooses an id.
  A name that already exists with the same values reuses that token; with different ones it is refused, because adding "Accent 2" silently is how palettes rot.
- **Tokens and page land in one undo step.** Rejecting the generation adds nothing.
- **Never** edits a token, deletes one, changes `mode` or the document block, or sets `--fc-`. An existing value applies to every page, and a brief is about one.

**Head items are out of its reach, read and write.** A verification code cannot be guessed, and JSON-LD states facts to search engines: a generated rating or
price is a false claim made in the owner's name. The score records those rows as refused on purpose, the way it does event handlers.

## The React importer's theme lines

These are the importer contract's "Tokens" section and finding R1 of its review: a foreign theme must not silently take the editor's colours. That contract said tokens land
on the import's root "until theme tokens exist", then "these move there, and nothing else changes". Taken literally that breaks R1, and this pull request amends it.

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
| Non-colour values (`--radius`) and values outside the grammar (`color-mix`, `var`) | Stay on the root as they are today, with no line. Their `.dark` values take the same media form rewrite as `dark:` utilities, as a `@media (prefers-color-scheme: dark)` rule on the root, so the half dark case below does not survive for them |
| A `--font-*` naming a `FONT_LIBRARY` family | A font token, with the alias. Any other family keeps its existing line |
| `var(--primary)` in compiled rules and styles | Unchanged. This is what keeps "nothing else changes" true for everything below the root |
| `dark:` utilities on nodes | **Always rewritten to `@media (prefers-color-scheme: dark)`.** `use-system-dark` goes away |

**Why the rewrite is unconditional.** A `system` site that imports shadcn flips its tokens while `&:is(.dark *)` utilities stay dead, which is the half dark page decision 4 exists to prevent. The media form works in every mode: live in `system`, as stored with no choice, a constant yes in `dark`, a constant no in `light`.

**Match or create, by the name's slug, ignoring case, against the whole family.** The family of `primary` is `primary` and every `primary N`. Any member with the same values is reused, so a re-import adds nothing. If none matches, create the next `primary N` and write an `adapted` line, because
an import must never change what a site's other pages show. Comparing slugs is what makes an exported `--accent-blue` find "Accent Blue" again. A token the owner renamed out of its family creates a new one, and the report says so. At the token cap the value stays literal on the root, with an `adapted` line.

- **An imported `--fc-t-<id>`,** from a hand-edited file: the same id on the same site reuses that token, and anything else is a new token by the rule above.
- `readBundle` proposes the tokens as data. They pass `normalizeTheme` like any other, and the placing action adds them in the same undo step as the definition.
- **With no chosen mode,** an imported dark value is stored and not shown, while a rewritten `dark:` rule fires, as the media form does on any site today. That is a half dark look on a dark system until someone chooses, so the placing report says so and offers System.
- **Under `light`** both stay out. **Under `dark` or `system`** the token's dark value appears: imported components finally follow the site.
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

Two homes: `page.metadata.head`, and `siteSettings.head` for what every page carries. Caps: 30 items per page, 20 on a site, content 500 characters, href 2,048, JSON-LD
16 kilobytes after serialising and 12 levels deep, and 3 JSON-LD items on a rendered page, counting site and page together, with the page's first.

**The merge.** A page item replaces site items with the same key, for names that may appear once. The key is `name`, `property`, or `rel` with `hreflang` and `type`. Repeatable keys are a stated list, where both emit and an exact duplicate drops: `article:tag`, `article:author`, `book:tag`, `book:author`, `og:locale:alternate`, `og:video`, `og:audio`, and `rel` `me`. JSON-LD has no key, so both emit.

The normalizer keeps anything of the stored shape, valid or not, and only `parseHeadItem` at emission refuses. So an item a later build refuses shows as refused in the panel instead of having gone.

**Copying a stored item (T1 code review, finding 5).** T1 keeps each stored item whole, and `JSON.parse` turns a `__proto__` key into an own data property, which is harmless while it stays a plain value. H1 copies an item with spread, or rebuilds it field by field from the kind's own keys, and never with `Object.assign` or a loop of assignments: those would treat `__proto__` as the prototype setter and give the item, and everything that reads it, a forged prototype. A test feeds an item whose JSON holds `"__proto__": {"kind": "link"}` through every H1 path and asserts that `Object.getPrototypeOf` of each copy is still `Object.prototype`.

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
| `name="color-scheme"`, `theme-color` | `generateViewport` writes both. A hoisted one sat beside the viewport's and the page had two [proven] |
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

- **`href`** passes `isHeadHref`, a small new check: absolute `https:` with a host, or a path starting with one `/`. Nothing else, so no `http`, `mailto`, `tel`, `sms`, `data:` or `//host`. It is not `isSafeAddress`, which is wider and private to the render gate. Another host is allowed, because these rels never request it.
- **`alternate`** needs exactly one of `hreflang`, a language tag or `x-default`, or `type`, from `application/rss+xml`, `application/atom+xml`, `application/feed+json`. `text/css` is refused.
- **`title`** is plain text, `content` the same. React escapes both, so markup in them is only text.

**`jsonld`, data, never text.** The stored form is a parsed object. Emission is `jsonLdScriptText`, the existing function, so `<` becomes `<`, with the type a constant
`application/ld+json`. The owner's text is never written into the element.

Unescaped, `</script><script>...` in a value ran [proven]. Escaped, the same object ran nothing, under `<!--<script>`, `</SCRIPT\t>` and a key holding `</script>` too, in Chromium and WebKit, `JSON.parse` of the element gave back every
string including U+2028, and hydration left it in place, with no console error [proven]. The panel parses as the person types and stores nothing that does not parse. It must be
an object with a string `@context` on `schema.org`, and either `@type` or an `@graph` array. A top-level array is split into items.

JSON-LD stays in the body, as the business JSON-LD does today, because only `meta` and `link` are hoisted [proven]. That search engines read it there is taken from Google's documentation, recalled and not checked here, and not run [unproven]. On the home page it emits beside the business block, and both are valid. Values do not bind: a product page's own
structured data belongs to the shop stream, generated from real product data.

### Where they render

Into the real `<head>`. `meta` and `link` written by a server component in `renderSitePage` are hoisted by React. In the real Next build each stood in `<head>` in the raw HTML for all
eight user agents tried, which included a browser, Google's verifier and the Facebook and LinkedIn fetchers, next to Next's own metadata [proven].

That depends on one thing: **the items render above any `Suspense`.** The route has no `loading.tsx` and no boundary around the page today [code], and a suspended subtree would flush
them into the body. Slice H2 asserts on raw HTML from a real build, so a boundary added later fails a test rather than silently losing a site's verification. Next's `other`
field also reaches the head, but it has no `property` form, so one path serves both.

The designed 404 gets its items, through `renderSitePage`. The default 404 gets the site's items. A refused item renders nothing, logs, and appears in `checkBeforePublish`.

`parseHeadItem` is the single entry, pure, in `src/lib/site/headItems.ts`, run at emission because a page is opaque JSON to the save route, and again in the panel.

## Consent and Content Security Policy

**Consent.** The banner gates storage and the tracker (`src/lib/consent/consent.ts`). This contract adds nothing it needs to gate, and that is the reason for the lists above:

- No head item contacts another host in a browser, so none discloses a visitor's address before consent.
- Fonts come only from the registry, which is self-hosted, so a font token cannot reintroduce the Google Fonts problem.
- A token holds no address.
- Nothing stores anything. The mode comes from the system, and the absence of a switch means no stored choice.

What this contract does change on the banner is its look, and that stays readable by construction, see "The consent banner and the default 404".

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

**Rows that move.** This contract closes no existing row. #261 closes `css-selector::root` in Format, Published and Canvas and leaves its AI cell red. The other 13 of `pageLevelRows` stay red under `page-level-css`: `@page`, `:first`, `:left`, `:right`, `@view-transition`, `@layer` and the view transition
pseudo-elements. The selector contract cut them too, none is in BusBasis, and owning a page-wide stylesheet is a different question from tokens.

**Exclusions.** `head` and `title` stay excluded, as the route's. `meta` and `link` stay excluded as node tags, with their reason changed to point at head items.

**New rows,** kind `page-item`, each with the same columns:

| Rows | Count | Closes with |
|---|---|---|
| Colour token, font token, dark value, each of the three chosen modes, document background, colour and font | 9 | T2, T3, T4 |
| `meta` names | 17 | H2, H3 |
| `property` entries | 8 | H2, H3 |
| `link` rels | 7 | H2, H3 |
| JSON-LD | 1 | H2, H3 |

That is 42 rows, of which the 33 head rows are refused on purpose in the AI column, with a named reason. So AI tops out about 1.8 percent lower on the widened list, and the arithmetic in the fleet
plan should count it. Each head row's Published cell tests a raw HTML position, not merely that the tag exists. The counts are this contract's arithmetic, not a score run.

**BusBasis.** The need `styles on html`, in `test/score/busbasis/pages.ts`, is #261's. Per that pull request, closing it takes a new lift, `rebuild.ts`, an `html` comparison and `lang` from the page, and this contract adds nothing to that work. Lifted pages use `:root` rules and never the `document` block.

**Corpus.** New fixtures: `theme-tokens` (a page by reference next to its literal copy), `theme-dark` (the same under each mode and each system setting, where a screenshot is the
check), `theme-font` (a font token that must load), and `theme-dark-rule` (a node with a dark media rule, which T2's before and after test needs because no fixture holds one). The harness's `publishedDocument` gains the sheet in the position the layout writes it.

**Render gate.** `pnpm test:render-gate` gains every refused kind, as stored data, through the real emission, in Chromium and WebKit: each `http-equiv`, every `stylesheet` spelling,
hostile JSON-LD, hostile token values with the unclosed bracket, `--fc-` in a keyframe block, and the banner's readability at both system settings. A detector canary runs with them, as it does today.

## Slices

Each slice verifies the four paths: **F** forward, **B** backtrack and revise (a change invalidates what derives from it, and an unchanged input keeps it), **R** resume from
persistence, **E** re-entry after completion or failure. Types, lint, unit tests and `pnpm score:primitives` run on every one, and `pnpm test:integration` on any that touches a route.
`shared_state` is the fleet's tag.

| Slice | Name | Files | `shared_state` | Depends on |
|---|---|---|---|---|
| T1 | `theme-model` | `src/lib/site/theme.ts`, `siteSettings.ts`, `ProjectModel.ts`, `repository.ts`, `snapshot.ts`, `src/stores/openProject.ts` | | |
| T2 | `theme-published` | `(site)/layout.tsx`, `app/layout.tsx`, `src/lib/rules/colorMode.ts`, `applyResponsiveStyles.ts`, `responsiveCss.ts`, `rootProperties.ts`, `rules.ts`, `validate.ts`, both renderers, `registry.ts`, `publishedFonts.tsx`, `notFoundDefault.ts`, `layoutAudit.ts`, `ConsentBanner.tsx`, `DefaultNotFound.tsx`, score | `renderer` | T1, #261 |
| T3 | `theme-canvas` | `GroundWrapper.tsx`, `PreviewFrame.tsx`, `surfaceSheet.ts`, `surfaces.ts`, `PageFontFaces.tsx`, `EditorUIStore.ts` | `renderer` | T2 |
| T4 | `theme-panel` | A Theme panel, `ColorInput.tsx`, `FontFamilySelect.tsx`, `publishCheck.ts` | | T3, #226 |
| T5 | `theme-ai` | `validate.ts`, `tells.ts`, `essentials.ts`, `siteContext.ts`, `promptSections/rules.ts`, `prompt.ts`, `apply.ts`, `schema.ts` | | T4 |
| T6 | `theme-import` | `reactImport/tailwind/tokens.ts`, `reactImport/bundle.ts` | | T2, T3, #226, import slice 3 |
| H1 | `head-model` | `src/lib/site/headItems.ts`, `PageModel.ts`, `siteSettings.ts`, `publishedHead.ts` | | T1, for the kept keys |
| H2 | `head-published` | `renderSitePage.tsx`, `(site)/not-found.tsx`, `test/renderGate`, score | `renderer` | H1 |
| H3 | `head-panel` | Page settings, `SiteSettingsDialog.tsx`, `publishCheck.ts` | | H2, #226 |

T6 cannot come earlier: before T2 no sheet exists, so every alias dangles, which is R1 in a worse form, and before #226 a saved theme reaches visitors at a cache miss.

**T1, the model.** `SiteTheme`, `normalizeTheme`, `parseColorValue`, `themeCss` with its three scopes, `resolveTokenRefs`, the reference scan, `updateTheme`, the two keeps, and the version comparison.

- F: add, rename, set dark, delete, and the emitted text, as unit tests. Every grammar row, both ways, including each hostile value of both probes, the unclosed and stray brackets, and `rgba(255, 0, 0, 0.5)`. Forged `id`, `kind` and `document` values never reach the sheet.
- B: a rename changes one field and no page byte. Undo restores a tombstone with its values. Going `system`, `light`, `system` keeps every `dark` value, and the sheet is what `mode` says. Clearing `mode` returns to not chosen.
- R: a blob through save and load is identical. An unknown family emits the system stack. A value that stops parsing keeps its id and text, is marked broken, is not emitted, and survives a save. A bare theme key from an older build is read without throwing. A stored `broken: true` on a value this build accepts reads as valid. Broken text over 256 characters is cut to nothing.
- E: Clean up removes only what the scan finds unused, and a token used only in `theme.document` stays. The 500th tombstone refuses a further delete, with the pointer to Detach, Replace and Clean up. A write over either cap is refused, and a stored blob over one loads, emits up to the cap and warns. A dialog opened before an edit and saved after it keeps the edit. A body lacking the key keeps the column through `projectToPersisted` and `saveProject`, and an explicit empty theme clears it. A second tab, reloading after a token edit with unsaved changes of its own, gets the warning naming the theme.

**T2, the published page.** The sheet, viewport, class, font faces, `withColorMode`, `isPlatformVariable`, `look` and `legibleLook`, `parseColor`, new rows.

- F: in a real build and Chromium, computed values per mode and system setting, `html` and `body` included, the default 404 reading a reference, a font loading, a page `:root` rule beating the theme on `color-scheme`, `color`, `backgroundColor` and `fontFamily`, and the banner table above at both system settings.
- B: a forced `light` site drops a dark node rule and a `:root` rule under the same wrapper, and `system` and no choice keep them. Every `withColorMode` case: lists, `not`, `or`, the boolean form, and the invalid `not (prefers-color-scheme: dark) and (min-width: 600px)`, which stays as stored and stays dead. Changing `mode` changes the sheet on the next read, with no stale cached sheet. A site's first token on a site with no choice changes no rule.
- R: after a cache miss, a site with no theme key emits nothing, byte for byte, by a before and after test on the corpus, `theme-dark-rule` included. An unparseable stored theme emits nothing and logs.
- E: a site that empties its theme and clears its mode returns to no sheet, and `generateViewport` to nothing. `dark` with no tokens gives the class and `color-scheme`. Rendering an error page keeps the sheet. `--fc-` is refused as a style key, in a rule, in a keyframe block and on `:root`, by one function.

**T2 as built, decided while building, say so if you disagree.**

- **Three colours `parseColor` declines to judge.** Every value the grammar accepts is painted on a canvas in Chromium and WebKit and compared with `parseColor`, within 2 of 255 a channel (`test/renderGate/theme.gate.ts`). Three forms the engines paint apart, or in a way the specification leaves open: a Display P3 colour with a channel outside 0 to 1 (`color(display-p3 0 0 100)` paints a light blue in both, not the clipped blue); an hwb colour with a negative whiteness or blackness (Chromium leaves it unclamped, WebKit clamps it), and an lch or oklch colour with a `none` hue and some chroma (Chromium and WebKit on macOS read the hue as zero, WebKit on Linux, in continuous integration, paints the chroma away). `parseColor` returns nothing for those, so the banner fails closed to the neutral pair, as for any colour it cannot read. The grammar still accepts them, so "only widens" holds.
- **`withColorMode` reports more than `or`, and leaves a whole list as stored around it (T2 code review, finding 1).** Any query that names the feature in a form it does not recognise (a media type, `not ... and`, an unbalanced bracket, `and` without white space on both sides, a blank member of a list) is left as stored and reported in the page's one warning, and so is the list it stands in, unless another member the mode makes true decides the list. The review found two rewrites that revived a dead rule: a blank list member read as always true, and `and(` (a function token to CSS) taken apart. `test/renderGate/colorMode.gate.ts` now holds every rewrite of a generated sweep to `matchMedia` in Chromium and WebKit, under both forced modes and both system settings, with the browser's verdict as the expected answer.
- **The banner's guard reads only the tokens the sheet emits (T2 code review, finding 2).** `emittedTheme` in `theme.ts` drops what `themeCss` leaves out (over a cap, a broken value), so a reference the page cannot resolve never reaches the banner.
- **Next keeps its default viewport (T2 code review, finding 3).** `test/behaviour/theme.spec.ts` reads raw HTML from the real production build: `width=device-width, initial-scale=1` stands beside the layout's `color-scheme` and `theme-color`, for a site with no theme, a `system` site and a forced `dark` one.
- **The layout's sheets live in `src/lib/site/siteSheets.tsx`.** A Next layout file may export only what Next reads, and the score harness renders exactly the layout's sheets, so `SiteSheets` and `themeViewport` sit beside it and the layout imports them.
- **A rule on `:root` still names its own refusal.** `isPlatformVariable` now refuses `--fc-` in every rule body, so the document's key list is checked first in `parseRootRule` and in the model, and #261's "cannot be set on the document" stands.
- **A font token's faces are only in the theme sheet.** `collectPageFonts` takes a resolver rather than the theme, because the registry cannot import `theme.ts`, which imports it. The resolver only picks the family to preload, the page's own font sheet does not declare a token's faces again, and the document font counts as what a heading inherits.
- **`theme-dark` covers `system` at both settings.** One fixture cannot change mode, so the forced modes are proven by `test/renderGate/themePublished.gate.ts` (both page bases, every mode, both settings, Chromium and WebKit) and by the score's `theme:mode-*` rows, not by the corpus. The before and after test ran once against main at `9c9b415`: all 16 existing fixtures on both page bases and the `theme-dark-rule` tree hashed identically; what stays in the gate is that settings with no theme key render the whole corpus as a site with no theme.

**T3, the canvas.** The scoped sheet, wrappers, mode switch, and the surface's reading of the frame's mode, in the mounted editor.

- F: two frames, or a switch, show both modes with nothing outside changing, including editor overlays under `color-scheme: dark` and a font token loading. On a forced site, the preview on a dark system shows no dark rule. A forced `dark` frame matches the published page on `--border`, `--background` and an `&:is(.dark *)` rule.
- B: a token edit repaints each frame with no reload. Switching mode changes no project byte, so nothing shows as unsaved.
- R: reload returns the project's state, and `previewColorMode` is not persisted. A second tab that reloads shows the first tab's saved theme.
- E: leaving preview and returning keeps the choice for the session. A theme emptied live removes the sheet, and floating elements never take a page background.

**T3 as built, decided while building, say so if you disagree.**

- **The attribute sits on the frame's page box, not on `GroundWrapper` itself.** `GroundWrapper` also holds the frame's chrome (`bg-white`, which would paint over a background on the wrapper) and its label, which would take the site's font and colour scheme. So `data-fc-theme="frame"`, `data-fc-theme-mode` and a forced site's `class="dark"` go on `[data-viewport-content-id]`, the box `VIEWPORT_ROOT` already names and the one that clips the page; a floating element's go on `[data-floating-root-id]`; the preview's on `[data-preview-frame]`. `GroundWrapper.tsx` is unchanged. The score checks the label's font and the editor's own `color-scheme` and variables stay as they were.
- **A frame has a ground before the document block** (`src/lib/site/surfaceTheme.ts`). On the published page that is `body` in the base sheet, which a frame does not have. With the `reset` base only a forced `dark` frame changes it, to `--background` and `--foreground` as the base layer paints `body` under `class="dark"`; with the `browser` base it is `Canvas`, the canvas colour of the frame's scheme, because that base rolls the layer back. It stands before the theme's sheet at the same specificity, so a document background still wins.
- **The `browser` ground writes `CanvasText` with `Canvas` (T3 code review, finding 1).** The review's probe, which mounted the theme sheet without the page base, found a dark frame on the `browser` base keeping the editor's near-black text. In the mounted editor the page base's surface sheet already writes `color:CanvasText` on the frame, so the score's comparison (text and ground as painted pixels, canvas and preview against the published page, every mode in both bases) passed with and without the fix. The ground now holds both anyway, so it is right on its own, and that comparison stays in the score's `mode-*` cells as the guard.
- **A floating element on a forced `dark` site carries the class too.** It reads the same `.dark` variables and `&:is(.dark *)` rules as the frames, so one element does not show the editor's light palette among dark frames. It never takes a document value.
- **Where the switch is.** The wide top bar has Light and Dark; the compact bar, under 1024 pixels, has it in More as a checkbox, "Show dark mode"; the preview toolbar has the same pair, so it can be changed without leaving the preview. All three write `EditorUIStore.previewColorMode`, which is volatile: no project byte, no undo step, light after a reload.
- **The surface sheet answers the colour scheme before the frame does.** `wrappersInColorMode` runs on a rule's wrappers before `surfaceWrappers`, on node rules and on `:root` rules shown on the page root, and the memo key holds the mode and the class, so a switch never hands back the other mode's blocks. A form it cannot answer stays as stored and is named once in the page's surface warning.
- **Font faces travel with the page's own.** The surface scope of `themeCss` writes no `@font-face`, so `PageFontFaces` takes the theme and declares its font tokens' families, tombstones included, on the canvas and in the preview (`themeFontFamilies`).
- **The score measures the canvas column on the mounted editor** (`test/score/pageItems.score.ts`): the real `EditorApp` in Chromium, the theme set through `updateTheme`, each row on the frame, with the editor outside it checked unchanged. Disabling the surface sheet and the mode in the canvas sheet turns all nine cells red, which was run once to show the probe can fail. The preview is not a score column; unit tests and the browser proof cover it.

**T4, the panel.** A Theme panel: list, name, values, mode including not chosen, document block. Pick a token in `ColorInput` and `FontFamilySelect`, "Used in N places", Replace, Detach, Clean up unused, the deleted, missing and broken states, the warnings (dark rules with no choice, a dark mode with no background, a page `colorScheme` that disagrees), and the publish warning. Waits for #226. A colour gesture is one undo step. Proven in the browser, per the fleet's rule.

- F: create, use, rename, edit, publish, and the live page shows it, only after publishing.
- B: a token edit after a reference repaints, with the node unchanged. Undo through each. Replace followed by undo restores each reference.
- R: the app has no `beforeunload` warning and this adds none. Reload brings back the tab's working copy, and `changedElsewhere` names the theme if it moved meanwhile. A published copy keeps the old theme while the draft moves on.
- E: delete, then re-create the name: a new id, and the tombstone untouched. Delete the last token. Publish, then republish, is the same sheet. A forged dangling reference shows Missing, and `checkBeforePublish` names it. Clean up says what it did not scan.

**T4 as built, decided while building, say so if you disagree.**

- **The panel is a dialog from the top bar,** beside Site settings (a palette button on the wide bar, Theme in the compact bar's More menu), `src/components/site/ThemePanel.tsx`. Unlike Site settings it edits live: every control is one `updateTheme` call, so the canvas repaints behind it and each edit is its own undo step. A refusal changes nothing and is said in the dialog's live region.
- **A colour gesture is one undo step everywhere,** not only in the panel: `ColorInput`'s native picker opens a history batch on focus and writes it on blur, so a drag through many values is one step on any colour field.
- **Picking a token on a node** is a small "Site colour" select beside the colour field, on Fill, Text and Border in Styles, and a "Site fonts" group in Typography's font select. A reference shows as the token's chip, with its value resolved in the frame's mode, and Detach writes that literal. The other colour fields (forms, the sticky bar, component inputs) do not offer tokens: their values pass their own checks, which a reference is not written for.
- **Replace is one project action,** `ProjectModel.replaceToken`, which rewrites the reference in every node's props (pages, floating elements, definitions), every definition's input defaults and the theme's document block, using the same walk as the usage count, so whatever was counted is replaced. The token replaced is left as it is, so Clean up can then remove a tombstone.
- **The publish warning** is `tokens` on `checkBeforePublish`: a page whose expanded tree refers to a token the theme does not hold (or that the sheet leaves out over a cap) or to a colour that no longer parses, and the same for the document block. The server's check of a frozen revision reads that revision's theme.
- **What was not proven here:** "publish, and the live page shows it, only after publishing" needs a signed-in project and the server, which this run did not have; the demo editor cannot publish. The rest was proven in the browser on the demo editor and by the unit and score tests.

**T5, the AI.** As specified above.

- F: a generation on a site with tokens uses them; one on an empty site adds a few, in one undo step. The prompt's dark line follows the mode.
- B: rejecting removes both. Regenerating under an edited brief starts from the current theme, not the rejected run's tokens.
- R: a run collected after a lost stream, through the existing GET, applies its tokens with its page. Tokens changed meanwhile are read again at apply, so a name that now differs is refused rather than overwritten.
- E: a repair round after a refused reference converges or fails loudly. A contrast tell fires on a token pair that fails, in both modes. Rerun after failure adds no duplicates. A local `new-1` left unresolved is refused.

**T5 as built, decided while building, say so if you disagree.**

- **The core is one pure file, `src/lib/ai/pageGen/generatedTheme.ts`.** It reads the model's `theme.tokens` (at most 12, each with a local `ref` such as `new-1`, a `name`, a `kind` and values), adopts them into the request's theme through the panel's own `addColorToken` and `addFontToken` (so the grammar, the name rule and the cap are the panel's), judges every reference in a style value, and decides the tokens again at apply. The validator mints the id and rewrites the local name, so a model never chooses an id.
- **A bad reference is an error, never a quiet drop.** The repair round only runs on errors, so a dropped value would ship a page missing a colour. Refused: an id not in the site, a deleted token, a font reference anywhere but the whole `fontFamily`, a colour in `fontFamily`, an undeclared local name, and every malformed spelling (a fallback, a space, upper case). Only `--fc-t-` text is judged: the platform's other variables (`--fc-sticky-cta-h`) pass as before. The streaming preview cannot see proposed tokens, so there an unknown reference drops with a warning and the section is still sent.
- **A replace may echo a reference the target already held,** deleted or missing, because it is the owner's and renders as it did (`heldTokenIds`, from the replaced context).
- **A token no node uses is not added,** with a warning. A name the site holds with the same values is reused; with other values it is refused, and the message names the existing token to use.
- **Tokens and page are one project action** (`ProjectModel.applyGenerationWithTheme`), so one undo step. At apply the editor decides the tokens again against the theme as it is: a name that now holds other values, or a used token removed meanwhile, refuses the whole apply and changes nothing. The dialog's Undo (`revertGenerationWithTheme`) takes the added tokens out again in the same action, but only while a token is unused and unchanged; the ones that stay are named in the dialog.
- **The same on the site operations path:** `generate_page` applies the tokens with the page in one recorded write, and `insertNodes` lets an agent use the site's tokens by reference.
- **The dark line follows the mode by changing the cached prefix, not by a note beside it.** With `light` or `dark` the rules docs omit the dark look (so three prefix variants exist, and a site with no fixed mode keeps today's prefix byte for byte); the volatile section says the site is fixed. The theme section itself (tokens as delimited JSON with `<` escaped, tombstones and broken tokens left out) is in the volatile part.
- **The colour tells read tokens through resolved views** (`tokenTells.ts`): the tree is resolved once per scheme the site can show and the existing tells run on that, while the applied tree and the automatic fixes keep the references. One new tell, `low-contrast`, for text on a surface where either is a token, in each scheme in force (4.5 to 1, 3 to 1 for large text), skipped over photos and gradients.
- **Score:** the AI column of the nine theme rows is `pageItems.ai.score.ts`. Token, font token and dark value pass; the mode and the three document defaults are the new gap `ai-theme-refused`, proven by the validator refusing a `mode` or `document` field.
- **Not done, on purpose:** the generator never sees head items; the importer (T6) is untouched.

**T6, the importer.** As specified above, ledger included.

- F: a shadcn theme produces tokens and aliases, every fixture stays at parity under both themes, and a `dark:` utility arrives as the media form.
- B: changing the token file discards the proposal, keyed to its inputs like every conversion result. Same inputs keep it.
- R: a bundle read later against a site whose tokens changed re-decides match or create at placing.
- E: re-importing the same component reuses tokens and adds none, across the whole family. A renamed token makes a new one, with its line. An export re-imports to the same render, and a hand-written `--fc-t-<id>` follows the stated rule. A forged bundle with a hostile value is refused by `normalizeTheme`.

**H1, the model.** `HeadItem`, `parseHeadItem`, `isHeadHref`, both homes, the merge, `ogType`, `updateSiteHead`.

- F: every row of every list, both ways. Every refusal above, as a stored item. `@graph` passes.
- B: a page item replacing a site item, then removed, falls back to the site's. Repeatable keys both emit, and two feeds with different `type` both stay. Changing `kind` drops the fields that kind cannot hold.
- R: a save and load round trip. An old page with no `head` reads as empty. A forged item stays stored and refused, and its neighbours render.
- E: over a cap, the later items drop, and the check says so. The site copy stays cleared and kept through a tab from before the deploy. A page's own `head` does not: MST in such a tab drops the unknown field and the page snapshot is replaced whole. That is accepted, because it needs a tab open across H1's deploy and through to H3's, the first thing that can write one.

**H1 as built, decided while building, say so if you disagree.**

- **`ogType` is a closed set of four: `website`, `article`, `book`, `profile`.** Next's metadata API throws `Invalid OpenGraph type` for any other value (read in `next/dist/lib/metadata/generate/opengraph.js`), and it has no `product`, so a forged or later-added stored value would otherwise be a 500 on a published page. `parseOgType` turns anything else into `website`; the model stores the text as it is so a snapshot from a later build still loads. `product:*` properties stay allowed as items; a page that wants `og:type product` has no way to say it until Next does.
- **Six files beyond the four the slice table names,** each for a reason the table could not see: `ProjectModel.ts` (`updateSiteHead`, the one action that writes the site's list, as its own comment at the dialog's save already said), `snapshotToComponentNode.ts` (`PageSeoMetadata` and `extractMetadata` carry `head` and `ogType` to the renderer), `yjsDocShape.ts` (its metadata field list would otherwise drop both from a shared document), and the three test files. `repository.ts` needed no change: T1's `mergeKeptSiteSettings` already keeps the site's `head` against a body that lacks it.
- **Caps count stored positions, not valid items.** A page keeps its first 30 stored items and a site its first 20, at write (`storeHeadItems`, the count returned for the panel) and again at emission (`resolveHead`, reported as `over-cap`), so a hand-built request over the cap cannot widen the head. The 3 JSON-LD limit is counted after the merge, the page's first.
- **A refused item leaves no trace in the merge.** It never displaces a valid site item with the same key, and a repeated single key within one home keeps the first. `resolveHead` is total and returns the items and a list of problems (`refused`, `over-cap`, `duplicate`, `over-jsonld-cap`) with the home and stored index, which is what H3's panel and `checkBeforePublish` read.
- **A stored item with any key its kind does not hold is refused, not trimmed,** which covers `http-equiv`, a second attribute and an own `__proto__` key, and every item is rebuilt from the kind's own fixed keys, so no stored text reaches an attribute. The page's `updateMetadata` no longer uses `Object.assign`: it walks the model's own keys.
- **JSON-LD is held in bytes, depth and width before it is serialised:** 16 kilobytes as UTF-8 bytes, 12 levels, 5,000 values, JSON values only (a cycle, `NaN`, a `Date` or a function is refused), and copied through `Object.fromEntries` so a nested `__proto__` key stays a plain own key.
- **Nothing is emitted yet.** `renderSitePage`, the layouts, the routes and the render gate are untouched; H2 emits. The one published change is `pageMetadata` reading `ogType`, which is `website` for every existing page, so the head of an existing page is byte for byte what it was.
- **Evidence that the head is unchanged, and its limits.** Two local checks, both run against `origin/main` at `c7a2effb` and this branch. (1) The `Metadata` objects `siteLayoutMetadata`, `pageMetadata`, `previewMetadata` and `buildBusinessJsonLd` return, over 3 site settings, 2 hosts, 3 pages, 3 paths and both 404 flags (about 110 objects), serialise to the same bytes. (2) The raw `<head>` the real route sent from a real `next build` and `next start` over the behaviour harness's Postgres, for one site (German, site name, favicon, sharing image, business data), at `/`, `/plain` and an unknown path (the 404), keeping `meta`, `link` and `title` tags and dropping the build's own `_next` assets and the random subdomain: identical, 35 lines each. What it does not show: sites with other settings, a page with `noIndex`, a page that sets `ogType` (the one input that changes a tag, `og:type`), and any browser rendering. No test is committed for it, because it needs Docker and two full builds.

**H2, the published page.** Emission, new rows, render gate entries.

- F: raw HTML from a real build under the same eight user agents: each tag in `<head>`, JSON-LD parsing back. Chromium, Firefox and WebKit make no request to another host, on a page holding every allowed item.
- B: removing an item removes the tag on the next read, and two pages do not share items.
- R: the published copy serves its own frozen items after a later save.
- E: a designed and a default 404 carry the right items. A test fails when a `Suspense` boundary moves a tag into the body.

**H2 as built, decided while building, say so if you disagree.**

- **Emission.** `HeadItemTags` (`src/components/site/HeadItemTags.tsx`) writes the tags a page's items resolve to, from parsed items only, and `renderSitePage` renders it as the first thing in the page's fragment, above the body. `publishedHead(site, pageHead)` runs `resolveHead` over the site's list and the page's own, logs every item it leaves out (home, position, reason) and returns nothing for a branch preview, whose address is a secret that expires and where an alternate or identity link would point a crawler from it to the live site. The default 404 renders the site's items beside `DefaultNotFound`; the designed 404 goes through `renderSitePage`. JSON-LD is written as `<script type="application/ld+json" data-head-jsonld="">` through `jsonLdScriptText`, in the body beside the business block.
- **Proven on a real build** (`test/behaviour/headItems.spec.ts`, Docker Postgres, `next build` and `next start`): every allowed item stands in the raw `<head>` for each of the eight user agents of the probe, JSON-LD parses back to the stored object, hostile text never closes the element, a page item replaces the site's with the same key and a page without it carries neither, a refused item and its neighbours (the `__proto__` one included), the published copy serves its frozen items after a later save, a republish without an item drops the tag, and a forged `ogType` is written as `website`. Chromium 156, Firefox 157 and WebKit 27.2 load a page holding every allowed item and the real server counts no connection and no request to another host, with a canary in each engine proving the counter sees one.
- **The `Suspense` guard was run, not assumed.** Adding `src/app/(site)/loading.tsx` to the build failed 12 of the 22 tests (the tags moved out of `<head>`); the file was removed again.
- **Render gate** (`test/renderGate/headItems.gate.tsx`, Chromium and WebKit): stored http-equiv in three shapes, `referrer`, `viewport`, `color-scheme`, every `stylesheet` spelling and the other refused rels (with `as`), `javascript:`, `data:`, `//host` and backslash addresses, a `script` and a `style` kind, all as stored data through the real emission: no navigation, no request, no script. Hostile JSON-LD in five forms runs nothing and parses back, U+2028 and U+2029 included, and a canary is requested.
- **The 404 does not put items in its raw `<head>`, and that is not new.** A miss answers 404 with Next's error document, and the not-found tree reaches the page through the stream: its tags are in the raw HTML as stream data and in `<head>` once the page has run, which the behaviour spec reads in Chromium for both the designed and the default 404. A 404 is noindex, so no crawler reads a head off it, and at the base commit the 404's raw HTML held no title or Open Graph either.
- **Observed, not caused here, not yet investigated:** for a page other than the home page, Next's own metadata (title, canonical, Open Graph, the manifest link) sits in the body in the raw HTML, even for a Googlebot user agent, and is moved into `<head>` by the client; on the home page it stands in `<head>`. Head items are in `<head>` on every page. If a crawler that runs no script reads that body metadata, search snippets are at risk, which is worth its own check before the first real launch.
- **Open here: the score's head rows.** The plan's 42 rows (33 head rows, five columns) are not added in this slice. They change `test/score/lib/types.ts` and `test/score/report.ts`, which the FX generator pull request #383 also edits, and the panel column would fall until H3 builds the panel, which needs a baseline refresh decided with the owner of the score. They go in after #383 lands, on the roadmap line.

**H3, the panel.** A Head section in Page settings and in Site settings: a kind picker, a list of allowed names with what each is for, a JSON-LD editor with live parse errors, the refusal text for an owned name naming the field to use.

- F: add one of each, publish, and the head holds them. A verification item can be added in under a minute.
- B: editing a JSON-LD to invalid keeps the last valid one, and shows why. Undo through each.
- R: reload keeps the list. A half-typed JSON-LD is a local draft, and is not saved.
- E: an item refused after a later code change shows as refused, not silently gone, and can be deleted.

## What this does not cover

- **Page-wide scripts,** by the behaviour contract, sandboxed.
- **Spacing, radius and shadow tokens.** Colour and font are what a site changes as a whole. An import's `--radius` stays on its root. The shape takes a new `kind` without a migration.
- **A visitor's light and dark switch,** see above.
- **Per-page themes and theme variants.** One site, one theme. A page's `:root` rule is the per-page answer for the three document properties.
- **Tokens shared between sites.** No clipboard path between projects was found [code]. Whichever change adds one meets the dangling reference check.
- **A page-wide stylesheet, `@page`, `@layer` and view transitions,** which stay red.
- **Head items that take bindings,** and product structured data, which the shop stream generates.
- **Enforcing a Content Security Policy,** which stays Marlin's open decision. Nothing here depends on it.

## Decided here, say so if you disagree

The fleet plan gives contracts to a fresh review agent, so these do not wait for Marlin.

1. `siteSettings.theme`, not a new column, with last writer wins on the blob behind a conflict warning.
2. No fallback in a reference, with tombstones, unlike Framer. Confirmed by the operator after review, with no automatic sweep, a cap, and broken values kept.
3. `mode` is optional, and absent means not chosen. Decided by the operator.
4. A forced mode answers `prefers-color-scheme` in node and `:root` rules. `or` is left as stored.
5. Forced `dark` writes `class="dark"`, on the document and on a frame, which wakes the editor's `.dark` variables on that site. A `system` site's frame does not.
6. No visitor switch.
7. A page's `:root` rule beats the theme, `color-scheme` included, so #261 needs no edit.
8. The `document` block holds two colours and a font.
9. The banner fails closed to the neutral pair, decided by the operator. T2 feeds it resolved colours, so a pair that reads keeps the site's look.
10. Importer output keeps its names, and its root aliases site tokens.
11. `dark:` always becomes the media form, and `use-system-dark` goes away.
12. A token name collision on import makes `primary N`, and on an AI generation is refused. An import is a person's deliberate act with a report, and a generation is not.
13. The AI may add tokens and writes no head items.
14. `next` and `prev` are out, because Firefox fetches `next` and search engines do not need them.
15. JSON-LD emits in the body.
16. A page's own `head` is not kept against a tab from before H1's deploy.
17. A `style-src` policy stays out of scope, with the cost stated.

## Review findings, and what changed

All 18 and the small items are applied. Where one was adapted, this says how and why.

| Finding | Where it went | Adapted |
|---|---|---|
| 1, #261 | T1's dependency; "One home per property"; `document` cut to three; `isPlatformVariable`; score section | Of the two `colorScheme` options, the one that leaves #261 alone: the page rule wins, and "Theme owns" is gone |
| 2, banner | "The consent banner and the default 404"; T2 | Taken with the operator's decision and #261's later fail closed, which replaced "passes unjudged". `color()` is limited to three spaces in the grammar so "extend `parseColor` to the grammar" is complete |
| 3, default `light` | Decision 4; the mode table; T2 and `theme-dark-rule` | None |
| 4, T6's order | Slice table | None |
| 5, second tab, deploy trap, Yjs | The four traps; T1, T3 and T4's paths | None |
| 6, export | "Export"; T6; the importer contract | Slug comparison added, because an exported name otherwise would not find its token |
| 7, tombstones | "Deleting", "When a value stops parsing"; caps | Broken colours emit nothing, since no stored text may reach the sheet, and the grammar is append only so this should stay unused. Delete is refused at the cap rather than dropping |
| 8, forced `dark` canvas | "Canvas and preview"; T3 | **Narrowed.** The class goes on a forced `dark` frame only, not every dark frame: a `system` site's published page has no class, so a frame carrying it would show what no visitor gets |
| 9, `system` half dark | Importer table; the importer contract | None |
| 10, the evaluator | `withColorMode`; T3 | Lives in a new file, `colorMode.ts`, because both the emitter and the surfaces read it |
| 11, grammar | Grammar table; "`themeCss` trusts nothing"; `generateViewport` | None |
| 12, keyframes | "Reserved names" | None |
| 13, size | "Published page" | Tombstones counted too, which makes the worst case 132 kilobytes rather than 51 |
| 14, refused items | "What a page may hold"; H1, H3 | None |
| 15, merge key | "The merge"; H1 | None |
| 16, `dark` with no theme | "Light and dark" | None |
| 17, re-entry | "Match or create"; T6 | None |
| 18, file lists | Slice table; H1; the AI's local name | The H1 line accepts the loss for a page's `head`, with its reason, instead of adding a server merge for a window that needs a tab across two deploys |
| Small | `isHeadHref`, `@graph`, the JSON-LD cap, `data-fc-theme-sheet`, `layoutAudit` in the reader table | None |

**The recheck at `b5b243f`** found eight small items, all applied: `withColorMode` rewrites only recognised forms; caps are enforced at write and broken text is limited; `broken` is recomputed on read; the cap points at Detach and Replace; export slugs avoid `fc-` and `u-`; non-token `.dark` values take the media form; `SaveButton.tsx` is named; and #261 moved from T1 to T2.

**Not adopted.** Nothing was declined. Two things in the review no longer apply as written: its `:root` row timing, since this contract now claims no such row, and "named colours and literals outside the grammar" as the open question, which the operator has decided.

## Open questions

None needs an answer before slice T1. T2 waits for #261, which holds `isPlatformVariable` and the `:root` rule; T1 does not. Whether a future policy adds `style-src` is the existing open decision on enforcing a Content Security Policy, and this contract only states its price.

**Still unproven, for whoever builds it:** whether `dns-prefetch` and Chromium's `preconnect` stay silent outside automation (both are refused either way); whether editor overlays survive a dark `color-scheme` on a frame, which T3 checks; whether a dark page avoids a white first paint; whether native dropdowns and scrollbars look right on a `system` site with no dark values; and the banner table, which comes from #261's `legibleLook` on resolved values, because T2's resolving does not exist yet.
