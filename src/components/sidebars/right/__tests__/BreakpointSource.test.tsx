// The properties panel's breakpoint source indicator: on a breakpoint smaller
// than the largest, each responsive row shows whether its value is set here
// (a reset button) or inherited from a larger breakpoint, with the real
// breakpoint labels; the section badge names the breakpoint being edited.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import PageModel from '@/models/PageModel';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import HistoryStore from '@/stores/HistoryStore';
import { TypographySection } from '../sections/TypographySection';
import { SizeSection } from '../sections/SizeSection';
import { StylesSection } from '../sections/StylesSection';

const D = 'bp-d';
const T = 'bp-t';
const P = 'bp-p';

function setup(style: Record<string, unknown>) {
  const page = PageModel.create({
    id: 'page',
    metadata: { title: 'Home' },
    appComponentTree: getSnapshot(createIntrinsicComponent('root', 'div', {})),
    canvasNodes: defaultViewportSnapshots([D, T, P]),
  });
  page.appComponentTree.addChild(createIntrinsicComponent('text', 'p', { style, children: 'Hi' }));
  const node = page.appComponentTree.children[0] as ComponentInstance;
  const history = HistoryStore.create({});
  history.setTargetStore(page);
  return { node, history };
}

/** The row (label cell's grid row) that holds a label. */
const row = (label: string) => screen.getByText(label, { selector: 'label, span[id]' }).closest('div.grid, div.flex-col') as HTMLElement;

afterEach(cleanup);

describe('breakpoint source indicator', () => {
  it('shows an override on Tablet as a reset button with the real labels', () => {
    const { node } = setup({ fontSize: { base: '40px', [T]: '28px' } });
    render(<TypographySection component={node} breakpointId={T} />);
    const reset = within(row('Size')).getByRole('button', { name: 'Set on Tablet, click to reset to Desktop' });
    expect(reset.getAttribute('data-source')).toBe('own');
    expect(reset.getAttribute('title')).toBe('Set on Tablet, click to reset to Desktop');
  });

  it('shows an inherited value on Mobile as "from Tablet", not interactive', () => {
    const { node } = setup({ fontSize: { base: '40px', [T]: '28px' } });
    render(<TypographySection component={node} breakpointId={P} />);
    const dot = within(row('Size')).getByTestId('breakpoint-source');
    expect(dot.getAttribute('data-source')).toBe('inherited');
    expect(dot.getAttribute('title')).toBe('Inherited from Tablet');
    expect(dot.textContent).toContain('from Tablet');
    expect(within(row('Size')).queryByRole('button')).toBeNull();
    // The field shows what the canvas renders on Mobile.
    expect((screen.getByLabelText('Size') as HTMLInputElement).value).toBe('28');
  });

  it('shows nothing on the largest breakpoint, or for a property set nowhere', () => {
    const { node } = setup({ fontSize: { base: '40px', [T]: '28px' } });
    render(<TypographySection component={node} breakpointId={D} />);
    expect(screen.queryAllByTestId('breakpoint-source')).toHaveLength(0);
    cleanup();
    render(<TypographySection component={node} breakpointId={T} />);
    expect(within(row('Spacing')).queryByTestId('breakpoint-source')).toBeNull();
  });

  it('reset removes the override in one undo step; the row then shows it inherited', () => {
    const { node, history } = setup({ fontSize: { base: '40px', [T]: '28px' } });
    render(<TypographySection component={node} breakpointId={T} />);
    fireEvent.click(within(row('Size')).getByRole('button', { name: /click to reset to Desktop/ }));
    expect(node.props.style.fontSize).toBe('40px');
    expect(history.history.length).toBe(1);
    const dot = within(row('Size')).getByTestId('breakpoint-source');
    expect(dot.getAttribute('title')).toBe('Inherited from Desktop');
    expect((screen.getByLabelText('Size') as HTMLInputElement).value).toBe('40');
  });

  it('a group row (W / H) is own when any field is set here and resets them together', () => {
    const { node, history } = setup({ width: { base: '100px', [T]: '50px' }, height: '80px' });
    render(<SizeSection component={node} breakpointId={T} />);
    fireEvent.click(within(row('Size')).getByRole('button', { name: 'Set on Tablet, click to reset to Desktop' }));
    expect(node.props.style).toEqual({ width: '100px', height: '80px' });
    expect(history.history.length).toBe(1);
  });

  it('the section badge names the breakpoint being edited', () => {
    const { node } = setup({});
    render(<StylesSection component={node} breakpointId={T} />);
    expect(screen.getByRole('button', { name: /Styles/ }).textContent).toContain('Tablet');
  });
});
