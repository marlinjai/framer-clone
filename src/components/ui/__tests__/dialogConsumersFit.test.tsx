// The editor's dialogs built on the shared DialogContent put their content in
// DialogBody (scrolls) with the actions in DialogFooter (always on screen), so
// none of them can push its buttons off a small window. jsdom cannot lay out,
// so the structure and classes are asserted.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import CollectionSettingsDialog from '@/components/cms/CollectionSettingsDialog';
import { expectBodyScrollsFooterFixed } from './viewportFit';

vi.mock('@/hooks/useStore', () => ({
  useStore: () => ({ editorUI: { currentProject: { id: 'site_1' } } }),
}));
vi.mock('@/components/domains/DomainsPanel', () => ({
  default: () => <div data-testid="domains-panel">panel</div>,
}));

import DomainsButton from '@/components/domains/DomainsButton';

afterEach(() => cleanup());

describe('dialogs fit a small window', () => {
  it('collection settings: fields scroll, Save / Cancel stay on screen', () => {
    render(
      <CollectionSettingsDialog
        collection={{ id: 'c1', slug: 'posts', name: 'Posts', columns: [] }}
        busy={false}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    const dialog = screen.getByTestId('cms-settings-dialog');
    expectBodyScrollsFooterFixed(dialog, screen.getByLabelText('Name'));
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).not.toBeNull();
  });

  it('domains: the panel scrolls inside the dialog body, no ad-hoc height cap left', () => {
    render(<DomainsButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Domains' }));
    const dialog = screen.getByRole('dialog');
    expectBodyScrollsFooterFixed(dialog, screen.getByTestId('domains-panel'));
    expect(dialog.getAttribute('class')).not.toContain('max-h-[85vh]');
  });
});

describe('menus and pickers fit a small window', () => {
  it('dropdown menus cap their height at the space Radix reports and scroll', async () => {
    const { DropdownMenu, DropdownMenuContent, DropdownMenuItem } = await import('@/components/ui/dropdown-menu');
    render(
      <DropdownMenu open>
        <DropdownMenuContent data-testid="menu">
          <DropdownMenuItem>One</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const classes = (screen.getByTestId('menu').getAttribute('class') ?? '').split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining(['max-h-(--radix-dropdown-menu-content-available-height)', 'overflow-y-auto']),
    );
  });
});
