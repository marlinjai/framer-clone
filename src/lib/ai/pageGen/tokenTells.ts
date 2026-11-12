// src/lib/ai/pageGen/tokenTells.ts
//
// The tells screen (./tells.ts) and the page essentials read colours out of style values with
// `parseColors`. A value that is `var(--fc-t-<id>)` reads as no colour at all, so on a page
// built from tokens every colour tell would go quiet. Plan, "Every reader that has to learn
// it": resolve the references first, once per scheme the site can show, and read that.
//
// Two jobs, both pure:
//
//   - `resolvedViews`: the tree with every token reference replaced by the token's value in
//     one scheme. Used only to DETECT. The tree that is applied keeps its references, and the
//     automatic fixes run on that one, so a fix can never overwrite a reference with a literal.
//   - `detectTokenTells`: the one tell that exists only because of tokens, `low-contrast`: a
//     text colour on a surface, where one of the two is a token (a person picks the pair
//     in the panel and the model picks it here) and the pair reads badly in a scheme the site
//     can show. Read per scheme, so a pair that passes in light and fails in dark is found.

import { composite, contrastRatio, isLargeText } from '@/lib/ai/review/layoutAudit';
import { parseColor, type Rgba } from '@/lib/color/cssColor';
import { EMPTY_THEME, resolveTokenRefs, schemesInForce, type ColorScheme, type SiteTheme, type ThemeToken } from '@/lib/site/theme';
import { hasText, styleOf, textOf, type TellFinding, type TellNode, type TellTree } from './tells';

/** The theme the generation will have once its added tokens are in. */
export function mergedTheme(theme: SiteTheme | undefined, added: readonly ThemeToken[] | undefined): SiteTheme {
  const base = theme ?? EMPTY_THEME;
  return added && added.length > 0 ? { ...base, tokens: [...base.tokens, ...added] } : base;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function resolveValue(value: unknown, theme: SiteTheme, scheme: ColorScheme): unknown {
  if (typeof value === 'string') return value.includes('--fc-t-') ? resolveTokenRefs(value, theme, scheme) : value;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, theme, scheme)]));
  return value;
}

/** The same-node rules that can apply in `scheme`: plain `&` rules, under no wrapper or the scheme's own media query. */
function activeRuleStyles(node: TellNode, scheme: ColorScheme): Record<string, unknown>[] {
  const rules = Array.isArray(node.props.rules) ? (node.props.rules as unknown[]) : [];
  const out: Record<string, unknown>[] = [];
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule.selector !== 'string' || rule.selector.trim() !== '&') continue;
    if (rule.when !== undefined || rule.gate !== undefined || !isRecord(rule.style)) continue;
    const at = Array.isArray(rule.at) ? (rule.at as unknown[]) : [];
    if (at.length > 1) continue;
    if (at.length === 1) {
      const media = String(at[0]).replace(/\s+/g, ' ').trim().toLowerCase();
      if (media !== `@media (prefers-color-scheme: ${scheme})`) continue;
    }
    out.push(rule.style);
  }
  return out;
}

/** The node's style with the rules that apply in `scheme` laid over it, a later rule winning. */
function styleInScheme(node: TellNode, scheme: ColorScheme): Record<string, unknown> {
  return Object.assign({}, styleOf(node), ...activeRuleStyles(node, scheme));
}

const hasReference = (value: unknown): boolean => JSON.stringify(value ?? null).includes('--fc-t-');

/** True when anything in the tree, or the document defaults, is a token reference, so a site without tokens costs nothing. */
export function holdsReferences(nodes: readonly TellNode[], theme?: SiteTheme): boolean {
  if (theme && (hasReference(theme.document.backgroundColor) || hasReference(theme.document.color))) return true;
  const walk = (node: TellNode): boolean => {
    const rules = Array.isArray(node.props.rules) ? (node.props.rules as unknown[]) : [];
    return (
      Object.values(styleOf(node)).some(hasReference) ||
      rules.some((r) => isRecord(r) && hasReference(r.style)) ||
      node.children.some(walk)
    );
  };
  return nodes.some(walk);
}

/** The tree with each reference replaced by its value in `scheme`: same ids, labels and paths. */
function resolvedTree<N extends TellNode>(tree: TellTree<N>, theme: SiteTheme, scheme: ColorScheme, withRules: boolean): TellTree {
  const map = (node: TellNode): TellNode => {
    const style = withRules ? styleInScheme(node, scheme) : styleOf(node);
    return {
      ...node,
      props: { ...node.props, ...(Object.keys(style).length > 0 ? { style: resolveValue(style, theme, scheme) as Record<string, unknown> } : {}) },
      children: node.children.map(map),
    };
  };
  return { ...tree, nodes: tree.nodes.map(map) };
}

/** One resolved view per scheme the site can show. Empty when no node refers to a token. */
export function resolvedViews<N extends TellNode>(
  tree: TellTree<N>,
  theme: SiteTheme,
  withRules = false,
): { scheme: ColorScheme; tree: TellTree }[] {
  if (!holdsReferences(tree.nodes)) return [];
  return schemesInForce(theme.mode).map((scheme) => ({ scheme, tree: resolvedTree(tree, theme, scheme, withRules) }));
}

/**
 * The value of a style key a visitor reads at breakpoint number `index` (0 is the largest).
 * A smaller breakpoint inherits from the larger ones, then from `base`; with none of them
 * set the answer is undefined, so an ancestor's value applies. An entry for some other
 * breakpoint is never borrowed.
 */
function valueAt(style: Record<string, unknown>, key: string, breakpointKeys: readonly string[] | undefined, index: number): string | undefined {
  const v = style[key];
  if (v === undefined || v === null) return undefined;
  if (!isRecord(v)) return String(v);
  for (let i = index; i >= 0; i -= 1) {
    const at = breakpointKeys?.[i];
    if (at !== undefined && v[at] !== undefined && v[at] !== null) return String(v[at]);
  }
  return v.base !== undefined && v.base !== null ? String(v.base) : undefined;
}

const PAINTS_IMAGE = /\b(?:url|(?:repeating-)?(?:linear|radial|conic)-gradient|image-set|element|cross-fade)\s*\(/i;

interface Source {
  color: Rgba;
  /** Whether the stored value was a token reference, which is what makes this tell the tokens' to raise. */
  viaToken: boolean;
}

/** A single solid colour, or undefined for a gradient, a function we cannot read, or nothing. */
function solid(value: string | undefined): Rgba | undefined {
  if (value === undefined) return undefined;
  const color = parseColor(value.trim());
  return color && color.a > 0 ? color : undefined;
}

const FAINT = 0.95;

/** The contrast a pair needs: 3 for large text, 4.5 otherwise (WCAG 2.2, 1.4.3). */
function required(fontSize: string | undefined, fontWeight: string | undefined): number {
  const px = fontSize && /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(fontSize);
  const weight = Number(fontWeight);
  return px && isLargeText(Number(px[1]), Number.isFinite(weight) ? weight : 400) ? 3 : 4.5;
}

/**
 * Text on a surface where either colour came from a token, in each scheme the site can show.
 * A node's own colours win, then the nearest ancestor's; a node with a background image or a
 * gradient leaves its subtree's surface unknown (a photo and its scrim are not a colour), and
 * a surface under 95 percent opaque is composited on the surface below it or skipped. Only the
 * node that holds the text is reported, once, with the worse scheme.
 */
export function detectTokenTells<N extends TellNode>(
  tree: TellTree<N>,
  theme: SiteTheme,
  breakpointKeys?: readonly string[],
): TellFinding[] {
  const out: TellFinding[] = [];
  if (!holdsReferences(tree.nodes, theme)) return out;
  // Contrast is read at every breakpoint a visitor can have (a mobile-only override can break a
  // pair the desktop one keeps), in every scheme the site can show. The layout tells in ./tells.ts
  // read the desktop breakpoint only; a colour pair is cheap to check everywhere, so this one does.
  const breakpoints = breakpointKeys && breakpointKeys.length > 0 ? breakpointKeys.map((_, i) => i) : [0];
  const views = schemesInForce(theme.mode).map((scheme) => ({ scheme, tree: resolvedTree(tree, theme, scheme, true) }));

  const original = new Map<string, TellNode>();
  const index = (node: TellNode): void => {
    original.set(node.id, node);
    node.children.forEach(index);
  };
  tree.nodes.forEach(index);

  views.forEach(({ scheme, tree: view }) => {
    // The document's own colours are what a root starts from.
    const documentSource = (key: 'backgroundColor' | 'color'): Source | undefined => {
      const reference = theme.document[key];
      if (reference === undefined) return undefined;
      const color = solid(resolveTokenRefs(reference, theme, scheme));
      return color ? { color, viaToken: true } : undefined;
    };
    const documentText = documentSource('color');
    const documentSurface = documentSource('backgroundColor');

    breakpoints.forEach((bp) => {
      const at = (style: Record<string, unknown>, key: string): string | undefined => valueAt(style, key, breakpointKeys, bp);
      const where = bp === 0 || !breakpointKeys ? '' : ` at the ${breakpointKeys[bp]} breakpoint`;

      const visit = (node: TellNode, path: string, text: Source | undefined, surface: Source | undefined): void => {
        const style = styleOf(node);
        const source = original.get(node.id) ?? node;
        const own = styleInScheme(source, scheme);
        const textValue = at(style, 'color');
        const bgValue = at(style, 'backgroundColor') ?? at(style, 'background');
        const ownBgValue = at(own, 'backgroundColor') ?? at(own, 'background') ?? '';
        const ownText = solid(textValue);
        let nextText = text;
        if (ownText) nextText = { color: ownText, viaToken: (at(own, 'color') ?? '').includes('--fc-t-') };
        let nextSurface = surface;
        const image = (at(style, 'backgroundImage') ?? '').trim();
        const hasPaintedImage = (image !== '' && image.toLowerCase() !== 'none') || PAINTS_IMAGE.test(at(style, 'background') ?? '');
        if (hasPaintedImage) nextSurface = undefined;
        else if (bgValue !== undefined) {
          const bg = solid(bgValue);
          if (bg) {
            const under = nextSurface?.color;
            nextSurface =
              bg.a >= FAINT
                ? { color: bg, viaToken: ownBgValue.includes('--fc-t-') }
                : under
                  ? { color: composite(bg, under), viaToken: nextSurface?.viaToken === true || ownBgValue.includes('--fc-t-') }
                  : undefined;
          } else if (/^\s*(transparent|none)\s*$/i.test(bgValue) === false) {
            nextSurface = undefined;
          }
        }

        const holdsOwnText = textOf(node) !== undefined && hasText(node);
        if (holdsOwnText && nextText && nextSurface && (nextText.viaToken || nextSurface.viaToken)) {
          const ink = composite(nextText.color, nextSurface.color);
          const ratio = contrastRatio(ink, nextSurface.color);
          const need = required(at(style, 'fontSize'), at(style, 'fontWeight'));
          if (ratio < need) {
            out.push({
              tell: 'low-contrast',
              path,
              detail: `contrast: the text of "${path}" is ${ratio.toFixed(1)}:1 against its background in ${scheme} mode${where}, and needs ${need}:1. Use the site's pair that reads (a text token on a surface token meant for it), or a literal that does.`,
              autoFixable: false,
            });
          }
        }
        const labelCount = new Map<string, number>();
        for (const child of node.children) labelCount.set(child.label, (labelCount.get(child.label) ?? 0) + 1);
        const seen = new Map<string, number>();
        for (const child of node.children) {
          const i = (seen.get(child.label) ?? 0) + 1;
          seen.set(child.label, i);
          const name = (labelCount.get(child.label) ?? 0) > 1 ? `${child.label} (${i})` : child.label;
          visit(child, `${path} > ${name}`, nextText, nextSurface);
        }
      };

      const labelCount = new Map<string, number>();
      for (const node of view.nodes) labelCount.set(node.label, (labelCount.get(node.label) ?? 0) + 1);
      const seen = new Map<string, number>();
      for (const node of view.nodes) {
        const i = (seen.get(node.label) ?? 0) + 1;
        seen.set(node.label, i);
        visit(node, (labelCount.get(node.label) ?? 0) > 1 ? `${node.label} (${i})` : node.label, documentText, documentSurface);
      }
    });
  });

  // One finding per node, the first scheme and breakpoint that failed.
  const seenPaths = new Set<string>();
  return out.filter((f) => (seenPaths.has(f.path) ? false : (seenPaths.add(f.path), true)));
}
