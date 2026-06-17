---
name: followon-wire-commerce-hydratebindings-publish
track: storefront
wave: static-html
priority: P1
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [trackc-commerce-binding-preview-and-publish-hydration, static-html-spike, static-html-publish-pipeline]
touchesSharedState: false
sharedState: []
estimateDays: 1
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Follow-on stub: wire the commerce bake of hydrateBindings into the static-publish pipeline

> STUB / placeholder. Created by `trackc-commerce-binding-preview-and-publish-hydration`
> to record the one deferred piece of that spec. The commerce bake in the
> reusable build-time hydrator (`src/lib/renderer/publish/hydrateBindings.ts`)
> and its preview-parity assertions have ALREADY landed. What remains is purely
> the WIRING, which is GATED on the static-html wave because the publish
> pipeline files do not exist yet. This is the commerce sibling of
> `followon-wire-hydratebindings-into-publish.md` (the CMS stub).

## Why this is gated

`trackc-commerce-binding-preview-and-publish-hydration` extended the helper but
deliberately did NOT wire it into any emitter, because:

- `projectPublisher.ts` and the per-page `staticHtmlEmitter.ts` do NOT exist yet.
  They are introduced by the static-html wave (`static-html-spike`,
  `static-html-publish-pipeline`), the SAME gate as the CMS hydration wiring.
- The hydrator is intentionally call-site-ready: the additive options-object
  signature `hydrateBindings(pageTree, pageParams, { cmsRepo, commerceRepo })`
  means wave-pickup is a one-line call, no re-derivation of resolver logic.

## What to do when the static-html wave lands

In the per-page emitter, BEFORE serializing a page to static HTML, pass the
commerce repo alongside the CMS repo:

```ts
import { getCmsRepository } from '@/server/cms';
import { getCommerceServerRepository } from '@/server/commerce';
import { hydrateBindings } from '@/lib/renderer/publish/hydrateBindings';

const hydratedTree = await hydrateBindings(pageTree, pageParams, {
  cmsRepo: getCmsRepository(),
  commerceRepo: getCommerceServerRepository(),
});
// ...then serialize hydratedTree instead of the raw bound tree.
```

The commerce repo is read DIRECTLY in Node (no HTTP); the Track-0 Prisma
singleton stays lazy (connects on first query, not on import), so compiling the
`src/server/commerce` import in `next build` does NOT need a live `DATABASE_URL`.
The TODO that points here lives at the top of
`src/lib/renderer/publish/hydrateBindings.ts`.

## Out of scope (still)

- Client-side runtime-island hydration for the INTERACTIVE commerce kinds
  (variant-selector / add-to-cart / cart-view / checkout-button). The commerce
  bake leaves these VERBATIM as runtime islands; turning them into hydrated
  client islands on the published site is a separate static-html-wave surface.

## References

- Helper + parity tests: `trackc-commerce-binding-preview-and-publish-hydration` (status: done).
- CMS sibling stub: `followon-wire-hydratebindings-into-publish.md`.
- Gated on: `static-html-spike`, `static-html-publish-pipeline`.
