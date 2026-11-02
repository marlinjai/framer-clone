// The WAI-ARIA Authoring Practices patterns as node trees, each with the primary
// keyboard contract from its page in the Guide. A tree is the best a page author
// can store today: where plain HTML brings the behaviour along (details, a range
// input, a dialog opened by a command attribute) that counts, because it needs no
// new primitive. Where a pattern needs script, the tree carries the correct roles
// and states and the contract fails: that failure is what the behaviour model
// (step 6 of the plan) has to close.
//
// A pattern with `built: 'behaviour'` takes its tree from its preset, the same function
// the palette calls, and its contract grows to the keys the Guide lists.
//
// A contract is one interaction, not the whole Guide page: passing means the
// primary keyboard path works, not that the pattern is fully conformant.

import type { Locator, Page } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { TEXT_NODE_TYPE } from '@/lib/renderer/textNode';
import { carousel } from '@/lib/behaviour/presets/carousel';
import { combobox } from '@/lib/behaviour/presets/combobox';
import { feed } from '@/lib/behaviour/presets/feed';
import { grid } from '@/lib/behaviour/presets/grid';
import { treegrid, treeview } from '@/lib/behaviour/presets/tree';
import { menuButton } from '@/lib/behaviour/presets/menu';
import { menubar } from '@/lib/behaviour/presets/menubar';
import { multithumbSlider } from '@/lib/behaviour/presets/slider';
import { splitter } from '@/lib/behaviour/presets/splitter';
import { tabs } from '@/lib/behaviour/presets/tabs';
import { toolbar } from '@/lib/behaviour/presets/toolbar';
import { tooltip } from '@/lib/behaviour/presets/tooltip';
import type { PresetKind } from '@/lib/behaviour/presets';

type Props = Record<string, unknown>;

let nextId = 0;

export function n(type: string, props: Props = {}, ...children: ComponentNode[]): ComponentNode {
  const node: ComponentNode = { id: `n${++nextId}`, type, props: props as ComponentNode['props'] };
  if (children.length > 0) node.children = children;
  return node;
}

export const t = (type: string, text: string, props: Props = {}) => n(type, { ...props, children: text });

/** A run of bare text among an element's children (src/lib/renderer/textNode.ts). */
export const run = (text: string) => t(TEXT_NODE_TYPE, text);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export interface Pattern {
  id: string;
  /** How the tree is built, in a few words. */
  built: 'native' | 'aria-only' | 'behaviour';
  /** The preset the tree comes from, when `built` is 'behaviour'. */
  preset?: PresetKind;
  tree: () => ComponentNode;
  /**
   * What the generator is taught to write for this pattern, when `built` is 'behaviour': the
   * preset request with the tree's own options, which the validator expands through the
   * same function (src/lib/ai/pageGen/promptSections/behaviour.ts).
   */
  generated?: () => Record<string, unknown>;
  /** Why the generated form cannot pass the contract, when the generator is refused part of it on purpose. */
  generatedRefusal?: string;
  /** `root` is where the tree sits: the page once published, the frame's content on the canvas. */
  contract: (page: Page, root: Scope) => Promise<void>;
}

/** What a contract looks elements up in, so the editor around a canvas tree is never matched. */
export type Scope = Page | Locator;

const pressed = async (page: Page, key: string) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(20);
};

const attr = (root: Scope, selector: string, name: string) => root.locator(selector).first().getAttribute(name);

const focusedText = (page: Page) => page.evaluate(() => document.activeElement?.textContent);

/** Presses each key in turn, and says where the focus must land after it. */
async function walkKeys(page: Page, steps: [string, string][]): Promise<void> {
  for (const [key, want] of steps) {
    await pressed(page, key);
    const at = await focusedText(page);
    assert(at === want, `${key} put the focus on ${JSON.stringify(at)}, not ${JSON.stringify(want)}`);
  }
}

/** One Tab stop in a group: Tab from inside leaves it. */
async function leavesWithTab(page: Page, root: Scope, role: 'tab' | 'button' | 'gridcell'): Promise<void> {
  await pressed(page, 'Tab');
  const inside = await root.getByRole(role).evaluateAll((items) => items.includes(document.activeElement as HTMLElement));
  assert(!inside, 'Tab stayed inside the group: it holds more than one Tab stop');
}

/** Opens by keyboard, puts focus inside, closes with Escape, gives focus back. */
async function modalContract(page: Page, root: Scope, role: 'dialog' | 'alertdialog'): Promise<void> {
  await root.getByRole('button', { name: 'Open' }).focus();
  await pressed(page, 'Enter');
  const dialog = root.getByRole(role);
  assert(await dialog.isVisible(), 'Enter on the trigger did not open it');
  await pressed(page, 'Tab');
  // A native modal hands focus to the browser's own controls after its last
  // stop and the page behind stays inert, so what must not happen is focus
  // landing on the page behind the dialog.
  const leaked = await page.evaluate(() => {
    const active = document.activeElement;
    return !!active && active !== document.body && !active.closest('dialog');
  });
  assert(!leaked, 'focus reached the page behind the dialog');
  await pressed(page, 'Escape');
  assert(!(await dialog.isVisible()), 'Escape did not close it');
  const back = await page.evaluate(() => document.activeElement?.textContent);
  assert(back === 'Open', 'focus did not return to the trigger');
}

const modalTree = (role: 'dialog' | 'alertdialog') => () =>
  n(
    'div',
    {},
    t('button', 'Open', { commandfor: 'modal', command: 'show-modal' }),
    n(
      'dialog',
      { id: 'modal', role: role === 'alertdialog' ? 'alertdialog' : undefined, 'aria-labelledby': 'modal-title' },
      t('h2', 'Title', { id: 'modal-title' }),
      t('button', 'Close', { commandfor: 'modal', command: 'close' }),
    ),
  );

export const PATTERNS: Pattern[] = [
  {
    id: 'accordion',
    built: 'native',
    tree: () =>
      n(
        'div',
        {},
        n('details', { name: 'group' }, t('summary', 'One'), t('p', 'First panel')),
        n('details', { name: 'group' }, t('summary', 'Two'), t('p', 'Second panel')),
      ),
    contract: async (page, root) => {
      await root.locator('summary').nth(0).focus();
      await pressed(page, 'Enter');
      assert(await root.getByText('First panel').isVisible(), 'Enter did not open the first panel');
      await root.locator('summary').nth(1).focus();
      await pressed(page, 'Space');
      assert(await root.getByText('Second panel').isVisible(), 'Space did not open the second panel');
      assert(!(await root.getByText('First panel').isVisible()), 'the first panel did not close');
    },
  },
  {
    id: 'alert',
    built: 'native',
    tree: () => t('div', 'Saved', { role: 'alert' }),
    contract: async (_page, root) => {
      assert(await root.getByRole('alert').isVisible(), 'no alert in the accessibility tree');
    },
  },
  {
    id: 'alertdialog',
    built: 'native',
    tree: modalTree('alertdialog'),
    contract: (page, root) => modalContract(page, root, 'alertdialog'),
  },
  {
    id: 'breadcrumb',
    built: 'native',
    tree: () =>
      n(
        'nav',
        { 'aria-label': 'Breadcrumb' },
        n(
          'ol',
          {},
          n('li', {}, t('a', 'Home', { href: '/' })),
          n('li', {}, t('a', 'Shoes', { href: '/shoes', 'aria-current': 'page' })),
        ),
      ),
    contract: async (page, root) => {
      assert(await root.getByRole('navigation', { name: 'Breadcrumb' }).isVisible(), 'no breadcrumb landmark');
      assert((await attr(root, 'a[aria-current]', 'aria-current')) === 'page', 'no current page marked');
    },
  },
  {
    id: 'button',
    built: 'native',
    tree: () => t('button', 'Press'),
    contract: async (page, root) => {
      await root.getByRole('button', { name: 'Press' }).evaluate((button) => {
        const win = window as unknown as { clicks: number };
        win.clicks = 0;
        button.addEventListener('click', () => win.clicks++);
      });
      await root.getByRole('button', { name: 'Press' }).focus();
      await pressed(page, 'Enter');
      await pressed(page, 'Space');
      const clicks = await page.evaluate(() => (window as unknown as { clicks: number }).clicks);
      assert(clicks === 2, `Enter and Space gave ${clicks} activations`);
    },
  },
  {
    id: 'carousel',
    built: 'behaviour',
    preset: 'carousel',
    tree: () => carousel({ seed: 'pattern-carousel', label: 'Offers', slides: ['Slide one', 'Slide two', 'Slide three'], rotateMs: 1000 }) as ComponentNode,
    generated: () => ({ preset: 'carousel', items: ['Slide one', 'Slide two', 'Slide three'], options: { label: 'Offers' } }),
    generatedRefusal: 'a generated carousel never rotates by itself: every is refused, and the contract asks for rotation',
    contract: async (page, root) => {
      const shown = async () => {
        const out: string[] = [];
        for (const slide of await root.getByRole('group').all()) if (await slide.isVisible()) out.push((await slide.textContent()) ?? '');
        return out;
      };
      // Focus arriving stops rotation, wherever it had got to, so the rest starts from a fixed slide.
      await root.getByRole('button', { name: 'Next slide' }).focus();
      const start = await shown();
      assert(start.length === 1, `${start.length} slides show at once`);
      const titles = ['Slide one', 'Slide two', 'Slide three'];
      const after = (by: number) => titles[(titles.indexOf(start[0]) + by + 3) % 3];
      await pressed(page, 'Enter');
      assert((await shown())[0] === after(1), 'Next slide did not show the next slide');
      await root.getByRole('button', { name: 'Previous slide' }).focus();
      await pressed(page, 'Enter');
      await pressed(page, 'Enter');
      assert((await shown())[0] === after(-1), 'Previous slide did not go back one and wrap');
      await page.waitForTimeout(1300);
      assert((await shown())[0] === after(-1), 'rotation went on after focus entered');
      const live = await root.locator('[aria-live]').first().getAttribute('aria-live');
      assert(live === 'polite', `a slide a person moved is not announced: aria-live is ${live}`);
      await root.getByRole('button', { name: 'Start rotation' }).focus();
      await pressed(page, 'Enter');
      assert((await focusedText(page)) === 'Stop rotation', 'the rotation control does not say what it does');
      await page.waitForTimeout(1300);
      assert((await shown())[0] !== after(-1), 'Start rotation did not start it');
    },
  },
  {
    id: 'checkbox',
    built: 'native',
    tree: () => n('label', {}, n('input', { type: 'checkbox', 'aria-label': 'Agree' })),
    contract: async (page, root) => {
      const box = root.getByRole('checkbox', { name: 'Agree' });
      await box.focus();
      await pressed(page, 'Space');
      assert(await box.isChecked(), 'Space did not check it');
    },
  },
  {
    id: 'combobox',
    built: 'behaviour',
    preset: 'combobox',
    tree: () => combobox({ seed: 'pattern-combobox', label: 'City', options: ['Bern', 'Zurich', 'Basel'] }) as ComponentNode,
    generated: () => ({ preset: 'combobox', items: ['Bern', 'Zurich', 'Basel'], options: { label: 'City' } }),
    contract: async (page, root) => {
      const box = root.getByRole('combobox', { name: 'City' });
      await box.focus();
      await pressed(page, 'ArrowDown');
      assert(await root.getByRole('option', { name: 'Bern' }).isVisible(), 'ArrowDown did not open the list');
      assert((await box.getAttribute('aria-expanded')) === 'true', 'aria-expanded did not follow');
      await pressed(page, 'Escape');
      assert(!(await root.getByRole('listbox').isVisible()), 'Escape did not close the list');
      await page.keyboard.type('b');
      await page.waitForTimeout(20);
      assert(!(await root.getByRole('option', { name: 'Zurich' }).isVisible()), 'typing did not filter the options');
      await pressed(page, 'ArrowDown');
      await pressed(page, 'ArrowDown');
      const active = await box.getAttribute('aria-activedescendant');
      const text = active ? await page.evaluate((id) => document.getElementById(id)?.textContent, active) : null;
      assert(text === 'Basel', `the active option is ${text}: it has to skip what the filter hid`);
      await pressed(page, 'Enter');
      assert((await box.inputValue()) === 'Basel', 'Enter did not copy the active option');
      assert(!(await root.getByRole('listbox').isVisible()), 'Enter did not close the list');
    },
  },
  {
    id: 'dialog-modal',
    built: 'native',
    tree: modalTree('dialog'),
    contract: (page, root) => modalContract(page, root, 'dialog'),
  },
  {
    id: 'disclosure',
    built: 'native',
    tree: () => n('details', {}, t('summary', 'More'), t('p', 'Hidden text')),
    contract: async (page, root) => {
      await root.locator('summary').focus();
      await pressed(page, 'Enter');
      assert(await root.getByText('Hidden text').isVisible(), 'Enter did not show the content');
    },
  },
  {
    id: 'feed',
    built: 'behaviour',
    preset: 'feed',
    tree: () =>
      n(
        'div',
        {},
        t('a', 'Before', { href: '#before' }),
        feed({ seed: 'pattern-feed', label: 'News', articles: [{ title: 'One', body: 'First' }, { title: 'Two', body: 'Second' }, { title: 'Three', body: 'Third' }] }) as ComponentNode,
        t('a', 'After', { href: '#after' }),
      ),
    generated: () => ({
      type: 'div',
      children: [
        { type: 'a', props: { href: '#before', children: 'Before' } },
        { preset: 'feed', items: [{ title: 'One', body: 'First' }, { title: 'Two', body: 'Second' }, { title: 'Three', body: 'Third' }], options: { label: 'News' } },
        { type: 'a', props: { href: '#after', children: 'After' } },
      ],
    }),
    contract: async (page, root) => {
      const heading = () => page.evaluate(() => document.activeElement?.querySelector('h3')?.textContent ?? document.activeElement?.textContent);
      await root.getByRole('article').nth(0).focus();
      for (const [key, want] of [['PageDown', 'Two'], ['PageDown', 'Three'], ['PageUp', 'Two']] as const) {
        await pressed(page, key);
        assert((await heading()) === want, `${key} put the focus on ${await heading()}, not ${want}`);
      }
      await pressed(page, 'Control+End');
      assert((await focusedText(page)) === 'After', 'Ctrl+End did not leave the feed for what follows it');
      await root.getByRole('article').nth(1).focus();
      await pressed(page, 'Control+Home');
      assert((await focusedText(page)) === 'Before', 'Ctrl+Home did not leave the feed for what comes before it');
    },
  },
  {
    id: 'grid',
    built: 'behaviour',
    preset: 'grid',
    tree: () => grid({ seed: 'pattern-grid', label: 'Prices', columns: ['A', 'B', 'C'], rows: [['A1', 'B1', 'C1'], ['A2', 'B2', 'C2'], ['A3', 'B3', 'C3']] }) as ComponentNode,
    generated: () => ({ preset: 'dataGrid', items: [['A1', 'B1', 'C1'], ['A2', 'B2', 'C2'], ['A3', 'B3', 'C3']], options: { label: 'Prices', columns: ['A', 'B', 'C'] } }),
    contract: async (page, root) => {
      await root.getByRole('gridcell', { name: 'A1' }).focus();
      await walkKeys(page, [
        ['ArrowRight', 'B1'], ['ArrowDown', 'B2'], ['End', 'C2'], ['Home', 'A2'], ['ArrowUp', 'A1'],
        ['Control+End', 'C3'], ['Control+Home', 'A1'], ['PageDown', 'A3'], ['PageUp', 'A1'],
      ]);
      await leavesWithTab(page, root, 'gridcell');
    },
  },
  {
    id: 'landmarks',
    built: 'native',
    tree: () =>
      n(
        'div',
        {},
        t('header', 'Top'),
        t('nav', 'Links', { 'aria-label': 'Main' }),
        t('main', 'Content'),
        t('aside', 'Related', { 'aria-label': 'Related' }),
        t('footer', 'Bottom'),
      ),
    contract: async (_page, root) => {
      for (const role of ['banner', 'navigation', 'main', 'complementary', 'contentinfo'] as const) {
        assert(await root.getByRole(role).isVisible(), `no ${role} landmark`);
      }
    },
  },
  {
    id: 'link',
    built: 'native',
    tree: () => n('div', {}, t('a', 'Jump', { href: '#target' }), t('p', 'Target', { id: 'target' })),
    contract: async (page, root) => {
      await root.getByRole('link', { name: 'Jump' }).focus();
      await pressed(page, 'Enter');
      assert(page.url().endsWith('#target'), 'Enter did not follow the link');
    },
  },
  {
    id: 'listbox',
    built: 'native',
    tree: () =>
      n(
        'select',
        { size: 3, 'aria-label': 'Size' },
        t('option', 'Small', { value: 's' }),
        t('option', 'Large', { value: 'l' }),
      ),
    contract: async (page, root) => {
      const box = root.getByRole('listbox', { name: 'Size' });
      await box.focus();
      await pressed(page, 'ArrowDown');
      await pressed(page, 'ArrowDown');
      const value = await box.inputValue();
      assert(value === 'l', `ArrowDown selected ${JSON.stringify(value)}`);
    },
  },
  {
    id: 'menubar',
    built: 'behaviour',
    preset: 'menubar',
    tree: () =>
      menubar({
        seed: 'pattern-menubar',
        label: 'Main',
        menus: [
          { title: 'File', href: '#file', items: [{ title: 'New', href: '#new' }, { title: 'Open', href: '#open' }] },
          { title: 'Edit', href: '#edit', items: [{ title: 'Undo', href: '#undo' }, { title: 'Redo', href: '#redo' }] },
        ],
      }) as ComponentNode,
    generated: () => ({
      preset: 'menubar',
      items: [
        { title: 'File', href: '#file', items: [{ title: 'New', href: '#new' }, { title: 'Open', href: '#open' }] },
        { title: 'Edit', href: '#edit', items: [{ title: 'Undo', href: '#undo' }, { title: 'Redo', href: '#redo' }] },
      ],
      options: { label: 'Main' },
    }),
    contract: async (page, root) => {
      await root.getByRole('menuitem', { name: 'File' }).focus();
      await walkKeys(page, [['ArrowRight', 'Edit'], ['ArrowRight', 'File'], ['End', 'Edit'], ['Home', 'File']]);
      await pressed(page, 'ArrowDown');
      await page.waitForTimeout(40);
      assert((await focusedText(page)) === 'New', 'ArrowDown did not open the menu on its first item');
      await walkKeys(page, [['ArrowDown', 'Open'], ['ArrowDown', 'New'], ['End', 'Open']]);
      await pressed(page, 'Escape');
      assert((await focusedText(page)) === 'File', 'Escape did not give the focus back to the top item');
      assert(!(await root.getByRole('menuitem', { name: 'New' }).isVisible()), 'Escape did not close the menu');
      await pressed(page, 'ArrowUp');
      await page.waitForTimeout(40);
      assert((await focusedText(page)) === 'Open', 'ArrowUp did not open the menu on its last item');
      await pressed(page, 'ArrowRight');
      assert((await focusedText(page)) === 'Edit', 'ArrowRight in a menu did not move along the bar');
      assert(!(await root.getByRole('menuitem', { name: 'Open' }).isVisible()), 'the menu left behind stayed open');
    },
  },
  {
    id: 'menu-button',
    built: 'behaviour',
    preset: 'menu-button',
    tree: () => menuButton({ seed: 'pattern-menu', label: 'Actions', items: ['Copy', 'Paste', 'Delete'] }) as ComponentNode,
    generated: () => ({ preset: 'menu-button', items: ['Copy', 'Paste', 'Delete'], options: { label: 'Actions' } }),
    contract: async (page, root) => {
      const button = root.getByRole('button', { name: 'Actions' });
      await button.focus();
      await pressed(page, 'Enter');
      await page.waitForTimeout(40);
      assert(await root.getByRole('menu').isVisible(), 'Enter did not open the menu');
      assert((await focusedText(page)) === 'Copy', 'focus is not on the first item');
      assert((await button.getAttribute('aria-expanded')) === 'true', 'aria-expanded did not follow');
      await walkKeys(page, [['ArrowDown', 'Paste'], ['End', 'Delete'], ['ArrowDown', 'Copy'], ['ArrowUp', 'Delete'], ['Home', 'Copy'], ['p', 'Paste']]);
      await pressed(page, 'Escape');
      assert(!(await root.getByRole('menu').isVisible()), 'Escape did not close the menu');
      assert((await focusedText(page)) === 'Actions', 'Escape did not give the focus back');
      assert((await button.getAttribute('aria-expanded')) === 'false', 'aria-expanded went stale on Escape');
      await pressed(page, 'ArrowUp');
      await page.waitForTimeout(40);
      assert((await focusedText(page)) === 'Delete', 'ArrowUp did not open the menu on its last item');
    },
  },
  {
    id: 'meter',
    built: 'native',
    tree: () => n('meter', { value: 3, min: 0, max: 10, 'aria-label': 'Fuel' }),
    contract: async (_page, root) => {
      assert(await root.getByRole('meter', { name: 'Fuel' }).isVisible(), 'no meter in the accessibility tree');
    },
  },
  {
    id: 'radio',
    built: 'native',
    tree: () =>
      n(
        'fieldset',
        {},
        n('input', { type: 'radio', name: 'size', 'aria-label': 'Small', defaultChecked: true }),
        n('input', { type: 'radio', name: 'size', 'aria-label': 'Large' }),
      ),
    contract: async (page, root) => {
      await root.getByRole('radio', { name: 'Small' }).focus();
      await pressed(page, 'ArrowDown');
      assert(await root.getByRole('radio', { name: 'Large' }).isChecked(), 'ArrowDown did not move the selection');
    },
  },
  {
    id: 'slider',
    built: 'native',
    tree: () => n('input', { type: 'range', min: 0, max: 10, defaultValue: 5, 'aria-label': 'Volume' }),
    contract: async (page, root) => {
      const slider = root.getByRole('slider', { name: 'Volume' });
      await slider.focus();
      await pressed(page, 'ArrowRight');
      assert((await slider.inputValue()) === '6', 'ArrowRight did not raise the value');
    },
  },
  {
    id: 'slider-multithumb',
    built: 'behaviour',
    preset: 'slider-multithumb',
    tree: () => multithumbSlider({ seed: 'pattern-range', label: 'Price', min: 0, max: 10, low: 2, high: 8 }) as ComponentNode,
    generated: () => ({ preset: 'slider-multithumb', options: { label: 'Price', min: 0, max: 10, low: 2, high: 8 } }),
    contract: async (page, root) => {
      const low = root.getByRole('slider', { name: 'Price, lowest' });
      const high = root.getByRole('slider', { name: 'Price, highest' });
      await low.focus();
      await pressed(page, 'ArrowRight');
      assert((await low.inputValue()) === '3', 'ArrowRight did not raise the low thumb');
      await pressed(page, 'End');
      assert((await low.inputValue()) === '8', `End took the low thumb to ${await low.inputValue()}, past the high one`);
      await high.focus();
      await pressed(page, 'Home');
      assert((await high.inputValue()) === '8', `Home took the high thumb to ${await high.inputValue()}, below the low one`);
      assert((await high.getAttribute('max')) === '10', 'the track was remapped');
    },
  },
  {
    id: 'spinbutton',
    built: 'native',
    tree: () => n('input', { type: 'number', defaultValue: 1, 'aria-label': 'Count' }),
    contract: async (page, root) => {
      const spin = root.getByRole('spinbutton', { name: 'Count' });
      await spin.focus();
      await pressed(page, 'ArrowUp');
      assert((await spin.inputValue()) === '2', 'ArrowUp did not raise the value');
    },
  },
  {
    id: 'switch',
    built: 'native',
    tree: () => n('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Wifi' }),
    contract: async (page, root) => {
      const control = root.getByRole('switch', { name: 'Wifi' });
      await control.focus();
      await pressed(page, 'Space');
      assert(await control.isChecked(), 'Space did not switch it');
    },
  },
  {
    id: 'table',
    built: 'native',
    tree: () =>
      n(
        'table',
        {},
        t('caption', 'Prices'),
        n('thead', {}, n('tr', {}, t('th', 'Item'), t('th', 'Price'))),
        n('tbody', {}, n('tr', {}, t('td', 'Tea'), t('td', '3'))),
      ),
    contract: async (_page, root) => {
      assert(await root.getByRole('table', { name: 'Prices' }).isVisible(), 'no table in the accessibility tree');
      assert((await root.getByRole('columnheader').count()) === 2, 'no column headers');
    },
  },
  {
    id: 'tabs',
    built: 'behaviour',
    preset: 'tabs',
    tree: () =>
      tabs({
        seed: 'pattern-tabs',
        items: [{ title: 'One', body: 'Panel one' }, { title: 'Two', body: 'Panel two' }, { title: 'Three', body: 'Panel three' }],
      }) as ComponentNode,
    generated: () => ({
      preset: 'tabs',
      items: [{ title: 'One', body: 'Panel one' }, { title: 'Two', body: 'Panel two' }, { title: 'Three', body: 'Panel three' }],
      options: { label: 'Sections' },
    }),
    contract: async (page, root) => {
      assert(!(await root.getByText('Panel two').isVisible()), 'a panel that is not selected shows');
      await root.getByRole('tab', { name: 'One' }).focus();
      await walkKeys(page, [['ArrowRight', 'Two']]);
      assert(await root.getByText('Panel two').isVisible(), 'ArrowRight did not change the tab');
      assert(!(await root.getByText('Panel one').isVisible()), 'the first panel stayed');
      assert((await root.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected')) === 'true', 'aria-selected did not follow');
      await walkKeys(page, [['End', 'Three'], ['ArrowRight', 'One'], ['ArrowLeft', 'Three'], ['Home', 'One']]);
      assert(await root.getByText('Panel one').isVisible(), 'Home did not select the first tab');
      await leavesWithTab(page, root, 'tab');
    },
  },
  {
    id: 'toolbar',
    built: 'behaviour',
    preset: 'toolbar',
    tree: () => toolbar({ seed: 'pattern-toolbar', label: 'Format', items: ['Bold', 'Italic', 'Underline'] }) as ComponentNode,
    generated: () => ({ preset: 'toolbar', items: ['Bold', 'Italic', 'Underline'], options: { label: 'Format' } }),
    contract: async (page, root) => {
      await root.getByRole('button', { name: 'Bold' }).focus();
      await walkKeys(page, [['ArrowRight', 'Italic'], ['End', 'Underline'], ['ArrowRight', 'Bold'], ['ArrowLeft', 'Underline'], ['Home', 'Bold']]);
      await leavesWithTab(page, root, 'button');
    },
  },
  {
    id: 'tooltip',
    built: 'behaviour',
    preset: 'tooltip',
    tree: () => tooltip({ seed: 'pattern-tooltip', label: 'Save', text: 'Saves the page' }) as ComponentNode,
    generated: () => ({ preset: 'tooltip', options: { label: 'Save', text: 'Saves the page' } }),
    contract: async (page, root) => {
      const tip = root.getByRole('tooltip');
      assert(!(await tip.isVisible()), 'the tooltip shows on its own');
      const save = root.getByRole('button', { name: 'Save' });
      await save.focus();
      await page.waitForTimeout(50);
      assert(await tip.isVisible(), 'focus did not show the tooltip');
      await pressed(page, 'Escape');
      assert(!(await tip.isVisible()), 'Escape did not dismiss the tooltip');
      await save.blur();
      await save.hover();
      await page.waitForTimeout(100);
      assert(await tip.isVisible(), 'hover did not show the tooltip');
      await pressed(page, 'Escape');
      assert(!(await tip.isVisible()), 'Escape did not dismiss a tooltip from hover alone');
    },
  },
  {
    id: 'treeview',
    built: 'behaviour',
    preset: 'treeview',
    tree: () => treeview({ seed: 'pattern-tree', label: 'Files', items: [{ title: 'src', children: [{ title: 'app.ts' }, { title: 'lib.ts' }] }, { title: 'docs' }] }) as ComponentNode,
    generated: () => ({ preset: 'treeview', items: [{ title: 'src', children: [{ title: 'app.ts' }, { title: 'lib.ts' }] }, { title: 'docs' }], options: { label: 'Files' } }),
    contract: async (page, root) => {
      const name = () => page.evaluate(() => document.activeElement?.firstChild?.textContent ?? document.activeElement?.textContent);
      const src = root.getByRole('treeitem').first();
      await src.focus();
      assert(!(await root.getByText('app.ts').isVisible()), 'a closed branch shows its items');
      await pressed(page, 'ArrowRight');
      assert(await root.getByText('app.ts').isVisible(), 'ArrowRight did not expand the node');
      assert((await src.getAttribute('aria-expanded')) === 'true', 'aria-expanded did not follow');
      for (const [key, want] of [['ArrowRight', 'app.ts'], ['ArrowDown', 'lib.ts'], ['ArrowLeft', 'src'], ['End', 'docs'], ['Home', 'src']] as const) {
        await pressed(page, key);
        assert((await name()) === want, `${key} put the focus on ${await name()}, not ${want}`);
      }
      await pressed(page, 'ArrowLeft');
      assert(!(await root.getByText('app.ts').isVisible()), 'ArrowLeft did not close the open branch');
      await pressed(page, 'Enter');
      assert(await root.getByText('app.ts').isVisible(), 'Enter did not open the branch');
      await pressed(page, 'd');
      assert((await name()) === 'docs', 'a printable key did not move to the item starting with it');
    },
  },
  {
    id: 'treegrid',
    built: 'behaviour',
    preset: 'treegrid',
    tree: () => treegrid({ seed: 'pattern-treegrid', label: 'Mail', columns: ['Subject'], rows: [{ cells: ['Thread'], children: [{ cells: ['Reply'] }] }, { cells: ['Other'] }] }) as ComponentNode,
    generated: () => ({ preset: 'treegrid', items: [{ cells: ['Thread'], children: [{ cells: ['Reply'] }] }, { cells: ['Other'] }], options: { label: 'Mail', columns: ['Subject'] } }),
    contract: async (page, root) => {
      const thread = root.getByRole('row', { name: 'Thread' });
      await thread.focus();
      assert(!(await root.getByText('Reply').isVisible()), 'a closed row shows its children');
      await pressed(page, 'ArrowRight');
      assert(await root.getByText('Reply').isVisible(), 'ArrowRight did not expand the row');
      assert((await thread.getAttribute('aria-expanded')) === 'true', 'aria-expanded did not follow');
      await walkKeys(page, [['ArrowRight', 'Reply'], ['ArrowLeft', 'Thread'], ['ArrowDown', 'Reply'], ['ArrowDown', 'Other'], ['Home', 'Thread']]);
      await pressed(page, 'ArrowLeft');
      assert(!(await root.getByText('Reply').isVisible()), 'ArrowLeft did not collapse the row');
    },
  },
  {
    id: 'windowsplitter',
    built: 'behaviour',
    preset: 'windowsplitter',
    tree: () => splitter({ seed: 'pattern-split', label: 'Resize', at: 50 }) as ComponentNode,
    generated: () => ({ preset: 'windowsplitter', options: { label: 'Resize', at: 50, first: 'First pane', second: 'Second pane' } }),
    contract: async (page, root) => {
      const separator = root.getByRole('separator');
      const value = () => separator.getAttribute('aria-valuenow');
      await separator.focus();
      await pressed(page, 'ArrowLeft');
      assert((await value()) === '45', `ArrowLeft gave ${await value()}`);
      await pressed(page, 'Enter');
      assert((await value()) === '0', 'Enter did not collapse it');
      await pressed(page, 'Enter');
      assert((await value()) === '45', 'Enter did not restore it');
      await pressed(page, 'End');
      assert((await value()) === '100', 'End did not move it to the end');
      await pressed(page, 'Home');
      assert((await value()) === '0', 'Home did not move it to the start');
    },
  },
];

/** Every tag and prop a tree uses, for the columns that follow from the elementwise ones. */
export function treeVocabulary(root: ComponentNode): { tags: Set<string>; props: Set<string> } {
  const tags = new Set<string>();
  const props = new Set<string>();
  const walk = (node: ComponentNode) => {
    tags.add(node.type);
    for (const key of Object.keys(node.props ?? {})) if (key !== 'children') props.add(key);
    node.children?.forEach(walk);
  };
  walk(root);
  return { tags, props };
}
