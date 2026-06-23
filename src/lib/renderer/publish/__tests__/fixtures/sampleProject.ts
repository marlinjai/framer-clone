// Deterministic MST ProjectModel fixtures for the publish-pipeline tests.
//
// Built from plain snapshots (no uuid / Date randomness) so emitted HTML, CSS,
// and the manifest are byte-stable across runs. Uses only HOST elements
// (div/h1/p/img/span) so the headless render needs no `window.__componentRegistry`
// entry. Reusable by the per-page emitter, asset-collector, and publisher suites.

import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';

export const BP_DESKTOP = 'bp-desktop';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function viewport(): any {
  return {
    id: 'viewport-desktop',
    type: 'div',
    componentType: 'host',
    canvasNodeType: 'viewport',
    label: 'Desktop',
    breakpointId: BP_DESKTOP,
    breakpointMinWidth: 1280,
    viewportWidth: 1280,
    viewportHeight: 800,
    canvasX: 0,
    canvasY: 0,
    props: {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function homeAppTree(): any {
  return {
    id: 'home-root',
    type: 'div',
    componentType: 'host',
    canvasNodeType: 'component',
    props: { style: { padding: '24px', fontFamily: 'Inter, sans-serif' } },
    children: [
      {
        id: 'home-title',
        type: 'h1',
        componentType: 'host',
        canvasNodeType: 'component',
        props: { children: 'Welcome home', style: { color: '#111827' } },
      },
      {
        // Relative asset: should be collected + bundlable.
        id: 'home-hero',
        type: 'img',
        componentType: 'host',
        canvasNodeType: 'component',
        props: { src: '/media/hero.jpg', alt: 'Hero', style: { width: '100%' } },
      },
      {
        // External CDN asset: should be IGNORED by the collector.
        id: 'home-cdn',
        type: 'img',
        componentType: 'host',
        canvasNodeType: 'component',
        props: { src: 'https://cdn.example.com/logo.png', alt: 'Logo' },
      },
      {
        // backgroundImage url(...) relative asset inside style.
        id: 'home-banner',
        type: 'div',
        componentType: 'host',
        canvasNodeType: 'component',
        props: {
          style: {
            backgroundImage: 'url(/media/banner.png)',
            height: '120px',
          },
        },
        children: [
          {
            id: 'home-banner-text',
            type: 'span',
            componentType: 'host',
            canvasNodeType: 'component',
            props: { children: 'On sale now' },
          },
        ],
      },
      {
        // Hidden node: must be omitted from emitted HTML.
        id: 'home-hidden',
        type: 'p',
        componentType: 'host',
        canvasNodeType: 'component',
        canvasVisible: false,
        props: { children: 'invisible-marker' },
      },
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function simpleAppTree(rootId: string, heading: string): any {
  return {
    id: rootId,
    type: 'div',
    componentType: 'host',
    canvasNodeType: 'component',
    props: { style: { padding: '16px' } },
    children: [
      {
        id: `${rootId}-h`,
        type: 'h1',
        componentType: 'host',
        canvasNodeType: 'component',
        props: { children: heading },
      },
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function page(id: string, slug: string, title: string, appTree: any): any {
  return {
    id,
    slug,
    metadata: {
      title,
      description: '',
      keywords: [],
      ogTitle: '',
      ogDescription: '',
      ogImage: '',
      canonicalUrl: '',
    },
    appComponentTree: appTree,
    canvasNodes: { 'viewport-desktop': viewport() },
  };
}

/**
 * A three-page project: a `home` (root) page with assets + a hidden node, plus
 * `about` and `contact` nested pages.
 */
export function makeSampleProject(): ProjectModelType {
  return ProjectModel.create({
    id: 'proj_sample',
    metadata: { title: 'Sample Site', description: 'A fixture site' },
    pages: {
      'page-home': page('page-home', 'home', 'Home', homeAppTree()),
      'page-about': page(
        'page-about',
        'about',
        'About',
        simpleAppTree('about-root', 'About us'),
      ),
      'page-contact': page(
        'page-contact',
        'contact',
        'Contact',
        simpleAppTree('contact-root', 'Contact us'),
      ),
    },
  });
}

/** A single-page project (the `home` page only), for focused emitter tests. */
export function makeSinglePageProject(): ProjectModelType {
  return ProjectModel.create({
    id: 'proj_single',
    metadata: { title: 'Single', description: '' },
    pages: { 'page-home': page('page-home', 'home', 'Home', homeAppTree()) },
  });
}
