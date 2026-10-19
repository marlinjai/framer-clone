// src/app/projects/__tests__/WorkspaceChooser.test.tsx
//
// The chooser renders one form per workspace of the session (company name and
// slug), each posting its workspace id and the validated `next` path to the
// server action; the current workspace is marked in switch mode; an empty
// session gets a way forward instead of a blank page.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import WorkspaceChooser, { workspaceLabel } from '../WorkspaceChooser';
import type { WorkspaceChoice } from '@/server/sites';

afterEach(() => cleanup());

const WORKSPACES: WorkspaceChoice[] = [
  { id: 'ws_a', name: 'Acme', slug: 'acme', companyName: 'Acme', companySlug: 'acme' },
  { id: 'ws_b', name: 'Shop', slug: 'beta-shop', companyName: 'Beta', companySlug: 'beta' },
];

function renderChooser(over: Partial<React.ComponentProps<typeof WorkspaceChooser>> = {}) {
  return render(
    <WorkspaceChooser
      workspaces={WORKSPACES}
      activeWorkspaceId={null}
      next="/projects"
      error={null}
      portalUrl="https://auth.lumitra.co/"
      action={vi.fn(async () => {})}
      {...over}
    />,
  );
}

describe('WorkspaceChooser', () => {
  it('lists every workspace with its company, each as a submit carrying its id and next', () => {
    const { container } = renderChooser({ next: '/projects/site_1' });

    expect(screen.getByRole('heading', { name: /choose a workspace/i })).toBeTruthy();
    const list = screen.getByRole('list', { name: /workspaces/i });
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /beta \/ shop/i })).toBeTruthy();
    expect(screen.getByText('beta · beta-shop')).toBeTruthy();

    const forms = Array.from(container.querySelectorAll('form'));
    expect(forms).toHaveLength(2);
    const ids = forms.map(
      (f) => (f.querySelector('input[name="workspaceId"]') as HTMLInputElement).value,
    );
    expect(ids).toEqual(['ws_a', 'ws_b']);
    for (const f of forms) {
      expect((f.querySelector('input[name="next"]') as HTMLInputElement).value).toBe(
        '/projects/site_1',
      );
    }
  });

  it('marks the current workspace and offers cancel in switch mode', () => {
    renderChooser({ activeWorkspaceId: 'ws_b' });

    const current = screen.getByRole('button', { name: /beta \/ shop/i });
    expect(current.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('link', { name: /cancel/i }).getAttribute('href')).toBe('/projects');
  });

  it('shows a refused choice as an alert', () => {
    renderChooser({ error: 'That workspace is not available.' });
    expect(screen.getByRole('alert').textContent).toMatch(/not available/);
  });

  it('gives a session without workspaces a way forward', () => {
    renderChooser({ workspaces: [] });
    expect(screen.getByText(/no workspace yet/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /open your account/i }).getAttribute('href')).toBe(
      'https://auth.lumitra.co/',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('workspaceLabel', () => {
  it('collapses a workspace named like its company', () => {
    expect(workspaceLabel(WORKSPACES[0])).toBe('Acme');
    expect(workspaceLabel(WORKSPACES[1])).toBe('Beta / Shop');
    expect(workspaceLabel({ ...WORKSPACES[1], companyName: '' })).toBe('Shop');
  });
});
