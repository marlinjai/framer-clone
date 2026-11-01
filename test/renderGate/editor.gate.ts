// The hostile probes on the mounted editor: the real EditorApp and ComponentRenderer,
// where the document is the signed-in owner's, so a stored node that acts here is
// worse than anywhere else. fuzz.gate.ts covers the width; this covers the real thing.

import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { chromium, webkit, type BrowserType } from 'playwright';
import { bundleEditor } from '../score/lib/canvasBundle';
import { ComponentTypeEnum } from '@/models/ComponentModel';
import { buildProbes, type ProbeNode } from './probes';

const EMBEDS = 'script,style,iframe,object,embed,fencedframe,portal';
const HOSTILE = /^tag .* in (?:html|svg)$|^<(?:x-y|div) \w+=html>$|proto|^an? \w+ ref$|as text|^a style|^<(?:a|form) (?:href|action)=js-array>$/;

const toSnapshot = (node: ProbeNode): Record<string, unknown> => ({
  id: node.id,
  type: node.type,
  componentType: ComponentTypeEnum.HOST,
  props: node.props,
  children: (node.children ?? []).map(toSnapshot),
});

describe('render gate on the mounted editor', () => {
  it.each([['chromium', chromium], ['webkit', webkit]] as [string, BrowserType][])('nothing stored acts on the canvas in %s', async (_name, type) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bundle = await bundleEditor();
    const probes = buildProbes(false).filter((probe) => HOSTILE.test(probe.what));
    const tree = {
      id: 'gate-root',
      type: 'div',
      componentType: ComponentTypeEnum.HOST,
      props: {},
      children: [...probes.map((probe) => toSnapshot(probe.node)), { id: 'gate-end', type: 'p', componentType: ComponentTypeEnum.HOST, props: { id: 'gate-end', children: 'end' }, children: [] }],
    };

    const browser = await type.launch();
    const hits: string[] = [];
    const errors: string[] = [];
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(60_000);
      await page.exposeFunction('__hit', (id: string) => { hits.push(id); });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) =>
        route.request().url() === 'http://canvas-probe.local/'
          ? route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' })
          : route.fulfill({ status: 204 }),
      );
      await page.goto('http://canvas-probe.local/');
      await page.addScriptTag({ content: fs.readFileSync(bundle, 'utf8') });
      await page.evaluate((snapshot) => (window as unknown as { __placeTree: (s: unknown) => void }).__placeTree(snapshot), tree);
      await page.locator('#gate-end').first().waitFor({ state: 'attached', timeout: 30_000 });

      const embedded = await page.evaluate(async (selector) => {
        const nodes = Array.from(document.querySelectorAll('[data-inner-component-id="gate-root"] *')) as HTMLElement[];
        for (const el of nodes) {
          try {
            el.click?.();
          } catch {
            // Nothing to learn from an element that refuses a click.
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return document.querySelectorAll(`[data-inner-component-id="gate-root"] :is(${selector})`).length;
      }, EMBEDS);
      await page.waitForTimeout(200);

      // Not blind: the same page does run what is written straight into it.
      await page.evaluate(() => {
        const img = document.createElement('img');
        img.setAttribute('onerror', "__hit('canary')");
        img.src = 'x:';
        document.body.append(img);
      });
      await page.waitForFunction(() => document.readyState === 'complete');
      await page.waitForTimeout(200);

      expect(hits).toEqual(['canary']);
      expect(embedded).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
