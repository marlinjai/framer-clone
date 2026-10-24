// The page-essentials screen (src/lib/ai/pageGen/essentials.ts): a primary
// call to action in the hero of a new marketing page, meaningful alt texts,
// and the last-resort alt fill.
import { describe, expect, it } from 'vitest';
import {
  altProblem,
  detectEssentials,
  fillMissingAlt,
  findHero,
  isNonMarketingPage,
  isPrimaryCallToAction,
} from '../essentials';
import type { TellNode } from '../tells';
import type { GeneratedNodeSnapshot } from '../validate';

let seq = 0;
function n(type: string, label: string, props: Record<string, unknown> = {}, children: TellNode[] = []): TellNode {
  seq += 1;
  return { id: `${type}-${seq}`, type, label, props, children };
}
const snap = (node: TellNode): GeneratedNodeSnapshot =>
  ({ ...node, componentType: 'host', children: node.children.map(snap) }) as unknown as GeneratedNodeSnapshot;

const BUTTON_LINK = { href: '#booking', children: 'Book a table', style: { backgroundColor: '#b45309', padding: '14px 24px' } };
const NEW_PAGE = { newPage: true, brief: 'A landing page for a small Italian restaurant in Berlin' };

const page = (...nodes: TellNode[]) => ({ title: 'Trattoria', nodes });
const hero = (...children: TellNode[]) => n('section', 'Hero', {}, [n('h1', 'Headline', { children: 'Pasta, made this morning' }), ...children]);
const nav = (...children: TellNode[]) => n('header', 'Navigation', {}, [n('nav', 'Nav', {}, children)]);
const ids = (tree: ReturnType<typeof page>, opts = NEW_PAGE) => detectEssentials(tree, opts).map((f) => f.tell);

describe('hero call to action', () => {
  it('flags a new page whose hero has no call to action, with the hero path', () => {
    const findings = detectEssentials(page(nav(), hero(n('p', 'Subline', { children: 'Open daily' }))), NEW_PAGE);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ tell: 'hero-cta', path: 'Hero', autoFixable: false });
    expect(findings[0].detail).toMatch(/primary call to action/);
    expect(findings[0].detail).toMatch(/href/);
  });

  it('accepts a link styled as a button, a button, a form submit or a checkout', () => {
    expect(ids(page(hero(n('a', 'CTA', BUTTON_LINK))))).toEqual([]);
    expect(ids(page(hero(n('button', 'CTA', { children: 'Reserve' }))))).toEqual([]);
    expect(ids(page(hero(n('div', 'Form', { 'data-form-kind': 'form' }, [n('button', 'Send', { 'data-form-kind': 'form-submit', children: 'Send' })]))))).toEqual([]);
    expect(ids(page(hero(n('div', 'Checkout', { 'data-component-kind': 'checkout-button' }))))).toEqual([]);
    // Nested deep inside the hero still counts.
    expect(ids(page(hero(n('div', 'Actions', {}, [n('div', 'Row', {}, [n('a', 'CTA', BUTTON_LINK)])]))))).toEqual([]);
  });

  it('does not count a plain text link, a link without href, an empty button or the sticky bar', () => {
    expect(ids(page(hero(n('a', 'Menu link', { href: '#menu', children: 'See the menu' }))))).toEqual(['hero-cta']);
    expect(ids(page(hero(n('a', 'CTA', { ...BUTTON_LINK, href: '' }))))).toEqual(['hero-cta']);
    expect(ids(page(hero(n('a', 'CTA', { ...BUTTON_LINK, style: { backgroundColor: 'transparent', padding: '14px' } }))))).toEqual(['hero-cta']);
    expect(ids(page(hero(n('button', 'Empty', {}))))).toEqual(['hero-cta']);
    const sticky = n('div', 'Sticky call to action', { 'data-sticky-cta': 'bar', ctaLabel: 'Book', ctaHref: '#b' });
    expect(isPrimaryCallToAction(sticky)).toBe(false);
    expect(ids(page(hero(), sticky))).toEqual(['hero-cta']);
  });

  it('accepts a bordered (ghost) button link', () => {
    const ghost = n('a', 'CTA', { href: '/contact', children: 'Contact', style: { border: '1px solid #fff', padding: '12px 20px' } });
    expect(ids(page(hero(ghost)))).toEqual([]);
  });

  it('ignores a call to action in the navigation: the hero needs its own', () => {
    expect(ids(page(nav(n('a', 'Nav CTA', BUTTON_LINK)), hero()))).toEqual(['hero-cta']);
  });

  it('finds the hero by its h1, behind a navigation and inside a single main wrapper', () => {
    const h = hero();
    const tree = [n('main', 'Page', {}, [nav(), h, n('section', 'Menu', {}, [n('h2', 'Title', { children: 'Menu' })])])];
    expect(findHero(tree)).toBe(h);
    // Without an h1, the first section that is not the navigation.
    const first = n('section', 'Intro', {}, [n('h2', 'Title', { children: 'Hi' })]);
    expect(findHero([nav(), first, n('footer', 'Footer')])).toBe(first);
  });

  it('never checks a section generation (replace or insert)', () => {
    expect(ids(page(hero()), { newPage: false, brief: NEW_PAGE.brief })).toEqual([]);
  });

  it('skips pages that are clearly not marketing pages', () => {
    expect(ids(page(hero()), { newPage: true, brief: 'Write our privacy policy' })).toEqual([]);
    expect(ids(page(hero()), { newPage: true, brief: 'Bitte ein Impressum für die Bäckerei' })).toEqual([]);
    expect(ids(page(hero()), { newPage: true, brief: 'A friendly 404 page' })).toEqual([]);
    expect(ids(page(hero()), { newPage: true, brief: 'A thank you page after the booking form' })).toEqual([]);
    expect(ids({ title: 'AGB', nodes: [hero()] }, { newPage: true, brief: 'Our conditions' })).toEqual([]);
    expect(ids(page(hero()), { newPage: true, brief: 'Legal', pageTitle: 'Datenschutz' } as never)).toEqual([]);
  });
});

describe('isNonMarketingPage', () => {
  it('matches legal, 404 and thank-you pages in German and English', () => {
    expect(isNonMarketingPage('Create the imprint')).toBe(true);
    expect(isNonMarketingPage('Datenschutzerklärung nach DSGVO')).toBe(true);
    expect(isNonMarketingPage('terms and conditions for the shop')).toBe(true);
    expect(isNonMarketingPage(undefined, 'Privacy')).toBe(true);
    expect(isNonMarketingPage(undefined, 'Danke')).toBe(true);
    expect(isNonMarketingPage('page not found')).toBe(true);
  });

  it('keeps marketing briefs that only mention a legal word', () => {
    expect(isNonMarketingPage('A landing page for a privacy-first notes app')).toBe(false);
    expect(isNonMarketingPage('Homepage for a law firm specialising in terms of employment', 'Home')).toBe(false);
    expect(isNonMarketingPage('A bakery landing page', 'Fresh bread')).toBe(false);
  });
});

describe('alt text', () => {
  const img = (props: Record<string, unknown>, label = 'Photo') => n('img', label, { src: 'https://images.unsplash.com/photo-1', ...props });

  it('flags a missing, empty, generic, file-name or layer-name alt', () => {
    expect(altProblem(img({}))).toBe('missing');
    expect(altProblem(img({ alt: '  ' }))).toBe('missing');
    expect(altProblem(img({ alt: 'Image' }))).toBe('generic');
    expect(altProblem(img({ alt: 'photo' }))).toBe('generic');
    expect(altProblem(img({ alt: 'Picture.' }))).toBe('generic');
    expect(altProblem(img({ alt: 'Bild' }))).toBe('generic');
    expect(altProblem(img({ alt: 'Foto 2' }))).toBe('generic');
    expect(altProblem(img({ alt: 'IMG_4031.jpg' }))).toBe('file name');
    expect(altProblem(img({ alt: 'DSC01234' }))).toBe('file name');
    expect(altProblem(n('img', 'Photo', { src: '/uploads/team-dinner.webp', alt: 'team-dinner' }))).toBe('file name');
    expect(altProblem(img({ alt: 'Header photo' }, 'Header photo'))).toBe('layer name');
  });

  it('accepts a meaningful alt and a decorative image', () => {
    expect(altProblem(img({ alt: 'Two cooks rolling fresh pasta on a floured table' }))).toBeUndefined();
    // The layer name is fine when it is itself a description.
    expect(altProblem(img({ alt: 'Chef plating risotto' }, 'Chef plating risotto'))).toBeUndefined();
    expect(altProblem(img({ alt: '', 'data-decorative': 'true' }))).toBeUndefined();
    // The flag alone does not excuse a generic alt.
    expect(altProblem(img({ alt: 'Image', 'data-decorative': 'true' }))).toBe('generic');
  });

  it('reports each image with its layer path, also on section generations', () => {
    const tree = page(n('section', 'Gallery', {}, [img({}, 'Photo'), img({ alt: 'Image' }, 'Photo')]));
    const findings = detectEssentials(tree, { newPage: false });
    expect(findings.map((f) => [f.tell, f.path])).toEqual([
      ['alt-text', 'Gallery > Photo (1)'],
      ['alt-text', 'Gallery > Photo (2)'],
    ]);
    expect(findings[0].detail).toMatch(/has no alt text/);
    expect(findings[1].detail).toMatch(/generic alt text/);
    expect(findings[0].detail).toMatch(/"decorative": true/);
  });
});

describe('fillMissingAlt', () => {
  it('fills from the photo description, then a meaningful layer name, and reports each', () => {
    const a = n('img', 'Photo', {});
    const b = n('img', 'Owner at the counter', { src: 'https://example.com/a.jpg', alt: 'image' });
    const c = n('img', 'Image', { src: 'https://example.com/b.jpg' });
    const ok = n('img', 'Team', { alt: 'Our team at the summer party' });
    const deco = n('img', 'Texture', { alt: '', 'data-decorative': 'true' });
    const nodes = [snap(n('section', 'Hero', {}, [a, b, c, ok, deco]))];
    const out = fillMissingAlt(nodes, [{ nodeId: a.id, kind: 'img', query: 'fresh sourdough loaves on a wooden table' }]);
    const [fa, fb, fc, fok, fdeco] = out.nodes[0].children;
    expect(fa.props.alt).toBe('Fresh sourdough loaves on a wooden table');
    expect(fb.props.alt).toBe('Owner at the counter');
    expect(fc.props.alt).toBe('');
    expect(fc.props['data-decorative']).toBeUndefined();
    expect(fok).toBe(nodes[0].children[3]);
    expect(fdeco).toBe(nodes[0].children[4]);
    expect(out.filled).toBe(2);
    expect(out.unfilled).toEqual(['Hero > Image']);
    expect(out.notes).toEqual([
      'Hero > Photo: alt text filled from the photo description ("Fresh sourdough loaves on a wooden table"); check it describes the photo',
      'Hero > Owner at the counter: alt text filled from the layer name ("Owner at the counter"); check it describes the image',
    ]);
    // The input is not mutated.
    expect(nodes[0].children[0].props.alt).toBeUndefined();
  });

  it('leaves a clean tree untouched', () => {
    const nodes = [snap(n('img', 'Team', { alt: 'Our team at the summer party' }))];
    const out = fillMissingAlt(nodes, []);
    expect(out.nodes[0]).toBe(nodes[0]);
    expect(out.notes).toEqual([]);
  });
});
