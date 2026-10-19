// src/app/projects/__tests__/CompanyChooser.test.tsx
//
// The chooser renders one form per company it is given (the loader passes only
// companies holding the `sites` grant), labelled by the company name alone (no
// "/ Main"), each posting its company id and the validated `next` path to the
// server action; the current company is marked in switch mode. Also the
// not-enabled page a user without such a company sees instead.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import CompanyChooser from '../CompanyChooser';
import SitesNotEnabled from '../SitesNotEnabled';
import type { CompanyChoice } from '@/server/sites';

afterEach(() => cleanup());

const COMPANIES: CompanyChoice[] = [
  { id: 't-a', name: 'Lumitra', slug: 'lumitra-core', workspaceId: 'ws_a' },
  { id: 't-b', name: 'Whiz-Art Media', slug: 'whiz-art-media', workspaceId: 'ws_b' },
];

function renderChooser(over: Partial<React.ComponentProps<typeof CompanyChooser>> = {}) {
  return render(
    <CompanyChooser
      companies={COMPANIES}
      activeCompanyId={null}
      next="/projects"
      error={null}
      action={vi.fn(async () => {})}
      {...over}
    />,
  );
}

describe('CompanyChooser', () => {
  it('lists each company by name, each as a submit carrying its id and next', () => {
    const { container } = renderChooser({ next: '/projects/site_1' });

    expect(screen.getByRole('heading', { name: /choose a company/i })).toBeTruthy();
    const list = screen.getByRole('list', { name: /companies/i });
    const buttons = within(list).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Lumitra', 'Whiz-Art Media']);
    expect(container.textContent).not.toMatch(/\/ main/i);
    expect(container.textContent).not.toMatch(/workspace/i);

    const forms = Array.from(container.querySelectorAll('form'));
    expect(forms).toHaveLength(2);
    const ids = forms.map(
      (f) => (f.querySelector('input[name="companyId"]') as HTMLInputElement).value,
    );
    expect(ids).toEqual(['t-a', 't-b']);
    for (const f of forms) {
      expect((f.querySelector('input[name="next"]') as HTMLInputElement).value).toBe(
        '/projects/site_1',
      );
    }
  });

  it('marks the current company and offers cancel in switch mode', () => {
    renderChooser({ activeCompanyId: 't-b' });

    const current = screen.getByRole('button', { name: /whiz-art media/i });
    expect(current.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('link', { name: /cancel/i }).getAttribute('href')).toBe('/projects');
  });

  it('shows a refused choice as an alert', () => {
    renderChooser({ error: 'Lumitra Sites is not available for that company any more.' });
    expect(screen.getByRole('alert').textContent).toMatch(/not available/);
  });
});

describe('SitesNotEnabled', () => {
  it('explains the missing grant and links the auth-brain portal, with no form to submit', () => {
    render(<SitesNotEnabled portalUrl="https://auth.lumitra.co/" grantedWithoutWorkspace={[]} />);

    expect(
      screen.getByRole('heading', { name: /lumitra sites is not enabled for your companies/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /open the account portal/i }).getAttribute('href'),
    ).toBe('https://auth.lumitra.co/');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('names a granted company the user has no access to yet', () => {
    render(
      <SitesNotEnabled
        portalUrl="https://auth.lumitra.co/"
        grantedWithoutWorkspace={['Whiz-Art Media']}
      />,
    );
    expect(screen.getByText(/enabled for whiz-art media, but your account/i)).toBeTruthy();
  });
});
