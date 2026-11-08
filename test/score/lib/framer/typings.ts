// The source of truth for the "Framer, native" column: Framer's official plugin API typings,
// npm package framer-plugin, pinned exactly in package.json and read at run time by the tests
// (mapping.test.ts proves every symbol the mapping cites is declared there, and every
// enumeration quoted below equals the typings literally).

import fs from 'node:fs';
import path from 'node:path';

export const FRAMER_PLUGIN = {
  name: 'framer-plugin',
  version: '3.10.3',
  /** sha256 of dist/index.d.ts as installed from the npm tarball on 2026-11-02. */
  typingsSha256: '38e57e89ce85f08f6624a203c31a9bde87d6449c8a94a269aa5bf22b0d11839e',
} as const;

export function typingsPath(root = process.cwd()): string {
  return path.join(root, 'node_modules', FRAMER_PLUGIN.name, 'dist', 'index.d.ts');
}

export function readTypings(root = process.cwd()): string {
  const file = typingsPath(root);
  if (!fs.existsSync(file)) {
    throw new Error(`${file} is missing: run pnpm install (framer-plugin ${FRAMER_PLUGIN.version} is a pinned devDependency)`);
  }
  return fs.readFileSync(file, 'utf8');
}

/** Framer documentation pages fetched on 2026-11-02. Only these are cited. */
export const FRAMER_DOCS = {
  nodes: 'https://www.framer.com/developers/nodes',
  traits: 'https://www.framer.com/developers/reference-legacy/plugins-traits',
  /** "Connect those states with click, mouse enter, or mouse leave triggers." and "appear, hover, press, drag, loop, or scroll effects". */
  animations: 'https://www.framer.com/academy/lessons/framer-animations-overview',
  /** Show Overlay ("Opens a fixed overlay", for popups and alerts) and Set Component Variant. */
  triggers: 'https://www.framer.com/help/articles/using-triggers/',
  /** "Use Events to let a nested element trigger a change in its parent Component." */
  events: 'https://www.framer.com/academy/lessons/framer-animations-component-events',
  /** "The Appear effect in Framer animates a layer into its final design as it becomes visible or scrolls into view." */
  appear: 'https://www.framer.com/academy/lessons/framer-animations-appear-effect',
  /** Input variants (default, focused, filled, error, disabled) and form validation, built as a component. */
  forms: 'https://www.framer.com/academy/lessons/input-variants-and-validation',
} as const;

/**
 * "Click start" has no public Framer page that could be found on 2026-11-02. Its source is the
 * test of Framer's real editor recorded in the plan, and the rows that rest on it say so.
 */
export const FRAMER_EDITOR_TEST = 'docs/plans/2026-11-01-complete-primitives.md, "What Framer does" (editor and framer.app, 2026-11-01)';

/** String literal unions quoted from the typings, checked literally by the tests. */
export const QUOTED_UNIONS: Record<string, readonly string[]> = {
  Position: ['relative', 'absolute', 'fixed', 'sticky'],
  Overflow: ['visible', 'hidden', 'auto', 'clip'],
  BorderStyle: ['solid', 'dashed', 'dotted', 'double'],
  LayoutType: ['stack', 'grid'],
  StackDirection: ['horizontal', 'vertical'],
  StackDistribution: ['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly'],
  StackAlignment: ['start', 'center', 'end'],
  GridItemAlignment: ['start', 'center', 'end'],
  GridContentAlignment: ['start', 'center', 'end'],
  ImageRendering: ['auto', 'pixelated'],
  TextNodeTag: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'],
  TextTransform: ['none', 'inherit', 'capitalize', 'uppercase', 'lowercase'],
  TextAlignment: ['left', 'center', 'right', 'justify'],
  TextDecoration: ['none', 'underline', 'line-through'],
  TextDecorationStyle: ['solid', 'double', 'dotted', 'dashed', 'wavy'],
  TextDecorationSkipInk: ['none', 'all', 'auto'],
  Gesture: ['hover', 'pressed', 'loading', 'error'],
  Rel: ['nofollow', 'noreferrer', 'me', 'ugc', 'sponsored'],
};

/** `declare const name: readonly [...]` tuples quoted from the typings. */
export const QUOTED_TUPLES: Record<string, readonly string[]> = {
  fontWeights: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
  fontStyles: ['normal', 'italic'],
  createableNodes: ['FrameNode', 'TextNode', 'ComponentNode'],
};

/** Values of `declare enum CSSUnit`. */
export const CSS_UNITS: readonly string[] = ['px', 'rem', 'em', '%', 'fr', 'vw', 'vh'];
