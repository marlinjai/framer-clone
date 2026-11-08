// Coverage matrix, WAI-ARIA Authoring Practices rows. Each pattern's tree goes
// through the real published path into real Chromium and its keyboard contract
// runs there. The same contract then runs on the mounted canvas: the real EditorApp
// with the tree on a page (lib/canvasBundle.ts). The panel column follows from the
// matrix (report.ts): a pattern is editable only when every tag and prop it uses is.
// The AI column asks the generator for a pattern built from a preset the way the prompt
// teaches it, a preset request, and runs the contract on what the validator made of it.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { getSnapshot } from 'mobx-state-tree';
import ComponentModel from '@/models/ComponentModel';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { PATTERNS, treeVocabulary, type Pattern } from './patterns';
import { BREAKPOINTS, publishedDocument, renderPublished, renderThroughPublishedPage } from './lib/published';
import { bundleRuntime } from './lib/runtime';
import { bundleEditor, droppedOnEditor, enterInteract, mountOnCanvas, toSnapshot } from './lib/canvasBundle';
import { ariaPatterns } from './lib/universe';
import { writeOut } from './lib/io';
import { rowKey, type Cell } from './lib/types';

const aiContext = { breakpoints: deriveBreakpointKeys(BREAKPOINTS.map(({ label, minWidth }) => ({ label, minWidth }))) };

function storesAll(root: ComponentNode): boolean {
  const created = getSnapshot(ComponentModel.create(toSnapshot(root))) as { type: string; props: unknown; children: unknown[] };
  const same = (a: ComponentNode, b: { type: string; props: unknown; children: unknown[] }): boolean =>
    a.type === b.type &&
    JSON.stringify(a.props ?? {}) === JSON.stringify(b.props) &&
    (a.children ?? []).length === b.children.length &&
    (a.children ?? []).every((c, i) => same(c, b.children[i] as typeof b));
  return same(root, created);
}

/**
 * What the generator makes of a pattern built from a preset: the request it is taught to
 * write goes through the validator, and what comes out must pass the pattern's whole
 * contract on the published page, with the runtime, in Chromium. Kept vocabulary would say
 * less: a tree can keep every prop and still not work.
 */
async function generatedPasses(pattern: Pattern, page: Page, runtime: string): Promise<Cell> {
  const outcome = validateGeneration({ nodes: [pattern.generated?.()] }, aiContext);
  if (!outcome.ok) return { status: 'fail', gap: 'unclassified', note: `the generator refused the request: ${outcome.errors[0]}` };
  if (outcome.result.nodes.length !== 1) return { status: 'fail', gap: 'unclassified', note: `the request gave ${outcome.result.nodes.length} nodes` };
  const tree = outcome.result.nodes[0] as unknown as ComponentNode;
  const published = await renderThroughPublishedPage({ tree, definitions: {} });
  await page.setContent(publishedDocument(published, undefined, undefined, runtime));
  try {
    await pattern.contract(page, page);
    return { status: 'pass' };
  } catch (error) {
    const note = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    return pattern.generatedRefusal
      ? { status: 'fail', gap: 'ai-motion-refused', note: `${pattern.generatedRefusal} (${note})` }
      : { status: 'fail', gap: 'unclassified', note: `the generated tree failed the contract: ${note}` };
  }
}

/**
 * The props the panel has to be able to write. A rule on a state or on the gate is the CSS
 * of stored behaviour and goes with `behaviour`; `rules` stays only for a plain rule, which
 * the panel writes through its raw field.
 */
function panelProps(root: ComponentNode, props: Set<string>): string[] {
  const rules: Record<string, unknown>[] = [];
  const walk = (node: ComponentNode) => {
    const stored = (node.props as { rules?: unknown } | undefined)?.rules;
    if (Array.isArray(stored)) rules.push(...(stored as Record<string, unknown>[]));
    node.children?.forEach(walk);
  };
  walk(root);
  const ofBehaviour = (rule: Record<string, unknown>) => 'when' in rule || 'gate' in rule;
  const out = new Set([...props].filter((prop) => prop !== 'rules'));
  if (rules.some(ofBehaviour)) out.add('behaviour');
  if (rules.some((rule) => !ofBehaviour(rule))) out.add('rules');
  return [...out];
}

/** Whether the validator keeps every tag and every prop of the tree. */
function generatorKeeps(root: ComponentNode): { kept: boolean; lost: string } {
  const toRaw = (node: ComponentNode): Record<string, unknown> => ({
    type: node.type,
    props: node.props,
    children: (node.children ?? []).map(toRaw),
  });
  const outcome = validateGeneration({ nodes: [toRaw(root)] }, aiContext);
  if (!outcome.ok) return { kept: false, lost: outcome.errors[0] };
  const out = outcome.result.nodes[0];
  const before = treeVocabulary(root);
  const after = treeVocabulary(out as unknown as ComponentNode);
  const lost = [...before.tags, ...before.props].filter((x) => !after.tags.has(x) && !after.props.has(x));
  return { kept: lost.length === 0, lost: lost.join(', ') };
}

describe('coverage matrix: WAI-ARIA Authoring Practices patterns', () => {
  let browser: Browser;

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('has one tree and contract per listed pattern', () => {
    expect(PATTERNS.map((p) => p.id).sort()).toEqual(ariaPatterns().map((e) => e.id).sort());
  });

  it('runs every contract in Chromium', async () => {
    const format: Record<string, Cell> = {};
    const renderer: Record<string, Cell> = {};
    const canvas: Record<string, Cell> = {};
    const ai: Record<string, Cell> = {};
    const vocabulary: Record<string, { tags: string[]; props: string[]; preset?: string }> = {};
    const bundle = await bundleEditor();
    const runtime = await bundleRuntime();

    for (const pattern of PATTERNS) {
      const key = rowKey('aria-pattern', pattern.id);
      const tree = pattern.tree();
      format[key] = storesAll(tree) ? { status: 'pass' } : { status: 'fail', gap: 'unclassified', note: 'the model changed the tree' };

      const page = await browser.newPage();
      page.setDefaultTimeout(1500);
      // Stored behaviour needs the whole published path, and the runtime on the page.
      const published = pattern.built === 'behaviour' ? await renderThroughPublishedPage({ tree, definitions: {} }) : renderPublished(tree);
      await page.setContent(publishedDocument(published, undefined, undefined, runtime));
      try {
        await pattern.contract(page, page);
        renderer[key] = { status: 'pass', note: pattern.built === 'native' ? 'plain HTML brings the behaviour' : undefined };
      } catch (error) {
        renderer[key] = {
          status: 'fail',
          gap: 'behaviour-state',
          note: (error instanceof Error ? error.message : String(error)).split('\n')[0],
        };
      }
      await page.close();

      // The canvas runs a page in the Interact tool, the one mode where it is the page's.
      const mounted = await mountOnCanvas(browser, bundle, tree);
      try {
        await enterInteract(mounted);
        await pattern.contract(mounted, mounted.locator('[data-viewport-content-id]'));
        canvas[key] = { status: 'pass' };
      } catch (error) {
        const dropped = droppedOnEditor(tree);
        const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
        canvas[key] = {
          status: 'fail',
          gap: renderer[key].status === 'pass' ? 'canvas-editor-context' : 'behaviour-state',
          note: dropped.length > 0 ? `${message}: the editor surfaces drop ${dropped.join(', ')}` : message,
        };
      }
      await mounted.close();

      if (pattern.generated) {
        const aiPage = await browser.newPage();
        aiPage.setDefaultTimeout(1500);
        ai[key] = await generatedPasses(pattern, aiPage, runtime);
        await aiPage.close();
      } else {
        const generated = generatorKeeps(tree);
        ai[key] = generated.kept ? { status: 'pass' } : { status: 'fail', gap: 'ai-attribute-allowlist', note: `lost: ${generated.lost}` };
      }

      const { tags, props } = treeVocabulary(tree);
      vocabulary[key] = { tags: [...tags], props: panelProps(tree, props), ...(pattern.preset ? { preset: pattern.preset } : {}) };
    }

    writeOut('patterns', { format, renderer, canvas, ai, vocabulary });
  });
});
