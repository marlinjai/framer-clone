// InMemoryDataSourceProvider — fixture-backed implementation of
// DataSourceProvider used until the cms track ships its HTTP client. Lives
// in-process; safe to mount in both the editor and the preview shell. Has a
// `_mutate` test helper so unit tests can verify subscribe fires on change.

import type { DataSourceProvider } from './provider';
import type {
  Collection,
  FilterClause,
  Query,
  Row,
  RowValue,
  RowsPage,
  SortClause,
} from './types';

interface Seed {
  collections: Collection[];
  rows: Record<string, Row[]>;
}

// Default seed data. Two collections with realistic-shape rows so the
// editor + binding picker have something useful to show in dev. Edit
// freely; this is fixture data, not a contract.
const DEFAULT_SEED: Seed = {
  collections: [
    {
      id: 'col_posts',
      slug: 'posts',
      name: 'Posts',
      columns: [
        { id: 'title', name: 'Title', type: 'text' },
        { id: 'body', name: 'Body', type: 'text' },
        { id: 'published_at', name: 'Published', type: 'date' },
      ],
    },
    {
      id: 'col_team',
      slug: 'team',
      name: 'Team',
      columns: [
        { id: 'name', name: 'Name', type: 'text' },
        { id: 'role', name: 'Role', type: 'text' },
        { id: 'photo', name: 'Photo', type: 'file' },
      ],
    },
  ],
  rows: {
    col_posts: [
      {
        id: 'post_1',
        values: {
          title: 'Hello, world',
          body: 'First post on the new CMS.',
          published_at: '2026-04-01',
        },
      },
      {
        id: 'post_2',
        values: {
          title: 'Shipping data bindings',
          body: 'How the new binding shape works.',
          published_at: '2026-04-15',
        },
      },
      {
        id: 'post_3',
        values: {
          title: 'Wave 2 progress',
          body: 'Resolver and editor binding picker landing.',
          published_at: '2026-05-01',
        },
      },
    ],
    col_team: [
      {
        id: 'team_1',
        values: {
          name: 'Marlin Pohl',
          role: 'CEO',
          photo: 'https://example.com/marlin.png',
        },
      },
      {
        id: 'team_2',
        values: {
          name: 'Ada Lovelace',
          role: 'Engineer',
          photo: 'https://example.com/ada.png',
        },
      },
      {
        id: 'team_3',
        values: {
          name: 'Grace Hopper',
          role: 'Engineer',
          photo: 'https://example.com/grace.png',
        },
      },
    ],
  },
};

// Deep-ish clone for fixture seed isolation. Sufficient for plain JSON values.
function cloneSeed(seed: Seed): Seed {
  return {
    collections: seed.collections.map((c) => ({
      ...c,
      columns: c.columns.map((col) => ({ ...col })),
    })),
    rows: Object.fromEntries(
      Object.entries(seed.rows).map(([k, v]) => [
        k,
        v.map((r) => ({ id: r.id, values: { ...r.values } })),
      ]),
    ),
  };
}

function compareValues(a: RowValue, b: RowValue): number {
  // null sorts last in ascending order.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return Number(a) - Number(b);
  }
  // Arrays and mixed types fall through to string compare for stability.
  const as = Array.isArray(a) ? a.join(',') : String(a);
  const bs = Array.isArray(b) ? b.join(',') : String(b);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

function matchesFilter(row: Row, clause: FilterClause): boolean {
  const cell = row.values[clause.column];
  switch (clause.op) {
    case 'eq':
      // Array vs scalar: treat array contains-match for parity with multi-select
      if (Array.isArray(cell)) {
        return clause.value !== null && cell.includes(clause.value as string);
      }
      return cell === clause.value;
    case 'ne':
      if (Array.isArray(cell)) {
        return clause.value === null || !cell.includes(clause.value as string);
      }
      return cell !== clause.value;
    case 'gt':
      return compareValues(cell, clause.value) > 0;
    case 'lt':
      return compareValues(cell, clause.value) < 0;
    case 'contains': {
      if (cell === null || cell === undefined) return false;
      if (Array.isArray(cell)) {
        return clause.value !== null && cell.includes(clause.value as string);
      }
      return String(cell)
        .toLowerCase()
        .includes(String(clause.value).toLowerCase());
    }
    default:
      return false;
  }
}

function applyQuery(rows: Row[], query: Query | undefined): Row[] {
  let out = rows;

  if (query?.filter && query.filter.length > 0) {
    out = out.filter((r) =>
      query.filter!.every((clause) => matchesFilter(r, clause)),
    );
  }

  if (query?.sort && query.sort.length > 0) {
    const sortClauses: SortClause[] = query.sort;
    // Stable sort with multi-key comparison. Array#sort in modern JS engines
    // is guaranteed stable, so a single .sort() with a composite comparator
    // is sufficient.
    out = [...out].sort((a, b) => {
      for (const clause of sortClauses) {
        const cmp = compareValues(a.values[clause.column], b.values[clause.column]);
        if (cmp !== 0) return clause.direction === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }

  if (typeof query?.limit === 'number' && query.limit >= 0) {
    out = out.slice(0, query.limit);
  }

  return out;
}

interface Subscription {
  collectionId: string;
  onChange: () => void;
}

export class InMemoryDataSourceProvider implements DataSourceProvider {
  private seed: Seed;
  private subscriptions = new Set<Subscription>();

  constructor(seed: Seed = DEFAULT_SEED) {
    this.seed = cloneSeed(seed);
  }

  async listCollections(): Promise<Collection[]> {
    return this.seed.collections.map((c) => ({
      ...c,
      columns: c.columns.map((col) => ({ ...col })),
    }));
  }

  async getCollection(collectionId: string): Promise<Collection | null> {
    const found = this.seed.collections.find((c) => c.id === collectionId);
    if (!found) return null;
    return {
      ...found,
      columns: found.columns.map((col) => ({ ...col })),
    };
  }

  async listRows(collectionId: string, query?: Query): Promise<RowsPage> {
    const rows = this.seed.rows[collectionId] ?? [];
    const filtered = applyQuery(rows, query);
    return {
      rows: filtered.map((r) => ({ id: r.id, values: { ...r.values } })),
      total: rows.length,
    };
  }

  async getRow(collectionId: string, rowId: string): Promise<Row | null> {
    const rows = this.seed.rows[collectionId] ?? [];
    const found = rows.find((r) => r.id === rowId);
    if (!found) return null;
    return { id: found.id, values: { ...found.values } };
  }

  subscribe(
    collectionId: string,
    _query: Query | undefined,
    onChange: () => void,
  ): () => void {
    const sub: Subscription = { collectionId, onChange };
    this.subscriptions.add(sub);
    return () => {
      this.subscriptions.delete(sub);
    };
  }

  /**
   * Test-only mutation hook. Lets the unit test trigger a change without a
   * write API. The cms HTTP client will be tested separately and won't need
   * this hatch.
   */
  _mutate(mutator: (seed: Seed) => void): void {
    mutator(this.seed);
    this.notify();
  }

  private notify(): void {
    // Snapshot to avoid mutation-during-iteration if a callback unsubscribes
    // synchronously.
    [...this.subscriptions].forEach((sub) => {
      try {
        sub.onChange();
      } catch {
        // Swallow listener errors so one bad subscriber can't take down the
        // notification fan-out. Not logging here to keep the in-memory
        // provider quiet in test runs.
      }
    });
  }
}

/**
 * Lazy singleton for app-wide use. The editor and preview shell both mount
 * the same instance so a future write API mutating one is visible from the
 * other. Tests should construct their own instance to stay isolated.
 */
let sharedInstance: InMemoryDataSourceProvider | null = null;

export function getSharedInMemoryDataSourceProvider(): InMemoryDataSourceProvider {
  if (!sharedInstance) {
    sharedInstance = new InMemoryDataSourceProvider();
  }
  return sharedInstance;
}
