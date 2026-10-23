// The published page carries the @font-face rules for exactly the library
// families it uses (responsive maps included), served from its own origin,
// and preloads the face of its first heading's family.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { ComponentNode, CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage } from '../renderPublishedPage';

const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;
const commerceRepo = {} as CommerceServerRepository;
const breakpoints = [
  { id: 'desktop', minWidth: 1200 },
  { id: 'mobile', minWidth: 0 },
];

async function html(root: ComponentNode): Promise<string> {
  const { body } = await renderPublishedPage({ root, pageParams: {}, cmsRepo, commerceRepo, breakpoints });
  return renderToString(<>{body}</>);
}

const page: ComponentNode = {
  type: 'main',
  id: 'root',
  props: { style: { fontFamily: "'Hanken Grotesk', system-ui, sans-serif" } },
  children: [
    {
      type: 'h1',
      id: 'h',
      props: {
        children: 'Hello',
        style: { fontFamily: { base: "'Fraunces', Georgia, serif", mobile: "'Big Shoulders', sans-serif" }, fontSize: { base: '64px', mobile: '40px' } },
      },
    },
    { type: 'p', id: 'p', props: { children: 'Body' } },
  ],
};

describe('published page fonts', () => {
  it('declares the used families only, from the site origin, with font-display swap', async () => {
    const out = await html(page);
    expect(out).toContain('data-fc-fonts');
    for (const family of ['Hanken Grotesk', 'Fraunces', 'Big Shoulders']) {
      expect(out).toContain(`font-family:'${family}'`);
    }
    expect(out).not.toContain("font-family:'Newsreader'");
    expect(out).not.toContain("font-family:'Manrope'");
    expect(out).toContain("url('/fonts/fraunces/5.3.0/fraunces-latin-standard-normal.woff2')");
    expect(out).toContain('font-display:swap');
    expect(out).not.toMatch(/googleapis|gstatic/);
  });

  it('preloads the latin face of the first heading family, with crossorigin', async () => {
    const out = await html(page);
    expect(out).toMatch(/<link rel="preload" href="\/fonts\/fraunces\/5\.3\.0\/fraunces-latin-standard-normal\.woff2" as="font" type="font\/woff2" crossorigin="anonymous"\/>/);
  });

  it('emits no font CSS and no preload for a page on system fonts', async () => {
    const out = await html({ type: 'main', id: 'r', props: { style: { fontFamily: 'Georgia, serif' } }, children: [] });
    expect(out).not.toContain('data-fc-fonts');
    expect(out).not.toContain('rel="preload"');
  });
});

describe('the published site base font', () => {
  it('falls back to the system stack, never to the editor chrome face', async () => {
    const { default: SiteLayout } = await import('@/app/(site)/layout');
    const out = renderToString(<SiteLayout><p>x</p></SiteLayout>);
    expect(out).toContain('body{font-family:system-ui, -apple-system');
    expect(out).not.toMatch(/geist/i);
  });
});
