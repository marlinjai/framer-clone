// The wide top bar's fold (docs/plans/2026-11-12-top-bar-fold.md, src/components/topbar/fold.ts): what folds at
// which width, in the order decided, and what never folds. jsdom has no layout, so the bar's widths are given
// here: the width the window leaves the bar, and what its content needs at each fold level, as measured in
// Chromium on the bar seen on production on 2026-11-12 (a branch, an agent at work, the site "Lumitra (new
// landing page)" on the page "Services: KI-Automatisierung für den Mittelstand"). The real layout is proven in
// real browsers in test/behaviour/branches.spec.ts.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import TopBar from '../TopBar';
import { SiteBranchProvider } from '@/contexts/SiteBranchContext';
import type { EditorBranchState } from '@/lib/sites/branches';
import { FoldLabel } from '../topbar/BarTooltip';
import { decideFoldLevel, foldLevelFor, type FoldLevel } from '../topbar/fold';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const presence = {
  active: [{ label: 'lumitra-sites-agent-mcp', focus: { tool: 'apply_batch' } }],
  runEdited: true,
  setPanelOpen: vi.fn(),
};
let currentStore: { editorUI: Record<string, unknown> };
vi.mock('@/hooks/useStore', () => ({ useStore: () => currentStore }));

const history = {
  history: [{ id: 'h1', timestamp: Date.now(), patches: [1] }],
  undoIdx: 1,
  canUndo: true,
  canRedo: false,
  undo: vi.fn(),
  redo: vi.fn(),
  jumpTo: vi.fn(),
  labelFor: () => 'Moved Header',
};
vi.mock('@/stores/RootStore', () => ({ getHistoryStore: () => history }));

interface StubProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
}
function stub(label: string) {
  return function Stub({ open, onOpenChange, triggerClassName }: StubProps) {
    return (
      <>
        <button type="button" aria-label={label} className={triggerClassName} onClick={() => onOpenChange?.(true)} />
        {open && <div role="dialog" aria-label={label} />}
      </>
    );
  };
}
// Generate and Polish as the real triggers draw themselves (an outline button, its words in a FoldLabel); their
// dialogs need the whole editor store, and are not what this proves.
function foldingStub(label: string) {
  return function FoldingStub({ iconOnly = false, triggerClassName = '' }: StubProps & { iconOnly?: boolean }) {
    return (
      <button type="button" className={`shrink-0 ${triggerClassName}`}>
        <FoldLabel folded={iconOnly}>{label}</FoldLabel>
      </button>
    );
  };
}
vi.mock('@/components/ai/GeneratePageDialog', () => ({ __esModule: true, default: foldingStub('Generate') }));
vi.mock('@/components/ai/VisualReview', () => ({ PolishPageButton: foldingStub('Polish') }));
vi.mock('@/components/domains/DomainsButton', () => ({ __esModule: true, default: stub('Domains') }));
vi.mock('@/components/site/SiteSettingsDialog', () => ({ __esModule: true, default: stub('Site settings') }));
vi.mock('@/components/site/ThemePanel', () => ({ __esModule: true, default: stub('Theme') }));
vi.mock('@/components/forms/FormSubmissionsButton', () => ({ __esModule: true, default: stub('Form submissions') }));
vi.mock('@/components/PublishedVersionsButton', () => ({ __esModule: true, default: stub('Published versions') }));
vi.mock('@/components/SaveStatus', () => ({ __esModule: true, default: () => <span data-testid="save-status">Saved</span> }));
vi.mock('@/components/PublishButton', () => ({ __esModule: true, default: () => <button type="button">Publish</button> }));
vi.mock('@/components/live/AgentAnnouncer', () => ({ __esModule: true, default: () => null }));
vi.mock('@/components/live/AgentDeletedPageWatcher', () => ({ __esModule: true, default: () => null }));

/** What the bar's content needs at fold levels 0 to 3, in pixels, measured in Chromium (see the header). */
const BRANCH_NEEDS = [1661, 1300, 1169, 1024];
/** The same bar on main (Publish, published versions, domains and form submissions in place of the branch's controls). */
const MAIN_NEEDS = [1420, 1296, 1232, 1012];

// The layout jsdom lacks: the bar is `width` wide; its content needs NEEDS[level] at the level it shows now
// (its data-fold), and overflows when that is more than the width.
const layout = { width: 1680, needs: BRANCH_NEEDS };
const resizeCallbacks: Array<() => void> = [];
let realResizeObserver: typeof ResizeObserver;
beforeEach(() => {
  layout.width = 1680;
  layout.needs = BRANCH_NEEDS;
  resizeCallbacks.length = 0;
  realResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private readonly cb: () => void) {
      resizeCallbacks.push(() => this.cb());
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-editor-topbar') ? layout.width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.hasAttribute('data-editor-topbar')) return 0;
    return Math.max(layout.width, layout.needs[Number(this.getAttribute('data-fold'))]);
  });
  currentStore = {
    editorUI: {
      currentProject: { id: 'site_1', metadata: { title: 'Lumitra (new landing page)' } },
      currentPage: { id: 'p1', metadata: { title: 'Services: KI-Automatisierung für den Mittelstand' } },
      livePresence: presence,
      setPreviewOpen: vi.fn(),
    },
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.ResizeObserver = realResizeObserver;
});

const branch: EditorBranchState = {
  kind: 'branch',
  siteId: 'site_1',
  mainSiteId: 'site_main',
  mainName: 'Lumitra (new landing page)',
  branch: {
    branchId: 'site_1', mainSiteId: 'site_main', name: 'Test new design', status: 'open', createdByKind: 'user', createdBy: 'u',
    createdAt: '2026-11-11T09:00:00.000Z', updatedAt: '2026-11-11T09:00:00.000Z', version: 2, baseVersion: 5, mainMoved: false,
    readyBy: null, readyAt: null, reviewNote: null, approved: false, mergedAt: null, discardedAt: null,
    undoUntil: null, undoneIntoBranchId: null, undoneAt: null,
  },
};
const main: EditorBranchState = { kind: 'main', siteId: 'site_1', siteName: 'Lumitra (new landing page)', openBranches: 1 };

const bar = () => document.querySelector('[data-editor-topbar]') as HTMLElement;
const level = () => Number(bar().getAttribute('data-fold')) as FoldLevel;
/** The window changes width: the bar's ResizeObserver hears it. */
const resizeTo = (width: number) => {
  layout.width = width;
  act(() => resizeCallbacks.forEach((cb) => cb()));
};
const words = (name: string) => screen.getByRole('button', { name, exact: true }).querySelector('[data-fold-label]');
/** The nearest box the fold hides `el` in (a plain `hidden`; `hidden lg:flex` is the wide bar's undo cluster, shown from 1024px up). */
const foldedBox = (el: Element): Element | null => {
  for (let at: Element | null = el; at; at = at.parentElement) {
    if (at.classList.contains('hidden') && !at.classList.contains('lg:flex')) return at;
  }
  return null;
};
const moreButton = () => screen.getByRole('button', { name: 'More actions' });

function renderBar(state: EditorBranchState, width: number) {
  layout.width = width;
  return render(
    <SiteBranchProvider initial={state}>
      <TopBar />
    </SiteBranchProvider>,
  );
}

describe('the fold decision', () => {
  it.each([
    [1680, 0],
    [1440, 1],
    [1280, 2],
    [1024, 3],
  ])('settles a branch bar with an agent at work at %ipx on level %i', (width, expected) => {
    expect(foldLevelFor(width, BRANCH_NEEDS)).toBe(expected);
    // Step by step from no fold, as the bar does it, one layout at a time.
    let at: FoldLevel = 0;
    const seen: (number | undefined)[] = [];
    for (let step = 0; step < 10; step++) {
      seen[at] = BRANCH_NEEDS[at];
      const next = decideFoldLevel(at, width, seen);
      if (next === at) break;
      at = next;
    }
    expect(at).toBe(expected);
  });

  it('unfolds when the window widens, trying the level before once, and never swings between two', () => {
    // At 1440 on level 3 (the window just grew from 1024): level 2 is unknown, so it is tried.
    expect(decideFoldLevel(3, 1440, [undefined, undefined, undefined, 1024])).toBe(2);
    expect(decideFoldLevel(2, 1440, [undefined, undefined, 1169, 1024])).toBe(1);
    expect(decideFoldLevel(1, 1440, [undefined, 1300, 1169, 1024])).toBe(0);
    // Level 0 does not fit: back to 1, and level 1 stays, since 0 is now known not to fit.
    expect(decideFoldLevel(0, 1440, [1661, 1300, 1169, 1024])).toBe(1);
    expect(decideFoldLevel(1, 1440, [1661, 1300, 1169, 1024])).toBe(1);
    // The last level is the last: nothing folds beyond it.
    expect(decideFoldLevel(3, 900, [1661, 1300, 1169, 1024])).toBe(3);
  });
});

describe('the wide top bar, folding', () => {
  it.each([
    { width: 1680, expected: 0 },
    { width: 1440, expected: 1 },
    { width: 1280, expected: 2 },
    { width: 1024, expected: 3 },
  ])('at $width px a branch bar with an agent at work folds to level $expected, in the order decided', ({ width, expected }) => {
    renderBar(branch, width);
    expect(level()).toBe(expected);

    // 1. The words of Generate, Polish, Share preview and Review and merge fold into their icons from level 1.
    for (const name of ['Generate', 'Polish', 'Share preview', 'Review and merge']) {
      if (expected >= 1) expect(words(name)).toHaveClass('sr-only');
      else expect(words(name)).not.toHaveClass('sr-only');
    }
    // Review and merge stays the bar's filled button at every level.
    expect(screen.getByRole('button', { name: 'Review and merge' }).className).toMatch(/bg-brand/);

    // 2. The page name narrows from level 2 (its full name on hover), and the branch badge gives way.
    const pageName = screen.getByTestId('topbar-page-name');
    expect(pageName).toHaveAttribute('title', 'Services: KI-Automatisierung für den Mittelstand');
    expect(pageName.className).toMatch(expected >= 2 ? /max-w-\[6rem\]/ : /max-w-\[10rem\]/);
    const badge = document.querySelector('[title^="A branch of"]') as HTMLElement;
    expect(badge.classList.contains('hidden')).toBe(expected >= 2);

    // 3. Site settings, theme and history move into More at level 3; More shows on the wide bar only then.
    for (const name of ['Site settings', 'Theme']) {
      const trigger = screen.getByRole('button', { name });
      if (expected >= 3) expect(trigger).toHaveClass('hidden');
      else expect(trigger).not.toHaveClass('hidden');
    }
    const historyButton = screen.getByRole('button', { name: /^History, step/ });
    // The history menu's own box, inside the wrapper that hides it at the last fold.
    expect(foldedBox(historyButton)).toBe(expected >= 3 ? historyButton.parentElement?.parentElement : null);
    expect(moreButton().className.includes('lg:hidden')).toBe(expected < 3);

    // 4. Never folded: undo, redo, preview, the save status and the agent chip.
    for (const name of ['Undo', 'Redo', 'Preview', 'Agent editing']) {
      // The wide bar's (the compact bar's agent dot, hidden from 1024px up by CSS, follows it).
      const control = screen.getAllByRole('button', { name })[0];
      expect(foldedBox(control), name).toBeNull();
    }
    expect(foldedBox(screen.getByTestId('save-status'))).toBeNull();
  });

  it.each([
    { width: 1680, expected: 0 },
    { width: 1440, expected: 0 },
    { width: 1280, expected: 2 },
    { width: 1024, expected: 3 },
  ])('on main at $width px folds to level $expected, and Publish keeps its words', ({ width, expected }) => {
    layout.needs = MAIN_NEEDS;
    renderBar(main, width);
    expect(level()).toBe(expected);
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    for (const name of ['Published versions', 'Domains', 'Form submissions', 'Site settings', 'Theme']) {
      const trigger = screen.getByRole('button', { name });
      if (expected >= 3) expect(trigger).toHaveClass('hidden');
      else expect(trigger).not.toHaveClass('hidden');
    }
  });

  it('folds and unfolds with the window, and lands on the same level each time', () => {
    renderBar(branch, 1680);
    expect(level()).toBe(0);
    resizeTo(1024);
    expect(level()).toBe(3);
    resizeTo(1280);
    expect(level()).toBe(2);
    resizeTo(1440);
    expect(level()).toBe(1);
    resizeTo(1680);
    expect(level()).toBe(0);
    resizeTo(1024);
    expect(level()).toBe(3);
  });

  it('at the last fold, the More menu opens with the keyboard and holds only what folded into it, each a menu item', () => {
    renderBar(branch, 1024);
    expect(level()).toBe(3);
    const trigger = moreButton();
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    act(() => {
      fireEvent.keyDown(trigger, { key: 'Enter' });
    });
    const menu = screen.getByRole('menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const items = within(menu).getAllByRole('menuitem').map((el) => el.textContent?.trim());
    // Generate and Polish stay in the bar as icons; on a branch, what belongs to main is left out.
    expect(items).toEqual(['Site settings', 'Theme', expect.stringMatching(/^History/)]);
    act(() => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Theme' }));
    });
    expect(screen.getByRole('dialog', { name: 'Theme' })).toBeInTheDocument();
  });

  it('gives every icon button a name a screen reader reads, at every fold', () => {
    renderBar(branch, 1024);
    expect(screen.getByRole('link', { name: 'Back to projects' })).toBeInTheDocument();
    for (const name of ['Generate', 'Polish', 'Share preview', 'Review and merge', 'Preview', 'More actions', 'Undo', 'Redo']) {
      expect(screen.getByRole('button', { name, exact: true }), name).toBeInTheDocument();
    }
    // The agent chip (the wide bar's words and the compact bar's dot) has the same name on both bars, and its full
    // sentence is its description (and its tooltip on hover and focus).
    const chips = screen.getAllByRole('button', { name: 'Agent editing' });
    expect(chips).toHaveLength(2);
    for (const chip of chips) expect(chip).toHaveAccessibleDescription('lumitra-sites-agent-mcp is editing this site');
    expect(chips[0]).toHaveAccessibleDescription('lumitra-sites-agent-mcp is editing this site');
  });
});
