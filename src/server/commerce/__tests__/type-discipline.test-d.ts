// src/server/commerce/__tests__/type-discipline.test-d.ts
//
// CM-05 — the public-prefix discipline PROOF, enforced by the verify gate.
//
// This is a TYPE-ONLY test: it is checked by `pnpm exec tsc --noEmit` (the
// verify gate), NOT executed. The `.test-d.ts` suffix keeps it out of the
// vitest unit run (vitest.config.ts matches only `*.{test,spec}.{ts,tsx}`), so
// nothing here ever runs — the function below is declared and never called.
//
// The `@ts-expect-error` directives are the assertions: each one REQUIRES the
// statement beneath it to fail to compile. If a bare-global query ever started
// type-checking (the discipline regressed), the directive would become unused
// and `tsc --noEmit` would FAIL with "Unused '@ts-expect-error' directive".
// That makes the public-prefix wall a compile-time gate, in-loop, with no
// separate type-test runner.
//
// What we prove against `tenantDb(getCommerceBase(), <tg>)` (a
// `Kysely<CommerceDB>` whose bare identifiers resolve to `tg_<id>.<table>`):
//   1. `.selectFrom('tenant_groups')`        — BARE GLOBAL → COMPILE ERROR.
//   2. `.selectFrom('public.tenant_groups')` — qualified global → compiles.
//   3. `.selectFrom('product')`              — bare commerce table → compiles.

import { assertTenantGroupId } from '@marlinjai/tenant-db';
import { getCommerceBase, tenantDb } from '../db';

// Never called: this module exists purely so `tsc` checks the bodies below.
export function _commercePublicPrefixDisciplineProbe(): void {
  const db = tenantDb(
    getCommerceBase(),
    assertTenantGroupId('018f9c10-0000-7000-8000-0000000000d5'),
  );

  // (1) A global table referenced BARE must NOT compile: the only key for the
  // registry is `public.tenant_groups`. Forgetting `public.` would otherwise
  // silently resolve against the tenant schema (the cross-tenant decoy hazard).
  // @ts-expect-error 'tenant_groups' is a global; only 'public.tenant_groups' is a valid key.
  db.selectFrom('tenant_groups');

  // (2) The same global, `public.`-qualified, compiles (no decoy fallback).
  db.selectFrom('public.tenant_groups');

  // (3) A per-tenant commerce table referenced BARE compiles and resolves to
  // `tg_<id>.product` via withSchema.
  db.selectFrom('product');

  // (4) Conversely, a commerce table referenced WITH a `public.` prefix must NOT
  // compile: commerce tables exist ONLY as bare keys. This keeps the two
  // namespaces disjoint (no `public.product` decoy path).
  // @ts-expect-error 'public.product' is not a key; commerce tables are bare-only.
  db.selectFrom('public.product');
}
