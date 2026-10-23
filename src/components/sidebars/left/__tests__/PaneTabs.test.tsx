// PaneTabs tests: the left sidebar's Components / Layers / Content tab strip.
// Asserts the WAI-ARIA tabs contract: roles, aria-selected, roving tabindex,
// aria-controls pairing, and Arrow / Home / End keyboard selection with wrap.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { PaneTabs, panePanelId, type PaneTab } from '../PaneTabs';

afterEach(cleanup);

type Tab = 'components' | 'layers' | 'content';
const TABS: readonly PaneTab<Tab>[] = [
  { id: 'components', label: 'Components' },
  { id: 'layers', label: 'Layers' },
  { id: 'content', label: 'Content' },
];

function Harness({ initial = 'layers' as Tab }) {
  const [active, setActive] = React.useState<Tab>(initial);
  return <PaneTabs tabs={TABS} active={active} onChange={setActive} label="Sidebar panels" idPrefix="t" />;
}

const tab = (name: string) => screen.getByRole('tab', { name });

describe('PaneTabs', () => {
  it('renders a named tablist with one selected tab', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Sidebar panels' })).toBeTruthy();
    expect(tab('Layers').getAttribute('aria-selected')).toBe('true');
    expect(tab('Components').getAttribute('aria-selected')).toBe('false');
    expect(tab('Layers').getAttribute('aria-controls')).toBe(panePanelId('t', 'layers'));
  });

  it('uses a roving tabindex', () => {
    render(<Harness />);
    expect(tab('Layers').tabIndex).toBe(0);
    expect(tab('Components').tabIndex).toBe(-1);
    expect(tab('Content').tabIndex).toBe(-1);
  });

  it('selects on click', () => {
    render(<Harness />);
    fireEvent.click(tab('Content'));
    expect(tab('Content').getAttribute('aria-selected')).toBe('true');
    expect(tab('Layers').getAttribute('aria-selected')).toBe('false');
  });

  it('ArrowRight selects and focuses the next tab, wrapping at the end', () => {
    render(<Harness />);
    fireEvent.keyDown(tab('Layers'), { key: 'ArrowRight' });
    expect(tab('Content').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('Content'));
    fireEvent.keyDown(tab('Content'), { key: 'ArrowRight' });
    expect(tab('Components').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('Components'));
  });

  it('ArrowLeft wraps from the first tab to the last', () => {
    render(<Harness initial="components" />);
    fireEvent.keyDown(tab('Components'), { key: 'ArrowLeft' });
    expect(tab('Content').getAttribute('aria-selected')).toBe('true');
  });

  it('Home and End jump to the first and last tab', () => {
    render(<Harness />);
    fireEvent.keyDown(tab('Layers'), { key: 'End' });
    expect(tab('Content').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tab('Content'), { key: 'Home' });
    expect(tab('Components').getAttribute('aria-selected')).toBe('true');
  });
});
