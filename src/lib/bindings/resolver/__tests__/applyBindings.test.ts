// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  applyBindings,
  LOADING_SENTINEL,
  type ComponentNode,
} from '../applyBindings';
import {
  createScope,
  pushRowFrame,
  pushPageFrame,
  type BindingScope,
} from '../scope';
import type { Row } from '@/lib/bindings/dataSource/types';
import type { BindingsRecord } from '@/lib/bindings/types';

const row: Row = {
  id: 'row_1',
  values: { title: 'Hello World', color: 'tomato', missing: null },
};

function rowScope(r: Row = row): BindingScope {
  return pushRowFrame(createScope(), r);
}

describe('applyBindings — merge', () => {
  it('merges a resolved value into props.children for a Text node', () => {
    const node: ComponentNode = {
      type: 'text',
      bindings: { children: { mode: 'read', expression: '{{title}}' } },
    };
    const { resolvedProps, isLoading } = applyBindings(
      node,
      { children: 'fallback' },
      rowScope(),
    );
    expect(resolvedProps.children).toBe('Hello World');
    expect(isLoading).toBe(false);
  });

  it('merges a resolved value into a dot-path style slot', () => {
    const node: ComponentNode = {
      type: 'text',
      bindings: { 'style.color': { mode: 'read', expression: '{{color}}' } },
    };
    const { resolvedProps } = applyBindings(
      node,
      { style: { color: 'black', fontSize: 16 } },
      rowScope(),
    );
    expect(resolvedProps.style).toEqual({ color: 'tomato', fontSize: 16 });
  });

  it('resolves page.params.id into a slot', () => {
    const node: ComponentNode = {
      bindings: { children: { mode: 'read', expression: '{{page.params.id}}' } },
    };
    const scope = pushPageFrame(createScope(), { id: '42' });
    expect(applyBindings(node, {}, scope).resolvedProps.children).toBe('42');
  });

  it('does NOT mutate baseProps (style is cloned)', () => {
    const baseStyle = { color: 'black' };
    const baseProps = { style: baseStyle };
    const node: ComponentNode = {
      bindings: { 'style.color': { mode: 'read', expression: '{{color}}' } },
    };
    applyBindings(node, baseProps, rowScope());
    expect(baseStyle.color).toBe('black');
  });

  it('leaves the base prop when the expression cannot be parsed', () => {
    const node: ComponentNode = {
      bindings: { children: { mode: 'read', expression: '{{a + b}}' } },
    };
    expect(
      applyBindings(node, { children: 'fallback' }, rowScope()).resolvedProps.children,
    ).toBe('fallback');
  });

  it('leaves the base prop when the value resolves to undefined', () => {
    const node: ComponentNode = {
      bindings: { children: { mode: 'read', expression: '{{nope}}' } },
    };
    expect(
      applyBindings(node, { children: 'fallback' }, rowScope()).resolvedProps.children,
    ).toBe('fallback');
  });

  it('ignores write / two-way bindings', () => {
    const bindings: BindingsRecord = {
      children: { mode: 'read', expression: '{{title}}' },
      value: { mode: 'write', collectionId: 'c', field: 'f' },
    };
    const { resolvedProps } = applyBindings(
      { bindings },
      { children: 'fallback', value: 'untouched' },
      rowScope(),
    );
    expect(resolvedProps.children).toBe('Hello World');
    expect(resolvedProps.value).toBe('untouched');
  });

  it('handles a node with no bindings', () => {
    const { resolvedProps, isLoading } = applyBindings({}, { children: 'x' }, rowScope());
    expect(resolvedProps).toEqual({ children: 'x' });
    expect(isLoading).toBe(false);
  });
});

describe('applyBindings — isLoading', () => {
  it('returns isLoading:true when a slot resolves to LOADING_SENTINEL', () => {
    const loadingRow: Row = {
      id: 'row_loading',
      // The sentinel is a symbol; the row value bag tolerates it at runtime.
      values: { title: LOADING_SENTINEL as unknown as string },
    };
    const node: ComponentNode = {
      bindings: { children: { mode: 'read', expression: '{{title}}' } },
    };
    const { resolvedProps, isLoading } = applyBindings(
      node,
      { children: 'fallback' },
      rowScope(loadingRow),
    );
    expect(isLoading).toBe(true);
    // The base prop is left untouched (the sentinel is not merged in).
    expect(resolvedProps.children).toBe('fallback');
  });

  it('isLoading stays false when every slot resolves', () => {
    const node: ComponentNode = {
      bindings: { children: { mode: 'read', expression: '{{title}}' } },
    };
    expect(applyBindings(node, {}, rowScope()).isLoading).toBe(false);
  });
});

describe('resolver runtime — node environment', () => {
  it('runs under environment:node (no jsdom globals)', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('produces identical output for the same (binding, scope) inputs', () => {
    const node: ComponentNode = {
      bindings: {
        children: { mode: 'read', expression: '{{title}}' },
        'style.color': { mode: 'read', expression: '{{color}}' },
      },
    };
    const scope = rowScope();
    const a = applyBindings(node, { children: 'x', style: {} }, scope);
    const b = applyBindings(node, { children: 'x', style: {} }, scope);
    expect(a).toEqual(b);
    expect(a.resolvedProps).toEqual({
      children: 'Hello World',
      style: { color: 'tomato' },
    });
  });
});

describe('resolver module — no React import', () => {
  it('contains zero React imports across src/lib/bindings/resolver/*', () => {
    const resolverDir = path.resolve(__dirname, '..');
    const sources = readdirSync(resolverDir).filter((f) => f.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const contents = readFileSync(path.join(resolverDir, file), 'utf8');
      expect(contents).not.toMatch(/from\s+['"]react['"]/);
      expect(contents).not.toMatch(/from\s+['"]react-dom['"]/);
      expect(contents).not.toMatch(/import\s+React\b/);
      expect(contents).not.toMatch(/require\(\s*['"]react['"]\s*\)/);
    }
  });
});
