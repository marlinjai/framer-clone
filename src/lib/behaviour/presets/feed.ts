// src/lib/behaviour/presets/feed.ts
//
// A feed: articles a reader pages through. Page Down and Page Up move between articles,
// Ctrl+End leaves the feed for what follows it and Ctrl+Home for what comes before, and
// the feed is one Tab stop. See docs/plans/2026-11-02-behaviour-model.md, "Presets" and
// "Prototyped before freezing".
//
// Each article carries its place, `aria-posinset` of `aria-setsize`, which derive writes.
// Without a script the articles are in order and each is a Tab stop.
//
// PURE: no React, no MST.

import { assertSeed, derived, el, onKeys, propsOf, withProps, type PresetNode } from './nodes';

export const FEED_VERSION = 1;

export interface FeedOptions {
  seed: string;
  label?: string;
  articles?: { title: string; body: string }[];
}

const DEFAULT_ARTICLES = [
  { title: 'First story', body: 'What the first story says.' },
  { title: 'Second story', body: 'What the second story says.' },
  { title: 'Third story', body: 'What the third story says.' },
];

const isArticle = (node: PresetNode): boolean => propsOf(node).role === 'article';

/** Writes every generated entry, and each article's place, from the articles the root holds. */
export function deriveFeed(root: PresetNode): PresetNode {
  const go = (move: 'next' | 'prev' | 'exit-after' | 'exit-before') => ({ rove: root.id, move });
  const articles = (root.children ?? []).filter(isArticle);
  return derived({
    ...root,
    children: root.children?.map((child) => {
      const at = articles.indexOf(child);
      return at === -1 ? child : withProps(child, { tabIndex: 0, 'aria-posinset': at + 1, 'aria-setsize': articles.length });
    }),
  }, {
    group: { role: 'article', axis: 'line' },
    on: [
      onKeys('next', ['PageDown'], go('next')),
      onKeys('prev', ['PageUp'], go('prev')),
      onKeys('after', ['Ctrl+End'], go('exit-after')),
      onKeys('before', ['Ctrl+Home'], go('exit-before')),
    ],
    preset: { kind: 'feed', version: FEED_VERSION },
  });
}

export function feed({ seed, label = 'Stories', articles = DEFAULT_ARTICLES }: FeedOptions): PresetNode {
  assertSeed(seed);
  return deriveFeed(
    el(seed, 'div', { role: 'feed', 'aria-label': label, 'aria-busy': 'false', style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
      ...articles.map((article, index) => {
        const id = `${seed}-article-${index}`;
        return el(id, 'article', { role: 'article', 'aria-labelledby': `${id}-title`, style: { padding: '16px', border: '1px solid #e5e5e5', borderRadius: '8px' } },
          el(`${id}-title`, 'h3', { id: `${id}-title`, children: article.title, style: { margin: '0 0 8px' } }),
          el(`${id}-body`, 'p', { children: article.body, style: { margin: '0' } }));
      })),
  );
}
