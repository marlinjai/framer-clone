// Coverage matrix, WAI-ARIA Authoring Practices rows. Each pattern's tree goes
// through the real published path into real Chromium and its keyboard contract
// runs there. The same contract then runs on the mounted canvas: the real EditorApp
// with the tree on a page (lib/canvasBundle.ts). The panel column follows from the
// matrix (report.ts): a pattern is editable only when every tag and prop it uses is.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { getSnapshot } from 'mobx-state-tree';
import ComponentModel from '@/models/ComponentModel';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { PATTERNS, treeVocabulary } from './patterns';
import { BREAKPOINTS, publishedDocument, renderPublished } from './lib/published';
import { bundleEditor, mountOnCanvas, toSnapshot } from './lib/canvasBundle';
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
    const vocabulary: Record<string, { tags: string[]; props: string[] }> = {};
    const bundle = await bundleEditor();

    for (const pattern of PATTERNS) {
      const key = rowKey('aria-pattern', pattern.id);
      const tree = pattern.tree();
      format[key] = storesAll(tree) ? { status: 'pass' } : { status: 'fail', gap: 'unclassified', note: 'the model changed the tree' };

      const page = await browser.newPage();
      page.setDefaultTimeout(1500);
      await page.setContent(publishedDocument(renderPublished(tree)));
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

      const mounted = await mountOnCanvas(browser, bundle, tree);
      try {
        await pattern.contract(mounted, mounted.locator('[data-viewport-content-id]'));
        canvas[key] = { status: 'pass' };
      } catch (error) {
        canvas[key] = {
          status: 'fail',
          gap: renderer[key].status === 'pass' ? 'canvas-editor-context' : 'behaviour-state',
          note: (error instanceof Error ? error.message : String(error)).split('\n')[0],
        };
      }
      await mounted.close();

      const generated = generatorKeeps(tree);
      ai[key] = generated.kept ? { status: 'pass' } : { status: 'fail', gap: 'ai-attribute-allowlist', note: `lost: ${generated.lost}` };

      const { tags, props } = treeVocabulary(tree);
      vocabulary[key] = { tags: [...tags], props: [...props] };
    }

    writeOut('patterns', { format, renderer, canvas, ai, vocabulary });
  });
});
