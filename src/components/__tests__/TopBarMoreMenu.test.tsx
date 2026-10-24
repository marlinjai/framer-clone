// The compact top bar's More menu (plan docs/plans/2026-10-24-editor-on-phones.md):
// every action the wide bar shows is reachable from it, and each item opens
// the same dialog instance the wide bar's button opens (the bar owns the open
// state). The dialog-owning buttons are stubbed to show their controlled state.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import TopBar from '../TopBar';

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
vi.mock('@/components/forms/FormSubmissionsButton', () => ({ __esModule: true, default: stub('Form submissions') }));
vi.mock('@/components/SaveButton', () => ({ __esModule: true, default: () => <button type="button">Save</button> }));
vi.mock('@/components/PublishButton', () => ({ __esModule: true, default: () => <button type="button">Publish</button> }));

beforeEach(() => {
  currentStore = {
    editorUI: {
      currentProject: { id: 'site_1', metadata: { title: 'Demo' } },
      currentPage: { id: 'p1', metadata: { title: 'Home' } },
    },
  };
});
afterEach(() => cleanup());

const openMore = () => {
  const trigger = screen.getByRole('button', { name: 'More actions' });
  act(() => {
    fireEvent.keyDown(trigger, { key: 'Enter' });
  });
};

describe('compact top bar', () => {
  it('keeps Save, Preview and Publish visible and hides the rest behind More below 1024px', () => {
    render(<TopBar />);
    for (const name of ['Save', 'Publish', 'Preview', 'More actions']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    // The wide-only triggers carry the class that hides them in the compact bar.
    for (const label of ['Generate', 'Polish', 'Domains', 'Site settings', 'Form submissions']) {
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
      'Domains',
      'Site settings',
      'Form submissions',
      expect.stringMatching(/^History/),
    ]);
  });

  it.each([
    ['Generate with AI', 'Generate'],
    ['Polish with AI', 'Polish'],
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
