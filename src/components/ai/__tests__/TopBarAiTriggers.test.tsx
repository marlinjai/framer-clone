// Generate and Polish in the top bar with nothing to work on (no project, no page): they stay focusable and
// say why they are off in their tooltip, and pressing them does nothing (aria-disabled, not `disabled`, which
// would take hover and focus and so the tooltip away; docs/plans/2026-11-12-top-bar-fold.md).
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';

// A real editor store with no project and no page open.
let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import { GeneratePageButton } from '../GeneratePageDialog';
import { PolishPageButton } from '../VisualReview';

beforeEach(() => {
  window.localStorage.clear();
  store = createRootStore();
});
afterEach(cleanup);

describe.each([
  { name: 'Generate', Trigger: GeneratePageButton, reason: 'Open a project to generate a page or section' },
  { name: 'Polish', Trigger: PolishPageButton, reason: 'Open a page to polish its layout with AI' },
])('$name without anything to work on', ({ name, Trigger, reason }) => {
  it('stays reachable by keyboard and says why it is off', async () => {
    render(<Trigger open={false} onOpenChange={vi.fn()} />);
    const button = screen.getByRole('button', { name: new RegExp(name) });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    expect((await screen.findByRole('tooltip')).textContent).toContain(reason);
  });

  it('does nothing when pressed', () => {
    const onOpenChange = vi.fn();
    render(<Trigger open={false} onOpenChange={onOpenChange} />);
    const button = screen.getByRole('button', { name: new RegExp(name) });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
