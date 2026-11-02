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

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { HOVER_GATE } from '@/lib/rules/states';
import { n, run, t } from '../patterns';
import type { GapId } from '../lib/types';
import type { PublishedOutput } from '../lib/published';

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

/** A 32px circle as an SVG, the same bytes as in stylesheet-values.html. */
const DOT_SVG = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iOCIgZmlsbD0iIzFkNGVkOCIvPjwvc3ZnPg==';

const responsive = (base: unknown, tablet: unknown, mobile: unknown) => ({ base, tablet, mobile });

/** The named states, written the way the panel stores them (src/lib/rules/states.ts). */
const hoverRule = (style: Record<string, unknown>) => ({ id: 'hover', selector: '&:hover', at: [HOVER_GATE], style });
const focusedRule = (style: Record<string, unknown>) => ({ id: 'focused', selector: '&:focus-visible', style });
const pressedRule = (style: Record<string, unknown>) => ({ id: 'pressed', selector: '&:active', style });
const rule = (id: string, selector: string, style: Record<string, unknown>) => ({ id, selector, style });
const wrapped = (id: string, at: string, style: Record<string, unknown>, selector = '&') => ({ id, selector, at: [at], style });

const WIDE_CARD = '@container (min-width: 600px)';

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
    // The animation's longhands are stored; @keyframes pulse has no home.
    tree: () =>
      n(
        'div',
        parity('page', { style: { font: `16px/1.5 ${FONT}`, padding: '24px', display: 'flex', gap: '16px' } }),
        n(
          'div',
          parity('dot', {
            style: { width: '80px', height: '80px', borderRadius: '50%', background: '#1d4ed8', animation: 'pulse 1s linear infinite' },
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
    tree: () => {
      const trigger = (value: string, title: string, active: boolean) =>
        t(
          'button',
          title,
          parity(`trigger-${value}`, {
            type: 'button',
            role: 'tab',
            'aria-selected': active ? 'true' : 'false',
            id: `tab-${value}`,
            'aria-controls': `panel-${value}`,
            'data-state': active ? 'active' : 'inactive',
            'data-orientation': 'horizontal',
            tabIndex: active ? 0 : -1,
            style: {
              border: 0, borderRadius: '6px', padding: '4px 8px', font: 'inherit', fontWeight: 500, cursor: 'pointer',
              ...(active ? { background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' } : { background: 'none' }),
            },
          }),
        );
      return n(
        'div',
        parity('page', { style: { font: `14px/20px ${FONT}`, color: '#0a0a0a', padding: '24px', maxWidth: '480px' } }),
        n(
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
            trigger('account', 'Account', true),
            trigger('password', 'Password', false),
          ),
          t(
            'div',
            'Change your name.',
            parity('content-account', {
              id: 'panel-account',
              'aria-labelledby': 'tab-account',
              role: 'tabpanel',
              tabIndex: 0,
              'data-state': 'active',
              'data-orientation': 'horizontal',
              style: { paddingTop: '8px' },
            }),
          ),
          n(
            'div',
            parity('content-password', {
              id: 'panel-password',
              'aria-labelledby': 'tab-password',
              role: 'tabpanel',
              tabIndex: 0,
              hidden: true,
              'data-state': 'inactive',
              'data-orientation': 'horizontal',
              style: { paddingTop: '8px' },
            }),
          ),
        ),
      );
    },
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
];

export function readFixtureFile(name: string): string {
  return fs.readFileSync(fixtureFile(name), 'utf8');
}
