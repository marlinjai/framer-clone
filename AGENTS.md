# framer-clone (Lumitra Sites)

The website builder of the Lumitra suite: an editor on `app.lumitra.co` and every other host served as a published
site (`<label>.sites.lumitra.co`, custom domains), plus the shop, books and custom code parts around it. Next.js
15, TypeScript, MobX State Tree, Prisma and Postgres. Node from `.nvmrc`, pnpm 9.15.

## The check command

**`pnpm verify`** runs what every change must pass, in CI's order, and prints one line per stage with pass or fail:
the tenant isolation guards, the agent plugin payload, the score floor, typecheck, lint and the unit tests.
**`pnpm verify --all`** adds the integration suite (needs Docker), the render gate and the behaviour suite (need
Playwright's browsers). `--only=typecheck,unit` runs the named stages. Report a branch only with it green, and say
which command ran with what result.

- When the Mac is busy, run it on hermes: `check-on-hermes pnpm verify`. On hermes `rawSqlCatalogQualified` fails
  because the copy has no `.git`; it passes in a checkout.
- Browser suites in CI's builds: the Playwright image `mcr.microsoft.com/playwright:v1.64.1-noble`, with
  `--cpus=1` or `2` to imitate a loaded runner. Run test files serially, never in parallel.
- A defect found by a review or in production becomes a test in the same change, and a fix is proven by a test that
  fails without it (a mutation check). A mutation counts as caught only when an expectation fails, never by a time limit.

## Plans and decisions

- Non-trivial work starts from a plan in `docs/plans/` (frontmatter per the document lifecycle standard: draft,
  decided, in-progress, completed). Decisions taken while building go into the plan's "Decided in ..." section,
  numbered, with their reasons, so they can be overruled.
- Open items live on the root `ROADMAP.md` as dated `- [ ]` lines; `pnpm check:roadmap` fails a line not confirmed
  within 30 days.

## Rules of this repository

- **Renderers never draw a stored tag that could run code.** `src/lib/renderer/blockedNodes.ts` refuses `iframe`,
  `script`, `object`, `embed` and the rest in both renderers; frames (the map embed, custom code) are built from an
  address the code makes, never from stored data.
- **Every database read and write is scoped to its tenant** (workspace, company schema). `pnpm lint:guards` enforces
  it for SQL; tests under `src/server/commerce` never use `.unsafe()`.
- **Custom code runs only in the cross-origin sandboxed frame** of `docs/plans/2026-11-02-sandboxed-custom-code.md`.
  Agents and the importer may propose a block, never write one.
- **Migrations need Marlin's yes by name.** Nothing in a pull request deploys: merging to main publishes no image while
  the deploy variables are unset.
- No secrets in the repository or on a command line: Infisical, through the secrets proxy for anything that prints.
- No em-dashes or en-dashes in code, comments, docs or commit messages.

## Landing

One branch per phase of a plan, about 1,500 changed lines at most. The check command green, one independent review,
fixes, the command again, one push, then the `land-pr` autopilot merges on green checks and cleans up. Never merge by
hand and never use `--no-verify`.
