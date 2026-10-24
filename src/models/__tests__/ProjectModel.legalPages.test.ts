// Legal pages on the model: created from the template at a stable slug, never
// twice, marked as a template, and linked from every footer in one action.
import { describe, expect, it } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectModelType } from '../ProjectModel';
import { createIntrinsicComponent, type ComponentInstance } from '../ComponentModel';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';

function project(language = 'de'): ProjectModelType {
  const p = ProjectModel.create({ id: 'proj', metadata: { title: 'Bakery' }, pages: {} });
  const home = p.createPage('Home');
  home.setSlug('');
  const root = home.appComponentTree as unknown as ComponentInstance;
  root.updateResponsiveStyle('fontFamily', 'Inter, sans-serif');
  const footer = createIntrinsicComponent('footer-1', 'footer', { style: { color: '#fff' } });
  footer.addChild(createIntrinsicComponent('a-1', 'a', { href: '/kontakt', children: 'Kontakt' }));
  root.addChild(footer);
  const base = normalizeSiteSettings({});
  p.updateSiteSettings({
    ...base,
    language,
    business: { ...base.business, legalName: 'Bäckerei Müller GmbH', email: 'hallo@mueller.de' },
  });
  return p;
}

const texts = (node: unknown): string[] => {
  const n = node as { props?: { children?: unknown }; children?: unknown[] };
  const own = typeof n.props?.children === 'string' ? [n.props.children] : [];
  return [...own, ...(n.children ?? []).flatMap(texts)];
};

const footerLinks = (p: ProjectModelType) => {
  const home = p.pagesArray.find((pg) => pg.slug === '')!;
  const snap = getSnapshot(home.appComponentTree) as { children: Array<{ type: string; children?: unknown[] }> };
  const footer = snap.children.find((c) => c.type === 'footer')!;
  const hrefs: string[] = [];
  const walk = (n: { props?: { href?: string }; children?: unknown[] }) => {
    if (n.props?.href) hrefs.push(n.props.href);
    (n.children as typeof n[] | undefined)?.forEach(walk);
  };
  walk(footer as never);
  return hrefs;
};

describe('createLegalPage', () => {
  it('creates the Impressum at /impressum, filled and marked as a template', () => {
    const p = project();
    const { page, created } = p.createLegalPage('impressum');
    expect(created).toBe(true);
    expect(page.slug).toBe('impressum');
    expect(page.metadata.title).toBe('Impressum');
    expect(page.metadata.legalTemplate).toBe('impressum');
    const all = texts(getSnapshot(page.appComponentTree)).join('\n');
    expect(all).toContain('Bäckerei Müller GmbH');
    expect(all).toContain('[Telefonnummer]');
    // The home page's font.
    const style = (getSnapshot(page.appComponentTree) as { props: { style: Record<string, unknown> } }).props.style;
    expect(style.fontFamily).toBe('Inter, sans-serif');
  });

  it('uses the English slugs on an English site', () => {
    const p = project('en');
    expect(p.createLegalPage('impressum').page.slug).toBe('imprint');
    expect(p.createLegalPage('privacy').page.slug).toBe('privacy');
    expect(p.createLegalPage('terms').page.slug).toBe('terms');
  });

  it('never creates a second copy: returns the existing page (also an owner-made one)', () => {
    const p = project();
    const first = p.createLegalPage('privacy');
    const again = p.createLegalPage('privacy');
    expect(again.created).toBe(false);
    expect(again.page.id).toBe(first.page.id);
    const own = p.createPage('AGB');
    expect(own.slug).toBe('agb');
    expect(p.createLegalPage('terms')).toMatchObject({ created: false });
    expect(p.pagesArray.filter((pg) => pg.slug.startsWith('datenschutz'))).toHaveLength(1);
  });

  it('links the new page from every footer, with the cookie settings link', () => {
    const p = project();
    p.createLegalPage('impressum');
    expect(footerLinks(p)).toEqual(['/kontakt', '/impressum', '#cookie-settings']);
    p.createLegalPage('privacy');
    // Added to the same nav, nothing twice.
    expect(footerLinks(p)).toEqual(['/kontakt', '/impressum', '#cookie-settings', '/datenschutz']);
  });
});

describe('addLegalLinksToFooters', () => {
  it('adds only missing links and reports pages without a footer', () => {
    const p = project();
    p.createLegalPage('impressum');
    p.createPage('Über uns');
    const result = p.addLegalLinksToFooters();
    expect(result).toEqual({ pagesUpdated: 0, pagesWithoutFooter: 1 });
    expect(footerLinks(p)).toEqual(['/kontakt', '/impressum', '#cookie-settings']);
  });

  it('labels the nav and links in the site language', () => {
    const p = project('en');
    p.createLegalPage('privacy');
    const home = p.pagesArray.find((pg) => pg.slug === '')!;
    const all = texts(getSnapshot(home.appComponentTree));
    expect(all).toContain('Privacy');
    expect(all).toContain('Cookie settings');
  });
});
