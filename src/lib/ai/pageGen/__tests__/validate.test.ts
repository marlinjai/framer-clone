// Repair-or-reject for model output (src/lib/ai/pageGen/validate.ts).

import { describe, expect, it } from 'vitest';
import ComponentModel from '@/models/ComponentModel';
import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { validateGeneration, type GeneratedNodeSnapshot } from '../validate';
import { deriveBreakpointKeys, GENERATION_LIMITS, PLACEHOLDER_IMAGE_SRC } from '../schema';

const breakpoints = deriveBreakpointKeys([
  { label: 'Desktop', minWidth: 1280 },
  { label: 'Tablet', minWidth: 768 },
  { label: 'Mobile', minWidth: 320 },
]);

function counter() {
  let n = 0;
  return () => `id${(n += 1)}`;
}

function ok(raw: unknown) {
  const out = validateGeneration(raw, { breakpoints, newId: counter() });
  if (!out.ok) throw new Error(`expected ok, got errors: ${out.errors.join('; ')}`);
  return out.result;
}

function rejected(raw: unknown) {
  const out = validateGeneration(raw, { breakpoints, newId: counter() });
  if (out.ok) throw new Error('expected a rejection');
  return out.errors;
}

describe('validateGeneration: accepts and normalises', () => {
  it('builds MST-valid snapshots with fresh ids and parentId on nested nodes', () => {
    const result = ok({
      title: 'Landing',
      nodes: [
        {
          id: 'model-chosen-id',
          type: 'section',
          label: 'Hero',
          props: { style: { padding: '64px', display: 'flex' } },
          children: [
            { type: 'h1', props: { children: 'Build faster' } },
            { type: 'a', props: { children: 'Docs', href: '/docs', target: '_blank' } },
          ],
        },
      ],
    });
    const [hero] = result.nodes;
    expect(hero.id).toBe('section-id1');
    expect(hero.parentId).toBeUndefined();
    expect(hero.children.map((c) => c.parentId)).toEqual([hero.id, hero.id]);
    expect(hero.children[0].label).toBe('H1');
    expect(hero.children[1].props).toMatchObject({ children: 'Docs', href: '/docs', target: '_blank' });
    expect(result.title).toBe('Landing');
    expect(result.stats).toEqual({ nodeCount: 3, maxDepth: 2 });
    // The final gate really is MST.
    expect(() => ComponentModel.create(hero)).not.toThrow();
  });

  it('merges preset defaults under the model props, model style keys win', () => {
    const result = ok({ nodes: [{ type: 'div', preset: 'card', props: { style: { padding: '32px' } } }] });
    const card = result.nodes[0];
    const defaults = COMPONENT_REGISTRY.card.defaultProps.style as Record<string, unknown>;
    expect(card.label).toBe('Card');
    expect(card.id.startsWith('card-')).toBe(true);
    expect(card.props.style).toMatchObject({ ...defaults, padding: '32px' });
  });

  it('turns a registry id used as type into its preset', () => {
    const result = ok({ nodes: [{ type: 'stack' }] });
    expect(result.nodes[0].type).toBe('div');
    expect(result.nodes[0].props.style).toMatchObject({ display: 'flex', flexDirection: 'column' });
    expect(result.warnings.some((w) => w.includes('is a preset, not a tag'))).toBe(true);
  });

  it('maps responsive keys to breakpoint keys and pins the primary breakpoint to base', () => {
    const result = ok({
      nodes: [{ type: 'div', props: { style: { padding: { base: '64px', Mobile: '24px', huge: '1px' } } } }],
    });
    expect(result.nodes[0].props.style).toEqual({
      padding: { base: '64px', mobile: '24px', desktop: '64px' },
    });
    expect(result.warnings.some((w) => w.includes('unknown breakpoint key "huge"'))).toBe(true);
  });
});

describe('validateGeneration: repairs', () => {
  it('drops unsupported style keys, converts kebab-case, drops unsafe values', () => {
    const result = ok({
      nodes: [
        {
          type: 'div',
          props: {
            style: {
              'font-size': '18px',
              webkitAppearance: 'none',
              background: 'url(javascript:alert(1))',
              backgroundImage: 'url("data:image/png;base64,xx")',
              color: 'expression(alert(1))',
              opacity: Number.NaN,
            },
          },
        },
      ],
    });
    expect(result.nodes[0].props.style).toEqual({ fontSize: '18px' });
    expect(result.warnings.length).toBeGreaterThanOrEqual(5);
  });

  it('drops event handlers, raw HTML, unsafe links and image sources', () => {
    const result = ok({
      nodes: [
        { type: 'a', props: { children: 'x', href: 'javascript:alert(1)', onClick: 'alert(1)' } },
        { type: 'div', props: { dangerouslySetInnerHTML: { __html: '<b>x</b>' }, className: 'x' } },
        { type: 'img', props: { src: 'data:image/png;base64,xx' }, label: 'Team photo' },
      ],
    });
    const [link, div, img] = result.nodes;
    expect(link.props).toEqual({ children: 'x' });
    expect(div.props).toEqual({});
    expect(img.props).toMatchObject({ src: PLACEHOLDER_IMAGE_SRC, alt: 'Team photo', draggable: false });
  });

  it('drops forbidden tags with their subtree and renames unknown tags to div', () => {
    const result = ok({
      nodes: [
        { type: 'section', children: [{ type: 'script', children: [{ type: 'p' }] }, { type: 'marquee', props: { children: 'hi' } }] },
      ],
    });
    const section = result.nodes[0];
    expect(section.children).toHaveLength(1);
    expect(section.children[0].type).toBe('div');
    expect(result.stats.nodeCount).toBe(2);
  });

  it('keeps text and children by moving the text into a leading text node', () => {
    const result = ok({ nodes: [{ type: 'div', props: { children: 'Intro' }, children: [{ type: 'p', props: { children: 'More' } }] }] });
    const div = result.nodes[0];
    expect(div.props.children).toBeUndefined();
    expect(div.children.map((c) => c.props.children)).toEqual(['Intro', 'More']);
  });

  it('drops children of a void tag and of a data component', () => {
    const result = ok({
      nodes: [
        { type: 'img', props: { src: '/a.png', alt: 'a' }, children: [{ type: 'p' }] },
        { type: 'div', preset: 'productList', children: [{ type: 'p' }] },
      ],
    });
    expect(result.nodes[0].children).toEqual([]);
    expect(result.nodes[1].children).toEqual([]);
    expect(result.nodes[1].props['data-component-kind']).toBe('product-list');
  });

  it('cuts overlong text with a warning', () => {
    const result = ok({ nodes: [{ type: 'p', props: { children: 'a'.repeat(GENERATION_LIMITS.maxTextChars + 10) } }] });
    expect((result.nodes[0].props.children as string).length).toBe(GENERATION_LIMITS.maxTextChars);
  });
});

describe('validateGeneration: rejects', () => {
  it('rejects a non-object, a missing or empty nodes array', () => {
    expect(rejected('hello')[0]).toMatch(/object/);
    expect(rejected({ root: {} })[0]).toMatch(/"nodes" array/);
    expect(rejected({ nodes: [] })[0]).toMatch(/empty/);
  });

  it('rejects a non-object node', () => {
    expect(rejected({ nodes: ['<div>hi</div>'] })[0]).toMatch(/nodes\[0\]: node must be an object/);
  });

  it('rejects output where nothing usable is left', () => {
    expect(rejected({ nodes: [{ type: 'script' }] })[0]).toMatch(/nothing usable/);
  });

  it('rejects more nodes than the budget', () => {
    const many = Array.from({ length: GENERATION_LIMITS.maxNodes + 1 }, () => ({ type: 'p', props: { children: 'x' } }));
    expect(rejected({ nodes: many }).join(' ')).toMatch(/exceed the limit/);
  });

  it('rejects nesting deeper than the budget', () => {
    let node: Record<string, unknown> = { type: 'div' };
    for (let i = 0; i < GENERATION_LIMITS.maxDepth; i++) node = { type: 'div', children: [node] };
    expect(rejected({ nodes: [node] }).join(' ')).toMatch(/nesting deeper/);
  });

  it('rejects duplicate ids (a broken id factory) instead of corrupting the editor later', () => {
    const out = validateGeneration(
      { nodes: [{ type: 'div', children: [{ type: 'div' }] }] },
      { breakpoints, newId: () => 'same' },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0]).toMatch(/duplicate node id/);
  });
});

describe('validateGeneration output shape', () => {
  it('is a plain ComponentSnapshotIn tree (no unknown keys)', () => {
    const result = ok({ nodes: [{ type: 'section', children: [{ type: 'p', props: { children: 'x' } }] }] });
    const keys = (n: GeneratedNodeSnapshot): string[] => [
      ...Object.keys(n),
      ...n.children.flatMap(keys),
    ];
    expect(new Set(keys(result.nodes[0]))).toEqual(
      new Set(['id', 'type', 'componentType', 'label', 'props', 'children', 'parentId']),
    );
  });
});
