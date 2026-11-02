// Classes on one property to a responsive map, only when the map is exact. The default
// frames are Desktop 1280, Tablet 768 and Mobile 320, so `md:` and `xl:` are the two
// widths a map can hold, as the bands they leave. Anything else stays a literal `at`,
// which is always exact, and one property never mixes the two.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Breakpoints".

import { familyOf } from './flatten';

/** The ids a map is written under. A project's frames have ids of their own, so a caller that knows them passes them. */
export interface BreakpointIds {
  tablet: string;
  mobile: string;
}

export const DEFAULT_BREAKPOINT_IDS: BreakpointIds = { tablet: 'tablet', mobile: 'mobile' };

type Band = 'desktop' | 'tablet' | 'mobile';

/** The bands each exact wrapper reaches. */
const WRAPPER_BANDS: Readonly<Record<string, readonly Band[]>> = {
  '@media (width >= 48rem)': ['desktop', 'tablet'],
  '@media (width >= 80rem)': ['desktop'],
  '@media (width < 48rem)': ['mobile'],
  '@media (width < 80rem)': ['tablet', 'mobile'],
};

/** Any width query: only the four above have a band, so the others make the property literal. */
const WIDTH_WRAPPER = /^@media\s+\(\s*(?:min-|max-)?width\b/i;

export interface NormalDeclaration {
  key: string;
  value: unknown;
  /** `[]` for an unprefixed class, one wrapper for a breakpoint. */
  at: string[];
}

export interface MappedStyle {
  /** What goes in Normal, in cascade order, scalars and maps. */
  style: Record<string, unknown>;
  /** Keys now held by a map, whose breakpoint rules are gone. Every other breakpoint declaration stays a literal rule. */
  mappedKeys: Set<string>;
}

/** Whether this key can be a map: a custom property is read through `var()`, so its value stays where it is exact. */
function canMap(key: string, own: readonly NormalDeclaration[], familyKeys: ReadonlySet<string>): boolean {
  if (key.startsWith('--') || familyKeys.size > 1) return false;
  if (!own.some((each) => each.at.length === 0)) return false;
  return own.every((each) => each.at.length === 0 || (each.at.length === 1 && Object.hasOwn(WRAPPER_BANDS, each.at[0])));
}

/**
 * Writes Normal from declarations in Tailwind's order, unprefixed and breakpoint alike. Each band takes the last
 * value that reaches it, which is what the cascade does. A longhand beside a shorthand (`px-2 md:px-4 pl-2`) stays
 * literal: moving `md:px-4` into Normal would put it before `pl-2`, and the wrong one would win.
 */
export function mapBreakpoints(declarations: readonly NormalDeclaration[], ids: BreakpointIds): MappedStyle {
  const byKey = new Map<string, NormalDeclaration[]>();
  const families = new Map<string, Set<string>>();
  for (const declaration of declarations) {
    const own = byKey.get(declaration.key);
    if (own) own.push(declaration);
    else byKey.set(declaration.key, [declaration]);
    const family = familyOf(declaration.key);
    const keys = families.get(family);
    if (keys) keys.add(declaration.key);
    else families.set(family, new Set([declaration.key]));
  }
  const style: Record<string, unknown> = {};
  const mappedKeys = new Set<string>();
  for (const [key, own] of byKey) {
    const hasBreakpoint = own.some((each) => each.at.length > 0);
    if (hasBreakpoint && canMap(key, own, families.get(familyOf(key)) ?? new Set())) {
      const bands: Partial<Record<Band, unknown>> = {};
      for (const { at, value } of own) {
        for (const band of at.length === 0 ? (['desktop', 'tablet', 'mobile'] as const) : WRAPPER_BANDS[at[0]]) bands[band] = value;
      }
      style[key] = {
        base: bands.desktop,
        ...(bands.tablet === bands.desktop ? {} : { [ids.tablet]: bands.tablet }),
        ...(bands.mobile === bands.tablet ? {} : { [ids.mobile]: bands.mobile }),
      };
      mappedKeys.add(key);
      continue;
    }
    for (const each of own) {
      if (each.at.length > 0) continue;
      delete style[key];
      style[key] = each.value;
    }
  }
  return { style, mappedKeys };
}

/** True for a wrapper that a width query decides. */
export const isWidthWrapper = (wrapper: string): boolean => WIDTH_WRAPPER.test(wrapper);
