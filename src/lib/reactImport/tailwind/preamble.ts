// What the compiler is given: a constant with holes for data. It loads two constants and
// refuses everything else, so no `@import`, `@plugin` or `@config` can reach a file, a
// program or the network, and `@source` is never written, because candidates come from us.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Layer 2: Tailwind".

import { TAILWIND_CSS, TW_ANIMATE_CSS } from './preamble.generated';
import type { SourceSheet } from './tokens';

const STYLESHEETS: ReadonlyMap<string, string> = new Map([
  ['tailwindcss', TAILWIND_CSS],
  ['tw-animate-css', TW_ANIMATE_CSS],
]);

/** Serves the generated constants. Anything else is a refusal, whatever asked for it. */
export async function loadStylesheet(id: string): Promise<{ path: string; base: string; content: string }> {
  const content = STYLESHEETS.get(id);
  if (content === undefined) throw new Error('the import compile loads nothing else');
  return { path: id, base: '/', content };
}

/** No plugin and no config: both are programs. */
export async function loadModule(): Promise<never> {
  throw new Error('the import compile runs no code');
}

/** The input to `compile`. Every name and value in the hole has been checked in `readStylesheet`. */
export function buildPreamble(sheet: Pick<SourceSheet, 'theme' | 'darkClass'>): string {
  const theme = [...sheet.theme].map(([name, value]) => `  ${name}: ${value};`);
  return [
    '@import "tailwindcss";',
    '@import "tw-animate-css";',
    ...(sheet.darkClass ? ['@custom-variant dark (&:is(.dark *));'] : []),
    ...(theme.length > 0 ? ['@theme inline {', ...theme, '}'] : []),
  ].join('\n');
}
