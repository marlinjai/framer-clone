// Site branches in the editor, slice S4 of docs/plans/2026-11-10-site-branches.md, in real Chromium and WebKit
// with real keys: the real editor's top bar (test/behaviour/branches/entry.tsx) on main, on a branch and on a
// branch behind main. The branch routes are answered here as the server answers them; leaving for another
// site is a real navigation, caught at its address.
//
//   - Keyboard only: the switcher opens with Enter, New branch moves the focus into the name field, typing there
//     never reaches the canvas's shortcuts, Enter creates and opens the branch; Escape closes a dialog.
//   - On a branch Publish gives way to Review and merge, which opens the review page (slice S5).
//   - Behind main, Update brings main in and says so in a status a screen reader hears.
//   - Paths: forward (create, update, open the review), backtrack (Escape out of a dialog changes nothing).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Page, type Route } from 'playwright';
import { bundleEditor, openEditor } from '../score/lib/canvasBundle';
import type { BranchSummaryJson, EditorBranchState } from '@/lib/sites/branches';

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const MAIN = 'site-main';
const BRANCH = 'site-branch';

function summary(over: Partial<BranchSummaryJson> = {}): BranchSummaryJson {
  return {
    branchId: BRANCH, mainSiteId: MAIN, name: 'Spring sale', status: 'open', createdByKind: 'user', createdBy: 'user-a',
    createdAt: '2026-11-11T09:00:00.000Z', updatedAt: '2026-11-11T09:00:00.000Z', version: 3, baseVersion: 7,
    mainMoved: false, readyBy: null, readyAt: null, reviewNote: null, approved: false, mergedAt: null, discardedAt: null,
    undoUntil: null,
    undoneIntoBranchId: null,
    undoneAt: null,
    ...over,
  };
}
const NONE = { site: [], settings: [], pages: { added: [], removed: [], changed: [] }, components: { added: [], removed: [], changed: [] }, nodes: { added: 0, removed: 0, changed: 0 }, pageOrder: false };
const CHANGED = { ...NONE, pages: { added: [], removed: [], changed: ['home'] }, nodes: { added: 1, removed: 0, changed: 2 } };
const onMain: EditorBranchState = { kind: 'main', siteId: MAIN, siteName: 'Bakery', openBranches: 1 };
const onBranch = (over: Partial<BranchSummaryJson> = {}): EditorBranchState => ({ kind: 'branch', siteId: BRANCH, mainSiteId: MAIN, mainName: 'Bakery', branch: summary(over) });

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

let bundle: string;
beforeAll(async () => {
  bundle = await bundleEditor('test/behaviour/branches/entry.tsx', 'branches-bundle');
});

for (const [engine, type] of ENGINES) {
  describe(`site branches in the editor (${engine})`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await type.launch();
    });
    afterAll(async () => {
      await browser.close();
    });

    /** The editor with `state`; `routes` answers the branch routes. Returns the requests made and where it went. */
    async function open(state: EditorBranchState, routes: (page: Page, calls: string[]) => Promise<void>) {
      const calls: string[] = [];
      const went: string[] = [];
      const { page, crashes } = await openEditor(browser, bundle, {}, async (p) => {
        await p.addInitScript((s) => {
          (window as unknown as { __BRANCH_STATE__: unknown }).__BRANCH_STATE__ = s;
        }, state);
        await routes(p, calls);
        // Leaving for another site's editor: a real navigation, answered with an empty page.
        await p.route('http://canvas-probe.local/projects/**', (route) => {
          went.push(new URL(route.request().url()).pathname);
          return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>left</title>' });
        });
      });
      page.setDefaultTimeout(5000);
      return { page, crashes, calls, went };
    }

    /** Tab on from where the focus is until `name` has it. WebKit, like Safari, tabs to buttons with Alt. */
    async function tabTo(page: Page, name: RegExp) {
      const tab = engine === 'webkit' ? 'Alt+Tab' : 'Tab';
      const label = () =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          // The page itself holds no focus worth naming (its text is all of the page's).
          if (!el || el === document.body) return '';
          return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
        });
      // Already there (a closed dialog gives the focus back to the control that opened it).
      if (name.test(await label())) return;
      for (let i = 0; i < 60; i += 1) {
        await page.keyboard.press(tab);
        if (name.test(await label())) return;
      }
      throw new Error(`Tab never reached ${name}`);
    }

    /** With the menu open: wait for its focus, then walk with ArrowDown to `item` and choose it with Enter. */
    async function choose(page: Page, item: RegExp) {
      // The menu moves the focus to its first item once it has opened; a person presses a key after that.
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('menuitem');
      const focusedText = () => page.evaluate(() => (document.activeElement?.textContent ?? '').trim());
      for (let i = 0; i < 10; i += 1) {
        const focused = await focusedText();
        if (item.test(focused)) {
          await page.keyboard.press('Enter');
          return;
        }
        await page.keyboard.press('ArrowDown');
        // The menu moves the focus in a timer after the key (Radix's roving focus). A person sees the highlight
        // move before the next press; so does this. Pressing again at once lands on the old item: Chromium runs
        // input and automation tasks ahead of timers, so back-to-back presses starve the move.
        await expect.poll(focusedText).not.toBe(focused);
      }
      throw new Error(`ArrowDown never reached ${item}`);
    }

    it('creates a branch with the keyboard alone, and opens it', async () => {
      const { page, crashes, calls, went } = await open(onMain, async (p, calls) => {
        await p.route('**/api/projects/site-main/branches', async (route) => {
          const req = route.request();
          calls.push(`${req.method()} ${req.postData() ?? ''}`);
          if (req.method() === 'GET') return json(route, { mainSiteId: MAIN, mainVersion: 7, open: [summary()], closed: [] });
          const body = JSON.parse(req.postData() ?? '{}');
          return json(route, { branch: summary({ branchId: 'site-new', name: body.name }), created: true }, 201);
        });
      });
      await tabTo(page, /^Main\. Switch branch$/);
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: /Spring sale/ }).waitFor();
      await choose(page, /^New branch/);
      const field = page.getByLabel('Branch name');
      await field.waitFor();
      await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe(await field.getAttribute('id'));
      // Escape first: the dialog closes and nothing was asked of the server.
      await page.keyboard.press('Escape');
      await field.waitFor({ state: 'detached' });
      // The focus goes back to the switcher, where the person was, never to the page.
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Main. Switch branch');
      expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
      // Again, now through to the end. Backspace and Delete in the field are the field's, not the canvas's.
      await tabTo(page, /^Main\. Switch branch$/);
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: /Spring sale/ }).waitFor();
      await choose(page, /^New branch/);
      await field.waitFor();
      await page.keyboard.type('Spring salex');
      await page.keyboard.press('Backspace');
      expect(await field.inputValue()).toBe('Spring sale');
      await page.keyboard.press('Enter');
      await expect.poll(() => went).toEqual(['/projects/site-new']);
      const post = calls.find((c) => c.startsWith('POST'))!;
      expect(JSON.parse(post.slice(5))).toMatchObject({ name: 'Spring sale' });
      expect(crashes).toEqual([]);
      await page.close();
    });

    /** Where the top bar's controls are: any outside the window, over one another, or not pressable. */
    const barGeometry = (page: Page) =>
      page.evaluate(() => {
        const bar = document.querySelector('[data-editor-topbar]')!;
        const name = (el: Element) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
        const controls = [...bar.querySelectorAll('button, a')]
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ el, r }) => r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden');
        const window_ = document.documentElement.clientWidth;
        const outside = controls.filter(({ r }) => r.left < -0.5 || r.right > window_ + 0.5).map(({ el, r }) => `${name(el)} [${Math.round(r.left)}, ${Math.round(r.right)}]`);
        const over: string[] = [];
        for (let i = 0; i < controls.length; i += 1) {
          for (let j = i + 1; j < controls.length; j += 1) {
            const a = controls[i];
            const b = controls[j];
            if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
            const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
            const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
            if (w > 1 && h > 1) over.push(`${name(a.el)} over ${name(b.el)} by ${Math.round(w)}px`);
          }
        }
        // What a click in the middle of each control lands on: itself, not a neighbour painted over it.
        const covered = controls
          .filter(({ el, r }) => {
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !(hit && (el.contains(hit) || hit.contains(el)));
          })
          .map(({ el }) => name(el));
        return {
          outside,
          over,
          covered,
          names: controls.map(({ el }) => name(el)),
          scrolls: document.documentElement.scrollWidth > window_ + 1,
          barBottom: bar.getBoundingClientRect().bottom,
        };
      });

    // The whole-feature review asked whether the top bar holds on a branch when the window is narrow: a branch
    // adds a badge, a switcher with the branch's name, Update, Share preview and Review and merge to it.
    it.each([
      { name: 'a very wide window', width: 1920 },
      { name: 'a wide window', width: 1536 },
      { name: 'a laptop', width: 1280 },
      { name: 'a small laptop', width: 1024 },
      { name: 'a tablet', width: 768 },
      { name: 'a phone', width: 390 },
    ])('on $name the top bar of a branch behind main keeps every control inside the window and none over another', async ({ width }) => {
      const state = onBranch({ mainMoved: true, name: 'Spring sale with the new pricing page and the long name of it' });
      const { page, crashes } = await openEditor(browser, bundle, { viewport: { width, height: 800 } }, async (p) => {
        await p.addInitScript((s) => {
          Object.assign(window, { __BRANCH_STATE__: s, __STORED_SITE__: true });
        }, state);
      });
      page.setDefaultTimeout(5000);
      await page.getByRole('button', { name: /Review and merge/ }).waitFor();
      const seen = await barGeometry(page);
      expect(seen.outside, `outside the window at ${width}px`).toEqual([]);
      expect(seen.over, `over one another at ${width}px`).toEqual([]);
      expect(seen.covered, `covered at ${width}px`).toEqual([]);
      expect(seen.scrolls).toBe(false);
      // The controls a branch needs are all there, at every width.
      expect(seen.names.some((n) => /Review and merge/.test(n))).toBe(true);
      expect(seen.names.some((n) => /^Update/.test(n))).toBe(true);
      expect(seen.names.some((n) => /^Branch Spring sale/.test(n))).toBe(true);
      expect(seen.names.some((n) => /Back to projects/.test(n))).toBe(true);
      expect(crashes).toEqual([]);
      await page.close();
    });

    // The floor that keeps the back link pressable is the bar's own, so a site that is not a branch gets it too.
    it.each([
      { name: 'a small laptop', width: 1024 },
      { name: 'a tablet', width: 768 },
      { name: 'a phone', width: 390 },
    ])('on $name the top bar of a site itself keeps every control inside the window and none over another', async ({ width }) => {
      const { page, crashes } = await openEditor(browser, bundle, { viewport: { width, height: 800 } }, async (p) => {
        await p.addInitScript((s) => {
          Object.assign(window, { __BRANCH_STATE__: s, __STORED_SITE__: true });
        }, onMain);
      });
      page.setDefaultTimeout(5000);
      await page.getByRole('button', { name: 'Publish', exact: true }).waitFor();
      const seen = await barGeometry(page);
      expect(seen.outside, `outside the window at ${width}px`).toEqual([]);
      expect(seen.over, `over one another at ${width}px`).toEqual([]);
      expect(seen.covered, `covered at ${width}px`).toEqual([]);
      expect(seen.scrolls).toBe(false);
      expect(seen.names.some((n) => /Back to projects/.test(n))).toBe(true);
      expect(seen.names.some((n) => /^Main\. Switch branch/.test(n))).toBe(true);
      expect(crashes).toEqual([]);
      await page.close();
    });

    it('shows Review and merge in place of Publish on a branch, and opens the review with Enter', async () => {
      const { page, crashes, went } = await open(onBranch(), async () => undefined);
      expect(await page.getByRole('button', { name: 'Publish', exact: true }).count()).toBe(0);
      await tabTo(page, /Review and merge/);
      await page.keyboard.press('Enter');
      await expect.poll(() => went).toEqual([`/projects/${BRANCH}/review`]);
      expect(crashes).toEqual([]);
      await page.close();
    });

    it('updates from main with Enter and says so in a status, then opens the review', async () => {
      let updated = false;
      const { page, crashes, calls, went } = await open(onBranch({ mainMoved: true }), async (p, calls) => {
        await p.route('**/api/projects/site-branch/branch/changes', (route) =>
          json(route, { branch: summary({ mainMoved: !updated }), token: updated ? 't2' : 't1', upToDate: updated, branchChanges: CHANGED, mainChanges: updated ? null : NONE, conflicts: [], settled: [], problems: [] }),
        );
        await p.route('**/api/projects/site-branch/branch/update', (route) => {
          calls.push(`update ${route.request().postData()}`);
          updated = true;
          return json(route, { updated: true, branch: summary(), token: 't2' });
        });
        await p.route('**/api/projects/site-main/branches/site-branch', (route) => json(route, { branch: summary({ mainMoved: !updated, baseVersion: updated ? 8 : 7 }) }));
      });
      await tabTo(page, /^Update$/);
      await page.keyboard.press('Enter');
      await page.getByRole('status').filter({ hasText: 'Updated from Bakery.' }).waitFor();
      expect(calls).toContain('update {"token":"t1"}');
      // Main no longer moved: Update is gone.
      await page.getByRole('button', { name: /^Update$/ }).waitFor({ state: 'detached' });
      // The merge itself is the review's (test/behaviour/branchReview.spec.ts): this opens it.
      await tabTo(page, /Review and merge/);
      await page.keyboard.press('Enter');
      await expect.poll(() => went).toEqual([`/projects/${BRANCH}/review`]);
      expect(crashes).toEqual([]);
      await page.close();
    });
  });
}
