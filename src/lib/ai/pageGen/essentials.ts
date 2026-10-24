// src/lib/ai/pageGen/essentials.ts
//
// The page-essentials screen of the page generator (published site
// essentials, decision 7, docs/plans/2026-10-23-published-site-essentials.md):
//
//   hero-cta   A full new marketing page whose hero has no primary call to
//              action. Never for a section (replace / insert) and never for a
//              page that is clearly not a marketing page (a legal page, a 404,
//              a thank-you page).
//   alt-text   An image without a meaningful alt text: none, empty, a generic
//              word ("image", "photo", "Bild"), a file name, or its layer name
//              repeated when that name is itself generic ("Hero image").
//              Decorative images (alt "" plus data-decorative) are legitimate.
//
// Why here and not in validate.ts: a validation error rejects the whole
// generation, and if the single repair round fails too the user gets no page
// at all. A missing button or alt text must never cost the page. The route
// runs this next to the design-tells screen (./tells.ts): findings join the
// same single repair round, the best valid page is kept, and whatever is left
// is reported. A missing alt text left after the repair round is filled from
// the photo's description (fillMissingAlt) and reported as an automatic fix.
//
// Pure, client-safe, no mutation of the input.

import {
  LEGAL_KINDS,
  LEGAL_LINK_LABELS,
  LEGAL_SLUGS,
  LEGAL_TITLES,
} from '@/lib/legal/legalPages';
import { formKindOf } from '@/lib/forms/definition';
import { isStickyCta } from '@/lib/stickyCta/stickyCta';
import {
  allValues,
  hasText,
  parseColors,
  styleOf,
  subtree,
  walk,
  type TellFinding,
  type TellNode,
  type TellTree,
} from './tells';
import type { GeneratedNodeSnapshot, ImageRequest } from './validate';
import { DECORATIVE_ATTR } from './schema';

export interface EssentialsOptions {
  /** True for a full new page; section generations (replace / insert) never get the hero check. */
  newPage: boolean;
  /** The user's brief and page name: a legal, 404 or thank-you page skips the hero check. */
  brief?: string;
  pageTitle?: string;
}


// ---------------------------------------------------------------- not a marketing page

const EXTRA_NON_MARKETING_PHRASES = [
  'legal notice', 'privacy policy', 'privacy statement', 'cookie policy', 'cookie richtlinie',
  'terms of service', 'terms of use', 'terms and conditions', 'nutzungsbedingungen',
  'allgemeine geschäftsbedingungen', 'datenschutzerklärung', 'datenschutzhinweise', 'widerrufsbelehrung',
  'accessibility statement', 'erklärung zur barrierefreiheit', 'barrierefreiheitserklärung',
  '404', 'not found', 'page not found', 'seite nicht gefunden', 'error page', 'fehlerseite',
  'thank you page', 'thank-you page', 'thanks page', 'danke seite', 'danke-seite', 'dankeseite',
  'confirmation page', 'bestätigungsseite',
];

/** Words that, as the whole page title, name a non-marketing page (both template languages). */
function nonMarketingTitles(): Set<string> {
  const titles = new Set<string>(['legal', 'rechtliches', 'cookies', 'danke', 'thank you', 'thanks', 'vielen dank', '404']);
  for (const lang of ['de', 'en'] as const) {
    for (const kind of LEGAL_KINDS) {
      titles.add(LEGAL_TITLES[lang][kind].toLowerCase());
      titles.add(LEGAL_LINK_LABELS[lang][kind].toLowerCase());
      titles.add(LEGAL_SLUGS[lang][kind].toLowerCase());
    }
  }
  return titles;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s_]+/g, ' ').replace(/[.!?:]+$/g, '').trim();
}

/**
 * True when the brief or the page title clearly asks for a page that is not a
 * marketing page: one of the legal templates (Impressum, privacy, terms in
 * German or English), a 404 page or a thank-you page. A whole-word phrase in
 * the brief or title, or a title that is exactly one of the legal page names.
 * A brief that merely mentions privacy ("an app for private notes") is still
 * a marketing page.
 */
export function isNonMarketingPage(brief: string | undefined, ...titles: (string | undefined)[]): boolean {
  const exact = nonMarketingTitles();
  for (const t of titles) {
    if (t && exact.has(normalize(t))) return true;
  }
  const phrases = [...EXTRA_NON_MARKETING_PHRASES];
  for (const lang of ['de', 'en'] as const) {
    phrases.push(LEGAL_TITLES[lang].impressum.toLowerCase(), LEGAL_TITLES[lang].privacy.toLowerCase());
  }
  phrases.push('agb', 'impressum', 'imprint');
  const haystacks = [brief, ...titles].filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map(normalize);
  return haystacks.some((h) =>
    phrases.some((p) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(p)}($|[^\\p{L}\\p{N}])`, 'u').test(h)),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------- hero call to action

const NAV_TAGS = new Set(['nav', 'header']);
const WRAPPER_TAGS = new Set(['main', 'div']);
const NAV_LABEL = /^(site )?(nav|navigation|navbar|menu|header|top bar|kopfzeile)\b/i;

function isTransparent(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'transparent' || v === 'none' || v === 'inherit' || v === 'initial' || v === 'unset' || v === '') return true;
  const colors = parseColors(v);
  return colors.length > 0 && colors.every((c) => c.a === 0);
}

function hasFill(style: Record<string, unknown>): boolean {
  const values = [...allValues(style, 'backgroundColor'), ...allValues(style, 'background'), ...allValues(style, 'backgroundImage')];
  return values.some((v) => !isTransparent(v));
}

function hasBorder(style: Record<string, unknown>): boolean {
  const shorthand = allValues(style, 'border').some((v) => !/^(none|0|0px|hidden)\b/i.test(v.trim()));
  const width = allValues(style, 'borderWidth').some((v) => !/^0(px)?$/i.test(v.trim()));
  const styled = allValues(style, 'borderStyle').some((v) => !/^(none|hidden)$/i.test(v.trim()));
  return shorthand || (width && styled) || (width && allValues(style, 'borderColor').length > 0);
}

function hasPadding(style: Record<string, unknown>): boolean {
  const keys = ['padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'paddingInline', 'paddingBlock'];
  return keys.some((k) => allValues(style, k).some((v) => /[1-9]/.test(v)));
}

/** A link with a fill or a border plus padding reads as a button. */
function isButtonLikeLink(node: TellNode): boolean {
  if (node.type !== 'a') return false;
  const href = node.props.href;
  if (typeof href !== 'string' || href.trim().length === 0) return false;
  const style = styleOf(node);
  return (hasFill(style) || hasBorder(style)) && hasPadding(style) && hasText(node);
}

/**
 * One primary call to action: a button (the button preset or any button
 * tag with a label), a form's submit button, a link styled as a button, or
 * an add-to-cart / checkout component. The sticky bar does not count: it is
 * not part of the hero and shows on phones only.
 */
export function isPrimaryCallToAction(node: TellNode): boolean {
  if (isStickyCta(node.props)) return false;
  if (formKindOf(node.props) === 'form-submit') return true;
  const kind = node.props['data-component-kind'];
  if (kind === 'add-to-cart' || kind === 'checkout-button') return true;
  if (node.type === 'button') return hasText(node);
  return isButtonLikeLink(node);
}

/** The nodes of the page, with single wrappers (one main or div around everything) unwrapped. */
function pageSections(nodes: TellNode[]): TellNode[] {
  let list = nodes.filter((n) => !isStickyCta(n.props));
  for (let i = 0; i < 3 && list.length === 1 && WRAPPER_TAGS.has(list[0].type) && list[0].children.length > 1; i++) {
    list = list[0].children.filter((n) => !isStickyCta(n.props));
  }
  return list;
}

function isNavigation(node: TellNode): boolean {
  if (node.type === 'nav') return true;
  if (NAV_TAGS.has(node.type) && !subtree(node).some((n) => n.type === 'h1')) return true;
  return NAV_LABEL.test(node.label) && !subtree(node).some((n) => n.type === 'h1');
}

/**
 * The hero: the section that holds the page's h1 (the design brief asks for
 * exactly one, in the hero), else the first section that is not the
 * navigation.
 */
export function findHero(nodes: TellNode[]): TellNode | undefined {
  const sections = pageSections(nodes);
  return sections.find((n) => subtree(n).some((d) => d.type === 'h1')) ?? sections.find((n) => !isNavigation(n));
}

// ---------------------------------------------------------------- alt text

const GENERIC_ALT_WORDS = new Set([
  'image', 'images', 'img', 'photo', 'photos', 'picture', 'pictures', 'pic', 'graphic', 'graphics', 'illustration',
  'placeholder', 'banner', 'hero', 'hero image', 'hero photo', 'thumbnail', 'icon', 'logo', 'untitled', 'alt', 'alt text',
  'bild', 'bilder', 'foto', 'fotos', 'grafik', 'abbildung', 'platzhalter', 'titelbild', 'symbolbild',
  'stock photo', 'stockfoto', 'sample image', 'sample-image', 'image placeholder', 'photo placeholder',
]);
const GENERIC_WORD = /\b(image|img|photo|picture|pic|graphic|bild|foto|grafik)\b/i;
const FILE_NAME = /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|heic)$/i;

function srcBaseName(src: unknown): string | undefined {
  if (typeof src !== 'string' || !src.trim()) return undefined;
  try {
    const path = new URL(src, 'https://x.invalid').pathname;
    const last = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
    return last ? last.replace(/\.[a-z0-9]{2,5}$/i, '').toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export type AltProblem = 'missing' | 'generic' | 'file name' | 'layer name';

/** True when the image is marked decorative (alt "" on purpose). */
export function isDecorativeImage(node: Pick<TellNode, 'props'>): boolean {
  return node.props[DECORATIVE_ATTR] === 'true' && (node.props.alt === '' || node.props.alt === undefined);
}

/** What is wrong with an img's alt text, or undefined when it is meaningful (or decorative). */
export function altProblem(node: Pick<TellNode, 'type' | 'label' | 'props'>): AltProblem | undefined {
  if (node.type !== 'img' || isDecorativeImage(node)) return undefined;
  const alt = typeof node.props.alt === 'string' ? node.props.alt.trim() : '';
  if (!alt) return 'missing';
  const norm = alt.toLowerCase().replace(/[\s_-]+/g, ' ').replace(/[.:!]+$/g, '').trim();
  if (GENERIC_ALT_WORDS.has(norm) || /^(image|img|photo|picture|bild|foto)\s*\d+$/.test(norm)) return 'generic';
  if (FILE_NAME.test(alt) || /^(img|dsc|dscn|pxl|photo)[_-]?\d{2,}/i.test(alt)) return 'file name';
  const base = srcBaseName(node.props.src);
  if (base && base.length > 2 && norm === base.replace(/[\s_-]+/g, ' ')) return 'file name';
  const label = node.label.trim().toLowerCase();
  if (label && norm === label.replace(/[\s_-]+/g, ' ') && GENERIC_WORD.test(label)) return 'layer name';
  return undefined;
}

const ALT_DETAIL: Record<AltProblem, string> = {
  missing: 'has no alt text',
  generic: 'has a generic alt text',
  'file name': 'uses a file name as its alt text',
  'layer name': 'repeats its layer name as its alt text',
};

// ---------------------------------------------------------------- detect

/** Every page-essentials finding of a validated tree. None is fixed automatically. */
export function detectEssentials(tree: TellTree, opts: EssentialsOptions): TellFinding[] {
  const out: TellFinding[] = [];
  if (opts.newPage && !isNonMarketingPage(opts.brief, opts.pageTitle, tree.title)) {
    const hero = findHero(tree.nodes);
    if (hero && !subtree(hero).some(isPrimaryCallToAction)) {
      let heroPath = hero.label;
      walk(tree.nodes, (n, path) => {
        if (n === hero) heroPath = path;
      });
      out.push({
        tell: 'hero-cta',
        path: heroPath,
        detail:
          'Page essentials: the hero (the first screen) has no primary call to action. Add exactly one inside this section, next to the headline and subline: an "a" with an href to the booking, contact or offer section (for example "#contact") or a real page, styled as a button (solid accent backgroundColor, readable color, padding about "14px 24px", borderRadius) with a short action label in the page\'s language such as "Book a table". Keep everything else.',
        autoFixable: false,
      });
    }
  }
  walk(tree.nodes, (n, path) => {
    const problem = altProblem(n);
    if (!problem) return;
    out.push({
      tell: 'alt-text',
      path,
      detail: `Page essentials: this image ${ALT_DETAIL[problem]}. Give it an alt that says what the photo shows, in the page's language (5 to 15 words, for example "Two baristas pouring latte art at a wooden counter"); if it is purely decorative, set "alt": "" and "decorative": true instead.`,
      autoFixable: false,
    });
  });
  return out;
}

// ---------------------------------------------------------------- fallback fill

export interface AltFillResult {
  nodes: GeneratedNodeSnapshot[];
  /** One line per image, for the dialog's list of automatic fixes. */
  notes: string[];
  /** How many images were filled from the photo description or their layer name. */
  filled: number;
  /** Images left without alt text (no photo description, no usable layer name). */
  unfilled: number;
}

function sentenceCase(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * The safe fallback when the repair round still left an image without a
 * meaningful alt text: the image's stock-photo query (it describes the photo,
 * which "Image" never did), else its layer name when that is not generic. With
 * neither, the alt stays empty (not decorative), so the editor's Image
 * section shows its "no alt text" warning, and the line here says so. Never
 * touches a decorative image or an image whose alt is fine.
 */
export function fillMissingAlt(nodes: GeneratedNodeSnapshot[], imageRequests: readonly ImageRequest[]): AltFillResult {
  const queries = new Map(imageRequests.filter((r) => r.kind === 'img').map((r) => [r.nodeId, r.query]));
  const notes: string[] = [];
  let filled = 0;
  let unfilled = 0;
  const paths = new Map<string, string>();
  walk(nodes as TellNode[], (n, path) => paths.set(n.id, path));
  const visit = (node: GeneratedNodeSnapshot): GeneratedNodeSnapshot => {
    const mapped = node.children.map(visit);
    const children = mapped.every((c, i) => c === node.children[i]) ? node.children : mapped;
    const problem = altProblem(node);
    if (!problem) return children === node.children ? node : { ...node, children };
    const path = paths.get(node.id) ?? node.label;
    const query = queries.get(node.id);
    const label = node.label.trim();
    let alt = '';
    if (query) {
      alt = sentenceCase(query);
      notes.push(`${path}: alt text filled from the photo description ("${alt}"); check it describes the photo`);
    } else if (label && !GENERIC_WORD.test(label) && !GENERIC_ALT_WORDS.has(label.toLowerCase())) {
      alt = label;
      notes.push(`${path}: alt text filled from the layer name ("${alt}"); check it describes the image`);
    } else {
      notes.push(`${path}: no alt text; add one in the Image section, or mark the image decorative`);
    }
    if (alt) filled += 1;
    else unfilled += 1;
    return { ...node, props: { ...node.props, alt }, children };
  };
  return { nodes: nodes.map(visit), notes, filled, unfilled };
}

