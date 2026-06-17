---
name: followon-wire-hydratebindings-into-publish
track: cms-content-tier
wave: static-html
priority: P1
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [slice2-publish-read-binding-hydration, static-html-spike, static-html-publish-pipeline]
touchesSharedState: false
sharedState: []
estimateDays: 1
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Follow-on stub: wire hydrateBindings into the static-publish pipeline

> STUB / placeholder. Created by `slice2-publish-read-binding-hydration` to record
> the one deferred piece of that slice. The reusable build-time hydrator
> (`src/lib/renderer/publish/hydrateBindings.ts`) and its preview-parity
> assertion against `HeadlessPageRenderer` have ALREADY landed. What remains is
> purely the WIRING, which is GATED on the static-html wave because the publish
> pipeline files do not exist yet.

## Why this is gated

`slice2-publish-read-binding-hydration` built the helper but deliberately did NOT
wire it into any emitter, because:

- `projectPublisher.ts` and the per-page `staticHtmlEmitter.ts` do NOT exist yet.
  They are introduced by the static-html wave (`static-html-spike`,
  `static-html-publish-pipeline`).
- The hydrator is intentionally call-site-ready: the options-object signature
  `hydrateBindings(pageTree, pageParams, { cmsRepo })` means wave-pickup is a
  one-line call, no re-derivation of resolver logic.

## What to do when the static-html wave lands

In the per-page emitter, BEFORE serializing a page to static HTML:

```ts
import { getCmsRepository } from '@/server/cms';
import { hydrateBindings } from '@/lib/renderer/publish/hydrateBindings';

const hydratedTree = await hydrateBindings(pageTree, pageParams, {
  cmsRepo: getCmsRepository(),
});
// ...then serialize hydratedTree instead of the raw bound tree.
```

The TODO that points here lives at the top of
`src/lib/renderer/publish/hydrateBindings.ts`.

## Out of scope (still)

- Commerce hydration: `trackc-commerce-binding-preview-and-publish-hydration`
  EXTENDS the helper's options-object to `{ cmsRepo, commerceRepo }` additively.
- Client-side runtime island hydration: a separate wave-3 surface.

## References

- Helper + parity test: `slice2-publish-read-binding-hydration` (status: done).
- Gated on: `static-html-spike`, `static-html-publish-pipeline`.
