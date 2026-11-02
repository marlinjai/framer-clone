// The repo's own button table and its theme, as the contract's probes used them. Shared by the tests.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { VariantTable } from '../order';

export const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive";

export const BUTTON_VARIANTS: Record<string, string> = {
  default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
  brand: 'bg-brand text-brand-foreground shadow-xs hover:bg-brand/90',
  destructive: 'bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
  outline: 'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50',
  secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
  ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
  link: 'text-primary underline-offset-4 hover:underline',
};

export const BUTTON_SIZES: Record<string, string> = {
  default: 'h-9 px-4 py-2 has-[>svg]:px-3',
  sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
  lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
  icon: 'size-9',
};

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);
const valuesOf = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).map(([key, text]) => [key, words(text)]));

export const BUTTON_TABLE: VariantTable = {
  base: words(BUTTON_BASE),
  keys: [
    { key: 'variant', values: valuesOf(BUTTON_VARIANTS) },
    { key: 'size', values: valuesOf(BUTTON_SIZES) },
  ],
};

/** The repo's own `globals.css`, which is a shadcn theme: what a developer's sheet looks like. */
export const GLOBALS_CSS = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
