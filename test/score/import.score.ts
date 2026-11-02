// The import score: real components through the importer and the one door a person uses,
// `readBundle`, rendered as a visitor gets them, and compared in Chromium with the real
// component running in a real Tailwind page. Every fixture runs under the repo's theme and
// under a foreign one, at each default breakpoint and in each scripted state.
//
// Four measures, per fixture and theme. Conservation: every construct of the source is on
// exactly one line that holds it. Honesty: a fixture that reads "imported" differs in
// nothing no line names. Coverage: atoms converted or adapted, without AI. Parity: all
// checks pass. Plus forged bundles made from the real ones, each of which must come out as
// what it is, and the mutation run, where a construct of each kind inserted into a fixture
// must be named by a line at its own `file:line`.
//
// A low number is a result, never an error here. A scripted state that changes nothing on
// the original is a harness error, as in the corpus, because it would test nothing.
//
// The contract is docs/plans/2026-11-02-react-import.md, "The corpus: how success is measured".

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { createBundle, readBundle, type ImportBundle } from '@/lib/reactImport/bundle';
import { DETAILS, type Disposition, type ImportLine } from '@/lib/reactImport/report';
import { importSource, type SourceInput } from '@/lib/reactImport/source';
import { BREAKPOINTS, publishedDocument, renderThroughPublishedPage } from './lib/published';
import { MAX_DIFF_RATIO, diffRatio, takeSnapshot, type Snapshot } from './lib/compare';
import { OUT_DIR, writeOut } from './lib/io';
import { checkConservation } from './import/conservation';
import { IMPORT_FIXTURES, fromRoot, type ImportFixture } from './import/fixtures';
import { EXCUSE_ROWS, unnamed, type Difference } from './import/honesty';
import { mountScript, originalCss, originalDocument } from './import/original';
import { THEMES, themeText, tokensOf, type ThemeId } from './import/themes';
import type { ForgedCase, ImportCheck, ImportFailure, ImportRun, ImportScoreOut, MutationCase } from './import/types';

const FRAME_IDS = {
  tablet: BREAKPOINTS.find((b) => b.label === 'Tablet')?.id ?? 'tablet',
  mobile: BREAKPOINTS.find((b) => b.label === 'Mobile')?.id ?? 'mobile',
};
const THEME_FILE = 'theme.css';

/**
 * Gives every element of the import a parity id by its place, the same way on both pages. The body is not
 * compared: it is the page's, the editor's own on one side and the original app's on the other, and what the
 * import inherits from it shows on the import's elements.
 */
async function assignParityIds(page: Page): Promise<void> {
  await page.evaluate(() => {
    const skip = (element: Element) => element.tagName === 'STYLE' || element.tagName === 'SCRIPT';
    const walk = (element: Element, id: string) => {
      element.setAttribute('data-parity-id', id);
      [...element.children].filter((child) => !skip(child)).forEach((child, index) => walk(child, `${id}.${index}`));
    };
    const root = [...(document.getElementById('root')?.children ?? [])].find((child) => !skip(child));
    if (root) walk(root, 'r');
  });
}

async function open(browser: Browser, html: string, viewport: { width: number; height: number }, waitForRoot: boolean, state?: { apply: (page: Page) => Promise<void> }) {
  const page = await browser.newPage({ viewport, reducedMotion: 'no-preference' });
  page.setDefaultTimeout(3000);
  await page.setContent(html);
  if (waitForRoot) await page.waitForFunction(() => document.querySelector('#root > :not(style):not(script)') !== null);
  await assignParityIds(page);
  if (state) {
    await state.apply(page);
    // A transition caught halfway reads as a difference that is only timing, so both pages are read once settled.
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
  }
  return page;
}

/** The page's own colours, behind the import. */
const pageColours = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return `${style.backgroundColor} ${style.color}`;
  });

/** Every difference between two snapshots, by element and property, custom properties left out. */
function differences(a: Snapshot, b: Snapshot): Difference[] {
  const out: Difference[] = [];
  for (const [element, facts] of Object.entries(a.computed)) {
    const other = b.computed[element];
    if (!other) {
      out.push({ element, property: 'missing' });
      continue;
    }
    if (facts.text !== other.text) out.push({ element, property: 'text' });
    if (facts.rendered !== other.rendered) out.push({ element, property: 'rendered text' });
    for (const [property, value] of Object.entries(facts.styles)) if (other.styles[property] !== value) out.push({ element, property });
    if (facts.before !== other.before) out.push({ element, property: '::before' });
    if (facts.after !== other.after) out.push({ element, property: '::after' });
  }
  for (const element of Object.keys(b.computed)) if (!a.computed[element]) out.push({ element, property: 'extra' });
  return out;
}

const camelToKebab = (key: string): string => (key.startsWith('--') ? key : key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace(/^(webkit|moz|ms)-/, '-$1-'));

/** What each replica element's node writes, and its node id, by parity id. #text nodes are not elements. */
function replicaMap(root: ComponentNode | undefined): { nodeAt: Map<string, string>; writes: Map<string, Set<string>> } {
  const nodeAt = new Map<string, string>();
  const writes = new Map<string, Set<string>>();
  const visit = (node: ComponentNode, id: string) => {
    nodeAt.set(id, String(node.id));
    const props = (node.props ?? {}) as Record<string, unknown>;
    const keys = new Set<string>();
    for (const key of Object.keys((props.style as Record<string, unknown>) ?? {})) keys.add(camelToKebab(key));
    for (const rule of (props.rules as { style?: Record<string, unknown> }[]) ?? []) for (const key of Object.keys(rule.style ?? {})) keys.add(camelToKebab(key));
    // A shorthand writes its longhands too.
    for (const key of [...keys]) if (key === 'font') keys.add('font-family');
    writes.set(id, keys);
    (node.children ?? []).filter((child): child is ComponentNode => typeof child === 'object' && child !== null && child.type !== '#text').forEach((child, index) => visit(child, `${id}.${index}`));
  };
  if (root) visit(root, 'r');
  return { nodeAt, writes };
}

const atomsBy = (lines: readonly ImportLine[]): Record<Disposition, number> => {
  const counts: Record<Disposition, number> = { converted: 0, adapted: 0, rebuilt: 0, left: 0 };
  for (const line of lines) counts[line.disposition] += line.atoms.length;
  return counts;
};

const linesBy = (lines: readonly ImportLine[]): Record<Disposition, number> => {
  const counts: Record<Disposition, number> = { converted: 0, adapted: 0, rebuilt: 0, left: 0 };
  for (const line of lines) counts[line.disposition] += 1;
  return counts;
};

const filesOf = (fixture: ImportFixture, theme: ThemeId): SourceInput[] => [
  ...fixture.files.map((file) => ({ name: file, text: fs.readFileSync(fromRoot(file), 'utf8') })),
  { name: THEME_FILE, text: themeText(theme) },
];

const replicaDocument = async (nodes: ComponentNode | undefined): Promise<string> => {
  if (!nodes) return publishedDocument({ html: '<div id="root"></div>', css: '' });
  const output = await renderThroughPublishedPage({ tree: nodes, definitions: {} });
  return publishedDocument({ html: `<div id="root">${output.html}</div>`, css: output.css });
};

interface Comparison {
  checks: ImportRun['parity']['checks'];
  failures: ImportFailure[];
  /** Differences no line names, by breakpoint and state. */
  unnamedFound: string[];
  /** Differences a line names, by element and property. */
  excused: string[];
}

/** The replica against the original at every breakpoint and in every state, with what no line names. */
async function compare(browser: Browser, fixture: ImportFixture, theme: ThemeId, nodes: ComponentNode | undefined, lines: readonly ImportLine[]): Promise<Comparison> {
  const { nodeAt, writes } = replicaMap(nodes);
  const replica = await replicaDocument(nodes);
  const original = originalDocument(await originalCss(themeText(theme), [...fixture.files, fixture.entry].map(fromRoot)), await mountScript(fromRoot(fixture.entry)));
  const checks: ImportRun['parity']['checks'] = {
    screenshot: { pass: 0, total: 0 }, 'computed-styles': { pass: 0, total: 0 }, 'accessibility-tree': { pass: 0, total: 0 }, interaction: { pass: 0, total: 0 },
  };
  const failures: ImportFailure[] = [];
  const unnamedFound = new Set<string>();
  const excused = new Set<string>();
  const record = (viewport: string, state: string, check: ImportCheck, ok: boolean, detail: string) => {
    checks[check].total += 1;
    if (ok) checks[check].pass += 1;
    else failures.push({ viewport, state, check, detail: detail.slice(0, 240) });
  };

  for (const breakpoint of BREAKPOINTS) {
    const viewport = { width: breakpoint.width, height: breakpoint.height };
    let initial: Snapshot | undefined;
    for (const state of [undefined, ...fixture.states]) {
      const stateId = state?.id ?? 'initial';
      const left = await open(browser, original, viewport, true, state);
      let interactionError: string | undefined;
      let right: Page;
      try {
        right = await open(browser, replica, viewport, false, state);
      } catch (error) {
        interactionError = (error instanceof Error ? error.message : String(error)).split('\n')[0];
        right = await open(browser, replica, viewport, false);
      }
      const a = await takeSnapshot(left, { withoutVariables: true });
      const b = await takeSnapshot(right, { withoutVariables: true });
      const [pageA, pageB] = await Promise.all([left, right].map(pageColours));
      await left.close();
      await right.close();
      if (!state) initial = a;
      else if (initial) {
        const unchanged = diffRatio(initial.png, a.png, path.join(OUT_DIR, 'scratch.png')) === 0 && differences(initial, a).length === 0 && initial.aria === a.aria;
        expect(unchanged, `${fixture.id}: "${stateId}" changes nothing on the original`).toBe(false);
      }
      const file = path.join(OUT_DIR, 'import-diffs', `${fixture.id}-${theme}-${breakpoint.id}-${stateId.replace(/\W+/g, '-')}.png`);
      const ratio = diffRatio(a.png, b.png, file);
      const found = differences(a, b);
      const pixels = ratio <= MAX_DIFF_RATIO;
      record(breakpoint.label, stateId, 'screenshot', pixels, `${(ratio * 100).toFixed(2)} percent of pixels differ`);
      record(breakpoint.label, stateId, 'computed-styles', found.length === 0, `${found.length} differences, first: ${found.slice(0, 4).map((d) => `${d.element} ${d.property}`).join(', ')}`);
      record(breakpoint.label, stateId, 'accessibility-tree', a.aria === b.aria, `original ${JSON.stringify(a.aria.slice(0, 120))}, replica ${JSON.stringify(b.aria.slice(0, 120))}`);
      if (state) record(breakpoint.label, stateId, 'interaction', !interactionError && pixels && found.length === 0 && a.aria === b.aria, interactionError ?? 'the replica did not end up where the original did');

      // What no line names. Pixels follow styles, so a screenshot failure with every style difference named is named too.
      const notNamed = unnamed(found, { nodeAt, writes, lines });
      for (const each of notNamed) unnamedFound.add(`${breakpoint.label} ${stateId}: ${each.element} ${each.property}`);
      for (const each of found) if (!notNamed.includes(each)) excused.add(`${each.element} ${each.property}`);
      // Pixels with no style difference: the page behind the import, when its colours differ and a line says they stay the page's.
      const pageNamed = pageA !== pageB && lines.some((line) => line.detail === DETAILS.basePage && line.disposition === 'adapted');
      if (!pixels && found.length === 0 && !pageNamed) unnamedFound.add(`${breakpoint.label} ${stateId}: pixels differ with no style difference`);
      if (a.aria !== b.aria) unnamedFound.add(`${breakpoint.label} ${stateId}: the accessibility tree differs`);
      if (interactionError) unnamedFound.add(`${breakpoint.label} ${stateId}: the state could not be applied`);
    }
  }
  return { checks, failures, unnamedFound: [...unnamedFound], excused: [...excused].sort() };
}

/** Forged bundles made from a real one: each says less than the truth, and must read as what it is. */
function forgeries(bundle: ImportBundle, fixture: string, theme: ThemeId): ForgedCase[] {
  if (!bundle.nodes) return [];
  const forge = (forgery: string, change: (copy: ImportBundle) => void, holds: (read: ReturnType<typeof readBundle>, raw: string) => string | null, ids: Set<string> = new Set()): ForgedCase => {
    const copy = JSON.parse(JSON.stringify(bundle)) as ImportBundle;
    copy.report = { ...copy.report, verdict: 'imported', lines: copy.report.lines.map((line) => ({ ...line, disposition: 'converted' })) };
    change(copy);
    const raw = JSON.stringify(copy);
    const read = readBundle(raw, { ids });
    const problem = holds(read, raw);
    return { fixture, theme, forgery, pass: problem === null, detail: problem ?? 'read as what it is' };
  };
  const rootProps = (copy: ImportBundle) => {
    const props = (copy.nodes?.props ?? {}) as Record<string, unknown>;
    (copy.nodes as ComponentNode).props = props as ComponentNode['props'];
    return props;
  };
  const blocks = (read: ReturnType<typeof readBundle>) => (read.verdict === 'not-imported' ? null : `the verdict read ${read.verdict}`);
  const key = `${['sk', 'live'].join('_')}_${randomBytes(16).toString('hex')}`;
  const allIds = new Set<string>();
  const collect = (node: ComponentNode) => {
    allIds.add(String(node.id));
    for (const child of node.children ?? []) if (typeof child === 'object' && child !== null) collect(child);
  };
  collect(bundle.nodes);
  return [
    forge('"imported" over a rule the parser refuses', (copy) => {
      rootProps(copy).rules = [...((rootProps(copy).rules as unknown[]) ?? []), { id: 'forged', selector: 'body', style: { color: 'red' } }];
    }, (read) => blocks(read) ?? (JSON.stringify(read.nodes).includes('"forged"') ? 'the rule was kept' : null)),
    forge('the editor\'s utilities as classes', (copy) => {
      rootProps(copy).className = 'fixed inset-0 z-50';
    }, (read) => blocks(read) ?? (/fixed|inset-0/.test(JSON.stringify(read.nodes)) ? 'a utility was kept' : null)),
    forge('a script address', (copy) => {
      rootProps(copy).href = 'javascript:alert(1)';
    }, (read) => blocks(read) ?? (JSON.stringify(read.nodes).includes('javascript:') ? 'the address was kept' : null)),
    forge('a secret in an attribute', (copy) => {
      rootProps(copy).title = key;
    }, (read) => blocks(read) ?? (JSON.stringify(read.nodes).includes(key) ? 'the secret was kept' : null)),
    forge('a placement of a project component', (copy) => {
      (copy.nodes as ComponentNode).children = [...((copy.nodes as ComponentNode).children ?? []), { id: 'p', type: '#component', props: { component: 'header' } as ComponentNode['props'] }];
    }, (read) => blocks(read) ?? (JSON.stringify(read.nodes).includes('#component') ? 'the placement was kept' : null)),
    forge('ids that collide with the project', () => undefined, (read) => {
      const out: string[] = [];
      if (read.nodes) collectIds(read.nodes, out);
      return out.some((id) => allIds.has(id)) ? 'an id collides' : null;
    }, allIds),
  ];
}

function collectIds(node: ComponentNode, out: string[]): void {
  out.push(String(node.id));
  for (const child of node.children ?? []) if (typeof child === 'object' && child !== null) collectIds(child, out);
}

// ---------- the mutation run ----------

type Site = 'top' | 'body' | 'attribute' | 'child';

/** One construct of each kind, and where it goes. Each must be named by a line at its own line. */
const SNIPPETS: readonly [Site, string][] = [
  ['top', 'const answer = 42;'], ['top', 'let counter = 0;'], ['top', 'function helper() { return 1; }'], ['top', 'class Thing {}'],
  ['top', 'enum Mode { A }'], ['top', 'interface Shape { a: string }'], ['top', 'type Alias = string;'], ['top', 'if (Math.random()) {}'],
  ['top', 'for (const x of []) {}'], ['top', 'while (false) {}'], ['top', 'do {} while (false);'], ['top', 'try {} catch {}'],
  ['top', 'switch (1) { case 1: break; }'], ['top', 'outer: for (;;) { break outer; }'], ['top', 'debugger;'], ['top', "import x from 'some-package';"],
  ['top', "import 'side-effect';"], ['top', 'export const y = 1;'], ["top", "export * from './elsewhere';"], ['top', 'namespace N {}'],
  ['top', "console.log('x');"], ['top', ';'], ['top', 'declare const z: number;'],
  ['body', "const local = 'x';"], ['body', 'const [a, b] = [1, 2];'], ['body', 'if (Date.now()) { return null; }'], ['body', 'useEffect(() => {});'],
  ['body', 'const fn = async () => {};'], ['body', 'void 0;'], ['body', 'counter++;'],
  ['attribute', "title={Math.random() ? 'a' : 'b'}"], ['attribute', 'data-x={`t${1}`}'], ['attribute', '{...rest}'], ['attribute', 'onMouseEnter={() => {}}'],
  ['attribute', 'aria-label={label}'], ['attribute', "style={{ color: 'red' }}"], ['attribute', 'tabIndex={-1}'], ['attribute', 'data-n={1 + 2}'],
  ['attribute', 'data-o={obj?.a}'], ['attribute', 'data-a={[1, 2]}'], ['attribute', 'data-t={typeof window}'], ['attribute', 'data-new={new Date()}'],
  ['attribute', 'data-tag={tag`x`}'], ['attribute', 'data-re={/x/}'], ['attribute', 'data-big={10n}'], ['attribute', 'data-nn={value!}'],
  ['attribute', 'data-as={value as string}'], ['attribute', 'data-sat={value satisfies string}'], ['attribute', 'data-del={delete obj.a}'],
  ['child', '<em>emphasis</em>'], ['child', '<br />'], ['child', '<>fragment</>'], ['child', "{'text'}"], ['child', '{items.map((i) => <i key={i}>{i}</i>)}'],
  ['child', '{flag && <b>x</b>}'], ['child', '{/* a comment */}'], ['child', '<Unknown />'], ['child', '<motion.div />'], ['child', 'plain &amp; text'],
  ['child', '{...spread}'], ['child', '<a:b />'],
];

const MUTATED = 'test/score/import/fixtures/static-card.tsx';

/** The fixture with one line inserted, and the line's number. */
function mutate(text: string, site: Site, snippet: string): { text: string; line: number } {
  const lines = text.split('\n');
  const anchor: Record<Site, number> = {
    top: lines.findIndex((line) => line.startsWith('export default function')),
    body: lines.findIndex((line) => line.trim() === 'return ('),
    attribute: lines.findIndex((line) => line.trim() === 'href="/create"') + 1,
    child: lines.findIndex((line) => line.includes('<header')) + 1,
  };
  const at = anchor[site];
  if (at < 1) throw new Error(`the mutation run lost its anchor for ${site}`);
  lines.splice(at, 0, snippet);
  return { text: lines.join('\n'), line: at + 1 };
}

// ---------- the run ----------

describe('import score', () => {
  let browser: Browser;
  const runs: ImportRun[] = [];
  const forged: ForgedCase[] = [];
  const mutation: MutationCase[] = [];
  let foreignThemeDistinct: ImportScoreOut['foreignThemeDistinct'] = { pass: false, same: [] };
  let honestySees: ImportScoreOut['honestySees'] = { pass: false, planted: [], unnamed: 0 };

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
    const out: ImportScoreOut = { runs, forged, mutation, foreignThemeDistinct, honestySees, excuses: EXCUSE_ROWS };
    writeOut('import', out);
  });

  it('keeps the foreign theme foreign', () => {
    const repo = tokensOf(themeText('repo'));
    const foreign = tokensOf(themeText('foreign'));
    // A mapping such as `--color-primary: var(--primary)` is the shadcn shape, not a value: it may match.
    const same = [...foreign].filter(([name, value]) => repo.get(name) === value && !/^var\(--[a-z0-9-]+\)$/.test(value)).map(([name]) => name);
    foreignThemeDistinct = { pass: same.length === 0, same };
    expect(foreign.size).toBeGreaterThan(60);
  });

  for (const fixture of IMPORT_FIXTURES) {
    for (const theme of THEMES) {
      it(`${fixture.id} under the ${theme} theme`, async () => {
        const files = filesOf(fixture, theme);
        const outcome = await importSource(files, { breakpoints: FRAME_IDS, atomTable: true });
        const conservation = checkConservation(files, outcome);
        const bundle = await createBundle(files, outcome, { breakpoints: FRAME_IDS });
        const read = readBundle(JSON.stringify(bundle), { ids: new Set() });
        forged.push(...forgeries(bundle, fixture.id, theme));

        const lines = [...read.stated.lines, ...read.found];
        const { checks, failures, unnamedFound, excused } = await compare(browser, fixture, theme, read.nodes, lines);

        const atoms = atomsBy(outcome.report.lines);
        const total = outcome.atoms?.length ?? 0;
        const claimsImport = read.verdict !== 'not-imported';
        runs.push({
          fixture: fixture.id,
          group: fixture.group,
          theme,
          verdict: outcome.report.verdict,
          readVerdict: read.verdict,
          lines: linesBy(outcome.report.lines),
          atoms: { ...atoms, total },
          coverage: total === 0 ? 0 : (atoms.converted + atoms.adapted) / total,
          blocking: [...new Set(lines.filter((line) => line.disposition === 'left' && line.nodeKey !== undefined).map((line) => line.detail))].slice(0, 8),
          conservation,
          parity: { pass: failures.length === 0, checks, failures: failures.slice(0, 40) },
          honesty: { pass: !claimsImport || unnamedFound.length === 0, unnamed: claimsImport ? unnamedFound.slice(0, 40) : [], excused: claimsImport ? excused.slice(0, 60) : [] },
          ...(fixture.waitsOn ? { waitsOn: fixture.waitsOn } : {}),
        });
      });
    }
  }

  it('sees a difference no line names, when one is planted', async () => {
    // Honesty is worth what it can see. So the measure itself is tested: a token the importer "forgot" on a real
    // import, with the report left as it was, must show as a difference no line names under the foreign theme.
    const fixture = IMPORT_FIXTURES.find((each) => each.id === 'static-card') as ImportFixture;
    const files = filesOf(fixture, 'foreign');
    const outcome = await importSource(files, { breakpoints: FRAME_IDS });
    const read = readBundle(JSON.stringify(await createBundle(files, outcome, { breakpoints: FRAME_IDS })), { ids: new Set() });
    const style = (read.nodes?.props?.style ?? {}) as Record<string, unknown>;
    const planted = Object.keys(style).filter((key) => /^--(?:card|primary|muted-foreground)$/.test(key));
    for (const key of planted) delete style[key];
    const { unnamedFound } = await compare(browser, fixture, 'foreign', read.nodes, [...read.stated.lines, ...read.found]);
    honestySees = { pass: planted.length > 0 && unnamedFound.length > 0, planted, unnamed: unnamedFound.length };
  });

  it('names a construct of every kind at its own line', async () => {
    const text = fs.readFileSync(fromRoot(MUTATED), 'utf8');
    for (const [site, snippet] of SNIPPETS) {
      const mutated = mutate(text, site, snippet);
      const files = [{ name: MUTATED, text: mutated.text }, { name: THEME_FILE, text: themeText('repo') }];
      const outcome = await importSource(files, { breakpoints: FRAME_IDS, atomTable: true });
      const named = outcome.report.lines.some((line) => line.file === MUTATED && line.line === mutated.line);
      mutation.push({ snippet, site, line: mutated.line, named, conserved: checkConservation(files, outcome).pass });
    }
  });
});
