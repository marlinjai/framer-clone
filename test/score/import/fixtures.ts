// The import corpus of slice 4: real shadcn components from `src/components/ui`, as far as
// the importer goes before props, entries and presets are read, and hand-written fixtures
// for what it carries end to end and for its refusal paths. Each runs under both themes.
// The importer is given the component's own file and the theme, never the entry: entries
// are slice `import-entries`. The entry is the original side's usage only.
//
// The contract is docs/plans/2026-11-02-react-import.md, "The corpus".

import path from 'node:path';
import type { Page } from 'playwright';

const ROOT = path.resolve(__dirname, '../../..');

export interface ImportState {
  id: string;
  /** Runs on both pages, after parity ids are assigned, and leaves the page in the state to compare. */
  apply: (page: Page) => Promise<void>;
}

export interface ImportFixture {
  id: string;
  group: 'repo-component' | 'hand-written';
  /** What the importer is given, relative to the repository, the component first. The theme is added per run. */
  files: string[];
  /** The original side's usage. */
  entry: string;
  states: ImportState[];
  /** Why a fixture is not expected to pass yet, in the words of the slice that closes it. */
  waitsOn?: string;
}

/** The import's root on either page: the first element inside `#root`. */
const root = (page: Page) => page.locator('#root > *').first();

const hoverRoot: ImportState = { id: 'hover', apply: (page) => root(page).hover() };
const keyboardFocus: ImportState = { id: 'keyboard focus', apply: (page) => page.keyboard.press('Tab') };

export const fromRoot = (file: string): string => path.join(ROOT, file);

export const IMPORT_FIXTURES: readonly ImportFixture[] = [
  {
    id: 'button',
    group: 'repo-component',
    files: ['src/components/ui/button.tsx'],
    entry: 'test/score/import/entries/button.tsx',
    states: [hoverRoot, keyboardFocus],
    waitsOn: 'cva tables and props (import-props), Slot and asChild, and children through the entry (import-entries)',
  },
  {
    id: 'input',
    group: 'repo-component',
    files: ['src/components/ui/input.tsx'],
    entry: 'test/score/import/entries/input.tsx',
    states: [keyboardFocus],
    waitsOn: 'props and the rest spread (import-props), and the placeholder through the entry (import-entries)',
  },
  {
    id: 'label',
    group: 'repo-component',
    files: ['src/components/ui/label.tsx'],
    entry: 'test/score/import/entries/label.tsx',
    states: [],
    waitsOn: 'the Radix label (import-radix) and props (import-props)',
  },
  {
    id: 'separator',
    group: 'repo-component',
    files: ['src/components/ui/separator.tsx'],
    entry: 'test/score/import/entries/separator.tsx',
    states: [],
    waitsOn: 'the Radix separator (import-radix) and props with defaults (import-props)',
  },
  {
    id: 'static-badge',
    group: 'hand-written',
    files: ['test/score/import/fixtures/static-badge.tsx'],
    entry: 'test/score/import/entries/static-badge.tsx',
    states: [],
  },
  {
    id: 'static-card',
    group: 'hand-written',
    files: ['test/score/import/fixtures/static-card.tsx'],
    entry: 'test/score/import/entries/static-card.tsx',
    states: [{ id: 'hover link', apply: (page) => page.locator('#root a').first().hover() }, keyboardFocus],
  },
  {
    id: 'refusals',
    group: 'hand-written',
    files: ['test/score/import/fixtures/refusals.tsx', 'test/score/import/fixtures/tailwind.config.js'],
    entry: 'test/score/import/entries/refusals.tsx',
    states: [],
    waitsOn: 'nothing: it exists to be refused, with a line for each refusal',
  },
];
