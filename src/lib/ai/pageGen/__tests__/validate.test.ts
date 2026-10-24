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

  it('maps responsive keys to breakpoint keys and keeps base as the value for every breakpoint without its own', () => {
    const result = ok({
      nodes: [{ type: 'div', props: { style: { padding: { base: '64px', Mobile: '24px', huge: '1px' } } } }],
    });
    expect(result.nodes[0].props.style).toEqual({
      padding: { base: '64px', mobile: '24px' },
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

  it('drops style values that could break out into more CSS (; { } backslash, control characters)', () => {
    const result = ok({
      nodes: [
        {
          type: 'div',
          props: {
            style: {
              color: 'red;position:fixed;inset:0;z-index:99999',
              backgroundImage: '\\75 rl(https://evil.example/x.png)',
              background: 'red} body{display:none',
              fontFamily: 'Inter\nposition: fixed',
              border: '1px solid\u0000red',
              padding: { base: '8px', mobile: '4px;margin:0' },
              margin: '0 auto',
            },
          },
        },
      ],
    });
    // Only the clean value survives; the responsive map keeps its clean entries.
    expect(result.nodes[0].props.style).toEqual({
      margin: '0 auto',
      padding: { base: '8px' },
    });
    expect(result.warnings.filter((w) => w.includes('control character'))).toHaveLength(6);
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
    expect(img.props).toMatchObject({ src: PLACEHOLDER_IMAGE_SRC, draggable: false });
    // A missing alt is not filled here (never from the label, never "Image"):
    // the page-essentials screen sends it to the repair round.
    expect(img.props).not.toHaveProperty('alt');
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

describe('validateGeneration: stock-photo queries', () => {
  it('collects an img query with the box shape and keeps it out of the props', () => {
    const result = ok({
      nodes: [
        {
          type: 'section',
          children: [
            { type: 'img', props: { imageQuery: '  fresh   sourdough loaves ', alt: 'Brote', style: { width: '600px', height: '400px' } } },
            { type: 'img', props: { imageQuery: 'baker portrait', style: { width: { desktop: '300px', mobile: '200px' }, height: '450px' } } },
            { type: 'img', preset: 'image', props: { imageQuery: 'flour on a table' } },
            { type: 'img', props: { imageQuery: 'wide shot', style: { width: '100%', height: '400px' } } },
          ],
        },
      ],
    });
    const imgs = result.nodes[0].children;
    expect(result.imageRequests).toEqual([
      { nodeId: imgs[0].id, kind: 'img', query: 'fresh sourdough loaves', orientation: 'landscape', widthPx: 600 },
      { nodeId: imgs[1].id, kind: 'img', query: 'baker portrait', orientation: 'portrait', widthPx: 300 },
      // The Image preset's 240 x 160 box.
      { nodeId: imgs[2].id, kind: 'img', query: 'flour on a table', orientation: 'landscape', widthPx: 240 },
      // A fluid width says nothing about the shape.
      { nodeId: imgs[3].id, kind: 'img', query: 'wide shot' },
    ]);
    for (const img of imgs) {
      expect(img.props).not.toHaveProperty('imageQuery');
      expect(img.props.src).toBe(PLACEHOLDER_IMAGE_SRC); // until the route resolves it
    }
    expect(imgs[0].props.alt).toBe('Brote');
  });

  it('a src from the brief wins over a query', () => {
    const result = ok({ nodes: [{ type: 'img', props: { src: 'https://example.com/a.jpg', imageQuery: 'bread', alt: 'A' } }] });
    expect(result.imageRequests).toEqual([]);
    expect(result.nodes[0].props.src).toBe('https://example.com/a.jpg');
  });

  it('a broken src still lets the query resolve', () => {
    const result = ok({ nodes: [{ type: 'img', props: { src: 'javascript:alert(1)', imageQuery: 'bread', alt: 'A' } }] });
    expect(result.imageRequests.map((r) => r.query)).toEqual(['bread']);
  });

  it.each([
    ['a URL', 'https://example.com/photo'],
    ['markup', '<b>bread</b>'],
    ['too long', 'bread '.repeat(GENERATION_LIMITS.maxImageQueryChars)],
    ['no letters', '1234'],
    ['not a string', 42],
  ])('drops an unusable query (%s) with a warning', (_label, imageQuery) => {
    const result = ok({ nodes: [{ type: 'img', props: { imageQuery, alt: 'A' } }] });
    expect(result.imageRequests).toEqual([]);
    expect(result.warnings.some((w) => w.includes('imageQuery'))).toBe(true);
  });

  it('never accepts a query on anything but an img or a container', () => {
    const result = ok({ nodes: [{ type: 'p', props: { imageQuery: 'bread', children: 'Text' } }] });
    expect(result.imageRequests).toEqual([]);
    expect(result.warnings.some((w) => w.includes('"imageQuery" is not allowed'))).toBe(true);
  });
});

describe('validateGeneration: existing stock photos (replace / insert context)', () => {
  const credit = {
    title: 'anything the model wrote',
    'data-credit-name': 'Ana',
    'data-credit-url': 'https://unsplash.com/@ana?utm_source=lumitra&utm_medium=referral',
    'data-credit-source-url': 'https://unsplash.com/?utm_source=lumitra&utm_medium=referral',
  };
  const src = 'https://images.unsplash.com/photo-1?w=480';

  it('keeps an Unsplash photo that comes back with its credit (title rebuilt from the name)', () => {
    const result = ok({ nodes: [{ type: 'img', props: { src, alt: 'A', ...credit } }] });
    expect(result.nodes[0].props).toMatchObject({ src, title: 'Photo by Ana on Unsplash', 'data-credit-name': 'Ana' });
    expect(result.warnings).toEqual([]);
    expect(result.imageRequests).toEqual([]);
  });

  it('drops an Unsplash photo without a valid credit, so it is never shown unattributed', () => {
    for (const props of [
      { src, alt: 'A' },
      { src, alt: 'A', ...credit, 'data-credit-url': 'https://evil.example/@ana' },
      { src, alt: 'A', ...credit, 'data-credit-name': '<img onerror=x>' },
    ]) {
      const result = ok({ nodes: [{ type: 'img', props: { ...props, imageQuery: 'bread' } }] });
      expect(result.nodes[0].props.src).toBe(PLACEHOLDER_IMAGE_SRC);
      expect(result.nodes[0].props).not.toHaveProperty('data-credit-name');
      expect(result.imageRequests.map((r) => r.query)).toEqual(['bread']); // resolved afresh
    }
  });

  it('never keeps credit attributes on an image that is not an Unsplash photo', () => {
    const result = ok({ nodes: [{ type: 'img', props: { src: 'https://example.com/a.jpg', alt: 'A', ...credit } }] });
    expect(result.nodes[0].props).not.toHaveProperty('data-credit-name');
    expect(result.nodes[0].props).not.toHaveProperty('title');
  });

  it('counts images whose query was unusable', () => {
    const result = ok({
      nodes: [
        { type: 'img', props: { imageQuery: '<b>', alt: 'A' } },
        { type: 'img', props: { imageQuery: '<b>', src: 'https://example.com/a.jpg', alt: 'B' } },
      ],
    });
    expect(result.invalidImageQueries).toBe(1);
  });
});

describe('validateGeneration: font families (the self-hosted library, src/lib/fonts)', () => {
  it('keeps library families with their canonical stack, per responsive entry', () => {
    const result = ok({
      nodes: [
        {
          type: 'h1',
          props: {
            children: 'Hi',
            style: { fontFamily: { base: 'Fraunces, serif', mobile: "'Big Shoulders', sans-serif" } },
          },
        },
      ],
    });
    expect(result.nodes[0].props.style).toMatchObject({
      fontFamily: {
        base: "'Fraunces', Georgia, 'Times New Roman', serif",
        mobile: "'Big Shoulders', 'Arial Narrow', 'Roboto Condensed', Impact, sans-serif",
      },
    });
    expect(result.warnings.some((w) => w.includes('fontFamily'))).toBe(false);
  });

  it('replaces banned and unhosted families by their category default, with a warning', () => {
    const result = ok({
      nodes: [
        { type: 'p', props: { children: 'a', style: { fontFamily: 'Inter, sans-serif' } } },
        { type: 'p', props: { children: 'b', style: { 'font-family': "'Lora', serif" } } },
        { type: 'p', props: { children: 'c', style: { fontFamily: 'Georgia, serif' } } },
      ],
    });
    expect(result.nodes[0].props.style).toMatchObject({ fontFamily: "'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" });
    expect(result.nodes[1].props.style).toMatchObject({ fontFamily: "'Fraunces', Georgia, 'Times New Roman', serif" });
    expect(result.nodes[2].props.style).toMatchObject({ fontFamily: 'Georgia, serif' });
    expect(result.warnings.filter((w) => w.includes('style.fontFamily'))).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('"Inter" is a banned typeface'))).toBe(true);
  });

  it('lets a preset button inherit the section font instead of forcing one', () => {
    const result = ok({ nodes: [{ type: 'button', preset: 'button', props: { children: 'Go' } }] });
    expect(result.nodes[0].props.style).toMatchObject({ fontFamily: 'inherit' });
  });
});
