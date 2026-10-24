// The automatic visual review after a generation, against a REAL editor store
// with the real review run and injected browser dependencies and transports
// (no network, no model): it runs by default, applies its fixes as ONE more
// undo step, shows them with model and cost, undoes them, fails soft, and
// stays off when the setting is off. Plus "Polish with AI" on an existing page.

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageGenHandlers, PageGenTransport } from '@/lib/ai/pageGen/client';
import type { PageGenRequest, PageGenResultPayload } from '@/lib/ai/pageGen/protocol';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import type { ReviewHandlers, ReviewTransport } from '@/lib/ai/review/client';
import type { ReviewRequest } from '@/lib/ai/review/protocol';
import type { ReviewRunDeps } from '@/lib/ai/review/runReview';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import { GeneratePageDialog } from '../GeneratePageDialog';
import { PolishPageDialog } from '../VisualReview';

function manualGenTransport() {
  const calls: Array<{ req: PageGenRequest; handlers: PageGenHandlers }> = [];
  const transport: PageGenTransport = (req, handlers) =>
    new Promise<void>((resolve) => {
      calls.push({ req, handlers });
      resolve();
    });
  return { transport, calls };
}

function resultFor(req: PageGenRequest): PageGenResultPayload {
  const out = validateGeneration(
    { title: 'Spoke', nodes: [{ type: 'section', label: 'Hero', children: [{ type: 'h1', label: 'Headline', props: { children: 'Ride further' } }] }] },
    { breakpoints: deriveBreakpointKeys(req.breakpoints) },
  );
  if (!out.ok) throw new Error(out.errors.join('; '));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { imageRequests, invalidImageQueries, ...result } = out.result;
  return { generationId: 'g1', model: 'claude-sonnet-5-5', ...result, images: { requested: 0, resolved: 0, fellBack: {}, credits: [] } };
}

function headline(): ComponentInstance {
  const walk = (n: ComponentInstance): ComponentInstance | undefined => {
    if (n.label === 'Headline') return n;
    for (const c of n.children) {
      const hit = walk(c as ComponentInstance);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(store.editorUI.currentPage!.appComponentTree as ComponentInstance)!;
}

/** Browser dependencies of the review, stubbed (jsdom has no layout and no canvas). */
function reviewDeps(respond: (req: ReviewRequest, h: ReviewHandlers) => void): { deps: Partial<ReviewRunDeps>; requests: ReviewRequest[] } {
  const requests: ReviewRequest[] = [];
  const transport: ReviewTransport = async (req, h) => {
    requests.push(req);
    respond(req, h);
  };
  return {
    requests,
    deps: {
      transport,
      waitForRender: async () => {},
      audit: () => ({
        findings: [
          { kind: 'text-clipped', severity: 'error', nodeId: headline().id, breakpoint: 'mobile', measured: { contentHeight: 90, boxHeight: 60 }, message: 'Text "Ride further" is cut off by its own box.' },
        ],
        missing: [],
      }),
      capture: async (frame) => ({ ok: false, breakpoint: frame.key, reason: 'no canvas in jsdom' }),
    },
  };
}

const USAGE = { inputTokens: 12000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 };

beforeEach(() => {
  window.localStorage.clear();
  store = createRootStore();
  store.projectStore.createProject('Spoke');
  const project = store.projectStore.findProjectByTitle('Spoke')!;
  const page = project.createPage('Home');
  page.insertRegistryComponent('container', { kind: 'appTree' });
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  getHistoryStore()!.clear();
});

afterEach(() => cleanup());

async function generate(review: { deps: Partial<ReviewRunDeps> }) {
  const { transport, calls } = manualGenTransport();
  render(<GeneratePageDialog open onOpenChange={() => {}} transport={transport} review={review} />);
  fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'A bike repair shop' } });
  fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
  await act(async () => calls[0].handlers.onResult?.(resultFor(calls[0].req)));
}

describe('automatic review after a generation', () => {
  it('is on by default, applies the fixes as one more undo step and lists them with model and cost', async () => {
    const { deps, requests } = reviewDeps((req, h) => {
      const id = req.tree.children[0].children[0].id;
      h.onResult?.({
        reviewId: 'r1',
        summary: 'The headline was clipped on phone.',
        ops: [{ op: 'update_style', nodeId: id, breakpoint: 'mobile', property: 'fontSize', value: '40px', reason: 'Headline clipped on phone' }],
        rejected: [{ index: 1, reason: 'unknown node id "ghost"' }],
        model: 'claude-sonnet-5-5',
      });
      h.onUsage?.(USAGE);
    });
    expect(screen.queryByRole('checkbox')).toBeNull();
    const { transport, calls } = manualGenTransport();
    render(<GeneratePageDialog open onOpenChange={() => {}} transport={transport} review={{ deps }} />);
    expect(screen.getByRole('checkbox', { name: /Review the layout with AI afterwards/ })).toBeChecked();
    fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'A bike repair shop' } });
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await act(async () => calls[0].handlers.onResult?.(resultFor(calls[0].req)));

    await waitFor(() => expect(screen.getByTestId('review-result')).toBeInTheDocument());
    expect(requests[0]).toMatchObject({ model: 'SONNET', brief: 'A bike repair shop' });
    expect(requests[0].findings).toHaveLength(1);
    expect(requests[0].notes?.join(' ')).toMatch(/could not be captured/);
    expect(screen.getByText(/applied 1 fix \(one undo step\)/)).toBeInTheDocument();
    expect(screen.getByText('Headline clipped on phone')).toBeInTheDocument();
    expect(screen.getByText(/1 suggested fix was refused/)).toBeInTheDocument();
    expect(screen.getByTestId('review-cost')).toHaveTextContent('Claude Sonnet 5.5, 12,000 tokens in, 900 out, about $0.03');

    // The generation and the review: two history entries.
    const history = getHistoryStore()!;
    expect(history.history.length).toBe(2);
    expect(history.history[1].actionName).toBe('AI review');
    const style = () => headline().props.style as Record<string, unknown> | undefined;
    expect(JSON.stringify(style())).toContain('40px');

    fireEvent.click(screen.getByRole('button', { name: 'Undo fixes' }));
    expect(JSON.stringify(style() ?? {})).not.toContain('40px');
    expect(screen.getByText('The review fixes were undone.')).toBeInTheDocument();
    // The generation itself is still there.
    expect(headline()).toBeDefined();
  });

  it('fails soft: the page stays as generated and the dialog says what failed', async () => {
    const { deps } = reviewDeps((_req, h) => {
      h.onError?.({ code: 'overloaded', message: 'The AI provider is overloaded right now. Try again in a minute.' });
    });
    await generate({ deps });
    await waitFor(() => expect(screen.getByTestId('review-error')).toBeInTheDocument());
    expect(screen.getByTestId('review-error')).toHaveTextContent(/page stays as it was: The AI provider is overloaded/);
    expect(getHistoryStore()!.history.length).toBe(1);
    expect(screen.getByText(/Added 2 components on a new page/)).toBeInTheDocument();
  });

  it('stays off when the setting is off, and can still be started by hand', async () => {
    const { deps, requests } = reviewDeps((_req, h) => {
      h.onResult?.({ reviewId: 'r', summary: '', ops: [], rejected: [], model: 'claude-opus-5-5' });
    });
    const { transport, calls } = manualGenTransport();
    render(<GeneratePageDialog open onOpenChange={() => {}} transport={transport} review={{ deps }} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Review the layout with AI afterwards/ }));
    expect(JSON.parse(window.localStorage.getItem('framer-clone:visual-review')!)).toMatchObject({ auto: false });
    fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'A bike repair shop' } });
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await act(async () => calls[0].handlers.onResult?.(resultFor(calls[0].req)));
    expect(requests).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Review layout' }));
    await waitFor(() => expect(screen.getByText('The layout review found nothing to change.')).toBeInTheDocument());
    expect(requests).toHaveLength(1);
  });

  it('Opus is selectable for the review', async () => {
    const { deps, requests } = reviewDeps((_req, h) => h.onResult?.({ reviewId: 'r', summary: '', ops: [], rejected: [], model: 'claude-opus-5-5' }));
    const { transport, calls } = manualGenTransport();
    render(<GeneratePageDialog open onOpenChange={() => {}} transport={transport} review={{ deps }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Best' }));
    fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'A bike repair shop' } });
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await act(async () => calls[0].handlers.onResult?.(resultFor(calls[0].req)));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].model).toBe('OPUS');
  });
});

describe('Polish with AI', () => {
  it('lists the measured findings on open, then fixes them on request', async () => {
    // A page with a headline to fix (generated straight into the store).
    const project = store.editorUI.currentProject!;
    const page = store.editorUI.currentPage!;
    page.insertRegistryComponent('heading', { kind: 'appTree' });
    const root = page.appComponentTree as ComponentInstance;
    const heading = root.children[root.children.length - 1] as ComponentInstance;
    heading.setLabel('Headline');
    void project;
    const { deps, requests } = reviewDeps((_req, h) => {
      h.onResult?.({
        reviewId: 'r',
        summary: 'Gave the headline room.',
        ops: [{ op: 'update_style', nodeId: heading.id, breakpoint: null, property: 'lineHeight', value: 1.1, reason: 'Headline lines were cramped' }],
        rejected: [],
        model: 'claude-sonnet-5-5',
      });
      h.onUsage?.(USAGE);
    });
    render(<PolishPageDialog open onOpenChange={() => {}} deps={deps} />);
    await waitFor(() => expect(screen.getByTestId('review-findings')).toBeInTheDocument());
    expect(screen.getByText(/measured 1 layout problem \(1 serious\)/)).toBeInTheDocument();
    expect(requests).toHaveLength(0); // measuring is free: no request yet

    fireEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));
    await waitFor(() => expect(screen.getByTestId('review-result')).toBeInTheDocument());
    expect(screen.getByText('Headline lines were cramped')).toBeInTheDocument();
    expect((heading.props.style as Record<string, unknown>).lineHeight).toBe(1.1);
    expect(getHistoryStore()!.history.at(-1)?.actionName).toBe('AI review');
  });
});
