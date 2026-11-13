// The AI column of the site theme's page-level item rows (docs/plans/2026-11-02-theme-and-head.md,
// slice T5). The question is the matrix's: is the entry still there after `validateGeneration`?
// For a theme that means a generated page may use a token by reference and may add one, with the
// dark value it was given. The mode and the document block are refused on purpose: a token
// applies to every page and a brief is about one, so the output has no field for either, and the
// probe proves the refusal holds rather than assuming it.
//
// Pure validator calls, no model and no browser. The published and canvas columns of the same
// rows run the real thing in Chromium (pageItems.score.ts), and the repair loop, the prompt and
// the apply path are unit tests (src/lib/ai/pageGen/__tests__).

import { describe, expect, it } from 'vitest';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import type { SiteTheme } from '@/lib/site/theme';
import { pageItemEntries } from './lib/universe';
import { BREAKPOINTS } from './lib/published';
import { writeOut } from './lib/io';
import { rowKey, type Cell } from './lib/types';

const ID = { ink: 'in000001', font: 'fo000003' };
const THEME: SiteTheme = {
  mode: 'system',
  tokens: [
    { id: ID.ink, name: 'Ink', kind: 'color', light: '#111827', dark: '#f9fafb' },
    { id: ID.font, name: 'Display', kind: 'font', family: 'fraunces' },
  ],
  document: {},
};
const breakpoints = deriveBreakpointKeys(BREAKPOINTS.map(({ label, minWidth }) => ({ label, minWidth })));

function generate(raw: unknown, theme: SiteTheme = THEME) {
  let n = 0;
  return validateGeneration(raw, { breakpoints, theme, newId: () => `n${(n += 1)}`, random: () => ((n += 1) * 0.6180339887) % 1 });
}

const pass = (): Cell => ({ status: 'pass' });
const cell = (ok: boolean, note: string): Cell => (ok ? pass() : { status: 'fail', gap: 'theme', note });
const refused = (ok: boolean, note: string): Cell =>
  ok ? { status: 'fail', gap: 'ai-theme-refused', note: 'refused on purpose: the generator has no field for it' } : { status: 'fail', gap: 'theme', note };

const node = (style: Record<string, unknown>) => ({ type: 'p', label: 'Copy', props: { style, children: 'Fresh bread' } });
const key = (id: string) => rowKey('page-item', `theme:${id}`);

describe('page-level item rows, the generator column', () => {
  it('measures what the generator can do with a theme, and names nothing that is not a row', () => {
    const out: Record<string, Cell> = {};

    out[key('color-token')] = (() => {
      const used = generate({ nodes: [node({ color: `var(--fc-t-${ID.ink})` })] });
      const added = generate({ theme: { tokens: [{ ref: 'new-1', name: 'Crust', kind: 'color', light: '#f3e9dc' }] }, nodes: [node({ color: 'var(--fc-t-new-1)' })] });
      const ok = used.ok && JSON.stringify(used.result.nodes[0].props.style) === JSON.stringify({ color: `var(--fc-t-${ID.ink})` })
        && added.ok && (added.result.theme?.tokens[0] as { light?: string } | undefined)?.light === '#f3e9dc' && (added.result.nodes[0].props.style as Record<string, unknown>)?.color === `var(--fc-t-${added.result.theme?.tokens[0].id})`;
      return cell(ok, 'a colour token was not kept by reference, or a proposed one was not added');
    })();

    out[key('font-token')] = (() => {
      const used = generate({ nodes: [node({ fontFamily: `var(--fc-t-${ID.font})` })] });
      const added = generate({ theme: { tokens: [{ ref: 'new-1', name: 'Body', kind: 'font', family: 'fraunces' }] }, nodes: [node({ fontFamily: 'var(--fc-t-new-1)' })] }, { ...THEME, tokens: [] });
      const ok = used.ok && (used.result.nodes[0].props.style as Record<string, unknown>)?.fontFamily === `var(--fc-t-${ID.font})`
        && added.ok && added.result.theme?.tokens[0]?.kind === 'font';
      return cell(ok, 'a font token was not kept as the whole fontFamily, or a proposed one was not added');
    })();

    out[key('dark-value')] = (() => {
      const added = generate({ theme: { tokens: [{ ref: 'new-1', name: 'Crust', kind: 'color', light: '#f3e9dc', dark: '#2b1b0f' }] }, nodes: [node({ color: 'var(--fc-t-new-1)' })] });
      const token = added.ok ? added.result.theme?.tokens[0] : undefined;
      return cell(!!token && token.kind === 'color' && token.dark === '#2b1b0f', 'a proposed dark value was lost');
    })();

    // A mode and a document default are the owner's: the output has no field for either.
    const hasField = (theme: unknown) => generate({ theme, nodes: [node({ color: '#111' })] }).ok;
    out[key('mode-system')] = refused(!hasField({ mode: 'system', tokens: [] }), 'a generation set the mode');
    out[key('mode-light')] = refused(!hasField({ mode: 'light', tokens: [] }), 'a generation set the mode');
    out[key('mode-dark')] = refused(!hasField({ mode: 'dark', tokens: [] }), 'a generation set the mode');
    out[key('document-background')] = refused(!hasField({ document: { backgroundColor: `var(--fc-t-${ID.ink})` }, tokens: [] }), 'a generation set the page background');
    out[key('document-color')] = refused(!hasField({ document: { color: `var(--fc-t-${ID.ink})` }, tokens: [] }), 'a generation set the page text colour');
    out[key('document-font')] = refused(!hasField({ document: { fontFamily: `var(--fc-t-${ID.font})` }, tokens: [] }), 'a generation set the page font');

    const rows = new Set(pageItemEntries().map((e) => rowKey(e.kind, e.id)));
    for (const name of Object.keys(out)) expect(rows.has(name), name).toBe(true);
    // Every theme row has an answer, so none falls back to "not built yet". The head rows are answered by head.score.ts.
    for (const name of rows) if (!name.startsWith('page-item:head:')) expect(out[name], name).toBeDefined();
    writeOut('page-items-ai', { ai: out });
  });
});
