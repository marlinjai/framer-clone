// Step 3 of three: frozen pages to node trees, and the manifest that seals them.
//
//   pnpm exec tsx test/score/busbasis/rebuild.ts
//
// One mechanical pass over every page (lift.ts). Fixing a misread of the CSS here is
// fair. Changing what is lifted because a page failed is tuning, and the fixtures are
// held out so that nobody does: see README.md beside them.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium, type Page } from 'playwright';
import { readRules } from '@/lib/rules/rules';
import { BREAKPOINTS } from '../lib/breakpoints';
import { LIFT_INPUT, liftDocument, settleEmbeds, settleRootRules, type LiftedNode, type LiftResult } from './lift';
import { BUSBASIS_PAGES } from './pages';
import { CORPUS_DIR, SHARED_SHEET, SHEET_MARKER, framesFile } from './freeze';

export const MANIFEST = path.join(CORPUS_DIR, 'manifest.json');

export const frozenDocument = (slug: string): string =>
  fs
    .readFileSync(path.join(CORPUS_DIR, 'pages', `${slug}.html`), 'utf8')
    .replace(SHEET_MARKER, () => `<style>${fs.readFileSync(path.join(CORPUS_DIR, SHARED_SHEET), 'utf8')}</style>`);

interface Inventory {
  nodes: number;
  rules: number;
  nodesWithRules: number;
  refused: Record<string, number>;
}

function inventoryOf(root: LiftedNode): Inventory {
  const inventory: Inventory = { nodes: 0, rules: 0, nodesWithRules: 0, refused: {} };
  // The page root reads its list as the published path does: a rule on `:root` is its own.
  const visit = (node: LiftedNode) => {
    inventory.nodes += 1;
    const { rules, refused } = readRules(node.props, { pageRoot: node === root });
    inventory.rules += rules.length;
    if (rules.length + refused.length > 0) inventory.nodesWithRules += 1;
    for (const entry of refused) {
      const stored = entry.rule as { selector?: string; at?: string[] };
      const key = `${entry.reason} [${stored.selector ?? 'definition'}${stored.at ? ` ${stored.at.join(' ')}` : ''}]`.slice(0, 200);
      inventory.refused[key] = (inventory.refused[key] ?? 0) + 1;
    }
    node.children?.forEach(visit);
  };
  visit(root);
  return inventory;
}

/** Live computed styles against the frozen page in the score's Chromium: did freezing change the page? */
async function fidelityOf(page: Page, slug: string): Promise<Record<string, unknown>> {
  const captured = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(CORPUS_DIR, 'pages', `${slug}.computed.json.gz`))).toString()) as Record<
    string,
    { firsts: Record<string, Record<string, string>>; rows: Record<string, { t: string; d: Record<string, string> }>; scrollHeight: number }
  >;
  const out: Record<string, unknown> = {};
  for (const breakpoint of BREAKPOINTS) {
    const reference = captured[breakpoint.id];
    await page.setViewportSize({ width: breakpoint.width, height: breakpoint.height });
    await page.setContent(frozenDocument(slug));
    await page.evaluate(() => document.getAnimations().forEach((a) => a.cancel()));
    const now = await page.evaluate(() => {
      const facts: Record<string, Record<string, string>> = {};
      document.querySelectorAll('[data-parity-id]').forEach((el) => {
        const style = getComputedStyle(el);
        const row: Record<string, string> = {};
        for (let i = 0; i < style.length; i++) if (!style[i].startsWith('--')) row[style[i]] = style.getPropertyValue(style[i]);
        facts[el.getAttribute('data-parity-id') as string] = row;
      });
      return { facts, scrollHeight: document.documentElement.scrollHeight };
    });
    let values = 0;
    let different = 0;
    const byProperty: Record<string, number> = {};
    for (const [id, row] of Object.entries(reference.rows)) {
      const expected = { ...reference.firsts[row.t], ...row.d };
      for (const [name, value] of Object.entries(expected)) {
        values += 1;
        if (now.facts[id]?.[name] !== value) {
          different += 1;
          byProperty[name] = (byProperty[name] ?? 0) + 1;
        }
      }
    }
    const top = Object.entries(byProperty).sort((a, b) => b[1] - a[1]).slice(0, 6);
    out[breakpoint.id] = { values, different, scrollHeightLive: reference.scrollHeight, scrollHeightFrozen: now.scrollHeight, top };
  }
  return out;
}

/** A link or button whose hover changes the original at every width, or none. */
async function findHoverTarget(page: Page, slug: string, tree: LiftedNode): Promise<string | null> {
  const candidates: string[] = [];
  const visit = (node: LiftedNode) => {
    const rules = (node.props.rules ?? []) as { selector?: string }[];
    if (rules.some((rule) => rule.selector === '&:hover')) candidates.push(node.props['data-parity-id'] as string);
    node.children?.forEach(visit);
  };
  visit(tree);
  for (const id of candidates.slice(0, 40)) {
    let everywhere = true;
    for (const breakpoint of BREAKPOINTS) {
      await page.setViewportSize({ width: breakpoint.width, height: breakpoint.height });
      await page.setContent(frozenDocument(slug));
      const target = page.locator(`[data-parity-id="${id}"]`);
      const dump = () => target.evaluate((el) => JSON.stringify(Object.fromEntries(Array.from(getComputedStyle(el)).map((p) => [p, getComputedStyle(el).getPropertyValue(p)]))));
      if (!(await target.isVisible())) { everywhere = false; break; }
      const before = await dump();
      const hovered = await target.hover({ timeout: 800 }).then(() => true, () => false);
      await page.waitForTimeout(350);
      if (!hovered || before === (await dump())) { everywhere = false; break; }
    }
    if (everywhere) return id;
  }
  return null;
}

/** The frame addresses freeze.ts recorded for a page, or undefined for a page without one. */
const framesOf = (slug: string): (string | null)[] | undefined =>
  fs.existsSync(framesFile(slug)) ? (JSON.parse(fs.readFileSync(framesFile(slug), 'utf8')) as { frames: (string | null)[] }).frames : undefined;

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  page.setDefaultTimeout(5000);
  // tsx wraps nested functions in __name, which the page does not have.
  await page.addInitScript('globalThis.__name = (f) => f');
  await page.evaluate('globalThis.__name = (f) => f');

  const entries: Record<string, unknown>[] = [];
  const captures = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'captures.json'), 'utf8')) as { pages: Record<string, unknown>[] };

  for (const listed of BUSBASIS_PAGES) {
    await page.setContent(frozenDocument(listed.slug));
    await page.evaluate('globalThis.__name = (f) => f');
    const { root, report } = settleEmbeds(settleRootRules((await page.evaluate(liftDocument, LIFT_INPUT)) as LiftResult), framesOf(listed.slug));
    const inventory = inventoryOf(root);
    const treeFile = path.join(CORPUS_DIR, 'pages', `${listed.slug}.tree.json.gz`);
    fs.writeFileSync(treeFile, zlib.gzipSync(JSON.stringify(root), { level: 9 }));
    const hoverTarget = await findHoverTarget(page, listed.slug, root);
    const fidelity = await fidelityOf(page, listed.slug);
    console.log(listed.slug, JSON.stringify({ ...inventory, refused: Object.keys(inventory.refused).length, hoverTarget }), JSON.stringify(fidelity).slice(0, 400));
    entries.push({
      ...captures.pages.find((p) => p.slug === listed.slug),
      hoverTarget,
      inventory,
      unread: report.unreadSelectors.length,
      rootTook: report.rootTook.filter((name) => !name.startsWith('--')),
      rootVariables: report.rootTook.filter((name) => name.startsWith('--')).length,
      rootRules: report.rootRules.filter((name) => !name.startsWith('--')),
      rootRuleVariables: report.rootRules.filter((name) => name.startsWith('--')).length,
      rootLeft: report.rootLeft,
      lang: report.lang,
      fidelity,
    });
  }
  await browser.close();

  const files = [SHARED_SHEET, ...fs.readdirSync(path.join(CORPUS_DIR, 'pages')).map((name) => `pages/${name}`)].sort();
  const manifest = {
    _doc: 'Held out: see README.md. Regenerated only by test/score/busbasis/rebuild.ts after a new capture of the live site. The score refuses to run when a file does not match its hash here.',
    source: 'https://basiscampberlin.de, read only, logged out, through dev-browser-auto (headless automation Chrome)',
    pages: entries,
    sha256: Object.fromEntries(files.map((name) => [name, sha256(path.join(CORPUS_DIR, name))])),
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1]?.endsWith('rebuild.ts')) void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
