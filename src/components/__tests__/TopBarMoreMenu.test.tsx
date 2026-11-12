// The compact top bar's More menu (plan docs/plans/2026-10-24-editor-on-phones.md):
// every action the wide bar shows is reachable from it, and each item opens
// the same dialog instance the wide bar's button opens (the bar owns the open
// state). The dialog-owning buttons are stubbed to show their controlled state.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import TopBar from '../TopBar';
import { SiteBranchProvider } from '@/contexts/SiteBranchContext';
import type { EditorBranchState } from '@/lib/sites/branches';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

let currentStore: { editorUI: { currentProject: unknown; currentPage: unknown; isUnsavedDemo?: boolean } };
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
        <button type="button" className={triggerClassName} onClick={() => onOpenChange?.(true)}>
          {label} button
        </button>
        {open && (
          <div role="dialog" aria-label={label}>
            <button type="button" onClick={() => onOpenChange?.(false)}>
              close {label}
            </button>
          </div>
        )}
      </>
    );
  };
}
vi.mock('@/components/ai/GeneratePageDialog', () => ({ __esModule: true, default: stub('Generate') }));
vi.mock('@/components/ai/VisualReview', () => ({ PolishPageButton: stub('Polish') }));
vi.mock('@/components/domains/DomainsButton', () => ({ __esModule: true, default: stub('Domains') }));
vi.mock('@/components/site/SiteSettingsDialog', () => ({ __esModule: true, default: stub('Site settings') }));
vi.mock('@/components/site/ThemePanel', () => ({ __esModule: true, default: stub('Theme') }));
vi.mock('@/components/forms/FormSubmissionsButton', () => ({ __esModule: true, default: stub('Form submissions') }));
vi.mock('@/components/PublishedVersionsButton', () => ({ __esModule: true, default: stub('Published versions') }));
vi.mock('@/components/SaveStatus', () => ({ __esModule: true, default: () => <span role="status">Saved</span> }));
vi.mock('@/components/PublishButton', () => ({ __esModule: true, default: () => <button type="button">Publish</button> }));

// These are the compact bar's (under 1024px): the wide bar's More menu holds only what folded into it
// (src/components/__tests__/TopBarFold.test.tsx).
let realMatchMedia: typeof window.matchMedia | undefined;
beforeEach(() => {
  realMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(max-width: 1023.98px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  currentStore = {
    editorUI: {
      currentProject: { id: 'site_1', metadata: { title: 'Demo' } },
      currentPage: { id: 'p1', metadata: { title: 'Home' } },
    },
  };
});
afterEach(() => {
  cleanup();
  if (realMatchMedia) window.matchMedia = realMatchMedia;
  else delete (window as { matchMedia?: unknown }).matchMedia;
});

const openMore = () => {
  const trigger = screen.getByRole('button', { name: 'More actions' });
  act(() => {
    fireEvent.keyDown(trigger, { key: 'Enter' });
  });
};

describe('compact top bar', () => {
  it('keeps the save status, Preview and Publish visible and hides the rest behind More below 1024px', () => {
    render(<TopBar />);
    for (const name of ['Publish', 'Preview', 'More actions']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    // The editor saves by itself: a status, and no Save button on either bar or in More.
    expect(screen.getByRole('status').textContent).toBe('Saved');
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
    // The wide-only triggers carry the class that hides them in the compact bar.
    for (const label of ['Generate', 'Polish', 'Published versions', 'Domains', 'Site settings', 'Theme', 'Form submissions']) {
      expect(screen.getByRole('button', { name: `${label} button` }).className).toContain('max-lg:hidden');
    }
    expect(screen.getByRole('button', { name: 'More actions' }).className).toContain('lg:hidden');
  });

  it('the More menu lists every action that does not fit', () => {
    render(<TopBar />);
    openMore();
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent?.trim());
    expect(items).toEqual([
      'Generate with AI',
      'Polish with AI',
      'Published versions',
      'Domains',
      'Site settings',
      'Theme',
      'Form submissions',
      expect.stringMatching(/^History/),
    ]);
  });

  it.each([
    ['Generate with AI', 'Generate'],
    ['Polish with AI', 'Polish'],
    ['Published versions', 'Published versions'],
    ['Domains', 'Domains'],
    ['Site settings', 'Site settings'],
    ['Form submissions', 'Form submissions'],
  ])('%s opens the same dialog as the wide bar button', (item, dialog) => {
    render(<TopBar />);
    openMore();
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: item }));
    });
    expect(screen.getByRole('dialog', { name: dialog })).toBeTruthy();
    // Closing goes through the same state, and the wide button reopens it.
    fireEvent.click(screen.getByRole('button', { name: `close ${dialog}` }));
    expect(screen.queryByRole('dialog', { name: dialog })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `${dialog} button` }));
    expect(screen.getByRole('dialog', { name: dialog })).toBeTruthy();
  });

  it('History opens a dialog listing the steps, which jump on click', () => {
    render(<TopBar />);
    openMore();
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: /History/ }));
    });
    const dialog = screen.getByTestId('history-dialog');
    fireEvent.click(screen.getByText('Initial state'));
    expect(history.jumpTo).toHaveBeenCalledWith(0);
    expect(dialog.textContent).toContain('Moved Header');
  });

  it('without a project the project-only actions are left out and Generate is disabled', () => {
    currentStore.editorUI.currentProject = undefined;
    render(<TopBar />);
    openMore();
    const names = screen.getAllByRole('menuitem').map((el) => el.textContent?.trim());
    expect(names).not.toContain('Domains');
    expect(screen.getByRole('menuitem', { name: 'Generate with AI' }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('the top bar on a site branch', () => {
  const branch: EditorBranchState = {
    kind: 'branch',
    siteId: 'site_1',
    mainSiteId: 'site_main',
    mainName: 'Bakery',
    branch: {
      branchId: 'site_1', mainSiteId: 'site_main', name: 'Spring sale', status: 'open', createdByKind: 'user', createdBy: 'u',
      createdAt: '2026-11-11T09:00:00.000Z', updatedAt: '2026-11-11T09:00:00.000Z', version: 2, baseVersion: 5, mainMoved: false,
      readyBy: null, readyAt: null, reviewNote: null, approved: false, mergedAt: null, discardedAt: null,
    undoUntil: null,
    undoneIntoBranchId: null,
    undoneAt: null,
    },
  };
  const main: EditorBranchState = { kind: 'main', siteId: 'site_1', siteName: 'Bakery', openBranches: 1 };

  it('puts Review and merge in place of Publish and leaves out what belongs to main', () => {
    render(
      <SiteBranchProvider initial={branch}>
        <TopBar />
      </SiteBranchProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.getByRole('button', { name: /review and merge/i })).toBeTruthy();
    for (const label of ['Published versions', 'Domains', 'Form submissions']) {
      expect(screen.queryByRole('button', { name: `${label} button` })).toBeNull();
    }
    // Still on a branch: site settings and the theme are part of what a branch changes.
    expect(screen.getByRole('button', { name: 'Site settings button' })).toBeTruthy();
    openMore();
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent?.trim());
    expect(items).not.toContain('Domains');
    expect(items).not.toContain('Published versions');
    expect(items).not.toContain('Form submissions');
    expect(items).toContain('Site settings');
  });

  it('keeps Publish and every action on main, with the switcher beside the name', () => {
    render(
      <SiteBranchProvider initial={main}>
        <TopBar />
      </SiteBranchProvider>,
    );
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Main. Switch branch' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Domains button' })).toBeTruthy();
  });
});
