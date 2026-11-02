// src/lib/behaviour/presets/grid.ts
//
// A data grid: a table whose cells are one Tab stop, moved by the arrows, Home and End to
// the ends of a row, Ctrl+Home and Ctrl+End to the ends of the grid, Page Up and Page Down
// by rows. See docs/plans/2026-11-02-behaviour-model.md, "Presets" and "Decided in slice B4"
// (the grid axis).
//
// Without a script it is a plain table: the server writes no `tabindex` and the role stays,
// which assistive technology reads as a table it can walk with its own keys.
//
// PURE: no React, no MST.

import { assertSeed, derived, el, onKeys, type PresetNode } from './nodes';

export const GRID_VERSION = 1;

export interface GridOptions {
  seed: string;
  label?: string;
  columns?: string[];
  rows?: string[][];
}

const DEFAULT_COLUMNS = ['Item', 'Price', 'Stock'];
const DEFAULT_ROWS = [['Tea', '3', '12'], ['Coffee', '4', '8'], ['Cocoa', '5', '0']];

const CELL_STYLE = { padding: '8px 12px', borderBottom: '1px solid #e5e5e5', textAlign: 'start' };

/** Every generated entry, all on the grid: a cell needs none of its own. */
export function deriveGrid(root: PresetNode): PresetNode {
  const go = (move: 'next' | 'prev' | 'up' | 'down' | 'first' | 'last' | 'page-up' | 'page-down') => ({ rove: root.id, move });
  return derived(root, {
    group: { role: 'gridcell', axis: 'grid' },
    on: [
      onKeys('right', ['InlineEnd'], go('next')),
      onKeys('left', ['InlineStart'], go('prev')),
      onKeys('down', ['ArrowDown'], go('down')),
      onKeys('up', ['ArrowUp'], go('up')),
      onKeys('first', ['Home', 'Ctrl+Home'], go('first')),
      onKeys('last', ['End', 'Ctrl+End'], go('last')),
      onKeys('page-down', ['PageDown'], go('page-down')),
      onKeys('page-up', ['PageUp'], go('page-up')),
    ],
    preset: { kind: 'grid', version: GRID_VERSION },
  });
}

export function grid({ seed, label = 'Prices', columns = DEFAULT_COLUMNS, rows = DEFAULT_ROWS }: GridOptions): PresetNode {
  assertSeed(seed);
  return deriveGrid(
    el(seed, 'table', { role: 'grid', 'aria-label': label, style: { borderCollapse: 'collapse', width: '100%' } },
      el(`${seed}-head`, 'thead', {},
        el(`${seed}-head-row`, 'tr', { role: 'row' },
          ...columns.map((column, at) => el(`${seed}-column-${at}`, 'th', { role: 'columnheader', scope: 'col', children: column, style: CELL_STYLE })))),
      el(`${seed}-body`, 'tbody', {},
        ...rows.map((row, y) => el(`${seed}-row-${y}`, 'tr', { role: 'row' },
          ...row.map((cell, x) => el(`${seed}-cell-${y}-${x}`, 'td', { role: 'gridcell', children: cell, style: CELL_STYLE }))))),
    ),
  );
}
