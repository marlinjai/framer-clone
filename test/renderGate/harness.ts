// Puts probes on a real page and watches what the browser does. Four detectors:
//
//   run       `__hit`, defined before any markup and reachable from every frame.
//   leave     a navigation by itself, or by a click on something that may not.
//   fetch     a request that is not an image or media file, which a page may load.
//   embed     an element that holds another document or code, after rendering.
//
// A crash (a stored value that stops the render) is a finding too. Every batch ends
// with canaries written straight into the page, past the renderers. If one stays
// silent the batch saw nothing, and that fails the run: a blind harness must not
// read as a clean gate.

import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Browser, Page, Request } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { BREAKPOINTS } from '../score/lib/published';
import { applyResponsiveStyles } from '@/lib/renderer/server/applyResponsiveStyles';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { FOREIGN, type Probe } from './probes';

export type Surface = 'published' | 'island' | 'canvas';

export interface Finding {
  browser: string;
  surface: Surface;
  probe: string;
  what: string;
  detector: 'run' | 'leave' | 'fetch' | 'embed' | 'crash' | 'blind';
  detail: string;
}

const ORIGIN = 'https://harness.test';
const ALLOWED_LOADS: ReadonlySet<string> = new Set(['image', 'media', 'texttrack']);
// React adds its own image preload next to an img, which loads only what the img would.
const EMBEDS = 'script,style,iframe,frame,frameset,object,embed,fencedframe,portal,link:not([rel=preload][as=image]),meta,base,webview';

const CANARIES = (id: string) => `<div data-canary hidden>
  <a data-canary-link href="javascript:__hit('${id}-link')">x</a>
</div><img data-canary src="x:" onerror="__hit('${id}-handler')">
<i data-canary-end></i>`;

interface Rendered {
  html: string;
  css: string;
  crashes: Finding[];
}

function renderBatch(browser: string, probes: readonly Probe[]): Rendered {
  const crashes: Finding[] = [];
  let html = '';
  let css = '';
  for (const probe of probes) {
    try {
      const { root, css: sheet } = (() => {
        const out = applyResponsiveStyles(probe.node as unknown as ComponentNode, BREAKPOINTS);
        return { root: out.root, css: out.css };
      })();
      const markup = renderToStaticMarkup(React.createElement(React.Fragment, null, renderComponentNode(root)));
      html += `<div data-probe="${probe.id}">${markup}</div>`;
      css += sheet;
    } catch (error) {
      crashes.push({ browser, surface: 'published', probe: probe.id, what: probe.what, detector: 'crash', detail: String(error).slice(0, 160) });
    }
  }
  return { html, css, crashes };
}

const doc = (head: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

/**
 * Every element gets the actions a visitor could take, one at a time, so one link
 * cannot cancel another. Reports where it is, so that a click that replaces the page
 * can be named and the rest of the batch still gets its turn.
 */
async function act(page: Page, from: number): Promise<number> {
  return page.evaluate(async (start) => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
    const at = (window as unknown as { __at: (index: number, probe: string) => void }).__at;
    const elements = Array.from(document.querySelectorAll('[data-probe] *, [data-canary-link]')) as HTMLElement[];
    for (let index = start; index < elements.length; index++) {
      const el = elements[index];
      at(index, el.closest<HTMLElement>('[data-probe]')?.dataset.probe ?? '');
      try {
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.focus?.();
        if (el instanceof HTMLDetailsElement) el.open = true;
        if (el instanceof HTMLMediaElement) void el.play().catch(() => {});
        if (el instanceof HTMLFormElement) el.requestSubmit();
        else if (typeof el.click === 'function') el.click();
        else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } catch {
        // An element that refuses an action has nothing to say about the gate.
      }
      if (el.matches('a, area, button, input, form, [href]')) await pause();
    }
    return elements.length;
  }, from);
}

interface Watch {
  hits: Set<string>;
  requests: Request[];
  crashes: { id: string; message: string }[];
  /** How far act() got, and on which probe. */
  index: number;
  probe: string;
  /** Each load has an address of its own, because a plain form submits to the page it is on. */
  address: string;
}

async function preparePage(browser: Browser, html: string, bundle: string | undefined): Promise<{ page: Page; watch: Watch; close: () => Promise<void> }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const watch: Watch = { hits: new Set(), requests: [], crashes: [], index: 0, probe: '', address: `${ORIGIN}/` };
  await page.exposeFunction('__hit', (id: string) => { watch.hits.add(String(id)); });
  await page.exposeFunction('__crash', (id: string, message: string) => { watch.crashes.push({ id, message }); });
  await page.exposeFunction('__at', (index: number, probe: string) => { watch.index = index; watch.probe = probe; });
  page.on('dialog', (dialog) => { void dialog.dismiss(); });
  page.on('popup', (popup) => { void popup.close(); });
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (request.url() === watch.address) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    if (bundle && request.url() === `${ORIGIN}/bundle.js`) return route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle });
    watch.requests.push(request);
    return route.fulfill({ status: 204 });
  });
  return { page, watch, close: () => context.close() };
}

/** WebKit reports a media file as `other`. */
const isMediaInWebkit = (request: Request, what: string | undefined) =>
  request.resourceType() === 'other' && /^<(?:video|audio|source|track)\b/i.test(what ?? '');

/** The harness's page, or a blob it made: WebKit turns a data: media file into one. */
const isOwn = (url: string) => url.startsWith(ORIGIN) || url.startsWith(`blob:${ORIGIN}`);

const probeOfRequest = (url: string): string | undefined => /\/(p\d+)/.exec(url)?.[1];

export async function runBatch(browser: Browser, browserName: string, surface: Surface, probes: readonly Probe[], batch: string, bundle: string): Promise<Finding[]> {
  const byId = new Map(probes.map((p) => [p.id, p]));
  const what = (id: string) => byId.get(id)?.what ?? id;
  const findings: Finding[] = [];
  const add = (probe: string, detector: Finding['detector'], detail: string) =>
    findings.push({ browser: browserName, surface, probe, what: what(probe), detector, detail: detail.slice(0, 200) });

  let html: string;
  if (surface === 'published') {
    const rendered = renderBatch(browserName, probes);
    findings.push(...rendered.crashes);
    html = doc(`<style>${rendered.css}</style>`, `${rendered.html}${CANARIES(batch)}`);
  } else {
    html = doc('<script src="/bundle.js"></script>', `<div id="probes"></div>${CANARIES(batch)}`);
  }

  const { page, watch, close } = await preparePage(browser, html, surface === 'published' ? undefined : bundle);
  let loads = 0;
  const load = async () => {
    watch.address = `${ORIGIN}/?load=${++loads}`;
    await page.goto(watch.address, { waitUntil: 'load' });
    if (surface !== 'published') {
      await page.evaluate(
        ({ surface: s, list }) => (window as unknown as { __mount: (a: string, b: unknown) => void }).__mount(s, list),
        { surface, list: probes.map(({ id, node }) => ({ id, node })) },
      );
    }
    await page.waitForTimeout(40);
  };
  try {
    await load();
    const loaded = watch.requests.length;
    for (const request of watch.requests) {
      if (request.isNavigationRequest()) add(probeOfRequest(request.url()) ?? 'unknown', 'leave', `by itself: ${request.url()}`);
    }

    const embedded = await page.evaluate((selector) => {
      const found: string[] = [];
      const visit = (root: ParentNode, probe: string) => {
        for (const el of Array.from(root.querySelectorAll(selector))) found.push(`${probe} ${el.tagName.toLowerCase()}`);
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (el.shadowRoot) {
            found.push(`${probe} shadow-root`);
            visit(el.shadowRoot, probe);
          }
        }
      };
      document.querySelectorAll('[data-probe]').forEach((box) => visit(box, (box as HTMLElement).dataset.probe ?? '?'));
      return found;
    }, EMBEDS);
    for (const line of embedded) {
      const [probe, tag] = line.split(' ');
      add(probe, 'embed', tag);
    }

    let start = 0;
    for (let reloads = 0; reloads < 40; reloads++) {
      const left = await act(page, start).catch(() => undefined);
      await page.waitForTimeout(60);
      if (left !== undefined && page.url().split('#')[0] === watch.address) break;
      add(watch.probe, 'leave', `the page was replaced by ${page.url()}`);
      start = watch.index + 1;
      await load();
    }

    for (const id of watch.hits) {
      if (!id.startsWith(batch)) add(id, 'run', 'code ran');
    }
    for (const { id, message } of watch.crashes) add(id, 'crash', message);
    watch.requests.forEach((request, index) => {
      const probe = probeOfRequest(request.url());
      const url = request.url();
      if (!url.startsWith(FOREIGN) && !isOwn(url)) add(probe ?? 'unknown', 'fetch', url);
      if (request.isNavigationRequest()) {
        // A plain form submits to the page it is on, and a path stays on the site.
        if (index >= loaded && !isOwn(url) && !(probe && byId.get(probe)?.mayNavigate)) add(probe ?? 'unknown', 'leave', `on a click: ${url}`);
      } else if (!ALLOWED_LOADS.has(request.resourceType()) && !isMediaInWebkit(request, probe && byId.get(probe)?.what) && !isOwn(url)) {
        add(probe ?? 'unknown', 'fetch', `${request.resourceType()}: ${url}`);
      }
    });

    const end = await page.locator('[data-canary-end]').count();
    if (end === 0) add(batch, 'blind', 'the page ended early: a probe swallowed what followed it');
    for (const canary of ['link', 'handler']) {
      if (!watch.hits.has(`${batch}-${canary}`)) add(batch, 'blind', `the ${canary} canary stayed silent`);
    }
  } finally {
    await close();
  }
  return findings;
}

export const readBundle = (file: string) => fs.readFileSync(file, 'utf8');
