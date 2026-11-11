// Sites for the review proof (test/behaviour/branchReview.spec.ts): a home page with `count` texts, the desktop,
// tablet and mobile viewports, and a theme whose page background is `ground`.

import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import type { MergeDocument } from '@/lib/siteMerge/document';
import { reviewDocuments } from '@/lib/siteMerge/elementChanges';
import type { BranchReviewJson } from '@/lib/sites/branchClient';
import type { BranchSummaryJson } from '@/lib/sites/branches';

export const BREAKPOINTS = ['bpdesk01', 'bptabl01', 'bpmobi01'];

export interface SiteSpec {
  id: string;
  texts: string[];
  ground: string;
}

export function siteSnapshot({ id, texts, ground }: SiteSpec): Record<string, unknown> {
  return {
    id,
    metadata: { title: 'Bakery' },
    siteSettings: {
      theme: { mode: 'light', tokens: [{ id: 'gr000001', name: 'Ground', kind: 'color', light: ground }], document: { backgroundColor: 'var(--fc-t-gr000001)' } },
    },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home' },
        appComponentTree: {
          id: 'root-home',
          type: 'div',
          componentType: 'host',
          props: {},
          children: texts.map((text, i) => ({ id: `el-${i}`, type: 'p', componentType: 'host', props: { children: text }, children: [] })),
        },
        canvasNodes: defaultViewportSnapshots(BREAKPOINTS),
      },
    },
  };
}

function mergeDocument(snapshot: Record<string, unknown>): MergeDocument {
  const pages = Object.values(snapshot.pages as Record<string, Record<string, unknown>>);
  return {
    name: 'Bakery', description: '', analyticsProjectId: null, ingestionEndpoint: null, apiKeyRef: null, lumitraEnabled: false, redirects: [],
    siteSettings: snapshot.siteSettings as Record<string, unknown>,
    pages: pages.map((p) => ({ pageId: p.id as string, slug: p.slug as string, snapshot: p })),
    components: {},
  };
}

export function summary(over: Partial<BranchSummaryJson> = {}): BranchSummaryJson {
  return {
    branchId: 'site-branch', mainSiteId: 'site-main', name: 'Spring sale', status: 'ready', createdByKind: 'user', createdBy: 'user-a',
    createdAt: '2026-11-11T09:00:00.000Z', updatedAt: '2026-11-11T09:00:00.000Z', version: 3, baseVersion: 8, mainMoved: false, readyBy: 'user-a',
    readyAt: '2026-11-11T10:00:00.000Z', reviewNote: null, approved: false, mergedAt: null, discardedAt: null, ...over,
  };
}

const NONE = { site: [], settings: [], pages: { added: [], removed: [], changed: [] }, components: { added: [], removed: [], changed: [] }, nodes: { added: 0, removed: 0, changed: 0 }, pageOrder: false };

/** The review the server would answer for a branch forked from `main` (up to date with it). */
export function reviewOf(main: Record<string, unknown>, branch: Record<string, unknown>, over: Partial<BranchReviewJson> = {}): BranchReviewJson {
  return {
    branch: summary(), token: 'tok-1', upToDate: true, branchChanges: NONE, mainChanges: null, conflicts: [], settled: [], problems: [],
    review: reviewDocuments(mergeDocument(main), mergeDocument(branch)), versions: { main: 8, branch: 3 }, ...over,
  };
}
