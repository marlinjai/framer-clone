---
title: AI Agent Layer Research for Framer-Clone
type: plan
status: draft
date: 2026-05-05
tags: [research, ai, llm, agent, framer-clone, bubble-killer, anthropic]
projects: [framer-clone]
summary: Research session evaluating how Framer-clone should add an AI agent layer (inline assistant, full-app scaffolding, hybrid) for non-developer customers. Recommendation: build Pattern C (hybrid) with a structured tool-use API against the MST tree, default to Sonnet 4.6 with prompt caching for the canvas-aware system prompt, gate full-app scaffolding behind the CMS plan landing.
---

# AI Agent Layer Research for Framer-Clone

> Strategic research doc. Not a build plan. Captures what an AI agent layer should look like for a Framer-quality visual builder targeting non-developers (the bubble-killer thesis at `~/.claude/projects/-Users-marlinjai-software-dev-ERP-suite-projects-framer-clone/memory/project_strategic_thesis_bubble_killer.md`). Conclusion at the bottom.

## Why we are even asking this

Three forces:

1. **The bubble-killer thesis only works with native AI.** "Framer-quality UX + Bubble power" is a graveyard pitch (Adalo, Bravo, Bildr) without an AI layer that lets non-developers describe an app and get a working canvas tree. Bubble's AI features (5 to 7 minutes to generate an MVP from a prompt) ship inside the same 11-year-old UI; Lovable, Bolt, V0 ship AI-native from day one. The window where "AI as a bolt-on" is competitive is closing fast in 2026.
2. **The MST tree is already structured data.** `src/models/ComponentModel.ts:77-114` defines a typed, serializable tree (id, type, props, children, per-breakpoint resolution, canvasNodeType). That is exactly the shape an LLM tool layer wants. We do not have to invent an IR for the agent: the canvas IS the IR.
3. **Customers in this thesis are NOT developers.** They will not see code. They will not edit JSX. The AI cannot output React source for them to read. It must output MST snapshots (or equivalent JSON patches) that the renderer consumes. This eliminates the entire "code-as-source-of-truth" category (Cursor 3 Design Mode, Bolt, Lovable Dev Mode) from the design space, and points us toward a different architecture than any of the current AI builders use.

The question is what the agent surface looks like, what model tier we run it against, and how we sequence it relative to the data layer (CMS plan).

## Current canvas architecture (relevant facts for the agent)

Useful before evaluating patterns:

- **MST tree** at `src/models/ComponentModel.ts:7-22` defines `ComponentTypeEnum` (HOST | FUNCTION) and `CanvasNodeType` (COMPONENT | VIEWPORT | FLOATING_ELEMENT). Snapshots are JSON-serializable and round-trip cleanly.
- **Component registry** at `src/lib/componentRegistry.ts:33-217` defines 8 layout primitives today (text, button, image, container, stack, grid, flex, card). Each entry has typed defaults including style maps. No data-bound components yet (form, list, table view, auth gate). Those land with the CMS plan: `docs/plans/2026-05-05-cms-data-layer-research.md`.
- **Responsive props** are resolved at render time by `getResolvedProps` (`src/models/ComponentModel.ts:375-409`) with smaller-first-then-larger fallback. The agent has to model this: "set fontSize to 24px on mobile" needs the right shape (a responsive map keyed by breakpointId).
- **Editor renderer** (`src/components/ComponentRenderer.tsx`) and **headless renderer** (`src/lib/renderer/HeadlessComponentRenderer.tsx`) are both React. The renderer research (`docs/plans/2026-05-01-framework-agnostic-renderer-research.md`) committed to React-only forever for the editor and at least 12 months for publish. The agent layer should be designed against this, not against a hypothetical multi-framework future.
- **Project / page model.** `ProjectModel` holds breakpoints, pages, and the active page id. `PageModel` holds the root component tree. The agent's tool surface has to operate at the page level (add component to page X) and project level (create new page, add new breakpoint, define a new collection).

## Research question 1: State of AI builders in 2026

Quick scan of the current art so we know what the customer is comparing against. Each entry: what it generates, output shape, refinement loop, who it targets.

### 1a. Lovable

- **Output:** Full-stack TypeScript + React + Vite + Tailwind apps backed by Supabase (PostgreSQL + auth + storage). Production-ready code, deployable in one click. Code is exportable; users own it.
- **Workflow:** Prompt or screenshot in. App scaffolded in minutes. Iterate by chatting. Two interaction modes: Chat Mode (agent reasons across multiple steps before editing) and Dev Mode (direct code editing alongside AI output).
- **Schema generation:** AI interprets plain English and proposes database tables + relationships, then wires them to the UI.
- **Audience:** Indie founders and small teams who want a working app in an afternoon and are willing to look at code if they need to debug. Expanded to general-purpose tasks (data analysis, BI, decks) in March 2026.
- **Comparison to Framer-clone thesis:** Closest competitor on full-app generation. But customers see TypeScript files. A non-developer who breaks the layout in Lovable is stuck unless someone edits code. Framer-clone's edge is "the canvas is always the source of truth, AI never hands you code".

### 1b. Bolt.new

- **Output:** Full-stack React/Vite apps running in StackBlitz WebContainers (Node.js in the browser via WebAssembly). The agent has full filesystem + terminal + npm access. Bolt Database (built-in backend) since September 2025.
- **Workflow:** Prompt in. Agent scaffolds, runs, and self-verifies the project in a live container. The model can see its own output (compile errors, runtime errors, console) and iterate. Default model: Claude Sonnet 4.6 since April 2026.
- **Self-correction:** "Because the code is being instantly executed in WebContainers, bolt.new can verify its own output and fix issues before you even notice them."
- **Audience:** Same as Lovable, slightly more code-fluent. Heavy use of Claude tool-use against a real Node environment.
- **Comparison:** WebContainers + agentic execution is a category-defining UX, but it requires shipping a Node runtime. Not a fit for Framer-clone (the canvas is the runtime, no Node, no terminal). The lesson is: tight feedback loop where the agent observes the result of its mutation. Framer-clone needs the same loop, but the "result" is the rendered canvas, not stdout.

### 1c. V0 (Vercel)

- **Output:** React components using shadcn/ui + Tailwind. Generated from natural-language prompts. As of February 2026: Git integration, VS Code-style editor, database connectivity, sandbox runtime, agentic workflows.
- **Design system support:** Shadcn Registry is "a distribution specification designed to pass context from your design system to AI Models". You ship your registry, V0 generates components that match it.
- **Refinement:** Conversational. "Make the sidebar collapsible / change the button style to outlined / add a loading skeleton state."
- **Audience:** Frontend developers and designer-developers who already use shadcn/ui.
- **Comparison:** V0's "design system as registry passed to the AI" is the most directly applicable pattern for Framer-clone. Our equivalent: pass `componentRegistry.ts` (with its 8 primitives, defaults, sizes) to the agent as part of the system prompt, plus the current MST tree, plus the available breakpoints. The agent then generates structured output that conforms to that registry.

### 1d. Cursor 3 Design Mode (April 2026)

- **Output:** Edits to the user's existing code repo. Code is the source of truth; visual editing is just a way to point at things.
- **Workflow:** User clicks an element in a rendered browser, annotates it, agent searches the codebase for the matching JSX and applies the edit.
- **Drift problem:** Already documented in the renderer research. Visual edits are "lossy hints"; the agent has to reverse-engineer the user's intent into the right code change. If the codebase doesn't match the rendered DOM, edits drift.
- **Comparison:** Different category. The drift problem only exists when code is the source of truth. In Framer-clone, the MST tree is the source of truth and the renderer is deterministic. The agent edits the tree, the canvas re-renders. No reverse engineering, no drift. This is a structural advantage we should lean into.

### 1e. Wix AI Website Builder / Wix Harmony

- **Output:** Full hosted Wix sites. Pages, color scheme, typography, layout generated from a creative brief. AI SEO assistant added in 2026. 15+ AI tools across the platform.
- **Workflow:** Hybrid: user can flow between AI generation and manual editing. Wix Harmony (the successor to ADI) explicitly markets the mixed mode: "you're not locked into one way of working".
- **Audience:** Small businesses, portfolios, restaurants. Non-developers entirely.
- **Comparison:** Direct competitor for the "full-site from prompt" feature. But Wix is content sites; doesn't do auth/data/forms in any serious way. Framer-clone's bubble-killer pitch is exactly: "Wix-quality AI generation, Bubble-level data and auth power". The hybrid editing pattern (AI for first pass, manual for refinement) is the right UX.

### 1f. Bubble AI

- **Output:** Full app with UI, database schema, workflows, logic. Inside Bubble's visual platform. 5 to 7 minutes to generate an MVP. Mobile (iOS / Android) since August 2025 via React Native foundation.
- **Workflow:** Prompt in, app out. User then refines inside Bubble's standard visual editor (which is the 11-year-old UI Marlin's thesis is targeting).
- **Comparison:** Closest competitor on the data + auth + AI combination. Their AI is bolted on top of an aging UX. Framer-clone's wedge: same end-state (full app from prompt), better canvas (Framer-grade), AI that is native to the design tool, not a generation step before it.

### 1g. Webflow AI

- **Output:** Generated sites from a creative brief. AI Assistant evolving as a conversational partner that "understands your site structure, design system, and workflow context". 2025 announcements promised AI-assisted code generation including React component output; in 2026 this is "more robust and widely available" but still maturing.
- **Comparison:** Webflow is constrained by being a designer tool first; AI is a layer on top of the designer. Framer-clone has the same shape problem but is much earlier and can architect AI as a first-class citizen.

### 1h. Plasmic Visual Copilot, Builder.io Visual Copilot

- **Plasmic:** Visual builder for headless content. No AI personalization or A/B testing in 2026. Codegen-focused.
- **Builder.io Visual Copilot:** Figma-to-code plugin. Pipeline: initial model that converts flat design structures to code hierarchies, Mitosis compiler for cross-framework output, fine-tuned LLM pass for framework-specific style. 2 million training data points. Multi-framework output (React, Vue, Svelte, Angular, Qwik, Solid, HTML).
- **Comparison:** These are designer-to-code pipelines, not visual-builder agents. Tangential to Framer-clone's audience. Useful as a model: trained-on-design-data LLM beats general-purpose LLM for this task.

### 1i. Summary table

| Tool | Output shape | Source of truth | Audience | Refinement loop |
|------|-------------|-----------------|----------|-----------------|
| Lovable | TS + React + Supabase code | Code | Indie / SMB devs | Chat or direct code edit |
| Bolt.new | Live Node container + React app | Code | Devs | Agentic, container-self-verifies |
| V0 | React + shadcn components | Code | Frontend devs | Chat refinement |
| Cursor 3 Design Mode | Codebase edits | Code | Devs | Visual annotate, agent edits code |
| Wix Harmony | Hosted Wix sites | Hosted DB | Non-developers | Hybrid AI + manual |
| Bubble AI | Bubble app (UI + DB + workflows) | Bubble platform | Non-developers | Visual editor + AI |
| Webflow AI | Hosted Webflow sites | Webflow platform | Designers / SMB | Conversational partner |
| Plasmic / Builder.io | Code in user's framework | Code | Designers / devs | Figma-to-code generation |
| **Framer-clone (proposed)** | **MST tree (no code visible)** | **MST tree** | **Non-developers building apps** | **Hybrid: scaffold + inline canvas-aware agent** |

The whitespace is the bottom row. No current builder targets non-developers with a tree-based source of truth and a fully agentic refinement loop. Wix and Bubble target the right audience but their canvas is weak; Lovable / Bolt / V0 / Cursor have the agent loop but expose code.

## Research question 2: Three architectural patterns

### Pattern A: Inline assistant in the canvas

User selects a node, opens an AI prompt panel, types ("make this hero bigger / generate 3 product cards / add a contact form"). Agent returns a partial MST patch, which gets applied in a single MST transaction (so it lands in the undo stack as one history entry).

- **Primitives:** Tool surface for component CRUD against the MST, scoped to the current selection / page. System prompt includes registry, current selection's subtree, breakpoints.
- **Tool-use surface:** `add_component`, `update_component_props`, `delete_component`, `move_component`, `set_responsive_prop`, plus read-side `get_component`, `get_subtree` for the agent to inspect before mutating.
- **Model:** Sonnet 4.6 is overkill for most inline edits. Haiku 4.5 ($1 / $5 per 1M) handles "make this bigger" or "change to red". Sonnet for anything multi-step (generate 3 cards from product descriptions).
- **Tradeoffs:** Lowest risk, ships first, immediately useful. Doesn't require the data layer. But by itself doesn't deliver the bubble-killer wow factor (no full-app generation).

### Pattern B: Full-app scaffolding from prompt

User describes the entire app (name, audience, key features). Agent returns a complete project: pages, breakpoints, navigation structure, hero / features / pricing / contact pages, a data schema (collections, fields), forms wired to collections, an auth gate.

- **Primitives:** Bigger tool surface that includes project-level mutations: `create_page`, `add_breakpoint`, plus all the inline tools. Also `create_collection`, `add_field_to_collection`, `bind_component_to_collection`, `create_query` (these are CMS-plan-blocked).
- **Output strategy:** Two options: (i) generate a single MST snapshot that is applied wholesale, like Lovable / Bubble do; (ii) stream a sequence of tool calls that build up the app step by step, with the canvas updating live as the agent works. Option (ii) is more impressive UX, harder to implement, requires the agent to handle partial state.
- **Model:** Opus 4.7 ($5 / $25 per 1M) for the planning pass (decide app structure, pages, schema). Sonnet 4.6 for the bulk-component generation. Mixed-model orchestration is normal in 2026 agent stacks.
- **Tradeoffs:** Highest wow factor, the marketing-line use case ("describe your app, get a working app"). But fully blocked on the CMS plan landing: a generated app without a data layer is a static site, which Wix and Webflow already do better.

### Pattern C: Hybrid

A first scaffolding pass (Pattern B), then ongoing inline assistance (Pattern A). User describes the app, gets a scaffold, then refines either by chat ("change the hero copy") or by manual canvas editing or by selecting a node and prompting.

- **Primitives:** Union of A and B. Same tool surface, different orchestration prompts.
- **Reality of comparable products:** Lovable, Bolt, V0, Wix all converged on this pattern after starting at one or the other end. Wix Harmony explicitly markets "you can flow easily between AI and manual editing tools".
- **Tradeoffs:** Most product surface area. But the inline part can ship first (Pattern A) and the scaffolding part can land when the CMS plan does. The architecture (tool-use surface, prompt structure) is shared between the two; we are not building two systems.

### Recommendation among A / B / C

**Pattern C, sequenced as A first, then B.** Inline assistant ships against the existing 8 primitives without needing the data layer. Full-app scaffolding ships when the CMS plan lands. Both share the same tool-use API, which means the second phase is mostly prompt engineering and orchestration, not new infrastructure.

## Research question 3: Tool-use surface

Sketch of the full tool surface, grouped. Each tool is a function the LLM calls; the framer-clone agent runtime executes the corresponding MST mutation in a transaction.

### 3a. Read tools (always available)

- `get_project_overview()`: returns project name, list of pages, list of breakpoints, list of collections (when CMS lands).
- `get_page_tree(pageId)`: returns the full MST snapshot for a page.
- `get_subtree(componentId)`: returns the subtree rooted at a component.
- `get_component(componentId)`: returns one component's id, type, props, parentId, children ids.
- `get_registry()`: returns the component registry as a typed list of available primitives. Cacheable in the system prompt.
- `find_components(query)`: filtered search by type, label, or text content. Useful for "find the contact form".

### 3b. Mutation tools (canvas / page level)

- `add_component(parentId, type, props, index?)`: creates a HOST or FUNCTION component as a child of `parentId` at optional index. Returns the new id.
- `update_component_props(componentId, propPatch)`: deep-merges the patch into props. The agent can pass partial style updates.
- `set_responsive_prop(componentId, prop, breakpointId, value)`: writes into the responsive map for a single property and breakpoint. Wraps the existing `updateResponsiveStyle` action.
- `delete_component(componentId)`: removes from tree.
- `move_component(componentId, newParentId, index?)`: detach + reattach.
- `set_text_content(componentId, value)`: shortcut for inline text. Wraps `setTextContent`.
- `set_label(componentId, label)`: rename the layer.

### 3c. Mutation tools (project / page level)

- `create_page(name, slug)`: adds a new page to the project.
- `delete_page(pageId)`: removes.
- `set_active_page(pageId)`: changes editor focus, useful when the agent wants to show its work.
- `add_breakpoint(label, minWidth)`: adds a new responsive breakpoint.
- `update_navigation(linkSpec)`: edits the project's navigation structure. (Depends on whether navigation lives as a model field or as a regular component subtree.)

### 3d. Data layer tools (CMS-plan-blocked)

These cannot ship until the data layer plan (`docs/plans/2026-05-05-cms-data-layer-research.md`) lands. Sketched here so the eventual surface is known:

- `create_collection(name, fields)`: define a new data collection (table) with typed fields.
- `add_field(collectionId, field)`: add a field to an existing collection.
- `bind_component_to_data(componentId, queryConfig)`: wire a list / table / form component to a collection or query.
- `create_query(collectionId, filterConfig, sortConfig, limit)`: define a reusable query.
- `add_form_submission_handler(formId, collectionId, fieldMapping)`: wire a form to write into a collection.

Until those land, the AI can only generate static layouts. That is fine for Pattern A (inline assist) and partially fine for Pattern B (scaffolding a marketing site), but it does not unlock the bubble-killer pitch ("describe an app, get a working app with logins and a database"). The data layer is the bottleneck.

### 3e. Auth layer tools (auth-brain-blocked)

Equally sketched-not-built:

- `add_auth_gate(componentId, requiredRole?)`: wraps a subtree behind auth.
- `create_login_page(provider)`: scaffold a login page wired to auth-brain.
- `add_user_signup_form(collectionId)`: wire a signup form.

Blocked on auth-brain Phase 3.5 (OIDC provider for end-users of customer-built apps), Month 8 to 10.

### 3f. Tool-use design notes

- **Idempotency.** Every mutation tool should be safe to call twice (same id, same patch = no-op). Helps the agent recover from partial failures.
- **Transactional grouping.** A single agent turn should batch its mutations into one MST transaction. Either expose a `batch_mutations(operations[])` tool, or wrap the entire turn server-side in a transaction that commits when the agent returns control. Either way, undo is one entry per agent turn, not per tool call.
- **Streaming feedback.** If we use streaming tool use (Anthropic supports it), the canvas can update live as the agent works. Bolt does this and it is a meaningful UX win. For Framer-clone, an MST batch transaction commits at the end, but the user sees the agent's plan and tool calls as they stream.
- **Schema-first.** Use Anthropic's structured outputs (released 2026) so the agent literally cannot generate a tool call that violates the schema. Reduces error handling.
- **Attempt-and-observe.** After each mutation batch, return the new subtree (or an error) to the agent so it can verify and continue. This is the loop that makes Bolt feel reliable; we replicate it without needing a Node runtime.

## Research question 4: Model choice and economics

### 4a. Model selection

| Use case | Model | Why |
|---------|-------|-----|
| Inline edit ("make this bigger", "change color to brand blue") | Haiku 4.5 ($1 / $5 per 1M) | Single-step, deterministic, no planning needed. Cheapest, fastest. |
| Multi-step inline ("generate 3 product cards", "add a hero with image and CTA") | Sonnet 4.6 ($3 / $15 per 1M) | Needs to plan, generate, and place. Sonnet is the sweet spot for tool-use orchestration. |
| Full-app scaffolding (Pattern B) | Opus 4.7 ($5 / $25 per 1M) for the planning pass, Sonnet 4.6 for the bulk-generation pass | Planning the app structure (which pages, which schema, which navigation) benefits from Opus reasoning. The 50+ component-add calls afterward are mechanical, Sonnet handles them fine. |
| Schema generation (data-layer prompt) | Opus 4.7 | Schema design is the highest-leverage decision and the worst to get wrong. Worth Opus pricing. |

Mixed-model orchestration is the standard in 2026 agent stacks. Bolt does it (Haiku / Sonnet / Opus selectable). Lovable does it. We do it.

### 4b. Cost per app generation (Pattern B back-of-envelope)

A full-app scaffold:

- Planning pass (Opus 4.7): ~5K input (system prompt + user description + registry + breakpoints), ~3K output (plan: pages, schema, navigation, page-by-page component skeletons). Cost: ~$0.025 input + $0.075 output = ~$0.10.
- Generation pass (Sonnet 4.6): ~10K input per page (cached system prompt + plan context + current page state), ~5K output per page (tool calls), assume 5 pages. Per page: ~$0.03 input + $0.075 output = ~$0.10. Five pages: $0.50.
- With prompt caching on the canvas-aware system prompt (registry + breakpoint definitions + tool schemas, ~3K tokens, mostly stable): cache reads at 0.1x the base input price. Saves ~50% of input cost across the multi-call generation. Net: $0.30 to $0.40 per full-app generation.

Even at $1 per generation (with margin and retries), a $20/mo subscription that allows 50 generations is comfortably profitable on the AI side. Lovable charges $20+ for similar usage, so the unit economics work.

Inline edits are essentially free at scale: ~1K input + ~500 output Haiku per edit = $0.0035. A user doing 100 edits in a session costs $0.35.

### 4c. Latency budget

- **Inline edit feels instant if it commits in <1.5s.** Haiku 4.5 with a 3K-token cached prefix and a single-tool-call output: ~700ms first-token + ~500ms streaming. Inside budget.
- **Inline multi-step (generate 3 cards) feels good if it commits in <5s.** Sonnet 4.6 with cached prefix and 5-tool-call output: ~1.2s first-token + ~3s streaming. Inside budget.
- **Full-app scaffolding has a different bar.** Users expect a progress indicator and 30s to 2min generation time (matches Bubble's "5 to 7 minutes" anchor and Lovable's "minutes" anchor). We have ample budget; the UX challenge is showing progress, not making it fast.

### 4d. Prompt caching strategy (Anthropic SDK)

The canvas-aware system prompt has stable and volatile parts:

- **Stable (cached, 1-hour cache write):** Tool schemas (~2K), component registry definitions (~1.5K), instructions for how to use the tool surface (~1K), examples of well-formed tool calls (~1K). Total ~5.5K, mostly stable per editor session.
- **Volatile (NOT cached):** Current page MST snapshot (changes on every mutation), current selection, current breakpoint. Goes into the user message or a separate non-cached system block at the end.

Prompt caching gives 90% input cost savings on the cached prefix and 85% latency reduction. For an inline-edit session with 50 turns, that is the difference between $1.50 and $0.20 of input cost, plus 2 to 3 seconds saved per turn.

The `claude-api` skill's prompt caching guidance applies directly: place the cache breakpoint at the end of the stable system content, before the volatile MST snapshot. Reference: `claude-api` skill, `~/.claude/skills/`.

## Research question 5: Schema design via AI

The highest-leverage AI feature for the data layer. A non-developer cannot define schemas; they think in user stories ("I want to track customers and their orders, and each order has line items"). The AI translates that to a normalized schema.

### 5a. What Lovable / Bubble do today

- **Lovable:** Interprets plain English, proposes Supabase tables and relationships, wires them to UI. Output is a real Postgres schema with foreign keys, indexes, RLS policies. The user can override but rarely needs to.
- **Bubble AI:** Generates Bubble-native data types (which are Bubble's abstraction over a database, not raw SQL). Same intent, different output shape.
- **Both** treat the schema as one part of the full-app generation, not a standalone feature. That is the right product framing.

### 5b. How Framer-clone should do it

Once the CMS plan lands, the agent gets a `create_collection(name, fields)` tool. The schema-generation flow:

1. User describes the app or the data model in natural language ("I run a small bakery, I want a website with a menu, and I want customers to be able to place pickup orders").
2. Opus 4.7 plans the schema: collections (Products, Orders, OrderItems, Customers), fields per collection (with types: string, number, datetime, relation), relationships (Order belongs to Customer, OrderItems belong to Order, OrderItems belong to Product).
3. Agent calls `create_collection` per collection, `add_field` per field. UI updates live in the data sidebar.
4. Same agent then scaffolds the pages: a menu page bound to Products, a checkout flow bound to Orders, an admin dashboard bound to Customers.

The wow moment is that the user never thinks about schema. They describe the business, get a working data model.

This requires the CMS plan landing first. Until then, Pattern A (inline canvas assist) is what we can ship.

### 5c. Schema correctness

LLMs occasionally generate bad schemas (missing foreign keys, wrong cardinality, redundant fields). Mitigations:

- **Constrain the tool input schema.** Field types are an enum (string, number, datetime, relation, enum, file). Relations require a target collection id that exists in the project. Structured outputs prevents the model from inventing types.
- **Validate before commit.** A `validate_schema` tool the agent calls before committing. Reports cycles, missing relations, duplicate field names. Cheap to implement, catches most LLM mistakes.
- **Show the schema diagram before committing.** UX: agent generates schema, user sees an ER diagram, approves or rejects. Reduces the cost of bad schemas being generated mid-flow.

## Research question 6: Distribution risk and AI moat

### 6a. The honest assessment

Lovable, Bolt, V0, Cursor have AI-generation moats today through (a) brand recognition, (b) trained models on their own usage data, (c) deep tooling integration with their target stacks. Framer-clone has none of those at the start. Treating "AI" alone as our moat is a graveyard pitch.

### 6b. What we DO have

The bubble-killer thesis already names these. The AI agent layer makes them sharper:

1. **The integrated Lumitra layer.** Apps built on Framer-clone are instrumented from day zero (heatmaps, A/B variants, experiments). The AI agent can read this data: "the contact form has a 80% drop-off at the phone-number field; make it optional and run a 7-day experiment." Lovable and Bolt cannot do this; they don't own the analytics. Webflow and Bubble have analytics tabs but no integrated experimentation. **This is the closest thing to a defensible moat.**
2. **Integrated auth and payments (auth-brain, future Stripe integration).** AI scaffolds an app, the auth gate and the payment flow are wired automatically. Lovable does this with Supabase + Stripe but at the cost of the user seeing TypeScript files. Framer-clone does it without exposing code.
3. **The visual canvas itself.** Once an app is generated, the user can refine on a Framer-grade canvas. Bubble's user has to refine in Bubble's UI. Lovable's user has to either prompt-iterate or read code. This is a real UX advantage that matters for the non-developer audience.
4. **MST as the source of truth.** No drift problem (unlike Cursor 3 Design Mode). The agent's mutations are deterministic; the canvas re-renders deterministically. This makes the agent feel reliable in a way code-edit-based tools cannot match.

### 6c. The defensible angle

"AI for non-developers building real apps, with analytics + experiments + auth + payments wired in by default, all editable on a Framer-grade canvas, no code ever."

The AI is table stakes. The integration of AI WITH the Lumitra moat WITH the auth/payments primitives WITH the visual canvas is the moat. Each of those alone is replicable; the combination is not, and a 1 to 2 person team can ship it because the primitives are built separately and integrated together.

### 6d. What a competitor would have to build

- Lovable would have to build a visual canvas (years of work, see Framer's history).
- Bubble would have to rebuild their UX (existential project, see Adalo's failure).
- Wix would have to build a real data and auth layer (they are content-first by design).
- Webflow would have to build an AI-native architecture and a data layer (they are doing the first, slowly).
- Framer would have to build a data and auth layer and an AI agent layer (they are content-first, no signal yet).

Each of these is harder than what Framer-clone has to do, IF Framer-clone executes the integration well. That is a meaningful asymmetry.

## Research question 7: Anthropic SDK integration

### 7a. SDK choice

Anthropic SDK (server-side, in the Framer-clone Next.js API routes). The Claude Agent SDK (renamed from Claude Code SDK) is overkill for this use case: it is designed for terminal/filesystem agents. Our agent has a fixed tool surface, runs on the server, returns JSON to the client. Plain Anthropic SDK with `messages.stream` and tool use is the right level.

### 7b. Architecture sketch

```
Editor (browser, MST in memory)
  ⇣ user prompts via assistant panel
  ⇣ POST /api/ai/edit { pageSnapshot, selection, prompt, sessionId }
Next.js API route
  ⇣ assembles system prompt (cached prefix + volatile state)
  ⇣ Anthropic SDK messages.stream with tools
  ⇣ streams tool_use events back to client via SSE
Editor receives SSE events
  ⇣ applies each mutation to MST in a single transaction
  ⇣ canvas re-renders live
  ⇣ when stream ends, transaction commits to undo stack
```

### 7c. Streaming tool use

Anthropic's streaming API emits `content_block_start` / `content_block_delta` / `content_block_stop` events for tool calls. We can apply each tool call as it arrives (live preview) or buffer them and apply on stream-stop (batch). Recommend: apply live, with a "rollback" button that undoes the entire turn. Bolt does this and it is the correct UX.

### 7d. Prompt caching

As detailed in 4d. Cache the stable system prefix (tool schemas + registry + instructions). Cache TTL is 5 minutes by default, 1-hour cache available at 2x write cost. For an editor session that lasts 20+ minutes, the 1-hour cache pays back immediately. Set the cache breakpoint at the end of the stable content; the volatile MST snapshot lives outside the cached prefix.

Reference: `claude-api` skill at `~/.claude/skills/claude-api/SKILL.md` for the exact SDK invocation pattern with `cache_control` markers.

### 7e. Error handling

- **Tool call validation errors:** Return the validation error as the tool result; the agent retries.
- **Rate limits / overload:** Exponential backoff with user-visible "AI is busy" state.
- **Long-running scaffolding:** Heartbeat the SSE connection every 10s, show progress in the UI.
- **Cost cap:** Per-user daily cap (configurable), surfaces friendly upsell when hit.

## Research question 8: Sequencing relative to other plans

The AI layer touches every other plan. Sequencing matters.

| Dependency | Status | Impact on AI layer |
|-----------|--------|-------------------|
| auth-brain v1 (editor user auth) | Designed, not shipped | Editor needs user identity to track AI usage and apply per-user caps. Blocking. ~3-day SDK integration. |
| auth-brain Phase 3.5 (end-user OIDC) | Month 8 to 10 | Blocks AI-generated auth gates (Pattern B for real apps). Pattern A unblocked. |
| CMS / data layer | Research only | Blocks all data-layer tools (5 of them). Pattern B is significantly weaker without it. |
| Stripe integration | Not planned | Blocks AI-generated payment flows. Out of scope for the next 6 months. |
| Static HTML publish target | Recommended in renderer plan | Independent of AI layer. AI generates MST; publish path is whatever we choose. |
| Lumitra Studio integration | In progress | Once landed, AI gets read access to experiment results. Powerful but not blocking. |

**Sequencing recommendation:**

1. **Now to 4 weeks:** Ship Pattern A (inline assistant) against the existing 8 primitives. Tool surface: read tools + canvas mutation tools. Model: Haiku 4.5 default, Sonnet 4.6 for multi-step. Anthropic SDK + prompt caching. Auth: stub user identity until auth-brain lands.
2. **Weeks 4 to 8:** Once auth-brain v1 lands, wire real user identity, add per-user cost caps, ship to early users.
3. **Weeks 8 onward:** Pattern B comes online incrementally as the CMS plan lands. Schema generation is the first capability that requires it. Auth-gate generation comes online when auth-brain Phase 3.5 lands (Month 8 to 10).

This sequencing also matches Marlin's solo-developer constraint: ship the smallest piece that delivers value (inline assist for non-developers refining their canvas), then layer on capabilities as the dependent primitives land.

## Recommendation

**I recommend Pattern C (hybrid) sequenced as A then B, built on Anthropic SDK + Sonnet 4.6 default + Haiku 4.5 / Opus 4.7 mix, with prompt caching on the canvas-aware system prompt and a structured tool-use surface that operates directly on the MST tree.**

Specifically:

1. **Ship Pattern A (inline canvas assistant) first.** Selection + prompt = MST mutations via tool use. Read tools + canvas mutation tools only. No data layer dependencies. 3 to 4 weeks of work assuming the API route + SSE streaming + assistant panel UI are new construction. Default model: Haiku 4.5 for single-step edits, Sonnet 4.6 for multi-step.
2. **Design the tool surface as the long-term API.** Even if we only implement read + canvas-mutation tools first, define the full surface (project, page, data, auth tools) up front and build the runtime that dispatches them. This way Pattern B is mostly orchestration prompts and new tool implementations, not new architecture.
3. **Use Anthropic structured outputs.** Tool inputs constrained by JSON Schema, model literally cannot violate them. Reduces error handling, increases reliability for non-developer users who cannot debug tool-use failures.
4. **Use prompt caching from day one.** Cache the stable system prefix (tool schemas + component registry + instructions, ~5K tokens). 90% input cost reduction, 85% latency reduction. The `claude-api` skill has the SDK pattern.
5. **Defer Pattern B (full-app scaffolding) until the CMS plan lands.** A full-app generator without a data layer produces a static brochure site, which Wix and Webflow already do better. The bubble-killer pitch ("describe your app, get a working app") needs the data layer. Until then, Pattern A delivers value to existing canvas users.
6. **Make schema generation the first feature to ship after the CMS plan.** It is the highest-leverage AI capability for non-developers and the hardest thing to learn manually. Lovable and Bubble both prove the demand.
7. **Lean into the moat-stacking story for positioning.** AI alone is not the moat (Lovable, Bolt, V0 own that brand). AI integrated with the Lumitra analytics layer + auth-brain + a Framer-grade canvas + no-code-visible-ever is the moat. Every AI feature should reinforce that integration.

The reasoning, condensed: the MST tree is already structured data and a deterministic renderer, which makes the agent loop categorically more reliable than code-edit agents (no drift). The 8 layout primitives plus the eventual data-bound primitives are a small, well-typed surface for the AI to target. Anthropic's tool use + structured outputs + prompt caching gives us the right primitives to build a fast, cheap, reliable agent. The audience (non-developers) is correctly served by an agent that NEVER exposes code, which is the opposite of what Lovable / Bolt / V0 / Cursor do, and the right wedge against Wix and Bubble. Sequencing matters more than architecture: ship Pattern A now, ride the data layer plan into Pattern B when it lands.

**Caveats:**

- The CMS plan is the bottleneck. If it slips by 6 months, Pattern A alone is not differentiated enough to justify the investment. The bubble-killer thesis only survives if the data layer ships in roughly the same window as the AI layer.
- Cost economics depend on prompt caching working at the assumed hit rate. If the canvas-aware system prompt churns more than expected (e.g., the registry changes per session), caching savings shrink. Worth measuring early.
- Schema generation (research question 5) is the riskiest UX. Bad schemas generated by Opus and committed without validation will burn early users. The validation tool + ER-diagram preview is non-negotiable.
- Streaming tool use UX is harder than batch. If the canvas-mutation-on-tool-call-arrival UX feels janky in early prototypes, fall back to "agent thinks, then commits all mutations at once" before shipping. Bolt's live execution is impressive but only works because their environment IS live; ours has to fake it carefully.
- The AI layer is unowned today (per the bubble-killer thesis blockers list). Marlin is the planner. Recommend a 2-week prototype spike of Pattern A end-to-end before committing to the full Pattern C build, to validate cost / latency / UX assumptions on a real canvas session.

## References

- Strategic thesis: `~/.claude/projects/-Users-marlinjai-software-dev-ERP-suite-projects-framer-clone/memory/project_strategic_thesis_bubble_killer.md`
- Renderer research (commits Framer-clone to React-only forever, AI layer designed against this): `projects/framer-clone/docs/plans/2026-05-01-framework-agnostic-renderer-research.md`
- CMS / data layer research (blocking dependency for Pattern B and schema generation): `projects/framer-clone/docs/plans/2026-05-05-cms-data-layer-research.md`
- Canvas tree model: `src/models/ComponentModel.ts:7-22, 77-114, 375-409`
- Component registry: `src/lib/componentRegistry.ts:33-217`
- Editor renderer: `src/components/ComponentRenderer.tsx`
- Headless renderer: `src/lib/renderer/HeadlessComponentRenderer.tsx`
- Anthropic pricing 2026: https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic advanced tool use: https://www.anthropic.com/engineering/advanced-tool-use
- Anthropic structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Writing tools for agents: https://www.anthropic.com/engineering/writing-tools-for-agents
- Lovable architecture and 2026 expansion: https://lovable.dev/, https://lovable.dev/guides/best-ai-app-builders
- Bolt.new + WebContainer + Claude default Sonnet 4.6: https://github.com/stackblitz/bolt.new, https://support.bolt.new/building/using-bolt/agents
- V0 + shadcn registry: https://v0.app/docs/design-systems, https://vercel.com/blog/ai-powered-prototyping-with-design-systems
- Cursor 3 Design Mode: https://cursor.com/changelog/3-0, https://www.builder.io/blog/cursor-design-mode-visual-editing
- Wix Harmony (successor to ADI): https://www.wix.com/blog/wix-artificial-design-intelligence
- Bubble AI: https://bubble.io/ai-features
- Webflow AI: https://webflow.com/ai
- Builder.io Visual Copilot pipeline (initial model + Mitosis + fine-tuned LLM): https://www.builder.io/blog/figma-to-code-visual-copilot
- Lovable vs Bubble schema generation: https://lovable.dev/guides/bubble-vs-lovable-no-code-platform-comparison
- claude-api skill (prompt caching guidance): `~/.claude/skills/claude-api/SKILL.md`
