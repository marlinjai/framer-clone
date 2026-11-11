// The review of a site branch, slice S5 of docs/plans/2026-11-10-site-branches.md, in real Chromium and WebKit
// with real keys: the real ReviewScreen (test/behaviour/branches/reviewEntry.tsx) drawing main and the branch in
// real preview frames. The branch routes are answered here as the server answers them.
//
//   - Each side keeps its own theme and rules: the panes are separate shadow roots, so main's red ground and the
//     branch's blue one never mix, and both draw the desktop breakpoint at any pane width.
//   - The changed elements are outlined in the real preview DOM, each side what it should show.
//   - Keyboard only: a question is answered, the answer stored, and the merge done, with Tab and Enter.
//   - A review of 200 changed elements is drawn, list and both panes, in under a second.

import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Page, type Route } from 'playwright';
import { bundleEditor, openBundle } from '../score/lib/canvasBundle';
import type { ReviewScreenProps } from '@/components/branches/review/ReviewScreen';
import type { BranchReviewJson, ShownConflictJson } from '@/lib/sites/branchClient';
import { reviewOf, siteSnapshot, summary } from './branches/reviewFixture';

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
/** The budget for drawing a 200-element review, list and both panes, from the bundle's start. */
const BUDGET_MS = 1_000;

let bundle: string;
beforeAll(async () => {
  bundle = await bundleEditor('test/behaviour/branches/reviewEntry.tsx', 'branch-review-bundle');
});

function propsOf(main: Record<string, unknown>, branch: Record<string, unknown>): ReviewScreenProps {
  return {
    branchId: 'site-branch', branchName: 'Spring sale', mainSiteId: 'site-main', mainName: 'Bakery',
    branch: { snapshot: branch as never, version: 3 }, main: { snapshot: main as never, version: 8 },
    can: { edit: true, review: true, merge: true },
  };
}

/** What a pane's shadow root shows: its frame's breakpoint and ground, and each element's outline. */
async function paneState(page: Page, side: 'main' | 'branch', ids: string[]) {
  return page.evaluate(
    ({ side, ids }) => {
      const root = document.querySelector(`[data-review-side="${side}"]`)?.shadowRoot;
      const frame = root?.querySelector<HTMLElement>('[data-preview-frame]');
      if (!root || !frame) return null;
      const outline = (id: string) => {
        const el = root.querySelector<HTMLElement>(`[data-inner-component-id="${id}"]`);
        if (!el) return 'absent';
        const s = getComputedStyle(el);
        return s.outlineStyle === 'solid' ? s.outlineColor : 'none';
      };
      return {
        breakpoint: frame.getAttribute('data-preview-breakpoint'),
        ground: getComputedStyle(frame).backgroundColor,
        outlines: Object.fromEntries(ids.map((id) => [id, outline(id)])),
      };
    },
    { side, ids },
  );
}

for (const [engine, type] of ENGINES) {
  describe(`the review of a site branch (${engine})`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await type.launch();
    });
    afterAll(async () => {
      await browser.close();
    });

    async function open(props: ReviewScreenProps, routes: (page: Page) => Promise<void>) {
      const { page, crashes } = await openBundle(browser, bundle, {}, async (p) => {
        await p.addInitScript((s) => {
          (window as unknown as { __REVIEW_PROPS__: unknown }).__REVIEW_PROPS__ = s;
        }, props);
        await routes(p);
      });
      page.setDefaultTimeout(5000);
      return { page, crashes };
    }

    async function tabTo(page: Page, name: RegExp) {
      const tab = engine === 'webkit' ? 'Alt+Tab' : 'Tab';
      const label = () => page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return '';
        return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      });
      if (name.test(await label())) return;
      for (let i = 0; i < 80; i += 1) {
        await page.keyboard.press(tab);
        if (name.test(await label())) return;
      }
      throw new Error(`Tab never reached ${name}`);
    }

    it('draws main next to the branch, each with its own theme, and outlines what changed', async () => {
      const main = siteSnapshot({ id: 'site-main', texts: ['Fresh bread', 'Since 1990', 'Closed Mondays'], ground: '#ff0000' });
      const branch = siteSnapshot({ id: 'site-branch', texts: ['Fresh rolls', 'Since 1990'], ground: '#0000ff' });
      const extra = branch.pages as Record<string, { appComponentTree: { children: unknown[] } }>;
      extra.home.appComponentTree.children.push({ id: 'el-new', type: 'p', componentType: 'host', props: { children: 'Open Sundays' }, children: [] });
      const { page, crashes } = await open(propsOf(main, branch), async (p) => {
        await p.route('**/api/projects/site-branch/branch/changes', (route) => json(route, reviewOf(main, branch)));
      });
      await page.getByText(/^1 page, 3 elements, 1 site setting changed · Ready for review$/).waitFor();
      const ids = ['el-0', 'el-1', 'el-2', 'el-new'];
      await expect.poll(() => paneState(page, 'branch', ids)).toMatchObject({ breakpoint: 'bpdesk01', ground: 'rgb(0, 0, 255)' });
      const onBranch = (await paneState(page, 'branch', ids))!;
      const onMain = (await paneState(page, 'main', ids))!;
      // Each side its own theme: two grounds in one window.
      expect(onMain.ground).toBe('rgb(255, 0, 0)');
      expect(onMain.breakpoint).toBe('bpdesk01');
      // The branch outlines what it changed and added; main what the branch changed and removed. Unchanged: none.
      expect(onBranch.outlines).toEqual({ 'el-0': 'rgb(217, 119, 6)', 'el-1': 'none', 'el-2': 'absent', 'el-new': 'rgb(22, 163, 74)' });
      expect(onMain.outlines).toEqual({ 'el-0': 'rgb(217, 119, 6)', 'el-1': 'none', 'el-2': 'rgb(220, 38, 38)', 'el-new': 'absent' });
      // An element chosen from the list with the keyboard is outlined thicker on the branch.
      await tabTo(page, /^Added Open Sundays/);
      await page.keyboard.press('Enter');
      await expect
        .poll(() => page.evaluate(() => {
          const el = document.querySelector('[data-review-side="branch"]')?.shadowRoot?.querySelector<HTMLElement>('[data-inner-component-id="el-new"]');
          return el ? getComputedStyle(el).outlineWidth : null;
        }))
        .toBe('4px');
      expect(crashes).toEqual([]);
      await page.close();
    });

    it('answers a question with the keyboard, stores it, updates the branch and merges', async () => {
      const main = siteSnapshot({ id: 'site-main', texts: ['Main title'], ground: '#ffffff' });
      const branch = siteSnapshot({ id: 'site-branch', texts: ['Branch title'], ground: '#ffffff' });
      const question: ShownConflictJson = {
        id: 'c1', kind: 'value', unit: { kind: 'node', id: 'el-0', container: 'page:home' }, path: ['props', 'children'], fingerprint: 'fp1',
        options: ['main', 'branch'], base: 'Title', main: 'Main title', branch: 'Branch title',
      };
      const calls: string[] = [];
      let state: 'asked' | 'answered' | 'updated' = 'asked';
      const now = (): BranchReviewJson =>
        reviewOf(main, branch, {
          upToDate: state === 'updated',
          token: state === 'updated' ? 'tok-2' : 'tok-1',
          conflicts: state === 'asked' ? [question] : [],
          settled: state === 'answered' ? [{ id: 'c1', pick: 'branch', conflict: question }] : [],
        });
      const { page, crashes } = await open(propsOf(main, branch), async (p) => {
        await p.route('**/api/projects/site-branch/branch/changes', (route) => json(route, now()));
        await p.route('**/api/projects/site-branch/branch/answers', (route) => {
          calls.push(`answers ${route.request().postData()}`);
          state = 'answered';
          return json(route, now());
        });
        await p.route('**/api/projects/site-branch/branch/update', (route) => {
          calls.push(`update ${route.request().postData()}`);
          state = 'updated';
          return json(route, { updated: true, branch: summary(), token: 'tok-2' });
        });
        await p.route('**/api/projects/site-branch/branch/merge', (route) => {
          calls.push(`merge ${route.request().postData()}`);
          return json(route, { merged: true, branch: summary({ status: 'merged' }), mainVersion: 9 });
        });
      });
      const merge = page.getByRole('button', { name: 'Merge into Bakery' });
      await page.getByText(/Home: Branch title: text|Home: .*: text/).waitFor();
      expect(await merge.isDisabled()).toBe(true);
      await tabTo(page, /^Branch: Branch title$/);
      await page.keyboard.press('Enter');
      await expect.poll(() => page.getByRole('button', { name: 'Branch: Branch title' }).getAttribute('aria-pressed')).toBe('true');
      expect(calls).toContain('answers {"token":"tok-1","resolutions":{"c1":{"fingerprint":"fp1","pick":"branch"}}}');
      await tabTo(page, /^Update the branch$/);
      await page.keyboard.press('Enter');
      await expect.poll(() => calls).toContain('update {"token":"tok-1"}');
      await expect.poll(() => merge.isEnabled()).toBe(true);
      await merge.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Merged into Bakery' }).waitFor();
      expect(calls).toContain('merge {"token":"tok-2"}');
      expect(await page.getByRole('link', { name: 'Open Bakery' }).getAttribute('href')).toBe('/projects/site-main');
      expect(crashes).toEqual([]);
      await page.close();
    });

    it('draws a review of 200 changed elements, list and both panes, in under a second', async () => {
      const count = 200;
      const main = siteSnapshot({ id: 'site-main', texts: Array.from({ length: count }, (_, i) => `Main text ${i}`), ground: '#ffffff' });
      const branch = siteSnapshot({ id: 'site-branch', texts: Array.from({ length: count }, (_, i) => `Branch text ${i}`), ground: '#ffffff' });
      const { page, crashes } = await open(propsOf(main, branch), async (p) => {
        await p.route('**/api/projects/site-branch/branch/changes', (route) => json(route, reviewOf(main, branch)));
      });
      await page.waitForFunction(
        (n) => {
          const panes = ['main', 'branch'].map((side) => document.querySelector(`[data-review-side="${side}"]`)?.shadowRoot);
          const drawn = panes.every((root) => root && root.querySelectorAll('[data-inner-component-id^="el-"]').length >= n && root.querySelector('[data-review-outlines]'));
          const listed = document.querySelectorAll('[data-element^="el-"]').length >= n;
          if (drawn && listed && !(window as unknown as { __REVIEW_DRAWN__?: number }).__REVIEW_DRAWN__) {
            (window as unknown as { __REVIEW_DRAWN__: number }).__REVIEW_DRAWN__ = performance.now();
          }
          return drawn && listed;
        },
        count,
        { polling: 'raf', timeout: 10_000 },
      );
      const ms = await page.evaluate(() => {
        const w = window as unknown as { __REVIEW_DRAWN__: number; __REVIEW_STARTED__: number };
        return Math.round(w.__REVIEW_DRAWN__ - w.__REVIEW_STARTED__);
      });
      // The measurement, kept where a run can read it back (the reporter swallows console output).
      appendFileSync(path.join(os.tmpdir(), 'branch-review-timing.log'), `${new Date().toISOString()} ${engine}: ${count} changed elements drawn in ${ms} ms\n`);
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(crashes).toEqual([]);
      await page.close();
    });
  });
}
