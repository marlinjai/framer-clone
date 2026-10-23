// The design-tells screen (src/lib/ai/pageGen/tells.ts): every rule with a
// positive and a negative case, the safe fixes, and their idempotence. Dashes
// are written as \u2013 / \u2014 escapes, never as the glyph.

import { describe, expect, it } from 'vitest';
import {
  autoFixTells,
  detectTells,
  fixDashes,
  stripBannedFonts,
  stripEmoji,
  stripTrailingArrow,
  styleValueTell,
  textTell,
  treeStats,
  type TellId,
  type TellNode,
  type TellTree,
} from '../tells';

let seq = 0;
function n(type: string, opts: { label?: string; text?: string; style?: Record<string, unknown>; props?: Record<string, unknown> } = {}, children: TellNode[] = []): TellNode {
  seq += 1;
  const props: Record<string, unknown> = { ...(opts.props ?? {}) };
  if (opts.text !== undefined) props.children = opts.text;
  if (opts.style) props.style = opts.style;
  return { id: `${type}-${seq}`, type, label: opts.label ?? type, props, children };
}

const page = (...nodes: TellNode[]): TellTree => ({ nodes });
const tells = (tree: TellTree, opts = {}): TellId[] => detectTells(tree, opts).map((f) => f.tell);

const EM = '\u2014';
const EN = '\u2013';

const featureCard = (i: number) =>
  n('div', { label: 'Card', style: { padding: '24px', backgroundColor: '#ffffff', border: '1px solid #e5e7eb' } }, [
    n('h3', { text: `Feature ${i}` }),
    n('p', { text: 'A short description of the feature.' }),
  ]);

describe('fixDashes', () => {
  it.each([
    [`Open daily 8:00 ${EN} 18:30`, 'Open daily 8:00-18:30'],
    [`8:00${EN}18:30`, '8:00-18:30'],
    [`Since 2019 ${EM} 2024`, 'Since 2019-2024'],
    [`Mo${EN}Fr`, 'Mo-Fr'],
    [`${EM} Anna, regular since 2019`, 'Anna, regular since 2019'],
    [`Fresh bread ${EM} baked every morning`, 'Fresh bread: baked every morning'],
    [`We bake our bread slowly and by hand ${EM} the way it used to be.`, 'We bake our bread slowly and by hand, the way it used to be.'],
    [`We bake ${EM} slowly ${EM} every night.`, 'We bake, slowly, every night.'],
    [`Quality matters${EM}always.`, 'Quality matters: always.'],
    [`Two sentences. Then this one is long enough ${EM} with an aside.`, 'Two sentences. Then this one is long enough, with an aside.'],
    ['Plain text -- with a double hyphen.', 'Plain text: with a double hyphen.'],
    ['Click here -->', 'Click here -->'],
    ['Opening hours 8:00 to 18:30', 'Opening hours 8:00 to 18:30'],
  ])('%s', (input, expected) => {
    expect(fixDashes(input)).toBe(expected);
    expect(fixDashes(fixDashes(input))).toBe(expected);
  });
});

describe('stripEmoji', () => {
  it('removes emoji, keeps (c), (r), trademark and rating stars, keeps a keycap digit', () => {
    expect(stripEmoji('Fresh bread \u{1F35E} daily \u{1F525}!')).toBe('Fresh bread daily!');
    expect(stripEmoji('© 2026 Bakery™')).toBe('© 2026 Bakery™');
    expect(stripEmoji('★★★★☆ rated')).toBe('★★★★☆ rated');
    expect(stripEmoji('1️⃣ Order')).toBe('1 Order');
    expect(stripEmoji('Team \u{1F468}‍\u{1F469}‍\u{1F467} family')).toBe('Team family');
    expect(stripEmoji('No emoji here.')).toBe('No emoji here.');
  });
});

describe('stripTrailingArrow', () => {
  it.each([
    ['Get started ->', 'Get started'],
    ['Get started →', 'Get started'],
    ['Learn more ›', 'Learn more'],
    ['Weiter »', 'Weiter'],
    ['Next >', 'Next'],
    ['→', '→'],
    ['Book a table', 'Book a table'],
  ])('%s', (input, expected) => {
    expect(stripTrailingArrow(input)).toBe(expected);
  });
});

describe('stripBannedFonts', () => {
  it('drops Inter, Geist and Space Grotesk, and the key when only generics remain', () => {
    expect(stripBannedFonts('Inter, sans-serif')).toBeUndefined();
    expect(stripBannedFonts("'Space Grotesk', system-ui, sans-serif")).toBeUndefined();
    expect(stripBannedFonts('"Geist Mono", ui-monospace, monospace')).toBe('ui-monospace, monospace');
    expect(stripBannedFonts("Inter, Georgia, serif")).toBe('Georgia, serif');
    expect(stripBannedFonts('Georgia, serif')).toBe('Georgia, serif');
    expect(stripBannedFonts('Interstate, sans-serif')).toBe('Interstate, sans-serif');
  });
});

describe('autoFixTells', () => {
  const tree = (): TellTree => ({
    title: `Bakery ${EM} fresh daily`,
    description: 'Bread \u{1F35E} for everyone',
    nodes: [
      n('section', { label: 'Hero', style: { fontFamily: { base: 'Inter, sans-serif', mobile: 'Geist, sans-serif' } } }, [
        n('h1', { label: 'Headline', text: `Bread ${EM} the old way` }),
        n('a', { label: 'CTA', text: 'Order now →', props: { href: '#order' } }),
        n('button', { label: 'Button', text: 'Book ✨', style: { fontFamily: 'Inter, sans-serif' } }),
        n('div', { label: 'Icon wrap' }, [n('span', { label: 'Icon', text: '\u{1F35E}' })]),
        n('img', { label: 'Photo', props: { src: 'https://example.com/a.jpg', alt: `Loaves ${EM} warm` } }),
      ]),
    ],
  });

  it('fixes dashes, emoji, fonts and button arrows, aggregated per kind', () => {
    const { tree: out, fixes, findings } = autoFixTells(tree());
    const hero = out.nodes[0];
    expect(out.title).toBe('Bakery: fresh daily');
    expect(out.description).toBe('Bread for everyone');
    expect(hero.props.style).toEqual({});
    expect(hero.children[0].props.children).toBe('Bread: the old way');
    expect(hero.children[1].props.children).toBe('Order now');
    expect(hero.children[2].props.children).toBe('Book');
    expect(hero.children[2].props.style).toEqual({});
    // The emoji-only icon is removed and reported for the repair round.
    expect(hero.children[3].children).toHaveLength(0);
    expect(findings.map((f) => f.tell)).toEqual(['emoji-icon']);
    expect(findings[0].path).toBe('Hero > Icon wrap > Icon');
    expect(hero.children[4].props.alt).toBe('Loaves: warm');
    const byTell = Object.fromEntries(fixes.map((f) => [f.tell, f.count]));
    expect(byTell).toMatchObject({ 'em-dash': 3, emoji: 2, 'banned-font': 2, 'button-arrow': 1, 'emoji-icon': 1 });
    expect(fixes.every((f) => !/[\u2013\u2014]/.test(f.detail))).toBe(true);
    expect(treeStats(out.nodes)).toEqual({ nodeCount: 6, maxDepth: 2 });
  });

  it('is idempotent and does not mutate its input', () => {
    const input = tree();
    const snapshot = structuredClone(input);
    const once = autoFixTells(input).tree;
    expect(input).toEqual(snapshot);
    const twice = autoFixTells(once);
    expect(twice.tree).toEqual(once);
    expect(twice.fixes).toEqual([]);
    expect(twice.findings).toEqual([]);
  });

  it('leaves arrows in body copy and clean pages alone', () => {
    const clean = page(n('section', { label: 'S' }, [n('p', { text: 'Step one -> step two' }), n('p', { text: 'Opening hours 8:00 to 18:30' })]));
    const { tree: out, fixes } = autoFixTells(clean);
    expect(fixes).toEqual([]);
    expect(out).toEqual(clean);
  });

  it('marks the copy tells it fixes as autoFixable in detection', () => {
    const found = detectTells(tree());
    const fixable = new Set(found.filter((f) => f.autoFixable).map((f) => f.tell));
    expect(fixable).toEqual(new Set(['em-dash', 'emoji', 'banned-font', 'button-arrow']));
    const after = detectTells(autoFixTells(tree()).tree);
    expect(after.filter((f) => f.autoFixable)).toEqual([]);
  });
});

describe('detectTells: layout', () => {
  it('flags three identical feature cards in a grid row and in a flex row', () => {
    const grid = n('div', { label: 'Features', style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' } }, [featureCard(1), featureCard(2), featureCard(3)]);
    expect(tells(page(grid))).toContain('feature-cards');
    const flex = n('div', { label: 'Features', style: { display: 'flex', gap: '24px' } }, [featureCard(1), featureCard(2), featureCard(3)]);
    expect(tells(page(flex))).toContain('feature-cards');
    expect(detectTells(page(flex)).find((f) => f.tell === 'feature-cards')?.path).toBe('Features');
  });

  it('does not flag a 3-item price list in a column, pricing tiers with buttons, or a two-column split', () => {
    const list = n('div', { label: 'Prices', style: { display: 'flex', flexDirection: 'column' } }, [
      n('div', { style: { display: 'flex', justifyContent: 'space-between' } }, [n('span', { text: 'Sourdough' }), n('span', { text: '4.50' })]),
      n('div', { style: { display: 'flex', justifyContent: 'space-between' } }, [n('span', { text: 'Rye' }), n('span', { text: '3.90' })]),
      n('div', { style: { display: 'flex', justifyContent: 'space-between' } }, [n('span', { text: 'Baguette' }), n('span', { text: '2.20' })]),
    ]);
    const tier = (name: string) =>
      n('div', { style: { padding: '32px', border: '1px solid #ddd' } }, [
        n('h3', { text: name }),
        n('p', { text: '29 per month' }),
        n('ul', {}, [n('li', { text: 'Feature' })]),
        n('a', { text: 'Choose', props: { href: '#' } }),
      ]);
    const pricing = n('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' } }, [tier('Basic'), tier('Pro'), tier('Team')]);
    const split = n('div', { style: { display: 'grid', gridTemplateColumns: '1.3fr 1fr' } }, [
      n('div', {}, [n('h2', { text: 'Our story' }), n('p', { text: 'Since 1952.' })]),
      n('img', { props: { src: 'https://example.com/bakery.jpg', alt: 'The bakery' }, style: { aspectRatio: '4 / 5' } }),
    ]);
    expect(tells(page(list, pricing, split))).toEqual([]);
  });

  it('flags a bento grid with spans, not a uniform grid or a full-row heading cell', () => {
    const tile = (span?: string) => n('div', { style: { backgroundColor: '#f4f1ea', padding: '24px', ...(span ? { gridColumn: span } : {}) } }, [n('p', { text: 'Tile' })]);
    expect(tells(page(n('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' } }, [tile('span 2'), tile(), tile(), tile()])))).toContain('bento-grid');
    expect(tells(page(n('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' } }, [tile('1 / 3'), tile(), tile(), tile()])))).toContain('bento-grid');
    expect(tells(page(n('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)' } }, [tile(), tile(), tile(), tile()])))).not.toContain('bento-grid');
    expect(tells(page(n('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)' } }, [tile('1 / -1'), tile(), tile(), tile()])))).not.toContain('bento-grid');
    const areas = n('div', { style: { display: 'grid', gridTemplateAreas: '"a a b" "c d b"' } }, [tile(), tile(), tile(), tile()]);
    expect(tells(page(areas))).toContain('bento-grid');
  });
});

describe('detectTells: colour and surfaces', () => {
  it('flags violet accents on near-black, once per dark root', () => {
    const dark = n('section', { label: 'Dark', style: { backgroundColor: '#0a0a0f' } }, [
      n('h2', { text: 'Ship faster', style: { color: '#ffffff' } }),
      n('a', { text: 'Start', style: { backgroundColor: '#8b5cf6' }, props: { href: '#' } }),
      n('div', {}, [n('p', { text: 'x', style: { color: 'rgb(124, 58, 237)' } })]),
    ]);
    const found = detectTells(page(dark)).filter((f) => f.tell === 'purple-on-black');
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe('Dark');
  });

  it('does not flag purple on a light page, blue on black, or a dark photo section', () => {
    const light = n('section', { style: { backgroundColor: '#faf7f2' } }, [n('a', { text: 'Go', style: { backgroundColor: '#7c3aed' }, props: { href: '#' } })]);
    const blue = n('section', { style: { backgroundColor: '#050505' } }, [n('a', { text: 'Go', style: { backgroundColor: '#2563eb' }, props: { href: '#' } })]);
    const photo = n('section', { style: { backgroundColor: '#0b0b0b', backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.45))' } }, [
      n('a', { text: 'Go', style: { backgroundColor: '#8b5cf6' }, props: { href: '#' } }),
    ]);
    expect(tells(page(light, blue))).toEqual([]);
    expect(tells(page(photo), { photoNodeIds: new Set([photo.id]) })).toEqual([]);
    const briefPhoto = n('section', { style: { backgroundColor: '#0b0b0b', backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.45)), url(https://example.com/hero.jpg)' } }, [
      n('a', { text: 'Go', style: { backgroundColor: '#8b5cf6' }, props: { href: '#' } }),
    ]);
    expect(tells(page(briefPhoto))).toEqual([]);
  });

  it('flags coloured radial orbs and blurred blobs, not a grey vignette scrim', () => {
    expect(tells(page(n('div', { style: { backgroundImage: 'radial-gradient(circle at 30% 20%, rgba(139, 92, 246, 0.5), transparent 60%)' } }, [n('p', { text: 'x' })])))).toContain('radial-orb');
    expect(tells(page(n('div', { style: { width: '400px', height: '400px', backgroundColor: '#f472b6', filter: 'blur(80px)' } })))).toContain('radial-orb');
    expect(tells(page(n('section', { style: { backgroundImage: 'radial-gradient(ellipse at center, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.6))' } }, [n('p', { text: 'x' })])))).toEqual([]);
  });

  it('flags dot and line grid backgrounds, not a full-size gradient', () => {
    expect(tells(page(n('section', { style: { backgroundImage: 'radial-gradient(#d4d4d8 1px, transparent 1px)', backgroundSize: '24px 24px' } }, [n('p', { text: 'x' })])))).toEqual(['dot-grid']);
    expect(tells(page(n('section', { style: { backgroundImage: 'linear-gradient(#eee 1px, transparent 1px), linear-gradient(90deg, #eee 1px, transparent 1px)', backgroundSize: '32px 32px' } }, [n('p', { text: 'x' })])))).toEqual(['dot-grid']);
    expect(tells(page(n('section', { style: { backgroundImage: 'linear-gradient(#faf7f2, #f1ebe0)', backgroundSize: 'cover' } }, [n('p', { text: 'x' })])))).toEqual([]);
  });

  it('flags rainbow gradients, gradient text and rainbow card sets, not a two-tone brand gradient', () => {
    expect(tells(page(n('div', { style: { backgroundImage: 'linear-gradient(90deg, #ef4444, #eab308, #22c55e, #3b82f6)' } }, [n('p', { text: 'x' })])))).toContain('rainbow');
    expect(tells(page(n('h1', { text: 'Big', style: { backgroundImage: 'linear-gradient(90deg, #f97316, #db2777)', backgroundClip: 'text', color: 'transparent' } })))).toContain('gradient-text');
    const card = (bg: string) => n('div', { style: { backgroundColor: bg, padding: '24px' } }, [n('p', { text: 'x' })]);
    expect(tells(page(n('div', { style: { display: 'flex', flexDirection: 'column' } }, [card('#ef4444'), card('#22c55e'), card('#3b82f6')])))).toContain('rainbow');
    expect(tells(page(n('div', { style: { backgroundImage: 'linear-gradient(135deg, #1e3a8a, #2563eb)' } }, [n('p', { text: 'x' })])))).toEqual([]);
  });

  it('flags decorative glass, not a sticky frosted header', () => {
    expect(tells(page(n('div', { style: { backdropFilter: 'blur(12px)', backgroundColor: 'rgba(255, 255, 255, 0.1)' } }, [n('p', { text: 'x' })])))).toContain('glass');
    expect(tells(page(n('header', { style: { position: 'sticky', top: '0', backdropFilter: 'blur(12px)' } }, [n('a', { text: 'Home', props: { href: '/' } })])))).toEqual([]);
  });
});

describe('detectTells: content', () => {
  it('flags a terminal mock-up, not a dark quote in a serif', () => {
    const terminal = n('div', { label: 'Terminal', style: { backgroundColor: '#0d1117', fontFamily: 'ui-monospace, monospace', padding: '24px' } }, [
      n('p', { text: '$ npm install bakery' }),
      n('p', { text: 'added 1 package' }),
    ]);
    expect(detectTells(page(terminal)).map((f) => [f.tell, f.path])).toEqual([['terminal', 'Terminal']]);
    const quote = n('div', { style: { backgroundColor: '#111111', fontFamily: 'Georgia, serif' } }, [n('p', { text: '> The best bread in town.' })]);
    expect(tells(page(quote))).toEqual([]);
  });

  it.each([
    "It's not a bakery, it's a ritual.",
    "This isn't just bread.",
    'More than just a coffee shop.',
    'Not a to-do list. A system.',
    'Not just fast but reliable.',
    'Es ist nicht nur Brot, es ist Handwerk.',
    'Mehr als nur eine Backstube.',
    'Kein Supermarkt, sondern eine Backstube.',
  ])('flags "not X, it\'s Y" copy: %s', (text) => {
    expect(tells(page(n('h2', { text })))).toContain('not-x-its-y');
  });

  it.each([
    'More than 20 years of baking.',
    'Not only bread but also cakes.',
    'Nicht nur Brot, sondern auch Kuchen.',
    'We do not use additives.',
    'Opening hours 8:00 to 18:30',
  ])('does not flag ordinary copy: %s', (text) => {
    expect(tells(page(n('p', { text })))).toEqual([]);
  });

  it('flags sparkle glyphs and sparkle layers, not rating stars', () => {
    expect(tells(page(n('span', { text: '✦ New' })))).toContain('sparkle');
    expect(tells(page(n('div', { label: 'Sparkle icon' }, [n('p', { text: 'x' })])))).toContain('sparkle');
    expect(tells(page(n('span', { text: '★★★★★' })))).toEqual([]);
  });

  it('flags hover animation on most cards, not on one', () => {
    const card = (anim: boolean) => n('div', { style: { padding: '24px', border: '1px solid #ddd', ...(anim ? { transition: 'transform 200ms ease' } : {}) } }, [n('p', { text: 'x' })]);
    const wrap = (...c: TellNode[]) => n('div', { style: { display: 'flex', flexDirection: 'column' } }, c);
    expect(tells(page(wrap(card(true), card(true), card(true), card(false))))).toContain('hover-everywhere');
    expect(tells(page(wrap(card(true), card(false), card(false), card(false))))).not.toContain('hover-everywhere');
  });

  it('flags icon-set images, not a real product photo', () => {
    expect(tells(page(n('img', { props: { src: 'https://unpkg.com/lucide-static@0.400.0/icons/zap.svg', alt: 'Zap' } })))).toEqual(['icon-set']);
    expect(tells(page(n('img', { props: { src: 'https://images.example.com/sourdough.jpg', alt: 'Sourdough loaf' }, style: { aspectRatio: '4 / 5' } })))).toEqual([]);
  });

  it('flags a gradient box standing in for a screenshot and a fake screen of empty boxes', () => {
    const demo = n('div', { label: 'Product shot', style: { aspectRatio: '16 / 9', backgroundImage: 'linear-gradient(135deg, #e0e7ff, #f5f3ff)' } });
    expect(detectTells(page(demo)).map((f) => f.tell)).toEqual(['placeholder-demo']);
    const bar = () => n('div', { style: { height: '12px', backgroundColor: '#e5e7eb' } });
    const fake = n('div', { label: 'Screen', style: { border: '1px solid #ddd' } }, [bar(), bar(), n('div', {}, [bar(), bar()])]);
    expect(detectTells(page(fake)).filter((f) => f.tell === 'placeholder-demo').map((f) => f.path)).toEqual(['Screen']);
  });

  it('does not flag a container awaiting a stock photo or a real photo', () => {
    const hero = n('section', { label: 'Hero', style: { minHeight: '640px', backgroundColor: '#1c1917', backgroundImage: 'linear-gradient(to top, rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0) 65%)' } });
    expect(tells(page(hero), { photoNodeIds: new Set([hero.id]) })).toEqual([]);
    const photo = n('div', { style: { aspectRatio: '3 / 2', backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0.3), rgba(0, 0, 0, 0.3)), url(https://images.example.com/a.jpg)' } });
    expect(tells(page(photo))).toEqual([]);
  });

  it('reads the desktop value of a responsive map', () => {
    const grid = n('div', { style: { display: 'grid', gridTemplateColumns: { desktop: 'repeat(3, 1fr)', mobile: '1fr' } } }, [featureCard(1), featureCard(2), featureCard(3)]);
    expect(tells(page(grid), { breakpointKeys: ['desktop', 'mobile'] })).toContain('feature-cards');
    const mobileOnly = n('div', { style: { display: 'grid', gridTemplateColumns: { base: '1fr', mobile: 'repeat(3, 1fr)' } } }, [featureCard(1), featureCard(2), featureCard(3)]);
    expect(tells(page(mobileOnly), { breakpointKeys: ['desktop', 'mobile'] })).not.toContain('feature-cards');
  });
});

describe('single-value rules (what a review patch may write)', () => {
  it('flags banned fonts, glass, coloured orbs, rainbow gradients and long dashes in style values', () => {
    expect(styleValueTell('fontFamily', 'Geist, sans-serif')).toMatch(/banned typefaces/);
    expect(styleValueTell('backdropFilter', 'blur(12px)')).toMatch(/glass/);
    expect(styleValueTell('backgroundImage', 'radial-gradient(circle, #7c3aed 0%, transparent 70%)')).toMatch(/orb/);
    expect(styleValueTell('backgroundImage', 'linear-gradient(90deg, #ff0000, #00ff00, #0000ff)')).toMatch(/rainbow/);
    expect(styleValueTell('content', 'a — b')).toMatch(/long dashes/);
  });

  it('lets ordinary values through, a dark scrim over a photo included', () => {
    expect(styleValueTell('fontFamily', '"Fraunces", Georgia, serif')).toBeNull();
    expect(styleValueTell('backgroundImage', 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.6) 100%)')).toBeNull();
    expect(styleValueTell('backdropFilter', 'none')).toBeNull();
    expect(styleValueTell('padding', '24px 16px')).toBeNull();
  });

  it('flags tells in copy and lets plain copy through', () => {
    expect(textTell('Fast — and honest')).toMatch(/long dashes/);
    expect(textTell('Ready to ride \u{1F6B2}')).toMatch(/emoji/);
    expect(textTell("It's not a repair shop, it's a community.")).toMatch(/not X/);
    expect(textTell('Most repairs are ready within three working days.')).toBeNull();
    expect(textTell('Open 8:00-18:30')).toBeNull();
  });
});
