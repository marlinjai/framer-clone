// TopBar navigation-chrome tests (MT-12).
//
// Asserts the editor top-bar chrome:
//   - a "back to /projects" control is always present,
//   - the workspace selector is HIDDEN for the common single-workspace case
//     and RENDERED (re-scoping on change) when the session has >1 workspace,
//   - the Preview control targets the id-aware route when a project is loaded.
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

let currentStore: {
  editorUI: { currentProject: unknown; currentPage: unknown };
};
vi.mock('@/hooks/useStore', () => ({
  useStore: () => currentStore,
}));

vi.mock('@/stores/RootStore', () => ({
  getHistoryStore: () => null,
}));

beforeEach(() => {
  pushMock.mockReset();
  currentStore = {
    editorUI: {
      currentProject: { id: 'site_1', metadata: { title: 'Demo' } },
      currentPage: null,
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

  it('hides the workspace selector for a single-workspace session (default)', () => {
    render(<TopBar />);
    expect(screen.queryByRole('combobox', { name: /workspace/i })).toBeNull();
  });

  it('renders a re-scoping workspace selector when the session has >1 workspace', () => {
    render(
      <TopBar
        workspaces={[
          { id: 'ws_a', name: 'Acme' },
          { id: 'ws_b', name: 'Beta' },
        ]}
        activeWorkspaceId="ws_a"
      />,
    );
    const select = screen.getByRole('combobox', {
      name: /workspace/i,
    }) as HTMLSelectElement;
    expect(select.value).toBe('ws_a');

    fireEvent.change(select, { target: { value: 'ws_b' } });
    expect(pushMock).toHaveBeenCalledWith('/projects?workspace=ws_b');
  });

  it('targets the id-aware preview route when a project is loaded', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    expect(pushMock).toHaveBeenCalledWith('/projects/site_1/preview');
  });
});
