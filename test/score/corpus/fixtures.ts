// The parity corpus: each fixture pairs an original (real HTML and CSS, or a real
// Radix component) with the closest node tree the format can store. Trees are
// written the way an author would: the declarations an element has without any
// selector go on the node, what needs a selector goes in `props.rules` as the
// author would write it, and what the format cannot hold is left out rather than
// faked. A hover colour inlined to match a screenshot would be a lie, so a state's
// value only ever sits in a rule.
//
// Each state names the gap its failure belongs to, which is what the state exists
// to probe. The classifier in compare.ts overrides that when the evidence is more
// specific (lost text, a pseudo-element).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { HOVER_GATE } from '@/lib/rules/states';
import { deriveTabs } from '@/lib/behaviour/presets/tabs';
import type { PresetNode } from '@/lib/behaviour/presets';
import { n, run, t } from '../patterns';
import type { GapId } from '../lib/types';
import { renderPublished, renderThroughPublishedPage, viewportCanvasNodes, type PublishedOutput } from '../lib/published';
import type { ComponentDefinitions } from '@/lib/components/definition';
import type { SiteTheme } from '@/lib/site/theme';

const FIXTURE_DIR = path.resolve(process.cwd(), 'test/score/corpus/fixtures');

export const fixtureFile = (name: string) => path.join(FIXTURE_DIR, name);

export interface FixtureState {
  id: string;
  gap: GapId;
  /** Runs on both pages; leaves the page in the state to compare. */
  apply: (page: Page) => Promise<void>;
  media?: 'print';
}

export interface Fixture {
  id: string;
  group: 'edge' | 'component';
  source: string;
  /** A whole HTML file, or a Radix mount script bundled in the page. */
  original: { html: string } | { mount: string; css: string };
  tree: () => ComponentNode;
  /**
   * The replica through the whole published path, for a fixture that needs
   * hydration, as a placement does (renderThroughPublishedPage). Used instead of `tree`.
   */
  published?: () => Promise<PublishedOutput>;
  /** The gap of a difference in the untouched page, when the fixture exists to probe one. */
  initialGap: GapId;
  /** Runs before the initial state: fixes moving parts so a snapshot is repeatable. */
  prepare?: (page: Page) => Promise<void>;
  states: FixtureState[];
  notMeasured?: string[];
}

const parity = (id: string, props: Record<string, unknown> = {}) => ({ ...props, 'data-parity-id': id });
const el = (page: Page, id: string) => page.locator(`[data-parity-id="${id}"]`);

const hover = (id: string): FixtureState => ({ id: `hover ${id}`, gap: 'selector-styles', apply: (page) => el(page, id).hover() });

const FONT = 'Arial, sans-serif';

/** The Radix tabs as the tabs preset stores them: its nodes laid out, then derived. Only the style is the fixture's. */
function radixTabs(): ComponentNode {
  const state = 'radix-tabs-active';
  const trigger = (value: string, title: string, index: number) =>
    t('button', title, parity(`trigger-${value}`, {
      type: 'button',
      role: 'tab',
      'data-orientation': 'horizontal',
      style: { border: 0, background: 'none', borderRadius: '6px', padding: '4px 8px', font: 'inherit', fontWeight: 500, cursor: 'pointer' },
      rules: [{ id: 'on', selector: '&', when: { state, eq: index }, style: { background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' } }],
    }));
  const content = (value: string, text: string) =>
    t('div', text, parity(`content-${value}`, { role: 'tabpanel', tabIndex: 0, 'data-orientation': 'horizontal', style: { paddingTop: '8px' } }));
  return n(
    'div',
    parity('page', { style: { font: `14px/20px ${FONT}`, color: '#0a0a0a', padding: '24px', maxWidth: '480px' } }),
    deriveTabs({
      ...n(
        'div',
        parity('tabs', { dir: 'ltr', 'data-orientation': 'horizontal' }),
        n(
          'div',
          parity('list', {
            role: 'tablist',
            'aria-label': 'Settings',
            'aria-orientation': 'horizontal',
            'data-orientation': 'horizontal',
            style: { display: 'inline-flex', background: '#f5f5f5', borderRadius: '8px', padding: '3px', outline: 'none' },
          }),
          trigger('account', 'Account', 0),
          trigger('password', 'Password', 1),
        ),
        content('account', 'Change your name.'),
        content('password', 'Change your password.'),
      ),
      id: 'radix-tabs',
    } as PresetNode) as ComponentNode,
  );
}

/** A 32px circle as an SVG, the same bytes as in stylesheet-values.html. */
const DOT_SVG = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iOCIgZmlsbD0iIzFkNGVkOCIvPjwvc3ZnPg==';

const responsive = (base: unknown, tablet: unknown, mobile: unknown) => ({ base, tablet, mobile });

/** Tailwind's defaults for what a utility has not set: the empty value, so its var() list stays valid. */
const TAILWIND_EMPTY = { '--tw-blur': ' ', '--tw-sepia': ' ', '--tw-ring-inset': ' ', '--tw-ring-shadow': '0 0 #0000', '--tw-shadow': '0 1px 2px #0003' };
const TAILWIND_FILTER = 'var(--tw-blur) var(--tw-sepia) drop-shadow(0 1px 1px #0004)';
const TAILWIND_RING = 'var(--tw-ring-inset) var(--tw-ring-shadow), var(--tw-shadow)';

/** The named states, written the way the panel stores them (src/lib/rules/states.ts). */
const hoverRule = (style: Record<string, unknown>) => ({ id: 'hover', selector: '&:hover', at: [HOVER_GATE], style });
const focusedRule = (style: Record<string, unknown>) => ({ id: 'focused', selector: '&:focus-visible', style });
const pressedRule = (style: Record<string, unknown>) => ({ id: 'pressed', selector: '&:active', style });
const rule = (id: string, selector: string, style: Record<string, unknown>) => ({ id, selector, style });
const wrapped = (id: string, at: string, style: Record<string, unknown>, selector = '&') => ({ id, selector, at: [at], style });

const WIDE_CARD = '@container (min-width: 600px)';

// Reusable components, written as docs/plans/2026-11-02-reusable-components.md stores
// them: a definition is a small page with frames of its own, so every responsive map
// inside one is keyed on its own breakpoint ids (`<prefix>-tablet`), never the page's.
// A placement holds only its definition id, its input values, its initial state and
// how it sits on the page. The trees are written from the contract alone, and the
// replica goes through the whole published path, where placements expand.

/** One read binding per slot, as the panel's binding control stores it. */
const bound = (node: ComponentNode, slots: Record<string, string>): ComponentNode =>
  ({ ...node, bindings: Object.fromEntries(Object.entries(slots).map(([slot, expression]) => [slot, { mode: 'read', expression }])) }) as ComponentNode;

/** A breakpoint id of a definition's own frames (viewportCanvasNodes). */
const own = (prefix: string, breakpoint: 'tablet' | 'mobile') => `${prefix}-${breakpoint}`;

interface StoredDefinition {
  id: string;
  name: string;
  prefix: string;
  tree: ComponentNode;
  inputs: Record<string, unknown>[];
  states?: Record<string, unknown>[];
  noScriptState?: string;
}

function definitions(...stored: StoredDefinition[]): ComponentDefinitions {
  return Object.fromEntries(
    stored.map(({ id, name, prefix, tree, inputs, states = [], noScriptState }) => [
      id,
      {
        id,
        name,
        page: { id: `${prefix}-page`, slug: prefix, appComponentTree: tree, canvasNodes: viewportCanvasNodes(prefix) },
        inputs,
        states,
        ...(noScriptState ? { noScriptState } : {}),
      },
    ]),
  ) as unknown as ComponentDefinitions;
}

/** A `#component` node: the definition it places and what this use sets. */
const placement = (id: string, component: string, props: Record<string, unknown> = {}): ComponentNode =>
  ({ id, type: '#component', componentType: 'host', props: { component, ...props } }) as unknown as ComponentNode;

/** A component state's difference, stored fail-closed until expansion compiles it. */
const stateRule = (state: string, style: Record<string, unknown>) => ({ id: `state-${state}`, componentState: state, selector: '&', style });

/** The `choice` state a definition's custom states live in: `cs-` and the first 8 of its id. */
const choiceStateOf = (definitionId: string) => `cs-${definitionId.slice(0, 8)}`;

/** Removes the behaviour gate, and the original's own `js` class: what a page is left with when its script failed. */
const scriptFailed = (page: Page) =>
  page.evaluate(() => {
    document.documentElement.removeAttribute('data-fc-b');
    document.documentElement.classList.remove('js');
  });

const CARD = 'a3c1e2d4-5b6f-4a7e-8c9d-0e1f2a3b4c5d';
const EVENT_CARD = 'b4d2f3e5-6c7a-4b8f-9dae-1f2a3b4c5d6e';
const NAVBAR = '2f6c1a9e-7d3b-4c5a-9e8f-1a2b3c4d5e6f';
const TILE = 'c5e3a4f6-7d8b-4c9a-8ebf-2a3b4c5d6e7f';

/** The card of the contract's canonical example: a link with an image, an optional badge, a title and a line of copy. */
function roomCard(): StoredDefinition {
  const prefix = 'card';
  return {
    id: CARD,
    name: 'Room card',
    prefix,
    inputs: [
      { id: 'title', name: 'Title', type: 'text', default: 'Card title' },
      { id: 'copy', name: 'Copy', type: 'text', default: 'Ask us about this room.' },
      { id: 'image', name: 'Image', type: 'image', default: { src: '/images/placeholder.jpg', alt: '' } },
      { id: 'href', name: 'Link', type: 'link', default: '/' },
      { id: 'badge', name: 'Show badge', type: 'toggle', default: false },
    ],
    tree: bound(
      n(
        'a',
        parity('card', {
          style: { display: 'block', overflow: 'hidden', border: '1px solid #e5e7eb', borderRadius: '12px', background: '#fff', color: 'inherit', textDecoration: 'none' },
        }),
        bound(
          n('img', parity('card-image', { style: { display: 'block', width: '100%', height: '120px', objectFit: 'cover', background: '#e5e7eb' } })),
          { src: '{{input.image.src}}', alt: '{{input.image.alt}}' },
        ),
        bound(
          t('span', 'New', parity('card-badge', {
            style: {
              display: 'inline-block', margin: '12px 16px 0', padding: '2px 8px', borderRadius: '999px', background: '#fef3c7', color: '#92400e',
              fontSize: '12px', fontWeight: 700,
            },
          })),
          { visible: '{{input.badge}}' },
        ),
        bound(
          t('h3', 'Card title', parity('card-title', { style: { margin: '12px 16px 4px', fontSize: { base: '20px', [own(prefix, 'mobile')]: '18px' }, lineHeight: 1.3 } })),
          { children: '{{input.title}}' },
        ),
        bound(t('p', 'Ask us about this room.', parity('card-copy', { style: { margin: '0 16px 16px', color: '#4b5563' } })), { children: '{{input.copy}}' }),
      ),
      { href: '{{input.href}}' },
    ),
  };
}

function cardsPage(): ComponentNode {
  const cell = (index: number, inputs: Record<string, unknown>) =>
    n('li', parity(`cell-${index}`), placement(`room-${index}`, CARD, { inputs }));
  return n(
    'main',
    parity('page', { style: { font: `16px/1.5 ${FONT}`, color: '#111827', padding: responsive('32px', undefined, '16px') } }),
    t('h1', 'Rooms', parity('title', { style: { fontSize: '28px', lineHeight: 1.2, margin: '0 0 24px' } })),
    n(
      'ul',
      parity('grid', {
        style: {
          listStyle: 'none', margin: 0, padding: 0, display: 'grid',
          gridTemplateColumns: responsive('repeat(3, 1fr)', 'repeat(2, 1fr)', '1fr'),
          gap: responsive('24px', undefined, '16px'),
        },
      }),
      cell(1, {
        title: 'Garden room', copy: 'Opens onto the courtyard.', image: { src: '/images/garden.jpg', alt: 'Courtyard garden' }, href: '/rooms/garden', badge: true,
      }),
      cell(2, { title: 'Attic', copy: 'Under the roof, with a skylight.', image: { src: '/images/attic.jpg', alt: 'Attic skylight' }, href: '/rooms/attic' }),
      // No copy of its own: the default shows.
      cell(3, { title: 'Cellar', image: { src: '/images/cellar.jpg', alt: 'Vaulted cellar' }, href: '/rooms/cellar' }),
    ),
  );
}

/** An event card, placed once as a Collection's row template and fed from each row. */
function eventCard(): StoredDefinition {
  const prefix = 'event';
  return {
    id: EVENT_CARD,
    name: 'Event card',
    prefix,
    inputs: [
      { id: 'title', name: 'Title', type: 'text', default: 'Event' },
      { id: 'copy', name: 'Copy', type: 'text' },
      { id: 'featured', name: 'Featured', type: 'toggle', default: false },
    ],
    tree: n(
      'article',
      parity('card', {
        style: { border: '1px solid #e5e7eb', borderRadius: '12px', padding: { base: '20px', [own(prefix, 'mobile')]: '16px' }, background: '#fff' },
      }),
      bound(
        t('span', 'Featured', parity('card-badge', {
          style: {
            display: 'inline-block', margin: '0 0 8px', padding: '2px 8px', borderRadius: '999px', background: '#dcfce7', color: '#166534',
            fontSize: '12px', fontWeight: 700,
          },
        })),
        { visible: '{{input.featured}}' },
      ),
      bound(t('h3', 'Event', parity('card-title', { style: { margin: '0 0 4px', fontSize: '20px', lineHeight: 1.3 } })), { children: '{{input.title}}' }),
      bound(t('p', '', parity('card-copy', { style: { margin: 0, color: '#4b5563' } })), { children: '{{input.copy}}' }),
    ),
  };
}

const EVENT_ROWS = [
  { title: 'Spring market', copy: 'Local growers in the courtyard.', featured: false },
  { title: 'Night of open studios', copy: 'Every door on the street open until midnight.', featured: true },
  { title: 'Repair cafe', copy: 'Bring what is broken, leave with it fixed.', featured: false },
];

function collectionPage(): ComponentNode {
  const template = bound(placement('event-row', EVENT_CARD), {
    'input.title': '{{row.title}}',
    'input.copy': '{{row.copy}}',
    'input.featured': '{{row.featured}}',
  });
  return n(
    'main',
    parity('page', { style: { font: `16px/1.5 ${FONT}`, color: '#111827', padding: responsive('32px', undefined, '16px') } }),
    t('h1', 'Upcoming events', parity('title', { style: { fontSize: '28px', lineHeight: 1.2, margin: '0 0 24px' } })),
    bound(
      n(
        'div',
        parity('list', {
          'data-component-kind': 'collection',
          style: { display: 'grid', gridTemplateColumns: responsive('repeat(3, 1fr)', 'repeat(2, 1fr)', '1fr'), gap: responsive('24px', undefined, '16px') },
        }),
        template,
      ),
      { collection: 'events' },
    ),
  );
}

/**
 * The contract's worked navbar: a tone input on the root's `data-tone`, a Closed and an
 * Open state, a menu button that cycles them and closes on Escape, and Open kept
 * without a script. Unlike the worked example the menu collapses at every width, so
 * each breakpoint has something to open.
 */
function navbar(): StoredDefinition {
  const prefix = 'nav';
  const S = choiceStateOf(NAVBAR);
  const link = (id: string, label: string, href: string) => t('a', label, parity(`link-${id}`, { href, style: { color: 'inherit', textDecoration: 'none' } }));
  return {
    id: NAVBAR,
    name: 'Navbar',
    prefix,
    inputs: [{ id: 'tone', name: 'Tone', type: 'choice', default: 'light', options: [{ label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }] }],
    states: [{ id: 's1', name: 'Open', kind: 'custom' }],
    noScriptState: 's1',
    tree: bound(
      n(
        'header',
        parity('navbar', {
          style: {
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
            padding: { base: '16px 24px', [own(prefix, 'mobile')]: '12px 16px' },
            background: '#fff', color: '#111827', borderBottom: '1px solid #e5e7eb',
          },
          rules: [rule('dark', '&[data-tone="dark"]', { background: '#111827', color: '#f9fafb', borderBottomColor: '#374151' })],
          behaviour: { state: [{ id: S, name: 'State', type: 'choice', initial: 'primary', options: ['primary', 's1'] }] },
        }),
        t('a', 'Lumen', parity('logo', { href: '/', style: { fontWeight: 700, fontSize: '20px', color: 'inherit', textDecoration: 'none' } })),
        t(
          'button',
          'Menu',
          parity('menu-button', {
            type: 'button',
            'aria-controls': 'site-menu',
            style: { border: '1px solid currentColor', borderRadius: '6px', background: 'none', color: 'inherit', padding: '6px 12px', font: 'inherit', cursor: 'pointer' },
            rules: [focusedRule({ outline: '3px solid #f59e0b', outlineOffset: '2px' })],
            behaviour: {
              on: [
                { id: 't1', on: 'click', do: [{ step: S, wrap: true }] },
                { id: 't2', on: 'keydown', keys: ['Escape'], if: { state: S, eq: 's1' }, do: [{ set: S, value: 'primary' }] },
              ],
              bind: [{ attr: 'aria-expanded', from: { eq: [{ get: S }, 's1'] } }],
            },
          }),
        ),
        n(
          'nav',
          parity('menu', {
            id: 'site-menu',
            'aria-label': 'Main',
            style: {
              display: 'none', flexBasis: '100%',
              flexDirection: { base: 'row', [own(prefix, 'mobile')]: 'column' },
              gap: { base: '24px', [own(prefix, 'mobile')]: '8px' },
              paddingTop: '12px',
            },
            rules: [stateRule('s1', { display: 'flex' })],
          }),
          link('rooms', 'Rooms', '/rooms'),
          link('events', 'Events', '/events'),
          link('contact', 'Contact', '/contact'),
        ),
      ),
      { 'data-tone': '{{input.tone}}' },
    ),
  };
}

function navbarPage(): ComponentNode {
  return n(
    'div',
    parity('page', { style: { font: `16px/1.5 ${FONT}`, color: '#111827', margin: 0 } }),
    placement('site-navbar', NAVBAR, { inputs: { tone: 'dark' } }),
    n(
      'main',
      parity('content', { style: { padding: responsive('32px 24px', undefined, '24px 16px') } }),
      t('h1', 'Welcome', parity('heading', { style: { margin: '0 0 8px', fontSize: responsive('32px', undefined, '24px'), lineHeight: 1.2 } })),
      t('p', 'A guest house in the old town.', parity('copy', { style: { margin: 0 } })),
    ),
  );
}

/** A plan tile: Hover, Pressed and Focused as pointer states, and Selected as a custom state a click cycles. */
function planTile(): StoredDefinition {
  const prefix = 'tile';
  const S = choiceStateOf(TILE);
  const mobile = own(prefix, 'mobile');
  return {
    id: TILE,
    name: 'Plan tile',
    prefix,
    inputs: [
      { id: 'label', name: 'Label', type: 'text', default: 'Plan' },
      { id: 'price', name: 'Price', type: 'text', default: '' },
    ],
    states: [
      { id: 'hover', name: 'Hover', kind: 'hover' },
      { id: 'pressed', name: 'Pressed', kind: 'pressed', implies: ['hover'] },
      { id: 'focused', name: 'Focused', kind: 'focused' },
      { id: 's1', name: 'Selected', kind: 'custom' },
    ],
    tree: n(
      'button',
      parity('tile', {
        type: 'button',
        style: {
          display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px',
          minWidth: { base: '180px', [mobile]: '0' }, width: { base: 'auto', [mobile]: '100%' },
          padding: { base: '16px 20px', [mobile]: '12px 16px' },
          border: '2px solid #d1d5db', borderRadius: '10px', background: '#fff', color: '#111827', font: 'inherit', textAlign: 'left', cursor: 'pointer',
        },
        rules: [
          stateRule('hover', { background: '#eff6ff', borderColor: '#93c5fd' }),
          stateRule('pressed', { background: '#dbeafe', borderColor: '#3b82f6' }),
          stateRule('focused', { outline: '3px solid #f59e0b', outlineOffset: '2px' }),
          stateRule('s1', {
            background: { base: '#1d4ed8', [mobile]: '#1e40af' },
            borderColor: { base: '#1d4ed8', [mobile]: '#1e40af' },
            color: '#fff',
          }),
        ],
        behaviour: {
          state: [{ id: S, name: 'State', type: 'choice', initial: 'primary', options: ['primary', 's1'] }],
          on: [{ id: 't1', on: 'click', do: [{ step: S, wrap: true }] }],
          bind: [{ attr: 'aria-pressed', from: { eq: [{ get: S }, 's1'] } }],
        },
      }),
      bound(
        t('span', 'Plan', parity('tile-label', {
          style: { fontWeight: 700, color: '#111827' },
          rules: [stateRule('hover', { color: '#1d4ed8' }), stateRule('s1', { color: '#fff' })],
        })),
        { children: '{{input.label}}' },
      ),
      bound(
        t('span', '', parity('tile-price', { style: { fontSize: '14px', color: '#4b5563' }, rules: [stateRule('s1', { color: '#dbeafe' })] })),
        { children: '{{input.price}}' },
      ),
    ),
  };
}

function statesPage(): ComponentNode {
  const cell = (index: number, inputs: Record<string, unknown>) => n('li', parity(`cell-${index}`), placement(`plan-${index}`, TILE, { inputs }));
  return n(
    'div',
    parity('page', { style: { font: `16px/1.5 ${FONT}`, color: '#111827', padding: responsive('32px', undefined, '16px') } }),
    n(
      'ul',
      parity('options', {
        style: {
          listStyle: 'none', margin: 0, padding: 0, display: 'flex',
          flexDirection: responsive('row', undefined, 'column'), gap: responsive('16px', undefined, '12px'),
        },
      }),
      cell(1, { label: 'Monthly', price: '12 francs a month' }),
      cell(2, { label: 'Yearly', price: '120 francs a year' }),
    ),
  );
}

/** The first tile, by its own cell: inner parity ids repeat across placements, as they do in the original. */
const firstTile = (page: Page) => page.locator('[data-parity-id="cell-1"] button');

const PRESSED = async (page: Page) => {
  await firstTile(page).hover();
  await page.mouse.down();
};

/** A token reference, as a style value stores it (src/lib/site/theme.ts). */
const token = (id: string) => `var(--fc-t-${id})`;

/** A fixture's tree and its replica on a site with this theme, which the layout writes ahead of the page. */
const themed = (theme: SiteTheme, tree: () => ComponentNode): Pick<Fixture, 'tree' | 'published'> => ({
  tree,
  published: async () => ({ ...renderPublished(tree()), theme }),
});

const darkSystem: FixtureState = { id: 'dark system', gap: 'theme', apply: (page) => page.emulateMedia({ colorScheme: 'dark' }) };

const SITE_ORIGIN = 'https://corpus-site.test';
const FONT_FILES = path.resolve(process.cwd(), 'public/fonts');

/**
 * Moves a page onto an origin of its own, serving the self-hosted font files, so a face
 * declared at `/fonts/...` loads on both pages: a page set by content has no origin, so
 * neither page could load one, and both would pass on the same fallback. A declared face
 * that does not load is a broken harness, not a result, so it throws; a page that
 * declares none is left to the comparison.
 */
async function onSiteOrigin(page: Page): Promise<void> {
  if (!fs.existsSync(path.join(FONT_FILES, 'fraunces'))) execFileSync('pnpm', ['fonts:sync'], { stdio: 'ignore' });
  const html = await page.content();
  await page.route(`${SITE_ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    const file = path.join(FONT_FILES, url.pathname.replace(/^\/fonts\//, ''));
    if (url.pathname.startsWith('/fonts/') && file.startsWith(FONT_FILES) && fs.existsSync(file)) {
      return route.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(file) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${SITE_ORIGIN}/`);
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts].filter((face) => /fraunces/i.test(face.family));
    if (faces.length > 0) await Promise.all(faces.map((face) => face.load().catch(() => face)));
    return faces.length === 0 || faces.some((face) => face.status === 'loaded');
  });
  if (!loaded) throw new Error('a declared Fraunces face did not load: the font files are missing or not served');
}

export const FIXTURES: Fixture[] = [
  {
    id: 'mixed-text',
    group: 'edge',
    source: 'hand-written',
    original: { html: 'mixed-text.html' },
    initialGap: 'mixed-text',
    tree: () =>
      n(
        'article',
        parity('page', { style: { font: `16px/1.5 ${FONT}`, color: '#1f2937', padding: '24px', maxWidth: '640px' } }),
        n('h1', parity('title'), run('Our '), t('em', 'first', parity('title-em')), run(' shop')),
        n(
          'p',
          parity('lead'),
          run('Hello '),
          t('strong', 'bold', parity('lead-strong')),
          run(' and '),
          t('a', 'a link', parity('lead-link', { href: '#more', style: { color: '#1d4ed8' } })),
          run(' at the end of the sentence.'),
        ),
        n(
          'ul',
          parity('list'),
          t('li', 'Plain item', parity('item-1')),
          n('li', parity('item-2'), run('Item with '), t('code', 'code', parity('item-code')), run(' inside')),
        ),
      ),
    states: [],
  },
  {
    id: 'hover-focus',
    group: 'edge',
    source: 'hand-written',
    original: { html: 'hover-focus.html' },
    initialGap: 'layout-difference',
    tree: () =>
      n(
        'div',
        parity('page', { style: { font: `16px/1.5 ${FONT}`, color: '#1f2937', padding: '24px', display: 'flex', gap: '16px', alignItems: 'center' } }),
        t(
          'button',
          'Save',
          parity('button', {
            style: { background: '#1d4ed8', color: '#fff', border: 0, borderRadius: '6px', padding: '12px 20px', font: 'inherit', cursor: 'pointer' },
            rules: [
              hoverRule({ background: '#1e3a8a' }),
              focusedRule({ outline: '3px solid #f59e0b', outlineOffset: '2px' }),
              pressedRule({ background: '#172554' }),
            ],
          }),
        ),
        n(
          'input',
          parity('field', {
            'aria-label': 'Name',
            style: { border: '1px solid #9ca3af', borderRadius: '6px', padding: '10px 12px', font: 'inherit' },
            rules: [rule('focus', '&:focus', { borderColor: '#1d4ed8', outline: 'none', boxShadow: '0 0 0 3px #bfdbfe' })],
          }),
        ),
      ),
    states: [
      hover('button'),
      {
        id: 'pressed button',
        gap: 'selector-styles',
        apply: async (page) => {
          await el(page, 'button').hover();
          await page.mouse.down();
        },
      },
      {
        id: 'keyboard focus button',
        gap: 'selector-styles',
        apply: async (page) => {
          await page.keyboard.press('Tab');
        },
      },
      { id: 'focus field', gap: 'selector-styles', apply: (page) => el(page, 'field').focus() },
    ],
  },
  {
    id: 'keyframes',
    group: 'edge',
    source: 'hand-written',
    original: { html: 'keyframes.html' },
    initialGap: 'at-rules',
    // A global name carries the u- prefix, as an import adds it, so the original is
    // written with that name: the corpus compares `animation-name` like any property.
    tree: () =>
      n(
        'div',
        parity('page', { style: { font: `16px/1.5 ${FONT}`, padding: '24px', display: 'flex', gap: '16px' } }),
        n(
          'div',
          parity('dot', {
            style: { width: '80px', height: '80px', borderRadius: '50%', background: '#1d4ed8', animation: 'u-pulse 1s linear infinite' },
            rules: [
              {
                id: 'pulse',
                define: '@keyframes u-pulse',
                blocks: [
                  { selector: 'from', style: { opacity: 1, transform: 'scale(1)' } },
                  { selector: 'to', style: { opacity: 0.2, transform: 'scale(0.6)' } },
                ],
              },
            ],
          }),
        ),
      ),
    prepare: async (page) => {
      await page.evaluate(() => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; }));
    },
    states: [
      {
        id: 'half way through the animation',
        gap: 'at-rules',
        apply: async (page) => {
          await page.evaluate(() => document.getAnimations().forEach((a) => { a.currentTime = 500; }));
        },
      },
    ],
  },
  {
    id: 'container-query',
    group: 'edge',
    source: 'hand-written',
    original: { html: 'container-query.html' },
    initialGap: 'at-rules',
    tree: () =>
      n(
        'div',
        parity('page', { style: { font: `16px/1.5 ${FONT}`, padding: '24px' } }),
        n(
          'div',
          parity('shell', { style: { containerType: 'inline-size' } }),
          n(
            'div',
            parity('card', {
              style: { display: 'block', background: '#eff6ff', borderRadius: '8px', padding: '16px' },
              rules: [
                wrapped('wide', WIDE_CARD, { display: 'flex', gap: '24px', alignItems: 'center' }),
                wrapped('wide-heading', WIDE_CARD, { margin: 0 }, '& h2'),
              ],
            }),
            t('h2', 'Delivery', parity('heading', { style: { margin: '0 0 8px', fontSize: '20px' } })),
            t('p', 'Two working days inside Switzerland.', parity('copy', { style: { margin: 0 } })),
          ),
        ),
      ),
    states: [],
  },
  {
    id: 'print-styles',
    group: 'edge',
    source: 'hand-written',
    original: { html: 'print-styles.html' },
    initialGap: 'layout-difference',
    tree: () =>
      n(
        'div',
        parity('page', {
          style: { font: `16px/1.5 ${FONT}`, color: '#374151', background: '#f3f4f6', padding: '24px' },
          rules: [wrapped('print', '@media print', { color: '#000', background: '#fff', padding: 0 })],
        }),
        t(
          'div',
          'Share this page',
          parity('bar', {
            style: { background: '#1d4ed8', color: '#fff', padding: '12px', margin: '0 0 16px' },
            rules: [wrapped('print', '@media print', { display: 'none' })],
          }),
        ),
        t('p', 'The article text that belongs on paper.', parity('body', { style: { margin: 0 } })),
      ),
    states: [{ id: 'print', gap: 'media-queries', media: 'print', apply: async () => {} }],
  },
  {
    id: 'pseudo-elements',
    group: 'edge',
    source: 'hand-written',
    original: { html: 'pseudo-elements.html' },
    initialGap: 'selector-styles',
    tree: () =>
      n(
        'div',
        parity('page', { style: { font: `16px/1.5 ${FONT}`, color: '#1f2937', padding: '24px' } }),
        t(
          'blockquote',
          'Good design is honest.',
          parity('quote', {
            style: { position: 'relative', paddingLeft: '28px', margin: '0 0 16px' },
            // The original's escape, typed as the character: a rule holds no CSS escape.
            rules: [rule('mark', '&::before', { content: '"\u201C"', position: 'absolute', left: 0, top: '-8px', fontSize: '40px', color: '#1d4ed8' })],
          }),
        ),
        t(
          'span',
          'Feature',
          parity('badge', {
            style: { display: 'inline-block', padding: '4px 8px', background: '#fef3c7', borderRadius: '4px' },
            rules: [rule('tag', '&::after', { content: '" new"', fontWeight: 700, color: '#b45309' })],
          }),
        ),
        n(
          'ul',
          parity('list', { style: { margin: '16px 0 0' }, rules: [rule('marker', '& li::marker', { color: '#dc2626' })] }),
          t('li', 'One point', parity('item')),
        ),
        t('p', 'Once upon a time.', parity('drop', { rules: [rule('initial', '&::first-letter', { fontSize: '2em', fontWeight: 700 })] })),
      ),
    states: [],
  },
  {
    id: 'responsive-layout',
    group: 'edge',
    source: 'hand-written: what the format claims to hold, so a passing control for the harness',
    original: { html: 'responsive-layout.html' },
    initialGap: 'layout-difference',
    tree: () => {
      const card = (index: number, title: string, copy: string) =>
        n(
          'article',
          parity(`card-${index}`, { style: { background: '#f3f4f6', borderRadius: '12px', padding: '24px' } }),
          t('h2', title, parity(`h-${index}`, { style: { fontSize: '20px', margin: '0 0 8px' } })),
          t('p', copy, parity(`p-${index}`, { style: { margin: 0 } })),
        );
      return n(
        'main',
        parity('page', {
          style: { font: `16px/1.5 ${FONT}`, color: '#111827', padding: responsive('48px', '32px', '16px') },
        }),
        t(
          'h1',
          'Three plans',
          parity('title', { style: { fontSize: responsive('40px', undefined, '28px'), lineHeight: 1.2, margin: '0 0 24px' } }),
        ),
        n(
          'section',
          parity('grid', {
            style: {
              display: 'grid',
              gridTemplateColumns: responsive('repeat(3, 1fr)', 'repeat(2, 1fr)', '1fr'),
              gap: responsive('24px', undefined, '12px'),
            },
          }),
          card(1, 'Small', 'For one person.'),
          card(2, 'Team', 'For up to ten people.'),
          card(3, 'Company', 'For everybody else.'),
        ),
      );
    },
    states: [],
  },
  {
    id: 'stylesheet-values',
    group: 'edge',
    source: 'hand-written: ordinary CSS values on a node whose other styles are responsive',
    original: { html: 'stylesheet-values.html' },
    initialGap: 'renderer-drops-value',
    tree: () =>
      n(
        'section',
        parity('hero', {
          style: {
            font: `16px/1.5 ${FONT}`,
            padding: responsive('48px', undefined, '16px'),
            minHeight: '120px',
            backgroundImage: `url("data:image/svg+xml;base64,${DOT_SVG}")`,
            backgroundSize: '32px 32px',
          },
        }),
        t('p', 'Pattern behind the text', parity('copy', { style: { margin: 0 } })),
      ),
    states: [],
  },
  {
    id: 'empty-variables',
    group: 'edge',
    source: 'hand-written: the var() chain Tailwind builds, with empty custom properties, in the sheet and inline',
    original: { html: 'empty-variables.html' },
    initialGap: 'empty-custom-property',
    tree: () =>
      n(
        'section',
        parity('page', { style: { font: `16px/1.5 ${FONT}`, margin: 0 } }),
        // Responsive, so its styles go to the sheet, where an empty value used to be dropped.
        t('p', 'In the sheet', parity('sheet', { style: { ...TAILWIND_EMPTY, padding: responsive('24px', undefined, '8px'), filter: TAILWIND_FILTER, boxShadow: TAILWIND_RING } })),
        t('p', 'Inline', parity('inline', { style: { ...TAILWIND_EMPTY, padding: '24px', filter: TAILWIND_FILTER, boxShadow: TAILWIND_RING } })),
      ),
    states: [],
  },
  {
    id: 'document-styles',
    group: 'edge',
    source: 'hand-written: what a page sets on html and :root, read by the nodes under it',
    original: { html: 'document-styles.html' },
    initialGap: 'page-level-css',
    tree: () =>
      n(
        'main',
        parity('page', {
          style: { margin: 0, fontFamily: FONT },
          rules: [
            { id: 'document', selector: ':root', style: { scrollBehavior: 'smooth', overflowX: 'hidden', fontSize: responsive('20px', undefined, '16px'), color: '#1d4ed8', '--accent': '#b91c1c', '--gap': ' ' } },
            { id: 'still', selector: ':root', at: ['@media (prefers-reduced-motion: reduce)'], style: { scrollBehavior: 'auto' } },
          ],
        }),
        // A rem reads the document, and the colour and the variable come down from it.
        t('p', 'Sized from the document', parity('copy', { style: { width: '10rem', margin: 0 } })),
        t('p', 'Coloured from the document', parity('accent', { style: { color: 'var(--accent)', filter: 'var(--gap) blur(1px)', margin: 0 } })),
      ),
    states: [],
  },
  {
    id: 'stylesheet-escapes',
    group: 'edge',
    source: 'hand-written: CSS escapes, angle brackets, a raw SVG and a multi-line grid on nodes in the sheet',
    original: { html: 'stylesheet-escapes.html' },
    initialGap: 'renderer-drops-value',
    tree: () => {
      const cell = (id: string, text: string, area: string, content: string) =>
        t('p', text, parity(id, { style: { gridArea: area, margin: 0, padding: responsive('8px', undefined, '4px'), content } }));
      return n(
        'section',
        parity('hero', {
          style: {
            font: `16px/1.5 ${FONT}`,
            padding: responsive('48px', undefined, '16px'),
            minHeight: '120px',
            display: 'grid',
            gridTemplateColumns: '96px 1fr',
            gridTemplateAreas: '"head head"\n      "side main"',
            content: '"\\201C"',
            backgroundImage: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='8' fill='navy'/></svg>")`,
            backgroundSize: '32px 32px',
          },
        }),
        cell('head', 'Heading', 'head', '">"'),
        cell('side', 'Side', 'side', '"\\"\\A"'),
        cell('main', 'Main', 'main', '"</style>"'),
      );
    },
    states: [],
  },
  {
    id: 'shadcn-button',
    group: 'component',
    source: 'shadcn/ui Button (src/components/ui/button.tsx)',
    original: { html: 'shadcn-button.html' },
    initialGap: 'layout-difference',
    tree: () => {
      const base = {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px', whiteSpace: 'nowrap',
        borderRadius: '6px', fontSize: '14px', lineHeight: '20px', fontWeight: 500, fontFamily: 'inherit', height: '36px',
        padding: '8px 16px', boxSizing: 'border-box', border: 0, outline: 'none', flexShrink: 0, cursor: 'pointer',
        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
      };
      // Every variant shares these, as `.button` does in the original. The disabled
      // look comes from `:disabled`, not from values on the node.
      const shared = [
        focusedRule({ boxShadow: '0 0 0 3px rgba(161,161,161,0.5)' }),
        rule('disabled', '&:disabled', { pointerEvents: 'none', opacity: 0.5 }),
      ];
      const hovered = (background: string) => [hoverRule({ background }), ...shared];
      return n(
        'div',
        parity('page', { style: { font: `16px/1.5 ${FONT}`, padding: '24px', display: 'flex', flexWrap: 'wrap', gap: '12px' } }),
        t('button', 'Continue', parity('default', { style: { ...base, background: '#171717', color: '#fafafa' }, rules: hovered('rgba(23,23,23,0.9)') })),
        t('button', 'Cancel', parity('outline', { style: { ...base, background: '#fff', color: '#171717', border: '1px solid #e5e5e5' }, rules: hovered('#f5f5f5') })),
        t('button', 'Delete', parity('destructive', { style: { ...base, background: '#dc2626', color: '#fff' }, rules: hovered('rgba(220,38,38,0.9)') })),
        t(
          'button',
          'Disabled',
          parity('disabled', { disabled: true, style: { ...base, background: '#171717', color: '#fafafa' }, rules: hovered('rgba(23,23,23,0.9)') }),
        ),
      );
    },
    states: [
      hover('default'),
      hover('outline'),
      { id: 'keyboard focus', gap: 'selector-styles', apply: (page) => page.keyboard.press('Tab') },
    ],
  },
  {
    id: 'shadcn-card',
    group: 'component',
    source: 'shadcn/ui Card',
    original: { html: 'shadcn-card.html' },
    initialGap: 'layout-difference',
    tree: () =>
      n(
        'div',
        parity('page', { style: { font: `14px/20px ${FONT}`, padding: '24px' } }),
        n(
          'div',
          parity('card', {
            style: {
              display: 'flex', flexDirection: 'column', gap: '24px', border: '1px solid #e5e5e5', borderRadius: '12px',
              padding: '24px 0', background: '#fff', color: '#0a0a0a', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', maxWidth: '380px',
            },
          }),
          n(
            'div',
            parity('header', { style: { display: 'grid', gap: '6px', padding: '0 24px' } }),
            t('div', 'Create project', parity('title', { style: { fontWeight: 600, lineHeight: 1 } })),
            t('div', 'Deploy your new project in one click.', parity('description', { style: { color: '#737373', fontSize: '14px' } })),
          ),
          n('div', parity('content', { style: { padding: '0 24px' } }), t('p', 'Card content goes here.', parity('copy', { style: { margin: 0 } }))),
          n(
            'div',
            parity('footer', { style: { display: 'flex', alignItems: 'center', padding: '0 24px' } }),
            t('p', 'Card footer', parity('note', { style: { margin: 0 } })),
          ),
        ),
      ),
    states: [],
  },
  {
    id: 'radix-accordion',
    group: 'component',
    source: '@radix-ui/react-accordion',
    original: { mount: 'radix-accordion.tsx', css: 'radix.css' },
    initialGap: 'layout-difference',
    tree: () => {
      const item = (value: string, title: string) =>
        n(
          'div',
          parity(`item-${value}`, { 'data-state': 'closed', 'data-orientation': 'vertical', style: { borderBottom: '1px solid #e5e5e5' } }),
          n(
            'h3',
            parity(`heading-${value}`, { 'data-state': 'closed', 'data-orientation': 'vertical', style: { margin: 0, font: 'inherit' } }),
            t(
              'button',
              title,
              parity(`trigger-${value}`, {
                type: 'button',
                id: `trigger-${value}`,
                'aria-controls': `content-${value}`,
                'aria-expanded': 'false',
                'data-state': 'closed',
                'data-orientation': 'vertical',
                style: {
                  display: 'flex', width: '100%', justifyContent: 'space-between', padding: '16px 0', border: 0, background: 'none',
                  font: 'inherit', fontWeight: 500, textAlign: 'left', cursor: 'pointer',
                },
              }),
            ),
          ),
          n('div', parity(`content-${value}`, { id: `content-${value}`, 'aria-labelledby': `trigger-${value}`, role: 'region', hidden: true, 'data-state': 'closed', style: { padding: '0 0 16px' } })),
        );
      return n(
        'div',
        parity('page', { style: { font: `14px/20px ${FONT}`, color: '#0a0a0a', padding: '24px', maxWidth: '480px' } }),
        n(
          'div',
          parity('accordion', { 'data-orientation': 'vertical' }),
          item('one', 'Is it accessible?'),
          item('two', 'Is it styled?'),
        ),
      );
    },
    states: [
      { id: 'click opens the first item', gap: 'behaviour-state', apply: (page) => el(page, 'trigger-one').click() },
      {
        id: 'arrow key moves to the next trigger',
        gap: 'behaviour-state',
        apply: async (page) => {
          await el(page, 'trigger-one').focus();
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
        },
      },
      hover('trigger-one'),
    ],
  },
  {
    id: 'radix-tabs',
    group: 'component',
    source: '@radix-ui/react-tabs',
    original: { mount: 'radix-tabs.tsx', css: 'radix.css' },
    initialGap: 'layout-difference',
    tree: radixTabs,
    published: () => renderThroughPublishedPage({ tree: radixTabs(), definitions: {} }),
    states: [
      {
        id: 'arrow key changes the tab',
        gap: 'behaviour-state',
        apply: async (page) => {
          await el(page, 'trigger-account').focus();
          await page.keyboard.press('ArrowRight');
        },
      },
      { id: 'click changes the tab', gap: 'behaviour-state', apply: (page) => el(page, 'trigger-password').click() },
    ],
  },
  {
    id: 'radix-dialog',
    group: 'component',
    source: '@radix-ui/react-dialog',
    original: { mount: 'radix-dialog.tsx', css: 'radix.css' },
    initialGap: 'layout-difference',
    tree: () =>
      n(
        'div',
        parity('page', { style: { font: `14px/20px ${FONT}`, color: '#0a0a0a', padding: '24px', maxWidth: '480px' } }),
        t(
          'button',
          'Edit profile',
          parity('trigger', {
            type: 'button',
            'aria-haspopup': 'dialog',
            'aria-expanded': 'false',
            'data-state': 'closed',
            style: { border: '1px solid #e5e5e5', borderRadius: '6px', background: '#fff', padding: '8px 16px', font: 'inherit', cursor: 'pointer' },
          }),
        ),
      ),
    states: [
      { id: 'click opens the dialog', gap: 'behaviour-state', apply: (page) => el(page, 'trigger').click() },
      {
        id: 'Enter opens the dialog',
        gap: 'behaviour-state',
        apply: async (page) => {
          await el(page, 'trigger').focus();
          await page.keyboard.press('Enter');
        },
      },
    ],
  },
  {
    id: 'component-cards',
    group: 'component',
    source: 'hand-written: three placements of one card definition with different inputs, against three handwritten cards',
    original: { html: 'component-cards.html' },
    initialGap: 'reusable-components',
    tree: cardsPage,
    published: () => renderThroughPublishedPage({ tree: cardsPage(), definitions: definitions(roomCard()) }),
    states: [],
    notMeasured: [
      'That each node with a class has one CSS block, not one per placement: the corpus compares pixels, computed styles and the accessibility tree, never the sheet',
      'Inner parity ids repeat across placements, as they do in the original, so their styles are compared on the last card; each cell is compared on its own, text included',
    ],
  },
  {
    id: 'component-navbar',
    group: 'component',
    source: 'hand-written: the contract\'s navbar (a tone input, Closed and Open, Escape, Open kept without a script), collapsing at every width',
    original: { html: 'component-navbar.html' },
    initialGap: 'reusable-components',
    tree: navbarPage,
    published: () => renderThroughPublishedPage({ tree: navbarPage(), definitions: definitions(navbar()) }),
    states: [
      { id: 'click opens the menu', gap: 'reusable-components', apply: (page) => el(page, 'menu-button').click() },
      {
        id: 'Enter opens the menu and Escape closes it',
        gap: 'reusable-components',
        apply: async (page) => {
          await page.keyboard.press('Tab');
          await page.keyboard.press('Tab');
          await page.keyboard.press('Enter');
          await page.keyboard.press('Escape');
        },
      },
      { id: 'the script failed', gap: 'reusable-components', apply: scriptFailed },
    ],
    notMeasured: [
      'One definition on two pages: the corpus compares one document per fixture, so only this page is measured',
      'Scripts turned off entirely: every page runs with scripts on, so the no-script state is the one a failed script leaves, the behaviour gate removed',
    ],
  },
  {
    id: 'component-collection',
    group: 'component',
    source: 'hand-written: one card definition placed as a Collection\'s row template, its inputs bound to each row',
    original: { html: 'component-collection.html' },
    initialGap: 'reusable-components',
    tree: collectionPage,
    published: () => renderThroughPublishedPage({ tree: collectionPage(), definitions: definitions(eventCard()), rows: EVENT_ROWS }),
    states: [],
    notMeasured: ['Inner parity ids repeat across rows, as they do in the original, so their styles are compared on the last row; the list is compared whole, text included'],
  },
  {
    id: 'component-states',
    group: 'component',
    source: 'hand-written: a plan tile with Hover, Pressed and Focused (on the tile and on a descendant) and a custom Selected state a click cycles',
    original: { html: 'component-states.html' },
    initialGap: 'reusable-components',
    tree: statesPage,
    published: () => renderThroughPublishedPage({ tree: statesPage(), definitions: definitions(planTile()) }),
    states: [
      { id: 'hover', gap: 'reusable-components', apply: (page) => firstTile(page).hover() },
      {
        id: 'hover, the script failed',
        gap: 'reusable-components',
        apply: async (page) => {
          await scriptFailed(page);
          await firstTile(page).hover();
        },
      },
      { id: 'pressed', gap: 'reusable-components', apply: PRESSED },
      {
        id: 'pressed, the script failed',
        gap: 'reusable-components',
        apply: async (page) => {
          await scriptFailed(page);
          await PRESSED(page);
        },
      },
      { id: 'keyboard focus', gap: 'reusable-components', apply: (page) => page.keyboard.press('Tab') },
      {
        id: 'keyboard focus, the script failed',
        gap: 'reusable-components',
        apply: async (page) => {
          await scriptFailed(page);
          await page.keyboard.press('Tab');
        },
      },
      { id: 'click selects the tile', gap: 'reusable-components', apply: (page) => firstTile(page).click() },
      {
        id: 'Space selects the tile',
        gap: 'reusable-components',
        apply: async (page) => {
          await page.keyboard.press('Tab');
          await page.keyboard.press('Space');
        },
      },
    ],
    notMeasured: [
      'Scripts turned off entirely: every page runs with scripts on, so the first three states are also run with the behaviour gate removed, which is what a failed script leaves',
      'Inner parity ids repeat across placements, as they do in the original, so their styles are compared on the second tile; each cell is compared on its own, text included',
    ],
  },
  {
    id: 'theme-tokens',
    group: 'edge',
    source: 'hand-written: a site\'s shared colours on the document, used by reference next to their literal copies',
    original: { html: 'theme-tokens.html' },
    initialGap: 'theme',
    ...themed(
      {
        tokens: [
          { id: 'ac000001', name: 'Accent', kind: 'color', light: '#1d4ed8' },
          { id: 'in000002', name: 'Ink', kind: 'color', light: '#111827' },
          { id: 'wa000003', name: 'Warm', kind: 'color', light: 'oklch(0.75 0.15 70 / 0.5)' },
        ],
        document: {},
      },
      () =>
        n(
          'main',
          parity('page', { style: { margin: 0, padding: '16px', fontFamily: FONT } }),
          t('p', 'Coloured by reference', parity('by-reference', { style: { color: token('ac000001'), border: `2px solid ${token('in000002')}`, margin: '0 0 8px', padding: '8px' } })),
          t('p', 'Coloured by its literal copy', parity('literal', { style: { color: '#1d4ed8', border: '2px solid #111827', margin: '0 0 8px', padding: '8px' } })),
          n('div', parity('gradient', { style: { height: '24px', margin: '0 0 8px', backgroundImage: `linear-gradient(90deg, ${token('ac000001')}, ${token('wa000003')})` } })),
          n('div', parity('shadow', { style: { width: '120px', height: '40px', boxShadow: `0 4px 12px ${token('in000002')}` } })),
        ),
    ),
    states: [],
  },
  {
    id: 'theme-dark',
    group: 'edge',
    source: 'hand-written: a site that follows the visitor\'s system, with its document colours from its tokens',
    original: { html: 'theme-dark.html' },
    initialGap: 'theme',
    ...themed(
      {
        mode: 'system',
        tokens: [
          { id: 'gr000001', name: 'Ground', kind: 'color', light: '#ffffff', dark: '#030712' },
          { id: 'in000002', name: 'Ink', kind: 'color', light: '#111827', dark: '#f9fafb' },
          { id: 'ac000003', name: 'Accent', kind: 'color', light: '#1d4ed8', dark: '#93c5fd' },
        ],
        document: { backgroundColor: token('gr000001'), color: token('in000002') },
      },
      () =>
        n(
          'main',
          parity('page', { style: { margin: 0, padding: '16px', fontFamily: FONT } }),
          t('p', 'Text that inherits the document colour', parity('copy', { style: { margin: '0 0 8px' } })),
          t('p', 'An accent that flips with the system', parity('accent', { style: { margin: 0, padding: '8px 12px', border: `1px solid ${token('ac000003')}`, color: token('ac000003') } })),
        ),
    ),
    states: [darkSystem],
  },
  {
    id: 'theme-font',
    group: 'edge',
    source: 'hand-written: a display face from the font library, named by a font token, that must load',
    original: { html: 'theme-font.html' },
    initialGap: 'theme',
    ...themed(
      { tokens: [{ id: 'fo000001', name: 'Display', kind: 'font', family: 'fraunces' }], document: {} },
      () =>
        n(
          'main',
          parity('page', { style: { margin: 0, padding: '16px', fontFamily: FONT } }),
          t('h1', 'A display face that must load', parity('title', { style: { margin: '0 0 8px', fontSize: '40px', fontWeight: 700, fontFamily: token('fo000001') } })),
          t('p', "Body text in the page's own face", parity('copy', { style: { margin: 0 } })),
        ),
    ),
    prepare: onSiteOrigin,
    states: [],
  },
  {
    id: 'theme-dark-rule',
    group: 'edge',
    source: 'hand-written: a node with a dark look of its own, on a site with no theme',
    original: { html: 'theme-dark-rule.html' },
    initialGap: 'media-queries',
    tree: () =>
      n(
        'main',
        parity('page', { style: { margin: 0, padding: '16px', fontFamily: FONT } }),
        t(
          'p',
          'A card with a dark look of its own',
          parity('card', {
            style: { margin: 0, padding: '12px', color: '#111827', backgroundColor: '#f3f4f6', borderRadius: '8px' },
            rules: [wrapped('dark', '@media (prefers-color-scheme: dark)', { color: '#f9fafb', backgroundColor: '#1f2937' })],
          }),
        ),
      ),
    states: [darkSystem],
  },
];

export function readFixtureFile(name: string): string {
  return fs.readFileSync(fixtureFile(name), 'utf8');
}
