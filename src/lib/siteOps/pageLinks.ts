// src/lib/siteOps/pageLinks.ts
//
// The links that lead to a page, counted in a site's trees, for the answer of a
// deletePage operation (./applyOps.ts): the editor deletes a page whatever links
// to it, so the agent is told how many links now lead nowhere and can fix them.
//
// Two kinds count:
//   - an `href` whose path is the page's address (`/about`, `/about#team`,
//     `/about?x=1`, `/About/`): a link inside the site, on any page or inside a
//     component definition. An address with a scheme or `//` is another site's
//     and never counts, even when it names the same path.
//   - a form that sends a visitor to the page after sending (`successBehavior`
//     redirect with `redirectPageId`, src/lib/forms/definition.ts): it stores
//     the page id, not its address, and falls back to its message once the page
//     is gone.
//
// A dynamic page (`products/:handle`) has no single address, so only the forms
// count for it. Pure and client-safe; works on plain snapshots.

import { linkPathOfSlug } from '@/lib/forms/paths';

interface TreeNode {
  props?: Record<string, unknown> | null;
  children?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A path as compared: decoded, lowercased, no empty segments, so `/About/` and `/about` match. */
function pathKey(path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  return decoded
    .toLowerCase()
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('/');
}

/** The comparison key of an href that stays on this site, or null for any other href. */
function internalHrefKey(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  const path = trimmed.split(/[?#]/, 1)[0];
  return pathKey(path);
}

/** How many links in `trees` lead to the page with this id and slug. */
export function countLinksToPage(trees: readonly unknown[], page: { pageId: string; slug: string }): number {
  const address = linkPathOfSlug(page.slug);
  const target = address === null ? null : pathKey(address);
  let count = 0;
  const walk = (raw: unknown, depth: number): void => {
    if (!isObj(raw) || depth > 500) return;
    const node = raw as TreeNode;
    const props = isObj(node.props) ? node.props : undefined;
    if (props) {
      if (target !== null && typeof props.href === 'string' && internalHrefKey(props.href) === target) count++;
      if (props.successBehavior === 'redirect' && props.redirectPageId === page.pageId) count++;
    }
    if (Array.isArray(node.children)) for (const child of node.children) walk(child, depth + 1);
  };
  for (const tree of trees) walk(tree, 0);
  return count;
}
