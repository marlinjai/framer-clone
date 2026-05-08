---
name: data-bindings-data-source-provider-interface
track: data-bindings
wave: 1
priority: P0
status: draft
depends_on: []
estimated_value: 8
estimated_cost: 4
owner: unassigned
---

# Data source provider interface and in-memory mock

## Goal

Define the abstract `DataSourceProvider` interface the renderer uses to read collections and rows. Ship an in-memory mock provider so the data-bindings track can build and test wave-2 components independently of the `cms` track's HTTP service. When the `cms` track ships its client, it implements the same interface and is swapped in via a single root-level `DataSourceProviderContext` provider.

This is the seam that decouples component-side data-bindings from CMS-service-side delivery. It is the boundary the strategic thesis names: data-bindings track owns "the component side", `cms` track owns "the API". This spec writes the contract between them.

## Scope

**In:**

- `DataSourceProvider` interface in `src/lib/bindings/dataSource/provider.ts` with the read-only Phase 1 surface: `listCollections`, `getCollection`, `listRows`, `getRow`, `subscribe` (polling-style change notification).
- An `InMemoryDataSourceProvider` implementation in `src/lib/bindings/dataSource/inMemoryProvider.ts` backed by hardcoded fixture collections. This unblocks editor + renderer development before the `cms` HTTP client exists.
- React context + hook: `DataSourceProviderContext`, `useDataSource()`. Mounted near the root in `EditorApp` and `PreviewShell`. The renderer uses the hook to read data; never imports a provider directly.
- Type definitions for `Collection`, `Column`, `Row`, `Query` (filter / sort / limit) shared with the wave-2 resolver and editor binding picker.
- Phase 2 placeholder: provider interface MUST reserve method slots for `createRow`, `updateRow`, `deleteRow` as `// Phase 2` typed-but-not-implemented members of an extended `WriteDataSourceProvider extends DataSourceProvider`. Phase 1 components only depend on `DataSourceProvider`. Reserving the extension type avoids a contract break when Form lands.

**Out (explicitly deferred):**

- HTTP client to `cms.lumitra.co`. Owned by the `cms` track. This spec just defines what shape the HTTP client must produce on the consuming side.
- Write methods (createRow / updateRow / deleteRow). Phase 2 only.
- WebSocket / SSE subscription. Phase 1 polling only via `subscribe` returning a timer-based interval. Phase 2 may swap for real push channels.
- Authentication context for end-user scoped reads. Phase 1 only has site-owner reads.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/bindings/dataSource/types.ts` | new | `Collection`, `Column`, `Row`, `Query` types. |
| `src/lib/bindings/dataSource/provider.ts` | new | `DataSourceProvider` interface and `WriteDataSourceProvider` extension stub. |
| `src/lib/bindings/dataSource/inMemoryProvider.ts` | new | Fixture-backed provider for editor + tests. Ships with two seed collections (e.g. `posts`, `team`) with realistic shape. |
| `src/lib/bindings/dataSource/context.tsx` | new | React context + `useDataSource()` hook. Throws if used outside a provider. |
| `src/components/EditorApp.tsx` | edit | Wrap children with `DataSourceProviderContext.Provider value={inMemoryProvider}`. |
| `src/components/preview/PreviewShell.tsx` | edit | Same wrap with the same in-memory provider for Phase 1. Phase 2 swaps for the real HTTP client. |
| `src/lib/bindings/dataSource/__tests__/inMemoryProvider.test.ts` | new | Unit tests for filter / sort / limit / subscribe. |

## API surface

```ts
// src/lib/bindings/dataSource/types.ts
export type ColumnType =
  | 'text' | 'number' | 'boolean' | 'date'
  | 'select' | 'multi-select' | 'relation' | 'file';

export interface Column {
  id: string;        // stable slug, owned by cms track
  name: string;      // display label
  type: ColumnType;
}

export interface Collection {
  id: string;        // stable identifier, owned by cms track
  slug: string;
  name: string;
  columns: Column[];
}

export type RowValue = string | number | boolean | null | string[];

export interface Row {
  id: string;
  values: Record<string, RowValue>; // keyed by column.id
}

export interface Query {
  filter?: Array<{ column: string; op: 'eq' | 'ne' | 'gt' | 'lt' | 'contains'; value: RowValue }>;
  sort?: Array<{ column: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  cursor?: string;
}

export interface RowsPage {
  rows: Row[];
  nextCursor?: string;
  total?: number;
}

// src/lib/bindings/dataSource/provider.ts
export interface DataSourceProvider {
  listCollections(): Promise<Collection[]>;
  getCollection(collectionId: string): Promise<Collection | null>;
  listRows(collectionId: string, query?: Query): Promise<RowsPage>;
  getRow(collectionId: string, rowId: string): Promise<Row | null>;

  // Polling-style subscription. Returns an unsubscribe function. The provider
  // calls `onChange` whenever data the query depends on may have changed.
  // Phase 1 in-memory provider invokes immediately + on internal mutate;
  // future HTTP provider polls every ~5s, pushed real-time deferred to Phase 2.
  subscribe(
    collectionId: string,
    query: Query | undefined,
    onChange: () => void,
  ): () => void;
}

// Phase 2 stub. NOT implemented. Reserved so Form / write-bindings have
// somewhere to live without a Phase 1 contract change.
export interface WriteDataSourceProvider extends DataSourceProvider {
  createRow(collectionId: string, values: Record<string, RowValue>): Promise<Row>;
  updateRow(collectionId: string, rowId: string, values: Record<string, RowValue>): Promise<Row>;
  deleteRow(collectionId: string, rowId: string): Promise<void>;
}

// src/lib/bindings/dataSource/context.tsx
export const DataSourceProviderContext: React.Context<DataSourceProvider | null>;
export function useDataSource(): DataSourceProvider;
```

## Data shapes

```ts
// In-memory fixtures shipped with InMemoryDataSourceProvider
const seed: { collections: Collection[]; rows: Record<string, Row[]> } = {
  collections: [
    {
      id: 'col_posts',
      slug: 'posts',
      name: 'Posts',
      columns: [
        { id: 'title', name: 'Title', type: 'text' },
        { id: 'body',  name: 'Body',  type: 'text' },
        { id: 'published_at', name: 'Published', type: 'date' },
      ],
    },
    {
      id: 'col_team',
      slug: 'team',
      name: 'Team',
      columns: [
        { id: 'name',  name: 'Name',  type: 'text' },
        { id: 'role',  name: 'Role',  type: 'text' },
        { id: 'photo', name: 'Photo', type: 'file' },
      ],
    },
  ],
  rows: {
    col_posts: [/* 3 to 5 fixture rows */],
    col_team:  [/* 3 to 5 fixture rows */],
  },
};
```

## Test plan

- [ ] Unit: `inMemoryProvider.listCollections()` returns the two fixture collections.
- [ ] Unit: `listRows('col_posts', { sort: [{ column: 'published_at', direction: 'desc' }] })` returns rows in descending date order.
- [ ] Unit: filter `{ column: 'role', op: 'eq', value: 'CEO' }` narrows to expected rows.
- [ ] Unit: `subscribe` callback fires when an internal `_mutate` test helper modifies the seed. Unsubscribe stops further callbacks.
- [ ] Unit: `useDataSource()` outside a provider throws a descriptive error.
- [ ] Integration: a wave-2 component test (in resolver spec) imports `useDataSource`, mounts under `DataSourceProviderContext.Provider value={inMemoryProvider}`, reads a row, asserts render.

## Definition of done

- [ ] Code lands and typechecks.
- [ ] Tests pass via `pnpm test`.
- [ ] EditorApp + PreviewShell mount the in-memory provider; nothing else changes in the editor visually until wave-2.
- [ ] `WriteDataSourceProvider` interface exists but is not used by any Phase 1 code.
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- **Cross-track contract with `cms`.** This spec ASSUMES the `cms` track delivers an HTTP client that satisfies `DataSourceProvider`. The `cms` track may want to model the API differently (e.g. server-side rendered HTML for static publish, GraphQL, etc.). Confirm with `cms` track lead that the four-method read surface (`listCollections`, `getCollection`, `listRows`, `getRow`) is implementable by their planned API, OR negotiate the boundary.
- **Polling interval.** Phase 1 docs mention "every 5 seconds refetch". This spec leaves the in-memory provider's `subscribe` event-driven and lets the future HTTP provider decide its own polling cadence. Confirm 5s default with `cms` track.
- **Cursor format.** Cursor-based pagination is in scope per the CMS plan (Research question 5, "Pagination 1.0 weeks"). The cursor is an opaque string here. `cms` track owns the encoding.
- **Authentication.** Phase 1 site-owner-only data should pass the auth-brain session cookie automatically when the HTTP client lands. The interface here doesn't expose an auth field because it's an HTTP-transport concern. Confirm this stays out-of-scope of the provider interface.
- **Static HTML publish.** The static-html track needs to render bindings at build time. Question for static-html track: does it consume `DataSourceProvider` directly (calling `listRows` at build) or does it ingest a serialized snapshot? This spec assumes the former and runs the same provider in a Node build context. Confirm with static-html track.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Research question 5: 12-13 weeks of binding-layer engineering, with reactivity strategy line item)
- Plan: `docs/plans/2026-05-01-framework-agnostic-renderer-research.md` (renderer is React-only at publish, reads Provider context the same way)
- Spec: `data-bindings-binding-shape-on-component-model` (parallel, no hard dep)
- Code: `src/components/EditorApp.tsx` and `src/components/preview/PreviewShell.tsx` (provider mount points)
- Cross-track: `cms` track HTTP client (sibling spec, not yet written)
