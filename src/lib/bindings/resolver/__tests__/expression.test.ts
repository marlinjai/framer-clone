// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseExpression, evaluateExpression } from '../expression';
import {
  createScope,
  pushRowFrame,
  pushCollectionFrame,
  pushPageFrame,
  lookup,
  type BindingScope,
} from '../scope';
import type { Collection, Row } from '@/lib/bindings/dataSource/types';

const collection: Collection = {
  id: 'col_posts',
  slug: 'posts',
  name: 'Posts',
  columns: [
    { id: 'title', name: 'Title', type: 'text' },
    { id: 'body', name: 'Body', type: 'text' },
  ],
};

const row: Row = {
  id: 'row_1',
  values: { title: 'Hello World', body: 'A body', published: true },
};

describe('parseExpression', () => {
  it('parses a single-segment expression', () => {
    expect(parseExpression('{{title}}')).toEqual({
      raw: '{{title}}',
      path: ['title'],
    });
  });

  it('parses a multi-segment row expression', () => {
    expect(parseExpression('{{row.title}}')).toEqual({
      raw: '{{row.title}}',
      path: ['row', 'title'],
    });
  });

  it('parses a deep page-params expression', () => {
    expect(parseExpression('{{page.params.id}}')).toEqual({
      raw: '{{page.params.id}}',
      path: ['page', 'params', 'id'],
    });
  });

  it('tolerates inner whitespace', () => {
    expect(parseExpression('{{  collection.name  }}')?.path).toEqual([
      'collection',
      'name',
    ]);
  });

  it('parses a row binding whose column id is a uuid (hyphens + leading digit)', () => {
    // A CMS column id is a `uuid()` and the binding picker emits
    // `{{row.<columnId>}}` verbatim. The path grammar MUST accept a hyphenated,
    // possibly digit-leading segment, or every real CMS row-field binding would
    // resolve to nothing (a regression the unit fixtures, using clean ids like
    // `title`, could not surface).
    expect(parseExpression('{{row.8f3a9c2e-1b4d-4abc-9e21-0a1b2c3d4e5f}}')).toEqual({
      raw: '{{row.8f3a9c2e-1b4d-4abc-9e21-0a1b2c3d4e5f}}',
      path: ['row', '8f3a9c2e-1b4d-4abc-9e21-0a1b2c3d4e5f'],
    });
  });

  it('returns null for an arithmetic expression', () => {
    expect(parseExpression('{{a + b}}')).toBeNull();
  });

  it('returns null for a filter/pipe expression', () => {
    expect(parseExpression('{{a | upper}}')).toBeNull();
  });

  it('returns null for a method call', () => {
    expect(parseExpression('{{a.b()}}')).toBeNull();
  });

  it('returns null for plain text (no mustache)', () => {
    expect(parseExpression('title')).toBeNull();
  });

  it('returns null for empty mustache', () => {
    expect(parseExpression('{{}}')).toBeNull();
  });

  it('returns null for nested braces', () => {
    expect(parseExpression('{{ {{title}} }}')).toBeNull();
  });

  it('returns null for a non-string input', () => {
    // @ts-expect-error exercising the runtime guard
    expect(parseExpression(42)).toBeNull();
  });
});

describe('lookup', () => {
  it('resolves a single segment against the innermost row frame', () => {
    const scope = pushRowFrame(createScope(), row);
    expect(lookup(scope, ['title'])).toBe('Hello World');
  });

  it('resolves row.<field> against row.values', () => {
    const scope = pushRowFrame(createScope(), row);
    expect(lookup(scope, ['row', 'title'])).toBe('Hello World');
    expect(lookup(scope, ['row', 'published'])).toBe(true);
  });

  it('resolves collection.<field> against the collection object', () => {
    const scope = pushCollectionFrame(createScope(), collection);
    expect(lookup(scope, ['collection', 'name'])).toBe('Posts');
    expect(lookup(scope, ['collection', 'slug'])).toBe('posts');
  });

  it('resolves page.params.id against the page frame', () => {
    const scope = pushPageFrame(createScope(), { id: '42' });
    expect(lookup(scope, ['page', 'params', 'id'])).toBe('42');
  });

  it('resolves against the INNERMOST row frame when nested', () => {
    const outer: Row = { id: 'r_outer', values: { title: 'Outer' } };
    const inner: Row = { id: 'r_inner', values: { title: 'Inner' } };
    const scope = pushRowFrame(pushRowFrame(createScope(), outer), inner);
    expect(lookup(scope, ['title'])).toBe('Inner');
  });

  it('returns undefined (never throws) on an unknown column', () => {
    const scope = pushRowFrame(createScope(), row);
    expect(lookup(scope, ['nope'])).toBeUndefined();
    expect(lookup(scope, ['row', 'nope'])).toBeUndefined();
  });

  it('returns undefined when the required frame is absent', () => {
    const scope = createScope();
    expect(lookup(scope, ['title'])).toBeUndefined();
    expect(lookup(scope, ['collection', 'name'])).toBeUndefined();
    expect(lookup(scope, ['page', 'params', 'id'])).toBeUndefined();
  });

  it('returns undefined for an empty path', () => {
    const scope = pushRowFrame(createScope(), row);
    expect(lookup(scope, [])).toBeUndefined();
  });

  it('returns undefined for a deep path that bottoms out early', () => {
    const scope = pushRowFrame(createScope(), row);
    expect(lookup(scope, ['title', 'length'])).toBeUndefined();
  });
});

describe('evaluateExpression', () => {
  it('evaluates a parsed expression against a scope', () => {
    const scope: BindingScope = pushCollectionFrame(
      pushRowFrame(createScope(), row),
      collection,
    );
    const expr = parseExpression('{{row.title}}');
    expect(expr).not.toBeNull();
    expect(evaluateExpression(expr!, scope)).toBe('Hello World');
    expect(evaluateExpression(parseExpression('{{collection.name}}')!, scope)).toBe(
      'Posts',
    );
  });

  it('returns undefined (never throws) on a miss', () => {
    const scope = pushRowFrame(createScope(), row);
    expect(evaluateExpression(parseExpression('{{missing}}')!, scope)).toBeUndefined();
  });
});
