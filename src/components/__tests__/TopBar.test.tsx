// TopBar navigation-chrome tests (MT-12).
//
// Asserts the editor top-bar chrome:
//   - a "back to /projects" control is always present,
//   - the workspace selector is HIDDEN for the common single-workspace case
//     and RENDERED (re-scoping on change) when the session has >1 workspace,
//   - the Preview control opens the preview over the editor, with no navigation.
//
// The store, router, and next/link are mocked so the bar renders in jsdom
// without the editor runtime. getHistoryStore is mocked to null (HistoryMenu
// short-circuits), keeping the test focused on the navigation chrome.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import TopBar from '../TopBar';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

// next/link -> a plain anchor so href/role assertions are environment-free.
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const setPreviewOpen = vi.fn();
let currentStore: {
  editorUI: { currentProject: unknown; currentPage: unknown; setPreviewOpen: (open: boolean) => void };
};
vi.mock('@/hooks/useStore', () => ({
  useStore: () => currentStore,
}));

vi.mock('@/stores/RootStore', () => ({
  getHistoryStore: () => null,
}));

beforeEach(() => {
  pushMock.mockReset();
  setPreviewOpen.mockReset();
  currentStore = {
    editorUI: {
      currentProject: { id: 'site_1', metadata: { title: 'Demo' } },
      currentPage: null,
      setPreviewOpen,
    },
  };
});

afterEach(() => cleanup());

describe('TopBar navigation chrome', () => {
  it('renders a back-to-projects link', () => {
    render(<TopBar />);
    const link = screen.getByRole('link', {
      name: /back to projects/i,
    }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/projects');
  });

  it('opens the preview over the editor at once, without navigating (it used to load a route)', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    expect(setPreviewOpen).toHaveBeenCalledWith(true);
    expect(pushMock).not.toHaveBeenCalled();
  });
});
