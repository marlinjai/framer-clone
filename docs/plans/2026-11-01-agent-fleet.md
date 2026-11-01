---
type: plan
status: draft
date: 2026-11-01
title: "Agent fleet: taking primitives to 95 percent and building the shop"
summary: "The autonomous fleet Marlin asked for on 2026-10-26 and again on 2026-11-01. About 70 small slices in two streams and a bug lane, run by the orchestrator on hermes and steered from the Mac. Roughly 30 million tokens and a few days of continuous running, measured from today's four slices. Draft for Marlin's review; nothing has been dispatched under it."
tags: [framer-clone, orchestration, agents, primitives, commerce]
projects: [framer-clone]
---

# Agent fleet

This closes the design Marlin requested on 2026-10-26, which was never delivered, and his request of
2026-11-01 to cover all primitive and shop work. Inputs: the
[complete primitives plan](2026-11-01-complete-primitives.md), the
[Medusa analysis](2026-11-01-medusa-architecture-analysis.md) and the first score.

## Can coverage reach 95 percent?

Yes, in every column, and the arithmetic comes from the matrix.

| Column | Today | Missing | What closes it |
|---|---|---|---|
| Format | 708 of 874 | 166: 118 selectors, 15 at-rules, 33 media features | Selector-level styling (step 4) |
| Published page | 690 | The same 166, plus 18 | Step 4, the `form` bug, 13 interaction patterns (step 6) |
| Editor canvas | 674 | 170 failed, 30 not tested | Step 4, plus testing patterns on a mounted canvas |
| AI | 128 | 746, mostly three allowlists | Derive the lists from the same data the matrix reads, minus blocked items |
| Panel | 57 | 817 | General property and attribute editor, tag choice, state switch, behaviour presets |

Selector-level styling alone takes the first three columns from about 80 to about 98 percent.
`iframe`, `object` and `embed` stay blocked on purpose and are served by the custom code primitive.

Two honest limits:

- **The matrix measures "exists", not "good".** A general property editor turns hundreds of panel
  cells green without making the builder better. The real test is the corpus, where today's figure
  is 2 of 13 small fixtures. So the stop condition combines both (see below).
- **The score will drop before it rises.** SVG, element-specific attributes and CSS value grammar are
  not measured yet. The fleet widens the measure first, so 95 percent means more than it would today.

JavaScript as a whole cannot reach 100 percent. Behaviour is measured against the 30 standard
interaction patterns, and custom code covers the rest.

## Measured inputs

Today's four slices are the unit for this plan and replace the week estimates, which are already
contradicted (step 1 was estimated at a week).

| Slice | Time | Tokens |
|---|---|---|
| Medusa analysis | 13 minutes | 332,000 |
| Stock hold fix | 20 minutes | 273,000 |
| Text nodes | 32 minutes | 417,000 |
| First score | 35 minutes | 392,000 |

Four samples are few, and foundation slices will run longer. Planning figures: 30 to 60 minutes and
about 400,000 tokens per slice, plus roughly 10 minutes of continuous integration each, and 30 percent
for retries and fixers.

**Total: about 70 slices, about 30 million tokens, and a few days of continuous running at four
workers, plus the time review gates wait for Marlin.** All of this is a judgement extrapolation. The
real limit is the subscription's rate limit, which is unmeasured; the first batch measures it.

## The shape

Two streams and a bug lane, in this order.

**Lane 0, preparation (operator, no workers).** Land #198, #200 and #202. Check production for rows
that would show hidden text, then deploy with browser proof. Install the expiry timer. Install the
orchestrator on hermes and clone the repo there as `marlins-hermes`. Add the `renderer` tag.

**Bug lane (about 5 slices, first).** The `form` tag collision. The `;` dropped from stylesheets. Text
nodes in tables. Clearer panel labels and splitting text at the cursor. The mixed-text fixture rewrite
and baseline ratchet.

**Primitive stream (about 42 slices).**

1. Widen the measure, and add BusBasis pages as held-out fixtures (3).
2. AI allowlists derived from the data (1). General property and attribute editor, tag choice (2).
3. Selector-level styling: contract, states, pseudo-elements, keyframes, at-rules, the state switch (6).
4. Reusable components and component states: contract, model, canvas frames, connectors, inputs (5).
5. Theme tokens, head items, navbar, marketing sections (4).
6. Behaviour: contract, page state, events and actions, canvas run, the patterns that fail (8).
7. Sandboxed custom code (3).
8. React import and export (5). Recurring corpus growth (5).

**Shop stream (about 23 slices, serial).**

1. Backbone: contract, outbox and jobs, Stripe reconciliation, checkout record (4). These may start
   before the fleet is approved, under the decision "backbone now".
2. Shipping (3), order list and fulfilment (3), discounts (2), refunds (2), light returns (2), payment
   methods (2), accounts (3), categories and search (2). Shipping, discounts and refunds wait for the
   VAT research, reviewed by Marlin.

## How it runs

- **Workers:** the orchestrator CLI on hermes (8 cores, 241 GB free, docker), one worktree per slice,
  each slice under 1.5 hours because long runs were reaped in June. Four at a time to start.
- **Operator:** one session on the Mac runs the dispatcher loop and owns holds, deploys, the roadmap,
  score reruns and production proofs. Everything that needs the Keychain stays there.
- **Goals:** one file per slice in `~/software-dev/orchestrator/goals/`, with `depends_on` and
  `shared_state`. That frontmatter is the only dispatch plan.
- **Collisions:** `renderer` for the two renderer files, plus the existing `lockfile`, `migrations` and
  `prisma`. Every shop slice touches tenant migrations, so that stream is serial by construction.
- **Landing:** workers stop at `gh pr create`, and land-pr lands green pull requests. The orchestrator's
  merge step is not used.
- **Roadmap:** workers never edit `ROADMAP.md`. The operator ticks lines after merging, because every
  worker edit to it today forced a rebase.
- **Verify gate:** types, lint and unit tests, plus `pnpm score:primitives` with its ratchet for
  primitive slices. Workers changing routes run `pnpm test:integration` themselves, because the
  in-loop gate misses it (a June lesson).
- **Held-out check:** BusBasis and component fixtures sit where workers cannot write, so nobody can
  tune a fixture to pass. A failure there escalates and is never fed back as a retry.
- **Review:** a fresh agent reviews every money, stock, security and contract pull request without
  seeing the author's reasoning.

## What still needs Marlin

Contracts are reviewed before fan-out, because every later slice builds on them: selector styling,
reusable components, behaviour and custom code, the job backbone. Beyond that:

- production migrations and machine changes, as a one-line yes;
- money and stock slices (createOrder, reserve, payments, refunds);
- the sandbox's security design;
- a look-and-feel check of the state switch, canvas frames and connectors;
- the VAT research, and live payments.

## Safety

`GLOBAL_STOP` halts every run at the next iteration. The stagnation brake, the tamper tripwire and the
marlin proxy stay on, and `irreversible_ops` always escalates. Both machines share one subscription,
and `ORCHESTRATOR_DAILY_TOKEN_CAP` is per machine, so running workers on hermes alone keeps the cap
meaningful. Deploys are batched, each with a production browser proof, and never run by a worker.

## Stop conditions

Proposed for the primitive stream: every column at 95 percent or more on the widened matrix, all 30
interaction patterns built from primitives, and every BusBasis page passing the corpus. The shop stream
ends when ranks 1 to 10 of the Medusa analysis are built and proven with test purchases.

## Dispatched before approval

Under decisions Marlin already made on 2026-11-01: the VAT research, under "research first", which is
running. The backbone may follow, under "backbone now", now that the expiry fix has merged.
