// src/lib/legal/publishCheck.ts
//
// What the publish flow warns about before a site goes live (plan
// docs/plans/2026-10-23-published-site-essentials.md, decision 5): a site
// that carries business data but has no Impressum (German law requires one
// for a business site), legal pages that still hold [placeholders], a Google Maps
// embed the privacy policy does not name (it loads only after consent, but Google
// still receives data then, so the policy must say so), and reusable
// components that will not show, and site colours or fonts a page refers to that
// the theme does not hold or cannot show (docs/plans/2026-11-02-theme-and-head.md,
// slice T4). A footer can be a component, and the Impressum
// link goes with it, so what expansion leaves out has to reach the owner. A
// warning, never a gate: the owner can publish anyway. PURE.
//
// Only expansion is checked here. A page that runs over its budget on rows from
// data is not known until a visitor loads it, and is logged there.

import type { BusinessInfo } from '@/lib/site/siteSettings';
import type { ComponentDefinitions, RefusedDefinition } from '@/lib/components/definition';
import type { ExpansionFailureKind } from '@/lib/components/expand';
import { literalPageTree, type LiteralPageSource } from '@/lib/renderer/server/snapshotToComponentNode';
import { LEGAL_KINDS, findLegalPage, type LegalKind, type LegalPageLike } from './legalPages';
import { findPlaceholders } from './templates';
import { treesHoldMapEmbed } from '@/lib/mapEmbed/mapEmbed';
import { colorPartialProblem, findToken, referenceState, tokenUsage, type SiteTheme } from '@/lib/site/theme';

interface NodeLike {
  props?: { children?: unknown } | null;
  children?: NodeLike[] | null;
}

export interface PublishCheckPage extends LegalPageLike {
  id: string;
  metadata: { legalTemplate?: string; title: string };
  /** The stored page: placements are expanded from it. */
  snapshot: LiteralPageSource;
}

/** The site's reusable components, as the check needs them. */
export interface PublishCheckComponents {
  definitions: ComponentDefinitions;
  /** Stored definitions that could not be read, and edits to one that were undone. */
  refused: readonly RefusedDefinition[];
}

/** Something reusable that will not show on the live site. */
export interface ComponentIssue {
  /** The page it shows on, absent for a definition's own problem. */
  pageId?: string;
  /** The page's title, or the definition's id. */
  title: string;
  message: string;
}

export interface LegalPlaceholderIssue {
  kind: LegalKind;
  pageId: string;
  title: string;
  count: number;
}

/**
 * Where the privacy policy stands on Google Maps, for a site that embeds a map:
 * there is none, it does not name Google Maps, or it does.
 */
export type MapsPrivacyStatus = 'no-privacy-page' | 'not-named' | 'named';

export interface MapsPrivacyCheck {
  status: MapsPrivacyStatus;
  /** The privacy policy page, when the site has one. */
  privacyPageId: string | null;
  privacyTitle: string | null;
}

export interface PublishCheck {
  /** Business data is filled in but no Impressum page exists. */
  missingImpressum: boolean;
  /** Set when some page embeds a Google Map: what the privacy policy says about it. */
  maps: MapsPrivacyCheck | null;
  /** Legal pages that still contain [placeholders]. */
  placeholders: LegalPlaceholderIssue[];
  /** Placements that render nothing, and definitions that could not be read. */
  components: ComponentIssue[];
  /**
   * Site colours and fonts that will not show: a reference to a token the theme does not
   * hold, or to a colour whose value no longer parses. Absent on a check from before themes.
   */
  tokens?: ComponentIssue[];
}

const FAILURE_COPY: Record<ExpansionFailureKind, string> = {
  'missing-definition': 'a component placed here no longer exists, so it shows nothing',
  cycle: 'a component placed here contains itself, so it shows nothing',
  'too-deep': 'components are nested too deeply here, so the innermost show nothing',
  unrenderable: 'a component placed here cannot be read, so it shows nothing',
  'over-budget': 'this page holds too much component content, so the later components show nothing',
};

/** True when the owner has entered any business data (the site is a business site). */
export function hasBusinessData(b: BusinessInfo): boolean {
  return Boolean(
    b.legalName || b.street || b.city || b.phone || b.email || b.vatId || b.registerEntry || b.managingDirectors.length > 0,
  );
}

/** Every text in a tree (bounded walk). */
function textsOf(root: NodeLike | null | undefined): string[] {
  const texts: string[] = [];
  const stack: NodeLike[] = root ? [root] : [];
  let seen = 0;
  while (stack.length > 0 && seen < 20000) {
    const node = stack.pop()!;
    seen++;
    const text = node.props?.children;
    if (typeof text === 'string') texts.push(text);
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return texts;
}

/** Whether a privacy policy tree names Google Maps anywhere in its text. */
export function namesGoogleMaps(root: NodeLike | null | undefined): boolean {
  return textsOf(root).some((text) => /google[\s\u00a0-]*maps/i.test(text));
}

/**
 * What the privacy policy says about Google Maps, or null when no page embeds a
 * map. Exported for Site settings, which shows the same hint.
 */
export function mapsPrivacyCheck(
  pages: readonly (LegalPageLike & { id: string; metadata: { title: string } })[],
  treeOf: (pageId: string) => NodeLike | null | undefined,
): MapsPrivacyCheck | null {
  if (!treesHoldMapEmbed(pages.map((page) => treeOf(page.id) as never))) return null;
  const privacy = findLegalPage(pages, 'privacy');
  if (!privacy) return { status: 'no-privacy-page', privacyPageId: null, privacyTitle: null };
  return {
    status: namesGoogleMaps(treeOf(privacy.id)) ? 'named' : 'not-named',
    privacyPageId: privacy.id,
    privacyTitle: privacy.metadata.title,
  };
}

function countPlaceholders(root: NodeLike | null | undefined): number {
  let count = 0;
  const stack: NodeLike[] = root ? [root] : [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const text = node.props?.children;
    if (typeof text === 'string') count += findPlaceholders(text).length;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return count;
}

/** The references in `value` that will not show under `theme`, as one message, or null. */
function tokenProblem(value: unknown, theme: SiteTheme): string | null {
  let missing = 0;
  const broken: string[] = [];
  const partial: string[] = [];
  for (const id of tokenUsage(value).keys()) {
    const state = referenceState(theme, id);
    if (state === 'missing') missing += 1;
    else if (state === 'broken') broken.push(findToken(theme, id)?.name || 'unnamed');
    else {
      const token = findToken(theme, id);
      const problem = token ? colorPartialProblem(token) : null;
      if (problem) partial.push(`the colour ${token?.name || 'unnamed'}: ${problem}`);
    }
  }
  const parts: string[] = [];
  if (missing > 0) parts.push(`${missing === 1 ? 'a site colour or font it uses no longer exists' : `${missing} site colours or fonts it uses no longer exist`}, so ${missing === 1 ? 'it shows' : 'they show'} nothing`);
  if (broken.length > 0) parts.push(`the colour ${broken.join(', ')} has no value that can be read, so it shows nothing`);
  parts.push(...partial);
  return parts.length > 0 ? parts.join('; ') : null;
}

export function checkBeforePublish(
  business: BusinessInfo,
  pages: PublishCheckPage[],
  { definitions, refused }: PublishCheckComponents,
  theme?: SiteTheme,
): PublishCheck {
  const trees = new Map(pages.map((page) => [page.id, literalPageTree(page.snapshot, definitions)]));

  const placeholders: LegalPlaceholderIssue[] = [];
  for (const kind of LEGAL_KINDS) {
    const page = findLegalPage(pages, kind);
    // Only pages made from the template: an owner's own page is theirs to word.
    if (!page || page.metadata.legalTemplate !== kind) continue;
    const count = countPlaceholders(trees.get(page.id)?.root as NodeLike | null | undefined);
    if (count > 0) placeholders.push({ kind, pageId: page.id, title: page.metadata.title, count });
  }

  const components: ComponentIssue[] = refused.map(({ id, reason, edit }) => ({
    title: id,
    message: edit
      ? `your last edit to this component was undone (${reason})`
      : `this component cannot be read, so it shows nothing wherever it is placed (${reason})`,
  }));
  for (const page of pages) {
    const kinds = new Set(trees.get(page.id)?.budget.failures.map((failure) => failure.kind));
    for (const kind of kinds) {
      components.push({ pageId: page.id, title: page.metadata.title, message: FAILURE_COPY[kind] });
    }
  }

  const tokens: ComponentIssue[] = [];
  if (theme) {
    // The expanded tree: a reference inside a component counts on every page that places it.
    for (const page of pages) {
      const message = tokenProblem(trees.get(page.id)?.root, theme);
      if (message) tokens.push({ pageId: page.id, title: page.metadata.title, message });
    }
    const documentMessage = tokenProblem(theme.document, theme);
    if (documentMessage) tokens.push({ title: 'Page defaults in Theme', message: documentMessage });
  }

  return {
    tokens,
    missingImpressum: hasBusinessData(business) && !findLegalPage(pages, 'impressum'),
    maps: mapsPrivacyCheck(pages, (id) => trees.get(id)?.root as NodeLike | null | undefined),
    placeholders,
    components,
  };
}

/** True when there is something to warn about. */
export function hasPublishIssues(check: PublishCheck): boolean {
  return (
    check.missingImpressum ||
    // A check from before maps were checked (a stored revision's, an older server's) has none.
    (check.maps != null && check.maps.status !== 'named') ||
    check.placeholders.length > 0 ||
    check.components.length > 0 ||
    (check.tokens?.length ?? 0) > 0
  );
}
