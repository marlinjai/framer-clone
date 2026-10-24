// One review round with injected browser dependencies and a scripted
// transport (no network, no model): what is sent, what is applied, and that
// every failure leaves the page as it was.

import { beforeEach, describe, expect, it } from 'vitest';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import { runVisualReview, type ReviewRunDeps } from '../runReview';
import type { ReviewRequest, ReviewResultPayload } from '../protocol';
import type { ReviewHandlers, ReviewTransport } from '../client';
import type { LayoutFinding } from '../layoutAudit';

let store: RootStoreType;
let page: PageModelType;
let headline: ComponentInstance;

beforeEach(() => {
  store = createRootStore();
  store.projectStore.createProject('Spoke');
  const project = store.projectStore.findProjectByTitle('Spoke')!;
  page = project.createPage('Home');
  page.ensureDefaultViewports();
  page.insertRegistryComponent('container', { kind: 'appTree' });
  page.insertRegistryComponent('heading', { kind: 'appTree' });
  const root = page.appComponentTree as ComponentInstance;
  headline = root.children[root.children.length - 1] as ComponentInstance;
  getHistoryStore()!.clear();
});

const FINDING: LayoutFinding = {
  kind: 'text-clipped',
  severity: 'error',
  nodeId: 'x',
  breakpoint: 'desktop',
  measured: { contentHeight: 80, boxHeight: 40 },
  message: 'Text is cut off',
};

function scripted(respond: (req: ReviewRequest, h: ReviewHandlers, signal?: AbortSignal) => void | Promise<void>) {
  const requests: ReviewRequest[] = [];
  const transport: ReviewTransport = async (req, handlers, signal) => {
    requests.push(req);
    await respond(req, handlers, signal);
  };
  return { transport, requests };
}

function deps(over: Partial<ReviewRunDeps>): Partial<ReviewRunDeps> {
  return {
    waitForRender: async () => {},
    audit: () => ({ findings: [FINDING], missing: [] }),
    capture: async (frame) =>
      frame.key === 'desktop'
        ? {
            ok: true,
            placeholderImages: 1,
            image: { breakpoint: 'desktop', mediaType: 'image/jpeg', data: 'AAAA', width: 1000, height: 1800, cssWidth: 1280, truncated: true },
          }
        : { ok: false, breakpoint: frame.key, reason: 'rendering failed (tainted canvas)' },
    ...over,
  };
}

const result = (ops: ReviewResultPayload['ops']): ReviewResultPayload => ({
  reviewId: 'r1',
  summary: 'Tightened the hero.',
  ops,
  rejected: [{ index: 3, reason: 'unknown node id "ghost"' }],
  model: 'claude-sonnet-5-5',
});

describe('runVisualReview', () => {
  it('sends tree, findings, images and notes, then applies the fixes as one undo step', async () => {
    const { transport, requests } = scripted((req, h) => {
      h.onProgress?.({ phase: 'reviewing', receivedChars: 2048 });
      h.onResult?.(
        result([{ op: 'update_style', nodeId: headline.id, breakpoint: 'mobile', property: 'fontSize', value: '40px', reason: 'Headline too big on phone' }]),
      );
      h.onUsage?.({ inputTokens: 9000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 });
    });
    const stages: string[] = [];
    const out = await runVisualReview({
      page,
      model: 'SONNET',
      brief: 'A bike repair shop',
      signal: new AbortController().signal,
      onStage: (s) => stages.push(s),
      deps: deps({ transport }),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(stages).toEqual(['rendering', 'measuring', 'capturing', 'reviewing', 'reviewing', 'applying']);
    const req = requests[0];
    expect(req.model).toBe('SONNET');
    expect(req.brief).toBe('A bike repair shop');
    expect(req.breakpoints.map((b) => b.label)).toEqual(['Desktop', 'Tablet', 'Mobile']);
    expect(req.findings).toEqual([FINDING]);
    expect(req.images.map((i) => i.breakpoint)).toEqual(['desktop']);
    expect(req.notes?.join(' ')).toMatch(/could not be loaded for the capture/);
    expect(req.notes?.join(' ')).toMatch(/"mobile" frame could not be captured/);
    expect(req.tree.id).toBe((page.appComponentTree as ComponentInstance).id);

    expect(out.applied).toHaveLength(1);
    expect(out.rejected).toEqual([{ index: 3, reason: 'unknown node id "ghost"' }]);
    expect(out.usage?.inputTokens).toBe(9000);
    expect(getHistoryStore()!.history.length).toBe(1);
    const mobileId = (page.viewportNodes as ComponentInstance[]).find((v) => v.label === 'Mobile')!.breakpointId;
    expect(((headline.props.style as Record<string, unknown>).fontSize as Record<string, unknown>)[mobileId]).toBe('40px');
  });

  it('continues without findings when the measurement throws', async () => {
    const { transport, requests } = scripted((_req, h) => h.onResult?.(result([])));
    const out = await runVisualReview({
      page,
      model: 'OPUS',
      signal: new AbortController().signal,
      deps: deps({
        transport,
        audit: () => {
          throw new Error('no layout');
        },
      }),
    });
    expect(out.ok).toBe(true);
    expect(requests[0].findings).toEqual([]);
    expect(requests[0].notes?.[0]).toMatch(/layout measurement failed \(no layout\)/);
  });

  it('fails soft on a provider error: nothing changes, the reason and usage come back', async () => {
    const before = JSON.stringify(headline.props);
    const { transport } = scripted((_req, h) => {
      h.onError?.({ code: 'overloaded', message: 'The AI provider is overloaded right now.' });
      h.onUsage?.({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    });
    const out = await runVisualReview({ page, model: 'SONNET', signal: new AbortController().signal, deps: deps({ transport }) });
    expect(out).toMatchObject({ ok: false, code: 'overloaded', findings: [FINDING], usage: { inputTokens: 100 } });
    expect(JSON.stringify(headline.props)).toBe(before);
    expect(getHistoryStore()!.history.length).toBe(0);
  });

  it('never applies after the run was cancelled', async () => {
    const controller = new AbortController();
    const { transport } = scripted((_req, h) => {
      controller.abort();
      h.onResult?.(result([{ op: 'update_style', nodeId: headline.id, breakpoint: null, property: 'color', value: 'red', reason: 'r' }]));
    });
    const out = await runVisualReview({ page, model: 'SONNET', signal: controller.signal, deps: deps({ transport }) });
    expect(out).toMatchObject({ ok: false, code: 'aborted' });
    expect(getHistoryStore()!.history.length).toBe(0);
  });

  it('reports a stream that ends without a result', async () => {
    const { transport } = scripted(() => {});
    const out = await runVisualReview({ page, model: 'SONNET', signal: new AbortController().signal, deps: deps({ transport }) });
    expect(out).toMatchObject({ ok: false, code: 'no_result' });
  });
});
