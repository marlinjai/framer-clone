---
type: plan
status: draft
date: 2026-10-26
title: "Editing an existing Next.js frontend visually in framer-clone (BusBasis storefront as the case)"
summary: "Research on what framer-clone would need so the BusBasis storefront (Next.js 16, Medusa 2.19) can be edited visually in it: code components with typed property controls, headless delivery, a canvas that runs the storefront's components, and a BusBasis company. Verdict: about 11 to 16 weeks, half of it the canvas, so the decided Puck plan stays right for BusBasis and its block schemas become framer-clone's first code components later."
tags: [framer-clone, code-components, property-controls, headless, canvas, busbasis, puck, medusa]
projects: [framer-clone]
---

# Editing an existing Next.js frontend visually in framer-clone

Question from Marlin (2026-10-26): what exactly would framer-clone (Lumitra's hosted Framer-style
website builder) need so that an existing Next.js frontend, the BusBasis storefront at
`MedusaJS/busbasisberlin-storefront` (live at basiscampberlin.de), can be edited visually in it?

This is research, not a decision to build. Everything below was read from the code on
`origin/main` at `79719bb` (framer-clone) and from the storefront's `main` on 2026-10-26. Nothing in
MedusaJS was changed.

## Bottom line

framer-clone is roughly **11 to 16 weeks of agent work** away from editing this storefront, and the
largest part (about half) is not a loader or an API but **a second kind of editor canvas**: one that
draws framer-clone's selection and drag handles over the storefront running in its own iframe. The
reason is hard: framer-clone runs Next.js 15.5 with Tailwind 4, the storefront Next.js 16.4 with
Tailwind 3 and the Medusa preset, plus next-intl, country-code routing and Meilisearch search. Those
components cannot be bundled into framer-clone's page; they can only run inside the storefront.

So the **decided light alternative (Puck inside the storefront, about two weeks) stays right for
BusBasis**. It is also low-regret: its blocks take all content as props, are validated by zod schemas
and are stored in Puck's data shape, which is exactly the form framer-clone would import later as its
first code components.

Recommended order, each step useful on its own:

1. **Code components with typed property controls** (point 1). framer-clone needs these for its own
   marketing sites anyway (roadmap line "Builder UX gaps"). 3 to 4 weeks.
2. **Headless delivery** (point 2), whose first step (an immutable published copy of each page)
   also fixes a live gap in framer-clone's own hosting, described under point 2. 2 to 3 weeks.
3. **The hosted canvas** (point 3), only once framer-clone is meant to edit frontends it does not
   host. 5 to 7 weeks.
4. **The BusBasis company** (point 4) is mostly auth-brain configuration plus three small gaps. 1 to 2
   weeks, needed only when a BusBasis team actually works in framer-clone.

| Point | What exists | Main gap | Effort |
|---|---|---|---|
| 1. Code components | A dormant, editor-only hook for React components; untyped props; hand-written properties panel | Stored component id, a shared registry for editor and server, a control schema, a generated inspector, a server render branch, a document version | 3 to 4 weeks |
| 2. Headless delivery | Pure functions that turn a stored page into a render tree | Published copy, read API (application programming interface) with machine keys, publish webhook, schema contract, preview | 2 to 3 weeks |
| 3. Canvas with the storefront's components | Same-document canvas, no iframe | A hosted canvas mode: iframe into the storefront, a message protocol, an overlay | 5 to 7 weeks |
| 4. BusBasis company | Companies, logins, roles all in auth-brain | Editor-without-publish role, page image storage, invite flow | 1 to 2 weeks |

The estimates are judgement, not measurement, in the same unit as the other framer-clone plans
(agent working days, five per week), and assume one focused stream with review.

## Context: the two codebases

**framer-clone** (`package.json`): Next.js 15.5.28, React 19.1, Tailwind 4, MobX-State-Tree (MST, the
in-memory tree that backs the editor) 7, zod 4, Yjs for the planned multiplayer. Postgres via Prisma.

**BusBasis storefront** (`busbasisberlin-storefront/package.json`): Next.js 16.4.3, React 19,
next-intl 4.13, Tailwind 3 with `@medusajs/ui-preset`, framer-motion 12, `@medusajs/js-sdk` 2.19,
Headless UI, Radix, InstantSearch with Meilisearch, Stripe. Hosted on Vercel; the Medusa backend runs
on Coolify at basiscamp-berlin.de. Note: framer-clone's own plans call this business "Basis Camp
Berlin" (`docs/plans/2026-10-25-business-platform-architecture.md:38-39`, ":100: Basis Camp stays
on Medusa"); "BusBasis" is the repository name.

Facts about the storefront that matter for every point below:

- **Routing** goes through `src/proxy.ts` (Next 16 renamed middleware to proxy). It fetches the
  Medusa regions and redirects every path without a country code to `/{countryCode}/...`, sets a
  per-visitor `_medusa_cache_id` cookie and a `Cache-Control: s-maxage=60` header.
- **Internationalisation (i18n) is German only in practice**: `src/i18n/request.ts` hard-codes `locale = 'de'` and the root
  layout imports `messages/de.json`; `messages/en.json` exists but nothing loads it.
- **The homepage sections** (Hero, Services, Team, Verein, Contact, FAQ, plus the announcement banner
  and a prefetcher) are all client components. On `main` none takes props: texts come from
  `useTranslations`, team members are hard-coded, FAQ items and the banner come from a client fetch
  of `/api/public/settings`. The hero opens an InstantSearch modal. `LocalizedClientLink` reads the
  country code from `useParams()`, so it breaks outside the `[countryCode]` route.
- **Fonts and styles**: no `next/font` (Inter is named but never loaded), `globals.css` with RGB
  custom properties, always dark (`html.dark`), a custom Tailwind variant `hero-alert-visible`.
- **Data caching**: Medusa calls use cache tags suffixed with the visitor's cookie, so there is no
  global tag a publisher could invalidate. There is no revalidation endpoint and no incoming webhook.

**State of the Puck work (snapshot, 2026-10-26, may have moved on):** the plan
`MedusaJS/busbasisberlin/docs/plans/2026-10-26-visual-homepage-editor.md` is decided. Phase 0
(sections take their content as props, zod block schemas, a default document) was in progress,
uncommitted, in the worktree `MedusaJS-editor-p0` on branch `feat/homepage-editor-phase0`. Its
`src/modules/site-content/schema.ts` already uses Puck's data shape, `{ root: { props }, content:
[{ type, props: { id, ... } }] }`, with `schemaVersion: 1`, bilingual text as `{ de, en }`, at most 50
blocks, unique block ids and an `href` pattern. Puck itself was not installed yet.

## 1. Code components: external React components with typed props

### What exists today

- **The registry is a palette of HTML presets, not component definitions.**
  `src/lib/componentRegistry.ts:70-98` defines `ComponentRegistryEntry` as `{ id, label, category,
  icon, iconClassName, htmlType, defaultProps, defaultSize, bindableSlots?, dataComponentKind?,
  defaultChildren? }`. `htmlType` is always an HTML tag. Props have no schema; `defaultProps` holds
  example values with styles nested under `style`. Registered ids: text, button, stickyCta, image,
  container, stack, grid, flex, card, collection, recordView, tableView, six commerce kinds and nine
  form kinds.
- **The only per-prop metadata is `bindableSlots`** (`src/lib/bindings/types.ts`), which drives the
  data-binding picker for CMS (content management system) and commerce data, not a property form.
- **Nodes store untyped props.** `src/models/ComponentModel.ts:89-135`: `type` (the HTML tag, not the
  registry id), `componentType: 'host' | 'function'`, `props: types.frozen<Record<string, any>>()`,
  `bindings`, canvas-only fields, `children`. Styles, effects, marker props and component-specific
  keys share one frozen object. Responsive values are maps `{ base, <breakpointId>: v }`, resolved by
  `getResolvedProps` (`:636-670`).
- **The registry id is not stored on the node.** `insertRegistryComponent`
  (`src/models/PageModel.ts:211-254`) creates the node with id `${entry.id}-${uuid}`; the properties
  panel recovers the registry id from that prefix (`src/components/sidebars/right/registryId.ts:11-30`).
- **The properties panel is hand-written per kind of node.**
  `src/components/sidebars/right/sectionConfig.ts` picks a category from tag and marker props
  (viewport, form, stickyCta, image, text, container, generic) and maps it to fixed sections (Size,
  Position, Layout, Typography, Image, Styles, Effects, Form, StickyCta). Every editor inside a
  section is JSX written by hand from primitives in `right/primitives/`. Only `DataSourceSection.tsx`
  is generated, from `bindableSlots`.
- **A hook for React components exists but is dormant and editor-only.**
  `ComponentTypeEnum.FUNCTION` and `createFunctionComponent` (`ComponentModel.ts:690-700`), and in
  the shared editor and preview dispatch `createComponentElement.tsx:312`:
  `(window as any).__componentRegistry?.[component.type]`. Nothing outside a test registers anything.
  The published-site renderer `src/lib/renderer/server/renderComponentNode.tsx` has no
  function-component branch at all (its own comment at `:18-22`); an unknown `type` falls through
  `resolveHtmlTag` (`:59-63`) and is emitted as a literal element such as `<FancyBox>`.
- **The AI page generator forbids function nodes** (`src/lib/ai/pageGen/schema.ts:106-115`,
  `validate.ts` forces `componentType: host`).
- **No document version.** No version field in page or project snapshots, no migration code;
  tolerance comes only from MST defaults and a few normalisers.
- **Prior design:** the archived ArboSano builder plan
  (`docs/specs/build-2026-06-arbosano/IMPLEMENTATION-PLAN.md`, section 3) sketched a
  `controls?: ComponentControls` field on registry entries (text, richtext, number, boolean, color,
  enum, image, link, list with item controls, spacing), an inspector that reads it, and a server
  branch for `data-component-kind === 'custom'` with a `customComponentRegistry.ts` plus a client
  island shell. It set the right altitude: marketing blocks need content editing and a few style
  knobs plus page-level add, remove and reorder, not free-form editing of their internals. It was
  archived when ArboSano moved to WordPress; none of it was built.

### How the four reference editors do it

| | Registration | Prop types | Where components run in the editor | Schema changes |
|---|---|---|---|---|
| Framer | `addPropertyControls(Comp, { text: { type: ControlType.String } })`, code written inside Framer | String, Number, Boolean, Enum, Color, Date, File, Link, Font, ResponsiveImage, Array, Object, ComponentInstance (a child slot), style and event types; no rich text | Inside Framer; npm imports "experimental"; no story for Next.js context | No documented migration |
| Plasmic | `registerComponent(Comp, { name, props: { children: 'slot', color: 'string' } })` | string, number, boolean, choice, color, imageUrl, href, object, array, slot (restrictable, repeatable), eventHandler, code, date | **Your app in an iframe** (an "app host" page rendering `<PlasmicCanvasHost />`); framework context through registered global contexts | Type change deletes values; renames not supported; advice is "new component, deprecate the old" |
| Builder.io | `customComponents: [{ component, name, inputs: [...] }]` (Gen 2 SDK) | string, longText, richText, number, boolean, enum, color, file, date, url, list, object, reference; any input can be `localized` | **Your running site in an iframe** via a preview URL; no React Server Components; server-fetched data not available while editing | Renames break published content |
| Puck | A config object `{ components: { Hero: { fields, defaultProps, render } } }` | text, textarea, number, select, radio, array, object, richtext, slot, external (references), custom; no built-in color or image | Inside your app, because Puck is a library you embed; preview in an iframe by default | `transformProps` and `migrate()` helpers; renames are breaking otherwise |

Sources: framer.com/developers/property-controls, docs.plasmic.app/learn/code-components-ref and
/app-hosting, builder.io/c/docs/custom-components-input-types and /preview-url,
puckeditor.com/docs/api-reference/fields and /integrating-puck/data-migration (checked 2026-10-26).

The lesson for framer-clone: every editor that edits components living in someone else's codebase
(Plasmic, Builder.io) runs them **inside that codebase** and only sends data across. Framer avoids
the problem by owning the code. Puck avoids it by being embedded.

### What is missing

1. **Node identity.** A code component node must carry its component id: `componentType: function`
   with `type` set to a namespaced id such as `busbasis/Hero`. Registry presets should also store
   their registry id instead of relying on the id prefix.
2. **One registry for editor and server.** Replace `window.__componentRegistry` with a module both
   the editor and `renderComponentNode.tsx` import: `{ id, label, category, icon, controls,
   defaultProps, render: React.ComponentType, island?: boolean, acceptsChildren?: slot rules }`.
3. **A control schema.** The ArboSano kinds plus three it lacked: `localizedText` (the storefront and
   the Puck schemas store `{ de, en }`), `object` (a nested group), and `slot` (named child areas,
   which Puck, Plasmic and Framer all have). Image and link controls first take a URL; a media picker
   follows with point 4's storage.
4. **A generated inspector section.** A `ControlsSection` that renders one editor per control and
   writes through `component.setProps`, placed above the hand-written sections. Style sections stay
   for host nodes; for a function node only the wrapper's Size, Position and Effects apply. The
   existing primitives (`TextInput`, `PropertySelect`, `ColorInput`, `PropertySwitch`) cover most
   kinds; list (add, remove, reorder) and localized text are new.
5. **Server rendering.** A function branch in `renderComponentNode.tsx` that looks the id up in the
   shared registry and renders the component on the server, a client island (copying
   `CommerceIsland.tsx`) for interactive ones, and a visible placeholder (not a stray element) for an
   unknown id, with a publish warning.
6. **Validation and versions.** Props of function nodes validated against their controls on save and
   publish (zod derived from the control schema), a `schemaVersion` on the page snapshot and a load
   time migration step. Per the pre-launch rule (no backwards compatibility), stored documents are
   rewritten by a one-off script rather than carried by shims.
7. **The AI generator** must learn function nodes: its schema docs are generated from the registry,
   so they extend once controls exist.

### Options

| Option | What it is | For | Against |
|---|---|---|---|
| A. Controls on the existing registry (ArboSano design, extended) | `controls` on registry entries, generated inspector, server branch | Smallest step; also gives framer-clone's own marketing sections typed forms | Components still compiled into framer-clone; no external libraries yet |
| B. Per-project component libraries | A project declares a library (its components and controls), loaded from a package or a host | What BusBasis needs eventually | Needs A first, plus loading (point 3) |
| C. Adopt Puck's config format as framer-clone's registry format | Read a Puck `Config` directly | Free interop with the BusBasis blocks | Puck's fields lack color and image, its config holds render functions (not serialisable), and framer-clone would follow Puck's churn |

### Recommendation

**A now, designed so B is a later addition, with an importer for Puck field definitions instead of
adopting Puck's format (C).** Concretely: the control schema is plain serialisable data (so a host
can later send it over a message channel), the registry entry separates the serialisable metadata
from the `render` function, and a small converter maps Puck fields (`text`, `textarea`, `number`,
`select`, `radio`, `array`, `object`, `richtext`, `slot`) to framer-clone controls.

**Effort: 3 to 4 weeks.** About 3 days for identity, registry and schema; 5 for the inspector
(list editing and localized text take most of it); 3 for the server branch, islands and the unknown
fallback; 2 for validation, `schemaVersion` and the migration script; 2 for the AI generator; the
rest for tests (forward, backtrack, resume, re-entry per the stateful-flow standard) and two or three
real marketing sections (hero, features, call to action) built as code components to prove it.

## 2. Headless delivery: the storefront fetches page documents and renders them itself

### What exists today

- **Storage:** one JSONB (binary JSON) column per page, `SitePage.snapshot`
  (`prisma/schema.prisma:292-321`), holding the full MST page snapshot including editor-only canvas
  nodes. `Site.status` is `draft | published | archived`.
- **No published copy.** Save (`src/app/api/projects/save/route.ts`) and publish
  (`src/app/api/projects/publish/route.ts:93-97`) both call `repo.saveProject`, which upserts the
  same `site_pages` rows; publish then only flips `Site.status` and calls `revalidateTag` for
  `site:<subdomain>` and each custom host. The public resolver
  (`src/server/sites/publicResolver.ts:207-223`) reads those same rows for any site whose status is
  published. Visitors are protected from saved-but-unpublished edits only by `unstable_cache`
  (`src/server/sites/cachedResolver.ts:233-250`), which is per process. **On a cache miss (a restart,
  a new deploy, a second replica), the public site shows the last save, not the last publish.**
  Saving is manual (`src/components/SaveButton.tsx`), so this takes a save on a published site plus
  a cache miss; it is a real gap today, independent of BusBasis.
- **No versions or history.** No version column (the repository says so at `repository.ts:403`), no
  revision table, last write wins.
- **Rendering pipeline that is already headless in spirit:** `snapshotToComponentNode.ts` drops the
  canvas and editor fields and returns `{ type, props, bindings, children, id }`; `hydrateBindings.ts`
  resolves CMS and commerce bindings; `renderPublishedPage.tsx` renders. The site route
  `src/app/(site)/[...slug]/page.tsx` is `force-dynamic` with the whole site cached by tag.
- **No public API for documents, no machine keys, no CORS (Cross-Origin Resource Sharing, the headers that let a browser on another domain call an endpoint).** The only anonymous endpoints are
  host-scoped reads of CMS rows and commerce products, and form submission. auth-brain already
  issues service-account keys for machine-to-machine calls
  (`docs/plans/2026-06-23-framer-hosting-platform-foundation.md:41`).
- **No outgoing events.** The event-layer plan of 2026-05-02 is archived and unbuilt;
  `src/app/api/projects/route.ts:118` notes there is no job or outbox seam.
- **Prior thinking:** the archived renderer research
  (`docs/plans/2026-05-01-framework-agnostic-renderer-research.md:127, 194-199`) already described
  "ship JSON plus a runtime renderer per framework, what Builder.io does" and estimated one week for
  the shared JSON schema plus one to one and a half weeks per framework runtime.

### What is missing

1. **An immutable published copy**, written only by publish: a `site_page_revisions` table (page,
   version, document, kind draft or published, author, time) plus a `published_revision_id` on the
   page, or at minimum a `published_snapshot` column. The public site and the delivery API read only
   that. This is also what makes history and restore possible.
2. **A delivery contract**: a versioned, documented JSON shape. For an external frontend the useful
   unit is the render tree of `snapshotToComponentNode`, not the MST snapshot (canvas nodes,
   positions and editor fields are noise to a consumer). Proposed envelope: `{ schemaVersion, site,
   page: { id, slug, metadata }, revision, publishedAt, tree: ComponentNode }`, with a zod schema
   published as a small package both sides import. Since BusBasis renders function nodes with its own
   components, its documents would be mostly `{ type: 'busbasis/Hero', props: {...} }` nodes; host
   nodes (framer-clone's own boxes and text) need either a tiny reference renderer in that package or
   a rule that pages delivered to external frontends contain only code components at the top level.
3. **A read endpoint** for machines, scoped per site: for example `GET /api/delivery/v1/sites/:siteId/pages/:slug`
   and `GET .../pages` (slugs and metadata for the consumer's sitemap). Authenticated with an
   auth-brain service-account key bound to the site's workspace, read-only. Called from the
   consumer's server, so no CORS is needed; if a browser ever calls it, CORS is added then.
4. **Publish webhook**: on publish and unpublish, a signed POST (HMAC, a hash-based message authentication code with a shared secret per
   subscription) to URLs the site owner registers, with `{ siteId, slugs, revision }`. The storefront
   gets a route that verifies the signature and calls `revalidateTag('fc-page:<slug>')`. Without an
   outbox in framer-clone, the first version sends directly after the publish transaction commits and
   records failures with a retry button; an outbox follows when other events need it.
5. **Preview of drafts**: a short-lived signed preview token (minutes, one page, one revision)
   generated by the editor; the consumer's `/api/preview` route verifies it, enables Next.js
   `draftMode()`, and fetches the draft revision with it. This mirrors how Plasmic and Builder.io
   handle preview, adapted to the App Router.
6. **Bindings and data**: CMS and commerce bindings resolve against framer-clone's own data, which an
   external frontend does not have. For BusBasis this does not matter (its components fetch Medusa
   data themselves, the document carries only content), so the first version delivers bindings
   unresolved and documents that consumers either ignore them or call framer-clone's existing
   host-scoped CMS endpoints.
7. **Images**: documents reference image URLs; the consumer must allow the image host in
   `images.remotePatterns`. Depends on point 4's storage.

### Options

| Option | For | Against |
|---|---|---|
| A. REST (plain HTTP and JSON) delivery API plus webhook, consumer renders with its own components (the Builder.io model, self-hosted) | Fits the storefront as it is; the storefront keeps its routing, shop and caching; small surface | Two repositories share a contract that must be versioned with care |
| B. framer-clone serves the pages itself and the storefront proxies or iframes them | No contract | framer-clone cannot render the storefront's components (point 3), and the shop shares header, cart and search with the pages |
| C. Codegen: framer-clone writes React files into the storefront repository on publish (Plasmic codegen) | No runtime dependency | A publish becomes a pull request and a deploy; non-developers lose instant publishing |
| D. Emit Puck's data shape from framer-clone, so the storefront's Puck renderer keeps working | The storefront would not change at all when switching editors | Ties framer-clone's contract to Puck; nested framer-clone trees need slots to map |

### Recommendation

**A, with a `toPuckData` adapter in the delivery package** (taking the good part of D without making
Puck the contract). The mapping is direct: Puck's `content` is an ordered list of
`{ type, props: { id, ... } }`, which is `tree.children` of function nodes; Puck slot fields map to
named child areas. A storefront that already renders Puck data could switch its data source from the
Medusa `site-content` module to framer-clone with one fetch change.

**Do the published copy first, regardless of BusBasis**, because it fixes the visitor-sees-unpublished
gap described above.

**Effort: 2 to 3 weeks.** 3 days for revisions, the published copy and restore; 2 for the contract
package and its zod schema; 2 for the endpoint and service-account keys; 2 for the webhook with
signatures and retries; 2 for preview tokens; 2 to 3 for the consumer side in the storefront (fetch
with a global cache tag, revalidate route, preview route, renderer mapping block types to components);
the rest for tests.

## 3. An editor canvas that runs the storefront's components

### What exists today

- **The canvas is the same document as the editor, not an iframe.** Viewport frames are transformed
  divs (`src/components/ResponsivePageRenderer.tsx`, `GroundWrapper`); styles are inline objects with
  breakpoints resolved in JavaScript per frame. The preview plan already said the iframe path is
  "needed once we add user code components or want true CSS isolation"
  (`docs/plans/2026-04-20-preview-mode.md:125`, `:158`).
- **Selection, drag and drop, resize and inline text editing** all assume they can reach the rendered
  DOM (Document Object Model) nodes directly in the same document (the drag-drop unification work
  uses `elementsFromPoint`).

### What the storefront's components depend on

| Dependency | Where | Consequence for a foreign canvas |
|---|---|---|
| `next/image`, `next/link`, `next/navigation` (`useParams`, `useRouter`, `usePathname`) | Hero, Team, footer, `LocalizedClientLink`, `StorePrefetch` | Need the App Router runtime of Next 16, or shims |
| next-intl `useTranslations` with `de.json` | Every section for interface strings | Needs `NextIntlClientProvider` and the message files |
| Tailwind 3 with `@medusajs/ui-preset`, `tailwindcss-radix`, a custom variant, CSS custom properties in `globals.css`, `html.dark` | Everywhere | Must be compiled with the storefront's config; collides with framer-clone's Tailwind 4 and editor chrome |
| Client fetches of `/api/public/settings`, the contact POST with the publishable key | FAQ, banner, Hero search flag, Contact | Need the storefront's origin and environment |
| InstantSearch, Meilisearch, Headless UI modals | Hero search, Verein's legal modal | Heavy client dependencies, fine in the storefront |
| `src/proxy.ts` country redirect, per-visitor cookies | All routes | A canvas route must be excluded from the matcher or live under a country segment |
| Async server components (`Nav`, the main layout's cart and customer lookups) | Layout, not the editable sections | Cannot re-render client-side on every edit; stay outside the editable area |

### Options

| Option | How | For | Against | Verdict |
|---|---|---|---|---|
| A. Shared package bundled into framer-clone | Publish the sections as an npm package and import them in the editor | Same-document canvas keeps working | Two Next majors (15.5 vs 16.4), two Tailwind majors (4 vs 3) and their CSS in one page; every provider and route shim rebuilt in framer-clone; any storefront change needs a framer-clone release | Ruled out |
| B. Module federation | Load the storefront's components at run time from its build | No rebuild of framer-clone | The Next.js plugin for module federation has historically supported only the Pages Router (not re-verified for Next 16); same CSS and runtime collision as A; fragile | Ruled out |
| C. App host iframe (the Plasmic and Builder.io model) | The storefront gets one route (for example `/fc-host`, excluded from the proxy, framable only by app.lumitra.co) that renders a small host runtime: it receives the page tree over `postMessage`, renders it with its own registered components inside its own providers, and reports back element rectangles, hover and clicks, and the component library (ids and control schemas) | Components run in their real environment, including data fetches, fonts and Tailwind; the storefront can change freely; the same host serves draft preview | framer-clone needs a second canvas mode: an overlay that draws selection, hover and drop indicators from reported rectangles; drag and drop over an iframe; breakpoints become iframe widths; a message protocol to version; a host runtime package to maintain | **Recommended** |
| C-lite. Form plus live preview (what Puck gives) | framer-clone shows the outline and the generated property form; the iframe shows the storefront page in draft mode; clicking in the iframe selects the block | About a third of C; enough for content editing | Not a visual canvas: no drag on the page, no handles | Good first stage of C |
| D. Server-rendered screenshots | The storefront renders the draft, framer-clone shows images | Trivial isolation | Slow, no interaction | Ruled out |

### What breaks or needs a decision even with C

- **Free-form styling does not apply.** framer-clone's Styles, Typography and Layout sections write
  inline styles on host nodes; a storefront component is styled by its own Tailwind classes and only
  takes props. Code components therefore get the property form plus page-level add, remove, reorder
  and duplicate (the altitude of the ArboSano plan), not pixel editing. A component can expose style
  knobs as enum controls (for example a "tone" or "spacing" choice).
- **Breakpoints.** framer-clone's breakpoints are viewport nodes with pixel widths; the storefront
  has Tailwind screens (512, 1024, 1280, 1440 ...). In hosted mode each breakpoint frame is an
  iframe of that width. Responsive props (a different value per breakpoint) are not offered for code
  components at first.
- **Security.** The host route must answer only to framer-clone's origin (`frame-ancestors` in its
  Content-Security-Policy, origin checks on every message) and must render only what it is sent; it
  never receives a framer-clone session.
- **Which mode a project uses.** A project is either native (same-document canvas, framer-clone
  hosts it) or hosted (iframe canvas, an external frontend renders it). Mixing both on one page is
  out of scope.
- **The AI generator and multiplayer.** Generation must know the host's component library (it
  arrives with the host's handshake); the Yjs document shape stores props per node and needs no
  change for opaque code-component props.

### Recommendation

**C, built in two stages: C-lite first (outline, form and live preview, click to select), then the
overlay with drag and drop.** Stage one already matches what the Puck editor gives the BusBasis team;
stage two is what would make framer-clone better than Puck for them.

**Effort: 5 to 7 weeks.** Host runtime package and message protocol, 1 week; C-lite in framer-clone
(hosted project mode, outline, preview iframe, click to select, library handshake), 1.5 weeks; the
overlay (rectangles, hover, selection, drop indicators, reorder by drag, breakpoint frames as
iframes), 2 to 3 weeks; the storefront side (host route, proxy exclusion, providers, registration of
the blocks), 3 days; tests and hardening, the rest.

## 4. A BusBasis company in framer-clone

### What exists today

- **framer-clone models no identity of its own** (`src/lib/auth-brain.ts:5-7`). Organisation (tenant
  group), company (tenant), workspace and memberships all live in auth-brain; sign-in is single
  sign-on through the `lumitra_session` cookie on `.lumitra.co`.
- **A company is usable** when it is one of the user's tenants, has the `sites` app grant and a
  workspace the user belongs to (slug `main` wins), see `src/server/sites/scope.ts:27-51, 131-173`.
  The active company is chosen by the `framer_company` cookie, re-checked against the session
  (`src/lib/activeCompanyCookie.ts`, `src/server/auth/activeCompany.ts`).
- **Data isolation:** sites and pages are filtered by `workspace_id` and `tenant_group_id` in code;
  commerce, Books and catalogue live in one Postgres schema per organisation (`tg_<hex>`) with a
  `tenant_id` per company. The first project a company creates provisions its schema
  (`src/app/api/projects/route.ts:70-82, 346`).
- **Roles** (`src/lib/permissions.ts:34-63`): `viewSite` needs workspace viewer; `editSite`,
  `publishSite` and `manageDomain` all need workspace admin. `workspace.member` is unused. So there
  are two effective roles, and nobody can edit without also being able to publish.
- **No invite or team management in framer-clone.** A user without the grant sees a page telling
  them to ask the company owner to request access in the account portal (`src/app/projects/SitesNotEnabled.tsx:32`).
- **No object storage for page images.** Page images are plain URLs (often Unsplash, from the AI
  generator). Catalogue and Books images are stored as bytes in Postgres, served only to signed-in
  users (`src/server/catalog/repository/images.ts:1-13`, "until a storage-brain client exists here").
- **Domains:** a subdomain under `sites.lumitra.co` on publish, custom domains with TXT (text record)
  verification and Traefik certificates (`docs/plans/2026-06-25-framer-custom-domains.md`). For
  BusBasis in headless mode the domain stays with Vercel and none of this is used.
- **Commerce:** framer-clone has its own engine; there is no Medusa connector ("We are NOT building
  on Medusa", `docs/research/2026-06-27-medusa-inventory-backorder-reference.md:13`). Not needed for
  headless content editing: the shop stays on Medusa.

### What is missing

1. **auth-brain configuration**: an organisation and company for BusBasis, the `sites` grant, one
   `main` workspace, the team as members. Half a day, no code.
2. **An editor-without-publish role**: map `editSite` to `workspace.member` and keep `publishSite`
   with admin, plus a "request publish" hint in the interface for members. The Puck plan does not have
   this either (any Medusa admin user can publish). 1 to 2 days.
3. **Page image storage**: a Storage Brain client in framer-clone for page images, per company, with
   public, cacheable URLs a foreign frontend can load through `next/image`, and the media picker for
   the image control of point 1. 3 to 5 days.
4. **Invites**: inviting a teammate happens in auth-brain's portal today; framer-clone needs at least
   a link to it from the project, better an invite form calling auth-brain. 1 to 3 days depending on
   what the portal offers.
5. **Delivery credentials** per site (point 2) and a settings page where the owner sees the delivery
   key, registers the webhook URL and the host URL for the hosted canvas. 2 days.

### Recommendation

Do the auth-brain setup only when a BusBasis person will actually work in framer-clone. Build the
role split and image storage as part of points 1 and 2, because framer-clone's own customers need
them too.

**Effort: 1 to 2 weeks** (mostly image storage, the role split and the settings page).

## Relation to the Puck plan, and its blocks as first code components

**The Puck plan is not reopened by this research.** It delivers the BusBasis team's actual need
(content editing inside the existing design) in about two weeks, keeps the shop untouched, and none of
its choices block a later move. framer-clone needs 11 to 16 weeks to offer the same plus a real canvas.

**Its blocks are the natural first code components, and nearly free to bring over:**

- **Phase 0 is exactly the required refactor.** Sections that take all their content as props, with
  no data lookups for content, are what a code component must be. framer-clone would register the
  same React components; nothing in them changes.
- **The zod block schemas translate to controls.** Each field becomes a control: a `{ de, en }` string
  becomes `localizedText`, an object with `src`, `alt`, `decorative` becomes `image`, a `{ x, y }`
  focal point becomes a focal-point control (framer-clone's Image section already has one), an array of
  team members becomes a `list`, an enum of icons becomes `enum`. Doing this by hand is a day; a
  generator from zod (or from the Puck field config) is the better long-term route and fits the
  "Puck field importer" of point 1.
- **The documents map one to one.** Puck's `{ root: { props }, content: [{ type, props: { id, ...
  } }] }` becomes a page whose `appComponentTree.children` are function nodes with `type` set to the
  block type (namespaced, for example `busbasis/Team`) and `props` set to the block's props;
  `root.props` (where the plan keeps the hero) becomes page-level props or a first block. A migration
  is a `transformProps`-style script over the stored revisions, not a rewrite.
- **Storage moves, rendering stays.** On a switch, documents move from Medusa's `site_page` and
  `site_page_revision` tables to framer-clone's revisions, and the storefront's homepage changes one
  fetch (from the Medusa store route to framer-clone's delivery API, through `toPuckData` if its Puck
  renderer is kept).

What would make a later move even cheaper, should the other session want it (not requested of it,
MedusaJS untouched here): keep block type names and `schemaVersion` stable, keep every content field
inside block props rather than in component code, and keep images as URLs plus alt text rather than
Medusa file ids.

## Decided while researching (say so if you disagree)

1. **The Puck plan stands** for BusBasis; this document does not reopen it.
2. **Code component identity** is a function node whose `type` is a namespaced component id; registry
   presets also store their registry id. Free-form styling does not apply to code components; they
   get a generated property form plus page-level structure editing.
3. **The control schema** is the ArboSano schema plus `localizedText`, `object` and `slot`, kept as
   plain serialisable data, with an importer for Puck field definitions rather than adopting Puck's
   config format.
4. **The canvas approach** for foreign components is the app-host iframe. Bundling into framer-clone
   and module federation are ruled out by the Next.js and Tailwind version split.
5. **Delivery** reads only an immutable published revision, is called server to server with an
   auth-brain service-account key (no new key system, no CORS until a browser needs it), and
   invalidates the consumer through a signed webhook.
6. **The published copy is built first and on its own**, because saved-but-unpublished edits reach
   visitors today whenever the per-process site cache misses. It has its own roadmap line.

## Open question for Marlin

**Is "edit a frontend framer-clone does not host" a product direction?** That is the Plasmic and
Builder.io market, which earlier plans treated as a different market
(`docs/plans/2026-05-05-cms-data-layer-research.md`). If yes, the hosted canvas (point 3) gets a plan
and BusBasis is its first customer once the Puck editor has run for a while. If no, framer-clone stops
after points 1 and 2 (code components and delivery, both useful for its own sites), and BusBasis stays
on Puck for good.

## Reality

- 2026-10-26: research written from the code on `origin/main` (`79719bb`) and the storefront's
  `main`, with the Puck Phase 0 worktree read as a snapshot. No implementation.
