// pnpm test:render-gate: whether anything stored can act on a page, in Chromium and
// WebKit, through both renderers. RENDER_GATE_FULL=1 crosses every row with every
// value. While working on it, RENDER_GATE_ONLY=published narrows the surfaces and
// RENDER_GATE_MATCH=<regexp> the probes, by what they are called.

import fs from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, webkit, type BrowserType } from 'playwright';
import { bundleEditor } from '../score/lib/canvasBundle';
import { BLOCKED_TAGS, FORM_NAMED_TAGS } from '@/lib/renderer/blockedNodes';
import { DOM_MEMBER_NAMES, FORM_MEMBER_NAMES } from '@/lib/renderer/domMemberNames.generated';
import { RENDERED_TAGS } from '@/lib/renderer/renderVocabulary';
import { buildProbes, type Probe } from './probes';
import { readBundle, runBatch, type Finding, type Surface } from './harness';

const FULL = process.env.RENDER_GATE_FULL === '1';
const BATCH_SIZE = 200;
const WORKERS = Number(process.env.RENDER_GATE_WORKERS ?? 4);
const SURFACES: Surface[] = (process.env.RENDER_GATE_ONLY?.split(',') as Surface[] | undefined) ?? ['published', 'island', 'canvas'];
const ONLY_PROBES = process.env.RENDER_GATE_MATCH ? new RegExp(process.env.RENDER_GATE_MATCH) : undefined;
const REPORT = 'test/renderGate/.out/findings.json';

const BROWSERS: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];

/**
 * WebKit stops following links after a burst of navigations from one page, which the
 * leave canary showed. So a batch holds fewer of what a click can take away.
 */
const MAX_NAVIGATING = 60;
const mayLeave = (probe: Probe) => /^<(?:a|area|form|button|input)\b|^a stored form/i.test(probe.what);

function batches(probes: readonly Probe[]): Probe[][] {
  const out: Probe[][] = [];
  let batch: Probe[] = [];
  let navigating = 0;
  for (const probe of probes) {
    batch.push(probe);
    if (mayLeave(probe)) navigating++;
    if (batch.length === BATCH_SIZE || navigating === MAX_NAVIGATING) {
      out.push(batch);
      batch = [];
      navigating = 0;
    }
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

const summary = (findings: readonly Finding[]) =>
  [...new Map(findings.map((f) => [`${f.browser}/${f.surface}/${f.detector}/${f.what}`, f])).values()]
    .map((f) => `${f.browser} ${f.surface} ${f.detector}: ${f.what} (${f.detail})`);

describe('render gate', () => {
  let bundle = '';

  beforeAll(async () => {
    bundle = readBundle(await bundleEditor('test/renderGate/browserEntry.tsx', 'render-gate-bundle'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it.each(BROWSERS)('the checked-in member names cover %s', async (_name, type) => {
    const browser = await type.launch();
    const page = await browser.newPage();
    const names = await page.evaluate(() =>
      [Document.prototype, HTMLFormElement.prototype].flatMap((start) => {
        const out: string[] = [];
        for (let proto: object | null = start; proto; proto = Object.getPrototypeOf(proto)) out.push(...Object.getOwnPropertyNames(proto));
        return out;
      }),
    );
    await browser.close();
    const known = new Set(DOM_MEMBER_NAMES);
    expect(names.filter((name) => !known.has(name))).toEqual([]);
  });

  it.each(BROWSERS)('the checked-in form members cover %s', async (_name, type) => {
    const browser = await type.launch();
    const page = await browser.newPage();
    const names = await page.evaluate(() => {
      const out: string[] = [];
      for (let proto: object | null = HTMLFormElement.prototype; proto; proto = Object.getPrototypeOf(proto)) out.push(...Object.getOwnPropertyNames(proto));
      return out;
    });
    await browser.close();
    const known = new Set(FORM_MEMBER_NAMES);
    expect(names.filter((name) => !known.has(name))).toEqual([]);
  });

  // The rule goes by tag, so a tag it does not know is a way through it: the whole
  // vocabulary is asked here, in a form and from outside one, and `img` has its own rule.
  it.each(BROWSERS)('no other rendered tag gives a form a member by id in %s', async (_name, type) => {
    const browser = await type.launch();
    const page = await browser.newPage();
    const tags = [...RENDERED_TAGS].filter((tag) => !BLOCKED_TAGS.has(tag));
    const found = await page.evaluate((list) => {
      const out: string[] = [];
      for (const tag of list) {
        for (const namespace of ['http://www.w3.org/1999/xhtml', 'http://www.w3.org/2000/svg', 'http://www.w3.org/1998/Math/MathML']) {
          const form = document.createElement('form');
          form.id = 'gate-form';
          const outside = document.createElement('div');
          const inner = document.createElementNS(namespace, tag);
          const beside = document.createElementNS(namespace, tag);
          inner.id = 'parentElement';
          beside.id = 'closest';
          beside.setAttribute('form', 'gate-form');
          form.append(inner);
          outside.append(form, beside);
          document.body.append(outside);
          if (Object.getOwnPropertyDescriptor(form, 'parentElement') || Object.getOwnPropertyDescriptor(form, 'closest')) out.push(tag);
          outside.remove();
        }
      }
      return [...new Set(out)];
    }, tags);
    await browser.close();
    expect(tags.length).toBeGreaterThan(100);
    expect(found.filter((tag) => tag !== 'img' && !FORM_NAMED_TAGS.has(tag))).toEqual([]);
    // Not blind: the list above is what the browser really does.
    expect(found.filter((tag) => FORM_NAMED_TAGS.has(tag)).sort()).toEqual([...FORM_NAMED_TAGS].sort());
  });

  // The tag the markup names is not always the element the parser makes, and a rule
  // by tag has to know each one that turns into something else.
  it.each(BROWSERS)('the parser rewrites no rendered tag but image in %s', async (_name, type) => {
    const browser = await type.launch();
    const page = await browser.newPage();
    const tags = [...RENDERED_TAGS].filter((tag) => !BLOCKED_TAGS.has(tag));
    const contexts = ['', '<svg><foreignObject>', '<svg><desc>', '<svg><title>', '<svg><g><p>', '<math><mi>', '<select>', '<table>', '<table><tr>', '<template>'];
    const found = await page.evaluate(({ list, around }) => {
      const out: string[] = [];
      for (const context of around) {
        for (const tag of list) {
          const parsed = new DOMParser().parseFromString(`<!doctype html><body>${context}<${tag} id="gate"></${tag}>`, 'text/html');
          const root = parsed.querySelector('template')?.content ?? parsed;
          const element = root.querySelector('#gate');
          if (element && element.localName.toLowerCase() !== tag) out.push(`${tag} became ${element.localName} after ${context || 'nothing'}`);
        }
      }
      return out;
    }, { list: tags, around: contexts });
    await browser.close();
    expect(found.filter((line) => !line.startsWith('image became img'))).toEqual([]);
    expect(found).toContain('image became img after nothing');
  });

  it.each(BROWSERS)('a member id would make a walk up from a form endless in %s', async (_name, type) => {
    const browser = await type.launch();
    const page = await browser.newPage();
    const steps = await page.evaluate(() => {
      const form = document.createElement('form');
      const input = document.createElement('input');
      input.id = 'parentElement';
      form.append(input);
      document.body.append(form);
      let count = 0;
      for (let node: Element | null = form; node && count < 1000; node = node.parentElement) count++;
      return count;
    });
    await browser.close();
    expect(steps).toBe(1000);
  });

  it.each(BROWSERS)('nothing stored acts on a page in %s', async (name, type) => {
    let browser = await type.launch();
    // WebKit can lose a tab to a batch that opens dozens of windows (forms with a
    // target), and no single value does it. So a batch that dies is halved until
    // each probe has had a page. One probe that still kills its page is a finding:
    // that is a stored value stopping a page, not a harness problem.
    const withRestart = async (list: Probe[], surface: Surface, tag: string): Promise<Finding[]> => {
      try {
        return await runBatch(browser, name, surface, list, tag, bundle);
      } catch (error) {
        if (!browser.isConnected()) browser = await type.launch();
        if (list.length === 1) {
          return [{ browser: name, surface, probe: list[0].id, what: list[0].what, detector: 'crash', detail: String(error).slice(0, 160) }];
        }
        const half = Math.ceil(list.length / 2);
        const parts = [await withRestart(list.slice(0, half), surface, `${tag}a`), await withRestart(list.slice(half), surface, `${tag}z`)];
        return parts.flat();
      }
    };
    const probes = buildProbes(FULL).filter((probe) => !ONLY_PROBES || ONLY_PROBES.test(probe.what));
    const findings: Finding[] = [];
    try {
      for (const surface of SURFACES) {
        const queue = batches(probes).map((list, index) => ({ list, tag: `b${index}` }));
        const worker = async () => {
          for (let job = queue.shift(); job; job = queue.shift()) {
            findings.push(...(await withRestart(job.list, surface, job.tag)));
          }
        };
        await Promise.all(Array.from({ length: WORKERS }, worker));
      }
    } finally {
      await browser.close();
    }
    fs.mkdirSync('test/renderGate/.out', { recursive: true });
    fs.writeFileSync(REPORT.replace('findings', `findings-${name}`), JSON.stringify(findings, null, 1));
    process.stdout.write(`${name}: ${probes.length} probes on ${SURFACES.join(', ')}, ${findings.length} findings\n`);
    expect(summary(findings)).toEqual([]);
  });
});
