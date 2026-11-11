// The browser side of the review proof (docs/plans/2026-11-10-site-branches.md, slice S5): the real ReviewScreen,
// with its two panes drawing real preview frames. The props are the ones the server page would pass, set on
// `window.__REVIEW_PROPS__` before the bundle runs; the branch routes are answered by the contract (page.route).
// The router is the app router's context with `refresh` counted, as the page has it under Next.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { ReviewScreen, type ReviewScreenProps } from '@/components/branches/review/ReviewScreen';

const w = window as unknown as { __REVIEW_PROPS__: ReviewScreenProps; __REFRESHES__: number; __REVIEW_STARTED__: number };
w.__REVIEW_STARTED__ = performance.now();
w.__REFRESHES__ = 0;
const noop = () => undefined;
const router = { refresh: () => void (w.__REFRESHES__ += 1), push: noop, replace: noop, back: noop, forward: noop, prefetch: noop, hmrRefresh: noop };

const root = document.getElementById('root');
if (!root) throw new Error('the probe page has no #root');
createRoot(root).render(
  <AppRouterContext.Provider value={router as never}>
    <ReviewScreen {...w.__REVIEW_PROPS__} />
  </AppRouterContext.Provider>,
);
