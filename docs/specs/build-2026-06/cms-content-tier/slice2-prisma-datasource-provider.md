---
name: slice2-prisma-datasource-provider
track: cms-content-tier
wave: 1
priority: P0
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [slice2-cms-server-adapter-and-repo]
touchesSharedState: false
sharedState: []
estimateDays: 2
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# PrismaDataSourceProvider over /api/cms read routes, swapped in at the two root mounts

> Depends on `slice2-cms-server-adapter-and-repo`. The provider does NOT import `@marlinjai/doc-tier-core` (gone). The client-side `DataSourceProvider` seam stays a client React context, so the provider reaches the server via thin `/api/cms/*` READ routes (the Track-0 api convention), which call the `src/server/cms` repo. This spec adds NO new package.json dep (adapter-prisma + @prisma/client land in Track 0 / the CMS server spec). Edit anchors are SYMBOL-based (`value={getSharedInMemoryDataSourceProvider()}`), not line numbers.

## Goal

Implement `PrismaDataSourceProvider` satisfying the existing `DataSourceProvider` interface by calling thin `/api/cms/*` read routes (which delegate to the `src/server/cms` read repository), then swap it in at the two root mounts (`EditorApp`, `PreviewShell`). The renderer goes through `useDataSource()` and never imports a concrete provider, so no renderer code changes. `InMemoryDataSourceProvider` is RETAINED as the test double.

## Scope

**In:**
- `src/app/api/cms/collections/route.ts` (GET list), `src/app/api/cms/collections/[id]/route.ts` (GET one), `src/app/api/cms/collections/[id]/rows/route.ts` (GET rows, query in searchParams), `src/app/api/cms/collections/[id]/rows/[rowId]/route.ts` (GET one row). All read routes, UNAUTHENTICATED for v1, `runtime = 'nodejs'`, returning the Track-0 JSON envelope on error. They call `getCmsRepository()`.
- `src/lib/bindings/dataSource/prismaProvider.ts`: `PrismaDataSourceProvider implements DataSourceProvider`, fetching via the `/api/cms/*` routes. `subscribe()` uses polling (default 5s) re-invoking `onChange`.
- Swap at the two root mounts: replace the `value={getSharedInMemoryDataSourceProvider()}` prop on `DataSourceProviderContext.Provider` in `EditorApp.tsx` and `PreviewShell.tsx` with a `PrismaDataSourceProvider`.
- Retain `InMemoryDataSourceProvider` as the isolated-test fixture (do NOT delete).

**Out (explicitly deferred):**
- Real-time push (polling only for Slice 2; SSE/socket is E6).
- WRITE methods + write routes (content-type UI spec).
- Direct RSC reading of the repo for the LIVE client (the build-time hydrator reads the repo directly in Node; the live client goes over HTTP: two readers, one repo).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/app/api/cms/collections/route.ts` | new | GET list, calls getCmsRepository |
| `src/app/api/cms/collections/[id]/route.ts` | new | GET one collection |
| `src/app/api/cms/collections/[id]/rows/route.ts` | new | GET rows (Query in searchParams) |
| `src/app/api/cms/collections/[id]/rows/[rowId]/route.ts` | new | GET one row |
| `src/app/api/cms/__tests__/*.test.ts` | new (node project) | route handlers with the repo mocked |
| `src/lib/bindings/dataSource/prismaProvider.ts` | new | PrismaDataSourceProvider, fetch + polling subscribe |
| `src/components/EditorApp.tsx` | edit | swap the Provider value (symbol anchor) |
| `src/components/preview/PreviewShell.tsx` | edit | same symbol anchor |
| `src/lib/bindings/dataSource/inMemoryProvider.ts` | retain | test double only; do not delete |
| `src/lib/bindings/dataSource/__tests__/prismaProvider.test.ts` | new | contract suite parity (fetch mocked) |

## API surface

```ts
export class PrismaDataSourceProvider implements DataSourceProvider {
  constructor(opts?: { baseUrl?: string; pollMs?: number }); // calls /api/cms/* routes
  listCollections(): Promise<Collection[]>;
  getCollection(id: string): Promise<Collection | null>;
  listRows(id: string, query?: Query): Promise<RowsPage>;
  getRow(id: string, rowId: string): Promise<Row | null>;
  subscribe(collectionId: string, query: Query | undefined, onChange: () => void): () => void; // polling, default 5s
}
// Read routes return: 200 Collection[] / Collection / RowsPage / Row | null;
//                     4xx/5xx the Track-0 { error: { code, message } } envelope.
```

## Test plan

- [ ] `PrismaDataSourceProvider` passes the SAME contract suite `InMemoryDataSourceProvider` passes (listCollections / getCollection / listRows with filter+sort+limit / getRow / subscribe-fires-on-poll), with `fetch` mocked against the route shapes.
- [ ] The `/api/cms/*` read route handlers, with `getCmsRepository` mocked, return the mapped shapes and a 404 (null) / 5xx envelope appropriately; a repo throw surfaces as a 5xx envelope, never a swallowed empty 200.
- [ ] `EditorApp` and `PreviewShell` mount `PrismaDataSourceProvider` (assert via the swapped symbol).
- [ ] Existing renderer tests still green with bindings empty.

## Definition of done

- [ ] `PrismaDataSourceProvider` implements `DataSourceProvider`; contract suite green (fetch mocked).
- [ ] `/api/cms/*` read routes return mapped shapes + surface repo errors as envelopes (never swallow into an empty 200).
- [ ] Both root mounts swapped via the symbol anchor (one site per file, verified unambiguous).
- [ ] `InMemoryDataSourceProvider` retained; a doc note records it is the test double only.
- [ ] NO `@marlinjai/doc-tier-core` import; NO new package.json dep added by this spec.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.
- [ ] No MST mutation.

## Open questions

- None blocking.

## References

- Re-scope brief (2026-06-16): keep the client DataSourceProvider seam; back PrismaDataSourceProvider with `/api/cms/*` read routes; reads unauthenticated for v1.
- Code touchpoints: `src/lib/bindings/dataSource/provider.ts`, `inMemoryProvider.ts` (`getSharedInMemoryDataSourceProvider` symbol, confirmed mounted at `EditorApp.tsx:114` and `preview/PreviewShell.tsx:97`, one site per file), `context.tsx`, `src/lib/api/respond.ts` (Track-0 envelope)
- Depends on: `slice2-cms-server-adapter-and-repo` (getCmsRepository)
