// The exact payloads of the security review of the widened validator
// (decision-pages/2026-11-02-ai-validator-review.md, findings F1 to F8 and F10),
// each with the form that must keep working next to it.

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { GENERATION_LIMITS, deriveBreakpointKeys } from '../schema';
import { validateGeneration, type GeneratedNodeSnapshot } from '../validate';
import { validateReviewOps } from '@/lib/ai/review/ops';
import { cssUrlsIn, scanCssValue } from '@/lib/responsive/responsiveCss';

const breakpoints = deriveBreakpointKeys([{ label: 'Desktop', minWidth: 1200 }, { label: 'Mobile', minWidth: 390 }]);

function forest(nodes: unknown[]): { nodes: GeneratedNodeSnapshot[]; warnings: string[] } {
  const outcome = validateGeneration({ nodes }, { breakpoints });
  if (!outcome.ok) throw new Error(outcome.errors.join('; '));
  return outcome.result;
}

const one = (node: Record<string, unknown>) => forest([node]).nodes[0];
const propsOf = (type: string, props: Record<string, unknown>) => one({ type, props }).props;
const styleOf = (style: Record<string, unknown>, type = 'div') => one({ type, props: { style } }).props.style ?? {};
const inSvg = (type: string, props: Record<string, unknown>) => one({ type: 'svg', children: [{ type, props }] }).children[0].props;

function review(property: string, value: unknown) {
  const nodes = new Map([['n', { type: 'div', isRoot: false, textEditable: false, backgroundUrls: new Set<string>() }]]);
  return validateReviewOps([{ op: 'update_style', nodeId: 'n', property, value, breakpoint: null }], { breakpointKeys: ['desktop'], nodes });
}

describe('F1: an id cannot clobber a global the platform boots from', () => {
  it.each(['__next_f', 'webpackChunk_N_E', '__NEXT_DATA__', 'fc-consent', 'fc-fx-start', 'ground-wrapper-x', 'Pricing', '1a', '', 'fcConsent-x'])('refuses %j', (id) => {
    expect(propsOf('div', { id, children: 'x' })).toEqual({ children: 'x' });
  });

  it('keeps a slug, the only thing a page anchor needs', () => {
    expect(propsOf('div', { id: 'pricing-2026' })).toEqual({ id: 'pricing-2026' });
  });
});

describe('F2: use expansion', () => {
  const uses = (id: string, count: number) => Array.from({ length: count }, () => ({ type: 'use', props: { href: `#${id}` } }));
  function bomb(levels: number) {
    const groups = [{ type: 'g', props: { id: 'a0' }, children: [{ type: 'rect' }] }];
    for (let i = 1; i <= levels; i++) groups.push({ type: 'g', props: { id: `a${i}` }, children: uses(`a${i - 1}`, 10) as never });
    return { type: 'svg', children: [{ type: 'defs', children: groups }, { type: 'use', props: { href: `#a${levels}` } }] };
  }

  it.each([6, 9])('drops a %i level bomb, whole, and keeps the rest of the page', (levels) => {
    const result = forest([{ type: 'p', props: { children: 'Kept' } }, bomb(levels)]);
    expect(result.nodes.map((n) => n.type)).toEqual(['p']);
    expect(result.warnings.join('\n')).toMatch(/expands past 1000/);
  });

  it('keeps a real sprite', () => {
    const svg = {
      type: 'svg',
      children: [{ type: 'defs', children: [{ type: 'g', props: { id: 'star' }, children: [{ type: 'path', props: { d: 'M0 0' } }] }] }, ...uses('star', 5)],
    };
    expect(one(svg).children).toHaveLength(6);
  });

  it('counts a cycle as over budget, including a self reference', () => {
    const cycle = { type: 'svg', children: [{ type: 'g', props: { id: 'a' }, children: uses('b', 1) }, { type: 'g', props: { id: 'b' }, children: uses('a', 1) }] };
    const self = { type: 'svg', children: [{ type: 'g', props: { id: 'a' }, children: uses('a', 1) }] };
    expect(forest([{ type: 'p' }, cycle, self]).nodes.map((n) => n.type)).toEqual(['p']);
  });

  it('follows a reference from one svg into another', () => {
    const defs = bomb(2);
    const other = { type: 'svg', children: uses('a2', 20) };
    expect(forest([{ type: 'p' }, defs, other]).nodes.map((n) => n.type)).toEqual(['p', 'svg']);
  });

  it('refuses a use reaching outside the generation, which could build the chain over two', () => {
    expect(forest([{ type: 'p' }, { type: 'svg', children: uses('elsewhere', 1) }]).nodes.map((n) => n.type)).toEqual(['p']);
    expect(forest([{ type: 'p' }, { type: 'svg', children: [{ type: 'use', props: { href: '/sprite.svg#a' } }] }]).nodes.map((n) => n.type)).toEqual(['p']);
  });

  it('counts every duplicate of an id, because a browser picks one', () => {
    const heavy = { type: 'g', props: { id: 'x' }, children: Array.from({ length: 30 }, () => ({ type: 'rect' })) };
    const svg = { type: 'svg', children: [{ type: 'g', props: { id: 'x' } }, heavy, ...uses('x', 40)] };
    expect(forest([{ type: 'p' }, svg]).nodes.map((n) => n.type)).toEqual(['p']);
  });

  it('counts a paint or mask reference as well as a use', () => {
    const patterns = [{ type: 'pattern', props: { id: 'p0' }, children: [{ type: 'rect' }] }];
    for (let i = 1; i <= 6; i++) {
      patterns.push({ type: 'pattern', props: { id: `p${i}` }, children: Array.from({ length: 10 }, () => ({ type: 'rect', props: { fill: `url(#p${i - 1})` } })) as never });
    }
    expect(forest([{ type: 'p' }, { type: 'svg', children: patterns }]).nodes.map((n) => n.type)).toEqual(['p']);
  });

  it('takes the dropped nodes out of the count, and a photo inside them out of the requests', () => {
    const svg = bomb(6);
    (svg.children as unknown[]).push({ type: 'foreignObject', children: [{ type: 'div', props: { imageQuery: 'a red bicycle' } }] });
    const outcome = validateGeneration({ nodes: [{ type: 'p' }, svg] }, { breakpoints });
    expect(outcome.ok && outcome.result.stats.nodeCount).toBe(1);
    expect(outcome.ok && outcome.result.imageRequests).toEqual([]);
  });

  it('refuses a generation that is only a bomb', () => {
    const outcome = validateGeneration({ nodes: [bomb(6)] }, { breakpoints });
    expect(outcome.ok).toBe(false);
  });
});

describe('second round R1: one spelling for every attribute', () => {
  it('drops the bomb whose heavy groups say ID', () => {
    const uses = (id: string) => Array.from({ length: 10 }, () => ({ type: 'use', props: { href: `#${id}` } }));
    const groups: unknown[] = [{ type: 'g', props: { ID: 'a0' }, children: [{ type: 'rect' }] }, { type: 'g', props: { id: 'a0' } }];
    for (let i = 1; i <= 6; i++) groups.push({ type: 'g', props: { ID: `a${i}` }, children: uses(`a${i - 1}`) }, { type: 'g', props: { id: `a${i}` } });
    const svg = { type: 'svg', children: [{ type: 'defs', children: groups }, { type: 'use', props: { href: '#a6' } }] };
    expect(forest([{ type: 'p' }, svg]).nodes.map((n) => n.type)).toEqual(['p']);
  });

  it('stores one key whatever the case the model wrote', () => {
    expect(propsOf('div', { ID: 'a', TABINDEX: 0, LANG: 'de' })).toEqual({ id: 'a', tabIndex: 0, lang: 'de' });
    expect(inSvg('rect', { 'stroke-width': 2, STROKEWIDTH: 3 })).toEqual({ strokeWidth: 3 });
    expect(inSvg('feGaussianBlur', { STDDEVIATION: 2 })).toEqual({ stdDeviation: 2 });
    expect(one({ type: 'svg', props: { VIEWBOX: '0 0 1 1' } }).props).toEqual({ viewBox: '0 0 1 1' });
  });
});

describe('second round R3: ids under svg belong to one generation', () => {
  const uses = (id: string, count: number) => Array.from({ length: count }, () => ({ type: 'use', props: { href: `#${id}` } }));
  const chain = (prefix: string, base: string, count: number) => {
    const groups: unknown[] = [{ type: 'g', props: { id: `${prefix}0` }, children: uses(base, count) }];
    for (let i = 1; i <= 3; i++) groups.push({ type: 'g', props: { id: `${prefix}${i}` }, children: uses(`${prefix}${i - 1}`, count) });
    return groups;
  };
  const generate = (nodes: unknown[], token: string) => {
    const outcome = validateGeneration({ nodes }, { breakpoints, newId: () => token });
    if (!outcome.ok) throw new Error(outcome.errors.join('; '));
    return outcome.result;
  };

  it('rewrites an id and every reference to it, and leaves no bare id for a decoy', () => {
    const svg = generate(
      [{
        type: 'svg',
        children: [
          { type: 'linearGradient', props: { id: 'paint0_linear_1_2' } },
          { type: 'rect', props: { fill: 'url(#paint0_linear_1_2)', style: { mask: { base: 'url("#paint0_linear_1_2")' } } } },
          { type: 'use', props: { href: '#paint0_linear_1_2' } },
          { type: 'text', props: { 'aria-labelledby': 'paint0_linear_1_2', children: 'x' } },
        ],
      }],
      'abc',
    ).nodes[0];
    const [gradient, rect, use, text] = svg.children;
    expect(gradient.props.id).toBe('paint0_linear_1_2--abc');
    expect(rect.props.fill).toBe('url(#paint0_linear_1_2--abc)');
    expect(rect.props.style).toEqual({ mask: { base: 'url("#paint0_linear_1_2--abc")' } });
    expect(use.props.href).toBe('#paint0_linear_1_2--abc');
    expect(text.props['aria-labelledby']).toBe('paint0_linear_1_2--abc');
  });

  it('rewrites every aria reference that names an id', () => {
    const props = ['aria-details', 'aria-flowto', 'aria-activedescendant', 'aria-errormessage', 'aria-owns', 'aria-controls'];
    const svg = generate([{ type: 'svg', children: [{ type: 'g', props: { id: 'x' } }, { type: 'rect', props: Object.fromEntries(props.map((p) => [p, 'x'])) }] }], 'abc').nodes[0];
    expect(svg.children[1].props).toEqual(Object.fromEntries(props.map((p) => [p, 'x--abc'])));
  });

  it('reaches an svg id from a style outside the svg', () => {
    const [div] = generate([{ type: 'div', props: { style: { clipPath: 'url(#shape)' } } }, { type: 'svg', children: [{ type: 'clipPath', props: { id: 'shape' } }] }], 'abc').nodes;
    expect(div.props.style).toEqual({ clipPath: 'url(#shape--abc)' });
  });

  it('leaves a page anchor alone', () => {
    const [section] = generate([{ type: 'section', props: { id: 'top' } }, { type: 'svg', children: [{ type: 'a', props: { href: '#top' } }] }], 'abc').nodes;
    expect(section.props.id).toBe('top');
  });

  it('does not stack suffixes when a generation echoes an earlier id', () => {
    const svg = generate([{ type: 'svg', children: [{ type: 'g', props: { id: 'a--old' } }, { type: 'use', props: { href: '#a--old' } }] }], 'new').nodes[0];
    expect(svg.children[0].props.id).toBe('a--new');
    expect(svg.children[1].props.href).toBe('#a--new');
  });

  it('cannot rebuild a chain over three generations: a decoy matches nothing', () => {
    const first = forest([{ type: 'svg', children: [{ type: 'defs', children: [{ type: 'g', props: { id: 'base' }, children: [{ type: 'rect' }] }, ...chain('p', 'base', 3)] }] }]).nodes[0];
    const second = forest([{ type: 'p' }, { type: 'svg', children: [{ type: 'defs', children: [{ type: 'g', props: { id: 'p3' } }, ...chain('q', 'p3', 3)] }] }]).nodes;
    const third = forest([{ type: 'p' }, { type: 'svg', children: [{ type: 'g', props: { id: 'q3' } }, ...chain('r', 'q3', 3), ...uses('r3', 1)] }]).nodes;
    const ids: string[] = [];
    const collect = (node: GeneratedNodeSnapshot) => {
      if (typeof node.props.id === 'string') ids.push(node.props.id);
      node.children.forEach(collect);
    };
    [first, ...second, ...third].forEach(collect);
    expect(new Set(ids).size).toBe(ids.length);
    const hrefs = JSON.stringify(third);
    expect(hrefs).not.toMatch(/"#(?:q3|p3)"/);
  });
});

describe('final round V1: the budget reads the ids that ship', () => {
  const tenUses = (id: string) => Array.from({ length: 10 }, () => ({ type: 'use', props: { href: `#${id}` } }));
  function mergingBomb() {
    const groups: unknown[] = [{ type: 'g', props: { id: 'a0--h' }, children: [{ type: 'rect' }] }, { type: 'g', props: { id: 'a0--d' } }];
    for (let i = 1; i <= 6; i++) groups.push({ type: 'g', props: { id: `a${i}--h` }, children: tenUses(`a${i - 1}--d`) }, { type: 'g', props: { id: `a${i}--d` } });
    return { type: 'svg', children: [{ type: 'defs', children: groups }, { type: 'use', props: { href: '#a6--d' } }] };
  }

  it('never maps two ids to one, so a decoy stays a decoy', () => {
    const svg = forest([mergingBomb()]).nodes[0];
    const ids: string[] = [];
    const collect = (node: GeneratedNodeSnapshot) => {
      if (typeof node.props.id === 'string') ids.push(node.props.id);
      node.children.forEach(collect);
    };
    collect(svg);
    expect(ids).toHaveLength(14);
    expect(new Set(ids).size).toBe(14);
  });

  it('points every use at its own target, never at the heavy twin', () => {
    const svg = forest([mergingBomb()]).nodes[0];
    const [defs, top] = svg.children;
    const decoy = defs.children.at(-1)!;
    const heavy = defs.children.at(-2)!;
    expect(top.props.href).toBe(`#${decoy.props.id}`);
    expect(top.props.href).not.toBe(`#${heavy.props.id}`);
  });

  it('counts the budget after the rewrite: a real duplicate of one id is counted at its heaviest', () => {
    const groups: unknown[] = [{ type: 'g', props: { id: 'a0' }, children: [{ type: 'rect' }] }, { type: 'g', props: { id: 'a0' } }];
    for (let i = 1; i <= 6; i++) groups.push({ type: 'g', props: { id: `a${i}` }, children: tenUses(`a${i - 1}`) }, { type: 'g', props: { id: `a${i}` } });
    const svg = { type: 'svg', children: [{ type: 'defs', children: groups }, { type: 'use', props: { href: '#a6' } }] };
    expect(forest([{ type: 'p' }, svg]).nodes.map((n) => n.type)).toEqual(['p']);
  });
});

describe('final round V2: a sticky bar cannot carry an id out of an svg', () => {
  const page = (nodes: unknown[]) => {
    const outcome = validateGeneration({ nodes }, { breakpoints, allowStickyCta: true });
    if (!outcome.ok) throw new Error(outcome.errors.join('; '));
    return outcome.result;
  };
  const bar = { preset: 'stickyCta', type: 'div', props: { id: '__next_f', ctaLabel: 'Buy', ctaHref: '/x' } };

  it('drops a bar under an svg, with its id', () => {
    const result = page([{ type: 'p' }, { type: 'svg', children: [bar] }]);
    expect(JSON.stringify(result.nodes)).not.toContain('__next_f');
    expect(JSON.stringify(result.nodes)).not.toContain('data-sticky-cta');
    expect(result.warnings.join('\n')).toMatch(/cannot sit inside svg or math/);
  });

  it('drops a bar under a foreignObject too', () => {
    const result = page([{ type: 'p' }, { type: 'svg', children: [{ type: 'foreignObject', children: [bar] }] }]);
    expect(JSON.stringify(result.nodes)).not.toContain('data-sticky-cta');
    expect(result.warnings.join('\n')).toMatch(/no place inside an svg/);
  });

  it('holds the strict id rule for a preset under a foreignObject', () => {
    const svg = forest([{ type: 'svg', children: [{ type: 'foreignObject', children: [{ preset: 'card', type: 'div', props: { id: '__next_f' } }] }] }]).nodes[0];
    expect(svg.children[0].children[0].props).not.toHaveProperty('id');
  });

  it('keeps a bar at the page level', () => {
    const result = page([{ type: 'p' }, { ...bar, props: { ...bar.props, id: 'buy-bar' } }]);
    expect(result.nodes.at(-1)!.props).toMatchObject({ id: 'buy-bar', ctaLabel: 'Buy' });
  });
});

describe('second round R4: real SVG survives', () => {
  it('keeps a Figma export with its fill', () => {
    const svg = forest([{ type: 'svg', children: [{ type: 'linearGradient', props: { id: 'paint0_linear_1_2' } }, { type: 'rect', props: { fill: 'url(#paint0_linear_1_2)' } }] }]).nodes[0];
    expect(svg.children[0].props.id).toMatch(/^paint0_linear_1_2--/);
    expect(svg.children[1].props.fill).toBe(`url(#${svg.children[0].props.id})`);
  });

  it('never counts a link as a reference, so a link to its own section is no cycle', () => {
    const result = forest([{ type: 'section', props: { id: 'top' }, children: [{ type: 'svg', children: [{ type: 'a', props: { href: '#top' } }] }] }]);
    expect(result.nodes[0].children[0].type).toBe('svg');
    expect(result.nodes[0].children[0].children[0].props.href).toBe('#top');
  });

  it('turns a camelCase anchor into its slug, and follows the link', () => {
    const [section, link] = forest([{ type: 'section', props: { id: 'heroSection' } }, { type: 'a', props: { href: '#heroSection', children: 'Up' } }]).nodes;
    expect(section.props.id).toBe('hero-section');
    expect(link.props.href).toBe('#hero-section');
  });

  it('keeps fill on svg and g, so an outline icon stays an outline', () => {
    expect(one({ type: 'svg', props: { fill: 'none' } }).props.fill).toBe('none');
    expect(inSvg('g', { fill: 'none' })).toEqual({ fill: 'none' });
  });

  it('moves geometry the format reads as style into style, in the form CSS needs', () => {
    expect(one({ type: 'svg', props: { width: '24', height: 24 } }).props.style).toEqual({ width: 24, height: 24 });
    expect(inSvg('rect', { width: '10', height: '100%' })).toEqual({ style: { width: 10, height: '100%' } });
    expect(inSvg('g', { transform: 'translate(10 20)', opacity: '0.5' })).toEqual({ style: { transform: 'translate(10px, 20px)', opacity: 0.5 } });
    expect(inSvg('g', { transform: 'rotate(45 12 12) scale(2)' })).toEqual({ style: { transform: 'translate(12px, 12px) rotate(45deg) translate(-12px, -12px) scale(2)' } });
    expect(inSvg('g', { transform: 'matrix(1 0 0 1 5 5)' })).toEqual({ style: { transform: 'matrix(1, 0, 0, 1, 5, 5)' } });
  });

  it('lets a style the model wrote win, and refuses what it cannot read', () => {
    expect(inSvg('rect', { width: '10', style: { width: '20px' } })).toEqual({ style: { width: '20px' } });
    expect(inSvg('g', { transform: 'url(#x)' })).toEqual({});
    expect(inSvg('mask', { width: '100%' })).toEqual({});
  });

  it('checks a moved value like any style', () => {
    expect(inSvg('rect', { width: 'red;x:y', opacity: 'javascript:x' })).toEqual({});
  });
});

describe('second round R6: /_next/ is no site path', () => {
  const proxy = '/_next/image?url=https%3A%2F%2Fimages.unsplash.com%2Fphoto-1506744038136-46273834b3fb&w=64&q=50';

  it.each([proxy, '/./_next/image?url=x', '/a/../_next/image', '/%5Fnext/image', 'https://site.example/_next/image?url=x'])('refuses %s as an image', (src) => {
    expect(one({ type: 'img', props: { alt: 'a', src } }).props.src).toBe('/images/sample-image.jpg');
    expect(propsOf('video', { poster: src })).toEqual({});
    expect(styleOf({ backgroundImage: `url(${src})` })).toEqual({});
  });

  it('keeps other paths', () => {
    expect(propsOf('video', { poster: '/next/poster.jpg' })).toEqual({ poster: '/next/poster.jpg' });
  });
});

describe('F3: nothing the owner cannot see', () => {
  it('drops a declarative shadow root that would replace a section', () => {
    const div = one({
      type: 'div',
      children: [
        { type: 'template', props: { shadowrootmode: 'open' }, children: [{ type: 'h1', props: { children: 'Forged page' } }] },
        { type: 'p', props: { children: 'real page, legal link' } },
      ],
    });
    expect(div.children.map((c) => c.type)).toEqual(['p']);
  });

  it('refuses every shadowroot attribute, wherever it stands', () => {
    expect(propsOf('div', { shadowrootmode: 'open', shadowRootMode: 'open', shadowrootclonable: true, shadowrootdelegatesfocus: true })).toEqual({});
  });

  it('drops a preset inside an svg: the parser would throw it out for crawlers while the canvas hides it', () => {
    const result = forest([{ type: 'svg', children: [{ preset: 'card', props: { children: 'Forged text' } }, { type: 'rect' }] }]);
    expect(result.nodes[0].children.map((c) => c.type)).toEqual(['rect']);
    expect(JSON.stringify(result.nodes)).not.toContain('Forged text');
    expect(result.warnings.join('\n')).toMatch(/preset "card" cannot sit inside svg or math/);
  });

  it('drops a preset inside math the same way, children included', () => {
    const math = one({ type: 'math', children: [{ preset: 'text', props: { children: 'Forged text' } }, { type: 'mi' }] });
    expect(math.children.map((c) => c.type)).toEqual(['mi']);
  });

  it('reads an SVG text or image as a tag, never as the preset of that name', () => {
    expect(one({ type: 'svg', children: [{ type: 'text', props: { children: 'Logo' } }, { type: 'image' }] }).children.map((c) => c.type)).toEqual(['text', 'image']);
  });

  it('keeps a preset under a foreignObject, whose namespace is HTML', () => {
    const svg = one({ type: 'svg', children: [{ type: 'foreignObject', children: [{ preset: 'card', props: { children: 'Real text' } }] }] });
    expect(svg.children[0].children[0].type).toBe('div');
    expect(JSON.stringify(svg)).toContain('Real text');
  });

  it('drops noscript with its hidden links', () => {
    const div = one({ type: 'div', children: [{ type: 'noscript', children: [{ type: 'a', props: { href: 'https://evil.example/', children: 'x' } }] }, { type: 'p' }] });
    expect(div.children.map((c) => c.type)).toEqual(['p']);
  });
});

describe('F4: leaking a visitor to a third party', () => {
  it('refuses a referrer or cors override, on any tag', () => {
    expect(propsOf('img', { src: 'https://example.com/ref.png', referrerpolicy: 'unsafe-url', alt: 'x' })).not.toHaveProperty('referrerpolicy');
    expect(propsOf('a', { href: 'https://example.com/', referrerPolicy: 'unsafe-url', crossOrigin: 'anonymous' })).toEqual({ href: 'https://example.com/' });
    expect(propsOf('area', { href: '/x', referrerpolicy: 'unsafe-url' })).toEqual({ href: '/x' });
  });

  it('refuses rel opener in any position, and keeps other rel tokens', () => {
    expect(propsOf('a', { target: '_blank', rel: 'opener', href: 'https://evil.example/' })).toEqual({ target: '_blank', href: 'https://evil.example/' });
    expect(propsOf('a', { rel: 'nofollow OPENER' })).toEqual({});
    expect(propsOf('a', { rel: 'nofollow noopener' })).toEqual({ rel: 'nofollow noopener' });
  });

  // Not enough alone: the platform lazy-loads images too, so applyImageLoading skips
  // external ones. A background inside details still fetches on open, and only a
  // browser-enforced image policy closes that.
  it('refuses a loading attribute from the model', () => {
    expect(propsOf('img', { loading: 'lazy', alt: 'x' })).not.toHaveProperty('loading');
  });

  it('lets media load from this site only', () => {
    expect(propsOf('audio', { src: 'https://evil.example/a.mp3' })).toEqual({});
    expect(propsOf('video', { src: 'https://evil.example/a.mp4', poster: 'https://evil.example/p.png' })).toEqual({});
    expect(propsOf('track', { src: 'https://evil.example/a.vtt' })).toEqual({});
    expect(propsOf('source', { src: 'https://evil.example/a.mp4', srcSet: 'https://evil.example/a.png 1x' })).toEqual({});
    expect(inSvg('image', { href: 'https://evil.example/a.png' })).toEqual({});
    expect(inSvg('feImage', { href: 'https://evil.example/a.png' })).toEqual({});
    expect(propsOf('video', { src: '/film.mp4', poster: '/film.jpg' })).toEqual({ src: '/film.mp4', poster: '/film.jpg' });
    expect(inSvg('image', { href: '/logo.png' })).toEqual({ href: '/logo.png' });
  });
});

describe('F5: one reading of an address', () => {
  it('reads past a string the way the browser does', () => {
    expect(cssUrlsIn('"url(/safe" url("data:image/svg+xml,x")')).toEqual(['data:image/svg+xml,x']);
    expect(cssUrlsIn('"url(#x" url(https://evil.example/p.png)')).toEqual(['https://evil.example/p.png']);
    expect(cssUrlsIn('image-set("https://evil.example/paren(((.png" 1x)')).toEqual(['https://evil.example/paren(((.png']);
    expect(cssUrlsIn('image-set(url(/a.png) 1x, "/b.png" 2x), url( "/c.png" )')).toEqual(['/a.png', '/b.png', '/c.png']);
    expect(scanCssValue('image-set(var(--a) 1x)').indirect).toBe(true);
  });

  it('refuses each payload in the generator', () => {
    expect(styleOf({ content: '"url(/safe" url("data:image/svg+xml,x")' })).toEqual({});
    expect(styleOf({ backgroundImage: 'image-set("https://evil.example/javascript:(((.png" 1x)' })).toEqual({});
    expect(styleOf({ backgroundImage: 'image-set("data:image/png;base64,paren(((" 1x)' })).toEqual({});
    expect(styleOf({ '--a': '"https://evil.example/viavar.png"', backgroundImage: 'image-set(var(--a) 1x)' })).toEqual({});
  });

  it('refuses each payload in the review', () => {
    expect(review('content', '"url(#x" url(https://evil.example/p.png)').ops).toEqual([]);
    expect(review('backgroundImage', 'image-set("https://evil.example/paren(((.png" 1x)').ops).toEqual([]);
    expect(review('--a', '"https://evil.example/viavar.png"').ops).toEqual([]);
    expect(review('backgroundImage', 'image-set(var(--a) 1x)').ops).toEqual([]);
  });

  it('refuses an address in a custom property, in any form', () => {
    expect(styleOf({ '--a': 'url(/a.png)', '--b': 'image-set("/a.png" 1x)', '--c': '"//evil.example/a.png"', '--d': '"a:b"' })).toEqual({});
    expect(styleOf({ '--brand': '#123456', '--label': '"Hello"' })).toEqual({ '--brand': '#123456', '--label': '"Hello"' });
  });

  it('refuses a CSS escape in a presentation attribute', () => {
    expect(inSvg('rect', { fill: 'u\\72 l(https://evil.example/a.svg#g)', mask: 'U\\52L(https://evil.example/m.svg#m)' })).toEqual({});
    expect(propsOf('div', { title: 'a\\b' })).toEqual({});
  });
});

describe('F6: no stock photo without its credit', () => {
  const photo = 'https://images.unsplash.com/photo-1';

  it.each([
    ['ul', { backgroundImage: `url(${photo})` }],
    ['li', { backgroundImage: `url(${photo})` }],
    ['div', { maskImage: `url(${photo})` }],
    ['div', { listStyleImage: `url(${photo})` }],
    ['div', { borderImageSource: `url(${photo})` }],
    ['div', { background: `url(${photo})` }],
    ['div', { backgroundImage: `url(/a.png), url(${photo})` }],
    ['div', { backgroundImage: `image-set(url(${photo}) 1x)` }],
    ['div', { backgroundImage: `image-set("${photo}(((" 1x)` }],
    ['div', { '--a': `url(${photo})` }],
    ['div', { backgroundImage: 'url(https://images.unsplash.com./photo-1)' }],
  ])('refuses it on %s through %j', (type, style) => {
    expect(styleOf(style as Record<string, unknown>, type)).toEqual({});
  });

  it('keeps the credited photo layer of a container', () => {
    const credit = {
      'data-credit-name': 'Ana',
      'data-credit-url': 'https://unsplash.com/@ana',
      'data-credit-source-url': 'https://unsplash.com/',
    };
    const value = `linear-gradient(red, blue), url("${photo}")`;
    expect(one({ type: 'section', props: { ...credit, style: { backgroundImage: { base: value } } } }).props.style).toEqual({ backgroundImage: { base: value } });
    expect(one({ type: 'ul', props: { ...credit, style: { backgroundImage: value } } }).props.style ?? {}).toEqual({});
  });

  it.each([`/\\images.unsplash.com/photo-1`, 'https://images.unsplash.com./photo-1', '//images.unsplash.com/photo-1'])('reads %j as a stock photo', (src) => {
    expect(one({ type: 'img', props: { src, alt: 'x' } }).props.src).toBe('/images/sample-image.jpg');
    expect(propsOf('source', { srcSet: `${src} 1x` })).toEqual({});
    expect(propsOf('video', { poster: src })).toEqual({});
    expect(inSvg('image', { href: src })).toEqual({});
  });
});

describe('F7: permission elements', () => {
  it.each(['geolocation', 'camera', 'microphone', 'usermedia', 'install', 'model'])('drops %s with its subtree', (type) => {
    expect(one({ type: 'div', children: [{ type, children: [{ type: 'p' }] }] }).children).toEqual([]);
  });
});

describe('F8: the consent banner stays on top and answerable', () => {
  it('clamps z-index below the banner, as a number, a string or per breakpoint', () => {
    expect(styleOf({ zIndex: 2147483647 })).toEqual({ zIndex: 100000 });
    expect(styleOf({ zIndex: '2147483647' })).toEqual({ zIndex: '100000' });
    expect(styleOf({ zIndex: { base: 2147483647, mobile: '2147483647' } })).toEqual({ zIndex: { base: 100000, mobile: '100000' } });
    expect(styleOf({ zIndex: 10 })).toEqual({ zIndex: 10 });
    expect(styleOf({ zIndex: 'auto' })).toEqual({ zIndex: 'auto' });
  });

  it('refuses a z-index it cannot read', () => {
    expect(styleOf({ zIndex: 'var(--top)' })).toEqual({});
    expect(styleOf({ zIndex: 'calc(2147483647)' })).toEqual({});
  });

  it('clamps in the review too', () => {
    expect(review('zIndex', 2147483647).ops[0]).toMatchObject({ value: 100000 });
    expect(review('zIndex', 'var(--top)').rejected).toHaveLength(1);
  });

  it('keeps pointerEvents: the clamp alone puts any overlay under the banner', () => {
    const overlay = { position: 'fixed', bottom: 0, left: 0, right: 0, height: 100, zIndex: 2147483647, pointerEvents: 'none', background: '#eee' };
    expect(styleOf(overlay)).toMatchObject({ zIndex: 100000, pointerEvents: 'none' });
    expect(review('pointerEvents', 'none').ops).toHaveLength(1);
    expect(inSvg('rect', { pointerEvents: 'none' })).toEqual({ pointerEvents: 'none' });
  });

  it('refuses every way into the top layer', () => {
    expect(propsOf('button', { commandfor: 'dd', command: 'show-modal', popovertarget: 'dd', popoverTarget: 'dd', popovertargetaction: 'show' })).toEqual({});
    expect(propsOf('div', { popover: 'auto' })).toEqual({});
  });
});

describe('F10', () => {
  it('lets an animation change shape and paint only', () => {
    for (const attributeName of ['target', 'href', 'xlink:href', 'onclick', 'style', 'madeup']) {
      expect(inSvg('animate', { attributeName })).toEqual({});
    }
    expect(inSvg('animate', { attributeName: 'r', to: '4' })).toEqual({ attributeName: 'r', to: '4' });
  });

  it('checks numbers and booleans like text', () => {
    expect(propsOf('area', { target: 1 })).toEqual({});
    expect(propsOf('a', { href: true })).toEqual({});
    expect(propsOf('div', { id: 1 })).toEqual({});
    expect(propsOf('td', { colSpan: 2 })).toEqual({ colSpan: 2 });
  });

  it('does not let a dropped svg bring a page past the node limit back under it', () => {
    const bomb = { type: 'svg', children: [{ type: 'use', props: { href: '#outside' } }, ...Array.from({ length: 300 }, () => ({ type: 'rect' }))] };
    expect(validateGeneration({ nodes: [bomb, { type: 'p' }] }, { breakpoints }).ok).toBe(false);
  });

  it('caps props and style keys per node, and names', () => {
    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`aria-l${'x'.repeat(i)}`, 'x']));
    expect(Object.keys(propsOf('div', many)).length).toBeLessThanOrEqual(GENERATION_LIMITS.maxPropsPerNode);
    const vars = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`--a${i}`, 'x']));
    expect(Object.keys(styleOf(vars))).toHaveLength(GENERATION_LIMITS.maxPropsPerNode);
    expect(styleOf({ [`--${'a'.repeat(100)}`]: 'x' })).toEqual({});
    expect(propsOf('div', { [`aria-${'a'.repeat(100)}`]: 'x' })).toEqual({});
  });

  it('refuses output past the size limit, and stops reading past the node limit', () => {
    const text = 'x'.repeat(GENERATION_LIMITS.maxGenerationChars);
    expect(validateGeneration({ nodes: [{ type: 'p', props: { title: text } }] }, { breakpoints }).ok).toBe(false);
    const outcome = validateGeneration({ nodes: Array.from({ length: 100_000 }, () => ({ type: 'p' })) }, { breakpoints });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.warnings).toEqual([]);
  });

  it('refuses a CSS name as an attribute in any case', () => {
    expect(propsOf('video', { WIDTH: 1, Height: 1 })).toEqual({});
    expect(inSvg('rect', { Color: 'red' })).toEqual({});
  });

  it('does not take a note in the data for an attribute', () => {
    expect(propsOf('div', { data_attributes: 'x' })).toEqual({});
  });

  it('refuses a font behind a variable, on both paths', () => {
    expect(styleOf({ fontFamily: 'var(--font)' })).toEqual({});
    expect(styleOf({ font: '16px var(--font)' })).toEqual({});
    expect(review('fontFamily', 'var(--font)').ops).toEqual([]);
  });

  it('refuses is', () => {
    expect(propsOf('div', { is: 'x-y' })).toEqual({});
  });
});
