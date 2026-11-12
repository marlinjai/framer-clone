# Roadmap

framer-clone is Lumitra's hosted website builder (a Framer-style visual editor plus hosting
platform; live demo at app.lumitra.co). Dormant since 2026-08-16 (no commits since); this file was
last reconciled 2026-09-10 by work-down session 9b of the one-home-per-open-item plan
(`knowledge-base/plans/2026-09-07-one-home-per-open-item.md`), which read every non-terminal plan
against the code on main and either marked it completed/archived with evidence or kept it here as
an open line. `docs/specs/build-2026-06/ROADMAP.md` is a separate, spec-era index for that one
build wave and stays outside this file's scope (`type: roadmap`, exempt from the plan-status rule).

## Open

- [ ] Dependabot alerts left after the dependency security fleet of 2026-11-08 (Zod 4.6.7, Kysely 0.28 and the in-range refresh), none dismissed, each checked for reachability: kysely 0.27.6 inside `@marlinjai/contacts-core` 0.3.0 (alerts 1, 2, 3, 7, 8 and 33; contacts-core declares `^0.27.4`, its fix to `^0.28.17` is merged on the contacts repository's main as #11 but not yet on npm, so take the next contacts-core release here; until then unreachable: contacts-core uses only the Postgres dialect and parameterised `sql` templates, never `sql.lit` or the JSON path builders the advisories are about); postcss 8.4.31 pinned by Next 15.5 (alerts 27, 71, 76 and 81; build time only, over the app's own stylesheets; clears with Next 16); deepmerge-ts 7.1.5 pinned by prisma 6.19.3's configuration loader (alert 106; the development command line only, merging the repository's own configuration, never self-referencing objects; clears with Prisma 7); minimatch 10.2.6 under typescript-eslint 8.72.1 and testcontainers' archiver 8 (alert 187; development only, both parents declare `^10.2.2` and are on their latest release); postcss-selector-parser 6.0.10 pinned exactly by `@tailwindcss/typography` 0.5.20 through clearify (alert 174; the docs build only). (2026-11-08)
- [ ] Company erasure consumer: `POST /api/internal/erasure` deletes every row and file of a company auth-brain erases (sites, CMS, and its rows in the tenant schemas shared by its group, issued invoices included through an owner-only bypass; form submissions by workspace, never by dropping the schema). Left: merge, deploy, set `SITES_ERASURE_WEBHOOK_SECRET` in Infisical, restart the app to load it and register the endpoint in auth-brain. See [plan](docs/plans/2026-11-05-company-erasure-consumer.md). (2026-11-05)
- [ ] Editor autosave: the working copy saves by itself about 1.5 s after the last change and right away after a generated page, with the version lock, backoff on passing failures and a warning before unloading unsaved work; no Save button (a save status in the top bar, Cmd/Ctrl+S saves at once). Built on `feat/editor-autosave`; left: merge, deploy and the browser check on app.lumitra.co. See [plan](docs/plans/2026-11-04-editor-autosave.md). (2026-11-04)
- [ ] Builder UX gaps: reusable components built from primitives (saved once, changed once, placed many times, with a small form for the fields each placement can set), a navbar component with editable links, theme colours and fonts, and marketing section components (hero, features, pricing, testimonials). Theme tokens T1 to T5 (T5, 2026-11-12: the generator uses and adds site tokens, one undo step) and the head-item model H1 are built (H1, 2026-11-12: `HeadItem`, `parseHeadItem`, both homes, the merge, `ogType`, `updateSiteHead`, nothing emitted yet); head emission H2, the head panel H3, and the theme in the React importer T6 are open, see the [theme and head plan](docs/plans/2026-11-02-theme-and-head.md). These are what stops a non-developer from building a real marketing site in the editor today. This replaces "typed property controls": those were mainly justified by outside React components, and sites are built from our own primitives. Designed in the [complete primitives plan](docs/plans/2026-11-01-complete-primitives.md); the archived ArboSano builder plan of 2026-06-26 (under docs/specs, sections 1 to 3) has the component inventory to start from. (2026-11-12)
- [ ] Editor history leaves no page selected: after Undo of a page addition, Redo restores the page (and, for a generation, its theme tokens) but the editor shows "No page selected" until the page is opened in the Pages panel. Reproduced 2026-11-12 on a plain Add page, Undo, Redo, with no generation involved, so it is the history store's, not slice T5's. Draft plan awaiting a decision, nothing built: [which page is open after Undo and Redo](docs/plans/2026-11-12-history-page-selection.md) (option B recommended: a fallback page plus opening the page a history step restores). (2026-11-12)
- [ ] Site save fails with a serialization conflict because of other sites' saves: `saveProject` ran SERIALIZABLE with four immediate retries, and PostgreSQL's predicate locks made saves of different sites conflict (6 of 6 saves of 100 pages and 4 of 6 saves of 3 pages failed beside six other writers, none alone). First seen as the red `verify` of pull request 390. Approved 2026-11-12 (option A): the save locks the site and runs at read committed; built, in review, then 390 is rebased and driven once. Branch update and merge stay serializable (branch owner). See [plan](docs/plans/2026-11-12-save-serializable-contention.md). (2026-11-12)
- [ ] Complete primitives: measure what framer-clone can express against HTML, CSS and JavaScript with a coverage matrix, a parity corpus of real components and a JSX round trip, then close the gaps: CSS that needs a selector (states, keyframes, container queries), behaviour primitives (accordion, tabs, dialog, carousel, menu) and developer import of React components by converting them to primitives. Behaviour cannot be a closed list, so custom code on customer sites is allowed, sandboxed and off by default. Decided 2026-11-01: this comes before moving BusBasis. The measurement exists: `pnpm score:primitives` writes [the score](docs/primitives-score/latest.md); the gaps it names are what is left. Step 2, text mixed with elements, is done as `#text` nodes. See [plan](docs/plans/2026-11-01-complete-primitives.md). (2026-11-01)
- [ ] SVG controls: paste or upload an SVG (Scalable Vector Graphics) file as real nodes, sanitised through the generation validator and the render gate, every path in the Layers panel, fill, stroke, caps, joins, opacity and aspect as panel controls that follow states and theme tokens, a Lucide icon picker, and the same insertion for the AI generator and the agent plugin. Closes 452 of the 610 misses in the score's panel column (SVG at 0 of 388 today). Eleven slices, about 22 to 28 agent days, no decision left for Marlin. See [plan](docs/plans/2026-11-02-svg-controls.md). (2026-11-02)
- [ ] A net-priced order whose hosted Stripe checkout is left open across a company's tax status change ends paid with `TOTALS_MISMATCH` (a dead receipt job the owner sees on the payments page, no invoice until handled). The first half of the #211 review finding (`TAX_IDENTITY_MISMATCH` for a buyer sharing a customer's name) is fixed: the receipt draft stores the buyer's tax country (#274). The complete fix is the plan's rule that a receipt keeps the order's tax profile (backbone B14). See [plan](docs/plans/2026-11-02-shop-backbone.md). (2026-11-08)
- [ ] Enforcing the Content Security Policy on published pages: report-only is live. Marlin decided on 2026-11-02 to review the reports after a week of real traffic, so the review is due 2026-11-09; enforcing closes the conditional request routes in `docs/plans/2026-11-02-selector-styling.md` but breaks hot-linked images. (2026-11-02)
- [ ] 3D scene primitive: a `scene` node that describes a three.js scene as data (models from a site model library in Storage Brain, material roles and curated presets such as wash bay foam, camera keyframes, a timeline driven by scroll progress, time or page state, a required poster), loaded as a lazy island only where a scene is on the page, so pages like the Grothe truck wash hero need no code. Decided, 11 slices; quotas (D1) answered by Marlin on 2026-11-02: the defaults, included in every plan until pricing is decided. Measured locally against the same scene as a sandboxed custom code block. See [plan](docs/plans/2026-11-02-3d-scene-primitive.md). (2026-11-02)
- [ ] Lumitra FX in Sites: decided by Marlin on 2026-11-08 that Lumitra FX, the owned WebGL effects engine behind the lumitra.co hero (today the private package `@lumitra-web/fx` in lumitra-web), belongs in Lumitra Sites; this supersedes the 2026-06-27 plan to move it into the lumitra-studio monorepo. Marlin approved the plan on 2026-11-11 and the build started: copy it into `src/lib/fx/`, an "FX scene" node rendered by a lazy island, panel controls generated from its parameter schema in place of leva, AI and agent plugin support, a pixel comparison against lumitra.co; eight slices, about 17 to 24 agent days. F1 (the engine copied in behind an import guard, leva and drei left out) merged as #365; F2 (the stored scene format and its safety checks, a render-free half of the engine) merged as #368; F3 (published pages draw a scene through a lazy island, with fallbacks, a bundle budget and a flash check) merged as #369; F4 (the pixel comparison with the engine as lumitra-web runs it: 0 pixels differ on the hub hero and two presets, held by the score) merged as #373; F5 (the editor: the palette entry, the FX section of the properties panel with controls generated from each layer's schema, the scene drawn live on the canvas in one breakpoint at a time, the preview started as the published page starts it, never more than one WebGL context) merged as #378; F6 (the page generator and the agent's site operations write a scene through one checked reader: presets recoloured and retuned inside their ranges, never a new layer, a new `setFxScene` operation, a foreign picture address refused) merged as #383. F1 to F6 are on main and none of it is deployed (the last production deploy is from 2026-11-09). Next: F7 (deploy to app.lumitra.co and the browser proof on a sites.lumitra.co test page), which waits for Marlin's yes to the deploy; then F8 (the hub hero rebuilt in Sites). lumitra.co and services.lumitra.co stay on lumitra-web until Marlin approves each move. Decided by Marlin on 2026-11-08 (option B): services.lumitra.co is rebuilt in Sites too and lumitra-web is retired, steps R1 to R6, which also carry lumitra-web's open services copy and booking items; changed by Marlin on 2026-11-12: services becomes a `/services` area of the one Lumitra site (not a second site), and services.lumitra.co later redirects there. See [plan](docs/plans/2026-11-08-lumitra-fx-in-sites.md). (2026-11-12)
- [ ] Sandboxed custom code: Marlin accepted the review's defaults for M1 to M10 on 2026-11-02 (see the [sandboxed custom code plan](docs/plans/2026-11-02-sandboxed-custom-code.md)). On 2026-11-02 he also answered M2 (`lumitrausercontent.com`, registered 2026-11-02 through Lumitra Mail at Cloudflare Registrar, zone in Lumitra's Cloudflare account, no records yet; slice O1 can start), M10 (the default contacts and one working day takedown) and the widening M11 to M15 (yes; M13 if its probe holds), so slice C8 is in scope. Still before slice C7, the switch-on: a lawyer's reading of the consent wording (M9). (2026-11-02)
- [ ] Erase personal data from old published revisions: Marlin decided on 2026-11-02 to build an erase tool, since up to 30 kept revisions hold data removed from a page. It builds on the immutable published copy (#226) and gets a GDPR review before business customers use it. (2026-11-02)
- [x] Designable shop controls: every button, field, label and message of the checkout, add to cart, the cart and the variant selector becomes a real node with a role marker that the island reads, so styles, states, theme tokens, text (German labels) and Layers work as for any element, and the canvas previews each state with sample data. All three slices are merged and deployed: the checkout (#323), add to cart and the cart (#324), and the variant selector (#325, 2026-11-04). The locked final pay step of the plan's section 5 stays open on its own line below. See [plan](docs/plans/2026-11-02-designable-shop-controls.md). (2026-11-08)
- [ ] Locked final pay step (the Shopify model): before live payments, the platform draws the checkout's final pay step itself as a modal in the top layer, in an isolated layer no page style reaches, styled only through a few design tokens (button and text colour, corner radius, the site's font), so the total, the demo or test notice and the fixed pay wording are guaranteed even against a site's author who sets out to deceive. Decided by Marlin on 2026-11-03: the designable controls guard against accidents now, this comes with live payments. See section 5 of the [plan](docs/plans/2026-11-02-designable-shop-controls.md). (2026-11-03)
- [ ] Map embeds on published sites (BusBasis home has a Google Maps iframe, refused by the render gate): Marlin's call between an approved provider list that loads only after consent behind a click-to-load placeholder (recommended) and a static map image with a link. (2026-11-02)
- [ ] Protect main: there is no branch protection or ruleset on `main` (checked 2026-11-02), so "every main commit passed CI", which `deploy.yml` relies on, holds only because land-pr merges on green. Require the CI checks before merge and block direct pushes, allowing the score report workflow (`score.yml`, from #292) to push, and correct the comment in `deploy.yml`. (2026-11-02)
- [ ] Reusable component definitions that fail to load are dropped on the next Save, after a publish warning: close to silent data loss, decide in a later slice of the [plan](docs/plans/2026-11-02-reusable-components.md). (2026-11-02)
- [ ] Agent fleet: about 70 slices across a bug lane, the primitive stream and the shop stream, four to eight workers on hermes, approved 2026-11-01. See [plan](docs/plans/2026-11-01-agent-fleet.md). (2026-11-01)
- [ ] German VAT rules for the shop: Germany only at launch, foreign VAT ids and addresses refused at checkout, receipt at dispatch, per-rate tax, decided 2026-11-01 without a tax adviser. See [plan](docs/plans/2026-11-01-german-vat-research.md). (2026-11-01)
- [ ] Shop capabilities from the Medusa analysis: outbox and jobs on Postgres, Stripe reconciliation, a server-side checkout record, then shipping, order list and fulfilment, discounts, refunds, light returns, payment methods, accounts and search, in the agent fleet's shop stream. The analysis is done; BusBasis may stay on Medusa long term. See [plan](docs/plans/2026-11-01-medusa-architecture-analysis.md). (2026-11-01)
- [x] Visual editing of an existing Next.js frontend: researched 2026-10-26, about 11 to 16 weeks, and rejected by Marlin on 2026-11-01: framer-clone does not edit frontends it does not host. See [research](docs/plans/2026-10-26-external-frontend-visual-editing-research.md). (2026-11-01)
- [ ] BusBasis expressed fully in framer-clone: the site served by framer-clone, the shop on its own commerce engine, Medusa retired, about 19 to 27 agent weeks. Most of the gap list is ordinary shop capability (shopper accounts, shipping, discounts, order list, categories, search, quotes). Whether and when BusBasis moves is Marlin's call; until then it stays on Medusa with its Puck editor. See [plan](docs/plans/2026-11-01-busbasis-native-storefront.md). (2026-11-01)
- [ ] An immutable published copy of each page: today save and publish write the same `site_pages` rows, so after a cache miss (restart, deploy, second replica) visitors see the last save instead of the last publish. Publish should write a revision that the public site reads, which also gives history and restore. Found by the external frontend research. (2026-11-01)
- [ ] Lumitra Sites agent plugin: an MCP endpoint at app.lumitra.co/api/mcp and a lumitra-sites plugin so an agent can read, build, edit and publish sites with a company API key (sites grant); version lock first, then the machine door, site operations, the endpoint, the plugin, and building the new lumitra.co through it. Approved 2026-11-02. The plugin package now preserves existing site themes, validates credential references and checks mirror synchronization failures; public mirror setup and building lumitra.co remain open; the new lumitra.co is being built on the site branch "Test new design" (hub sections, footer, hero, and services.lumitra.co as `/services`, decided by Marlin 2026-11-12), its merge and publish are Marlin's. See [plan](docs/plans/2026-11-02-lumitra-sites-agent-plugin.md). (2026-11-12)
- [x] Lumitra Sites MCP, a `deletePage` batch operation: an agent can remove a page it created (or any page but the home page and the last page, the editor's own rules), audited and under the version lock, with the links that still lead to it counted in the answer; tool descriptions, vocabulary and the edit-a-site skill updated (plugin 0.3.0). See [plan](docs/plans/2026-11-02-lumitra-sites-agent-plugin.md). (2026-11-09)
- [ ] claude.ai and Claude Desktop connectors for Lumitra Sites: OAuth sign-in on /api/mcp (MCP authorization spec), needs protected-resource metadata in framer-clone and dynamic client registration in auth-brain. Today only clients that send a company API key as a bearer header connect. See [plan](docs/plans/2026-11-02-lumitra-sites-agent-plugin.md). (2026-11-03)
- [ ] AI-driven page generation: let AI agents write pages directly as MST (MobX-State-Tree, the
  in-memory tree that backs the editor) snapshot JSON, so the data format is the API. Decided and
  in progress since 2026-10-19: phases 1 to 3 (registry-generated schema docs with validation, the
  guarded `/api/ai/generate-page` route, the editor's "Generate page" dialog with undo) shipped;
  real Unsplash stock photos instead of the placeholder and a Fast / Balanced / Best model slider
  (dialog and CMS agent) live since 2026-10-20 (#112, verified on app.lumitra.co: 4 photos from
  images.unsplash.com with credits in the canvas and on the published page). Since 2026-10-23 the
  prompt carries a design brief distilled from the design skills, containers can hold a stock
  photo behind text under a scrim, every stock photo is cropped around its subject (a Haiku vision
  pass), and the properties panel has an Image section for fit, focal point and photo backgrounds
  (done, recorded in the 2026-10-23 design quality plan linked from the plan below). Since
  2026-10-29 a generation (and the layout review) keeps running when the phone switches apps and
  is collected when the editor comes back, even after iOS reloaded the tab (proven with a reload in the
  browser; a real iPhone app switch is still Marlin's own check). Phase 4's style references
  and screenshot loop stay open. See [plan](docs/plans/ai-driven-page-generation.md). (2026-11-01)
- [ ] AI page generation, ideas and streaming: an idea row in the Generate dialog (static ideas at
  once, then six tailored to the site by Haiku) and an Enhance button that streams a structured
  rewrite of the brief with one-step undo (pull request 1, merged 2026-11-04 as #327),
  then a page that builds itself section by section on the canvas as a detached draft that never
  enters the project tree, still one undo step (pull request 2). See
  [plan](docs/plans/2026-11-04-page-generator-ideas-and-streaming.md). (2026-11-04)
- [x] Live agent canvas: watch an agent build a site in the open editor, as Paper does with its Model Context Protocol (MCP) server. A per-site server-sent events stream makes the editor follow every write (adopted as one undo step labelled by the agent), a blue frame and label show the section the agent works on with an activity feed, a new `announce_sections` tool draws skeletons of planned sections, and new nodes reveal element by element with a short client-side stagger; in-editor Generate gets an outline first so it draws skeletons too, and the MCP `generate_page` streams its draft to open editors. Six slices, about 14 to 17 agent days; approved 2026-11-08, slice 1 (live sync core) shipped and proven on production (#336), slice 2 (presence and activity feed) shipped (#337), slice 3 (per-component reveal) shipped (#338), slice 4 (MCP skeletons: `announce_sections`, `clear_sections`, the skeleton layer and the plugin skill) shipped (#343), slice 5 (Generate outline skeletons: the outline first in the emit tool, skeletons in the Generate draft) shipped (#344), slice 6 (the MCP `generate_page` streams its draft to open editors) shipped (#346, #349), and a deletePage operation added (#347). Completed 2026-11-09: a whole-feature review by four fresh reviewers was fixed in #350 (server), #351 and #355 (presentation), #353 and #356 (editor sync), with #354 for test isolation, and an end-to-end proof on app.lumitra.co passed (an agent write shows in about 100 ms, typing survives an agent write, a dropped stream recovers in about 5 s). See [plan](docs/plans/2026-11-08-live-agent-canvas.md). (2026-11-09)
- [ ] Site branches: a branch is a copy of a whole site's working copy that a person or an agent changes without touching main, reviewed as a change list and a side-by-side view, then merged into main by a node-level three-way merge whose conflicts are settled on the branch; modelled on Framer's branching. A branch is a hidden site row, so the editor, autosave, the version lock, the live stream and the Model Context Protocol (MCP) tools work on it unchanged, and it can never be published. Approved by Marlin on 2026-11-11 with all four recommendations (no tier logic, no forced second approval, a public preview link as S8, the Content Management System (CMS) not branched). Nine slices. S1 to S8 are merged: the data model and the per-company switch `SITE_BRANCHES_COMPANIES` (#360), the merge engine (#361), the review and merge routes (#366), branches in the editor (#367), the review page (#371), the agent tools and plugin 0.4.0 (#372), undo of the latest merge for 30 days (#374), and the public preview link `preview-<token>.sites.lumitra.co` (#376). Three whole-feature reviews (isolation and security; data integrity and flows; usability, accessibility and performance) ran on 2026-11-12 and found no code blocker for one company; their findings are fixed on `feat/site-branches-s9` with a fourth additive migration (plan decisions 86 to 97). Live since 2026-11-12: with Marlin's approval, production was deployed at commit `b1e19a32` (six additive migrations, rehearsed on a restored copy first) and site branches were switched on for the Lumitra company only; the browser proof passed in every step that could be run, including the agent's steps (plan section 12, "The deploy and the proof as run"). Open: (1) the approve and decline halves of proof step 7, which need Marlin's fresh sign-in in the automation browser (the agent's branch "Proof B" is left open on the draft site "Branch proof 2026-11-12" for it); (2) the review-only half of step 8, only with a temporary viewer account of Marlin's own; (3) a finding from the proof, fixed in code (decision 99) and waiting for the next authorized deploy: with the switch off, the agent tool `get_site` still read an open branch by its id while the editor answers 404. See [plan](docs/plans/2026-11-10-site-branches.md). (2026-11-12)
- [x] Editor top bar, cramped while an agent writes: seen on production on 2026-11-12 at about 1680px on a site branch, the agent's note was drawn over the save status and the page name was cut short. The agent note is now a compact chip ("Agent editing", the full sentence in a tooltip that keyboard focus opens too, a press opens the Agent activity feed) in a slot of its own beside the save status, and from 1024px up the bar measures what it holds and folds in a fixed order (the words of Generate, Polish, Share preview and Review and merge; then the page name; then the secondary icons into More), never squeezing undo, redo, preview, the status or the chip. See [plan](docs/plans/2026-11-12-top-bar-fold.md). (2026-11-12)
- [ ] A cookie of another Lumitra application is readable by every site under `sites.lumitra.co`: seen on 2026-11-12 in the automation browser on a branch preview host, `document.cookie` held one cookie, a PostHog one named `ph_phc_<project key>_posthog` (about 300 characters), which is not `HttpOnly` and is scoped to the whole `lumitra.co` domain. Sites did not set it (a preview loads no analytics, and no `posthog.init` is in this repository); which application sets it was not seen and is not known. Any customer's site hosted under `sites.lumitra.co` can read it with its own script, and the browser sends it with every request to such a site. To do: find the setter (a search of the other Lumitra applications for PostHog with a cookie domain of `.lumitra.co`), and either scope that cookie to its own host or move hosted sites to a domain that is not under `lumitra.co`. (2026-11-12)
- [ ] The deploy workflow no longer deploys: since 2026-11-12 the shared `coolify-deploy-verify` workflow (repository `actions-shared`, tag `v1`) calls the Coolify webhook with GET and gets HTTP 405, so `.github/workflows/deploy.yml` builds and pushes the image and then fails before any deployment starts. The release of 2026-11-12 was started through the Coolify API instead (`deploy/README.md`, "Releasing"). The same step broke the receipts release that day, so the fix belongs in `actions-shared` (send the request the way Coolify 4.7 expects, and keep the deployment-status check); this repository then needs nothing but a run to confirm. (2026-11-12)
- [x] Top bar of the unsaved demo editor at about 1,024 pixels: the "Keep as project" button lay over Publish, Domains and Site settings. Fixed by the measured fold of the top bar, which folds for the demo status like for anything else the bar holds; the demo is now in the geometry proof of `test/behaviour/branches.spec.ts` at 1024 and 1280 pixels ([plan](docs/plans/2026-11-12-top-bar-fold.md)). (2026-11-12)
- [ ] Live replay of a settled edit on top of an agent's write, instead of the Site Changed dialog, where the edit only replaced values of nodes the agent left alone. Built in #353 and taken out after four review rounds; rebuilt and merged on 2026-11-10 as #358 (edits made while the agent's copy was held, the refusal-first ordering, Cmd+S right after typing, a dialog gate). A production proof on 2026-11-12 found the most common ordering still asked (a committed edit whose save waits or is out when the agent writes): extended on branch `fix/replay-unmarked-409` to that edit (all the person's unsaved steps since the last saved copy, or none) and the status no longer flashes the conflict while a replay resolves it; in review. Open after the merge: the proof on production with the next release. See [plan](docs/plans/2026-11-09-live-replay-on-top.md). (2026-11-12)
- [x] Live agent canvas, the first adoption in an open editor is slow: measured on 2026-11-08 on app.lumitra.co, every adopted agent write held the page for 2 to 5 s on a heavily loaded machine. Split and cut on 2026-11-09 with a measurement harness (`src/lib/projects/__tests__/adoption.perf.test.ts` for the store, `src/components/__tests__/adoptionRender.perf.test.tsx` for the canvas render). The cause was that every adoption replaced every node's props and bindings (the snapshot route delivers new objects), so a one-node write emitted 887 patches on a 400-node site, made an undo entry the size of the document and re-rendered every node. Now the incoming copy reuses the open copy's objects wherever the content is equal, only changed pages and parts are reconciled, and the no-op check and the created and changed diff no longer serialise the site twice: in Node a one-node adoption went from 150 ms (first) and 130 ms (later) to 35 ms and 13 ms, 887 patches to 1, and in the canvas render (jsdom, React Profiler) from 34 ms re-rendered (29% of the page) to 1 ms (1%). Not re-taken in a browser on production (no deploy in that change): to be re-checked with a real agent write in the end-to-end proof after the deploy. See [plan](docs/plans/2026-11-08-live-agent-canvas.md). (2026-11-09)
- [x] Motion and effects: an Effects section in the properties panel (appear on scroll, restrained
  hover states, light scroll-linked transforms such as a small image parallax), stored per
  breakpoint like any style, undoable and generatable by the AI, rendered on published pages with
  CSS plus an IntersectionObserver or Motion (MIT). The canvas shows the final state with an effect
  badge and a play control, the preview plays everything. Follows the motion rules: entrances
  under 300ms, ease-out, nothing perpetual, off under prefers-reduced-motion. Plus an optional
  per-site Lenis (MIT) smooth-scroll toggle, off by default and off under reduced motion. Decided
  by Marlin on 2026-10-23; built 2026-10-24 (Effects section, canvas badge and Play, preview and
  published runtime, Lenis switch in Site settings, sparing appear effects in the generator). See
  [plan](docs/plans/2026-10-23-motion-effects.md). (2026-10-24)
- [x] The editor on phones: below 768px wide (or a phone held sideways) the canvas fills the screen
  between a compact top bar and a bottom bar, Pages and Layers and the properties panel open as
  bottom sheets, every top-bar action stays reachable through a More menu, dialogs and the preview
  fit 390px, components are added with a tap; and the canvas works by touch (two fingers pan and
  pinch-zoom on the canvas only, one finger taps, moves the selection, draws the selection
  rectangle and double-taps to edit text, finger-sized handles, no browser page zoom inside the
  editor, published sites keep it). Asked by Marlin on 2026-10-24 after the editor proved unusable
  at 390px; both parts built 2026-10-24. Then a floating glass quick toolbar next to the
  selection, a long-press menu with slide-to-select, peek and full detents for the properties
  sheet, and haptic ticks (2026-10-25). See [plan](docs/plans/2026-10-24-editor-on-phones.md). (2026-10-25)
- [ ] Scroll-driven page type (later): an opt-in page type for scrollytelling pages, the only place
  GSAP ScrollTrigger pinning and scrubbing is used, because there the scroll is the requested
  interaction (the sanctioned exception to the scroll-jacking rule, as the scroll-craft skill
  defines it). Not a general editor feature. Needs a plan. (2026-10-23)
- [x] Published site essentials, the rest of the owner's 19-point checklist of 2026-10-23. Built by
  2026-10-24 (plan sections "as built"): Site settings, lang, favicon set, Open Graph defaults, title
  template, robots.txt, sitemap.xml, canonical, noindex, JSON-LD, the designable 404 page, loading
  states, forms with a thank-you page, Impressum, privacy and terms templates, the publish warning
  for a missing Impressum, the first-party consent banner that loads analytics only after consent,
  and decision 7 of the generator: a primary call to action in the hero of every new marketing page
  and meaningful alt texts as repair findings (no silent "Image" fallback; an alt field with a
  Decorative switch and a warning in the Image section), plus the sticky mobile call to action
  component. Form notification emails stay open on their own line below. See
  [plan](docs/plans/2026-10-23-published-site-essentials.md). (2026-10-24)
- [ ] Form notification emails: forms (built 2026-10-24, see the site essentials plan, decision 4)
  store submissions per company and show them in the editor's inbox, but framer-clone has no mail
  path, so the owner is not emailed about a new submission. Wire Lumitra Mail (the suite's mail
  service) as the sender: a notification address per form defaulting to the site's contact email,
  sent after the submission is stored, a failure logged and shown in the inbox, never losing the
  submission. (2026-10-24)
- [ ] Animated components, a few chosen ones: React Bits was checked on 2026-10-23 and is MIT plus
  Commons Clause, which forbids redistributing its components "alone, in a bundle, or as a ported
  version", so a builder that offers them to its customers cannot ship them. Instead build the
  few worth having ourselves (a text reveal, a marquee, a logo loop) or take them from MIT sources
  (Magic UI, Motion), avoiding the vibe-coded tells in the round 2 plan
  (docs/plans/2026-10-23-ai-design-quality-round-2.md). (2026-10-23)
- [x] Custom domains (Option B): a site owner connects their own domain to a published site
  (TXT ownership check, per-domain Let's Encrypt certificates through Traefik's file provider,
  a Domains panel in the editor; code in #103). Live since 2026-10-20: `domains.lumitra.co`
  (DNS only, IPv4 only) is the CNAME target, the `CUSTOM_DOMAIN_*` values are set, and the sync
  and re-check timers run on the shared server. Proven end to end with
  `fc-cd-test.marlinjai.com`: verified in the Domains panel, route written within a minute, Let's
  Encrypt certificate, `HTTP/2 200` with the site's page, `active` in the panel; then
  disconnected, its records deleted and the route gone again. The infra side is recorded in
  infra's deployments/framer-clone/RUNBOOK.md, phase 4. See
  [plan](docs/plans/2026-06-25-framer-custom-domains.md). Done 2026-10-20.
Build order decided by Marlin on 2026-10-15: finish the per-company schemas, get the app running
again, then the invoicing tier on top, then the import of the existing invoices and the
connections to the suite. The four lines below are in that order.

- [x] 1. Commerce per company (step MT-18 of the multi-tenancy plan, carried out as the commerce
  tenant plan): every company's shop data lives in its own `tg_<hex32>` Postgres schema on
  auth-brain tenant groups, every shop page and route reads only that schema and fails closed
  without one (CM-10, #92), the tenant isolation guards run in CI as `pnpm lint:guards`, and
  Prisma is out of the commerce module with its test coverage ported (CM-13), including a fix
  that keeps orders, credit notes and stock movements append-only for the app role. See
  [commerce tenant plan](docs/plans/2026-06-27-commerce-tenant-db-migration-plan.md). Done
  2026-10-17.
- [x] 2. Running again: live since 2026-10-19 (new Coolify app and database with daily backups,
  editor on app.lumitra.co, published sites on <label>.sites.lumitra.co with a DNS-01 wildcard
  certificate, hardened commerce roles, demo seeded, test order placed). The empty legacy
  `commerce` schema was dropped (0 rows, structure saved on the server), and a project was
  created, published and opened at its new address in the browser, then removed. The infra side
  is recorded in infra's deployments/framer-clone/RUNBOOK.md. Done 2026-10-19.
- [ ] 3. The Books: the Customer + SalesDocument + DocumentTemplate document tier for Marlin's own
  accounting (invoices and credit notes now, offers later; joins with receipt-ocr-app's expense
  side), in each company's own schema. Built: phase 1 (2026-10-17, the document domain, migration
  `007_books`), phase 2 (2026-10-20, the `/api/books` routes behind the active company, the
  auth-brain app grant `books` and the workspace admin role, and the Books area in the editor:
  customers, documents, the document editor with issue on confirmation) and phase 3 (2026-10-20,
  templates, the PDF rendered with pdf-lib from the frozen snapshots, checked for the section 34a
  UStDV and section 14 (4) UStG fields and stored once in `sales_document_file`, migration
  `008_books_files`, download from the editor). The operator steps are done: the Books are live
  for Whiz-Art Media (app grant, contacts database, `008`, the company set up), checked
  2026-10-28 in the live editor: invoices 1 to 63 listed, counter at 64. Open: the first real
  invoice from the editor (Nr. 64) closes this line. See
  [plan](docs/plans/2026-08-15-books-receipts-invoices-integration.md), sections "Phase 1 build
  specification" and "Phase 2 and 3 build notes (2026-10-20)". (2026-10-28)
- [x] 3b. The invoice editor in the app's editor shell (PR #164, the glass redesign of the invoice
  editor and template composer): deployed (deploy run 40202044416) and proven live on the Books
  Testfirma company. Done 2026-10-25. See [plan](docs/plans/2026-10-25-books-invoice-editor-shell.md). (2026-10-26)
- [ ] 3c. One business platform: a company-level catalogue of products and services on the commerce
  engine (replacing the Books' own list), first proven on the owner's test jewellery shop (sample products,
  checkout through Stripe Connect in test mode, receipt in the Books), then instant booking for one
  practitioner (paid online, receipt in the Books), then quotes, then team dispatch; lumitra-booking's slot engine and calendar sync
  reused as packages. Architecture decided; the catalogue was built in slices (2026-10-26: slice 1, the
  company column, migration `020_catalogue_company` and `sites.company_id`). The catalogue and the test shop
  are built, deployed and proven on production as of 2026-10-27; open: instant booking, quotes, team dispatch.
  See [plan](docs/plans/2026-10-25-business-platform-architecture.md) and
  [catalogue design](docs/plans/2026-10-25-catalogue-design.md). (2026-11-01)
- [x] Abandoned checkouts can hold stock indefinitely: an order reserved stock and only the pay route ever released an expired hold, so the next buyer got a 409 and never reached that route. Reproduced by test and fixed on 2026-11-01: a new order closes its company's expired payments before it reserves (a failed sweep never fails the order), a scheduled sweep closes them across all companies, and two sweeps at once release once. A later Postgres job table may absorb the schedule, part of the job design in the Medusa analysis. (2026-11-01)
- [x] The expired payment timer is installed on `coolify-shared-host`, enabled every 5 minutes; its first run swept 4 tenant groups with 0 failed. Runbook updated in infra #92. Done 2026-11-01.
- [ ] Payment minimum in a foreign currency: the order route refuses a paid total below Stripe's minimum charge per currency (2026-11-04, #324), but Stripe applies the minimum of the shop's payout currency after conversion, so a shop charging in a currency other than its payout currency could pass the check and still be refused at payment. Needed once a shop charges outside its payout currency: read the connected account's default currency and convert before comparing. Today every shop charges EUR into EUR, where the check is exact. (2026-11-04)
- [ ] Live payments: the platform runs on Stripe sandbox keys. Going live means live keys and a real shop finishing Stripe onboarding, which is Marlin's yes because it moves real money; prepare a checklist and a rollback first. (2026-11-01)
- [x] A real product in the editor: a product page is a template, so the canvas and the preview now show the first catalogue product, with a small switcher in the editor and the preview toolbar, and a product link in the preview opens that product. The choice stays in the editor session. (2026-11-01)
- [x] 3f. Prove Stripe Connect against Stripe in test mode: open the Stripe account (test mode), paste the
  test secret key, the webhook signing secret and the Connect client id into the three placeholders in
  Infisical (project framer-clone), register the webhook endpoint `/api/payments/stripe/webhook` for
  connected accounts, then connect the test shop and pay with a test card. Built against a fake Stripe on
  2026-10-26; see [catalogue design](docs/plans/2026-10-25-catalogue-design.md), "Decided while building
  slice 5". Progress 2026-10-26: the sandbox "Lumitra Sites" in the Lumitra Stripe account has Connect
  (Standard accounts, OAuth) and the webhook; the three keys are in Infisical prod and dev; the test shop's
  Stripe account finished onboarding and reads "Ready". The test purchases passed on production on 2026-10-26 and 2026-10-27 (orders ORD-000001 to ORD-000006: paid, declined and retried, receipts issued, the 1% fee arrived). (2026-11-01)
- [x] 3g. Shop pages that link up: a Link component (its target checked as it is typed, or picked from the
  site's pages), and `{{product.href}}` in the binding picker inside a product list or detail, which links
  each product to the site's product page (`products/:handle`, `productPagePath` in `src/lib/pages/slug.ts`).
  Every bound link target passes `isSafeHref` (`src/lib/links/safeHref.ts`), so a CMS cell can never become
  a `javascript:` link; the canvas no longer navigates when a link is clicked, and the preview follows links
  to the site's fixed pages. The payments page says "test mode" while the platform runs on Stripe test keys,
  and the buyer's thank-you shows the order number and no longer promises an email. Found while building the
  test shop on 2026-10-26, built the same day. (2026-10-26)
- [ ] 3i. Contact person on a customer and on an invoice (the Books half of the contact affiliations plan in the contacts repository, the plan dated 2026-11-11 named contact affiliations, section 6): a business customer's people with their roles, a default per customer, "z. Hd. Name, Rolle" on the invoice (template block `attention`, off by default), frozen in the recipient snapshot version 2 at issue; migration `030_books_contact_person`. Built 2026-11-11 in the pull request that adds this line (needs `@marlinjai/contacts-core` 0.5.0, on npm). Left: deploy, which needs the shared contacts database at migration `0003` first (applied by the receipts app at its start), so it waits for the plan's production gate: a same-day verified backup, the dry run on a restored copy, Marlin's yes. Then prove it live on the Testfirma company without creating real data (read the customer screen and a draft's contact person select). (2026-11-11)
- [ ] 3h. Shop buyers with the same name share one contact and one Books customer: the shared contacts
  database's identity is the name (and company or role), so two different buyers called "Anna Müller" (or one
  buyer who moved) are linked to the same contact. Each receipt is made out correctly since 2026-10-27 (the
  order's own buyer details are frozen on it), but the customer list mixes their invoices. Needs a decision on
  the shared contact model (email as part of a person's identity, or a contact per buyer), which spans every
  app on the contacts database. Found in the receipt email test on 2026-10-27. (2026-10-27)
- [x] 3e. Customer email from the shop: an order confirmation with a link to the receipt, and the notice when a
  late payment had to be refunded, sent from the shop company's own Lumitra Mail workspace (framer-clone is
  Lumitra Mail's trusted application `sites`, email-editor pull request 176; framer-clone pull request 185).
  Plan [shop receipt email](docs/plans/2026-10-27-shop-receipt-email.md) : completed. Proven on production
  2026-10-27: the test company connected its workspace (sending domain testshop.lumitra.co), order ORD-000005
  paid through Stripe, the confirmation arrived in the buyer's inbox and its link served receipt RE-4. (2026-10-27)
- [ ] 3d. Deletable invoice drafts: a draft (no number, not a bookkeeping record) can be deleted with its
  lines and events (hard delete, no tombstone, migration relaxing the 007 guards for drafts only);
  issued documents stay undeletable. Reverses decision 8 of the Books integration plan for drafts
  only. Built on the owner's order of 2026-10-26 (migration `019_books_draft_delete`, the DELETE
  route, "Delete draft" in the editor's More menu); a draft that was issued once (an offer taken
  back) keeps its spent number and is not deletable. Open: roll `019` out with the next deploy.
  See [plan](docs/plans/2026-10-25-business-platform-architecture.md). (2026-10-26)
- [ ] 4. Existing invoices and the suite. The historical import is DONE: invoices 1 to 61 (the
  full series) were imported live on 2026-10-20 at 15:08 with `pnpm books:import` for Whiz-Art
  Media, 61 imported and 0 errors, the printed yearly totals matching the filed returns 2019 to
  2025, the invoice counter still at 62; checked in the live editor (61 documents numbered 1 to
  61, the PDFs of invoices 1, 23 and 60 byte-identical to the originals). Imports keep their
  printed currency (invoice 23 is in CHF, never converted). The read-only endpoint receipt-ocr-app
  pulls issued invoices from is built (2026-11-08): `GET /api/machine/books/documents`, behind the
  machine door of #316 (`/api/machine/*` is bearer only, like `/api/mcp`), a company API key of a
  service account scoped to the company, with the `books` app grant and a workspace admin role;
  issued invoices and credit notes only, in the fields the receipts parser reads, never a
  recipient (`src/server/books/machine.ts`, `repository/mirror.ts`). Open: storage-brain for the
  PDFs, the shared contacts database for recipients in production. See the Books plan's
  "Connections: the mirror endpoint (2026-11-08)" and "Historical import build notes
  (2026-10-20)". (2026-11-08)
- [x] 5. Importing past invoices by uploading PDFs in the Books: a company drops up to 50 invoice
  PDFs, Claude Sonnet 5.5 reads each one into the historical-import record, the user checks and
  corrects the rows in a review table beside the PDF, and confirmed rows import through the same
  core as `pnpm books:import` (original PDF as the document of record, counter raised upwards
  only). Built 2026-10-20 (migration `010_books_upload_import`). First real upload proven
  2026-10-28 for Whiz-Art Media: invoices 62 (BCB GmbH, 750 €) and 63 (Schönlau & Rudolph
  GbR, 387 €) read correctly, imported with "Import all ready", counter raised to 64, the
  original PDF downloadable from the document. Done 2026-10-28. See
  [plan](docs/plans/2026-10-20-books-upload-import.md), "Build notes".
- [x] 5b. The import page kept showing the old "Next invoice number" in its header after an
  import raised the counter (showed 62 after the 2026-10-28 import set it to 64). The header now
  moves with every raise the import reports, never down; covered by the single-row and the
  "Import all ready" tests. Done 2026-10-28.
- [ ] 6. Domestic reverse charge (section 13b UStG) for Books documents and the import, when a
  company needs it. Not supported now (lead's decision of 2026-10-20): the Books cannot issue such
  documents, so the import refuses them too (`reverse_charge_domestic`, the row says to keep the
  invoice outside the Books); Whiz-Art Media is never affected (section 13b does not apply to a
  small-business supplier). See [plan](docs/plans/2026-10-20-books-upload-import.md), Build notes
  item 15. (2026-10-20)
- [ ] 7. Production on Node 24 before Node 22 leaves support (2027-04-30): the Dockerfile's
  NODE_IMAGE, `.nvmrc`, package.json engines and `@types/node` move together, as in the move to
  Node 22 of 2026-10-20 (pinned by digest, Dependabot proposes patch and minor releases but never a
  new major). (2026-10-20)
- [x] 8. A visual invoice template composer in the Books (asked by the owner on 2026-10-21): a
  block-based A4 composer like the email editor whose canvas is the real PDF, versioned templates,
  legally required blocks that move but cannot be removed, a save gate running the completeness
  check, logos in the tenant schema, and a Correct flow (credit note plus a prefilled replacement
  draft), plus an EPC QR payment block. Approved by the owner on 2026-10-22; phases 1 to 5 are
  live and proven, English documents and e-invoicing are later work on their own lines below.
  Phases 1 (Korrigieren, #125, migration 011) and 2 (model, engine, versions, the save gate, the
  preview route, #127, migration 012) are live since 2026-10-22, proven on app.lumitra.co on the
  test company "Books Testfirma" (auth-brain organisation marlinjai, apps `sites` and `books`,
  fictional sender, regular taxation, number series `TEST-{n}`, `TEST-GS-{n}`, `TEST-ANG-{n}`;
  for proving Books changes without touching a real number series): invoice TEST-1 with the EPC
  QR code, its PDF byte-identical after a later template edit. Phase 3 (the shared editor
  package `@marlinjai/block-editor-react`, email-editor #166, 0.1.0 on npm) is done since
  2026-10-23. Phases 4 (the composer, #135) and 5 (logos and Noto fonts, #134, migration 013) are
  deployed and proven on app.lumitra.co on 2026-10-23: a template created from Modern in the
  composer, a logo uploaded, a QR block added, a block moved by keyboard, saved through the gate;
  invoice TEST-2 issued with it (the stored PDF shows the logo, the QR code and every legal field,
  and stayed byte-identical after a later template edit to version 4; the version list counts it
  against version 3); a composer refresh after an edit takes 705 to 892 ms end to end on
  production. The proof found Noto printing blank letters (pdf-lib subsetting), fixed in #136
  (Noto embedded whole, a glyph-outline test) and deployed; TEST-3 issued in Noto Serif renders
  correctly. The last piece, deleting a logo nobody uses (phase 4 decision 9: never while an
  issued document or a live template's current version names it), was built in #137 (migration
  014, BK015, the logo list and delete routes, "Your logos" in the composer's logo picker), and
  the plan was completed with it. See
  [plan](docs/plans/2026-10-21-books-visual-template-composer.md). (2026-10-23)
- [x] 8a. Prove the logo deletion on app.lumitra.co after the deploy that rolls migration
  `014_books_asset_delete`: proven on 2026-10-23 on "Books Testfirma". A spare logo deleted with
  "Delete" in the composer's "Your logos" (the confirmation says it cannot be undone) is gone from
  the list and the server; the logo printed on TEST-2 shows "In use" with no delete, its DELETE
  answers 409 `asset_in_use`, and TEST-2's stored PDF is unchanged (sha256 698c6ba9...). The proof
  found a deleted logo still showing from the browser cache (served `immutable` for a year): now
  `private, no-cache`, revalidated by its ETag. (2026-10-23)
- [x] 8b. Write the invoice on the invoice (asked by the owner on 2026-10-23, "a pixel perfect
  WYSIWYG editing experience closer to sevdesk but even more WYSIWYG"): the draft editor becomes the
  real A4 page in the company's template, every field edited in place over the PDF, add-line and
  line actions placed on the page, redrawn by the layout engine running in the browser; plus a
  subject line, a reference number, payment terms on the page, formatted intro and closing texts
  and a product and service list. Decided 2026-10-23 (the owner took every recommendation), in
  progress: phase 1 built (the engine draws drafts in a browser worker, byte-identical to the
  server, proven in headless Chrome); phase 2 (every editable field's rectangle and style, the
  add-line and row anchors in the layout map) built 2026-10-23; phase 3 (the editor on the page,
  line actions, product picker, undo, the issued invoice as its stored PDF) live and proven on
  Books Testfirma 2026-10-24 (TEST-4 written on the page and issued); the subject line (migration
  016, a template block, on the page and in the form) live and proven 2026-10-24 (TEST-5); formatted
  intro and closing texts (italic faces, migration 018, the engine, the formatting editor on the
  page) live and proven 2026-10-24 (TEST-6). Done 2026-10-24; the whole-invoice discount and the
  snippets are 8c and 8d. See
  [plan](docs/plans/2026-10-23-books-wysiwyg-invoice-editor.md). (2026-10-23)
- [ ] 8c. A discount on the whole invoice ("Gesamtrabatt", as sevdesk), split across the tax rates
  in proportion and printed so the tax per rate stays right (section 14 UStG): needs its own small
  plan touching the tax engine, the totals block and the completeness check. Decided 2026-10-23 as
  later work, after the in-place editor. (2026-10-23)
- [ ] 8d. Text snippets and placeholders for intro and closing texts (sevdesk's "Textvorlage" and
  "Platzhalter", for example the customer's name), with placeholders resolved to frozen data at
  issue: after the in-place editor is in daily use. Decided 2026-10-23 as later work. (2026-10-23)
- [ ] 9. E-invoicing for Books documents (XRechnung and ZUGFeRD profile EN 16931, built from the
  frozen document data, ZUGFeRD as a PDF/A-3 with the XML embedded): write its own plan in the
  first half of 2027, so every regular-taxed company using the Books can issue e-invoices before
  the German business-to-business obligation of 1 January 2028 (section 19 small businesses such
  as Whiz-Art Media are exempt). Decided 2026-10-22 as phase 7 of the completed visual template
  composer plan of 2026-10-21 (in docs/plans, decision 14 has the background; the roadmap check
  refuses an open line naming a completed plan's path). (2026-10-23)
- [ ] 10. English documents in the Books (phase 6 of the completed visual template composer plan,
  "not now", decided 2026-10-22): an `en-GB` label dictionary, date and number formats, the locale
  on the template and the completeness check per locale. Built when a client needs an English
  invoice; about 3 agent days. (2026-10-23)
- [x] The framer-clone Coolify Postgres database with the published port 5439: checked on
  2026-10-15, there is no framer-clone database or app in Coolify any more and port 5439 is closed
  on both servers, so nothing is left to restart. Done 2026-10-15.
- [ ] Re-evaluate the untracked `docs/specs/build-2026-06-arbosano/` in the main checkout: a draft
  plan of 2026-06-26 to mature the builder UX with the ArboSano site as the forcing spec. ArboSano
  has since been built on WordPress, so the forcing spec is gone; the builder-UX gaps it lists
  (reusable components, navbar, theme) are still real. Marlin's call: re-scope, keep as
  reference, or drop. The commerce tenant plan that sat next to it is committed. (2026-10-15)

## Completed

See the individual plan files under `docs/plans/` and `docs/specs/` for status and evidence; this
roadmap only tracks open work, per the one-home-per-open-item rule
(`knowledge-base/standards/document-lifecycle.md` section 4).
